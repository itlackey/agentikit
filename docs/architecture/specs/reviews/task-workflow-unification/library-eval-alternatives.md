# akm workflow engine — third-party library survey

Date: 2026-08-01. Scope: find a TS/JS library **measurably better** than the two
already under review (`bunqueue`, `openworkflow` — deliberately excluded here) for
replacing akm's hand-rolled engine in `src/workflows/`.

---

## 0. What akm actually needs (measured from the code)

Sizes (`wc -l`, MPL-2.0 headers included):

| area | LOC |
|---|---|
| `src/workflows/exec` | 7,070 |
| `src/workflows/ir` | 1,635 |
| **exec + ir (the replacement target)** | **8,705** |
| `src/workflows/runtime` | 1,889 |
| `src/workflows` total | 13,046 |

Hard requirements read out of the code, not assumed:

1. **Short-lived process, no daemon.** `akm workflow run` is a one-shot CLI. The
   header of `/home/user/akm/src/workflows/exec/run-workflow.ts` documents an
   explicit drain of child-process handles so the event loop closes and the
   process exits — there is no resident engine and adding one is a regression.
2. **SQLite already is the journal.** `workflow_runs`, `workflow_run_steps`,
   `workflow_run_units` in `state.db`, all raw SQL in
   `/home/user/akm/src/storage/repositories/workflow-runs-repository.ts`, migrated
   by `/home/user/akm/src/storage/engines/sqlite-migrations.ts`.
3. **Multi-process safety by lease, not by singleton.** 90-second
   `engine_lease_holder`/`engine_lease_until` on the run row; expired leases are
   claimable (crash recovery); a second `workflow run` on a live-leased run
   refuses. Concurrent *read-only* `akm workflow brief` runs against the same DB
   by design.
4. **Content-derived unit identity for resume.** `<node_id>:<sha256(canonicalJson(item))[:12]>`
   — resume reuses journaled results even if the producer re-emits items in a
   different order. This is stronger than the position/replay identity every
   generic engine uses.
5. **A frozen data plan, not code-defined workflows.** IR v3
   (`/home/user/akm/src/workflows/ir/schema.ts`): `unit | agent | map | gate`
   nodes, `route` specs, per-engine frozen concurrency caps, `plan_hash`
   integrity, budget caps. Authored as YAML/markdown, compiled and frozen into
   `plan_json`. Every generic library expects workflows expressed as *TypeScript
   functions*.
6. **A harness-neutral external driver protocol.** `brief.ts` (713) + `report.ts`
   (1,977) let an outside agent session execute units and report back, producing
   byte-identical unit graphs to the native engine. 2,690 LOC that no library has
   any analogue for.
7. **Zero-native-addon distribution.** Runtime deps are 7 tiny pure-JS packages;
   `better-sqlite3` is *optional*. `.github/workflows/release.yml` compiles
   `bun-linux-x64/arm64`, `bun-darwin-x64/arm64`, **`bun-windows-x64`** via
   `bun build --compile`. A hard native dependency breaks the standalone binary.
8. **Long-running steps.** Units are LLM/agent invocations with per-invocation
   `timeoutMs` up to `2**31-1` ms.
9. **MPL-2.0 distribution** — needs MIT/Apache-2.0/BSD/ISC.

The generic, library-shaped slice of exec+ir is small:
`scheduler.ts` (118) + the lease/resume plumbing inside `run-workflow.ts` (~325 of
814) + retry/concurrency wiring inside `native-executor.ts` (~130 of 1,334)
≈ **570 LOC ≈ 6.5 % of exec+ir**. Everything else is akm's authoring format, its
gate semantics, its prompt/artifact model, and its driver protocol.

---

## 1. Eliminated on the no-server constraint (one line each, verified)

