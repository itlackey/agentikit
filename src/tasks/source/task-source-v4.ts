// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Task source v4 — the second, additive task source grammar (spec
 * docs/plans/specs/p2a-task-source-v4.md §1.1 D1, §1.2 D2, §1.5 D2-N1..D2-N7,
 * §3). Never call this grammar bare "v4" in prose — the workflow plan IR is
 * separately versioned (D1).
 *
 * `version: 4` introduces typed `inputs:`, a single bounded `output:` schema,
 * OPTIONAL scheduling (absent `schedule:` is valid and manual-only, D2-N6),
 * and top-level execution controls (the `akm:` options bag and the `on:`
 * trigger block are both GONE — every `akm:` member that D2 does not
 * re-home survives as a top-level key instead, D2-N7). There is no
 * github-action `uses:` variant.
 *
 * `src/tasks/source-v3.ts` is untouched by this phase (task brief: "v3
 * parsing is UNTOUCHED"). D2-N4 asks for the bounded-document front end and
 * field helpers to move body-intact out of that file; since it cannot be
 * edited here, `./bounded-document.ts` carries a fresh, parameterized
 * reimplementation of the helpers that are already path-generic in v3
 * (no hardcoded `"akm"` segment), and this file implements its own
 * top-level-rooted versions of the three v3 helpers that DO hardcode
 * `["akm", …]` (`parseTimeout`, `nullableSelector`, `parseTools`) — v4 needs
 * the same accept/reject semantics at a different field path, not the same
 * field path.
 */

import { type ParsedBuiltinCommandAction, parseBuiltinCommandAction } from "../../commands/command/builtin-action";
import { UsageError } from "../../core/errors";
import { checkJsonSchemaDefinition, JSON_SCHEMA_SUBSET_SUPPORTED_KEYWORDS, validateJsonSchemaSubset } from "../../core/json-schema";
import { warn } from "../../core/warn";
import { DURATION_UNITS, parseDuration } from "../../core/time";
import type { ExecutionJsonObject, ExecutionJsonValue } from "../../execution/json";
import { EXECUTION_MAX_TIMEOUT_MS } from "../../execution/limits";
import { INPUT_NAME_PATTERN, type InputContract, type InputDeclaration, validateInputs } from "../../execution/input-contract";
import { classifyTargetRef } from "../../execution/target-ref";
import {
  TASK_V3_HOST_SHELLS,
  TASK_V3_MAX_SCHEDULES,
  type TaskV3Environment,
  type TaskV3HostShell,
} from "../source-v3";
import { detectSecretShapedParams } from "../../workflows/exec/param-secrets";
import { WORKFLOW_ENV_VAR_NAME_PATTERN, WORKFLOW_MAX_EXEC_PASS_ENV, WORKFLOW_MAX_PARAMS, WORKFLOW_MAX_RETRIES, WORKFLOW_MAX_SCHEMA_BYTES } from "../../workflows/resource-limits";
import {
  asRecord,
  type BoundedDocumentContext,
  checkKeys,
  cloneBoundedJson,
  noGithubExpression,
  own,
  parseEnvironment,
  parseStringArray,
  presentJsonValue,
  readBoundedTaskSourceYaml,
  sourceError,
  stringField,
  utf8Bytes,
  validateWorkingDirectory,
} from "./bounded-document";

// ── Closed constants (D1, D2-N3, D2-N7) ─────────────────────────────────────

export const TASK_SOURCE_V4_VERSION = 4 as const;

/** The exact, closed top-level key set (D2-N7) — `akm` and `on` are deliberately absent. */
export const TASK_SOURCE_V4_TOP_LEVEL_KEYS = [
  "version",
  "name",
  "description",
  "when_to_use",
  "tags",
  "inputs",
  "output",
  "uses",
  "run",
  "with",
  "env",
  "shell",
  "working-directory",
  "schedule",
  "agent",
  "engine",
  "model",
  "inference",
  "tools",
  "timeout",
  "redact",
  "maxSteps",
  "maxRetries",
] as const;

/** Closes one `schedule:` list entry (D2-N5). */
export const TASK_SOURCE_V4_SCHEDULE_KEYS = ["cron", "enabled", "inputs"] as const;

/**
 * The closed key set for one `inputs.<name>` declaration root (D2-N3). The
 * JSON-Schema-subset portion is DERIVED from
 * `JSON_SCHEMA_SUBSET_SUPPORTED_KEYWORDS` (`src/core/json-schema.ts`) rather
 * than restated, so the two lists cannot silently drift; `title`,
 * `description`, and `default` are the v4-only declaration keys layered on
 * top (`required` is already one of the derived subset keywords — at the
 * declaration ROOT it is re-interpreted as the boolean flag, D2-N3).
 */
const SUBSET_KEYWORD_NAMES = JSON_SCHEMA_SUBSET_SUPPORTED_KEYWORDS.split(",")
  .map((entry) => entry.split(":")[0]?.trim() ?? "")
  .filter((entry) => entry.length > 0);
export const TASK_INPUT_DECLARATION_KEYS = Object.freeze([...SUBSET_KEYWORD_NAMES, "title", "description", "default"]);

const SHELL_SET = new Set<string>(TASK_V3_HOST_SHELLS);

// ── Types (spec §3.2) ────────────────────────────────────────────────────────

export type TaskSourceV4UsesTarget =
  | Readonly<{ kind: "builtin-command"; ref: "akm/command" }>
  | Readonly<{ kind: "command" | "script" | "workflow"; ref: string }>;

export type TaskSourceV4Target =
  | Readonly<{
      kind: "uses";
      uses: TaskSourceV4UsesTarget;
      with?: ExecutionJsonObject;
      command?: ParsedBuiltinCommandAction;
    }>
  | Readonly<{
      kind: "run";
      run: string;
      shell?: TaskV3HostShell;
      workingDirectory?: string;
    }>;

export interface TaskSourceV4ScheduleBinding {
  readonly cron: string;
  readonly enabled: boolean;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly source: string;
  readonly ordinal: number;
}

export interface TaskSourceV4Execution {
  readonly agent?: string | null;
  readonly engine?: string | null;
  readonly model?: string | null;
  readonly inference?: ExecutionJsonObject | null;
  readonly tools?: string | readonly string[] | ExecutionJsonObject | null;
  readonly timeout?: string | number | null;
  readonly redact?: readonly string[];
  readonly maxSteps?: number;
  readonly maxRetries?: number;
}

export interface TaskSourceV4Document {
  readonly version: typeof TASK_SOURCE_V4_VERSION;
  readonly name?: string;
  readonly description?: string;
  readonly when_to_use?: string;
  readonly tags?: readonly string[];
  readonly inputs?: InputContract;
  readonly output?: Readonly<Record<string, unknown>>;
  readonly target: TaskSourceV4Target;
  readonly env?: TaskV3Environment;
  readonly execution: TaskSourceV4Execution;
  readonly schedule: readonly TaskSourceV4ScheduleBinding[];
  readonly manualOnly: boolean;
  readonly source: Readonly<{ path: string }>;
}

export interface ParseTaskSourceV4DocumentOptions {
  readonly filePath: string;
  /** Required when `working-directory` is authored so symlinks can be contained physically. */
  readonly workspaceRoot?: string;
  /** Internal line lookup supplied by the router/YAML adapter. */
  readonly lineAt?: (fieldPath: readonly (string | number)[]) => number | undefined;
}

export interface ParseTaskSourceV4Input extends Omit<ParseTaskSourceV4DocumentOptions, "lineAt"> {
  readonly yaml: string;
}

const SOURCE_LABEL = "task source v4";

function ctxFrom(options: ParseTaskSourceV4DocumentOptions): BoundedDocumentContext {
  return { filePath: options.filePath, sourceLabel: SOURCE_LABEL, ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}), ...(options.lineAt ? { lineAt: options.lineAt } : {}) };
}

