# Review #3 — `task-workflow-format-unification.md` (v7) + the implementation it builds on

Reviewer: independent reviewer #3 of 3.
Repo: `/home/user/akm` @ `claude/akm-markdown-tasks-history-75l6du` (baselined on `claude/release-0-9-0-polish-d6sycl`).
Scope: the spec end-to-end, every factual claim it makes about the code, and the readiness of the
code it plans to build on.

---

## 0. Summary judgement

The **direction** is right and the grounding (§1) is sound: `uses:`/`run:`, the prose rule, and
"steps are tasks" genuinely reduce concept count, and the target-key XOR really does make a whole
error class structurally impossible. The `.yml` task format is, on inspection, worse than the spec
says it is (see F-04) and deserves to die.

The **v7 configuration section (§3.4) and the non-goals (§10) do not survive contact with the
code.** Three load-bearing claims are false:

1. Freeze's "layer cascade" the spec says it is merely *exposing* does **not** include a config
   defaults layer for anything but `engine` — `defaults.model` does not exist in the config schema
   and is read nowhere, so the spec's own worked example silently does nothing today.
2. The "kind-gated hard error" the spec says `llm:` exists to scope is **dead code** in
   `freeze.ts`. The workflow surface already silently drops `llm` overrides on agent engines.
3. §10's "no changes to IR, freeze, journal, leases, or replay" is contradicted by §3.4/§3.6/§3.7 on
   at least six counts (agent persona → system prompt/tool policy; shell units without an engine;
   `env` list-of-mappings; `cwd`/`shell`/`params` at dispatch; non-empty-`instructions` invariant;
   the unit input-hash preimage). This is not authoring-surface-only work; it is an IR v3 schema +
   hash-version change.

Plus two silent-loss bugs the plan would bake in: deleting `unit.output` conflates two
*semantically different* schemas (F-05), and moving `command:` argv → `run:` shell text destroys
the `akm`-binary resolution seam every shipped template depends on (F-06).

Recommendation: **do not sign off decision 14 as written.** §3.4 needs a config-layer reality pass
and §10 needs to be rewritten to admit an IR change. §3.3/§3.6 need the input-hash and
`instructions` invariants addressed before anyone starts.

---

## 1. Findings table

| # | Sev | Title | Evidence |
|---|---|---|---|
| F-01 | critical | Cascade's "config defaults" layer does not exist; the worked example is a silent no-op | `config-schema.ts:102-108`, `freeze.ts:169-171,193-209` |
| F-02 | critical | §10 "no IR/freeze changes" is false — §3.4/§3.6/§3.7 all require IR v3 schema changes | `ir/schema.ts:417-451`, `unit-dispatch.ts:9-31`, `native-executor.ts:1026-1027` |
| F-03 | critical | Shell (`run:`) units cannot exist in the current IR: no engine, empty instructions, no runner kind | `freeze.ts:52-62`, `ir/schema.ts:434-441`, `native-executor.ts:1104+` |
| F-04 | critical | Unit input-hash preimage is unaddressed — `run:`/`uses:`/`cwd`/`shell`/`params` would not re-dispatch | `step-work.ts:376-392` |
| F-05 | major | Deleting the `unit:` bag conflates two distinct `output` schemas and loses per-item validation on `map` | `program/schema.ts:125,186`, `compile.ts:204,229`, `native-executor.ts:54-56,663` |
| F-06 | major | `command:` argv → `run:` shell text destroys `resolveNestedAkmCommand` / akm-bin resolution | `runner.ts:263,343-348`, `command-executable.ts:18-22`, `src/assets/tasks/**` |
| F-07 | major | The "kind-gated hard error" §3.4 argues against is dead code; workflows already drop `llm` silently | `freeze.ts:67-73` |
| F-08 | major | `agent:` as a cascade selector requires system-prompt + tool-policy plumbing that does not exist | `native-executor.ts:1026-1027`, `renderers.ts:252-262`, `IrInvocation` `ir/schema.ts:78-84` |
| F-09 | major | `params:` now means three different things; §5 claims this as a simplification | §3.2 vs §5 vs `renderers.ts:164-176`, `ir/params.ts:34-56` |
| F-10 | major | Command-template filling is undefined for the actual placeholder grammar (`$ARGUMENTS`, `$1`..`$9`) | `renderers.ts:164-176`, `indexer/walk/matchers.ts:126` |
| F-11 | major | `env:` list-of-mappings breaks the IR `string[]` contract and the "names only" hash invariant | `ir/schema.ts:448`, `step-work.ts:353-357,387` |
| F-12 | major | Prose-optional on `uses:`/`run:` steps collides with the non-empty-`instructions` invariant | `workflows/parser.ts:281-296`, `ir/schema.ts:434-441` |
| F-13 | major | Migrator depends on the live task parser; yml→md is a path-changing content step in a journaled plan | `task-target-ref-migration.ts:27,44-58` |
| F-14 | major | Markdown tasks silently inherit the whole markdown lint/OKF/`improve` surface — including body rewrites of live prompts | `akm-adapter.ts:388-434`, `asset-placement.ts:157-169` |
| F-15 | minor | Model aliases are *not* portable to LLM endpoints or non-claude/opencode platforms | `model-aliases.ts:45-104` |
| F-16 | minor | Gate judges are outside the cascade; §3.4 never says whether that stays | `freeze.ts:109,263-278` |
| F-17 | minor | `on_error` is called steps-only in §3.4 but already exists at document defaults | §3.4 vs `program/schema.ts:210`, `compile.ts:231` |
| F-18 | minor | Adapter story for `.md` tasks is underspecified and partly contradicts `okf-support.md` | `adapters/index.ts:73-88`, `akm-workflow-adapter.ts:141-155`, `okf-support.md:47-63` |
| F-19 | minor | `status: draft` adds a second, orthogonal installation gate next to `enabled:` | §4 vs `tasks.ts:400-445` |
| F-20 | minor | `task_history.target_kind` is a persisted enum the new target vocabulary outgrows | `runner.ts:823-830,870-899` |
| F-21 | minor | Embedded-template enumeration fails *silently* on format change | `embedded.ts:91-97` |
| F-22 | minor | Composition loses single-file provenance (`IrUnitNode.source`) and can blow the 256 KiB instruction cap | `ir/schema.ts:444-445`, `compile.ts:186` |
| F-23 | minor | 0.7 md → 0.8 yml → 0.9 md whiplash; the existing collision guard must be inverted | `tasks.ts:154-163` |
| F-24 | minor | `prompt: agents/x` sends raw file bytes (frontmatter included) — worse than §3.5 describes | `runner.ts:592-593` |

