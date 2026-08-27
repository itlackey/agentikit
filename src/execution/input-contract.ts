// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The shared input contract (P2a Lane B, docs/plans/specs/p2a-task-source-v4.md
 * §4, §1.3 D3, and the disambiguations D3-N1/D3-N2/D3-N3 in §1.5).
 *
 * This module GENERALIZES the pure module `src/workflows/ir/params.ts`
 * (`WorkflowParameterPlan`, `WorkflowParameterFlag`,
 * `materializeWorkflowParameterFlags`, `validateWorkflowParams`,
 * `assertRunParamsSatisfyPlan`) into a contract-shaped vocabulary that both
 * workflow params AND task source v4's `inputs:` declarations can consume.
 * `src/workflows/ir/params.ts` becomes a THIN CONSUMER of this module: it
 * adapts a `WorkflowParameterPlan` into an `InputContract`
 * (`contractFromPlan`), supplies the workflow-specific diagnostics
 * vocabulary, and re-exports its three wrappers under their existing names —
 * byte-identical messages, codes, and hints
 * (tests/workflows/workflow-param-flags.test.ts,
 * tests/integration/workflows/params-validation.test.ts).
 *
 * `TaskInputBinding` is declared here for P2b (task source v4 `inputs:`
 * delivery). P2a only ever produces `kind: "literal"` bindings, and nothing
 * consumes them yet — P2a's contract for inputs is VALIDATION only
 * (docs/plans/specs/p2a-task-source-v4.md §0).
 *
 * D3-N1 (import boundary): `src/execution/**` must never import
 * `src/workflows/**` — `tests/architecture/import-cycle-ratchet.test.ts` runs
 * a shrink-only, EMPTY baseline, and an `execution -> workflows` edge would
 * close a cycle the moment `workflows/ir/params.ts` imports back into this
 * module. `INPUT_NAME_PATTERN` is therefore DEFINED here (identical
 * source/flags to today's `PROGRAM_PARAM_NAME_PATTERN`) rather than imported
 * from the workflow program vocabulary; `src/workflows/program/schema.ts`
 * becomes a re-export of this constant instead. Permitted imports:
 * `node:crypto`, `src/core/errors`, `src/core/json-schema`, and
 * `src/execution/**` — see `tests/execution/input-contract.test.ts`'s purity
 * scan, which reads this file as text/AST and asserts the allowlist.
 *
 * D3-N2 (canonical JSON): `canonicalInputJson`/`canonicalInputHash`
 * implement the SAME recursive key-sort + `JSON.stringify` as `canonicalJson`
 * (`src/workflows/ir/plan-hash.ts`) locally, rather than importing it —
 * `plan-hash.ts` also imports `./schema-v4` and `../resource-limits`, so
 * importing it would drag workflow IR into `src/execution/**` and violate
 * D3-N1. `tests/execution/input-contract.test.ts` asserts BYTE EQUALITY with
 * `canonicalJson` over a fixture set covering nested objects, arrays, `null`,
 * unicode keys, and insertion-order permutations, so the duplication cannot
 * drift unnoticed.
 *
 * D3-N3 (injected diagnostics vocabulary): `materializeInputFlags` contains
 * no literal user-facing string. Every message/code it raises is produced by
 * a caller-supplied `InputFlagDiagnostics` — `params.ts`'s
 * `WORKFLOW_PARAMETER_DIAGNOSTICS` reproduces today's five workflow-parameter
 * strings/codes exactly; `src/tasks/source/task-input-diagnostics.ts` (Lane A)
 * supplies the task vocabulary.
 *
 * Pure module: no IO, no engine imports.
 */

import { createHash } from "node:crypto";
import type { UsageError } from "../core/errors";
import { validateJsonSchemaSubset } from "../core/json-schema";

/**
 * Input/param names must be addressable as a plain identifier
 * (`params.<ident>` / `inputs.<ident>`): a letter or underscore, then
 * letters, digits, or underscores. Byte-identical source/flags to
 * `src/workflows/program/schema.ts`'s `PROGRAM_PARAM_NAME_PATTERN`, which
 * re-exports this constant (D3-N1) rather than defining its own copy.
 */
export const INPUT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** One input's declaration: a bounded JSON Schema, an optional default, and whether it is required. */
export interface InputDeclaration {
  /** The bounded JSON Schema (`default` and the declaration-root `required` flag stripped — task source v4 D2-N3). */
  readonly schema: Readonly<Record<string, unknown>>;
  readonly default?: unknown;
  readonly required: boolean;
}

/** A closed set of named input declarations — a workflow's params, or a task source v4 document's `inputs:`. */
export type InputContract = Readonly<Record<string, InputDeclaration>>;

/** One raw CLI flag, prior to contract-driven coercion. */
export interface InputFlag {
  name: string;
  value: string | boolean;
}

/**
 * A single input binding as it will be frozen into a `TaskInvocation`
 * (`src/tasks/model/invocation.ts`, P2b). Task source v4's `inputs:` grammar
 * needs both a literal value (an `akm task run --<name> <value>` flag, or a
 * `schedule[i].inputs` literal) and a reference binding (P2b,
 * `docs/plans/specs/p2b-input-bindings.md` §3.6). P2a's `akm task run` input
 * flags only ever produce `kind: "literal"` bindings.
 *
 * The `reference` arm additionally carries `schema` — the declaration's
 * bounded JSON Schema (P2b §3.6's "Contract note"): pre-attempt resolution
 * (`src/workflows/exec/step-work.ts`) validates the reference's RESOLVED
 * value against it without re-reading the task source, so the check stays a
 * pure function of the frozen plan. This is an additive widening; the
 * `literal` arm is untouched.
 */
export type TaskInputBinding =
  | Readonly<{ kind: "literal"; name: string; value: unknown }>
  | Readonly<{ kind: "reference"; name: string; from: string; schema: Readonly<Record<string, unknown>> }>;

/**
 * The injected message vocabulary `materializeInputFlags` calls into instead
 * of throwing a literal string itself (D3-N3). Each formatter returns the
 * `UsageError` to throw; `materializeInputFlags` never constructs one
 * directly, so it carries no task- or workflow-specific wording of its own.
 */
export interface InputFlagDiagnostics {
  /** An unrecognized (or name-pattern-invalid) flag. `declared` is the full declared name set, sorted. */
  unknownFlag(name: string, declared: readonly string[]): UsageError;
  /** A supplied value that cannot be coerced to its declaration. `detail` carries no trailing period. */
  invalidValue(name: string, detail: string): UsageError;
  /** The materialized values, once assembled, violate the contract (schema and/or missing-required). */
  contractViolation(errors: readonly string[]): UsageError;
  /** A non-array-declared input supplied more than once. */
  duplicateNonArray(name: string): UsageError;
  /** A JSON-array-shorthand or object/array-typed value that failed to parse as JSON. */
  malformedJson(name: string): UsageError;
}

/**
 * Apply declared defaults on top of supplied values. A supplied value always
 * wins, including an explicit falsy one (`false`, `0`, `""`) — PRESENCE, not
 * truthiness, decides. A declared input with no `default` that is absent from
 * `values` is left absent from the result (never filled with `undefined`); a
 * value not named by the contract passes through unchanged — defaults are
 * additive, not a filter. Returns a NEW object; `values` is never mutated.
 */
export function applyInputDefaults(contract: InputContract, values: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...values };
  for (const [name, declaration] of Object.entries(contract)) {
    if (Object.hasOwn(result, name)) continue;
    if (Object.hasOwn(declaration, "default")) result[name] = declaration.default;
  }
  return result;
}