// ── classifyTaskSourceV4Uses (spec §3.3) ────────────────────────────────────

/**
 * A value SHAPED like `owner/repo[/path]@revision` — used only to produce a
 * good "the github-action target was removed" message (B-13), never to
 * accept. Deliberately a shape test, not v3's full github-locator grammar
 * (`validGithubRevision`, `source-v3.ts:497-520`) — that full grammar exists
 * to decide ACCEPTANCE in v3; v4 never accepts a github locator, so only the
 * shape needs to be recognized here.
 */
function looksLikeGithubActionLocator(value: string): boolean {
  const at = value.lastIndexOf("@");
  if (at <= 0) return false;
  const locator = value.slice(0, at);
  const revision = value.slice(at + 1);
  if (revision.length === 0 || /\s/.test(revision)) return false;
  if (locator.length === 0 || /\s/.test(locator) || !locator.includes("/")) return false;
  return true;
}

/**
 * Classify one exact `uses:` string for task source v4 (spec §3.3). Delegates
 * to {@link classifyTargetRef} (`src/execution/target-ref.ts`) — the repo's
 * one canonical-ref classifier — rather than re-deriving ref grammar; layers
 * the `akm/command` builtin special case, the task-ref rejection (B-14), and
 * the github-locator-shape rejection (B-13) on top, mirroring how v3's own
 * `classifyTaskV3Uses` layers `akm/command` and the github-action grammar on
 * top of the same underlying bundle-ref parser.
 */
