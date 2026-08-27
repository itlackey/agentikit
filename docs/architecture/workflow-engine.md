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
plan **`irVersion` 5** on the run row (`plan_json` + `plan_hash`); a new start
never emits an older version.

The durable plan includes a guarded, canonical `sourceReadSet` covering the
workflow and every command/persona/task/script source it owns — and, for a
step that composes a child workflow, every source the child transitively owns
too (see [Child workflows](#child-workflows)). Each entry records logical and
physical identity, content hash, and containment evidence, so aliases,
replacements, and source races fail before publication.

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

## Child workflows

A step that composes another workflow — directly (`uses: workflows/<ref>`)
or through a task whose own target is a workflow (`uses: tasks/<ref>`) —
freezes to a `child-workflow` frozen target. Unlike the `command`/`shell`/
`script` targets, a `child-workflow` target carries the child's **complete
frozen plan, embedded**: compiling the parent recursively compiles,
validates, and freezes each child in full — depth-first, all of it — before
the parent run is ever published. Nothing about a child is re-read at
dispatch time; the embedded plan is authoritative. See
[Workflow Schema: Child workflows](../reference/workflow-schema.md#child-workflows)
for the authoring-side view, including the three composition bounds (depth,
cycle, aggregate embedded bytes) enforced at freeze.

**Decode-time integrity chain.** Every time a plan carrying an embedded child
is decoded, the child is re-verified recursively, in order: the parent's own
canonical bytes are hashed and checked against its `plan_hash`; its
`irVersion` is checked; then, for each embedded child, the same two checks
run again against the embedded bytes (`sha256(canonicalPlanJson(frozenPlan))
=== planHash`, `irVersion === 5`), plus a check that the target's own
`contentHash` (covering `ref`, `planHash`, `via`, and any `taskRef`/
`inputBindings`) still matches. A single tampered byte anywhere in an
embedded child — or an embedded child claiming any `irVersion` other than 5
— fails the parent's decode, not just the child's. This closes the same
corruption boundary the top-level `plan_hash` check already closes, extended
recursively through however many levels of composition a plan embeds.

This release freezes child workflows into the parent's plan; it does not yet
execute them. See [Workflow Schema: what is not yet available](../reference/workflow-schema.md#what-is-not-yet-available).

## Resume is journaled replay

Only the current durable plan version is executable — checked structurally,
without decoding the stored plan bytes. A stored run frozen at an older
`irVersion` keeps `akm workflow status`, `list`, and `abandon` working (they
never read the plan itself), but `resume`, `next`, `complete`, and a bare
`run` against that run id fail closed with `UsageError` code
`WORKFLOW_IR_VERSION_UNSUPPORTED`, naming the run's frozen version and
pointing at `akm workflow abandon` — see
[Migrating from akm 0.9.1 to 0.9.2](../migration/v0.9.1-to-v0.9.2.md#workflow-cutover)
for the exact message and recovery steps. There is no second executor and no
compatibility replay layer for an old plan version; abandon it and start a
new run from current source instead of carrying an old execution
architecture inside the runtime.

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
