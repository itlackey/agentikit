# Task / Workflow Unification: One Target Vocabulary, One Prose Rule

Status: PROPOSAL v7 — owner decisions from review rounds 1–6 applied
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
   and inside a procedure in the other. A workflow step **is a task**: defined
   inline, or referenced by ref, so the same repeatable process is truly
   composable without duplicating content or config.

3. **Reduce the number of concepts and formats a user must learn.** akm's
   primary goal is a **simple, intuitive abstraction layer over the common
   tools and processes autonomous agents use** — the measure of success is
   lower cognitive load, not architectural novelty.

Not in scope: tasks do not grow `steps:`; workflows do not grow `schedule:`.
The unit of sharing is the asset, the unit of scheduling is the task, the
unit of procedure is the workflow — and a workflow *composes* tasks (§3.3),
it does not replace them.

## 2. Baseline

Facts from the `release-0-9-0-polish` branch this design builds on:

- `akm workflow run <ref|run-id>` is the canonical orchestrator — Stable,
  ungated, owning creation, dispatch, completion, and durable replay
  (`start`/`next`/`complete` are removed; only the `brief`/`report` driver
  protocol keeps the `experimental.workflowEngine` opt-in).
- Scheduled workflow tasks already execute end-to-end
  (`runWorkflowTask()` → `runWorkflowSteps()`).
- Workflow params are **declared flags** coerced through frozen parameter
  schemas — any param passing below rides that mechanism.
- `src/workflows/exec/unit-dispatch.ts` is the one dispatch seam.
  `UnitDispatchRequest` already carries an assembled `prompt`, a frozen engine
  snapshot, `timeoutMs`, `env`, `cwd`, and `sensitiveValues`; results carry a
  structured `failureReason`.
- **Freeze already implements a configuration cascade.**
  `compileResolveFreezeWorkflow()` (`src/workflows/ir/freeze.ts`) assembles
  `layers: EngineUseConfig[] = [documentDefaults, unit]`, selects the engine
  by nearest layer, and resolves model, timeout, and request overrides by
  walking the layers nearest-wins / deep-merged. §3.4 exposes this existing
  mechanism as the authoring model instead of hiding it behind special-cased
  sibling keys.

## 3. The format

### 3.1 Two target keys: `uses:` and `run:`

| Declaration | Work performed | Inputs |
|---|---|---|
| *(none)* | Dispatch an agent with **the nearest prose** as the prompt | — |
| `uses: <asset-ref>` | Execute the referenced asset **per its type**, which the ref's subdir already declares (§3.2) | `params:`, `env:` |
| `run: <shell text>` | Execute inline shell — no AI. GitHub-Actions `run:` semantics (§3.6) | `env:` |

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
| `uses: tasks/<name>` *(steps only)* | Compose the task into the workflow as this step's work (§3.3) | the task's own inputs, overridable |
| `uses: workflows/<ref>` *(tasks only)* | Run the workflow via `runWorkflowSteps()`; on a step this is an error (no nesting) | `params:` → the declared param flags |
| `uses: agents/<name>` | **Error**, with the hint: an agent is a persona, not work — set `agent:` (§3.4) |

Template filling stays scoped to the command asset type, whose definition
already is "a template with placeholders" — bodies remain verbatim, per
[`workflow-format-unification.md`](./workflow-format-unification.md) §2.3.
Filling happens before dispatch, producing the `prompt` string
`UnitDispatchRequest` expects; a placeholder with no matching param is an
error at fill time.

### 3.3 Steps are tasks — composition by reference

A workflow step is a task: defined inline (the step's own target, options,
and prose) or referenced with `uses: tasks/<id>`, so one repeatable process
serves the scheduler and any number of workflows without duplication.

```yaml
steps:
  - id: lint
    uses: tasks/lint-check       # the task's target, options, env, and body
    timeout: 2m                  # call-site override
  - id: fix                      # inline task: same keys, defined here
    run: bun run fix
```

Rules:

- **Step keys override the referenced task's keys** — the task and the step
  are just two adjacent layers of the §3.4 cascade. `env:` lists concatenate
  task-then-step, so the later-entries-win rule (§3.7) is the same rule.