export function classifyTaskSourceV4Uses(value: string): TaskSourceV4UsesTarget {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || /\s/.test(value) || value.includes("${{")) {
    throw new UsageError(
      "Task source v4 uses must be one exact, non-empty executable ref without expressions.",
      "INVALID_FLAG_VALUE",
    );
  }
  if (value === "akm/command") {
    return Object.freeze({ kind: "builtin-command" as const, ref: "akm/command" as const });
  }
  if (looksLikeGithubActionLocator(value)) {
    throw new UsageError(
      "GitHub Action targets were removed in task source v4 — the github-action uses: variant no longer exists. " +
        "Use commands/, scripts/, workflows/, or akm/command instead.",
      "INVALID_FLAG_VALUE",
    );
  }
  let classified: ReturnType<typeof classifyTargetRef>;
  try {
    classified = classifyTargetRef(value);
  } catch (cause) {
    throw cause instanceof Error ? cause : new UsageError(String(cause), "INVALID_FLAG_VALUE");
  }
  if (classified.kind === "task") {
    throw new UsageError("A task ref is not an executable task source v4 target.", "INVALID_FLAG_VALUE");
  }
  return Object.freeze({ kind: classified.kind, ref: classified.ref }) as TaskSourceV4UsesTarget;
}

// ── Top-level scalar/target field parsing ───────────────────────────────────

function nullableSelectorTopLevel(value: unknown, ctx: BoundedDocumentContext, key: string): string | null {
  const selector = stringField(value, ctx, [key], { nullable: true });
  if (selector !== null && selector.trim().length === 0) sourceError(ctx, [key], "must be null or a non-empty string.");
  return selector;
}

function parseTimeoutTopLevel(value: unknown, ctx: BoundedDocumentContext): string | number | null {
  if (value === null) return null;
  if (typeof value === "string" && value.trim() !== value) {
    sourceError(ctx, ["timeout"], "must not contain surrounding whitespace.");
  }
  const milliseconds = typeof value === "string" ? parseDuration(value, DURATION_UNITS) : value;
  if (
    milliseconds === null ||
    typeof milliseconds !== "number" ||
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 0 ||
    milliseconds > EXECUTION_MAX_TIMEOUT_MS
  ) {
    sourceError(ctx, ["timeout"], `must be null, 0 through ${EXECUTION_MAX_TIMEOUT_MS} milliseconds, or a common duration such as 20m.`);
  }
  return value as string | number;
}

