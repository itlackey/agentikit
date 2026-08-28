# 0008 — Task input binding normalization and re-binding across a composition

## Context

P2b gave a task-composing workflow step a `with:` record that freezes into
typed `TaskInputBinding[]` against the target's declared `inputs:`
contract. P3a then made workflows composable — a task-wrapped step can
target a child WORKFLOW rather than a plain task — which raises a second
problem `freezeTaskInputBindings` alone does not solve: a v4 task's own
already-classified bindings (literal or reference) need to be re-expressed
against the CHILD workflow's declared `params:` contract, by name, without
re-deriving each entry's classification from its value's shape a second
time.

## Decision

Moved verbatim from `src/workflows/freeze/task-bindings.ts`'s module
header:

> The pure `with:` -> `TaskInputBinding[]` normalizer (spec
> docs/plans/specs/p2b-input-bindings.md §3.2 A2, §3.3), plus the pure
> re-binder a recursive composition needs on top of it (spec
> docs/plans/specs/p3a-plan-v5-child-freeze.md A-N8).
>
> `freezeTaskInputBindings` classifies a genuinely AUTHORED `with:` record
> against a contract; `src/workflows/freeze/targets/task.ts`'s
> `taskDispatch` calls it with THIS step's own authored `with:` against the
> composed task's own `InputContract`, never anything from an outer
> composition (§3.5 — there is no merge across a composition chain).
> `rebindTaskInputBindings` instead takes an ALREADY-classified
> `TaskInputBinding[]` — a v4 task's own effective inputs — and re-binds it
> by name against a DIFFERENT contract, trusting each entry's existing
> `kind` rather than re-deriving it from the value's shape;
> `src/workflows/freeze/targets/child-workflow.ts`'s `childWorkflowDispatch`
> is its only caller, re-binding a task-wrapped composition's effective
> inputs against the child workflow's declared `params:`.
>
> Everything decidable at FREEZE time is decided here: an unknown `with:`
> key, a missing required-without-default input, a literal value failing
> its declared schema, and a reference's syntax + "names an earlier step
> that exists" / "names a declared workflow param" structural check. A
> reference's *resolved* value is validated PRE-ATTEMPT instead
> (`src/workflows/exec/step-work.ts`, §3.6) — this module never resolves
> anything, so it needs no run params and no step outputs.
>
> Pure function: no IO, no config reads. Imports only
> `src/execution/input-contract.ts`, `src/workflows/program/expressions.ts`,
> and `src/core/errors.ts`.

And from `rebindTaskInputBindings`'s own doc comment — the part explaining
WHY re-binding cannot simply reuse `freezeTaskInputBindings`:

> This exists because a `kind: "literal"` binding's VALUE can be an
> arbitrary JSON value, including one shaped exactly like the `{from:
> "<ref>"}` reference grammar (e.g. a declared default for an object-typed
> input). Round-tripping such a binding back through a `with:`-shaped
> record and re-running `freezeTaskInputBindings`'s value-shape-driven
> classification (`normalizeOneEntry`) would silently reinterpret that
> literal as a live reference binding — the composing task's OWN contract
> already settled `kind` once; this function trusts that answer instead of
> asking the value's shape again (code-review finding, docs/plans/specs/
> p3a-plan-v5-child-freeze.md).

## Consequences

- `freezeTaskInputBindings` and `rebindTaskInputBindings` must never be
  merged into one shape-sniffing function, even though they look similar —
  doing so would reintroduce exactly the silent-reinterpretation bug the
  code-review finding above caught: a literal value that happens to look
  like `{from: "..."}` would flip from literal to reference on its second
  pass through composition.
- A reference binding's `from` target (an earlier step or declared param)
  never changes across a re-bind — only which CONTRACT it validates against
  changes. A future caller that tries to re-target a reference's `from`
  during re-binding is outside this module's contract and needs new
  reasoning, not an extension of `rebindTaskInputBindings`.
- Both functions stay pure and IO-free by construction — a caller that
  needs a resolved value (not just a structurally-validated binding) is
  looking for `step-work.ts`'s pre-attempt resolution instead, not a change
  to this module.

## Provenance

- Source: `src/workflows/freeze/task-bindings.ts`, module header and
  `rebindTaskInputBindings`'s doc comment (code-review finding).
- Spec: `docs/plans/specs/p2b-input-bindings.md` §3.2 A2, §3.3;
  `docs/plans/specs/p3a-plan-v5-child-freeze.md` A-N8.
- Extracted: P4 (`docs/plans/specs/p4-deletions-closeout.md` §4.2), 2026-08-27.
