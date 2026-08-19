// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Canonical task-v3 source contract.
 *
 * This module owns the strict source grammar. It deliberately does not project
 * a v3 source into the still-v2 task runner; execution integration must consume
 * this typed result rather than inventing a second parser.
 */

import fs from "node:fs";
import path from "node:path";
import { types as utilTypes } from "node:util";
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml";
import { type ParsedBuiltinCommandAction, parseBuiltinCommandAction } from "../commands/command/builtin-action";
import { bundleRefToString, parseBundleRef } from "../core/asset/asset-ref";
import { UsageError } from "../core/errors";
import { checkJsonSchemaDefinition } from "../core/json-schema";
import { DURATION_UNITS, parseDuration } from "../core/time";
import type { ExecutionJsonObject, ExecutionJsonValue } from "../execution/json";
import { EXECUTION_MAX_TIMEOUT_MS } from "../execution/limits";
import { type StrictRecordSnapshot, snapshotStrictRecord } from "../execution/record";
import {
  WORKFLOW_ENV_VAR_NAME_PATTERN,
  WORKFLOW_MAX_EXEC_PASS_ENV,
  WORKFLOW_MAX_RETRIES,
} from "../workflows/resource-limits";

export const TASK_V3_SCHEMA_VERSION = 3 as const;
export const TASK_V3_MAX_SOURCE_BYTES = 1024 * 1024;
export const TASK_V3_MAX_JSON_DEPTH = 64;
export const TASK_V3_MAX_JSON_NODES = 10_000;
export const TASK_V3_MAX_COLLECTION_ITEMS = 1024;
export const TASK_V3_MAX_OBJECT_KEYS = 256;
export const TASK_V3_MAX_STRING_BYTES = 256 * 1024;
export const TASK_V3_MAX_SCHEDULES = 64;

/** Closed authoring vocabulary. Arbitrary GitHub `{0}` shell templates are not accepted. */
export const TASK_V3_HOST_SHELLS = ["bash", "sh", "zsh", "pwsh", "powershell", "cmd"] as const;
export type TaskV3HostShell = (typeof TASK_V3_HOST_SHELLS)[number];

export const TASK_V2_MIGRATION_HINT =
  "Run `akm migrate apply --dry-run` to preview the task-v2 to task-v3 conversion, then run `akm migrate apply`.";

export function taskV2UnsupportedError(filePath: string, id?: string): UsageError {
  const label = id ? `Task "${id}"` : "Task";
  return new UsageError(
    `TASK_SCHEMA_VERSION_UNSUPPORTED: ${label} uses task schema version 2, which normal execution does not accept. File: ${filePath}`,
    "TASK_SCHEMA_VERSION_UNSUPPORTED",
    TASK_V2_MIGRATION_HINT,
  );
}

export type TaskV3UsesTarget =
  | Readonly<{ kind: "builtin-command"; ref: "akm/command" }>
  | Readonly<{ kind: "command" | "workflow" | "script"; ref: string }>
  | Readonly<{
      kind: "github-action";
      ref: string;
      owner: string;
      repository: string;
      path?: string;
      revision: string;
    }>;

export type TaskV3Environment = Readonly<Record<string, string | number | boolean>>;

export interface TaskV3AkmOptions {
  readonly schedule?: string;
  readonly enabled?: boolean;
  readonly description?: string;
  readonly when_to_use?: string;
  readonly tags?: readonly string[];
  readonly agent?: string | null;
  readonly engine?: string | null;
  readonly model?: string | null;
  readonly inference?: ExecutionJsonObject | null;
  readonly outputSchema?: ExecutionJsonObject | null;
  readonly tools?: string | readonly string[] | ExecutionJsonObject | null;
  readonly timeout?: string | number | null;
  readonly redact?: readonly string[];
  readonly maxSteps?: number;
  readonly maxRetries?: number;
}

export type TaskV3Target =
  | Readonly<{
      kind: "uses";
      uses: TaskV3UsesTarget;
      with?: ExecutionJsonObject;
      command?: ParsedBuiltinCommandAction;
    }>
  | Readonly<{
      kind: "run";
      run: string;
      shell?: TaskV3HostShell;
      workingDirectory?: string;
    }>;

export interface TaskV3ScheduleBinding {
  readonly cron: string;
  readonly source: string;
  readonly ordinal: number;
}

export interface TaskV3TriggerPlan {
  readonly manual: boolean;
  readonly schedules: readonly TaskV3ScheduleBinding[];
}

export interface TaskV3SourceDocument {
  readonly version: typeof TASK_V3_SCHEMA_VERSION;
  readonly name?: string;
  readonly target: TaskV3Target;
  readonly env?: TaskV3Environment;
  readonly akm?: Readonly<TaskV3AkmOptions>;
  readonly triggers: TaskV3TriggerPlan;
  readonly source: Readonly<{ path: string }>;
}

