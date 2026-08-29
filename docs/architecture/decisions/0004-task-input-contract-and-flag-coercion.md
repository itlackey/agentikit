# 0004 — The shared input contract, generalized from workflow params

## Context

Before task source v4, workflow parameters (`WorkflowParameterPlan` /
`WorkflowParameterFlag` in `src/workflows/ir/params.ts`) had their own
pure validation/coercion vocabulary, and nothing else in the codebase
needed the same shape. Task source v4 introduced typed `inputs:`
declarations on tasks (P2a), which need the identical kind of contract —
declared names, types, defaults, required-ness, JSON-schema validation —
but for a different caller (a task) with its own diagnostics vocabulary
(different error codes and messages than a workflow parameter flag). Rather
than duplicate the logic, P2a generalized the workflow-only module into a
shared one.

## Decision

Moved verbatim from `src/execution/input-contract.ts`'s module header:

> The shared input contract (P2a Lane B, docs/plans/specs/
> p2a-task-source-v4.md §4, §1.3 D3, and the disambiguations
> D3-N1/D3-N2/D3-N3 in §1.5).
>
> This module GENERALIZES the pure module `src/workflows/ir/params.ts`
> (`WorkflowParameterPlan`, `WorkflowParameterFlag`,
> `materializeWorkflowParameterFlags`, `validateWorkflowParams`,
> `assertRunParamsSatisfyPlan`) into a contract-shaped vocabulary that both
> workflow params AND task source v4's `inputs:` declarations can consume.
> `src/workflows/ir/params.ts` becomes a THIN CONSUMER of this module: it
> adapts a `WorkflowParameterPlan` into an `InputContract`
> (`contractFromPlan`), supplies the workflow-specific diagnostics
> vocabulary, and re-exports its three wrappers under their existing names
> — byte-identical messages, codes, and hints
> (`tests/workflows/workflow-param-flags.test.ts`,
> `tests/integration/workflows/params-validation.test.ts`).
>
> `TaskInputBinding` is declared here for P2b (task source v4 `inputs:`
> delivery). P2a only ever produces `kind: "literal"` bindings, and nothing
> consumes them yet — P2a's contract for inputs is VALIDATION only
> (docs/plans/specs/p2a-task-source-v4.md §0).
>
> **D3-N1 (import boundary):** `src/execution/**` must never import
> `src/workflows/**` — `tests/architecture/import-cycle-ratchet.test.ts`
> runs a shrink-only, EMPTY baseline, and an `execution -> workflows` edge
> would close a cycle the moment `workflows/ir/params.ts` imports back into
> this module. `INPUT_NAME_PATTERN` is therefore DEFINED here (identical
> source/flags to today's `PROGRAM_PARAM_NAME_PATTERN`) rather than
> imported from the workflow program vocabulary; `src/workflows/program/
> schema.ts` becomes a re-export of this constant instead. Permitted
> imports: `node:crypto`, `src/core/errors`, `src/core/json-schema`, and
> `src/execution/**` — see `tests/execution/input-contract.test.ts`'s
> purity scan, which reads this file as text/AST and asserts the allowlist.
>
> **D3-N2 (canonical JSON):** `canonicalInputJson`/`canonicalInputHash`
> implement the SAME recursive key-sort + `JSON.stringify` as
> `canonicalJson` (`src/workflows/ir/plan-hash.ts`) locally, rather than
> importing it — `plan-hash.ts` also imports `./schema-v4` and
> `../resource-limits`, so importing it would drag workflow IR into
> `src/execution/**` and violate D3-N1. `tests/execution/
> input-contract.test.ts` asserts BYTE EQUALITY with `canonicalJson` over a
> fixture set covering nested objects, arrays, `null`, unicode keys, and
> insertion-order permutations, so the duplication cannot drift unnoticed.
>
> **D3-N3 (injected diagnostics vocabulary):** `materializeInputFlags`
> contains no literal user-facing string. Every message/code it raises is
> produced by a caller-supplied `InputFlagDiagnostics` — `params.ts`'s
> `WORKFLOW_PARAMETER_DIAGNOSTICS` reproduces today's five
> workflow-parameter strings/codes exactly; `src/tasks/source/
> task-input-diagnostics.ts` supplies the task vocabulary.
>
> Pure module: no IO, no engine imports.

## Consequences

- Workflow params and task `inputs:` share exactly one validation/coercion
  implementation; a bug fix or a new capability (e.g. a new JSON-schema
  subset feature) lands once and both callers get it.
- The two callers can still speak entirely different user-facing vocabulary
  (different error codes, different hint text) because the diagnostics are
  injected, not hardcoded — `materializeInputFlags` itself never needs to
  know which caller it is serving.
- `src/execution/**` staying import-free of `src/workflows/**` is a
  standing constraint, not a one-time fact: any future change that makes
  this module (or anything it imports) reach into `src/workflows/**` closes
  an import cycle and fails `tests/architecture/import-cycle-ratchet.test.ts`'s
  shrink-only, empty baseline.
- The canonical-JSON duplication between here and `workflows/ir/plan-hash.ts`
  is deliberate, not an oversight — a future refactor that "de-duplicates"
  it by importing across the D3-N1 boundary is the violation, not the
  duplication itself.

## Provenance

- Source: `src/execution/input-contract.ts`, module header.
- Spec: `docs/plans/specs/p2a-task-source-v4.md` §4, §1.3 D3, §1.5
  (D3-N1/D3-N2/D3-N3).
- Extracted: P4 (`docs/plans/specs/p4-deletions-closeout.md` §4.2), 2026-08-27.
