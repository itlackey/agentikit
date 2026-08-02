# Critical Review — `task-workflow-format-unification.md` v7

Reviewer #1 of 3. Branch `claude/akm-markdown-tasks-history-75l6du`, baselined on
`claude/release-0-9-0-polish-d6sycl`. All citations are `path:line` against the
working tree.

**Verdict.** The *direction* is right and several of the spec's baseline claims
about the code check out exactly. But the document systematically understates
its own blast radius: §10's "no changes to IR, freeze, journal, replay" is
false at least four times over, and three load-bearing factual claims about the
current code (the "duplicate `output`", the command asset "already reads
`agent:`", "the assembled prompt is a frozen string produced at one seam") are
wrong in ways that invalidate the design decisions they justify. One change —
executing script assets' `run:`/`setup:` frontmatter — silently reverses a
documented security boundary.

---

## Findings table

| # | Sev | Title |
|---|---|---|
| C1 | Critical | `uses: scripts/*` executing `run:`/`setup:` reverses a documented "advisory, not executed" security boundary |
| C2 | Critical | The "duplicate `output`" is not a duplicate — `unit.output` and `step.output` are two different schemas; the flatten silently deletes per-unit/per-item structured output |
| C3 | Critical | §10's "no IR/freeze/journal/replay change" is false: shell units, `env:` mappings, optional prose and composition each force IR + input-hash changes |
| C4 | Critical | `run:`/shell work has no representation in the dispatch seam — `IrInvocation.engine` and `UnitDispatchRequest.engine` are required, and freeze hard-fails with no engine configured |
| M1 | Major | "Command assets already read an `agent:` frontmatter field today" is false — it is a *recognition heuristic*, nothing consumes it |
| M2 | Major | Command-template filling by named `params:` conflicts with the actual command placeholder contract (`$ARGUMENTS`/`$1`), and with §10's non-goal |
| M3 | Major | The `config defaults:` cascade layer largely does not exist — `defaults.model` is unschema'd/unread and `defaults.llm` is *explicitly retired in 0.9* |
| M4 | Major | §3.5's alias-portability claim is false for LLM and `opencode-sdk` engines — `model: sonnet` passes through verbatim |
| M5 | Major | The prose-append rule ("append to the assembled prompt at one seam") does not match how prompts are assembled; appending there puts call-site context after the item/inputs/gate/schema blocks |
| M6 | Major | `env:` literal values break the "names only, never values" plan/hash invariant and put literals into `brief` output |
| M7 | Major | `params` as a cascade-merged value field collides with workflow frontmatter `params:` (schema declarations) and with the "params are non-secret and un-redactable" contract |
| M8 | Major | Freeze must become IO-dependent (and probably async) to resolve `uses: tasks/<id>`, breaking its stated purity contract; lint never freezes, so composition refs go unvalidated until run start |
| M9 | Major | Migration losslessness is overclaimed: `name:`, `llm.supportsJsonSchema`/`contextLength`/`enableThinking`, and `prompt: agents/x` semantics are all lost or changed |
| M10 | Major | "Post-migration `sync`/`doctor` name any stray `.yml` by path" is not structural — the placement table and sync both key on extension, so strays become invisible or double-installed |
| m1 | Minor | Value fields legal "at every layer" are not legal on the engine node (`env`/`cwd`/`shell`/`params` silently pass through `.passthrough()` and are ignored) |
| m2 | Minor | Value fields on a `uses: workflows/*` task are structurally inert — the workflow run re-freezes from its own layers |
| m3 | Minor | Frontmatter `agent:`/`model:` on a task collide with indexer type-classification heuristics |
| m4 | Minor | `status: draft` as an execution gate overloads the OKF lifecycle field and duplicates `enabled:` |
| m5 | Minor | Setup wizard's YAML round-trip and `EmbeddedTask.command` will destroy markdown task bodies |
| m6 | Minor | Body-section requirement in the current parser contradicts optional sections for `uses:`/`run:` steps |
| m7 | Minor | `run:` shell semantics silently drop the argv-based nested-akm optimization and change the injection surface |
| m8 | Minor | Existing wart the plan inherits: `prompt: agents/x` sends the agent asset's raw YAML frontmatter to the model |
| m9 | Minor | okf-support.md explicitly names "YAML tasks" as a non-Markdown native asset and gates the promotion allowlist on `workflow` alone |
| m10 | Minor | Test/golden churn is larger than "schema and golden churn" implies |

---

## Critical

### C1 — `uses: scripts/*` executing `run:`/`setup:` reverses a documented security boundary

**Spec claim.** §3.2: "`uses: scripts/<name>` — Execute the script asset per its
own `run`/`setup`/`cwd` metadata — no AI." §6: "one executor: inline shell +
script assets per `run`/`setup`/`cwd`, both surfaces."

**Evidence.** Those three fields are today explicitly, deliberately non-executable:

```
src/indexer/passes/metadata.ts:140
  // SECURITY NOTE: run, setup, and cwd are advisory metadata fields for AI agent consumers.
  // They are NOT executed by akm directly. Consumers should validate and sanitize before execution.
```

This is not incidental. It sits alongside the sync attribution boundary whose
comment states the invariant plainly — "registering a bundle never activates
code" (`src/commands/tasks/tasks.ts:397-401`). Under the proposal, any installed
third-party bundle's `scripts/*.md` frontmatter `setup:` / `run:` becomes
executable the moment a local workflow or task names it. `setup:` in particular
implies "run an install command," which is the highest-value supply-chain target
in the whole asset model.

**Why it matters.** The spec's §10 non-goals say "No change to how `command`,
`script`, ... assets are authored or stored — this proposal executes and embodies
them." That sentence *admits* the change and then classifies it as a non-goal.
Executing them is the entire security delta.

**Recommendation.** Either (a) drop `uses: scripts/*` from v1 and keep `run:`
inline-only, or (b) add an explicit section covering: trust scope (own bundle
only? a per-bundle `executable: true` config opt-in?), whether `setup:` runs at
all, whether `cwd:` may escape the bundle root, and how `akm bundle add` warns.
Update `metadata.ts:140`'s SECURITY NOTE in the same change so the comment and
the behavior cannot disagree.

---

### C2 — The "duplicate `output`" is not a duplicate; the flatten deletes a real feature

**Spec claim.** §3.6: "`output:` is declared **both** on the step and inside the
bag — a live wart in `schemas/akm-workflow.json`" … "The duplicate `output`
declaration disappears with the bag."

**Evidence.** They are two distinct schemas with two distinct consumers:

- `ProgramUnit.output` (`src/workflows/program/schema.ts:124-125`, "JSON Schema
  the unit's structured result must validate against") → compiled to
  `WorkflowUnitDraft.schema` (`src/workflows/ir/compile.ts:229`) → frozen as
  `IrUnitNode.schema` → becomes `UnitDispatchRequest.schema`
  (`src/workflows/exec/native-executor.ts:663`), the LLM `responseSchema`
  (`native-executor.ts:1092`), the structured-output retry trigger
  (`native-executor.ts:928-929`), the `--result-file` contract in the driver
  brief (`src/workflows/exec/brief.ts:574,656-657`), and per-unit result
  validation (`src/workflows/exec/report.ts:1597-1618`).
- `ProgramStep.output` (`program/schema.ts:185-186`, "Step artifact schema") →
  `WorkflowStepDraft.outputSchema` (`compile.ts:204`) → `IrStepPlan.outputSchema`
  → validates the *promoted step artifact* (`src/workflows/exec/step-work.ts:555-561`).

For a `map:` step the distinction is load-bearing: `map.unit.output` types each
per-item result, `step.output` types the reduced array. `workflow-format-unification.md`
itself documents exactly that: "`output` describes the REDUCER RESULT: the
default `collect` reducer folds per-item unit results into an array"
(workflow-format-unification.md:127-129) — on a step whose `map.unit` also
carries settings.

**Consequence.** Collapsing both onto one step-level `output:` either (a) drops
per-unit structured output entirely — losing the LLM response-schema path, the
structured-retry path, and the driver `--result-file` contract — or (b) silently
changes the meaning of `output:` on map steps from "reducer result" to "per-item
result", breaking the shipped example and the reducer contract.

**Recommendation.** Fix the spec: there is no duplicate. If the bag must go, the
flatten needs two step-level keys with unambiguous names (e.g. `output:` = step
artifact, `unit_output:` / `item_output:` = per-dispatch schema), and §3.6 must
say which one a map step's `output:` means. Also drop the "live wart" framing
from §6's table row, which currently justifies the deletion on a false premise.

---

### C3 — §10's "no IR / freeze / journal / replay change" is false four times over

**Spec claim.** §10: "no changes to `map`/`route`/`gate` semantics, IR, freeze,
journal, leases, or replay (the §3.6 flatten and §3.4 cascade are
authoring-surface changes…)".

**Evidence — each of these is an IR-level change:**

1. **Optional prose.** `decodeWorkflowPlanV3` rejects an empty
   `instructions` (`src/workflows/ir/schema.ts:437-439`: `!node.instructions`
   → `fail`). A `run: bun test` step with no `## run-tests` section produces an
   empty-instructions unit. The workflow *parser* rejects it even earlier
   (`src/workflows/parser.ts:282-296`, and workflow-format-unification.md:220-224
   body rule 2).
2. **`env:` shape.** `IrUnitNode.env` is `string[]`, validated by
   `validateStringArray` (`ir/schema.ts:447`). §3.7's list-of-(ref-string |
   mapping) is not a string array. The spec calls this "extends the existing
   schema additively" — additive for the *authoring* JSON Schema, breaking for
   the IR decoder.
3. **Input hash.** `env` is part of the unit input-hash preimage
   (`src/workflows/exec/step-work.ts:388`, `hashVersion: 4`). Changing `env`'s
   shape changes the preimage → `hashVersion` must bump to 5 → every in-flight
   run's journaled rows stop matching → replay divergence
   (`native-executor.ts` `classifyUnitReuse`, "diverge" arm). Worse: if `run:` /
   `cwd:` / `shell:` are added to `IrUnitNode` but *not* to the preimage
   (the spec never mentions the hash), editing a step's shell command reuses the
   completed row and never re-dispatches — a silent correctness bug.
4. **Composition.** §3.3 "Resolution happens at freeze" means the frozen unit's
   `instructions` now derive from a *different asset*. Nothing in the plan or
   hash records which task version was composed, so `akm workflow report` cannot
   attribute a unit's prose to its source task, and the plan-hash integrity check
   (`src/workflows/runtime/runs.ts:236-241`, `requireExecutableWorkflowPlan`)
   gives no signal that an upstream task changed between two runs of the same
   workflow.

**Recommendation.** Rewrite §10 honestly: IR v3 gains fields, `hashVersion`
bumps, and pre-existing frozen plans become undecodable. Given 0.9.0 is
unreleased this is cheap — but it must be stated, and the hash preimage must
explicitly enumerate the new dispatch-significant fields (`run`, `shell`, `cwd`,
`env` in its new shape, and the composed task's identity).

---

### C4 — Shell work has no representation in the dispatch seam

**Spec claim.** §3.6: "A shell unit inside a workflow journals like any unit
(`workflow_run_units`): no tokens, but status, timing, attempts, and
`failure_reason` behave normally." §2 leans on `unit-dispatch.ts` being "the one
dispatch seam."

**Evidence.** That seam is agent-shaped, top to bottom:

- `UnitDispatchRequest` requires `prompt: string` and `engine: FrozenEngineSnapshot`
  (`src/workflows/exec/unit-dispatch.ts:15,19` — neither optional).
- `IrUnitNode.invocation` is required and `validateInvocation` requires a
  non-empty `engine` string (`ir/schema.ts:85, 481-497`).
- Freeze throws `ConfigError` "No workflow engine is selected" for *any* unit
  when no engine resolves (`src/workflows/ir/freeze.ts:52-62`). **A workflow
  consisting entirely of `run:` steps would refuse to freeze on a machine with
  no agent CLI configured** — which is precisely the machine most likely to want
  a shell-only workflow.
- `runUnit` bails with `dispatch_error` when `!workUnit.engine`
  (`native-executor.ts:636-643`).
- The `brief`/`report` driver protocol surfaces a prompt for an external driver
  to execute (`brief.ts:571-577`). What does a shell unit's brief contain? The
  spec never says. If it emits the shell text, an external driver is now being
  asked to execute arbitrary shell.

**Recommendation.** §6's "honest boundary" paragraph acknowledges *two agent*
dispatch paths; it must acknowledge a *third, non-agent* one. Concretely the
spec needs: a discriminated `IrUnitNode` (`kind: "unit" | "shell"`), an optional
`invocation`, a `ShellDispatchRequest` variant on the seam, an explicit
"shell-only workflows freeze without an engine" rule, defined `failure_reason`
mapping for exit codes/timeouts, and a defined `brief`/`report` behavior for
shell units (most likely: refuse — shell units are engine-executed only).

---

## Major

### M1 — "Command assets already read an `agent:` frontmatter field today" is false

**Spec claim.** §3.4: "(Command assets already read an `agent:` frontmatter field
today — a referenced asset naming its preferred persona is existing behavior,
corroborating the asset-as-layer model.)"

**Evidence.** `agent` in a markdown file's frontmatter is a *type-classification
signal only*:

```
src/indexer/walk/matchers.ts:234-236
  if ("agent" in fm) { return { type: "command", specificity: 18 }; }
src/core/adapter/adapters/tool-dir-shared.ts:201
  // command-shaped body/frontmatter signals … an `agent` frontmatter key.
```

Nothing reads the *value*. There is no code path that resolves a command asset's
`agent:` to a persona at dispatch. A repo-wide search for a consumer turns up
only these two classification sites.

**Why it matters.** This is the sole cited empirical corroboration for the
asset-as-cascade-layer model in the round-6/7 redesign — the reversal
Decision 14 asks for explicit sign-off on. Sign-off is being requested partly on
a false premise.

**Recommendation.** Strike the parenthetical, or restate it accurately ("`agent:`
exists on command assets today as a recognition signal; this design gives it
semantics for the first time"). Note that giving it semantics also means an
untrusted bundle's command asset can now select a persona — worth a sentence.

---

### M2 — Template filling by named `params:` conflicts with the real command placeholder contract

**Spec claim.** §3.2: "`uses: commands/<name>` — Fill the command asset's
template (its type contract — 'a prompt template with placeholders'), dispatch
an agent with the result | `params:` fill the placeholders." "a placeholder with
no matching param is an error at fill time."

**Evidence.** The command asset's placeholder vocabulary is **positional**, not
named:

```
src/indexer/walk/matchers.ts:126
  const COMMAND_PLACEHOLDER_RE = /\$ARGUMENTS|\$[123]\b/;
```

There is no named-placeholder syntax in command assets. `params: { scope: team }`
(the spec's own §4 example) has nothing to bind to. Introducing named
placeholders is a change to how command assets are authored — which §10
explicitly declares a non-goal.

The one named-substitution mechanism that exists is the workflow prompt
preamble's `{{PARAMS_JSON}}` (`src/workflows/exec/step-work.ts:469`), which is a
whole-blob injection, not per-placeholder filling — and workflow-format-unification
§2.3/§1.3 spent a whole section *removing* moustache templating from prose
because "the fake templating trap" (workflow-format-unification.md:57-63) was a
standing cost. §3.2 re-introduces a templating language into asset bodies.

**Recommendation.** Pick one and specify it: (a) positional — `params:` becomes a
list and `$1`/`$ARGUMENTS` fill from it; (b) named — declare the syntax, declare
it a change to the command asset contract, and remove the §10 non-goal; or (c)
no filling — `params:` are attached as context the way workflow params are, which
is consistent with the "no interpolation" decision the sibling spec already made.
Also state whether the "no matching param is an error" rule is symmetric (an
unused param — error or notice?).

---

### M3 — The leftmost cascade layer (`config defaults:`) largely does not exist

**Spec claim.** §3.4's cascade begins at "config defaults: (global)", and the
worked example is
`{ "defaults": { "engine": "claude", "model": "sonnet" } }`.

**Evidence.**

- `DefaultsSchema` declares only `engine`, `llmEngine`, `improveStrategy`
  (`src/core/config/config-schema.ts:102-108`). It is `.passthrough()`, so
  `defaults.model` would *validate* — and be read by nobody.
- `exactModel()` never consults `config.defaults` — it walks `layers`, then falls
  back to `engine.model` (`src/workflows/ir/freeze.ts:169-171`). Same for
  `effectiveTimeout` (`freeze.ts:193-209`).
- `defaults.llm` and `defaults.agent` are **explicitly hard-rejected**:
  `` `defaults.${key} is retired in 0.9` `` (`config-schema.ts:234-241`). The
  spec proposes putting `temperature`, `max_tokens`, `extra_params` at exactly
  that scope.

So the "one vocabulary appears at every scope" claim requires: new
`DefaultsSchema` fields, new readers in `exactModel`/`effectiveTimeout`/
`mergedLlmOverrides`, `akm config set defaults.*` support, and an explicit
un-retirement of a key the 0.9 cutover deliberately killed. None of this is
scoped in §6's cost table.

Second-order problem: a global `defaults.model` applies to **all** engines, and
model strings are per-platform. A user with a claude engine and an LLM endpoint
gets one `model` value cascading into both. §3.5 says aliases save this — see M4,
they don't.

**Recommendation.** Enumerate the new config-schema surface in §6. Explain the
interaction with the `defaults.llm` retirement (why is it coming back, in flat
form, one release after being killed?). Decide whether `defaults.model` is
per-engine-kind or genuinely global, and if global, say what happens when it is
an alias with no column for the selected platform.

---

### M4 — Alias portability across engine kinds is claimed but not implemented

**Spec claim.** §3.5: "Aliases are **per-platform**, which is what makes a shared
asset portable: `model: sonnet` resolves to the right string under a claude
engine, an opencode engine, or an LLM endpoint." And: "Aliases are therefore
legal at every layer — a persona node saying `model: opus` works under any
engine."

**Evidence.** `BUILTIN_ALIASES` has exactly two platform columns — `claude` and
`opencode` (`src/integrations/agent/model-aliases.ts:45-76`). `resolveModel`
returns `entry?.platforms[platform] ?? model` — **verbatim pass-through** when
the column is missing (`model-aliases.ts:103`).

- **LLM endpoints.** `resolveLlmModel(selected, name, config.modelAliases)`
  (`freeze.ts:189`) passes the *engine name* as the platform column and adds an
  `"llm"` fallback column (`model-aliases.ts:107-109`). Neither the engine name
  nor `"llm"` exists in `BUILTIN_ALIASES`. So `model: sonnet` under an LLM engine
  resolves to the literal string `"sonnet"` — which almost every OpenAI-compatible
  endpoint will reject.
- **`opencode-sdk`.** `freeze.ts:190` passes `engine.platform`, which for the SDK
  engine is `"opencode-sdk"` — also not a `BUILTIN_ALIASES` column, also verbatim.

The claim is only true if the user has hand-authored a `modelAliases` table, which
is not what "portable by construction" means.

**Recommendation.** Either add `"*"`-style built-in columns / an `opencode-sdk`
alias to `BUILTIN_ALIASES`, or downgrade §3.5's claim to "aliases are portable
across configured platform columns; an unmatched alias passes through verbatim
and will typically fail at the endpoint." Given §3.4 makes a global
`defaults.model` the recommended shape, an unresolvable alias silently becoming a
literal model string is a bad default — consider making it a notice at freeze.

---

### M5 — The prose-append rule does not match how prompts are assembled

**Spec claim.** §3.3: "Investigated (round 6): the assembled prompt is a frozen
string produced at one seam, so appending is a deterministic concat — easy…
the step's section text is appended to the assembled prompt after a blank line,
byte-exact."

**Evidence.** There is no frozen assembled prompt. What is frozen is
`IrUnitNode.instructions` (byte-exact body prose). The *prompt* is built at
dispatch time, per unit, by `buildUnitPrompt`:

```
src/workflows/exec/step-work.ts:500
  return `${preamble}\n${instructions}${itemBlock}${inputsBlock}${gateBlock}${schemaDirective}`;
```

Appending the step section to "the assembled prompt" places the call-site context
*after* the fan-out item block (`step-work.ts:473-475`), the declared-inputs
block, the gate feedback block, and the schema directive. "In this workflow,
focus on X" lands after "here is your item" and after "your result must match
this JSON Schema" — the worst position in the prompt.

Appending to `instructions` instead is the right answer, but that is a
**freeze-time / compose-time** concat, not a dispatch-seam one, and it changes
the hash preimage (`step-work.ts:381` hashes `template.instructions`) — see C3.

**Recommendation.** Restate the rule as "the referenced task's body and the
step's section are concatenated at freeze into the unit's `instructions`". Also
specify: does the step's `### gate` sub-heading participate? (The parser already
splits the gate rubric out of the section — `src/workflows/parser.ts:379-381` —
so it does not, but the spec's "section text" wording implies it might.) And
specify ordering for a `uses: commands/*` target: task body, then filled command
template, then step section? The spec says "appended to the assembled prompt"
for both cases without disambiguating.

---

### M6 — `env:` literals break the "names only, never values" plan invariant

**Spec claim.** §3.7 allows literal mappings inline (`LOG_LEVEL: debug`) and
`DATABASE_URL: secrets/db-url`, and says this "extends the existing schema
additively."

**Evidence.** The current invariant is explicit and deliberate:

```
src/workflows/exec/step-work.ts:354-358
  // `env` carries NAMES ONLY, never resolved values: hashing a resolved secret
  // would leak it into a durable hash oracle and would spuriously re-dispatch
  // on every secret rotation.
```

and, from the driver-protocol contract:

```
src/workflows/exec/param-secrets.ts:17-19
  secrets belong in **env bindings** (`env:` refs), which `brief` surfaces by
  NAME ONLY and never resolves.
```

Under §3.7, literal env values are frozen into the plan (`plan_json` in the run
row), hashed into the unit input hash, and surfaced verbatim by `brief`
(`brief.ts:577` passes `unit.env` straight through). A user who writes
`env: { API_KEY: sk-… }` — a natural GHA-muscle-memory mistake the spec
*encourages* with the bare-mapping shorthand — has just written a credential into
a durable journal and a driver-visible brief.

**Recommendation.** Keep the shape but keep the invariant: freeze/hash/brief must
carry env **keys and ref values only**; literal values must either be (a) hashed
as `key → sha256(value)` or `key → <literal>` sentinel, or (b) rejected for
workflow units and permitted only on tasks. Add a lint that flags secret-shaped
literal env values — `detectSecretShapedParams` (`param-secrets.ts:87`) is a
ready-made heuristic. State explicitly which of `env/` group values,
`secrets/` values, and inline literals join `sensitiveValues`.

---

### M7 — `params` as a cascade value field collides with two existing meanings

**Spec claim.** §3.4 lists `params` in the flat value vocabulary, "legal at every
layer, merged per-field with the nearest layer winning."

**Three collisions:**

1. **Within one workflow file.** Top-level frontmatter `params:` already means
   *param schema declarations* (`schemas/akm-workflow.json:22-32`,
   `program/schema.ts:99-100`). §3.4 makes `params` legal at the "document
   defaults" layer — i.e. `defaults: { params: … }` — meaning *values*. Two
   meanings of one word in one file, one nesting level apart.
2. **Across targets.** On a `uses: workflows/*` task, `params:` are declared
   run parameters coerced through frozen schemas
   (`src/workflows/ir/params.ts:34-72`). On `uses: commands/*`, they are template
   placeholder fills (M2). On `uses: tasks/*`, they are "the task's own inputs".
   These have different validation, different coercion, and different failure
   modes; per-field cascade merging across them is undefined.
3. **Secrets.** Params are contractually **non-secret and un-redactable** because
   they are in the prompt and the input hash (`param-secrets.ts:9-19`). Making
   `params` inheritable from a global config layer means a global value silently
   flows into every prompt of every workflow. That is a new, quiet exfiltration
   path for anything a user puts in `defaults.params`.

**Recommendation.** Remove `params` from the cascade value vocabulary. It is a
call-site input, not a setting. If a default-params feature is wanted, scope it
to one layer with an unambiguous key name and re-run the secret analysis.

---

### M8 — Freeze must become IO-dependent; lint never freezes

**Spec claim.** §3.3: "Resolution happens at freeze. The referenced task compiles
into the frozen plan… the existing snapshot rule, unchanged." §10: "§3.3
composition resolves at the existing freeze step."

**Evidence.** Freeze is deliberately pure over `(asset, config)`:

```
src/workflows/ir/freeze.ts:39-43
 * The only source-to-runtime boundary. Source compilation remains pure; engine
 * selection and every dispatch-significant setting are resolved here once.
export function compileResolveFreezeWorkflow(asset: WorkflowAsset, config: AkmConfig): FrozenWorkflow
```

Resolving `uses: tasks/<id>` requires `resolveAssetPath` + a file read, which is
**async** (`src/sources/resolve.ts`, used async everywhere:
`src/tasks/runner.ts:159`, `src/tasks/validator.ts:54`). Making freeze async is
mechanically fine at the one call site (`src/workflows/runtime/runs.ts:241` is in
an async function) but it destroys the purity property the file's own doc
comment advertises, and it means freeze can now fail with `ASSET_NOT_FOUND` /
bundle-resolution errors it has never produced before.

Second problem: **workflow lint does not freeze.** `compileResolveFreezeWorkflow`
has exactly one caller (grep: `runs.ts:241`). So `uses: tasks/does-not-exist`,
`uses: tasks/x` where `x` targets a workflow (the §3.3 "no nesting through the
back door" error), and a composed task with an unresolvable engine all become
**run-start failures, not lint failures** — the opposite of what §6's lint row
promises.

Third: cross-bundle. Which bundle does `uses: tasks/lint-check` resolve against?
Tasks already carry bundle attribution through the scheduler (`--bundle` token,
`src/tasks/scheduler-invocation.ts:59-78`); a workflow composing a task has no
such context. Undefined in the spec.

**Recommendation.** State that freeze becomes async and IO-bearing; add a
compile-time composition-resolution pass that lint can also run (a resolver
callback injected into `compileWorkflowPlan`, keeping `compile` pure and moving
the IO to the caller is the cleaner shape). Define bundle scoping for `uses:`.

---

### M9 — Migration losslessness is overclaimed

**Spec claim.** §8: "No key survives with a changed meaning — the `.yml`
vocabulary maps onto different spellings, so nothing is silently reinterpreted."

**Gaps, all against `src/tasks/parser.ts` + `src/tasks/schema.ts`:**

| Lost / changed | Evidence |
|---|---|
| `name:` — a real, parsed, displayed field | `parser.ts:89`, `schema.ts:88-89` ("Human-readable display name shown in `akm show` and search results"). Not in the §8 table; not in the envelope (`schemas/akm-asset-envelope.json` has no `name` definition); §4's envelope list omits it. |
| `llm.supportsJsonSchema`, `llm.contextLength`, `llm.enableThinking` | Parsed and validated today (`parser.ts:331-357`), frozen into `IrInvocation.llm` for workflows. §3.4's value vocabulary is a *closed nine-field list* that omits all three; §8's row is `llm.maxTokens / llm.temperature / llm.extraParams / …` — the ellipsis is doing load-bearing work for three fields with no destination. |
| `prompt: agents/x` → `agent: agents/x` | This *is* a changed meaning. Today it reads the agent asset file and sends its bytes as the prompt (`runner.ts:581-593`). After: the agent becomes a persona node and the body is "seeded". §3.5 correctly frames this as a fix, but §8's blanket "nothing is silently reinterpreted" is then false for the one row that matters most. |
| `command:` as an **array** | `readCommand` accepts `string[]` (`parser.ts:286-299`), and `akm-task.json:19-24` declares the `oneOf`. §8 maps only `command: <shell>` → `run: <shell>`. An array command has no lossless single-line shell spelling (quoting/escaping is now the migrator's problem, per-platform). |
| `timeoutMs: null` | `readTimeout` treats `null` as "explicitly no timeout" (`parser.ts:318-323`). Does `timeout: none` (the workflow spelling, `schemas/akm-workflow.json:59-70`) survive the conversion? Unstated. |

**Recommendation.** Complete the §8 table (all keys, including `name` and the
three dropped `llm` fields), decide where `name` goes (`description`? a new
envelope key? dropped with a migration warning?), and either extend the §3.4
vocabulary to the full `llm` set or state explicitly that those three fields are
being dropped and why.

---

### M10 — "Strays named by path" is not structural

**Spec claim.** §8: "The 0.7→0.8 lesson — leftover files must never be **silently
invisible** — is honored structurally: 0.9.0 commands already refuse an
un-migrated installation rather than migrating as a side effect, and
post-migration `task sync` / `task doctor` name any stray `.yml` file by path
instead of skipping it."

**Evidence, both halves:**

- **"Already refuse."** The existing refusals are keyed on *config shape*
  (`config-schema.ts:170,207`; `config-walker.ts:446-447`) and *DB schema
  version* (`src/storage/engines/sqlite-migrations.ts:242`). Neither observes a
  leftover `tasks/foo.yml`. After a successful cutover both gates are satisfied
  and the stray file trips nothing.
- **"Name any stray by path."** Nothing does this today, and the structure works
  against it. `sync` enumerates `*.yml` only
  (`src/commands/tasks/tasks.ts:414`, `.filter((f) => f.endsWith(".yml"))`,
  and `:433` `path.join(typeRoot, \`${id}.yml\`)`). Flip that to `.md` and the
  stray is invisible; leave it and the stray is **installed into the OS
  scheduler**. The placement table (`src/core/asset/asset-placement.ts:159-169`,
  `isRelevantFile: ext === ".yml"`) has the same property in the indexer.
- Note the existing precedent runs the *other* direction: `akm task add` already
  guards against a leftover pre-0.8 `<id>.md` shadowing a new `<id>.yml`
  (`tasks.ts:155-164`). That guard will need inverting, and it demonstrates the
  hazard is real and recurring.
- Worst case during the window: `<id>.yml` and `<id>.md` both exist. Both are
  recognized (by the `akm-task` and a new markdown-task adapter respectively),
  both produce conceptId `tasks/<id>`, and the index gains a duplicate identity.

**Recommendation.** Replace "structurally" with a concrete mechanism: a named
migration step that fails loudly on any surviving `tasks/*.yml`, plus an explicit
raw-directory scan in `sync` and `doctor` that reports `.yml` files by path with
a non-zero exit. Add a `tasks/<id>.{yml,md}` collision check to the adapter or
indexer.

---

## Minor

### m1 — "Legal at every layer" is not true of the engine node

§3.4: "Everything else is a flat set of value fields, legal at every layer."
Then the exception carves out only *strictness*. But four of the nine fields —
`env`, `cwd`, `shell`, `params` — have no declaration on either engine schema
(`src/core/config/schema/engines.ts:66-88, 90-131`). Both schemas are
`.passthrough()` and neither superRefine reject-list mentions them
(`engines.ts:84, 106-117`), so writing `env:` on an engine node **validates
silently and is ignored** — the exact "silently load-bearing" failure §3.4 says
it is avoiding. Recommend: add the four fields to both engine schemas, or add
them to both reject lists, and say which in the spec.

### m2 — Value fields on a `uses: workflows/*` task are structurally inert

Today the parser forbids them: `rejectTargetFields(data, ["params"])` for
workflow targets (`src/tasks/parser.ts:113`), mirrored in
`schemas/akm-task.json:31-34`. Under the cascade they become legal at the task
layer — but a workflow run re-freezes every unit from its *own* layers
(`freeze.ts:50`: `[documentDefaults, unit]`), and `RunWorkflowOptions`
(`src/workflows/exec/run-workflow.ts:98-148`) has no env/model/timeout channel.
So `model: haiku` on a workflow-target task does nothing. The spec never says
whether this is a notice, an error, or plumbed through. Same for §3.7's "For a
`uses: workflows/*` target, `env:` merges into the run's process environment" —
that needs a new `RunWorkflowOptions` field and a decision about whether it is
frozen (a resumed run would otherwise lose it).

### m3 — Frontmatter `agent:`/`model:` on a task collide with type classification

`matchers.ts:234` maps `agent` in frontmatter → `type: command` (specificity 18);
`matchers.ts:243-245` maps `model` in frontmatter → `type: agent` (specificity 8).
A markdown task with `agent: agents/reviewer` and `model: opus` in frontmatter
carries two mis-classification signals. Directory residence should win, but the
spec's §6 adapter row says recognition is "`type: task` / `tasks/` residence" —
both need to be *stronger* than these heuristics, and the interaction is
untested. Add a specificity note and a golden.

### m4 — `status: draft` as an execution gate overloads OKF lifecycle

§4: "`status: draft` as author-now, arm-later (draft tasks are never installed by
`sync`)." `status` is the OKF v0.2 lifecycle family (okf-support.md:88-93,
`schemas/akm-asset-envelope.json`), shared by every asset type. Making it a
scheduler gate for one type means the same value has execution semantics on
tasks and none elsewhere, and it duplicates `enabled:` — two off switches with
different names, different origins, and no stated precedence. Recommend: drop it,
or specify the precedence table (`status: draft` + `enabled: true` = ?).

### m5 — Setup wizard will destroy markdown task bodies

`prepareSetupTaskDefinitions` does a full YAML round-trip on the template —
`yamlParse(plan.task.yaml)` → mutate `schedule`/`enabled` → `yamlStringify`
(`src/setup/steps/tasks.ts:161-169`) — and the existing-file path uses a
line-based `setEnabledInYaml`. Both destroy a markdown body. `EmbeddedTask` also
hard-filters `.yml` and `target.kind === "command"` and exposes
`command: string` (`src/tasks/embedded.ts:81,96,42-45`). §8's "the ten embedded
templates convert in this change" covers the ten files but not these three code
seams. (There are ten templates: five in `src/assets/tasks/core/`, five in
`src/assets/tasks/improve/` — that count checks out.)

### m6 — The parser's must-have-a-section rule contradicts optional sections

`src/workflows/parser.ts:282-296` hard-errors on a missing or empty section for
any non-route step, per workflow-format-unification.md:220-224 body rule 2.
§3.3/§3.6 require that a `run:` or `uses:` step need no section. The sibling spec
must be amended in the same change, or the two specs are in direct conflict.

### m7 — `run:` shell semantics change more than the spec says

Today `command:` tasks spawn argv with no shell (`runManagedSubprocess(spawnCmd,
…)`, `src/tasks/runner.ts:277-289`), which is why `resolveNestedAkmCommand`
(`runner.ts:344-348`) can rewrite a bare `akm` token to the resolved
invocation — an argv-only optimization that a shell string breaks. Moving to
`sh -c` also (a) introduces shell metacharacter interpretation over strings that
today are safe, which matters once `env:` values can come from `secrets/`, and
(b) makes the `AKM_ITEM` JSON injection of §3.6 a quoting hazard inside the shell
text. Also: `cwd` defaults to `process.env.HOME ?? os.tmpdir()` today
(`runner.ts:279`) — what is the default under the new `cwd:` field? Unstated.

### m8 — Inherited wart: `prompt: agents/x` ships raw frontmatter to the model

`resolvePromptText` reads the asset file whole — `fs.readFileSync(assetPath,
"utf8")` (`src/tasks/runner.ts:592-593`) — so the agent asset's YAML frontmatter
delimiters and keys are sent to the model as prompt text. The spec's §3.5
correctly identifies that this path drops the model preference; it does not
mention that it also sends frontmatter. Worth naming, since §8's migration
"seeds the body from the agent asset's prompt" and should seed the *body*, not
the file.

### m9 — okf-support.md consistency is not as clean as claimed

The proposal lists okf-support.md as a "Related" consistency anchor. Two frictions:

- okf-support.md:20-22 lists "**YAML tasks**" among things OKF is explicitly
  *not* "a serialization imposed on". Converting tasks to OKF-enveloped markdown
  doesn't violate the letter (nothing is imposed), but the sentence goes stale and
  should be updated in the same change.
- okf-support.md:131-134: "`workflow` is the only type whose frontmatter is parsed
  against a closed allowlist, and that allowlist admits these keys". A markdown
  task with a closed frontmatter schema becomes the second such type, so
  `promoteProposal`'s OKF v0.2 stamping needs the task allowlist to admit
  `generated`/`verified`/`provenance`/`status`/`stale_after` — or stamping falls
  back to "promote unstamped, warn". Not mentioned in §4 or §6.

### m10 — Golden/test churn is understated

§3.6 prices the flatten as "schema and golden churn on a pre-release format —
approved." The actual surface: the `akm-task` conformance oracle is marked
**"authored, DO NOT modify"** and has four goldens
(`tests/fixtures/format-family-goldens/akm-task/{recognition,placement,lint,renderer}.json`)
plus a fixture bundle (`tests/fixtures/bundles/akm-task/`); `looksLikeRoot`
(`akm-task-adapter.ts:136-155`) is an install-time probe keyed on top-level
`.yml`; there are ~20 task test files, two CLI goldens
(`tests/fixtures/goldens/cli/c-tasks-*.json`), a schema-drift test pinning
`akm-workflow.json` enums against `program/schema.ts` constants
(`program/schema.ts:22-24`), a `tests/integration/tasks-schema.test.ts` that is
the sole runtime consumer of `akm-task.json`, and an
`all-types` stash fixture (`tests/fixtures/stashes/all-types/tasks/*.yml`). Add a
work-item line for the oracle rewrite — "DO NOT modify" implies an explicit
owner decision to re-author it.

---

## Claims verified as accurate (for the record)

Not everything is wrong; these check out precisely and should not be re-litigated:

- §2 "`run` is the canonical orchestrator; `start`/`next`/`complete` removed" —
  `src/commands/workflow-cli.ts:522` subcommands are status/list/create/run/brief/
  report/abandon/resume.
- §2 "Freeze already implements a configuration cascade … `layers:
  EngineUseConfig[] = [documentDefaults, unit]`, selects engine by nearest layer,
  resolves model/timeout/request overrides nearest-wins / deep-merged" —
  `freeze.ts:50, 151-155, 163-191, 193-209, 211-216`. Exactly right, and it is
  the strongest argument in the document.
- §2 `UnitDispatchRequest` carries prompt / frozen engine snapshot / timeoutMs /
  env / cwd / sensitiveValues, results carry `failureReason` —
  `unit-dispatch.ts:9-43`. (Nit: `failureReason` is typed `string`, not the
  `AgentFailureReason` union.)
- §3.4 "`temperature` on an agent-kind engine node remains a config validation
  error … `engines.ts` already enforces this, while `model` remains legal on both
  kinds" — `engines.ts:105-120` (reject list) and `:71` / `:99`.
- §3.5's description of `resolveModel`'s four-tier chain, `"*"` fallback column,
  `resolveLlmModel`'s `llm` column, one resolution level, no recursion —
  `model-aliases.ts:11-16, 89-109`. Accurate.
- §3.5 "today the `.yml` task path drops an agent asset's model preference" —
  `runner.ts:581-593` resolves the ref to text only; no model is read.
- §6 "`akm-task.json` standalone (87 lines, loaded by nothing at runtime)" — 87
  lines, one consumer and it is a test (`tests/integration/tasks-schema.test.ts:8`).
- §6 "`parseTaskDocument()` + `TASK_KEYS` + `rejectTargetFields()` +
  `resolvePromptSource()` (368 lines)" — `src/tasks/parser.ts` is 368 lines.
- §6 "`runCommandTask` runs raw argv only" — `runner.ts:277-289`.
- §8 "task ids and the `akm task run <id>` ABI do not change, so nothing is
  reinstalled" — `buildScheduledTaskInvocation` /`parseScheduledTaskArgv`
  (`scheduler-invocation.ts:59-78, 198-227`) are extension-agnostic; ids derive
  from the basename. Correct, provided the id grammar is unchanged
  (`src/tasks/task-id.ts`).
- §8 "0.9.0 already has an explicit, journaled, crash-resumable migration … Task
  conversion joins it as one more content step" — `scripts/akm-migrate/migrate/
  legacy/content-migration.ts:5-45` is exactly that, and its "PRE-RELEASE
  EXTENSION NOTE" explicitly blesses growing the fold set in-branch.

---

## Cross-cutting: what will actually be hard

Ranked by hidden cost, not by spec word count:

1. **A second, non-agent dispatch path through the journal** (C4). Everything
   downstream of `runUnit` assumes an engine, a prompt, and token usage. Retry,
   worktree isolation, budget accounting, `brief`/`report`, and `failure_reason`
   mapping all need shell-shaped answers. This is the single largest unscoped item.
2. **IR + hash version bump with a defined preimage** (C3). Mechanically small,
   semantically dangerous — a missed field is a silent replay-reuse bug.
3. **Composition at freeze** (M8): async freeze, bundle scoping, lint-time
   validation, and provenance of the composed prose in the report surface.
4. **The cascade's config half** (M3): new `DefaultsSchema` fields, new readers in
   three freeze helpers, `akm config set` support, and un-retiring `defaults.llm`
   in flat form one release after killing it.
5. **The task-runner / orchestrator split** (§6's "honest boundary") is the right
   call but leaves the observable-semantics divergence unaddressed: the *same*
   task, run by cron, resolves config at dispatch (`runner.ts:476-514`); composed
   into a workflow, it resolves at freeze. A user who edits `config.defaults.model`
   mid-flight sees one surface change and the other not. §3.5 notes the timing
   difference in one clause; it deserves a paragraph and a documented rule.

## Recommended pre-implementation actions

1. Correct or strike C2, M1, M5 — three design decisions rest on inaccurate
   readings of the code.
2. Rewrite §10 to enumerate the real IR/freeze/hash changes (C3).
3. Add a §3.8 "shell units in the orchestrator" covering C4 end to end.
4. Add a security paragraph for `uses: scripts/*` (C1) and update
   `metadata.ts:140` in the same commit.
5. Remove `params` from the cascade vocabulary (M7); decide the command-template
   placeholder syntax explicitly (M2).
6. Complete the §8 migration table and replace "honored structurally" with a
   named mechanism (M9, M10).