| Candidate | Evidence |
|---|---|
| Temporal | `@temporalio/worker@1.21.1` deps include `@grpc/grpc-js` — the SDK is a gRPC client of a separate Temporal Server cluster. |
| Inngest | `inngest@4.14.0` is an SDK; execution is driven by `inngest-cli@1.40.0` ("workflow orchestration platform… run on servers") or Inngest Cloud calling back into your HTTP endpoint. |
| Trigger.dev | Tasks execute inside Trigger.dev's own runners (cloud or self-hosted Docker stack); the package is a client. |
| Hatchet | `@hatchet-dev/typescript-sdk@1.28.1` is a worker client for the Hatchet engine (Postgres + gRPC engine service). |
| Windmill | Rust worker + Postgres server product; TS is the *script* language, not an embeddable library. |
| n8n | Full Node application/server with its own DB and editor UI; not a library. |
| Restate | Requires the Restate runtime/sidecar to invoke and journal handlers. |
| Netflix Conductor / Orkes | Java server + Elasticsearch/Redis/Postgres; TS SDK is a client. |
| Camunda / Zeebe | Zeebe broker cluster; `zeebe-node`/`@camunda8/sdk` are gRPC job-worker clients. |
| Azure Durable Functions | `durable-functions@3.5.0` requires the Azure Functions host + Durable Task storage provider. |
| Dapr Workflow | `@dapr/durabletask-js@1.0.0` talks to the Dapr sidecar / durabletask gRPC endpoint. |
| AWS durable execution | `@aws/durable-execution-sdk-js@2.2.0` — Lambda-hosted durable functions. |
| Convex | `@convex-dev/workflow@0.4.4` is a component of the hosted Convex backend. |
| Cloudflare Workflows | Workers/Durable Objects runtime only. |
| Vercel Workflow DevKit | `workflow@4.8.0` ships Next/Nuxt/Astro/Nitro/SvelteKit/Nest adapters — a web-framework durable-function SDK bound to a deployed "world", not a CLI library. |
| Upstash Workflow | `@upstash/workflow` — QStash HTTP service re-invokes your endpoint per step. |
| Obelisk | Rust/WASM engine shipped as a standalone binary, not a TS library. |
| HotMesh | `@hotmeshio/hotmesh@0.27.0` peerDeps `pg` **and** `nats`; also `SEE LICENSE IN LICENSE` (non-standard). |
| Resonate | `@resonatehq/sdk@0.11.4` peerDeps `pg` + `@nats-io/transport-node`; local mode is in-memory (not crash-durable), durability needs the Resonate server/Postgres. |
| Smithers | `smithers-orchestrator@0.32.0` is an *application* (React UI, `@smithers-orchestrator/{ui,aws,gcp,cli,driver,engine}`), not an embeddable engine. |
| Eve (Vercel) | `eve@0.29.4` is a Nitro-based agent *framework* (`nitro` dep, `node>=24`), an app scaffold not a library. |
| RaySpec | `@rayspec/workflow-durable@1.6.2` delegates durability to `@rayspec/durable-dbos` → DBOS → Postgres; 1 week old, no adoption. |

## 2. Eliminated on the storage constraint

| Candidate | Evidence |
|---|---|
| **DBOS Transact (TS)** | **Verified against the current artifact, not memory.** `@dbos-inc/dbos-sdk@4.25.14`, published **2026-07-30**: only DB dependency is `pg@^8.11.3`; the unpacked tarball contains **zero** files matching `*sqlite*`; the only DSN scheme in `dist/src/*.js` is `postgresql://`; `README.md` still says "a lightweight **Postgres-backed** library". Every `@dbos-inc/*-datasource` package is explicitly "with PostgreSQL support". DBOS's June-2026 announcement of a SQLite durability backend applies to the **Go** SDK (and Python, whose docs default the system DB to SQLite) — **it has not landed in TypeScript.** Verdict: **fail today**, re-check when a TS SQLite system DB ships. |
| pg-boss | `pg-boss@12.26.4` deps `pg` — Postgres-only by construction. |
| BullMQ | `bullmq@6.0.5` — "Queue for messages and jobs based on Redis"; requires a Redis server. |
| Absurd | `absurd-sdk@0.4.0` — "PostgreSQL-based durable task execution". |
| Agenda / node-resque / bee-queue | MongoDB / Redis / Redis respectively. |
| SideQuest | `@sidequest/engine@1.16.2` is **LGPL-3.0-or-later** — copyleft on a linked library; avoid for a distributed CLI. |