- **Trigger keys never fire outside the scheduler surface.** `schedule:` and
  `enabled:` are consumed *only* by `akm task sync` and related commands.
  Anywhere else — on a referenced task in a workflow, or written directly on
  a step — they are no-ops with a lint notice. A scheduled task referenced by
  a workflow therefore cannot double-fire.
- **A `uses:` step's section is additional prose, passed along when that
  makes sense.** Investigated (round 6): the assembled prompt is a frozen
  string produced at one seam, so appending is a deterministic concat —
  easy — and call-site context ("in this workflow, focus on X") is genuinely
  useful without duplicating the task. Rule: **when the resolved work is
  agent-dispatched** (a prose task, or a command template), the step's
  section text is appended to the assembled prompt after a blank line,
  byte-exact. **When it is not** (shell work), the section is documentation,
  ignored at runtime. Sections on `uses:` steps remain optional either way;
  this is additive context, never a prose override — a call site needing
  *different* instructions defines the step inline.
- **Resolution happens at freeze.** The referenced task compiles into the
  frozen plan, so in-flight runs are immune to later task edits — the
  existing snapshot rule, unchanged.
- **No nesting through the back door.** A referenced task whose own target is
  `uses: workflows/*` is a compile error on a step, the same as writing it
  directly. A task referencing a task is likewise an error — a task is the
  unit; composition lives in workflows.

### 3.4 Configuration: two selectors, one value set, one cascade

Round 6 asked for a no-constraints re-look at `agent`/`engine`/`model`/`llm`.
The four-sibling design (and both prior attempts to fix it) was describing
the right mechanism with the wrong surface. The mechanism already exists:
freeze resolves every dispatch-significant setting by walking **layers**,
nearest-wins (§2). The fix is to make the authoring model *be* that cascade —
the same familiar shape as opencode's and Claude Code's configuration, where
one vocabulary appears at every scope and the nearest scope wins.

**Two selectors.** These don't merge — the nearest one *picks a node* whose
fields join the cascade:

| Selector | Picks | Node lives in |
|---|---|---|
| `engine:` | the execution node — *how* work runs (agent CLI or LLM endpoint) | config `engines.<name>` |
| `agent:` | the persona node — *who* runs it (system prompt, tool policy, model preference) | the bundle, `agents/<name>` |

**One value vocabulary.** Everything else is a flat set of value fields,
legal at every layer, merged per-field with the nearest layer winning:

`model` · `temperature` · `max_tokens` · `extra_params` · `timeout` · `env` ·
`cwd` · `shell` · `params`

`llm:` is **dissolved**: it was a grouping whose only job was to scope a
kind-gated hard error, and that error is incompatible with a cascade (a
global default `temperature` must not brick every agent-engine dispatch).
In its place, **engines consume what they understand**: each engine kind
declares the value fields it reads (`temperature`/`max_tokens`/`extra_params`
are LLM-endpoint fields; agent CLIs read `model` and `timeout`), and a field
the selected engine cannot consume is a **lint/freeze notice** — never a
rejection, never silently load-bearing.

**The cascade**, far to near — later wins per field, `env:` concatenates:

```
config defaults:  →  engines.<selected>  →  agents/<selected>  →  document defaults:  →  step / task keys
     (global)           (execution node)       (persona node)      (workflow frontmatter)    (call site)
```

Worked example:

```jsonc
// config.json
{ "defaults": { "engine": "claude", "model": "sonnet" },
  "engines":  { "claude": { "kind": "agent", "platform": "claude" } } }
```

```yaml
# agents/reviewer frontmatter
model: opus
```

```yaml
# workflow
steps:
  - id: review
    agent: agents/reviewer   # model: opus  (persona layer beats global default)
  - id: digest
    model: haiku             # model: haiku (call site beats everything)
    temperature: 0.2         # notice: agent-kind engine does not consume this
```

One sentence to teach it: **set a field where it should usually apply;
override it closer when a case differs; the nearest value wins.** The rule
the user already knows from opencode and Claude Code configuration — and the
rule `env:` (§3.7) already follows, list-concatenated.