Claims I checked and found **accurate**: `parser.ts` is 368 lines; `akm-task.json` is 87 lines and
loaded by nothing at runtime (`tests/integration/tasks-schema.test.ts:8` only); `start`/`next`/
`complete` are gone (`workflow-cli.ts:522-531`); `runWorkflowTask()` → `runWorkflowSteps()` works
(`runner.ts:352-416`); `UnitDispatchRequest` carries prompt/engine/timeoutMs/env/cwd/
sensitiveValues and results carry `failureReason` (`unit-dispatch.ts:9-43`); `output` really is
declared twice in `akm-workflow.json` (`:232,344`); command assets really do read an `agent:`
frontmatter key (`renderers.ts:235`); agent assets really are model-hint-only
(`renderers.ts:260`); `temperature` on an agent-kind engine really is a config error
(`engines.ts:105-120`); `resolveModel()` really is a one-level four-tier chain
(`model-aliases.ts:89-104`).

---

## 2. Critical

### F-01 — The cascade's far layer does not exist. The worked example is a silent no-op.

§2 and §3.4 rest on: *"Freeze already implements a configuration cascade … §3.4 exposes this
existing mechanism."* The mechanism exists **for the two document layers only**.

`freeze.ts:50` builds `layers = [documentDefaults, unit]`. Resolution:

- engine — `selectedEngine()` walks layers nearest-first, then falls back to
  `config.defaults?.engine` (`freeze.ts:151-155`). ✅ config layer exists.
