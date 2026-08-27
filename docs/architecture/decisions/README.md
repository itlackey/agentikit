# Architecture decision records

This directory holds the design history that used to live as long comment
blocks inside the modules the 0.9.2 task/workflow refactor touched. Brief
§9 named the problem directly: *"Historical essays inside large modules |
Keep invariant comments locally; move design history to ADRs | Reduce
cognitive load without deleting important reasoning."* These records are
that move.

## Format

- One file per decision: `NNNN-kebab-title.md`, numbered in the order the
  decision was extracted, not the order the underlying work happened.
- No front matter.
- Four sections, in this order:
  - **Context** — the problem the module was solving and the constraints in
    play when the decision was made.
  - **Decision** — what was decided, including the essay's own reasoning
    verbatim where it was already written as reasoning. Nothing here is
    deleted or "cleaned up" on the move — see the binding rule below.
  - **Consequences** — what the decision implies for callers, for future
    changes, and (where the essay named one) for alternatives that were
    considered and rejected.
  - **Provenance** — the source file(s) and, where the essay named one, the
    spec section or review round the reasoning came from, plus the date and
    phase this record was extracted.

## What moves here and what stays in the code

Per the brief's own framing (§15, quoted in
`docs/plans/specs/p4-deletions-closeout.md` §1.5): a code comment that
explains *why mutation is delayed, why a hash includes a field, why a
transaction boundary exists, why a source is revalidated, why a child
invocation is idempotent* — a short, load-bearing invariant a maintainer
needs sitting right next to the code — **stays in the code**. A comment
block that is historical narrative — peer-review findings, an earlier
draft, a superseded alternative, a phase-by-phase chronology of how a
design arrived where it is — moves here instead, replaced in the source by
a one-line invariant summary plus a relative link back to the ADR that
carries the full reasoning.

**Binding rule carried from the spec:** no ADR may delete reasoning. An
essay's text moves; it is not summarized away. Where an essay describes
behavior a later phase deleted, the ADR records the behavior **and** its
removal date, rather than being quietly rewritten as if the behavior never
existed.

## Index

| ADR | Title | Source essay | Extracted |
|---|---|---|---|
| [0001](./0001-no-interpolation-attached-structured-context.md) | No interpolation — data reaches units as attached structured context | `src/workflows/exec/native-executor.ts` module header (data flow / reference scope / peer-review-R1 narrative) | P4 |
| [0002](./0002-unit-reuse-and-input-hash-scope.md) | Unit reuse and the input-hash scope | `src/workflows/exec/step-work.ts` (module purity contract; `computeUnitInputHash`'s doc comment) | P4 |
| [0003](./0003-child-env-allowlist-and-provenance.md) | The exec unit's child-environment allowlist and provenance | `src/workflows/exec/exec-unit.ts` (module header; the default-allowlist rationale; capture/overflow semantics; `childEnv`'s layering) | P4 |
| [0004](./0004-task-input-contract-and-flag-coercion.md) | The shared input contract, generalized from workflow params | `src/execution/input-contract.ts` module header | P4 |
| [0005](./0005-task-result-vocabulary-and-legacy-read-mapping.md) | The D8 result-vocabulary re-code and its legacy read mapping | `src/tasks/run/task-result.ts` + `src/tasks/run/task-history.ts` headers (the mapping's own one-line invariant stays in `task-history.ts`) | P4 |
| [0006](./0006-task-source-version-routing.md) | Task source version routing, from three generations to one | `src/tasks/source/parse-task-source.ts` routing-table header | Owned and extracted by the task-source-v3-acceptance-removal family (P4 §3.2/§4.8) — this file is a Lane A deliverable, not Lane B's; it is linked here once that commit lands. |
| [0007](./0007-workflow-composition-bounds.md) | Recursive child-workflow composition bounds | `src/workflows/resource-limits.ts` (the composition-depth and aggregate-plan-bytes section) | P4 |
| [0008](./0008-task-binding-normalization.md) | Task input binding normalization and re-binding across a composition | `src/workflows/freeze/task-bindings.ts` (module header; `rebindTaskInputBindings`'s doc comment) | P4 |
| [0009](./0009-child-run-publication-column-parity.md) | Child-run publication's hand-duplicated INSERT column list | New content — the R11/R-R3 disposition (`docs/plans/specs/p4-deletions-closeout.md` §8), not a moved essay | P4 |
| [0010](./0010-driver-protocol-cut.md) | The external driver protocol (`workflow brief`/`workflow report`/`--settle`) was cut | Stub pointing at `docs/architecture/specs/driver-protocol-keep-or-cut.md`, which stays the normative decision record | P4 |

ADR 0006 is listed for completeness of the index; its file is authored by
the family that owns `parse-task-source.ts` (`docs/plans/specs/
p4-deletions-closeout.md` §4.8: "Essays living in files Lane A owns are
extracted by Lane A, in that file's own family commit").
