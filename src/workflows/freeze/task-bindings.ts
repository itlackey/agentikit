// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The pure `with:` -> `TaskInputBinding[]` normalizer (spec
 * docs/plans/specs/p2b-input-bindings.md §3.2 A2, §3.3), plus the pure
 * re-binder a recursive composition needs on top of it (spec
 * docs/plans/specs/p3a-plan-v5-child-freeze.md A-N8).
 *
 * {@link freezeTaskInputBindings} classifies a genuinely AUTHORED `with:`
 * record against a contract; `src/workflows/freeze/targets/task.ts`'s
 * `taskDispatch` calls it with THIS step's own authored `with:` against the
 * composed task's own `InputContract`, never anything from an outer
 * composition (§3.5 — there is no merge across a composition chain).
 * {@link rebindTaskInputBindings} instead takes an ALREADY-classified
 * `TaskInputBinding[]` — a v4 task's own effective inputs — and re-binds it
 * by name against a DIFFERENT contract, trusting each entry's existing
 * `kind` rather than re-deriving it from the value's shape;
 * `src/workflows/freeze/targets/child-workflow.ts`'s `childWorkflowDispatch`
 * is its only caller, re-binding a task-wrapped composition's effective
 * inputs against the child workflow's declared `params:`.
 *
 * Everything decidable at FREEZE time is decided here: an unknown `with:`
 * key, a missing required-without-default input, a literal value failing its
 * declared schema, and a reference's syntax + "names an earlier step that
 * exists" / "names a declared workflow param" structural check. A
 * reference's *resolved* value is validated PRE-ATTEMPT instead
 * (`src/workflows/exec/step-work.ts`, §3.6) — this module never resolves
 * anything, so it needs no run params and no step outputs.
 *
 * Pure function: no IO, no config reads. Imports only
 * `src/execution/input-contract.ts`, `src/workflows/program/expressions.ts`,
 * and `src/core/errors.ts`.
 */

import { UsageError } from "../../core/errors";
import { type InputContract, type TaskInputBinding, validateInputs } from "../../execution/input-contract";
import { parseReference } from "../program/expressions";

export interface FreezeTaskInputBindingsInput {
  /** The composing step's own id — for diagnostics only. */
  readonly stepId: string;
  /** The task's authored ref (e.g. "tasks/nightly-v4") — for diagnostics only. */
  readonly targetRef: string;
  /** The step's authored `with:` record, already decoded to arbitrary JSON values (A-N3). */
  readonly with: Readonly<Record<string, unknown>> | undefined;
  /** The composed task's OWN declared `inputs:` contract — never a caller's (§3.5, B-29). */
  readonly contract: InputContract;
  /** Step ids that appear BEFORE this step in the frozen step order (A-N4). */
  readonly earlierStepIds: ReadonlySet<string>;
  /** THIS workflow's own declared param names (A-N4) — never an outer composing task's. */
  readonly declaredParamNames: ReadonlySet<string>;
}

export interface RebindTaskInputBindingsInput {
  /** The composing step's own id — for diagnostics only. */
  readonly stepId: string;
  /** The child's authored ref (e.g. "workflows/inner") — for diagnostics only. */
  readonly targetRef: string;
  /** An ALREADY-NORMALIZED binding set — a v4 task's own effective inputs, classified once against the TASK's own `inputs:` contract. */
  readonly bindings: readonly TaskInputBinding[] | undefined;
  /** The NEW contract to re-bind `bindings` against by name — the child workflow's declared `params:` (A-N8), never the task's own. */
  readonly contract: InputContract;
}