Composition (§3.3) needs no extra semantics: a referenced task is simply one
more layer between the persona node and the step's own keys.

Tier structure otherwise unchanged: **graph keys** (`map`, `route`, `inputs`,
`output`, `gate`, `retry`, `on_error`, `isolation`) are steps-only —
orchestration stays with the orchestrator; **trigger keys** (`schedule`,
`enabled`) are tasks-only and scheduler-surface-only (§3.3). A scheduled
*gated* process is a task whose target is a one-step workflow.

### 3.5 Model aliases — findings from the implementation review

`resolveModel()` (`src/integrations/agent/model-aliases.ts`) is one four-tier
chain: engine-profile `modelAliases` → config-root `modelAliases` (alias →
platform → model, with a `"*"` fallback column, plus an `llm` column via
`resolveLlmModel`) → the built-in table (`fable` / `opus` / `sonnet` /
`haiku`) → verbatim pass-through. One resolution level, no recursion.
Aliases are **per-platform**, which is what makes a shared asset portable:
`model: sonnet` resolves to the right string under a claude engine, an
opencode engine, or an LLM endpoint.

How it composes with §3.4: the cascade settles *which* value `model` holds;
alias resolution then runs **once, after the cascade**, against the selected
engine's platform. Aliases are therefore legal at every layer — a persona
node saying `model: opus` works under any engine. Timing is unchanged: tasks
resolve at dispatch, workflows at freeze into the frozen plan; composition
follows the freeze path.

The review also surfaced an inconsistency this design fixes: today the
`.yml` task path **drops** an agent asset's model preference —
`prompt: agents/x` resolves the asset to prompt text only — while `akm
agent` embodiment honors it under an explicit `--model` override. With
`agent:` as a selector whose node sits in the cascade, tasks get the
embodiment semantics by construction.

### 3.6 `run:` semantics — and steps flatten to the task shape

**Inline shell.** `run:` is always a shell, single line or block scalar — the
GitHub Actions behavior, one rule, no line-count semantics. `sh` on POSIX,
`powershell` on Windows; `shell:` overrides. (`run:` is also the script
asset's own metadata key for its shell line — the same word means the same
thing in both places.) A shell unit inside a workflow journals like any unit
(`workflow_run_units`): no tokens, but status, timing, attempts, and
`failure_reason` behave normally. A `map:` step with a shell target receives
its item and index as `AKM_ITEM` (JSON-encoded) and `AKM_ITEM_INDEX` in the
environment — the env-not-argv stance applied to fan-out; no argv
substitution exists.