function parseToolsTopLevel(value: ExecutionJsonValue, ctx: BoundedDocumentContext): TaskSourceV4Execution["tools"] {
  if (value === null || typeof value === "string") return value;
  if (Array.isArray(value)) {
    if (value.some((entry) => typeof entry !== "string")) sourceError(ctx, ["tools"], "array values must be strings.");
    return value as readonly string[];
  }
  if (typeof value === "object") return value as ExecutionJsonObject;
  sourceError(ctx, ["tools"], "must be a string, string array, mapping, or null.");
}

function parseTarget(input: ExecutionJsonObject, ctx: BoundedDocumentContext): TaskSourceV4Target {
  const hasUses = own(input, "uses");
  if (hasUses) {
    if (own(input, "shell")) sourceError(ctx, ["shell"], "is legal only with run.");
    if (own(input, "working-directory")) sourceError(ctx, ["working-directory"], "is legal only with run.");
    const usesText = stringField(input.uses, ctx, ["uses"], { nonempty: true }) as string;
    let uses: TaskSourceV4UsesTarget;
    try {
      uses = classifyTaskSourceV4Uses(usesText);
    } catch (cause) {
      sourceError(ctx, ["uses"], cause instanceof Error ? cause.message : String(cause));
    }
    let withValues: ExecutionJsonObject | undefined;
    if (own(input, "with")) {
      if (uses.kind !== "builtin-command") {
        sourceError(ctx, ["with"], "is legal only with uses: akm/command; declare typed inputs: instead.");
      }
      withValues = asRecord(presentJsonValue(input.with, ctx, ["with"]), ctx, ["with"]);
    }
    if (uses.kind === "builtin-command") {
      let command: ParsedBuiltinCommandAction;
      try {
        command = parseBuiltinCommandAction(withValues);
      } catch (cause) {
        sourceError(ctx, ["with"], cause instanceof Error ? cause.message : String(cause));
      }
      return Object.freeze({ kind: "uses", uses, ...(withValues ? { with: withValues } : {}), command });
    }
    return Object.freeze({ kind: "uses", uses, ...(withValues ? { with: withValues } : {}) });
  }

  if (own(input, "with")) sourceError(ctx, ["with"], "is legal only with uses: akm/command; declare typed inputs: instead.");
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
    workingDirectory = stringField(input["working-directory"], ctx, ["working-directory"], { nonempty: true }) as string;
    validateWorkingDirectory(workingDirectory, ctx);
  }
  return Object.freeze({
    kind: "run",
    run,
    ...(shell ? { shell } : {}),
    ...(workingDirectory ? { workingDirectory } : {}),
  });
}

function parseExecutionControls(input: ExecutionJsonObject, ctx: BoundedDocumentContext): TaskSourceV4Execution {
  const out: Record<string, unknown> = {};
  for (const key of ["agent", "engine", "model"] as const) {
    if (own(input, key)) out[key] = nullableSelectorTopLevel(input[key], ctx, key);
  }
  if (own(input, "inference")) {
    const inference = presentJsonValue(input.inference, ctx, ["inference"]);
    out.inference = inference === null ? null : asRecord(inference, ctx, ["inference"]);
  }
  if (own(input, "tools")) out.tools = parseToolsTopLevel(presentJsonValue(input.tools, ctx, ["tools"]), ctx);
  if (own(input, "timeout")) out.timeout = parseTimeoutTopLevel(input.timeout, ctx);
  if (own(input, "redact")) {
    const names = parseStringArray(input.redact, ctx, ["redact"], {
      max: WORKFLOW_MAX_EXEC_PASS_ENV,
      pattern: WORKFLOW_ENV_VAR_NAME_PATTERN,
    });
    if (new Set(names).size !== names.length) sourceError(ctx, ["redact"], "must not contain duplicate names.");
    out.redact = names;
  }
  if (own(input, "maxSteps")) {
    if (!Number.isSafeInteger(input.maxSteps) || (input.maxSteps as number) < 1) {
      sourceError(ctx, ["maxSteps"], "must be a positive safe integer.");
    }
    out.maxSteps = input.maxSteps;
  }
  if (own(input, "maxRetries")) {
    if (
      !Number.isSafeInteger(input.maxRetries) ||
      (input.maxRetries as number) < 0 ||
      (input.maxRetries as number) > WORKFLOW_MAX_RETRIES
    ) {
      sourceError(ctx, ["maxRetries"], `must be an integer from 0 through ${WORKFLOW_MAX_RETRIES}.`);
    }
    out.maxRetries = input.maxRetries;
  }
  return Object.freeze(out) as TaskSourceV4Execution;
}