- model — `exactModel()` walks layers, then `engine.model` (`freeze.ts:169-171`). **`config.defaults.model` is never consulted.**
- timeout — `effectiveTimeout()` walks layers, then `engine.timeoutMs`, then a builtin constant (`freeze.ts:193-209`). **No config-defaults timeout.**
- llm overrides — `mergedLlmOverrides()` deep-merges layers only (`freeze.ts:211-216`). No engine-node or config-defaults participation (the engine's own `temperature`/`maxTokens` go into the *snapshot*, `freeze.ts:231-236`, a different path).

And the config schema has no such key at all:

```ts
// src/core/config/config-schema.ts:102-108
export const DefaultsSchema = z.object({
  engine: engineName.optional(),
  llmEngine: engineName.optional(),
  improveStrategy: engineName.optional(),
}).passthrough();
```

`.passthrough()` means the spec's literal worked example —
`{ "defaults": { "engine": "claude", "model": "sonnet" } }` (§3.4) — **validates today and does
absolutely nothing.** A user following the spec's teaching example gets silent configuration loss,
the exact failure mode `config-schema.ts:117-120` says the strict schema exists to prevent.

So the honest framing is the opposite of the spec's: freeze implements a *two-layer* nearest-wins
resolution with per-field engine fallbacks. §3.4 proposes a **five-layer** cascade. Three of those
five layers (config defaults, engine node as a uniform layer, persona node) do not exist as layers
and must be built, each with its own schema surface.

**Recommendation.** Rewrite §2's third bullet and §3.4's opening to say what is true: "freeze
resolves two document layers nearest-wins; §3.4 generalizes that to five." Then add an explicit
sub-section enumerating the *new config schema surface* (`defaults.model`, `defaults.timeout`,
`defaults.env`, …) with `.strict()` on it, plus a migration note that a pre-existing
passthrough `defaults.model` would change meaning from inert to load-bearing — which violates §8's
"No key survives with a changed meaning."

### F-02 — §10 "no changes to IR, freeze, journal, leases, or replay" is false.

§10 asserts the §3.4 cascade and §3.6 flatten are "authoring-surface changes over the layer
resolution freeze already performs." Every one of the following requires an IR v3 shape change,
each of which trips `assertKeys` (`ir/schema.ts:417-433`) and therefore changes `plan_hash`
(`plan-hash.ts:22-34`) for every plan:

| §3.x feature | IR field needed | Blocking code |
|---|---|---|
| `agent:` persona (system prompt) | `IrUnitNode.systemPrompt` | `native-executor.ts:1026-1027` — "`systemPrompt`/`tools`/`cwd` come from the profile/asset, not the workflow unit" |
| `agent:` persona (tool policy) | new IR field + dispatch plumbing | no field on `UnitDispatchRequest` at all (`unit-dispatch.ts:9-31`) |
| `cwd:` as a value field | `IrUnitNode.cwd` | today `request.cwd` is populated only by worktree isolation |
| `shell:` | `IrUnitNode.shell` | no such concept |
| `params:` at step level | `IrUnitNode.params` | params are run-level only (`step-work.ts:326`) |
| `run:` target | a target discriminator on the node | `node.kind` is `"unit"\|"map"` only (`ir/schema.ts:392`) |
| `env:` literal mappings | `env` type widened | `validateStringArray(node.env, …)` (`ir/schema.ts:448`) |

`IrInvocation` today is exactly `{engine, model, timeoutMs, llm?}` (`ir/schema.ts:78-84`).

**Recommendation.** Replace §10's first bullet with an explicit IR-change budget: list the new
`IrUnitNode`/`IrInvocation` fields, state whether `WORKFLOW_IR_VERSION` bumps to 4 (it should — the
plan classifier already has an `unsupported-version` arm, `plan-classifier.ts:14`), and note that
every frozen-plan golden and the replay-fuzz suite re-baselines. Pre-release makes this cheap; the
spec pretending it is free makes it *unschedulable*.

### F-03 — A `run:` step cannot be frozen at all today.

§3.6 says a shell unit "journals like any unit (`workflow_run_units`): no tokens, but status,
timing, attempts, and `failure_reason` behave normally." Three hard blocks:

1. **Engine required.** `freezeInvocation()` (`freeze.ts:49-75`) throws `ConfigError("No workflow
   engine is selected…")` when no layer and no `config.defaults.engine` names one. A workflow of
   nothing but `run:` steps therefore **fails to freeze on a machine with no agent CLI installed** —
   the single most obvious reason to want shell steps.
2. **Non-empty instructions required.** `ir/schema.ts:434-441` fails a unit whose `instructions` is
   not a non-empty string. A `run:` step whose prose section is optional (§3.3/§4) produces `""`
   (`compile.ts:174`).
3. **No shell runner.** `frozenUnitRunner`/`defaultUnitDispatcher` branch on `llm` / `sdk` / `agent`
   (`native-executor.ts:1076,1104`). `FrozenEngineSnapshot` is `FrozenLlmEngine | FrozenAgentEngine`.
   There is no fourth kind, and the two guards at `native-executor.ts:1050-1074` (env-unsupported,
   isolation-unsupported) are written assuming a child process implies an agent.

**Recommendation.** §3.6 must specify a `kind: "shell"` frozen node with **no** `invocation`, make
`instructions` optional-when-shell (or synthesise the `run:` text as the instruction bytes), and
say explicitly that a shell-only workflow must freeze without any engine configured. Otherwise the
headline "`run:` is inline shell, no AI" is undeliverable.

### F-04 — The unit input-hash preimage is never mentioned; replay would be wrong.

`step-work.ts:376-392` computes the per-unit `inputHash` over a fixed preimage
(`hashVersion: 4`): `template.instructions`, `item`, `inputs`, `params`, `dispatch`, `invocation`,
`schema`, `env`, `isolation`, `gateFeedback`. Its own comment states the contract: *"Every field
here is a PLAN-FROZEN input that changes what the backend is actually asked to do, so a completed
unit is reused ONLY when all of them match."*

None of the new dispatch-significant surface is in that preimage:

- the `run:` shell text (for a shell unit `instructions` may be empty or unrelated prose — editing
  `run: bun test` → `run: bun test --coverage` would **reuse the completed row**);
- `uses:` ref and the resolved target;
- `cwd`, `shell`, step-level `params`;
- the appended `uses:`-step prose (§3.3) if the concat happens at prompt assembly rather than at
  freeze — `instructions` is what is hashed, not the assembled `prompt`.

That last one is subtle and important. §3.3 says the append is "a deterministic concat" at "one
seam". If that seam is `buildUnitPrompt` (`step-work.ts:331`), the hash preimage does not see it and
two materially different asks hash identically — the same class of bug the `gateFeedback` inclusion
(`step-work.ts:363-370`) was added to fix.

**Recommendation.** Add a §3.8 "Replay identity": every new field enters the preimage,
`hashVersion` becomes 5, and the `uses:` prose append happens **at freeze**, folded into
`instructions`, so the existing preimage covers it for free. Also note the one-time consequence:
bumping `hashVersion` invalidates reuse for every in-flight run at cutover.

---

## 3. Major

### F-05 — Deleting the `unit:` bag silently deletes per-item output validation.

§3.6: *"`output:` is declared **both** on the step and inside the bag — a live wart … The duplicate
`output` declaration disappears with the bag."* They are not duplicates.

- `unit.output` → `WorkflowUnitDraft.schema` (`compile.ts:229`) → `IrUnitNode.schema` →
  `UnitDispatchRequest.schema` (`native-executor.ts:663`) → constrains the harness's structured
  output and drives `runStructured` / `parse_error` retries (`native-executor.ts:928-929,1038,1092`).
- `step.output` → `IrStepPlan.outputSchema` → validates the **promoted step artifact** after
  reduction, with a distinct failure mode that feeds the gate loop
  (`native-executor.ts:54-62`: "the promoted artifact is validated … flagged (`artifactSchemaFailure`)
  so the engine's bounded gate loop can re-run the step").

For a `map` step these are necessarily different schemas: `map.unit.output` types *one item's*
result, `step.output` types the *collected* array. Collapsing them onto one step-level `output:`
key makes per-item structured output unexpressible on fan-out, and quietly disables constrained
generation for every mapped unit.

**Recommendation.** Keep two keys under distinct names after the flatten — e.g. `output:` (step
artifact, unchanged) and `result:`/`unit_output:` (per-unit/per-item schema). Correct the §3.6
"wart" claim and the §6 table row that repeats it.

### F-06 — `run:` shell text destroys akm-binary resolution for every shipped template.

Today `command:` is **pre-split argv** (`parser.ts:300-306`) executed without a shell
(`runner.ts:277`), and before spawning, `resolveNestedAkmCommand()` (`runner.ts:343-348`) rewrites a
bare `akm` in the executable position to the *current installation's* invocation via
`resolveAkmInvocation()` — including the `env VAR=… akm …` form (`command-executable.ts:10-22`).

All ten shipped templates are exactly this shape:

```yaml
# src/assets/tasks/core/improve.yml
command: akm improve
```

Under `run: akm improve` executed by `sh -c`, that rewrite is impossible without shell-text
parsing — which the spec explicitly wants to avoid ("no ref-vs-inline sniffing exists anywhere in
the format"). The scheduled invocation captures `PATH` in its descriptor
(`scheduler-invocation.ts:86`), so a globally-installed binary survives; a `bun run src/index.ts`
dev install, a version-managed install, or a compiled binary not on the captured `PATH` does not.
`akm task doctor` already flags `path-selected` bindings as a distinct status (`tasks.ts:739`) —
this change makes *every* shell task path-selected.

Related: `runCommandTask` runs with `cwd: process.env.HOME ?? os.tmpdir()` (`runner.ts:279`) while
`runPromptTask` uses `cwd: stashDir` (`runner.ts:522`). §3.4 introduces `cwd:` as a value field but
never states the default, and the two existing paths disagree.

**Recommendation.** §3.6 must state: (a) how `akm` self-reference is resolved under shell
execution — the honest answer is probably to inject `AKM_BIN` into the env and document
`$AKM_BIN improve` in templates, or to prepend the resolved bin dir to `PATH`; (b) the default
`cwd` for `run:` in tasks vs steps, explicitly reconciling `runner.ts:279` and `:522`.

### F-07 — The hard error §3.4 argues against does not fire.

§3.4: *"`llm:` … was a grouping whose only job was to scope a kind-gated hard error, and that error
is incompatible with a cascade."* In `freeze.ts`:

```ts
67  const llm = engine.kind === "llm" ? mergedLlmOverrides(layers) : undefined;
68  if (engine.kind !== "llm" && llm !== undefined) {
69-73  throw new ConfigError(`Workflow engine "${name}" is an agent engine and cannot receive llm overrides.`, …);
```

Line 68 is **unreachable**: `llm` is `undefined` in exactly the branch the guard tests. So today a
workflow that writes `defaults: { llm: { temperature: 0.2 } }` under an agent engine gets **silent
drop**, not an error. The real hard error lives on the *task* path
(`runner.ts:497-501`) and in `akm-task.json`'s `oneOf` (`:36-40`).

This matters two ways. First, the spec's premise is wrong about where the behavior is, which
weakens the case for dissolving `llm:` (the argument reduces to "the *task* error must relax",
which is true but much narrower). Second, the proposed capability notice is a strict
*improvement* over the current silent drop — the spec should claim that credit rather than
argue against a guard that never runs.

**Recommendation.** Fix `freeze.ts:67-73` independently of this proposal (compute
`mergedLlmOverrides(layers)` unconditionally, then branch). Amend §3.4 to describe the actual
state: workflow = silent drop (bug), task = hard error, target = uniform notice.

### F-08 — `agent:` as a selector needs persona plumbing that does not exist.

§3.4 defines `agent:` as picking "the persona node — *who* runs it (system prompt, tool policy,
model preference)". Today an agent asset yields three things (`renderers.ts:252-262`): `prompt`
(system prompt), `toolPolicy` (`tools` frontmatter), `modelHint` (`model`).

Only the third is in the spec's flat value vocabulary. The other two are the ones that make a
persona a persona, and neither can reach a workflow unit: `native-executor.ts:1026-1027` states
outright that `systemPrompt`/`tools`/`cwd` "come from the profile/asset, not the workflow unit".
`UnitDispatchRequest.systemPrompt` exists but is used only by the frozen gate judge
(`frozen-judge.ts:38`), and for agent-CLI dispatch it is passed through
`buildAgentDispatchRequest` (`native-executor.ts:1035`) with no tool-policy channel at all.

There is also a **security seam** the spec walks past: `renderers.ts:246-250` documents that the
self-declared `tools` policy is subject to a *provenance ceiling* applied at the show layer, which
knows whether the asset came from the operator's own writable stash or a read-only third-party
source. Making `agent:` a first-class cascade selector resolved at freeze moves tool-policy
selection to a layer that does **not** have that provenance context. A third-party bundle shipping
`agents/helper` with a permissive `tools:` block, referenced by `agent: agents/helper` in a
workflow step, would bypass the ceiling.

**Recommendation.** Either (a) scope `agent:` to model-preference-only in 0.9.0 and say so
explicitly, or (b) add a §3.4 sub-section covering system-prompt and tool-policy plumbing plus the
provenance ceiling, and move the IR cost into the §10 budget (F-02).

### F-09 — `params:` acquires three meanings; §5 sells that as simplification.

§5: *"`inputs:` declared / `with:` passed → `params:` both places — one word beats two."* After
this change `params:` means:

1. **Declarations** at workflow document level: name → JSON Schema (`ir/params.ts:34-56`,
   `akm-workflow.json:26-36`). Not values.
2. **Workflow run arguments** on `uses: workflows/*` (§3.2) — coerced through those schemas.
3. **Template placeholder fills** on `uses: commands/*` (§3.2) — an entirely different mechanism
   (see F-10).
4. And, per §3.4, a **cascading value field legal at every layer** — so `defaults: { params: … }`
   would be values sitting one nesting level away from root `params:` which are schemas.

This is precisely the "three overloaded meanings" indictment the spec levels at `prompt:` in §3.1.
Worse, GHA's `inputs:`/`with:` split exists *because* the two are different things.

**Recommendation.** Keep two words. `params:` for declarations (existing), `with:` for passed
values at any call site. It is one extra word against four collapsed meanings, and it matches the
GHA muscle memory §5 is otherwise chasing.

### F-10 — Command-template filling is undefined against the real placeholder grammar.

§3.2: *"`uses: commands/<name>` … `params:` fill the placeholders … a placeholder with no matching
param is an error at fill time."*

The actual command placeholder grammar is **positional plus named**:
`$ARGUMENTS`, `$1`–`$9`, and `{{named}}` (`renderers.ts:164-176`, `indexer/passes/metadata.ts:438-444`,
`indexer/walk/matchers.ts:126` — `$ARGUMENTS|$[123]\b` is part of *recognizing* a file as a command
asset). A `params:` **mapping** has no defined projection onto `$ARGUMENTS` or `$1`.

Combined with the hard-error rule, this is actively breaking: `$ARGUMENTS` is the single most
common placeholder, and a scheduled task has no arguments, so
`uses: commands/<anything-with-$ARGUMENTS>` becomes an unconditional freeze/fill error.

**Recommendation.** §3.2 must state the mapping explicitly: `{{named}}` ← `params.<name>`;
`$1`–`$9` ← a positional `args:` list or `params: { "1": … }`; `$ARGUMENTS` ← the joined positional
list, defaulting to empty string rather than erroring. Also decide the converse case the spec omits:
a `params:` key with no matching placeholder (recommend: notice, consistent with §3.4's
capability-notice stance).

### F-11 — `env:` as a list of mappings breaks two existing contracts.

§3.7 claims the change "extends the existing schema additively — the workflow `unit.env` is already
a list of ref strings, so every currently-valid value stays valid." True of the *authoring* schema
(`akm-workflow.json:236-243`). False downstream:

- `ir/schema.ts:448`: `validateStringArray(node.env, …)` — a list containing a mapping fails plan
  decode.
- `step-work.ts:353-357`: the input hash includes `env: template.env ?? null` with the documented
  invariant *"`env` carries NAMES ONLY, never resolved values: hashing a resolved secret would leak
  it into a durable hash oracle."* Literal mappings are values. Inline literals would land in both
  `plan_json` and the durable hash.
- The spec also never says how `env` list concatenation interacts with **key collisions across
  layers**: "later entries win" is stated for entries, but an `env/prod` group entry and a literal
  entry can define the same key — is the winner determined by list position after concatenation
  (yes, presumably) or by layer? Say it.
- `ProgramDefaults` (`program/schema.ts:204-211`) has **no** `env` field, so "legal at every layer"
  is new surface at the document-defaults layer too.

**Recommendation.** State the IR representation for the new `env` shape (recommend: freeze
normalizes to an ordered list of `{ref}` / `{literals}` records, hash only refs + literal *keys*,
never literal values that resolve from `secrets/`), and add `env` to `ProgramDefaults`.

### F-12 — Optional prose on `uses:`/`run:` steps contradicts a hard parser + IR rule.

`workflows/parser.ts:281-296` errors when a unit/map step has no `## <id>` section, and errors again
when the section is empty. `ir/schema.ts:434-441` independently rejects empty `instructions`. §3.3
("Sections on `uses:` steps remain optional either way") and §3.6 (`run: bun test` with no section)
both require relaxing this.

That relaxation is not free: the "every unit step has prose" rule is what makes the prose rule
teachable and what the `instructions`-is-the-hash-preimage design leans on (`step-work.ts:378`).

**Recommendation.** Spell out the new body rule as a table: (no target → section **required**),
(`uses: commands/*` / `uses: tasks/<agent-task>` → optional, appended), (`run:` / `uses: scripts/*`
→ optional, documentation only). And say what fills `instructions` in the IR when the section is
absent.

### F-13 — The migrator depends on the live parser, and yml→md is a path change inside a journaled plan.

`scripts/akm-migrate/migrate/legacy/task-target-ref-migration.ts:27` imports `parseTaskDocument`
from `src/tasks/parser`, and its module doc says *"live task parsing remains strict 0.9 grammar."*
Replacing that parser with a markdown one breaks the migrator, which must read the **old** format.

Second problem: this migrator's plan is a list of `{filePath, before: Buffer, after: Buffer, mode}`
rewrites with `durabilityPaths` and a journaled, crash-resumable apply phase (`:44-58` and the
module doc). A format conversion **renames** `tasks/<id>.yml` → `tasks/<id>.md`. In-place byte
rewrite and rename-plus-write are different durability shapes; a crash between them leaves both
files present, which is exactly the "leftover files must never be silently invisible" lesson §8
invokes. Note also that `akmTasksSync` reads only `*.yml` today (`tasks.ts:414`) and
`akmTasksAdd` already has an *inverse* collision guard (`tasks.ts:154-163`, "a leftover `<id>.md`
still names the same task") that must be flipped.

**Recommendation.** §8 should require (a) a frozen copy of the v2 parser vendored into
`scripts/akm-migrate/`, with a note that `src/tasks/parser.ts` is free to change; (b) an explicit
ordering constraint (ref-rewrite phase completes before format-conversion phase, or they merge into
one phase); (c) the rename be journaled as delete+create with both paths in `durabilityPaths`.

### F-14 — Markdown tasks inherit the whole markdown lint / OKF / `improve` surface, including body rewrites.

`akm-adapter.ts:401-414` special-cases `type === "task"` to parse as **pure YAML with
`frontmatter: null`**, and the comment explains why: *"so the TaskLinter's field checks see real
data and `missing-updated` never fires."* Once tasks are markdown with real frontmatter, that
branch goes away and tasks join `runBaseValidateChecks` — `missing-updated`, `missing-description`,
staleness, OKF stamping, the lot. §6's "Envelope … future stamped keys inherited free" is true, and
also means the lint output for every existing task changes on day one.

The bigger issue is `improve`. A task body is now indexed prose *and*, for an agent task, the
literal executable prompt (§4, §3.1: "the prose *is* the work"). The improve pipeline semantically
rewrites markdown asset bodies. That means an automated pass can change what a scheduled agent job
does, with no scheduler-side signal — the file mtime changes but `akm task sync` only reconciles
`schedule`/`enabled` drift (`tasks.ts:388`), not body drift.

**Recommendation.** §4 must state whether task bodies are `improve`-eligible. Recommend: exclude
`tasks/` from semantic rewrite passes in 0.9.0, and add a §6 row acknowledging the lint-surface
change with an explicit list of newly-applicable base checks.

---

## 4. Minor

### F-15 — Model aliases are not as portable as §3.5 claims.

§3.5: *"`model: sonnet` resolves to the right string under a claude engine, an opencode engine, or
an LLM endpoint."* `BUILTIN_ALIASES` has exactly two platform columns, `claude` and `opencode`
(`model-aliases.ts:45-76`). `resolveModel` returns `entry?.platforms[platform] ?? model`
(`:103`) — so under any other harness id in `VALID_HARNESS_IDS` (codex, copilot, gemini, pi, …
referenced at `native-executor.ts:1016-1022`) `sonnet` passes through **verbatim** and the CLI gets
a bogus model string. For an LLM endpoint, `resolveLlmModel` looks up
`tier[engineName] ?? tier["llm"] ?? tier["*"]` (`:100,108`) — none of which the builtin table has —
so it also passes through verbatim unless the user has hand-written a global `modelAliases` entry.

Since §3.4's whole portability argument is "a persona node saying `model: opus` works under any
engine", this is load-bearing.

**Recommendation.** Soften §3.5 to "resolves under claude and opencode; other platforms and LLM
endpoints require a `modelAliases` entry", and add a §6 row for extending the builtin table (or
emitting an alias-unresolved notice, consistent with the capability-notice stance).

### F-16 — Gate judges sit outside the cascade.

`freezeGateJudge` (`freeze.ts:263-278`) resolves entirely from `config.workflow.judgeEngine` with
`layers = []`. §3.4 never mentions gate judges. Does a step's `model:`/`agent:` apply to its gate?
(Almost certainly it should not — but the "legal at every layer, nearest wins" sentence implies it
does.)

**Recommendation.** One sentence in §3.4: gate judges resolve from `workflow.judgeEngine` only and
are outside the cascade.

### F-17 — `on_error` is called steps-only but already lives at document defaults.

§3.4: *"**graph keys** (`map`, `route`, `inputs`, `output`, `gate`, `retry`, `on_error`,
`isolation`) are steps-only."* `ProgramDefaults.onError` exists (`program/schema.ts:210`), is
schema-declared (`akm-workflow.json:199-201`), and is consumed
(`compile.ts:231`: `unit?.onError ?? defaults?.onError ?? "fail"`). Removing it is an
unannounced breaking change; keeping it makes the tier rule false as stated.

**Recommendation.** Either exempt `on_error` (and note it), or list it in §8's conversion table as
removed.

### F-18 — Adapter recognition for `.md` tasks is underspecified and partly contradicts `okf-support.md`.

§6's last row: *"markdown task recognized by `type: task` / `tasks/` residence."*

- `okf-support.md:60-62` states the opposite rule for the `akm` adapter: *"The `akm` adapter still
  derives native identity and capability from its directory, extension, filename, and content
  rules; **frontmatter `type` does not override those rules**."* Residence-based recognition is
  consistent; `type: task`-based recognition is not.
- The standalone `akm-task` adapter currently keys entirely on `.yml`
  (`akm-task-adapter.ts:42,53,106,144`) and `directoryList()` returns `["."]` — tasks live *anywhere*
  under the component root, so "tasks/ residence" does not describe it either.
- Ordering: `akmWorkflowAdapter` precedes `akmTaskAdapter` (`adapters/index.ts:81-83`), and its
  `looksLikeRoot` fires on a top-level `.md` with `type: workflow` (`akm-workflow-adapter.ts:141-155`).
  A markdown-task bundle root needs a symmetric probe (`type: task`), and the two probes must be
  proven disjoint — the goldens under `tests/fixtures/format-family-goldens/akm-task/` all assume
  `.yml`.

**Recommendation.** Add a §6 sub-item covering the `akm-task` adapter rewrite: `.md` extension,
`type: task` recognition *within* an akm-task bundle, an explicit `type: task` `looksLikeRoot`
probe, and a note that the four `akm-task` goldens re-baseline.

### F-19 — `status: draft` is a second, orthogonal installation gate.

§4: *"`status: draft` as author-now, arm-later (draft tasks are never installed by `sync`)."* There
is already `enabled:` (`tasks.ts:445+`, `runner.ts:169`) and a `disabled` run status
(`runner.ts:179`). Now there are two gates with different vocabularies, and the spec does not say
what `status: deprecated` does, what `enabled: true, status: draft` means, or how
`akm task list`/`doctor` report the distinction. Since OKF `status` is a lifecycle field that
tooling can rewrite, this couples scheduler state to a documentation field.

**Recommendation.** Pick one. Recommend: `status:` is documentation only and never gates
installation; `enabled:` remains the sole gate.

### F-20 — `task_history.target_kind` is a persisted enum the new vocabulary outgrows.

`appendHistory` writes `target_kind` ∈ {workflow, command, prompt} and `target_ref` only for
workflow (`runner.ts:823-824`); `taskHistoryRowToResult` decodes exactly those three
(`:875-888`), with a `metadataVersion` 1/2 split already in place. The new target space is
{prose, `uses:commands/*`, `uses:scripts/*`, `uses:workflows/*`, `run:`}. §8's "the `akm task run
<id>` ABI does not change" is about argv, but history rows are also an ABI (`akm task history` is
a documented surface).

**Recommendation.** Add a `metadataVersion: 3` row to §8 with the old→new `target_kind` mapping and
a statement that historical rows continue to decode.

### F-21 — Embedded-template enumeration fails silently on format change.

`listEmbeddedTasks()` swallows parse errors (`embedded.ts:91-96`: `catch { continue }`) and skips
non-command targets (`:97`). Converting the ten templates to markdown without updating this
function yields an **empty template list in `akm setup`** with no error — the wizard just offers
nothing. §8 says the templates "convert in this change"; it should also say `embedded.ts` converts
with them and that the silent `continue` becomes a loud failure.

### F-22 — Composition loses provenance and can exceed the instruction cap.

`IrUnitNode.source` is a single `SourceRef` (`ir/schema.ts:444-445`, `compile.ts:186`). A step
composed from `uses: tasks/<id>` has two source files (the task and the workflow). One of them will
be dropped from every error message and lint pointer. Separately, `instructions` is capped at
256 KiB (`ir/schema.ts:444`); task body + appended step section makes overflow reachable in a way
it was not before, and the error would name only one file.

**Recommendation.** Either make `source` an array, or state explicitly that a composed unit's
`source` points at the *step* and the referenced task's path is carried in a new sibling field.

### F-23 — Format whiplash and an inverted collision guard.

`tasks.ts:154-163` exists because *"Pre-0.8.0 tasks were markdown; the 0.8.0 cutover moved them to
pure YAML … A leftover `<id>.md` still names the same task, so creating `<id>.yml` beside it must
collide loudly."* §4 calls the new format "the 0.7.x markdown task restored". Users who ran the
documented `v0.7-to-v0.8` migration will run it back. That is defensible for a pre-1.0 project but
should be *stated* in §8 rather than framed as pure forward progress — and the guard must be
inverted (a leftover `<id>.yml` must now collide with `<id>.md`), which is exactly the failure mode
§8's "never silently invisible" bullet targets.

### F-24 — `prompt: agents/x` is worse than §3.5 says.

§3.5: *"the `.yml` task path **drops** an agent asset's model preference — `prompt: agents/x`
resolves the asset to prompt text only."* `resolvePromptText` does
`fs.readFileSync(assetPath, "utf8")` with **no frontmatter parse** (`runner.ts:592-593`). So the
agent's YAML frontmatter — `model:`, `tools:`, `description:` — is sent to the model **as part of
the prompt text**. Same for `prompt: commands/x`: the raw template with unfilled `$ARGUMENTS`
placeholders goes out verbatim.

This is a real bug in the current implementation and strengthens the case for the change; the spec
should cite it accurately as a §6 "Today" entry.

---

## 5. Cross-cutting: what this actually costs

The spec's §6 "shared plumbing" table reads as a code-*reduction* story. Counting the work the
findings above surface, the honest ledger is:

**Genuinely deleted:** `resolvePromptSource` sniffing, `rejectTargetFields`, `TASK_KEYS`,
`akm-task.json`'s standalone target `oneOf`, the ~12-flag `task add` surface, the `unit:` bag
nesting. Real, and worth having.

**Genuinely shared for the first time:** target resolution by ref subdir, command-template filling,
env assembly + redaction, the value-field cascade. Also real.

**Net-new, not in the table:** an IR v3 schema extension + version bump (F-02); a shell frozen node
kind and runner (F-03); an input-hash version bump and preimage extension (F-04); a new config
`defaults.*` schema surface (F-01); persona system-prompt/tool-policy plumbing with a provenance
ceiling (F-08); a placeholder-fill grammar (F-10); an env normalizer with a hash-safety rule
(F-11); a vendored legacy parser + a rename-safe migration phase (F-13); a rewritten `akm-task`
adapter + four goldens (F-18); `embedded.ts` (F-21).

**Test/golden churn:** 14 test files reference `unit:` (`tests/integration/workflows/*`,
`tests/workflows/*`, including `conformance/`, `driver-parity`, and `fuzz/replay-fuzz`);
`tests/fixtures/format-family-goldens/akm-task/{recognition,placement,lint,renderer}.json` all
assume `.yml`; every frozen-plan golden re-baselines on the IR bump; `docs/reference/workflows.md`
and `stash-conventions-code-spec.md` both document `unit:`.

None of that is a reason not to do it. It is a reason the spec should not say §10.

---

## 6. Answer to §9's remaining question

> Confirm the cascade model and the dissolution of `llm:`.

**Dissolving `llm:` — yes.** The grouping earns nothing: its workflow-side guard is dead code
(F-07), its task-side guard is a schema `oneOf` that a cascade cannot express anyway, and flat
`temperature`/`max_tokens`/`extra_params` with engine-capability notices is strictly better than
today's silent drop. Do fix `freeze.ts:67-73` first so the before/after comparison is honest.

**The cascade model — yes in shape, not as specified.** Nearest-wins layering is the right mental
model and matches what users know. But the spec currently sells it as *exposing an existing
mechanism* when three of its five layers do not exist (F-01), and buys that framing by asserting a
no-op change budget (F-02). Sign off on the *model*; require §3.4 and §10 to be rewritten with the
real layer inventory and the real IR cost before implementation starts. Specifically, before
sign-off I would want: the config-schema addition enumerated, `params:` de-overloaded (F-09), and
the merge semantics for mapping-valued fields (`params`, `extra_params`) stated — the spec says
"merged per-field, nearest wins" but `freeze.ts:211-216` deep-merges `llm` today, and those are
different answers.
