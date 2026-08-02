# Task / Workflow Unification: One Target Vocabulary, One Prose Rule

Status: PROPOSAL v5 — owner decisions from review rounds 1–4 applied
(see §9 decision log). Baselined on `claude/release-0-9-0-polish-d6sycl`
(post-"`run` is the canonical orchestrator"). Breaking changes are approved
for the 0.9.0 release.
Date: 2026-08-01
Related: [`workflow-format-unification.md`](./workflow-format-unification.md),
[`okf-support.md`](./okf-support.md),
[`docs/reference/workflows.md`](../../reference/workflows.md),
[`docs/migration/v0.7-to-v0.8.md`](../../migration/v0.7-to-v0.8.md)

---

## 1. Grounding — what tasks and workflows are in akm

Stated by the owner; everything below derives from these three points.

1. **A task is a bundle asset that abstracts over OS-scheduled work.** It is
   *discovered* (search/show, like any asset) and *enabled* — enabling creates
   an entry in the OS scheduler (cron / launchd / schtasks) that executes the
   work the task defines, or dispatches an agent with the task's prompt. The
   point is a platform-agnostic way to **share and store repeatable
   processes**, scheduled through one consistent CLI.

2. **A task and a workflow step are conceptually the same job** — execute a
   command, a script, or a prompt — positioned behind a schedule in one case
   and inside a procedure in the other. Unifying the underlying execution code
   cuts duplication and gives workflows abilities steps lack today: run a
   script as a step, execute a command asset as a step.

3. **Reduce the number of concepts and formats a user must learn.** The
   measure of success is lower cognitive load, not architectural novelty.

Not in scope: tasks do not grow `steps:`; workflows do not grow `schedule:`;
there is no step reference/reuse system. The unit of sharing is the asset, the
unit of scheduling is the task, the unit of procedure is the workflow.

## 2. Baseline

Four facts from the `release-0-9-0-polish` branch this design builds on:

- `akm workflow run <ref|run-id>` is the canonical orchestrator — Stable,
  ungated, owning creation, dispatch, completion, and durable replay
  (`start`/`next`/`complete` are removed; only the `brief`/`report` driver
  protocol keeps the `experimental.workflowEngine` opt-in). There is no
  execution-gate asymmetry between tasks and workflows.
- Scheduled workflow tasks already execute end-to-end
  (`runWorkflowTask()` → `runWorkflowSteps()`).
- Workflow params are **declared flags** coerced through frozen parameter
  schemas — any param passing below rides that mechanism.
- `src/workflows/exec/unit-dispatch.ts` is the one dispatch seam.
  `UnitDispatchRequest` already carries an assembled `prompt`, a frozen engine
  snapshot, `timeoutMs`, `env`, `cwd`, and `sensitiveValues`; results carry a
  structured `failureReason`. The shared execution layer plugs in there.

## 3. The format

### 3.1 Two target keys: `uses:` and `run:`

| Declaration | Work performed | Inputs |
|---|---|---|
| *(none)* | Dispatch an agent with **the nearest prose** as the prompt | — |
| `uses: <asset-ref>` | Execute the referenced asset **per its type**, which the ref's subdir already declares (§3.2) | `params:`, `env:` |
| `run: <shell text>` | Execute inline shell — no AI. GitHub-Actions `run:` semantics (§3.5) | `env:` |

`uses:` and `run:` are mutually exclusive — one schema rule, and the whole
class of "provided a script *and* a command on one task/step" errors is
structurally impossible. A ref key and an inline key also cannot be confused,
so no ref-vs-inline sniffing exists anywhere in the format.

> **The prose rule.** The machine surface names the target; the nearest prose
> is the instructions. In a task that is the document body; in a workflow step
> it is the `## <step-id>` section. With no target key, the prose *is* the
> work, dispatched to an agent.

That sentence is the entire shared learning curve. It also retires `prompt:`
for good — its three overloaded meanings (inline text / asset ref / file
path) and the `resolvePromptSource()` sniff that disambiguated them all go:
inline text is the body, an asset ref is `uses:` or `agent:`, and file paths
are dropped with the `.yml` format (§8).

