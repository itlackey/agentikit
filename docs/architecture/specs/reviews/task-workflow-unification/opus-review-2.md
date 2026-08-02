# Review #2 — `task-workflow-format-unification.md` (v7) vs. the implementation

Reviewer: independent reviewer #2 of 3.
Repo: `/home/user/akm` @ `claude/akm-markdown-tasks-history-75l6du` (baselined on
`claude/release-0-9-0-polish-d6sycl`, HEAD `3c5fadb`).
Scope: the spec in full, plus `src/tasks/`, `src/workflows/{ir,exec,program}`,
`schemas/*.json`, config engine schema, model aliases, the task adapter, and the
0.9.0 migrator.

**Overall.** The *direction* is right and several of the spec's diagnoses are
accurate (the `unit:` bag is awkward; `resolvePromptSource()` sniffing is bad;
`akm-task.json` really is dead weight; freeze really does resolve by layers).
But the document repeatedly presents **new mechanism as existing mechanism**.
The three load-bearing "this already exists" claims — the configuration cascade,
the single dispatch seam, and "no IR/freeze/journal changes" — do not survive
contact with the code. `run:` shell units cannot be represented in IR v3 at all;
the cascade that "already exists" is two layers deep with no persona layer and
no `defaults.model`; and the `output:` "duplicate" the flatten deletes is two
semantically distinct schemas that the *sibling spec it cites* explicitly
distinguishes. The migration section's losslessness claim is false in at least
four concrete ways.

Verdict: **do not sign off decision 14 (or §3.6/§10) as written.** The design is
salvageable, but §10's non-goals must be withdrawn and the hidden cost
(IR v4, plan-hash/journal migration, a persona-layer freeze path, a placeholder
grammar decision, a redaction-policy change) has to be priced in before this is
scoped as "authoring-surface changes".

---

## Findings table

| # | Sev | Title | Key refs |
|---|---|---|---|
| C1 | critical | `unit.output` and `step.output` are not duplicates; the flatten collides them | `src/workflows/ir/compile.ts:204,229`; `src/workflows/exec/step-work.ts:560`; `src/workflows/exec/report.ts:1621`; `workflow-format-unification.md` §2.3b |
| C2 | critical | `run:` shell units are unrepresentable in IR v3 / dispatch; §10 non-goals are false | `src/workflows/exec/unit-dispatch.ts:19`; `src/workflows/ir/schema.ts:29,48,65,171`; `src/workflows/exec/native-executor.ts:638-645`; `src/workflows/ir/freeze.ts:52-62` |
| C3 | critical | Prose-append rule can change the prompt without changing the input hash | `src/workflows/exec/step-work.ts:376-392,362-368`; spec §3.3 bullet 3 |
| C4 | critical | `params` as a cascade value field collides with `params:` = param *declarations* | `schemas/akm-workflow.json:22-32`; `src/workflows/ir/params.ts:39-53`; spec §3.4 |
| M1 | major | The "existing cascade" is 2 layers; `defaults.model` and the persona layer don't exist | `src/core/config/config-schema.ts:102-108`; `src/workflows/ir/freeze.ts:50,163-191`; `schemas/akm-config.json` defaults |
| M2 | major | The kind-gated `llm` error is already dead code in workflows (silent drop, not error) | `src/workflows/ir/freeze.ts:67-73`; `src/tasks/runner.ts:497-502` |
| M3 | major | Model aliases are not portable to LLM endpoints — §3.5's portability claim is wrong | `src/integrations/agent/model-aliases.ts:45-76,107-109` |
| M4 | major | `agent:` as a cascade selector needs systemPrompt + toolPolicy in the frozen plan, incl. the provenance ceiling | `src/output/renderers.ts:250-262`; `src/workflows/exec/native-executor.ts:1026`; `src/workflows/exec/unit-dispatch.ts:16` |
| M5 | major | Command-template filling: four placeholder conventions, one existing bug, silent behavior change | `src/output/renderers.ts:164-186`; `src/commands/agent/agent-dispatch.ts:63-72,125-133` |
| M6 | major | `uses: scripts/<name>` is net-new remote-code-execution surface, not plumbing reuse | `src/output/renderers.ts:118-142`; `src/core/activation-policy.ts` |
| M7 | major | Literal `env:` values will be over-redacted through the existing seam | `src/workflows/exec/native-executor.ts:1163-1193`; `src/core/redaction.ts:193-202` |
| M8 | major | `env:` list shape is an IR + input-hash + per-unit-env change | `src/workflows/ir/compile.ts:46`; `src/workflows/exec/step-work.ts:353-357,387`; `src/workflows/exec/native-executor.ts:449-457` |
| M9 | major | Markdown-task recognition collides with the `.md`-claiming workflow adapter; "DO NOT modify" goldens | `src/core/adapter/adapters/index.ts:73-90`; `akm-workflow-adapter.ts:60-76`; `akm-task-adapter.ts:24-26` |
| M10 | major | Migration is neither a byte-rewrite nor lossless; stray `.yml` becomes silently invisible | `scripts/akm-migrate/migrate/legacy/task-target-ref-migration.ts:44-66`; `src/core/asset/asset-placement.ts:159-170`; `src/tasks/parser.ts:331-338` |
| M11 | major | `defaults.on_error` is deleted by "graph keys are steps-only" with no migration row | `src/workflows/parser.ts:104`; `src/workflows/ir/compile.ts:231` |
| m1 | minor | "Trigger keys consumed only by `task sync`" — the runner gates on `enabled` at fire time | `src/tasks/runner.ts:169`; `src/core/activation-policy.ts` rule 3 |
| m2 | minor | §3.5's `akm agent` embodiment sentence is backwards | `src/commands/agent/contribute-cli.ts:87-88` |
| m3 | minor | "The `.yml` task path drops the model preference" understates: frontmatter is injected into the prompt | `src/tasks/runner.ts:582-593` |
| m4 | minor | "The engine node keeps its strict schema" — both engine schemas are `.passthrough()` | `src/core/config/schema/engines.ts:54,82,104` |
| m5 | minor | `status: draft` overloads OKF lifecycle with scheduler activation; a second unordered gate | `schemas/akm-asset-envelope.json` `status`; spec §4 |
| m6 | minor | `cwd:` × `isolation: worktree` interaction unspecified | `src/workflows/exec/native-executor.ts:1063-1075` |
| m7 | minor | `uses:` table covers 5 of ~15 asset types; the rest are unspecified | `src/core/asset/asset-placement.ts:89-178` |
| m8 | minor | Task id / placement inconsistency the plan inherits (subdir tasks index but cannot run) | `src/tasks/task-id.ts:7`; `src/core/asset/asset-placement.ts:162-169` |
| m9 | minor | Embedded-template plumbing is `.yml`+command-only and must change too | `src/tasks/embedded.ts:82,97` |
| ✓ | — | Claims that *do* check out (see §"Verified claims") | — |

