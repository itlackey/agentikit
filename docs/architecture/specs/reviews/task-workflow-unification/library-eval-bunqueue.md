# bunqueue — evaluation as a replacement/underpinning for akm's workflow engine

Repo: https://github.com/egeominotti/bunqueue · npm `bunqueue` · site https://bunqueue.dev
Evaluated: 2026-08-01 against akm @ `0.9.0-rc.13` (MPL-2.0, Bun CLI).
Version examined: **2.8.55** (repo HEAD, pushed 2026-08-01T22:10:18Z).

---

## 0. What bunqueue actually is

Two separable subsystems shipped in one package:

1. **A BullMQ-shaped job queue** — SQLite/WAL persistence, priorities, delayed jobs,
   cron (`croner`), DLQ, rate limits, per-queue concurrency slots, FlowProducer
   (parent/child DAGs), stall detection, S3 backup, TCP/HTTP servers, MCP server
   (73 tools). This is the mature, heavily tested core.
2. **A workflow/saga engine** (`src/client/workflow/`, 37 files) — a *code* DSL
   (`.step().branch().parallel().forEach().waitFor().pivot()`) layered on a
   `Queue`/`Worker` pair, with its own SQLite `workflow_executions` table.

akm's engine maps onto (2), not (1). The two do not compose: the workflow engine's
fan-out primitives do **not** use the queue's concurrency slots (see §3).

Evidence: https://github.com/egeominotti/bunqueue/tree/main/src/client/workflow ·
https://raw.githubusercontent.com/egeominotti/bunqueue/main/docs/features/workflow-engine.md

---

## 1. Server requirement — **PARTIAL (fails for akm)**

| Question | Answer | Evidence |
|---|---|---|
| Fully embedded? | Yes, `new Queue('q', { embedded: true, dataPath })` — no sockets, no daemon | `docs/architecture.md:222` |
| Redis/Mongo/PG? | **No.** Zero external infra; deps are only `croner` + `msgpackr` | `package.json` (deps: `croner@10.0.1`, `msgpackr@^1.11.8`); README "Zero external infrastructure" |
| Storage | `bun:sqlite` WAL, `synchronous=NORMAL`, `busy_timeout=5000`, 256MB mmap; omit `dataPath` → `:memory:` | `docs/features/persistence.md`; `EngineOptions.dataPath` "omit → `:memory:` for store" |

**The disqualifier.** Embedded mode is documented single-process-only:

> "Trade-off: scoped to one process; multiple processes pointing at the same SQLite
> file is **not** supported for concurrent writers."
> — https://github.com/egeominotti/bunqueue/blob/main/docs/architecture.md (Deployment Modes (a), lines 222–228)

The authoritative queue state is the **in-memory** sharded index, hydrated from SQLite
at startup and then served from RAM (`docs/features/persistence.md`, "What Stays
In-Memory"). Two concurrent `akm workflow run` processes on the same DB would each own
a divergent authoritative view.

akm is precisely a multi-process CLI: `workflow_runs.engine_lease_holder` /
`engine_lease_until` (90s, claimable on expiry) and
`workflow_run_units.claim_holder` / `claim_expires_at` exist *because* a second
invocation can race the first (`src/core/state/migrations.ts:881–955`;
`src/workflows/exec/run-workflow.ts` "Run lease" docblock). Also `akm task run` is
invoked by cron/launchd/schtasks, so several runs can legitimately overlap
(`src/tasks/runner.ts:6`).

To get multi-process safety from bunqueue you must run **server mode**
(`bunqueue start`, TCP :6789 / HTTP :6790) — a resident daemon, which is exactly what
akm's zero-daemon design refuses. Also note the workflow engine specifically:
"No cross-process lock; within one executor, `nodesInFlight` holds a claim"
(`docs/features/workflow-engine.md`, Concurrency & Idempotency) — even in server mode
the *workflow* layer is not cross-process safe, because `WorkflowStore` opens a local
`bun:sqlite` directly.

**Verdict: embedded-yes, but single-process-only, which akm's model violates.**

---

## 2. Durability & crash-resume — **PARTIAL**

Genuinely good, but weaker and less precise than what akm already has.

**What's there**
- SQLite WAL; `PRAGMA wal_checkpoint(TRUNCATE)` on close (`docs/features/persistence.md`).
- Workflow state in `workflow_executions` (+ `_archive`): input, steps, signals,
  metadata as **msgpackr BLOBs**, plus a `current_node_index` cursor.
- `Engine.recover()` scans `running` / `waiting` / `compensating` / failed-before-unwind
  rows, re-enqueues running work, re-arms waiting timers with original start time,
  resumes on already-delivered signals, adopts orphaned children by
  `parentExecutionId`.
- Completed steps and completed loop iterations are memoized and skipped on re-entry;
  attempt counts accumulate across re-entry. Docs are explicit that this is
  **at-least-once**: "Unknown external outcomes may re-run with stable
  `idempotencyKey`" (`idempotencyKey = run:step#occurrence:direction`, persisted at
  step START).

