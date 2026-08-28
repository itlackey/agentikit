# P2a — task source v4, the shared input contract, and input flags

**Status:** ready for implementation
**Phase:** P2a of the akm task/workflow refactor
**Owner artifacts:** `src/tasks/source/**` (the task source v4 grammar, the
version router, the v4 → preparable projection), `src/execution/input-contract.ts`
(the shared input contract), `akm task run`'s input flags,
`schemas/akm-task.json`, `docs/reference/tasks.md`, plus the authorized
behavior flips of §6 and their tests.

This document is the **single source of truth** for P2a. Lanes do not
re-derive these facts from the codebase and do not read the parent plan. Every
`file:line` below was verified at the head of
`claude/breaking-changes-0-9-2-3cfyvp` (P1b landed: `c64e5e1`).

---

## 0. What P2a is (and is not)

P2a introduces a **second, additive task source grammar** — "task source v4" —
alongside the existing v3 grammar, and extracts the workflow parameter machinery
into a **shared input contract** both grammars' consumers can use.

P2a **is**:

- a new source grammar (`version: 4`) with typed `inputs:`, a single bounded
  `output:` schema, **optional** scheduling, top-level execution controls, and
  no `akm:` bag / no `on:` block / no github-action target;
- a version **router** so `version: 3` and `version: 4` documents both parse;
- the generalization of `src/workflows/ir/params.ts` into
  `src/execution/input-contract.ts`, with `params.ts` left as a thin consumer;
- exact-name **input flags** on `akm task run`, validated end-to-end.

P2a is **not**:

- **input delivery.** A validated input value does **not** reach the target's
  execution in this phase — no `with:` params, no env, no prompt substitution.
  P2a's observable contract for inputs is **validation**: an unknown flag name
  fails `UNKNOWN_FLAG`, a bad value or an unsatisfied declaration fails
  `INPUT_BINDING_INVALID`, and a *valid* set of flags leaves the run
  byte-identical to the same run without them. **P2b owns delivery** (`with:`
  bindings, reference bindings, and the scheduler-invocation ABI).
- a v3 removal phase. v3 documents still parse, still run, still schedule, and
  still produce byte-identical errors. **P4** removes v3 acceptance.
- a task-composition phase. `uses: tasks/<ref>` inside a workflow step still
  rejects `with:` (P1a) and now rejects a **v4** task source with an explicit
  message (§3.6); composing a v4 task from a workflow is **P2b**.
- a `TaskDefinition` widening phase. The P1b model types gain only the two
  declarations §4.4 names; nothing else about `src/tasks/model/**` changes.
- an `akm task add` phase. `akm task add` keeps writing v3 sources and gains
  no input flags (Lane C, binding).

Rules of engagement (unchanged from P1b):

- A defect discovered that is **not** in §6 is recorded in the Review log and
  left unfixed. Do not "improve" anything on the way past.
- If preserving a behavior and implementing an authorized change appear to
  conflict, **stop and record it** — preserving wins until the Review log says
  otherwise.
- Every helper *extracted* from `src/tasks/source-v3.ts` keeps its body
  byte-equivalent. A rewrite disguised as a move is the failure mode this
  phase exists to avoid.

---

## 1. Binding design decisions (verbatim)

§1.1–§1.4 are copied verbatim from the phase decisions and are binding.
§1.5 records the disambiguations this spec adds, with evidence. Where a
verbatim block and a disambiguation appear to conflict, the disambiguation
states which reading wins and why.

### 1.1 D1 naming (binding)

> Task-side is "task SOURCE v4": TASK_SOURCE_V4_VERSION, TaskSourceV4Document,
> parseTaskSourceV4(), files under src/tasks/source/. Never bare "v4" in prose
> — the workflow plan IR is separately versioned.

### 1.2 D2 task source v4 grammar (binding)

> ```yaml
> version: 4
> name: Review code            # optional
> description: …               # optional
> inputs:                      # optional; typed declarations
>   scope: { type: string, enum: [changed, all], default: changed }
>   strict: { type: boolean, default: true }
>   ticket: { type: string, required: true }
> output:                      # optional; single bounded JSON Schema
>   type: object
>   properties: { summary: { type: string } }
> uses: commands/review        # exactly one of uses: | run:
> schedule:                    # OPTIONAL — absent means manual-only
>   - cron: "0 8 * * 1"
>     enabled: true            # optional, default true
>     inputs: { scope: all }   # optional literals, validated against declarations
> timeout: 45000               # top-level (was akm.timeout)
> engine: reviewer             # top-level resolver overrides
> model: exact-model-id
> redact: [TOKEN]
> env: { … }
> shell: …
> working-directory: …
> maxSteps / maxRetries        # top-level (were akm.maxSteps / akm.maxRetries)
> ```
>
> - `schedule: "0 8 * * 1"` string shorthand === one enabled binding, no inputs.
>   Schedule count bound reuses TASK_V3_MAX_SCHEDULES.
> - The `akm:` options bag is GONE in v4 (its members are top-level). `on:` is
>   GONE (no GitHub trigger block). There is NO github-action `uses:` variant —
>   v4 targets are commands/ | scripts/ | workflows/ | akm/command | run:. A
>   github-locator `uses:` in a v4 document is a TASK_SOURCE_INVALID error
>   naming the removal.
> - Absent `schedule:` ⇒ the task is valid, runnable manually, composable, and
>   `akm task sync` SKIPS it silently (this is R-06's flip: v3 required exactly
>   one scheduling source).
> - Input declarations: name grammar identical to workflow params
>   (PROGRAM_PARAM_NAME_PATTERN); each declaration is a bounded JSON Schema
>   validated through the EXISTING validateJsonSchemaSubset
>   (src/core/json-schema.ts) — do not write a second validator; optional
>   `default`; optional `required: true`; `default` + `required` together is an
>   error. Unknown keys in a declaration are rejected. Secret-shaped default
>   values warn exactly as workflow params do.
> - v3 documents STILL PARSE unchanged through src/tasks/source-v3.ts + the P1b
>   adapter (P4 removes v3 acceptance, not P2a). A `version: 4` document routes
>   to the new parser; `version: 3` to the old one; any other version keeps
>   TASK_SCHEMA_VERSION_UNSUPPORTED.

### 1.3 D3 shared input contract (binding, Lane B)