## 3. Eliminated as "not orchestrators"

| Candidate | Evidence |
|---|---|
| bree | `bree@9.2.9` — cron/date scheduler that spawns worker threads. No DAG, no journal, no resume. |
| croner | `croner@10.0.1` — zero-dep cron expression evaluator. Schedule only. akm already gets scheduling from `schtasks`/cron in `src/tasks/`. |
| better-queue | `better-queue@3.8.12` — in-process job queue with pluggable stores; no step journal, no fan-out graph, no resume-mid-workflow. |
| p-queue / p-limit / fastq | Concurrency limiters. akm already has `core/concurrent.ts` + `scheduler.ts` doing exactly this with the extra frozen-cap policy. |
| workflow-es | `workflow-es@2.3.5`, **last published 2022-06-29**, 19 versions, deps on `inversify@^4` + `reflect-metadata@^0.1` (both several majors stale). Unmaintained; TS-decorator/DI-heavy; would not build cleanly under Bun + modern TS. Dead. |
| @deepkit/workflow | FSM only (`1.0.19`, Sep 2025); no persistence, no durability. |

---

## 4. Candidates evaluated in full

Rubric: **server-free embed / SQLite durability + resume / orchestration primitives /
long-step tolerance / maturity / % of exec+ir replaced.**

### 4.1 Weft — `@lostgradient/weft@0.16.0` (MIT)

The only library found that was *designed* for akm's runtime shape.

- Bun-native (`engines: {bun: ">=1.3.13"}`), 4.6 MB, deps `zod` + `@msgpack/msgpack`.
- Storage adapters are subpath exports, including **`./storage/sqlite/bun`** — i.e.
  `bun:sqlite`, **no native addon**, which is the one thing LangGraph gets wrong.
  Also `./storage/sqlite/node`, `lmdb`, `turso`, `neon`, `postgres`, `http`, `memory`.
- Checkpoint-per-`yield*` (state snapshot, no replay-determinism constraint), so a
  30-minute LLM step is fine.
- Primitives: `ctx.all()`, `ctx.race()`/`raceKeyed()`, activity retry policies,
  `ctx.sleep()` durable timers, `ctx.waitUntil(pred, timeout)`, `waitForSignal()`,
  mutex + semaphore.
- Windows: `bun build --compile` targets include `windows-x64` — matches akm's
  release matrix exactly.

**Killer flaw — the concurrency model is the opposite of akm's.** From the README:
`"Run a single engine per durable store; pointing two at the same store is not yet
coordinated and can double-resume a workflow"`, plus
`"Engine.create() recovers by default after registering workflow definitions, so
fresh processes resume persisted running workflows"`. For akm that means every
`akm workflow run <x>` boot would auto-resume *every* persisted running workflow,
and two overlapping CLI invocations can double-execute. akm's 90-second run lease
exists precisely to make N short-lived processes safe against one SQLite file;
Weft has no equivalent and tells you to enforce singleton-ness "in infrastructure".
Docs also state the server runtime is Bun-only for this launch line.

**Maturity — disqualifying for a shipping CLI.** GitHub `stevekinney/weft`:
**7 stars, 1 fork, sole maintainer, bus factor 1.** npm: first publish
**2026-06-03**, 16 versions, latest 2026-07-25 — **eight weeks old**. Explicitly
pre-1.0 with an experimental/candidate-stable tier split and an incomplete "Tier-0".
1,065 commits in 8 weeks by one person is a velocity profile that is as likely to
be abandoned as to reach 1.0.