---

## Critical

### C1. `unit.output` and `step.output` are two different schemas; the flatten collides them

Spec §3.6: *"`output:` is declared **both** on the step and inside the bag — a
live wart in `schemas/akm-workflow.json`"*, and *"The duplicate `output`
declaration disappears with the bag."* §6 repeats: *"separate `unit` defs with a
duplicated `output`"*.

They are not duplicates.

- `src/workflows/ir/compile.ts:229` — `unit.output` → `WorkflowUnitDraft.schema`.
- `src/workflows/ir/compile.ts:204` — `step.output` → `WorkflowStepDraft.outputSchema`.
- `schema` validates **one unit's structured result**, per dispatch attempt:
  `src/workflows/exec/report.ts:1621` (`Unit "…" result failed validation against
  its declared output schema`), threaded to harness native structured output at
  `native-executor.ts:1038,1092`.
- `outputSchema` validates the **promoted step artifact** after reduction:
  `src/workflows/exec/step-work.ts:558-561`, `native-executor.ts:55`,
  `ir/schema.ts:217`.

And the spec this one claims consistency with says so in as many words —
`docs/architecture/specs/workflow-format-unification.md` §2.3b: *"For a map step,
`output:` validates the **promoted artifact**, i.e. what the reducer produced —
not one unit's result."*

Consequence: on a `map:` step, `map.unit.output` (per-item schema, which drives
each harness's native structured-output mode) and `step.output` (the collected
array schema) are **necessarily different documents**. Deleting the bag deletes
the ability to type a map step's per-item result at all — silently, since both
spellings are `output:`. Existing workflows that set both will migrate to a
conflict with no defined winner.

Recommendation: keep two spellings on the flattened step (e.g. `result:` for the
per-unit schema and `output:` for the step artifact), or explicitly declare
per-item schemas removed and accept losing harness-native structured output on
map steps. Either way, remove the "duplicate" framing from §3.6/§6 — it is the
justification for the change and it is wrong.

### C2. `run:` shell units cannot be represented in IR v3; §10's non-goals are false

Spec §3.6: *"A shell unit inside a workflow journals like any unit
(`workflow_run_units`): no tokens, but status, timing, attempts, and
`failure_reason` behave normally."* §2: *"`unit-dispatch.ts` is the one dispatch
seam."* §10: *"no changes to … IR, freeze, journal, leases, or replay."*

The code:

- `src/workflows/exec/unit-dispatch.ts:19` — `UnitDispatchRequest.engine:
  FrozenEngineSnapshot` is **required**, as is `invocation: IrInvocation`.
- `src/workflows/ir/schema.ts:48,65,76` — `FrozenEngineSnapshot` is a closed
  two-member union (`llm` | `agent`), validated by `decodeWorkflowPlanV3`
  (`ir/schema.ts:171` — `irVersion must be 3`; `:341-374` field allowlists;
  `:517` `assertUnitEngineCompatibility`).
- `src/workflows/exec/native-executor.ts:638-645` — a unit with no frozen engine
  snapshot hard-fails `dispatch_error` before dispatch.