export interface ParseTaskV3DocumentOptions {
  readonly filePath: string;
  /** Required when `working-directory` is authored so symlinks can be contained physically. */
  readonly workspaceRoot?: string;
  /** Internal line lookup supplied by the YAML adapter. */
  readonly lineAt?: (path: readonly (string | number)[]) => number | undefined;
}

export interface ParseTaskV3YamlInput extends Omit<ParseTaskV3DocumentOptions, "lineAt"> {
  readonly yaml: string;
}

export interface ClassifyTaskV3TriggersOptions {
  readonly filePath: string;
  readonly lineAt?: (path: readonly (string | number)[]) => number | undefined;
}

interface ParseContext extends ParseTaskV3DocumentOptions {}

interface CloneState {
  nodes: number;
}

const TOP_LEVEL_KEYS = ["version", "name", "uses", "run", "with", "env", "shell", "working-directory", "akm", "on"];
const AKM_KEYS = [
  "schedule",
  "enabled",
  "description",
  "when_to_use",
  "tags",
  "agent",
  "engine",
  "model",
  "inference",
  "outputSchema",
  "tools",
  "timeout",
  "redact",
  "maxSteps",
  "maxRetries",
];
const ON_KEYS = ["schedule", "workflow_dispatch"];
const SHELL_SET = new Set<string>(TASK_V3_HOST_SHELLS);
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]+$/;
const GITHUB_ACTION_PATH_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const GITHUB_REF_FORBIDDEN = new Set(["~", "^", ":", "?", "*", "[", "\\"]);

function own(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function wellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function hasForbiddenGithubRefCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x20 || codePoint === 0x7f || GITHUB_REF_FORBIDDEN.has(character)) return true;
  }
  return false;
}

function sourceError(ctx: ParseContext, fieldPath: readonly (string | number)[], detail: string): never {
  const dotted =
    fieldPath.length === 0
      ? "$"
      : fieldPath.reduce<string>(
          (display, segment) =>
            typeof segment === "number"
              ? `${display}[${segment}]`
              : display.length > 0
                ? `${display}.${segment}`
                : segment,
          "",
        );
  const line = ctx.lineAt?.(fieldPath);
  const location = `${ctx.filePath}${line === undefined ? "" : `:${line}`}`;
  throw new UsageError(`Invalid task v3 source at ${location}: ${dotted} ${detail}`, "INVALID_FLAG_VALUE");
}

