# Task / Workflow Unification: One Target Vocabulary, One Prose Rule

Status: PROPOSAL v8 — full redesign after three independent adversarial
reviews of v7 verified every claim against the code (consolidated findings:
5 critical, 13 major; all resolved or explicitly costed here, see §11
cross-reference). Baselined on `claude/release-0-9-0-polish-d6sycl` @
`71bb686` (hardened 0.9 cutover). Breaking changes are approved for 0.9.0.
Date: 2026-08-01
Related: [`workflow-format-unification.md`](./workflow-format-unification.md),
[`okf-support.md`](./okf-support.md),
[`docs/reference/workflows.md`](../../reference/workflows.md)

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
(positional) and `{{name}}`; the current filler substitutes only positional
`{{0}}` forms leniently (`src/output/renderers.ts:164-186` — a live bug
fixed by this work). The contract, defined against that reality:

- `with:` mapping keys fill `{{name}}` placeholders.
- The reserved key `with.arguments` (string) fills `$ARGUMENTS`, and its
  whitespace-split words fill `$1`–`$9`.
- An unmatched placeholder or unused `with:` key is a **lint warning and is
  left verbatim** — not a runtime hard error, so imported `$ARGUMENTS`
  commands remain usable as targets.

Filling happens at freeze (workflows) / dispatch (tasks), producing the
prompt string. Bodies remain verbatim — templating stays scoped to the
command asset type, whose definition is "a template with placeholders."

## 3. The task asset

`<bundle>/tasks/<id>.md`: the shared envelope (`$ref
akm-asset-envelope.json`, OKF v0.2 families included), trigger keys, at
most one target, and any §4 fields. No `version:` key. **Recognition
requires frontmatter `type: task`** — v7's "or `tasks/` residence" is
unimplementable as stated because the workflow adapter is ordered first
and claims `.md` files without a contrary `type:`
(`src/core/adapter/adapters/index.ts:73-90`); residence is a lint
*expectation*, not a recognition signal.

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
warning. The improve pipeline **never rewrites task bodies** — a task body
is an executable prompt, not curatable knowledge; lint runs, improve is
excluded by adapter policy.

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
false for them; they remain meaningless on a task and lint says so.)

**Layers, far → near:**

```
config defaults: → engines.<selected> → agents/<selected> → document defaults: → uses: tasks/<ref> → step/task keys
```

**What must be built (the honest inventory):**

1. `DefaultsSchema` gains the value fields, and stops silently swallowing
   unknown keys (strict with migration-safe notices).
2. A **persona snapshot**: the agent asset resolved through the show layer
   — which is where the writable-vs-third-party provenance ceiling for
   self-declared `tools:` already lives (review M5) — yielding
   `{systemPrompt, toolPolicy, model, …valueFields}`, frozen into the plan.
   Freeze never re-implements the ceiling; it consumes the show layer's
   verdict. (This also fixes the live bug where `prompt: agents/x` ships
   raw file bytes *including frontmatter* to the model —
   `runner.ts:592-593`.)
3. One cascade module (`src/exec/cascade.ts`), the only implementation of
   layer merge, consumed at freeze (workflows) and dispatch (tasks).
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

Run recording stays split (cron job vs journaled plan) — that boundary is
real. Everything upstream unifies: target resolution, template filling,
cascade, alias resolution, env assembly.

### 5.2 Shell units in the IR — v3 → v4, not a non-goal

Review C2 (3/3): `IrInvocation.engine` and `UnitDispatchRequest.engine`
are required, the engine snapshot union is closed, freeze hard-errors with
no engine, and the IR rejects empty instructions — v7's "no IR changes"
was false. Owned properly:

- `IrInvocation` becomes a discriminated union:
  `{ kind: "agent", engine, … }` | `{ kind: "shell", script, shell, cwd }`.
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
- Plan IR version bumps to 4; decoders reject v4 plans in older binaries
  (existing plan-version machinery).

### 5.3 Unit identity — hashVersion 5, preimage stated

Review C3 (3/3): hashVersion 4's preimage
(`step-work.ts:333-392`) covers none of the new inputs; without a bump,
editing `run:` text or the appended prose would silently reuse completed
journal rows. hashVersion 5's preimage, explicitly:

| Field | Notes |
|---|---|
| template instructions | **post** freeze-time prose append (§2.3) |
| target kind + `uses:` ref + resolved content hash | a re-pointed or edited referenced asset re-dispatches |
| shell text, `shell`, `cwd` | shell units |
| item / inputs / dispatch / invocation / schema | as v4 |
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
  per unit.

### 5.6 Executing scripts is an activation decision, not plumbing

Review C5: script `run`/`setup`/`cwd` metadata is advisory today, and
"registering a bundle never activates code" is a documented invariant —
v7 quietly reversed it. v8 extends the invariant instead:

- Executing a script asset (or composing a task that does) from the
  operator's **own writable bundles**: allowed — same trust as authoring
  `run:` text.
- From a **third-party / read-only bundle**: requires an explicit
  per-bundle grant (`bundles.<name>.allowScriptExecution: true`), settable
  interactively during `akm setup`'s existing task-review step or by
  `akm config set`. Absent the grant, dispatch refuses with the config
  key named; nothing is auto-activated by install, ever.
- Same ceiling philosophy as the `tools:` provenance gate, applied at
  resolve time (§5.4), enforced at both executors.

### 5.7 Shell ergonomics

- Bare `akm` in shell/script work resolves to the current installation by
  **PATH prepend** in the child environment — replacing the argv-rewrite
  (`resolveNestedAkmCommand`) that shell text would defeat (review M9),
  and covering scripts for free. The task runner keeps the argv rewrite
  only for legacy `.yml` `command:` until that format retires.
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
  [argv…]` → `run:` with each element shell-escaped (arrays have no free
  shell spelling); `prompt: |` → body; `prompt: commands/x` → `uses:` +
  `with:`; `prompt: agents/x` → `agent:`; `prompt: ./file.md` → inlined;
  `workflow:`+`params` → `uses: workflows/…` + `with:`; `timeoutMs` →
  `timeout`; `llm.maxTokens`/`llm.temperature`/`llm.extraParams` → flat
  fields; **`name:` → the body's H1** (not dropped);
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
  **permanently, as a diagnostic** — `sync`, `doctor`, and `lint` each
  hard-error naming the file and the fix; a `.yml` is never installed and
  never silently skipped. `<id>.yml` + `<id>.md` collide on one conceptId
  → same named error.
- Embedded templates convert to `.md`; `listEmbeddedTasks` and `akm
  setup`'s task review move to markdown-aware editing (the current YAML
  round-trip would destroy bodies — review minor).
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
| Parsers | `parseTaskDocument` retired to the migrator (vendored); unified parser gains task recognition; section-required rule relaxed per target kind |
| Adapters | markdown task recognition (`type: task`); improve-exclusion policy; task goldens re-baselined (they are marked immutable — a DESIGNATIONS re-baseline note is part of the change, as the S6 precedent) |
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
| C5 script execution security (2/3) | §5.6 — activation grants; invariant extended, not reversed |
| M1 params overload (3/3) | §2.2 — `with:` for inputs; `params:` declarations only; neither cascades |
| M2 placeholder grammar (3/3) | §2.4 — `with:`/`with.arguments` against the real grammar; lenient + lint |
| M3 env not additive (3/3) | §5.5 — literal/ref provenance split; IR v4; per-unit env |
| M4 alias portability (3/3) | §4.5 — `"*"` columns + unresolved-alias notice |
| M5 agent plumbing + ceiling; false corroboration | §4.2 — persona snapshot via show layer; corroboration claim retracted |
| M6 dead kind-gate (2/3) | §4.4 — both gates → capability notices |
| M7 migration overclaims (3/3) | §8 — vendored parser, full mapping, tombstone rule |
| M8 adapter recognition (2/3) | §3 — `type: task` required |
| M9 akm-bin rewrite (2/3) | §5.7 — PATH prepend |
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

Open items: none blocking. Two implementation-time choices are delegated
to the implementer with defaults: the exact capability-declaration shape
per engine kind (default: a static field list per kind), and the
scheduler-id mapping for subdir task ids (default: `/` → `--` with
collision lint).
