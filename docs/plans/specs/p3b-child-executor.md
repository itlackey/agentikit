# P3b — child workflow EXECUTION, workflow `outputs:`, the status tree, and `akm workflow plan`

**Status:** ready for implementation
**Phase:** P3b of the akm task/workflow refactor
**Owner artifacts:** `src/workflows/exec/child-workflow.ts` (new — the ONE child
drive), `src/workflows/exec/native-executor.ts` (the one dispatch-seam branch),
`src/workflows/exec/step-work.ts` (`childParams`, the live-only `childRun`
outcome field, the child-blocked step arm), `src/workflows/exec/run-workflow.ts`
(the `child-blocked` outcome kind), `src/workflows/exec/unit-dispatch.ts` +
`src/core/errors.ts` (the P3a `WORKFLOW_CHILD_EXECUTION_UNSUPPORTED` guard is
retired), `src/workflows/runtime/run-outputs.ts` (new — declared-output
resolution and the exported result), `src/workflows/runtime/runs.ts`
(resolve-at-completion + the status tree), `src/workflows/ir/schema-v4.ts` +
`src/workflows/ir/compile.ts` + `src/workflows/parser.ts` (the `outputs:`
declaration), `src/workflows/freeze/child-output-references.ts` (new — the
freeze-time reference check), `src/core/state/migrations.ts` (migration
`024-workflow-run-outputs`),
`src/storage/repositories/workflow-runs-repository.ts` (the `outputs_json`
column and the three child-excluding scope queries),
`src/commands/workflow/plan.ts` + `src/commands/workflow-cli.ts` (`akm workflow
plan`), the §6 authorized behavior flips, and the §8 docs.

This document is the **single source of truth** for P3b. Lanes do not
re-derive these facts from the codebase and do not read the parent plan. Every
`file:line` below was verified at the head of
`claude/breaking-changes-0-9-2-3cfyvp` (P3a closed out through its code-review
round 2, `6ec07482`).

---

## 0. What P3b is (and is not)

P3a made a child workflow a **frozen target inside the parent's plan** — the
complete child plan embedded, hash-verified on every decode, bounded at freeze —
and landed the durable storage a child run needs. It deliberately shipped with
**no production caller**: dispatching a `child-workflow`-targeted unit failed
closed with `WORKFLOW_CHILD_EXECUTION_UNSUPPORTED` (P3a Review log R8).

P3b makes the child **run**.

P3b **is**:

- **the child executor** — `src/workflows/exec/child-workflow.ts`, reached from
  the ONE dispatch seam in `native-executor.ts`, which derives the
  `invocation_key`, publishes the child idempotently, and **drives it with the
  existing engine** (`runWorkflowSteps`, pointed at the child run row). No
  second executor, no second scheduler, no second journal (§3);
- **workflow `outputs:`** — a source-level declaration of named, optionally
  schema-validated projections of step artifacts, compiled into source IR,
  frozen into the plan **additively within `irVersion` 5**, resolved and
  persisted at run completion, and promoted by a composing parent step (§4.2–§4.4);
- **the parent-child status tree** on `akm workflow status`, additive-only, with
  blocked children surfaced with their exact resume commands (§4.5);
- **`akm workflow plan <ref>`** — compile + freeze with **zero durable writes**,
  printing the canonical step graph, per-step frozen target kinds, task/child
  expansion boundaries, child plan hashes, input bindings, source read set,
  effective concurrency/budgets, and lowering notices (§4.6);
- **crash-window, replay-determinism, contention, and fixture-family
  coverage** for all of the above (§5).

P3b is **not**:

- **a plan `irVersion` bump.** `WORKFLOW_IR_V5_VERSION` stays `5`. `outputs` is
  an ADDITIVE plan field within `irVersion` 5 — see §0.1 and B-N1.
- **a `hashVersion` bump.** Both prefixes stay `akm.workflow.unit\0v6\0` and
  `akm.workflow.gate\0v6\0`, and `hashVersion` stays `6`. §3.6 states why the
  preimage needs no change and B-N3 states why a plan-level `outputs`
  declaration is correctly absent from it.
- **a child-scheduling phase.** A child is driven **inline**, inside its parent
  unit's journaled attempt, by the parent's own process. There is no background
  child driver, no daemon, no queue.
- **an auto-resume phase.** A `blocked` child is never resumed by the engine —
  a gate is a gate, for a child exactly as for a parent (§3.4, row A-14).
- **a deduplication phase.** P3a's row B-23 stands: a diamond embeds two
  independent copies and therefore publishes two independent child runs, under
  two `invocation_key`s.
- **a vocabulary-rename phase.** `src/workflows/ir/schema-v4.ts` keeps its FILE
  NAME and every exported TYPE name. P4 owns the rename.
- **a limit-relaxation phase.** `WORKFLOW_MAX_PLAN_BYTES`,
  `WORKFLOW_MAX_COMPOSITION_DEPTH` (8), and
  `WORKFLOW_MAX_EMBEDDED_CHILD_PLAN_BYTES` (1 MiB) are unchanged.

Rules of engagement (unchanged since P1b):

- A defect discovered that is **not** in §6 is recorded in the Review log and
  left unfixed. Do not "improve" anything on the way past.
- If preserving a behavior and implementing an authorized change appear to
  conflict, **stop and record it** — preserving wins until the Review log says
  otherwise.
- Editing a **pre-existing** test that §6 does not name is a **review-blocking
  violation**.

### 0.1 Naming discipline (binding, D1)

P3a's D1 rule carries forward verbatim and gains one clause:

| Counter | Value in P3b | Where it lives |
|---|---|---|
| Workflow plan schema | **plan `irVersion` 5** — UNCHANGED | `WORKFLOW_IR_V5_VERSION`, `plan.irVersion`, `workflow_runs.plan_ir_version` |
| Unit / gate input hash | **`hashVersion` 6** — UNCHANGED | `akm.workflow.unit\0v6\0`, `akm.workflow.gate\0v6\0`, the `hashVersion` preimage field |
| Child invocation key | **`\0v1\0`** — UNCHANGED | `akm.workflow.child-invocation\0v1\0` (`src/workflows/exec/child-invocation.ts:45`) |

Never write a bare `v5` or `v6` in prose, a comment, a test name, or a commit
message. The `\0v6\0` and `\0v1\0` inside a hash PREFIX STRING are byte
literals — write them verbatim. Everywhere else the words "plan irVersion",
"hashVersion", or "child-invocation vocabulary" must accompany the number.

**A P3b commit that changes any of the three numbers above is a
review-blocking violation.**

### 0.2 Commit ladder (binding)

| # | Commit | Contents |
|---|---|---|
| 1 | `docs(p3): behavior spec for child execution, outputs, and status tree` | **this file only** |
| 2 | `test(p3b): failing tests for workflow outputs, the status tree, and akm workflow plan (lane b)` | §7's Lane B suites, red |
| 3 | `feat(p3b): workflow outputs, the run status tree, and akm workflow plan` | Lane B + the §6 flips Lane B owns |
| 4 | `test(p3b): failing tests for the child executor (lane a)` | §7's Lane A suites, red |
| 5 | `feat(p3b): child workflow execution` | Lane A + the §6 flips Lane A owns |
| 6 | `test(p3b): crash windows, replay determinism, and the child-workflow fixture family (lane c)` | Lane C (tests + fixtures + the one manifest edit) |
| 7 | `docs(p3b): child execution, workflow outputs, and the status tree` | §8 docs |

**Lane B lands before Lane A.** Lane A's child executor promotes
`workflowRunExportedResult` (§4.4), which Lane B introduces; the reverse
dependency does not exist (the status tree renders whatever child rows exist,
and renders nothing when there are none). Commit 3 must be green on its own;
commit 5 depends on 3; commit 6 depends on 5.

Lane C is a test-and-fixture commit by construction: it adds no `src/**` file
and edits exactly one pre-existing non-test file,
`tests/fixtures/execution-contracts/workflows/manifest.json` (F-C1).

---

## 1. Binding design decisions (verbatim)

§1.1–§1.5 are copied **verbatim** from the phase decisions and are binding.
§1.6 records the disambiguations this spec adds, each with head-verified
evidence. Where a verbatim block and a disambiguation appear to conflict, the
disambiguation states which reading wins and why.

### 1.1 Lane A — child executor (binding)

> - New src/workflows/exec/child-workflow.ts. When the native executor reaches a
>   unit whose frozenTarget.kind === "child-workflow", it does NOT go through
>   UnitDispatcher (that envelope is {prompt,frozenTarget}->{ok,text} — a
>   process-call shape, not a run handle). Instead: derive invocation_key (P3a
>   helper) from (parentRunId, parentUnitId, v6 unitInputHash);
>   publishChildWorkflowRun idempotently (crash between publish and parent
>   recording must find the SAME child on retry — pin it); then DRIVE the child
>   run with the existing engine (the same run-workflow loop the top-level path
>   uses, pointed at the child run row — spec must name the exact reuse seam
>   after reading src/workflows/exec/run-workflow.ts and
>   src/workflows/runtime/runs.ts; no second executor).
> - Status mapping: child completed -> parent unit completes with the child's
>   exported output as the unit artifact; child failed -> parent unit fails with
>   journal failure_reason "child_workflow_failed" surfacing the child run id;
>   child blocked -> parent run blocks, the blocked-state notes name the child
>   run id and the exact resume command; publication/integrity failure -> its own
>   specific failure reason.
> - Cancellation: the parent's AbortSignal propagates into the child drive loop;
>   an aborted child leaves BOTH runs resumable (leases released per existing
>   lease semantics).
> - Retry/resume: a parent retry or resume reuses the SAME child while (parent
>   unit identity + effective input hash) are unchanged — the invocation_key
>   guarantees it; gateFeedback changing the unit hash yields a NEW child
>   (already true via the v6 preimage — pin it).
> - Nesting: a child containing its own child-workflow units drives recursively;
>   depth was bounded at freeze (P3a), so the executor needs no second bound —
>   but pin one 3-level integration test.
> - Provenance: thread eventSource into the child drive exactly as
>   run-workflow.ts's options.eventSource does today.

### 1.2 Lane B — workflow outputs + status tree + `akm workflow plan` (binding)

> - Workflow `outputs:` declaration (source level): named outputs, each `{from:
>   steps.<id>.output(.<seg>)*, schema?: <bounded JSON Schema via the existing
>   validateJsonSchemaSubset>}`. Compiled into source IR, frozen into the plan
>   (plan v5 already carries the field or gains it here — read what P3a landed
>   and specify exactly; if it requires a plan-shape addition, it is ADDITIVE
>   within irVersion 5 because v5 shipped this same release — say so
>   explicitly). At run completion the engine resolves declared outputs from step
>   artifacts, validates against schemas, and persists them as the run's exported
>   result. A child's exported result is what the parent unit promotes (Lane A
>   consumes this). A child with NO outputs declaration exports {runId, status}
>   metadata only, and a parent step referencing steps.<child>.output.<path>
>   beyond that fails at freeze if statically knowable, else at pre-attempt.
> - `akm workflow status` gains the parent-child tree: children listed under
>   their parent with status glyphs, blocked children surfaced with resume
>   commands. ADDITIVE ONLY — akm workflow verbs are Stable tier; existing output
>   lines/JSON fields keep their exact shapes, new fields/sections only. Pin the
>   existing status output shape before extending (read the current renderer +
>   its envelope tests).
> - New CLI: `akm workflow plan <ref> --json` — compile+freeze WITHOUT
>   publishing (zero durable writes, zero usage/event rows — pin that), print:
>   source format, canonical step graph, per-step frozen target kinds, task/child
>   expansion boundaries, child plan hashes, input bindings (names + kinds,
>   literal values shown but NEVER resolved env/secret values), source read set
>   (relative paths), effective concurrency/budgets, lowering notices. Text mode
>   = human summary; --json = the full structure. Register beside the other
>   workflow verbs; tests/contracts/command-cli-contract.test.ts must be updated
>   in the same commit (additive).

### 1.3 Lane C — crash-window + replay + fixtures (binding)