function cloneBoundedJson(
  value: unknown,
  ctx: ParseContext,
  fieldPath: readonly (string | number)[],
  state: CloneState,
  depth = 0,
  ancestors: ReadonlySet<object> = new Set(),
): ExecutionJsonValue {
  state.nodes += 1;
  if (state.nodes > TASK_V3_MAX_JSON_NODES)
    sourceError(ctx, fieldPath, `exceeds the ${TASK_V3_MAX_JSON_NODES}-node limit.`);
  if (depth > TASK_V3_MAX_JSON_DEPTH)
    sourceError(ctx, fieldPath, `exceeds the nesting depth of ${TASK_V3_MAX_JSON_DEPTH}.`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) sourceError(ctx, fieldPath, "must be a finite JSON number.");
    return value;
  }
  if (typeof value === "string") {
    if (!wellFormedUnicode(value)) sourceError(ctx, fieldPath, "must contain well-formed Unicode.");
    if (utf8Bytes(value) > TASK_V3_MAX_STRING_BYTES) {
      sourceError(ctx, fieldPath, `exceeds the ${TASK_V3_MAX_STRING_BYTES}-byte string limit.`);
    }
    return value;
  }
  if (value === undefined) sourceError(ctx, fieldPath, "must be omitted instead of set to undefined.");
  if (typeof value !== "object") sourceError(ctx, fieldPath, "must be JSON-safe.");
  if (utilTypes.isProxy(value)) sourceError(ctx, fieldPath, "must not be a Proxy object.");
  if (ancestors.has(value)) sourceError(ctx, fieldPath, "must not contain a cycle.");
  const nextAncestors = new Set(ancestors).add(value);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype)
      sourceError(ctx, fieldPath, "array must use the standard prototype.");
    const rawLength = Reflect.getOwnPropertyDescriptor(value, "length")?.value;
    if (
      typeof rawLength !== "number" ||
      !Number.isInteger(rawLength) ||
      rawLength < 0 ||
      rawLength > TASK_V3_MAX_COLLECTION_ITEMS
    ) {
      sourceError(ctx, fieldPath, `array exceeds the ${TASK_V3_MAX_COLLECTION_ITEMS}-item limit.`);
    }
    const length = rawLength as number;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1) sourceError(ctx, fieldPath, "array must be dense and contain no extra fields.");
    const result: ExecutionJsonValue[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        sourceError(ctx, [...fieldPath, index], "array item must be an enumerable data property in a dense array.");
      }
      result.push(cloneBoundedJson(descriptor.value, ctx, [...fieldPath, index], state, depth + 1, nextAncestors));
    }
    return Object.freeze(result);
  }

  let snapshot: StrictRecordSnapshot;
  try {
    snapshot = snapshotStrictRecord(value, fieldPath.map(String).join(".") || "task source");
  } catch (cause) {
    sourceError(ctx, fieldPath, cause instanceof Error ? cause.message : String(cause));
  }
  const entries = Object.entries(snapshot);
  if (entries.length > TASK_V3_MAX_OBJECT_KEYS) {
    sourceError(ctx, fieldPath, `mapping exceeds the ${TASK_V3_MAX_OBJECT_KEYS}-key limit.`);
  }
  const result = Object.create(null) as Record<string, ExecutionJsonValue>;
  for (const [key, child] of entries) {
    if (!wellFormedUnicode(key)) sourceError(ctx, fieldPath, "contains a mapping key with malformed Unicode.");
    if (utf8Bytes(key) > TASK_V3_MAX_STRING_BYTES) {
      sourceError(
        ctx,
        fieldPath,
        `contains a mapping key exceeding the ${TASK_V3_MAX_STRING_BYTES}-byte string limit.`,
      );
    }
    Object.defineProperty(result, key, {
      value: cloneBoundedJson(child, ctx, [...fieldPath, key], state, depth + 1, nextAncestors),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(result);
}

function asRecord(
  value: ExecutionJsonValue,
  ctx: ParseContext,
  fieldPath: readonly (string | number)[],
): ExecutionJsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object")
    sourceError(ctx, fieldPath, "must be a mapping.");
  return value as ExecutionJsonObject;
}

function checkKeys(
  value: ExecutionJsonObject,
  allowed: readonly string[],
  ctx: ParseContext,
  fieldPath: readonly (string | number)[],
): void {
  const allow = new Set(allowed);
  const firstUnknown = Object.keys(value).find((key) => !allow.has(key));
  if (firstUnknown !== undefined) sourceError(ctx, [...fieldPath, firstUnknown], "is an unsupported field.");
}

function presentJsonValue(
  value: ExecutionJsonValue | undefined,
  ctx: ParseContext,
  fieldPath: readonly (string | number)[],
): ExecutionJsonValue {
  if (value === undefined) sourceError(ctx, fieldPath, "must be omitted instead of set to undefined.");
  return value;
}

function stringField(
  value: unknown,
  ctx: ParseContext,
  fieldPath: readonly (string | number)[],
  options: { nonempty?: boolean; nullable?: boolean } = {},
): string | null {
  if (value === null && options.nullable) return null;
  if (typeof value !== "string")
    sourceError(ctx, fieldPath, options.nullable ? "must be a string or null." : "must be a string.");
  if (options.nonempty && value.trim().length === 0) sourceError(ctx, fieldPath, "must be a non-empty string.");
  return value;
}

function noGithubExpression(value: string, ctx: ParseContext, fieldPath: readonly (string | number)[]): void {
  if (value.includes("${{")) sourceError(ctx, fieldPath, "contains an unsupported GitHub expression.");
}

function parseEnvironment(value: ExecutionJsonValue, ctx: ParseContext): TaskV3Environment {
  const environment = asRecord(value, ctx, ["env"]);
  for (const [key, child] of Object.entries(environment)) {
    if (!WORKFLOW_ENV_VAR_NAME_PATTERN.test(key))
      sourceError(ctx, ["env", key], "has an invalid environment variable name.");
    if (typeof child !== "string" && typeof child !== "number" && typeof child !== "boolean") {
      sourceError(ctx, ["env", key], "must be a string, finite number, or boolean.");
    }
  }
  return environment as TaskV3Environment;
}

function nullableSelector(value: unknown, ctx: ParseContext, key: string): string | null {
  const selector = stringField(value, ctx, ["akm", key], { nullable: true });
  if (selector !== null && selector.trim().length === 0)
    sourceError(ctx, ["akm", key], "must be null or a non-empty string.");
  return selector;
}

function parseTimeout(value: unknown, ctx: ParseContext): string | number | null {
  if (value === null) return null;
  if (typeof value === "string" && value.trim() !== value) {
    sourceError(ctx, ["akm", "timeout"], "must not contain surrounding whitespace.");
  }
  const milliseconds = typeof value === "string" ? parseDuration(value, DURATION_UNITS) : value;
  if (
    milliseconds === null ||
    typeof milliseconds !== "number" ||
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 0 ||
    milliseconds > EXECUTION_MAX_TIMEOUT_MS
  ) {
    sourceError(
      ctx,
      ["akm", "timeout"],
      `must be null, 0 through ${EXECUTION_MAX_TIMEOUT_MS} milliseconds, or a common duration such as 20m.`,
    );
  }
  return value as string | number;
}

function parseStringArray(
  value: unknown,
  ctx: ParseContext,
  fieldPath: readonly (string | number)[],
  options: { max?: number; pattern?: RegExp } = {},
): readonly string[] {
  if (!Array.isArray(value)) sourceError(ctx, fieldPath, "must be an array of strings.");
  if (options.max !== undefined && value.length > options.max)
    sourceError(ctx, fieldPath, `accepts at most ${options.max} items.`);
  const strings: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || entry.length === 0)
      sourceError(ctx, [...fieldPath, index], "must be a non-empty string.");
    if (options.pattern && !options.pattern.test(entry))
      sourceError(ctx, [...fieldPath, index], "has an invalid value.");
    strings.push(entry);
  }
  return Object.freeze(strings);
}