> Create src/execution/input-contract.ts by GENERALIZING the pure module
> src/workflows/ir/params.ts (exports today: WorkflowParameterPlan,
> WorkflowParameterFlag, materializeWorkflowParameterFlags,
> validateWorkflowParams, assertRunParamsSatisfyPlan; header says "Pure module:
> no IO, no engine imports" — the new module keeps that property). It must
> export: an InputDeclaration/InputContract shape, applyInputDefaults(),
> validateInputs() (returns path-prefixed error strings),
> materializeInputFlags() (exact-name flag matching + array grouping + type
> coercion that preserves exact string text, e.g. "001" stays a string), and
> canonicalInputHash() (stable canonical JSON + sha256, for later phases'
> execution identity). params.ts becomes a THIN CONSUMER re-exporting its
> existing workflow-specific wrappers (validateWorkflowParams /
> materializeWorkflowParameterFlags keep their names, messages, and UsageError
> codes byte-identically — tests/workflows/workflow-param-flags.test.ts and
> tests/integration/workflows/params-validation.test.ts must pass UNCHANGED).
> TaskInputBinding is DECLARED here for P2b: { kind:"literal", name, value } |
> { kind:"reference", name, from }. P2a only produces literals.

### 1.4 Lane C — CLI + schema + docs (binding)

> - `akm task run <id>` gains exact-name input flags mirroring `akm workflow
>   run`'s param UX (materializeInputFlags), producing literal TaskInvocation
>   inputs. Unknown input name -> UNKNOWN_FLAG; invalid value ->
>   INPUT_BINDING_INVALID. `akm task add` is NOT extended in this phase.
> - schemas/akm-task.json: publish the v4 shape. The drift test
>   tests/integration/tasks-schema.test.ts asserts schema-vs-parser agreement
>   against exported constants — schema, constants, and that test move in ONE
>   commit. Keep the file at its existing path (the release tar gate requires
>   schemas/akm-task.json, docs/reference/tasks.md,
>   docs/reference/workflow-schema.md to exist).
> - docs/reference/tasks.md documents v4 (optional scheduling, inputs, output)
>   and states v3 still parses until a later release; every `akm …` example
>   must satisfy scripts/lint-doc-examples.ts (it parses examples against the
>   real citty tree). CHANGELOG [Unreleased] gets the task-source-v4 entry
>   (optional scheduling; akm:/on: removal; github-action target removal; new
>   input flags). Update shell completion if it enumerates task flags.

And, verbatim, the preservation gates the reviewer runs:

> - Every P0/P1 suite green EXCEPT the spec's authorized flips;
>   tests/integration/tasks-runtime-v3-runner.test.ts unchanged;
>   tests/contracts/execution-*.test.ts + resolved-execution-contract +
>   command-invocation-contract unchanged; workflow param suites unchanged;
>   tests/integration/tasks-scheduler-sync-v3.test.ts behavior identical for v3
>   sources.
> - The R-06 characterization row (v3 requires exactly one scheduling source)
>   STAYS true for v3 documents; v4's optional schedule is a NEW row, not a flip
>   of the v3 rule. Name this explicitly in the flips table.

### 1.5 Binding disambiguations added by this spec

Each carries an ID so the flips table, the acceptance list, and the Review log
can cite it.

#### D2-N1 — `with:` survives in v4 **only** as `akm/command`'s action bag {#d2-n1}

**Tension.** D2's grammar block shows no `with:` key, yet D2 also lists
`akm/command` as a valid v4 target. `akm/command` is *defined* by its `with:`
bag: `parseBuiltinCommandAction(withValues)`
(`src/tasks/source-v3.ts:747-753`, `src/commands/command/builtin-action.ts`)
requires exactly one of `with.ref` / `with.content` and reads the optional
`with.arguments`. Without `with:`, `akm/command` cannot be authored at all,
which would silently delete a documented 0.9.2 feature
(`docs/reference/tasks.md:41-45`) that D2 explicitly keeps.

**Binding resolution.** v4 accepts a top-level `with:` key **only** when
`uses: akm/command`. Everywhere else — `commands/`, `scripts/`, `workflows/`,
and `run:` — a `with:` key is a `TASK_SOURCE_INVALID` error whose detail points
the author at `inputs:`. Rationale: `with:` in v4 is not an input mechanism (that
is `inputs:` + P2b's bindings); it is the builtin action's own argument record,
and it is validated by the same `parseBuiltinCommandAction` v3 uses, unchanged.

#### D2-N2 — version routing preserves both existing version errors verbatim {#d2-n2}

Today only **one** version raises `TASK_SCHEMA_VERSION_UNSUPPORTED`: `version: 2`,
via `taskV2UnsupportedError` (`source-v3.ts:49-57`, pinned by
`tests/tasks/source-v3.test.ts:260` and
`tests/integration/tasks-runtime-v3-runner.test.ts:74`). A missing version, or
any other value, goes through `sourceError` and renders
`… $ version is required and must be 3.` / `… version must be exactly 3.`
with code `TASK_SOURCE_INVALID` (`source-v3.ts:720-722`).

**Binding resolution.** The router (§3.4) dispatches on the root `version`
field:

| root `version` | routed to | observable result |
|---|---|---|
| `4` | `parseTaskSourceV4Document` | new grammar |
| `3` | `parseTaskV3Document` | **byte-identical to today** |
| `2` | `taskV2UnsupportedError` | **byte-identical to today** (`TASK_SCHEMA_VERSION_UNSUPPORTED`) |
| absent / anything else | `parseTaskV3Document` | **byte-identical to today**, including the now-stale `must be exactly 3` wording |

The stale wording is **deliberately preserved, not fixed**: rewriting it is a
message flip nobody authorized, and P4 (which removes v3 acceptance) owns the
final version-error text. Record it in the Review log as a known, accepted wart.

#### D2-N3 — the input-declaration key set is closed; `required` / `default` are declaration keys, not schema keywords {#d2-n3}

D2 requires "unknown keys in a declaration are rejected", but
`checkJsonSchemaDefinition` (`src/core/json-schema.ts:190`) deliberately
**ignores** unrecognized keywords ("matching JSON Schema's own open-keyword
behavior", `:60-64` and `:188-192`). A closed key set therefore has to be
enforced by the v4 parser, above the schema checker — not by changing
`json-schema.ts`, which stays untouched.

**Binding resolution.**

- `TASK_INPUT_DECLARATION_KEYS` (exported from
  `src/tasks/source/task-source-v4.ts`) is the exact, closed allowlist for a
  declaration's **root** object:
  `["type", "enum", "properties", "required", "items", "additionalProperties",
  "minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum",
  "allOf", "anyOf", "oneOf", "not", "title", "description", "default"]`.
  The subset keywords are single-sourced from
  `JSON_SCHEMA_SUBSET_SUPPORTED_KEYWORDS` (`src/core/json-schema.ts:99`) — the
  parser derives the list from that constant rather than restating it, and a
  test asserts the derivation still covers every keyword the constant names.
- At the declaration **root**, `required` is the v4 boolean flag (`required: true`),
  **not** JSON Schema's `required` array. `required` must be a boolean there;
  `required: false` is accepted and means the same as omitting it.
- `default` and root-level `required` are **stripped** before the remainder is
  handed to `checkJsonSchemaDefinition` (definition time) and
  `validateJsonSchemaSubset` (value time). `default` is an annotation the
  subset validator already ignores (`json-schema.ts:185-192`); stripping it is
  about the closed-key check, not about semantics.
- **Nested** objects inside `properties` / `items` / `allOf` / … keep full JSON
  Schema meaning: `required` there is an array, `default` there is an ordinary
  annotation, and the closed-key check does **not** apply — nesting is checked
  only by `checkJsonSchemaDefinition`, exactly as `akm.outputSchema` is today
  (`source-v3.ts:458-466`).
- `default` **must itself satisfy its declaration**: the parser runs
  `validateJsonSchemaSubset(default, strippedSchema)` and raises
  `TASK_SOURCE_INVALID` on any error, path-prefixed at
  `inputs.<name>.default`.
- `default` together with `required: true` is a `TASK_SOURCE_INVALID` error, per
  D2.
- Input name grammar is `PROGRAM_PARAM_NAME_PATTERN` (§D3-N1); the input count
  bound reuses `WORKFLOW_MAX_PARAMS` (`src/workflows/resource-limits.ts:11`,
  = 128) and each declaration's serialized size bound reuses
  `WORKFLOW_MAX_SCHEMA_BYTES` (`:14`, = 256 KiB), matching
  `parseParams` (`src/workflows/parser.ts:549-580`).
- Secret-shaped `default` values warn through the **existing**
  `detectSecretShapedParams` (`src/workflows/exec/param-secrets.ts:91`) — the
  same function `src/tasks/prepare/prepare-support.ts:22,40` already imports —
  emitted with `warn()` (`src/core/warn.ts:134`). WARN only; never an error.

#### D2-N4 — one bounded-document front end, two source labels {#d2-n4}

v3's bounded YAML front end and its field helpers are all file-private in
`src/tasks/source-v3.ts` (`cloneBoundedJson`, `asRecord`, `checkKeys`,
`stringField`, `presentJsonValue`, `own`, `utf8Bytes`, `wellFormedUnicode`,
`noGithubExpression`, `parseEnvironment`, `nullableSelector`, `parseTimeout`,
`parseStringArray`, `parseTools`, `validateWorkingDirectory`, `sourceError`,
`yamlProblem`, `yamlAstError`, and the `TASK_V3_MAX_*` bounds). v4 needs every
one of them. Copying them is exactly the drift P1b's §4.3 removed elsewhere.

**Binding resolution.** They move **body-intact** to
`src/tasks/source/bounded-document.ts` and `source-v3.ts` imports them
(§3.1). `sourceError` gains a `sourceLabel` field on its context:

- v3 passes `"task v3 source"` → `Invalid task v3 source at <path>[:<line>]: <field> <detail>` — **byte-identical to today** (`source-v3.ts:210-226`).
- v4 passes `"task source v4"` → `Invalid task source v4 at <path>[:<line>]: <field> <detail>`.

The same parameterization applies to `parseTaskV3Yaml`'s pre-funnel
`INVALID_FLAG_VALUE` messages (`source-v3.ts:894-935`: `Invalid task v3 source
at <path>: source must be a string.` / `… exceeds the 1 MiB …` / `… YAML parsing
failed: …` / `… unsupported YAML construct: …` / `… YAML expansion failed: …`)
and to `assertBoundedTaskYamlDocument`'s `sourceLabel` option, which already
exists (`source-v3.ts:818-882`). Every v3 rendering stays byte-identical;
`tests/tasks/source-v3.test.ts` must pass **unchanged**.

Note the code split is preserved as-is for v4 too: YAML syntax/size/structure/
expansion failures raise `INVALID_FLAG_VALUE`; everything through the
`sourceError` funnel raises `TASK_SOURCE_INVALID`. This is the split the
`[Unreleased]` CHANGELOG already documents for v3, and P2a does not change it.

#### D2-N5 — per-binding `enabled` is an additive, defaulted field on the scheduler seam {#d2-n5}

v3 has one document-level `akm.enabled`; `compileTaskSchedulerBindings`
(`src/tasks/scheduler-binding.ts:166-187`) applies it to every compiled binding
(`:182`, `enabled: input.enabled`) and `SchedulerSourceSchedule`
(`:41-45`) carries no per-entry flag. v4 has a per-binding `enabled` and **no**
document-level one.

**Binding resolution.** `SchedulerSourceSchedule` gains an **optional**
`enabled?: boolean`; `compileTaskSchedulerBindings` resolves each binding as
`schedule.enabled ?? input.enabled`. v3 never sets the field, so every v3
projection is byte-identical and `tests/tasks/scheduler-binding.test.ts` /
`tests/integration/tasks-scheduler-sync-v3.test.ts` stay green **unchanged**. A
v4 document passes document-level `enabled: true` and lets each entry decide.

A disabled v4 binding is **compiled and disabled**, not omitted — that is v3's
existing semantics for `akm.enabled: false` and the semantics the sync
reconciler and `setEnabledInYaml` (`src/commands/tasks/tasks.ts:1512`) are
built around. Do not silently drop it.

#### D2-N6 — absent `schedule:` projects as manual-only, and R-06 is scoped, not flipped {#d2-n6}

A v4 document with no `schedule:` projects to
`triggers = { manual: true, schedules: [] }` (§3.5). `manual: true` is the
existing v3 spelling for "`workflow_dispatch` was declared, no cron"
(`source-v3.ts:619-633`), so no consumer learns a new shape.
`compileTaskSchedulerBindings` maps an empty `schedules` array to an empty
binding list (`:172-186`, a bare `.map`, no throw), so `akm task sync` emits no
OS entry and records no failure — the "SKIPS it silently" clause of D2, obtained
without touching `scheduler-sync.ts`'s loop.

**R-06 is NOT flipped.** `docs/plans/specs/p0-invariants.md:78` marks R-06
"Replaced by **P2a**", and
`tests/integration/tasks-scheduling-characterization.test.ts:11-16` says P2a
"deliberately makes the schedule optional". Both are **scoped to v4**: a
`version: 3` document that declares neither `akm.schedule` nor `on:` still
fails with the byte-identical `must declare exactly one scheduling source:
akm.schedule or on.` text, and all three tests in that file stay green
unchanged. See §6's F-0 row, which records this explicitly as instructed.

#### D2-N7 — every `akm.*` member that D2 does not re-home survives as a top-level v4 key {#d2-n7}

D2 says "the `akm:` options bag is GONE in v4 (**its members are top-level**)"
and then names `timeout`, `engine`, `model`, `redact`, `env`, `shell`,
`working-directory`, `maxSteps`, `maxRetries`, re-homing `schedule` →
`schedule:`, `enabled` → per-binding, `description` → top-level `description`,
and `outputSchema` → `output`. That leaves four `AKM_KEYS` members
(`source-v3.ts:158-174`) unmentioned: `when_to_use`, `tags`, `agent`,
`inference`, and `tools`.

**Binding resolution.** They survive as top-level v4 keys with **identical
validation and identical projection**. Dropping them would silently remove
authorable behavior (and would strand P2b's v3 → v4 migrator, which must be
lossless). The exported top-level key set is therefore, exactly:

```
TASK_SOURCE_V4_TOP_LEVEL_KEYS = [
  "version", "name", "description", "when_to_use", "tags",
  "inputs", "output",
  "uses", "run", "with", "env", "shell", "working-directory",
  "schedule",
  "agent", "engine", "model", "inference", "tools",
  "timeout", "redact", "maxSteps", "maxRetries",
]
```

`env`, `shell`, and `working-directory` keep v3's top-level position and v3's
field matrix (`shell` / `working-directory` are legal only with `run:`;
`with:` is legal only with `uses:` — narrowed further by D2-N1).

#### D3-N1 — `PROGRAM_PARAM_NAME_PATTERN` moves down; `src/execution/**` must not import `src/workflows/**` {#d3-n1}

Verified at head: `src/execution/**` imports **nothing** from
`src/workflows/**`; the dependency is one-way `workflows → execution`
(`src/workflows/exec/unit-dispatch.ts:6-12`,
`src/workflows/exec/lowering-notices.ts:5`, `src/workflows/exec/frozen-judge.ts:44`).
`tests/architecture/import-cycle-ratchet.test.ts` runs a **shrink-only, empty**
baseline and counts type-only imports as real edges, so
`execution/input-contract.ts → workflows/program/schema.ts` would close a cycle
the moment `workflows/ir/params.ts` imports back.

**Binding resolution.**

- `PROGRAM_PARAM_NAME_PATTERN` is **defined** in
  `src/execution/input-contract.ts` as `INPUT_NAME_PATTERN`, and
  `src/workflows/program/schema.ts:100` becomes a re-export
  (`export { INPUT_NAME_PATTERN as PROGRAM_PARAM_NAME_PATTERN } from "…"`) so
  its four existing importers (`ir/params.ts:21`, `ir/schema.ts:8`,
  `parser.ts:45`, and the pattern's own module) keep compiling and every
  message stays byte-identical.
- `input-contract.ts` must not import `src/workflows/**` at all — not for the
  pattern, not for limits, not for canonical JSON (see D3-N2). Permitted
  imports: `node:crypto`, `src/core/errors`, `src/core/json-schema`,
  and `src/execution/**`. The module keeps `params.ts`'s header property:
  *"Pure module: no IO, no engine imports."*

#### D3-N2 — `canonicalInputHash()` implements canonical JSON locally, byte-equal to `canonicalJson` {#d3-n2}

`canonicalJson` (`src/workflows/ir/plan-hash.ts:32`) is the repo's canonical
sorted-key JSON, but `plan-hash.ts` also imports `./schema-v4` and
`../resource-limits`, so importing it would drag workflow IR into
`src/execution/**` and violate D3-N1.

**Binding resolution.** `input-contract.ts` implements the same recursive
key-sort + `JSON.stringify` locally (a ~10-line pure helper) and computes
`sha256` hex with `node:crypto`, matching `computePlanHash`'s shape
(`plan-hash.ts:21-23`). A test in `tests/execution/input-contract.test.ts`
asserts **byte equality** with `canonicalJson` over a fixture set covering
nested objects, arrays, `null`, unicode keys, and insertion-order permutations,
so the duplication cannot drift unnoticed. Reference the test from both
modules' headers.

#### D3-N3 — the generic flag materializer takes an injected message vocabulary {#d3-n3}

`materializeWorkflowParameterFlags` must keep its messages and codes
**byte-identical** (`params.ts:51-56,70-72,158,162`: `Unknown workflow parameter
"--<n>". Parameter flags must exactly match a declared workflow parameter.` /
`Declared parameters: …` / `This workflow declares no parameters.` /
`Workflow parameter "--<n>" <detail>.` / `Workflow parameter flags do not
satisfy the workflow's declared schemas:\n  - …`), with `UNKNOWN_FLAG` for the
first and `INVALID_FLAG_VALUE` for the rest. Task inputs need different nouns
and, per D2/Lane C, `INPUT_BINDING_INVALID` for value failures.

**Binding resolution.** `materializeInputFlags(contract, flags, diagnostics)`
takes an `InputFlagDiagnostics` record of exactly five formatters, each
returning a `UsageError`:

```
interface InputFlagDiagnostics {
  unknownFlag(name: string, declared: readonly string[]): UsageError;
  invalidValue(name: string, detail: string): UsageError;   // "<detail>." appended by the formatter, not the generic
  contractViolation(errors: readonly string[]): UsageError;
  duplicateNonArray(name: string): UsageError;
  malformedJson(name: string): UsageError;
}
```

`params.ts` supplies `WORKFLOW_PARAMETER_DIAGNOSTICS` reproducing today's five
strings and codes exactly; `src/tasks/source/task-input-diagnostics.ts` supplies
the task vocabulary. The generic function contains **no** literal user-facing
string. The coercion rules (`schemaTypes`, `coerceFlagValue`,
`materializeFlagValues`, `parseJsonFlag`) move body-intact, including the
comment at `params.ts:110-112` explaining why a union that permits `string`
keeps the user's exact text (`"001"` stays a string).

#### LC-N1 — a v4 task is not yet a workflow step target {#lc-n1}

`taskDispatch` (`src/workflows/ir/source-freeze-v4.ts:231`) freezes a
`uses: tasks/<ref>` step by calling `parseTaskV3Yaml` + `prepareTaskV3Execution`.
Routing it would require freezing an input contract into the plan, which is
`irVersion` work (**P3a**) gated on P2b's bindings.

**Binding resolution.** `taskDispatch` does **not** route in P2a. It gains an
explicit pre-parse guard: peek the source's `version` and, when it is `4`, throw
`UsageError`/`TASK_SOURCE_INVALID` naming the deferral, rather than falling
through to the v3 parser's `version must be exactly 3` (which would read as a
grammar error rather than an unsupported composition). Message (binding):

```
Workflow step "<id>" targets task <ref>, which uses task source v4. Composing a
task source v4 target from a workflow arrives in a later 0.9.x release; keep the
task at version 3 until then.
```

This is a **new** behavior row (B-24), not a flip: no test pins the current
outcome, because no v4 document could exist before this phase.

#### LC-N2 — shell completion needs no change {#lc-n2}

`src/commands/completions.ts` generates completions by walking the **real citty
tree** (`walkCommandTree`) plus a `FLAG_VALUES` table keyed by flag name
(`:41-48`). It enumerates no task flags by hand, and v4 input flags are
per-task and dynamic, so they are not enumerable at generation time.
**Binding resolution:** no edit to `completions.ts`, and
`tests/completions.test.ts` / `tests/integration/completions-install.test.ts`
must pass **unchanged**. Lane C's "update shell completion if it enumerates task
flags" is discharged by verifying it does not. Record the verification.

---

## 2. Behavior table (input → expected after P2a)

**PRESERVE** rows must be observably identical before and after. **NEW** rows
are behavior that could not previously exist (there is no v4 document at head).
**CHANGE** rows are the authorized flips, cross-referenced to §6.

| # | Input / situation | Expected after P2a | Evidence at head | Status |
|---|---|---|---|---|
| B-01 | `version: 3` document, any shape | parses byte-identically; same accept/reject set, same message bytes, same codes | `source-v3.ts:716-793` | PRESERVE |
| B-02 | `version: 3` with neither `akm.schedule` nor `on:` | `UsageError`/`TASK_SOURCE_INVALID`, `Invalid task v3 source at <path>:1: $ must declare exactly one scheduling source: akm.schedule or on.` | `source-v3.ts:640-643` | PRESERVE (R-06) — see §6 F-0 |
| B-03 | `version: 3` with **both** `akm.schedule` and `on:` | same byte-identical error as B-02 | `source-v3.ts:640-643` | PRESERVE (R-06) |
| B-04 | `version: 2` document | `UsageError`/`TASK_SCHEMA_VERSION_UNSUPPORTED`, `TASK_SCHEMA_VERSION_UNSUPPORTED: Task … uses task schema version 2 …` + the v2 migration hint | `source-v3.ts:49-57` | PRESERVE (D2-N2) |
| B-05 | `version: 5` / missing `version` | `TASK_SOURCE_INVALID`, `… version must be exactly 3.` / `… version is required and must be 3.` — **stale wording preserved on purpose** | `source-v3.ts:720-722` | PRESERVE (D2-N2, recorded wart) |
| B-06 | `version: 4`, `uses: commands/review`, no `schedule:` | parses; valid; runnable with `akm task run` | — | **NEW** |
| B-07 | `version: 4`, no `schedule:`, `akm task sync` | task contributes **zero** scheduler bindings, records **zero** failures, emits no diagnostic | `scheduler-binding.ts:172-186`, `scheduler-sync.ts:503-517` | **NEW** (D2-N6) |
| B-08 | `version: 4`, `schedule: "0 8 * * 1"` (string shorthand) | one binding, `enabled: true`, no inputs, `source: "schedule"`, `ordinal: 0` | — | **NEW** |
| B-09 | `version: 4`, `schedule:` list of N entries | N bindings, `ordinal` = list index, `source: "schedule[<i>].cron"`; N > `TASK_V3_MAX_SCHEDULES` (64) is `TASK_SOURCE_INVALID` | `source-v3.ts:40,609-611` | **NEW** |
| B-10 | `version: 4`, `schedule[i].enabled: false` | that binding compiles with `enabled: false`; siblings unaffected | `scheduler-binding.ts:182` | **NEW** (D2-N5) |
| B-11 | `version: 4` with an `akm:` key | `TASK_SOURCE_INVALID`, detail names the removal and points at the top-level spellings | — | **NEW** |
| B-12 | `version: 4` with an `on:` key | `TASK_SOURCE_INVALID`, detail names the removal and points at `schedule:` | — | **NEW** |
| B-13 | `version: 4`, `uses: actions/checkout@v4` (github locator) | `TASK_SOURCE_INVALID`, detail **names the removal** of the github-action target | `source-v3.ts:562-583` (v3 accepts it) | **NEW** |
| B-14 | `version: 4`, `uses: tasks/other` | `TASK_SOURCE_INVALID` — a task ref is not an executable v4 target | `target-ref.ts:40-44` classifies `tasks` but v4 rejects the kind | **NEW** |
| B-15 | `version: 4`, `uses: agents/x` / a non-canonical ref | `TASK_SOURCE_INVALID` (the `TARGET_REF_INVALID` from `classifyTargetRef` is re-coded through the v4 `sourceError` funnel, like v3 re-codes `classifyTaskV3Uses`) | `source-v3.ts:737-741`, `target-ref.ts:47-52` | **NEW** |
| B-16 | `version: 4`, both `uses:` and `run:` (or neither) | `TASK_SOURCE_INVALID`, `$ requires exactly one executable selector: uses or run.` (same detail text as v3) | `source-v3.ts:726` | **NEW** |
| B-17 | `version: 4`, `with:` on `uses: akm/command` | accepted; validated by the existing `parseBuiltinCommandAction`, identical accept/reject set to v3 | `source-v3.ts:747-753` | **NEW** (D2-N1) |
| B-18 | `version: 4`, `with:` on any other target | `TASK_SOURCE_INVALID`, detail points at `inputs:` | — | **NEW** (D2-N1) |
| B-19 | `version: 4`, `inputs.<name>` with an unknown key | `TASK_SOURCE_INVALID` at `inputs.<name>.<key>` | `json-schema.ts:60-64` (open-keyword) | **NEW** (D2-N3) |
| B-20 | `version: 4`, `inputs.<name>` with `default` **and** `required: true` | `TASK_SOURCE_INVALID` at `inputs.<name>` | — | **NEW** (D2-N3) |
| B-21 | `version: 4`, `inputs.<name>.default` violating its own declaration | `TASK_SOURCE_INVALID` at `inputs.<name>.default`, detail carries `validateJsonSchemaSubset`'s error text | `json-schema.ts:69-77` | **NEW** (D2-N3) |
| B-22 | `version: 4`, `inputs.<name>.default` that is secret-shaped | **warns** (same detector, same phrasing family as workflow params); parse still succeeds | `param-secrets.ts:91`, `runs.ts:359` | **NEW** (D2-N3) |
| B-23 | `version: 4`, `inputs` name failing `PROGRAM_PARAM_NAME_PATTERN`, or > `WORKFLOW_MAX_PARAMS` entries | `TASK_SOURCE_INVALID` | `parser.ts:556-575`, `resource-limits.ts:11` | **NEW** (D2-N3) |
| B-24 | workflow step `uses: tasks/<ref>` whose task source is `version: 4` | `UsageError`/`TASK_SOURCE_INVALID` with the LC-N1 deferral message | `source-freeze-v4.ts:231` | **NEW** (LC-N1) |
| B-25 | workflow step `uses: tasks/<ref>` with `with:` (v3 task) | `UsageError`/`COMPOSITION_INVALID`, P1a message verbatim | `source-freeze-v4.ts:225-230` | PRESERVE (P1a) |
| B-26 | `akm task run <id>` with no input flags, v3 or v4 task | run is **byte-identical** to today: same prepare, same dispatch, same history row, same exit code | `run/load-task.ts:60`, `run/run-task.ts` | PRESERVE |
| B-27 | `akm task run <id> --<undeclared>` | `UsageError`/`UNKNOWN_FLAG`, exit **2**, `{ok:false,error,code}` on stderr; detail lists declared inputs | `params.ts:47-58` (workflow analogue) | **NEW** |
| B-28 | `akm task run <id> --scope bogus` (violates the declaration) | `UsageError`/`INPUT_BINDING_INVALID`, exit **2** | — | **NEW** |
| B-29 | `akm task run <id>` omitting a `required: true` input | `UsageError`/`INPUT_BINDING_INVALID`, exit **2**, detail names the missing input | — | **NEW** |
| B-30 | `akm task run <id> --version 001` where `version` is declared `type: string` | value stays the **string** `"001"`; no numeric coercion | `params.ts:110-112` | **NEW** (shared with workflow params) |
| B-31 | `akm task run <id> --f a --f b` where `f` is declared `type: array` | array `["a","b"]`; a non-array declaration supplied twice is `INPUT_BINDING_INVALID` | `params.ts:83-98` | **NEW** |
| B-32 | `akm task run <id> --target x` | still the retired-flag usage error, unchanged — `--target` is **never** treated as an input | `tasks-cli.ts:44-58` (`rejectRetiredTaskTargetFlag`) | PRESERVE |
| B-33 | `akm task run --format json <id>` / `--bundle b` / `--scheduled` / `--quiet` | still parsed as their declared flags, **never** as inputs | `tasks-cli.ts:126-131`, `cli/shared.ts:163-205` | PRESERVE |
| B-34 | `akm workflow run <ref> --<param>` (every existing case) | byte-identical messages, codes, and coercion | `params.ts`, `workflow-cli.ts:232-289` | PRESERVE (D3) |
| B-35 | `validateWorkflowParams` / `assertRunParamsSatisfyPlan` on any input | byte-identical error strings, re-rooted at `params` | `params.ts:175-209` | PRESERVE (D3) |
| B-36 | `akm lint` on a `version: 4` source | validates through the router; a valid v4 source yields **no** diagnostic; an invalid one yields `invalid-task-yaml` with the v4 detail text | `akm-lint.ts:317` | **NEW** |
| B-37 | `akm show` / index metadata for a `version: 4` task | name / description / tags / when_to_use extracted from the v4 top-level keys | `akm-metadata.ts:242` | **NEW** |
| B-38 | `version: 4`, `schedule[i].inputs` supplied | validated against the declarations at parse time; **not delivered** to the scheduled run; `akm task sync` warns once per task that schedule inputs are not yet delivered; the compiled binding is **byte-identical** to one with no inputs | `scheduler-binding.ts:171` (fixed invocation tail) | **NEW** (§0 non-goal, P2b delivers) |
| B-39 | `canonicalInputHash(v)` | stable sha256 hex of canonical sorted-key JSON; **byte-equal** canonical string to `canonicalJson(v)` | `plan-hash.ts:21-33` | **NEW** (D3-N2) |
| B-40 | any v3 source through `akm task sync` | identical binding set, ids, ordinals, `source` strings, `enabled` values, and invocation tails | `scheduler-sync.ts:503-517`, `scheduler-binding.ts:166-187` | PRESERVE |

---

## 3. Lane A — task source v4, routing, and projection

### 3.1 Files

| File | Contents |
|---|---|
| `src/tasks/source/bounded-document.ts` (new) | The bounded-YAML front end and field helpers extracted **body-intact** from `source-v3.ts` (D2-N4): `assertBoundedTaskYamlDocument`, `cloneBoundedJson`, `asRecord`, `checkKeys`, `stringField`, `presentJsonValue`, `own`, `utf8Bytes`, `wellFormedUnicode`, `noGithubExpression`, `parseEnvironment`, `nullableSelector`, `parseTimeout`, `parseStringArray`, `parseTools`, `validateWorkingDirectory`, `sourceError`, `yamlProblem`, `yamlAstError`, `readBoundedTaskYaml` (the YAML → `{root, lineAt}` front end lifted from `parseTaskV3Yaml:894-952`), and the `TASK_V3_MAX_*` bounds. Every message is templated on a `sourceLabel`. |
| `src/tasks/source-v3.ts` (edited) | Imports the above; **re-exports** the `TASK_V3_MAX_*` constants and `assertBoundedTaskYamlDocument` at their existing names so no importer or test changes; keeps `parseTaskV3Document`, `parseTaskV3Yaml`, `classifyTaskV3Uses`, `classifyTaskV3Triggers`, `taskV2UnsupportedError`, `taskExtensionDetail`, `taskV3SourceErrorDetail` and every type export unchanged. No behavior change. |
| `src/tasks/source/task-source-v4.ts` (new) | `TASK_SOURCE_V4_VERSION`, `TASK_SOURCE_V4_TOP_LEVEL_KEYS`, `TASK_SOURCE_V4_SCHEDULE_KEYS`, `TASK_INPUT_DECLARATION_KEYS`, `TaskSourceV4Document` + sub-types, `classifyTaskSourceV4Uses()`, `parseTaskSourceV4Document()`, `parseTaskSourceV4()`. |
| `src/tasks/source/task-input-diagnostics.ts` (new) | `TASK_INPUT_DIAGNOSTICS`: the task vocabulary for `InputFlagDiagnostics` (D3-N3). |
| `src/tasks/source/parse-task-source.ts` (new) | `ParsedTaskSource` union, `parseTaskSource()`, `peekTaskSourceVersion()`. |
| `src/tasks/source/project-v4.ts` (new) | `projectTaskSourceV4()` → `PreparableTaskDocument`. |
| `src/tasks/prepare/prepared-execution.ts` (edited) | `export type PreparableTaskDocument = TaskV3SourceDocument;` — a name for the prepare seam's input that is not version-bound. Type alias only; P4 renames the underlying type. |
| `tests/tasks/task-source-v4.test.ts` (new) | grammar: accept/reject matrix, message bytes, codes, bounds. |
| `tests/tasks/parse-task-source.test.ts` (new) | the D2-N2 routing table, including both preserved version errors. |
| `tests/tasks/project-v4.test.ts` (new) | projection table of §3.5, incl. the manual-only shape and per-binding `enabled`. |
| `tests/tasks/bounded-document.test.ts` (new) | the extracted front end renders both source labels; v3's renderings are byte-identical to the strings `tests/tasks/source-v3.test.ts` already pins. |

### 3.2 The grammar

`TaskSourceV4Document` (all fields deep-frozen, mirroring `TaskV3SourceDocument`):

```
interface TaskSourceV4Document {
  readonly version: 4;
  readonly name?: string;
  readonly description?: string;
  readonly when_to_use?: string;
  readonly tags?: readonly string[];
  readonly inputs?: InputContract;                     // src/execution/input-contract.ts
  readonly output?: Readonly<Record<string, unknown>>; // bounded JSON Schema
  readonly target: TaskSourceV4Target;                 // uses | run, see below
  readonly env?: TaskV3Environment;
  readonly execution: TaskSourceV4Execution;           // agent/engine/model/inference/tools/timeout/redact/maxSteps/maxRetries
  readonly schedule: readonly TaskSourceV4ScheduleBinding[];  // [] when absent
  readonly manualOnly: boolean;                        // schedule.length === 0
  readonly source: Readonly<{ path: string }>;
}

type TaskSourceV4Target =
  | Readonly<{ kind: "uses"; uses: TaskSourceV4UsesTarget; with?: ExecutionJsonObject; command?: ParsedBuiltinCommandAction }>
  | Readonly<{ kind: "run"; run: string; shell?: TaskV3HostShell; workingDirectory?: string }>;

type TaskSourceV4UsesTarget =
  | Readonly<{ kind: "builtin-command"; ref: "akm/command" }>
  | Readonly<{ kind: "command" | "script" | "workflow"; ref: string }>;

interface TaskSourceV4ScheduleBinding {
  readonly cron: string;
  readonly enabled: boolean;      // default true
  readonly inputs: Readonly<Record<string, unknown>>;  // {} when absent
  readonly source: string;        // "schedule" | "schedule[<i>].cron"
  readonly ordinal: number;
}
```

Field rules, in the order the parser applies them:

1. Top-level keys are checked against `TASK_SOURCE_V4_TOP_LEVEL_KEYS` (D2-N7).
   `akm` and `on` are **not** in the set; their rejection details name the
   removal explicitly (B-11, B-12) rather than the generic unknown-key text.
2. Exactly one of `uses:` / `run:` (B-16), reusing v3's detail text verbatim.
3. `shell` / `working-directory` only with `run:`; `with:` only with
   `uses: akm/command` (D2-N1). `working-directory` is validated by the
   extracted `validateWorkingDirectory`, so the workspace-root containment rule
   and its messages are unchanged.
4. `uses:` classification (§3.3).
5. `inputs:` → `InputContract` (D2-N3).
6. `output:` → `checkJsonSchemaDefinition`, same as v3's `akm.outputSchema`
   (`source-v3.ts:458-466`), detail text re-rooted at `output`.
7. `schedule:` (§3.4), including `schedule[i].inputs` validated against the
   declarations via `validateInputs()` (B-38).
8. Execution controls: `agent`/`engine`/`model` through `nullableSelector`,
   `inference` through `asRecord`, `tools` through `parseTools`, `timeout`
   through `parseTimeout`, `redact` through `parseStringArray` with
   `WORKFLOW_MAX_EXEC_PASS_ENV` + `WORKFLOW_ENV_VAR_NAME_PATTERN` + the
   duplicate check, `maxSteps`/`maxRetries` with v3's bounds — every one of
   them the **same extracted helper** v3 calls, so accept/reject sets and
   detail texts match v3's by construction.

### 3.3 `classifyTaskSourceV4Uses()`

```
classifyTaskSourceV4Uses(value: string): TaskSourceV4UsesTarget
```

- `"akm/command"` → `{ kind: "builtin-command", ref: "akm/command" }`.
- otherwise delegate to `classifyTargetRef` (`src/execution/target-ref.ts:55`)
  — the P1a classifier is the repo's one canonical-ref classifier and P2a adds
  no second one:
  - `command` / `script` / `workflow` → the corresponding v4 kind;
  - `task` → `TASK_SOURCE_INVALID`, "a task ref is not an executable task
    target" (B-14);
  - `classifyTargetRef`'s `TARGET_REF_INVALID` throw is caught and re-raised
    through the v4 `sourceError` funnel at field path `uses`, exactly as v3
    wraps `classifyTaskV3Uses` (`source-v3.ts:737-741`) — so the *envelope*
    code a user sees for a bad `uses:` is `TASK_SOURCE_INVALID` (B-15).
- A value matching the github locator shape (`owner/repo[/path]@rev`) is
  detected **before** the generic invalid-ref message and gets its own detail
  naming the removal (B-13). Reuse the shape test, not the full v3 grammar: it
  exists only to produce a good message, never to accept.
- **No** `${{ }}` expressions, no local (`./action`) or Docker
  (`docker://`) targets — v3's rejections carry over via the same
  `noGithubExpression` helper and the classifier's canonical-ref requirement.

### 3.4 The router

`src/tasks/source/parse-task-source.ts`:

```
type ParsedTaskSource =
  | Readonly<{ version: 3; v3: TaskV3SourceDocument }>
  | Readonly<{ version: 4; v4: TaskSourceV4Document }>;

function parseTaskSource(input: { yaml: string; filePath: string; workspaceRoot?: string }): ParsedTaskSource;
function peekTaskSourceVersion(root: unknown): number | undefined;
```

The router runs the bounded YAML front end **once**
(`readBoundedTaskYaml`, giving `{root, lineAt}`), reads `root.version`, and
dispatches per D2-N2's table into `parseTaskV3Document` / `parseTaskSourceV4Document`
with that same `{root, lineAt}` — **no second parse, no re-serialization, no
synthetic document**. The pre-funnel `INVALID_FLAG_VALUE` failures (source not a
string, source too large, YAML parse/warning/expansion) happen inside the front
end and therefore render with the **v3** label when the version is unknown at
that point; that is byte-identical to today and is the reason the label is chosen
after, not before, the front end runs. Concretely: front-end failures always
render `Invalid task v3 source at …` in P2a. Record this in the Review log —
P4 owns the final label once v3 is gone.

`parseTaskV3Yaml` stays exported and byte-identical for the call sites that do
not route (§3.6) and for its test importers.

### 3.5 `projectTaskSourceV4()` — the prepare seam

`prepareTaskV3Execution` (`src/tasks/prepare/prepare.ts`) is **not** modified in
P2a. Instead `projectTaskSourceV4(doc)` returns a `PreparableTaskDocument`
(= `TaskV3SourceDocument`) built by a pure, typed function — **no YAML string is
fabricated and nothing is re-parsed** (this is the invariant P1b §4.3
established when it deleted `directScript`'s synthetic document; a grep for a
synthetic `version: 3\nuses:` string must still return zero hits in `src/`).

| v4 | projected `PreparableTaskDocument` |
|---|---|
| `version: 4` | `version: 3` — the prepare contract's literal discriminant. Recorded in the Review log; P4 retires it with the type rename. |
| `name` | `name` |
| `target` (`uses`/`run`, `with`, `shell`, `working-directory`) | `target`, identical shapes |
| `env` | `env` |
| `description` | `akm.description` |
| `when_to_use` / `tags` / `agent` / `engine` / `model` / `inference` / `tools` / `timeout` / `redact` / `maxSteps` / `maxRetries` | `akm.<same name>` |
| `output` | `akm.outputSchema` |
| `schedule[]` | `triggers.schedules[]` — `{cron, source, ordinal}` per entry |
| `schedule.length > 0` | `triggers.manual = false` |
| `schedule.length === 0` | `triggers = { manual: true, schedules: [] }` (D2-N6) |
| per-entry `enabled` | **not** projected into `akm.enabled`; carried separately to the scheduler seam (§5.2, D2-N5) |
| `inputs` | **not** projected (delivery is P2b, §0) |
| `schedule[i].inputs` | **not** projected (B-38) |

The projection is deep-frozen and total: every v4 document that parses projects
without throwing. A test asserts that for the whole v4 fixture set.

### 3.6 Routing call sites

Verified call sites of `parseTaskV3Yaml` in `src/` and their P2a disposition:

| Call site | Disposition |
|---|---|
| `src/tasks/run/load-task.ts:60` | **ROUTE** — `akm task run` |
| `src/tasks/scheduler-sync.ts:480` | **ROUTE** — `akm task sync` (§5.2) |
| `src/core/adapter/adapters/akm-lint.ts:317` | **ROUTE** — `akm lint` |
| `src/core/adapter/adapters/akm-task-adapter.ts:99,164` | **ROUTE** — detection + validation |
| `src/core/adapter/adapters/akm-metadata.ts:242` | **ROUTE** — indexed metadata (§B-37) |
| `src/commands/tasks/tasks.ts:189` | **ROUTE** — the task read path shared by mutation commands |
| `src/commands/proposal/validators/proposal-validators.ts:76` | **ROUTE** — proposal validation |
| `src/tasks/embedded.ts:92` | **STAYS on `parseTaskV3Yaml`** — akm's own bundled task assets, authored at `version: 3` by this repo and not re-authored in P2a |
| `src/setup/steps/tasks.ts:137,196` | **STAYS** — same bundled assets, installed by `akm setup` |
| `src/workflows/ir/source-freeze-v4.ts:231` | **STAYS**, plus the LC-N1 guard |

Every routed call site consumes the union and must handle **both** arms. Where
a consumer needs one shape (e.g. `scheduler-sync` needs a preparable document),
it calls `projectTaskSourceV4` on the v4 arm. No routed call site may
`throw`/`assert` on the v4 arm.

---

## 4. Lane B — `src/execution/input-contract.ts`

### 4.1 Files

| File | Contents |
|---|---|
| `src/execution/input-contract.ts` (new) | The generalized module (§4.2). Header keeps `params.ts`'s *"Pure module: no IO, no engine imports"* line and names this spec, D3-N1, and D3-N2. |
| `src/workflows/ir/params.ts` (edited) | Thin consumer (§4.3). |
| `src/workflows/program/schema.ts` (edited) | `PROGRAM_PARAM_NAME_PATTERN` becomes a re-export of `INPUT_NAME_PATTERN` (D3-N1). |
| `tests/execution/input-contract.test.ts` (new) | Generic behavior + the D3-N2 canonical-JSON byte-equality fixture set. |

### 4.2 Exported surface

```
const INPUT_NAME_PATTERN: RegExp;                    // === today's PROGRAM_PARAM_NAME_PATTERN

interface InputDeclaration {                          // one input's declaration
  readonly schema: Readonly<Record<string, unknown>>; // the bounded JSON Schema, `default`/root `required` stripped
  readonly default?: unknown;
  readonly required: boolean;
}
type InputContract = Readonly<Record<string, InputDeclaration>>;

interface InputFlag { name: string; value: string | boolean }

type TaskInputBinding =                               // DECLARED here for P2b
  | Readonly<{ kind: "literal";  name: string; value: unknown }>
  | Readonly<{ kind: "reference"; name: string; from: string }>;

interface InputFlagDiagnostics { /* the five formatters of D3-N3 */ }

function applyInputDefaults(contract: InputContract, values: Record<string, unknown>): Record<string, unknown>;
function validateInputs(contract: InputContract, values: Record<string, unknown>, options?: { readonly pathRoot?: string }): string[];
function materializeInputFlags(contract: InputContract, flags: readonly InputFlag[], diagnostics: InputFlagDiagnostics): Record<string, unknown>;
function canonicalInputJson(value: unknown): string;
function canonicalInputHash(value: unknown): string;
```

Semantics:

- `applyInputDefaults` returns a **new** object: supplied values win; a declared
  input absent from `values` and carrying a `default` takes it; a declared input
  absent with no default is left absent (missing-required is `validateInputs`'
  job, not this function's).
- `validateInputs` builds the same synthetic object schema `validateWorkflowParams`
  builds (`params.ts:175-195`: `{type:"object", properties: <schemas>}`), maps
  `$` → `pathRoot` (default `"$"`), and **additionally** appends one
  `<pathRoot>.<name>: is required` string per declared-required input missing
  from `values`. Workflow params declare nothing required, so the wrapper's
  output is unchanged (§4.3).
- `materializeInputFlags` is `materializeWorkflowParameterFlags`' body with every
  literal string replaced by a `diagnostics` call and the plan lookup replaced by
  the contract (`declared = Object.keys(contract)`, `schema = contract[name].schema`).
  Exact-name matching, array grouping, JSON-array shorthand, repeated-flag
  rejection for non-array declarations, and the string-preserving coercion are
  all unchanged. It ends by running `validateInputs` and raising
  `diagnostics.contractViolation(errors)` when non-empty.
- `canonicalInputJson` / `canonicalInputHash` per D3-N2.

### 4.3 `params.ts` as a thin consumer

`params.ts` keeps **every** existing export name and signature:
`WorkflowParameterPlan`, `WorkflowParameterFlag`,
`materializeWorkflowParameterFlags`, `validateWorkflowParams`,
`assertRunParamsSatisfyPlan`. It adds one private
`contractFromPlan(plan): InputContract` (`{schema: plan.paramSchemas?.[name] ?? {},
required: false}` for every name in `plan.params ?? Object.keys(plan.paramSchemas ?? {})`)
and one private `WORKFLOW_PARAMETER_DIAGNOSTICS`.

Binding constraints:

- `WorkflowParameterFlag` may be an alias of `InputFlag` but keeps its name —
  `src/commands/workflow-cli.ts:19,232-233` imports it by that name.
- `validateWorkflowParams(plan, params)` returns
  `validateInputs(contractFromPlan(plan), params, { pathRoot: "params" })` and
  must return `[]` for an empty/absent `paramSchemas` (`params.ts:176-177`'s
  early return) — a plan with no schemas must not start emitting
  `properties: {}` noise.
- `materializeWorkflowParameterFlags(plan, flags)` returns `{}` for zero flags
  (`params.ts:41`) before anything else, then delegates.
- `assertRunParamsSatisfyPlan` is unchanged, including its long message.
- **`tests/workflows/workflow-param-flags.test.ts` (93 lines) and
  `tests/integration/workflows/params-validation.test.ts` (206 lines) must pass
  with ZERO diff.** They are the canary for this lane; run them green before
  and after each commit of it.

### 4.4 Model-type declarations (types only)

- `src/tasks/model/invocation.ts`: `TaskInvocation` gains
  `readonly inputs?: readonly TaskInputBinding[]` (type-only import from
  `src/execution/input-contract`). The model purity ratchet
  (`tests/tasks/parse-v3-adapter.test.ts:423-439`) forbids
  fs/db/network/storage/integration imports; `src/execution/**` is not on that
  list and the import is type-only, so the ratchet stays green with **no
  baseline change**.
- `src/tasks/model/definition.ts` is **not** modified. `TaskDefinition` gains no
  `inputs`/`output` in P2a; P2b widens it when it widens the adapter.
- No new file joins the purity ratchet's file list, and none is removed from it.

---

## 5. Lane C — CLI, scheduler seam, schema, docs

### 5.1 `akm task run` input flags

Mirror `akm workflow run`'s two-stage design exactly (`workflow-cli.ts:170,193`
→ `runs.ts:274`): the CLI captures **raw** flags and carries them to the
boundary that knows the declarations; coercion happens once, there.

**Stage 1 — capture (`src/commands/tasks/tasks-cli.ts`).**
`parseTaskInputFlags(rawArgs, id): InputFlag[]`, modeled on
`parseWorkflowParameterFlags` (`workflow-cli.ts:232-289`) and living beside it in
spirit, with these value/boolean sets:

```
TASK_RUN_VALUE_FLAGS   = ["bundle", "format", "detail", "shape", "output"]
TASK_RUN_BOOLEAN_FLAGS = ["scheduled", "quiet", "verbose", "help", "no-quiet", "no-verbose"]
```

- Input flags must come **after** the task id, with the same error text shape as
  workflow run's positional rule (B-33).
- `--target` is handled by the existing `rejectRetiredTaskTargetFlag()` **before**
  input capture and is never an input (B-32).
- A bare `--` is rejected, as on `workflow run`.
- The captured flags ride on `akmTasksRun`'s options as
  `inputFlags?: readonly InputFlag[]`.

**Stage 2 — materialize (`src/tasks/run/load-task.ts`).** After
`parseTaskSource` returns, the loader builds the contract (v4: the document's
`inputs`; v3: the empty contract) and calls
`materializeInputFlags(contract, options.inputFlags ?? [], TASK_INPUT_DIAGNOSTICS)`,
then `applyInputDefaults`, then `validateInputs` for the required check. The
result becomes `readonly TaskInputBinding[]` of `kind: "literal"` on the
`TaskInvocation` the run constructs. **Nothing consumes the values in P2a** —
see §0.

Codes, binding: unknown name → `UNKNOWN_FLAG`; every value/contract failure →
`INPUT_BINDING_INVALID`. Both surface as `{ok:false,error,code}` on stderr with
exit **2** (`EXIT_CODES`, AGENTS.md "CLI Contract"). A v3 task with an empty
contract therefore rejects **any** input flag with `UNKNOWN_FLAG` — the correct
outcome, and it is the reason capture must not silently swallow unknown tokens.

`RunTaskOptions` gains `inputFlags?: readonly InputFlag[]` (optional — every
existing caller and every test call site keeps today's behavior untouched, the
same pattern P1b used for `provenance`).

### 5.2 Scheduler seam

- `src/tasks/scheduler-binding.ts`: `SchedulerSourceSchedule` gains
  `readonly enabled?: boolean`; `compileTaskSchedulerBindings:182` becomes
  `enabled: schedule.enabled ?? input.enabled`. Nothing else in the file
  changes; the invocation tail (`:171`) is untouched, so binding signatures and
  native ids are byte-stable (D2-N5).
- `src/tasks/scheduler-sync.ts:480-517`: route through `parseTaskSource`;
  on the v4 arm call `projectTaskSourceV4` before `prepareTaskV3Execution` (so
  projectability is checked identically), pass
  `enabled: true` at the document level, and map each entry to
  `{cron, source, ordinal, enabled}`. The `source` string keeps its existing
  `<relpath>:<field>` composition (`:509-512`).
- A v4 document whose `schedule[i].inputs` is non-empty triggers one
  `warn()` per task naming that schedule inputs are declared but not yet
  delivered (B-38).
- **`tests/integration/tasks-scheduler-sync-v3.test.ts` (897 lines) must pass
  with ZERO diff.**

### 5.3 `schemas/akm-task.json`

Keep the file at its existing path — `tests/release-check.sh:139` lists
`package/schemas/akm-task.json` in the npm candidate tar gate, alongside
`package/docs/reference/tasks.md` and `package/docs/reference/workflow-schema.md`.

The published schema becomes a **two-arm `oneOf`** so an editor validates both
grammars during the deprecation window:

- arm 1: today's v3 object, moved under the arm **unchanged** (`version: {const: 3}`);
- arm 2: the v4 object — `version: {const: 4}`, `additionalProperties: false`,
  `properties` exactly `TASK_SOURCE_V4_TOP_LEVEL_KEYS`, the `uses` `oneOf`
  **without** the `githubActionRef` arm, `schedule` as
  `oneOf[nonemptyLiteral, array(minItems 1, maxItems TASK_V3_MAX_SCHEDULES, items
  {cron, enabled?, inputs?} additionalProperties:false)]`, `inputs` as a
  `propertyNames`-patterned object of declarations closed to
  `TASK_INPUT_DECLARATION_KEYS`, and `output` reusing the existing
  `outputSchema` grammar definition.
- `title` / `description` / `x-akm-runtimeConstraints.authoritativeParser`
  updated to name both parsers (`src/tasks/source-v3.ts` and
  `src/tasks/source/task-source-v4.ts`). Keep every existing numeric constraint
  value — the drift test asserts them against the same exported constants.

`tests/integration/tasks-schema.test.ts` is rewritten in the **same commit** as
the schema and the constants (§6 F-1). Its v4 assertions must be derived from
the exported constants (`TASK_SOURCE_V4_VERSION`,
`TASK_SOURCE_V4_TOP_LEVEL_KEYS`, `TASK_SOURCE_V4_SCHEDULE_KEYS`,
`TASK_INPUT_DECLARATION_KEYS`, `TASK_V3_MAX_SCHEDULES`, `TASK_V3_HOST_SHELLS`,
`WORKFLOW_MAX_PARAMS`, `WORKFLOW_MAX_RETRIES`, `WORKFLOW_MAX_EXEC_PASS_ENV`,
`EXECUTION_MAX_TIMEOUT_MS`) — never from literals restated in the test.

### 5.4 Docs

- **`docs/reference/tasks.md`** documents task source v4 as the current
  grammar: `version: 4`, `inputs:`, `output:`, optional `schedule:` (with the
  string shorthand), top-level execution controls, the `akm:` / `on:` removal,
  the github-action target removal, and `akm task run`'s input flags. It states
  plainly that `version: 3` sources still parse and run **until a later
  release**, and links the migration path (P2b's migrator) as forthcoming. Every
  `akm …` example must pass `bun scripts/lint-doc-examples.ts` — the linter
  parses each fenced `akm` invocation against the real citty tree, so an example
  such as `akm task run nightly --scope all` will be checked flag-by-flag;
  dynamic per-task input flags are **not** declared on the command, so those
  examples need the linter's documented `# doclint:ignore` marker on the line.
  Prefer at most one such example, and say in prose why the flag names are
  task-specific.
- **`CHANGELOG.md` `[Unreleased]` → "Breaking changes & migration"** gets the
  task-source-v4 entry, stating: task source **v4** exists and `version: 3`
  still parses in this release; scheduling is **optional** in v4 and a v4 task
  with no `schedule:` is skipped by `akm task sync` instead of failing to parse;
  the `akm:` options bag and the `on:` trigger block are **gone** in v4, with
  their members re-homed top-level (list the mapping, including
  `akm.outputSchema` → `output` and `akm.enabled` → per-schedule `enabled`);
  the **github-action `uses:` target is removed** in v4 (still recognized-and-
  rejected in v3); `akm task run` accepts exact-name input flags for a v4 task's
  declared `inputs:`, which are **validated but not yet delivered** to the
  target; and a v4 task cannot yet be the target of a workflow step (LC-N1).
- Docs that state "every task must declare `version: 3`" or "exactly one trigger
  source" as universal rules (`docs/reference/tasks.md:4,11,17`,
  `docs/reference/supported-formats.md`, `docs/reference/cli.md`,
  `docs/architecture/adapters.md`) are corrected to scope those statements to
  v3. Do **not** add anchors to `docs/architecture/architecture.md`'s
  "## Module Boundaries" section — `tests/contracts/module-boundaries.test.ts`
  locks that list and P2a moves nothing on it.
- `tests/fixtures/format-family-goldens/akm-task/lint.json`'s prose fields
  (`realWorldSource`, `adapterStatus`) may be updated to name both parsers.
  They are specification prose, not asserted output; updating them is optional
  and, if done, is a docs-only diff.

---

## 6. AUTHORIZED-FLIPS table

Nothing outside this table may change observably. Every affected existing test
is enumerated by file.

### F-0 — R-06 is **scoped**, not flipped (recorded here as instructed)

| Test (file at head) | P0 row | Disposition |
|---|---|---|
| `tests/integration/tasks-scheduling-characterization.test.ts:45` (neither source) | R-06 | **UNCHANGED, must stay green.** The rule is a **v3** rule and P2a does not touch v3's `compileTriggers` (`source-v3.ts:636-651`). |
| `…:57` (both sources) | R-06 | **UNCHANGED, must stay green.** |
| `…:73` (`akm.schedule` success shape) | R-06 | **UNCHANGED, must stay green**, including the three `Object.isFrozen` assertions. |
| `docs/plans/specs/p0-invariants.md:78` (R-06's "Replaced by P2a" cell) and `…:11-16`'s file header | R-06 | **Prose only**: append a Review-log note to `p0-invariants.md` recording that the replacement is **scoped to task source v4** — v3's exactly-one-scheduling-source rule stands until P4 removes v3 acceptance. Do not edit the row's pinned behavior text. |

v4's optional schedule is behavior row **B-06/B-07**, a NEW row. There is no v4
document at head, so nothing about it can be a flip.

### F-1 — the published task schema gains a v4 arm

| Test / artifact (file at head) | Disposition |
|---|---|
| `schemas/akm-task.json` (353 lines) | **CHANGE**: two-arm `oneOf` (§5.3). The v3 arm's every keyword and numeric bound is moved **unchanged**. |
| `tests/integration/tasks-schema.test.ts` (253 lines) | **FLIP**: rewritten in the same commit. Its five existing tests keep their intent, re-rooted at the v3 arm: `published task schema pins the strict v3 source vocabulary` (now asserts the v3 arm's `properties`/`required`/`additionalProperties`/`oneOf`/`allOf` shape), `… closes AKM controls and trigger shapes at parser bounds`, `every published pattern is valid ECMAScript …`, `draft-07 validation follows the parser's exact uses-classification precedence`, and `published outputSchema grammar rejects keywords the runtime subset cannot enforce`. `the production parser consumes the same strict v3 spellings the schema publishes` stays as-is. **NEW** parallel tests assert the v4 arm against the exported constants, that the v4 arm has **no** `githubActionRef` alternative, and that an `akm:` / `on:` key fails the v4 arm. |
| `tests/release-check.sh:139` | **UNCHANGED** — the path is preserved deliberately. |

### F-2 — `src/tasks/source-v3.ts` is edited (extraction only)

| Surface | Disposition |
|---|---|
| `src/tasks/source-v3.ts` | **CHANGE (mechanism only)**: the D2-N4 helpers move out and are imported back; every export name, every message byte, and every code is preserved. P1b's acceptance criterion "`git diff --stat -- src/tasks/source-v3.ts` empty" was **P1b's**, not a standing invariant, and P2a supersedes it for this file only. |
| `tests/tasks/source-v3.test.ts` (417 lines) | **UNCHANGED, must stay green** — this is the canary for the extraction. |
| `tests/integration/lint-task-yaml.test.ts` (188 lines) | **UNCHANGED, must stay green**; v4 coverage lands as new tests in a new file. |

### F-3 — `PROGRAM_PARAM_NAME_PATTERN` is re-homed

| Surface | Disposition |
|---|---|
| `src/workflows/program/schema.ts:100` | **CHANGE (mechanism only)**: definition → re-export of `INPUT_NAME_PATTERN` (D3-N1). Same `RegExp` source, same flags. |
| `src/workflows/ir/schema.ts:8,423,428`, `src/workflows/parser.ts:45,562` | **UNCHANGED** import sites; behavior identical. |
| `tests/workflows/workflow-param-flags.test.ts`, `tests/integration/workflows/params-validation.test.ts`, `tests/workflows/schema-definition.test.ts`, `tests/workflows/ir-compile.test.ts` | **UNCHANGED, must stay green.** |

### F-4 — the scheduler-source schedule shape gains an optional field

| Surface | Disposition |
|---|---|
| `src/tasks/scheduler-binding.ts:41-45,182` | **CHANGE (additive)**: `SchedulerSourceSchedule.enabled?: boolean`; `enabled: schedule.enabled ?? input.enabled`. |
| `tests/tasks/scheduler-binding.test.ts` | **UNCHANGED, must stay green** — v3 never sets the field, so every compiled binding is byte-identical. |
| `tests/integration/tasks-scheduler-sync-v3.test.ts` (897 lines) | **UNCHANGED, must stay green.** |

### F-5 — `akm task run` gains raw-argv flag capture

| Surface | Disposition |
|---|---|
| `src/commands/tasks/tasks-cli.ts:119-147` | **CHANGE (additive)**: `parseTaskInputFlags(rawArgs, args.id)` and the `inputFlags` option. The declared args (`GLOBAL_OUTPUT_ARGS`, `id`, `bundle`, `scheduled`) are unchanged, so `--help` output for the command is unchanged except for any prose the lane deliberately adds. |
| `src/cli.ts:623-639` (`isTaskRunWithId`) | **VERIFY UNCHANGED**: it parses only `args.id` off the declared args and tolerates extra tokens. A test must cover `akm task run <id> --scope all` still classifying as a task-run-with-id. |
| `tests/completions.test.ts`, `tests/integration/completions-install.test.ts` | **UNCHANGED, must stay green** (LC-N2). |
| `tests/integration/tasks-runtime-v3-runner.test.ts` | **UNCHANGED, must stay green** — `inputFlags` is optional. |

### F-6 — new diagnostic coverage

| Surface | Disposition |
|---|---|
| `tests/integration/cli-errors.test.ts` | **EXTEND** (the P1b-established home for envelope coverage): one test per new CLI-reachable code path — `UNKNOWN_FLAG` from an undeclared task input, `INPUT_BINDING_INVALID` from a bad value and from a missing required input — each asserting `{ok:false,error,code}` on **stderr** and exit **2**. Existing tests in the file stay green unchanged. |
| `tests/architecture/diagnostic-codes.test.ts` | **VERIFY green.** `INPUT_BINDING_INVALID` and `TASK_SOURCE_INVALID` already exist (`src/core/errors.ts:103,114,179,183`); P2a mints **no new code**. If the ratchet counts literal code strings, follow `src/tasks/model/definition.ts:66-77`'s established remedy pattern rather than adding baseline entries. |

---

## 7. Preservation gates (the reviewer runs these)

- [x] `tests/integration/tasks-runtime-v3-runner.test.ts` green and **byte-unchanged**
      (fail-before-mutation canary for the run path).
- [x] `tests/tasks/source-v3.test.ts` green and **byte-unchanged** (canary for the
      D2-N4 extraction).
- [x] `tests/integration/tasks-scheduling-characterization.test.ts` green and
      **byte-unchanged** — all three R-06 tests (§6 F-0).
- [x] `tests/integration/tasks-scheduler-sync-v3.test.ts` green and
      **byte-unchanged**; the compiled binding set for every v3 fixture is
      identical in ids, ordinals, `source` strings, `enabled`, and invocation tails.
- [x] `tests/workflows/workflow-param-flags.test.ts` and
      `tests/integration/workflows/params-validation.test.ts` green and
      **byte-unchanged** (Lane B canary).
- [x] `tests/contracts/execution-cascade-resolver.test.ts`,
      `tests/contracts/execution-json.test.ts`,
      `tests/contracts/execution-source-loader.test.ts`,
      `tests/contracts/resolved-execution-contract.test.ts`,
      `tests/contracts/command-invocation-contract.test.ts` green and
      **byte-unchanged**.
- [x] Every other P0/P1 suite green except §6's enumerated flips — in particular
      `tests/integration/tasks-provenance-characterization.test.ts`,
      `tests/integration/tasks-legacy-vocabulary-characterization.test.ts`,
      `tests/integration/tasks-with-classification-characterization.test.ts`,
      `tests/tasks/model-contracts.test.ts`, `tests/tasks/parse-v3-adapter.test.ts`,
      `tests/tasks/prepare-split.test.ts`, `tests/tasks/run-split.test.ts`.
- [x] `tests/architecture/import-cycle-ratchet.test.ts` green with **no new cycle
      participant** — specifically no `src/execution/** → src/workflows/**` edge
      (D3-N1).
- [x] `tests/architecture/src-fn-size-ratchet.test.ts` green with **no baseline
      additions** — every new parser/materializer function stays under the
      220-line `SRC_FN_SIZE_BAR`.
- [x] `tests/tasks/parse-v3-adapter.test.ts`'s purity ratchet green with its file
      list unchanged (§4.4).
- [x] No frozen-plan bytes change: workflow freeze / plan-hash suites green
      unchanged. `taskDispatch`'s only edit is the LC-N1 guard, which runs
      **before** any freeze.
- [x] `rg -F 'version: 3\nuses:' src/` and `rg -F 'schedule: "@daily"' src/`
      return **zero** hits (P1b's synthetic-document invariant still holds —
      §3.5's projection is typed, not textual).
- [x] `bun scripts/lint-doc-examples.ts` clean.
- [x] `bunx biome check --write src/ tests/` produces no further changes;
      `bunx tsc --noEmit` clean; `bun run check` passes.

### G-1 — recorded gate scope note {#g1}

Lane C's verbatim gate says "tests/integration/tasks-runtime-v3-runner.test.ts
unchanged". `RunTaskOptions.inputFlags` is **optional**, so unlike P1b's
`stashDir` → `bundleDir` rename there is no mechanical-diff carve-out this
time: that file must be **byte-unchanged**, full stop. If any line of it must
change, **stop and record it in the Review log** — that is the signal that the
input-flag thread is not additive.

---

## 8. Docs that ride with the code

- [x] `docs/reference/tasks.md` — task source v4 documented; v3 stated as still
      parsing until a later release; every `akm …` example passes
      `scripts/lint-doc-examples.ts` (§5.4).
- [x] `CHANGELOG.md` `[Unreleased]` → "Breaking changes & migration" — the
      task-source-v4 entry, with the full `akm:` → top-level mapping, the
      github-action removal, the optional-schedule/sync-skip behavior, the new
      input flags and their validate-but-not-yet-deliver scope, and the LC-N1
      workflow-composition deferral.
- [x] `docs/plans/specs/p0-invariants.md` Review log — the **R-06 scoping note**
      (§6 F-0). This is a close-out obligation, not optional.
- [x] Universal "`version: 3`" / "exactly one trigger source" statements in
      `docs/reference/supported-formats.md`, `docs/reference/cli.md`, and
      `docs/architecture/adapters.md` scoped to v3.

---

## 9. Acceptance criteria

**Structure**

- [x] `src/tasks/source/bounded-document.ts` exists and owns the D2-N4 helpers;
      `src/tasks/source-v3.ts` imports them and contains **no copy** of any of
      them.
- [x] `src/tasks/source/task-source-v4.ts` exports `TASK_SOURCE_V4_VERSION`,
      `TaskSourceV4Document`, `parseTaskSourceV4()`, and the three key-set
      constants of D2-N3/D2-N7.
- [x] `src/tasks/source/parse-task-source.ts` exports `parseTaskSource()`
      returning the `ParsedTaskSource` union and parses the YAML **once**.
- [x] `src/tasks/source/project-v4.ts` exports `projectTaskSourceV4()`; no YAML
      is fabricated and `prepareTaskV3Execution` is unmodified.
- [x] `src/execution/input-contract.ts` exports the full §4.2 surface, imports
      nothing from `src/workflows/**`, and keeps the pure-module header.
- [x] `src/workflows/ir/params.ts` contains no coercion or validation logic of
      its own — only the plan→contract adapter, the diagnostics vocabulary, and
      the three re-exported wrappers.
- [x] Every §3.6 "ROUTE" call site consumes the union and handles both arms; every
      "STAYS" call site is unchanged except `source-freeze-v4.ts`'s LC-N1 guard.

**Naming (D1)**

- [x] The task-side symbols are `TASK_SOURCE_V4_VERSION`, `TaskSourceV4Document`,
      `parseTaskSourceV4` and live under `src/tasks/source/`.
- [x] No prose in the new code, the schema, `docs/reference/tasks.md`, or the
      CHANGELOG entry says bare "v4" for the task grammar — it is always "task
      source v4". `grep -n '\bv4\b'` over the new/edited docs shows only
      workflow-plan-IR uses.

**Behavior**

- [x] Every PRESERVE row of §2 holds, verified by its cited test.
- [x] Every NEW row of §2 has at least one test asserting its code **and** its
      message text.
- [x] A v4 task with no `schedule:` parses, runs via `akm task run`, and
      contributes zero bindings and zero failures to `akm task sync` (B-06/B-07).
- [x] `akm:` , `on:`, and a github locator `uses:` each fail a v4 document with
      `TASK_SOURCE_INVALID` and a detail **naming the removal** (B-11/B-12/B-13).
- [x] `with:` is accepted on `uses: akm/command` and rejected everywhere else in
      v4 (D2-N1).
- [x] The D2-N2 routing table holds exactly, including both preserved version
      errors.
- [x] `akm task run` input flags produce `UNKNOWN_FLAG` / `INPUT_BINDING_INVALID`
      per §5.1, exit 2, JSON envelope on stderr; a *valid* flag set leaves the
      run byte-identical to the same run without flags.
- [x] `canonicalInputJson` is byte-equal to `canonicalJson` across the D3-N2
      fixture set.
- [x] `schemas/akm-task.json`, the exported constants, and
      `tests/integration/tasks-schema.test.ts` land in **one** commit (Lane C,
      binding).

**Gates**

- [x] Every gate in §7 ticked, including G-1.
- [x] Every §6 flip is a **visible test diff**; no existing test was deleted to
      make a flip disappear.
- [x] §8's CHANGELOG entry and the R-06 scoping note in
      `docs/plans/specs/p0-invariants.md` are both landed.
- [x] Every behavior difference observed during implementation that is not in
      §6 is recorded in the Review log and **not** silently absorbed. The four
      already-known items to carry there: the stale `must be exactly 3` version
      message (D2-N2), the v3 source label on front-end failures for an unknown
      version (§3.4), the `version: 3` literal inside the projected preparable
      document (§3.5), and `schedule[i].inputs` being validated but undelivered
      (B-38).

---

## Review log

<!-- Reviewers append dated entries below. -->

**2026-08-26 — close-out: the four already-known non-§6 behavior differences (§9 acceptance,
"Behavior" bullet).** Recorded here as required, none fixed (all four are deliberate, spec-recorded
warts, not defects):

1. **The stale `must be exactly 3` version message (D2-N2).** A `version: 4` document with an
   invalid `version` value never reaches this text — it routes through `parseTaskSourceV4Document`,
   which has its own `must be exactly 4.` wording. But a document with a missing `version`, or any
   value that is neither `3` nor `4` nor `2`, still routes to the unmodified v3 parser and renders
   `$ version is required and must be 3.` (`src/tasks/source-v3.ts:495`) / `$ version must be exactly
   3.` (`:497`) — text that is no longer accurate now that a second, valid version exists. This is
   deliberate (spec §1.5 D2-N2: "rewriting it is a message flip nobody authorized… P4 owns the final
   version-error text") and is pinned, not fixed, by `tests/tasks/source-v4.test.ts`'s router-table
   tests and `tests/tasks/source-v3.test.ts:260`.
2. **The v3 source label on front-end failures for an unknown version (§3.4).** `parseTaskSource`
   (`src/tasks/source/parse-task-source.ts`) runs the bounded YAML front end with
   `sourceLabel: "task v3 source"` unconditionally, because `root.version` cannot be read until the
   front end already succeeded. A source-not-a-string / oversized / malformed-YAML failure on a
   document that would otherwise have declared `version: 4` therefore still renders `Invalid task v3
   source at …`, never `Invalid task source v4 at …`. Recorded in the module's own header comment as
   "a deliberate, spec-recorded wart… P4 owns the final label once v3 is gone."
3. **The literal `version: 3` inside the projected preparable document (§3.5).** `projectTaskSourceV4`
   (`src/tasks/source/project-v4.ts`) always sets the projected `PreparableTaskDocument.version` to
   the literal `TASK_V3_SCHEMA_VERSION` (`3`), regardless of the source document having been
   `version: 4` — it is the prepare seam's discriminant, not a re-assertion of the source version. The
   `rg -F 'version: 3\nuses:'`-style synthetic-document invariant is not violated (this is a typed
   field assignment, not a fabricated YAML string), but a debugger inspecting the object handed to
   `prepareTaskV3Execution` would see `3` for a task authored at `version: 4`. Recorded as a wart in
   `project-v4.ts`'s own header; P4 retires it with the `PreparableTaskDocument` type rename.
4. **`schedule[i].inputs` validated but undelivered (B-38).** A schedule entry's `inputs:` literal is
   validated against the document's `inputs:` declarations at parse time (and, per the fix below,
   validated with a closed key set), but `projectTaskSourceV4` does not project it onto
   `triggers.schedules[i]`, and `compileTaskSchedulerBindings`'s invocation tail
   (`src/tasks/scheduler-binding.ts:180`, `["task", "run", id, "--bundle", bundle, "--scheduled"]`) is
   fixed — no `--<input>` flag is ever appended for a scheduled run. This is P2a's explicit non-goal
   (spec §0: "P2b owns delivery"), not a defect.

**2026-08-26 — close-out: LC-N2 verification record (§1.5 LC-N2, §9 acceptance).** Re-verified as
part of this review-fix pass: `src/commands/completions.ts` enumerates no task input flags by hand —
it walks the real citty command tree (`walkCommandTree`) and a `FLAG_VALUES` table keyed by flag
name, neither of which names any per-task, per-document flag. `tests/completions.test.ts` and
`tests/integration/completions-install.test.ts` pass unchanged (19 pass / 0 fail). No edit was made
to `completions.ts`, confirming Lane C's "update shell completion if it enumerates task flags" is
discharged by verifying it does not, per LC-N2's binding resolution.

**2026-08-26 — close-out: D2-N4 deviation record (§1.5 D2-N4, §3.1).** D2-N4's own extraction list
names `nullableSelector` alongside `parseTimeout` and `parseTools` as one of the helpers that "move
body-intact to `src/tasks/source/bounded-document.ts`." At head, only two of the three actually
moved: `parseTimeout` and `parseTools` live in `bounded-document.ts` (both still hardcode the
`["akm", …]` field path, exactly as D2-N4 describes); `nullableSelector` stayed declared directly in
`src/tasks/source-v3.ts` and was never moved. `bounded-document.ts`'s own header documents this as a
deliberate choice ("`nullableSelector` is the same kind of `["akm", …]`-hardcoding helper but is NOT
in D2-N4's named list and stays declared directly in `source-v3.ts`") — but that characterization
does not match D2-N4's actual text, which does name `nullableSelector` in the list quoted above. This
is therefore a genuine deviation from a literal reading of D2-N4, not merely a header's accurate
description of an intentional exception, and is recorded here per §9's acceptance criterion that
every observed non-§6 behavior difference be recorded rather than silently absorbed. The deviation is
purely structural, not behavioral: task source v4 declares its own top-level-rooted
`nullableSelectorTopLevel` sibling in `task-source-v4.ts` (same accept/reject semantics as v3's
`nullableSelector`, at a different, un-prefixed field path — the same pattern `parseTimeoutTopLevel`/
`parseToolsTopLevel` use relative to their moved counterparts), so no v3 or v4 behavior is affected;
`tests/tasks/source-v3.test.ts` and `tests/tasks/bounded-document.test.ts` (including its AST scan)
both pass unchanged. Left as-is — moving `nullableSelector` now is a mechanical follow-up, not a
CONFIRMED-finding fix, and is better done together with any other D2-N4 cleanup rather than as an
isolated diff.

**2026-08-26 — fix(review): schedule[i].inputs fail-closed on undeclared keys (finding at
task-source-v4.ts:530).** `parseScheduleEntry` validated a schedule entry's `inputs:` literal only
through `validateInputs(contract, inputsValue)` (§3.2 rule 7), whose synthetic `{type:"object",
properties}` schema (§4.2) deliberately carries no `additionalProperties:false` — the right default
for `validateInputs` itself, which has other callers (`materializeWorkflowParameterFlags`/
`materializeInputFlags` already do their own exact-name check before ever calling it). Relying on
`validateInputs` alone at the `schedule[i].inputs` parse site left a fail-closed hole: a typo'd or
wholly undeclared literal (e.g. `scoep: all` alongside a declared `scope`) parsed cleanly, survived
`projectTaskSourceV4`'s no-op drop of `schedule[i].inputs` unnoticed, and was never named by any
diagnostic — accepted-but-silently-ignored forever, the exact state the repo's fail-closed convention
(mirrored everywhere else in this file via `checkKeys`, and by `materializeInputFlags`' own
exact-name rule) forbids. Fixed by adding a `checkKeys(inputsValue, Object.keys(contract), ctx,
[...entryPath, "inputs"])` call in `parseScheduleEntry`, ahead of `validateInputs` — layered on top
of, not inside, the shared `validateInputs` function, so `validateInputs`'s own general-purpose
§4.2 contract (no implicit `additionalProperties:false`) is unchanged for every other caller. An
unrecognized key now fails `TASK_SOURCE_INVALID` at `schedule[<i>].inputs.<name>`, mirroring
`checkKeys`' existing use at every other closed-key boundary in this file (top-level keys, schedule-
entry keys, input-declaration keys). `schemas/akm-task.json`'s `taskSourceV4ScheduleEntry.inputs` is
tightened off the free-form `jsonObject` $ref to a new `taskSourceV4ScheduleInputs` definition closing
property names to the input-name pattern (full cross-referencing of the document's own declared
`inputs:` names is not expressible in static JSON Schema here, so this is a partial, name-shape-only
tightening, not a semantic replacement for the runtime's exact-name check). New coverage:
`tests/tasks/source-v4.test.ts` (three new tests: an undeclared-key rejection, the exact typo'd-name
repro from the finding, and the empty-contract case) and `tests/integration/tasks-schema.test.ts`
(one new test asserting the schema-level property-name tightening). This is judged to be within
§3.2 rule 7's "validated against the declarations… via `validateInputs()`" — the fix adds a
closed-key check immediately alongside that call, inside the same parse step, rather than replacing
or contradicting it — so no gap is recorded as an alternative to the fix; this entry documents the
mechanism for a future reader instead.

**2026-08-26 — fix(review): schema/parser drift on task source v4's `output: null` (finding at
schemas/akm-task.json:226).** The published schema's v4 arm accepted `output: null` (a
`{"type":"null"}` alternative copied from v3's `akm.outputSchema`, which genuinely accepts `null` at
`src/tasks/source-v3.ts:272-282`), but `parseOutputSchema` (`src/tasks/source/task-source-v4.ts`)
goes straight to `asRecord`, which rejects `null` with `output must be a mapping.` Per §5.3 ("the v4
arm reuses the existing outputSchema grammar DEFINITION") and §3.2's `Readonly<Record<string,
unknown>>` typing (no `null`), the schema was wrong, not the parser: dropped the `{"type":"null"}`
alternative from the v4 arm's `output` property only — v3's `akm.outputSchema` keeps it, unchanged.
New coverage: `tests/integration/tasks-schema.test.ts` gains the v4 arm's first `output:` assertion
(previously absent entirely), asserting both that v4 rejects `null` and that v3's `akm.outputSchema:
null` still validates.

**2026-08-26 — fix(review): task-source-v4.ts module header corrected (finding at
task-source-v4.ts:18).** The header claimed `src/tasks/source-v3.ts` was untouched by this phase and
that `bounded-document.ts` was "a fresh, parameterized reimplementation" of helpers that "cannot be
edited" in `source-v3.ts` — the opposite of what the commit (and `bounded-document.ts`'s own header)
actually describes: `source-v3.ts` IS edited (the D2-N4 helpers move out body-intact and are
imported/re-exported back), which is the D2-N4 move itself, not a waiver of it. Left uncorrected, the
header told the next reader the copy-vs-move invariant `tests/tasks/bounded-document.test.ts`'s AST
scan exists to protect had been waived. Rewritten to describe the actual extraction, keeping only the
true part: task source v4 declares its own top-level-rooted `parseTimeoutTopLevel`/
`nullableSelectorTopLevel`/`parseToolsTopLevel` because the v3 originals (two of which now live in
`bounded-document.ts`, one of which — `nullableSelector` — stayed in `source-v3.ts`, see the D2-N4
deviation entry above) hardcode the `["akm", …]` field path.

**2026-08-26 — close-out: review round ledger, gate summary, and four outstanding advisories.**

*Review round ledger.* Test-review: round 1 — CHANGES_REQUIRED, 11 confirmed
(`fix(p2): address test review findings (round 1)`, 88d8bd5); round 2 — CHANGES_REQUIRED, 3
confirmed (`fix(p2): address test review findings (round 2)`, 31096c9). Code-review: round 1 —
CHANGES_REQUIRED, 8 confirmed (`fix(p2): address review findings (round 1)`, d7abd29); round 2 —
CHANGES_REQUIRED, 5 confirmed (`fix(p2): address review findings (round 2)`, de08468 — the commit
that also added every Review-log entry standing above this one). Both cycles reached the
orchestrator's two-round review budget with round 2's fixes applied and no third round spent
re-verifying them: per the orchestrator rule, a budget-exhausted CHANGES_REQUIRED round is
auto-adjudicated rather than looped further, and any of its confirmed findings not already fixed by
the round's own commit are carried forward as advisories instead of blocking close-out. The four
advisories below are exactly that carry-forward.

*Gate summary.* Re-verified for this close-out, not merely asserted: `bun run lint` is green — biome
plus all thirteen chained repo-specific checks (`lint-tests-isolation`, `lint-license-headers`,
`lint-runtime-boundary`, `lint-write-source-chokepoint`, `lint-secret-resolver-boundary`,
`lint-execution-boundary`, `lint-process-argv`, `lint-repository-sql`, `lint-goldens-presence`,
`lint-golden-captured-at-head`, `lint-shipped-assets`, `lint-doc-examples`,
`gen-config-schema --check`, `lint-active-docs-terminology`) all report OK. Biome's own findings are
1347 pre-existing, repo-wide warnings (chiefly `noNonNullAssertion`), none in a P2a file and every
one flagged an UNSAFE fix — confirmed by re-running `bunx biome check --write src/ tests/` for this
close-out, which reports "No fixes applied" and leaves the working tree byte-clean. `bunx tsc
--noEmit` is clean. `bun run test:unit`: 4193 pass / 0 skip / 0 fail across 303/303 files. `bun run
test:integration`: 5694 pass / 57 skip / 0 fail across 424/424 files (the 57 skips are the
pre-existing gated semantic-search-e2e / Docker suites, unrelated to this phase). Every canary named
in §7 — `tests/tasks/source-v3.test.ts`, `tests/integration/tasks-runtime-v3-runner.test.ts`,
`tests/integration/tasks-scheduling-characterization.test.ts`,
`tests/integration/tasks-scheduler-sync-v3.test.ts`, `tests/workflows/workflow-param-flags.test.ts`,
`tests/integration/workflows/params-validation.test.ts`, and the five `tests/contracts/execution-*` /
`resolved-execution-contract` / `command-invocation-contract` suites — is byte-unchanged from P1b's
head (`c64e5e1`) to this commit (`git diff --stat` empty for each, checked individually); no test
file under `tests/` was deleted anywhere in the phase.

*Outstanding advisories.* Four findings from the review rounds are not §6 flips. Per the Rules of
Engagement ("A defect discovered that is not in §6 is recorded in the Review log and left unfixed"),
each is recorded here rather than fixed:

1. **[`src/tasks/source/task-source-v4.ts:463`] Secret-shaped input defaults warn with
   workflow-parameter prose that is factually wrong for a task input.** B-22/D2-N3 mandate reusing
   `detectSecretShapedParams`, and the reuse works as required — verified: a `token`-named default
   warns, and no value is echoed. But the emitted text is the unmodified workflow string: ``Run param
   "token" has a secret-suggesting name. Workflow params are copied verbatim into every native unit
   execution context and returned in `akm workflow run` and `akm workflow status` output (they are
   part of the unit input hash and CANNOT be redacted) — move secrets to an env binding…`` — none of
   which is true of a task source v4 input default, which P2a does not deliver anywhere (§0).
   Spec-sanctioned (D2-N3 mandates reusing the existing detector), so it is left as-is; P2b, which
   owns delivery, is the right place to parameterize the noun and the remediation sentence for the
   task-input case.
2. **[`src/execution/input-contract.ts:295`] Task input values are interpolated verbatim into the
   user-facing error envelope on stderr.** `coerceFlagValue`'s terminal throw is
   ``diagnostics.invalidValue(name, `must be ${types.join(" | ")}; received ${JSON.stringify(raw)}`)``,
   which `TASK_INPUT_DIAGNOSTICS` renders as `Task input "--<n>" must be <t>; received "<value>".` in
   the `{ok:false,error,code}` stderr envelope — so `akm task run t --token ghp_…` on a non-string
   declaration prints the credential. `parseScheduleEntry`'s `validateInputs` errors likewise echo the
   source literal (e.g. `value "zzz" is not one of ["a","b"]`, from `src/core/json-schema.ts:534`).
   Both are the body-intact moves D3-N3 requires and are byte-identical to workflow params' own
   behavior, so left unchanged here — but `akm task run` is a NEW surface for this (workflow params
   were already documented as non-secret; task inputs are not). Recorded for P2b to decide on
   redaction.
3. **[`src/tasks/source/task-source-v4.ts:508`] A `required: true` input with no default makes every
   scheduled run of that task fail, and neither parse nor `akm task sync` says so.** Verified:
   `version: 4` + `inputs: { ticket: { type: string, required: true } }` + `schedule: "0 8 * * 1"`
   parses clean and `akm task sync` installs a binding, but `compileTaskSchedulerBindings`'s
   invocation tail is the fixed `["task","run",id,"--bundle",b,"--scheduled"]`
   (`scheduler-binding.ts:180`), so `loadPreparedTask`'s `validateInputs` — after
   `applyInputDefaults` — throws `INPUT_BINDING_INVALID` on every firing. The B-38 warn in
   `scheduler-sync.ts` fires only when some schedule entry declares non-empty `inputs`, which this
   case does not, so nothing at parse time or sync time names the gap. A defect outside §6, left
   unfixed per the Rules of Engagement. The natural P2b fix is a sync-time warn (or a parse-time
   rejection) when a scheduled v4 task declares a required input that no schedule entry or default can
   ever satisfy.
4. **[`src/tasks/source/task-source-v4.ts:531`] Two cosmetic message defects on the new v4 rejection
   paths: a doubled `$` path root, and a `uses:` error that lists `tasks/` as valid.** (a)
   `parseScheduleEntry` passes `validateInputs`'s default `"$"` root straight into `sourceError`,
   rendering `Invalid task source v4 at t.yml:7: schedule[0].inputs $.scope: value "zzz" is not one of
   ["changed","all"]` — two path roots in one message. `TASK_INPUT_DIAGNOSTICS.contractViolation` and
   `WORKFLOW_PARAMETER_DIAGNOSTICS.contractViolation` already strip the leading `$` for exactly this
   reason; `parseScheduleEntry` does not pass `{ pathRoot: "" }` or otherwise strip it before joining.
   (b) `classifyTaskSourceV4Uses` re-raises `classifyTargetRef`'s message unchanged on a non-canonical
   `uses:`, so `uses: agents/x` in a v4 document yields `Target ref "agents/x" must be a canonical
   commands/, scripts/, tasks/, or workflows/ asset ref.` — naming `tasks/` as acceptable one branch
   after the immediately preceding `classified.kind === "task"` check has already rejected exactly
   that ref kind (B-14). Neither string is spec-mandated; left as message-quality warts for a future
   pass rather than fixed in this close-out.

   **2026-08-28 — PR-844 review-pass note (parts (a) and (b) both fixed).** `parseScheduleEntry` now passes
   `validateInputs(contract, inputsValue, { pathRoot: "inputs" })` and roots the `sourceError` call at
   `entryPath` (not `[...entryPath, "inputs"]`) — matching `checkScheduleEntryRunnable`'s own
   convention, which already did both. The example above now renders as `Invalid task source v4 at
   t.yml:7: schedule[0] inputs.scope: value "zzz" is not one of ["changed","all"]` — one coherent
   path (`inputs.scope`) in the detail, not the JSON-pointer `$` colliding with the dotted
   `schedule[0].inputs` field path. Part (b) (`uses:` naming `tasks/` as valid) is unrelated to
   `validateInputs`/`pathRoot` and is NOT addressed by this note; it remains an open wart.

**2026-08-26 — commit-history note (orchestrator).** The bulk of this phase's implementation is
recorded under commit `894ed58`, whose message reads `wip(p2): in-flight implement snapshot —
typecheck RED`. That message is wrong about the final state: it was an orchestrator safety snapshot
taken while two implement lanes were still writing (in response to a stop-hook prompt, after two
earlier phases were lost to container interruptions). Because it staged everything, the run's
integrator step found nothing left to commit and its intended
`feat(p2): task source v4, shared input contract, task input flags` commit never landed. The phase's
real state is the one proved by the gate recorded above: lint, typecheck, unit and integration all
green. Pushed history is not rewritten to correct the message; this entry is the correction.

**2026-08-27 — P2b supersession note (row B-24, §1.5 LC-N1).** P2b
(`docs/plans/specs/p2b-input-bindings.md` §1.7 A-N6, §7 F-A4) LIFTS the LC-N1
deferral this spec's row **B-24** and §1.5 section describe: `taskDispatch`
no longer peeks the root `version` and throws `TASK_SOURCE_INVALID` naming
the deferral. It now routes through `parseTaskSource`
(`src/tasks/source/parse-task-source.ts`) and composes a `version: 4` task
target exactly as it always did a `version: 3` one — `with:` bindings land
via `freezeTaskInputBindings` (P2b §3.3) when the target declares `inputs:`.
Row B-24's pinned text above is NOT edited (this is a prose-only, dated
note, per F-A4's own disposition table); the row is historically accurate
for P2a's own scope and is superseded, not wrong. The corresponding P2a test
(`tests/workflows/task-source-v4-deferral.test.ts`, its `LC-N1` describe
block) was rewritten in place by P2b to assert composition succeeds instead
— its v3-contrast companion test is unaffected and stays verbatim.

**2026-08-28 — P4 deletion note (§6 F-0's table, §7's preservation-gate
checkbox at lines 1032-1033).**
`tests/integration/tasks-scheduling-characterization.test.ts` — F-0's table
cites it as the file whose `:45`/`:57`/`:73` tests must stay "UNCHANGED, must
stay green" for R-06, and §7 checks it off as green and byte-unchanged ("all
three R-06 tests") — was **deleted** by commit `0969162` ("refactor(p4):
remove task source v3 acceptance from src", spec
`docs/plans/specs/p4-deletions-closeout.md` §3.2, row **F-A2.7**: "DELETE —
all three tests are R-06, resolved by deletion (§5.5)"). This does not
falsify F-0 or §7's gate: at P2a's own head the file was live and all three
tests stayed green, byte-unchanged, exactly as pinned. The deletion is a
downstream consequence of P4 §3.2 removing task v3 acceptance from `src`
altogether, which retires the exactly-one-scheduling-source rule (R-06) these
three tests characterized — `docs/plans/specs/p0-invariants.md`'s final
disposition table records R-06 as "RESOLVED by deletion." No replacement test
exists; the coverage was intentionally retired along with the rule it tested,
not relocated. Matching notes are appended to
`docs/plans/specs/p1a-with-rejection-classifier.md` and
`docs/plans/specs/p2b-input-bindings.md` (both 2026-08-28 entries). This
entry is prose-only; F-0's table and §7's checkbox above are not edited —
they are historically accurate for P2a's own scope and are superseded, not
wrong.