/**
 * Validate `values` against the contract's declared schemas plus its
 * `required` flags. Builds the same synthetic `{type:"object",
 * properties:<schemas>}` object schema the workflow param validator built,
 * re-roots {@link validateJsonSchemaSubset}'s leading `$` at `pathRoot`
 * (default `"$"`), and additionally appends one
 * `"<pathRoot>.<name>: is required"` string per declared-required input
 * absent from `values` (schema violations first, missing-required after). A
 * name absent from the contract is never constrained. Returns `[]` when
 * `values` fully satisfies the contract.
 */
export function validateInputs(
  contract: InputContract,
  values: Record<string, unknown>,
  options?: { readonly pathRoot?: string },
): string[] {
  const pathRoot = options?.pathRoot ?? "$";

  const properties: Record<string, unknown> = {};
  for (const [name, declaration] of Object.entries(contract)) properties[name] = declaration.schema;
  const schemaErrors =
    Object.keys(properties).length === 0
      ? []
      : validateJsonSchemaSubset(values, { type: "object", properties }).map((error) => error.replace(/^\$/, pathRoot));

  const missingRequired: string[] = [];
  for (const [name, declaration] of Object.entries(contract)) {
    if (declaration.required && !Object.hasOwn(values, name)) {
      missingRequired.push(`${pathRoot}.${name}: is required`);
    }
  }

  return [...schemaErrors, ...missingRequired];
}

/**
 * Materialize exact-name CLI input flags against a contract. The CLI
 * deliberately carries RAW string/boolean flag values to this one boundary
 * so type coercion cannot race or drift from the declared contract:
 * exact-name matching (a mistyped or undeclared flag name, or one that fails
 * {@link INPUT_NAME_PATTERN}, is `diagnostics.unknownFlag` — the full
 * declared set, sorted), array grouping (repeated flags on an array-declared
 * input collect into an array in supplied order), the `[`-prefixed
 * JSON-array shorthand, repeated-flag rejection on a non-array declaration
 * (`diagnostics.duplicateNonArray`), and string-preserving coercion (a union
 * type that permits `string` keeps the caller's exact text — `--version 001`
 * on `type:"string"` stays the string `"001"`, never a silently-converted
 * number, B-30). Ends by running {@link validateInputs} over the
 * materialized result and raising `diagnostics.contractViolation` with its
 * (still `"$"`-rooted) errors when non-empty.
 *
 * Returns `{}` immediately for zero flags, regardless of the contract, and
 * calls no diagnostic — callers combine this with
 * {@link applyInputDefaults} and a separate {@link validateInputs} call
 * (after defaults are applied) to catch a `required` input that was never
 * supplied as a flag at all.
 */