function parseTools(value: ExecutionJsonValue, ctx: ParseContext): TaskV3AkmOptions["tools"] {
  if (value === null || typeof value === "string") return value;
  if (Array.isArray(value)) {
    if (value.some((entry) => typeof entry !== "string"))
      sourceError(ctx, ["akm", "tools"], "array values must be strings.");
    return value as readonly string[];
  }
  if (typeof value === "object") return value as ExecutionJsonObject;
  sourceError(ctx, ["akm", "tools"], "must be a string, string array, mapping, or null.");
}

function parseAkm(value: ExecutionJsonValue, ctx: ParseContext): Readonly<TaskV3AkmOptions> {
  const input = asRecord(value, ctx, ["akm"]);
  checkKeys(input, AKM_KEYS, ctx, ["akm"]);
  const out: Record<string, unknown> = {};
  if (own(input, "schedule")) {
    const schedule = stringField(input.schedule, ctx, ["akm", "schedule"], { nonempty: true }) as string;
    noGithubExpression(schedule, ctx, ["akm", "schedule"]);
    out.schedule = schedule;
  }
  if (own(input, "enabled")) {
    if (typeof input.enabled !== "boolean") sourceError(ctx, ["akm", "enabled"], "must be a boolean.");
    out.enabled = input.enabled;
  }
  for (const key of ["description", "when_to_use"] as const) {
    if (own(input, key)) out[key] = stringField(input[key], ctx, ["akm", key]);
  }
  if (own(input, "tags")) out.tags = parseStringArray(input.tags, ctx, ["akm", "tags"]);
  for (const key of ["agent", "engine", "model"] as const) {
    if (own(input, key)) out[key] = nullableSelector(input[key], ctx, key);
  }
  if (own(input, "inference")) {
    const inference = presentJsonValue(input.inference, ctx, ["akm", "inference"]);
    out.inference = inference === null ? null : asRecord(inference, ctx, ["akm", "inference"]);
  }
  if (own(input, "outputSchema")) {
    const outputSchema = presentJsonValue(input.outputSchema, ctx, ["akm", "outputSchema"]);
    if (outputSchema === null) out.outputSchema = null;
    else {
      const schema = asRecord(outputSchema, ctx, ["akm", "outputSchema"]);
      const issue = checkJsonSchemaDefinition(schema as Record<string, unknown>)[0];
      if (issue) sourceError(ctx, ["akm", "outputSchema"], `is not a supported JSON schema: ${issue.message}`);
      out.outputSchema = schema;
    }
  }
  if (own(input, "tools")) out.tools = parseTools(presentJsonValue(input.tools, ctx, ["akm", "tools"]), ctx);
  if (own(input, "timeout")) out.timeout = parseTimeout(input.timeout, ctx);
  if (own(input, "redact")) {
    const names = parseStringArray(input.redact, ctx, ["akm", "redact"], {
      max: WORKFLOW_MAX_EXEC_PASS_ENV,
      pattern: WORKFLOW_ENV_VAR_NAME_PATTERN,
    });
    if (new Set(names).size !== names.length) sourceError(ctx, ["akm", "redact"], "must not contain duplicate names.");
    out.redact = names;
  }
  if (own(input, "maxSteps")) {
    if (!Number.isSafeInteger(input.maxSteps) || (input.maxSteps as number) < 1) {
      sourceError(ctx, ["akm", "maxSteps"], "must be a positive safe integer.");
    }
    out.maxSteps = input.maxSteps;
  }
  if (own(input, "maxRetries")) {
    if (
      !Number.isSafeInteger(input.maxRetries) ||
      (input.maxRetries as number) < 0 ||
      (input.maxRetries as number) > WORKFLOW_MAX_RETRIES
    ) {
      sourceError(ctx, ["akm", "maxRetries"], `must be an integer from 0 through ${WORKFLOW_MAX_RETRIES}.`);
    }
    out.maxRetries = input.maxRetries;
  }
  return Object.freeze(out) as Readonly<TaskV3AkmOptions>;
}