// ── inputs: -> InputContract (D2-N3) ────────────────────────────────────────

function stripDeclarationAnnotations(declInput: ExecutionJsonObject): {
  readonly schema: Record<string, unknown>;
  readonly hasDefault: boolean;
  readonly defaultValue: unknown;
  readonly required: boolean;
} {
  const schema: Record<string, unknown> = {};
  let hasDefault = false;
  let defaultValue: unknown;
  let required = false;
  for (const [key, value] of Object.entries(declInput)) {
    if (key === "default") {
      hasDefault = true;
      defaultValue = value;
      continue;
    }
    if (key === "required") {
      required = value as boolean;
      continue;
    }
    schema[key] = value;
  }
  return { schema, hasDefault, defaultValue, required };
}

function parseInputDeclaration(name: string, raw: ExecutionJsonValue, ctx: BoundedDocumentContext): InputDeclaration {
  const declPath = ["inputs", name];
  const declInput = asRecord(raw, ctx, declPath);
  checkKeys(declInput, TASK_INPUT_DECLARATION_KEYS, ctx, declPath);

  if (own(declInput, "required") && typeof declInput.required !== "boolean") {
    sourceError(
      ctx,
      [...declPath, "required"],
      "must be a boolean at the declaration root (nested objects' own required: […] keeps ordinary JSON Schema array semantics).",
    );
  }

  const { schema, hasDefault, defaultValue, required } = stripDeclarationAnnotations(declInput);
  if (hasDefault && required) {
    sourceError(ctx, declPath, "must not declare both default and required: true.");
  }

  const definitionIssue = checkJsonSchemaDefinition(schema)[0];
  if (definitionIssue) sourceError(ctx, declPath, `is not a supported JSON schema: ${definitionIssue.message}`);

  if (utf8Bytes(JSON.stringify(schema)) > WORKFLOW_MAX_SCHEMA_BYTES) {
    sourceError(ctx, declPath, `serialized schema exceeds the ${WORKFLOW_MAX_SCHEMA_BYTES}-byte limit.`);
  }

  if (hasDefault) {
    const violations = validateJsonSchemaSubset(defaultValue, schema);
    if (violations.length > 0) {
      sourceError(ctx, [...declPath, "default"], `does not satisfy its own declaration: ${violations.join("; ")}`);
    }
    const secretWarnings = detectSecretShapedParams({ [name]: defaultValue });
    for (const message of secretWarnings) warn(message);
  }

  return Object.freeze({
    schema: Object.freeze(schema),
    ...(hasDefault ? { default: defaultValue } : {}),
    required,
  });
}

