# Workflow architecture: Claude Code workflows vs. akm workflows

A technical comparison of two things that share a name but occupy different
layers of the stack: the **Claude Code `Workflow` tool** (the harness-native
orchestration DSL) and **akm workflows** (`akm workflow …`, the workflow
subsystem in this repo).

The short version: they are not competitors. An akm workflow is one durable
markdown asset with two execution surfaces. In the stable manual loop, akm
hands each step's instructions to the driving agent and records what comes
back. With `akm workflow run`, akm compiles the same asset to a plan graph and
a native engine fans work out to concurrent runner units, retries, gates on
typed artifacts, and enforces budget ceilings — genuine execution, not just
tracking. That engine is **experimental and opt-in** — see [Part
B.0](#b0-one-format-two-execution-surfaces-and-an-experimental-gate) — so the
"akm just remembers, Claude Code executes" framing remains the default, but
it is no longer the only truth. The most
interesting seam is not either engine in isolation: akm also ships a
**harness-neutral driver protocol** (`akm workflow brief` / `akm workflow
report`) that lets Claude Code itself execute an akm-orchestrated run's units
and report results back through the exact code path the native engine uses —
the clearest point where the two systems compose.

> **Scope.** This report analyzes akm's own workflow subsystem
> (`src/workflows/**`, `src/commands/workflow-cli.ts`) against the Claude Code
> `Workflow` tool. It deliberately **excludes** any `.workflow.mjs` Claude Code
> workflow scripts that may live elsewhere in this repo (e.g. under internal
> review tooling) — those are *consumers* of the Claude Code system, not
> instances of akm's own workflow engine.

---

## Part A — Claude Code workflows: technical details

### A.1 Representation: an imperative JavaScript program

A Claude Code workflow **is a program**, not a document. The model authors a
self-contained JavaScript script, passed inline to the `Workflow` tool via its
`script` parameter. Every script begins with a **pure-literal** `meta` export:

```js
export const meta = {
  name: 'review-changes',
  description: 'Review changed files across dimensions, verify each finding',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}
// body: uses agent()/parallel()/pipeline()/phase()/log()
```

`meta` must be a static literal (no variables, calls, spreads, or template
interpolation) so the harness can read the workflow's shape — its name,
description, and declared phases — **without executing the body**. The body
is arbitrary control flow: loops, conditionals, fan-out, accumulation.

The scripting surface is a small set of injected hooks and globals:

| Hook / global | Role |
|---|---|
| `agent(prompt, opts?)` | Spawn a subagent (a fresh LLM context). Returns its final text, or — with `opts.schema` — a validated structured object (the subagent is forced to call a `StructuredOutput` tool and the result is schema-checked with retries). Returns `null` if the agent is skipped mid-run or dies after retries are exhausted. |
| `parallel(thunks)` | Run tasks concurrently with a **barrier** — awaits all before returning. Failed thunks resolve to `null` (the call itself never rejects — filter with `.filter(Boolean)`). |
| `pipeline(items, ...stages)` | Run each item through all stages independently with **no barrier** between stages — item A can be in stage 3 while item B is still in stage 1. Each stage callback receives `(prevResult, originalItem, index)`. |
| `phase(title)` | Open a progress group; subsequent `agent()` calls are grouped under it. |
| `log(message)` | Emit a narrator line to the user. |
| `workflow(nameOrRef, args?)` | Run another workflow inline as a sub-step (one level of nesting only; the nested run shares the parent's concurrency cap, agent counter, and token budget). |
| `args` | The caller-supplied input value, verbatim. |
| `budget` | The turn's token target (`total`, `spent()`, `remaining()`) — a hard ceiling once reached. |

The unit of work is `agent()` — **a subagent with its own LLM context, model,
effort, and tool set**. Options include `label`, `phase`, `schema`, `model`,
`effort`, `isolation: 'worktree'` (an isolated git worktree so parallel file
mutations don't collide — expensive, so reserved for agents that mutate files
in parallel and would otherwise conflict; auto-removed if left unchanged), and
`agentType` (a named custom subagent). A subagent's model/effort/tools default
to the session's resolved model when unset, and subagents can reach
session-connected MCP tools via on-demand `ToolSearch`. Subagents are told
their final text *is* the return value, so a well-written `agent()` prompt
asks for raw data, not human-facing prose.

### A.2 Execution engine: the harness runs the script

The defining fact: **the Claude Code harness itself executes the script**, in a
controlled JavaScript interpreter. The model *writes* the orchestration; the
harness *runs* it deterministically, intercepting each `agent()` call to spawn a
real subagent, meter tokens, and update progress.

The script runs in a **restricted sandbox**, not full Node:

- Standard JS built-ins are available (`JSON`, `Math`, `Array`, …).
- **No filesystem or Node API access** — a workflow script cannot read or write
  files directly; only its subagents (which have tools) touch the world.
- **`Date.now()`, `Math.random()`, and argless `new Date()` throw** — they would
  make replay non-deterministic and break resume (see A.5). Timestamps come in
  via `args`; randomness is faked by varying prompts/labels by index.
- It is **TypeScript-hostile**: plain JS only, no type annotations/generics.

Invocation is **asynchronous / background by default**: the tool returns
immediately with a `runId` (`wf_…`), and a `<task-notification>` fires when the
workflow completes. `/workflows` streams live progress in the meantime.

### A.3 Concurrency model: parallel by construction

Concurrency is the entire point. Fan-out is first-class:

- Concurrent `agent()` calls are capped at `min(16, cores − 2)` per workflow;
  excess calls queue and drain as slots free.
- A single `parallel()`/`pipeline()` call accepts up to **4096 items**; total
  agents across a workflow's lifetime are capped at **1000** (a runaway
  backstop).
- `pipeline()` is the default multi-stage primitive precisely because it has no
  barrier: wall-clock equals the slowest single-item chain, not sum-of-slowest
  per stage.

On top of these primitives the ecosystem layers *quality patterns* — adversarial
verify (N skeptics per finding), judge panels, loop-until-dry discovery,
multi-modal sweeps, completeness critics — all expressed as ordinary control
flow over `agent()`. A handful of shapes recur often enough to be canonical:
review-then-verify as a `pipeline()` (each dimension's findings verify as soon
as that dimension finishes, no cross-dimension barrier), loop-until-count or
loop-until-budget (keep spawning finders until a target count or
`budget.remaining()` falls below a threshold), and adversarial/perspective-
diverse verify (N skeptics per finding, kept only if a majority survive).
`parallel()`'s barrier is reserved for the cases that genuinely need every
prior result together (dedup/merge, early-exit on zero); everything else
defaults to `pipeline()`. The load-bearing point underneath all of this: the
orchestration, the model policy, and any safety envelope are all *code* —
versioned, reviewable, and re-runnable, not something reconstructed from
scratch in an agent's head each time.

### A.4 Progress tracking

Progress is **push-based and live**:

- `meta.phases` declares named phase groups up front; `phase()` / `opts.phase`
  assign agents to them. Titles are matched exactly.
- `/workflows` renders a live progress tree (phases → agents → status).
- `log()` emits narrator lines above the tree.
- Completion delivers a `<task-notification>` back into the session.

Under the hood each run has a **transcript directory** containing
`journal.jsonl` (each `agent()` call's actual return value) and `agent-<id>.jsonl`
files (per-subagent transcripts) — the durable record used for diagnosis and
resume.

### A.5 State, resume, and budget

- **Resume** keys on `runId`. Relaunching with `{scriptPath, resumeFromRunId}`
  replays the longest unchanged **prefix** of `agent()` calls from cache
  (same `(prompt, opts)` → instant cached result); the first edited/new call
  and everything after it runs live. Same script + same args → 100% cache hit.
  This is why determinism (A.2) is enforced.
- **Iteration** is file-based: every invocation persists its script under the
  session directory and returns the path; you edit that file and re-invoke with
  `scriptPath`.
- **Budget** ties depth to the user's "+Nk" directive. `budget.total` is a hard
  ceiling; `budget.spent()`/`remaining()` are shared across the main loop and
  all workflows, enabling `while (budget.remaining() > 50_000) { … }` scaling.

### A.6 Lifecycle & trust

A Claude Code workflow is **session-scoped and turn-shaped**: it is one
well-bounded fan-out inside the current agent session, gone when the session
ends (only the transcript persists). Trust is handled by the harness sandbox —
the script can't touch the filesystem; only its tool-bearing subagents can, under
the session's normal permission model.

---

## Part B — akm workflows: technical details

This part deliberately stays high-level: `docs/reference/workflows.md` is the
maintained, exhaustive reference for the unified markdown format, reference
grammar, gates, budgets, the run lease, and the brief/report protocol. What
follows is the comparison-relevant subset — read the reference doc for
anything this section doesn't answer.

### B.0 One format, two execution surfaces, and an experimental gate

An akm workflow is one markdown asset addressed as `workflows/<name>`. Its
frontmatter declares the orchestration graph (`unit`/`map`/`route`, inputs,
outputs, retries, isolation, and budgets), while `## <step-id>` body sections
carry unit/map instructions and optional `### gate` rubrics.

The `start`/`next`/`complete`/`status`/`list`/`create`/`resume`/`abandon` CLI
contract is stable and ungated. What's experimental is native execution and
the driver protocol that mirrors it: `akm workflow run|brief|report` refuse
with a classified `ConfigError`
(`WORKFLOW_ENGINE_NOT_ENABLED`, **exit code 78**) until
`experimental.workflowEngine` is set:

```console
$ akm workflow run some-run-id
{
  "ok": false,
  "error": "`akm workflow run` is EXPERIMENTAL and refuses to run until `experimental.workflowEngine` is set. Run `akm config set experimental.workflowEngine true` to enable it.",
  "code": "WORKFLOW_ENGINE_NOT_ENABLED",
  "hint": "Run `akm config set experimental.workflowEngine true` to enable it."
}
$ echo $?
78
$ akm config set experimental.workflowEngine true
$ akm workflow run some-run-id
{"ok":false,"error":"Workflow run or workflow \"some-run-id\" not found.", ...}
```

(Both outcomes above were reproduced against a real build,
`src/workflows/exec/workflow-engine-gate.ts`; the second command clears the
gate and fails for the ordinary reason instead.) `akm lint --type workflows`
is **not** gated — it only type-checks the unified markdown asset. Creating a
workflow with `akm workflow create <name>` is unaffected either way.

### B.1 Representation

The unified format (`src/assets/workflows/workflow-template.md`, validated
against `schemas/akm-workflow.json`) keeps machine orchestration in
frontmatter and human-authorable prose in the body. Bare whole-value
references (`params.<name>` and `steps.<id>.output.<path>`) wire `map.over`,
`route.input`, and `inputs`; prose is never interpolated. Runtime params, map
items, and declared input artifacts reach units as attached context.

### B.2 Parsers & compiled models

`parseWorkflow` (`src/workflows/parser.ts`) parses the frontmatter graph and
binds body prose into a `WorkflowDocument` (`src/workflows/schema.ts`). It
accumulates `WorkflowError`s instead of throwing, and every element carries a
`SourceRef` line span. The IR compiler (`src/workflows/ir/compile.ts`) lowers
that document into the plan graph (`src/workflows/ir/schema.ts`) executed by
the engine and brief/report driver. Parsed documents cached in `index.db` are
regenerable; only run state (B.3, below) is not.

### B.3 Persistence: durable SQLite run state

Run state lives in **`state.db`**
(`src/storage/repositories/workflow-runs-repository.ts`; the former
`workflow.db` was folded into `state.db` in the 0.9.0 three-database cutover),
whose rows are explicitly **non-regenerable**. **Three** tables, not two:

- `workflow_runs` — `id`, `workflow_ref`, `workflow_title`, `status`
  (`active|completed|blocked|failed`), `params_json`, `current_step_id`,
  timestamps, `scope_key`, `agent_harness`, `agent_session_id`,
  `checkin_armed_at`, plus the engine's own columns: `plan_json`/`plan_hash`
  (the frozen compiled plan) and `engine_lease_holder`/
  `engine_lease_until` (the run lease, see B.5).
- `workflow_run_steps` — `(run_id, step_id)` PK, `step_title`, `instructions`,
  `completion_json`, `sequence_index`, `status`
  (`pending|completed|blocked|failed|skipped`), `notes`, `evidence_json`,
  `completed_at`, `summary`.
- `workflow_run_units` — one row per dispatched (or driver-reported) unit of
  work under the native engine or the brief/report protocol: `run_id`,
  `unit_id`, `step_id`, `status` (`pending|running|completed|failed|skipped`),
  `input_hash`, `result_json`, `tokens`, `failure_reason`, `worktree_path`,
  `session_id`, `last_checkin_at`, `attempts`, `claim_holder`/
  `claim_expires_at`. This table stays empty for a run that only ever used the
  manual `next`/`complete` loop.

Schema evolves through an additive, idempotent migration engine, recorded in
`schema_migrations`. The three-table shape above is the current baseline
(`001-initial-schema` in `src/core/state/migrations.ts`); the pre-cutover
`workflow.db` history that produced it is preserved for reference in
`scripts/akm-migrate/migrate/legacy/workflow-migrations-bodies.ts` —
`004-workflow-run-units` (the table itself), `005`/`007` (unit session id /
check-in columns), `006-frozen-plan-and-lease` (the engine's frozen plan +
run lease), `008`/`009` (unit attempts / claim columns).

### B.4 Execution model: two surfaces, one memory

**Manual loop: akm tracks, the agent executes.** This is the stable default: a
persisted state machine driven by an external agent through a CLI command loop
(`src/workflows/runtime/runs.ts`):

```
akm workflow start    → snapshot steps into state.db, set currentStepId
akm workflow next     → return the current step's instructions (auto-starts if none)
akm workflow complete → validate summary, advance currentStepId
```

The agent reads the instructions `next` returns and does the work in its own
environment (full user shell, no sandbox — see the Security section below),
then repeats `next` → work → `complete` until the run is `completed`.
Sequentiality is strict: exactly one `current_step_id`; `complete` refuses any
step that isn't the current one.

**The same asset under `akm workflow run`: akm executes.** `akm workflow
start` compiles the frontmatter graph and **freezes** the resulting plan on the run row
(`plan_json`/`plan_hash`) — edits to the source file need a new run. `akm
workflow run <run-id>` then dispatches each step's units to the configured
runner (`llm`, `agent`, or `sdk`), with:

- **Real concurrency.** A `map` step's units run through a scheduler
  (`src/workflows/exec/scheduler.ts`) capped by `min(map's concurrency,
  workflow.maxConcurrency, the selected engine's concurrency, a CPU-derived
  host safety limit)`. The CPU-derived default — `min(16, max(1, cores − 2))`
  — is, deliberately, the same formula Claude Code's own `agent()` cap uses
  (A.3).
- **Retries** (`retry: { max, on: [<failure-reason>…] }`), journaled per
  attempt so no attempt's row is clobbered.
- **Worktree isolation** (`isolation: worktree`) — a fresh detached git
  worktree per unit attempt for file-mutating agent/sdk units, so parallel
  fan-out can't trample a shared working tree; a clean one is auto-removed,
  a dirty one is retained and its path logged.
- **Typed step artifacts** — a step's declared `output` JSON Schema validates
  the promoted artifact (a solo unit's result, a `collect` fan-out's array, or
  a `vote` fan-out's majority winner) before the step can complete.
- **Gates that judge the artifact**, with `gate.max_loops` turning a rejection
  into a bounded evaluator-optimizer loop (re-run with the judge's feedback
  threaded into every unit prompt). Omitted or empty rubrics skip validation;
  unavailable or malformed judges fail open.
- **Budget ceilings** (`budget.max_units`/`max_tokens`), enforced across
  resumes because both counters are seeded from the unit journal.

Crucially, the engine is not the only thing that can execute an orchestrated
run: the **harness-neutral driver protocol** (`akm workflow brief` / `akm
workflow report`) lets any agent session — Claude Code included — read the
same frozen plan's active-step work-list and report results back through the
identical shared step semantics (`src/workflows/exec/step-work.ts`) the
engine uses. An engine-driven run and a driver-driven run of the same plan
produce **byte-identical unit graphs**; a run lease (B.5) ensures only one of
the two drives at a time. See *Driving a run from any agent* in
`docs/reference/workflows.md` for the full protocol — it is the sharpest point
of contact between the two systems in this whole comparison.

### B.5 Scoping & concurrency guards (two different guards)

Runs are partitioned by **`scope_key`** — a `sha256` of the nearest project
anchor (`.akm/config.json` root → git root → bundle dir → cwd),
`src/workflows/authoring/scope-key.ts`. Within a `(workflow_ref, scope_key)`
pair, `startWorkflowRun` enforces a **single active run** unless `--force` is
passed, so two terminals starting the same ref can't leave two runs racing
for `next` to pick between. This guard applies to every run.

Orchestrated runs add a second, unrelated guard: the **run lease**. `akm
workflow run` takes a lease (a random holder id, 90s expiry, renewed between
steps) before dispatching anything; a second `run` invocation against a
live-leased run refuses, and manual `complete`/driver `report` calls are
likewise refused while the lease is live — the engine owns the step spine
while it drives. An expired lease is claimable, so a crashed engine never
wedges a run. `next`/`status`/`brief` stay read-only and always work.

### B.6 Progress tracking

For the manual loop, progress is still **pull-based**: `next`/`status`
report step rows, notes, evidence, and summary; there's no daemon, the agent
(or human) polls. This much is unchanged from before the engine existed.

What's new: **`akm log --run <run-id>`** reads a run's `workflow_*` /
`workflow_unit_*` events off the general append-only events stream;
`--since '@offset:<id>'` resumes from the last seen row-id cursor, so a
cooperating process can poll it on an interval — there's no daemon, and
no dedicated workflow-watch command (0.9.0 dropped one; this is the general
`log` surface instead). It's not a push channel in Claude Code's
`/workflows`-live-tree sense (there's no server pushing to a client — the
poller polls under the hood), but it closes most of the practical gap: a
second terminal polling `akm log --run <run-id> --since '@offset:<id>'` next
to `akm workflow run <run-id>` gets a live-feeling tail with no daemon of its
own. Event metadata is ids/status/enums only, never workflow-authored
content, so it's safe to pipe into logs or dashboards.

### B.7 Quality gates

The manual `next`/`complete` loop requires a completion summary. When the step
has a gate rubric and an LLM
is configured, `validateStepSummary`
(`src/workflows/validate-summary.ts`) judges the summary text against each
criterion, fail-open (no criteria/no judge/an errored verdict all let the
step complete). `blocked` status still models human-review gates;
`akm workflow resume` still flips a `blocked`/`failed` run back to `active`.

The engine-driven gate (B.4) judges different material: it
evaluates the step's **promoted artifact** (real JSON data, clipped at 4000
chars) against the criteria, not a machine-generated prose summary. Both
gates are optional LLM calls and fail open when no valid verdict is available;
invoked engine gates are journaled.

### B.8 Check-in: stall nudging without a daemon

Unchanged from before the engine: akm records the driving **agent identity**
(`agent_harness`, `agent_session_id`) from environment hints
(`src/workflows/runtime/agent-identity.ts`), arms a **check-in** timestamp
(`checkin_armed_at`) — not a background thread — and on the next `workflow
next`/`status` poll, `evaluateCheckin()`
(`src/workflows/runtime/checkin.ts`) compares `now` against
`max(updated_at, checkin_armed_at)`; past a 90s stall window it surfaces a
`continue` directive through the normal command output. The design ADR
explicitly rejects a background-thread alternative: "No daemon in a CLI… the
command loop is already the heartbeat." A parallel, independent check-in
exists at the *unit* level for the brief/report driver protocol
(`--status running` claims and heartbeats a long-running unit so a second
driver can reclaim it if the first goes silent) — same no-daemon,
pure-timestamp design, different granularity.

### B.9 CLI surface

`akm workflow` (`src/commands/workflow-cli.ts`) exposes **eleven**
subcommands — derived here from `workflowCommand.subCommands`, not
hand-listed:

```
akm workflow start|next|complete|status|list|create|resume|abandon|run|brief|report
```

`start`, `next`, `complete`, `status`, `list`, `create`, `resume`,
and `abandon` are stable and ungated (`create --print` prints a starter
template without writing, and `akm lint --type workflows` — not a `workflow`
subcommand — structurally validates the unified markdown format; 0.9.0
dropped the standalone `template`/`validate`/`watch` subcommands). `run`,
`brief`, and `report` are the experimental, gated engine surface (B.0). Bare
`akm workflow` with no subcommand is a usage error (exit 2); there is no
default action.

---

## Part C — Side-by-side

akm has one asset format with a stable manual loop and an experimental native
engine/driver surface.

| Dimension | Claude Code workflow | akm workflow |
|---|---|---|
| **Artifact** | Imperative JS program (`script`) | Unified declarative Markdown asset (`.md`), compiled to a plan graph |
| **Authored by** | The agent, inline, per-task, ephemeral | Human or agent, saved as a reusable bundle asset |
| **Who executes work** | The harness runs the script; subagents do the work | An external agent via `next`/`complete`, the native engine, or an external driver via `brief`/`report` |
| **Unit of work** | `agent()` — a fresh LLM subagent context | A sequential step in the manual loop; one dispatch or one `map` item under the engine/driver |
| **Concurrency** | Massively parallel (≤16 concurrent, ≤1000 total, `pipeline`/`parallel`) | Sequential in the manual loop; bounded map concurrency under the engine/driver |
| **Control flow** | Full JS: loops, conditionals, fan-out, budget-scaled | `unit`/`map`/`route`, bare reference strings, and bounded gate retries; no backward routes |
| **State store** | Transcript dir (`journal.jsonl`, `agent-*.jsonl`) | SQLite `state.db`; engine/driver runs add unit rows and a frozen `plan_json`/`plan_hash` |
| **Scope / lifetime** | One session, one turn-shaped fan-out | Cross-session, per-project `scope_key`, resumable indefinitely |
| **Progress model** | Push: live `/workflows` tree + `task-notification` | Pull via `next`/`status`, with near-live NDJSON event polling via `akm log` |
| **Resume** | Prefix-cache replay keyed on `runId` (needs determinism) | Durable row resume; engine/driver units add journaled replay keyed on content-derived identity |
| **Quality gates** | Agent-authored (adversarial verify, judge panels, schemas) | Optional LLM validation: summary-based in the manual loop, typed-artifact-based under the engine/driver; `gate.max_loops` bounds retries |
| **Sandbox / trust** | Restricted JS interpreter, no FS; subagents use tools | No sandbox; engine units can opt into `isolation: worktree`, which is not a security boundary |
| **Nesting** | `workflow()`, one level deep, sharing the parent's concurrency cap/budget | None built in |
| **Stability** | Stable harness feature | Format and manual loop stable; `run`/`brief`/`report` experimental and opt-in |

---

## Part D — Where they overlap

Despite living on different layers, they converge on several ideas — and the
native engine (Part B.4) made two of these convergences much closer than they
used to be:

1. **Task decomposition into named units** — phases/agents vs. steps/units.
2. **Durable run identity and resume** — `runId` prefix-cache vs. `state.db`
   workflow-run rows. Both are built to survive interruption and pick up where
   they left off; the native engine's resume is also **journaled replay**
   keyed on content-derived unit identity, much closer in spirit to Claude
   Code's cache-and-replay than the markdown loop's plain row re-read.
3. **Per-unit status + evidence** — journal return values vs. step
   `status`/`notes`/`evidence`/`summary`, or (for engine/driver runs) per-unit
   `workflow_run_units` rows with the same shape.
4. **A "keep going" nudge** — Claude Code's `task-notification`/resume vs.
   akm's run-level `continue` check-in directive and its unit-level `--status
   running` heartbeat via the driver protocol.
5. **Structured validation of results** — Claude Code's `schema` option
   (forced `StructuredOutput`, retried) vs. akm's per-unit `output` JSON
   Schema under the engine/driver and the manual loop's LLM
   summary-vs-rubric judge.
6. **Scaffolding + validation of the artifact** — `meta` shape checks vs.
   `akm workflow create --print` / `akm lint --type workflows` and the
   accumulating parser for the unified format.
7. **Bounded, capped concurrency with the same default formula.** Claude
   Code's `agent()` cap and akm's unit scheduler both default to
   `min(16, cores − 2)` — not a coincidence; the engine's CPU-derived default
   was written to match it (B.4).
8. **Awareness of the driving session** — Claude Code owns the session; akm
   *records* it (`CLAUDE_SESSION_ID` → `claude-code`). Under the engine this
   awareness becomes load-bearing, not just descriptive: the run lease (B.5)
   uses it to arbitrate who is allowed to drive a given run right now.
9. **A shared execution surface, by design.** The harness-neutral driver
   protocol (`brief`/`report`) means a Claude Code session can literally *be*
   the thing executing an akm-orchestrated run's units — the two systems don't
   just resemble each other, one can drive the other through a stable
   contract with byte-identical results to the native engine (B.4).

---

## Part E — Where they still diverge, and where they no longer do

The old axis — "who holds the execution loop" — is still the right frame, but
it no longer sorts cleanly by *system*. For akm, it depends on **which
execution surface is in play.**

- **Claude Code workflows always own execution.** The harness is the runtime;
  the script is the plan; subagents are the workers. Because the harness
  replays the script to resume, it must constrain the script (no wall-clock,
  no randomness, no FS) and keep it ephemeral. Parallelism is free because the
  runtime schedules it.

- **An akm workflow in the manual loop owns memory, not execution** — this half
  of the old thesis is entirely unchanged. `next`/`complete` hands
  instructions to an external agent and records what comes back; it never
  parallelizes, never spawns a worker of its own, needs no determinism
  constraints because it never replays a script. Its value is durability and
  gating: state that outlives any session, plus `blocked` human gates a
  fire-and-forget fan-out has no place to put.

- **The same workflow under `akm workflow run` owns execution too** — this is
  the half of the old thesis that changed. The native engine
  dispatches real concurrent units (through the existing multi-harness
  substrate: `RunnerSpec` `llm|agent|sdk` + `executeRunner`, the same spawner
  `akm improve`/`reflect` already used), retries them, isolates them in
  worktrees, judges their typed artifacts, and enforces budget ceilings — a
  genuine executor, gated behind `experimental.workflowEngine` (B.0) while it
  earns stability. It executes the same markdown asset and keeps its durable
  spine through a frozen plan and journaled resume rather than trading those
  properties away for parallelism.

Concretely, per surface:

| | Claude Code workflow | akm manual loop | akm native engine (`run`, experimental) |
|---|---|---|---|
| Lifetime | Ephemeral (session-scoped) | Durable (SQLite, cross-session) | Durable (SQLite, cross-session) |
| Parallel? | Yes, by construction | No, by design | Yes, bounded (B.4) |
| Self-contained? | Yes — carries its own workers | No — inert without a driving agent | Partially — the native engine can drive itself, or hand off to `brief`/`report` |
| Sandbox | Restricted JS interpreter, no FS for the script itself | None — full user shell | None for the shell/agent substrate; opt-in `isolation: worktree` for file mutation, not a security boundary |
| Artifact | Executable script | Managed markdown asset (indexed, searched, `curate`d, versioned) | The same markdown asset, compiled and frozen for execution |

The genuinely durable conclusion, restated for 0.9.0: Claude Code is strong
at in-session parallel LLM execution, while akm is strong at durable,
cross-session procedures. The native engine keeps the second half of that
trade while buying back some of the first — and the driver protocol lets
Claude Code drive the same durable spine directly.

---

## Part F — What's left to integrate

Most of what this section used to propose as *future* integration work has
**shipped** as the native engine and the harness-neutral driver protocol
described in Part B — not as Claude-Code-specific features, but as
harness-agnostic ones any driver (including Claude Code) can use today:

| Formerly-proposed idea | Status |
|---|---|
| A blessed "akm-driver" loop pattern any agent runs to drive an akm run, with structured per-step results | **Shipped**, generalized: the `brief`/`report` driver protocol (Part B.4) — not Claude-Code-specific, any agent session works |
| Machine-readable, near-live progress instead of polling `status` | **Shipped**: `akm log --run <id> --since '@offset:<id>'` (Part B.6) |
| Structural (schema) validation of step output, not just an LLM prose judge | **Shipped**: per-unit `output` JSON Schema + typed step artifacts, validated before a gate ever runs (Part B.4/B.7) |
| An explicit, opt-in fan-out step type | **Shipped**: `map` steps with `over`/`concurrency`/`reducer` (Part B.4) |

What's genuinely still not built, as of this writing:

### F.1 Correlate an akm run with the driving harness's own run/session id

`agent-identity.ts` captures `agent_harness`/`agent_session_id` from
environment hints, and the driver protocol's `--session-id` flag records a
harness-native session id per unit (Part B.3). Neither captures a *workflow-
level* id from an external orchestrator (e.g. a Claude Code `Workflow` tool's
own `runId`) when one is driving an akm run — there is no env-hint or CLI flag
for it today, so correlating "this akm run was driven by that Claude Code
workflow invocation" still has to be done by hand (matching timestamps, logs).

### F.2 Let a stalled run's check-in wake the driver instead of waiting to be polled

The check-in (Part B.8) is still exactly as passive as the ADR mandates: it
surfaces only on the next `workflow next`/`status` poll, never proactively.
There is no signal-file or other out-of-band mechanism that lets a stalled
run *notify* a harness capable of receiving one (the ADR's own design
contemplates "a best-effort checkin signal file under the run scope" as a
future extension) — this remains unbuilt.

### F.3 Two-way compilation between the artifacts

Neither direction exists: there is no `akm workflow export` that emits a
driver script/pattern specialized to a given workflow for a specific harness,
and there is no `akm workflow ingest-journal` (or equivalent) that backs an
externally-orchestrated run with an akm run for durability. The driver
protocol (shipped) covers the *live* case — an external agent driving an akm
plan in real time — but not converting between the artifacts themselves after
the fact.

### F.4 Suppress the check-in when the driving harness already owns liveness

The check-in fires uniformly for any active run past the stall window
(`evaluateCheckin`, Part B.8) — it does not special-case a recorded
`agent_harness` that is known to own its own liveness/orchestration (so
wouldn't stall the way a free-form chat agent can). This is a small, purely
local trim on top of the existing check-in logic, not a new subsystem, but it
is not implemented today.

### F.5 Distribute non-akm executable workflow scripts as akm assets

The `workflow` asset type carries akm's unified markdown format. There is no
mechanism for it to carry or reference an
externally-executable script (a Claude Code `Workflow` tool script, or
anything else) as an alternate form alongside the runbook, which would let
akm's package-manager strengths (`add`, search, `curate`, version pinning,
feedback/improve) apply to *that* artifact too. This is the largest and most
speculative item on this list.

The guiding principle from the original version of this section still holds
and is, if anything, more clearly demonstrated now that part of it has
shipped: **don't make akm imitate Claude Code's executor, and don't make
Claude Code imitate akm's durability.** The native engine gives akm real
concurrency without discarding its durable/gated spine (Part E), and the
driver protocol means Claude Code can drive that spine directly instead of
either side reinventing the other.
