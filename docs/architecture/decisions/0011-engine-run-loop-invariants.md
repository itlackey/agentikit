# 0011 — The engine run loop's invariants: gate spine, frozen plan, run lease, process lifecycle

## Context

`src/workflows/exec/run-workflow.ts` is `akm workflow run`'s
start/resume/execute path — the single execution surface that walks a
frozen plan and dispatches every unit. It sits one layer above
`native-executor.ts` (unit dispatch, ADR 0001) and `step-work.ts` (pure
step semantics, ADR 0002): this module is where the ENGINE LOOP's own
invariants live — never bypassing the gate spine, reading the plan from
its frozen row rather than live source, holding a run lease, running
bounded gate loops, and not leaking OS handles on exit.

## Decision

Moved verbatim from `run-workflow.ts`'s module header:

> Engine-driven workflow execution — the `akm workflow run`
> start/resume/execute path, and the single execution surface for a run:
> akm walks the frozen plan and dispatches every unit itself.
>
> **Invariant (plan §*Never bypass the gate spine*):** every step advances
> through `completeWorkflowStep`, never by writing step rows directly, so
> the summary-validation gate and run-state derivation stay authoritative.
> A gate rejection (`SummaryValidationFailure`) STOPS the engine and
> surfaces the corrective feedback — a gate is a gate, even for the engine.
>
> **Artifact-judging gates (redesign addendum, R2):** when a step declares
> completion criteria, the engine hands the gate a summary BUILT FROM the
> step's promoted artifact (canonical JSON, clipped, prefixed with a
> one-line unit count — `buildArtifactSummary`) instead of the machine-prose
> execution summary, so the judge evaluates real results. Each
> engine-driven judge call is journaled as a unit row (`node_id
> "<stepId>.gate"`, `unit_id "<stepId>.gate:l<loop>"`, runner "llm",
> `result_json` = the verdict) through the writer queue — it is an LLM call
> like any other. Human approvals are never cached: a blocked gate stays
> blocked.
>
> **Bounded gate loops (`gate.max_loops`, addendum R2):** a rejection on a
> step with `maxLoops > 1` re-executes the step subgraph with the judge's
> feedback + `missing[]` threaded into every unit prompt (`gateFeedback` on
> `StepExecutionContext`) — the feedback changes each unit's input hash, so
> the loop re-dispatches naturally instead of reusing the rejected rows.
> After `maxLoops` rejections the engine stops with the gate feedback,
> exactly like the one-shot case. A typed-artifact schema mismatch feeds
> the same loop (the validation errors are the feedback; no judge ran, so
> no gate unit is journaled for that attempt) — only the FINAL loop's
> mismatch fails the run. `effectiveGateMaxLoops` caps a step to a SINGLE
> loop whenever its subgraph's frozen target is anything other than a
> `command` (agent/SDK/LLM-runner) target — which covers both an `exec`
> unit (a `shell`/`script` target) and a composed `child-workflow` step,
> for two DIFFERENT reasons that both land on the same cap. An exec unit's
> argv is frozen and never interpolated, so it cannot read the feedback: a
> second loop would only re-run the identical side effect. A child-workflow
> unit has no prompt to thread feedback into either — its only frozen input
> is the composing step's resolved `with:` bindings, published once to the
> child run — so a second loop would re-publish the same child with
> byte-identical bindings rather than asking it anything new. Only a
> `command`-targeted (engine) step, whose feedback is threaded into its
> prompt, can loop past one; an authored `gate.max_loops` on an engine step
> is untouched.
>
> **Frozen plan (redesign addendum, R1):** the plan graph is read from the
> run row (`plan_json`, persisted by `startWorkflowRun` under migration
> 006) with a `plan_hash` integrity check — the workflow asset file is
> NEVER re-read for an in-flight run, so a mid-run asset edit cannot change
> behavior. Durable-row resume: re-invoking a partially-executed run
> re-dispatches only work that never completed.
>
> **Run lease (redesign addendum, R2):** exactly one engine invocation
> drives a run at a time. The lease (random holder id + 90s expiry on the
> run row) is acquired before any dispatch, renewed between steps, and
> released in a `finally` unless a failed run retains it as forensic
> state; a second `workflow run` on a live-leased run refuses up front, and
> an expired lease is claimable (crash recovery). While the lease is live,
> any competing spine advance is refused — the engine owns the run while
> driving (enforced inside `completeWorkflowStep`).
>
> **Process-lifecycle contract (owner finding 4 — no leaked handles):** the
> SDK dispatch path caches `opencode serve` CHILD PROCESSES in a per-env
> registry for reuse across units. Each live child is an OS handle that
> keeps Bun's event loop open; the registry's own teardown is wired only to
> `process.once('exit')`, which never fires while a child holds the loop
> open. That deadlock hangs a one-shot CLI (`akm workflow run` has no
> `process.exit` on success — it relies on the loop draining). The engine
> therefore DRAINS the dispatch registry (`disposeDispatchResources`) in its
> run `finally`, on EVERY exit path, so the process exits cleanly the
> moment the run resolves. The drain is synchronous, idempotent, and a
> no-op when no SDK server started.

## Consequences

- Any future code path that advances a step must go through
  `completeWorkflowStep` — a direct write to a step row bypasses both the
  summary-validation gate and run-state derivation, silently breaking the
  gate-is-a-gate guarantee even if the write itself succeeds.
- Because the frozen plan is read from `plan_json` (never the live asset),
  editing a workflow's Markdown/YAML source after a run has started has
  **no effect** on that run — this is the same "child source edits cannot
  alter an in-flight parent run" property child workflows rely on (P3a),
  applied to the root run itself.
- A new dispatch backend that spawns a long-lived child process (the way
  the SDK harness does) must register its teardown with the SAME drain the
  engine already calls in its run `finally` — relying on `process.exit` or
  `process.once('exit')` alone reintroduces the exact hang class "owner
  finding 4" fixed.
- The run lease is the ONLY exclusivity mechanism for driving a run;
  anything that touches a run's step spine outside `completeWorkflowStep`
  while a lease might be live needs to reason about this contract
  explicitly rather than assuming single-writer access.

## Provenance

- Source: `src/workflows/exec/run-workflow.ts`, module header.
- Review markers: "redesign addendum" R1/R2, "owner finding 4".
- Extracted: P4 (`docs/plans/specs/p4-deletions-closeout.md` §4.2), 2026-08-27.
  Added as an 11th record, past the ten-item minimum set the spec named —
  `run-workflow.ts` carries "(comment only)" on Lane B's file list (§6) but
  was not cited by name in §4.2's minimum-ADR-set table; this essay does not
  fit cleanly inside any of the other ten without either duplicating engine-
  loop-specific reasoning into a step- or unit-scoped record or dropping it,
  both of which the spec's no-reasoning-deleted rule forecloses. §4.2
  explicitly permits the implementer to merge related essays and record the
  final set in the commit body — this is the converse case, an essay that
  does not merge cleanly, so it gets its own number instead.