function parseInputDeclarations(value: ExecutionJsonValue, ctx: BoundedDocumentContext): InputContract {
  const input = asRecord(value, ctx, ["inputs"]);
  const names = Object.keys(input);
  if (names.length > WORKFLOW_MAX_PARAMS) {
    sourceError(ctx, ["inputs"], `accepts at most ${WORKFLOW_MAX_PARAMS} declared inputs.`);
  }
  const result: Record<string, InputDeclaration> = {};
  for (const name of names) {
    if (!INPUT_NAME_PATTERN.test(name)) {
      sourceError(ctx, ["inputs", name], "must match the input name pattern (a letter/underscore, then letters, digits, or underscores).");
    }
    result[name] = parseInputDeclaration(name, input[name] as ExecutionJsonValue, ctx);
  }
  return Object.freeze(result);
}

// ── output: -> bounded JSON Schema (mirrors v3's akm.outputSchema) ─────────

function parseOutputSchema(value: ExecutionJsonValue, ctx: BoundedDocumentContext): Readonly<Record<string, unknown>> {
  const schema = asRecord(value, ctx, ["output"]);
  const issue = checkJsonSchemaDefinition(schema as Record<string, unknown>)[0];
  if (issue) sourceError(ctx, ["output"], `is not a supported JSON schema: ${issue.message}`);
  return schema;
}

// ── schedule: -> TaskSourceV4ScheduleBinding[] (D2-N5, D2-N6, B-06..B-10, B-38) ──

function parseScheduleEntry(
  entryRaw: ExecutionJsonValue,
  index: number,
  contract: InputContract,
  ctx: BoundedDocumentContext,
): TaskSourceV4ScheduleBinding {
  const entryPath = ["schedule", index];
  const entry = asRecord(entryRaw, ctx, entryPath);
  checkKeys(entry, TASK_SOURCE_V4_SCHEDULE_KEYS, ctx, entryPath);
  if (!own(entry, "cron")) sourceError(ctx, [...entryPath, "cron"], "is required.");
  const cron = stringField(entry.cron, ctx, [...entryPath, "cron"], { nonempty: true }) as string;
  noGithubExpression(cron, ctx, [...entryPath, "cron"]);

  let enabled = true;
  if (own(entry, "enabled")) {
    if (typeof entry.enabled !== "boolean") sourceError(ctx, [...entryPath, "enabled"], "must be a boolean.");
    enabled = entry.enabled;
  }

  let inputsLiteral: Readonly<Record<string, unknown>> = Object.freeze({});
  if (own(entry, "inputs")) {
    const inputsValue = asRecord(presentJsonValue(entry.inputs, ctx, [...entryPath, "inputs"]), ctx, [...entryPath, "inputs"]);
    const errors = validateInputs(contract, inputsValue as Record<string, unknown>);
    if (errors.length > 0) sourceError(ctx, [...entryPath, "inputs"], errors.join("; "));
    inputsLiteral = Object.freeze({ ...inputsValue });
  }

  return Object.freeze({ cron, enabled, inputs: inputsLiteral, source: `schedule[${index}].cron`, ordinal: index });
}

function parseSchedule(
  input: ExecutionJsonObject,
  contract: InputContract,
  ctx: BoundedDocumentContext,
): readonly TaskSourceV4ScheduleBinding[] {
  if (!own(input, "schedule")) return Object.freeze([]);
  const raw = presentJsonValue(input.schedule, ctx, ["schedule"]);

  if (typeof raw === "string") {
    const cron = stringField(raw, ctx, ["schedule"], { nonempty: true }) as string;
    noGithubExpression(cron, ctx, ["schedule"]);
    return Object.freeze([Object.freeze({ cron, enabled: true, inputs: Object.freeze({}), source: "schedule", ordinal: 0 })]);
  }

  if (!Array.isArray(raw) || raw.length === 0) {
    sourceError(ctx, ["schedule"], "must be a non-empty string or a non-empty list of {cron, enabled?, inputs?} records.");
  }
  if (raw.length > TASK_V3_MAX_SCHEDULES) {
    sourceError(ctx, ["schedule"], `accepts at most ${TASK_V3_MAX_SCHEDULES} entries.`);
  }
  const bindings = raw.map((entryRaw, index) => parseScheduleEntry(entryRaw, index, contract, ctx));
  return Object.freeze(bindings);
}

