// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Pure, byte-producing task-v2 to task-v3 migration planner. */

import crypto from "node:crypto";
import path from "node:path";
import { LineCounter, parseDocument, stringify as stringifyYaml } from "yaml";
import { bundleRefToString, parseBundleRef } from "../core/asset/asset-ref";
import { formatExtraParamsIssue, validateExtraParams } from "../core/extra-params";
import { WORKFLOW_ENV_VAR_NAME_PATTERN, WORKFLOW_MAX_RETRIES } from "../workflows/resource-limits";
import { parseTaskDocument } from "./parser";
import { TASK_MAX_REDACT_NAMES, TASK_MAX_TIMEOUT_MS } from "./schema";
import {
  assertBoundedTaskYamlDocument,
  classifyTaskV3Uses,
  parseTaskV3Yaml,
  TASK_V3_MAX_SOURCE_BYTES,
  type TaskV3UsesTarget,
} from "./source-v3";

export interface TaskV2ToV3FileInput {
  readonly filePath: string;
  readonly bytes: Buffer;
  readonly mode: number;
  readonly writable: boolean;
  /** False when the inspected file or its publication directory has no write bit. */
  readonly onDiskWritable?: boolean;
  /** Physical bundle/component root recorded by the filesystem inspector. */
  readonly containmentRoot?: string;
  /** Physical identities captured by the filesystem inspector for drift fencing. */
  readonly inspectionIdentity?: TaskV2ToV3InspectionIdentity;
}

export interface TaskV2ToV3FilesystemIdentity {
  readonly realPath: string;
  readonly device: string;
  readonly inode: string;
  /** Decimal hard-link count captured with the physical inode identity. */
  readonly linkCount: string;
  /** Decimal nanosecond inode change time; catches transient link/unlink drift. */
  readonly changeTimeNs: string;
}

export interface TaskV2ToV3InspectionIdentity {
  readonly file: TaskV2ToV3FilesystemIdentity;
  readonly root: TaskV2ToV3FilesystemIdentity;
  /** Stable owning bundle identity when `root` is a nested component. */
  readonly bundleRoot?: TaskV2ToV3FilesystemIdentity;
}

interface TaskV2ToV3OutcomeBase {
  readonly filePath: string;
  readonly before: Buffer;
  readonly beforeHash: string;
  readonly mode: number;
  readonly writable: boolean;
  readonly onDiskWritable?: boolean;
  readonly containmentRoot?: string;
  readonly inspectionIdentity?: TaskV2ToV3InspectionIdentity;
  readonly reason: string;
  readonly detail?: string;
}

export interface TaskV2ToV3Changed extends TaskV2ToV3OutcomeBase {
  readonly status: "changed";
  readonly reason: "v2-task-converted";
  readonly after: Buffer;
  readonly afterHash: string;
}

export interface TaskV2ToV3Skipped extends TaskV2ToV3OutcomeBase {
  readonly status: "skipped";
  readonly reason: "already-v3";
}

export interface TaskV2ToV3Blocked extends TaskV2ToV3OutcomeBase {
  readonly status: "blocked";
}

export type TaskV2ToV3FileOutcome = TaskV2ToV3Changed | TaskV2ToV3Skipped | TaskV2ToV3Blocked;

export interface TaskV2ToV3MigrationPlan {
  readonly schemaVersion: 1;
  readonly generation: string;
  readonly files: readonly TaskV2ToV3FileOutcome[];
}

const V2_KEYS = new Set([
  "version",
  "name",
  "description",
  "when_to_use",
  "tags",
  "schedule",
  "enabled",
  "workflow",
  "prompt",
  "command",
  "params",
  "engine",
  "model",
  "timeoutMs",
  "maxSteps",
  "maxRetries",
  "llm",
  "redact",
]);
const V2_LLM_KEYS = new Set([
  "temperature",
  "maxTokens",
  "supportsJsonSchema",
  "extraParams",
  "contextLength",
  "enableThinking",
]);
const SAFE_V2_COMMAND_TOKEN = /^[A-Za-z0-9_./:=+,-]+$/;
const SHELL_ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;
/**
 * V2 executed argv directly, while v3 `run:` enters a host shell. An explicit
 * path bypasses shell aliases/builtins; `akm` is the one bare executable whose
 * v3 runtime resolution is contractually pinned to the current installation.
 */
