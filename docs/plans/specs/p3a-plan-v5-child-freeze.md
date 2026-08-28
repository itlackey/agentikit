# P3a — plan `irVersion` 5, `hashVersion` 6, and the one recursive child-workflow freeze

**Status:** ready for implementation
**Phase:** P3a of the akm task/workflow refactor
**Owner artifacts:** `src/workflows/ir/schema-v4.ts` (in-place plan-schema
version bump + the `child-workflow` frozen target), `src/workflows/ir/plan-hash.ts`
+ `src/workflows/runtime/plan-classifier.ts` (the complete-or-abandon decode
policy), `src/workflows/exec/step-work.ts` (`hashVersion` 6),
`src/workflows/exec/child-invocation.ts` (new, pure),
`src/workflows/freeze/targets/child-workflow.ts` (new — the ONE recursive
resolver), `src/workflows/source-ir/semantics.ts` +
`src/workflows/freeze/targets/task.ts` (the two rejection removals),
`src/workflows/resource-limits.ts` (depth / aggregate-bytes bounds),
`src/execution/guarded-source.ts` (read-set absorption),
`src/core/state/migrations.ts` (migration `023-child-workflow-runs`),
`src/storage/repositories/workflow-runs-repository.ts`
(`publishChildWorkflowRun` + the child accessors), the §6 authorized behavior
flips, and the §8 docs.

This document is the **single source of truth** for P3a. Lanes do not
re-derive these facts from the codebase and do not read the parent plan. Every
`file:line` below was verified at the head of
`claude/breaking-changes-0-9-2-3cfyvp` (P2b closed out: `7a491ff6`).

---

## 0. What P3a is (and is not)

P2b made a workflow step's `with:` a real, frozen, delivered **binding** on a
`tasks/<ref>` target. Composition still stopped at the workflow boundary: every
route to `uses: workflows/<ref>` — direct or task-wrapped — was rejected. P3a
makes a child workflow a **frozen target inside the parent's plan**, bumps the
plan and hash vocabularies once for it, and lands the durable storage a child
run needs.

P3a **is**:

- **plan `irVersion` 5** — a new `child-workflow` member of the frozen-target
  union carrying the **complete frozen child plan, embedded**, decoded and
  re-verified whenever the parent plan is decoded (§3);
- a **complete-or-abandon** policy for stored `irVersion` 4 runs: `status` /
  `list` / `abandon` keep working, `resume` / execute fail closed with a
  policy-naming message under the pre-declared code
  `WORKFLOW_IR_VERSION_UNSUPPORTED`. **No second executor. No v4 replay
  layer.** (§3.2)
- **`hashVersion` 6** — both unit and gate input-hash prefixes bump once, with
  the full preimage table stated here (§3.3);
- a pure **`invocation_key`** derivation helper (§3.4);
- **ONE recursive child-workflow resolver** in freeze, reached by BOTH the
  direct `uses: workflows/<ref>` step and the task-wrapped
  `uses: tasks/<ref>`-whose-task-targets-a-workflow form (§4);
- three **composition bounds** — depth, cycle, aggregate embedded plan bytes —
  all failing at FREEZE, before publication, with `COMPOSITION_INVALID` (§4.5);
- **migration `023-child-workflow-runs`** plus an **idempotent**
  `publishChildWorkflowRun` with pinned crash-window and concurrent-publisher
  semantics (§5).

P3a is **not**:

- a **child EXECUTION phase.** Nothing in P3a dispatches, schedules, or
  advances a child run. `publishChildWorkflowRun` ships with **no production
  caller** — P3b wires it. Consequence, and a gate: `akm workflow list` /
  `status` / `next` output is **byte-unchanged** in P3a, because no child row
  is ever created by a production path (§5.5).
- a **status-tree, outputs, or `akm workflow plan` phase.** P3b owns those.
- a **vocabulary-rename phase.** `src/workflows/ir/schema-v4.ts` keeps its
  FILE NAME and every exported TYPE name (`WorkflowPlanGraphV4`,
  `decodeWorkflowPlanV4`, `IrUnitNodeV4`, …). Only the version CONSTANT
  changes (§3.1, A-N1). P4 owns the rename.
- a **v3 removal phase.** v3 task documents still parse, run, and schedule.
- a **limit-relaxation phase.** `WORKFLOW_MAX_PLAN_BYTES` stays `2 * 1024 *
  1024` (§1.8, A-N6).

Rules of engagement (unchanged since P1b):

- A defect discovered that is **not** in §6 is recorded in the Review log and
  left unfixed. Do not "improve" anything on the way past.
- If preserving a behavior and implementing an authorized change appear to
  conflict, **stop and record it** — preserving wins until the Review log says
  otherwise.
- Editing a **pre-existing** test that §6 does not name is a **review-blocking
  violation**.

### 0.1 Naming discipline (binding, D1)

Two independent version counters move in this phase and they are one apart.
Never write a bare `v5` or `v6` in prose, a comment, a test name, or a commit
message:

| Counter | Name to use | New value | Where it lives |
|---|---|---|---|
| Workflow plan schema | **plan `irVersion` 5** | `5` | `WORKFLOW_IR_V5_VERSION`, `plan.irVersion`, `workflow_runs.plan_ir_version` |
| Unit / gate input hash | **`hashVersion` 6** | `6` | `akm.workflow.unit\0v6\0`, `akm.workflow.gate\0v6\0`, the `hashVersion` preimage field |

The `\0v6\0` inside a hash PREFIX STRING is a byte literal, not prose — write
it verbatim. Everywhere else, the words "plan irVersion" or "hashVersion"
must accompany the number.

### 0.2 Commit ladder (binding)

| # | Commit | Contents |
|---|---|---|
| 1 | `docs(p3): behavior spec for plan irVersion 5 and child-workflow freeze` | **this file only** |
| 2 | `test(p3a): failing tests for plan irVersion 5 and child-workflow freeze` | §7's new suites, red |
| 3 | `feat(p3a): plan irVersion 5, hashVersion 6, and the v4 complete-or-abandon policy` | Lane A + the §6 flips Lane A owns |
| 4 | `feat(p3a): recursive child-workflow freeze` | Lane B + the §6 flips Lane B owns |
| 5 | `feat(p3a): child workflow run storage and idempotent publication` | Lane C (disjoint from B; may land in parallel with 4) |
| 6 | `docs(p3a): child workflows, plan irVersion 5, and the 0.9.2 upgrade break` | §8 docs |

Commit 3 must be green on its own. Commit 4 depends on 3 (a child target
cannot be frozen into a plan whose schema does not admit it). Commit 5 touches
no file commit 4 touches except `workflow-runs-repository.ts`, whose Lane A
edit (`plan_ir_version = 5`, one line) lands in commit 3.

---

## 1. Binding design decisions (verbatim)

§1.1–§1.7 are copied **verbatim** from the phase decisions and are binding.
§1.8 records the disambiguations this spec adds, each with head-verified
evidence. Where a verbatim block and a disambiguation appear to conflict, the
disambiguation states which reading wins and why.

### 1.1 D1 naming (binding)

> Workflow plan side: WORKFLOW_IR_V5_VERSION = 5, plan "irVersion 5";
> unit/gate input-hash prefixes become "akm.workflow.unit\0v6\0" and
> "akm.workflow.gate\0v6\0" (hashVersion: 6). Never bare "v5"/"v6" in prose
> without "plan irVersion" / "hashVersion".

### 1.2 Lane A — plan schema v5 + hashVersion 6 + v4 complete-or-abandon (binding)