function validGithubRevision(revision: string): boolean {
  if (
    revision.length === 0 ||
    hasForbiddenGithubRefCharacter(revision) ||
    revision.startsWith("/") ||
    revision.endsWith("/") ||
    revision.includes("..") ||
    revision.includes("@{") ||
    revision.includes("@")
  ) {
    return false;
  }
  return revision
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !segment.startsWith(".") &&
        !segment.endsWith(".") &&
        !segment.endsWith(".lock"),
    );
}

/** Classify one exact `uses` string. This function never resolves or guesses. */
export function classifyTaskV3Uses(value: string): TaskV3UsesTarget {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    /\s/.test(value) ||
    value.includes("${{")
  ) {
    throw new UsageError(
      "Task v3 uses must be one exact, non-empty executable ref without expressions.",
      "INVALID_FLAG_VALUE",
    );
  }
  if (value === "akm/command") return Object.freeze({ kind: "builtin-command" as const, ref: "akm/command" as const });

  try {
    const parsed = parseBundleRef(value);
    if (parsed.fragment === undefined && bundleRefToString(parsed) === value) {
      const slash = parsed.conceptId.indexOf("/");
      const family = slash < 0 ? "" : parsed.conceptId.slice(0, slash);
      const name = slash < 0 ? "" : parsed.conceptId.slice(slash + 1);
      if (name.length > 0 && (family === "commands" || family === "workflows" || family === "scripts")) {
        const kind = family === "commands" ? "command" : family === "workflows" ? "workflow" : "script";
        return Object.freeze({ kind, ref: value });
      }
      if (family === "agents") {
        throw new UsageError(
          "An agent ref selects a persona and is not executable through task v3 uses.",
          "INVALID_FLAG_VALUE",
        );
      }
      if (family === "tasks") {
        throw new UsageError("A task ref is not an executable task-v3 uses target.", "INVALID_FLAG_VALUE");
      }
    }
  } catch (error) {
    if (error instanceof UsageError && /agent ref|task ref/i.test(error.message)) throw error;
  }

  const at = value.lastIndexOf("@");
  if (at > 0 && at === value.indexOf("@")) {
    const locator = value.slice(0, at);
    const revision = value.slice(at + 1);
    const segments = locator.split("/");
    const [owner, repository, ...actionPath] = segments;
    if (
      owner &&
      repository &&
      GITHUB_OWNER.test(owner) &&
      GITHUB_REPOSITORY.test(repository) &&
      repository !== "." &&
      repository !== ".." &&
      actionPath.every((segment) => GITHUB_ACTION_PATH_SEGMENT.test(segment) && segment !== "." && segment !== "..") &&
      validGithubRevision(revision)
    ) {
      const action = {
        kind: "github-action" as const,
        ref: value,
        owner,
        repository,
        ...(actionPath.length > 0 ? { path: actionPath.join("/") } : {}),
        revision,
      };
      return Object.freeze(action);
    }
  }
  throw new UsageError(
    "Task v3 uses must be akm/command, a canonical commands/, workflows/, or scripts/ asset ref, or owner/repo[/path]@ref. Agent/task/local/Docker/ambiguous targets are not executable.",
    "INVALID_FLAG_VALUE",
  );
}

function parseOn(value: ExecutionJsonValue, ctx: ParseContext): TaskV3TriggerPlan {
  const input = asRecord(value, ctx, ["on"]);
  const keys = Object.keys(input);
  if (keys.length === 0) sourceError(ctx, ["on"], "must declare schedule and/or workflow_dispatch.");
  const unsupported = keys.find((key) => !ON_KEYS.includes(key));
  if (unsupported)
    sourceError(ctx, ["on", unsupported], "is an unsupported local service event; no scheduler binding was created.");
  const schedules: TaskV3ScheduleBinding[] = [];
  if (own(input, "schedule")) {
    if (!Array.isArray(input.schedule) || input.schedule.length === 0) {
      sourceError(ctx, ["on", "schedule"], "must be a non-empty list of {cron: string} records.");
    }
    if (input.schedule.length > TASK_V3_MAX_SCHEDULES) {
      sourceError(ctx, ["on", "schedule"], `accepts at most ${TASK_V3_MAX_SCHEDULES} entries.`);
    }
    for (const [index, raw] of input.schedule.entries()) {
      const entry = asRecord(raw, ctx, ["on", "schedule", index]);
      checkKeys(entry, ["cron"], ctx, ["on", "schedule", index]);
      if (!own(entry, "cron")) sourceError(ctx, ["on", "schedule", index, "cron"], "is required.");
      const cron = stringField(entry.cron, ctx, ["on", "schedule", index, "cron"], { nonempty: true }) as string;
      noGithubExpression(cron, ctx, ["on", "schedule", index, "cron"]);
      schedules.push(Object.freeze({ cron, source: `on.schedule[${index}].cron`, ordinal: index }));
    }
  }
  let manual = false;
  if (own(input, "workflow_dispatch")) {
    const dispatch = input.workflow_dispatch;
    if (dispatch !== null) {
      const mapping = asRecord(presentJsonValue(dispatch, ctx, ["on", "workflow_dispatch"]), ctx, [
        "on",
        "workflow_dispatch",
      ]);
      if (Object.keys(mapping).length > 0) {
        sourceError(ctx, ["on", "workflow_dispatch"], "must be null or an empty mapping; inputs are unsupported.");
      }
    }
    manual = true;
  }
  return Object.freeze({ manual, schedules: Object.freeze(schedules) });
}

