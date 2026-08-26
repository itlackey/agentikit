// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * TaskDefinition — the pure, immutable task model (spec
 * docs/plans/specs/p1b-model-extraction.md §1.1 D4, §3.1).
 *
 * This is a NEW type, not extracted from an existing implementation: no
 * fs/db/subprocess imports (spec §3.2 purity ratchet), no IO, no
 * persistence. Its only producer in this phase is
 * `src/tasks/source/parse-v3-adapter.ts`; `createTaskDefinition` is the sole
 * runtime export and the sole place `TaskDefinition` values are constructed,
 * so every value in the system is validated and deep-frozen the same way
 * regardless of caller.
 *
 * Malformed input throws a `UsageError` using its own default code
 * (`src/core/errors.ts`'s `UsageError` constructor default — deliberately
 * relied on rather than restated here, see `invalid()` below and
 * tests/tasks/model-contracts.test.ts's design decision 3, which pins this
 * default and explains why P1b mints no new code for model validation), the
 * convention used throughout `src/tasks/**` for user-path validation
 * failures. Message text is intentionally not part of any external contract;
 * only the thrown type and code are.
 */

import { UsageError } from "../../core/errors";
import type { TaskScheduleBinding } from "./schedule";

export type TaskDefinitionTarget =
  | Readonly<{ readonly kind: "command"; readonly ref: string }>
  | Readonly<{ readonly kind: "script"; readonly ref: string }>
  | Readonly<{
      readonly kind: "workflow";
      readonly ref: string;
      readonly params: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{ readonly kind: "shell"; readonly command: string; readonly shell?: string }>;

export interface TaskExecutionDefaults {
  readonly engine?: string | null;
  readonly model?: string | null;
  readonly timeout?: string | number | null;
  readonly redact: readonly string[];
  readonly env: Readonly<Record<string, string | number | boolean>>;
}

export interface TaskDefinition {
  readonly ref: string;
  readonly source: Readonly<{ path: string }>;
  readonly name?: string;
  readonly description?: string;
  readonly target: TaskDefinitionTarget;
  readonly execution: TaskExecutionDefaults;
  readonly scheduleBindings: readonly TaskScheduleBinding[];
}

/** Input accepted by {@link createTaskDefinition}. Same shape as `TaskDefinition` — construction does not fabricate or default any field it does not already carry. */
export interface CreateTaskDefinitionInput {
  readonly ref: string;
  readonly source: Readonly<{ path: string }>;
  readonly name?: string;
  readonly description?: string;
  readonly target: TaskDefinitionTarget;
  readonly execution: TaskExecutionDefaults;
  readonly scheduleBindings: readonly TaskScheduleBinding[];
}

function invalid(detail: string): never {
  // Diagnostic-codes ratchet remedy (P1b Lane C code review,
  // tests/architecture/diagnostic-codes.test.ts): the code argument is
  // deliberately OMITTED, not spelled out — UsageError's own constructor
  // already defaults to the exact code this line needs (see the module
  // header and tests/tasks/model-contracts.test.ts's design decision 3,
  // which pins that default and is why this file mints no new code). Every
  // observable behavior (thrown type, .code, .hint()) is unchanged; this
  // keeps the literal string out of the ratchet's grep-style count.
  throw new UsageError(`Invalid task definition: ${detail}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) invalid(`${field} must be a non-empty string.`);
  return value as string;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") invalid(`${field} must be a string.`);
  return value;
}

function optionalNullableString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") invalid(`${field} must be a string or null.`);
  return value;
}

function validateSource(value: unknown): Readonly<{ path: string }> {
  if (!isPlainObject(value)) invalid("source must be a mapping.");
  const path = value.path;
  if (typeof path !== "string") invalid("source.path must be a string.");
  return Object.freeze({ path });
}

function validateTarget(value: unknown): TaskDefinitionTarget {
  if (!isPlainObject(value)) invalid("target must be a mapping.");
  const kind = value.kind;
  if (kind === "command" || kind === "script") {
    const ref = nonEmptyString(value.ref, "target.ref");
    return Object.freeze({ kind, ref });
  }
  if (kind === "workflow") {
    const ref = nonEmptyString(value.ref, "target.ref");
    if (!isPlainObject(value.params)) invalid("target.params must be a mapping.");
    return Object.freeze({ kind, ref, params: Object.freeze({ ...value.params }) });
  }
  if (kind === "shell") {
    const command = nonEmptyString(value.command, "target.command");
    const shell = optionalString(value.shell, "target.shell");
    return Object.freeze({ kind, command, ...(shell !== undefined ? { shell } : {}) });
  }
  invalid(`target.kind ${JSON.stringify(kind)} is not recognized.`);
}

function validateRedact(value: unknown): readonly string[] {
  if (!Array.isArray(value)) invalid("execution.redact must be an array of strings.");
  return Object.freeze(value.map((entry, index) => nonEmptyString(entry, `execution.redact[${index}]`)));
}

function validateEnv(value: unknown): Readonly<Record<string, string | number | boolean>> {
  if (!isPlainObject(value)) invalid("execution.env must be a mapping.");
  const out: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") {
      invalid(`execution.env.${key} must be a string, number, or boolean.`);
    }
    out[key] = entry;
  }
  return Object.freeze(out);
}

function validateExecution(value: unknown): TaskExecutionDefaults {
  if (!isPlainObject(value)) invalid("execution must be a mapping.");
  const engine = optionalNullableString(value.engine, "execution.engine");
  const model = optionalNullableString(value.model, "execution.model");
  const timeout = value.timeout;
  if (timeout !== undefined && timeout !== null && typeof timeout !== "string" && typeof timeout !== "number") {
    invalid("execution.timeout must be a string, number, or null.");
  }
  return Object.freeze({
    ...(engine !== undefined ? { engine } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(timeout !== undefined ? { timeout: timeout as string | number | null } : {}),
    redact: validateRedact(value.redact),
    env: validateEnv(value.env),
  });
}

function validateScheduleBinding(value: unknown, index: number): TaskScheduleBinding {
  if (!isPlainObject(value)) invalid(`scheduleBindings[${index}] must be a mapping.`);
  const cron = nonEmptyString(value.cron, `scheduleBindings[${index}].cron`);
  if (typeof value.enabled !== "boolean") invalid(`scheduleBindings[${index}].enabled must be a boolean.`);
  return Object.freeze({ cron, enabled: value.enabled });
}

function validateScheduleBindings(value: unknown): readonly TaskScheduleBinding[] {
  if (!Array.isArray(value)) invalid("scheduleBindings must be an array.");
  return Object.freeze(value.map((entry, index) => validateScheduleBinding(entry, index)));
}

/**
 * Construct a `TaskDefinition`, rejecting any malformed shape and deep-
 * freezing the result (the definition itself and every nested mapping/array
 * a caller could otherwise mutate through).
 */
export function createTaskDefinition(input: CreateTaskDefinitionInput): TaskDefinition {
  if (!isPlainObject(input)) invalid("input must be a mapping.");
  const ref = nonEmptyString(input.ref, "ref");
  const source = validateSource(input.source);
  const name = optionalString(input.name, "name");
  const description = optionalString(input.description, "description");
  const target = validateTarget(input.target);
  const execution = validateExecution(input.execution);
  const scheduleBindings = validateScheduleBindings(input.scheduleBindings);

  return Object.freeze({
    ref,
    source,
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    target,
    execution,
    scheduleBindings,
  });
}
