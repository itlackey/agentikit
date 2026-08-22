# Architecture: The Workflow Engine

A workflow compiles to a frozen plan, persists run and unit state, dispatches
its work, verifies declared gates, and resumes without replaying completed
units. This page is the architecture-level reference for that engine — how a
run's plan is frozen and stored, how dispatch and resume actually work, how
one engine owns a run, and how isolated file-mutating units execute. For the
exact frontmatter/body syntax that produces the plan, see
[Workflow Schema](../reference/workflow-schema.md). For the day-to-day
commands that drive a run, see [Running Workflows](../guides/run-workflows.md).

> **`akm workflow run` is Stable, ungated, and the only execution surface.**
> It is the canonical start/resume/execute command; there is no separate
> external-driver protocol.

## Frozen plans

The first `akm workflow run <ref>` compiles either peer source format through
source IR v1. Every new run/start creates and atomically publishes durable
plan IR v4 on the run row (`plan_json` + `plan_hash`); a new start never emits
v3.

The v4 durable plan includes a guarded, canonical `sourceReadSet` covering the
workflow and every command/persona/task/script source it owns. Each entry
records logical and physical identity, content hash, and containment evidence,
so aliases, replacements, and source races fail before publication.

Dispatch-significant material is immutable. The resolved request is frozen,
the resolved target is frozen, and runner selection is frozen.
Working directory (`cwd`) identity is frozen.
Executable identity is frozen. Git identity and its commit OID are frozen.
Exact models, inference, tools and authorization,
execution limits, parameter snapshots, command/script bytes, and verifier
selection therefore cannot drift under an in-flight run.

Workflow environment asset values are the narrow live-value exception within
authored workflow inputs.
The environment owner key set and secret-token topology are frozen.
Literal values remain frozen. Pass-through bindings
materialize at dispatch from the current process, and env/secret references
materialize their current values only after owner/topology checks. Durable
plans never store secret values or enable whole-process `inheritEnv`.

**A run executes the plan compiled at creation; edits to source need a new
run.** Orchestration decisions are pure functions of the frozen plan, run
params, and journaled results.

## Resume is journaled replay

Durable plan v3 is an exact compatibility island. Its decoder and canonical
bytes remain unchanged; a stored v3 row resumes as v3 rather than being
rewritten, refrozen, or normalized to v4.

Resume never re-reads authored workflow source. Resume never re-reads config
or configuration. Resume never re-reads the asset index. It validates the
persisted plan version and consumes only frozen dispatch inputs plus journaled
attempts and results.

Every dispatched unit is journaled with a content-derived identity — the step
id plus a hash of the unit's frozen instructions, its item (for a map unit),
its declared `inputs:` artifacts, and the params snapshot — and its input
hash. On re-run, a journaled completed unit with the same identity and the
same inputs is **reused**, never re-dispatched; a failed or missing unit is
dispatched live. If a journaled completed unit matches by identity but its
recorded inputs differ, the engine fails the step with a **replay
divergence** error naming the unit — it never silently re-runs work whose
inputs changed under it. (Divergence means the program produced different
data for the "same" unit across invocations — a nondeterminism bug worth
surfacing, not papering over.)

## Durable attempts and at-least-once dispatch

Workflow dispatch is at-least-once. Every unit has a stable content-derived
unit id and an append-only sequence of attempts.
A crash reclaim reuses the same stable dispatchId for the interrupted attempt.
An explicit retry gets a new dispatchId under one stable unit id and increments the attempt number.

The run lease and attempt claim fence stale completions after ownership changes,
but they cannot prove whether an external process completed immediately before
a crash. An ambiguous crash outcome may re-run and can produce a duplicate
side effect. Workflow actions should be idempotent or use the stable dispatch
identity as their own deduplication key.

## One engine drives a run (the run lease)