**Where it's weaker than akm**
- Memoization is keyed on **step name + occurrence index**, not on inputs. akm keys on
  content-derived unit ids (`<node_id>:<sha256(canonicalJson(item))[:12]>`) plus an
  `input_hash` column, and treats a matching id with a differing hash as a hard
  **replay divergence** failure rather than silently reusing or re-dispatching
  (`src/workflows/exec/native-executor.ts:74`, `:690–706`;
  `src/core/state/migrations.ts` `workflow_run_units.input_hash`). bunqueue has no
  equivalent; item-list reordering between runs would re-key every iteration.
- Definition rebinding "fails closed" only when a hash exists; akm freezes the whole
  plan into `workflow_runs.plan_json` + `plan_hash` and never re-reads the asset.
- Job-level writes are **buffered by default** (`writeBufferFlushMs` ~10ms,
  `writeBufferSize` 100 rows) — up to 10ms of job rows lost on crash unless
  `durable: true` per job (`docs/features/persistence.md`, Write Paths).
- The store is opaque msgpackr BLOBs. akm's `workflow_run_units` is a queryable
  relational journal that `akm workflow report` / `brief` read directly
  (`src/workflows/exec/report.ts`, 1977 lines). Adopting bunqueue means a **second**
  SQLite database whose contents the akm CLI cannot query without decoding BLOBs.

---

## 3. Orchestration primitives — **PARTIAL (the fan-out gap is fatal)**

| akm needs | bunqueue workflow engine | Evidence |
|---|---|---|
| DAG / flows | Ordered node array, sequential cursor (`currentNodeIndex`); each `advance()` enqueues exactly one successor. Not a general DAG. | `docs/features/workflow-engine.md` (Execution Model) |
| Conditional routing | `.branch(condition)` + `.path(name, builder)` — condition is an **arbitrary JS closure** | same |
| Fan-out with concurrency cap | **NO.** `.parallel(builder)` is `Promise.allSettled` over *statically declared sibling steps*, **unbounded**, and `.forEach(items, …)` is **strictly sequential** (`for (let i = 0; i < items.length; i++)`) with only `maxIterations` (default 1000). `ParallelDefinition` has no concurrency field. | `src/client/workflow/loops.ts`; `src/client/workflow/stepTypes.ts` |
| Result reduction | **NO aggregation.** Loop results write `exec.steps["name:i"]` per iteration and `exec.steps["name"]` holds **only the last iteration** ("the documented contract for downstream steps"). No collect/vote reducer. | `src/client/workflow/loops.ts` |
| Bounded retry + **error classification** | `retry` is a **plain number** (default 3) + backoff w/ jitter. **No error-type filter.** akm has `retry: { max, on: [failureReason] }` over a structured failure vocabulary. | `src/client/workflow/stepTypes.ts` (`StepOptions.retry: number`); `src/workflows/exec/unit-dispatch.ts` (`failureReason`) |
| Per-job timeouts | Yes — per-step `timeout` (default 30_000ms), chunked timers bounded at 2^31−1 ms, aborts `ctx.signal` | `docs/features/workflow-engine.md` |
| Beyond akm | Saga `compensate` + `pivot()`, `waitFor(event)` HITL gates with transactional parking, `subWorkflow`, `compensation-stuck` operator state, 15 event types, injectable clock for deterministic tests | same |