function compileTriggers(
  input: ExecutionJsonObject,
  akm: Readonly<TaskV3AkmOptions> | undefined,
  ctx: ParseContext,
): TaskV3TriggerPlan {
  const hasSchedule = akm !== undefined && own(akm, "schedule");
  const hasOn = own(input, "on");
  if (hasSchedule === hasOn) {
    sourceError(ctx, [], "must declare exactly one scheduling source: akm.schedule or on.");
  }
  if (hasOn) return parseOn(presentJsonValue(input.on, ctx, ["on"]), ctx);
  return Object.freeze({
    manual: false,
    schedules: Object.freeze([Object.freeze({ cron: akm?.schedule as string, source: "akm.schedule", ordinal: 0 })]),
  });
}

interface ParsedTaskV3TriggerFields {
  readonly akm?: Readonly<TaskV3AkmOptions>;
  readonly triggers: TaskV3TriggerPlan;
}

function parseTaskV3TriggerFields(input: ExecutionJsonObject, ctx: ParseContext): ParsedTaskV3TriggerFields {
  const akm = own(input, "akm") ? parseAkm(presentJsonValue(input.akm, ctx, ["akm"]), ctx) : undefined;
  return Object.freeze({ ...(akm ? { akm } : {}), triggers: compileTriggers(input, akm, ctx) });
}

/**
 * Classify the strict trigger fragment `{akm?, on?}` into deterministic local
 * scheduler bindings. Full workflow adapters pass only those two fields; this
 * rejects `jobs` and every other workflow field rather than owning WP7's
 * document grammar.
 */
export function classifyTaskV3Triggers(value: unknown, options: ClassifyTaskV3TriggersOptions): TaskV3TriggerPlan {
  const ctx: ParseContext = options;
  const cloned = cloneBoundedJson(value, ctx, [], { nodes: 0 });
  const input = asRecord(cloned, ctx, []);
  checkKeys(input, ["akm", "on"], ctx, []);
  return parseTaskV3TriggerFields(input, ctx).triggers;
}

function validateWorkingDirectory(value: string, ctx: ParseContext): void {
  if (
    value.trim().length === 0 ||
    value.includes("\0") ||
    path.posix.isAbsolute(value.replaceAll("\\", "/")) ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith("\\\\")
  ) {
    sourceError(ctx, ["working-directory"], "must be a non-empty relative path contained by the workspace root.");
  }
  const segments = value.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => segment === ".." || segment.length === 0)) {
    sourceError(ctx, ["working-directory"], "must not contain empty or escaping path segments.");
  }
  if (!ctx.workspaceRoot) {
    sourceError(ctx, ["working-directory"], "requires a workspace root so physical containment can be verified.");
  }
  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = fs.realpathSync(ctx.workspaceRoot);
    const candidate = path.resolve(realRoot, value);
    const stat = fs.statSync(candidate);
    if (!stat.isDirectory()) sourceError(ctx, ["working-directory"], "must resolve to a directory.");
    realCandidate = fs.realpathSync(candidate);
  } catch (cause) {
    if (cause instanceof UsageError) throw cause;
    sourceError(
      ctx,
      ["working-directory"],
      `cannot be physically verified: ${cause instanceof Error ? cause.message : String(cause)}.`,
    );
  }
  const relative = path.relative(realRoot, realCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    sourceError(ctx, ["working-directory"], "resolves outside the workspace root and is not physically contained.");
  }
}