- `src/workflows/ir/freeze.ts:49-62` — **every** unit runs `freezeInvocation`,
  which throws `ConfigError("No workflow engine is selected…")` when no engine
  resolves. A workflow made entirely of `run:` steps therefore cannot even be
  frozen on a machine with no agent CLI configured — the single most obvious
  use case for inline shell.

Adding a shell unit kind requires: a third `FrozenEngineSnapshot` variant or a
new IR node kind, `decodeWorkflowPlanV3` changes, an `irVersion` bump (persisted
`plan_json`/`plan_hash` on run rows), a `hashVersion` bump in `step-work.ts:379`,
and a `frozenUnitRunner` branch. That is an IR + freeze + journal + replay
change, i.e. the exact four things §10 says are untouched. Nothing in the
codebase currently executes a shell string at all — `runCommandTask` spawns
pre-split argv with no shell (`src/tasks/runner.ts:277-289`,
`src/tasks/parser.ts:300-306`), which the spec itself notes in §6.

Recommendation: withdraw the §10 non-goal, state IR v4 explicitly, and decide
whether in-flight v3 runs are drained or migrated. Also state what
`freezeInvocation` does for a shell unit (it must be skipped, not defaulted —
otherwise every shell-only workflow requires an engine).

### C3. The prose-append rule can change the prompt without changing the input hash

Spec §3.3: *"the assembled prompt is a frozen string produced at one seam, so
appending is a deterministic concat — easy"*, and the appended section is
*"appended to the assembled prompt after a blank line, byte-exact."*

There are two seams, and the spec names the wrong one. `step-work.ts:322-332`
assembles the prompt via `buildUnitPrompt`; `step-work.ts:376-392` computes the
`inputHash` over **`template.instructions`** — the frozen template bytes — *not*
over the assembled prompt. The comment at `:342-350` states this deliberately.
The codebase has already been bitten by exactly this: `gateFeedback` had to be
added to the hash preimage (`:362-368`) because *"omitting it made loop 1 and
loop 2 journal identical hashes for different prompts, breaking the 'changed
inputs ⇒ changed hash' audit contract."*

If the `## <step-id>` section of a `uses: tasks/<id>` step is appended at
prompt-assembly time, two materially different prompts hash identically →
`classifyUnitReuse` (`native-executor.ts:690`) reuses a completed row for a
different ask, and editing only the step's section produces no re-dispatch.

Recommendation: the append must happen at **compile** time, folded into
`WorkflowUnitDraft.instructions` before freeze, so it is inside the hash
preimage by construction. Say so in §3.3. (This also makes the "byte-exact" and
"blank line" rule a compile-time, testable property.)

Secondary: the rule is conditioned on *"when the resolved work is
agent-dispatched"* — but for a `uses: tasks/<id>` step, whether the task
resolves to agent work or shell work is known only after resolving the task.
The same authored step therefore silently changes whether its prose is
load-bearing or documentation depending on the referenced task's target — and a
later edit to the *task* (prose → `run:`) silently demotes the *workflow's*
prose to a comment. That is a footgun worth an explicit lint.

### C4. `params` as a cascade value field collides with `params:` = declarations

§3.4 lists `params` in the flat value vocabulary, *"legal at every layer, merged
per-field with the nearest layer winning"*, and §3.3 says a referenced task is
*"one more layer"*.

But at the workflow-document layer, `params:` already means something else
entirely: the **declaration block**, name → JSON Schema
(`schemas/akm-workflow.json:22-32`; `compile.ts:132-139` → `plan.paramSchemas`).
A "document defaults" layer contributing `params` *values* into the same
frontmatter namespace is not expressible.

Worse, cascading param *values* down from config/engine/persona layers breaks
the declared-flag contract the spec cites in §2: `materializeWorkflowParameterFlags`
(`ir/params.ts:39-53`) rejects any name not in `plan.params`, and
`assertRunParamsSatisfyPlan` (`run-workflow.ts:531`) validates the journaled set.
A global `params` default would inject undeclared names into every run.

