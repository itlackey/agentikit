# 0007 — Recursive child-workflow composition bounds

## Context

P3a made a workflow step able to compose another workflow as a child — via
a direct `uses: workflows/<ref>` step or a task-wrapped `uses: tasks/<ref>`
step whose target is itself a workflow — and made that composition
recursive: a child can itself compose a grandchild, bounded only by policy.
Recursion without a bound is a corruption/DoS surface at both ends of the
plan's lifecycle: an attacker-controlled or merely buggy source could
either recurse arbitrarily deep at freeze time, or (once persisted) blow up
the aggregate bytes a parent plan carries once every descendant's frozen
plan is embedded inside it.

## Decision

Moved verbatim from `src/workflows/resource-limits.ts`'s composition-bounds
section:

> Enforced ONCE, at freeze, before publication, in
> `src/workflows/freeze/targets/child-workflow.ts` — the ONE resolver both
> the direct `uses: workflows/<ref>` form and the task-wrapped form route
> through — and re-enforced as a corruption gate whenever a parent plan is
> DECODED (`src/workflows/ir/schema-v4.ts`'s recursive
> `decodeChildWorkflowTarget`).
>
> `WORKFLOW_MAX_COMPOSITION_DEPTH` (= 8): max workflow composition depth —
> the root workflow plus this many descendant levels (root is depth 0, so 8
> descendant levels freeze and a 9th fails). Deep enough that no legible
> authored composition hits it (the per-workflow bounds — 256 steps, 64
> engines, 10 000 map expansion — are the practical ceilings), shallow
> enough that the worst case is bounded recursion during freeze and decode.
>
> The max AGGREGATE canonical-JSON bytes of every embedded child plan in
> ONE root freeze (the sum across the whole composition tree, not per
> child) is deliberately HALF of `WORKFLOW_MAX_PLAN_BYTES` rather than a
> larger value layered on top of it: an embedded child plan lives INSIDE
> its parent's own plan bytes, so a cap independent of (and comparable to)
> the total plan cap would let composition alone exhaust it. Halving keeps
> the parent's own content always able to claim at least half the budget,
> and lets this actionable, freeze-time `COMPOSITION_INVALID` (which names
> the offending child ref and the running total) fire before the terse,
> unlocated decoder message a reviewer would otherwise have to debug.
> Rejected alternative: raising `WORKFLOW_MAX_PLAN_BYTES` itself, which
> would relax a corruption/DoS bound for every plan — including ones with
> no children — to serve a bound only composition needs (A-N6).

## Consequences

- The bound is enforced TWICE by design, not once: at freeze (where a
  violation gets an actionable `COMPOSITION_INVALID` naming the offending
  ref) and again at decode (where it acts purely as a corruption gate for a
  persisted plan that should already be valid). A future change that
  removes the decode-time re-check on the theory that "freeze already
  checked it" would remove the last line of defense against a corrupted or
  hand-edited `plan_json` row.
- `WORKFLOW_MAX_COMPOSITION_DEPTH` and the aggregate-bytes cap are both
  named in `docs/plans/specs/p4-deletions-closeout.md` §0 as one of the
  three numbers ("`WORKFLOW_MAX_*` limits, plan `irVersion` 5, `hashVersion`
  6") that P4 is expressly forbidden from changing — a P4 commit that
  touches either is a review-blocking violation, and the same discipline
  should apply to any later phase unless a spec explicitly re-opens it.
  **2026-08-27 update:** `hashVersion` itself moved on from that pinned
  value after this ADR was written — P4's R-R15 advisory (a reference
  binding's resolved value sitting outside the unit-input hash) was closed
  by bumping `hashVersion` 5 → 7 to fold `taskInputs` into the preimage
  (`src/workflows/exec/step-work.ts`, `.update("akm.workflow.unit\0v7\0")`,
  `hashVersion: 7`); see ADR 0002's "Consequences" entry for the full
  supersession. The composition-bounds discipline this entry describes
  still applies to `WORKFLOW_MAX_COMPOSITION_DEPTH` and the aggregate-bytes
  cap unchanged — only the `hashVersion` figure in the quoted §0 sentence is
  now stale.
- The half-of-plan-bytes ratio is a relationship, not an independent
  constant — if `WORKFLOW_MAX_PLAN_BYTES` itself is ever revisited, the
  composition cap should move with it rather than being independently
  retuned, per the rejected-alternative reasoning above.

## Provenance

- Source: `src/workflows/resource-limits.ts`, the "Recursive child-workflow
  composition bounds" section.
- Spec: `docs/plans/specs/p3a-plan-v5-child-freeze.md` §4.5, A-N6.
- Extracted: P4 (`docs/plans/specs/p4-deletions-closeout.md` §4.2), 2026-08-27.