// ── Top-level key rejection (akm:/on: removal, B-11/B-12; D2-N7) ───────────

function checkTopLevelKeys(input: ExecutionJsonObject, ctx: BoundedDocumentContext): void {
  if (own(input, "akm")) {
    sourceError(
      ctx,
      ["akm"],
      "is removed in task source v4; its members are top-level keys now (schedule, timeout, engine, model, redact, " +
        "maxSteps, maxRetries, description, when_to_use, tags, agent, inference, tools, and output for outputSchema) " +
        "— see docs/reference/tasks.md.",
    );
  }
  if (own(input, "on")) {
    sourceError(ctx, ["on"], "is removed in task source v4; declare a top-level schedule: instead.");
  }
  checkKeys(input, TASK_SOURCE_V4_TOP_LEVEL_KEYS, ctx, []);
}

// ── parseTaskSourceV4Document (spec §3.2) ───────────────────────────────────

/** Parse an already-decoded JSON/YAML value as a task source v4 document (spec §3.2). */
export function parseTaskSourceV4Document(value: unknown, options: ParseTaskSourceV4DocumentOptions): TaskSourceV4Document {
  const ctx = ctxFrom(options);
  const cloned = cloneBoundedJson(value, ctx, [], { nodes: 0 });
  const input = asRecord(cloned, ctx, []);

  if (!own(input, "version")) sourceError(ctx, ["version"], "is required and must be 4.");
  if (input.version !== TASK_SOURCE_V4_VERSION) sourceError(ctx, ["version"], "must be exactly 4.");

  checkTopLevelKeys(input, ctx);

  const hasUses = own(input, "uses");
  const hasRun = own(input, "run");
  if (hasUses === hasRun) sourceError(ctx, [], "requires exactly one executable selector: uses or run.");

  const name = own(input, "name") ? (stringField(input.name, ctx, ["name"]) as string) : undefined;
  const description = own(input, "description") ? (stringField(input.description, ctx, ["description"]) as string) : undefined;
  const whenToUse = own(input, "when_to_use") ? (stringField(input.when_to_use, ctx, ["when_to_use"]) as string) : undefined;
  const tags = own(input, "tags") ? parseStringArray(input.tags, ctx, ["tags"]) : undefined;
  const env = own(input, "env") ? parseEnvironment(presentJsonValue(input.env, ctx, ["env"]), ctx) : undefined;

  const target = parseTarget(input, ctx);
  const inputs = own(input, "inputs") ? parseInputDeclarations(presentJsonValue(input.inputs, ctx, ["inputs"]), ctx) : undefined;
  const output = own(input, "output") ? parseOutputSchema(presentJsonValue(input.output, ctx, ["output"]), ctx) : undefined;
  const schedule = parseSchedule(input, inputs ?? Object.freeze({}), ctx);
  const execution = parseExecutionControls(input, ctx);

  return Object.freeze({
    version: TASK_SOURCE_V4_VERSION,
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(whenToUse !== undefined ? { when_to_use: whenToUse } : {}),
    ...(tags !== undefined ? { tags } : {}),
    ...(inputs !== undefined ? { inputs } : {}),
    ...(output !== undefined ? { output } : {}),
    target,
    ...(env !== undefined ? { env } : {}),
    execution,
    schedule,
    manualOnly: schedule.length === 0,
    source: Object.freeze({ path: options.filePath }),
  });
}

/** Parse hostile YAML text as a task source v4 document — the standalone entry (mirrors `parseTaskV3Yaml`). */
export function parseTaskSourceV4(input: ParseTaskSourceV4Input): TaskSourceV4Document {
  const { root, lineAt } = readBoundedTaskSourceYaml(input, { sourceLabel: SOURCE_LABEL });
  return parseTaskSourceV4Document(root, {
    filePath: input.filePath,
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    lineAt,
  });
}