> - Crash windows (SIGKILL a driver subprocess, mirror
>   tests/integration/workflow-crash-windows.test.ts's technique): (1) kill after
>   child publication, before any child unit ran -> resume finds the child by
>   invocation_key, drives it, no duplicate child; (2) kill mid-child-execution
>   -> both runs resumable, child resumes its own journal; (3) kill after child
>   completed, before parent unit finalized -> resume completes the parent unit
>   WITHOUT re-running the child (journal replay). Plus: two-parent-process
>   contention on one child (leases).
> - Replay determinism: a resumed parent replays completed child units from the
>   journal byte-identically (no re-dispatch), mirroring the existing
>   chaos.test.ts patterns.
> - Fixture family
>   tests/fixtures/execution-contracts/workflows/child-workflow/: direct child,
>   task-wrapped child, child-with-outputs, 3-level nesting; registered per the
>   family manifest convention; a structural test proving each freezes to the
>   expected target kinds (mirror characterization-fixture-contracts.test.ts).

### 1.4 Docs (ride with code) (binding)

> docs/reference/workflow-schema.md (outputs:, child execution semantics, status
> tree), docs/reference/workflows.md, docs/guides/run-workflows.md (child resume
> flows), docs/reference/cli.md if it enumerates verbs, CHANGELOG [Unreleased]
> (child execution + outputs + workflow plan verb),
> docs/migration/v0.9.1-to-v0.9.2.md. Every akm example must pass
> scripts/lint-doc-examples.ts. STABILITY.md: workflow plan starts Evolving (new
> verb) — one-line tier note.

### 1.5 Preservation gates (binding)

> All P3a suites green; frozen-plan/chaos/run-lease/crash-window suites green;
> existing top-level run/resume/abandon/status behavior byte-identical for
> non-child workflows (Stable tier); fail-before-mutation unchanged; every akm
> workflow verb's existing JSON envelope shape unchanged (additive fields only).

### 1.6 Binding disambiguations added by this spec

Each row states a decision the verbatim blocks leave open, or corrects a detail
contradicted by head. Every claim carries its evidence.

**B-N1 — plan `irVersion` 5 does NOT carry `outputs` today; P3b adds it,
additively, without bumping the version.**
§1.2 says "plan v5 already carries the field or gains it here — read what P3a
landed and specify exactly". **Verified: it does not.**
`WorkflowPlanGraphV4` (`src/workflows/ir/schema-v4.ts:184-193`) is exactly
`{irVersion, title, params?, paramSchemas?, budget?, execution, sourceReadSet,
steps}`; `decodeWorkflowPlanV4`'s closed key set (`:220-224`) and the shared
`validateWorkflowPlanStructure` key set (`src/workflows/ir/schema.ts:163-168`,
extended by `planExtraKeys: ["sourceReadSet"]` at `schema-v4.ts:231`) both omit
it, and `rg outputs src/workflows/ir/` returns only the per-STEP `outputSchema`
(a different concept — see B-N2). P3b therefore adds `outputs` as a new optional
top-level plan field.

That addition is **ADDITIVE within `irVersion` 5, and the version does not
bump**, for two independent reasons, both of which must be stated in the code
comment on the new field:

1. **`irVersion` 5 has not shipped.** It was introduced by P3a in
   `CHANGELOG.md`'s `[Unreleased]` section for the SAME 0.9.2 release P3b ships
   in. No `plan_ir_version = 5` row exists anywhere outside a development tree,
   so there is no stored plan for the addition to be incompatible with. A bump
   to 6 would retire a version that never reached a user.
2. **A plan that declares no `outputs:` is byte-identical.** The field follows
   P2b's A-N7 rule — **absent, never `{}`**, when nothing is declared — so
   `canonicalPlanJson` emits the identical bytes and `computePlanHash` the
   identical digest for every workflow that does not use the feature. Every
   pre-existing plan-hash pin, frozen-plan fixture, and
   `task-binding-identity.test.ts` determinism assertion is therefore
   untouched, which is why §6 lists no plan-hash flip.

**B-N2 — plan `outputs` and step `outputSchema` are different concepts and
neither replaces the other.**
`IrStepPlanV4.outputSchema` (`schema-v4.ts:180`, authored as a step's `output:`)
is a **typed-artifact contract on ONE step**, enforced by `validateStepArtifact`
(`step-work.ts:891-905`) and retryable through the bounded gate loop. Plan
`outputs` is a **run-level export projection** over already-promoted step
artifacts, enforced once at run completion. They compose: a step may declare
`output:` and a plan may project that same step's artifact under an `outputs:`
name. P3b changes nothing about `outputSchema`.

**B-N3 — the `hashVersion` 6 preimage is unchanged, and plan `outputs` is
correctly absent from it.**
§3.3 of the P3a spec fixes the unit preimage's field list. P3b adds no field and
removes none. A plan-level `outputs:` declaration is **not** a unit input: it
governs what the run exports after every unit has run, so a unit's completed
journal row stays valid across a change to it — the same reasoning `retry` and
`onError` are excluded under P3a §3.3 exclusion 1. The CHILD's own `outputs`
declaration IS covered, transitively and wholesale: it lives inside
`frozenTarget.frozenPlan`, which the parent unit's preimage hashes through
`frozenTarget` (`step-work.ts:702`), and any byte of it changes
`frozenTarget.planHash` and therefore `frozenTarget.contentHash` (P3a row A-15).
A reviewer must not "fix" this by adding `outputs` to the preimage.

**B-N4 — `outputs:` is a Markdown-frontmatter key only; a GitHub-shaped
workflow cannot declare one.**
`parseGithubWorkflowSource` (`src/workflows/source-ir/github-yaml.ts:78-129`)
accepts exactly `ROOT_KEYS = ["name", "on", "jobs"]` (`:36`) and returns
`{sourceIrVersion, name, triggers, jobs, source}` — it produces no `params` and
has no extension surface for one. `params:` is therefore already
Markdown-frontmatter-only (`src/workflows/parser.ts:116`'s `WORKFLOW_KEYS`,
`parseParams` at `:548-579`), and `outputs:` is defined **symmetrically**: the
same authoring surface, the same name grammar, the same schema-subset validator,
the same per-schema byte bound.

Consequences, all of which must be stated in `docs/reference/workflow-schema.md`:

- A GitHub-shaped child workflow exports `{runId, status}` metadata only. That
  is not a defect; it is the same reason such a workflow declares no `params:`.
- Composition itself is unaffected: the PARENT must be GitHub-shaped (only
  `jobs.<id>.steps[].uses` composes), the CHILD may be either format, and a
  child that wants to export a real artifact is authored in Markdown. The
  §5.5 fixture family exercises exactly this pairing.

**B-N5 — the reuse seam is `runWorkflowSteps`, called with the child RUN ID as
`target`. Nothing else.**
§1.1 requires the spec to "name the exact reuse seam". It is
`runWorkflowSteps(options)` (`src/workflows/exec/run-workflow.ts:231`), the
exported entry point `akm workflow run` itself calls
(`src/commands/workflow-cli.ts:191`). Evidence that pointing it at a child run
row is exactly the top-level path, with no special casing:

- `runWorkflowAttempt` (`:278`) calls `getNextWorkflowStep(options.target, …)`
  (`:282`), which calls `resolveRunSpecifier` (`runs.ts:879`). Its FIRST branch
  is `repo.getRunById(specifier)` (`:886`) — a run id resolves to that row and
  returns immediately, with `autoStarted: false`. No ref canonicalization, no
  scope lookup, no `startWorkflowRun`.
- `requireExecutableWorkflowPlan(row)` (`:291`) then decodes the child's own
  `plan_json` against its own `plan_hash` — the identical integrity gate a
  top-level run gets.
- `acquireRunLease` (`:314`) takes the CHILD's own run lease on the CHILD's row,
  with its own holder id and its own `LeaseHeartbeat`. That is what makes
  two-parent contention on one child arbitrate correctly (§5.3) rather than
  needing a new mechanism.
- `driveRun` (`:937`) walks the child's spine through `completeWorkflowStep`,
  journals the child's units under the CHILD's run id, and re-reads the child's
  final state.

`driveRun` itself is **module-private and must not be exported**: it takes no
lease, starts no heartbeat, seeds no accounting, and runs no retry loop.
Reaching for it would be the "second executor" §1.1 forbids.

**B-N6 — the child drive MUST pass a no-op `disposeDispatchResources`.**
`runWorkflowAttempt`'s `finally` (`run-workflow.ts:358-368`) drains the cached
`opencode serve` child-process registry on EVERY exit path. That drain exists so
a one-shot CLI invocation can exit (module doc, "owner finding 4"). Letting the
CHILD drive run it would kill servers the PARENT's sibling units — a `map` step
fanning out beside the composing step — are still using, mid-dispatch. The child
drive therefore passes `disposeDispatchResources: () => {}`; the parent's own
`finally` remains the single owner of the process-lifecycle drain, for the whole
process, exactly as today. Pinned by row A-24.

**B-N7 — the child drive passes NO `maxSteps` and NO `maxRetries`.**
The parent's `--max-steps` budget counts DISTINCT PARENT spine steps
(`run-workflow.ts:971-976`); a composing step consumes exactly one of them, no
matter how many steps its child has. Forwarding the parent's remaining budget
into the child would make one parent step cost N, silently, and would make the
same composition behave differently depending on where in the parent it sits.
The child is driven to a terminal-for-this-invocation state (completed, failed,
blocked, or aborted) or not at all. Likewise `maxRetries`: the parent's retry
loop (`runWorkflowSteps`, `:245-275`) re-opens the failed parent step, which
re-derives the same `invocation_key` and therefore re-drives the SAME child —
that is the retry semantics §1.1 asks for, and a second retry budget inside the
child would double-count it.

**B-N8 — `parentUnitId` in the invocation key is the parent unit's
`journalBaseId`.**
`StepWorkUnit` carries two ids (`step-work.ts:137-145`): `unitId`, the
content-derived base (`<node_id>:<sha256>` / `<node_id>:solo`), and
`journalBaseId`, which is `unitId` or `<unitId>~l<loop>` inside a gate loop
(`:551`). `journalBaseId` is what `dispatchJournaledAttempt` passes as
`request.unitId` (`native-executor.ts` `runUnit`'s
`request: { ...request, unitId: attemptId }`, with `attemptIdFor` returning
`journalBaseId`) and therefore what `reserveUnitAttempt` writes to
`workflow_run_units.unit_id`. Using it as `parentUnitId`:

- makes `workflow_runs.parent_unit_id` join **exactly** to a real
  `workflow_run_units` row, which is how §4.5's tree resolves a child's parent
  STEP (`repo.getUnit(parentRunId, parent_unit_id)?.step_id`, `:1040`);
- is **stable across parent retries** (`attemptIdFor` returns the same
  `journalBaseId` for every attempt of the same unit), so a retry reuses the
  same child (row A-15);
- **changes under a gate loop** (`~l<n>`), which is a *second*, independent
  reason a gate loop yields a new child. The first — the one §1.1 asks to pin —
  is that `gateFeedback` is a `hashVersion` 6 preimage field (P3a §3.3), so the
  unit input hash changes on its own. Row A-16 asserts the hash-driven reason
  directly, against `unitInputHash`, so the pin does not depend on the id
  suffix.

**B-N9 — `--json` means the global `--format json`; no new flag is added.**
§1.2 writes `akm workflow plan <ref> --json`. There is no `--json` boolean
anywhere in this CLI: the one canonical way to select JSON is the global
`--format` (`GLOBAL_OUTPUT_ARGS`, `src/cli/shared.ts:163-164`), which
`defineJsonCommand` splices onto every leaf (`:221`). P2b's own new verb set the
precedent and the spec wording (`akm task explain <ref> --format json`, P2b row
B-53). `akm workflow plan <ref> --json` would additionally FAIL
`scripts/lint-doc-examples.ts`, which checks every `--flag` in a fenced doc
example against the real command tree. So: the verb is
`akm workflow plan <ref> [--format json]`, and every doc example uses that
spelling.

**B-N10 — a child run must be invisible to the three scope queries.**
P3a §5.2 pins `run.scopeKey` = the PARENT's `scope_key` so a status tree can
find children in one scope. Three pre-existing queries select by scope and would
therefore start returning child rows:

| Site | Consequence if unfiltered |
|---|---|
| `listRuns` (`workflow-runs-repository.ts:372`) | `akm workflow list` shows each child as a peer of its parent; `--active` double-counts one logical run |
| `getActiveRunRowForScope` (`:352`) | `akm workflow run workflows/<childRef>` ATTACHES to a child a parent is currently driving (`resolveRunSpecifier`, `runs.ts:900,917`) — two drivers, one run |
| `findActiveOrBlockedRunForScope` (`:415`) | `akm show`'s active-run guard (`getActiveWorkflowRun`, `runs.ts:1113-1121`) reports a child as "the" active run |

All three gain `AND parent_run_id IS NULL`. For any database with no child rows
— every pre-P3b database and every non-composing workflow — the result set is
**byte-identical**, which is what keeps these Stable-tier surfaces preserved.
`listRuns` additionally gains an opt-in `includeChildren` filter, surfaced as
`akm workflow list --children` (additive boolean, default `false`), so an
operator can still enumerate them. `akm workflow status <childRunId>` needs no
flag and is unchanged — a child run id is a run id.

**B-N11 — P3a's `WORKFLOW_CHILD_EXECUTION_UNSUPPORTED` is RETIRED, and its
guard becomes an internal-invariant guard.**
P3a Review log R8 added a `UsageError` guard at the top of
`dispatchWorkflowExecution` (`unit-dispatch.ts:180-187`) plus the
`UsageErrorCode` member (`errors.ts:139`) and its `USAGE_HINTS` entry (`:216`),
because a `child-workflow` target legitimately reached dispatch with nothing to
do about it. After P3b that premise is gone: `dispatchJournaledAttempt` routes a
`child-workflow` unit to the child executor before dispatch is reached (§3.2), so
arriving at `dispatchWorkflowExecution` with one means the executor seam was
**bypassed** — an engine routing bug, not a user-facing "not implemented yet".

Chosen: the guard **stays** but becomes a plain `Error` naming the seam, and the
error CODE is deleted (no producer would remain). Rejected alternatives:

- *Delete the guard entirely.* A bypassed seam would then fall into the generic
  `kind !== "command"` `ConfigError` reading "is not a command target." — the
  exact false, unhelpful message R8 was opened to remove. Rejected for the same
  reason R8 rejected it.
- *Keep the `UsageError` and its code.* A `UsageError` tells a user to change
  their input; nothing a user can author causes this. Keeping a
  user-facing code with no user-reachable producer is dead vocabulary.

`tests/workflows/child-workflow-dispatch-guard.test.ts` flips accordingly
(F-A1); its negative control is byte-unchanged.

**B-N12 — run-output resolution reads STEP ROWS and fails loudly on a
truncation envelope.**
`clipStepEvidenceForPersistence` (`runs.ts:642-691`) may replace an over-cap
step artifact with a `TruncatedEvidenceValue` in the row. `completeWorkflowStep`
sees only the CURRENT step's live evidence — earlier steps' complete in-memory
values live in `driveRun`'s `liveEvidence` map (`run-workflow.ts:942-959`),
which the runtime cannot reach. So resolution reads the persisted rows, and a
declared output whose source artifact is a truncation envelope fails through the
existing `isTruncatedEvidence` predicate (`runs.ts:611-617`) with a loud,
by-name error — never silently exporting the envelope. This is the identical
contract a resumed run's `steps.<id>.output` reference already gets
(`step-work.ts`'s truncation guard); P3b adds no second reading of it.

**B-N13 — an output-resolution failure rolls back inside the existing
completion transaction; fail-before-mutation is preserved.**
Whether a run COMPLETES is only knowable after `deriveRunState(refreshedSteps)`
(`runs.ts:838`), which needs the step row written. Rather than projecting the
spine in memory, resolution runs immediately after `deriveRunState` yields
`"completed"`, INSIDE the same `repo.transaction` (`:782-858`); a failure throws
there, and SQLite rolls the whole transaction back — the step completion
included. The observable result is exactly fail-before-mutation: the step stays
`pending`, the run stays `active`, no event is appended (`appendEvent` runs after
the transaction, `:867`), and the run is resumable once the workflow is fixed or
abandoned. The `tests/integration/tasks-runtime-v3-runner.test.ts` canary is
untouched.

**B-N14 — a child run's `workflow_entry_id` is `NULL`.**
`InsertRunInput.workflowEntryId` is `number | null`
(`workflow-runs-repository.ts:230`) and the column is a nullable `INTEGER`
(`migrations.ts:886`). `startWorkflowRun` fills it via
`resolveWorkflowEntryId(asset.sourcePath, asset.ref, asset.adapterId)`
(`runs.ts:303`) — an INDEX lookup keyed on the asset's source path, which the
child publication contract has no access to: P3a row C-11 forbids
`publishChildWorkflowRun` from any source access, and the child plan was frozen
into the parent long before this dispatch. Resolving it live would additionally
make a resumed run's child row depend on the current index state, which is not
frozen. `NULL` is the honest value; row A-08 asserts it.

**B-N15 — the child-blocked instruction needs NO renderer change.**
The blocked-state notes (§3.4) are written through `completeWorkflowStep`'s
`notes` field, which `formatWorkflowStatusPlain` already renders under the step
(`src/output/text/workflow-format.ts:59-61`), and are returned as the executed
step's `summary`, which `formatWorkflowRunPlain` already renders
(`:159-161`). Lane A therefore touches **no** output module, which is what keeps
Lane A's and Lane B's file lists disjoint (Lane B owns `workflow-format.ts`
exclusively, for §4.5's tree and §4.6's plan summary).

---

## 2. Behavior table (input → expected after P3b)

Rows are tagged **PRESERVE** (must not change; a failure is a regression) or
**NEW** (this phase's authorized change). Every NEW row needs at least one test
asserting both its code/reason and its message text.

### 2.1 The dispatch seam (Lane A)

| # | Input | Expected after P3b | Tag |
|---|---|---|---|
| A-01 | A parent unit whose `frozenTarget.kind === "child-workflow"` reaches `dispatchJournaledAttempt` | Routed to `driveChildWorkflowUnit`; `UnitDispatcher` is **never** called for it (assert with an injected dispatcher that records every call) | NEW |
| A-02 | The same unit | Still reserves and finishes its OWN attempt row in `workflow_run_units` (`phase: "unit"`, `runner: "exec"`), so retry/reuse/journal accounting are unchanged | NEW |
| A-03 | `dispatchWorkflowExecution` called directly with a `child-workflow` target | Plain `Error` (NOT a `UsageError`, no `code`), message names `src/workflows/exec/child-workflow.ts` and says the unit reached the command dispatch path | NEW (was `UsageError` / `WORKFLOW_CHILD_EXECUTION_UNSUPPORTED`) |
| A-04 | `rg WORKFLOW_CHILD_EXECUTION_UNSUPPORTED src/` | Zero hits | NEW |
| A-05 | A `command` / `shell` / `script` unit | Dispatch path byte-unchanged; no child code is reached | PRESERVE |
| A-06 | `computeStepWorkList` on a child-workflow step | `timeoutMs: null` (P3a Review log R1's arm), `runner: "exec"`, `prompt` built as today | PRESERVE |

### 2.2 Publication and identity (Lane A)

| # | Input | Expected after P3b | Tag |
|---|---|---|---|
| A-07 | A child-workflow unit dispatching for the first time | `computeChildInvocationKey({parentRunId, parentUnitId: <journalBaseId>, unitInputHash})`, then `publishChildWorkflowRun` — exactly one child row, one `workflow_started` event, one step set | NEW |
| A-08 | That child row | `parent_run_id` = parent, `parent_unit_id` = the parent unit's `journalBaseId`, `invocation_key` = A-07's key, `scope_key` = the PARENT's, `plan_ir_version = 5`, `workflow_entry_id` **NULL** (B-N14), `agent_harness`/`agent_session_id` copied from the parent | NEW |
| A-09 | That child row's `params_json` | Exactly the resolved `inputBindings` of the composing unit (`resolveTaskInputBindings`, `step-work.ts:397`); `{}` when the step binds nothing | NEW |
| A-10 | A child plan whose recomputed `computePlanHash(frozenPlan)` ≠ `frozenTarget.planHash` | Parent unit fails, `failure_reason: "child_workflow_publish_failed"`, message names the child ref and both hashes. **No** child row, **no** event | NEW |
| A-11 | Resolved params that violate the child plan's `paramSchemas` | Same reason `child_workflow_publish_failed`, message carries `validateWorkflowParams`' errors. No child row | NEW |
| A-12 | `publishChildWorkflowRun` throwing for any other reason | Same reason, message wraps the cause | NEW |
| A-13 | Calling the seam twice with the same three key inputs | The SAME child run id both times; `childRunsOf(parent).length === 1` | NEW |
| A-14 | A parent RESUME of the composing step | Same `invocation_key` → same child; the child is driven, never re-published | NEW |
| A-15 | A parent RETRY (`--max-retries`) of the composing step | Same child (`journalBaseId` is retry-stable, B-N8) | NEW |
| A-16 | A gate loop ≥ 2 on the composing step | `computeUnitInputHash` differs (the `gateFeedback` preimage field, P3a §3.3) → a DIFFERENT `invocation_key` → a NEW child run. Asserted directly on the two hashes, not on the id suffix | NEW |
| A-17 | Two different composing steps in one parent, same child ref, same bindings | Two child runs (different `parentUnitId` → different key). Deduplication is out of scope (P3a row B-23) | NEW |

### 2.3 Driving and status mapping (Lane A)

| # | Input | Expected after P3b | Tag |
|---|---|---|---|
| A-18 | Child status `active` after publication | `runWorkflowSteps({target: <childRunId>, …})` drives it (B-N5) | NEW |
| A-19 | Child reaches `completed` | Parent unit COMPLETES; its `result` is `workflowRunExportedResult(childRow)` (§4.4); `evidence.output` for a solo step is that object | NEW |
| A-20 | Child reaches `failed` | Parent unit fails, `failure_reason: "child_workflow_failed"`, message names the child run id, the child ref, and the child's own failed step | NEW |
| A-21 | Child reaches `blocked` | Parent unit fails with `failure_reason: "child_workflow_blocked"`; the composing STEP completes **`blocked`** (not `failed`); the parent RUN derives `blocked`; the notes are §3.4's exact string | NEW |
| A-22 | A child already `blocked` from a previous parent attempt | Identical to A-21 **without** driving it — `runWorkflowSteps` is not called, no lease is taken | NEW |
| A-23 | A child already `failed` from a previous parent attempt | Identical to A-20 without driving it | NEW |
| A-24 | Any child drive | Passes `disposeDispatchResources: () => {}` (B-N6); the parent's registry drain fires exactly once, in the parent's own `finally` | NEW |
| A-25 | Any child drive | Passes no `maxSteps` and no `maxRetries` (B-N7); the composing step consumes exactly ONE of the parent's `maxSteps` regardless of the child's step count | NEW |
| A-26 | Parent invoked with `--max-steps 1` on a workflow whose first step composes a 4-step child | The child runs all 4 of its steps; `stepsProcessed === 1` | NEW |
| A-27 | A child whose lease is already held live by another driver | Parent unit fails, `failure_reason: "child_workflow_busy"`, message carries the holder and expiry from `acquireRunLease`'s existing text; the parent run fails and stays resumable | NEW |

### 2.4 Cancellation, provenance, nesting (Lane A)

| # | Input | Expected after P3b | Tag |
|---|---|---|---|
| A-28 | Parent `AbortSignal` aborts mid-child-drive | The child drive observes it (it is the parent unit's dispatch signal — the heartbeat controller, `run-workflow.ts:966`); the child returns `aborted: true`; the parent unit fails with `failure_reason: "aborted"` | NEW |
| A-29 | After A-28 | BOTH leases are released (each drive's own `finally`, `run-workflow.ts:350-368`); both runs are resumable; `akm workflow status` on each shows no live lease | NEW |
| A-30 | The parent loses its OWN run lease mid-child-drive | The heartbeat's controller aborts the child drive; the parent stops loudly through the existing `assertAlive` path; the child is left resumable | NEW |
| A-31 | `RunWorkflowOptions.eventSource` set on the parent | Threaded into the child drive's `eventSource` verbatim, so child units and child gate judges observe it exactly as parent ones do | NEW |
| A-32 | `eventSource` absent (every `akm workflow run` invocation) | Absent in the child drive; byte-identical behavior | PRESERVE |
| A-33 | `StepExecutionContext.dispatcher` (the test seam) | Threaded into the child drive's `dispatcher`, so an injected fake serves child units and child judges (`workflowSummaryJudge`, `run-workflow.ts:568-574`) | NEW |
| A-34 | `StepExecutionContext.maxConcurrency` | Threaded into the child drive's `maxConcurrency`; the child's effective width is `min(parent engine cap, child plan's execution.maxConcurrency)` | NEW |
| A-35 | A child that itself composes a grandchild | Drives recursively through the identical seam; three levels complete; three run rows exist, linked `root → child → grandchild` | NEW |
| A-36 | The executor's own depth handling | **None.** Depth is bounded at freeze and re-bounded at decode (P3a §4.5, row A-23). A second executor-side bound is a review-blocking addition | NEW |

### 2.5 Workflow `outputs:` — authoring and freeze (Lane B)

| # | Input | Expected after P3b | Tag |
|---|---|---|---|
| B-01 | Markdown frontmatter `outputs: {report: {from: steps.summarize.output}}` | Parses; reaches `WorkflowSourceIrV1.outputs`; compiles to `WorkflowPlanDraft.outputs`; freezes to `plan.outputs` | NEW |
| B-02 | `outputs:` with a `schema:` | Same, with `schema` frozen alongside `from` | NEW |
| B-03 | An output name outside `^[A-Za-z_][A-Za-z0-9_]*$` | Parse error naming the key and the grammar (the `params:` message, adapted) | NEW |
| B-04 | More than `WORKFLOW_MAX_OUTPUTS` (64) entries | Parse error naming the cap | NEW |
| B-05 | `from:` that is not a valid `steps.<id>.output(.<seg>)*` reference | Parse error from `checkReferenceSyntax` | NEW |
| B-06 | `from:` naming a step id the document does not declare | Compile error naming the step and the output | NEW |
| B-07 | `from: params.<name>` | Rejected — an output projects a STEP artifact, never a param (a param is already on the run row) | NEW |
| B-08 | A `schema:` outside the enforced JSON Schema subset | Parse error from the existing `checkSchemaDefinition` (`parser.ts:1387`), same message shape as a `params:` schema | NEW |
| B-09 | A `schema:` over `WORKFLOW_MAX_SCHEMA_BYTES` (256 KiB) | Parse error naming the cap, same as `params:` | NEW |
| B-10 | `outputs:` in a GitHub-shaped `.yml` | Rejected by the existing closed `ROOT_KEYS` check, message unchanged (B-N4) | PRESERVE |
| B-11 | A workflow declaring NO `outputs:` | `plan.outputs` is **absent**, never `{}`; `canonicalPlanJson` and `computePlanHash` are byte-identical to P3a's | NEW |
| B-12 | `decodeWorkflowPlanV4` on a plan with a valid `outputs` | Accepts; `irVersion` stays 5 | NEW |
| B-13 | `decodeWorkflowPlanV4` on `outputs: {}` | Fails — absent-never-empty (P2b A-N7) | NEW |
| B-14 | `decodeWorkflowPlanV4` on `outputs` whose keys are not in sorted-unique order | Fails — canonical wire order, same rule as `inputBindings` (`schema-v4.ts:670-672`) | NEW |
| B-15 | `decodeWorkflowPlanV4` on `outputs.<n>.from` naming a step not in `plan.steps` | Fails, naming the output and the step | NEW |
| B-16 | An unknown key inside an `outputs` entry | Fails through the module's existing `assertKeys` | NEW |
| B-17 | Two freezes of the same source declaring `outputs:` | Byte-identical plan hash | NEW |

### 2.6 Workflow `outputs:` — resolution and export (Lane B)

| # | Input | Expected after P3b | Tag |
|---|---|---|---|
| B-18 | A run whose final step completes, plan declares `outputs:` | `workflow_runs.outputs_json` holds the canonical JSON of the resolved map; written in the SAME transaction as the completion | NEW |
| B-19 | A run whose plan declares no `outputs:` | `outputs_json` stays NULL; nothing is written | NEW |
| B-20 | An output whose `from` resolves to a missing property | The completion transaction rolls back; `UsageError` code **`WORKFLOW_OUTPUT_INVALID`**, exit 2, naming the output and the reference. Step stays `pending`, run stays `active`, no event appended (B-N13) | NEW |
| B-21 | An output whose source step artifact is a truncation envelope | Same failure, message names the output and says the artifact was truncated at persistence (B-N12) | NEW |
| B-22 | An output whose resolved value violates its declared `schema` | Same failure, message carries `validateJsonSchemaSubset`'s errors | NEW |
| B-23 | A run that fails or blocks | No output resolution runs; `outputs_json` stays NULL | NEW |
| B-24 | `workflowRunExportedResult(row)` on a completed run with `outputs_json` | The parsed map | NEW |
| B-25 | `workflowRunExportedResult(row)` on any run with `outputs_json` NULL | `{runId: <id>, status: <status>}` — synthesized, never stored | NEW |
| B-26 | `akm workflow status <runId>` on a run with `outputs_json` | The envelope's `run.outputs` carries the map | NEW |
| B-27 | `akm workflow status <runId>` on a run without it | `run.outputs` is **absent** (not `null`) — every pre-existing envelope byte-identical | PRESERVE |
| B-28 | A parent step `inputs: [steps.<child>.output.<name>]` where `<name>` is a declared child output | Freezes | NEW |
| B-29 | The same where `<name>` is NOT declared by the child (and the child declares `outputs:`) | `COMPOSITION_INVALID` at FREEZE, naming the step, the child ref, the bad name, and the child's declared names | NEW |
| B-30 | The same where the child declares NO `outputs:` and `<name>` is not `runId`/`status` | `COMPOSITION_INVALID` at freeze, message says the child exports `{runId, status}` only and points at `outputs:` | NEW |
| B-31 | A reference DEEPER than the first segment (`steps.<child>.output.<name>.<path>`) | Freeze checks only the first segment; the rest resolves at pre-attempt through the existing resolver and fails there with its existing message | NEW |
| B-32 | A reference into a NON-child step's output | Freeze check does not apply; behavior byte-unchanged | PRESERVE |

### 2.7 The status tree (Lane B)

| # | Input | Expected after P3b | Tag |
|---|---|---|---|
| B-33 | `akm workflow status <runId>` on a run with NO children | Envelope and text bytes **identical** to P3a's; no `children` key, no `children:` block | PRESERVE |
| B-34 | `akm workflow status <parentRunId>` with children | Envelope gains `children: [...]`, in `created_at, id` order (P3a row C-13) | NEW |
| B-35 | Each `children[]` entry | `{runId, workflowRef, workflowTitle, status, spawnedByUnitId, stepId, currentStepId, createdAt, updatedAt}`, plus `resume` when blocked and `children` when it has its own | NEW |
| B-36 | `stepId` on a child entry | The parent STEP that spawned it — `repo.getUnit(parentRunId, parent_unit_id)?.step_id`; `null` when the unit row is gone | NEW |
| B-37 | A 3-level tree | Nested recursively; the depth of the rendered tree equals the composition depth | NEW |
| B-38 | Text mode with children | A `children:` block immediately after `steps:`, one glyph-prefixed line per child (§4.5's glyph table), indented by depth | NEW |
| B-39 | A blocked child in text mode | Two extra indented lines: `resume:` and `then:`, carrying §4.5's exact commands | NEW |
| B-40 | `akm workflow list` in a scope containing child runs | Child rows are **excluded**; output for a childless scope is byte-identical (B-N10) | NEW |
| B-41 | `akm workflow list --children` | Child rows included, each carrying `parentRunId` | NEW |
| B-42 | `akm workflow run workflows/<childRef>` while a parent drives a child of that ref | Starts a NEW top-level run; never attaches to the child (B-N10) | NEW |
| B-43 | `akm show`'s active-run guard while a child is active | Reports the PARENT run, never the child | NEW |
| B-44 | `akm workflow status <childRunId>` | Works; the envelope gains `run.parentRunId` and `run.spawnedByUnitId` | NEW |
| B-45 | `akm workflow status`/`list`/`resume`/`abandon`/`run` on any non-child run | Every existing JSON field and every existing text line byte-identical (Stable tier) | PRESERVE |

### 2.8 `akm workflow plan` (Lane B)

| # | Input | Expected after P3b | Tag |
|---|---|---|---|
| B-46 | `akm workflow plan workflows/<ref>` | Exit 0; human summary on stdout (§4.6) | NEW |
| B-47 | `akm workflow plan workflows/<ref> --format json` | One JSON object with §4.6's exact key set | NEW |
| B-48 | Either mode, before/after row counts | **Zero** new rows in `workflow_runs`, `workflow_run_steps`, `workflow_run_units`, `workflow_run_unit_attempts`, and the events table; zero usage rows; no warn-log file written | NEW |
| B-49 | A workflow composing a child | Per-step `expansion` names `via: "child"`, the child ref, the child `planHash`, the child's declared output names, and the child's own steps nested | NEW |
| B-50 | A task-wrapped step | `expansion` names `via: "task"` and the `taskRef` | NEW |
| B-51 | `inputBindings` on a step | Names + kinds; a `literal`'s VALUE is shown; a `reference`'s `from` is shown and never resolved | NEW |
| B-52 | A step with `env:` bindings / an `env-ref` | `environment` reports kind + name (and, for `env-ref`, `ref`/`keys`/`secretNames` — all NAMES). **No** literal env VALUE, ever | NEW |
| B-53 | A fixture whose command body, persona, script bytes, and `env:` hold sentinel secrets | No sentinel appears in stdout or in the JSON envelope bytes, in either mode | NEW |
| B-54 | `sourceReadSet` in the output | Relative paths only; `expect(path.isAbsolute(p)).toBe(false)` for every entry | NEW |
| B-55 | A workflow that fails to freeze (any `COMPOSITION_INVALID` / `INPUT_BINDING_INVALID` case) | The verb reports the same error, same code, same exit code, and still writes nothing | NEW |
| B-56 | Compile warnings (`collectWorkflowWarnings`) | Returned in the envelope's `warnings[]`. The verb never calls `warn()` (that writes a log file, breaking B-48) | NEW |
| B-57 | Lowering notices from freeze | Returned in `notices[]`, the same projection `akm workflow run` renders | NEW |
| B-58 | `akm workflow plan` with no ref / an unknown ref | Usage error exit 2 / `WORKFLOW_NOT_FOUND` exit 1, standard `{ok:false,error,code}` envelope | NEW |
| B-59 | The command registration | `main.subCommands.workflow.subCommands.plan` exists with a required `ref` positional and the global `format` flag | NEW |

### 2.9 Crash windows, contention, replay (Lane C)

| # | Input | Expected after P3b | Tag |
|---|---|---|---|
| C-01 | SIGKILL after the child row is published, before any child unit ran | Resume finds the child by `invocation_key`, drives it to completion. `childRunsOf(parent).length === 1`; exactly one `workflow_started` event for the child | NEW |
| C-02 | SIGKILL mid-child-execution (a child unit journaled `running`) | Both runs resumable; after lease expiry a fresh process resumes, the child re-dispatches **only** the interrupted unit, and both runs complete | NEW |
| C-03 | SIGKILL after the child completed, before the parent unit row finished | Resume completes the parent unit with the child's exported result and dispatches **zero** child units (marker count for every child unit stays at its pre-crash value) | NEW |
| C-04 | Two parent processes driving composing steps that resolve to the same `(parentRunId, invocationKey)` | Exactly one child row; one drive holds the child lease and the other's unit fails `child_workflow_busy` naming the holder. Never two drivers | NEW |
| C-05 | A resumed parent whose composing step already completed | The parent unit is REUSED from the journal (`classifyUnitReuse` → `reuse`); `driveChildWorkflowUnit` is never entered; the promoted artifact is byte-identical to the live run's | NEW |
| C-06 | The same, compared byte-for-byte | The resumed parent's step evidence JSON equals the interrupted run's, exactly (the chaos-suite comparison technique) | NEW |
| C-07 | A tampered child `input_hash` on the parent's composing unit row | The existing `replay_divergence` hard failure, message unchanged | PRESERVE |

### 2.10 Fixtures (Lane C)

| # | Input | Expected after P3b | Tag |
|---|---|---|---|
| C-08 | `tests/fixtures/execution-contracts/workflows/child-workflow/` | Four registered workflows: `direct-child`, `task-wrapped-child`, `child-with-outputs`, `three-level` | NEW |
| C-09 | Every `*.yml` **and** `*.md` under `child-workflow/workflows/` | Registered in the manifest's `childWorkflow.workflows` — no orphan fixtures. (Unlike `planV4`, this family registers BOTH extensions: the parent must be `.yml`, a child declaring `outputs:` must be `.md` — B-N4) | NEW |
| C-10 | Freezing each registered fixture | The manifest's `expectedStepTargetKinds` match, INCLUDING `child-workflow` entries | NEW |
| C-11 | Freezing `three-level` | The embedded chain is 3 plans deep; each level's `frozenTarget.planHash` matches `computePlanHash` of its own embedded plan | NEW |
| C-12 | Freezing `child-with-outputs` | The embedded child plan carries `outputs`; the parent step referencing a declared name freezes | NEW |
| C-13 | The `planV4` family | Byte-unchanged: same files, same `expectedTargetKindSet` `["command","script","shell"]`, same assertions | PRESERVE |

---

## 3. Lane A — the child executor

### 3.1 Files

| File | Change |
|---|---|
| `src/workflows/exec/child-workflow.ts` | **New.** `driveChildWorkflowUnit(input): Promise<UnitOutcome>` — the ONE child drive (§3.3). Imports `computeChildInvocationKey` from `./child-invocation`, `runWorkflowSteps` from `./run-workflow`, `workflowRunExportedResult` from `../runtime/run-outputs` (Lane B), `withWorkflowRunsRepo` from the repository, and `canonicalPlanJson`/`computePlanHash` + `validateWorkflowParams`/`frozenStepRows`. No new limit, no new scheduler, no new journal writer. |
| `src/workflows/exec/native-executor.ts` | `dispatchJournaledAttempt`'s single dispatch call (`:1168`) becomes a two-arm branch (§3.2). The `prepareAttemptWorktree` child-workflow comment (`:1000-1008`) is corrected: dispatch no longer fails closed; a `child-workflow` unit that also declares `isolation: worktree` still carries no `gitCommitOid`, and the prepared worktree is simply unused by the drive. No other edit. |
| `src/workflows/exec/step-work.ts` | `StepWorkUnit` gains `childParams?: Readonly<Record<string, unknown>>` (§3.3 step 2); `UnitOutcome` gains the LIVE-ONLY `childRun?` field (§3.4); `ExecutedStepOutcome`/`StepExecutionResult` gain `childBlocked?`; `reduceStepOutcomes` (`:1043`) sets it; `FinalizeStepResult` (`:1646`) gains `{kind: "child-blocked"; summary: string}`; `finalizeExecutedStep`'s `!result.ok` arm checks `childBlocked` FIRST; a new `blockStepForChildWorkflow` sits beside `blockStepForJudgeFailure` (`:1700`). The `:454` comment (P3a R8's "dispatch itself is what fails closed") is corrected to name the child executor. |
| `src/workflows/exec/run-workflow.ts` | `StepGateLoopOutcome["kind"]` (`:733`) gains `"child-blocked"`; it is **not** added to `STEP_FINISHED_KINDS` (`:747`); `RunWorkflowResult` (`:197`) gains `childBlocked?: {stepId, childRunId, childRef, resume, then}`; `runStepGateLoop` maps `finalize.kind === "child-blocked"` to it and returns; `driveRun` surfaces it and breaks. |
| `src/workflows/exec/unit-dispatch.ts` | The P3a guard (`:173-187`) becomes the internal-invariant guard of B-N11: a plain `Error`, no code. |
| `src/core/errors.ts` | `WORKFLOW_CHILD_EXECUTION_UNSUPPORTED` is deleted from the `UsageErrorCode` union (`:139`) and from `USAGE_HINTS` (`:216`). |

Lane A touches **no** file under `src/output/`, `src/commands/`, `src/core/state/`, or `src/storage/` (B-N15). Its only `src/core/` edit is the two-line code deletion above.

### 3.2 The dispatch seam (exact)

`native-executor.ts:1168`, inside `dispatchJournaledAttempt`, becomes:

```ts
const dispatched =
  request.frozenTarget.kind === "child-workflow"
    ? await driveChildWorkflowUnit({
        request,
        target: request.frozenTarget,
        ctx: input.ctx,
        childParams: input.workUnit.childParams ?? {},
        inputHash: input.inputHash,
        dispatcher,
      })
    : await dispatchUnit(request, dispatcher);
```

Why **here** and nowhere else:

- **Before** it, `reserveJournaledDispatch` has already claimed the parent
  unit's attempt row (`running`, claim holder, expiry). A crash between the
  reservation and the child's publication therefore leaves a `running` parent
  row and NO child — recovered by C-01's resume, which re-dispatches the parent
  unit and publishes the child idempotently.
- **After** it, `redactUnitOutcome`, `finishJournaledDispatch`, the worktree
  epilogue, and the `journal_write_failed` classification all run unchanged, so
  a child-workflow unit is journaled exactly like any other and the durable-row
  reuse that C-03 and C-05 depend on works with no new code.
- It is **inside** the retry loop (`runUnit`), so a `retry:` policy on the
  composing step still applies — and, because none of the three new failure
  reasons is a member of `PROGRAM_RETRY_REASONS`
  (`src/workflows/program/schema.ts:77`), no authored `retry.on:` can name one.
  A failed child is re-driven by an explicit parent retry or resume, never by an
  automatic in-step re-dispatch. Row A-15 pins that this reuses the same child.

`dispatchUnit` (`:1267`) is **not** modified: it owns structured-output parsing,
usage capture, and `UnitTransportError` classification, none of which applies to
a run handle.

### 3.3 `driveChildWorkflowUnit` — the drive contract

```ts
export interface DriveChildWorkflowInput {
  readonly request: UnitDispatchRequest;              // unitId === the parent unit's journalBaseId (B-N8)
  readonly target: FrozenChildWorkflowTarget;
  readonly ctx: StepExecutionContext;
  readonly childParams: Readonly<Record<string, unknown>>;
  readonly inputHash: string;                         // the hashVersion 6 unit input hash
  readonly dispatcher: UnitDispatcher;
}
export function driveChildWorkflowUnit(input: DriveChildWorkflowInput): Promise<UnitOutcome>;
```

Ordered steps. Every failure before step 6 produces `child_workflow_publish_failed`.

1. **Integrity re-check.** `computePlanHash(target.frozenPlan) === target.planHash`
   (row A-10). The plan was already verified at decode; re-checking here is
   cheap and makes the publication's own inputs self-consistent.
2. **Params.** `childParams` comes from `StepWorkUnit.childParams`, which
   `buildStepWorkUnit` sets from `taskInputsResolution.values` — the SAME
   resolution P2b already runs for every frozen target's `inputBindings`
   (`step-work.ts:397`), so no second binding resolver exists. Run
   `validateWorkflowParams(target.frozenPlan, childParams)`; a non-empty error
   list fails with row A-11's message.
3. **Key.** `computeChildInvocationKey({parentRunId: ctx.runId, parentUnitId:
   request.unitId, unitInputHash: inputHash})` (B-N8).
4. **Publish.** `publishChildWorkflowRun` (P3a §5.2) with:

   | Field | Value |
   |---|---|
   | `parentRunId` | `ctx.runId` |
   | `spawnedByUnitId` | `request.unitId` |
   | `invocationKey` | step 3's key |
   | `run.id` | `randomUUID()` — used only on the INSERT path; the SELECT-first contract returns the existing row otherwise |
   | `run.workflowRef` | `target.ref` |
   | `run.scopeKey` | the parent row's `scope_key` |
   | `run.workflowEntryId` | `null` (B-N14) |
   | `run.workflowTitle` | `target.frozenPlan.title` |
   | `run.paramsJson` | `JSON.stringify(childParams)` |
   | `run.currentStepId` | `target.frozenPlan.steps[0]?.stepId ?? null` |
   | `run.agentHarness` / `run.agentSessionId` | copied from the parent row |
   | `run.createdAt` / `updatedAt` / `checkinArmedAt` | `now` |
   | `steps` | `frozenStepRows(target.frozenPlan)` — the same helper `startWorkflowRun` uses (`runs.ts:340`) |
   | `planJson` | `canonicalPlanJson(target.frozenPlan)` |
   | `planHash` | `target.planHash` |

5. **Pre-drive status read.** Re-read the returned child row's `status`.
6. **Drive, or not.**

   | Child status at step 5 | Action |
   |---|---|
   | `active` | `runWorkflowSteps(§3.3.1's options)` |
   | `completed` | `runWorkflowSteps` too — it is a documented pure no-op for a terminal run (`completedRunResult`, `run-workflow.ts:545-553`, which takes no lease). ONE code path |
   | `blocked` | **Skip the drive.** No lease is taken (row A-22) |
   | `failed` | **Skip the drive** (row A-23) |

7. **Map.** Re-read the child row (or reuse step 5's, when the drive was
   skipped) and map its FINAL status through §3.4's table.

#### 3.3.1 The exact `runWorkflowSteps` options

```ts
await runWorkflowSteps({
  target: childRunId,
  ...(ctx.signal ? { signal: ctx.signal } : {}),      // the parent unit's dispatch signal (A-28)
  ...(ctx.dispatcher ? { dispatcher: ctx.dispatcher } : {}),          // A-33
  ...(ctx.maxConcurrency !== undefined ? { maxConcurrency: ctx.maxConcurrency } : {}), // A-34
  ...(ctx.eventSource !== undefined ? { eventSource: ctx.eventSource } : {}),          // A-31
  disposeDispatchResources: () => {},                                 // B-N6, A-24
});
```

Deliberately **not** passed, each with its row: `params` / `parameterFlags`
(a run id with parameters is a `UsageError` by design, `runs.ts:888-892`);
`maxSteps` / `maxRetries` (B-N7, rows A-25/A-26); `loadPlan` (the child's frozen
plan is already the authority); `summaryJudge` (the child builds its own from
its own frozen plan — threading the dispatcher at A-33 is what makes a gated
child testable); `heartbeatScheduler` (the child owns its own lease heartbeat).

`ctx.signal` is the parent unit's dispatch signal, which `executeStepPlan`
derived from `driveRun`'s `dispatchSignal` — the heartbeat controller
(`run-workflow.ts:966`). So a parent Ctrl-C, a parent deadline, a budget abort,
AND a lost parent lease all abort the child drive (rows A-28, A-30).

### 3.4 Status mapping (exact)

`UnitOutcome` gains one LIVE-ONLY field, declared with the same contract
`notices` already carries ("the current contract intentionally excludes them
from durable `result_json`/evidence", `step-work.ts:92`):

```ts
/** Live-only child-run identity for a child-workflow unit. Excluded from durable evidence. */
childRun?: {
  runId: string;
  ref: string;
  status: WorkflowRunStatus;
  currentStepId: string | null;
};
```

It is excluded from the deterministic artifact graph automatically:
`buildEvidence` (`step-work.ts:924`) projects a closed whitelist
(`{unitId, ok, result|text, failureReason}`), so a new field cannot leak into a
hashed artifact. Nothing needs to change there — assert it.

| Child final status | Parent unit | `failure_reason` | Parent STEP | Parent RUN |
|---|---|---|---|---|
| `completed` | `ok: true`, `result` = `workflowRunExportedResult(childRow)` | — | completes normally through the gate | continues |
| `failed` | `ok: false` | `child_workflow_failed` | `failed` (existing reduction) | `failed` |
| `blocked` | `ok: false` | `child_workflow_blocked` | **`blocked`** via `blockStepForChildWorkflow` | `blocked` (via `deriveRunState`) |
| aborted mid-drive | `ok: false` | `aborted` | not finalized — `driveRun` breaks on `options.signal.aborted` | left active/resumable |
| never reached (publication/integrity) | `ok: false` | `child_workflow_publish_failed` | `failed` | `failed` |
| lease held by another driver | `ok: false` | `child_workflow_busy` | `failed` | `failed` |

Failure-reason vocabulary (exact strings, and **none** is a member of
`PROGRAM_RETRY_REASONS`):

```
child_workflow_failed
child_workflow_blocked
child_workflow_publish_failed
child_workflow_busy
```

`child_workflow_failed` error text (exact shape):

```
Child workflow run <childRunId> (<childRef>) failed at step "<childStepId>".
Inspect it with `akm workflow status <childRunId>`; the parent run's step
"<parentStepId>" cannot advance until it succeeds.
```

`blockStepForChildWorkflow`'s notes (exact shape) — the ONE place the resume
sequence is worded, mirroring `judgeFailureNotes` (`step-work.ts:1666`):

```
Step "<parentStepId>" composes child workflow run <childRunId> (<childRef>),
which is blocked at its own step "<childStepId>". Nothing in this run advances
until the child does — a gate is a gate for a child workflow too, so `akm` will
not resume it for you. Clear it with `akm workflow resume <childRunId>`, then
`akm workflow resume <parentRunId>` and `akm workflow run <parentRunId>` to
continue: re-driving the parent drives the resumed child.
```

Two properties this wording pins, each its own test:

- the CHILD is resumed first, and the PARENT's re-drive is what advances it —
  the child drive never calls `resumeWorkflowRun` itself (row A-22);
- the notes name the child run id and both commands verbatim, so the text
  renderer needs no change (B-N15).

`finalizeExecutedStep`'s `!result.ok` arm checks `result.childBlocked` **before**
the `artifactSchemaFailure` retry branch and before the `failed` completion, and
returns `{kind: "child-blocked", summary}`. `runStepGateLoop` maps that kind to
`StepGateLoopOutcome.kind === "child-blocked"`, records
`RunWorkflowResult.childBlocked`, and returns; because the kind is NOT in
`STEP_FINISHED_KINDS`, the blocked step consumes no `maxSteps` allowance — the
same accounting a judge outage already gets.

`akm workflow run`'s exit code is unchanged: `run.status === "blocked"` already
maps to `EXIT_CODES.GENERAL` (`workflow-cli.ts:208-210`).

### 3.5 Cancellation and leases

- The child holds its OWN lease on its OWN row, acquired and released by
  `runWorkflowAttempt` (`run-workflow.ts:314, 350-357`). Nothing new.
- An abort propagates through `ctx.signal` (§3.3.1); the child's `driveRun`
  breaks between steps, `runWorkflowAttempt`'s `finally` releases the child
  lease, and the parent's own `finally` releases the parent lease. Both runs are
  resumable (row A-29).
- A LOST parent lease aborts the child drive through the same signal, then the
  parent's `heartbeat.assertAlive()` throws loudly at the next dispatch boundary
  — the existing path, unchanged (row A-30).
- A live foreign lease on the CHILD makes `acquireRunLease` throw its existing
  `UsageError`. `driveChildWorkflowUnit` catches exactly that shape and converts
  it to `child_workflow_busy`, preserving the holder/expiry text (row A-27).
  It catches nothing else: any other throw out of `runWorkflowSteps` propagates
  and is classified by the existing `dispatch_error` handling.

### 3.6 Why `hashVersion` stays 6

The parent unit's preimage already covers everything the child drive depends on:
`frozenTarget` (P3a §3.3) carries the child ref, `planHash`, `contentHash`,
`via`, `taskRef`, `inputBindings`, and the entire embedded child plan; `params`
and `inputs` cover the resolution scope the bindings read from; `gateFeedback`
covers the loop. Nothing the executor adds is a unit INPUT: the child run id is
minted at dispatch (an output), and the exported result is an output. **A P3b
commit that touches either hash prefix or the `hashVersion` field is a
review-blocking violation** (§0.1, B-N3).

---

## 4. Lane B — outputs, the status tree, `akm workflow plan`

### 4.1 Files

| File | Change |
|---|---|
| `src/workflows/resource-limits.ts` | `WORKFLOW_MAX_OUTPUTS = 64` (new). `WORKFLOW_MAX_PLAN_BYTES`, `WORKFLOW_MAX_COMPOSITION_DEPTH`, `WORKFLOW_MAX_EMBEDDED_CHILD_PLAN_BYTES`, `WORKFLOW_MAX_SCHEMA_BYTES` unchanged. |
| `src/workflows/parser.ts` | `WORKFLOW_KEYS` (`:116`) gains `"outputs"`; `parseOutputs` added beside `parseParams` (`:548`); `WorkflowDocument` carries it. |
| `src/workflows/schema.ts` | `WorkflowDocument.outputs?: Record<string, WorkflowOutputDeclaration>`. |
| `src/workflows/source-ir/schema.ts` | `WorkflowSourceIrV1.outputs?` (`:180-194`); the root `keys(...)` list (`:210-227`) gains `"outputs"`; `validateOutputs` beside `validateParams` (`:233`). |
| `src/workflows/source-ir/compile.ts` | The Markdown→IR mapping (`:88-115`) carries `outputs` through `jsonClone`, exactly as `params` is carried at `:95`. `parseGithubWorkflowSource` is untouched (B-N4). |
| `src/workflows/ir/compile.ts` | `WorkflowPlanDraft.outputs?` (`:91-98`); the draft assembly (`:160-180`) emits it, absent when empty; reference validation (`:338-390`) gains the `from`-names-a-declared-step check (row B-06) and the `params.*` rejection (row B-07). |
| `src/workflows/ir/schema-v4.ts` | `FrozenWorkflowOutput` + `WorkflowPlanGraphV4.outputs?` (`:184-193`); `decodeWorkflowPlanV4`'s `assertKeys` (`:220-224`) and the `planExtraKeys` array (`:231`) each gain `"outputs"`; `decodeWorkflowOutputs` added. **File name and every exported TYPE name unchanged.** |
| `src/workflows/freeze/child-output-references.ts` | **New.** `assertChildOutputReferences(steps)` — the freeze-time first-segment check (§4.4, rows B-28…B-31). Pure over the frozen step list. |
| `src/workflows/ir/freeze-v4.ts` | Carries `compiled.plan.outputs` onto the frozen plan; calls `assertChildOutputReferences(steps)` after `steps` is built and before the plan object is assembled. |
| `src/workflows/runtime/run-outputs.ts` | **New.** `resolveWorkflowRunOutputs(plan, stepRows)` and `workflowRunExportedResult(row)` (§4.3, §4.4). Pure; no IO. |
| `src/workflows/runtime/runs.ts` | `completeWorkflowStep` resolves + persists at completion (§4.3); `WorkflowRunDetail.children?` and `childRunTree` (§4.5); `toWorkflowRunSummary` gains the three conditional fields; `listWorkflowRuns` threads `includeChildren`. |
| `src/core/state/migrations.ts` | Migration `024-workflow-run-outputs` (§4.3). |
| `src/storage/repositories/workflow-runs-repository.ts` | `WorkflowRunRow.outputs_json`; `setRunOutputs`; `ListRunsFilter.includeChildren`; the `parent_run_id IS NULL` predicate on `listRuns` (`:372`), `getActiveRunRowForScope` (`:352`), `findActiveOrBlockedRunForScope` (`:415`). |
| `src/sources/types.ts` | `WorkflowRunSummary` gains `outputs?`, `parentRunId?`, `spawnedByUnitId?` — all optional, all spread conditionally. |
| `src/commands/workflow/plan.ts` | **New.** `akmWorkflowPlan(ref)` → §4.6's envelope. Read-only by construction. |
| `src/commands/workflow-cli.ts` | `workflowPlanCommand` registered in `workflowCommand.subCommands` (`:358-365`); `--children` added to `workflowListCommand` (`:73-76`). |
| `src/output/shapes/passthrough.ts` | `"workflow-plan"` added to `PASSTHROUGH_COMMANDS` (`:66-72`). |
| `src/output/text/workflow.ts` | `{command: "workflow-plan", handler: …}` registered (`:16-23`). |
| `src/output/text/workflow-format.ts` | The `children:` block in `formatWorkflowStatusPlain` (§4.5) and `formatWorkflowPlanPlain` (§4.6). |
| `schemas/akm-workflow.json` | An `outputs` property (`maxProperties: 64`, `propertyNames.pattern` = the param-name pattern, per-entry `{from, schema?}`). `additionalProperties: false` at the root makes this edit mandatory. |

Lane B touches **no** file under `src/workflows/exec/`. Lane A and Lane B file
lists are disjoint.

### 4.2 `outputs:` — the declaration

Authored in Markdown frontmatter only (B-N4):

```yaml
outputs:
  report:
    from: steps.summarize.output
  changed_count:
    from: steps.collect.output.total
    schema: { type: integer, minimum: 0 }
```

Grammar, each rule with its enforcement site:

| Rule | Enforced by | Row |
|---|---|---|
| Name matches `PROGRAM_PARAM_NAME_PATTERN` (`^[A-Za-z_][A-Za-z0-9_]*$`) | `parseOutputs` | B-03 |
| At most `WORKFLOW_MAX_OUTPUTS` (64) entries | `parseOutputs` | B-04 |
| Entry is a mapping with exactly `from` and optional `schema` | `parseOutputs` | B-16 |
| `from` parses through `checkReferenceSyntax` and is a `stepOutput` expression | `parseOutputs` | B-05 |
| `from` names a declared step | `ir/compile.ts` reference validation | B-06 |
| `from` is not `params.<name>` | `parseOutputs` | B-07 |
| `schema` passes `checkSchemaDefinition` (the enforced subset) | `parseOutputs` | B-08 |
| `schema` is at most `WORKFLOW_MAX_SCHEMA_BYTES` | `parseOutputs` | B-09 |

The name pattern is chosen so `steps.<child>.output.<name>` addresses a declared
output under the EXISTING reference grammar — no new expression syntax is added
anywhere.

Frozen shape:

```ts
export interface FrozenWorkflowOutput {
  /** A validated `steps.<id>.output(.<seg>)*` reference into a step artifact. */
  readonly from: string;
  /** Bounded JSON Schema (the `validateJsonSchemaSubset` subset). Absent when undeclared. */
  readonly schema?: Record<string, unknown>;
}

// WorkflowPlanGraphV4 gains:
readonly outputs?: Record<string, FrozenWorkflowOutput>;
```

**Absent, never `{}`** (P2b A-N7, B-N1 reason 2). `decodeWorkflowOutputs`
enforces: non-empty record; sorted-unique keys (canonical wire order, the
`inputBindings` rule at `schema-v4.ts:670-672`); each name matching the pattern;
each entry's closed key set; `from` re-parsing through `parseReference` as a
`stepOutput` whose `stepId` exists in `plan.steps`; `schema`, when present, a
record. Failures go through the module's existing `fail()`.

### 4.3 Resolution at run completion

Migration, appended to `STATE_MIGRATIONS` **and** as the last key of
`STATE_MIGRATION_SAFETY_BY_ID` (both, or module load crashes —
`assertStateMigrationSafetyRegistry`), classified `"additive"`:

```
024-workflow-run-outputs
ALTER TABLE workflow_runs ADD COLUMN outputs_json TEXT;
```

The pure resolver, `src/workflows/runtime/run-outputs.ts`:

```ts
export type ResolveRunOutputsResult =
  | { ok: true; outputs: Record<string, unknown> }
  | { ok: false; errors: string[] };

export function resolveWorkflowRunOutputs(
  plan: WorkflowPlanGraphV4,
  steps: readonly WorkflowRunStepRow[],
): ResolveRunOutputsResult;
```

Algorithm, per declared output, in declaration order:

1. Build the step-output scope with the existing
   `stepOutputsFromEvidence`/`projectStepOutput` pair (`step-work.ts:836-849`)
   over the persisted `evidence_json` of every step row. One scope, built once.
2. Resolve `from` with the existing `resolveReferenceString`. A miss records
   `output "<name>": <the resolver's own message>`.
3. If the resolved value (or any whole-value ancestor on the path) satisfies
   `isTruncatedEvidence`, record
   `output "<name>" reads step "<id>"'s artifact, which exceeded the evidence persistence cap and was not stored` (B-N12, row B-21).
4. If `schema` is declared, run `validateJsonSchemaSubset`; record every error
   prefixed with the output name (row B-22).

`completeWorkflowStep`'s write transaction (`runs.ts:782-858`), immediately
after `const state = deriveRunState(refreshedSteps)` (`:838`):

```ts
if (state.status === "completed" && plan.outputs) {
  const resolved = resolveWorkflowRunOutputs(plan, refreshedSteps);
  if (!resolved.ok) {
    throw new UsageError(
      `Workflow run ${run.id} completed its final step but its declared outputs could not be resolved:\n` +
        resolved.errors.map((e) => `  - ${e}`).join("\n"),
      "WORKFLOW_OUTPUT_INVALID",
    );
  }
  repo.setRunOutputs(run.id, JSON.stringify(resolved.outputs));
}
```

The throw rolls the transaction back — step completion included — so the
observable outcome is fail-before-mutation (B-N13, row B-20). `appendEvent` runs
outside the transaction (`:867`), so no event is emitted either.

`WORKFLOW_OUTPUT_INVALID` is a **new** `UsageErrorCode` member with a
`USAGE_HINTS` entry:

```
Check each `outputs:` entry's `from:` against the step artifact it names, and its
`schema:` against the value that step actually promotes.
```

### 4.4 The exported result

```ts
/**
 * What a completed run EXPORTS: the resolved declared outputs, or `{runId,
 * status}` metadata when the plan declared none. The `{runId, status}` form is
 * synthesized on read and never stored (row B-25).
 */
export function workflowRunExportedResult(row: WorkflowRunRow): Record<string, unknown>;
```

- `outputs_json` non-null → the parsed map (row B-24).
- otherwise → `{ runId: row.id, status: row.status }` (row B-25).

This is exactly what Lane A's completed-child arm promotes as the parent unit's
`result` (row A-19), which the reducer then promotes as the step's `output`
artifact through the unchanged `buildEvidence`/`reduceStepOutcomes` path.

**The freeze-time reference check** (`freeze/child-output-references.ts`) runs
over the frozen step list, after every target is resolved and therefore after
every embedded child plan is available:

For each step, for each reference in the step's `inputs[]`, `map.over`,
`route.input`, and each `reference`-kind `inputBindings[].from`: parse it; if it
is `steps.<S>.output.<first>…` and step `S`'s frozen target has
`kind === "child-workflow"`, then

| Child plan | Accepted first segments |
|---|---|
| declares `outputs` | exactly its declared names |
| declares no `outputs` | exactly `runId` and `status` |

Anything else fails at freeze with `COMPOSITION_INVALID`:

```
Workflow step <stepId> reads "<reference>", but child workflow <childRef>
exports <either "outputs: a, b, c" or "only {runId, status} — it declares no
`outputs:`">. Declare the output in the child's `outputs:` frontmatter, or
reference one of the names above.
```

Only the FIRST segment is checked. Deeper path segments are not statically
knowable (the value's shape is unconstrained unless the output declares a
`schema:`) and resolve at pre-attempt through the existing resolver, failing
with its existing message (row B-31). A reference AT `steps.<S>.output` with no
further segment is always accepted — it names the whole exported object.

### 4.5 `akm workflow status` — the parent-child tree

**Pinned baseline (do this before extending).** `formatWorkflowStatusPlain`
(`src/output/text/workflow-format.ts:34-106`) emits, in order: `workflow:`,
`run:`, `title:`, `status:`, optional `currentStep:`, the `steps:` block (each
`  - <title> [<id>] (<status>)` plus an optional `    notes:` line), then —
only under `--units` — a blank line and the `units:` block, then — only when
stalled — a blank line and the check-in directive. The JSON envelope is
`WorkflowRunDetail` = `{run, workflow: {ref, title, steps}, checkin?, warnings?,
units?}`. Row B-33 asserts both are byte-identical for a childless run; it is a
PRESERVE row and must be written FIRST.

**JSON, additive.** `WorkflowRunDetail` gains:

```ts
children?: WorkflowChildRunNode[];   // absent, never [], when the run has none

export interface WorkflowChildRunNode {
  runId: string;
  workflowRef: string;
  workflowTitle: string;
  status: WorkflowRunStatus;
  /** workflow_runs.parent_unit_id — the parent unit that spawned it. */
  spawnedByUnitId: string;
  /** The parent STEP that unit belongs to; null when its unit row is gone. */
  stepId: string | null;
  currentStepId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Present only when status === "blocked". */
  resume?: { command: string; then: string };
  /** This child's own children. Absent, never [], when it has none. */
  children?: WorkflowChildRunNode[];
}
```

Built by `childRunTree(repo, runId)` from `repo.childRunsOf(runId)` (P3a's
`created_at, id` order), recursively, with `stepId` from
`repo.getUnit(parentRunId, parent_unit_id)?.step_id ?? null` (row B-36). The
recursion is bounded by construction: composition depth is bounded at freeze to
8 (P3a), so the child-run graph is at most 8 deep.

`resume` for a blocked child:

```
command: akm workflow resume <childRunId>
then:    akm workflow resume <rootRunId> && akm workflow run <rootRunId>
```

`WorkflowRunSummary` gains three optional, conditionally-spread fields, so every
non-child envelope is byte-identical (row B-27/B-45):

| Field | Present when |
|---|---|
| `outputs?: Record<string, unknown>` | `outputs_json` is non-null |
| `parentRunId?: string` | `parent_run_id` is non-null |
| `spawnedByUnitId?: string` | `parent_unit_id` is non-null |

**Text, additive.** The `children:` block renders ONLY when `result.children` is
a non-empty array, immediately after the `steps:` block and before the `units:`
block. Glyph table (drawn from the repo's existing vocabulary —
`src/output/text/status-list.ts:24`'s `✗`/`✓` and
`src/output/text/proposal-format.ts:175`'s `→`):

| Child status | Glyph |
|---|---|
| `completed` | `✓` |
| `active` | `→` |
| `blocked` | `⚠` |
| `failed` | `✗` |

Order is **spawn order**, never severity order — the tree is structural, so
`renderStatusEntries`' worst-first sort is deliberately NOT used. Nesting adds
two spaces per level.

```
children:
  - ✓ 4f2b… workflows/leaf [completed] (step "dispatch")
  - ⚠ 91ac… workflows/review [blocked] (step "verify")
      resume: akm workflow resume 91ac…
      then:   akm workflow resume <rootRunId> && akm workflow run <rootRunId>
    - → c30e… workflows/deep [active] (step "inner")
```

`akm workflow list` excludes child rows by default and gains `--children`
(B-N10, rows B-40…B-43).

### 4.6 `akm workflow plan <ref>`

Registration: `defineJsonCommand`, `subCommands.plan` on `workflowCommand`, one
required positional `ref`, and the global `--format` (B-N9). Tier: **Evolving**
(STABILITY.md, §8).

Implementation — `src/commands/workflow/plan.ts`:

```ts
const asset = await loadWorkflowAsset(ref);
const frozen = await compileResolveFreezeWorkflowV4(asset, loadConfig());
```

— the SAME two calls `startWorkflowRun` makes (`runs.ts:263-268`), and then
nothing else. It does **not** call `publishWorkflowRunV4`, `startWorkflowRun`,
`warn()`, `appendEvent`, `akmIndex`, or any repository method.

**Zero durable writes (row B-48), verified, not assumed.** `rg '\bwarn\(' src/workflows/freeze/ src/workflows/ir/ src/workflows/source-ir/` and
`rg 'appendEvent|recordUsage' src/workflows/freeze/ src/workflows/ir/` are both
empty at head: freeze itself emits no event and writes no warn log. Every
`warn()` on the start path lives in `startWorkflowRun` (`runs.ts:279-281,
:360-364`), which this verb does not call — `collectWorkflowWarnings` is called
directly and its lines are returned in the envelope's `warnings[]` (row B-56).
The env-audit `appendEvent` calls are in `prepareStepDispatchPrerequisites`
(`native-executor.ts`), which runs at DISPATCH, not at freeze. The test asserts
row counts across `workflow_runs`, `workflow_run_steps`, `workflow_run_units`,
`workflow_run_unit_attempts`, and the events table before and after.

**Envelope (`--format json`), exact key set:**

```
ok, ref, title, sourceFormat, sourcePath, irVersion, planHash, published,
execution{maxConcurrency}, budget?{maxTokens?,maxUnits?}, params?, outputs?,
steps[], sourceReadSet[], notices[], warnings[]
```

`published` is the literal `false`, present so a consumer can never mistake this
for a run envelope.

Each `steps[]` entry:

```
stepId, sequenceIndex, kind ("unit"|"map"|"route"), targetKind
("command"|"shell"|"script"|"child-workflow"|null), concurrency?, inputs[],
environment[], inputBindings?[], gate{criteria,maxLoops,judgeEngine},
outputSchema?, expansion
```

`expansion` is the task/child boundary:

| `expansion` | When |
|---|---|
| `{via: "direct"}` | an ordinary step |
| `{via: "task", taskRef}` | the step's target was reached through a `tasks/<ref>` |
| `{via: "child", childRef, childPlanHash, childVia, childTaskRef?, childOutputs, steps[]}` | a `child-workflow` target; `steps[]` is the child's own step list, recursively, in the identical shape |

**The closed print list, and what is deliberately never printed.** The
secret-free discipline is P2b's B-N4, applied here:

| Printed | Never printed |
|---|---|
| `inputBindings[].name` / `.kind` | any resolved reference VALUE (references resolve at pre-attempt; there is nothing to resolve here) |
| a `literal` binding's `.value` | a `literal` **environment** binding's `.value` |
| a `reference` binding's `.from` | `request.command.content`, `request.persona`, `request.conversation` |
| `environment[].kind` / `.name` | `request.runtime.environment` |
| an `env-ref`'s `.ref` / `.keys` / `.secretNames` (all NAMES) | a script target's `bytesBase64` |
| `gate.judgeEngine` (the engine NAME) | any credential, token, or engine `apiKey` |

Row B-53's sentinel test plants a distinct sentinel in a command body, a
persona, script bytes, and an `env:` literal, and asserts none appears in either
mode's bytes.

**Text mode** is a human summary of the same data:

```
workflow: team//workflows/release (markdown)
source:   workflows/release.md
plan:     irVersion 5, hash 4f2ba91c3d0e… (not published)
limits:   maxConcurrency 4; budget max_units 50, max_tokens 100000
params:   channel, version
outputs:  report <- steps.summarize.output
steps:
  1. notify   [command]        direct
  2. build    [script]         via tasks/plan-v4-task
  3. dispatch [child-workflow] -> workflows/release-checklist (plan 91acbe20f5d1…)
       with: channel="stable" (literal), files <- steps.build.output.files (reference)
       exports: report, changed_count
       3.1 verify [command] direct
  4. summarize [command]       direct
read set:
  workflows/release.md
  commands/notify.md
  workflows/release-checklist.md
notices:
  ! lowering[warn] <code> (<adapter>): <message>
warnings:
  ! <compile warning>
```

`tests/contracts/command-cli-contract.test.ts` gains a `workflow plan` arm in
the SAME commit (F-B4), mirroring its existing `task explain` arm.

---

## 5. Lane C — crash windows, replay, contention, fixtures

### 5.1 Files

| File | Contents |
|---|---|
| `tests/integration/workflow-child-crash-windows.test.ts` | **New.** Rows C-01…C-04, using `tests/integration/_helpers/workflow-crossproc.ts` unchanged. |
| `tests/integration/workflows/child-replay-determinism.test.ts` | **New.** Rows C-05…C-07, mirroring `chaos.test.ts`'s in-process patterns. |
| `tests/fixtures/execution-contracts/workflows/child-workflow/**` | **New.** The four-workflow family (§5.4). |
| `tests/fixtures/execution-contracts/workflows/manifest.json` | **Edited (F-C1).** One new top-level `childWorkflow` key. |
| `tests/workflows/characterization-fixture-contracts.test.ts` | **Edited (F-C2).** A new `describe` for the family; every pre-existing `describe` byte-unchanged. |

Lane C adds no `src/**` file and edits exactly one pre-existing non-test file.

### 5.2 Crash windows

The technique is `tests/integration/workflow-crash-windows.test.ts`'s, verbatim:
a real `bun` child running `tests/integration/_helpers/workflow-chaos-runner.ts`
against the parent's isolated storage, synchronized on marker files and journal
polling (never a sleep), SIGKILLed at a precise durable window, then
`expireLease` and a fresh process. The helper needs **no change**: the CHILD's
units dispatch through the same seam and write the same markers, so
`dispatchCount(markerDir, <childUnitId>)` already counts them.

| Window | Kill point | Durable state at the kill | Resume must |
|---|---|---|---|
| **CW-1** (C-01) | The child row is published; no child unit has dispatched | one `workflow_runs` row with `parent_run_id`; one `workflow_started` event; the parent unit row `running` | find the child by `invocation_key`, drive it to completion, publish NO second child, emit NO second `workflow_started` |
| **CW-2** (C-02) | A child unit row is `running` | both runs `active`, both leases orphaned | after lease expiry: re-dispatch exactly that one child unit (marker count goes 1→2 for it, stays put for every other), complete both runs |
| **CW-3** (C-03) | The child run is `completed`; the parent unit row is still `running` | child terminal, parent unit unfinished | complete the parent unit from the child's exported result and dispatch **zero** child units (every child marker count unchanged) |

CW-3 is the row that proves the child's own journal is what prevents
re-execution: the parent unit re-dispatches (a `running` row is not reusable),
re-enters `driveChildWorkflowUnit`, republishes idempotently, and
`runWorkflowSteps` on a `completed` child is the documented no-op
(`completedRunResult`) — no lease, no dispatch.

### 5.3 Two-parent contention on one child (C-04)

Two `bun` children drive the same parent run's composing step against the same
storage. The first to `acquireRunLease` on the CHILD drives it; the second's
`driveChildWorkflowUnit` catches the lease `UsageError` and returns
`child_workflow_busy`. Asserted: exactly one child row; exactly one
`workflow_started` event; the loser's parent unit row carries
`failure_reason = "child_workflow_busy"` and its message contains the winner's
holder id; the loser's parent run is `failed` and resumable; a subsequent resume
of the loser converges on the SAME child.

The parent's own run lease already prevents two engines driving one PARENT — the
pre-existing `run-lease.test.ts` guarantee. C-04 is the CHILD-row analogue and
must exercise the real index and the real lease, never a mocked repository.

### 5.4 Replay determinism (C-05, C-06)

Mirroring `chaos.test.ts`: run a composing parent to completion with an injected
dispatcher that records every call; snapshot the parent's
`workflow_run_steps.evidence_json` for the composing step; then resume the same
run in a fresh invocation and assert

- `driveChildWorkflowUnit` is never entered (the parent unit reuses its
  completed row through `classifyUnitReuse`),
- the dispatcher records **zero** new calls,
- the re-read step evidence is **byte-identical** to the snapshot.

C-07 keeps the existing `replay_divergence` guard honest: tampering with the
composing unit row's `input_hash` fails the resume loudly with the unchanged
message, exactly as it does for any other target kind.

### 5.5 The fixture family

`tests/fixtures/execution-contracts/workflows/child-workflow/`, registered under
a new `childWorkflow` manifest key with the same shape `planV4` uses:

| id | Parent | Child(ren) | Proves |
|---|---|---|---|
| `direct-child` | `workflows/direct-child.yml` | `workflows/leaf.yml` | `uses: workflows/<ref>` freezes to `kind: "child-workflow"`, `via: "direct"` |
| `task-wrapped-child` | `workflows/task-wrapped-child.yml` + `tasks/wrap-leaf.yml` | `workflows/leaf.yml` | `via: "task"` with `taskRef` |
| `child-with-outputs` | `workflows/child-with-outputs.yml` | `workflows/exporter.md` | a **Markdown** child declaring `outputs:`; the embedded child plan carries `outputs`; a parent reference to a declared name freezes |
| `three-level` | `workflows/three-level.yml` | `workflows/mid.yml` → `workflows/leaf.yml` | recursive embedding, three levels, each `planHash` verified |

Manifest fragment:

```json
"childWorkflow": {
  "description": "Source fixtures (not byte-snapshots) that freeze end to end into durable plans containing child-workflow targets. bundleRoot's subtree is copied verbatim into a sandboxed stash and indexed before each ref below is frozen.",
  "bundleRoot": "child-workflow",
  "workflows": [ { "id": "...", "file": "...", "ref": "...", "expectedStepTargetKinds": { }, "expectedChildRefs": { }, "expectedChildDepth": 1 } ],
  "expectedTargetKindSet": ["child-workflow", "command", "shell"]
}
```

The registration test differs from `planV4`'s in exactly one way and the
difference must be commented: it enumerates `*.yml` **and** `*.md` under
`child-workflow/workflows/`, because a parent must be GitHub-shaped (only
`jobs.<id>.steps[].uses` composes) while a child declaring `outputs:` must be
Markdown (B-N4). `planV4`'s `.yml`-only enumeration is byte-unchanged.

The structural test mirrors
`characterization-fixture-contracts.test.ts`'s `plan-v4` freeze test: freeze
through `startWorkflowRun`, decode the stored `plan_json`, assert
`stepTargetKinds(plan)` equals the manifest's map, and additionally walk each
`child-workflow` target asserting `frozenPlan.irVersion === 5`,
`computePlanHash(frozenPlan) === planHash`, and — for `three-level` — a chain
depth of 3.

---

## 6. AUTHORIZED-FLIPS table

Every pre-existing test whose expectations change in P3b, with the exact site
and the exact new expectation. **An edit to any pre-existing test not listed
here is a review-blocking violation.** New test files are §7, not here.

The list below was built by grepping, at head, for every test that (a) pins a
`workflow` verb's registration or output shape, (b) references
`WORKFLOW_CHILD_EXECUTION_UNSUPPORTED` or the child-workflow dispatch guard, (c)
asserts a run-completion path, or (d) asserts an exhaustive plan/`UsageErrorCode`
key set. Each grep and its result is recorded in the "Explicitly NOT flipped"
table so a reviewer does not have to re-derive it.

### F-A1 — `child-workflow-dispatch-guard.test.ts` (Lane A)

`tests/workflows/child-workflow-dispatch-guard.test.ts` — the whole file's
premise flips (B-N11). It stays a file; it does not become a new one.

- The header comment (`:5-36`) is rewritten: after P3b, reaching
  `dispatchWorkflowExecution` with a `child-workflow` target means the child
  executor seam (`src/workflows/exec/child-workflow.ts`) was bypassed — an
  engine routing bug — not an unimplemented feature.
- `:82-92` and `:94-102` — both entry points now throw a plain `Error`; the
  `expect(caught).toBeInstanceOf(UsageError)` and
  `expect(err.code).toBe("WORKFLOW_CHILD_EXECUTION_UNSUPPORTED")` assertions
  become `expect(caught).not.toBeInstanceOf(UsageError)` plus a message
  assertion naming `child-workflow.ts`. The `expect(err.message).toContain(...)`
  ref/unit-id assertions and the
  `expect(err.message).not.toContain("is not a command target")` assertion are
  **kept unchanged** — they are exactly the R8 properties that must survive.
- `:104-111` — the `USAGE_HINTS` test is **removed**: the code no longer exists,
  so there is no hint to assert.
- `:113-134` — the ordinary-target negative control is **byte-unchanged**.
- `childWorkflowRequest` (`:52-70`) is **byte-unchanged**.

### F-A2 — `tests/workflows/hash-v6.test.ts` (Lane A) — verify, do not edit

Listed here because a reviewer will reach for it. P3b changes neither hash
prefix nor the preimage field list (§3.6, B-N3), so this file is
**byte-unchanged** and is a §7 preservation gate, not a flip. Its A-15 test (a
changed embedded child `planHash` changes the parent unit hash) is precisely the
property Lane A's `invocation_key` derivation depends on.

### F-B1 — `tests/integration/workflows/schema-drift.test.ts` needs NO edit

Verified at head: the file pins the dispatch-significant bounds
(`WORKFLOW_MAX_GATE_LOOPS`, `WORKFLOW_MAX_CONCURRENCY`, `WORKFLOW_MAX_RETRIES`,
`WORKFLOW_MAX_TIMEOUT_MS`, engine-name pattern/length), the program enums, the
`budget` key set, and a set of `not.toContain` / `in` root assertions
(`:85-108`). It never enumerates the root property list exhaustively, and it
does not assert `params.maxProperties`. Adding an `outputs` property with
`maxProperties: 64` is therefore invisible to it. `WORKFLOW_MAX_OUTPUTS` is an
authoring-document bound, not a dispatch-significant one, so it is deliberately
**not** added to this pin (A-N10's rule, applied). §7 gate.

### F-B2 — `tests/integration/commands/workflow-cli-envelope.test.ts` (Lane B)

One additive arm only; every existing test in the file is **byte-unchanged**.
A new test asserts `akm workflow plan workflows/release-flow --format json`
returns exit 0 and an envelope carrying `ok`, `planHash`, `published: false`,
and a `steps` array — the same additive convention P2b used for `task explain`.
The pre-existing `workflow create` / `list` / `run + status` / `create --print`
/ not-found / retired-`next` tests are untouched; row B-33's byte-identity claim
is asserted against this file's existing `status` test.

### F-B3 — `tests/completions.test.ts` needs NO edit

Verified: its top-level list (`:73-90`) contains `"workflow"` but never
enumerates the workflow SUBCOMMANDS; the only workflow-subcommand assertions
(`:181`, `:201-204`) are about `workflow create`'s `--from` flag-value scoping.
Registering `plan` is invisible to it. §7 gate.

### F-B4 — `tests/contracts/command-cli-contract.test.ts` (Lane B)

Additive, in the SAME commit that registers the verb (§1.2's binding
instruction, and the exact convention its own P2b comment at `:27-31` records).
A third `describe`, "canonical workflow CLI surface", asserting
`main.subCommands.workflow === workflowCommand`, that
`workflowCommand.subCommands.plan.args.ref` matches
`{type: "positional", required: true}`, and that `…plan.args.format` matches
`{type: "string"}`. The existing `command run` and `task explain` describes are
**byte-unchanged**.

### F-B5 — `tests/integration/cli-errors.test.ts` needs NO edit

Verified: its `READ_ONLY_VERBS` list (`:414-423`) is a curated set of verbs that
take **no required args**; `workflow plan <ref>` takes a required positional and
so does not belong in it, by that list's own stated rule (`:411-413`). The
shape-registry guard it implements is instead satisfied by F-B2's envelope arm,
which exercises the real `workflow-plan` shape end to end. §7 gate.

### F-C1 — `tests/fixtures/execution-contracts/workflows/manifest.json` (Lane C)

One new top-level key, `childWorkflow` (§5.5). The `schemaVersion`,
`equivalent`, `currentFreeze`, `currentFreezeWithSchema`, `rejected`,
`singleJob`, and `planV4` keys are **byte-unchanged**. The
`WorkflowsManifestFragment` interface in
`characterization-fixture-contracts.test.ts` reads only the keys it declares, so
this addition breaks nothing (it is extended by F-C2 in the same commit).

### F-C2 — `tests/workflows/characterization-fixture-contracts.test.ts` (Lane C)

Additive only:

- `WorkflowsManifestFragment` (`:115-118`) gains `childWorkflow`, and a
  `ChildWorkflowManifestEntry` interface is added beside `PlanV4ManifestEntry`
  (`:109-113`).
- Two new `describe` blocks are appended, mirroring the `plan-v4` pair: a
  registration test (`.yml` **and** `.md`, §5.5) and a freeze/structural test.
- **Every pre-existing block is byte-unchanged**, including
  `"workflows/plan-v4 fixture registration"` (`:225-236`), the `irVersion 5`
  freeze test (`:263-269`), the `expectedTargetKindSet` characterization
  (`:279`), and the task-composed read-set characterization (`:290`). Row C-13
  asserts this.

### Explicitly NOT flipped (verified at head, do not edit)

| File | Grep run | Result |
|---|---|---|
| `tests/workflows/hash-v6.test.ts` | prefix / `hashVersion` pins | P3b changes neither (F-A2) |
| `tests/workflows/task-binding-identity.test.ts` | `WORKFLOW_IR_V5_VERSION`, `\0v6\0`, two-freeze determinism | unchanged: no version bump, and `outputs` is absent on a plan that declares none (B-N1) |
| `tests/integration/workflows/frozen-plan.test.ts` | `irVersion` / `executionSupport` pins | unchanged: `irVersion` stays 5 |
| `tests/integration/workflows/chaos.test.ts`, `tests/integration/_helpers/workflow-chaos-runner.ts` | run-completion + resume paths | unchanged: non-child runs take no new code path |
| `tests/integration/workflows/run-lease.test.ts` | lease arbitration | unchanged: the child uses the SAME lease code on its own row |
| `tests/integration/workflow-crash-windows.test.ts` | SIGKILL windows | unchanged: P3b adds a sibling file, never edits this one |
| `tests/integration/workflows/v4-atomic-publication-red.test.ts` | parent publication atomicity | unchanged: `publishChildWorkflowRun` has its own suite and does not join this one |
| `tests/integration/storage/child-run-publication.test.ts` | P3a Lane C storage contract | unchanged: P3b calls the API, it does not change it |
| `tests/integration/tasks-runtime-v3-runner.test.ts` | fail-before-mutation canary | unchanged (B-N13) |
| `tests/core/errors-usage-hints.test.ts` | `NEW_CODE_HINTS` covers P1a's five codes; the regression guard pins `INVALID_FLAG_VALUE` only | removing `WORKFLOW_CHILD_EXECUTION_UNSUPPORTED` and adding `WORKFLOW_OUTPUT_INVALID` are both invisible to it |
| `tests/integration/workflows/status-units.test.ts`, `tests/integration/workflow-cli.test.ts`, `tests/integration/workflows/checkin-surfacing.test.ts`, `tests/integration/workflows/plan-v4-retirement.test.ts` | `rg 'toEqual\(\{' <files>` returns only `parseWorkflowRefInput` rows in `workflow-cli.test.ts` | no whole-object status assertion exists, so the additive `children` / `run.outputs` fields are invisible |
| `tests/integration/workflows/schema-drift.test.ts` | root property enumeration | none exists (F-B1) |
| `tests/completions.test.ts` | workflow subcommand enumeration | none exists (F-B3) |
| `tests/integration/cli-errors.test.ts` | `READ_ONLY_VERBS` | `workflow plan` is out of scope by that list's own rule (F-B5) |
| `tests/fixtures/execution-contracts/workflows/plan-v4/**` | family contents | sources, not plan bytes; the family keeps its name and contents (row C-13) |

---

## 7. Preservation gates (the reviewer runs these)

- [ ] `bun run check` green.
- [ ] Every P3a suite green: `tests/workflows/child-workflow-freeze.test.ts`,
      `tests/workflows/child-workflow-limits.test.ts`,
      `tests/workflows/plan-v5-schema.test.ts`,
      `tests/workflows/child-invocation-key.test.ts`,
      `tests/integration/workflows/plan-version-policy.test.ts`,
      `tests/integration/storage/child-run-publication.test.ts`,
      `tests/integration/workflows/child-freeze-read-set.test.ts` — all
      **byte-unchanged**.
- [ ] `tests/workflows/hash-v6.test.ts` green and **byte-unchanged** (F-A2).
- [ ] `tests/integration/workflows/frozen-plan.test.ts` green and
      **byte-unchanged**.
- [ ] `tests/integration/workflows/chaos.test.ts` and
      `tests/integration/_helpers/workflow-chaos-runner.ts` green and
      **byte-unchanged**.
- [ ] `tests/integration/workflows/run-lease.test.ts` green and
      **byte-unchanged**.
- [ ] `tests/integration/workflow-crash-windows.test.ts` green and
      **byte-unchanged**.
- [ ] `tests/integration/workflows/v4-atomic-publication-red.test.ts` green and
      **byte-unchanged**.
- [ ] `tests/integration/tasks-runtime-v3-runner.test.ts` green and
      **byte-unchanged** (fail-before-mutation, B-N13).
- [ ] `tests/integration/workflows/schema-drift.test.ts` green and
      **byte-unchanged** (F-B1).
- [ ] `tests/completions.test.ts` green and **byte-unchanged** (F-B3).
- [ ] `tests/integration/cli-errors.test.ts` green and **byte-unchanged** (F-B5).
- [ ] `tests/workflows/task-binding-identity.test.ts` green and
      **byte-unchanged** — two freezes of a source declaring no `outputs:` are
      still byte-identical, at plan hash AND unit hash (B-N1 reason 2).
- [ ] The migration position/safety registry test green
      (`024-workflow-run-outputs` last in **both** `STATE_MIGRATIONS` and
      `STATE_MIGRATION_SAFETY_BY_ID`, classified `"additive"`).
- [ ] `tests/architecture/import-cycle-ratchet.test.ts` green:
      `src/execution/**` still imports nothing from `src/workflows/**`, and
      `src/workflows/exec/child-workflow.ts` closes no cycle with
      `run-workflow.ts` (it is imported BY the executor and imports
      `runWorkflowSteps`; if the ratchet objects, the drive is reached through
      an injected function value, the pattern `freeze-v4.ts`'s `ChildFreezeFn`
      already establishes — record the choice in the Review log).
- [ ] `rg WORKFLOW_CHILD_EXECUTION_UNSUPPORTED src/ tests/` returns **zero**
      hits (row A-04).
- [ ] `rg 'akm\.workflow\.(unit|gate)\\0v5\\0' src/ tests/` returns **zero**
      hits, and `rg 'hashVersion: 7|WORKFLOW_IR_V6' src/` returns **zero** hits
      (§0.1).
- [ ] `rg 'irVersion' src/workflows/ir/schema-v4.ts` shows `5`, unchanged.
- [ ] `bun run lint` includes the doc-examples check; every `akm …` example
      added in §8 is lint-doc-examples-clean, and none of them spells `--json`
      (B-N9).
- [ ] For a workflow with no `outputs:` and no child steps:
      `akm workflow status`, `list`, `run`, `resume`, and `abandon` produce
      **byte-identical** stdout and JSON envelopes to the same commands at
      `6ec07482` (Stable tier; row B-33/B-45 — capture the baseline in commit 2,
      before any Lane B `src/**` change lands).

New suites this phase adds (these are NOT flips):

| File | Covers |
|---|---|
| `tests/workflows/child-executor-seam.test.ts` | Rows A-01…A-06 |
| `tests/integration/workflows/child-execution.test.ts` | Rows A-07…A-27 |
| `tests/integration/workflows/child-cancellation.test.ts` | Rows A-28…A-30 |
| `tests/integration/workflows/child-nesting.test.ts` | Rows A-31…A-36 |
| `tests/workflows/workflow-outputs-source.test.ts` | Rows B-01…B-17 |
| `tests/integration/workflows/workflow-outputs-runtime.test.ts` | Rows B-18…B-27 |
| `tests/workflows/child-output-references.test.ts` | Rows B-28…B-32 |
| `tests/integration/workflows/status-tree.test.ts` | Rows B-33…B-45 |
| `tests/commands/workflow-plan.test.ts` | Rows B-46…B-59 |
| `tests/integration/workflow-child-crash-windows.test.ts` | Rows C-01…C-04 |
| `tests/integration/workflows/child-replay-determinism.test.ts` | Rows C-05…C-07 |

---

## 8. Docs that ride with the code

| File | Contents |
|---|---|
| `docs/reference/workflow-schema.md` | A new `outputs:` section beside "What a step's output is" (§4.2's grammar, the bounds, the Markdown-only note and why — B-N4, the `outputSchema` distinction — B-N2, and the `{runId, status}` default). The "Child workflows" section's **"What is not yet available"** subsection (`:198-212`) is REPLACED by "Child execution": the status mapping table (§3.4), the blocked-child resume sequence, the retry/resume identity rule, and the note that a child is driven inline by its parent's process. The composition-limits table is byte-unchanged. |
| `docs/reference/workflows.md` | The child-workflow paragraph (`:67`) drops `WORKFLOW_CHILD_EXECUTION_UNSUPPORTED` and gains one paragraph on what running a composing workflow now does, with a pointer to the status tree. |
| `docs/guides/run-workflows.md` | A new "Child runs" section after "Check status": reading the tree, the blocked-child three-command recovery (§3.4's exact sequence), that `akm workflow list` hides children and `--children` shows them, and that `akm workflow status <childRunId>` works directly. |
| `docs/reference/cli.md` | The `akm workflow` synopsis block (`:553-562`) gains `akm workflow plan workflows/<name>` and `akm workflow list --children`; a `akm workflow plan` subsection beside the `status` one (`:696-710`) documents the two modes, the zero-writes guarantee, and the secret-free print list. |
| `docs/architecture/workflow-engine.md` | The child-workflow section (`:79`) is corrected: the dispatch seam (§3.2), the drive contract (§3.3), why `runWorkflowSteps` is reused rather than a second executor (B-N5), and why `hashVersion` stays 6 (§3.6). A short "Run outputs" subsection covers resolve-at-completion and the rollback rule (B-N13). |
| `CHANGELOG.md` `[Unreleased]` | Three entries. (1) Under a feature heading: **child workflows now execute** — the status mapping, the blocked-child resume flow, and that a parent retry/resume reuses the same child. (2) **Workflow `outputs:`** — the declaration, the exported result, and the `{runId, status}` default. (3) **New verb `akm workflow plan`** (Evolving). Plus a correction line: the P3a entry at `:150` naming `WORKFLOW_CHILD_EXECUTION_UNSUPPORTED` is amended to say that code existed only in the P3a increment and is gone in the shipped release. |
| `docs/migration/v0.9.1-to-v0.9.2.md` | The "Workflow cutover" section (`:110`) gains a short subsection: nothing to migrate for child execution (no stored child run predates this release), plus the one operational note that `akm workflow list` hides child runs by default. |
| `STABILITY.md` | One row in the tier table (`:60-65`): `` `akm workflow plan` `` | Evolving | New in 0.9.2; envelope shape may change. The five existing workflow rows are byte-unchanged. |

Every `akm` example must pass the doc-examples lint that `bun run lint` runs,
and none may spell `--json` (B-N9).

---

## 9. Acceptance criteria

**Structure**

- [ ] `src/workflows/exec/child-workflow.ts` is the **only** module that
      publishes or drives a child run; `native-executor.ts` calls into it and
      contains no child logic of its own.
- [ ] `driveRun` is **not** exported from `run-workflow.ts`; the child drive
      goes through `runWorkflowSteps` (B-N5).
- [ ] The child drive passes a no-op `disposeDispatchResources`, no `maxSteps`,
      and no `maxRetries` (B-N6, B-N7).
- [ ] `WORKFLOW_IR_V5_VERSION === 5`; both hash prefixes read `\0v6\0`; the
      `hashVersion` preimage field reads `6`; the child-invocation prefix reads
      `\0v1\0` (§0.1).
- [ ] `WorkflowPlanGraphV4.outputs` is absent — never `{}` — when nothing is
      declared, and `computePlanHash` is byte-identical to P3a's for every
      workflow that declares none (B-N1).
- [ ] `WORKFLOW_MAX_OUTPUTS` lives in `src/workflows/resource-limits.ts`;
      `WORKFLOW_MAX_PLAN_BYTES`, `WORKFLOW_MAX_COMPOSITION_DEPTH`, and
      `WORKFLOW_MAX_EMBEDDED_CHILD_PLAN_BYTES` are unchanged.
- [ ] `024-workflow-run-outputs` is the last entry of `STATE_MIGRATIONS` **and**
      the last key of `STATE_MIGRATION_SAFETY_BY_ID`, classified `"additive"`.
- [ ] `WORKFLOW_CHILD_EXECUTION_UNSUPPORTED` is gone from the `UsageErrorCode`
      union and from `USAGE_HINTS`; `WORKFLOW_OUTPUT_INVALID` is present in both.
- [ ] Lane A's and Lane B's file lists (§3.1, §4.1) are disjoint; Lane C adds no
      `src/**` file.
- [ ] `src/commands/workflow/plan.ts` imports nothing from
      `src/workflows/runtime/runs.ts` beyond the asset loader, and never calls
      `startWorkflowRun`, `publishWorkflowRunV4`, `warn`, `appendEvent`, or
      `akmIndex`.

**Behavior**

- [ ] Every PRESERVE row of §2 holds, verified by its cited test.
- [ ] Every NEW row of §2 has at least one test asserting its reason/code **and**
      its message text.
- [ ] A child-workflow unit never reaches `UnitDispatcher`, and still journals
      its own attempt row (A-01, A-02).
- [ ] The three key inputs produce one child; a second call with the same three
      returns the same child; a changed `gateFeedback` produces a different one
      (A-07, A-13, A-16).
- [ ] Completed / failed / blocked / aborted / publication-failure / busy each
      map to §3.4's exact row, with the exact failure reason and message
      (A-19…A-23, A-27, A-28).
- [ ] A blocked child blocks the parent RUN, and the notes name the child run id
      and the three-command sequence verbatim (A-21).
- [ ] An abort leaves BOTH runs resumable with no live lease (A-29).
- [ ] A three-level composition drives to completion and produces three linked
      run rows (A-35).
- [ ] `outputs:` parses, compiles, freezes, resolves at completion, and is
      exported; a run without a declaration exports `{runId, status}`
      (B-01…B-25).
- [ ] An unresolvable / truncated / schema-violating output rolls the completion
      back with `WORKFLOW_OUTPUT_INVALID`, leaving the step `pending` and the run
      `active` (B-20…B-22).
- [ ] A parent reference to an undeclared child output fails at FREEZE with
      `COMPOSITION_INVALID`; a deeper path fails at pre-attempt (B-29…B-31).
- [ ] `akm workflow status` on a childless run is byte-identical, envelope and
      text (B-33).
- [ ] Child runs are hidden from `list`, from the scope-attach path, and from
      `akm show`'s guard (B-40, B-42, B-43).
- [ ] `akm workflow plan` writes **zero** rows across all five tables and emits
      no warn log (B-48), and leaks no sentinel in either mode (B-53).
- [ ] All three crash windows converge with no duplicate child and no re-run
      child unit (C-01…C-03); two parents contending on one child produce one
      child row and one `child_workflow_busy` (C-04).
- [ ] A resumed parent replays its completed composing step byte-identically,
      with zero dispatcher calls (C-05, C-06).

**Gates**

- [ ] Every §7 checkbox ticked.
- [ ] Every §8 doc updated in the same commit range, examples lint-clean.
- [ ] No pre-existing test outside §6 was edited.

---

## Review log