The bounded-fan-out-with-reduction primitive is the single most load-bearing thing akm
needs from an orchestrator (`scheduleUnits` + `collect`/`vote` reducers) and it is the
one thing the workflow engine does not have. You *can* build it on the **queue** layer
instead — `FlowProducer.addBulkThen(parallel, final)` gives N children + a reducer
parent, with per-queue concurrency slots and `getParentResults()`
(`docs/features/flow-producer.md`) — but that abandons the workflow DSL entirely and
you re-hand-roll gates, routing, and step advance on top of raw jobs. Limits there:
depth ≤100 edges, batch ≤10,000 jobs, 10MB/job, 64MB aggregate.

---

## 4. Long-running jobs (agent CLI spawns, minutes) — **PARTIAL**

- Worker lock: `lockDuration` **30_000ms** default, `heartbeatInterval` **10_000ms**,
  both configurable; heartbeats renew locks for all pulled job ids
  (`docs/features/client-worker-sdk.md`). A minutes-long handler survives *if* the
  event loop stays responsive — fine for akm, whose units `await` a subprocess.
- Stall detection is two-phase (BullMQ-style) to avoid false positives, tracks
  `job.stallCount`, and either retries with backoff or moves to DLQ
  (`src/application/stallDetection.ts`).
- **But**: if the lock does expire, "the server's stall detection may **re-dispatch**
  that job to another worker"; the mitigation is only worker-side dedup on
  `activeJobIds` and swallowing the stale ack. For akm a re-dispatch means a **second
  agent CLI spawn / second paid LLM call**, not a cheap duplicate.
- Step `timeout` defaults to **30s** — every akm unit would need an explicit override;
  a missed override silently kills an agent run at 30s.