> 1. Add FrozenChildWorkflowTarget to the frozen-target union (currently
>    command|shell|script in src/workflows/ir/schema-v4.ts:114, decoder
>    decodeFrozenTarget at :260-271 with a closed kind check): { kind:
>    "child-workflow", ref, planHash, frozenPlan (the complete frozen child
>    plan, embedded), inputBindings, contentHash, … } — the spec finalizes
>    exact fields. Introduce the v5 schema module (src/workflows/ir/schema-v5.ts
>    or an in-place version bump — spec decides, but the DECODER must accept
>    exactly irVersion 5 for execution).
> 2. plan-hash.ts decode path: canonical-bytes -> sha256 match -> irVersion
>    check. Post-P3a: irVersion 5 is the sole EXECUTABLE plan; irVersion 4
>    plans remain DECODABLE FOR STATUS AND ABANDON ONLY — `akm workflow
>    status`/`list`/`abandon` keep working on stored v4 runs, but
>    resume/execute of a v4 run fails closed with a clear message naming the
>    policy ("pre-v5 plans cannot execute after the 0.9.2 upgrade; complete
>    them before upgrading or abandon and restart from source") — reuse
>    WORKFLOW_IR_VERSION_UNSUPPORTED semantics if such a code exists, else
>    COMPOSITION_INVALID is wrong — pick the correct existing code family and
>    name it in the spec. NO second executor, NO v4 replay layer.
> 3. hashVersion 6: bump both prefixes in src/workflows/exec/step-work.ts
>    (computeUnitInputHash ~:585-606, gate hash ~:1707-1716). The SPEC must
>    state the FULL v6 preimage table explicitly (role, stepId, nodeId,
>    template, item, inputs, params, frozenTarget — which now may embed child
>    planHash + inputBindings — environment, schema, isolation, gateFeedback).
>    Record as a DOCUMENTED EXCLUSION that persona snapshots are NOT in the
>    preimage (unification-spec future work — reviewers must not "fix" it).
>    Since v4 plans can no longer execute, there is no replay-compat concern
>    with the bump; say so.
> 4. invocation_key derivation helper:
>    sha256("akm.workflow.child-invocation\0v1\0" +
>    canonicalJson({parentRunId, parentUnitId, unitInputHash})) where
>    unitInputHash is the v6 unit hash. Lives beside the hash code; pure.

### 1.3 Lane B — ONE recursive child-workflow resolver in freeze (binding)

> 1. src/workflows/freeze/targets/child-workflow.ts: BOTH forms lower here —
>    a direct step `uses: workflows/<ref>` AND a task-wrapped workflow target
>    (a tasks/<ref> whose task targets a workflow). The task path already
>    resolves task inputs via task-bindings.ts; effective inputs become the
>    child's params.
> 2. Classification flip: src/workflows/source-ir/semantics.ts:141-146
>    currently throws nested-workflow-unsupported for a direct workflows/<ref>
>    step — that rejection is REMOVED; classification returns the workflow
>    target and freeze decides. The duplicate task-side rejection pair (now in
>    src/workflows/freeze/targets/task.ts after the P2b split; original sites
>    source-freeze-v4.ts:220-222/:237-239) is REPLACED by routing to the child
>    resolver. P4 deletes any dead remnants; P3a must leave ZERO reachable
>    "cannot compose a nested workflow" path.
> 3. Recursive freeze: compiling the parent freezes each child COMPLETELY
>    (compile child source -> validate -> freeze its plan) BEFORE the parent
>    run publishes. Child source files (workflow doc + its
>    commands/scripts/tasks, transitively) enter the parent's source read set,
>    so the parent's publication CAS covers them. Editing child source after
>    parent start must not affect the frozen parent.
> 4. Limits in src/workflows/resource-limits.ts (new constants, spec picks
>    values with rationale): max composition DEPTH (suggest 8), CYCLE
>    detection via the ref-path set (a workflow reaching itself through any
>    chain of workflows/tasks fails COMPOSITION_INVALID naming the cycle
>    path), max AGGREGATE embedded plan bytes (suggest 4 MiB). All three fail
>    AT FREEZE, before publication, with COMPOSITION_INVALID.
> 5. The embedded child plan's planHash is re-verified when the parent plan is
>    decoded (corruption boundary: a tampered embedded child fails decode).

### 1.4 Lane C — migration 023 + idempotent child publication (binding)

> 1. Migration "023-child-workflow-runs", classification "additive": ALTER
>    TABLE workflow_runs ADD COLUMN parent_run_id TEXT; ADD COLUMN
>    parent_unit_id TEXT; ADD COLUMN invocation_key TEXT; CREATE INDEX
>    idx_workflow_runs_parent ON workflow_runs(parent_run_id); CREATE UNIQUE
>    INDEX idx_workflow_runs_invocation_key ON workflow_runs(parent_run_id,
>    invocation_key) WHERE parent_run_id IS NOT NULL. Append to
>    STATE_MIGRATIONS in src/core/state/migrations.ts AND the same position in
>    STATE_MIGRATION_SAFETY_BY_ID (the registry is position-checked at module
>    load — appending one without the other is a startup crash). Migration
>    comment MUST disambiguate: workflow_runs.parent_unit_id = "the parent
>    run's unit that spawned this child"; workflow_run_units.parent_unit_id
>    (migrations.ts:935) = map fan-out template parentage — different
>    concepts, same column name, and the TypeScript repository API uses
>    spawnedByUnitId to avoid the collision.
> 2. publishChildWorkflowRun(input) in
>    src/storage/repositories/workflow-runs-repository.ts, beside
>    publishWorkflowRunV4 (:508-539): ONE immediateTransaction that SELECTs by
>    (parent_run_id, invocation_key) and returns the existing child if
>    present, else INSERTs the child run row (embedded frozen child plan JSON
>    + plan hash + irVersion 5 + params + parentage columns + invocation_key)
>    and its step rows, and appends the child's workflow_started event. It
>    must NOT apply top-level scope-conflict rules and must NEVER re-read
>    child source (the plan was frozen at parent freeze). The public
>    startWorkflowRun path is untouched and never used for children.
> 3. Repository accessors: spawnedByUnitId naming in the TS API;
>    childRunsOf(parentRunId); getRunByInvocationKey(parentRunId, key).
> 4. Crash-window semantics to pin NOW (execution itself is P3b): calling
>    publishChildWorkflowRun twice with the same key returns the SAME child
>    (idempotent across a crash between publish and parent-side recording);
>    two concurrent publishers race safely on the partial unique index (one
>    inserts, the loser reads the winner's row — assert both outcomes).

### 1.5 AUTHORIZED-FLIPS the spec must enumerate (binding)

> - tests/workflows/characterization-classification.test.ts: the R-03
>   nested-workflow rejection pins (direct + task-composed) flip to successful
>   classification/freeze.
> - tests/workflows/source-ir-contract.test.ts: the ["workflows/child",
>   "nested-workflow-unsupported"] row flips.
> - tests/execution/target-ref.test.ts: the ["workflows/child",
>   "nested-workflow-unsupported"] rejection row flips to acceptance.
> - tests/workflows/characterization-fixture-contracts.test.ts:
>   expect(plan.irVersion).toBe(4) flips to 5 (its comment already names P3a).
> - tests/workflows/with-rejection.test.ts / task-input-bindings.test.ts: any
>   row pinning "A workflow task step cannot compose a nested workflow
>   target." flips to the child-workflow path.
> - tests/integration/workflows/schema-drift.test.ts and any suite pinning
>   irVersion 4 or the v4 hash prefixes: update per spec.
> - P0's plan-v4 fixture family keeps its NAME but its structural test now
>   asserts irVersion 5 (the fixtures are sources, not plan bytes).
> Anything else that pins nested-workflow rejection or irVersion must be
> listed explicitly; an unlisted edit to a pre-existing test is a
> review-blocking violation.

### 1.6 Docs (ride with code) (binding)

> docs/reference/workflow-schema.md (child workflows: direct + task-wrapped,
> limits, frozen-before-publication semantics), docs/reference/workflows.md,
> docs/architecture/workflow-engine.md (plan v5, embedded child plans),
> CHANGELOG [Unreleased] BREAKING: pre-v5 stored plans no longer execute
> (status/abandon remain; complete or abandon v4 runs, then restart from
> source) + child workflows arrive; docs/migration/v0.9.1-to-v0.9.2.md updated
> accordingly. Every akm example lint-doc-examples-clean.

### 1.7 Preservation gates the reviewer runs (binding)

> frozen-plan/chaos/run-lease/crash-window suites green (updated only where
> the flips table says); tests/integration/workflows/v4-atomic-publication-red.test.ts
> semantics preserved for the PARENT publication path; fail-before-mutation
> suite unchanged; every P2b binding suite green; migration position/safety
> registry test green.

### 1.8 Binding disambiguations added by this spec

Each row states a decision the verbatim blocks leave open, or corrects a
detail contradicted by head. Every claim carries its evidence.

**A-N1 — in-place bump, no `schema-v5.ts`, no type renames.**
§1.2(1) offers "a new module or an in-place bump — spec decides". **In-place
wins**, in `src/workflows/ir/schema-v4.ts`, with the FILE NAME and every
exported TYPE name unchanged. Evidence and reasoning:

- There is no v4 decoder to keep. `classifyWorkflowRunPlan`
  (`plan-classifier.ts:38-48`) returns `unsupported-version` for a
  non-current `plan_ir_version` **without ever calling `decodeCanonicalPlan`**.
  A stored v4 run is therefore never decoded on any surface — status, list and
  abandon read only the run/step rows. "Decodable for status and abandon" in
  §1.2(2) means *the run stays readable and abandonable*, not *its plan bytes
  are parsed*. So a second schema module would have exactly zero callers.
- Renaming the exported types (`WorkflowPlanGraphV4` → `…V5`, etc.) would
  force edits to many **pre-existing** test files; §1.5 makes every such edit
  review-blocking unless enumerated. Keeping the type names holds the flip
  surface to the sites §6 lists.
- The version constant `WORKFLOW_IR_V4_VERSION` is **deleted** and replaced by
  `WORKFLOW_IR_V5_VERSION = 5 as const`. Its only meaning was "the executable
  version", and leaving both invites drift. Head sites, exhaustive
  (`rg WORKFLOW_IR_V4_VERSION src/ tests/ scripts/`): `schema-v4.ts:36,155,168,179,209`;
  `plan-hash.ts:19,56`; `plan-classifier.ts:9,17,41,49`; `freeze-v4.ts:21,84`;
  `tests/_helpers/workflow.ts:31,130`; `tests/workflows/ir-compile.test.ts:11`
  (aliased import, value never asserted); `tests/workflows/task-binding-identity.test.ts:21,58,154,155`.
  The two test files are §6 flips F-A6 and F-A7; `ir-compile.test.ts` needs
  only its import identifier updated and is F-A8.

**A-N2 — the correct error code is `WORKFLOW_IR_VERSION_UNSUPPORTED`.**
It already exists in the `UsageErrorCode` union (`src/core/errors.ts:81`) and
has **no producer anywhere** (`rg WORKFLOW_IR_VERSION_UNSUPPORTED src/ tests/`
returns that one declaration line). P3a is its first and only producer.
`COMPOSITION_INVALID` is explicitly wrong here — it is the freeze-time
"cannot compose" family (`errors.ts:102,188`), not a stored-plan-version
family. `INVALID_JSON_ARGUMENT` (today's code for this branch,
`plan-classifier.ts:75`) is retained for the `missing-plan` and `corrupt-plan`
branches; only `unsupported-version` re-codes. §3.2 states the split.

**A-N3 — head line numbers, corrected.** §1.2/§1.3 cite pre-P2b positions.
Verified at `7a491ff6`:

| Cited in §1 | Verified at head |
|---|---|
| `schema-v4.ts:114` (target union) | `src/workflows/ir/schema-v4.ts:122` (`export type FrozenWorkflowTarget = …`) |
| `schema-v4.ts:260-271` (`decodeFrozenTarget`) | `src/workflows/ir/schema-v4.ts:267-279` |
| `step-work.ts:585-606` (`computeUnitInputHash`) | `src/workflows/exec/step-work.ts:689-711` (prefix at `:691`, `hashVersion` at `:694`) |
| `step-work.ts:1707-1716` (gate hash) | `src/workflows/exec/step-work.ts:1829-1839` (prefix at `:1830`, `hashVersion` at `:1833`) — inside the `summaryJudge` closure, not a standalone function |
| `semantics.ts:141-146` (direct rejection) | `src/workflows/source-ir/semantics.ts:155-159` |
| `source-freeze-v4.ts:220-222/:237-239` (task rejections) | `src/workflows/freeze/targets/task.ts:116` and `:149` |
| `workflow-runs-repository.ts:508-539` (`publishWorkflowRunV4`) | `src/storage/repositories/workflow-runs-repository.ts:508-539` (unchanged) |
| `migrations.ts:935` (`workflow_run_units.parent_unit_id`) | `src/core/state/migrations.ts:934` |

**A-N4 — removing ONE throw retires the rejection on three call chains.**
`nested-workflow-unsupported` has exactly one producer,
`semantics.ts:155-159`, reached from `freeze/resolve-steps.ts:21` (freeze),
`source-ir/schema.ts:369` (`decodeWorkflowSourceIrV1`), and
`source-ir/github-yaml.ts:621` (compile). That is why §6 lists four
independent test sites for a single deletion: the classifier pin
(`characterization-classification.test.ts:180`), the decode pin
(`source-ir-contract.test.ts:1090`), and two code tables
(`source-ir-contract.test.ts:447`, `target-ref.test.ts:179`).
`WorkflowSourceUsesTarget` already admits `kind: "workflow"`
(`source-ir/uses.ts:29-31`), so removing the throw needs no type change.

**A-N5 — `tests/workflows/with-rejection.test.ts` needs NO edit.**
§1.5 says "with-rejection.test.ts / task-input-bindings.test.ts: any row
pinning …". Verified: `rg "nested workflow" tests/workflows/with-rejection.test.ts`
returns **nothing**. Only `task-input-bindings.test.ts:806,824` pin that
message. `with-rejection.test.ts` therefore stays **byte-unchanged** and is a
preservation gate (§7), not a flip.

**A-N6 — the aggregate embedded-plan cap is 1 MiB, not 4 MiB.**
§1.3(4) *suggests* 4 MiB and instructs the spec to pick with rationale. 4 MiB
is arithmetically impossible at head: a plan's TOTAL canonical JSON is capped
at `WORKFLOW_MAX_PLAN_BYTES = 2 * 1024 * 1024` in **two** places —
`plan-hash.ts:43-44` ("frozen plan exceeds the 2 MiB resource limit") and
`ir/schema.ts:161` ("plan exceeds the 2 MiB resource limit"). Embedded child
plans are *inside* the parent plan, so a 4 MiB aggregate could never decode.
The two ways out:

- **rejected:** raise `WORKFLOW_MAX_PLAN_BYTES` to 8 MiB. That relaxes a
  corruption/DoS bound for *every* plan — including plans with no children —
  to serve a bound that only composition needs, and it drifts two pinned
  message strings. P3a is not a limit-relaxation phase (§0).
- **chosen:** `WORKFLOW_MAX_EMBEDDED_CHILD_PLAN_BYTES = 1024 * 1024`
  (1 MiB), the **sum** of `canonicalPlanJson(childPlan)` byte lengths over all
  embedded descendants of one root freeze. `WORKFLOW_MAX_PLAN_BYTES` is
  untouched. Deliberately **half** the total plan cap, so the parent's own
  content always keeps ≥ 1 MiB and the actionable freeze-time
  `COMPOSITION_INVALID` (which names the offending child ref and the running
  total) always fires **before** the terse, unlocated decoder message a
  reviewer would otherwise have to debug.

**A-N7 — the child freeze uses a FRESH collector, then the parent ABSORBS it.**
§1.3(3) requires child source files to enter the parent's read set.
`compileResolveFreezeWorkflowV4` already accepts
`FreezeWorkflowV4Options.sourceCollector` (`freeze-v4.ts:34-36,44`), so simply
sharing the parent's collector is the obvious implementation — and it is
**wrong**. `sourceReadSet` is built from `sourceCollector.snapshot()`
(`freeze-v4.ts:76-82`), i.e. *everything captured so far*. A shared collector
would give the embedded child plan a `sourceReadSet` containing the parent's
and its earlier siblings' files, making the child plan — and therefore its
`planHash`, the target `contentHash`, the unit input hash, and P3b's
`invocation_key` — a function of its POSITION in the parent rather than of
its own source. Two identical children would embed differently.

Chosen instead: the child freezes with its **own** fresh
`GuardedExecutionSourceCollector`, so its `sourceReadSet` is exactly its own
transitive sources and its plan is a pure function of its source; the parent
then **absorbs** the child's captured sources and directory manifests via a
new `GuardedExecutionSourceCollector.absorb(other)`
(`src/execution/guarded-source.ts`, additive), so `revalidate()` — the final
pre-publication CAS run inside `publishWorkflowRunV4`'s transaction
(`runs.ts:352`, `workflow-runs-repository.ts:510`) — covers every child file.
`absorb` re-runs `#assertNoPhysicalOwnerAlias` for each absorbed record and
fails if the same resolved path was captured with a different content
identity, so the shared-physical-owner authority
(`tests/integration/workflows/shared-physical-owner-authority.test.ts`) holds
**across** the composition, not just within one workflow.

**A-N8 — the direct form binds against the child's declared `params:`.**
A `tasks/<ref>` target's binding surface is its task-source-v4 `inputs:`
contract (P2b). A **workflow** has no `inputs:`; it declares `params:`
(`source-ir/schema.ts:182,640-646` → `ir/compile.ts:160-168` →
`plan.params` / `plan.paramSchemas`). P3a reuses the ONE normalizer,
`freezeTaskInputBindings` (`src/workflows/freeze/task-bindings.ts:65`), which
is already generic over an `InputContract` and uses `targetRef` only in
messages. `contractFromPlan` (`src/workflows/ir/params.ts:50-57`, currently
module-private) is **exported** as `workflowParamContract` — additive, no
behavior change — and the child resolver feeds it the child plan's
`{params, paramSchemas}`. No second binding grammar, no second validator.

**A-N9 — persona snapshots ARE in the preimage; the exclusion note is
recorded in corrected form.** §1.2(3) asks the spec to record "persona
snapshots are NOT in the preimage". **Verified false at head.** A command
target's persona reaches `FrozenWorkflowCommandTarget.request.persona`; the
canonical request wire projects it, content and source identity included
(`src/execution/resolved-request.ts:845-848` and `projectPersona` at
`:769-773`); `request` is part of `frozenTarget`; and `frozenTarget` is a
preimage field (`step-work.ts:702`). A persona snapshot is therefore already
covered, transitively and wholesale, in both the unit and gate preimages
(the gate hashes `dispatch: gateTarget`, itself a
`FrozenWorkflowCommandTarget`). §3.3 records the **actual** exclusion list.
The operative half of the instruction stands and is binding: **P3a changes
nothing about persona handling, and a reviewer must not "fix" persona hashing
in this phase** — it is unification-spec follow-up work.

**A-N10 — `tests/integration/workflows/schema-drift.test.ts` needs NO edit.**
§1.5 names it. Verified: it pins only the authoring-time
*dispatch-significant* bounds mirrored into `schemas/akm-workflow.json`
(`WORKFLOW_MAX_GATE_LOOPS`, `WORKFLOW_MAX_CONCURRENCY`,
`WORKFLOW_MAX_RETRIES`, `WORKFLOW_MAX_TIMEOUT_MS`,
`WORKFLOW_ENGINE_NAME_PATTERN`, `WORKFLOW_MAX_ENGINE_NAME_LENGTH`) plus the
program enum/pattern vocabularies. It asserts nothing about `irVersion` or
hash prefixes. P3a's two new constants (§4.5) are **freeze-time composition
bounds**, not authoring-document bounds, so they are deliberately **not**
mirrored into `schemas/akm-workflow.json` and the drift pin stays
byte-unchanged. It is a preservation gate (§7), not a flip.

**A-N11 — three non-obvious `4` literals must move with the schema.**
Beyond the constant, head hard-codes the executable version in three places
`rg` finds only by value:

- `src/storage/repositories/workflow-runs-repository.ts:525` —
  `… SET plan_json = ?, plan_hash = ?, plan_ir_version = 4 WHERE id = ?`.
- `src/tasks/scheduler-sync.ts:119` — `readonly irVersion: 4;` on
  `SchedulerExecutableWorkflowEvidence`, and `:637` — `irVersion: 4 as const`.
  This is the *frozen plan's* version (the evidence carries
  `WorkflowPlanGraphV4["sourceReadSet"]` beside it), not a scheduler schema
  version, so it moves to `5`.
- `tests/_helpers/workflow.ts:380` — the same `plan_ir_version = 4` UPDATE in
  the shared test helper (§6, F-A7).

---

## 2. Behavior table (input → expected after P3a)

Rows are tagged **PRESERVE** (must not change; a failure is a regression) or
**NEW** (this phase's authorized change). Every NEW row needs at least one
test asserting both its code and its message text.

### 2.1 Plan version and the complete-or-abandon policy (Lane A)

| # | Input | Expected after P3a | Tag |
|---|---|---|---|
| A-01 | `akm workflow run <ref>` on any workflow | The published plan carries `irVersion: 5`; `workflow_runs.plan_ir_version = 5` | NEW |
| A-02 | A stored run with `plan_ir_version = 5` and matching hash | Decodes and executes exactly as v4 did | PRESERVE |
| A-03 | A stored run with `plan_ir_version = 4` → `akm workflow status` | Succeeds; `run.executionSupport === "unsupported-version"`, `run.planIrVersion === 4` | NEW (was: same shape, reported against "version 4 supported") |
| A-04 | …→ `akm workflow list` | Succeeds; the row appears with `executionSupport: "unsupported-version"` | NEW |
| A-05 | …→ `akm workflow abandon <id>` | Succeeds; run becomes `failed`; **step spine untouched** | PRESERVE |
| A-06 | …→ `resume` / `next` / `complete` / `run` | `UsageError`, code **`WORKFLOW_IR_VERSION_UNSUPPORTED`**, exit 2, message = §3.2's policy string | NEW (was `INVALID_JSON_ARGUMENT`) |
| A-07 | A stored run with `plan_json = NULL` | `missing-plan`; `UsageError` code `INVALID_JSON_ARGUMENT` (unchanged) | PRESERVE |
| A-08 | A stored run with `plan_ir_version = 5` and malformed/noncanonical/hash-mismatched `plan_json` | `corrupt-plan`; `UsageError` code `INVALID_JSON_ARGUMENT` (unchanged) | PRESERVE |
| A-09 | `new UsageError(m, "WORKFLOW_IR_VERSION_UNSUPPORTED").hint()` | Returns §3.2's hint string | NEW |
| A-10 | Any code path that would decode a v4 plan | Does not exist. No v4 decoder, no replay shim, no second executor | NEW |

### 2.2 `hashVersion` 6 (Lane A)

| # | Input | Expected after P3a | Tag |
|---|---|---|---|
| A-11 | `computeUnitInputHash` | Prefix `akm.workflow.unit\0v6\0`, preimage field `hashVersion: 6`; §3.3's field list, otherwise byte-identical to head | NEW |
| A-12 | The gate hash | Prefix `akm.workflow.gate\0v6\0`, `hashVersion: 6`; fields `{dispatch, invocation, prompt}` unchanged | NEW |
| A-13 | Two freezes of the same source | Byte-identical plan hash and unit input hashes (determinism preserved through the bump) | PRESERVE |
| A-14 | A changed `with:` literal or reference on a task step | Still changes the unit input hash (P2b B-41/B-42 semantics under the new prefix) | PRESERVE |
| A-15 | A changed child `planHash` (any byte of child source) | Changes the parent unit's input hash, via `frozenTarget.contentHash` and `frozenTarget.planHash` | NEW |
| A-16 | Any in-flight run frozen before the bump | Cannot execute at all (A-06), so no unit is ever re-hashed under a mixed vocabulary. No replay-compat shim exists or is needed | NEW |
| A-17 | A changed RESOLVED value of a reference binding, under an unchanged `from:` | Changes the unit input hash — a resumed run reports replay divergence instead of reusing the stale completed unit | AMENDED 2026-08-28 (R-R15) |

**A-11/A-12 amended 2026-08-28:** both prefixes and both `hashVersion` fields
now read **7**, not 6, and the unit preimage gains the conditional
`taskInputs` field A-17 exercises. A-13 – A-16 are unaffected. §3.3's amended
table is the authority; the rest of this document's `hashVersion` 6 prose is
P3a's own phase history.

### 2.3 `invocation_key` (Lane A)

| # | Input | Expected after P3a | Tag |
|---|---|---|---|
| A-17 | `computeChildInvocationKey({parentRunId, parentUnitId, unitInputHash})` | 64-hex sha256 of §3.4's exact preimage | NEW |
| A-18 | The same three inputs, twice | Byte-identical key (pure; no clock, no randomness, no IO) | NEW |
| A-19 | Any one of the three inputs changed | Different key | NEW |

### 2.4 Direct child workflows (Lane B)

| # | Input | Expected after P3a | Tag |
|---|---|---|---|
| B-01 | `classifyWorkflowStepUses("workflows/child")` | Returns `{kind: "workflow", ref: "workflows/child"}`. **No throw.** | NEW (was `nested-workflow-unsupported`) |
| B-02 | `decodeWorkflowSourceIrV1` on a step with `uses: workflows/child` | Accepts | NEW |
| B-03 | `compileGithubWorkflowSource` on the same | Accepts | NEW |
| B-04 | `akm workflow run` on a parent whose step is `uses: workflows/child` | Freezes; the step's `frozenTarget.kind === "child-workflow"` with the complete child plan embedded | NEW |
| B-05 | …parent's `sourceReadSet` | Contains the child workflow doc **and** every command/script/task the child transitively resolves, all as relative paths | NEW |
| B-06 | Child source edited after the parent run started | Parent behavior unchanged; the frozen embedded plan is authoritative | NEW |
| B-07 | Child source edited **between** parent freeze and parent publication | Publication fails on the existing read-set CAS (`revalidate()`), atomically, with no run row written | NEW |
| B-08 | `with:` on the direct step naming a declared child param | Frozen as an `inputBindings` entry (literal or reference), normalized by the ONE `freezeTaskInputBindings` | NEW |
| B-09 | `with:` naming an **undeclared** child param | `INPUT_BINDING_INVALID` at freeze, before publication, message from `freezeTaskInputBindings` | NEW |
| B-10 | `with: {from: …}` plus another key, or a `from` failing the reference grammar | Hard `INPUT_BINDING_INVALID` — never reinterpreted as a literal (P2b §1.1(2) semantics, unchanged) | PRESERVE |
| B-11 | `workflows/<ref>` that does not resolve | The existing asset-resolution failure, unchanged in code and shape | PRESERVE |

### 2.5 Task-wrapped child workflows (Lane B)

| # | Input | Expected after P3a | Tag |
|---|---|---|---|
| B-12 | A workflow step `uses: tasks/<t>` where `<t>` is a **v3** task with `uses: workflows/child` | Freezes to `kind: "child-workflow"`, `via: "task"`, `taskRef` = the task's qualified ref. **No** "cannot compose a nested workflow target." | NEW |
| B-13 | The same with a **v4** task declaring `inputs:` | Same, and the task's effective inputs (authored `with:` + declared defaults) become the child's params via `inputBindings` | NEW |
| B-14 | The v3 task's own `with:` on its workflow target | Becomes the child's params, exactly as `PreparedTaskV3Workflow.params` carries it today (`prepare/prepare.ts:124-128`) | NEW |
| B-15 | A v3 task with `env:` on a workflow target | Existing rejection, byte-unchanged ("Task v3 workflow env cannot be consumed by the durable workflow runtime in 0.9.2; …", `prepare/prepare.ts:110-115`) | PRESERVE |
| B-16 | `rg "cannot compose a nested workflow"` over `src/` | Zero hits. Zero reachable paths | NEW |
| B-17 | `akm task run <t>` on a workflow-target task (the standalone task path) | Unchanged. P3a touches only the workflow-step composition route | PRESERVE |

### 2.6 Composition bounds (Lane B)

| # | Input | Expected after P3a | Tag |
|---|---|---|---|
| B-18 | A chain 9 workflows deep (root + 8 descendants exceeds the bound) | `COMPOSITION_INVALID` at freeze, before publication; message names the depth limit and the ref path | NEW |
| B-19 | A chain exactly 8 deep | Freezes | NEW |
| B-20 | `A → A` (self-reference) | `COMPOSITION_INVALID`; message names the cycle path | NEW |
| B-21 | `A → B → A` | `COMPOSITION_INVALID`; message names `A -> B -> A` | NEW |
| B-22 | `A → tasks/w → B → tasks/v → A` | `COMPOSITION_INVALID`; the reported path includes the intermediate **task** refs for legibility, while the cycle test itself is on workflow refs | NEW |
| B-23 | The same workflow reached twice on **disjoint** branches (a diamond, not a cycle) | Freezes; each occurrence embeds its own copy. Deduplication is explicitly out of scope | NEW |
| B-24 | Aggregate embedded plan bytes over the bound | `COMPOSITION_INVALID`; message names the cap, the running total, and the child that crossed it | NEW |
| B-25 | Every bound violation | No run row, no step rows, no event. Freeze fails before `publishWorkflowRunV4` is entered | NEW |

### 2.7 Embedded-plan integrity (Lane A + B)

| # | Input | Expected after P3a | Tag |
|---|---|---|---|
| A-20 | Decoding a parent plan whose embedded child bytes were tampered with | Decode fails: recomputed `sha256(canonicalPlanJson(frozenPlan))` ≠ `planHash` | NEW |
| A-21 | Decoding a parent whose child `contentHash` was tampered with | Decode fails on the recomputed `contentHash` | NEW |
| A-22 | An embedded child plan declaring `irVersion` ≠ 5 | Decode fails | NEW |
| A-23 | An embedded child nested past the depth bound | Decode fails (the bound is re-enforced at decode, not only at freeze) | NEW |
| A-24 | An unknown `frozenTarget.kind` | The existing closed-kind failure, message shape unchanged | PRESERVE |

### 2.8 Migration 023 (Lane C)

| # | Input | Expected after P3a | Tag |
|---|---|---|---|
| C-01 | A fresh `state.db` | Carries `workflow_runs.parent_run_id`, `parent_unit_id`, `invocation_key`, `idx_workflow_runs_parent`, and the partial unique `idx_workflow_runs_invocation_key` | NEW |
| C-02 | An existing `state.db` at migration 022 | Migrates additively; every existing row reads back with the three new columns `NULL` | NEW |
| C-03 | The migration registry | `023-child-workflow-runs` is the last entry of `STATE_MIGRATIONS` **and** the last key of `STATE_MIGRATION_SAFETY_BY_ID`, classified `"additive"` | NEW |
| C-04 | Two child rows under the same parent with the same `invocation_key` | Second INSERT violates the unique index | NEW |
| C-05 | Two **top-level** rows (`parent_run_id IS NULL`) with `invocation_key IS NULL` | Both insert — the index is partial | NEW |
| C-06 | Any existing query in `workflow-runs-repository.ts` | Returns identical rows and identical column sets for pre-existing runs | PRESERVE |

### 2.9 Idempotent child publication (Lane C)

| # | Input | Expected after P3a | Tag |
|---|---|---|---|
| C-07 | `publishChildWorkflowRun(input)` on a fresh key | Inserts the child run row (embedded plan JSON + hash + `plan_ir_version = 5` + params + `parent_run_id` + `parent_unit_id` + `invocation_key`), its step rows, and one `workflow_started` event — all in ONE `immediateTransaction` | NEW |
| C-08 | The same call **twice** | Returns the SAME child run row; no second insert, no second event, no step-row duplication | NEW |
| C-09 | Two concurrent publishers, same key | One inserts; the loser reads the winner's row and returns it. **Both outcomes asserted.** Never two children, never a thrown conflict | NEW |
| C-10 | An active top-level run occupying the same `(workflow_ref, scope_key)` | Irrelevant — `publishChildWorkflowRun` never calls `findActiveRunForScope` and never raises `RESOURCE_ALREADY_EXISTS` | NEW |
| C-11 | Child source files on disk | Never read. `publishChildWorkflowRun` takes the plan it is given and performs **no** source CAS | NEW |
| C-12 | `startWorkflowRun` / `publishWorkflowRunV4` | Untouched behavior; never used for a child | PRESERVE |
| C-13 | `childRunsOf(parentRunId)` | Child rows in `created_at, id` order; `[]` for a run with none | NEW |
| C-14 | `getRunByInvocationKey(parentRunId, key)` | The child row, or `undefined` | NEW |
| C-15 | The repository TS API | Uses `spawnedByUnitId`, never `parentUnitId`, for the `workflow_runs.parent_unit_id` column | NEW |

---

## 3. Lane A — plan `irVersion` 5, `hashVersion` 6, `invocation_key`

### 3.1 Files

| File | Change |
|---|---|
| `src/workflows/ir/schema-v4.ts` | `WORKFLOW_IR_V5_VERSION = 5 as const` replaces `WORKFLOW_IR_V4_VERSION` (`:36`); `FrozenChildWorkflowTarget` added to the union (`:122`); `decodeChildWorkflowTarget` added and wired into `decodeFrozenTarget` (`:267-279`); the `irVersion must be 4` message (`:168`) becomes `irVersion must be 5`. **A-N1: file name and every exported type name unchanged.** |
| `src/workflows/ir/plan-hash.ts` | `:19,56` re-point to `WORKFLOW_IR_V5_VERSION`; `:58`'s message names version 5. The order canonical-bytes → sha256 → irVersion → structural decode is preserved exactly. |
| `src/workflows/runtime/plan-classifier.ts` | `:9,17,41,49` re-point; `:46`'s message becomes §3.2's policy string; `requireExecutableWorkflowPlan` (`:72-76`) splits the code by branch (A-N2). |
| `src/workflows/ir/freeze-v4.ts` | `:21,84` re-point; a `composition` option is threaded (§4.3). |
| `src/storage/repositories/workflow-runs-repository.ts` | `:525` `plan_ir_version = 4` → `= 5` (A-N11). |
| `src/tasks/scheduler-sync.ts` | `:119` `readonly irVersion: 4` → `5`; `:637` `irVersion: 4 as const` → `5 as const` (A-N11). |
| `src/workflows/exec/step-work.ts` | `:691,694` and `:1830,1833` bump to `hashVersion` 6 (§3.3). `:450`'s `timeoutMs` ternary gains a `target.kind === "child-workflow"` arm yielding `timeoutMs: null` (Review log R1, resolved test-review round 3, option 1: `FrozenChildWorkflowTarget` has no `.exec` field, and a child-workflow-targeted unit has no exec timeout of its own — "genuinely unbounded" is the reading the surrounding comment already documents for `timeout: none`; P3a does not dispatch child units at all, so nothing depends on this value for anything real yet). This is the ONLY authorized edit to `:450`; the ternary's `"command"` and `"shell"`/`"script"` arms are unchanged. |
| `src/workflows/exec/child-invocation.ts` | **New**, pure. `computeChildInvocationKey` (§3.4). |
| `src/core/errors.ts` | One `USAGE_HINTS` entry for `WORKFLOW_IR_VERSION_UNSUPPORTED` (§3.2). Additive — the union member already exists at `:81`. |

### 3.2 The complete-or-abandon policy

`classifyWorkflowRunPlan` keeps its four-way result and its current control
flow, including the property that a non-current `plan_ir_version` returns
**without decoding** (A-N1). Only the message and the downstream code change.

`unsupported-version` message (exact, `${runId}` and `${version}` interpolated):

```
Workflow run <id> was frozen as workflow plan irVersion <n>; pre-irVersion-5
plans cannot execute after the 0.9.2 upgrade. Complete them before upgrading,
or run 'akm workflow abandon <id>' and start a new run from the authored
workflow. 'akm workflow status' and 'akm workflow list' still work on this run.
```

`USAGE_HINTS.WORKFLOW_IR_VERSION_UNSUPPORTED` (exact):

```
Abandon the run with `akm workflow abandon <id>`, then start it again from the
workflow source — pre-0.9.2 frozen plans are not re-executable.
```

`requireExecutableWorkflowPlan` code split:

| `classified.support` | Code thrown |
|---|---|
| `"unsupported-version"` | `WORKFLOW_IR_VERSION_UNSUPPORTED` |
| `"missing-plan"` | `INVALID_JSON_ARGUMENT` (unchanged) |
| `"corrupt-plan"` | `INVALID_JSON_ARGUMENT` (unchanged) |

Surfaces that call it, and therefore fail closed for a v4 run:
`getNextWorkflowStep` (`runs.ts:449`), `resumeWorkflowRun` (`:494`),
`completeWorkflowStep` (`:700`, `:784`), and the executor
(`exec/run-workflow.ts:291`, `:1165`). Surfaces that do **not** call it, and
therefore keep working: `getWorkflowStatus` (`runs.ts:369-390`),
`listWorkflowRuns` (`:396-434`, projecting via `toWorkflowRunSummary`'s
non-throwing `classifyWorkflowRunPlan` at `:994`), and `abandonWorkflowRun`
(`:524-556`, which reads no plan at all).

**No v4 decoder, no replay layer, no second executor** exists after this
phase. `decodeWorkflowPlanV4` accepts exactly `irVersion: 5`.

### 3.3 The FULL `hashVersion` preimage table

**AMENDED 2026-08-28 (`hashVersion` 6 → 7).** P3a landed `hashVersion` 6 and
deliberately excluded `taskInputs` (old exclusion 4, struck below). The 0.9.2
close-out review confirmed that exclusion as a defect — carried advisory
§8 **R-R15** in `p4-deletions-closeout.md`, and criterion 8's "MET WITH
CAVEAT" — and the fix bumps both prefixes once more, 6 → 7, adding the
conditional `taskInputs` field. `hashVersion` 6 never shipped in a release
(every released tag on the line carries 5), so the durable step a released
install sees is 5 → 7. **This section is the authority for what ships**; the
`hashVersion` 6 statements elsewhere in this document are P3a's own phase
history and are left as written. Disposition: see the external-review entry
in `docs/plans/specs/p4-deletions-closeout.md`'s Review log.

`computeUnitInputHash` (`step-work.ts:686-708`) — prefix
`akm.workflow.unit\0v7\0`, then `canonicalJsonString` (recursive key-sort, so
literal field order in the object is irrelevant) of:

| Field | Value at head | Present |
|---|---|---|
| `hashVersion` | `7` | always |
| `role` | `"unit"` | always |
| `stepId` | `ctx.plan.stepId` | always |
| `nodeId` | `ctx.template.id` | always |
| `template` | `ctx.template.instructions` (the frozen, uninterpolated text) | always |
| `item` | the fan-out item for a map unit, else `null` | always |
| `inputs` | `ctx.resolvedInputs` — the step's declared `inputs:` artifacts | always |
| `params` | `ctx.input.params` — the run's param snapshot | always |
| `frozenTarget` | `ctx.target` — the complete frozen target. For `kind: "child-workflow"` this covers `ref`, `planHash`, `contentHash`, `via`, `taskRef?`, `inputBindings?` **and the entire embedded child plan** | always |
| `environment` | `ctx.template.environment` — binding **names** and literal values; env-ref bindings contribute names/keys, never resolved secret values | always |
| `schema` | `ctx.template.schema ?? null` | always |
| `isolation` | `ctx.template.isolation ?? "none"` | always |
| `taskInputs` | `ctx.taskInputs` — the **resolved** effective values of the frozen target's `inputBindings` (a literal value as frozen; a reference value as resolved against THIS invocation's scope) | **conditional** (R-R15) — present iff the frozen target carries at least one `inputBindings` entry. `resolveTaskInputBindings` writes exactly one key per binding, so there is no in-between case: a binding-free unit never gains the key and keeps the preimage shape it had |
| `gateFeedback` | `ctx.input.gateFeedback` | **conditional** — the key is absent when there is no feedback, so a no-feedback unit's preimage keeps the same shape it had |

The gate hash (`step-work.ts:1961-1971`) — prefix
`akm.workflow.gate\0v7\0`, then `canonicalJsonString` of exactly:

| Field | Value |
|---|---|
| `hashVersion` | `7` |
| `dispatch` | `gateTarget` — the frozen judge `FrozenWorkflowCommandTarget` |
| `invocation` | `null` |
| `prompt` | the assembled judge prompt |

The gate preimage's own field list is unchanged by the R-R15 fix; only its
version moves, because unit and gate `hashVersion` are ONE vocabulary
(§0.1) and must never disagree.

The gate preimage has **no** `role` field. Do not add one.

**DOCUMENTED EXCLUSIONS — do not "fix" any of these in P3a:**

1. `retry` and `onError`. They govern failed-unit re-dispatch and step-level
   failure reduction, not a COMPLETED unit's inputs or output, so a completed
   row stays valid across policy changes (`step-work.ts:665-671`).
2. Ambient config. Not consulted during execution; the frozen target and named
   environment bindings are the runtime identity boundary
   (`step-work.ts:684-687`).
3. **Resolved** environment values. `environment` carries NAMES only — hashing
   a resolved secret would leak it into a durable hash oracle and would
   re-dispatch every unit on every secret rotation (`step-work.ts:667-670`).
4. ~~`taskInputs` — the *resolved* values of reference-kind `inputBindings`.
   They reach the unit through the prompt and `AKM_TASK_INPUTS`
   (`step-work.ts:562-563`), not the preimage; the BINDINGS themselves are
   covered wholesale via `frozenTarget`. Pre-existing P2b behavior,
   unchanged.~~ **STRUCK 2026-08-28 — this exclusion was the defect.** The
   frozen binding expression is constant across invocations, so covering it
   "wholesale via `frozenTarget`" left a resumed unit whose referenced
   upstream output had CHANGED indistinguishable from one whose had not:
   `classifyUnitReuse` accepted the completed row and returned the stale
   output instead of reporting replay divergence. `taskInputs` is now a
   conditional preimage field (see the table above); the prompt /
   `AKM_TASK_INPUTS` delivery path it describes is unchanged.
5. **Persona snapshots are NOT excluded — see A-N9.** They are already
   covered, transitively, inside `frozenTarget.request.persona`. The
   instruction's operative half stands: **P3a changes nothing about persona
   handling and no reviewer may adjust persona hashing in this phase.** It is
   unification-spec follow-up work.

**No replay-compat concern.** A stored plan frozen before this phase carries
`irVersion` 4 and, per §3.2, can no longer execute at all — so no unit is ever
re-hashed under a mixed vocabulary and no compatibility shim is possible or
needed. This is the whole reason the two bumps ride together in one phase.

### 3.4 `computeChildInvocationKey` (new, pure)

`src/workflows/exec/child-invocation.ts`. Imports exactly `node:crypto` and
`canonicalJson` from `../ir/plan-hash`. No IO, no config, no clock, no
randomness.

```
computeChildInvocationKey({ parentRunId, parentUnitId, unitInputHash }): string
  = sha256hex(
      "akm.workflow.child-invocation\0v1\0"
      + canonicalJson({ parentRunId, parentUnitId, unitInputHash })
    )
```

- `unitInputHash` is the **current unit hash** (`hashVersion` 7 as shipped —
  §3.3's amendment) of the parent unit that spawns the child.
- `parentUnitId` is the parent run's unit id (the value stored in
  `workflow_runs.parent_unit_id` and surfaced as `spawnedByUnitId` in the TS
  API — A-N12 below).
- The `\0v1\0` here is this helper's OWN vocabulary version and is deliberately
  independent of `hashVersion`: the key's preimage does not change when the
  unit-hash vocabulary does, because the unit hash enters it as an opaque
  value.
- P3a has no production caller. P3b passes the result to
  `publishChildWorkflowRun`.

**A-N12 (naming, binding):** the SQL column is `parent_unit_id`; the TS
parameter and every repository accessor use **`spawnedByUnitId`**. The helper
input field is `parentUnitId` because it names the hash preimage, which is a
wire format, not an API. Both spellings appear exactly once each, at the
boundary between them, and §5.2's code comment says so.

### 3.5 `FrozenChildWorkflowTarget` (exact fields)

```ts
export interface FrozenChildWorkflowTarget {
  readonly kind: "child-workflow";
  /** The child workflow's fully-qualified ref, as resolved at parent freeze. */
  readonly ref: string;
  /** sha256 (hex) of canonicalPlanJson(frozenPlan). Re-verified on every parent decode. */
  readonly planHash: string;
  /** The COMPLETE frozen child plan, embedded. irVersion 5, recursively. */
  readonly frozenPlan: WorkflowPlanGraphV4;
  /** This target's own content identity (see below). */
  readonly contentHash: string;
  /** How the child was reached. */
  readonly via: "direct" | "task";
  /** Present only when via === "task": the composing task's qualified ref. */
  readonly taskRef?: string;
  /** The composing step's frozen bindings, which become the child's params. Absent, never [], when empty. */
  readonly inputBindings?: readonly TaskInputBinding[];
}
```

`contentHash` is:

```
sha256hex(
  "akm.workflow.child-workflow\0v1\0"
  + canonicalJson({
      ref,
      planHash,
      via,
      taskRef: taskRef ?? null,
      inputBindings: inputBindings ?? null,
    })
)
```

`frozenPlan` is covered transitively through `planHash`, so it is deliberately
not re-serialized into `contentHash`. `inputBindings` follows P2b's A-N7 rule
exactly: **absent, never `[]`**, when there is nothing to bind — the same rule
the other three target kinds already obey (`schema-v4.ts:100,118`).

Deliberately **not** fields: `depth` (derivable during decode recursion —
storing it invites drift and adds a redundant hash input) and `paramNames`
(already in `frozenPlan.params` / `frozenPlan.paramSchemas`).

### 3.6 `decodeChildWorkflowTarget`

Added beside `decodeCommandTarget` / `decodeShellTarget` /
`decodeScriptTarget` and dispatched from `decodeFrozenTarget`
(`schema-v4.ts:267-279`) by `target.kind === "child-workflow"`. The closed-kind
`fail(...)` fallback at `:277` is preserved verbatim (row A-24). Order of
checks, all failing through the module's existing `fail()`:

1. `assertKeys` against the exact closed key set of §3.5.
2. `frozenPlan` decodes through `decodeWorkflowPlanV4` — which enforces
   `irVersion === 5` (row A-22), the 2 MiB per-plan cap, and the full
   structural contract, **recursively**.
3. `sha256(canonicalPlanJson(decodedChildPlan)) === planHash` (row A-20).
4. Recomputed `contentHash` matches (row A-21).
5. `inputBindings`, when present, decode through the existing
   `TaskInputBinding` decoder and are non-empty.
6. The **depth** bound is re-enforced as the decoder recurses (row A-23), and
   the **aggregate embedded bytes** bound is re-enforced against the running
   total. Freeze is the actionable gate; decode is the corruption gate.

The child plan's `sourceReadSet` is decoded as-is. It is exactly the child's
own transitive sources (A-N7), which is what P3b needs to CAS a child before
dispatch — P3a stores it and does nothing else with it.

---

## 4. Lane B — the ONE recursive child-workflow resolver

### 4.1 Files

| File | Change |
|---|---|
| `src/workflows/freeze/targets/child-workflow.ts` | **New.** `childWorkflowDispatch(...)` — the single lowering for BOTH forms. Exports the depth/cycle/bytes guards it owns. |
| `src/workflows/source-ir/semantics.ts` | Delete the `target.kind === "workflow"` throw (`:155-159`). Classification returns the workflow target; freeze decides (A-N4). |
| `src/workflows/freeze/resolve-steps.ts` | `resolveStep` (`:17-35`) gains `if (target.kind === "workflow") return childWorkflowDispatch(source, baseUnit, target.ref, context)`, placed with the other `target.kind` arms. `rejectNonTaskBindingWith` (`:46-53`) is **not** extended to workflow targets — a workflow IS a binding surface (A-N8). |
| `src/workflows/freeze/targets/task.ts` | Both `"A workflow task step cannot compose a nested workflow target."` throws (`:116`, `:149`) are **replaced by routing** to `childWorkflowDispatch`. Zero reachable rejection paths remain (row B-16). |
| `src/workflows/freeze/step-values.ts` | `ResolutionContext` (`:56-61`) gains `readonly composition: ChildCompositionContext`. |
| `src/workflows/freeze/source-freeze.ts` | `resolveWorkflowSourceV4` accepts and threads the composition context into the `ResolutionContext` it builds (`:64`). |
| `src/workflows/ir/freeze-v4.ts` | `FreezeWorkflowV4Options` gains `readonly composition?: ChildCompositionContext`; the root default is `{depth: 0, refPath: [rootRef], budget: {embeddedBytes: 0}}`. |
| `src/workflows/resource-limits.ts` | Two new constants (§4.5). |
| `src/execution/guarded-source.ts` | `GuardedExecutionSourceCollector.absorb(other)` (A-N7). Additive. |
| `src/workflows/ir/params.ts` | Export `contractFromPlan` (`:50-57`) as `workflowParamContract`. Additive; no behavior change (A-N8). |

### 4.2 Both forms, one resolver

```
resolveStep
 ├─ target.kind === "workflow"  ──────────────────────────────┐
 └─ target.kind === "task" → taskDispatch                     │
        ├─ task.target.kind === "uses" && uses.kind === "workflow"  (was :116)
        └─ prepared.kind === "workflow"                        (was :149)
                                                              ▼
                                        childWorkflowDispatch(...)  ← the ONE resolver
```

`childWorkflowDispatch(source, baseUnit, childRefInput, context, via)`:

1. **Resolve + qualify** the child ref through the existing
   `resolveOwnedAsset(ref, "workflow", context)`
   (`freeze/environment.ts:60-66` — the `"workflow"` type is already
   supported). Resolution failures propagate unchanged (row B-11).
2. **Cycle check** against `context.composition.refPath` — before any IO on
   the child (§4.5).
3. **Depth check** against `context.composition.depth + 1` (§4.5).
4. **Freeze the child completely**: `loadWorkflowAsset(childRef)` then
   `compileResolveFreezeWorkflowV4(childAsset, context.config, {
   sourceCollector: <a FRESH collector>, composition: {depth: depth + 1,
   refPath: [...refPath, <intermediate task ref, when via === "task">,
   childRef], budget: <the SAME mutable budget object>} })`. Compile →
   validate → freeze, all of it, **before** the parent continues.
5. **Aggregate-bytes check**: add `utf8Bytes(canonicalPlanJson(childPlan))` to
   the shared budget and check the cap (§4.5).
6. **Absorb** the child collector into `context.collector` (A-N7), so the
   parent's pre-publication CAS covers every child file (rows B-05, B-07).
7. **Bind params**: `freezeTaskInputBindings({stepId, targetRef: childRef,
   with: <authored source>, contract: workflowParamContract(childPlan),
   earlierStepIds, declaredParamNames})` — the ONE normalizer (A-N8). The
   `<authored source>` differs by form only in where the mapping comes from:

   | `via` | Authored mapping |
   |---|---|
   | `"direct"` | the step's own `with:` |
   | `"task"`, v3 task | `PreparedTaskV3Workflow.params` (`prepare/prepare.ts:126`), i.e. the task document's `with:` |
   | `"task"`, v4 task | the task's **effective inputs** — the step's `with:` normalized against the task's `inputs:` by `taskDispatch`'s existing `freezeTaskInputBindings` call, then re-bound against the child's `params:` |

8. **Build** the `FrozenChildWorkflowTarget` of §3.5 and return it in the
   standard `ResolvedDispatch` envelope (`step-values.ts:63-69`) with an empty
   `environment` — a child run carries its own frozen environment inside its
   own plan; the parent unit's `environment` stays whatever the step itself
   declares.

### 4.3 The composition context

Declared in `src/workflows/freeze/targets/child-workflow.ts` and imported by
`step-values.ts`:

```ts
export interface ChildCompositionContext {
  /** 0 at the root workflow; +1 per child freeze. */
  readonly depth: number;
  /** Refs from the root to the current workflow, in order. Task refs appear for legibility. */
  readonly refPath: readonly string[];
  /** MUTABLE accumulator shared by the ENTIRE freeze tree. */
  readonly budget: { embeddedBytes: number };
}
```

`budget` is deliberately a shared mutable object: the aggregate bound is over
the whole tree, so every descendant must see the same running total. `depth`
and `refPath` are per-node and immutable.

### 4.4 Frozen before publication (rows B-04 … B-07)

The recursion happens inside `resolveWorkflowSourceV4`, which
`compileResolveFreezeWorkflowV4` calls at `freeze-v4.ts:46` — well before
`runs.ts:323`'s `repo.publishWorkflowRunV4`. Every child is compiled,
validated, and frozen, and every child file is absorbed into the parent
collector, before the publication transaction opens. `revalidate()`
(`workflow-runs-repository.ts:510`) then CASes the union under `IMMEDIATE`, so
a child edited during the window aborts the whole publication atomically
(row B-07) — the same guarantee
`tests/integration/workflows/v4-atomic-publication-red.test.ts` already pins
for the parent's own sources, now extended to children **without changing that
suite's semantics** (§7).

### 4.5 Composition bounds

```ts
/** Max workflow composition depth: the root plus this many descendant levels. */
export const WORKFLOW_MAX_COMPOSITION_DEPTH = 8;
/** Max AGGREGATE canonical bytes of all embedded child plans in ONE root freeze. */
export const WORKFLOW_MAX_EMBEDDED_CHILD_PLAN_BYTES = 1024 * 1024;
```

**Depth = 8.** Deep enough that no legible authored composition hits it (the
existing per-workflow bounds — 256 steps, 64 engines, 10 000 map expansion —
are the practical ceilings), shallow enough that the worst case is bounded
recursion during freeze and decode. Root is depth 0, so 8 descendant levels
freeze (row B-19) and a 9th fails (row B-18).

**Aggregate = 1 MiB.** Rationale and the rejected 4 MiB alternative: A-N6.

**Cycle.** Detected on the **workflow** entries of `refPath` (a task target
cannot itself be a task — `TaskDefinitionTarget` is `command | script |
workflow | shell`, `src/tasks/model/definition.ts:30-38` — so no task→task
chain exists to close a cycle). Intermediate task refs are carried in
`refPath` and **reported** in the message so the author can see the route
(row B-22).

All three failures are `UsageError` with code **`COMPOSITION_INVALID`**, at
freeze, before publication (row B-25). Message shapes:

```
Workflow step <stepId> cannot compose <childRef>: workflow composition is
limited to <N> levels. Path: <a -> b -> c -> …>.

Workflow step <stepId> cannot compose <childRef>: that would create a
composition cycle. Path: <a -> tasks/w -> b -> a>.

Workflow step <stepId> cannot compose <childRef>: the embedded child plans
would total <X> bytes, over the <CAP>-byte limit for one workflow run.
```

---

## 5. Lane C — migration 023 and idempotent child publication

### 5.1 Migration `023-child-workflow-runs`

Appended to `STATE_MIGRATIONS` (`src/core/state/migrations.ts`, after the
`022-workflow-unit-attempts` entry that ends at `:1054`) **and** appended as
the last key of `STATE_MIGRATION_SAFETY_BY_ID` (`:29-52`, after
`"022-workflow-unit-attempts": "additive"`) with the value `"additive"`.
`assertStateMigrationSafetyRegistry` (`:1057-1071`) checks key ORDER against
the array at module load — appending one without the other is a **startup
crash**, not a test failure.

```sql
ALTER TABLE workflow_runs ADD COLUMN parent_run_id  TEXT;
ALTER TABLE workflow_runs ADD COLUMN parent_unit_id TEXT;
ALTER TABLE workflow_runs ADD COLUMN invocation_key TEXT;
CREATE INDEX idx_workflow_runs_parent ON workflow_runs(parent_run_id);
CREATE UNIQUE INDEX idx_workflow_runs_invocation_key
  ON workflow_runs(parent_run_id, invocation_key)
  WHERE parent_run_id IS NOT NULL;
```

The migration comment MUST carry this disambiguation verbatim in substance:

> `workflow_runs.parent_unit_id` is **the parent run's unit that spawned this
> child run**. It is NOT the same concept as
> `workflow_run_units.parent_unit_id` (migration 004, `migrations.ts:934`),
> which records **map fan-out template parentage** within a single run. Same
> column name, different tables, different concepts. The TypeScript repository
> API deliberately spells this one **`spawnedByUnitId`** so the two cannot be
> confused at a call site.

`WorkflowRunRow` (`workflow-runs-repository.ts:21-46`) gains the three columns
as `parent_run_id: string | null`, `parent_unit_id: string | null`,
`invocation_key: string | null`. `SELECT *` reads them back automatically;
every existing insert leaves them `NULL` (row C-02, C-06).

### 5.2 `publishChildWorkflowRun`

Placed immediately after `publishWorkflowRunV4` (`:508-539`). Input:

```ts
export interface PublishChildWorkflowRunInput {
  readonly parentRunId: string;
  /** The parent unit that spawned this child — stored in workflow_runs.parent_unit_id (A-N12). */
  readonly spawnedByUnitId: string;
  readonly invocationKey: string;
  readonly run: InsertRunInput;
  readonly steps: InsertStepInput[];
  /** Canonical JSON of the EMBEDDED frozen child plan. Never re-derived from source. */
  readonly planJson: string;
  readonly planHash: string;
}
```

ONE `immediateTransaction`:

1. `SELECT * FROM workflow_runs WHERE parent_run_id = ? AND invocation_key = ?`.
   If a row exists, **return it** — no insert, no event, no mutation
   (rows C-08, C-09).
2. Otherwise `insertRun` extended with the three parentage columns,
   `insertSteps`, then
   `UPDATE workflow_runs SET plan_json = ?, plan_hash = ?, plan_ir_version = 5 WHERE id = ?`,
   then `insertEventOnce({eventType: "workflow_started", …, idempotencyKey: run.id})`
   — the same event shape and idempotency key `publishWorkflowRunV4` uses
   (`:531-538`).
3. Return the inserted row.

Explicitly **absent**, and each its own test (rows C-10, C-11, C-12):

- no `findActiveRunForScope` call, no `RESOURCE_ALREADY_EXISTS`, no `force`
  flag — top-level scope-conflict rules do not apply to a child;
- no `revalidateSources` callback and no filesystem access of any kind — the
  child plan was frozen and CAS'd at parent freeze;
- no change to `publishWorkflowRunV4` or `startWorkflowRun`.

`run.scopeKey` is set by the caller to the **parent's** `scope_key`, so P3b's
status tree can find children in the same scope. Because
`publishChildWorkflowRun` never consults the scope index, that copy creates no
conflict (row C-10).

### 5.3 Accessors

| Method | Contract |
|---|---|
| `childRunsOf(parentRunId: string): WorkflowRunRow[]` | `WHERE parent_run_id = ?`, ordered `created_at, id`. `[]` when none (row C-13). Uses `idx_workflow_runs_parent`. |
| `getRunByInvocationKey(parentRunId: string, key: string): WorkflowRunRow \| undefined` | The single row, or `undefined` (row C-14). Uses the partial unique index. |

Both are read-only. Neither appears in any P3a production path.

### 5.4 Crash-window and concurrency semantics (pinned NOW)

Execution is P3b's; these two properties are pinned in P3a because they are
properties of the **storage** contract, and pinning them later would mean
pinning them against a moving executor.

- **Crash between publish and parent-side recording.** Calling
  `publishChildWorkflowRun` twice with the same `(parentRunId,
  invocationKey)` returns the SAME child run id, with exactly one
  `workflow_started` event and exactly one set of step rows. The test asserts
  the second call's returned row equals the first's, and asserts event and
  step-row counts (row C-08).
- **Two concurrent publishers.** Both outcomes are asserted (row C-09): the
  winner's call returns its inserted row; the loser's call returns the
  winner's row. Neither throws, and `childRunsOf(parent)` has length 1. The
  partial unique index is what makes the loser's path deterministic — the
  test must exercise it against the real index, not a mocked repository.

### 5.5 No production caller in P3a

`publishChildWorkflowRun`, `childRunsOf`, and `getRunByInvocationKey` are
reachable in P3a **only from tests**. This is deliberate and is a gate: it is
why `akm workflow list` / `status` / `next` output is byte-unchanged in this
phase (§0), and why no CLI golden moves. A reviewer finding a production call
site to any of the three has found a phase-boundary violation.

---

## 6. AUTHORIZED-FLIPS table

Every pre-existing test whose expectations change in P3a, with the exact site
and the exact new expectation. **An edit to any pre-existing test not listed
here is a review-blocking violation.** New test files are §7, not here.

### F-A1 — `characterization-fixture-contracts.test.ts` asserts plan `irVersion` 5

`tests/workflows/characterization-fixture-contracts.test.ts:263-269`.
`expect(plan.irVersion).toBe(4)` → `.toBe(5)`; the test NAME ("freezes to
irVersion 4 …") → "freezes to irVersion 5 …"; the P0 comment at `:263-264`
(which already names P3a as the flip point) is updated to record that the flip
happened. `expectedStepTargetKinds` and the manifest are **untouched** — the
`plan-v4` fixture family keeps its directory NAME and its contents; those
fixtures are workflow SOURCES, not plan bytes (`manifest.planV4.description`
says so). The sibling tests at `:272-292` (target-kind set; task-composed read
set) stay byte-unchanged.

### F-A2 — `frozen-plan.test.ts` version pins

`tests/integration/workflows/frozen-plan.test.ts`:

- `:88-89` — `expect(plan.irVersion).toBe(4)` → `.toBe(5)`; the guard
  `if (plan.irVersion !== 4) throw new Error("fresh starts must persist v4")`
  → `!== 5` / `"fresh starts must persist plan irVersion 5"`.
- `:256-283` ("non-current workflow IR is unsupported on every live plan
  surface") — the fixture stays `plan_ir_version = 2`; `executionSupport`
  assertions stay `"unsupported-version"`; the five `expectCorrupt` code
  assertions change from `INVALID_JSON_ARGUMENT` to
  `WORKFLOW_IR_VERSION_UNSUPPORTED` (A-N2). The final
  `abandonWorkflowRun(...).run.status === "failed"` assertion is **unchanged**
  and is the row A-05 gate.
- `:286-306` ("malformed and unsupported plans can be abandoned without
  touching their spine") — the case `{ name: "malformed-future", version: 4 }`
  becomes `{ name: "malformed-current", version: 5 }`, so the table keeps
  exercising the *current-version + malformed JSON* branch; `version: 4` is now
  covered by the same unsupported-version branch as `2` and `3`. Every
  assertion in the loop is unchanged.
- `:201` (`plan_ir_version = NULL`) and `:308-345` (bad hash / spine
  mismatch) are **byte-unchanged** — rows A-07 and A-08.

### F-A3 — `v4-atomic-publication-red.test.ts` publication-version pins

`tests/integration/workflows/v4-atomic-publication-red.test.ts`. Three value
changes only; **every semantic assertion is preserved** (§7 gate):

- `:97` — `irVersion: 4` in the `v4Plan()` fixture → `5`.
- `:289` and `:380` — `expect(row?.plan_ir_version).toBe(4)` → `.toBe(5)`.
- `:345` — the abort trigger's `NEW.plan_ir_version = 4` → `= 5`, so the WP7
  fault still fires on the plan-attachment UPDATE it is written to intercept.

The file's atomicity, rollback, and no-partial-spine assertions are untouched.
Its subject remains the **parent** publication path (§7).

### F-A4 — the scheduler's frozen-plan evidence version

`tests/integration/tasks-scheduler-durable-v4-red.test.ts`:

- `:17` — the local `irVersion: 4` type annotation → `5`.
- `:116` — `expect(item.irVersion).toBe(4)` → `.toBe(5)`.
- `:203` — `expect(row?.plan_ir_version).toBe(4)` → `.toBe(5)`.
- `:150-155` — the `["nested workflow", …, /nested workflow|unsupported/i]`
  rejection row is **removed** from the `test.each` table; a
  `uses: workflows/child` step no longer fails scheduler preparation. Its
  replacement is a positive assertion in the new §7 suite, not here.

`tests/integration/tasks-scheduler-evidence-v4-remediation-red.test.ts:23` —
the same local `irVersion: 4` annotation → `5`.

### F-A5 — `tasks-scheduler-sync-v3.test.ts` nested-workflow row

`tests/integration/tasks-scheduler-sync-v3.test.ts:395-397`. The
`["nested workflow", "workflows/child", /nested workflow|unsupported/i]` row is
**removed** from the `test.each` table; the `["remote action", …]` row stays.
This is the one file P2a §7 pinned as "byte-unchanged"; P3a explicitly
supersedes that pin for this row only, and the Review log must record it.

### F-A6 — `task-binding-identity.test.ts` hash-vocabulary pin

`tests/workflows/task-binding-identity.test.ts` — P2b's B-44, which exists
precisely to make this bump visible:

- `:21-22` and `:154` — the doc comment and test name move from
  `WORKFLOW_IR_V4_VERSION` / `akm.workflow.unit\0v5\0` / `hashVersion` 5 to
  `WORKFLOW_IR_V5_VERSION` / `akm.workflow.unit\0v6\0` / `hashVersion` 6, and
  drop the "P2b bumps neither" clause in favour of "P3a bumps both".
- `:58` — the import of `WORKFLOW_IR_V4_VERSION` → `WORKFLOW_IR_V5_VERSION`.
- `:155` — `expect(WORKFLOW_IR_V4_VERSION).toBe(4)` →
  `expect(WORKFLOW_IR_V5_VERSION).toBe(5)`.
- `:174` — `hashVersion: 5` → `6`.
- `:188` — `.update("akm.workflow.unit\0v5\0")` → `\0v6\0`.

Everything else in the file — B-01 (`inputBindings` absent, never `[]`) and
B-43 (two freezes are byte-identical) — is **byte-unchanged** and is a
preservation gate.

### F-A7 — `tests/_helpers/workflow.ts`

- `:31` and `:130` — `WORKFLOW_IR_V4_VERSION` → `WORKFLOW_IR_V5_VERSION`.
- `:380` — `… SET plan_json = ?, plan_hash = ?, plan_ir_version = 4 WHERE id = ?`
  → `= 5`.

A shared helper, not a test: its flip is mechanical and touches no assertion.

### F-A8 — `ir-compile.test.ts` import identifier

`tests/workflows/ir-compile.test.ts:11` —
`WORKFLOW_IR_V4_VERSION as WORKFLOW_IR_VERSION` →
`WORKFLOW_IR_V5_VERSION as WORKFLOW_IR_VERSION`. The local alias and every
assertion in the file (including `:136`'s
`expect(result.plan).not.toHaveProperty("irVersion")`) are unchanged.

### F-A9 — `immutable-execution-v4-red.test.ts` fixture version

`tests/workflows/immutable-execution-v4-red.test.ts:102` — the `commandPlan()`
fixture builder's `irVersion: 4` → `5`. **Mechanical value change only; no
assertion in the file changes.** This suite pins the single common frozen
target shape (`command`/`shell`/`script`, executable identity, cwd identity,
worktree `gitCommitOid`) via hand-built plans fed straight to
`decodeWorkflowPlanV4` at `:140, :154, :158, :162, :167, :171, :175, :199,
:227, :262, :298` (several `.not.toThrow()`), and was never in §6 because it
was written before plan `irVersion` 5 existed as a concept. Discovered by
review (round 2): once `WORKFLOW_IR_V5_VERSION` lands, `decodeWorkflowPlanV4`
rejects every one of this file's `irVersion: 4` fixtures with "irVersion must
be 5" — before ever reaching the executable/cwd/git-OID checks these tests
exist to pin — which would silently break this **entire** file with no
`§6` authorization for Implement (or a subsequent lane) to fix it. Landed
directly in the test range (this fix), so the file is red **today**, for
exactly that on-topic reason (`decodeWorkflowPlanV4` throws "irVersion must
be 4" against a fixture that now says 5), and returns to green — with zero
further edits — the moment Implement's version bump lands. `commandPlan()`'s
return value is untyped (inferred, fed to `decodeWorkflowPlanV4(input:
unknown, …)`), so this flip carries no type-level consequence and needs no
`@ts-expect-error` pin.

### F-A10 — `environment-v4-red.test.ts` fixture version

`tests/workflows/environment-v4-red.test.ts:134` — the `v4ShellPlan()`
fixture builder's `irVersion: 4` → `5`. **Mechanical value change only; no
assertion in the file changes.** Same shape as F-A9: three tests in the
`"durable workflow v4 environment schema"` describe (`:181, :206, :214`) feed
this fixture straight to `decodeWorkflowPlanV4`; the `"freezeWorkflowEnvironment"`
and `"materializeFrozenWorkflowEnvironment"` describes never call
`decodeWorkflowPlanV4` and are untouched by this flip. Discovered and landed
alongside F-A9 for the identical reason: unauthorized before this round,
silently green today on the stale literal, would have gone red with no `§6`
cover the moment `WORKFLOW_IR_V5_VERSION` lands. No type-level consequence
(same untyped-return-value shape as `commandPlan()`), no `@ts-expect-error`
pin needed.

### F-A11 — `workflow-param-flags.test.ts` fixture version (type-only)

`tests/workflows/workflow-param-flags.test.ts:12` — the `parameterPlan()`
fixture's `irVersion: 4` → `5`, behind a directly-preceding
`// @ts-expect-error P3a red-phase: WORKFLOW_IR_V5_VERSION lands in Implement`
pin. **Mechanical value change only; no assertion in the file changes; no
runtime behavior changes.** Unlike F-A9/F-A10, `parameterPlan()` is explicitly
typed `WorkflowPlanGraphV4` (aliased `WorkflowPlanGraph`), so the object
literal is checked against `irVersion`'s field type under full contextual
typing — no widening. Discovered by review (round 2): once Implement narrows
`WorkflowPlanGraphV4["irVersion"]` from `typeof WORKFLOW_IR_V4_VERSION` (4) to
`typeof WORKFLOW_IR_V5_VERSION` (5), `irVersion: 4` here becomes a plain
`tsc` error ("Type '4' is not assignable to type '5'") with no `§6`
authorization for Implement to fix it — a `bunx tsc --noEmit` failure Implement
cannot resolve without an unauthorized pre-existing-test edit. Landed directly
in the test range (this fix), pinned red-phase exactly like
`frozen-plan.test.ts:88,90`'s `WORKFLOW_IR_V5_VERSION` pins (§0's convention):
`irVersion: 5` does not type-check today (the field is still literal `4`), so
the pin keeps `tsc` green now, and Implement's own type narrowing makes the
pin's line valid — at which point the unused-`@ts-expect-error` check forces
Implement to delete it, same as every other red-phase pin in this phase.
`materializeWorkflowParameterFlags` / `contractFromPlan`
(`src/workflows/ir/params.ts:50-57`) read only `params`/`paramSchemas` off the
plan and never inspect `irVersion` at runtime, so — confirmed by running the
file — all four tests pass unchanged both before and after this flip; it is
purely a forward-compatibility fix for Implement's type narrowing, not a
behavior pin.

### F-A12 — `ir-compile.test.ts` version-value assertion (discovered by Implement; see Review log R3)

`tests/workflows/ir-compile.test.ts:133` — `expect(WORKFLOW_IR_VERSION).toBe(4);` →
`.toBe(5);`. **Mechanical value change only.** F-A8 authorized the import
alias rename (`WORKFLOW_IR_V4_VERSION as WORKFLOW_IR_VERSION` →
`WORKFLOW_IR_V5_VERSION as WORKFLOW_IR_VERSION`) and stated "every assertion
in the file... are unchanged", citing `:136`'s
`not.toHaveProperty("irVersion")` as its example — but did not separately
account for `:133`'s own direct value comparison against the aliased
constant, in the `"keeps executable versioning out of the unresolved draft"`
test. Once `WORKFLOW_IR_VERSION` narrows to literal `5` (A-N1), `.toBe(4)`
is both a `bunx tsc --noEmit` type error (`Argument of type '4' is not
assignable to parameter of type '5'`) and, if merely type-suppressed, a
false runtime assertion (`WORKFLOW_IR_VERSION` really is `5` at runtime).
See Review log R3.

### F-A13 — current-version pins in three unrelated-subject integration suites (discovered by Implement; see Review log R4)

Three sites across three files, all the identical mechanical pattern — a
fresh `startWorkflowRun` followed immediately by
`expect(started.run.planIrVersion).toBe(4);` as a sanity pin before the
file's real (version-unrelated) subject matter proceeds. Each becomes
`.toBe(5);`. **Mechanical value change only; no other edit to any of the
three files.**

- `tests/integration/workflow-crash-windows.test.ts:108,152` (both sites,
  identical text).
- `tests/integration/workflow-db-contention.test.ts:76,141` (both sites,
  identical text).
- `tests/integration/workflow-lease-crossproc.test.ts:87`.

§7 lists all three files as preservation gates ("byte-unchanged" for the
first; the other two are not separately named in §7 but carry no `§6` flip
either — same gap). That instruction and A-01 ("a fresh run persists
`plan_ir_version = 5`") are jointly unsatisfiable once `WORKFLOW_IR_V5_VERSION`
is current: every one of these call sites asserts the fresh run's OWN
just-started `planIrVersion` against the hardcoded literal `4`, so leaving
any of them untouched fails outright (a direct assertion mismatch, not a
decode/policy failure), and none of the three files' actual subject matter
(SIGKILL crash-window recovery, cross-process DB contention, cross-process
lease arbitration) has anything to do with plan versioning — there is no
reading under which `4` remains correct. See Review log R4.

### F-B1 — `characterization-classification.test.ts` R-03, both sites

`tests/workflows/characterization-classification.test.ts`:

- `:176-187` — R-03 site 1 (comment `:176-179`, test `:180-187`). The test
  `"R-03 (site 1/3, semantics.ts:141-146): a direct 'uses: workflows/x' step
  throws nested-workflow-unsupported"` flips to assert successful
  classification: `classifyWorkflowStepUses("workflows/child")` returns
  `{kind: "workflow", ref: "workflows/child"}` and throws nothing. Rename the
  test to record the flip and update the P0 comment at `:176-179` (which
  already says "Flips in P3 (child workflows)").
- `:201-259` — R-03 sites 2/3, the `describe` block
  `"R-03 (sites 2/3, source-freeze-v4.ts:211-239) — a task-composed
  nested-workflow target"`. Its single test (`:217-258`) flips from asserting
  `UsageError` / `INVALID_FLAG_VALUE` / `"A workflow task step cannot compose
  a nested workflow target."` to asserting that
  `startWorkflowRun("workflows/nested-composition")` **succeeds** and that the
  step's frozen target is `{kind: "child-workflow", via: "task"}` with the
  child plan embedded. The long trailing comment at `:238-257` (explaining why
  the third site was unreachable) is replaced by a note that both sites now
  route to `childWorkflowDispatch`. The fixture files are unchanged.
- `:189-196` — R-04(c) (GitHub-action locator) is **byte-unchanged**; it flips
  in P4, not here.

### F-B2 — `source-ir-contract.test.ts`, two sites

`tests/workflows/source-ir-contract.test.ts`:

- `:447` — the `["workflows/child", "nested-workflow-unsupported"]` row moves
  **out of** the rejection table (`:442-455`) and **into** the acceptance loop's
  list (`:430-437`) as `"workflows/child"`. The enclosing test name at `:429`
  ("accepts workflow-step task definitions and rejects nested workflows and
  remote actions") drops "nested workflows".
- `:1088-1090` — the `nested` case in the `decodeWorkflowSourceIrV1` battery
  flips from `expect(() => …).toThrow(/nested workflow/i)` to asserting the
  decode **succeeds**. The neighbouring `remote`, `escapedCwd`, `controlCwd`,
  and `builtin` cases are byte-unchanged (A-N4: one deleted throw, three call
  chains).

### F-B3 — `target-ref.test.ts` parity table

`tests/execution/target-ref.test.ts`:

- `:179` — the `["workflows/child", "nested-workflow-unsupported"]` row is
  removed from the rejection table (`const rejected` at `:174`).
- `:149-156` — `"workflows/child"` is added to the accepted table (`const
  accepted` at `:149`, entries `:150-155`) as
  `["workflows/child", "workflow"]`, matching `TargetRefKind`
  (`src/execution/target-ref.ts:33`). The accepted loop's per-property
  assertions need no change.
- `:120-141` (the `classifyTargetRef` rejection battery, which never listed
  `workflows/`) is **byte-unchanged**.

### F-B4 — `task-input-bindings.test.ts` B-30 block

`tests/workflows/task-input-bindings.test.ts:762-827` — the `describe`
`"P2b freeze-time — a workflow-target task step is STILL rejected, now
reachable via version: 4 too (B-30)"`. Both tests flip:

- `:797-808` ("without an authored `with:`") — flips from `UsageError` /
  `INVALID_FLAG_VALUE` / `"A workflow task step cannot compose a nested
  workflow target."` + `expectNoRunRowWritten()` to asserting a **successful**
  freeze whose frozen target is `{kind: "child-workflow", via: "task",
  taskRef: <tasks/nested-v4>}`.
- `:810-826` ("WITH an authored `with:` that validly binds the target's
  declared input") — flips the same way, and additionally asserts the bound
  input reaches the child as an `inputBindings` entry.

The `describe` name and its long P2b comment (`:763-780`) are rewritten to
record the P3a flip. Every other block in the file — the
`INPUT_BINDING_INVALID` matrix, the normalize/merge rules, and the B-41/B-42
hash-coverage block — is **byte-unchanged**.

### F-B5 — `immutable-resolution-v4-red.test.ts` rejection row AND the
task-composed standalone test (amended — code-review round 1, Review log R5)

`tests/integration/workflows/immutable-resolution-v4-red.test.ts`. TWO edits,
both authorized:

- `:307-311` — the `["nested-workflow", workflowYaml("… uses:
  workflows/child"), /nested workflow|unsupported/i]` row is **removed** from
  the `test.each` rejection table. The `remote-action`, `multi-job`,
  `nonprojectable-agent`, and `secret-literal` rows are byte-unchanged.
- The standalone test `"rejects a task-composed workflow target as forbidden
  nested orchestration before mutation"` (formerly directly below the
  `test.each` block) is **removed**, not flipped to a positive assertion. Its
  fixture (`writeTask("delegate", ["uses: workflows/child"])` composed into
  `workflows/task-nested`) never wrote a real `workflows/child` asset — under
  the pre-P3a rejection, the throw fired at classification/prepare time,
  before the target would ever need to resolve, so the fixture never needed
  one. Once the task-composed route succeeds instead of rejecting (row B-12),
  that same fixture would fail freeze on ordinary asset resolution ("workflow
  not found"), not on anything this test exists to pin — flipping it to a
  positive assertion is not a mechanical value change, it is authoring a new
  test with new fixture content. See Review log R5 for why the no-mutation
  property this test used to guard is left un-duplicated here.

### F-B6 — `USAGE_HINTS` pin

`tests/core/errors-usage-hints.test.ts` — **byte-unchanged.** Verified: its
`NEW_CODE_HINTS` table (`:46-58`) covers only P1a's five codes, and its regression guard
(`:83-87`) pins `INVALID_FLAG_VALUE` only. Adding a
`WORKFLOW_IR_VERSION_UNSUPPORTED` hint is purely additive; its assertion lives
in the new §7 suite. Listed here so a reviewer does not have to re-derive that
it is untouched.

### F-B7 — `task-fixture-vocabulary.test.ts` allowlist widening (added —
code-review round 1, Review log R6)

`tests/architecture/task-fixture-vocabulary.test.ts` — `ALLOWED_EXACT_FILES`
gains two entries: `tests/workflows/child-workflow-freeze.test.ts` and
`tests/integration/workflows/child-freeze-read-set.test.ts`. Both files
author a `version: 3` task whose own `uses:` targets a workflow, specifically
to prove the task-wrapped child-workflow composition path works from a v3
task (rows B-12/B-14, and B-22's task-mediated composition-cycle fixture) —
the same `PreparedTaskV3Workflow.params` code path the pre-existing
`task-binding-identity.test.ts` allowlist entry already documents as
"unaffected by [the v4 deferral]" and "the more faithful fixture" for a
v3-specific claim. Converting either fixture to task source v4 would test the
DIFFERENT v4 declared-`inputs:` binding path instead — already covered by
F-B4's flip in `task-input-bindings.test.ts` — silently dropping
v3-task-wrapped-workflow coverage entirely. See Review log R6.

### F-C1 — `workflow-runs-repository.characterization.test.ts` row shape
(added — code-review round 1, Review log R7)

`tests/integration/storage/workflow-runs-repository.characterization.test.ts:104-111`
— the one pre-existing full-row `WorkflowRunRow` fixture asserted via
`toEqual` against a `SELECT *` result gains three fields migration 023 adds
as nullable columns: `parent_run_id: null`, `parent_unit_id: null`,
`invocation_key: null`, each on a top-level (non-child) run row. This is a
mechanical, assertion-preserving addition — the ROW SHAPE change is forced by
migration 023 landing (§5.1), not a behavior change this test exists to pin;
every other field and every other assertion in the file is unchanged. This
file MOVES OUT of the "Explicitly NOT flipped" table below: its prior "do not
edit" entry was scoped to `:104`'s `plan_ir_version: null` (a
missing-plan-fixture claim that genuinely stays version-agnostic and
unchanged), not to the row's overall field set staying frozen against a
future additive migration. See Review log R7.

### Explicitly NOT flipped (verified, do not edit)

| File | Why |
|---|---|
| `tests/workflows/with-rejection.test.ts` | Contains no nested-workflow row at all (A-N5). |
| `tests/integration/workflows/schema-drift.test.ts` | Pins authoring bounds only; nothing about `irVersion` or hash prefixes (A-N10). |
| `tests/workflows/characterization-with-drop.test.ts` | P1a's drop characterization; no version or nested-workflow pin. |
| `tests/fixtures/execution-contracts/workflows/plan-v4/**` and `manifest.json` | Sources, not plan bytes. The family keeps its name (§1.5). |

---

## 7. Preservation gates (the reviewer runs these)

- [x] `bun run check` green. Verified fresh at `f35d433d`: lint exit 0
      (`lint-doc-examples: OK`), `bunx tsc --noEmit` clean, `test:unit` 4284
      pass / 0 skip / 0 fail (313 files), `test:integration` 5760 pass / 57
      skip / 0 fail (432 files).
- [x] `tests/integration/workflows/frozen-plan.test.ts` green, changed **only**
      at F-A2's four sites.
- [x] `tests/integration/workflows/chaos.test.ts` and
      `tests/integration/_helpers/workflow-chaos-runner.ts` green and
      **byte-unchanged**. Verified: `git diff 7a491ff6 --stat` for both is
      empty.
- [x] `tests/integration/workflows/run-lease.test.ts` green and
      **byte-unchanged**. Verified: `git diff 7a491ff6 --stat` is empty.
- [ ] `tests/integration/workflow-crash-windows.test.ts` green and
      **byte-unchanged**. Green, but **not** byte-unchanged: R4 (above)
      records that this pin is superseded for exactly its two F-A13 sites
      (`:108,152`, a fresh run's own `planIrVersion` pin forced from `4` to
      `5` by A-01) — `git diff 7a491ff6 --stat` shows only those two value
      changes. Left unticked on the letter of "byte-unchanged"; the
      substantive gate (green, minimal, spec-authorized diff) holds per R4.
- [x] `tests/integration/workflows/v4-atomic-publication-red.test.ts` green
      with **only** F-A3's three value changes; every atomicity/rollback
      assertion byte-unchanged. Its subject stays the **parent** publication
      path — `publishChildWorkflowRun` gets its own suite, it does not join
      this one. Verified: `git diff 7a491ff6` shows exactly the four F-A3
      literal-value edits (irVersion, two `plan_ir_version` assertions, the
      WP7 trigger predicate) and nothing else.
- [x] `tests/integration/tasks-runtime-v3-runner.test.ts` (the
      fail-before-mutation canary) green and **byte-unchanged**. Verified:
      `git diff 7a491ff6 --stat` is empty.
- [x] Every P2b binding suite green: `tests/workflows/task-input-bindings.test.ts`
      (changed only at F-B4), `tests/workflows/task-binding-identity.test.ts`
      (changed only at F-A6), `tests/workflows/with-rejection.test.ts`
      (**byte-unchanged**), `tests/integration/workflows/task-binding-resolution.test.ts`
      and `tests/integration/workflows/task-inputs-delivery.test.ts`
      (**byte-unchanged**). Verified: `task-input-bindings.test.ts`'s diff is
      confined to the two `describe` blocks F-B4 names;
      `task-binding-identity.test.ts`'s diff matches F-A6's five sites
      exactly; the other three files' diffs against `7a491ff6` are empty.
- [x] `tests/integration/workflows/schema-drift.test.ts` green and
      **byte-unchanged** (A-N10). Verified: `git diff 7a491ff6 --stat` is
      empty.
- [x] The migration position/safety registry test green (`023-child-workflow-runs`
      last in both `STATE_MIGRATIONS` and `STATE_MIGRATION_SAFETY_BY_ID`).
      Verified structurally: `023-child-workflow-runs` is the final array
      element of `STATE_MIGRATIONS` (`migrations.ts:1085-1092`) and the
      final key of `STATE_MIGRATION_SAFETY_BY_ID` (`:52`); covering tests
      `tests/integration/state-migration-023.test.ts` and
      `tests/storage/state-db-migrations.test.ts` both green.
- [x] `tests/integration/workflows/shared-physical-owner-authority.test.ts`
      green and **byte-unchanged** — `absorb` must not weaken the aliasing
      authority (A-N7). Verified: `git diff 7a491ff6 --stat` is empty.
- [x] `tests/architecture/import-cycle-ratchet.test.ts` green:
      `src/execution/**` still imports nothing from `src/workflows/**`
      (`child-invocation.ts` lives under `src/workflows/`; `guarded-source.ts`
      gains no workflow import).
- [x] `rg "cannot compose a nested workflow" src/` returns **zero** hits
      (row B-16). Verified fresh.
- [x] `rg "WORKFLOW_IR_V4_VERSION" src/ tests/ scripts/` returns **zero** hits.
      Verified fresh.
- [x] `rg 'akm\.workflow\.(unit|gate)\\0v5\\0' src/ tests/` returns **zero**
      hits. Verified fresh.
- [x] `bun run lint` includes the doc-examples check; every `akm …` example
      added in §8 is lint-doc-examples-clean. Verified fresh
      (`lint-doc-examples: OK — 0 doc-example violations found`); this
      close-out's own doc edits (R12, three sites) add no new `akm …`
      example lines.

New suites this phase adds (these are NOT flips):

| File | Covers |
|---|---|
| `tests/workflows/child-workflow-freeze.test.ts` | Rows B-01…B-17 |
| `tests/workflows/child-workflow-limits.test.ts` | Rows B-18…B-25 |
| `tests/workflows/plan-v5-schema.test.ts` | Rows A-01, A-02, A-20…A-24 |
| `tests/workflows/child-invocation-key.test.ts` | Rows A-17…A-19 |
| `tests/integration/workflows/plan-version-policy.test.ts` | Rows A-03…A-10, A-16 |
| `tests/integration/storage/child-workflow-publication.test.ts` | Rows C-01…C-15 |

---

## 8. Docs that ride with the code

| File | Contents |
|---|---|
| `docs/reference/workflow-schema.md` | Child workflows: the **direct** form (`uses: workflows/<ref>` with `with:` binding the child's declared `params:`) and the **task-wrapped** form (`uses: tasks/<ref>` whose task targets a workflow); the three composition limits with their values and the exact `COMPOSITION_INVALID` messages; **frozen-before-publication** semantics — the child is compiled, validated, and frozen into the parent plan before the parent run exists, and editing child source afterwards cannot affect the frozen parent. |
| `docs/reference/workflows.md` | Author-facing walkthrough of both forms and how child params are supplied; a pointer to the limits; an explicit note that child **execution** surfaces (status tree, outputs) arrive in a later 0.9.2 increment. |
| `docs/architecture/workflow-engine.md` | Plan `irVersion` 5; the `child-workflow` frozen target and its embedded child plan; the decode-time integrity chain (canonical bytes → plan sha256 → `irVersion` → recursive child `planHash` + `contentHash`); `hashVersion` 6 and §3.3's preimage table including the documented exclusions; why the two bumps ride together (no replay-compat surface, §3.3). |
| `CHANGELOG.md` `[Unreleased]` | Under **Breaking changes & migration**: (1) pre-`irVersion`-5 stored plans no longer execute — `akm workflow status` / `list` / `abandon` still work, but `resume` / `run` / `next` / `complete` fail with `WORKFLOW_IR_VERSION_UNSUPPORTED`; complete in-flight runs before upgrading, or abandon them and restart from source. (2) Under a feature heading: child workflows arrive — both forms, the limits, and the frozen-before-publication guarantee. |
| `docs/migration/v0.9.1-to-v0.9.2.md` | A pre-upgrade checklist step: run `akm workflow list --active` **before** upgrading and finish or abandon what is in flight; the exact post-upgrade error text and the two-command recovery (`akm workflow abandon <id>` then `akm workflow run <ref>`); a note that no data is lost — the run row, its spine, and its evidence remain readable. |

Every `akm` example must pass the doc-examples lint that `bun run lint` runs.

---

## 9. Acceptance criteria

**Structure**

- [x] `src/workflows/ir/schema-v4.ts` exports `WORKFLOW_IR_V5_VERSION = 5` and
      no `WORKFLOW_IR_V4_VERSION`; its file name and every exported TYPE name
      are unchanged (A-N1). Verified: `rg WORKFLOW_IR_V4_VERSION` is empty;
      the file is still named `schema-v4.ts`.
- [x] `FrozenChildWorkflowTarget` has exactly §3.5's key set, and
      `inputBindings` is absent — never `[]` — when empty. Verified at the
      construction site (`child-workflow.ts`):
      `...(inputBindings.length > 0 ? { inputBindings } : {})`.
- [x] `decodeFrozenTarget` accepts exactly four kinds and keeps its closed-kind
      `fail(...)` fallback verbatim. Verified: `command`, `shell`, `script`,
      `child-workflow`, then `fail(\`unit ${unit.id} frozenTarget has
      unsupported kind ${String(target.kind)}\`)`.
- [x] `src/workflows/freeze/targets/child-workflow.ts` is the **only** module
      that lowers a child workflow; `resolve-steps.ts` and `targets/task.ts`
      call into it and contain no child-lowering logic of their own.
      Verified: both import and call `childWorkflowDispatch`.
- [x] `src/workflows/exec/child-invocation.ts` is pure: it imports only
      `node:crypto` and `canonicalJson`, and performs no IO. Verified by
      reading the file in full: exactly those two imports, no other IO.
- [x] `src/execution/**` still imports nothing from `src/workflows/**`.
      Verified via `tests/architecture/import-cycle-ratchet.test.ts`, green.
- [x] `WORKFLOW_MAX_COMPOSITION_DEPTH` and
      `WORKFLOW_MAX_EMBEDDED_CHILD_PLAN_BYTES` live in
      `src/workflows/resource-limits.ts`; `WORKFLOW_MAX_PLAN_BYTES` is
      **unchanged** at `2 * 1024 * 1024` (A-N6). Verified: both constants
      import from `resource-limits.ts` in `child-workflow.ts`;
      `WORKFLOW_MAX_PLAN_BYTES = 2 * 1024 * 1024` at `resource-limits.ts:7`.
- [x] `023-child-workflow-runs` is the last entry of `STATE_MIGRATIONS` **and**
      the last key of `STATE_MIGRATION_SAFETY_BY_ID`, classified `"additive"`,
      and its comment carries §5.1's `parent_unit_id` disambiguation.
      Verified by reading `migrations.ts:1057-1092` and `:52` in full.
- [x] `publishChildWorkflowRun`, `childRunsOf`, and `getRunByInvocationKey`
      have **no** production caller in P3a (§5.5). Verified: `rg` across
      `src/` finds no call site outside `workflow-runs-repository.ts` itself
      (two unrelated doc-comment prose mentions only).

**Behavior**

- [x] Every PRESERVE row of §2 holds, verified by its cited test. `bun run
      check` green end to end (4284/4284 unit, 5760 pass/57 skip/0 fail
      integration).
- [x] Every NEW row of §2 has at least one test asserting its code **and** its
      message text. Covered by the six new suites below (§7's "New suites"
      table) plus the flipped assertions in §6 — B-18…B-25 specifically live
      in `tests/workflows/child-workflow-freeze.test.ts` (6
      `COMPOSITION_INVALID` sites) rather than a separately-named
      `child-workflow-limits.test.ts`, an organizational difference from
      that table's forward-looking file list, not a coverage gap.
- [x] A fresh run persists `plan_ir_version = 5` and a plan whose
      `irVersion` is 5 (A-01). Verified directly in
      `v4-atomic-publication-red.test.ts`'s "workflow v4 start publication"
      test.
- [x] A stored `plan_ir_version = 4` run: `status`, `list`, and `abandon`
      succeed; `resume`, `next`, `complete`, and `run` fail with
      `WORKFLOW_IR_VERSION_UNSUPPORTED` and §3.2's message (A-03…A-06).
      Covered by `frozen-plan.test.ts` (F-A2) and
      `plan-v4-retirement.test.ts`.
- [x] `missing-plan` and `corrupt-plan` still fail with
      `INVALID_JSON_ARGUMENT` (A-07, A-08). Byte-unchanged sites in
      `frozen-plan.test.ts` (§6, F-A2).
- [x] Both hash prefixes and both `hashVersion` fields read 6, and the unit
      preimage's field list is exactly §3.3's (A-11, A-12). Covered by
      `hash-v6.test.ts`.
- [x] Freezing the same source twice is byte-identical at plan hash and unit
      hash (A-13); a changed binding still changes the unit hash (A-14); a
      changed child plan changes the parent unit hash (A-15). A-13/A-14
      preserved via `task-binding-identity.test.ts`'s B-43 (byte-unchanged);
      A-15 covered by `hash-v6.test.ts`, unblocked by R1's resolution.
- [x] `computeChildInvocationKey` is deterministic and sensitive to each of its
      three inputs (A-17…A-19). Covered by `child-invocation-key.test.ts`.
- [x] A direct `uses: workflows/<ref>` step classifies, decodes, compiles, and
      freezes to a `child-workflow` target (B-01…B-04). Covered by
      `child-workflow-freeze.test.ts` and `characterization-classification.test.ts`
      (F-B1).
- [x] A task-wrapped workflow target freezes to a `child-workflow` target with
      `via: "task"` from BOTH a v3 and a v4 task (B-12, B-13). Covered by
      `child-workflow-freeze.test.ts` (v3, per F-B7's allowlist rationale)
      and `task-input-bindings.test.ts` (v4, F-B4).
- [x] `rg "cannot compose a nested workflow" src/` is empty (B-16). Verified
      fresh.
- [x] The parent's `sourceReadSet` covers every transitive child source file,
      all relative (B-05), and a child edited before publication aborts the
      whole publication with no run row (B-07). Covered by
      `child-freeze-read-set.test.ts`.
- [x] Depth, cycle, and aggregate-bytes violations each fail at freeze with
      `COMPOSITION_INVALID`, naming the path or the cap, with no run row, no
      step rows, and no event (B-18…B-25). Covered by
      `child-workflow-freeze.test.ts` (6 `COMPOSITION_INVALID` assertions).
- [x] A tampered embedded child plan, a tampered child `contentHash`, an
      embedded child with the wrong `irVersion`, and an over-depth embedded
      child each fail **decode** (A-20…A-23). Covered by
      `plan-v5-schema.test.ts`.
- [x] `publishChildWorkflowRun` is idempotent on `(parent_run_id,
      invocation_key)`, races safely with a concurrent publisher (both outcomes
      asserted), applies no scope-conflict rule, and reads no source
      (C-07…C-11). Covered by `child-run-publication.test.ts`, including its
      dedicated `describe("publishChildWorkflowRun — two concurrent
      publishers (C-09)")` block against the real partial unique index — see
      also R10's caveat on the guarantee's scope when nested.
- [x] The repository TS API says `spawnedByUnitId`, never `parentUnitId`
      (C-15, A-N12). Verified: `parentUnitId` appears in this file only on
      `ReserveUnitAttemptV4Input` — the unrelated, pre-existing
      `workflow_run_units` map fan-out concept; every child-run accessor and
      `PublishChildWorkflowRunInput` field uses `spawnedByUnitId`.

**Gates**

- [ ] Every §7 checkbox ticked. 15 of 16 are; the one exception
      (`workflow-crash-windows.test.ts`'s literal byte-unchanged claim) is
      left unticked with its reason inline, per R4.
- [x] Every §8 doc updated in the same commit range, examples lint-clean.
      Landed in `1f06b22c`; this close-out's own R12 edits further correct
      three of those same doc sites within the same phase's commit range.
      `lint-doc-examples: OK` fresh.
- [x] No pre-existing test outside §6 was edited. Verified by auditing every
      file in `git diff 7a491ff6 --stat -- tests/` (31 files): each
      pre-existing file among them is named in §6 (F-A1…F-C1); every
      remaining file is new, not a flip.

---

## Review log

### R1 — `step-work.ts:450`'s timeoutMs ternary does not admit `kind: "child-workflow"` (RESOLVED — test-review round 3, option 1 authorized)

**Status: RESOLVED**, test-review round 3. Option 1 below is authorized:
§3.1's `step-work.ts` file-table row now includes the `:450` ternary
extension alongside the two `hashVersion` 6 prefix bumps, landing as ONE
edit in Lane A's single implement commit (§0.2 commit ladder, #3). The
discovery narrative and the originally-rejected alternatives are kept below,
verbatim in substance, as the record of why; only the outcome changed.

Discovered by test review (round 2), against
`tests/workflows/hash-v6.test.ts`. `computeStepWorkList`'s per-unit
resolution (`step-work.ts`, building `StepWorkUnitContext`) computes:

```ts
const timeoutMs = target.kind === "command" ? (target.runner.timeoutMs ?? null) : target.exec.timeoutMs;
```

This assumes every non-`"command"` frozen target carries an `.exec` spec —
true for `kind: "shell"` and `kind: "script"` today, but
`FrozenChildWorkflowTarget` (§3.5) has no `.exec` field. The moment a
`child-workflow`-targeted unit reaches this line — which happens for EVERY
unit whose step composes a child workflow, since `computeStepWorkList` runs
unconditionally ahead of dispatch — it throws a bare `TypeError: undefined is
not an object (evaluating 'target.exec.timeoutMs')`, before
`computeUnitInputHash` is ever reached.

At round 2, §3.1's file table row for `step-work.ts` authorized exactly two
edits: the `hashVersion` 6 prefix bumps at `:691,:694` (unit hash) and
`:1830,:1833` (gate hash). It did **not** authorize touching `:450`. Per
§0's rule ("Editing a pre-existing test that §6 does not name is a
review-blocking violation") and the binding instruction "if preserving a
behavior and implementing an authorized change appear to conflict, stop and
record it — preserving wins until the Review log says otherwise", the
`:450` edit was **not** made as part of that review-fix round, even though
`tests/workflows/hash-v6.test.ts`'s own header comment (written by the
original Lane A test-writing commit, `de45e7c3`) argues at length that it
belongs in the same commit as the hash bump. Round 2 judged that argument
"may well be right… but 'may well be right' is not the same as
'spec-authorized'", and left the `:450` edit for a review round whose
mandate covers expanding Lane A's authorized src edit surface — this is
that round.

**Resolution (test-review round 3):** Option 1 from round 2's own list is
chosen over the other two:

1. **Chosen.** Extend the `:450` ternary to admit `kind: "child-workflow"`,
   yielding `timeoutMs: null` — a child-workflow-targeted unit has no single
   exec timeout of its own, so `null` ("genuinely unbounded") is the reading
   the surrounding comment already documents for `timeout: none`; P3a does
   not dispatch child units at all, so no engine-side backstop needs this
   value for anything real yet. §3.1's file table (above) now authorizes
   exactly this one added arm; the ternary's `"command"` and
   `"shell"`/`"script"` arms are unchanged, and this is the ONLY authorized
   edit to `:450`.
2. Rejected: leaving §3.1 unamended and hoping "the fix rides in some other
   commit whose own authorization already covers it" (e.g. P3b's executor
   work) would ship P3a with `tests/workflows/hash-v6.test.ts`'s A-15 — "the
   single strongest guard that the hashVersion 6 preimage actually covers
   the embedded child plan" — permanently red for the whole phase,
   contradicting §0.2 ("Commit 3 must be green on its own"). This is exactly
   the defect test-review round 3 raised against shipping R1 unresolved, so
   it is rejected rather than deferred again.

**Consequence:** `tests/workflows/hash-v6.test.ts`'s A-15 test ("a changed
embedded child planHash changes the unit's input hash") goes green in Lane
A's single implement commit (§0.2 commit ladder, #3) — the SAME commit that
lands the `hashVersion` 6 bump, since A-15 needs both changes together and
neither alone makes it pass. A-11 (the general preimage-shape/prefix claim)
never depended on this — see the test-review-fix round 2 rewrite of that
file's fixtures, which moved the A-11 tests onto an ordinary,
already-handled `shell` target for exactly this reason — and test-review
round 3 additionally split A-17…A-19 (`computeChildInvocationKey`) out into
their own file, `tests/workflows/child-invocation-key.test.ts`, so
`hash-v6.test.ts` no longer imports the not-yet-existing
`child-invocation.ts` module at all: A-11's and A-12's RED signal today is
the intended `hashVersion` 6 mismatch, not an unrelated module-load
failure.

### R2 — three pre-existing suites hard-coded `irVersion: 4` outside §6 (RESOLVED — F-A9/F-A10/F-A11)

**Status: RESOLVED**, this review round. §6 amended with F-A9, F-A10, F-A11
(above); the three files' fixtures are flipped in the same commit as this
entry.

Discovered by test review (round 2): three suites written before plan
`irVersion` 5 existed as a concept hard-code `irVersion: 4` in hand-built
plan fixtures, and none of them were named in §6 at the time:

- `tests/workflows/immutable-execution-v4-red.test.ts:102` —
  `commandPlan()`, fed to `decodeWorkflowPlanV4` at eleven call sites,
  several under `.not.toThrow()`.
- `tests/workflows/environment-v4-red.test.ts:134` — `v4ShellPlan()`, fed to
  `decodeWorkflowPlanV4` at three call sites.
- `tests/workflows/workflow-param-flags.test.ts:12` — `parameterPlan()`,
  explicitly typed `WorkflowPlanGraphV4`, so this one is a **type-level**
  problem rather than a runtime one.

Left un-flipped, all three would have gone from silently green today (the
stale `4` literal matches today's still-current version) to broken the
moment Implement's Lane A commit lands — the two `-red.test.ts` files via a
`decodeWorkflowPlanV4` "irVersion must be 5" throw pre-empting every
assertion in each file, `workflow-param-flags.test.ts` via a plain `tsc`
error once `WorkflowPlanGraphV4["irVersion"]` narrows to literal `5`. Per
§0's rule, Implement is not permitted to fix a pre-existing test §6 does not
name, so all three would have left Lane A's implement commit blocked with no
review-authorized path forward.

Resolution: §6 gained F-A9 (`immutable-execution-v4-red.test.ts`), F-A10
(`environment-v4-red.test.ts`), and F-A11 (`workflow-param-flags.test.ts`),
each a mechanical `irVersion: 4` → `5` value change with **no assertion
change**. F-A9/F-A10 needed no `@ts-expect-error` pin (both fixture builders
return an untyped/inferred value fed to `decodeWorkflowPlanV4(input:
unknown, …)`, so the literal carries no type-level consequence); F-A11
needed one, following the exact convention `tests/integration/workflows/frozen-plan.test.ts:88,90`
already established for a `WORKFLOW_IR_V5_VERSION`-shaped red-phase pin.
Verified (this round): with the flips landed, `bunx tsc --noEmit` is clean;
`immutable-execution-v4-red.test.ts` goes from 6/6 passing to 0/6 passing,
every failure reading `"irVersion must be 4"` (on-topic, resolves the moment
Implement's version bump lands, no residual edit needed); the three
version-gated tests in `environment-v4-red.test.ts` go the same way (the
file's other seven tests, which never call `decodeWorkflowPlanV4`, are
unaffected); `workflow-param-flags.test.ts` stays 4/4 passing throughout,
because `materializeWorkflowParameterFlags`/`contractFromPlan`
(`src/workflows/ir/params.ts:50-57`) never read `irVersion` at runtime — its
flip is purely forward-compatible with Implement's type narrowing.

### R3 — `ir-compile.test.ts:133`'s version-value assertion was outside F-A8's authorization (RESOLVED — F-A12)

**Status: RESOLVED**, this round. §6 amended with F-A12 (above); the one-line
fixture flip lands in the same Lane A implement commit as the rest of this
phase's schema change, per the same rationale R2 already established for
`immutable-execution-v4-red.test.ts`, `environment-v4-red.test.ts`, and
`workflow-param-flags.test.ts`.

Discovered by Implement while landing `WORKFLOW_IR_V5_VERSION`: F-A8 (§6)
authorizes exactly one mechanical edit to
`tests/workflows/ir-compile.test.ts` — the import alias at `:11`
(`WORKFLOW_IR_V4_VERSION as WORKFLOW_IR_VERSION` →
`WORKFLOW_IR_V5_VERSION as WORKFLOW_IR_VERSION`) — and states "every
assertion in the file... are unchanged", citing `:136`'s
`expect(result.plan).not.toHaveProperty("irVersion")` as the representative
unchanged assertion. It does not separately name `:133`'s
`expect(WORKFLOW_IR_VERSION).toBe(4);` (in the `"keeps executable versioning
out of the unresolved draft"` test), which directly compares the aliased
constant's VALUE, not merely its presence. Once `WORKFLOW_IR_VERSION` narrows
from `typeof WORKFLOW_IR_V4_VERSION` (literal `4`) to
`typeof WORKFLOW_IR_V5_VERSION` (literal `5`), `.toBe(4)` fails
`bunx tsc --noEmit` ("Argument of type '4' is not assignable to parameter of
type '5'") — the same class of gap R2 already found and fixed three times
over (F-A9/F-A10/F-A11), here on the one call site F-A8's own rationale did
not enumerate. Left unfixed, this single line would have blocked Implement's
commit from being `tsc`-green with no `§6`-authorized path forward, for
exactly the reason R2's entry already documents in general.

Resolution: §6 gained F-A12 (above), a single mechanical `.toBe(4)` →
`.toBe(5)` value change with no other edit to the file — `:11`'s alias and
`:136`'s structural assertion (and every other assertion) are untouched.
Verified: with the flip landed, `bunx tsc --noEmit` is clean for this file,
and the fixed assertion is a genuine (not merely type-suppressed) runtime
check — `WORKFLOW_IR_VERSION` really does equal `5` once Implement lands, so
`.toBe(5)` is the correct value, not a suppression.

### R4 — current-version pins in `workflow-crash-windows.test.ts`, `workflow-db-contention.test.ts`, `workflow-lease-crossproc.test.ts` were unnamed AND `§7` implies byte-unchanged (RESOLVED — F-A13)

**Status: RESOLVED**, this round. §6 amended with F-A13 (above); §7's
"byte-unchanged" instruction for `workflow-crash-windows.test.ts` is
superseded for exactly its two mechanical sites (recorded here so a
reviewer does not have to re-derive why the file is no longer byte-identical
to head).

Discovered by Implement while landing `WORKFLOW_IR_V5_VERSION`, first via a
full `bun run test:unit` / `bun run test:integration` sweep run specifically
to catch this class of gap after `v4-atomic-publication-red.test.ts` (F-A3)
and the two scheduler suites (F-A4) turned out to need the identical
mechanical fix beyond what §6 enumerated at the time: three files —
`tests/integration/workflow-crash-windows.test.ts:108,152`,
`tests/integration/workflow-db-contention.test.ts:76,141`, and
`tests/integration/workflow-lease-crossproc.test.ts:87` — each assert
`expect(started.run.planIrVersion).toBe(4);` immediately after a fresh
`startWorkflowRun`, a direct pin on "the CURRENT executable version" that no
other flip already covers. Only the first is separately named in §7 (under
"green and **byte-unchanged**"); the other two carry no `§7` mention and no
`§6` flip either — the identical gap, just less visible because §7 never
claimed byte-unchanged for them in the first place. This is the same family
R2 and R3 already found (a hardcoded current-version literal in a
pre-existing suite the flip-authorization pass did not enumerate): §0.2's
commit ladder states A-01 ("a fresh run persists `plan_ir_version = 5`") as
the FIRST authorized behavior of Lane A's implement commit, and each of
these three files' own fresh `startWorkflowRun` call is a direct instance of
that behavior — leaving any literal at `4` fails its test outright (an
assertion mismatch on the run's own just-frozen version, not a domain
regression), for a reason wholly unrelated to any of the three files' actual
subject matter (SIGKILL crash-window recovery, cross-process DB contention,
cross-process lease arbitration), so there is no reading under which
preserving the literal is the intended behavior.

Resolution: §6 gained F-A13 (above), three identical mechanical `.toBe(4)`
→ `.toBe(5)` value changes across the three files, no other edit to any of
them. Verified: with the flips landed, all affected tests pass end-to-end
with their real mechanics still exercised (real SIGKILL + resume + re-dispatch
for crash-windows; real concurrent readers/writers for db-contention; real
cross-process lease arbitration + reclaim for lease-crossproc) — the fix is
on the version pin only in every case. A full `bun run test:unit` / `bun run
test:integration` pass after this round shows every remaining failure
belongs to Lane B (the `nested-workflow-unsupported` throw's callers, still
present pending `src/workflows/freeze/targets/child-workflow.ts`, plus its
own `tests/architecture/task-fixture-vocabulary.test.ts` fixture-allowlist
gap) or Lane C (migration `023-child-workflow-runs` and
`publishChildWorkflowRun`, not yet implemented) — none in Lane A's own
files or the files this phase's `§6` table names.

### R5 — `immutable-resolution-v4-red.test.ts`'s standalone task-composed test was DELETED, not flipped, and F-B5 did not say so (RESOLVED — code-review round 1, F-B5 amended)

**Status: RESOLVED**, code-review round 1. §6's F-B5 entry is amended
(above) to name both edits Lane B's implement commit (`4a23b181`) actually
made to this file, and this entry records the deletion's rationale and where
the property it used to guard is covered now.

Found by code review after Lane B landed: F-B5, as originally written,
authorized exactly one edit to
`tests/integration/workflows/immutable-resolution-v4-red.test.ts` — removing
the `["nested-workflow", …]` row from the `test.each` rejection table (row
B-16's "zero reachable rejection paths" claim, and the direct-form mirror of
F-A4/F-A5's `test.each`-row removals). The commit that landed Lane B also
deleted a second, standalone test in the same file — `"rejects a
task-composed workflow target as forbidden nested orchestration before
mutation"` (8 lines) — pinning the identical now-superseded rejection for the
TASK-WRAPPED form, with its own `mutationCounts()` no-mutation assertion.
That second deletion was never named in F-B5 or anywhere else in §6: an
unlisted edit to a pre-existing test, exactly the violation §0 calls
review-blocking. (The commit's own message narrates the discovery candidly —
"a standalone test asserting the identical now-false premise … that §6 did
not separately name" — but the narration lived only in the commit message,
never promoted into this spec document, which is the actual authorization
surface §0 and §6 require.)

Two remediations were available: restore the test as a flipped positive
assertion (freeze succeeds; re-assert the `mutationCounts()`/
`establishStateBaseline()` invariant that still holds for a NON-rejected
freeze's tables unrelated to the run itself), or amend F-B5 and record the
deletion here. Restoring it mechanically is not possible: the deleted test's
fixture — `writeTask("delegate", ["uses: workflows/child"])` composed into
`workflows/task-nested` — never wrote a real `workflows/child.yml` asset,
because under the pre-P3a rejection the throw fired at classification/
prepare time, before resolution would ever need one to exist. Now that the
task-composed route succeeds (row B-12), freezing that exact fixture would
fail on ordinary asset resolution ("workflow not found") instead of
exercising anything this test was written to pin. Making it pass would mean
authoring new fixture content (a real child workflow doc), which is not a
"flip" under §0's discipline — it is a new test, and the identical scenario
is already covered, more completely, by tests this same commit and F-B4
landed: `tests/workflows/characterization-classification.test.ts`'s F-B1
sites-2/3 test (`startWorkflowRun("workflows/nested-composition")` succeeds;
frozen target is `{kind: "child-workflow", via: "task", taskRef: …}`),
`tests/workflows/child-workflow-freeze.test.ts` rows B-12–B-17 (the dedicated
new suite, both v3 and v4 task-wrapped forms), and
`tests/workflows/task-input-bindings.test.ts`'s F-B4 block (task-wrapped
composition with an authored `with:`, asserting the bound `inputBindings`
entry reaches the child).

The specific NO-MUTATION property the deleted test pinned — reject before
touching the run/journal/usage/event tables — has no successful-freeze
analog (a successful freeze is SUPPOSED to write a run row); its true
successor is the ALL-OR-NOTHING atomicity property for a composing freeze,
which is covered by `tests/integration/workflows/v4-atomic-publication-red.test.ts`
(F-A3, extended per §4.4 to cover children, parent publication path
unchanged) and, specifically for a composing step,
`tests/integration/workflows/child-freeze-read-set.test.ts`'s row B-07 tests
("editing child source between parent freeze and parent publication fails
publication atomically … writes NO run row") — the direct-form composition
route, but through the SAME `childWorkflowDispatch`/`absorb`/`revalidate()`
machinery §4.2's "ONE recursive resolver" design routes the task-wrapped form
through too, so the guarantee is not form-specific.

Resolution: F-B5 (§6, above) now names both edits and their rationale
directly; this entry is the fuller record. No further code or test change
needed — the deletion stands, now authorized.

### R6 — `task-fixture-vocabulary.test.ts`'s `ALLOWED_EXACT_FILES` widening was never authorized in `§6`, though R4 named the gap (RESOLVED — code-review round 1, F-B7 added)

**Status: RESOLVED**, code-review round 1. §6 gained F-B7 (above).

R4 (this log, above) closed out three files' current-version pins and, in
its closing paragraph, named a second, separate gap in passing: "[the
remaining Lane B failures belong to] its own
`tests/architecture/task-fixture-vocabulary.test.ts` fixture-allowlist gap"
— but R4 itself only resolved the three current-version-pin files; it never
opened a dedicated entry for the fixture-allowlist gap, and no `§6` flip
entry for it was ever written, either at that time or when Lane B actually
landed the widening.

The widening itself: Lane B's implement commit (`4a23b181`) added two
entries to `ALLOWED_EXACT_FILES` — `tests/workflows/child-workflow-freeze.test.ts`
and `tests/integration/workflows/child-freeze-read-set.test.ts` — each
carrying a substantial in-file comment (mirroring this same file's
pre-existing "Lane D sweep" / `task-binding-identity.test.ts` escape-valve
entries) explaining that both files author a load-bearing `version: 3` task
whose own `uses:` targets a workflow, to prove the task-wrapped
child-workflow path from a v3 task specifically (rows B-12/B-14/B-22) — a
DIFFERENT code path (`PreparedTaskV3Workflow.params`) than a v4 task's
declared-`inputs:` binding (already covered by F-B4), so converting either
fixture to v4 would silently drop v3-task-wrapped-workflow coverage rather
than being a neutral rewrite. That reasoning is sound and, on inspection,
identical in kind to the pre-existing allowlist entries this same ratchet
file already carries for the same reason — but per §0's rule, a widening of
an architecture ratchet's own allowlist is exactly the kind of change that
needs `§6` authorization to not be review-blocking, the same as any other
pre-existing test file edit, and none was written.

Resolution: §6 gained F-B7 (above), authorizing the two allowlist additions
verbatim per the reasoning already recorded in-file. No code or test change
needed — the widening stands, now authorized, and the gap R4 named is
closed.

### R7 — `workflow-runs-repository.characterization.test.ts` is on `§6`'s "Explicitly NOT flipped" table, yet Lane C edited it, with no `§6` entry (RESOLVED — code-review round 1, F-C1 added)

**Status: RESOLVED**, code-review round 1. §6 gained F-C1 (above); the file
is moved out of the "Explicitly NOT flipped" table.

Found by code review: `tests/integration/storage/workflow-runs-repository.characterization.test.ts`
was listed in §6's "Explicitly NOT flipped (verified, do not edit)" table,
scoped to the claim that its `:104` `plan_ir_version: null` fixture is a
missing-plan case and version-agnostic — true, and still true. But Lane C's
implement commit (`1adee4ef`) edited the SAME file's full-row `WorkflowRunRow`
fixture a few lines later (the `toEqual` assertion covering a complete
`SELECT *` row), adding three fields — `parent_run_id: null`,
`parent_unit_id: null`, `invocation_key: null` — that migration 023 (§5.1)
makes real, nullable columns on `workflow_runs`. Once those columns exist, a
`SELECT *`-shaped `toEqual` fixture that omits them no longer matches the
real row shape and the test fails outright, with no assertion about run
BEHAVIOR at stake — the identical class of forced, mechanical fixture-sync
edit F-A7 already authorizes for `tests/_helpers/workflow.ts`. The commit
message says as much ("the same class of unavoidable fixture-sync fix
already established by this plan's Review log (R2-R4)") but, like the Lane B
commit R5/R6 above cover, never promoted that reasoning into `§6` itself, and
left the file sitting in the "do not edit" table it had just edited.

Resolution: §6 gained F-C1 (above), authorizing the three-field addition and
narrowing the "Explicitly NOT flipped" table's prior claim to what it always
actually meant (`:104` specifically, not the file's every fixture against
every future additive migration); the table row for this file is removed.
No code or test change needed — the edit stands, now authorized.

### R8 — `step-work.ts:454` and `native-executor.ts:1001` asserted a false "P3a never dispatches a child-workflow unit" premise; nothing failed closed when one actually reached dispatch (RESOLVED — code-review round 1)

**Status: RESOLVED**, code-review round 1.

Found by code review: `computeStepWorkList` (`step-work.ts`) builds an
ordinary work unit for ANY step, regardless of frozen target kind — nothing
in Lane B's freeze-time work makes a `child-workflow`-targeted step's unit
any different from a `command`/`shell`/`script` one once the plan is
frozen and the run starts. R1 (above) already established that
`computeStepWorkList` reaches the `:450` ternary unconditionally for such a
unit; what R1 did not examine is what happens AFTER that ternary, when the
same unit reaches actual dispatch. It reached
`src/workflows/exec/unit-dispatch.ts`'s `dispatchWorkflowExecution` (via
`native-executor.ts`'s `defaultUnitDispatcher`, which handles `"script"`/
`"shell"` explicitly and falls through everything else — `"command"` AND, as
of Lane B, `"child-workflow"` — into it) and hit the generic `kind !==
"command"` guard, throwing `ConfigError("unit … is not a command target.",
"INVALID_CONFIG_FILE")`. That message is FALSE (a `child-workflow` target is
a legitimate, freeze-validated target kind, not a malformed one) and
unhelpful (it does not say child execution is simply not implemented yet).
The two comments this finding names — `step-work.ts:454`'s "a child-workflow
target carries no exec spec of its own (§3.5); P3a never dispatches it" and
`native-executor.ts:1001`'s "P3a dispatches no child-workflow unit at all, so
this arm is unreached in practice" — both asserted, as settled fact, exactly
the premise this finding falsifies: nothing before dispatch stops a
`child-workflow`-targeted unit from reaching it, because P3a's own Lane B
work makes freezing (and therefore running) such a step succeed. Shipped
docs repeated the same false claim: `docs/reference/workflow-schema.md`'s
"What is not yet available" section and `docs/reference/workflows.md`'s
child-workflow paragraph both asserted composing a child is inert to the
parent step ("nothing dispatches … the parent step is unaffected"), when in
fact the parent step itself is the one that fails.

This also means R1's own authorization rationale for the `:450` ternary —
"P3a does not dispatch child units at all, so no engine-side backstop needs
this value for anything real yet" — rested on a premise this finding shows
is false in its strong form (dispatch IS reached); R1's CODE resolution
stays correct and necessary regardless (the ternary must still avoid
crashing on `target.exec.timeoutMs` for a target with no `.exec` field,
independent of whether dispatch later succeeds or fails), but its narrative
premise needed the same correction applied here.

Resolution: `src/workflows/exec/unit-dispatch.ts`'s `dispatchWorkflowExecution`
gains a dedicated guard for `frozenTarget.kind === "child-workflow"`, ahead
of the generic `!== "command"` check, throwing `UsageError` under a new code,
`WORKFLOW_CHILD_EXECUTION_UNSUPPORTED` (`src/core/errors.ts`, additive to the
`UsageErrorCode` union, plus a `USAGE_HINTS` entry) — option (b) from the
finding's two alternatives, chosen over option (a) (rejecting a
`child-workflow` target AT FREEZE) because option (a) would nullify Lane B's
entire authorized behavior surface (rows B-01…B-25, and every test §6's F-B1
through F-B5/F-B7 already authorize), not merely correct a mislabeled error.
The two false comments are corrected in place (no behavior change, comment
text only). `docs/reference/workflow-schema.md`'s "What is not yet
available" section and `docs/reference/workflows.md`'s child-workflow
paragraph are corrected to say what actually happens: freeze and embedding
still succeed; dispatching the composing step's own unit is what fails, with
`WORKFLOW_CHILD_EXECUTION_UNSUPPORTED`, naming the child ref; every other
step in the same run is unaffected. `docs/architecture/workflow-engine.md`
and the `CHANGELOG.md` `[Unreleased]` entry get the same one-sentence
correction for consistency. Pinned by a new suite,
`tests/workflows/child-workflow-dispatch-guard.test.ts` (both
`dispatchWorkflowExecution` directly and `defaultUnitDispatcher`, the
production seam, plus a negative control on an ordinary target kind) — a new
file, not an edit to any pre-existing test, so it needs no `§6` entry.
`bunx tsc --noEmit` clean; the new suite passes; every pre-existing suite
this round's `bun run check` sweep touches is unaffected (no pre-existing
test asserted the prior `ConfigError`/"is not a command target" message —
`rg "is not a command target" src/ tests/` had exactly one hit, the throw
site itself, before this fix).

### Close-out — review-round summary and gate status

**Test-review** (ran against the red test suites before Lane A/B/C
implementation landed):

| Round | Verdict | Confirmed | Commit |
|---|---|---|---|
| 1 | CHANGES_REQUIRED | 2 | `15fa41d0` |
| 2 | CHANGES_REQUIRED | 2 | `850fbc5a` |
| 3 | CHANGES_REQUIRED | 3 | `08a91854` |

(auto-adjudicated). Fully reconciled against the commits themselves: round
1's two findings (a fixture-tamper fix on the then-not-yet-written
`plan-v4-retirement.test.ts`, and landing F-A2 early) needed no Review-log
entry — neither is a pre-existing-test edit outside §6. Round 2's two
findings are R1 (opened here, "OPEN" — the `step-work.ts:450` ternary gap)
and R2 (F-A9/F-A10/F-A11). Round 3's three findings are R1 (resolved, option
1 chosen), a `tests/workflows/hash-v6.test.ts` / `child-invocation-key.test.ts`
file-split fix folded into R1's own "Consequence" paragraph rather than
broken out separately (it is test-infrastructure, not a §6 matter), and a
determinism fix to `tests/integration/storage/child-run-publication.test.ts`'s
C-09 concurrent-publisher test — the last of these needed no entry either,
since that file did not exist before P3a and fixing a not-yet-landed new
test is Implement's own purview, not a pre-existing-test edit. R3 and R4
(F-A12, F-A13) were discovered directly by Implement during the same
pre-implementation hardening window, outside this numbered sequence, and are
recorded above regardless, per §0's rule that any pre-existing-test edit
outside §6 needs a Review-log entry no matter who discovers it or when.
Net: zero outstanding test-review gaps.

**Code-review** (ran against the landed implementation, after `1f06b22c`
closed P3a's own commit ladder):

| Round | Verdict | Confirmed | Commit |
|---|---|---|---|
| 1 | CHANGES_REQUIRED | 4 | `e6a5aee0` |
| 2 | CHANGES_REQUIRED | 4 | `6ec07482` |
| 3 | CHANGES_REQUIRED | 1 | *(this close-out)* |

(auto-adjudicated). Round 1's four findings are R5–R8 above. Round 2's four
findings — `targets/task.ts`'s `bindingsToWithRecord()` round-tripping an
already-classified v4 task binding through the `with:` grammar (fixed by
`rebindTaskInputBindings` / the `AuthoredChildInputs` union, the direct
ancestor of R9 below), `decodeChildWorkflowTarget` re-enforcing only the
depth bound at decode and not the aggregate-embedded-bytes bound, stale
RED-phase test narration across five files, and two false claims in
`workflow-schema.md`'s Child workflows section (authorability in Markdown
source; a `{from: "params.<name>"}` reference form) — are fixed and verified
in commit `6ec07482`'s own message (`bunx tsc --noEmit` clean;
`bun run test:unit` 4284/4284; `bun run test:integration` 5760 pass / 57
skip). Unlike round 1, round 2's findings were never promoted into this
Review log; that gap is noted here for the record, and this close-out does
not re-litigate already-fixed, already-verified findings by reproducing
their detail a second time — doing so is outside what this close-out was
asked to do. Round 3's one confirmed finding is R9 below, the v3-task
sibling of round 2's `bindingsToWithRecord()` fix. Three further findings
(R10–R12 below) surfaced in an independent final verification pass ahead of
close-out and are recorded the same way.

**Gate status** (verified fresh against HEAD at `f35d433d`, before this
close-out's own edits, none of which touch source behavior):

- `bun run check` (lint + `bunx tsc --noEmit` + `bun run test:unit` +
  `bun run test:integration`): green end to end — `bun run test:unit`
  4284 pass / 0 skip / 0 fail across 313 files; `bun run test:integration`
  5760 pass / 57 skip / 0 fail across 432 files; `lint-doc-examples: OK — 0
  doc-example violations`; no `tsc` errors.
- `rg "cannot compose a nested workflow" src/`,
  `rg "WORKFLOW_IR_V4_VERSION" src/ tests/ scripts/`, and
  `rg 'akm\.workflow\.(unit|gate)\0v5\0' src/ tests/`: all return **zero**
  hits.
- `023-child-workflow-runs` is the last entry of both `STATE_MIGRATIONS`
  (`migrations.ts:1084`) and `STATE_MIGRATION_SAFETY_BY_ID` (`:52`),
  classified `"additive"`, and its comment (`:1057-1083`) carries §5.1's
  `parent_unit_id` disambiguation verbatim, including the `spawnedByUnitId`
  naming rule.
- `publishChildWorkflowRun` / `childRunsOf` / `getRunByInvocationKey`: `rg`
  across `src/` finds no call site outside `workflow-runs-repository.ts`
  itself (two doc-comment prose mentions only) — no production caller
  (§5.5).
- Every test file touched since the P2b baseline (`7a491ff6`, 31 files, via
  `git diff --stat`) is accounted for: each pre-existing file among them is
  named in §6's flip table (F-A1…F-C1); every remaining file is new, not a
  flip. No pre-existing test outside §6 was edited.
- §7 and §9 below are ticked accordingly. One exception:
  `tests/integration/workflow-crash-windows.test.ts`'s literal
  **byte-unchanged** claim is superseded by R4 for its two F-A13 sites, so
  that box is left unticked with its reason inline rather than ticked on a
  claim that is no longer exactly true.

### R9 — a v3 task's authored `with:` gains reference semantics only when composed into a child workflow; standalone `akm task run` treats the identical value as a literal (RECORDED — decision point handed to P3b/P4)

**Status: RECORDED**, not fixed. The divergence is produced by routing this
spec's own §4.2 step 7 table specifies, not by an implementation bug, so
fixing it would mean changing authorized behavior — out of scope for a
close-out review under §0's rules of engagement ("A defect discovered that
is not in §6 is recorded in the Review log and left unfixed"). Handed to
P3b/P4 as a decision point instead.

Found in the task-wrapped composition path,
`src/workflows/freeze/targets/task.ts:180`. The `AuthoredChildInputs` union
(`src/workflows/freeze/targets/child-workflow.ts:73-75`) carries two shapes:
`{kind: "bindings"}` for a v4 task with a declared `inputs:` contract — round
2 (`6ec07482`) fixed exactly this arm, adding `rebindTaskInputBindings` so an
already-classified binding is re-bound against the child's `params:` without
re-deriving its `kind` from the value's shape a second time — and
`{kind: "with"}` for everything else, including every v3 task
(`contract === undefined`, per `task.ts:118`), which still routes the task
document's own `with:` (`PreparedTaskV3Workflow.params`) through the ONE
value-shape-driven normalizer, `freezeTaskInputBindings` → `normalizeOneEntry`
(`task-bindings.ts:239`): any plain object whose sole key is `from` becomes a
live reference resolved against the PARENT workflow's earlier step outputs.

Reproduced: a `version: 3` task with `uses: workflows/inner` and
`with: {config: {from: "steps.first.output"}}`, composed into a parent
workflow, freezes to
`[{"kind":"reference","name":"config","from":"steps.first.output","schema":{"type":"object"}}]`.
The SAME task run standalone (`akm task run`) passes `task.params` verbatim
as literal run params (`src/tasks/run/run-workflow-task.ts:121`,
`params: task.params`) — one authored task document means two different
things depending on the composition route.

This is spec-conformant: §4.2 step 7's routing table (above, the `"task"`,
v3 task row: "`PreparedTaskV3Workflow.params` (`prepare/prepare.ts:126`),
i.e. the task document's `with:`") directs exactly this case through the
`{kind: "with"}` arm — the same arm a genuinely-authored step `with:` uses
for the direct-composition form, where shape-driven classification is the
correct, intended reading (a workflow step author who writes `{from: "..."}`
does mean a live reference). A v3 task has no `inputs:` contract to trust the
way round 2's fix lets the v4 arm trust one, so no equivalent of
`rebindTaskInputBindings` is available for it: the value must be classified
somehow, and the spec's own routing table already settled on shape-driven
classification for this arm.

**Decision point for P3b/P4** (two options, neither chosen here):

1. Add a literal-only `AuthoredChildInputs` variant — e.g. `{kind:
   "literals"}` — that binds every entry as `kind: "literal"`
   unconditionally, never consulting the value's shape, and route a v3
   task's `with:` (and a v4 task with no declared `inputs:`) through it
   instead of `{kind: "with"}`.
2. Explicitly document, in `docs/reference/workflow-schema.md`'s
   composition section, that a v3 task's `with:` gains reference semantics
   the moment it is composed into a parent workflow — different from its
   meaning under `akm task run` — so the divergence is an authored contract,
   not a latent defect.

Neither this close-out nor round 2 (`6ec07482`) picked one; doing so changes
authorized behavior beyond what a close-out review may do under §0.

### R10 — `publishChildWorkflowRun`'s doc comment stated its serialization guarantee unconditionally; `withImmediateTransaction`'s re-entrancy join can silently drop it under a nested DEFERRED transaction (RESOLVED — doc comment tightened)

**Status: RESOLVED**, this close-out. The doc comment on
`publishChildWorkflowRun` (`src/storage/repositories/workflow-runs-repository.ts`,
immediately above the method) is tightened; no behavior change.

Found: the comment stated unconditionally that "Because the whole
SELECT-else-INSERT sequence runs inside one `BEGIN IMMEDIATE` transaction,
two concurrent callers … serialize on SQLite's write lock." But
`withImmediateTransaction` (`src/core/state-db.ts:690-726`) has a
re-entrancy guard (`:698`, "issue #686") that silently JOINS an
already-open transaction on the connection — no `BEGIN` of its own — when
`db.inTransaction` is already true. `WorkflowRunsRepository.transaction()`
is `db.transaction(fn)()`, **DEFERRED** per its own doc comment
(`state-db.ts:611`), and is already used in production at
`resumeWorkflowRun` (`src/workflows/runtime/runs.ts:506`) and
`completeWorkflowStep` (`:782`) — the latter the most plausible place a P3b
child-spawn gets wired. A `publishChildWorkflowRun` call nested inside one of
those DEFERRED outer transactions never issues its own `BEGIN IMMEDIATE`; it
joins the outer transaction instead, so the SELECT can read a stale
snapshot, both publishers can miss the existing row, and the loser's INSERT
then hits `idx_workflow_runs_invocation_key` with a raw, unclassified
`SQLiteError` rather than returning the winner's row — not idempotent, not a
`UsageError`, contradicting C-09's "never a thrown conflict."

P3a itself is unaffected: `publishChildWorkflowRun` has no production caller
(§5.5), so this is a doc-and-contract issue, not a live bug. Verified: the
real concurrent-publisher race (two connections, a worker thread holding the
write lock) passes exactly as C-09 requires when this call is the OUTERMOST
transaction on its connection —
`tests/integration/storage/child-run-publication.test.ts`'s
`describe("publishChildWorkflowRun — two concurrent publishers (C-09)")`
block (`:438`) exercises exactly that case — and the transaction body itself
(`workflow-runs-repository.ts`) is synchronous end to end (SELECT → INSERT →
`insertSteps` → UPDATE → `insertEventOnce`, no `await` crossing the
transaction boundary), so the guarantee genuinely holds whenever nothing
nests it. The gap is specifically the nested case, which no current test
exercises because no current caller nests it.

**Resolution:** the doc comment now states the guarantee holds only when
`publishChildWorkflowRun` is the outermost transaction on its connection,
names `withImmediateTransaction`'s re-entrancy join as the mechanism that
can break it, and names the two DEFERRED `repo.transaction()` call sites
(`runs.ts:506`, `:782`) a P3b caller must not nest this call inside without
its own accounting for the loss of isolation. No catch-and-reselect fallback
is added: §5.5 already bars this method from having a production caller in
P3a, so there is no live caller to protect yet, and adding untested new
functional surface is not this close-out's place — P3b inherits the
documented constraint and may add the fallback if it needs to nest the call.

### R11 — `publishChildWorkflowRun` hand-rolls its own INSERT instead of extending `insertRun`, duplicating a 13-column list against §5.2's own wording (RECORDED — duplication accepted, not refactored)

**Status: RECORDED**, not fixed. Between the two remediations available —
extend `insertRun` with optional parentage parameters and call it from
`publishChildWorkflowRun`, or record the duplication and its
must-move-together constraint — this close-out takes the second.

Found: `publishChildWorkflowRun` hand-rolls its own
`INSERT INTO workflow_runs (id, workflow_ref, scope_key, workflow_entry_id,
workflow_title, status, params_json, current_step_id, created_at, updated_at,
agent_harness, agent_session_id, checkin_armed_at, parent_run_id,
parent_unit_id, invocation_key)` rather than extending `insertRun` (the same
13 columns, minus the three parentage ones) with optional parentage
parameters. §5.2 itself describes the shape as "`insertRun` extended with
the three parentage columns" — the landed code took the other path. The two
13-column lists are in sync today (diffed column by column, in order, while
preparing this entry) but nothing enforces that they stay in sync: a future
migration adding a column to `InsertRunInput` / `insertRun` would silently
leave it unwritten for every child run, and no existing test would catch it
— the Lane C suite (`tests/integration/storage/child-run-publication.test.ts`)
asserts the child row's fields explicitly, field by field, rather than
comparing its shape against a freshly-inserted top-level row's.

**Decision:** recorded rather than refactored. `publishChildWorkflowRun` has
no production caller in P3a (§5.5), so there is no live behavior at stake;
extending `insertRun`'s signature is exactly the kind of change P3b will
need to revisit anyway once it wires a real caller and settles what, if
anything, a child run's insert needs beyond what is here today (e.g.,
whether `agent_harness` / `agent_session_id` should ever differ for a
child) — deciding that shape now, with no caller to drive it, risks
guessing at something P3b will have to re-derive regardless. Anyone touching
`InsertRunInput` or `insertRun`'s column list going forward MUST update
`publishChildWorkflowRun`'s hand-rolled list in the same change; this entry
is that note.

### R12 — R8's own docs fix overstated the blast radius of a composing step's dispatch failure: the run does not advance past it (RESOLVED — three doc sites reworded)

**Status: RESOLVED**, this close-out. The same three doc sites R8 corrected
in code-review round 1 are reworded again, this time to state what happens
to the REST of the run, not just to the composing step's own unit.

Found: `docs/reference/workflow-schema.md`'s "What is not yet available"
section (mirrored at `docs/reference/workflows.md`'s child-workflow
paragraph and `CHANGELOG.md`'s `[Unreleased]` entry — all three corrected
together by R8) stated "Every other step in the same run is unaffected —
only a step whose own target is `kind: "child-workflow"` hits this." Read
end to end against the real path: a parent whose first step composes a
child returns `run.status: "failed"`, `stepsProcessed: 1`, the step itself
recorded as `failedUnits: 1 (dispatch_error)`. Steps after the composing
step never dispatch, because the RUN fails at that step. R8's narrower claim
two sentences earlier — "running a step that composes a child workflow
fails closed… it fails with `UsageError` code
`WORKFLOW_CHILD_EXECUTION_UNSUPPORTED`" — is accurate; "every other step…
is unaffected" reads as though the run continues past the failure to reach
those other steps, which it does not.

**Resolution:** all three sites are reworded to say only what is true: the
composing step's own unit fails with `WORKFLOW_CHILD_EXECUTION_UNSUPPORTED`
and the run fails there; a step that already completed keeps its journaled
results and no other step's own target is touched by the failure, but the
run does not advance past the composing step. `docs/architecture/workflow-engine.md`
carries no matching claim (verified: `rg "unaffected" docs/architecture/workflow-engine.md`
is empty — it documents the plan `irVersion` 5 shape and the decode
integrity chain, not run-time dispatch behavior) and needs no edit.
