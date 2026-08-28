# 0009 — Child-run publication's hand-duplicated INSERT column list

## Context

`WorkflowRunsRepository.insertRun` is the ordinary path that creates a
top-level `workflow_runs` row: a 13-column `INSERT` built from
`InsertRunInput`. P3a added `publishChildWorkflowRun`, the idempotent
publication path a parent step uses to create (or, on a race, discover) a
child run — `SELECT`-else-`INSERT` inside one `BEGIN IMMEDIATE` transaction,
so two concurrent callers racing on the same `(parentRunId, invocationKey)`
serialize on SQLite's write lock instead of double-inserting. Its own
`INSERT` is NOT a call to `insertRun` — it is a second, hand-written
16-column `INSERT` (the same 13 columns plus `parent_run_id`,
`parent_unit_id`, `invocation_key`) inside the same prepared statement as
the idempotency check.

This is not an oversight. P3a's review log (R11) considered sharing one
`INSERT` builder between the two paths and explicitly declined to guess at
the right shape for it with the caller (`publishChildWorkflowRun`) barely a
commit old — a signature refactor made in haste, before the shape had
proven itself in use, was judged a worse bet than a documented duplication.

## Decision

**Keep the duplication as an explicit, cross-referenced invariant rather
than refactoring it.** `insertRun`'s 13-column list and
`publishChildWorkflowRun`'s first 13 columns must stay byte-identical by
hand — each site carries a one-line comment naming the other and pointing
here. This was re-affirmed rather than fixed during the P4 close-out
(`docs/plans/specs/p4-deletions-closeout.md` §8, row R-R3): "A signature
refactor now, with P3b's caller one commit old, is exactly the guess R11
declined to make."

The two INSERTs are NOT candidates for a trivial "extract the shared 13
columns" refactor either, despite looking like one: they run inside
different transaction shapes (`insertRun` runs standalone or inside
whatever transaction its caller already holds; `publishChildWorkflowRun`
runs inside its own `immediateTransaction`, specifically `BEGIN IMMEDIATE`
so the idempotency check and the insert are atomic against a racing
publisher) and `publishChildWorkflowRun`'s version is followed by
`insertSteps`, a `plan_json`/`plan_hash`/`plan_ir_version` update, and an
idempotent `workflow_started` event insert — all inside the SAME
transaction, none of which `insertRun`'s callers do at the same call site.
A shared builder would need to either accept both shapes as parameters
(defeating the point of extraction) or leave the transaction/follow-up
choreography to the caller anyway (in which case the "shared" part is only
the column list, which is exactly what the hand-duplication already is).

## Consequences

- Any future change to `workflow_runs`'s schema that adds or removes a
  column BOTH paths write must update both `INSERT`s in the same commit.
  The two comments (at `insertRun` and at `publishChildWorkflowRun`'s
  `INSERT`) exist specifically so a reviewer checking one site is pointed at
  the other.
- A drift between the two column lists is a silent correctness bug, not a
  compile error — SQLite's parameter binding is positional, so a column
  added to `insertRun` but not to `publishChildWorkflowRun` (or reordered in
  one but not the other) would silently bind the wrong value to the wrong
  column rather than failing loudly. This is precisely why the invariant
  comment exists as a standing reminder rather than being left implicit.
- A future refactor attempt should re-read R11 and this record before
  concluding the duplication is accidental — it is a deliberate,
  re-affirmed choice made twice (P3a, then P4), not an oversight waiting to
  be cleaned up.

## Provenance

- Sites: `src/storage/repositories/workflow-runs-repository.ts` —
  `WorkflowRunsRepository.insertRun` and
  `WorkflowRunsRepository.publishChildWorkflowRun`.
- Source: P3a Review log, finding R11 (the original "should these share a
  builder?" question, declined).
- Disposition: `docs/plans/specs/p4-deletions-closeout.md` §8, row R-R3
  ("RESOLVED AS AN INVARIANT, not a refactor").
- Extracted: P4, 2026-08-27. Unlike ADRs 0001–0005/0007–0008, this record is
  new content written for the close-out, not a moved essay — there was no
  pre-existing long comment block to extract; R11's finding lived only in a
  review log until this record and the two source comments it backs were
  added.