function inputBindingInvalid(message: string): UsageError {
  return new UsageError(message, "INPUT_BINDING_INVALID");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownBindingNameError(
  stepId: string,
  targetRef: string,
  name: string,
  declaredNames: readonly string[],
): UsageError {
  return inputBindingInvalid(
    `Workflow step ${stepId} targets ${targetRef} with.${name}, which is not a declared input. ` +
      `Declared inputs: ${declaredNames.length > 0 ? declaredNames.join(", ") : "(none)"}.`,
  );
}

/**
 * Normalize the workflow source front end's authored `with:` record into the
 * `TaskInputBinding[]` a task-composing step's frozen target carries (spec
 * §3.3). Throws `UsageError`/`INPUT_BINDING_INVALID` for the first violation
 * found — per authored entry first (B-11, B-15, B-16, B-17, B-18), then over
 * the whole contract (B-12, B-13). The result is sorted by name; an entry
 * exists only for a declared input with an effective value (authored
 * literal, authored reference, or an applied default) — never for an
 * unsupplied optional input with no default (B-20).
 */
export function freezeTaskInputBindings(input: FreezeTaskInputBindingsInput): readonly TaskInputBinding[] {
  const { stepId, targetRef, contract, earlierStepIds, declaredParamNames } = input;
  const authored = input.with ?? {};
  const declaredNames = Object.keys(contract).sort();

  const byName = new Map<string, TaskInputBinding>();
  for (const [name, value] of Object.entries(authored)) {
    if (!Object.hasOwn(contract, name)) throw unknownBindingNameError(stepId, targetRef, name, declaredNames);
    const declaration = contract[name];
    if (!declaration)
      throw inputBindingInvalid(`Workflow step ${stepId} targets ${targetRef} with.${name} is invalid.`);
    byName.set(
      name,
      normalizeOneEntry(stepId, targetRef, name, value, declaration.schema, earlierStepIds, declaredParamNames),
    );
  }

  return finalizeBindings(stepId, targetRef, contract, byName);
}

/**
 * Re-bind an ALREADY-NORMALIZED `TaskInputBinding[]` — a v4 task's own
 * effective inputs, classified once against the TASK's own declared
 * `inputs:` contract by {@link freezeTaskInputBindings} — against a
 * DIFFERENT contract (the child workflow's declared `params:`, A-N8) by
 * NAME, without re-deriving each entry's literal/reference classification
 * from its value's shape.
 *
 * This exists because a `kind: "literal"` binding's VALUE can be an
 * arbitrary JSON value, including one shaped exactly like the `{from:
 * "<ref>"}` reference grammar (e.g. a declared default for an object-typed
 * input). Round-tripping such a binding back through a `with:`-shaped record
 * and re-running {@link freezeTaskInputBindings}'s value-shape-driven
 * classification ({@link normalizeOneEntry}) would silently reinterpret that
 * literal as a live reference binding — the composing task's OWN contract
 * already settled `kind` once; this function trusts that answer instead of
 * asking the value's shape again (code-review finding, docs/plans/specs/
 * p3a-plan-v5-child-freeze.md).
 *
 * Per-entry rules, otherwise identical to {@link freezeTaskInputBindings}:
 * an entry naming a key the new `contract` does not declare is
 * `INPUT_BINDING_INVALID` (same message shape); a `kind: "literal"` entry
 * keeps its value verbatim and is validated against the NEW contract's
 * declared schema for that name; a `kind: "reference"` entry keeps its
 * `from` verbatim (the reference target — an earlier step or declared param
 * of the composing workflow — does not change with which contract it is
 * bound against) and its `schema` is re-derived from the NEW contract,
 * matching {@link normalizeOneEntry}'s existing rule that a reference
 * binding's schema always comes from the contract it is bound against; a
 * contract key absent from `bindings` is defaulted or required exactly as
 * {@link freezeTaskInputBindings} does.
 */
export function rebindTaskInputBindings(input: RebindTaskInputBindingsInput): readonly TaskInputBinding[] {
  const { stepId, targetRef, contract } = input;
  const declaredNames = Object.keys(contract).sort();

  const byName = new Map<string, TaskInputBinding>();
  for (const binding of input.bindings ?? []) {
    if (!Object.hasOwn(contract, binding.name)) {
      throw unknownBindingNameError(stepId, targetRef, binding.name, declaredNames);
    }
    const declaration = contract[binding.name];
    if (!declaration)
      throw inputBindingInvalid(`Workflow step ${stepId} targets ${targetRef} with.${binding.name} is invalid.`);
    byName.set(
      binding.name,
      binding.kind === "literal"
        ? binding
        : Object.freeze({ kind: "reference", name: binding.name, from: binding.from, schema: declaration.schema }),
    );
  }

  return finalizeBindings(stepId, targetRef, contract, byName);
}

/**
 * The tail shared by {@link freezeTaskInputBindings} and
 * {@link rebindTaskInputBindings} once `byName` holds one classified entry
 * per AUTHORED/bound name: apply declared defaults for every remaining
 * contract key (or throw for a required one with none), schema-validate
 * every literal (authored, re-bound, or defaulted) against the contract, and
 * return the result sorted by name.
 */
function finalizeBindings(
  stepId: string,
  targetRef: string,
  contract: InputContract,
  byName: Map<string, TaskInputBinding>,
): readonly TaskInputBinding[] {
  for (const [name, declaration] of Object.entries(contract)) {
    if (byName.has(name)) continue;
    if (Object.hasOwn(declaration, "default")) {
      byName.set(name, Object.freeze({ kind: "literal", name, value: declaration.default }));
      continue;
    }
    if (declaration.required) {
      throw inputBindingInvalid(
        `Workflow step ${stepId} targets ${targetRef}, which declares required input "${name}" with no default; ` +
          `supply it with with.${name}.`,
      );
    }
  }

  // Every LITERAL value (authored, re-bound, or defaulted) is validated
  // against its own declared schema — a contract NARROWED to just the
  // literal-bound names, so a required input bound via REFERENCE (whose
  // value is not known until pre-attempt, §3.6) is never wrongly flagged
  // "missing" here.
  const literalContract: Record<string, InputContract[string]> = {};
  const literalValues: Record<string, unknown> = {};
  for (const binding of byName.values()) {
    if (binding.kind !== "literal") continue;
    const declaration = contract[binding.name];
    if (declaration) literalContract[binding.name] = declaration;
    literalValues[binding.name] = binding.value;
  }
  const schemaErrors = validateInputs(literalContract, literalValues, { pathRoot: "with" });
  if (schemaErrors.length > 0) {
    throw inputBindingInvalid(`Workflow step ${stepId} targets ${targetRef}: ${schemaErrors.join("; ")}`);
  }

  const sorted = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return Object.freeze(sorted);
}

/**
 * Classify and validate ONE authored `with:` entry whose key is already
 * known to be a declared input name. §3.3 point 2/3: a value is a
 * `{kind:"reference"}` binding IFF it is a non-null, non-array plain object
 * whose OWN key set is exactly `["from"]` and whose `from` is a string
 * `parseReference` accepts — the hard-fail band (B-15, B-16) means any OTHER
 * shape carrying an own `from` key is `INPUT_BINDING_INVALID`, never
 * reinterpreted as a literal.
 */
function normalizeOneEntry(
  stepId: string,
  targetRef: string,
  name: string,
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
  earlierStepIds: ReadonlySet<string>,
  declaredParamNames: ReadonlySet<string>,
): TaskInputBinding {
  if (!isPlainObject(value) || !Object.hasOwn(value, "from")) {
    return Object.freeze({ kind: "literal", name, value });
  }

  const keys = Object.keys(value);
  if (keys.length !== 1 || typeof value.from !== "string") {
    throw inputBindingInvalid(
      `Workflow step ${stepId} targets ${targetRef} with.${name} looks like a reference binding ({from: ...}) ` +
        `but is not one: it must have exactly one key, "from", whose value is a reference string.`,
    );
  }
  const parsed = parseReference(value.from);
  if (!parsed.ok) {
    throw inputBindingInvalid(
      `Workflow step ${stepId} targets ${targetRef} with.${name} reference ${JSON.stringify(value.from)} is ` +
        `invalid: ${parsed.message}`,
    );
  }
  if (parsed.expr.kind === "stepOutput") {
    if (!earlierStepIds.has(parsed.expr.stepId)) {
      throw inputBindingInvalid(
        `Workflow step ${stepId} targets ${targetRef} with.${name} reference ${value.from} does not name an ` +
          `earlier step of this workflow.`,
      );
    }
  } else if (!declaredParamNames.has(parsed.expr.name)) {
    const sortedParams = [...declaredParamNames].sort();
    throw inputBindingInvalid(
      `Workflow step ${stepId} targets ${targetRef} with.${name} reference ${value.from} does not name a ` +
        `declared workflow param; declared params: ${sortedParams.length > 0 ? sortedParams.join(", ") : "(none)"}.`,
    );
  }
  return Object.freeze({ kind: "reference", name, from: value.from, schema });
}