Also unspecified: `params` means three different things across §3.2 —
workflow param flags, command-template placeholder fills, and (per §3.4) a
cascading value field. Merging them per-field across five layers has no
coherent semantics (e.g. a persona node's `params.scope` leaking into an
unrelated workflow's param set).

Recommendation: remove `params` from the cascade vocabulary. Make it a
target-local input (`uses:`-adjacent only), and keep the document-level
`params:` declaration block as-is.

---

## Major

### M1. The "cascade that already exists" is two layers, with no persona layer and no `defaults.model`

§2 and §3.4 lean hard on *"Freeze already implements a configuration cascade"*
and *"exposing this existing mechanism"*. What exists:

- `freeze.ts:50` — `layers = [documentDefaults?, unit?]`. **Two** layers, both
  from the workflow document. Verified.
- `freeze.ts:151-155` `selectedEngine`, `:163-191` `exactModel`,
  `:193-209` `effectiveTimeout`, `:211-216` `mergedLlmOverrides` — nearest-wins /
  deep-merge. Verified.
- The **engine node is not a layer**: `engine.model` is consulted only as a
  fallback *after* the layers produce nothing (`freeze.ts:171`), and
  `engine.timeoutMs` likewise (`:197`). Same relative order the spec wants, but
  it is a two-branch fallback chain, not a layer list — generalizing it to five
  layers is a rewrite of these three functions, not an exposure.
- **There is no persona layer at all.** Nothing in `freeze.ts` loads an agent
  asset. This is the largest new piece of work in the whole proposal (see M4)
  and §3.4 describes it as already-mechanism.
- **`defaults.model` does not exist.** `src/core/config/config-schema.ts:102-108`:
  `DefaultsSchema = { engine?, llmEngine?, improveStrategy? }.passthrough()`.
  `schemas/akm-config.json` `properties.defaults` has the same three keys with
  `additionalProperties: true`. So the spec's §3.4 worked example
  (`"defaults": { "engine": "claude", "model": "sonnet" }`) is a config a user can
  write **today**, that validates, and that is **silently ignored**. That is a
  live drift bug the plan should fix explicitly, not a documented layer.

Recommendation: rewrite §2's fifth bullet and §3.4's "the mechanism already
exists" framing to name what is new (persona layer, config `defaults.model`,
`env`/`cwd`/`shell` layering, per-field merge across five layers) versus what is
reused (nearest-wins over two workflow-document layers). Otherwise the estimate
is wrong by a large factor.

### M2. The kind-gated `llm` hard error is already dead code in the workflow path

§3.4: *"`llm:` … was a grouping whose only job was to scope a kind-gated hard
error"*; §6: *"a kind-gated hard error"* (singular).

There are two behaviors, and one is a bug:

```ts
// src/workflows/ir/freeze.ts:67-73
const llm = engine.kind === "llm" ? mergedLlmOverrides(layers) : undefined;
if (engine.kind !== "llm" && llm !== undefined) { throw new ConfigError(...) }
```

The guard is **unreachable** — `llm` is `undefined` whenever `kind !== "llm"`.
So a workflow that sets `defaults.llm.temperature` under an agent engine today
gets its overrides **silently discarded**, with no error and no warning. The
live hard error exists only on the task path
(`src/tasks/runner.ts:497-502`, `NotFoundError` — also the wrong error class for
a config problem).

This matters for the proposal in two ways: (a) the "convert the error to a
notice" work item is really "fix a silent-drop bug *and* convert a task-path
error", and (b) §3.4's argument that *"a global default `temperature` must not
brick every agent-engine dispatch"* is already true of workflows — the
motivating hazard is one path only.

Recommendation: fix `freeze.ts:67-73` independently (it is a bug on the current
branch), and correct §3.4/§6 to describe two divergent behaviors.

### M3. Model aliases are not portable to LLM endpoints

§3.5: *"Aliases are **per-platform**, which is what makes a shared asset
portable: `model: sonnet` resolves to the right string under a claude engine, an
opencode engine, **or an LLM endpoint**."*

`src/integrations/agent/model-aliases.ts:45-76` — the built-in table has exactly
two platform columns: `claude` and `opencode`. `resolveLlmModel` (`:107-109`)
calls `resolveModel(model, engineName, undefined, global, ["llm"])`, i.e. it
passes the **engine name** where `platform` is expected, then falls back to a
`"llm"` column and `"*"`. A user-supplied `modelAliases` table can supply those
columns; the **built-ins cannot**. So under an LLM engine, `model: sonnet`
returns `"sonnet"` verbatim (`:103` `entry?.platforms[platform] ?? model`) and is
sent as the model id to an OpenAI-compatible endpoint.

Since §3.4/§3.5 make aliases legal at *every* layer (including a shared persona
node in a third-party bundle), this failure now occurs at more layers, not
fewer, and only at dispatch.

Recommendation: either add an `llm`/`*` column to `BUILTIN_ALIASES`, or drop the
portability claim and add a freeze-time notice when an alias fails to resolve
against the selected engine.

### M4. The persona layer is not "a node whose fields join the cascade" — it carries a system prompt and a gated tool policy

§3.4 describes `agent:` as picking *"the persona node — who runs it (system
prompt, tool policy, model preference)"* and then only ever discusses `model`.
The other two are the hard part:

- Today an agent asset yields `{ prompt (system), modelHint, toolPolicy }`
  (`src/output/renderers.ts:241-262`), consumed only by `akm agent`
  (`contribute-cli.ts:72-90` → `AgentDispatchRequest`).
- The workflow path deliberately does **not** carry them:
  `native-executor.ts:1026` — *"`systemPrompt`/`tools`/`cwd` come from the
  profile/asset, not the workflow unit"*; `unit-dispatch.ts:16` documents
  `systemPrompt` as *"used by frozen workflow gate judges"* only;
  `buildAgentDispatchRequest` (`:1029-1039`) passes only prompt/model/schema.
  `FrozenEngineSnapshot` has no tool-policy field (`ir/schema.ts:60-75`).