function shellStableV2Executable(executable: string): boolean {
  return executable === "akm" || executable.includes("/");
}
const KNOWN_PROMPT_REF_FAMILIES = new Set([
  "agents",
  "commands",
  "env",
  "facts",
  "instructions",
  "knowledge",
  "lessons",
  "memories",
  "scripts",
  "secrets",
  "sessions",
  "skills",
  "tasks",
  "workflows",
]);

function hash(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function base(input: TaskV2ToV3FileInput): Omit<TaskV2ToV3OutcomeBase, "reason"> {
  const inspectionIdentity = input.inspectionIdentity
    ? Object.freeze({
        file: Object.freeze({ ...input.inspectionIdentity.file }),
        root: Object.freeze({ ...input.inspectionIdentity.root }),
        ...(input.inspectionIdentity.bundleRoot
          ? { bundleRoot: Object.freeze({ ...input.inspectionIdentity.bundleRoot }) }
          : {}),
      })
    : undefined;
  return {
    filePath: input.filePath,
    before: Buffer.from(input.bytes),
    beforeHash: hash(input.bytes),
    mode: input.mode,
    writable: input.writable,
    ...(input.onDiskWritable !== undefined ? { onDiskWritable: input.onDiskWritable } : {}),
    ...(input.containmentRoot ? { containmentRoot: input.containmentRoot } : {}),
    ...(inspectionIdentity ? { inspectionIdentity } : {}),
  };
}

function blocked(input: TaskV2ToV3FileInput, reason: string, detail?: string): TaskV2ToV3Blocked {
  return Object.freeze({ status: "blocked" as const, ...base(input), reason, ...(detail ? { detail } : {}) });
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be a mapping`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error(`${label} must use a plain or null prototype`);
  return value as Record<string, unknown>;
}

function exactString(value: unknown, label: string, nonempty = false): string {
  if (typeof value !== "string" || (nonempty && value.trim().length === 0)) {
    throw new Error(`${label} must be ${nonempty ? "a non-empty " : "a "}string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return exactString(value, label);
}

function parseV2Yaml(input: TaskV2ToV3FileInput): { data: Record<string, unknown>; source: string } {
  if (input.bytes.byteLength > TASK_V3_MAX_SOURCE_BYTES) {
    throw new Error(`task YAML exceeds the 1 MiB (${TASK_V3_MAX_SOURCE_BYTES}-byte) source resource limit`);
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input.bytes);
  } catch {
    throw new Error("task YAML contains invalid UTF-8 bytes");
  }
  const lineCounter = new LineCounter();
  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(source, { lineCounter, uniqueKeys: true });
  } catch (cause) {
    throw new Error(`invalid YAML: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const [parseError] = document.errors;
  if (parseError) throw new Error(`invalid YAML: ${parseError.message.split("\n")[0]}`);
  const [parseWarning] = document.warnings;
  if (parseWarning) throw new Error(`unsupported YAML construct: ${parseWarning.message}`);
  assertBoundedTaskYamlDocument(document, {
    filePath: input.filePath,
    sourceLabel: "task v2 migration source",
    lineCounter,
  });
  return { data: plainRecord(document.toJS({ maxAliasCount: 0 }), "task YAML"), source };
}

function validateCommonV2(data: Record<string, unknown>): void {
  const unknown = Object.keys(data).filter((key) => !V2_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`unknown v2 field(s): ${unknown.join(", ")}`);
  exactString(data.schedule, "schedule", true);
  if (data.enabled !== undefined && typeof data.enabled !== "boolean") throw new Error("enabled must be a boolean");
  for (const key of ["name", "description", "when_to_use"] as const) optionalString(data[key], key);
  if (data.tags !== undefined && data.tags !== null) {
    if (!Array.isArray(data.tags) || data.tags.some((entry) => typeof entry !== "string" || entry.length === 0)) {
      throw new Error("tags must be an array of non-empty strings");
    }
  }
  if (data.timeoutMs !== undefined && data.timeoutMs !== null) {
    if (
      !Number.isInteger(data.timeoutMs) ||
      (data.timeoutMs as number) < 1 ||
      (data.timeoutMs as number) > TASK_MAX_TIMEOUT_MS
    ) {
      throw new Error(`timeoutMs must be null or an integer from 1 through ${TASK_MAX_TIMEOUT_MS}`);
    }
  }
  if (data.redact !== undefined && data.redact !== null) {
    if (
      !Array.isArray(data.redact) ||
      data.redact.length > TASK_MAX_REDACT_NAMES ||
      data.redact.some((entry) => typeof entry !== "string" || !WORKFLOW_ENV_VAR_NAME_PATTERN.test(entry))
    ) {
      throw new Error("redact must contain only bounded environment variable names");
    }
  }
}

function validateV2Llm(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const llm = plainRecord(value, "llm");
  const unknown = Object.keys(llm).filter((key) => !V2_LLM_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`llm has unknown field(s): ${unknown.join(", ")}`);
  if (llm.temperature !== undefined && (typeof llm.temperature !== "number" || !Number.isFinite(llm.temperature))) {
    throw new Error("llm.temperature must be a finite number");
  }
  for (const key of ["maxTokens", "contextLength"] as const) {
    if (llm[key] !== undefined && (!Number.isInteger(llm[key]) || (llm[key] as number) <= 0)) {
      throw new Error(`llm.${key} must be a positive integer`);
    }
  }
  for (const key of ["supportsJsonSchema", "enableThinking"] as const) {
    if (llm[key] !== undefined && typeof llm[key] !== "boolean") throw new Error(`llm.${key} must be a boolean`);
  }
  if (llm.extraParams !== undefined) {
    const issue = validateExtraParams(llm.extraParams)[0];
    if (issue) throw new Error(formatExtraParamsIssue("llm.extraParams", issue));
  }
  return llm;
}

function commonAkm(data: Record<string, unknown>): Record<string, unknown> {
  const akm: Record<string, unknown> = {
    schedule: exactString(data.schedule, "schedule", true),
    enabled: data.enabled === undefined ? true : data.enabled,
  };
  for (const key of ["description", "when_to_use", "tags"] as const) {
    if (data[key] !== undefined && data[key] !== null) akm[key] = data[key];
  }
  return akm;
}

function addRuntimeOverrides(data: Record<string, unknown>, akm: Record<string, unknown>): void {
  for (const key of ["engine", "model"] as const) {
    const value = optionalString(data[key], key);
    if (value) akm[key] = value;
  }
  const llm = validateV2Llm(data.llm);
  if (llm !== undefined) akm.inference = llm;
  if (data.timeoutMs !== undefined) akm.timeout = data.timeoutMs;
  if (data.redact !== undefined && data.redact !== null) {
    akm.redact = [...new Set(data.redact as string[])];
  }
}

function addSharedNonPromptOverrides(data: Record<string, unknown>, akm: Record<string, unknown>): void {
  if (data.timeoutMs !== undefined) akm.timeout = data.timeoutMs;
  if (data.redact !== undefined && data.redact !== null) {
    akm.redact = [...new Set(data.redact as string[])];
  }
}

function promptSourceKind(raw: string): "file" | "agent" | "command" | "other-ref" | "inline" {
  const trimmed = raw.trim();
  if (
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    path.isAbsolute(trimmed) ||
    /^[A-Za-z]:[\\/]/.test(trimmed)
  ) {
    return "file";
  }
  try {
    const parsed = parseBundleRef(trimmed);
    const family = parsed.conceptId.split("/", 1)[0] ?? "";
    if (bundleRefToString(parsed) !== trimmed || !parsed.conceptId.includes("/")) {
      return "inline";
    }
    if (!KNOWN_PROMPT_REF_FAMILIES.has(family)) return parsed.bundle === undefined ? "inline" : "other-ref";
    if (family === "agents") return "agent";
    if (family === "commands") return "command";
    return "other-ref";
  } catch {
    return "inline";
  }
}

function migratedObject(data: Record<string, unknown>): Record<string, unknown> | TaskV2ToV3Blocked["reason"] {
  validateCommonV2(data);
  const targets = ["workflow", "prompt", "command"].filter(
    (key) => Object.hasOwn(data, key) && data[key] !== null && data[key] !== "",
  );
  if (targets.length !== 1) throw new Error("v2 task must declare exactly one of workflow, prompt, or command");
  const output: Record<string, unknown> = { version: 3 };
  if (data.name !== undefined && data.name !== null) output.name = data.name;
  const akm = commonAkm(data);

  if (targets[0] === "workflow") {
    const ref = exactString(data.workflow, "workflow", true).trim();
    let target: TaskV3UsesTarget;
    try {
      target = classifyTaskV3Uses(ref);
    } catch {
      throw new Error("workflow is not a canonical v3 asset ref");
    }
    if (target.kind !== "workflow") throw new Error("workflow target is not a workflows/ ref");
    output.uses = ref;
    if (data.params !== undefined && data.params !== null) {
      const params = plainRecord(data.params, "params");
      output.with = params;
    }
    if (data.maxSteps !== undefined && data.maxSteps !== null) {
      if (!Number.isSafeInteger(data.maxSteps) || (data.maxSteps as number) < 1)
        throw new Error("maxSteps must be positive");
      akm.maxSteps = data.maxSteps;
    }
    if (data.maxRetries !== undefined && data.maxRetries !== null) {
      if (
        !Number.isSafeInteger(data.maxRetries) ||
        (data.maxRetries as number) < 0 ||
        (data.maxRetries as number) > WORKFLOW_MAX_RETRIES
      ) {
        throw new Error(`maxRetries must be from 0 through ${WORKFLOW_MAX_RETRIES}`);
      }
      akm.maxRetries = data.maxRetries;
    }
    addSharedNonPromptOverrides(data, akm);
  } else if (targets[0] === "prompt") {
    const prompt = exactString(data.prompt, "prompt", true).trim();
    const kind = promptSourceKind(prompt);
    if (kind === "file") return "dynamic-file-read-cannot-be-inlined-without-changing-semantics";
    if (kind === "agent") return "agent-ref-has-persona-but-no-command-work";
    if (kind === "other-ref") return "non-command-asset-has-no-v3-command-ref-equivalent";
    if (kind === "command") output.uses = prompt;
    else {
      output.uses = "akm/command";
      output.with = { content: prompt };
    }
    addRuntimeOverrides(data, akm);
  } else {
    if (Array.isArray(data.command)) return "argv-array-has-no-portable-shell-string";
    const command = exactString(data.command, "command", true).trim();
    if (/['"\\]/.test(command)) return "shell-quoting-changes-v2-whitespace-split-semantics";
    const tokens = command.split(/\s+/).filter(Boolean);
    if (tokens.length === 0 || tokens.some((token) => !SAFE_V2_COMMAND_TOKEN.test(token))) {
      return "shell-operators-change-v2-literal-argv-semantics";
    }
    const executable = tokens[0] as string;
    if (SHELL_ASSIGNMENT_WORD.test(executable) || !shellStableV2Executable(executable)) {
      return "shell-command-resolution-changes-v2-literal-argv-semantics";
    }
    output.run = tokens.join(" ");
    addSharedNonPromptOverrides(data, akm);
  }
  output.akm = akm;
  return output;
}

function isReason(value: Record<string, unknown> | string): value is string {
  return typeof value === "string";
}

/** Plan exactly one source file without touching disk. */
export function planTaskV2ToV3File(input: TaskV2ToV3FileInput): TaskV2ToV3FileOutcome {
  let data: Record<string, unknown>;
  let source: string;
  try {
    ({ data, source } = parseV2Yaml(input));
  } catch (cause) {
    return blocked(input, "invalid-task-yaml", cause instanceof Error ? cause.message : String(cause));
  }
  if (data.version === 3) {
    try {
      parseTaskV3Yaml({
        yaml: source,
        filePath: input.filePath,
        ...(input.containmentRoot ? { workspaceRoot: input.containmentRoot } : {}),
      });
      return Object.freeze({ status: "skipped" as const, ...base(input), reason: "already-v3" as const });
    } catch (cause) {
      return blocked(input, "invalid-v3-task", cause instanceof Error ? cause.message : String(cause));
    }
  }
  if (data.version !== 2)
    return blocked(input, "unsupported-task-version", `expected version 2 or 3, got ${String(data.version)}`);
  if (!input.writable || input.onDiskWritable === false) {
    return blocked(
      input,
      "read-only-source",
      !input.writable ? "the owning source is not writable" : "the source file or publication directory is read-only",
    );
  }
  try {
    parseTaskDocument({ yaml: source, filePath: input.filePath, id: path.basename(input.filePath, ".yml") });
  } catch (cause) {
    return blocked(input, "invalid-v2-task", cause instanceof Error ? cause.message : String(cause));
  }
  let migrated: Record<string, unknown> | string;
  try {
    migrated = migratedObject(data);
  } catch (cause) {
    return blocked(input, "invalid-v2-task", cause instanceof Error ? cause.message : String(cause));
  }
  if (isReason(migrated)) return blocked(input, migrated);
  const after = Buffer.from(stringifyYaml(migrated), "utf8");
  try {
    parseTaskV3Yaml({
      yaml: after.toString("utf8"),
      filePath: input.filePath,
      ...(input.containmentRoot ? { workspaceRoot: input.containmentRoot } : {}),
    });
  } catch (cause) {
    return blocked(input, "generated-v3-validation-failed", cause instanceof Error ? cause.message : String(cause));
  }
  return Object.freeze({
    status: "changed" as const,
    ...base(input),
    reason: "v2-task-converted" as const,
    after,
    afterHash: hash(after),
  });
}

function generationFor(files: readonly TaskV2ToV3FileOutcome[]): string {
  const digest = crypto.createHash("sha256");
  digest.update("akm-task-v2-to-v3-plan-v1\0");
  for (const file of files) {
    digest.update(file.filePath);
    digest.update("\0");
    digest.update(file.status);
    digest.update("\0");
    digest.update(file.reason);
    digest.update("\0");
    digest.update(String(file.mode));
    digest.update("\0");
    digest.update(file.writable ? "writable" : "read-only");
    digest.update("\0");
    digest.update(file.onDiskWritable === false ? "disk-read-only" : "disk-writable-or-unspecified");
    digest.update("\0");
    if (file.containmentRoot) digest.update(file.containmentRoot);
    digest.update("\0");
    digest.update(file.beforeHash);
    digest.update("\0");
    if (file.status === "changed") digest.update(file.afterHash);
    digest.update("\0");
    if (file.detail) digest.update(file.detail);
    digest.update("\0");
  }
  return digest.digest("hex");
}

/** Build/fingerprint a plan from already-derived immutable outcomes. */
export function taskV2ToV3PlanFromOutcomes(outcomes: readonly TaskV2ToV3FileOutcome[]): TaskV2ToV3MigrationPlan {
  const files = [...outcomes].sort((left, right) =>
    left.filePath < right.filePath ? -1 : left.filePath > right.filePath ? 1 : 0,
  );
  for (let index = 1; index < files.length; index += 1) {
    const previous = files[index - 1];
    const current = files[index];
    if (previous && current && path.resolve(previous.filePath) === path.resolve(current.filePath)) {
      throw new Error(`duplicate task migration file path: ${current.filePath}`);
    }
  }
  return Object.freeze({ schemaVersion: 1 as const, generation: generationFor(files), files: Object.freeze(files) });
}

/** Plan a complete, stable file set. Input order cannot change the result. */
export function planTaskV2ToV3Migration(inputs: readonly TaskV2ToV3FileInput[]): TaskV2ToV3MigrationPlan {
  const sorted = [...inputs].sort((left, right) =>
    left.filePath < right.filePath ? -1 : left.filePath > right.filePath ? 1 : 0,
  );
  let previous: TaskV2ToV3FileInput | undefined;
  for (const current of sorted) {
    if (previous && path.resolve(previous.filePath) === path.resolve(current.filePath)) {
      throw new Error(`duplicate task migration file path: ${current.filePath}`);
    }
    previous = current;
  }
  return taskV2ToV3PlanFromOutcomes(sorted.map(planTaskV2ToV3File));
}