- Real-world evidence that this area has been buggy: closed issues
  "A successful job completion is silently lost when the lock token expired",
  "Lock-expiry DLQ move still not persisted on 2.8.27 (#97 follow-up)",
  "Retrying a job failed via the lock-expiry path throws UNIQUE constraint failed"
  (https://github.com/egeominotti/bunqueue/issues?q=is%3Aissue+is%3Aclosed).
- Also: `subWorkflow` timeout "doesn't cancel" — the parent fails but the child keeps
  running (`docs/features/workflow-engine.md`, Edge Cases). akm kills process groups
  on timeout (`src/core/subprocess.ts` via `runManagedSubprocess`).

akm's own lease model (90s run lease + per-unit `claim_holder`/`claim_expires_at`) is a
closer fit and is already written.

---

## 5. Runtime & platform — **PARTIAL**

- **Bun-native and Bun-only** for engine/embedded: `engines: { bun: ">=1.3.9" }`;
  `src/require-bun.ts` / `src/bun-only.ts` enforce it. akm is Bun, so this is a plus.
  (Node/Deno/Python/PHP/Go/Rust/Elixir clients exist but only speak TCP to a server.)
- The workflow engine is documented as Bun-only *by design*: "The DSL takes
  **functions, not data** — `branch()` and `doUntil()` evaluate arbitrary closures that
  a server never can… The blocker is `WorkflowStore` opens local `bun:sqlite`"
  (`docs/features/workflow-engine.md`, "Why Bun-Only (For Now)").
- **Windows: untested.** CI (`.github/workflows/ci.yml`) runs **every** job on
  `ubuntu-latest`; only the release *build* matrix cross-compiles a `bun-windows-x64`
  binary. No Windows test job, no macOS test job. Tests run in Docker containers
  (`docs/testing.md`). No `os` field in package.json.
  akm ships Windows as a first-class target (`schtasks` scheduling backend,
  `src/tasks/schedule.ts:33`), so this is an unmitigated regression risk.

---

## 6. Maturity — **PARTIAL / concerning**

| Metric | Value | Source |
|---|---|---|
| Stars / forks | 525 / 17 | api.github.com/repos/egeominotti/bunqueue |
| Created | **2026-01-28** (≈6 months old) | same |
| Last push | 2026-08-01 (today) | same |
| License | **MIT** | same; npm registry |
| Open issues | **0** (11–12 closed) | https://github.com/egeominotti/bunqueue/issues?q=is%3Aissue |
| npm versions | **271** published in ~6 months (≈1.5/day), 2 majors, 19 minor lines (1.0→2.8) | registry.npmjs.org/bunqueue |
| GitHub releases | 36 pages of releases; latest v2.8.55 (2026-08-01), v2.8.54 same day | /releases |
| npm maintainers | **1** — `kernelvoid` <egeominotti@gmail.com> (same person as the GitHub owner) | registry.npmjs.org/bunqueue |
| Commit authors | `egeominotti`, `kernelvoid` (same human), plus `claude` as co-author | /commits/main |
| Tests | **>100 test files**, property tests (`fast-check`), model-based testing, Docker-isolated unit/TCP/embedded suites, benchmark policy | /tree/main/test; `docs/testing.md`; ci.yml |
| Docs | Excellent — 44 feature docs + architecture/data-model/protocol/testing + Astro Starlight site | /tree/main/docs |

**Bus factor: 1.** Test and doc quality are genuinely above average for a 6-month
project; release cadence is *too* fast to be stable (271 versions, two majors in six
months means the API has already broken once and minor lines turn over every ~10 days).

The closed-issue list is the most informative maturity signal — all reported by
third parties in the last two months, all in exactly the correctness domains akm would
be depending on:
- "Worker over-pulls jobs past concurrency still exists" / "Worker might blow the
  concurrency threshold due to a racing condition" (timnew)
- "A successful job completion is silently lost when the lock token expired" (assantech)
- "Queue control-state (paused / rate-limit / concurrency) is never persisted"
- "cancel() does not remove flow chain jobs in waitingDeps state"
- "finishedOn is always undefined on jobs from getJobs() in embedded mode"
- "TLS: any client connection can crash the whole server" / "TLS client never verifies
  the server certificate" (server-mode only; not reachable from embedded)

They are fixed, and fixed fast — but concurrency-cap violations and lost completions in
mid-2026 mean the invariants are still settling.

---

## 7. Integration sketch & % deletable

akm's engine surface: `src/workflows/exec/` = 7,070 lines across 12 files;
`src/workflows/ir/` = 1,635 lines across 5 files. **Total 8,705 lines.**

### Could plausibly be replaced
| akm file | Lines | bunqueue equivalent | Real? |
|---|---|---|---|
| `exec/scheduler.ts` | 118 | queue concurrency slots | **No** — it's a 20-line policy layer over `core/concurrent.ts` composing 4 caps (map request ∧ frozen workflow cap ∧ frozen LLM engine cap ∧ live host CPU cap, reapplied at dispatch so a resume on a smaller machine re-clamps). bunqueue's workflow layer has no bounded fan-out at all (§3); the queue layer's slot model can't see the frozen caps. |
| retry/attempt bookkeeping in `native-executor.ts` | ~120 | `StepOptions.retry: number` | **No** — akm needs `retry.on: [failureReason]` classification and per-attempt journal rows (`<unitId>~r<n>`) that bunqueue's single mutable `attempts` counter cannot express. |
| run lease | ~60 | worker lock/heartbeat | **No** — bunqueue's workflow engine has no cross-process lock at all. |

### Must remain hand-rolled regardless
- `ir/` **all 1,635 lines** — plan compile, freeze, `plan_hash`, params/secrets. bunqueue
  workflows are code, not data; there is nothing to freeze.
- `exec/step-work.ts` (1,536) — the pure `computeStepWorkList` that makes `brief` able to
  *predict* the exact units the engine will dispatch. Structurally impossible on bunqueue:
  its DSL is closures ("functions, not data" — its own docs), so the work list can never
  be a pure function of persisted state.
- `exec/report.ts` (1,977) + `exec/brief.ts` (713) — the harness-neutral driver protocol
  and CLI-queryable journal. bunqueue's store is msgpackr BLOBs in a foreign DB.
- `exec/frozen-judge.ts` + `workflow-engine-gate.ts` (177) + the gate-loop logic — judged
  gates with feedback threaded into unit prompts (changing the input hash so the loop
  re-dispatches naturally). No analogue; `waitFor` is a human signal gate, not an LLM judge.
- `exec/worktree.ts` (208), `exec/param-secrets.ts` (118), budget ceilings, token
  accounting, empty-output normalization, structured-output validation — all domain.
- Input-hash replay divergence and content-derived unit identity — §2.

### Estimate
**≈0–3% of `src/workflows/exec` + `src/workflows/ir` is deletable** (at absolute best
`scheduler.ts`'s 118 lines ≈ 1.4%, and even that would be a downgrade). The
*additive* cost is large: a second SQLite DB, a timer-driven worker (`poll()`
reschedules every 10ms) that must be explicitly `close()`d or it holds Bun's event loop
open — directly against the "no leaked handles" contract akm documents in
`run-workflow.ts` — and a single-process constraint akm cannot satisfy.

A hypothetical adoption degenerates to: one bunqueue `.step()` whose handler calls
akm's existing `executeStepPlan`. At that point bunqueue contributes a job row and a
retry counter.

---

## 8. Risks

| Risk | Severity | Detail |
|---|---|---|
| **Architecture mismatch** | **Blocking** | Embedded = single-process; akm is a multi-process CLI with an explicit lease protocol. The alternative (server mode) reintroduces the daemon akm exists to avoid. |
| **Capability gap** | **Blocking** | No bounded-concurrency data fan-out, no result reduction, no error-classified retry — the three primitives akm's engine is built around. |
| Abandonment | Medium | 6 months old, bus factor 1, single npm maintainer. Very active *now*; no track record through a maintainer gap. MIT means a fork is always legal. |
| API instability | **High** | 271 npm versions in ~6 months, 2 majors, 19 minor lines. Pinning is mandatory; upgrades will be frequent and unbudgeted. |
| Correctness churn | Medium-High | Third-party-reported concurrency-cap violations, lost completions on lock expiry, unpersisted queue control state — all within the last two months. |
| Security | Low (embedded) / Medium (server) | Two TLS issues (unauthenticated crash; no server-cert verification) reported and fixed; both server-mode only. Embedded path adds no network surface. Supply chain is small: 2 runtime deps (`croner`, `msgpackr`) + 1 optional peer (`@modelcontextprotocol/sdk`). |
| Windows | Medium | Zero Windows CI. akm supports Windows via `schtasks`. |
| License | **None** | MIT consumed by MPL-2.0 is fine; MPL file-level copyleft is unaffected by a permissive dependency. |

---

## Recommendation

**Do not adopt** — neither as a replacement nor as an underpinning of
`src/workflows/exec` + `ir`.

The blocker is not maturity, it is shape. bunqueue's workflow engine is a
**code-DSL saga engine for a single long-lived process**; akm's is a **frozen-data-plan
executor for short-lived, potentially concurrent CLI invocations** whose journal is a
queryable first-class CLI surface. The two disagree on the process model (single vs
multi), the plan representation (closures vs frozen IR), the resume key (step name vs
input hash), and the fan-out primitive (sequential/unbounded vs bounded-with-reducer).

**Worth stealing, not importing** (all MIT, all cheap to reimplement):
1. `pivot()` — an explicit no-rollback-past-here marker.
2. `compensation-stuck` as a deliberately **non-terminal** state requiring operator
   action, with `resumeCompensation()` / `abandonCompensation()` — a better failure
   parking model than a plain `failed`.
3. Injectable `clock()` covering timestamps, retry jitter, entropy **and** timers, with
   `simulatedClock(seed)` — turns a 1,794ms retry test into 66ms deterministically.
   akm's scheduler/retry tests would benefit directly.
4. Decision logic as **pure functions returning values** (`decideUnwindAction`,
   `decideAdmission`) so admission/unwind are property-testable — akm already does this
   for `computeStepWorkList`; extending it to lease admission is the same idea.
5. Two-phase stall detection (candidate-mark, then confirm on the next sweep) to avoid
   false-positive reclaims — relevant if akm ever shortens its 90s lease.

**Where bunqueue *would* be a good fit for akm**, if a need ever appears: as the backend
for a genuinely *daemonized* akm service (a long-lived `akm serve` with a job queue for
scheduled tasks), replacing the current cron/launchd/schtasks delegation in
`src/tasks/`. That is a different product decision, and today's design deliberately
rejects it.