- **Security-relevant:** the agent asset's `tools:` is *self-declared
  frontmatter*, and there is an explicit **provenance ceiling** applied at the
  show layer that decides whether to honour it based on writable-own-stash vs
  read-only third-party source (`renderers.ts:257-260`, tagged "07 P1-D").
  Freeze has no notion of source provenance. Making `agent:` a cascade selector
  resolved at freeze silently relocates that ceiling — or drops it.

Combined with §3.4's *"This widens agent assets from today's model-hint-only
frontmatter to the full value vocabulary"*, a third-party bundle's agent asset
would now be able to set `env`, `cwd`, `timeout` and a tool policy for a
workflow that merely names it. §10 says *"no multi-file config merging"* while
§3.4 makes bundle assets configuration layers; that tension should be resolved
explicitly with a provenance rule.

Recommendation: state that the persona layer contributes `systemPrompt` and
`toolPolicy` into the frozen plan (IR change), and carry the existing provenance
ceiling into freeze with a named test.

### M5. Command-template filling: four conventions, one live bug, and a silent behavior change

§3.2: *"`uses: commands/<name>` … `params:` fill the placeholders"*, *"a
placeholder with no matching param is an error at fill time"*; §6: *"one
implementation, both surfaces"* (from "n/a").

It is not "n/a" today, and the existing surface is inconsistent:

- `src/output/renderers.ts:164-186` (`extractParameters`) advertises **three**
  conventions to consumers: `$ARGUMENTS`, `$1`…`$9`, and `{{name}}`.
- `src/commands/agent/agent-dispatch.ts:63-72` (`fillPlaceholders`) substitutes
  **only** `{{<digits>}}`, **positionally** from `--args`, and leaves unmatched
  placeholders verbatim (`:70`).

So a command asset declaring `{{scope}}` is reported as having a `scope`
parameter and can never be filled — an existing bug the plan inherits. And the
spec's rule changes behavior on two axes at once: positional → named, and
lenient → hard error. `$ARGUMENTS`-style command assets imported from Claude
Code (which the `agent:` frontmatter support at `renderers.ts:234` implies akm
already ingests) would become **errors** under "a placeholder with no matching
param is an error at fill time".

Recommendation: pick one grammar in the spec, state what happens to the other
three, and state the inverse rule (extra `params:` with no placeholder — error
or notice?). Treat this as a real work item, not a table row.

### M6. `uses: scripts/<name>` is new execution surface, not consolidation

§3.2: *"Execute the script asset per its own `run`/`setup`/`cwd` metadata — no
AI."* §6 files it under shared plumbing.

Today `run`/`setup`/`cwd` on a script asset are **display hints only**:
`resolveExecHints` (`src/output/renderers.ts:118-142`) merges indexed metadata,
`@run`/`@setup`/`@cwd` header comments, and — critically — **auto-detection from
extension + dependency files** (`detectExecHints`). Nothing executes them.

Making them executable means: a scheduled task or workflow step naming a script
from an *installed third-party bundle* runs (a) an auto-detected interpreter
line and (b) a `setup` command (typically a package install) at cron time.
`src/core/activation-policy.ts` enumerates four activation rules — dangerous env
keys, install-time key scan, task activation, write activation — **none** covers
executing a bundle-supplied script. The spec's §10 "no change to how script
assets are authored or stored — this proposal executes and embodies them" waves
past exactly the interesting part.

