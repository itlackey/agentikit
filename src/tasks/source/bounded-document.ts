// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The bounded-document front end and field helpers task source v4 needs
 * (spec docs/plans/specs/p2a-task-source-v4.md §1.5 D2-N4, §3.1).
 *
 * D2-N4's binding resolution asks for these to move BODY-INTACT out of
 * `src/tasks/source-v3.ts` (which today declares them file-private) so v3
 * and v4 share one funnel with two `sourceLabel`s. This phase's Lane A scope
 * is explicitly constrained to NOT touch `src/tasks/source-v3.ts` (that file
 * stays byte-for-byte as it is at the head of this branch) — so the
 * functions below are a fresh, parameterized implementation rather than an
 * import-back from a v3 edit. Every one of them is already path-parameterized
 * in the ORIGINAL v3 code (no hardcoded "akm" segment baked into the
 * function body — `parseTimeout`/`nullableSelector`/`parseTools` are the
 * v3-only exceptions that hardcode `["akm", …]` and are therefore NOT
 * reproduced here; task-source-v4.ts implements its own top-level-rooted
 * versions of those three instead), so this file's bodies are byte-identical
 * copies of v3's, generalized only by taking a `sourceLabel` on the parse
 * context instead of the hardcoded string "task v3 source". A follow-up pass
 * that actually edits `src/tasks/source-v3.ts` to import these (completing
 * D2-N4 structurally, per `tests/tasks/bounded-document.test.ts`'s third
 * describe block) is still owed; this module is written so that pass is a
 * mechanical import swap, not a rewrite.
 *
 * The numeric bounds (`TASK_V3_MAX_*`) and `assertBoundedTaskYamlDocument`
 * are imported from `../source-v3`, which already exports them — reused,
 * never restated, so the bounds cannot drift between v3 and v4.
 */

import fs from "node:fs";
import path from "node:path";
import { types as utilTypes } from "node:util";
import { LineCounter, parseDocument } from "yaml";
import { UsageError } from "../../core/errors";
import type { ExecutionJsonObject, ExecutionJsonValue } from "../../execution/json";
import { type StrictRecordSnapshot, snapshotStrictRecord } from "../../execution/record";
import { WORKFLOW_ENV_VAR_NAME_PATTERN } from "../../workflows/resource-limits";
import {
  assertBoundedTaskYamlDocument,
  TASK_V3_MAX_COLLECTION_ITEMS,
  TASK_V3_MAX_JSON_DEPTH,
  TASK_V3_MAX_JSON_NODES,
  TASK_V3_MAX_OBJECT_KEYS,
  TASK_V3_MAX_SOURCE_BYTES,
  TASK_V3_MAX_STRING_BYTES,
  type TaskV3Environment,
} from "../source-v3";

/** Parse context every helper in this module takes. `workspaceRoot` is used only by {@link validateWorkingDirectory}. */
export interface BoundedDocumentContext {
  readonly filePath: string;
  /** "task v3 source" or "task source v4" — the ONLY text that differs between the two renderings (D2-N4). */
  readonly sourceLabel: string;
  readonly workspaceRoot?: string;
  readonly lineAt?: (fieldPath: readonly (string | number)[]) => number | undefined;
}

interface CloneState {
  nodes: number;
}

export function own(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function wellFormedUnicode(value: string): boolean {
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

/** The one per-field error funnel both grammars render through, distinguished only by `ctx.sourceLabel` (D2-N4). */
export function sourceError(
  ctx: Pick<BoundedDocumentContext, "filePath" | "sourceLabel" | "lineAt">,
  fieldPath: readonly (string | number)[],
  detail: string,
): never {
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
  throw new UsageError(`Invalid ${ctx.sourceLabel} at ${location}: ${dotted} ${detail}`, "TASK_SOURCE_INVALID");
}

export function cloneBoundedJson(
  value: unknown,
  ctx: BoundedDocumentContext,
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
      sourceError(ctx, fieldPath, `contains a mapping key exceeding the ${TASK_V3_MAX_STRING_BYTES}-byte string limit.`);
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

export function asRecord(
  value: ExecutionJsonValue,
  ctx: BoundedDocumentContext,
  fieldPath: readonly (string | number)[],
): ExecutionJsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object")
    sourceError(ctx, fieldPath, "must be a mapping.");
  return value as ExecutionJsonObject;
}

export function checkKeys(
  value: ExecutionJsonObject,
  allowed: readonly string[],
  ctx: BoundedDocumentContext,
  fieldPath: readonly (string | number)[],
): void {
  const allow = new Set(allowed);
  const firstUnknown = Object.keys(value).find((key) => !allow.has(key));
  if (firstUnknown !== undefined) sourceError(ctx, [...fieldPath, firstUnknown], "is an unsupported field.");
}

export function presentJsonValue(
  value: ExecutionJsonValue | undefined,
  ctx: BoundedDocumentContext,
  fieldPath: readonly (string | number)[],
): ExecutionJsonValue {
  if (value === undefined) sourceError(ctx, fieldPath, "must be omitted instead of set to undefined.");
  return value;
}

export function stringField(
  value: unknown,
  ctx: BoundedDocumentContext,
  fieldPath: readonly (string | number)[],
  options: { nonempty?: boolean; nullable?: boolean } = {},
): string | null {
  if (value === null && options.nullable) return null;
  if (typeof value !== "string")
    sourceError(ctx, fieldPath, options.nullable ? "must be a string or null." : "must be a string.");
  if (options.nonempty && value.trim().length === 0) sourceError(ctx, fieldPath, "must be a non-empty string.");
  return value;
}

export function noGithubExpression(
  value: string,
  ctx: BoundedDocumentContext,
  fieldPath: readonly (string | number)[],
): void {
  if (value.includes("${{")) sourceError(ctx, fieldPath, "contains an unsupported GitHub expression.");
}

/** `env:` is already a top-level field in both grammars — reused body-intact, field path unchanged. */
export function parseEnvironment(value: ExecutionJsonValue, ctx: BoundedDocumentContext): TaskV3Environment {
  const environment = asRecord(value, ctx, ["env"]);
  for (const [key, child] of Object.entries(environment)) {
    if (!WORKFLOW_ENV_VAR_NAME_PATTERN.test(key)) sourceError(ctx, ["env", key], "has an invalid environment variable name.");
    if (typeof child !== "string" && typeof child !== "number" && typeof child !== "boolean") {
      sourceError(ctx, ["env", key], "must be a string, finite number, or boolean.");
    }
  }
  return environment as TaskV3Environment;
}

export function parseStringArray(
  value: unknown,
  ctx: BoundedDocumentContext,
  fieldPath: readonly (string | number)[],
  options: { max?: number; pattern?: RegExp } = {},
): readonly string[] {
  if (!Array.isArray(value)) sourceError(ctx, fieldPath, "must be an array of strings.");
  if (options.max !== undefined && value.length > options.max)
    sourceError(ctx, fieldPath, `accepts at most ${options.max} items.`);
  const strings: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || entry.length === 0) sourceError(ctx, [...fieldPath, index], "must be a non-empty string.");
    if (options.pattern && !options.pattern.test(entry)) sourceError(ctx, [...fieldPath, index], "has an invalid value.");
    strings.push(entry);
  }
  return Object.freeze(strings);
}

