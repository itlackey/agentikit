# Workflow Engine: Buy vs Build

Status: DECISION RECORD — A/B investigation complete, recommendation stated
Date: 2026-08-01
Question: can a third-party library offload the maintenance burden of akm's
hand-rolled workflow/task engine?
Constraints (owner): no server; markdown authoring preserved (simple
JSON/YAML acceptable only if markdown becomes cumbersome).
Evidence: [`reviews/task-workflow-unification/library-eval-*.md`](./reviews/task-workflow-unification/)
Companion: [`task-workflow-format-unification.md`](./task-workflow-format-unification.md)
(Design A's authoring/config layer, independently reviewed across five rounds)

---

## 0. Answer

**Build — keep the engine.** Not for lack of a good library: OpenWorkflow is
genuinely well-built and empirically durable. The blocker is that the thing
being "offloaded" is mostly not there. Measured against the actual tree,
**~7% of `src/workflows/exec` + `ir` is the generic durable-execution
concern these libraries sell**; the other ~93% is akm's product and would
survive adoption unchanged — while adoption *subtracts* capabilities the
engine has today.

Take the dependency **below** the engine instead, and cut scope **above**
it (§7). That is where the maintenance burden actually is.

## 1. Method

Three independent Opus investigations, all forbidden from relying on
training knowledge — every claim verified against live artifacts:

| Investigation | Scope | Report |
|---|---|---|
| bunqueue | Full rubric + source read | [`library-eval-bunqueue.md`](./reviews/task-workflow-unification/library-eval-bunqueue.md) |
| OpenWorkflow | Full rubric + **executed** (SIGKILL durability probe, schema-collision repro) | [`library-eval-openworkflow.md`](./reviews/task-workflow-unification/library-eval-openworkflow.md) |
| Landscape | 25+ candidates against the hard constraints | [`library-eval-alternatives.md`](./reviews/task-workflow-unification/library-eval-alternatives.md) |

Rubric derived from what the engine demonstrably does (established across
the five review rounds behind the companion spec): embedded in a
short-lived CLI process; crash-resume from `state.db`; completed-unit reuse
keyed on **content hashes**; map fan-out with concurrency caps and
reducers; minutes-long units with leases and stall recovery; judged gate
loops; and the `brief`/`report` driver protocol.

## 2. The decisive measurement

`src/workflows/exec` + `src/workflows/ir` = **8,705 LOC**. Composition:

| Component | LOC | Would a library replace it? |
|---|---|---|
| `brief.ts` + `report.ts` — external-driver protocol | **2,690 (31%)** | No — no library has an analogue |
| `ir/` — schema, compile, freeze, plan hash, params | 1,635 | No — determinism/replay identity is akm's contract |
| Dispatch, gates, worktrees, step-work | ~3,750 | No — agent/LLM dispatch, judged gates, redaction |
| Journal/resume/lease/concurrency plumbing | **~630 (7%)** | **Yes — this is the addressable surface** |

Rows sum to 8,705. The plumbing row is a *region* count, not a file-level
partition — no whole-file split yields it (the only fully generic files are
`scheduler.ts` 118 + `unit-writer.ts` 29). The defensible band is ~490–720,
depending on whether the journal-row rehydration helpers and the gate
resume seed count as plumbing or as product; the conclusion is unchanged
anywhere in that band.

For calibration, the generic concurrency concern is `src/core/concurrent.ts`
(40) + `src/workflows/concurrency-policy.ts` (20) = **60 lines** — both of
which sit *outside* the 8,705.

A dependency that replaces 7% while adding an integration seam, a schema
bridge, and a pre-1.0 upstream is not a burden transfer. It is a burden
trade at unfavourable odds.

## 3. Candidate results

| | bunqueue | OpenWorkflow | Weft | Mastra | XState v5 |
|---|---|---|---|---|---|
| License | MIT | Apache-2.0 | MIT | Apache-2.0 | MIT |
| Server-free | ⚠ single-process only | ✅ | ⚠ single-engine only | ✅ | ✅ |
| SQLite durability + resume | ⚠ name-keyed | ✅ *(SIGKILL-verified)* | ✅ | ⚠ snapshot, no lease | ❌ |
| Bounded fan-out + reducer | ❌ | ❌ *(issue #20, 9mo)* | ⚠ | ✅ | ⚠ |
| Error-classified retry | ❌ | ❌ | ⚠ | ⚠ | ⚠ |
| Per-step timeout / cancel | ⚠ 30s default | ❌ *(no AbortSignal)* | ⚠ | ✅ | ✅ |
| Windows CI | ❌ | ❌ | ✅ target | ⚠ | ✅ |
| Bus factor | 1 | 1 | 1 | team | team |
| **% of exec+ir deletable** | **0–3%** | **8–12%** | ~6% | 10–15% | 4–6% |

**Eliminated on the no-server constraint** (one line each in the landscape
report): Temporal, Inngest, Trigger.dev, Hatchet, Windmill, n8n, Restate,
Conductor, Camunda/Zeebe, Dapr, Azure Durable Functions, AWS durable
execution, Convex, Cloudflare Workflows, Vercel Workflow DevKit, Upstash,
Obelisk, HotMesh, Resonate. **On storage**: BullMQ (Redis), pg-boss/Absurd
(Postgres), Agenda (Mongo), SideQuest (LGPL — license). **Not
orchestrators**: bree, croner, better-queue, p-queue, `@deepkit/workflow`,
liteflow. **Dead**: workflow-es (2022, `inversify@^4`).

Three verifications that overturned plausible assumptions:

- **DBOS Transact TS is still Postgres-only.** The tarball for
  `@dbos-inc/dbos-sdk@4.25.14` (2026-07-30) contains zero SQLite files;
  only `pg` and `postgresql://`. The June 2026 SQLite announcement was the
  **Go** SDK.
- **Effect's workflow/cluster packages fail on akm's exact topology** —
  open upstream issues #6176/#6179: `SqliteError: database is locked` with
  one runner plus multiple short-lived client processes on one store.
- **LangGraph JS's SQLite checkpointer hard-depends on `better-sqlite3`**
  (native addon), which would break `bun build --compile` single-binary
  distribution across all five targets.

## 4. The architectural finding (independent of maturity)

Every candidate expresses a workflow as **code** — a function whose steps
are memoized by *call position* as execution proceeds. akm expresses a
workflow as **data**: markdown compiles to a frozen plan, and units are
memoized by *content hash* (today `hashVersion 4`: frozen template bytes,
item, declared inputs, params snapshot, dispatch snapshot, invocation,
schema, env names, isolation, gate feedback — the companion spec proposes
`hashVersion 5`, adding post-append/post-fill template bytes, the `uses:`
target kind plus resolved-asset content hash, the persona snapshot, shell text/`shell`/`cwd`, and env *literal*
values).

Two consequences that no amount of library maturity fixes:

1. **Adoption inverts the memoization key.** A code-DSL engine would have
   to be handed a closure generated from akm's plan at runtime; its cache
   then keys on call order, not content. Edit a step's prose and a
   call-order cache happily reuses the completed result — precisely the
   silent-replay-reuse bug the review rounds forced into `hashVersion 5`.
   akm would keep its own hash layer *on top*, so the library's durability
   is redundant rather than substitutive.
2. **Gate loops are content-addressed retries.** A failed gate re-runs its
   step *with judge feedback* — same call position, materially different
   ask. akm handles this by folding `gateFeedback` into the hash preimage.
   Under call-order memoization, loop 2 either wrongly reuses loop 1 or
   wrongly re-runs everything.

This is why bunqueue's reviewer landed on the same phrase independently:
*code-DSL saga engine for one long-lived process* vs *frozen-data-plan
executor for concurrent short-lived CLI runs*.

## 5. Design A — build (the reviewed plan)

The companion spec, as it stands after five review rounds: markdown tasks
and workflows on one parser, `uses:`/`run:` targets, steps-are-tasks
composition, the five-layer cascade, IR v4 with a shell invocation kind,
`hashVersion 5`, env provenance split, ceiling-inherited shell execution,
migration inside the journaled 0.9.0 cutover.

Maintenance burden, honestly: akm owns ~630 LOC of journal/lease/resume
plumbing plus the IR pipeline. The plumbing is the *stable* part — the
tables, leases, and claim rows have not been the source of churn; format
and dispatch semantics have.

**Risk:** correctness of concurrency and replay is akm's problem. Mitigated
by what already exists — the journal, `plan_hash`, deterministic replay
tests, and the chaos/crash-window suites.

## 6. Design B — buy (OpenWorkflow, at its strongest)

Designed to win if it can. OpenWorkflow scores best of the candidates
(embedded, zero runtime deps, empirically SIGKILL-durable, Apache-2.0).

**Shape.** Markdown authoring is preserved exactly — the constraint is not
the discriminator. `akm workflow run` compiles markdown → frozen plan
→ *generates an OpenWorkflow definition* whose steps call akm dispatch.
OpenWorkflow owns run/step journaling, resume, memoization, heartbeats.
akm keeps the parser, IR/freeze, cascade, gates, dispatch, redaction.

**What is deleted:** ~670 LOC (~8%, the low end of §3's 8–12% estimate) —
the run/step journal writer, resume bookkeeping, lease renewal. That is
~40 LOC above §2's ~630 central estimate and sits inside its ~490–720
band: OpenWorkflow absorbs a little more than the narrowest reading of
"plumbing," which is the most favourable assumption available to it.

**What must be built to stand still** (each verified absent upstream):

| Gap | Consequence |
|---|---|
| No concurrency cap (issue #20, open 9 months) | Re-implement bounded fan-out — the capability was the point |
| No per-step timeout, **no `AbortSignal`** | Lose in-flight cancellation of agent spawns; a runaway unit cannot be preempted |
| No error classification | Re-implement the 12-value failure taxonomy driving retry |
| Schema collision — **reproduced**: `no such column: parent_step_attempt_id`, no table-prefix option | A **second DB file**, which breaks single-transaction atomicity across the gate spine |
| 1,000 step-attempt cap | 10× below akm's 10,000-unit expansion limit |
| `brief`/`report` (2,690 LOC) are built on the `workflow_run_units` row shape (`WorkflowRunUnitRow`, consumed field-by-field — `input_hash`, `phase`, `claim_holder`, `attempts`, `result_json`, `failure_reason` — through the `withWorkflowRunsRepo` seam, not raw SQL) | The protocol must be re-pointed at a foreign schema it does not control |

**Net:** ~670 LOC deleted, ~400+ LOC of adapters and re-implementations
added, atomicity and cancellation lost, a 10× capacity regression, and a
bus-factor-1 pre-1.0 dependency placed in the execution path of an
autonomous scheduled system. The landscape reviewer's phrasing for the
comparable case applies: *net LOC plausibly negative*.

## 7. Recommendation

**Adopt Design A.** Then pursue the two moves that actually reduce burden —
neither of which is a workflow engine:

1. **Dependency below the engine, not instead of it.** Replace
   `core/concurrent.ts` with `p-limit`/`p-queue` if desired. Small, real,
   zero architectural risk. (Optional; 40 lines — the other 20 of §2's
   calibration figure are `workflows/concurrency-policy.ts`, whose
   cap-precedence policy survives the swap unchanged.)
2. **Cut scope above the engine — the real lever.** `brief`/`report` is
   **2,690 LOC, 31% of the engine**, and is Experimental/opt-in behind
   `experimental.workflowEngine` while `run` is Stable and ungated. That
   is the largest maintenance liability in the subsystem *and* the most
   removable. Recommend an explicit keep/cut decision on the external
   driver protocol as its own proposal — cutting it removes ~4× more code
   than the best library adoption would, with no new dependency.

**Worth stealing** (patterns, not packages): bunqueue's `pivot()` for plan
changes mid-run, its non-terminal `compensation-stuck` state, and its
seeded `simulatedClock()` for deterministic time tests; OpenWorkflow's
SIGKILL-probe test methodology, which is a stronger durability check than
akm's current crash-window suites.

## 8. Reopen triggers

Revisit if any becomes true:

- DBOS Transact **TS** ships a SQLite system DB (Go/Python already have it).
- Weft reaches 1.0 with documented **multi-process lease coordination** —
  it is the only library designed for akm's runtime shape (Bun-native,
  `bun:sqlite`, `windows-x64` compile target); today it explicitly refuses
  concurrent engines against one store and is 8 weeks old.
- OpenWorkflow lands concurrency caps (#20), `AbortSignal`, and a table
  prefix — the three gaps that force the second DB file and the capability
  regressions.
- akm's own plumbing becomes a churn source. It has not been; format and
  dispatch semantics have.

The trigger is not "a library got popular." It is "a library removes more
than it adds," measured the way §2 measures it.