| criterion | |
|---|---|
| server-free embed | **partial** — in-process, but assumes one long-lived engine per store |
| SQLite durability + resume | **pass** — `bun:sqlite` adapter, checkpoint per yield |
| orchestration primitives | **pass** — all/race/retry/timers/signals/semaphore |
| long-running steps | **pass** |
| maturity | **fail** — 7★, 8 weeks old, bus factor 1, pre-1.0 |
| % exec+ir replaced | **~6 %** (scheduler + lease/resume plumbing), and it *removes* the lease guarantee |

### 4.2 Mastra workflows — `@mastra/core@1.55.0` + `@mastra/libsql@1.18.0` (Apache-2.0)

- Genuinely server-free for embedding: `mastra dev` is an optional playground; the
  workflow engine runs in-process via `workflow.createRunAsync()`.
- Storage is pluggable; `@mastra/libsql` wraps `@libsql/client` and takes a
  `file:` URL, so local SQLite durability is real and supported. Snapshots survive
  restarts; `workflow.getWorkflowRunById()` + `createWorkflowStateReader()` recover a
  run in a brand-new process.
- Control flow: `.then/.parallel/.branch/.dowhile/.dountil/.foreach({concurrency})`,
  step retries, suspend/resume. Good coverage of akm's `unit/map/route`.
- License fine. Maintained (1,437 releases since Oct 2024).

**Why it does not win:**
- **Durability model mismatch.** Mastra's snapshots are written *on suspend*
  (`suspend()`, `sleep()`, human-in-the-loop). It has no run lease, no
  crash-recovery daemon, and no per-unit idempotency key equivalent to akm's
  content-derived `sha256(item)` unit ids. akm would keep hand-rolling exactly the
  parts it already hand-rolls.
- **Weight is disqualifying for this CLI.** `@mastra/core` alone is **59 MB
  unpacked / 2,862 files / 31 runtime deps**, including three parallel copies of the
  AI SDK provider layer (`@ai-sdk/provider-v5/v6/v7`), `execa`, `ws`,
  `@modelcontextprotocol/sdk`, and **`posthog-node`** (vendor telemetry). akm's
  entire runtime dependency set today is 7 small pure-JS packages and it ships a
  compiled single binary. This is a >10× install-surface increase plus a telemetry
  dependency in a tool whose repo carries `docs/reference/data-and-telemetry.md`.
- **Release churn.** ~1,437 versions in 22 months (~2/day) against a CLI that pins
  deps hard (see the `pinNotes` entry in `package.json`).
- akm would still own the IR compiler, gates, artifact promotion, brief/report.

| criterion | |
|---|---|
| server-free embed | **pass** |
| SQLite durability + resume | **partial** — libSQL storage yes; snapshot-on-suspend, no lease, no crash-resume daemon |
| orchestration primitives | **pass** — parallel/branch/loops/foreach-concurrency/retries |
| long-running steps | **pass** |
| maturity | **partial** — active and adopted, but 59 MB, 31 deps, posthog telemetry, extreme churn |
| % exec+ir replaced | **~10–15 %** of exec, **0 %** of ir |

### 4.3 XState v5 — `xstate@5.32.5` (MIT)

- Best maturity on this list: MIT, **zero dependencies**, 2.3 MB, Stately-backed,
  huge install base, stable v5 line.
- Persistence exists — `actor.getPersistedSnapshot()` / `createActor(m, { snapshot })` —
  and machines can be built at runtime from akm's frozen IR JSON.

**But it is a state-machine library, not a durable execution engine.** What akm
would *still* hand-roll after adopting it: the unit journal and its SQLite schema,
content-derived unit ids and idempotent resume, retry/backoff, the frozen
concurrency caps, the 90-second run lease, gate loops and feedback threading,
artifact promotion/validation, and the entire brief/report protocol. Worse, a
restored XState actor **re-invokes** its promise actors — the invoked LLM call is
not journaled, so naive restore *re-runs paid work*. akm would have to wrap every
invoke in its existing journal anyway, at which point XState is contributing only
step sequencing and route evaluation (~300–500 LOC of `run-workflow.ts` +
`step-work.ts`), while adding a second source of truth for run state next to
`workflow_runs`.

