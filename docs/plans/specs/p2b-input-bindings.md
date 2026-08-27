# P2b — task input bindings, delivery, the v3 → task-source-v4 migrator, and `akm task explain`

**Status:** ready for implementation
**Phase:** P2b of the akm task/workflow refactor
**Owner artifacts:** `src/workflows/freeze/**` (the mechanical split of
`src/workflows/ir/source-freeze-v4.ts`, then the `with:` → `TaskInputBinding`
freeze), `src/workflows/exec/step-work.ts` (pre-attempt resolution + the three
delivery surfaces), `src/workflows/exec/exec-unit.ts` +
`src/workflows/resource-limits.ts` (the `AKM_TASK_INPUTS` spawn boundary),
`src/tasks/scheduler-binding.ts` + `src/tasks/scheduler-invocation.ts` +
`src/tasks/scheduler-sync.ts` (schedule-supplied inputs),
`src/commands/tasks/tasks-cli.ts` (`akm task explain`),
`scripts/akm-migrate/migrate/task-to-v4.ts` (the v3 → task source v4
migrator), the v3 fixture sweep, and the authorized behavior flips of §7.

This document is the **single source of truth** for P2b. Lanes do not
re-derive these facts from the codebase and do not read the parent plan. Every
`file:line` below was verified at the head of
`claude/breaking-changes-0-9-2-3cfyvp` (P2a closed out: `8852607`).

---

## 0. What P2b is (and is not)

P2a made a task source v4 document *declare* typed `inputs:` and validated
them at the CLI. Nothing consumed a validated value. P2b makes a declared input
**bindable** from a workflow step and **delivered** to the target that runs.

P2b **is**:

- a purely **mechanical split** of `src/workflows/ir/source-freeze-v4.ts`
  (716 lines at head) into `src/workflows/freeze/**`, landed as its own commit
  **before any feature edit** (§3.1);
- real `with:` **bindings** on `uses: tasks/<ref>` workflow steps — literal and
  reference — normalized to `TaskInputBinding`
  (`src/execution/input-contract.ts:97`) and frozen **inside** the frozen
  target (§3.2–§3.5);
- **two-stage validation**: everything decidable at FREEZE fails before the
  plan is published; a reference's *resolved value* is validated PRE-ATTEMPT,
  before `reserveUnitAttempt` is ever called (§3.6);
- **delivery** on all four target kinds — one `AKM_TASK_INPUTS` env var for
  shell/script, a structured fenced JSON block for command (agent/LLM), child
  run params for workflow targets, and the scheduler argv for schedule-supplied
  inputs (§4);
- a new **`akm task explain <ref>`** verb — secret-free, `text` + `--format
  json` (§4.5);
- a **v3 → task source v4 migrator** under `scripts/**` only (§5);
- a **mechanical v3 fixture sweep**, landed as its own commit so a botched
  sweep reverts in one revert (§6).

P2b is **not**:

- a **hash-version phase.** `inputBindings` is frozen *inside* the frozen
  target, so `computeUnitInputHash` (`step-work.ts:585`, prefix
  `akm.workflow.unit\0v5\0`, `hashVersion: 5`) already covers it wholesale
  through its `frozenTarget` field. **P2b bumps nothing.** P3a owns
  `irVersion` 5 + `hashVersion` 6.
- a **merge-semantics phase.** There is NO merging of bindings across a
  composition chain: a step's `with:` binds the referenced task's DECLARED
  inputs and nothing else. A task that itself composes another task does not
  inherit, forward, or shadow its caller's bindings.
- a **nested-workflow phase.** `taskDispatch`'s two
  `"A workflow task step cannot compose a nested workflow target."` guards
  (`source-freeze-v4.ts:264,281`) stand unchanged. P3b owns child runs.
- a **v3 removal phase.** v3 documents still parse, still run, still schedule.
  P4 removes v3 acceptance.
- an **`akm task add` phase.** `akm task add` keeps writing v3 sources and
  gains no input flags.

Rules of engagement (unchanged since P1b):

- A defect discovered that is **not** in §7 is recorded in the Review log and
  left unfixed. Do not "improve" anything on the way past.
- If preserving a behavior and implementing an authorized change appear to
  conflict, **stop and record it** — preserving wins until the Review log says
  otherwise.
- Every function *moved* in §3.1 keeps its body byte-equivalent. A rewrite
  disguised as a move is the failure mode the split commit exists to avoid.

### 0.1 Commit ladder (binding)

| # | Commit | Contents |
|---|---|---|
| 1 | `docs(p2): behavior spec for task input bindings and delivery` | **this file only** |
| 2 | `refactor(p2b): split source-freeze-v4 into src/workflows/freeze/**` | §3.1 **only**. Mechanical. No behavior change. Reviewable as a pure move. |
| 3 | `test(p2b): failing tests for task input bindings and delivery` | Lane A2 + Lane B red tests |
| 4 | `feat(p2b): task input bindings, delivery, and akm task explain` | Lane A2 + Lane B implementation + the §7 flips they own + the §9 docs |
| 5 | `feat(p2b): v3 to task source v4 migrator` | Lane C — `scripts/**` + its tests only (disjoint; may land in parallel with 3–4) |
| 6 | `test(p2b): convert v3 task fixtures to schedule-free task source v4` | Lane D — **own commit**, last |

Commit 2 must be landable and green on its own. Commit 6 must be revertible on
its own.

---

## 1. Binding design decisions (verbatim)

§1.1–§1.6 are copied verbatim from the phase decisions and are binding. §1.7
records the disambiguations this spec adds, with evidence. Where a verbatim
block and a disambiguation appear to conflict, the disambiguation states which
reading wins and why.

### 1.1 Lane A — freeze split, then with-bindings (binding)

> 1. FIRST, a purely MECHANICAL split of src/workflows/ir/source-freeze-v4.ts
>    (653 lines, owns step routing + command/task/shell/script/judge lowering +
>    env freezing + bundle ownership + executable identity + Git OID) into
>    src/workflows/freeze/: source-freeze.ts (entry), resolve-steps.ts,
>    targets/{command,shell,script,task}.ts, environment.ts, identity.ts. No
>    behavior change; the old path re-exports. This is its own commit before
>    any feature edit.
> 2. THEN implement bindings: a step's `with:` on `uses: tasks/<ref>` — today
>    rejected with COMPOSITION_INVALID by P1a's fail-closed patch — becomes a
>    real binding. Normalize each entry to TaskInputBinding
>    (src/execution/input-contract.ts): a value that is EXACTLY the object
>    `{from: "steps.<id>.output(.<seg>)*"}` is `{kind:"reference"}`; `{from}`
>    plus any other key, or a `from` whose value does not match the reference
>    grammar, is a hard INPUT_BINDING_INVALID (never silently a literal);
>    everything else is `{kind:"literal"}`. NO merge semantics across
>    composition chains: a step's `with:` binds the referenced task's DECLARED
>    inputs and nothing else.
> 3. Validation timing: at FREEZE — unknown input name, missing
>    required-without-default, literal failing its declared schema, and
>    reference syntax + "names an earlier step that exists" — all fail before
>    publication. At PRE-ATTEMPT (src/workflows/exec/step-work.ts) — resolve
>    each reference against run params and prior step outputs, then validate the
>    resolved value against the declared schema; a type mismatch fails BEFORE
>    the attempt is reserved.
> 4. `inputBindings` is frozen INSIDE the frozen target, so computeUnitInputHash
>    (step-work.ts, prefix akm.workflow.unit\0v5\0) already covers it wholesale
>    — NO hashVersion bump in P2b (P3a owns irVersion 5 + hashVersion 6). A test
>    MUST prove a changed literal or reference changes the unit input hash.
> 5. P1a's COMPOSITION_INVALID rejection is REPLACED for valid bindings; it
>    remains for a `with:` on a target that declares no inputs, and for
>    `uses: commands/<ref>`/`scripts/<ref>` (still not binding surfaces — say so
>    in docs).

### 1.2 Lane B — delivery, schedule inputs, task explain (binding)

> - Shell/script targets: ONE env var AKM_TASK_INPUTS = canonical JSON of the
>   effective inputs (never one var per input). Add its cap row alongside
>   AKM_PARAMS/AKM_ITEM in src/workflows/resource-limits.ts and enforce at the
>   spawn boundary in src/workflows/exec/exec-unit.ts (reason
>   exec_context_too_large, unchanged mechanism).
> - Command (agent/LLM) targets: a structured fenced JSON block appended by the
>   existing prompt/context assembly in step-work.ts — same mechanism that
>   already carries params/step inputs. Never interpolated into authored prose.
> - Workflow targets: effective inputs become the child run's params (the
>   existing with->params path).
> - Schedule bindings supply inputs: a v4 `schedule[].inputs` mapping reaches
>   the run through the scheduler argv (src/tasks/scheduler-binding.ts) and the
>   sync-time projectability proof (src/tasks/scheduler-sync.ts) validates them
>   against the declarations.
> - NEW CLI: `akm task explain <ref> [input flags]` — prints (text + --format
>   json) the task source path and owning bundle, input declarations with
>   defaults, supplied values WITH provenance (default | flag |
>   schedule-binding), the resolved target kind and ref, effective execution
>   settings with field-level provenance, and schedule bindings. SECRET-FREE:
>   never prints resolved env values, credentials, or prompt bodies. Register it
>   in src/cli.ts next to the other task verbs;
>   tests/contracts/command-cli-contract.test.ts walks main.subCommands, so
>   update what that contract needs in the same commit.

### 1.3 Lane C — v3 -> task-source-v4 migrator (binding, disjoint: scripts/** only)

> Add scripts/akm-migrate/migrate/task-to-v4.ts mirroring task-to-v3.ts's
> fail-closed ladder EXACTLY: dry-run plan with per-file status
> changed|skipped|blocked -> config lock + maintenance barrier ->
> timestamped+UUID backup root -> O_EXCL backups written BEFORE any mutation ->
> pre-validate every output through the REAL v4 parser -> assertUnchanged TOCTOU
> recheck immediately before each replace -> atomic replace preserving file mode
> -> reverse-order rollback on failure -> re-inspect and require convergence.
> Translation: `akm.schedule`/`on.schedule` -> top-level `schedule:`;
> `on.workflow_dispatch`-only -> schedule ABSENT (manual-only) with a notice;
> `akm.timeout/engine/model/redact/env/maxSteps/maxRetries` -> top-level; a
> github-action `uses:` is BLOCKED (never guessed); anything ambiguous is
> BLOCKED with the original bytes untouched. The migrator vendors its own parser
> copy — src/ must not import scripts/ (dist tsc rootDir is src). Wire it into
> the existing CLI surface the same way task-to-v3 is.

### 1.4 Lane D — v3 fixture sweep (binding, own commit)