**The flatten (schema change).** Today a step's dispatch configuration hides
inside a `unit:` bag (and a map step's inside `map.unit`), while `output:` is
declared **both** on the step and inside the bag — a live wart in
`schemas/akm-workflow.json`. Steps-are-tasks makes the bag untenable:

- **`unit:` and `map.unit` are deleted.** Targets, value fields, and graph
  keys sit directly on the step. `map:` keeps only `over` / `concurrency` /
  `reducer`; the step's own target and fields are the per-item template.
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
graph position — which is precisely what makes `uses: tasks/<id>` coherent.
Cost: schema and golden churn on a pre-release format — approved.

### 3.7 `env:` — literals and refs in one property

`env:` is a **list**; each entry is either an env-asset ref (inject the whole
group) or a mapping of literal pairs. A value that is a `secrets/<name>` ref
resolves to the secret at runtime. Later entries win — the cascade rule in
list form. A bare mapping is shorthand for a single-entry list, so the
GitHub-Actions spelling works as muscle memory:

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
any value fields or selectors. There is no `version:` key — identity is the
ref and the schema evolves additively, as the workflow format already
decided.

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
strengths. `uses:`/`run:` match GHA outright — and cost akm nothing, because
akm refs are subdir-typed, so `uses: scripts/lint-all` still says *what*
executes right in the value.

**Adopted from GHA:**

| GHA | Here |
|---|---|
| `uses:` names the reusable thing, `run:` is inline shell, at most one of them | same — and the ref's subdir supplies the type GHA leaves opaque |
| reusable workflows / composite actions | `uses: tasks/<id>` — a bundle task composed as a step (§3.3) |
| step-level keys, no nesting bag | targets and fields directly on the step (§3.6) |
| `run:` text executes under a shell, per-OS defaults, `shell:` override | same; `sh` / `powershell` defaults |
| `env:` mapping at any level | the bare-mapping shorthand (§3.7) |
| `working-directory:` | `cwd:` (the script asset's existing metadata word) |
| `continue-on-error` / `timeout-minutes` as step keys | `on_error:` / `timeout:` as step keys |

**Kept akm, deliberately:**

| GHA | Here | Why |
|---|---|---|
| opaque `uses:` refs | typed asset refs (`commands/*`, `scripts/*`, `tasks/*`, `workflows/*`) | the ref grammar already encodes the type; recognition needs no registry lookup |
| `inputs:` declared / `with:` passed | `params:` both places | one word beats two; `inputs:` already means upstream artifacts in workflows |
| `name:` on steps | none | step titles were removed by owner ruling in the workflow unification |
| marketplace actions | bundle assets | the sharing unit is the bundle |

## 6. Shared plumbing — the point-2 code reduction

| Layer | Today | After |
|---|---|---|
| Target + options schema | `akm-task.json` standalone (87 lines, loaded by nothing at runtime); separate `unit` defs with a duplicated `output` | one shared definitions file `$ref`'d by both published schemas; one spelling; bag deleted |
| Dispatch configuration | four sibling keys with per-key applicability rules and a kind-gated hard error; freeze resolves via layers internally | two selectors + one flat value vocabulary, cascade-merged — the authoring surface finally matches the layer mechanism freeze already implements |
| Parsing | `parseTaskDocument()` + `TASK_KEYS` + `rejectTargetFields()` + `resolvePromptSource()` (368 lines) | the unified frontmatter+body parser; `uses:`-xor-`run:` as one schema rule |
| Envelope | hand-listed keys, no OKF | `$ref akm-asset-envelope.json`; future stamped keys inherited free |
| Target resolution | prompt/ref/path sniffing in `src/tasks/` | none to do — `uses:` is always a ref, `run:` is always inline; the resolver dispatches on the ref's subdir |
| Model aliases | one `resolveModel()` chain, but the task path drops agent model preferences | same chain, run once after the cascade settles `model`; task path gains embodiment semantics via `agent:` (§3.5) |
| Command-template filling | n/a | one implementation, both surfaces |
| Script/shell execution | n/a (`runCommandTask` runs raw argv only) | one executor: inline shell + script assets per `run`/`setup`/`cwd`, both surfaces |
| Env assembly + redaction | `akm env run` and workflow `unit.env`, separately | one `env:` resolver feeding `sensitiveValues` |
| Step reuse | impossible — steps are anonymous and inline-only | `uses: tasks/<id>` as one more cascade layer (§3.3) |
| Lint | `invalid-task-yaml` in the task adapter | shared envelope + schema + prose-rule passes; engine-capability notices; task-only passes (cron parse) on top |
| Adapter | `.yml`-only recognize/place | markdown task recognized by `type: task` / `tasks/` residence; `place()` → `.md` |

Honest boundary: agent dispatch stays two paths — the task runner's
`executeRunner()` and the orchestrator's journaled unit dispatch — because
run recording, leases, and replay genuinely differ between "cron fired one
job" and "the orchestrator is executing a plan." Everything upstream of
`UnitDispatchRequest` unifies: target resolution, template filling, the
cascade, alias resolution, env assembly.

## 7. Authoring UX

- **One sentence for the format:** *`uses:` an asset, `run:` a shell line, or
  write prose and an agent does it — plus `schedule:` if it should recur.*
- **One sentence for configuration:** *set a field where it should usually
  apply; override it closer when a case differs; the nearest value wins.*
- `akm task create <id> [--schedule … --run … | --uses <ref>]` emits the
  markdown template and opens it. The ~12-flag `task add` surface retires with
  the `.yml` format — flags were compensating for a format with nowhere to
  put prose.
- One published schema chain → `yaml-language-server` completion and inline
  validation for tasks and workflows alike, including the shared target and
  value vocabulary.

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
| `timeoutMs` | `timeout` |
| `llm.maxTokens` / `llm.temperature` / `llm.extraParams` / … | `max_tokens` / `temperature` / `extra_params` / … — flat value fields (§3.4) |
| `model` | `model` |
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
- Workflow frontmatter written against the pre-flatten schema (`unit:`,
  `map.unit`, `defaults.llm`) converts in the same content step: bag fields
  lift to the step, `llm` sub-fields flatten.

## 9. Decision log and remaining questions

Resolved by owner:

1. **Model** (round 1): task = schedulable bundle asset over OS scheduling;
   step = the same job inside a procedure; unify execution code; fewer
   concepts. Tasks don't grow steps; workflows don't grow schedules.
2. **Targets name assets; the body is the prompt** (round 2): `prompt:`
   deleted.
3. **Breaking changes approved for 0.9.0** (round 3).
4. **`env:` property** (round 3): key-value pairs and/or env refs, used at
   runtime — shaped as §3.7. Ref-valued single entries confirmed (round 4).
5. **`agent:` property** (round 3): a ref to an agent asset, applied when
   applicable; no-op (plus lint notice) where it isn't. Reframed in round 6
   as one of the two cascade selectors (§3.4).
6. **GHA alignment** (round 3): familiar, not copied — applied as §5.
7. **No `version:`** (round 3).
8. **Windows default shell: `powershell`** (round 4).
9. **`uses:`/`run:` replace `command:`/`script:`/`workflow:` as the target
   keys** (round 4). The double-target error class becomes structurally
   impossible; asset-type alignment survives in the ref's subdir.
10. **Trigger keys are scheduler-surface-only** (round 5): consumed
    exclusively by `akm task sync` and related commands; no-ops with a lint
    notice anywhere else.
11. **Steps are tasks** (round 5): defined inline or referenced with
    `uses: tasks/<ref>` — truly composable without duplicating content or
    config. Semantics in §3.3.
12. ~~`model:` stays top-level as one of four sibling keys~~ (round 5) —
    **superseded by 14**; the finding that motivated it (model is the one
    cross-engine-kind knob) survives as engine capability declarations.
13. **A `uses:` step's section is optional additional prose** (round 6):
    investigated easy + helpful — appended byte-exact to the assembled
    prompt for agent-dispatched work; documentation, ignored at runtime, for
    shell work (§3.3).
14. **Configuration is two selectors + one flat value vocabulary on a
    cascade** (round 6): `engine:` and `agent:` pick nodes; `model`,
    `temperature`, `max_tokens`, `extra_params`, `timeout`, `env`, `cwd`,
    `shell`, `params` merge per-field, nearest layer wins — config defaults →
    engine node → persona node → document defaults → call site. `llm:` is
    dissolved; the kind-gated hard error becomes an engine-capability
    lint/freeze notice, which cascade semantics require. This is the layer
    mechanism `freeze.ts` already implements, exposed as the authoring model
    (§3.4).

Remaining:

1. None blocking. Decision 14 reverses two earlier rounds of back-and-forth
   on this surface (v5's fold, v6's unfold), so it is called out for explicit
   sign-off rather than buried: confirm the cascade model and the
   dissolution of `llm:`.

## 10. Non-goals

- No `steps:` in tasks; no `schedule:` on workflows; no changes to
  `map`/`route`/`gate` semantics, IR, freeze, journal, leases, or replay
  (the §3.6 flatten and §3.4 cascade are authoring-surface changes over the
  layer resolution freeze already performs; §3.3 composition resolves at the
  existing freeze step).
- No change to the scheduler backends, `sync` reconciliation, runtime
  binding, task ids, or the `akm task run <id>` ABI.
- No change to how `command`, `script`, `agent`, `env`, or `secret` assets
  are authored or stored — this proposal executes and embodies them, it does
  not reformat them.
- No multi-file config merging: akm still reads one config file; the cascade
  layers are config nodes, bundle assets, and document/call-site keys.
- No observability redesign; sharing one failure vocabulary across the two
  execution paths is a natural follow-up.