| criterion | |
|---|---|
| server-free embed | **pass** |
| SQLite durability + resume | **fail** — snapshot serialization only; no journal, no effect durability, no resume semantics |
| orchestration primitives | **partial** — parallel states/routing yes; no concurrency caps, no retry policy, no fan-out-over-data |
| long-running steps | **pass** |
| maturity | **pass** — the strongest here |
| % exec+ir replaced | **~4–6 %**, and it duplicates run state |

### 4.4 Effect — `@effect/workflow@0.19.1` + `@effect/cluster@0.60.2` (MIT)

Durable workflows for Effect: `DurableDeferred`, `DurableClock`, activity
journaling, compensation. The only real engine is `ClusterWorkflowEngine`, which
maps each workflow to a cluster Entity and routes through `Sharding` — so you take
on `@effect/cluster` + `@effect/sql` + `@effect/rpc` + `@effect/platform` +
`@effect/experimental` as peers, and a runner topology.

**Directly disqualifying evidence for akm's exact pattern:** two *open* upstream
issues — [Effect-TS/effect#6176](https://github.com/Effect-TS/effect/issues/6176)
(filed 2026-04-15, still open) and #6179 — report that SQLite-backed
`@effect/workflow`/`@effect/cluster` storage degrades under
"one persistent runner + multiple short-lived client processes on the same SQLite
store", producing `PersistenceError` and `SqliteError: database is locked`. That is
*precisely* akm's topology (one engine invocation + concurrent `brief`/`report`
CLI processes on `state.db`). Plus: adopting Effect means rewriting akm's
imperative engine into the Effect runtime — an enormous, non-incremental change to
an MPL-2.0 codebase that today has 7 dependencies.

| criterion | |
|---|---|
| server-free embed | **fail/partial** — needs cluster runner topology |
| SQLite durability + resume | **fail** — documented, currently-open lock failures under akm's multi-process pattern |
| orchestration primitives | **pass** |
| long-running steps | **pass** |
| maturity | **partial** — Effect core is mature; `@effect/workflow` is 0.19.x and moving fast |
| % exec+ir replaced | ~15 % nominally, at the cost of rewriting the other 85 % in Effect |

### 4.5 LangGraph JS — `@langchain/langgraph@1.4.8` + `@langchain/langgraph-checkpoint-sqlite@1.0.3` (MIT)

Closest "real product" fit conceptually: graph of nodes, `Send` API for
data-driven fan-out, `interrupt()`/`Command(resume=…)`, retry policies, per-thread
checkpoints in SQLite, no server required (LangGraph Platform is optional).

Blockers:
- **`@langchain/langgraph-checkpoint-sqlite` depends on `better-sqlite3@^12`** — a
  native addon. akm keeps `better-sqlite3` *optional* precisely so
  `bun build --compile` produces a runtime-free binary for 5 targets including
  Windows. Making it mandatory is a distribution regression; the package does not
  offer a `bun:sqlite` driver.
- Upstream positions `SqliteSaver` as "local testing"; Postgres is the documented
  production saver.
- Checkpointing is at **superstep boundaries**, so a crash mid-node re-runs the
  whole node — weaker than akm's per-unit content-hash journal, i.e. it would
  re-pay for LLM calls akm currently reuses.
- Pulls `@langchain/core` (peer) + `@langchain/langgraph-sdk` + `@langchain/protocol`
  into a 7-dependency CLI.
- Graph-of-code model vs. akm's frozen IR data plan; `brief`/`report` have no home.

| criterion | |
|---|---|
| server-free embed | **pass** |
| SQLite durability + resume | **partial** — works, but native addon + "local testing" positioning + superstep granularity |
| orchestration primitives | **pass** — Send fan-out, interrupts, retry policies |
| long-running steps | **partial** — node-level replay on crash |
| maturity | **pass** — large ecosystem, MIT |
| % exec+ir replaced | **~10 %**, and it breaks single-binary distribution |