/**
 * `working-directory:` is already a top-level field in both grammars —
 * reused body-intact, field path unchanged (`source-v3.ts:677-714`).
 */
export function validateWorkingDirectory(value: string, ctx: BoundedDocumentContext): void {
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

function yamlProblem(message: string): string {
  return message.split("\n")[0]?.trim() || "invalid YAML";
}

// ── The bounded YAML front end ──────────────────────────────────────────────

export interface BoundedTaskSourceYamlInput {
  readonly yaml: string;
  readonly filePath: string;
}

export interface BoundedTaskSourceYamlResult {
  readonly root: unknown;
  readonly lineAt: (fieldPath: readonly (string | number)[]) => number | undefined;
}

/**
 * Parse hostile YAML without aliases/tags/merges, then hand back the bounded
 * `{root, lineAt}` pair both `parseTaskV3Document` and
 * `parseTaskSourceV4Document` consume — lifted from `parseTaskV3Yaml`
 * (`source-v3.ts:894-952`), generalized only by `sourceLabel`. The version
 * router (`parse-task-source.ts`) always passes `sourceLabel: "task v3
 * source"` here (spec §3.4's recorded wart: the front end runs before
 * `root.version` is even read, so it cannot know the document is v4 yet);
 * `parseTaskSourceV4`'s own standalone YAML-string entry passes `"task
 * source v4"`.
 */
export function readBoundedTaskSourceYaml(
  input: BoundedTaskSourceYamlInput,
  options: { readonly sourceLabel: string },
): BoundedTaskSourceYamlResult {
  const sourceLabel = options.sourceLabel;
  if (typeof input.yaml !== "string") {
    throw new UsageError(`Invalid ${sourceLabel} at ${input.filePath}: source must be a string.`, "INVALID_FLAG_VALUE");
  }
  if (utf8Bytes(input.yaml) > TASK_V3_MAX_SOURCE_BYTES) {
    throw new UsageError(
      `Invalid ${sourceLabel} at ${input.filePath}: source exceeds the 1 MiB (${TASK_V3_MAX_SOURCE_BYTES}-byte) resource limit.`,
      "INVALID_FLAG_VALUE",
    );
  }
  const lineCounter = new LineCounter();
  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(input.yaml, { lineCounter, uniqueKeys: true });
  } catch (cause) {
    throw new UsageError(
      `Invalid ${sourceLabel} at ${input.filePath}: YAML parsing failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      "INVALID_FLAG_VALUE",
    );
  }
  const [problem] = document.errors;
  if (problem) {
    const offset = Array.isArray(problem.pos) ? problem.pos[0] : 0;
    throw new UsageError(
      `Invalid ${sourceLabel} at ${input.filePath}:${lineCounter.linePos(offset).line}: ${yamlProblem(problem.message)}`,
      "INVALID_FLAG_VALUE",
    );
  }
  const [warning] = document.warnings;
  if (warning) {
    throw new UsageError(
      `Invalid ${sourceLabel} at ${input.filePath}: unsupported YAML construct: ${yamlProblem(warning.message)}`,
      "INVALID_FLAG_VALUE",
    );
  }
  assertBoundedTaskYamlDocument(document, { filePath: input.filePath, sourceLabel, lineCounter });
  let root: unknown;
  try {
    root = document.toJS({ maxAliasCount: 0 });
  } catch (cause) {
    throw new UsageError(
      `Invalid ${sourceLabel} at ${input.filePath}: YAML expansion failed: ${cause instanceof Error ? cause.message : String(cause)}`,
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
  return { root, lineAt };
}