Recommendation: add an activation rule (fifth) for third-party script execution,
decide whether `setup` runs at all (I'd say no — it is an install-time concern),
and forbid auto-detected `run` for non-primary-bundle scripts.

### M7. Literal `env:` values will be over-redacted

§3.7: *"Values sourced from `env/` and `secrets/` assets join the dispatch's
`sensitiveValues`"* — implying literals do not.

`collectWorkflowDispatchSensitiveValues` (`native-executor.ts:1163-1185`) starts
from `new Set(Object.values(env ?? {}))` — **every** resolved env value, no
provenance distinction. `collectSensitiveValues` (`src/core/redaction.ts:193-202`)
applies no length, entropy, or dictionary floor.

So `env: [{ LOG_LEVEL: debug }]` (the spec's own example, §3.7) adds the string
`"debug"` to `sensitiveValues`, and every occurrence of `debug` in the unit's
output, journaled result, and error text is replaced. Worse,
`redactUnitOutcome` (`:1187-1193`) collapses any redacted `failureReason` to
`"reported_failure"` — so a common literal value can silently destroy the
failure taxonomy `retry.on` keys off.

Recommendation: tag env entries with provenance at resolution
(`ref` vs `literal`) and feed only ref-sourced values to `sensitiveValues`; or
add a minimum-length/entropy floor. Say which in §3.7.

### M8. The `env:` list shape is an IR change, a hash-version change, and a per-unit-env change

§3.7: *"This **extends the existing schema additively** — the workflow
`unit.env` is already a list of ref strings, so every currently-valid value stays
valid."* §10: no IR/journal changes.

- `compile.ts:46` / `ir/schema.ts` — `env?: string[]`. A list of
  `string | Record<string,string>` is a **type change** through
  `WorkflowUnitDraft` → `IrUnitNode` → `decodeWorkflowPlanV3` validation →
  `plan_json`. Existing values stay *authorable*; the IR does not stay the same.
- `step-work.ts:353-357,387` — the input-hash preimage includes `env` and the
  comment is explicit: *"`env` carries NAMES ONLY, never resolved values:
  hashing a resolved secret would leak it into a durable hash oracle"*. A list
  containing literal mappings puts literal values into the preimage (fine) but
  mixes them with names, and `secrets/<name>` ref-valued entries must be hashed
  as refs, not values. Either way `hashVersion: 4` (`:379`) has to become 5,
  which invalidates every journaled `input_hash` and every replay golden.
- **Per-unit env is not supported.** `native-executor.ts:449-457` resolves env
  **once per step**, before any dispatch, from `template.env`, and passes one
  `Record<string,string>` to every unit (`RunUnitInput.env`, `:611`). §3.6's
  `AKM_ITEM` / `AKM_ITEM_INDEX` for map+shell steps requires per-unit env
  assembly, which also moves the `sensitiveValues` computation and the
  "one binding error fails the whole step cleanly" property (`:446-448`).
- The cascade also requires env at layers that have no env today:
  `ProgramDefaults` (`program/schema.ts:203-211`) has no `env`, and
  `DEFAULTS_KEYS` (`parser.ts:104`) does not list it.

Recommendation: drop "additively" from §3.7, name the hash-version bump, and
specify per-unit env for map fan-out.

### M9. Markdown-task recognition collides with the workflow adapter; the task goldens are declared immutable

§6: *"Adapter | `.yml`-only recognize/place | markdown task recognized by
`type: task` / `tasks/` residence"*.

- `src/core/adapter/adapters/index.ts:73-90` orders `akmWorkflowAdapter`
  **before** `akmTaskAdapter`.
- `akm-workflow-adapter.ts:60-76` — *"any `.md` file in this bundle IS a workflow
  … UNLESS its frontmatter declares a DIFFERENT non-empty `type:`"*.

So `type: task` is **mandatory** in practice for a markdown task in a
workflow-adapter bundle; the "or `tasks/` residence" alternative in §6 and the
schedule-only examples pattern would be claimed as workflows. Note also that
`recognize()` receives a component-relative path, and `akmTaskAdapter.directoryList()`
returns `["."]` (tasks live anywhere) — residence-based recognition is not
available in this adapter's contract as written.

Separately, `akm-task-adapter.ts:24-26` declares its fixture + four goldens
(`tests/fixtures/format-family-goldens/akm-task/{recognition,placement,lint,renderer}.json`)
a *"Conformance oracle (authored, DO NOT modify)"*. §3.6's "schema and golden
churn on a pre-release format — approved" does not acknowledge that these
specific goldens are marked immutable, nor `looksLikeRoot`'s `.yml`+`schedule`
probe (`:136-155`), which would need a disjoint `.md` probe that does not fire
on workflow bundles.

Recommendation: state that `type: task` is required (drop the residence
alternative), and get explicit sign-off to re-author the akm-task conformance
oracle.

### M10. Migration is not a byte-rewrite, is not lossless, and re-creates the invisible-file failure

§8: *"Task conversion joins it as one more content step"*, *"No key survives with
a changed meaning"*, and *"The 0.7→0.8 lesson — leftover files must never be
**silently invisible** — is honored structurally."*

Four problems.

1. **Shape.** The existing task migration phase
   (`scripts/akm-migrate/migrate/legacy/task-target-ref-migration.ts`) rewrites
   *YAML scalar bytes in place*: `TaskTargetRefRewrite = { filePath, from, to,
   before, after, mode }` (`:44-52`) with an atomic same-path write. There is no
   rename in the plan structure, no journal phase for a rename, and no
   crash-resume story for a half-renamed set. `.yml → .md` plus a full
   frontmatter reshape plus body synthesis is a new migrator, not a new step.
2. **Read-only bundles.** `:53-66` — `readOnlyLegacyTasks` exists precisely
   because *"The migration NEVER rewrites a read-only bundle … but the 0.9
   runtime removed the v1 parser, so these tasks will fail after upgrade."*
   Under this proposal every `.yml` task in every registry-installed bundle
   becomes permanently unrunnable and unconvertible. "No key survives with a
   changed meaning" is true; "lossless" is not.
3. **Invisible files.** `src/core/asset/asset-placement.ts:159-170` makes `task`
   `.yml`-only for `isRelevantFile` / `toCanonicalName` / `toAssetPath`.
   Flipping it to `.md` makes stray `.yml` task files invisible to
   `resolveAssetPath` — which is what `akm task run` uses
   (`src/tasks/runner.ts:159`). The 0.7→0.8 lesson is **not** honored
   "structurally"; it requires *new* code that deliberately scans for a
   no-longer-relevant extension in `task sync` / `task doctor`. That is a work
   item, not a property.
   (`src/tasks/task-id.ts:8,15,41-46` also hardcodes `.yml`/`.yaml`, including
   in the portable-length budget.)
4. **Dropped fields.** The §8 table's `llm.*` row ends in an ellipsis. Three
   `llm` sub-fields have **no home** in §3.4's nine value fields:
   `supportsJsonSchema`, `contextLength`, `enableThinking`
   (`src/tasks/parser.ts:331-338`; `src/tasks/schema.ts:61-68`;
   `schemas/akm-task.json:46-56`; identical set on the workflow side,
   `schemas/akm-workflow.json:76-87`, and all six are carried into
   `FrozenLlmEngine`, `freeze.ts:231-236`). Either the vocabulary grows to
   twelve fields or the migration is lossy — the spec should say which.

### M11. `defaults.on_error` is silently deleted

§3.4: *"**graph keys** (`map`, `route`, `inputs`, `output`, `gate`, `retry`,
`on_error`, `isolation`) are steps-only"*.

`on_error` is legal at document level today: `src/workflows/parser.ts:104`
(`DEFAULTS_KEYS = ["engine","model","timeout","on_error","llm"]`),
`schemas/akm-workflow.json:200`, `program/schema.ts:210`, and it is *read*:
`compile.ts:231` — `unit?.onError ?? defaults?.onError ?? "fail"`. Making
`on_error` steps-only removes a working document-level default, and §8's
migration table has no row for it.

Recommendation: either keep `on_error` (and `retry`, arguably) as a document
default, or add a migration row that lifts `defaults.on_error` onto every step.

---

## Minor

**m1 — "Trigger keys are consumed *only* by `akm task sync`" (§3.3, decision 10)
is inaccurate.** `enabled` is also read at fire time by the runner:
`src/tasks/runner.ts:169` → `shouldSkipUnactivatedTask({ enabled, scheduled })`,
which is activation-policy rule 3 (`src/core/activation-policy.ts`, doc block
rule 3: *"Task activation (`tasks/runner.ts`)"*). This is a defense-in-depth
property worth preserving; the spec's phrasing invites removing it.

**m2 — §3.5's embodiment sentence is backwards.** *"`akm agent` embodiment
honors it under an explicit `--model` override"* — `contribute-cli.ts:87-88`:
`// --model flag wins over the asset's modelHint`. The asset's model is honored
in the *absence* of `--model`. The design conclusion drawn from it still stands,
but the sentence should be fixed.

**m3 — §3.5 understates the `.yml` prompt-asset bug.** *"`prompt: agents/x`
resolves the asset to prompt text only"*. `runner.ts:582-593` does
`fs.readFileSync(assetPath, "utf8")` with **no frontmatter stripping**, so the
YAML frontmatter (`---\nmodel: opus\ntools: …\n---`) is prepended to the prompt
sent to the agent. Same for `kind: "file"` (`:576-579`). This is a live bug on
the current branch, worth fixing independently of the proposal.

**m4 — "the engine node … keeps its strict schema" overstates.** Both
`LlmEngineSchema` and `AgentEngineSchema` are `.passthrough()`
(`src/core/config/schema/engines.ts:54,82,104`) with a *blacklist* superRefine
(`:83-88`, `:105-131`). `model` legal on both, LLM fields rejected on agent
kind — that part of §3.4 is verified. But the new value fields `cwd`, `shell`,
`env`, `params` are in neither list, so an engine node would silently accept and
silently ignore them. "Strict" needs to become strict (closed schema) if the
spec's asymmetry argument is to hold.

**m5 — `status: draft` overloads the OKF lifecycle family.**
`schemas/akm-asset-envelope.json` defines `status: ["draft","stable","deprecated"]`
as *"OKF v0.2 lifecycle status"*, shared across all asset types and stamped by
`okf-support.md`'s enhancement contract. §4 makes it load-bearing for scheduler
installation (*"draft tasks are never installed by `sync`"*), creating a second
activation gate alongside `enabled:` with no stated precedence, and leaving
`status: deprecated` undefined. Recommend: keep activation on `enabled:` only,
or define the truth table.

**m6 — `cwd:` × `isolation: worktree`.** `request.cwd` is currently set *only*
by worktree isolation, and `defaultUnitDispatcher` rejects `cwd` on the llm
runner (`native-executor.ts:1063-1075`). A user-set `cwd:` on an isolated step,
or on an llm-engine step, has no defined behavior in the spec.

**m7 — `uses:` coverage.** §3.2 defines 5 of ~15 placement types
(`asset-placement.ts:89-178`: skill, command, agent, script, memory, env,
secret, lesson, task, session, fact, workflow, knowledge…). `uses: lessons/x`,
`uses: skills/x`, `uses: env/x` need a stated rule (error with a hint, or
"anything not listed is an error").

**m8 — task id vs placement inconsistency inherited.**
`asset-placement.ts:162-169` derives a task's canonical name from the *relative
path*, so `tasks/sub/x.yml` indexes as `sub/x`; `validateTaskId`
(`task-id.ts:7`, `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`) rejects `/`, so
`akm task run sub/x` throws. §4's "an ordinary akm markdown asset at
`<bundle>/tasks/<id>.md`" plus the adapter's `directoryList(): ["."]`
perpetuates it. Worth resolving in the same change.

**m9 — embedded templates.** `src/tasks/embedded.ts:82` filters `.yml` and
`:97` drops any task whose target is not `command` — so the setup wizard's whole
enumeration path changes with the format (and `EmbeddedTask.command: string`
becomes `run:`). Confirmed 10 templates (`src/assets/tasks/core/` ×5,
`src/assets/tasks/improve/` ×5), all `command:` targets, so §8's "ten embedded
templates" is accurate.

---

## Verified claims (the spec gets these right)

Recorded so the above is read as targeted, not blanket:

- §2 — `akm workflow run` is the canonical orchestrator; no `start`/`next`/`complete`
  subcommands; `brief`/`report` gated on `experimental.workflowEngine`
  (`src/commands/workflow-cli.ts:160,324,351,522-530`;
  `src/workflows/exec/workflow-engine-gate.ts:39,56`).
- §2 — scheduled workflow tasks run end-to-end (`runner.ts:199-208,352-416`
  → `runWorkflowSteps`).
- §2 — `UnitDispatchRequest` carries prompt / frozen engine / `timeoutMs` / `env`
  / `cwd` / `sensitiveValues`, and results carry `failureReason`
  (`unit-dispatch.ts:9-43`).
- §2 — freeze assembles `layers = [documentDefaults, unit]`, selects engine by
  nearest layer, resolves model/timeout/llm nearest-wins/deep-merged
  (`freeze.ts:50,151-216`) — accurate as far as it goes (see M1).
- §3.4 — `temperature` etc. are a config validation error on an agent-kind
  engine, `model` legal on both (`engines.ts:99,105-120`).
- §3.4 — command assets already read an `agent:` frontmatter field
  (`renderers.ts:234`).
- §3.5 — `resolveModel` is a four-tier chain (profile aliases → global table with
  `"*"` fallback → built-ins `fable`/`opus`/`sonnet`/`haiku` → verbatim), one
  level, no recursion (`model-aliases.ts:45-104`).
- §3.6 — `output:` is declared on both the step and the `unit` bag in
  `schemas/akm-workflow.json` (`:234`, `:351`). *Present* — but not a duplicate
  (C1).
- §3.7 — `unit.env` is currently `array of string` (`akm-workflow.json:237-244`).
- §6 — `parseTaskDocument` + `TASK_KEYS` + `rejectTargetFields` +
  `resolvePromptSource` = exactly 368 lines (`src/tasks/parser.ts`).
- §6 — `akm-task.json` is 87 lines and referenced only by
  `tests/integration/tasks-schema.test.ts:8` (no runtime loader).
- §6 — `runCommandTask` runs raw argv only, no shell
  (`runner.ts:277-289`; `parser.ts:300-306`).
- §6 — lint lives in `akm-task-adapter.ts` as `invalid-task-yaml` (`:88-98`).
- §8 — task ids and the `akm task run <id>` ABI need not change; the scheduler
  argv shape is `[…akm, --scheduler-context, <path>, task, run, <id>, [--bundle
  <b>], --scheduled]` and depends on the id, not the file format
  (`scheduler-invocation.ts:59-78,198-227`).
- §8 — 0.9.0 already refuses un-migrated installations at the config boundary
  (`src/core/common.ts:228`).
- §8 — ten embedded templates.
- §10 / §3.6 alignment with `workflow-format-unification.md` §2.3's forward
  reference: *"If a non-agent unit kind (raw shell/exec) is ever added, that unit
  kind reintroduces substitution as its own need"* — §3.6's `AKM_ITEM` env
  approach is consistent with that ruling.

---

## Recommended changes before sign-off

1. **Withdraw §10's "no changes to IR, freeze, journal, replay."** Replace with
   an explicit list: IR v4, `hashVersion` 5, a shell node kind or third engine
   snapshot variant, a persona-layer freeze path, plan/journal migration for
   in-flight runs.
2. **Fix C1** — keep two output spellings, or state the map-step loss.
3. **Fix C3** — move the prose append to compile time, into the hashed
   `instructions`.
4. **Remove `params` from the cascade vocabulary (C4).**
5. **Rewrite §2 bullet 5 and §3.4's framing (M1)** to distinguish the two-layer
   nearest-wins resolver that exists from the five-layer cascade being proposed,
   and add `defaults.model` as a new config field (it is silently ignored today).
6. **Add a provenance rule for bundle-asset configuration layers (M4, M6)** —
   the tool-policy ceiling and script execution both need one.
7. **Decide the placeholder grammar (M5)** and the fate of `$ARGUMENTS`.
8. **Rewrite §8** — losslessness is false for read-only bundles and for the three
   `llm` sub-fields; the migrator needs rename support; the "silently invisible"
   guarantee is a work item, not a structural property.
9. **Independently fix, on the current branch:** the dead `llm` guard
   (`freeze.ts:67-73`), the frontmatter-in-prompt bug (`runner.ts:582-593`), and
   the `{{name}}` vs `{{0}}` placeholder mismatch (`renderers.ts:178` vs
   `agent-dispatch.ts:68`). All three are bugs today and the plan inherits them.