### 4.6 Also looked at, not worth a full row

- `@clawdbot/lobster@2026.6.11` (MIT, deps `ajv`+`yaml`) — "typed JSON-first
  pipelines, jobs, and approval gates", local-first, fan-out/retries/timeouts.
  Conceptually the closest thing to akm's gate model found on npm. But it is an
  **OpenClaw-native plugin shell**, still described as in planning, with no
  documented durable journal or resume contract and no adoption. Not a credible
  swap; possibly worth watching.
- `liteflow@1.1.0` — "a lightweight SQLite-based workflow *tracker*". Tracking, not
  execution. No fan-out, no retries, no resume.
- `@gobing-ai/ts-dual-workflow-engine`, `@pi-stef/agent-workflows`,
  `nervous-system`, `@workglow/job-queue` — sub-1.0, single-author, no adoption,
  no durability contract. Same or worse risk profile than Weft with fewer features.

---

## 5. Ranked shortlist

1. **Weft (`@lostgradient/weft`)** — the only library whose *design* matches akm
   (Bun-native, `bun:sqlite`, in-process, checkpoint-per-step, MIT, Windows
   compile target), but it explicitly does not coordinate multiple processes
   against one store and auto-resumes everything on `Engine.create()`, which
   contradicts akm's lease model; and at 7 stars / 8 weeks / bus factor 1 it is
   not adoptable by a shipping CLI. **Watch, do not adopt.**
2. **Mastra (`@mastra/core` + `@mastra/libsql`)** — real server-free SQLite
   durability and the best control-flow coverage of akm's `unit/map/route`, but
   59 MB / 31 deps / bundled `posthog-node` / ~2 releases-per-day churn is
   indefensible against a 7-dependency single-binary CLI, and its
   snapshot-on-suspend model leaves akm hand-rolling leases and unit idempotency
   anyway.
3. **XState v5** — by far the safest dependency (MIT, zero deps, 2.3 MB, stable),
   but it is not durable execution: restored actors re-invoke their effects, so
   akm keeps its journal, lease, retries and gates and gains only step
   sequencing — while creating a second run-state source of truth.

## 6. Bottom line

**Nothing found beats hand-rolling, and nothing found is measurably better than
the two candidates already under review.**

The reason is structural, not a gap in the search. akm's engine is 8,705 LOC of
exec+ir, but only ~570 of them (~6 %) are the generic durable-execution concerns a
library sells: bounded concurrency, retry, journal-and-resume, lease. The other
~94 % is akm's own product — the IR v3 compiler and freeze/plan-hash pipeline, the
LLM/agent/SDK dispatch with frozen per-engine caps, artifact promotion and
output-schema validation, artifact-judged gates with bounded feedback loops, and
the 2,690-LOC `brief`/`report` harness-neutral driver protocol. No library on npm
has an analogue for the last item, and every library would *replace* akm's
`workflow_run_units` journal with its own schema, which is the exact table
`brief`/`report` read from — so adoption costs an extra translation layer on top
of the rewrite.

Three specific things akm already does that none of these libraries do:
content-derived unit identity (`sha256(canonicalJson(item))`) that survives item
reordering; a claimable 90-second run lease that makes N short-lived CLI processes
safe against one SQLite file; and byte-identical unit graphs across the native and
external-driver execution paths.

**Recommendation:** keep the engine. If a dependency is wanted, the defensible
scope is *below* the engine, not instead of it — e.g. keep using `core/concurrent.ts`
or swap it for `p-limit`/`p-queue`. Re-open this evaluation if
**DBOS Transact TS ships a SQLite system database** (Go has it, Python defaults to
it, TS at `4.25.14`/2026-07-30 does not), or if **Weft reaches 1.0 with documented
multi-process lease coordination**.
