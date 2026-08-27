// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The pure `with:` -> `TaskInputBinding[]` normalizer (spec
 * docs/plans/specs/p2b-input-bindings.md §3.2 A2, §3.3).
 *
 * `src/workflows/freeze/targets/task.ts` is this module's only caller:
 * `taskDispatch` builds the composed task's own `InputContract` from its own
 * parsed `inputs:`, and calls {@link freezeTaskInputBindings} with THIS
 * step's own authored `with:`, never anything from an outer composition
 * (§3.5 — there is no merge across a composition chain).
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

function inputBindingInvalid(message: string): UsageError {
  return new UsageError(message, "INPUT_BINDING_INVALID");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    if (!Object.hasOwn(contract, name)) {
      throw inputBindingInvalid(
        `Workflow step ${stepId} targets ${targetRef} with.${name}, which is not a declared input. ` +
          `Declared inputs: ${declaredNames.length > 0 ? declaredNames.join(", ") : "(none)"}.`,
      );
    }
    const declaration = contract[name];
    if (!declaration)
      throw inputBindingInvalid(`Workflow step ${stepId} targets ${targetRef} with.${name} is invalid.`);
    byName.set(
      name,
      normalizeOneEntry(stepId, targetRef, name, value, declaration.schema, earlierStepIds, declaredParamNames),
    );
  }

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

  // Every LITERAL value (authored or defaulted) is validated against its own
  // declared schema — a contract NARROWED to just the literal-bound names, so
  // a required input bound via REFERENCE (whose value is not known until
  // pre-attempt, §3.6) is never wrongly flagged "missing" here.
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
