# 0002 — Unit reuse and the input-hash scope

## Context

A resumed workflow run must recompute the same units the original run
dispatched, byte-for-byte, so that journaled rows can stand in for a live
dispatch instead of re-executing. That guarantee depends on two things
staying strictly separated: which computations are PURE functions of
`(frozen plan, params, journaled results)`, and exactly which fields feed
the hash that decides whether a journaled unit is still valid to reuse.
`src/workflows/exec/step-work.ts` is the one module both the fresh-execution
path (`native-executor.ts`) and the resume/replay path share for these
decisions, specifically so the two paths cannot drift apart.

## Decision

### The module's purity contract

Moved verbatim from `step-work.ts`'s module header:

> Shared step semantics — the ONE implementation of a step's orchestration
> decisions, consumed by the engine loop (`run-workflow.ts` +
> `native-executor.ts`) on both the fresh-execution and the resume/replay
> path. The cardinal rule here is *no duplicated semantics*: work-list
> computation, prompt assembly, reducer/artifact promotion, output-schema
> validation, artifact-judged gate summaries, gate-feedback recovery, and
> route evaluation live here so a first run and a resumed run of the same
> frozen plan produce byte-identical unit graphs.
>
> **What is PURE here.** `computeStepWorkList` — given the frozen step plan
> and a `WorkListInput` (params, prior step outputs, gate-loop number + its
> recovered feedback) — is a pure function: same inputs ⇒ same unit ids,
> input hashes, and fully-resolved prompts. It takes NO clock, NO IO, and NO
> journal (journal-derived state, i.e. the recovered gate feedback, is
> passed in). This is the load-bearing guarantee that a resumed run
> recomputes exactly the units the original run dispatched, so journaled
> rows can be reused instead of re-executed. So are the reducer/artifact
> helpers (`buildEvidence`, `projectStepOutput`, `validateStepArtifact`,
> `buildArtifactSummary`), the gate-feedback recovery (`recoverGateFeedback`
> / `activeGateLoop`), and route evaluation (`evaluateRoute` and its
> bookkeeping).
>
> **What does IO here.** The gate-evaluation journaling
> (`journalGateEvaluationStart` / `journalGateEvaluationFinish`) writes
> `workflow_run_units` rows through the serialized writer queue — an
> engine-driven judge call is an LLM call and is journaled like a unit. It
> lives here (not in the engine loop) so every caller journals gate
> evaluations through the identical writer.
>
> This module NEVER dispatches a unit and NEVER writes step rows: dispatch
> is the executor's job (`native-executor.ts`), advancing the gated spine is
> the engine loop's job (`run-workflow.ts` via `completeWorkflowStep`).

### The input-hash preimage

Moved verbatim from `computeUnitInputHash`'s doc comment:

> The canonical dispatch-input envelope (reviewer finding #1). Every field
> here is a PLAN-FROZEN input that changes what the backend is actually
> asked to do, so a completed unit is reused ONLY when all of them match; a
> change to any of them re-dispatches. `canonicalJsonString` sorts keys
> recursively, so the preimage is order-independent, and this is the ONE
> place a unit's inputHash is computed (every caller goes through
> `computeStepWorkList`) — a hash that is byte-identical across a fresh run
> and a resume is structural, not coincidental.
>
> Unit identity (workflow-format-unification, spec §2.3/§4) hashes the
> FROZEN TEMPLATE BYTES (`template.instructions`, byte-exact, never an
> instantiated/interpolated string) + the canonical item JSON + the
> declared-input artifacts + the params snapshot — instead of a
> resolved/spliced prompt string, since there is no more splicing.
>
> Included beyond the template/runner/model/schema baseline: resolved
> timeoutMs, named environment bindings, and isolation — each reaches
> dispatch and a changed one yields a materially different call. `env`
> carries NAMES ONLY, never resolved values: hashing a resolved secret would
> leak it into a durable hash oracle and would spuriously re-dispatch on
> every secret rotation. `retry`/`onError` are DELIBERATELY excluded — they
> govern failed-unit re-dispatch and step-level failure reduction, not a
> COMPLETED unit's inputs/output, so a completed row stays valid across
> policy changes.
>
> `gateFeedback` IS included (conditionally, so a no-feedback unit's
> preimage is byte-identical to before): it is appended to the prompt by
> `buildUnitPrompt`, so a gate loop's retry is materially a different ask
> than the rejected attempt. Replay-safe: feedback is re-derived from the
> journaled gate decision, so a resumed retry re-hashes identically.
>
> `taskInputs` IS included, on the same conditional terms (R-R15,
> `hashVersion` 7): a reference binding's RESOLVED value reaches the unit's
> prompt / `AKM_TASK_INPUTS` / `childParams`, so a changed upstream value is
> a materially different ask even though the binding's authored shape inside
> `frozenTarget` is unchanged. Hashing it makes a resume whose journaled
> upstream output was altered fail loudly as replay divergence instead of
> silently reusing the stale row. The key is absent for a unit whose target
> carries no `inputBindings`, so a binding-free unit's preimage keeps the
> shape it had — only the version fields moved.
>
> Command targets carry their frozen argv/script/cwd/timeout identity in the
> same target slot used by agent, SDK, and direct-LLM work. The complete
> current target is hashed once, so a completed unit is reused only for the
> exact durable request that originally produced it.
>
> Ambient config is deliberately excluded because it is not consulted
> during execution. The frozen target and named environment bindings are
> the runtime identity boundary; only the values behind those names remain
> live.

## Consequences

- Any new field added to a unit's dispatch plan must be triaged against
  this scope explicitly: does it change what the backend is asked to do
  (include it), is it a policy about failure handling rather than a
  completed unit's inputs/output (exclude it, like `retry`/`onError`), or is
  it a resolved secret value (exclude the value, include only the name)?
  Getting this wrong either lets a materially different request reuse a
  stale journaled row, or spuriously invalidates every journaled row on an
  unrelated change.
- `hashVersion` (currently **7**) is the version prefix mixed into this hash;
  changing what this preimage covers requires bumping it. P4's R-R15 carried
  advisory — a reference binding's RESOLVED value sitting outside this hash —
  is exactly such a scope change, and it is now **resolved**: `taskInputs`
  (the resolved values of a composed task's reference-kind `inputBindings`) is
  a conditional preimage field, present only for a unit whose frozen target
  carries `inputBindings`, and closing it came with the bump this rule
  mandates. The 0.9.2 line's released tags (`v0.9.2-alpha.1`…`alpha.4`) all
  carry 5, so the durable, user-visible step is 5 → 7. The "left unfixed
  rather than folded in as a quiet scope change" note in
  `docs/plans/specs/p4-deletions-closeout.md` §8 R-R15 (and p3b §3.6's "why
  `hashVersion` stays 6") records the state BEFORE that bump and is
  superseded by this entry.
- Because the whole module is import-cycle-free with respect to dispatch
  (it never dispatches, never writes step rows), the fresh-execution and
  resume/replay paths cannot silently diverge by one of them bypassing this
  module's decisions.

## Provenance

- Source: `src/workflows/exec/step-work.ts`, module header (the Purity
  Contract) and `computeUnitInputHash`'s doc comment (reviewer finding #1).
- Spec: workflow-format-unification, spec §2.3/§4.
- Extracted: P4 (`docs/plans/specs/p4-deletions-closeout.md` §4.2), 2026-08-27.
