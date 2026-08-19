# Task / Workflow Unification: One Target Vocabulary, One Prose Rule

Status: PROPOSAL v9 — v8 (the post-Opus-review redesign) revised against a
four-lens Sonnet panel, then re-verified claim-by-claim against the current
baseline (98 claims checked, 22 corrected; a further 7 corrections from an
audit of that pass). Review corpus:
[`reviews/task-workflow-unification/`](./reviews/task-workflow-unification/).
Baselined on `origin/main` @ `17a0dca`, which merged the 0.9 polish branch
(`71bb686`). Breaking changes are approved for 0.9.0.
Date: 2026-08-01
Related: [`workflow-format-unification.md`](./workflow-format-unification.md),
[`okf-support.md`](./okf-support.md),
[`docs/reference/workflows.md`](../../reference/workflows.md)

> **2026-08-18 owner clarification:**
> [Agent, Command, Engine, and Model Resolution](./agent-command-engine-model-design.md)
> is authoritative wherever this proposal discusses agent personas, command
> execution, command placeholders, engine/model cascading, tool policy,
> capability handling, or model aliases. In particular, this proposal's
> `with:`/named/positional command-template grammar, primary-bundle tool-policy
> ceiling, static engine-capability declarations, and built-in wildcard alias
> recommendations are superseded. The exact task/workflow source syntax remains
> undecided and MUST NOT be inferred from the superseded examples here. The
> still-compatible task/workflow concepts — tasks as scheduling wrappers,
> agents as selectors rather than targets, task composition in workflow steps,
> live task resolution, and frozen workflow resolution — remain design input.

---

## 1. Grounding — what tasks and workflows are in akm

Owner's model; everything below derives from it.

1. **A task is a bundle asset that abstracts over OS-scheduled work** —
   discovered like any asset, *enabled* into a cron/launchd/schtasks entry
   that executes the defined work or dispatches an agent with the task's
   prompt. A platform-agnostic way to share repeatable processes behind one
   CLI.
2. **A workflow step is a task** — defined inline or referenced by ref — so
   the same repeatable process is composable without duplicating content or
   config.
3. **Fewer concepts, lower cognitive load.** akm is a simple, intuitive
   abstraction layer over the tools and processes autonomous agents use.

Not in scope: tasks do not grow `steps:`; workflows do not grow `schedule:`.
The unit of sharing is the asset, of scheduling the task, of procedure the
workflow.

## 2. The format (stable since v5–v6, corrections applied)

### 2.1 Targets

| Declaration | Work performed |
|---|---|
| *(none)* | Agent, prompted with **the nearest prose** — a task's body, or a step's `## <id>` section |
| `uses: <asset-ref>` | Execute the referenced asset per its subdir-declared type (§2.2) |
| `run: <shell text>` | Shell, no AI — GitHub-Actions semantics; `sh` on POSIX, `powershell` on Windows, `shell:` override |

`uses:` xor `run:` — one schema rule; the double-target error class is
structurally impossible. No ref-vs-inline sniffing exists.

> **The prose rule.** The machine surface names the target; the nearest
> prose is the instructions. With no target key, the prose *is* the work.

### 2.2 `uses:` — a closed set of four executable types

| Ref | Execution | Inputs |
|---|---|---|
| `uses: commands/<n>` | Fill the template (§2.4), dispatch an agent | `with:` |
| `uses: scripts/<n>` | Execute per the script's `run`/`setup`/`cwd` — gated by the execution-activation policy (§5.6) | `env:` |
| `uses: tasks/<n>` *(steps only)* | Compose the task as this step's work (§2.3) | the task's own, overridable |
| `uses: workflows/<r>` *(tasks only)* | `runWorkflowSteps()` | `with:` → declared param flags |

Any other subdir (including `agents/` — a persona, not work) is an error
with a targeted hint. **`with:` replaces v5–v7's call-site `params:`** —
review finding M1 (3/3): `params:` already means *declarations* (name →
JSON Schema) in workflow frontmatter, and one key carrying declarations,
run-arguments, placeholder fills, *and* a cascading value was the same
overload this spec deletes `prompt:` for. GHA's `inputs:`/`with:` split
exists precisely here, and §2.4/§4 give `with:` exactly one meaning:
**inputs handed to the referenced asset, never cascaded.**

Two `uses:` modes differ in kind, named for authors: `tasks/<n>`
**composes** — the referenced definition becomes this step's own work —
while `workflows/<r>` **invokes** — a child run executes and returns.
`with:` merge on a composition chain (a step referencing a task that
itself targets a command or workflow) is per-key shallow merge, referencing
step wins; `with.arguments` is one key, replaced whole. The merged mapping
feeds the final target: placeholder fill for a command, declared param
flags for a workflow.

### 2.3 Steps are tasks — composition by reference

```yaml
steps:
  - id: lint
    uses: tasks/lint-check   # the task's target, fields, env, and body
    timeout: 2m              # call-site override (one cascade layer nearer)
  - id: fix
    run: bun run fix         # inline task: same keys, defined here
```