export function materializeInputFlags(
  contract: InputContract,
  flags: readonly InputFlag[],
  diagnostics: InputFlagDiagnostics,
): Record<string, unknown> {
  if (flags.length === 0) return {};

  const declared = new Set(Object.keys(contract));
  const grouped = new Map<string, Array<string | boolean>>();
  for (const flag of flags) {
    if (!INPUT_NAME_PATTERN.test(flag.name) || !declared.has(flag.name)) {
      throw diagnostics.unknownFlag(flag.name, [...declared].sort());
    }
    const values = grouped.get(flag.name) ?? [];
    values.push(flag.value);
    grouped.set(flag.name, values);
  }

  const entries: Array<[string, unknown]> = [];
  for (const [name, rawValues] of grouped) {
    entries.push([name, materializeFlagValues(name, rawValues, contract[name]?.schema, diagnostics)]);
  }
  const values = Object.fromEntries(entries);

  const errors = validateInputs(contract, values);
  if (errors.length > 0) throw diagnostics.contractViolation(errors);
  return values;
}

function materializeFlagValues(
  name: string,
  values: readonly (string | boolean)[],
  schema: Readonly<Record<string, unknown>> | undefined,
  diagnostics: InputFlagDiagnostics,
): unknown {
  const types = schemaTypes(schema);
  if (types.includes("array")) {
    if (values.length === 1 && typeof values[0] === "string" && values[0].trim().startsWith("[")) {
      const parsed = parseJsonFlag(name, values[0], diagnostics);
      if (!Array.isArray(parsed)) throw diagnostics.invalidValue(name, "must be a JSON array");
      return parsed;
    }
    const itemSchema = isRecord(schema?.items) ? schema.items : undefined;
    return values.map((value) => coerceFlagValue(name, value, itemSchema, diagnostics));
  }

  if (values.length > 1) throw diagnostics.duplicateNonArray(name);
  return coerceFlagValue(name, values[0] as string | boolean, schema, diagnostics);
}

function coerceFlagValue(
  name: string,
  raw: string | boolean,
  schema: Readonly<Record<string, unknown>> | undefined,
  diagnostics: InputFlagDiagnostics,
): unknown {
  const types = schemaTypes(schema);
  if (types.length === 0) return raw;

  if (typeof raw === "boolean") {
    if (types.includes("boolean")) return raw;
    if (types.includes("string")) return String(raw);
    throw diagnostics.invalidValue(name, `requires a value of type ${types.join(" | ")}`);
  }

  // A union that permits strings keeps the caller's exact text. This
  // prevents a value such as "001" from being silently converted to a
  // number (B-30).
  if (types.includes("string")) return raw;

  for (const type of types) {
    switch (type) {
      case "boolean":
        if (raw === "true") return true;
        if (raw === "false") return false;
        break;
      case "number": {
        const value = Number(raw);
        if (raw.trim() !== "" && Number.isFinite(value)) return value;
        break;
      }
      case "integer": {
        const value = Number(raw);
        if (raw.trim() !== "" && Number.isSafeInteger(value)) return value;
        break;
      }
      case "null":
        if (raw === "null") return null;
        break;
      case "object": {
        const parsed = parseJsonFlag(name, raw, diagnostics);
        if (isRecord(parsed)) return parsed;
        break;
      }
      case "array": {
        const parsed = parseJsonFlag(name, raw, diagnostics);
        if (Array.isArray(parsed)) return parsed;
        break;
      }
    }
  }
  throw diagnostics.invalidValue(name, `must be ${types.join(" | ")}; received ${JSON.stringify(raw)}`);
}

function schemaTypes(schema: Readonly<Record<string, unknown>> | undefined): string[] {
  const declared = schema?.type;
  if (typeof declared === "string") return [declared];
  return Array.isArray(declared) ? declared.filter((value): value is string => typeof value === "string") : [];
}

function parseJsonFlag(name: string, raw: string, diagnostics: InputFlagDiagnostics): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw diagnostics.malformedJson(name);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Canonical JSON used for input hashing: object keys recursively sorted, so
 * two structurally-equal input value sets hash identically regardless of key
 * insertion order. Byte-equal to `canonicalJson`
 * (`src/workflows/ir/plan-hash.ts`) — see D3-N2 above.
 */
export function canonicalInputJson(value: unknown): string {
  return JSON.stringify(sortInputJsonKeys(value));
}

/** sha256 hex digest of {@link canonicalInputJson}'s output — a stable input-value fingerprint (B-39, for P2b execution identity). */
export function canonicalInputHash(value: unknown): string {
  return createHash("sha256").update(canonicalInputJson(value)).digest("hex");
}

function sortInputJsonKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => sortInputJsonKeys(item));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => [key, sortInputJsonKeys(child)]),
  );
}
