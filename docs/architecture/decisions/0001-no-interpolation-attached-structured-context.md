# 0001 — No interpolation: data reaches units as attached structured context

## Context

The pre-unification engine spliced data into a unit's prompt by string
substitution (`${{ item }}`-style interpolation). That created an injection
class: a producer's output could itself contain `${{ ... }}`-shaped text,
and a re-scan of the already-substituted prose would interpret it as more
grammar (the "P1 `{{item}}` re-scan injection" the essay below names). The
workflow-format-unification work (spec §2.3) closed that class structurally
rather than by escaping or sanitizing.

## Decision

The essay, moved verbatim from `src/workflows/exec/native-executor.ts`'s
module header:

> Data flow (workflow-format-unification, spec §2.3): there is NO
> interpolation language. A unit's instructions are the step's body prose
> BYTE-EXACT — prose is never scanned for reference syntax, so a literal
> `${{` in a body is content, not grammar. Data reaches the unit as ATTACHED
> STRUCTURED CONTEXT rather than string splices: `buildUnitPrompt`
> (`exec/step-work.ts`) wraps the verbatim instructions with JSON blocks for
> the run params, a map unit's item + index, and the artifacts named by the
> step's `inputs:`. Because nothing is ever substituted INTO the prose, the
> P1 `{{item}}` re-scan injection class is structurally impossible.
>
> References survive only in the three whole-value FRONTMATTER positions the
> closed two-root grammar occupies (`program/expressions.ts`): `map.over`,
> `route.input`, and each `inputs[]` entry. They resolve ONCE per step
> against `{ params, stepOutputs }`. There is NO ambient key search: a
> `steps.<id>.output.<path>` reference addresses INTO that step's recorded
> output explicitly.
>
> Step outputs (`steps.<id>.output…`): every engine-executed step journals a
> promoted ARTIFACT under `evidence.output` — the solo unit's result/text,
> the collect reducer's per-item array, or the vote reducer's winner — and
> that artifact is what the reference scope exposes
> (`projectStepOutput`). The documented addressing
> (`steps.discover.output.files`) therefore resolves against real step
> results, never the raw evidence envelope (peer review R1). Steps completed
> manually (no `output` key in their evidence) expose their recorded
> evidence object as-is.

## Consequences

- A workflow author can never accidentally (or deliberately) inject
  reference grammar through step output content — the prose a unit receives
  is always byte-exact, and the only place reference syntax is EVER parsed
  is the three closed frontmatter positions, resolved once, before dispatch.
- `steps.<id>.output` addressing is stable and explicit: it always resolves
  against the PROMOTED artifact a step recorded, never against an internal
  evidence shape that could change without the reference contract changing
  with it.
- Peer review R1 flagged an earlier draft where the documented addressing
  risked resolving against the raw evidence envelope instead of the
  promoted artifact; the fix (route addressing through `projectStepOutput`)
  is what the essay above describes as settled behavior, not a proposal.
- Because references resolve ONCE per step (not per unit, not lazily),
  resuming a run against the same frozen plan recomputes the identical
  resolution — this is part of what makes `computeStepWorkList`
  (`step-work.ts`, ADR 0002) a pure function of (plan, params, journaled
  results).

## Provenance

- Source: `src/workflows/exec/native-executor.ts`, module header (the "Data
  flow" / "References" / "Step outputs" paragraphs).
- Spec: workflow-format-unification, spec §2.3.
- Review round: peer review R1 (addressing must resolve against the
  promoted artifact, not the raw evidence envelope).
- Extracted: P4 (`docs/plans/specs/p4-deletions-closeout.md` §4.2), 2026-08-27.