export function parseTaskV3Document(value: unknown, options: ParseTaskV3DocumentOptions): TaskV3SourceDocument {
  const ctx: ParseContext = options;
  const cloned = cloneBoundedJson(value, ctx, [], { nodes: 0 });
  const input = asRecord(cloned, ctx, []);
  if (!own(input, "version")) sourceError(ctx, ["version"], "is required and must be 3.");
  if (input.version === 2) throw taskV2UnsupportedError(options.filePath);
  if (input.version !== TASK_V3_SCHEMA_VERSION) sourceError(ctx, ["version"], "must be exactly 3.");
  checkKeys(input, TOP_LEVEL_KEYS, ctx, []);

  const hasUses = own(input, "uses");
  const hasRun = own(input, "run");
  if (hasUses === hasRun) sourceError(ctx, [], "requires exactly one executable selector: uses or run.");

  const name = own(input, "name") ? (stringField(input.name, ctx, ["name"]) as string) : undefined;
  const env = own(input, "env") ? parseEnvironment(presentJsonValue(input.env, ctx, ["env"]), ctx) : undefined;
  const { akm, triggers } = parseTaskV3TriggerFields(input, ctx);
  let target: TaskV3Target;

  if (hasUses) {
    if (own(input, "shell")) sourceError(ctx, ["shell"], "is legal only with run.");
    if (own(input, "working-directory")) sourceError(ctx, ["working-directory"], "is legal only with run.");
    const usesText = stringField(input.uses, ctx, ["uses"], { nonempty: true }) as string;
    let uses: TaskV3UsesTarget;
    try {
      uses = classifyTaskV3Uses(usesText);
    } catch (cause) {
      sourceError(ctx, ["uses"], cause instanceof Error ? cause.message : String(cause));
    }
    let withValues: ExecutionJsonObject | undefined;
    if (own(input, "with")) withValues = asRecord(presentJsonValue(input.with, ctx, ["with"]), ctx, ["with"]);
    if (uses.kind === "builtin-command") {
      let command: ParsedBuiltinCommandAction;
      try {
        command = parseBuiltinCommandAction(withValues);
      } catch (cause) {
        sourceError(ctx, ["with"], cause instanceof Error ? cause.message : String(cause));
      }
      target = Object.freeze({ kind: "uses", uses, ...(withValues ? { with: withValues } : {}), command });
    } else {
      target = Object.freeze({ kind: "uses", uses, ...(withValues ? { with: withValues } : {}) });
    }
  } else {
    if (own(input, "with")) sourceError(ctx, ["with"], "is legal only with uses.");
    const run = stringField(input.run, ctx, ["run"], { nonempty: true }) as string;
    noGithubExpression(run, ctx, ["run"]);
    let shell: TaskV3HostShell | undefined;
    if (own(input, "shell")) {
      const rawShell = stringField(input.shell, ctx, ["shell"], { nonempty: true }) as string;
      if (!SHELL_SET.has(rawShell)) {
        sourceError(ctx, ["shell"], `must be one of the closed host-shell table: ${TASK_V3_HOST_SHELLS.join(", ")}.`);
      }
      shell = rawShell as TaskV3HostShell;
    }
    let workingDirectory: string | undefined;
    if (own(input, "working-directory")) {
      workingDirectory = stringField(input["working-directory"], ctx, ["working-directory"], {
        nonempty: true,
      }) as string;
      validateWorkingDirectory(workingDirectory, ctx);
    }
    target = Object.freeze({
      kind: "run",
      run,
      ...(shell ? { shell } : {}),
      ...(workingDirectory ? { workingDirectory } : {}),
    });
  }

  return Object.freeze({
    version: TASK_V3_SCHEMA_VERSION,
    ...(name !== undefined ? { name } : {}),
    target,
    ...(env !== undefined ? { env } : {}),
    ...(akm !== undefined ? { akm } : {}),
    triggers,
    source: Object.freeze({ path: options.filePath }),
  });
}

function yamlProblem(message: string): string {
  return message.split("\n")[0]?.trim() || "invalid YAML";
}

interface BoundedTaskYamlOptions {
  readonly filePath: string;
  readonly sourceLabel: string;
  readonly lineCounter?: LineCounter;
}

function yamlAstError(options: BoundedTaskYamlOptions, node: unknown, detail: string): never {
  const range = (node as { range?: readonly number[] | null } | null | undefined)?.range;
  const line = range && options.lineCounter ? options.lineCounter.linePos(range[0] ?? 0).line : undefined;
  throw new UsageError(
    `Invalid ${options.sourceLabel} at ${options.filePath}${line === undefined ? "" : `:${line}`}: ${detail}`,
    "INVALID_FLAG_VALUE",
  );
}

/**
 * Bound and close the YAML AST before `toJS` can allocate or recurse through
 * it. This is shared by the v3 parser and the explicit v2 migration reader.
 */