### 3.2 What `uses:` accepts — the ref carries the type

akm refs are subdir-qualified concept ids, so the asset type is visible in
the value; no key-per-type is needed to keep the vocabulary aligned to asset
types:

| Ref | Execution | Inputs |
|---|---|---|
| `uses: commands/<name>` | Fill the command asset's template (its type contract — "a prompt template with placeholders"), dispatch an agent with the result | `params:` fill the placeholders |
| `uses: scripts/<name>` | Execute the script asset per its own `run`/`setup`/`cwd` metadata — no AI | `env:` |
| `uses: workflows/<ref>` *(tasks only)* | Run the workflow via `runWorkflowSteps()`; on a step this is an error (no nesting) | `params:` → the declared param flags |
| `uses: agents/<name>` | **Error**, with the hint: an agent is a persona, not work — set `agent:` (§3.3) |

Template filling stays scoped to the command asset type, whose definition
already is "a template with placeholders" — bodies remain verbatim, per
[`workflow-format-unification.md`](./workflow-format-unification.md) §2.3.
Filling happens before dispatch, producing the `prompt` string
`UnitDispatchRequest` expects; a placeholder with no matching param is an
error at fill time.

### 3.3 Dispatch options — one bag, three tiers

One set of option keys, spelled identically on a task and on a step. Tier 1
is the shared core; tiers 2 and 3 are what each container legitimately adds.

**Tier 1 — shared core.** For agent-dispatched work, three keys with three
disjoint nouns — *who*, *the runner*, *the request*:

| Key | Meaning | Applies to |
|---|---|---|
| `agent:` | **Who** — an `agents/<name>` asset to embody: its system prompt, model hint, and tool policy | agent-dispatched targets (prose, `uses: commands/*`); no-op elsewhere, flagged by `akm lint` |
| `engine:` | **The runner** — a named engine from config; defaults to `defaults.engine` | agent-dispatched targets |
| `llm:` | **The request** — `model`, `temperature`, `max_tokens`, … (the fields an LLM request body carries; `model` moves in here from its former top-level spot) | agent-dispatched targets |
| `timeout:` | `10m` / `30s` / `none` | all targets (whole-run timeout for `uses: workflows/*`) |
| `env:` | Environment for the dispatched work (§3.6) | all targets |
| `cwd:` | Working directory | `run:` (a script asset's own `cwd` metadata wins) |
| `shell:` | Shell override for `run:`; defaults: `sh` on POSIX, `powershell` on Windows | `run:` |
| `params:` | Inputs to the referenced asset | `uses:` commands (placeholders) and workflows (declared flags) |

Model precedence, the one overlap, in one line: **`llm.model` > the agent
asset's model hint > the engine's default.**

One rule for inapplicable combinations: **ignored at runtime, flagged by
`akm lint`** — e.g. `agent:` next to `run:` is a no-op with a lint notice,
not an error.

**Tier 2 — graph keys, steps only:** `map`, `route`, `inputs`, `output`,
`gate`, `retry`, `on_error`, `isolation`. These are orchestration — fan-out,
routing, artifact typing, judged gates, retry against the failure taxonomy,
worktree isolation — and stay where the orchestrator is.

**Tier 3 — trigger keys, tasks only:** `schedule`, `enabled` (plus the full
asset envelope, §4).

A scheduled *gated* process is therefore not a gap: it is a task whose target
is a one-step workflow — gates live in tier 2, schedules in tier 3, and
`uses: workflows/<ref>` is the bridge.

### 3.4 Steps flatten to the same shape (schema change)

Today a step's dispatch configuration hides inside a `unit:` bag (and a map
step's inside `map.unit`), while `output:` is declared **both** on the step
and inside the bag — a live wart in `schemas/akm-workflow.json`. If tasks and
steps are to read identically, the bag is the obstacle. So:

- **`unit:` and `map.unit` are deleted.** Targets and tier-1/tier-2 options
  sit directly on the step. `map:` keeps only `over` / `concurrency` /
  `reducer`; the step's own target and options are the per-item template.
- A route step still takes no target or dispatch keys; `map`/`route` remain
  mutually exclusive.
- The duplicate `output` declaration disappears with the bag.

```yaml
steps:
  - id: run-tests
    run: bun test
    timeout: 5m
  - id: review
    uses: commands/code-review
    agent: agents/reviewer
    retry: { max: 2, on: [timeout] }
  - id: fix
    map: { over: steps.review.output.findings, concurrency: 3 }
    isolation: worktree          # per-item template: step-level keys
  - id: summarize                # no target → agent + its ## summarize section
    inputs: [steps.review.output]
```

A step entry is now a task's frontmatter minus the envelope and trigger, plus
graph position. That is point 3, made literal. Cost: schema and golden churn
on a pre-release format — approved.

### 3.5 `run:` semantics

- **Always a shell**, single line or block scalar — the GitHub Actions
  behavior, one rule, no line-count semantics. `sh` on POSIX, `powershell` on
  Windows; `shell:` overrides. (`run:` is also the script asset's own
  metadata key for its shell line — the same word means the same thing in
  both places.)
- A shell unit inside a workflow journals like any unit
  (`workflow_run_units`): no tokens, but status, timing, attempts, and
  `failure_reason` behave normally.
- A `map:` step with a `run:` or `uses: scripts/*` target receives its item
  and index as `AKM_ITEM` (JSON-encoded) and `AKM_ITEM_INDEX` in the
  environment — the env-not-argv stance applied to fan-out; no argv
  substitution exists.

### 3.6 `env:` — literals and refs in one property

`env:` is a **list**; each entry is either an env-asset ref (inject the whole
group) or a mapping of literal pairs. A value that is a `secrets/<name>` ref
resolves to the secret at runtime. Later entries win, which gives layering
its precedence rule for free. A bare mapping is shorthand for a single-entry
list, so the GitHub-Actions spelling works as muscle memory:

```yaml
env:
  - env/prod                      # whole group, values redacted from logs
  - LOG_LEVEL: debug              # literals
    NODE_ENV: production
  - DATABASE_URL: secrets/db-url  # ref-valued entry → the secret, redacted
```

```yaml
env: { LOG_LEVEL: debug }         # bare-mapping shorthand
```

This **extends the existing schema additively** — the workflow `unit.env` is
already a list of ref strings, so every currently-valid value stays valid.
Values sourced from `env/` and `secrets/` assets join the dispatch's
`sensitiveValues`, riding the redaction seam `unit-dispatch.ts` already has.
For a `uses: workflows/*` target, `env:` merges into the run's process
environment.

## 4. The task asset

A task is an ordinary akm markdown asset at `<bundle>/tasks/<id>.md`: the
shared envelope (`description`, `tags`, `when_to_use`, `xrefs`, and the OKF
v0.2 `generated`/`verified`/`provenance`/`status`/`stale_after` families via
`$ref akm-asset-envelope.json`), the trigger keys, at most one target, and
tier-1 options. There is no `version:` key — identity is the ref and the
schema evolves additively, as the workflow format already decided.

An agent task — the 0.7.x markdown task restored, minus the sentinel:

````markdown
---
type: task
description: Weekly review digest.
schedule: "0 8 * * 1"
agent: agents/reviewer
timeout: 10m
---

Review the week's completed tasks and summarize action items.
Group the summary by bundle. Call out anything that failed more than twice.
````

A shell task — what today's `command:` tasks become; the body is optional
runbook prose (indexed, shown by `akm show`, never executed):

````markdown
---
type: task
description: Full nightly quality sweep.
schedule: "15 2 * * *"
run: akm improve --strategy thorough --skip-if-locked
---

# Nightly improve sweep

If this starts failing, check `akm task history --id akm-improve-nightly`,
then `akm health`. A `blocked` status usually means a stale improve lock.
````

A command-asset task and a workflow task:

````markdown
---
type: task
schedule: "@daily"
uses: commands/weekly-review
params: { scope: team }
env:
  - env/prod
---
````

````markdown
---
type: task
schedule: "0 9 * * 1"
uses: workflows/ship-release
params: { version: nightly }
---
````

The lifecycle is untouched: discovery via `akm search --type task` /
`akm show tasks/<id>`; enablement via `enabled:` + `akm task sync`; the OS
entry still invokes `akm task run <id>`; setup still reviews templates before
touching the scheduler. What markdown adds: a home for the prompt and the
runbook, OKF provenance stamping with no special-casing, `xrefs` to the
lesson or incident behind the task, and `status: draft` as author-now,
arm-later (draft tasks are never installed by `sync`).

## 5. GitHub Actions alignment — familiar, not copied

The owner's rule: follow GHA style wherever it doesn't compromise akm's
strengths. `uses:`/`run:` now match GHA outright — and cost akm nothing,
because akm refs are subdir-typed, so `uses: scripts/lint-all` still says
*what* executes right in the value.

**Adopted from GHA:**

| GHA | Here |
|---|---|
| `uses:` names the reusable thing, `run:` is inline shell, at most one of them | same — and the ref's subdir supplies the type GHA leaves opaque |
| step-level keys, no nesting bag | targets and options directly on the step (§3.4) |
| `run:` text executes under a shell, per-OS defaults, `shell:` override | same; `sh` / `powershell` defaults |
| `env:` mapping at any level | the bare-mapping shorthand (§3.6) |
| `working-directory:` | `cwd:` (the script asset's existing metadata word) |
| `continue-on-error` / `timeout-minutes` as step keys | `on_error:` / `timeout:` as step keys |

**Kept akm, deliberately:**

| GHA | Here | Why |
|---|---|---|
| opaque `uses:` refs | typed asset refs (`commands/*`, `scripts/*`, `workflows/*`) | the ref grammar already encodes the type; recognition needs no registry lookup |
| `inputs:` declared / `with:` passed | `params:` both places | one word beats two; `inputs:` already means upstream artifacts in workflows |
| `name:` on steps | none | step titles were removed by owner ruling in the workflow unification |
| marketplace actions | bundle assets | the sharing unit is the bundle |

## 6. Shared plumbing — the point-2 code reduction

| Layer | Today | After |
|---|---|---|
| Target + options schema | `akm-task.json` standalone (87 lines, loaded by nothing at runtime); separate `unit` defs with a duplicated `output` | one shared definitions file `$ref`'d by both published schemas; one spelling; bag deleted |
| Parsing | `parseTaskDocument()` + `TASK_KEYS` + `rejectTargetFields()` + `resolvePromptSource()` (368 lines) | the unified frontmatter+body parser; `uses:`-xor-`run:` as one schema rule |
| Envelope | hand-listed keys, no OKF | `$ref akm-asset-envelope.json`; future stamped keys inherited free |
| Target resolution | prompt/ref/path sniffing in `src/tasks/` | none to do — `uses:` is always a ref, `run:` is always inline; the resolver dispatches on the ref's subdir |
| Command-template filling | n/a | one implementation, both surfaces |
| Script/shell execution | n/a (`runCommandTask` runs raw argv only) | one executor: inline shell + script assets per `run`/`setup`/`cwd`, both surfaces |
| Env assembly + redaction | `akm env run` and workflow `unit.env`, separately | one `env:` resolver feeding `sensitiveValues` |
| Lint | `invalid-task-yaml` in the task adapter | shared envelope + schema + prose-rule passes; task-only passes (cron parse) on top |
| Adapter | `.yml`-only recognize/place | markdown task recognized by `type: task` / `tasks/` residence; `place()` → `.md` |

Honest boundary: agent dispatch stays two paths — the task runner's
`executeRunner()` and the orchestrator's journaled unit dispatch — because
run recording, leases, and replay genuinely differ between "cron fired one
job" and "the orchestrator is executing a plan." Everything upstream of
`UnitDispatchRequest` unifies: target resolution, template filling, env
assembly, options.

## 7. Authoring UX

- **One sentence to learn:** *`uses:` an asset, `run:` a shell line, or write
  prose and an agent does it — plus `schedule:` if it should recur.* True of
  a task, true of a step.
- `akm task create <id> [--schedule … --run … | --uses <ref>]` emits the
  markdown template and opens it. The ~12-flag `task add` surface retires with
  the `.yml` format — flags were compensating for a format with nowhere to
  put prose.
- One published schema chain → `yaml-language-server` completion and inline
  validation for tasks and workflows alike, including the shared target and
  options vocabulary.

## 8. Migration — inside the 0.9.0 cutover, not beside it

Breaking changes are approved for 0.9.0, and 0.9.0 already has an explicit,
journaled, crash-resumable migration (`akm migrate apply`) that re-keys refs,
folds databases, and converts `vaults/` → `env/`. Task conversion joins it as
one more content step. No key survives with a changed meaning — the `.yml`
vocabulary maps onto different spellings, so nothing is silently
reinterpreted:

| `.yml` (v2) | `.md` |
|---|---|
| `command: <shell>` | `run: <shell>` |
| `prompt: \|` (inline scalar) | the document body |
| `prompt: commands/<x>` | `uses: commands/<x>` |
| `prompt: agents/<x>` | `agent: agents/<x>` (body seeded from the agent asset's prompt when the task had no other text) |
| `prompt: ./file.md` | inlined into the body |
| `workflow: <ref>` + `params` | `uses: workflows/<ref>` + `params` |
| `timeoutMs` / `llm.maxTokens` / `model` | `timeout` / `llm.max_tokens` / `llm.model` |
| `version: 2` | dropped |

- Scheduler entries are untouched — task ids and the `akm task run <id>` ABI
  do not change, so nothing is reinstalled.
- The 0.7→0.8 lesson — leftover files must never be **silently invisible** —
  is honored structurally: 0.9.0 commands already refuse an un-migrated
  installation rather than migrating as a side effect, and post-migration
  `task sync` / `task doctor` name any stray `.yml` file by path instead of
  skipping it.
- The ten embedded templates convert in this change and are the reference
  examples; each gains a real runbook body.

## 9. Decision log and remaining questions

Resolved by owner:

1. **Model** (round 1): task = schedulable bundle asset over OS scheduling;
   step = the same job inside a procedure; unify execution code; fewer
   concepts. Tasks don't grow steps; workflows don't grow schedules.
2. **Targets name assets; the body is the prompt** (round 2): `prompt:`
   deleted.
3. **Breaking changes approved for 0.9.0** (round 3).
4. **`env:` property** (round 3): key-value pairs and/or env refs, used at
   runtime — shaped as §3.6. Ref-valued single entries confirmed (round 4).
5. **`agent:` property** (round 3): a ref to an agent asset, applied when
   applicable; no-op (plus lint notice) where it isn't.
6. **GHA alignment** (round 3): familiar, not copied — applied as §5.
7. **No `version:`** (round 3).
8. **Windows default shell: `powershell`** (round 4).
9. **`uses:`/`run:` replace `command:`/`script:`/`workflow:` as the target
   keys** (round 4 — supersedes round 3's "reuse `command:`," reopened by the
   owner). The double-target error class becomes structurally impossible, the
   `command:`-changes-meaning hazard and its parse-error guard are deleted,
   ref-vs-inline sniffing never exists, and asset-type alignment survives in
   the ref's subdir.

Remaining:

1. **`model` folds into `llm.model`** (§3.3, proposed this round). Shrinks
   the muddy four (`agent`/`engine`/`model`/`llm`) to three disjoint nouns —
   who / the runner / the request — with one precedence line. Confirm, or
   keep `model:` top-level as a fourth key.

## 10. Non-goals

- No `steps:` in tasks; no `schedule:` on workflows; no step reference/reuse
  system; no changes to `map`/`route`/`gate` semantics, IR, freeze, journal,
  leases, or replay (the §3.4 flatten is authoring-schema-only — it compiles
  to the same plan).
- No change to the scheduler backends, `sync` reconciliation, runtime
  binding, task ids, or the `akm task run <id>` ABI.
- No change to how `command`, `script`, `agent`, `env`, or `secret` assets
  are authored or stored — this proposal executes and embodies them, it does
  not reformat them.
- No observability redesign; sharing one failure vocabulary across the two
  execution paths is a natural follow-up.