- Step keys override the referenced task's keys — the task and the step are
  adjacent cascade layers (§4); `env:` concatenates task-then-step.
- Trigger keys (`schedule`, `enabled`) are consumed **only** by
  `akm task sync` and, at fire time, the task runner's enabled gate
  (`src/tasks/runner.ts:169` — v7's "sync-only" wording corrected).
  Anywhere else they are no-ops with a lint notice; a referenced task
  cannot double-fire.
- **Call-site prose is appended at freeze, not at dispatch.** Review
  finding (3/3): there is no "one assembled prompt seam" — prompts are
  built per-unit at dispatch, and the unit hash covers the *frozen
  template*, not the assembled string. So: when the resolved work is
  agent-dispatched, the step's section text is concatenated onto the
  frozen instruction template (blank-line separator, byte-exact) **at
  freeze**, which puts it inside the hash preimage automatically and keeps
  the append ahead of the item/inputs/gate blocks. For shell work the
  section is documentation, ignored at runtime.
- Refs resolve at freeze (§5.4), so in-flight runs are immune to edits.
- No nesting: a referenced task targeting `workflows/*` is a compile error
  on a step; a task referencing a task is an error.

### 2.4 Command templates — filled against the real placeholder grammar

Review finding M2 (3/3): command placeholders are `$ARGUMENTS` / `$1`–`$9`
(positional) and `{{name}}` per the advertised grammar
(`extractParameters`, `src/output/renderers.ts:164-186`); the actual
filler is `fillPlaceholders()` in
`src/commands/agent/agent-dispatch.ts:67-72`, which substitutes only
positional `{{0}}` forms, leniently — a live bug fixed by this work, and
a second call site the new `with:` contract replaces. Three further
grammars for the same placeholders exist today and diverge from each
other: the indexer's recognition sniff `COMMAND_PLACEHOLDER_RE`
(`src/indexer/walk/matchers.ts:126`, consumed at `:239`) matching only
`$ARGUMENTS`/`$1`–`$3`; `extractCommandParameters`
(`src/indexer/passes/metadata.ts:440-461`), a near-clone of the display
grammar that differs from it in case-sensitivity and digit bounding; and
a lenient sniff at
`src/core/adapter/adapters/tool-dir-shared.ts:201-204`.

**Convergence is scoped to the fill and display grammars — the two
recognition sniffs keep their `$`-only forms.** Adding `{{name}}` to
`COMMAND_PLACEHOLDER_RE` would be a live mis-classification hazard, not a
cleanup: it returns specificity 18, outranking the directory rules
(10/15), so any `knowledge/`, `facts/`, or `instructions/` `.md`
containing a mustache token would be re-typed `command`. The recognition
gap is narrower than it looks anyway — `classifyByDirectory` /
`classifyByParentDirHint` (`matchers.ts:43-47`, `:147-156`, `:178-197`)
already type any `.md` under `commands/` as a command at specificity
10/15, beating `classifyBySmartMd`'s `knowledge` (5). The sniff is only
the fallback for command-shaped `.md` living *outside* `commands/`
without `tools:`/`agent:` frontmatter. The contract, defined against that
reality:

- `with:` mapping keys fill `{{name}}` placeholders.
- The reserved key `with.arguments` (string) fills `$ARGUMENTS`, and its
  whitespace-split words fill `$1`–`$9`.
- An unmatched placeholder or unused `with:` key is a **lint warning and is
  left verbatim** — not a runtime hard error, so imported `$ARGUMENTS`
  commands remain usable as targets.
- `with.arguments` is reserved: a literal `{{arguments}}` placeholder is
  filled by it too, with a lint warning about the shadowing. Words past
  `$9` remain reachable only through `$ARGUMENTS`.

Filling happens at freeze (workflows) / dispatch (tasks), producing the
prompt string. Bodies remain verbatim — templating stays scoped to the
command asset type, whose definition is "a template with placeholders."

## 3. The task asset

`<bundle>/tasks/<id>.md`: the shared envelope (`$ref
akm-asset-envelope.json`, OKF v0.2 families included), trigger keys, at
most one target, and any §4 fields. No `version:` key. **Recognition
requires frontmatter `type: task`, honored in two subsystems** (R2
finding: v8 cited only one). At the bundle-adapter layer, the workflow
adapter is ordered ahead of the task and generic akm adapters in the
source-root probe list (6th of 11 —
`src/core/adapter/adapters/index.ts:73-90`; that array is `looksLikeRoot`
probe order, and only the adapter that claims a root ever calls
`recognize()` on its files), and inside an akm-workflow bundle it claims
every `.md` file whose frontmatter does not declare a contrary `type:`
(`akm-workflow-adapter.ts:67-70`, `:160`). At the per-file
indexer classifier — the path that actually types `tasks/*.md` during
normal indexing — `src/indexer/walk/matchers.ts` gains a `type: task`
branch **ordered before** its existing `"agent" in fm → command` rule
(`matchers.ts:234-236`), which would otherwise misclassify any task
carrying an `agent:` selector — including this section's own example.
Residence is a lint *expectation*, not a recognition signal.

````markdown
---
type: task
description: Weekly review digest.
schedule: "0 8 * * 1"
agent: agents/reviewer
timeout: 10m
---

Review the week's completed tasks and summarize action items.
````

````markdown
---
type: task
description: Full nightly quality sweep.
schedule: "15 2 * * *"
run: akm improve --strategy thorough --skip-if-locked
---

# Nightly improve sweep

Runbook prose: indexed, shown, never executed.
````

````markdown
---
type: task
schedule: "@daily"
uses: commands/weekly-review
with: { scope: team }
env: [env/prod]
---
````

Lifecycle unchanged: discover via search/show; enable via `enabled:` +
`task sync`; the OS entry still invokes `akm task run <id>`. Lifecycle
interactions pinned (review minors): `status: draft` → `sync` never
installs, regardless of `enabled:`; `status: deprecated` → installs with a
warning; a previously-installed task that becomes `draft` (or
`enabled: false`) is uninstalled by the next `sync` — reconciliation is to
desired state, both directions.

Two adapter-policy changes with named mechanisms (panel M13 follow-up):
the akm adapter's current `type: "task"` special-case — parse as pure
YAML, `frontmatter: null`, so markdown base checks never fire
(`akm-adapter.ts:404-412`) — is **removed with the format**, and markdown
tasks get the full markdown base-check suite; and tasks are declared
**improve-ineligible**. No such site exists on `BundleAdapter`
(`src/core/adapter/bundle-adapter.ts:69-121` declares only adapter-level
optional methods), so v8's "where the adapter already declares per-type
capabilities" was wrong. Three candidate homes, cheapest first: the
existing per-type refusal set `DISTILL_REFUSED_INPUT_TYPES`
(`src/commands/improve/distill.ts:134-142`, already gated at
`eligibility.ts:380` and documented as driving the planner "for free")
gains `task`; or the per-type table `TYPE_PRESENTATION`
(`src/core/type-presentation.ts:74`) gains an eligibility flag; or
`eligibility.ts` gains an explicit type filter. A task body is an
executable prompt,
not curatable knowledge. Lint runs; improve never rewrites it.

## 4. Configuration: two selectors, one value vocabulary, one cascade — built, not "exposed"

v7 claimed freeze "already implements" the cascade. Review finding C4
(3/3): freeze's layer list is exactly `[documentDefaults, unit]`
(`freeze.ts:50`); `DefaultsSchema` has **no** `model` field and is
`.passthrough()`, so v7's own worked example is a silent no-op today
(`config-schema.ts:102-108`); `defaults.llm` is hard-rejected as retired;
no persona layer exists. What exists is a two-layer resolver whose *shape*
proves the pattern fits. This section specifies **building** the rest.

**Selectors** (nearest wins; each picks a node whose fields join the
cascade):

| Selector | Node | Source |
|---|---|---|
| `engine:` | execution node | config `engines.<name>` |
| `agent:` | persona node | bundle `agents/<name>` |

**Value fields** — legal at every layer, merged per-field, nearest wins;
`env:` concatenates: `model` · `temperature` · `max_tokens` ·
`extra_params` · `timeout` · `env` · `cwd` · `shell` · `on_error` · `retry`.

(`with:` is *not* a value field — it binds to one referenced asset. `params`
no longer exists as a field name outside workflow declarations. `on_error`/
`retry` join the vocabulary because `defaults.on_error` already exists at
document level today — review M12 — making "graph keys are steps-only"
false for them; they remain meaningless on a task and lint says so. Value
fields other than `timeout`/`env` on a `uses: workflows/*` task draw the
same inapplicable-field notice — they configure a unit, and a workflow
invocation has none.)

**Merge classes, stated once** (panel finding: a generic "nearest wins"
would silently downgrade the existing deep-merge): **scalars** (`model`,
`temperature`, `max_tokens`, `timeout`, `cwd`, `shell`, `on_error`) —
nearest wins whole; **mappings** (`extra_params`) — deep-merged along the
chain, preserving today's `deepMergeConfig` behavior
(`freeze.ts:211-216`); **lists** (`env`) — concatenated, later wins;
**`retry`** — replaced whole (half-merging `max`/`on` would be
incoherent). `with:` merges per-key at its target (§2.2), outside the
cascade.

**Layers, far → near:**

```
config defaults: → engines.<selected> → agents/<selected> → document defaults: → uses: tasks/<ref> → step/task keys
```

(`document defaults:` is the workflow frontmatter's `defaults:` block and
exists only there — a standalone task IS its own call site, so for tasks
that layer is simply absent, not an implied new task key.)

**What must be built (the honest inventory):**

1. `DefaultsSchema` gains the value fields, and stops silently swallowing
   unknown keys (strict with migration-safe notices).
2. A **persona snapshot**: the agent asset resolved through the
   provenance ceiling — 07 P1-D, today inline in the show command
   (`src/commands/read/show.ts:433-445`): self-declared `tools:` honored
   ONLY for the operator's **primary bundle**, keyed off primary-bundle
   identity, explicitly *not* the writable bit, failing closed. That
   check is **extracted into a shared persona resolver** consumed by both
   `show` and freeze — a named refactor in §9, since its current home is
   a CLI formatter. The snapshot `{systemPrompt, toolPolicy, model,
   …valueFields}` freezes into the plan; `toolPolicy` is consumed by
   agent-kind engines and draws the standard unconsumed-field notice on
   LLM engines. (This also fixes the live bug where `prompt: agents/x`
   ships raw file bytes *including frontmatter* to the model —
   `runner.ts:592-593`.)
3. One cascade module — a new shared module (e.g. `src/core/cascade.ts`;
   there is no `src/exec/` tree today, only `src/workflows/exec/` and
   `src/tasks/`) — the only implementation of layer merge, consumed at
   freeze (workflows) and dispatch (tasks). It
   consolidates the three engine/model resolution sites that exist today
   (`freeze.ts:163-209`, `tasks/runner.ts:479-514`, engine-resolution)
   including their subtly divergent opencode-sdk `llmEngine` fallback
   rules — one implementation, one fallback rule.
4. **Capability notices replace both kind-gates.** The task path's hard
   error and freeze's guard — which review M6 showed is *dead code*
   (`freeze.ts:67-73` computes `llm` only for llm engines, then guards
   `kind !== "llm"`), meaning workflows already silently drop these fields
   — are both replaced by one behavior: engines declare the fields they
   consume; an unconsumed field is a lint/freeze **notice**. Strictness
   stays only where the kind is known at authoring time: the engine node's
   own schema (which today is `.passthrough()` + blacklist; it becomes
   genuinely strict as part of this work — review minor).
5. Aliases: resolution runs once, after the cascade settles `model`,
   through the existing `resolveModel()` chain. Review M4 (3/3): the
   builtin table has only `claude`/`opencode` columns, so portability to
   LLM endpoints is currently *false* — the builtin entries gain a `"*"`
   column, and an alias that resolves nowhere for the selected platform is
   a freeze/lint notice, not silent pass-through.
6. The gate judge (`workflow.judgeEngine`) stays outside the cascade in
   0.9.0 — frozen separately, as shipped. Noted, not changed.

One sentence to teach: *set a field where it should usually apply;
override it closer when a case differs; the nearest value wins.*

## 5. Execution architecture

### 5.1 One target model, two executors

A shared target module resolves every declaration to a typed value:

```
Target = { kind: agent-prose }            # nearest prose is the prompt
       | { kind: command,  ref, with }    # template fill → agent prompt
       | { kind: script,   ref }          # script asset, exec
       | { kind: shell,    text, shell }  # inline run:
       | { kind: workflow, ref, with }    # tasks only
       | { kind: task,     ref }          # steps only; resolves recursively once
```

Execution is a strategy seam with exactly two implementations:

- **AgentUnitExecutor** — today's paths (task runner's `executeRunner()`;
  the orchestrator's journaled `UnitDispatcher`), consuming an assembled
  prompt + frozen engine + persona snapshot.
- **ShellUnitExecutor** — `Bun.spawn()` for `run:` text and script assets,
  used by both the task runner and the orchestrator.

Staging is symmetric and named (panel: the task path's staging was
unstated): **tasks** run *resolve → execute* — the same resolve stage
(cascade, persona, targets, templates) with no plan persistence;
**workflows** run *compile → resolve → freeze → execute* (§5.4). Both
executors sit behind one interface; each surface wraps results into its
own recording sink (`task_history`/`logs.db` vs the run journal) — the
adapter lives at the sink, not inside the executor, which is how the
`RunnerSpec`-vs-`UnitDispatchRequest` split stays out of the executors'
type signatures: the resolve stage produces one dispatch plan both
consume. **ShellUnitExecutor is extracted from the task runner's existing
hardened command path** (`runManagedSubprocess`, `src/core/subprocess.ts`,
called at `tasks/runner.ts:277-289`: process-group spawn, SIGTERM→SIGKILL
kill ladder, injectable spawn/timer seams, `AKM_EVENT_SOURCE` stamping)
and adopted by the orchestrator — not a new spawn wrapper.
(`src/tasks/backends/exec-utils.ts` is the scheduler-backend exec seam,
not part of this path.) Composition is monotemporal by rule: a referenced
task's fields join the cascade from the copy resolved at freeze, under the
workflow's config snapshot — a composed task never re-reads config at
dispatch.

Run recording stays split (cron job vs journaled plan) — that boundary is
real. Everything upstream unifies: target resolution, template filling,
cascade, alias resolution, env assembly.

### 5.2 Shell units in the IR — v3 → v4, not a non-goal

Review C2 (3/3): `IrInvocation.engine` and `UnitDispatchRequest.engine`
are required, the engine snapshot union is closed, freeze hard-errors with
no engine, and the IR rejects empty instructions — v7's "no IR changes"
was false. Owned properly:

- `IrInvocation` becomes a discriminated union:
  `{ kind: "agent", engine, … }` | `{ kind: "shell", script, shell, cwd,
  timeoutMs }` (`timeout` is a value field for `run:`, so the shell member
  carries it). Shell members exclude engine/llm fields **structurally** —
  by union-member shape, not by decoder-validated absence.
- Engine resolution happens **per unit kind**: shell units need no engine,
  so a shell-only workflow freezes on an engine-less machine (the current
  "no engine selected" error narrows to plans containing agent units).
- Instructions become optional for shell units (parser + IR relaxation —
  review M10; agent units keep the non-empty invariant).
- Shell units journal as normal `workflow_run_units` rows (status, timing,
  attempts, `failure_reason`; no tokens). Under the external driver
  protocol, shell units are **orchestrator-owned**: `brief` lists them as
  non-claimable and the engine executes them natively — a harness never
  claims shell work.
- Crash/restart: shell units use the same claim/lease rows as agent
  units; a running shell unit whose lease expires re-dispatches on resume
  under its retry policy. Re-execution idempotency is the author's
  contract — the same contract every cron job already carries — stated in
  the docs, not solvable by the engine.
- Plan IR version bumps to 4; decoders reject v4 plans in older binaries
  (existing plan-version machinery).

### 5.3 Unit identity — hashVersion 5, preimage stated

Review C3 (3/3): hashVersion 4's preimage (`step-work.ts:333-392`) covers
the frozen template bytes but none of the *other* new inputs — shell text,
the `uses:` target kind/ref/content hash, and the persona snapshot.
Without a bump, editing `run:` text, re-pointing a `uses:` ref, or editing
`agents/<n>` would silently reuse completed journal rows. (Freeze-time
prose appending, §2.3, already rides in via `template`.) hashVersion 5's
preimage, explicitly:

| Field | Notes |
|---|---|
| template instructions | **post** freeze-time prose append (§2.3) and **post** template fill, so `with:` values are covered via the filled bytes |
| target kind + `uses:` ref + resolved content hash | a re-pointed or edited referenced asset re-dispatches; also the retained provenance for composed steps (the "single-file provenance" minor). Script bytes are **embedded at resolve**, like a command's filled text — execution never re-reads live files, keeping composition monotemporal (§5.1) |
| persona snapshot hash | system prompt, tool policy, and value fields of the frozen persona — editing `agents/<n>` re-dispatches (panel critical: omitted in v8) |
| shell text, `shell`, `cwd` | shell units |
| item / inputs / params / dispatch / invocation / schema | as v4 |
| env **names** + env **literal values** | see §5.5 — literals are plan content; ref-sourced values stay names-only |
| isolation, gateFeedback | as v4 |

`retry`/`on_error` stay excluded (policy, not input) — unchanged rationale.

### 5.4 Freeze becomes two stages; lint gets a dry freeze

Review M11: `uses:` resolution needs asset IO inside a function documented
pure, and freeze currently has exactly one caller (run start), so every
composition error would escape lint. Restructure: **compile** (pure) →
**resolve** (asset loader injected: personas, referenced tasks, command
templates) → **freeze** (snapshot + hash). `akm lint --type workflows`
runs compile+resolve with the real loader and no persistence, so dangling
`uses:` refs, back-door workflow nesting, placeholder mismatches, and
capability notices all surface at lint time. Composed instructions carry
the existing 256 KiB cap with a lint warning at 80%.

### 5.5 `env:` — one shape, two provenance classes

Format unchanged from v6 (list of env-asset refs and literal mappings,
later wins, bare-mapping shorthand). Semantics corrected by review M3
(3/3), which showed "strictly additive" was false at the IR/hash/redaction
layers. The clean line is **provenance, not shape**:

- **Literal entries** are plan content: author-written bytes already
  durable in the source file — frozen into the plan, hashed (§5.3), shown
  by `brief`, **never redacted** (`LOG_LEVEL: debug` must not scrub
  "debug" from every log — the over-redaction finding).
- **Ref-sourced entries** (`env/<n>` groups, `secrets/<n>` values) are
  runtime-resolved: hashed by **name only**, resolved at dispatch, values
  joined to `sensitiveValues` for redaction, never durable. (Existing
  contract, now stated as the rule.)
- IR `env` becomes a typed entry list (ref | literal-pair) — an IR v4
  change, not "additive."
- Env assembly moves per-unit where fan-out requires it: a `map:` step
  with a shell target receives `AKM_ITEM` (JSON) and `AKM_ITEM_INDEX`
  per unit — set as env-object entries on the spawned process (the
  `runManagedSubprocess` `env:` pattern — `src/core/subprocess.ts`, as
  used at `tasks/runner.ts:284`), never spliced into shell text.
- Literal entries run the existing secret-shape heuristic
  (`param-secrets.ts`'s `detectSecretShapedParams`, built for exactly this
  risk on params): a secret-shaped literal is a lint error pointing at
  `secrets/<n>`.
- The split is enforced at one place: a single env-assembly resolver (§8
  plumbing) is the only producer of env entries and of their
  `sensitiveValues` contributions, so the literal/ref line cannot
  silently diverge per call site.

### 5.6 Executing scripts inherits the tools: ceiling — no new trust machinery

v8 proposed a per-bundle grant key. The panel killed it twice over:
`activation-policy.ts` documents a standing decision **against new
persisted trust machinery**, and the claimed precedent — the `tools:`
provenance ceiling — has **no override at all**. v9 inherits the ceiling
exactly instead of imitating it loosely:

- Shell-class work (a script asset, or the `run:` text of a task) executes
  **only when its defining asset lives in the operator's primary bundle** —
  the same line 07 P1-D draws for self-declared tool grants
  (`show.ts:433-445`): keyed off primary-bundle identity, explicitly *not*
  the writable bit, failing closed.
- Evaluated in the **resolve stage** (§5.1) — the shared stage both
  surfaces run before any execution — so there is no sync-time/fire-time
  gap and no standing grant for a bundle update to swap content under.
- Composition chains inherit the rule from the **defining asset's own
  source**: a primary-bundle task that `uses:` a third-party script — or
  composes a third-party task whose target is shell — refuses with an
  error naming the ref and its source. No chain launders provenance.
- The remedy is an existing verb, not a config bit: `akm clone <ref>`
  copies the asset into the primary bundle, where the operator owns and
  reviews the bytes; the refusal message says exactly that.
- Scope: this ceiling governs the **new non-AI exec surface only**.
  Agent-dispatched third-party tasks remain governed by the existing
  scheduling gates (setup/sync review, `enabled:`), unchanged.

Zero new config, zero persisted trust state. Loosening later (per-bundle
grants) is an additive future decision that must revisit the
activation-policy document — deliberately out of 0.9.0 scope.

### 5.7 Shell ergonomics

- Bare `akm` in shell/script work resolves to the current installation by
  a **synthesized shim**, not a bare PATH prepend: `resolveAkmInvocation()`
  can return a multi-element launcher invocation (`bun <script>` — the
  case the argv-splice was built for, panel M9 follow-up), so the runner
  writes a platform-appropriate shim (sh script / `.cmd`) invoking the
  exact resolved invocation into the run's temp dir and prepends that dir
  to the child `PATH` (case-insensitive `Path` merge on Windows). Replaces
  the argv rewrite for shell work and covers scripts for free; the task
  runner keeps the argv rewrite only for legacy `.yml` until retirement.
- `cwd:` under `isolation: worktree` is resolved relative to the worktree
  root; `cwd:` on the LLM runner is a capability notice (review minors).

## 6. GitHub Actions alignment — familiar, not copied

Adopted: `uses:`/`run:` pair with mutual exclusion; **`with:` for inputs
to the referenced thing** (returned to the adopted column by M1);
step-level keys with no nesting bag; shell semantics with per-OS defaults
and `shell:`; `env:` bare-mapping shorthand; `cwd:`; `on_error`/`timeout`
as step keys. Kept akm: typed asset refs (the subdir says what executes —
GHA's `uses:` is opaque); `params:` reserved for declarations; no step
`name:`; bundles as the sharing unit.

## 7. Steps flatten to the task shape — with the schema collision fixed

The `unit:` bag and `map.unit` are still deleted; targets and value fields
sit on the step; `map:` keeps `over`/`concurrency`/`reducer`. But v7's
"duplicate `output` wart" was **wrong** — review C1 (3/3):
`unit.output` compiles to the per-dispatch structured-result `schema`
(driving structured retry / `parse_error`) while `step.output` compiles to
`outputSchema`, the promoted artifact the gate validates
(`compile.ts:204,229` — verified). Two concepts, two homes:

- **`output:`** on a step — the step's **artifact** schema, all step kinds.
  On a unit step it also serves as the dispatch result schema (result *is*
  the artifact).
- **`map.output:`** — the **per-item** result schema of a map step's units;
  the step's `output:` continues to describe the reduced artifact.

```yaml
- id: review
  map: { over: steps.intake.output.files, concurrency: 3, output: { type: object } }
  output: { type: array }        # what `steps.review.output` resolves to
```

## 8. Migration — inside the hardened 0.9.0 cutover

Rebuilt against the `71bb686` migrator and review M7 (3/3):

- **The converter joins the content-migration step with a vendored,
  frozen copy of the v2 task parser** — the current
  `task-target-ref-migration.ts` imports the *live* parser from `src/`,
  which violates the frozen-migrator principle and breaks the moment the
  live parser is replaced; that gets fixed as part of this work.
- Mapping: `command: <shell string>` → `run:` verbatim; `command:
  [argv…]` → `run:` with each element shell-escaped **for POSIX `sh`, the
  migrated task recording `shell: sh` explicitly** so the Windows
  `powershell` default never reinterprets the quoting; `prompt: |` →
  body; `prompt: commands/x` → `uses:` + `with:`; `prompt: agents/x` →
  `agent:`; `prompt: ./file.md` → inlined; `workflow:`+`params` →
  `uses: workflows/…` + `with:`; `timeoutMs` → `timeout`;
  `llm.maxTokens`/`llm.temperature`/`llm.extraParams` → flat fields;
  **`name:` → the body's H1** when the converted body has none, else a
  per-task migration notice (never silently dropped);
  `llm.supportsJsonSchema`/`contextLength`/`enableThinking` are
  endpoint-capability facts that belong on the **engine node** — the
  migrator emits a per-task notice naming the value and the config key
  (lossy-with-notice, never silent).
- Scheduler entries untouched: ids and the `akm task run <id>` ABI do not
  change.
- **The `.yml` tombstone rule** replaces v7's false "structural" claim
  (refusals key on config/DB shape, not stray files, and placement
  filters by extension — a stray `.yml` today would be invisible or
  wrongly installed): task discovery keeps matching `tasks/*.yml`
  **permanently, as a diagnostic**. In **writable** bundles, `sync`,
  `doctor`, and `lint` hard-error naming the file and the fix; in
  **read-only/third-party** bundles the same diagnostic is a warning —
  the operator cannot edit those files, matching the migrator's existing
  read-only carve-out (`task-target-ref-migration.ts:253-271`). Either
  way a `.yml` is never installed and never silently skipped.
  `<id>.yml` + `<id>.md` colliding on one conceptId is the same named
  error. **Conversion is interruption-safe by ordering**: the migrator
  journals the `.md` write and verifies it before removing the `.yml`,
  and the collision diagnostic special-cases the byte-equivalent
  mid-migration pair (resume completes the removal instead of erroring on
  the migrator's own half-applied state — the panel's crash-window
  finding; the current *backup* model journals whole-DB/config artifacts
  only (`migration-backup.ts:54`), so per-file crash safety lives in the
  content-migration step's own resume ledger —
  `content-migration-report.json`'s `reservedRenames`
  (`config-migrate.ts:518-575`); the `.md`-write-then-`.yml`-delete
  ordering extends that existing ledger rather than introducing per-file
  journaling, costed in §9).
- Embedded templates convert to `.md`; `listEmbeddedTasks` and `akm
  setup`'s task review move to markdown-aware editing (the current YAML
  round-trip would destroy bodies — review minor).
- The id-grammar work (subdir ids, scheduler-id `/` → `--` mapping with
  collision lint) lands **in the same migration step, before scheduler
  reconciliation** — sequencing the panel flagged as unstated.
- The pre-flatten workflow schema (`unit:`, `map.unit`, `defaults.llm`)
  converts in the same step: bag fields lift, `llm` flattens,
  `unit.output` → `map.output` or step `output:` per §7.

## 9. Cost inventory — what this actually changes

Honest replacement for v7's §10 (review: "non-goals false ×4").

| Surface | Change |
|---|---|
| IR | v3 → v4: invocation union, optional instructions (shell), typed env entries, `map.output` |
| Unit hash | hashVersion 4 → 5 (§5.3 preimage) |
| Freeze | two-stage (compile/resolve/freeze), per-kind engine resolution, persona snapshot, prose append, capability notices |
| Dispatch | executor strategy (agent/shell); persona fields reach `UnitDispatchRequest` |
| Schemas | shared target+value defs; task schema rewritten; workflow schema flattened; `DefaultsSchema` extended and made strict; engine schemas made strict |
| Parsers | `parseTaskDocument` retired to the migrator (vendored); unified parser gains task recognition; section-required rule relaxed per target kind; the indexer classifier (`matchers.ts`) gains a `type: task` branch ordered ahead of the `"agent" in fm` rule |
| Adapters | markdown task recognition (`type: task`); the `type: "task"` pure-YAML special-case removed (markdown base checks apply); improve-ineligibility declared per-type (§3 — `DISTILL_REFUSED_INPUT_TYPES` is the cheapest of three homes); akm-task format-family goldens rewritten directly (they carry `specificationGolden: true` / `adapterStatus: NOT IMPLEMENTED`, and `DESIGNATIONS.json` does not cover that tree at all). **DESIGNATIONS re-pointing is mandatory pre-work**: six entries are touched — `cli/c-tasks-family.json` (already `re-baseline`, chunk 9) plus five goldens pinning `tasks/*.yml` paths — `recognition/all-types.json`, `placement/all-types.json`, `minting/oracle.json` (chunk 4), `lint/all-types.json` (chunk 3), `renderer/all-types.json` (chunk 8) — whose `reBaselineChunk` must be re-pointed at this change *before* it lands, per the DESIGNATIONS `$policy` surface-owner rule |
| Named refactors | 07 P1-D ceiling extracted from `show.ts` into a shared persona resolver; ShellUnitExecutor extracted from the task runner's hardened command path; the three engine/model resolution sites consolidated into the cascade module; the `akm` shim mechanism; per-file create-verify-delete ordering added to the content-migration step's existing `reservedRenames` resume ledger |
| CLI | `task create`; `task add` retires with `.yml`; capability notices in lint/doctor |
| Storage | `task_history.target_kind` values widened (additive) |
| Docs/tests | reference docs, ~10 templates, format-family goldens, parser/freeze/executor suites |

Inherited bugs fixed en route: `{{0}}`-only placeholder filling; raw
frontmatter shipped to models via `prompt: agents/x`; subdir task ids
indexed but unrunnable (`validateTaskId` rejects `/` — the id grammar
gains subdir support with the scheduler-id mapping documented); freeze's
dead llm guard.

## 10. Non-goals (now true)

- No new orchestration semantics: `map`/`route`/`gate` behavior, leases,
  check-ins, replay *logic*, and the driver protocol are unchanged (shell
  units are orchestrator-owned under it).
- No scheduler-backend, `sync`-reconciliation, or `akm task run <id>` ABI
  changes.
- No change to how command/script/agent/env/secret assets are authored.
- No multi-file config merging; the cascade layers are config nodes,
  bundle assets, and document/call-site keys.
- Gate judge selection stays outside the cascade in 0.9.0.

## 11. Findings cross-reference and decision log

| Finding (consolidated) | Resolution |
|---|---|
| C1 output collision (3/3) | §7 — two schemas, two homes (`output:` / `map.output:`) |
| C2 shell units unrepresentable (3/3) | §5.2 — IR v4 invocation union, per-kind engine resolution |
| C3 hash preimage (3/3) | §5.3 — hashVersion 5, preimage table; §2.3 freeze-time append |
| C4 cascade layers don't exist (3/3) | §4 — "built, not exposed"; build inventory |
| C5 script execution security (2/3) | §5.6 — the tools: ceiling inherited exactly (primary-bundle only, no override); v8's grant key withdrawn after the panel showed it contradicted activation-policy's no-new-trust-machinery decision |
| M1 params overload (3/3) | §2.2 — `with:` for inputs; `params:` declarations only; neither cascades |
| M2 placeholder grammar (3/3) | §2.4 — `with:`/`with.arguments` against the real grammar; lenient + lint |
| M3 env not additive (3/3) | §5.5 — literal/ref provenance split; IR v4; per-unit env |
| M4 alias portability (3/3) | §4.5 — `"*"` columns + unresolved-alias notice |
| M5 agent plumbing + ceiling; false corroboration | §4.2 — persona snapshot via show layer; corroboration claim retracted |
| M6 dead kind-gate (2/3) | §4.4 — both gates → capability notices |
| M7 migration overclaims (3/3) | §8 — vendored parser, full mapping, tombstone rule |
| M8 adapter recognition (2/3) | §3 — `type: task` required |
| M9 akm-bin rewrite (2/3) | §5.7 — synthesized shim (a bare PATH prepend cannot cover multi-element launcher invocations) |
| M10 prose invariants (2/3) | §5.2 — per-kind relaxation, costed |
| M11 lint never freezes (1/3) | §5.4 — dry freeze in lint |
| M12 `defaults.on_error` (2/3) | §4 — `on_error`/`retry` join the value vocabulary |
| M13 improve surface (1/3) | §3 — improve excluded from task bodies |
| Minors | §3 (draft/deprecated), §5.7 (cwd), §8 (embedded/setup, collisions), §9 (bugs fixed, target_kind, goldens) |

Decisions 1–14 (rounds 1–6) stand as logged in v7 except where this
revision supersedes them with review evidence: call-site `params:` →
`with:` (M1); "expose the cascade" → "build the cascade" (C4); "duplicate
output" → two-schema design (C1); §10 non-goals → §9 cost inventory
(C2/C3). v7's remaining question (cascade sign-off) is superseded by this
section's cross-reference — the cascade shape survived review; its cost
didn't, and is now stated.

**Round 1 Sonnet panel (v8 → v9).** Four independent reviewers (coverage
audit, architecture, fresh adversarial, security+migration; full reports
`sonnet-r1-*.md` in the session scratchpad). Panel criticals, all applied:
the §5.6 grant key contradicted activation-policy's documented
no-new-trust-machinery decision → replaced by exact ceiling inheritance;
the v8 hash preimage omitted the persona snapshot → added; `with:` merge
on composition chains was undefined → §2.2; the tombstone hard-error was
unactionable on read-only bundles → warning carve-out. Panel majors, all
applied: task-path staging named (resolve → execute); executor sinks as
the adapter boundary; ShellUnitExecutor extracted from the task runner's
hardened path, not rebuilt; monotemporal composition rule; persona
resolver extraction scoped; merge classes stated (deep-merge preserved
for `extra_params`); shell invocation carries `timeoutMs`; shell-unit
crash/lease semantics; toolPolicy under capability notices; improve
exclusion given a named mechanism; migration crash-window ordering;
POSIX-pinned migrated quoting; launcher-aware shim. One panel claim was
verified false and rejected: "the tools: ceiling doesn't exist" — it does
(`show.ts:433-445`), inline in the show command, which is exactly why §4
scopes its extraction.

Open items: none blocking. Two implementation-time choices are delegated
to the implementer with defaults: the exact capability-declaration shape
per engine kind (default: a static field list per kind), and the
scheduler-id mapping for subdir task ids (default: `/` → `--` with
collision lint).