export function assertBoundedTaskYamlDocument(
  document: ReturnType<typeof parseDocument>,
  options: BoundedTaskYamlOptions,
): void {
  const stack: Array<{ node: unknown; depth: number }> = [{ node: document.contents, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    const node = current.node;
    if (node === null || node === undefined) continue;
    nodes += 1;
    if (nodes > TASK_V3_MAX_JSON_NODES) {
      yamlAstError(options, node, `YAML exceeds the ${TASK_V3_MAX_JSON_NODES}-node limit.`);
    }
    if (current.depth > TASK_V3_MAX_JSON_DEPTH) {
      yamlAstError(options, node, `YAML exceeds the nesting depth of ${TASK_V3_MAX_JSON_DEPTH}.`);
    }
    if (isAlias(node)) yamlAstError(options, node, "YAML aliases are unsupported.");
    if ((node as { anchor?: unknown }).anchor !== undefined) {
      yamlAstError(options, node, "YAML anchors are unsupported.");
    }
    if ((node as { tag?: unknown }).tag) {
      yamlAstError(options, node, "custom or explicit YAML tags are unsupported.");
    }
    if (isScalar(node)) continue;
    if (isSeq(node)) {
      if (node.items.length > TASK_V3_MAX_COLLECTION_ITEMS) {
        yamlAstError(options, node, `YAML sequence exceeds the ${TASK_V3_MAX_COLLECTION_ITEMS}-item limit.`);
      }
      for (let index = node.items.length - 1; index >= 0; index -= 1) {
        stack.push({ node: node.items[index], depth: current.depth + 1 });
      }
      continue;
    }
    if (isMap(node)) {
      if (node.items.length > TASK_V3_MAX_OBJECT_KEYS) {
        yamlAstError(options, node, `YAML mapping exceeds the ${TASK_V3_MAX_OBJECT_KEYS}-key limit.`);
      }
      for (let index = node.items.length - 1; index >= 0; index -= 1) {
        const pair = node.items[index];
        if (!pair) yamlAstError(options, node, "sparse YAML mappings are unsupported.");
        if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
          yamlAstError(options, pair.key, "non-string YAML mapping keys are unsupported.");
        }
        if (!wellFormedUnicode(pair.key.value)) {
          yamlAstError(options, pair.key, "YAML mapping key must contain well-formed Unicode.");
        }
        if (utf8Bytes(pair.key.value) > TASK_V3_MAX_STRING_BYTES) {
          yamlAstError(
            options,
            pair.key,
            `YAML mapping key exceeds the ${TASK_V3_MAX_STRING_BYTES}-byte string limit.`,
          );
        }
        if (pair.key.value === "<<") yamlAstError(options, pair.key, "YAML merge keys are unsupported.");
        stack.push({ node: pair.value, depth: current.depth + 1 });
        stack.push({ node: pair.key, depth: current.depth + 1 });
      }
      continue;
    }
    yamlAstError(options, node, "unsupported YAML node kind.");
  }
}

/** Preserve actionable classified hints when a parser failure becomes a diagnostic. */
export function taskV3SourceErrorDetail(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  const hint =
    "hint" in cause && typeof (cause as { hint?: unknown }).hint === "function"
      ? (cause as { hint: () => string | undefined }).hint()
      : undefined;
  return hint ? `${cause.message} ${hint}` : cause.message;
}

/** Parse hostile YAML without aliases/tags/merges, then enter the canonical object parser. */
export function parseTaskV3Yaml(input: ParseTaskV3YamlInput): TaskV3SourceDocument {
  if (typeof input.yaml !== "string") {
    throw new UsageError(`Invalid task v3 source at ${input.filePath}: source must be a string.`, "INVALID_FLAG_VALUE");
  }
  if (utf8Bytes(input.yaml) > TASK_V3_MAX_SOURCE_BYTES) {
    throw new UsageError(
      `Invalid task v3 source at ${input.filePath}: source exceeds the 1 MiB (${TASK_V3_MAX_SOURCE_BYTES}-byte) resource limit.`,
      "INVALID_FLAG_VALUE",
    );
  }
  const lineCounter = new LineCounter();
  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(input.yaml, { lineCounter, uniqueKeys: true });
  } catch (cause) {
    throw new UsageError(
      `Invalid task v3 source at ${input.filePath}: YAML parsing failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      "INVALID_FLAG_VALUE",
    );
  }
  const [problem] = document.errors;
  if (problem) {
    const offset = Array.isArray(problem.pos) ? problem.pos[0] : 0;
    throw new UsageError(
      `Invalid task v3 source at ${input.filePath}:${lineCounter.linePos(offset).line}: ${yamlProblem(problem.message)}`,
      "INVALID_FLAG_VALUE",
    );
  }
  const [warning] = document.warnings;
  if (warning) {
    throw new UsageError(
      `Invalid task v3 source at ${input.filePath}: unsupported YAML construct: ${yamlProblem(warning.message)}`,
      "INVALID_FLAG_VALUE",
    );
  }
  assertBoundedTaskYamlDocument(document, { filePath: input.filePath, sourceLabel: "task v3 source", lineCounter });
  let root: unknown;
  try {
    root = document.toJS({ maxAliasCount: 0 });
  } catch (cause) {
    throw new UsageError(
      `Invalid task v3 source at ${input.filePath}: YAML expansion failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      "INVALID_FLAG_VALUE",
    );
  }
  const lineAt = (fieldPath: readonly (string | number)[]): number | undefined => {
    for (let depth = fieldPath.length; depth >= 0; depth -= 1) {
      const node = depth === 0 ? document.contents : document.getIn(fieldPath.slice(0, depth), true);
      const range = (node as { range?: [number, number, number] | null } | null | undefined)?.range;
      if (range) return lineCounter.linePos(range[0]).line;
    }
    return undefined;
  };
  return parseTaskV3Document(root, {
    filePath: input.filePath,
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    lineAt,
  });
}