> 66 test files still author task fixtures with a synthetic
> `akm:\n  schedule: "@daily"` purely to satisfy v3's mandatory-scheduling rule.
> Convert those fixtures to schedule-free task source v4 EXCEPT: (a)
> tests/fixtures/execution-contracts/tasks/v2/** and the migrator's own
> fixtures, (b) tests/tasks/source-v3.test.ts, tests/tasks-runtime-v3.test.ts
> and any test whose SUBJECT is v3 parsing or v3 migration, (c) the P0
> characterization files pinning v3 behavior (R-06 must stay true for v3). This
> is a MECHANICAL conversion: assertion semantics must not drift, and the
> unit/integration test COUNTS must not drop (scripts/test-unit.sh and
> test-integration.sh enforce floors
> AKM_MIN_UNIT_TESTS/AKM_MIN_INTEGRATION_TESTS). Land it as its own commit so a
> botched sweep reverts in one revert.

### 1.5 Docs (binding, ride with code)

> docs/reference/workflow-schema.md (with: on task steps now binds declared
> inputs; command/script refs still ignore it), docs/reference/tasks.md (inputs,
> schedule inputs, task explain), docs/guides/author-workflows.md (a worked
> task-composition example), CHANGELOG [Unreleased],
> docs/migration/v0.9.1-to-v0.9.2.md (v3->v4 migration procedure). Every
> `akm …` example must satisfy scripts/lint-doc-examples.ts.

### 1.6 Preservation gates the reviewer runs (binding)

> tests/integration/tasks-runtime-v3-runner.test.ts unchanged;
> tests/contracts/execution-*.test.ts + resolved-execution-contract +
> command-invocation-contract unchanged; frozen-plan/chaos/run-lease/crash-window
> suites green; workflow param suites unchanged; P0 characterization green except
> the spec's authorized flips.

### 1.7 Binding disambiguations added by this spec

Each carries an ID so the flips table, the acceptance list, and the Review log
can cite it.

#### A-N1 — the split's file boundaries, and what stays put {#a-n1}

**Tension.** §1.1 names 653 lines and seven destination files. At head the file
is **716** lines (P2a added `taskDispatch`'s LC-N1 guard,
`source-freeze-v4.ts:231-256`), and `src/workflows/ir/environment-v4.ts` (390
lines, `freezeWorkflowEnvironment` + `materializeFrozenWorkflowEnvironment`,
imported by `exec/native-executor.ts:149`) **already exists** — so
"`environment.ts`" cannot mean that module.

**Binding resolution.** The split is scoped to the *contents of
`source-freeze-v4.ts`*, function bodies byte-intact:

| Destination | Moves in (from `source-freeze-v4.ts`) |
|---|---|
| `src/workflows/freeze/source-freeze.ts` | `resolveWorkflowSourceV4` (`:93`), `ResolvedWorkflowSourceV4` (`:65`), `ResolvedWorkflowUnitV4` (`:57`). The lane's **only** public entry. |
| `src/workflows/freeze/resolve-steps.ts` | `resolveStep` (`:139`), `resolveJudge` (`:194`), the `ResolutionContext` / `ResolvedDispatch` / `OwnedAsset` types, and the shared step helpers `freezeExecSpec` (`:466`), `executionValues` (`:505`), `executionUnitValues` (`:509`), `targetConcurrency` (`:479`), `durableRequest` (`:497`). |
| `src/workflows/freeze/targets/command.ts` | `commandDispatch` (`:156`), `inlineDispatch` (`:176`), `commandResult` (`:420`). |
| `src/workflows/freeze/targets/shell.ts` | `directShell` (`:397`). |
| `src/workflows/freeze/targets/script.ts` | `directScript` (`:317`), `scriptResult` (`:363`). |
| `src/workflows/freeze/targets/task.ts` | `taskDispatch` (`:212`). |
| `src/workflows/freeze/environment.ts` | `freezeEnvironment` (`:523`), `guardedExecutionSource` (`:545`), `resolveOwnedAsset` (`:560`), `resolveOwnedAssetSync` (`:568`), `resolveOwnedAssetCore` (`:572`), `configuredOwner` (`:624`), `assetExtensions` (`:639`), `captureOwned` (`:664`), `trackAncestry` (`:676`), `qualifyRef` (`:690`) — env freezing **and** the bundle-ownership resolution the env freeze is built on. |
| `src/workflows/freeze/identity.ts` | `scriptExecutable` (`:699`), `gitIdentity` (`:705`). |

`src/workflows/ir/environment-v4.ts`, `src/workflows/ir/freeze-v4.ts`,
`src/workflows/ir/schema-v4.ts`, `src/workflows/ir/plan-hash.ts` are **NOT
moved** and **NOT edited by commit 2**. Re-homing `environment-v4.ts` is P4's
call, not P2b's.

`src/workflows/ir/source-freeze-v4.ts` becomes a **pure re-export shim** —
`export { resolveWorkflowSourceV4, type ResolvedWorkflowSourceV4, type
ResolvedWorkflowUnitV4 } from "../freeze/source-freeze";` and nothing else — so
`src/workflows/ir/freeze-v4.ts:24` is byte-unchanged. The shim is P4's to
delete.

Circular-import note: `resolve-steps.ts` imports the four `targets/*` modules
and the targets import `resolve-steps.ts`'s shared helpers. Split the helpers
into `resolve-steps.ts`'s **own** module only if
`tests/architecture/import-cycle-ratchet.test.ts` (shrink-only, **empty**
baseline, counts type-only imports as real edges) reports a cycle; if it does,
the shared helpers move to a fifth module `src/workflows/freeze/step-values.ts`
and nothing else changes. **A new cycle participant is a hard stop**, not a
baseline addition.

#### A-N2 — one pre-existing test scans this file BY PATH {#a-n2}

`tests/workflows/direct-script-typed.test.ts:367` hard-codes
`path.join(SRC_ROOT, "workflows/ir/source-freeze-v4.ts")` and runs a
TypeScript-AST, function-scoped call scan requiring the **`directScript`** and
**`taskDispatch`** function *declarations* to be found in that file (`:410`,
`:424` assert `functionFound === true`). After §3.1 the shim contains neither,
so both tests fail with their own "function declaration not found" message.

**Binding resolution.** Commit 2 re-points that one constant into two —
`SCRIPT_TARGET_FILE = .../workflows/freeze/targets/script.ts` and
`TASK_TARGET_FILE = .../workflows/freeze/targets/task.ts` — and updates the
describe title. **Every assertion in both tests is retained verbatim.** The same
file's whole-`src/` greps (`:293`, `:302`) are path-independent and stay
byte-unchanged. This is flip **F-A1**; it is the *only* test the split commit
may touch.

Every other reference to the old path in `tests/` is a **prose comment**
(`tests/tasks/prepare-split.test.ts:20,61,199,212,218`,
`tests/workflows/characterization-*.test.ts`,
`tests/workflows/with-rejection.test.ts:13,277`,
`tests/workflows/task-source-v4-deferral.test.ts:10`,
`tests/integration/tasks-scheduling-characterization.test.ts:14`). Comments may
be corrected in the commit that changes the code they describe; a comment-only
edit is never a flip.

#### A-N3 — `with:` on a task step must first survive DECODE {#a-n3}

**Tension.** §1.1 requires a `with:` value that is EXACTLY the object
`{from: "…"}`. At head `scalarRecord` (`src/workflows/source-ir/schema.ts:879`,
called at `:389`) **fails any non-scalar `with:` value** — `step <id> with.<key>
must be a scalar` — and `WorkflowSourceStep.with` is typed
`Record<string, WorkflowSourceScalar>` (`:144`). A `{from: …}` mapping, and any
object/array literal for an input declared `type: object` / `type: array`,
never reaches freeze today.

**Binding resolution.**

- `scalarRecord`'s restriction is **narrowed to non-task targets**. On a step
  whose `uses:` classifies as `kind: "task"`
  (`classifyWorkflowStepUses`, `source-ir/semantics.ts`), `with:` values may be
  **any JSON value** the bounded document front end already accepts. On every
  other step — `akm/command`, `commands/<ref>`, `scripts/<ref>`,
  `workflows/<ref>` — `scalarRecord`'s message and behavior are
  **byte-identical to today**.
- The key grammar `^[A-Za-z_][A-Za-z0-9_.-]{0,127}$` (`:883`) is
  **unchanged** for every target. (Input *names* are narrower —
  `INPUT_NAME_PATTERN`, `input-contract.ts:70` — and an authored key that
  passes the decode grammar but is not a declared input name is caught at
  freeze as an unknown input, B-11.)
- `WorkflowSourceStep.with` widens to `Record<string, unknown>`. Every existing
  read site keeps compiling because the narrowing happens at freeze.
- `rejectStepWithExpressions` (`:720`) currently skips non-string values
  (`typeof item !== "string"` → `continue`). It must **recurse** into the new
  nested values so a `${{ … }}` string buried in an object or array is still
  `step <id> with.<key> contains an unsupported expression`. The
  `akm/command` + `commandMode: literal` + `key === "content"` carve-out
  (`:724`) is unchanged.
- Depth/size are bounded by the workflow source front end that already bounds
  every other authored value; P2b adds **no** new bound and no new constant.

This is flip **F-A2**. It flips exactly one pre-existing assertion —
`tests/workflows/characterization-with-drop.test.ts:98` — which is re-scoped,
not deleted (§7).

#### A-N4 — the `from` grammar is `parseReference`'s, both roots {#a-n4}

**Tension.** §1.1 spells the reference as `steps.<id>.output(.<seg>)*` but
§1.1(3) says PRE-ATTEMPT resolution happens "against run params **and** prior
step outputs".

**Binding resolution.** `from` is parsed by the **existing**
`parseReference` (`src/workflows/program/expressions.ts:55`) — the closed
two-root grammar `params.<ident>` | `steps.<ident>.output( .<ident> |
[<int>] )*`, `<ident>` = `[A-Za-z_][A-Za-z0-9_-]*`. Both roots are accepted.
Writing a narrower steps-only parser would be a second grammar for the same
strings, which is exactly the drift these phases exist to prevent, and it would
make §1.1(3)'s "run params" clause unreachable. `steps.<id>.output(.<seg>)*` in
the decision text is the motivating spelling, not an exclusion.

Consequences:

- The freeze-time **"names an earlier step that exists"** check applies to the
  `stepOutput` arm only. A `param` arm is checked against the workflow's
  declared params at freeze (the plan already carries `paramSchemas`,
  `schema-v4.ts:163`) and fails `INPUT_BINDING_INVALID` for an undeclared name.
- Resolution at pre-attempt goes through the **existing**
  `resolveStepReference` (`step-work.ts:251`) against the **existing**
  `ExpressionScope { params, stepOutputs }` (`step-work.ts:307`). No new
  resolver.
- "Earlier" means *before this step in the frozen step order* — the same
  ordering `map.over` / `inputs[]` already rely on. A self-reference or a
  forward reference is `INPUT_BINDING_INVALID` at freeze, never a runtime
  resolution error.

#### A-N5 — COMPOSITION_INVALID narrows, and grows to `commands/` / `scripts/` {#a-n5}

**Tension.** §1.1(5) says the rejection "remains … for `uses: commands/<ref>` /
`scripts/<ref>`". At head it never fired there: `resolveStep`
(`source-freeze-v4.ts:146-151`) forwards `source.with` to
`prepareCommandInvocation` **only** for `builtin-command`; for
`commands/<ref>` it builds `{ ref: qualifyRef(...) }` and **discards
`source.with` silently**, and `directScript` never reads it at all.

**Binding resolution.** Fail closed, which is the only reading under which the
rejection can "remain" and the only reading consistent with P1a's thesis (a
silently-dropped `with:` is the exact defect P1a existed to close, P0 row
R-01(c)). After P2b:

| step `uses:` | authored `with:` | result |
|---|---|---|
| `tasks/<ref>` whose task declares `inputs:` | valid | **binds** (§3.3) |
| `tasks/<ref>` whose task declares **no** `inputs:` | any, incl. `{}` | `UsageError` / `COMPOSITION_INVALID` — detail names the target and says it declares no inputs |
| `commands/<ref>` | any, incl. `{}` | `UsageError` / `COMPOSITION_INVALID` — detail says a command ref is not a binding surface |
| `scripts/<ref>` | any, incl. `{}` | `UsageError` / `COMPOSITION_INVALID` — detail says a script ref is not a binding surface |
| `akm/command` | any | **unchanged** — `with:` is the builtin action's own argument bag (`parseBuiltinCommandAction`), never an input binding |
| `workflows/<ref>` | any | unchanged — `taskDispatch`'s nested-workflow guards still fire first |

`src/core/errors.ts:178`'s `COMPOSITION_INVALID` remediation string
(`"Remove the step's with: block; task-call inputs arrive in a later 0.9.x
release."`) is now false and **must** change to name the two real causes. The
message bytes in `taskDispatch` change too. This is flip **F-A3**; it is a
**breaking change** for any workflow that authors a `with:` on a `commands/` or
`scripts/` step, and it gets its own CHANGELOG "Breaking changes & migration"
bullet (§9).

#### A-N6 — LC-N1's task-source-v4 composition deferral is LIFTED {#a-n6}

Only a **task source v4** document can declare `inputs:` (P2a §1.2 D2). P2a
deferred composing one from a workflow entirely: `taskDispatch` peeks the root
`version` and throws `TASK_SOURCE_INVALID` with the LC-N1 message
(`source-freeze-v4.ts:231-256`, p2a spec row B-24, pinned byte-exactly by
`tests/workflows/task-source-v4-deferral.test.ts:75`). Bindings are
unimplementable while that guard stands.

**Binding resolution.** P2b **removes** the peek-and-throw. `taskDispatch`
routes through `parseTaskSource` (`src/tasks/source/parse-task-source.ts`) and
handles both arms:

- `version: 4` → `projectTaskSourceV4(parsed.v4)` for the prepare seam
  (identical to `scheduler-sync.ts:498`'s call), with `parsed.v4.inputs` as the
  binding contract.
- `version: 3` → `parsed.v3`, contract = **empty**, so any `with:` is the
  no-inputs `COMPOSITION_INVALID` of A-N5.

`readBoundedTaskSourceYaml` + `peekTaskSourceVersion` are no longer called from
`taskDispatch`; `parseTaskSource` parses the YAML **once**. This is flip
**F-A4**. `tests/workflows/task-source-v4-deferral.test.ts` is rewritten in
place (same path, its `:112` v3-contrast test retained verbatim) to assert
composition **succeeds**; a prose note is appended to p2a's Review log recording
that its B-24 row is superseded here.

#### A-N7 — `inputBindings` placement, shape, and what it does NOT touch {#a-n7}

**Binding resolution.**

- All three frozen target interfaces (`src/workflows/ir/schema-v4.ts:77`,
  `:90`, `:99`) gain the SAME optional field:
  `readonly inputBindings?: readonly TaskInputBinding[];`
- The three `assertKeys` allowlists — command (`:277`), shell (`:346`), script
  (`:381`) — each gain `"inputBindings"`, and each decoder validates the array
  (closed `kind`, `INPUT_NAME_PATTERN` name, `value` present on literals /
  `from` present and `parseReference`-valid on references, names unique, sorted
  by name).
- **Contents.** ONE entry per DECLARED input that has an effective value —
  authored literal, authored reference, or the declaration's `default` applied
  at freeze via `applyInputDefaults` (`input-contract.ts:128`) — **sorted by
  name**. A declared optional input with no default and no authored value
  produces **no entry**. Freeze records what will actually run.
- **Absence is the identity-preserving default.** A step with no `with:` on a
  target that declares no inputs freezes the field **absent** (never `[]`), so
  the canonical JSON preimage of every existing frozen target is
  **byte-identical to today** and every frozen-plan / plan-hash fixture stays
  green (row B-01).
- **No contentHash change.** The shell target's `contentHash` preimage
  (`schema-v4.ts:360-366`: `akm.workflow.shell.v1\0` over
  `{exec, environment, cwdIdentity}`) and the command/script equivalents are
  **untouched** — `inputBindings` deliberately sits outside them. Identity
  coverage comes from `computeUnitInputHash`'s `frozenTarget` field
  (`step-work.ts:598`), which hashes the whole target.
- **No hashVersion bump, no irVersion bump.** `akm.workflow.unit\0v5\0` and
  `hashVersion: 5` (`step-work.ts:587,590,1710`) and
  `WORKFLOW_IR_V4_VERSION` are byte-unchanged. §1.1(4) is explicit; P3a owns
  the bump.

#### B-N1 — `AKM_TASK_INPUTS` needs no new limit, only a new roster entry {#b-n1}

`checkExecContextSize` (`exec-unit.ts:474-500`) already iterates
`Object.entries(input.context ?? {})` **generically** and charges every entry
against `execContextLimits(platform)`'s `perVarBytes` / `totalBytes`
(`resource-limits.ts:158-181`). A new `AKM_*` variable is therefore covered the
moment it is put in the context map — this is precisely §1.2's "unchanged
mechanism".

**Binding resolution.** The "cap row" is **documentation, not a constant**:
`resource-limits.ts`'s exec-context section comment (`:145-176`) and
`step-work.ts:512-513`'s note name the roster `AKM_INPUTS` / `AKM_PARAMS` /
`AKM_ITEM`; both gain `AKM_TASK_INPUTS`. No new numeric bound, no new exported
symbol, no change to `checkExecContextSize`'s loop, no change to
`contextTooLarge`'s message template (`:502-517`) beyond the variable name it
already interpolates. The existing `exec_context_too_large` failure reason is
reused verbatim.

`AKM_TASK_INPUTS` is emitted **only** when the unit's frozen target carries a
non-empty `inputBindings`, so `tests/integration/workflows/exec-unit.test.ts:426-433`'s
exact allowed-env-name set for a plain exec step is byte-unchanged (row B-02).

#### B-N2 — the command-target block changes the PROMPT, never the hash preimage {#b-n2}

`buildUnitPrompt` (`step-work.ts:639-675`) already appends structured
`## Item (index n)` / `## Declared inputs` / gate-feedback / schema blocks after
the byte-exact instructions. The task-inputs block is the same mechanism:
appended after `inputsBlock`, before `gateBlock`, as

````
## Task inputs
The composed task's declared inputs resolved to:
```json
{ …canonicalInputJson(effectiveInputs)… }
```
````

**Binding resolution.**

- The **template asset** `src/assets/prompts/workflow-unit-preamble.md` is
  **byte-unchanged** — the block is appended by the function, exactly as
  `itemBlock` and `inputsBlock` are.
- Authored prose (`template.instructions`) is **never** interpolated; the
  workflow-format-unification invariant stands.
- The assembled prompt is **not** part of `computeUnitInputHash`'s preimage
  (it hashes `template.instructions`, `step-work.ts:594`). Identity coverage
  for bindings comes from `frozenTarget` (A-N7). Adding the block therefore
  changes **no** hash, and a changed binding still changes the hash — the two
  facts are independent and each gets its own test (rows B-16, B-17).
- The block appears **only** when `inputBindings` is non-empty, so every
  existing prompt-shape assertion (`tests/integration/workflows/chaos.test.ts:629`,
  `tests/integration/workflows/native-executor.test.ts`) is byte-unchanged.

#### B-N3 — the scheduler argv tail widens; every v3 tail stays byte-identical {#b-n3}

`compileTaskSchedulerBindings` freezes a **fixed** tail
`["task","run",<id>,"--bundle",<bundle>,"--scheduled"]`
(`scheduler-binding.ts:171`), and `parsePublicSchedulerInvocation`
(`scheduler-invocation.ts:220-243`) requires `--scheduled` to be **the last
token** (`index !== invocation.length - 1` → reject).

**Binding resolution.**

- `SchedulerSourceSchedule` (`scheduler-binding.ts:41`) gains an optional
  `readonly inputs?: Readonly<Record<string, unknown>>;` — additive, exactly as
  P2a's `enabled?` was (D2-N5). v3 never sets it.
- When present and non-empty, `compileTaskSchedulerBindings` appends a
  **canonically ordered** flag tail after `--scheduled`: for each input name in
  **sorted** order, `--<name>` followed by one value token. A scalar is its
  exact text (`String(value)` for number/boolean, the string itself for a
  string); an object/array value is its `canonicalInputJson` text, which
  `parseTaskInputFlags` + `materializeInputFlags` already coerce back through
  the declaration (`input-contract.ts:194`, the JSON-shorthand path). A
  `true` boolean is still emitted as `--<name> true` (never a bare flag) so the
  tail round-trips through one parser.
- `parsePublicSchedulerInvocation` accepts that tail: after `--scheduled`, zero
  or more `--<name> <value>` pairs where `<name>` matches `INPUT_NAME_PATTERN`
  and `<value>` is a single non-flag token. Anything else — a bare flag, a
  repeated name, a token starting with `-`, an odd tail — is refused with the
  **existing** `invalidSchedulerInvocation()` error
  (`scheduler-invocation.ts:362-367`), whose message gains the optional
  `[--<input> <value>…]` clause.
- **A v3 source, or a v4 source whose `schedule[i].inputs` is empty, produces a
  tail with zero extra tokens — byte-identical to today.**
  `tests/tasks/scheduler-binding.test.ts` and
  `tests/integration/tasks-scheduler-sync-v3.test.ts` (897 lines) stay green
  **byte-unchanged**.
- The sync-time projectability proof (`scheduler-sync.ts:483-546`) validates
  each entry's `inputs` against `parsed.v4.inputs` with the same
  `applyInputDefaults` + `validateInputs` pair the CLI uses — so an unknown
  name or a schema violation that somehow survived parse fails at **sync**,
  recorded as a task failure, not at 3 a.m. in the scheduler.
- P2a's B-38 `warn()` (`scheduler-sync.ts:542-546`, "validated but not yet
  delivered") is **deleted** — the gap it announced is closed. This is flip
  **F-B2**.

#### B-N4 — what `akm task explain` may print, exactly {#b-n4}

**Binding resolution.** `akm task explain <ref> [input flags]` is
**read-only** — it never prepares an execution that spawns anything, never
writes history, never touches the scheduler. It prints:

| Field | Source | Notes |
|---|---|---|
| task source path, owning bundle | `resolveAssetPath` / `parseBundleRef` | absolute path is fine (not a secret) |
| task source version (`3` \| `4`) | `parseTaskSource` | |
| input declarations: name, type, `enum`, `required`, `default` | `parsed.v4.inputs` (v3 → empty) | `default` values are printed; a **secret-shaped** default (`detectSecretShapedParams`, `exec/param-secrets.ts:91`) prints as `<redacted>` and the row is marked |
| supplied values **with provenance** | `default` \| `flag` \| `schedule-binding` | one row per declared input; `schedule-binding` rows name the ordinal |
| resolved target kind + ref | `classifyTaskSourceV4Uses` / `classifyTaskV3Uses` | |
| effective execution settings + **field-level** provenance | `planExecutionCascade`'s `ResolvedExecutionPlanV1.provenance` (`execution-cascade.ts:109-120`, `{layer, kind, via}`) | reuse; **do not** write a second resolver |
| schedule bindings: cron, enabled, ordinal, source, inputs | `parsed.v4.schedule` | |

**SECRET-FREE, enumerated bans.** It must never print: a resolved `env:`
value or any environment variable value; an `env/<ref>` asset's contents; a
credential, API key, or token from config; a prompt body, `run:` command
string, `with.content`, or script bytes; the `AKM_TASK_INPUTS` payload of a
real run. Env bindings are shown as **names and refs only** — the same shape
`akm env path` guarantees. A test asserts the JSON envelope's serialized bytes
contain no value from a fixture whose `env:` and inline prompt hold sentinel
strings.

**Registration.** `taskCommand.subCommands` (`tasks-cli.ts:286`) gains
`explain: tasksExplainCommand`; `src/cli.ts:508` already maps
`task: taskCommand` and is **unchanged**. `isTaskRunWithId`
(`cli.ts:632-647`) keys on `taskArgs[0] !== "run"` and is **unchanged**.
`tests/contracts/command-cli-contract.test.ts` (24 lines) today asserts only the
`command` family; §1.2 requires it be updated in the same commit, so it gains a
parallel arm pinning `main.subCommands.task.subCommands.explain`'s
`ref` positional and `format` flag. That is flip **F-B3**.

#### C-N1 — "vendors its own parser copy" means the LEGACY reader, not the v4 parser {#c-n1}

**Tension.** §1.3 says the migrator "vendors its own parser copy" **and** that
it must "pre-validate every output through the REAL v4 parser".

**Binding resolution.** These are two different parsers, and both clauses hold
as written:

- The **input** side is vendored inside `scripts/**`, exactly as
  `task-to-v3.ts` vendors `parseLegacyTaskYaml` (`:211-238`) plus `V2_KEYS` /
  `V2_SHARED_KEYS` / `V2_LLM_KEYS` (`:94-132`) rather than reusing a typed
  parser. `task-to-v4.ts` reads the v3 document as a **raw record**, key by
  key, because a typed v3 parse would normalize away exactly the ambiguity the
  migrator must BLOCK on.
- The **output** side imports the real
  `parseTaskSourceV4` from `src/tasks/source/task-source-v4.ts`. This is
  legal and already the established pattern: `task-files-to-v3.ts:11` imports
  `parseTaskV3Yaml` from `src/`, and `task-migrate.ts` imports eleven `src/`
  modules. The forbidden direction is `src/ → scripts/`, because
  `tsconfig`'s build `rootDir` is `src` and `bun run build` must never emit
  `dist/scripts` (AGENTS.md: "`dist/tests` should never appear").
- An acceptance grep proves the direction:
  `rg -n 'from "\.\./\.\./scripts|from "\.\./scripts|scripts/akm-migrate' src/`
  returns **zero** hits.

#### D-N1 — the sweep inventory is re-derived at implementation time {#d-n1}

**Tension.** §1.4 says 66 files. At the head verified for this spec the
inventory is **59** files matching both `version: 3` and `schedule:` under
`tests/` (73 match `version: 3` alone) — P2a landed task-source-v4 fixtures and
shifted the count.

**Binding resolution.** The number is **not** pinned. Lane D re-derives the
candidate set with exactly this command and records the result in the Review
log:

```sh
comm -12 <(rg -l --sort path 'version: 3' tests/) <(rg -l --sort path 'schedule:' tests/)
```

then removes the exclusions of §6.2. The head-verified list is reproduced in
§6.1 as the reviewer's cross-check, not as a contract. **The count that IS
pinned** is the executed-test floor: `scripts/test-unit.sh:52`
(`AKM_MIN_UNIT_TESTS`, default **3500**) and `scripts/test-integration.sh:44`
(`AKM_MIN_INTEGRATION_TESTS`, default **5000**) must both still pass after the
sweep, and the ran+skipped totals must not **drop at all** relative to the
pre-sweep run — record both numbers in the Review log.

**Exclusion (d), added here:** no fixture named by §7's flips table may be
converted. `tests/workflows/with-rejection.test.ts:132`'s
`tasks/nightly.yml` and `tests/workflows/characterization-with-drop.test.ts`'s
equivalent are `version: 3` **on purpose** — their v3-ness is what makes them
"a target that declares no inputs" (A-N5). Converting them would silently
change what the flip row asserts.

---

## 2. Behavior table (input → expected after P2b)

**PRESERVE** rows must be observably identical before and after. **NEW** rows
are behavior that could not previously exist. **CHANGE** rows are the
authorized flips, cross-referenced to §7.

### 2.1 Identity and preservation

| # | Input / situation | Expected after P2b | Evidence at head | Status |
|---|---|---|---|---|
| B-01 | any workflow step with **no** `with:` on **any** target | frozen target's canonical JSON is **byte-identical** to today (no `inputBindings` key), so `plan_hash` and every unit `inputHash` are byte-identical | `schema-v4.ts:277,346,381`; `step-work.ts:585-604` | PRESERVE (A-N7) |
| B-02 | a plain `exec:` / `run:` step's child environment | exact `AKM_*` name set unchanged: `AKM_RUN_ID`, `AKM_STEP_ID`, `AKM_UNIT_ID`, `AKM_PARAMS` (+ `AKM_ITEM`/`AKM_ITEM_INDEX` on fan-out, `AKM_INPUTS` when `inputs:` declared) | `step-work.ts:521-539`; `tests/integration/workflows/exec-unit.test.ts:426-433` | PRESERVE (B-N1) |
| B-03 | any v3 task through `akm task sync` | identical binding set, ids, ordinals, `source` strings, `enabled` values, and **byte-identical invocation tails** | `scheduler-binding.ts:166-190`; `scheduler-invocation.ts:220-243` | PRESERVE (B-N3) |
| B-04 | `akm task run <id>` with no input flags | run byte-identical to today: same prepare, same dispatch, same history row, same exit code | `run/load-task.ts:101-108` | PRESERVE |
| B-05 | `akm workflow run <ref> --<param>` (every existing case) | byte-identical messages, codes, coercion | `ir/params.ts` | PRESERVE |
| B-06 | `uses: akm/command` step with `with: {content}` / `with: {ref}` | consumed by `parseBuiltinCommandAction` exactly as today; scalar-only `with:` still enforced | `source-freeze-v4.ts:146-151`; `schema.ts:389` | PRESERVE (A-N3, A-N5) |
| B-07 | `version: 3` task composed from a workflow step with **no** `with:` | freezes to the same dispatch as today | `source-freeze-v4.ts:261-311` | PRESERVE |
| B-08 | `version: 3` task source anywhere | parses byte-identically; R-06 (exactly one scheduling source) still true for v3 | p2a §6 F-0 | PRESERVE |
| B-09 | the mechanical split (commit 2) alone | `bun run check` green; `plan_hash` for every frozen-plan fixture byte-identical; only `tests/workflows/direct-script-typed.test.ts`'s two path constants differ | §3.1, A-N2 | PRESERVE (mechanism-only) |

### 2.2 Freeze-time binding (Lane A2)

| # | Input / situation | Expected after P2b | Status |
|---|---|---|---|
| B-10 | step `with: {scope: all}` on `uses: tasks/<v4 ref>` declaring `scope` | freezes `{kind:"literal", name:"scope", value:"all"}` into the frozen target's `inputBindings` | **NEW** |
| B-11 | `with:` key that is not a declared input name | `UsageError` / `INPUT_BINDING_INVALID` **at freeze**; detail names the step, the target ref, the offending key, and the sorted declared set | **NEW** |
| B-12 | declared `required: true` input with no default, not supplied by `with:` | `UsageError` / `INPUT_BINDING_INVALID` **at freeze**; detail names the missing input | **NEW** |
| B-13 | literal value violating its declared schema (`--scope bogus` analogue) | `UsageError` / `INPUT_BINDING_INVALID` **at freeze**; detail carries `validateJsonSchemaSubset`'s error text, path-rooted at `with.<name>` | **NEW** |
| B-14 | `with: {files: {from: "steps.collect.output.files"}}`, `collect` an earlier step | freezes `{kind:"reference", name:"files", from:"steps.collect.output.files"}` | **NEW** |
| B-15 | `{from: "…", other: 1}` — `from` plus **any** other key | `INPUT_BINDING_INVALID` at freeze. **Never** silently a literal | **NEW** |
| B-16 | `{from: "not a reference"}` / `{from: 42}` / `{from: "steps.x"}` | `INPUT_BINDING_INVALID` at freeze, detail carries `parseReference`'s own message. **Never** silently a literal | **NEW** |
| B-17 | `{from: "steps.later.output"}` naming a **later** step, the step itself, or a nonexistent id | `INPUT_BINDING_INVALID` at freeze, detail says the step is not an earlier step of this workflow | **NEW** (A-N4) |
| B-18 | `{from: "params.undeclared"}` | `INPUT_BINDING_INVALID` at freeze, detail names the workflow's declared params | **NEW** (A-N4) |
| B-19 | a declared input with a `default`, not supplied by `with:` | the **default** is frozen as a `{kind:"literal"}` binding | **NEW** (A-N7) |
| B-20 | a declared **optional** input with no default, not supplied | **no** entry in `inputBindings` | **NEW** (A-N7) |
| B-21 | `with:` on `uses: tasks/<ref>` whose task declares **no** `inputs:` (v3 task, or v4 with no `inputs:`) — including `with: {}` | `UsageError` / `COMPOSITION_INVALID`, detail names the target and says it declares no inputs | **CHANGE** (§7 F-A3) |
| B-22 | `with:` on `uses: commands/<ref>` — including `with: {}` | `UsageError` / `COMPOSITION_INVALID`, detail says a command ref is not a binding surface | **CHANGE** (§7 F-A3) |
| B-23 | `with:` on `uses: scripts/<ref>` — including `with: {}` | `UsageError` / `COMPOSITION_INVALID`, detail says a script ref is not a binding surface | **CHANGE** (§7 F-A3) |
| B-24 | workflow step `uses: tasks/<ref>` whose task source is `version: 4` | **composes** — the LC-N1 deferral is gone | **CHANGE** (§7 F-A4, supersedes p2a B-24) |
| B-25 | non-scalar `with:` value on a `tasks/<ref>` step | **decodes**; freeze decides | **CHANGE** (§7 F-A2) |
| B-26 | non-scalar `with:` value on `akm/command` / `commands/` / `scripts/` / `workflows/` | `step <id> with.<key> must be a scalar` — byte-identical to today | PRESERVE (A-N3) |
| B-27 | `${{ … }}` inside a nested `with:` value on a task step | `step <id> with.<key> contains an unsupported expression` (the check now recurses) | **NEW** (A-N3) |
| B-28 | `with:` with no `uses:` | `step <id> with is legal only with uses` — byte-identical | PRESERVE |
| B-29 | a task whose target composes another task | the inner step's `with:` binds the INNER task's declared inputs only; **nothing** merges, forwards, or shadows | **NEW** (§1.1(2)) |
| B-30 | a workflow-target task step | still `INVALID_FLAG_VALUE` "A workflow task step cannot compose a nested workflow target." | PRESERVE |

### 2.3 Pre-attempt resolution (Lane A2, `step-work.ts`)

| # | Input / situation | Expected after P2b | Status |
|---|---|---|---|
| B-31 | reference resolves and the resolved value satisfies its declared schema | attempt reserved, unit dispatched, `AKM_TASK_INPUTS` / prompt block carries the **resolved** value | **NEW** |
| B-32 | reference resolves to a value **violating** its declared schema | `computeStepWorkList` returns `{ok:false, error}` naming the step, the input, the reference, and the schema error — **before** `reserveUnitAttempt` runs; **no** attempt row is journaled | **NEW** (§1.1(3)) |
| B-33 | reference names a step whose output is absent / a path segment that does not exist | same `{ok:false, error}` shape, carrying `resolveStepReference`'s message | **NEW** |
| B-34 | a literal binding | passes through with **no** re-resolution; its freeze-time schema check is not repeated | **NEW** |

### 2.4 Delivery (Lane B)

| # | Input / situation | Expected after P2b | Status |
|---|---|---|---|
| B-35 | shell-target task step with effective inputs | child env gains **exactly one** var, `AKM_TASK_INPUTS` = `canonicalInputJson(effectiveInputs)`. **Never** one var per input | **NEW** |
| B-36 | script-target task step with effective inputs | identical to B-35 | **NEW** |
| B-37 | `AKM_TASK_INPUTS` over `perVarBytes`, or the `AKM_*` total over `totalBytes` | unit fails `exec_context_too_large` **before** spawn, message names `AKM_TASK_INPUTS`, the byte count, and the platform limit | **NEW** (B-N1) |
| B-38 | command (agent/LLM) target task step with effective inputs | prompt gains the `## Task inputs` fenced JSON block after the declared-inputs block; `template.instructions` bytes unchanged; nothing interpolated into authored prose | **NEW** (B-N2) |
| B-39 | any target with **empty** effective inputs | no `AKM_TASK_INPUTS`, no prompt block — prompt and env byte-identical to today | PRESERVE (B-N1, B-N2) |
| B-40 | a task whose target is `uses: workflows/<ref>`, run via `akm task run` | effective inputs become the child run's **params**, through the existing `with:` → params path | **NEW** |
| B-41 | changing one **literal** binding's value | the unit's `inputHash` changes | **NEW** (§1.1(4), acceptance-critical) |
| B-42 | changing one **reference** binding's `from` string | the unit's `inputHash` changes | **NEW** (§1.1(4), acceptance-critical) |
| B-43 | re-running / resuming with identical bindings | `inputHash` byte-identical; the completed unit is reused | **NEW** |
| B-44 | any run at all | `akm.workflow.unit\0v5\0` and `hashVersion: 5` unchanged; `WORKFLOW_IR_V4_VERSION` unchanged | PRESERVE (A-N7) |

### 2.5 Schedule-supplied inputs (Lane B)

| # | Input / situation | Expected after P2b | Status |
|---|---|---|---|
| B-45 | v4 `schedule[i].inputs` non-empty | compiled binding's invocation tail is `task run <id> [--bundle <b>] --scheduled --<name> <value>…`, names sorted | **NEW** (B-N3) |
| B-46 | that binding's argv through `parseScheduledBindingArgv` | round-trips: same id, same target, same input flags | **NEW** |
| B-47 | a malformed input tail (bare flag, repeated name, odd token count, leading `-` value) | the existing `invalidSchedulerInvocation()` `ConfigError` / `INVALID_CONFIG_FILE` | **NEW** |
| B-48 | the scheduled run executes | the flags materialize through the **same** `parseTaskInputFlags` + `materializeInputFlags` path as `akm task run --<name>`; provenance is `schedule-binding` | **NEW** |
| B-49 | `akm task sync` on a v4 task with non-empty `schedule[i].inputs` | **no** warn; the compiled binding is **not** byte-identical to one with no inputs | **CHANGE** (§7 F-B2) |
| B-50 | `schedule[i].inputs` violating a declaration | still `TASK_SOURCE_INVALID` at **parse** time; additionally proven at sync time and recorded as a task failure if it ever reaches there | PRESERVE + **NEW** |
| B-51 | v4 task with **no** `schedule:` | zero bindings, zero failures, no diagnostic | PRESERVE (p2a B-06/B-07) |

### 2.6 `akm task explain` (Lane B)

| # | Input / situation | Expected after P2b | Status |
|---|---|---|---|
| B-52 | `akm task explain <ref>` on a v4 task | text output: source path, owning bundle, source version, declarations + defaults, supplied values with provenance, target kind + ref, effective execution settings with field-level provenance, schedule bindings | **NEW** |
| B-53 | `akm task explain <ref> --format json` | one JSON object on stdout with the same fields; stable key order | **NEW** |
| B-54 | `akm task explain <ref> --scope all` | `scope`'s provenance is `flag`; a defaulted input's is `default`; a schedule-supplied one's is `schedule-binding` | **NEW** |
| B-55 | `akm task explain <ref> --<undeclared>` | `UsageError` / `UNKNOWN_FLAG`, exit **2**, `{ok:false,error,code}` on stderr | **NEW** |
| B-56 | `akm task explain <ref>` on a fixture whose `env:`, `run:`, and prompt hold sentinel secrets | **no** sentinel appears in stdout or in the JSON envelope bytes | **NEW** (B-N4) |
| B-57 | `akm task explain <ref>` on a **v3** task | works; declarations list is empty; target kind/ref and execution settings still resolve | **NEW** |
| B-58 | `akm task explain` with no ref / an unknown ref | usage error exit **2** / `ASSET_NOT_FOUND` exit **1**, standard envelope | **NEW** |
| B-59 | `akm task run <id> …` argv classification | `isTaskRunWithId` still true; `explain` never classifies as a run | PRESERVE |

### 2.7 Migrator (Lane C)

| # | Input / situation | Expected after P2b | Status |
|---|---|---|---|
| B-60 | v3 doc with `akm.schedule: "@daily"` | `changed`: top-level `schedule: "@daily"` (string shorthand), `akm:` gone | **NEW** |
| B-61 | v3 doc with `on: { schedule: [{cron: …}] }` | `changed`: top-level `schedule:` list, ordinals preserved, `on:` gone | **NEW** |
| B-62 | v3 doc with `on: { workflow_dispatch: {} }` and no cron | `changed`: `schedule:` **ABSENT** (manual-only), with a per-file `notice` | **NEW** |
| B-63 | v3 doc with `akm.timeout` / `engine` / `model` / `redact` / `env` / `maxSteps` / `maxRetries` | `changed`: each re-homed to the identical top-level key with identical value bytes | **NEW** |
| B-64 | v3 doc with `akm.enabled: false` | `changed`: `enabled: false` on **every** compiled schedule entry (D2-N5 shape); a doc with no schedule and `enabled: false` is **blocked** (nothing to attach it to) | **NEW** |
| B-65 | v3 doc with `akm.when_to_use` / `tags` / `agent` / `inference` / `tools` | `changed`: re-homed top-level (p2a D2-N7's key set) | **NEW** |
| B-66 | v3 doc with `akm.outputSchema` | `changed`: becomes top-level `output:` | **NEW** |
| B-67 | v3 doc with a **github-action** `uses:` (`actions/checkout@v4`) | `blocked`, reason names the removed target. **Never guessed** | **NEW** |
| B-68 | anything ambiguous — an unrecognized `akm.*` member, a `with:` on a non-`akm/command` target, both `akm.schedule` and `on:`, a `version` that is not `3` | `blocked`; original bytes untouched | **NEW** |
| B-69 | a document already `version: 4` | `skipped` | **NEW** |
| B-70 | any plan containing a `blocked` file | `applyTaskToV4MigrationPlan` throws before writing **anything**; zero files replaced | **NEW** |
| B-71 | every `changed` output | pre-validated through the **real** `parseTaskSourceV4` before any backup is written | **NEW** (C-N1) |
| B-72 | a file mutated between preview and replace | `assertUnchanged` TOCTOU recheck throws; no file replaced | **NEW** |
| B-73 | a replace failing mid-run | reverse-order rollback from the O_EXCL backups; file modes preserved | **NEW** |
| B-74 | after a successful apply | re-inspect and require convergence (a second plan reports zero `changed`) | **NEW** |
| B-75 | `src/` importing anything from `scripts/` | zero occurrences | **NEW** (C-N1) |

### 2.8 Fixture sweep (Lane D)

| # | Input / situation | Expected after P2b | Status |
|---|---|---|---|
| B-76 | every swept fixture | authored as schedule-free task source v4; the test's assertion semantics are **unchanged** | **NEW** |
| B-77 | `bun run test:unit` / `test:integration` after the sweep | both floors pass; ran+skipped totals do **not** drop | PRESERVE (D-N1) |
| B-78 | the §6.2 exclusions | still `version: 3`; R-06 still true for v3 | PRESERVE |

---

## 3. Lane A — the freeze split, then the bindings

### 3.1 A1 — the mechanical split (commit 2, no behavior change)

#### 3.1.1 Files

| File | Contents |
|---|---|
| `src/workflows/freeze/source-freeze.ts` (new) | A-N1's entry set. |
| `src/workflows/freeze/resolve-steps.ts` (new) | A-N1's routing + shared step helpers + shared types. |
| `src/workflows/freeze/targets/command.ts` (new) | `commandDispatch`, `inlineDispatch`, `commandResult`. |
| `src/workflows/freeze/targets/shell.ts` (new) | `directShell`. |
| `src/workflows/freeze/targets/script.ts` (new) | `directScript`, `scriptResult`. |
| `src/workflows/freeze/targets/task.ts` (new) | `taskDispatch`. |
| `src/workflows/freeze/environment.ts` (new) | env freezing + bundle ownership (A-N1). |
| `src/workflows/freeze/identity.ts` (new) | `scriptExecutable`, `gitIdentity`. |
| `src/workflows/ir/source-freeze-v4.ts` (edited) | reduced to the three-symbol re-export shim. |
| `tests/workflows/direct-script-typed.test.ts` (edited) | **only** the two path constants + the describe title (A-N2, §7 F-A1). |

#### 3.1.2 Rules

- Function bodies move **byte-intact**. `git diff` for commit 2 must read as a
  move: no renames, no signature changes, no reordering of statements, no
  "while I'm here" simplifications.
- Every symbol keeps its exact name. Cross-module visibility is achieved by
  `export`ing what was file-private; nothing else changes.
- Import lists are re-derived mechanically. `src/workflows/ir/freeze-v4.ts:24`
  is **not** edited.
- Prose comments that cite `source-freeze-v4.ts:<line>` inside the moved bodies
  are updated to the new path in this commit (they are comments; A-N2).
- The commit is green on `bun run check` on its own.

### 3.2 A2 — files

| File | Contents |
|---|---|
| `src/workflows/freeze/task-bindings.ts` (new) | `freezeTaskInputBindings(...)`: the pure normalizer — authored `with:` record + `InputContract` + earlier-step ids + declared param names → `readonly TaskInputBinding[]`, or a thrown `UsageError`. No IO. |
| `src/workflows/freeze/targets/task.ts` (edited) | routes through `parseTaskSource` (A-N6); calls `freezeTaskInputBindings`; attaches `inputBindings` to the three result shapes. |
| `src/workflows/freeze/resolve-steps.ts` (edited) | the A-N5 `COMPOSITION_INVALID` guards for `commands/` and `scripts/` steps; threads the earlier-step-id list into `ResolutionContext`. |
| `src/workflows/source-ir/schema.ts` (edited) | A-N3: `with?: Record<string, unknown>` (`:144`), task-scoped `scalarRecord` relaxation (`:389`), recursive `rejectStepWithExpressions` (`:720`). |
| `src/workflows/ir/schema-v4.ts` (edited) | A-N7: `inputBindings?` on the three target interfaces; three `assertKeys` allowlists; three decoders. |
| `src/workflows/exec/step-work.ts` (edited) | §3.6 pre-attempt resolution; §4.1/§4.2 delivery. |
| `src/core/errors.ts` (edited) | A-N5: the `COMPOSITION_INVALID` remediation string. |
| `tests/workflows/task-input-bindings.test.ts` (new) | the §2.2 freeze matrix: codes **and** message bytes. |
| `tests/workflows/task-binding-identity.test.ts` (new) | B-01, B-41, B-42, B-43, B-44. |
| `tests/integration/workflows/task-binding-pre-attempt.test.ts` (new) | B-31–B-34, incl. "no attempt row was journaled". |

### 3.3 Normalization (`freezeTaskInputBindings`)

For each authored `with:` entry `[key, value]`, in authored order:

1. `key` must be a declared input name (`Object.hasOwn(contract, key)`), else
   `INPUT_BINDING_INVALID` (B-11).
2. **Reference test.** `value` is a `{kind:"reference"}` binding **iff** it is a
   non-null, non-array plain object whose **own key set is exactly
   `["from"]`** and whose `from` is a **string** that `parseReference` accepts.
3. **Hard-fail band.** If `value` is a plain object that has an own `from` key
   but fails (2) for **any** reason — extra keys, a non-string `from`, a
   `from` that `parseReference` rejects — it is `INPUT_BINDING_INVALID`
   (B-15, B-16). It is **never** reinterpreted as a literal.
4. Otherwise `value` is `{kind:"literal", name:key, value}` (B-10).

Then, over the whole contract:

5. Every declared `required: true` input must have a binding (B-12).
6. Every input with a `default` and no binding gets one at the default's value
   (B-19); every optional input with neither gets none (B-20).
7. Every **literal** value is validated with `validateInputs`
   (`input-contract.ts:148`), `pathRoot: "with"` (B-13).
8. Every **reference** is checked structurally: a `stepOutput` arm's `stepId`
   must be in the earlier-step id set (B-17); a `param` arm's `name` must be a
   declared workflow param (B-18). No *value* check happens here — that is
   §3.6's job.
9. The result is sorted by `name` and deep-frozen.

`freezeTaskInputBindings` is a **pure** function taking already-resolved
inputs. It imports `src/execution/input-contract.ts` and
`src/workflows/program/expressions.ts`; it does no IO and reads no config.

### 3.4 Where `inputBindings` lands

`taskDispatch` attaches the frozen array to whichever target shape it returns —
`commandResult`'s `FrozenWorkflowCommandTarget`, the inline
`FrozenWorkflowShellTarget`, or `scriptResult`'s
`FrozenWorkflowScriptTarget` — via `...(bindings.length > 0 ? { inputBindings:
bindings } : {})`. Absent when empty (A-N7). No other dispatch path ever sets
it.

### 3.5 Composition chains

There is **no** merge. `taskDispatch` builds the contract from **this** task's
own `parsed.v4.inputs` and normalizes **this** step's own `with:`. If that task
is itself composed from another workflow step, the outer step's bindings are
neither visible nor inherited. A test asserts a two-level chain where the outer
and inner tasks declare the **same** input name with different defaults and the
inner binding wins for the inner task, the outer for the outer.

### 3.6 Pre-attempt resolution (`step-work.ts`)

Insert immediately after the declared-`inputs:` resolution loop
(`step-work.ts:317-327`) and before fan-out item resolution — inside
`computeStepWorkList`, which returns `{ok:false, error}` and is reached long
before `reserveJournaledDispatch` (`native-executor.ts:1021`, called at
`:1137`) or `journalGateEvaluationStart`'s reservation (`step-work.ts:1207`):

```
resolveTaskInputBindings(target.inputBindings, contract, scope) →
  { ok: true, values } | { ok: false, error }
```

- `{kind:"literal"}` → the frozen value, unchanged, **not** re-validated.
- `{kind:"reference"}` → `resolveStepReference(from, scope)`; on failure return
  `{ok:false, error: 'Step "<id>" input "<name>" reference <from> failed to
  resolve: <message>'}` (B-33). On success, validate the resolved value with
  `validateInputs` restricted to that one declaration; on failure return
  `{ok:false, error: …}` naming the step, the input, the reference, and the
  schema error (B-32).
- The resolved map is stored on `StepWorkUnitContext` as
  `taskInputs?: Readonly<Record<string, unknown>>` — step-constant, serialized
  **once** as `taskInputsJson` alongside `execParamsJson` / `execInputsJson`
  (`step-work.ts:385-389`), never per unit.

**The declared contract at execution time.** `computeStepWorkList` has the
plan, not the task source. The contract needed for the resolved-value check is
therefore carried on the frozen binding itself: each `{kind:"reference"}`
entry additionally freezes `readonly schema: Readonly<Record<string, unknown>>`
— the declaration's bounded JSON Schema, already `default`/`required`-stripped
by P2a's parser (`input-contract.ts:73-78`). This keeps the pre-attempt check a
pure function of the plan, needs no source re-read at execution time, and is
covered by the input hash like everything else in the target. Literals carry no
schema (they were validated at freeze).

> **Contract note.** `TaskInputBinding`'s `reference` arm
> (`input-contract.ts:97-99`) is `{kind, name, from}` today. P2b widens it to
> `{kind, name, from, schema}`. That is an additive change to a type P2a
> declared for exactly this purpose and that nothing else constructs — the
> `literal` arm is untouched, so `run/load-task.ts:101-108`'s literal
> production is byte-unchanged.

---

## 4. Lane B — delivery, schedule inputs, `akm task explain`

### 4.1 Shell and script targets — `AKM_TASK_INPUTS`

`buildExecContextEnv` (`step-work.ts:521-540`) gains, after the `AKM_INPUTS`
line:

```
if (ctx.taskInputsJson !== undefined) env.AKM_TASK_INPUTS = ctx.taskInputsJson;
```

- Exactly **one** variable. Never `AKM_TASK_INPUT_<NAME>`, never one var per
  input — the roster is closed and enumerable, and per-input vars would collide
  with authored `env:` bindings.
- The payload is `canonicalInputJson(effectiveInputs)`
  (`input-contract.ts:322`) — sorted keys, stable bytes.
- Enforcement is `checkExecContextSize` (`exec-unit.ts:474`), unchanged
  (B-N1). Rows B-35, B-36, B-37.
- Absent when there are no effective inputs (B-39, B-02).

`src/workflows/resource-limits.ts`'s exec-context section comment and
`step-work.ts:512-513`'s note add `AKM_TASK_INPUTS` to the named roster. No new
constant.

### 4.2 Command (agent/LLM) targets — the fenced JSON block

`BuildUnitPromptInput` (`step-work.ts:610-624`) gains
`taskInputs?: Readonly<Record<string, unknown>>`; `buildUnitPrompt` appends
`taskInputsBlock` between `inputsBlock` and `gateBlock` (B-N2). Same
`safeJson` helper, same "attached context, never a splice" rule. Row B-38.

### 4.3 Workflow targets — child params

A task whose target is `uses: workflows/<ref>` delivers its effective inputs as
the child run's **params** through the existing `with:` → params path
(`src/tasks/runtime-v3.ts`, P0 row P-03,
`tests/integration/tasks-with-classification-characterization.test.ts:104`).

The two never collide: a v4 document may carry `with:` **only** on
`uses: akm/command` (p2a D2-N1), so a `uses: workflows/<ref>` v4 task has
`inputs:` and no `with:`; a v3 task has `with:` and no `inputs:`. P-03's
characterization test is a **v3** fixture and stays green unchanged. Row B-40.

### 4.4 Schedule bindings supply inputs

Per B-N3:

| File | Change |
|---|---|
| `src/tasks/scheduler-binding.ts:41-55` | `SchedulerSourceSchedule.inputs?: Readonly<Record<string, unknown>>` (additive). |
| `src/tasks/scheduler-binding.ts:166-190` | `invocation` moves inside the `.map` and appends the sorted flag tail when `schedule.inputs` is non-empty. |
| `src/tasks/scheduler-invocation.ts:220-243` | `parsePublicSchedulerInvocation` accepts the tail; `:362-367`'s message gains the optional clause. |
| `src/tasks/scheduler-sync.ts:519-546` | passes `inputs: schedule.inputs` on the v4 arm; validates each entry against `parsed.v4.inputs`; **deletes** the B-38 warn. |

Rows B-45–B-50. Row B-03 is the preservation canary: a v3 tail must not gain a
single byte.

### 4.5 `akm task explain`

| File | Contents |
|---|---|
| `src/commands/tasks/task-explain.ts` (new) | `akmTaskExplain(ref, opts)` → the envelope of B-N4. Read-only; no history write, no scheduler touch, no execution spawn. |
| `src/commands/tasks/tasks-cli.ts` (edited) | `tasksExplainCommand` (`defineJsonCommand`, positional `ref`, `...bundleArg`, exact-name input flags via the existing `parseTaskInputFlags`) added to `taskCommand.subCommands` (`:286`). |
| `src/cli.ts` | **unchanged** (`:508` already maps `task: taskCommand`). |
| `tests/contracts/command-cli-contract.test.ts` (edited) | §7 F-B3 — a `task explain` arm. |
| `tests/commands/task-explain.test.ts` (new) | B-52–B-59, including the secret-free sentinel test. |
| `tests/fixtures/goldens/cli/c-tasks-family.json` (edited) | a new `explain` key; existing `doctor` / `history` keys byte-unchanged. |

Field-level execution provenance is **read** from
`planExecutionCascade`'s `ResolvedExecutionPlanV1.provenance`
(`execution-cascade.ts:109-120`). `tests/contracts/execution-cascade-resolver.test.ts`
stays **byte-unchanged** — `explain` is a consumer, never a second resolver.

---

## 5. Lane C — the v3 → task source v4 migrator (`scripts/**` only)

### 5.1 Files

| File | Contents |
|---|---|
| `scripts/akm-migrate/migrate/task-to-v4.ts` (new) | Mirrors `task-to-v3.ts` exactly: `TaskToV4FileInput`, `TaskToV4{Changed,Skipped,Blocked}`, `TaskToV4FileOutcome`, `TaskToV4MigrationPlan`, `planTaskToV4File`, `taskToV4PlanFromOutcomes`, `planTaskToV4Migration`, plus the vendored legacy reader (C-N1). |
| `scripts/akm-migrate/migrate/task-files-to-v4.ts` (new) | Mirrors `task-files-to-v3.ts`: `inspectTaskToV4Files`, `taskMigrationBackupPathV4`, `assertUnchanged`, `applyTaskToV4MigrationPlan`. Reuses `./durable-fs`'s `fsyncDirectoryPortable` unchanged — one helper, no divergence. |
| `scripts/akm-migrate/task-migrate.ts` (edited) | A second generation wired the **same** way as `task-to-v3`: same `withConfigLock` + `withMaintenanceStartBarrier` + timestamped-UUID backup root + `--dry-run` plan + summary shape. |
| `scripts/akm-migrate/help.txt` (edited) | the new generation's usage. |
| `tests/migrate/task-v3-to-v4-files.test.ts` (new) | the ladder: B-70–B-74. |
| `tests/tasks/migrate-v3-to-v4.test.ts` (new) | the translation table: B-60–B-69. |
| `tests/fixtures/execution-contracts/tasks/v3-to-v4/**` (new) | the migrator's own fixtures — **excluded** from Lane D's sweep (§6.2 (a)). |

### 5.2 The ladder (order is binding, mirrored from `task-files-to-v3.ts:201-241`)

1. dry-run plan, per-file `changed | skipped | blocked`, each with `beforeHash`
   and (for `changed`) `afterHash`;
2. `withConfigLock` + `withMaintenanceStartBarrier`;
3. timestamped + UUID backup root;
4. **any** `blocked` file ⇒ throw before writing anything (B-70);
5. `assertUnchanged` + **pre-validate every output through the real
   `parseTaskSourceV4`** for every `changed` file (B-71, C-N1);
6. O_EXCL backups written for **all** changed files **before any mutation**
   (`writeDurable(..., exclusive = true)`);
7. per file: `assertUnchanged` TOCTOU recheck **immediately** before its
   replace (B-72), then `replaceAtomically` preserving mode;
8. on any failure: reverse-order rollback from the backups, only for files
   whose current bytes still equal the written `after` (B-73);
9. re-inspect and require convergence (B-74).

### 5.3 Translation table

| v3 | v4 | Outcome |
|---|---|---|
| `akm.schedule: "<cron>"` | top-level `schedule: "<cron>"` | `changed` |
| `on.schedule: [{cron}…]` | top-level `schedule:` list, ordinals preserved | `changed` |
| `on.workflow_dispatch` only, no cron | `schedule:` **absent** (manual-only) + a `notice` | `changed` |
| `akm.timeout` / `engine` / `model` / `redact` / `env` / `maxSteps` / `maxRetries` | identical top-level keys, identical value bytes | `changed` |
| `akm.when_to_use` / `tags` / `agent` / `inference` / `tools` | identical top-level keys (p2a D2-N7) | `changed` |
| `akm.outputSchema` | top-level `output:` | `changed` |
| `akm.description` | top-level `description:` | `changed` |
| `akm.enabled: false` **with** a schedule | `enabled: false` on every schedule entry | `changed` |
| `akm.enabled: false` **without** a schedule | — | **`blocked`** (nothing to attach it to) |
| `uses:` naming a github action | — | **`blocked`**, reason names the removal. Never guessed |
| both `akm.schedule` **and** `on:` | — | **`blocked`** |
| an unrecognized `akm.*` member | — | **`blocked`** |
| a `with:` on a non-`akm/command` target | — | **`blocked`** (p2a D2-N1) |
| `version: 4` already | — | `skipped` |
| anything else ambiguous | — | **`blocked`**, original bytes untouched |

`inputs:` is **never invented**. The migrator translates structure, not intent;
declaring inputs is an authoring decision.

---

## 6. Lane D — the v3 fixture sweep (own commit)

### 6.1 Head-verified candidate inventory (cross-check, not a contract — D-N1)

59 files under `tests/` match both `version: 3` and `schedule:` at the head
this spec was written against:

```
tests/commands/goldens-cli-health-tasks.test.ts
tests/core/adapter/akm-task-adapter.test.ts
tests/core/adapter/akm-validate.test.ts
tests/fixtures/bundles/akm-task/nightly-index.yml
tests/fixtures/bundles/akm-task/two-targets.yml
tests/fixtures/execution-contracts/tasks/v3-migration/*.yml            (7 files)
tests/fixtures/execution-contracts/workflows/plan-v4/tasks/plan-v4-task.yml
tests/fixtures/goldens/renderer/all-types.json
tests/fixtures/stashes/all-types/tasks/all-types-task.yml
tests/integration/cli-errors.test.ts
tests/integration/commands/tasks-bundle-target.test.ts
tests/integration/commands/tasks-cli-envelope.test.ts
tests/integration/commands/tasks-lifecycle.test.ts
tests/integration/file-context.test.ts
tests/integration/lint-task-yaml.test.ts
tests/integration/linux-standalone-scheduler.test.ts
tests/integration/proposals-validation.test.ts
tests/integration/proposals.test.ts
tests/integration/tasks-launchd-backend.test.ts
tests/integration/tasks-legacy-vocabulary-characterization.test.ts
tests/integration/tasks-provenance-characterization.test.ts
tests/integration/tasks-provenance-context.test.ts
tests/integration/tasks-result-vocabulary.test.ts
tests/integration/tasks-run-attempt-observability.test.ts
tests/integration/tasks-runner.test.ts
tests/integration/tasks-runtime-binding.test.ts
tests/integration/tasks-runtime-v3-runner.test.ts
tests/integration/tasks-scheduler-durable-v4-red.test.ts
tests/integration/tasks-scheduler-evidence-v4-remediation-red.test.ts
tests/integration/tasks-scheduler-source-snapshot.test.ts
tests/integration/tasks-scheduler-sync-v3.test.ts
tests/integration/tasks-scheduler-sync-v4.test.ts
tests/integration/tasks-scheduler-transaction.test.ts
tests/integration/tasks-scheduling-characterization.test.ts
tests/integration/tasks-schema.test.ts
tests/integration/tasks-sync.test.ts
tests/integration/tasks-with-classification-characterization.test.ts
tests/integration/workflows/immutable-resolution-v4-red.test.ts
tests/migrate/task-v2-to-v3-files.test.ts
tests/setup-scheduled-tasks.test.ts
tests/tasks-runtime-v3.test.ts
tests/tasks/bounded-document.test.ts
tests/tasks/migrate-v2-to-v3.test.ts
tests/tasks/parse-v3-adapter.test.ts
tests/tasks/prepare-split.test.ts
tests/tasks/source-v3.test.ts
tests/tasks/source-v4-adapter.test.ts
tests/tasks/source-v4.test.ts
tests/workflows/characterization-classification.test.ts
tests/workflows/characterization-with-drop.test.ts
tests/workflows/direct-script-typed.test.ts
tests/workflows/task-source-v4-deferral.test.ts
tests/workflows/with-rejection.test.ts
```

### 6.2 Exclusions (binding)

**(a)** `tests/fixtures/execution-contracts/tasks/v2/**`, the v2→v3 migrator's
fixtures (`tests/fixtures/execution-contracts/tasks/v3-migration/**`,
`tests/migrate/task-v2-to-v3-files.test.ts`,
`tests/tasks/migrate-v2-to-v3.test.ts`) and Lane C's own new
`tests/fixtures/execution-contracts/tasks/v3-to-v4/**`.

**(b)** `tests/tasks/source-v3.test.ts`, `tests/tasks-runtime-v3.test.ts`,
`tests/tasks/parse-v3-adapter.test.ts`, `tests/tasks/bounded-document.test.ts`,
`tests/tasks/source-v4.test.ts` and `tests/tasks/source-v4-adapter.test.ts`'s
**routing** fixtures, `tests/integration/tasks-runtime-v3-runner.test.ts`,
`tests/integration/tasks-scheduler-sync-v3.test.ts`,
`tests/integration/tasks-schema.test.ts`, and any other test whose SUBJECT is
v3 parsing, v3 routing, or v3 migration.

**(c)** the P0 characterization files pinning v3 behavior:
`tests/integration/tasks-scheduling-characterization.test.ts` (R-06 must stay
true for v3), `tests/integration/tasks-provenance-characterization.test.ts`,
`tests/integration/tasks-legacy-vocabulary-characterization.test.ts`,
`tests/integration/tasks-with-classification-characterization.test.ts`,
`tests/workflows/characterization-classification.test.ts`,
`tests/workflows/characterization-with-drop.test.ts`.

**(d)** (added by D-N1) any fixture named by §7's flips table —
`tests/workflows/with-rejection.test.ts`,
`tests/workflows/characterization-with-drop.test.ts`,
`tests/workflows/direct-script-typed.test.ts`,
`tests/workflows/task-source-v4-deferral.test.ts`. Their v3-ness is
load-bearing for what the flip asserts.

### 6.3 Rules

- **Mechanical only.** Replace the v3 header (`version: 3` + the `akm:` bag's
  synthetic `schedule: "@daily"`) with `version: 4` and the corresponding
  top-level keys. Do not rename fixtures, do not restructure `describe`/`test`
  blocks, do not add or remove assertions, do not "tidy" adjacent code.
- Any file where the conversion would change what the test **asserts** is
  moved into the exclusion list and the reason is recorded in the Review log.
- Record the pre-sweep and post-sweep ran+skipped totals for both targets
  (D-N1).
- Land as **one** commit containing nothing else.

---

## 7. AUTHORIZED-FLIPS table

Nothing outside this table may change observably. Every affected pre-existing
test is enumerated by file, with the disposition of every test in that file
that the flip touches.

### F-A1 — the split re-points one path-scoped AST scan (commit 2)

| Test / surface (at head) | Disposition |
|---|---|
| `tests/workflows/direct-script-typed.test.ts:366-430` — `SOURCE_FREEZE_V4_FILE` and the two `scanFunctionCalls` tests (`:412` directScript, `:424` taskDispatch) | **FLIP (path only).** Becomes two constants (`.../freeze/targets/script.ts`, `.../freeze/targets/task.ts`); the describe title is updated; **every assertion is retained verbatim.** |
| `tests/workflows/direct-script-typed.test.ts:252-338` (whole-`src/` greps for `schedule: "@daily"` and the synthetic-YAML literals) | **UNCHANGED, must stay green** — path-independent, and the split must not reintroduce a fabrication. |
| `tests/workflows/direct-script-typed.test.ts` — everything else | **UNCHANGED, must stay green.** |
| `src/workflows/ir/freeze-v4.ts:24` | **VERIFY UNCHANGED** — the shim preserves the import path. |
| `src/core/errors.ts:98`, `src/tasks/prepare/prepare.ts:18`, `src/tasks/prepare/prepare-script-target.ts:8`, `tests/tasks/prepare-split.test.ts:20,61,199,212,218` | **Prose only** — path citations in comments. Not a flip. |

### F-A2 — `with:` decode widens for task targets only (A-N3)

| Test / surface (at head) | Disposition |
|---|---|
| `src/workflows/source-ir/schema.ts:144,389,720,879` | **CHANGE** per A-N3. |
| `tests/workflows/characterization-with-drop.test.ts:98` — *"R-01(b): scalarRecord still rejects a non-scalar with value on a tasks/x step (schema.ts:389)"* | **FLIP (re-scoped).** The same assertion is retained for an `akm/command` step and a `commands/<ref>` step; a **new** sibling asserts a `tasks/<ref>` step now decodes a nested value. The test is **not** deleted. |
| `tests/workflows/characterization-with-drop.test.ts:65,73,104,117` | **UNCHANGED, must stay green.** |
| `tests/workflows/source-ir-contract.test.ts:269-277` (sorted-key scalar `with` serialization), `:323` (depth guard), `:462-468`, `:497`, `:509`, `:1097`, `:1115` | **UNCHANGED, must stay green** — all scalar/`akm/command` cases. |

### F-A3 — `COMPOSITION_INVALID` narrows for tasks and grows to `commands/` / `scripts/` (A-N5)

| Test / surface (at head) | Disposition |
|---|---|
| `src/workflows/freeze/targets/task.ts` (was `source-freeze-v4.ts:222-226`) | **CHANGE**: the unconditional rejection becomes the no-declared-inputs rejection; message bytes change. |
| `src/workflows/freeze/resolve-steps.ts` (was `source-freeze-v4.ts:146-151`) | **CHANGE (new rejection)**: a `with:` on `commands/<ref>` / `scripts/<ref>` now fails instead of being silently dropped. **Breaking** — CHANGELOG entry required. |
| `src/core/errors.ts:178` (`COMPOSITION_INVALID` remediation) | **CHANGE**: names the two real causes; no longer promises a future release. |
| `tests/workflows/with-rejection.test.ts:57` (`COMPOSITION_INVALID_MESSAGE`), `:159` (B-02), `:176` (B-03), `:218` (B-02b) | **FLIP (message bytes only).** Code stays `COMPOSITION_INVALID`; the fixture task stays `version: 3` (§6.2 (d)); the structure of each test is retained. |
| `tests/workflows/with-rejection.test.ts:86` (manifest `reasonCode`), `:95` (decode/compile), `:250` (B-04 without-`with:`), `:280` (B-05 `akm/command`) | **UNCHANGED, must stay green.** |
| `tests/fixtures/execution-contracts/workflows/manifest.json` `rejected[]` entry `with-on-task-composition` | **UNCHANGED** — still `COMPOSITION_INVALID`; only its `note` prose may be updated. |
| `tests/workflows/characterization-with-drop.test.ts:169` (R-01(c)) | **FLIP (message bytes only).** |
| `tests/architecture/diagnostic-codes.test.ts` | **VERIFY green.** P2b mints **no new code** — `COMPOSITION_INVALID` (`errors.ts:99`) and `INPUT_BINDING_INVALID` (`:114`) both exist. |

### F-A4 — the LC-N1 task-source-v4 composition deferral is lifted (A-N6)

| Test / surface (at head) | Disposition |
|---|---|
| `src/workflows/freeze/targets/task.ts` (was `source-freeze-v4.ts:231-256`) | **CHANGE**: peek-and-throw deleted; routes through `parseTaskSource` + `projectTaskSourceV4`. |
| `tests/workflows/task-source-v4-deferral.test.ts:75` — *"…rejects with UsageError/TASK_SOURCE_INVALID naming the deferral, byte-exact"* | **FLIP.** Rewritten in place (same path) to assert a `version: 4` target **composes**: the step freezes, and its bindings land. |
| `tests/workflows/task-source-v4-deferral.test.ts:112` — *"the identical step targeting a version: 3 task is unaffected"* | **UNCHANGED, must stay green.** |
| `docs/plans/specs/p2a-task-source-v4.md` row **B-24** + its LC-N1 section | **Prose only**: a dated Review-log entry recording that P2b supersedes B-24. Do not edit the row's pinned text. |

### F-A5 — the frozen target key sets gain `inputBindings` (A-N7)

| Test / surface (at head) | Disposition |
|---|---|
| `src/workflows/ir/schema-v4.ts:77,90,99` (interfaces), `:277,346,381` (`assertKeys`), the three decoders | **CHANGE (additive)**: one optional field + one allowlist entry + one decoder branch each. |
| `src/workflows/ir/schema-v4.ts:360-366` (the shell `contentHash` preimage) and the command/script equivalents | **VERIFY UNCHANGED** — `inputBindings` deliberately sits outside them. |
| `src/workflows/exec/step-work.ts:585-604` (`computeUnitInputHash`) | **VERIFY UNCHANGED** — `akm.workflow.unit\0v5\0`, `hashVersion: 5`, and the field list are byte-identical; `frozenTarget` already covers the new field. |
| `tests/integration/workflows/native-executor.test.ts`, `tests/integration/workflows/frozen-plan*.test.ts`, `tests/workflows/plan-hash*.test.ts`, the chaos / run-lease / crash-window suites | **UNCHANGED, must stay green** — absence-when-empty (B-01) is what makes this true. |
| `src/execution/input-contract.ts:97-99` (`TaskInputBinding`'s reference arm) | **CHANGE (additive)**: gains `schema` (§3.6). The `literal` arm is untouched. |
| `tests/execution/input-contract.test.ts` | **EXTEND** — new coverage for the widened reference arm; existing tests unchanged. |
| `src/tasks/run/load-task.ts:101-108` | **VERIFY UNCHANGED** — it only produces literals. |

### F-B1 — `AKM_TASK_INPUTS` joins the exec context (B-N1)

| Test / surface (at head) | Disposition |
|---|---|
| `src/workflows/exec/step-work.ts:521-540` (`buildExecContextEnv`), `:380-389`, `:426-427` (`StepWorkUnitContext`) | **CHANGE (additive)**. |
| `src/workflows/resource-limits.ts:145-176` (section comment roster), `src/workflows/exec/step-work.ts:512-513` (note) | **Prose only** — the "cap row". No new constant, no new bound. |
| `src/workflows/exec/exec-unit.ts:474-517` (`checkExecContextSize`, `contextTooLarge`) | **VERIFY UNCHANGED** — the loop is generic. |
| `tests/integration/workflows/exec-unit.test.ts:426-433` (exact allowed `AKM_*` set), `:1150-1240` (the `AKM_INPUTS` / `AKM_PARAMS` / `AKM_ITEM` ceiling tests) | **UNCHANGED, must stay green**; a **new** sibling covers `AKM_TASK_INPUTS` over the ceiling (B-37). |

### F-B2 — schedule inputs are delivered (B-N3)

| Test / surface (at head) | Disposition |
|---|---|
| `src/tasks/scheduler-binding.ts:41-55,166-190` | **CHANGE (additive)**. |
| `src/tasks/scheduler-invocation.ts:220-243,362-367` | **CHANGE (additive)**: the optional input-flag tail. |
| `src/tasks/scheduler-sync.ts:519-546` | **CHANGE**: passes `inputs`, validates them, **deletes** the B-38 warn. |
| `tests/integration/tasks-scheduler-sync-v4.test.ts:185` — *"schedule[i].inputs non-empty warns exactly once…, and the compiled binding is byte-identical to one with no inputs"* | **FLIP.** Rewritten: no warn, and the tail carries the sorted flags. |
| `tests/integration/tasks-scheduler-sync-v4.test.ts:60,80,105,131,158,242` | **UNCHANGED, must stay green** (`:131` — no warn for a manual-only v4 task — becomes trivially stronger). |
| `tests/tasks/scheduler-binding.test.ts` | **UNCHANGED, must stay green** — v3 never sets `inputs`. |
| `tests/integration/tasks-scheduler-sync-v3.test.ts` (897 lines) | **UNCHANGED, must stay green** — byte-identical tails (B-03). |
| `tests/integration/tasks-scheduler-invocation.test.ts` | **EXTEND** — round-trip and malformed-tail coverage (B-46, B-47). Existing cases unchanged. |
| `tests/integration/commands/tasks-cli-envelope.test.ts` | **VERIFY green** — no argv shape it pins changes for a v3 task. |

### F-B3 — `akm task explain` joins the task family (B-N4)

| Test / surface (at head) | Disposition |
|---|---|
| `src/commands/tasks/tasks-cli.ts:280-300` (`taskCommand.subCommands`) | **CHANGE (additive)**: `explain`. |
| `src/cli.ts:508,632-647` | **VERIFY UNCHANGED**. A test covers `akm task explain <ref>` not classifying as a task run (B-59). |
| `tests/contracts/command-cli-contract.test.ts` (24 lines) | **EXTEND** in the same commit (§1.2, binding): a `task explain` arm pinning the `ref` positional and `format` flag. The existing `command run` test is unchanged. |
| `tests/commands/goldens-cli-health-tasks.test.ts` + `tests/fixtures/goldens/cli/c-tasks-family.json` | **EXTEND** with an `explain` golden; the existing `doctor` / `history` keys are byte-unchanged. |
| `src/assets/hints/cli-hints-full.md:354-372`, `docs/reference/cli.md` | **EXTEND** — one line for the new verb. |
| `tests/completions.test.ts`, `tests/integration/completions-install.test.ts` | **VERIFY green** (p2a LC-N2: completions do not enumerate task subcommands). |
| `tests/contracts/execution-cascade-resolver.test.ts` | **UNCHANGED, must stay green** — `explain` is a consumer. |

### F-B4 — the command-target prompt gains a task-inputs block (B-N2)

| Test / surface (at head) | Disposition |
|---|---|
| `src/workflows/exec/step-work.ts:610-675` (`BuildUnitPromptInput`, `buildUnitPrompt`) | **CHANGE (additive)**: `taskInputs?` + `taskInputsBlock`. |
| `src/assets/prompts/workflow-unit-preamble.md` | **VERIFY UNCHANGED**. |
| `tests/integration/workflows/chaos.test.ts:629` (`## Declared inputs` slice), `tests/integration/workflows/native-executor.test.ts`, `tests/workflows/ir-compile.test.ts:529` | **UNCHANGED, must stay green** — the block appears only for non-empty bindings (B-39). |

### F-C1 — the migrator (disjoint)

| Test / surface (at head) | Disposition |
|---|---|
| `scripts/akm-migrate/migrate/task-to-v4.ts`, `task-files-to-v4.ts`, `tests/migrate/task-v3-to-v4-files.test.ts`, `tests/tasks/migrate-v3-to-v4.test.ts`, `tests/fixtures/execution-contracts/tasks/v3-to-v4/**` | **NEW files only.** |
| `scripts/akm-migrate/task-migrate.ts`, `scripts/akm-migrate/help.txt` | **CHANGE (additive)**: a second generation wired like the first. |
| `scripts/akm-migrate/migrate/task-to-v3.ts`, `task-files-to-v3.ts`, `durable-fs.ts` | **UNCHANGED** — `durable-fs.ts` is **shared**, not copied. |
| `tests/migrate/task-v2-to-v3-files.test.ts`, `tests/tasks/migrate-v2-to-v3.test.ts` | **UNCHANGED, must stay green.** |

### F-D1 — the fixture sweep (own commit)

| Test / surface | Disposition |
|---|---|
| Every file in §6.1 **minus** §6.2's exclusions | **FLIP (fixture bytes only).** `version: 3` + synthetic `akm.schedule` → schedule-free task source v4. Assertion semantics must not drift. |
| Every file in §6.2 | **UNCHANGED, must stay green.** |
| `scripts/test-unit.sh:52`, `scripts/test-integration.sh:44` | **VERIFY green** — floors pass and totals do not drop (D-N1). |

---

## 8. Preservation gates (the reviewer runs these)

- [ ] `tests/integration/tasks-runtime-v3-runner.test.ts` green and
      **byte-unchanged**.
- [ ] `tests/contracts/execution-cascade-resolver.test.ts`,
      `tests/contracts/execution-json.test.ts`,
      `tests/contracts/execution-source-loader.test.ts`,
      `tests/contracts/resolved-execution-contract.test.ts`,
      `tests/contracts/command-invocation-contract.test.ts` green and
      **byte-unchanged**.
- [ ] Frozen-plan, chaos, run-lease, and crash-window suites green — with
      **byte-identical `plan_hash` and unit `inputHash`** for every fixture
      that authors no `with:` on a task step (B-01).
- [ ] Workflow param suites green and **byte-unchanged**:
      `tests/workflows/workflow-param-flags.test.ts`,
      `tests/integration/workflows/params-validation.test.ts`.
- [ ] Every P0 characterization suite green except §7's enumerated flips —
      `tests/integration/tasks-scheduling-characterization.test.ts` (all three
      R-06 tests, v3 unchanged),
      `tests/integration/tasks-provenance-characterization.test.ts`,
      `tests/integration/tasks-legacy-vocabulary-characterization.test.ts`,
      `tests/integration/tasks-with-classification-characterization.test.ts`,
      `tests/workflows/characterization-classification.test.ts`.
- [ ] `tests/tasks/source-v3.test.ts`, `tests/tasks/parse-v3-adapter.test.ts`,
      `tests/tasks/prepare-split.test.ts`, `tests/tasks/run-split.test.ts`,
      `tests/tasks/model-contracts.test.ts`,
      `tests/tasks/bounded-document.test.ts` green and **byte-unchanged**.
- [ ] `tests/integration/tasks-scheduler-sync-v3.test.ts` and
      `tests/tasks/scheduler-binding.test.ts` green and **byte-unchanged**
      (B-03).
- [ ] `tests/architecture/import-cycle-ratchet.test.ts` green with **no new
      cycle participant** — in particular none among
      `src/workflows/freeze/**` (A-N1).
- [ ] `tests/architecture/src-fn-size-ratchet.test.ts` green with **no baseline
      additions** — the split adds no function, and every new function stays
      under `SRC_FN_SIZE_BAR`.
- [ ] `tests/architecture/diagnostic-codes.test.ts` green; **no new diagnostic
      code minted** (§7 F-A3).
- [ ] **Commit 2 in isolation**: `bun run check` green, and
      `git show --stat` reads as a pure move plus `tests/workflows/direct-script-typed.test.ts`'s
      two path constants.
- [ ] `rg -n 'from "\.\./\.\./scripts|from "\.\./scripts|scripts/akm-migrate' src/`
      returns zero hits (C-N1).
- [ ] `rg -F 'schedule: "@daily"' src/` and `rg -F 'version: 3\nuses:' src/`
      still return zero hits.
- [ ] `bun scripts/lint-doc-examples.ts` clean.
- [ ] `bun run test:unit` and `bun run test:integration` both pass their floors
      with ran+skipped totals **not lower** than the pre-sweep run (D-N1).
- [ ] `bunx biome check --write src/ tests/` produces no further changes;
      `bunx tsc --noEmit` clean; `bun run check` passes; `bun run build`
      emits no `dist/scripts` and no `dist/tests`.

---

## 9. Docs that ride with the code

- [ ] `docs/reference/workflow-schema.md:79-85` — replace the "task-call inputs
      arrive in a later 0.9.x release" paragraph: `with:` on a task-composed
      step now **binds the target task's declared `inputs:`**; literal and
      `{from: …}` reference forms; the no-declared-inputs rejection; and an
      explicit statement that `uses: commands/<ref>` and `uses: scripts/<ref>`
      are **not** binding surfaces and now reject a `with:` (A-N5). Document
      the `AKM_TASK_INPUTS` variable next to the existing `AKM_*` roster and
      its platform ceiling guidance.
- [ ] `docs/reference/tasks.md` — task source v4 `inputs:` as a *binding
      surface*; `schedule[].inputs` now delivered; `akm task explain` with a
      worked example of both output formats and its secret-free guarantee.
- [ ] `docs/guides/author-workflows.md` — one worked task-composition example:
      a v4 task with `inputs:`, a workflow step binding a literal **and** a
      `{from: "steps.<id>.output.…"}` reference, and what the composed target
      receives on each of the three delivery surfaces.
- [ ] `CHANGELOG.md` `[Unreleased]` — under "Breaking changes & migration":
      (1) `with:` on `uses: commands/<ref>` / `uses: scripts/<ref>` is now
      rejected instead of silently dropped (F-A3); (2) `with:` on
      `uses: tasks/<ref>` binds declared inputs and the P1a "not supported yet"
      message is gone (F-A3, F-A4); (3) the task-source-v4 composition deferral
      is lifted (F-A4); (4) `schedule[].inputs` are delivered and the sync-time
      "not yet delivered" warning is gone (F-B2). Under features: `akm task
      explain`, `AKM_TASK_INPUTS`, and the v3 → task source v4 migrator.
      Say explicitly that **no plan/hash version changed**.
- [ ] `docs/migration/v0.9.1-to-v0.9.2.md` — the v3 → task source v4 migration
      procedure: the dry-run plan, the `changed | skipped | blocked` statuses,
      what is blocked and why (github-action targets, ambiguity), where backups
      land, and how to roll back.
- [ ] `docs/plans/specs/p2a-task-source-v4.md` Review log — the B-24/LC-N1
      supersession note (F-A4). A close-out obligation, not optional.
- [ ] Every `akm …` example in every touched doc passes
      `scripts/lint-doc-examples.ts`.

---

## 10. Acceptance criteria

**Structure**

- [ ] `src/workflows/freeze/{source-freeze,resolve-steps,environment,identity}.ts`
      and `src/workflows/freeze/targets/{command,shell,script,task}.ts` exist and
      hold exactly A-N1's assignment; `src/workflows/ir/source-freeze-v4.ts` is
      a three-symbol re-export shim and contains **no function declaration**.
- [ ] Commit 2 contains **only** the split (plus F-A1's two path constants) and
      is green on `bun run check` on its own.
- [ ] `src/workflows/ir/environment-v4.ts`, `freeze-v4.ts`, `plan-hash.ts` are
      **byte-unchanged by commit 2**.
- [ ] `src/workflows/freeze/task-bindings.ts` exports a **pure**
      `freezeTaskInputBindings` — no IO, no config reads — importing only
      `src/execution/input-contract.ts`, `src/workflows/program/expressions.ts`,
      and `src/core/errors.ts`.
- [ ] `src/execution/**` still imports nothing from `src/workflows/**`
      (p2a D3-N1 still holds).
- [ ] `scripts/akm-migrate/migrate/task-to-v4.ts` +
      `task-files-to-v4.ts` exist, share `./durable-fs`, and validate their
      output through the real `parseTaskSourceV4`; `src/` imports nothing from
      `scripts/` (C-N1, B-75).

**Behavior**

- [ ] Every PRESERVE row of §2 holds, verified by its cited test.
- [ ] Every NEW row of §2 has at least one test asserting its code **and** its
      message text.
- [ ] `{from}` plus any other key, and a `from` that fails `parseReference`, are
      **hard** `INPUT_BINDING_INVALID` at freeze — a test proves neither is ever
      reinterpreted as a literal (B-15, B-16, §1.1(2)).
- [ ] Unknown input name, missing required-without-default, a literal violating
      its schema, and a reference naming a non-earlier step all fail at
      **FREEZE**, before the plan is published (B-11–B-13, B-17).
- [ ] A reference whose **resolved** value violates its declared schema fails
      **before `reserveUnitAttempt`**, proven by asserting the run's unit-attempt
      table is empty for that unit (B-32).
- [ ] A changed **literal** and a changed **reference** each change the unit
      input hash (B-41, B-42) — §1.1(4)'s mandatory test.
- [ ] `akm.workflow.unit\0v5\0`, `hashVersion: 5`, and `WORKFLOW_IR_V4_VERSION`
      are byte-unchanged, and a step with no `with:` produces a frozen target
      whose canonical JSON is byte-identical to today (B-01, B-44).
- [ ] Exactly **one** `AKM_TASK_INPUTS` variable is emitted for shell/script
      targets, never one per input, and it is absent when there are no effective
      inputs (B-35, B-36, B-39).
- [ ] An over-ceiling `AKM_TASK_INPUTS` fails `exec_context_too_large` **before**
      spawn with a message naming the variable (B-37).
- [ ] The command-target block is **appended**, never interpolated; the preamble
      asset and `template.instructions` are byte-unchanged (B-38, B-N2).
- [ ] No merge semantics: a two-level composition chain test proves the outer
      step's bindings are invisible to the inner task (B-29).
- [ ] A v3 scheduler binding's invocation tail is **byte-identical**; a v4 tail
      with `schedule[i].inputs` round-trips through `parseScheduledBindingArgv`
      and a malformed tail is refused (B-03, B-45–B-47).
- [ ] `akm task explain` prints every B-N4 field, in both formats, and a
      sentinel-secret fixture proves nothing banned reaches stdout or the JSON
      bytes (B-52–B-58).
- [ ] The migrator's ladder holds in order, blocks what §5.3 says to block, never
      guesses a github-action target, and converges (B-60–B-74).

**Gates**

- [ ] Every gate in §8 ticked.
- [ ] Every §7 flip is a **visible test diff**; no existing test was deleted to
      make a flip disappear. In particular
      `tests/workflows/characterization-with-drop.test.ts:98` is **re-scoped,
      not removed**, and `tests/workflows/task-source-v4-deferral.test.ts:112`
      survives verbatim.
- [ ] Lane D is one commit containing nothing else, and reverting it alone
      leaves the tree green.
- [ ] §9's CHANGELOG entries and the p2a Review-log supersession note are both
      landed.
- [ ] Every behavior difference observed during implementation that is not in §7
      is recorded in the Review log and **not** silently absorbed. The
      already-known items to carry there: the `commands/` / `scripts/`
      `with:` rejection being a genuinely new rejection rather than a
      "remaining" one (A-N5); the `TaskInputBinding` reference arm widening with
      `schema` (§3.6); and the §1.4 fixture count (66) not matching the
      head-verified inventory (D-N1).

---

## Review log

<!-- Reviewers append dated entries below. -->

### 2026-08-27 — Lane D (fixture sweep) close-out

Re-derived the candidate set per D-N1's exact command at implementation time:
72 files matched `version: 3` + `schedule:` (comm -12 over `rg -l`), minus
`tests/architecture/task-fixture-vocabulary.test.ts` itself (D-N1's own
inventory ratchet, which reimplements the same intersection in `node:fs` and
excludes itself by construction) = 71 tracked matches. After applying §6.2's
named exclusions plus the four files already carrying the flip/identity
comments that self-declare their own exclusion (`tests/tasks/prepare-split.test.ts`,
`tests/tasks/source-v4.test.ts`, `tests/tasks/source-v4-adapter.test.ts`,
`tests/workflows/task-binding-identity.test.ts`), 31 files remained as the
sweep's candidate set. All 31 were converted or, where conversion was
genuinely load-bearing, excluded with a comment at the fixture site — the six
files below are recorded here as spec §6.3 requires ("Any file where the
conversion would change what the test asserts is moved into the exclusion
list and the reason is recorded in the Review log") and are also added to
`tests/architecture/task-fixture-vocabulary.test.ts`'s `ALLOWED_EXACT_FILES`
with matching per-file comments, since that ratchet is this lane's own
inventory contract and its own header text anticipates exactly this update
("A file discovered mid-sweep whose v3-ness turns out to be genuinely
load-bearing … is added to ALLOWED_EXACT_FILES below").

**New exclusions found during the sweep (not previously named by §6.2):**

1. `tests/integration/commands/tasks-cli-envelope.test.ts` and
   `tests/integration/tasks-runner.test.ts` — task source v4's
   per-schedule-binding `enabled` is deliberately NOT projected into the
   document-level flag `runTask`'s own disabled-dispatch skip reads
   (`src/tasks/source/project-v4.ts`'s header; `src/tasks/prepare/prepare-support.ts:120`
   derives `enabled: document.akm?.enabled !== false`, always `true` for a
   v4-projected document). Both files have one fixture each (a shared
   `describe("runTask — disabled tasks", …)` case, and a "scheduler-generated
   invocation … skips the disabled task" case) whose assertion depends on
   that runtime skip actually firing — unreachable for a v4 source under the
   current runtime. `tests/integration/tasks-runner.test.ts` additionally
   keeps ONE more test (`"threads declared maxSteps / maxRetries into the
   orchestrator"`) on v3: it asserts `with:` params flow to a
   `uses: workflows/<ref>` task's child run, and P2a D2-N1 restricts v4's
   `with:` to `uses: akm/command` only, so no v4 fixture can express the same
   claim (spec §4.3 already calls out the sibling P-03 characterization for
   the identical reason). Every OTHER fixture in both files converted
   cleanly to schedule-free v4.
2. `tests/integration/commands/tasks-lifecycle.test.ts` — one test
   ("setup-style enable edits stay inside the v3 akm mapping") exercises
   `setEnabledInYaml` (`src/commands/tasks/tasks.ts`) byte-for-byte; that
   function is a v3-YAML-text splice used only by `akm task add`'s
   `--disabled` path, which this spec's §0 says keeps writing v3 sources
   throughout P2b. Every other fixture in the file converted cleanly.
3. `tests/integration/tasks-scheduler-sync-v4.test.ts` — already named by
   §7 F-B2's own disposition table ("tests/integration/tasks-scheduler-sync-v4.test.ts:60,80,105,131,158,242
   — UNCHANGED, must stay green"); line 105's test is a v3/v4 coexistence
   proof by construction ("a manual-only version: 4 task alongside a
   normally-scheduled version: 3 task"). Recorded here only because D-N1's
   inventory ratchet needed the file added to its allowlist to go green — no
   new fact beyond what F-B2 already states.
4. `tests/core/adapter/akm-validate.test.ts` — every occurrence sits in a
   test whose own name says its subject is v3 parsing ("task missing the v3
   version", "a valid v3 task omitting optional akm.enabled", "a task with a
   non-boolean akm.enabled", "a task omitting version"), asserting v3-only
   field paths or v3's own preserved error wording — squarely §6.2(b)'s
   catch-all, just not enumerated by name there.
5. `tests/setup-scheduled-tasks.test.ts` — `akm setup`'s scheduled-task
   review step (`src/setup/steps/tasks.ts`'s `listSetupTaskDefinitions` /
   `prepareSetupTaskDefinitions`) calls `parseTaskV3Yaml` and
   `setTaskV3EnabledInYaml` directly; there is no `parseTaskSource` version
   routing on this path at all. A v4 fixture would not silently change
   behavior here, it would throw "version … must be exactly 3" — this
   subsystem is unrouted, not merely v3-preferring, and is out of P2b's
   scope entirely (not touched by any of the four P2b lanes).

**Pre-existing failures on HEAD, unrelated to Lane D (verified by `git
stash`-ing this lane's entire diff and re-running the named files in
isolation — identical failures with or without the sweep):**

- `tests/workflows/characterization-with-drop.test.ts` — `R-01(b)` and
  `R-01(c)` fail; these are §7 F-A2 and F-A3's own named flips
  ("characterization-with-drop.test.ts:98" re-scope, ":169" message-byte
  flip) not yet applied to this file.
- `tests/workflows/task-source-v4-deferral.test.ts` — the `LC-N1` test fails
  (`TASK_SOURCE_INVALID` expected, `INVALID_FLAG_VALUE` received); this is
  §7 F-A4's own named flip ("rewritten in place … to assert a version: 4
  target composes"), not yet applied.
- `tests/workflows/direct-script-typed.test.ts` — `taskDispatch (the same
  file, unrelated to R-02) still legitimately calls parseTaskV3Yaml(...)`
  fails (`parseTaskV3Yaml` expected in `taskDispatch`'s call set, not
  found) — a consequence of A-N6 already routing `taskDispatch` through
  `parseTaskSource` instead, uncaptured by this test.
- `tests/workflows/task-binding-identity.test.ts` — `B-43` fails with
  `RESOURCE_ALREADY_EXISTS` ("already has an active run in this scope") from
  `publishWorkflowRunV4`, a workflow-run concurrency guard unrelated to task
  source schema version.

All four are Lane A's own follow-up (§7's F-A2/F-A3/F-A4 flips, and the
freeze-split's own test surface), not task-fixture content, and are outside
this lane's ownership (`tests/architecture/task-fixture-vocabulary.md`'s
`ALLOWED_EXACT_FILES` already carries these files for reasons unrelated to
the failures above). Left unfixed per this document's own rule of engagement
("A defect discovered that is not in §7 is recorded in the Review log and
left unfixed").

**Verification:** `bun run test:integration` — 5733 pass / 57 skip / 0 fail
across 428/428 files (floor 5000, exit 0). `bun run test:unit` — 4241 pass /
0 skip / 5 fail across 308/308 files (floor 3500); the 5 failures are the
four pre-existing cases above (`characterization-with-drop.test.ts` reports
two of them). `bunx tsc --noEmit` clean. `bun run lint` exit 0 (1364
pre-existing `noNonNullAssertion` advisories repo-wide, none introduced by
this lane). Pre-sweep vs. post-sweep test counts are unchanged by
construction — `git diff -- tests/` shows exactly one `test(...)` line
touched across the whole sweep (a title rename, 1:1, not an add/remove);
every other change is inside fixture strings or comments.

### 2026-08-27 — Lane A/B close-out (review round 3)

§10's Gates name three items that "the already-known items to carry there"
must include; only the fixture-count item (D-N1) landed in the Review log
(inside Lane D's entry above). The other two (items 1–2 below), two in-code
comments that already asserted "recorded in the Review log" before it was
true (items 3–4 below), and one further non-§7 behavior difference
surfaced by the same review round (item 5 below) are closed out here
together, since none of the five is itself a §7-named flip:

1. **The `commands/`/`scripts/` `with:` rejection is a genuinely NEW
   rejection, not a "remaining" one (A-N5).** §1.1(5)'s verbatim text says
   P1a's COMPOSITION_INVALID rejection "remains … for `uses:
   commands/<ref>`/`scripts/<ref>`" — read in isolation that sentence implies
   the behavior was already there and P2b merely leaves it alone. A-N5's own
   "Tension" paragraph already flags that at the P2b head `with:` was
   **silently dropped**, never rejected, for those two target kinds
   (`resolveStep`, pre-split `source-freeze-v4.ts:146-151`, forwarded
   `source.with` to `prepareCommandInvocation` only for `builtin-command` and
   otherwise discarded it; `directScript` never read it at all) — so the
   rejection implemented at `src/workflows/freeze/resolve-steps.ts:38-53`
   (`rejectNonTaskBindingWith`, called from `resolveStep` at `:24` and `:28`)
   is observably new behavior for any workflow that authored a `with:` on
   either target, not a preserved one. This is exactly why it is CHANGELOG's
   own "Breaking changes & migration" bullet (F-A3, `CHANGELOG.md`) rather
   than filed under "Added" — recorded here per §10's own instruction to
   carry it explicitly, since a future reader skimming only §1.1(5)'s
   "remains" wording could otherwise mistake it for a preservation.
2. **`TaskInputBinding`'s `reference` arm widens with `schema` (§3.6).**
   `src/execution/input-contract.ts:104-106` declares the reference arm as
   `{kind:"reference", name, from, schema}` — P2a shipped `{kind, name,
   from}` (no `schema`) and constructed only `literal` bindings; P2b adds the
   field so pre-attempt resolution
   (`src/workflows/exec/step-work.ts:314-339`'s `resolveTaskInputBindings`,
   `binding.schema` read at `:336`) can validate a reference's *resolved*
   value as a pure function of the frozen plan, without re-reading the task
   source. Additive to a type P2a declared for exactly this purpose and that
   nothing else constructs (spec's own "Contract note", §3.6) — the
   `literal` arm, and every existing literal producer
   (`src/tasks/run/load-task.ts:101-108`), are byte-unchanged. Carried here
   per §10's explicit naming.
3. **`tests/workflows/direct-script-typed.test.ts`'s
   `parseTaskV3Yaml`→`resolveTaskForComposition` assertion change** (the
   file's own comment at `:424-436` says "recorded in the Review log as a
   consequence of F-A4" — this entry is what makes that true). Before A-N6,
   `taskDispatch` called `parseTaskV3Yaml` directly on the composed task's
   real document, and a `scanFunctionCalls` AST probe in this test asserted
   that call was present in `taskDispatch`'s own body. A-N6 (§1.7, F-A4)
   routes `taskDispatch` through the new `resolveTaskForComposition` (this
   file's sibling `src/workflows/freeze/targets/task.ts:68-78`), which itself
   calls `parseTaskSource` (handling both source versions in one parse) —
   `taskDispatch` no longer calls `parseTaskV3Yaml` at all, so the original
   assertion became permanently unsatisfiable the moment A-N6 landed. The
   test was rewritten in place to scan for `resolveTaskForComposition` in
   `taskDispatch`'s call set instead, preserving the same "function-scoped,
   not file-wide" proof technique. F-A1's own table (the split commit, A-N2)
   only re-pointed this test's two path constants and left every assertion
   verbatim; this particular assertion's *content* changed one commit later,
   as a direct structural consequence of A-N6 rather than of the split — it
   is not itself named in §7's flips table, so it is recorded here instead.
4. **The asset-resolution repaint** (`src/workflows/freeze/targets/task.ts`,
   the "RECORDED TENSION (spec §0, Review log)" comment at `:48-66` — this
   entry is what makes that citation true). A-N5's "no declared inputs"
   COMPOSITION_INVALID is reasoned from the composed target's *parsed*
   `inputs:` contract, which requires the target to resolve and parse
   successfully first — but `tests/workflows/with-rejection.test.ts` B-02b
   pins `COMPOSITION_INVALID` (not a raw asset-resolution error) for a
   `with:`-bearing step whose task ref does not even resolve. Reconciled by
   `resolveAndCaptureTaskAsset` (`task.ts:81-97`): an authored `with:` whose
   target asset cannot be resolved is repainted from its real resolution
   error into `noDeclaredInputsError` — "cannot be proven a valid binding
   surface" reads as the same refusal a genuinely-no-`inputs:` target gets. A
   P2b round-2 review finding narrowed this repaint to the asset-resolution
   step alone (`resolveOwnedAsset`/`captureOwned`): once the target resolves
   to real bytes, `parseTaskSource`/`projectTaskSourceV4` (called at
   `resolveTaskForComposition`, `task.ts:68-78`, **outside** the repainting
   try/catch) reports the composed task's own genuine defects (e.g. a
   `TASK_SOURCE_INVALID` for a malformed `inputs.<name>`) unchanged, never
   repainted as a false "no declared inputs" — so a real defect in the
   referenced task's own source is never masked by A-N5's rejection. Neither
   the reconciliation nor its round-2 narrowing is itself a §7-named flip
   (both are internal to implementing A-N5/A-N6 against the pre-existing
   `with-rejection.test.ts` pin); recorded here per the tension comment's own
   forward reference.
5. **The reserved input-flag-name rejection is a non-§7 behavior difference**
   (also the subject of a dedicated review-round-3 finding; recorded here as
   part of the same close-out sweep). `parseInputDeclarations`
   (`src/tasks/source/task-source-v4.ts:481-519`) now calls `sourceError` for
   any declared `inputs:` name in `TASK_RUN_RESERVED_FLAG_NAMES`
   (`src/tasks/task-run-reserved-flags.ts:50-53`: the union of
   `TASK_RUN_VALUE_FLAGS` — `bundle`, `format`, `detail`, `shape`, `output` —
   and `TASK_RUN_BOOLEAN_FLAGS` — `scheduled`, `quiet`, `verbose`, `help`,
   `no-quiet`, `no-verbose`). This closes a genuine defect a P2b round-2
   review found: `schedulerInputFlagTail`
   (`src/tasks/scheduler-binding.ts`) and a bare `akm task run <id>
   --<name> <value>` both let a declared input name collide with a flag
   `akm task run` (and now `akm task explain`, B-N4) already binds to
   itself, so the value would be silently misrouted (a second `--bundle`
   re-targets which bundle the task loads from) or left as an orphaned
   positional token that throws. It is a **parse-time (`TASK_SOURCE_INVALID`)
   rejection of task source v4 documents that was not requested by §7's
   flips table**, is absent from this Review log until now, and was
   undocumented in `CHANGELOG.md`/`docs/reference/tasks.md` until this same
   review round — both are now updated (`CHANGELOG.md`'s task-source-v4
   bullet; `docs/reference/tasks.md`'s `inputs:` field-notes bullet) in the
   same commit as this entry. `output` and `format` in particular are
   entirely plausible authored input names that this rule now forecloses;
   the fix itself is judged sound (it closes a real misrouting hole) and is
   left in place, recorded per this spec's own rule of engagement ("A defect
   discovered that is not in §7 is recorded in the Review log … Do not
   'improve' anything on the way past" — read here as "do not silently
   absorb a genuinely new rejection without recording it").