`akm workflow run` takes a **run lease** before dispatching anything: a
random holder id with a 90-second expiry recorded on the run row, renewed
between steps, and released when the invocation exits. A second
`workflow run` against a live-leased run refuses up front, naming the holder
and the expiry. An *expired* lease is claimable, so a crashed engine never
wedges a run — wait out the expiry and re-run. While the lease is live the
engine owns the step spine. `workflow status` remains read-only; run detail
surfaces a live lease as `engineLease` (holder + expiry).

## Worktree isolation

A file-mutating unit can declare `isolation: worktree` in its `unit:` bag
(agent and sdk runners) — see
[Workflow Schema: Frontmatter keys](../reference/workflow-schema.md#frontmatter-keys).
Each unit attempt gets a fresh **detached git worktree** of the run's base
repository under a run-scoped temp directory; the worktree path is journaled
on the unit row and passed to the harness as its working directory, so
parallel fan-out units can never trample each other's working tree. After the
unit finishes, a clean worktree (`git status --porcelain` empty) is removed
automatically; a dirty one is retained and its path logged, so uncollected
work is never destroyed. Declaring worktree isolation in a non-git directory
fails the step cleanly before anything dispatches.

> **Warning — outputs matched by `.gitignore` are treated as disposable.** A
> worktree-isolated unit's output survives only if it lands on a
> **collectible path**: a tracked file, or an untracked file your repository
> does **not** `.gitignore`. Anything a unit writes to a `.gitignore`d path —
> build outputs, caches, logs, dependency directories like
> `node_modules`/`dist`, or a scratch file under an ignored directory — is
> **discarded** when its clean worktree is auto-removed. If a unit produces an
> artifact that must survive, write it to a non-ignored path, or report it as
> a result (a structured `output` / free-text result), before the unit
> returns.

The clean probe deliberately does **not** pass `--ignored`, so "uncollected
work" means tracked or untracked-*unignored* changes only. A worktree whose
only residue is files your repository's own `.gitignore` matches is treated
as clean and removed: those files are disposable by the repo's own
declaration, and retaining a worktree after every package install or build
would blow up disk under the temp root.

## Concurrency limits

Native fan-out (`akm workflow run`) uses the minimum of four limits: the
map's declared `concurrency`, the run's frozen `workflow.maxConcurrency`, the
selected frozen LLM engine's `concurrency` (including an SDK engine's
fallback LLM), and the current host's CPU-derived safety limit. Reapplying
host safety keeps a run safe when it resumes on a smaller machine.

- **Unset (default):** the CPU-derived value `min(16, max(1, cores − 2))` — a
  conservative default that leaves headroom on the host and matches the
  original Claude-Code cap.
- **Set:** an explicit positive integer, clamped when frozen to `[1, 64]`
  (values above 64 are clamped down, never rejected, so one config shared
  across machines with different core counts never hard-fails).

```console
$ akm config set workflow.maxConcurrency 8   # raise the frozen workflow limit
$ akm config get workflow.maxConcurrency
8
```

A workflow that fans out is authorizing **N parallel agents**, not one — see
[Running Workflows: workflow sources are executed code](../guides/run-workflows.md#security-workflow-sources-are-executed-code)
for what that means for trust.

## Run scope and persistence

Run state (`plan_json`, `plan_hash`, step statuses, the unit journal, and the
engine lease) persists in the project's `state.db`. Run state is scoped to
the current project directory — the nearest `.akm/config.json`, git root,
bundle root, or current directory — so the same workflow can run
independently in separate projects, and `akm workflow list`/`status` without
an explicit run id only ever see runs in that scope.

## See also

- [Workflow Schema](../reference/workflow-schema.md) — exact frontmatter,
  refs, gates, and outputs syntax
- [Running Workflows](../guides/run-workflows.md) — start, inspect, resume,
  and abandon a run
- [Author's Guide: Writing Workflows](../guides/author-workflows.md) — writing
  and testing a workflow definition
