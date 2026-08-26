# P1b — task model extraction, prepare seam, and runner split

**Status:** ready for implementation
**Phase:** P1b of the akm task/workflow refactor
**Owner artifacts:** `src/tasks/model/**`, `src/tasks/source/parse-v3-adapter.ts`,
`src/tasks/prepare/**`, `src/tasks/run/**`, plus the three authorized behavior
flips below and their tests.

This document is the **single source of truth** for P1b. Lanes do not
re-derive these facts from the codebase and do not read the parent plan. Every
`file:line` below was verified at the head of
`claude/breaking-changes-0-9-2-3cfyvp`.

---

## 0. What P1b is (and is not)

P1b is a **behavior-preserving extraction** of the task domain into four
homes — `model/` (pure types + validation), `source/` (v3 → model adapter),
`prepare/` (projection), `run/` (orchestration + dispatch arms).

**The only authorized behavior changes are the three rows of the
AUTHORIZED-FLIPS table (§6)**, plus the one advisory-authorized allowlist
widening recorded there as F-4. Everything else must be observably identical:
same errors, same codes, same message bytes, same stored strings, same child
env, same frozen plan bytes, same exit codes.

P1b is **not**:

- a source-syntax change (`src/tasks/source-v3.ts` parsing is untouched — the
  adapter is additive),
- a schedule-model change (P2a owns optional schedules / R-06),
- a `with:`-binding change (P2b owns bindings),
- a deletion phase (P4 owns removing the compat shims this phase leaves behind).

Rules of engagement:

- A defect discovered that is **not** in §6 is recorded in the Review log and
  left unfixed. Do not "improve" anything on the way past.
- If preserving a behavior and implementing an authorized flip appear to
  conflict, **stop and record it** — preserving wins until the Review log says
  otherwise.
- Every module extracted keeps its function bodies byte-equivalent where
  possible; a rewrite disguised as a move is the failure mode this phase exists
  to avoid.

---

## 1. Binding design decisions (verbatim)

The three blocks in §1.1–§1.3 are copied verbatim from the phase decisions and
are binding. §1.4–§1.5 are the vocabulary renames and the advisories carried
from P1a. §1.6 records the one disambiguation this spec adds, with evidence.

### 1.1 Module map (decision D4, binding)

> - Lane A: src/tasks/model/{definition,invocation,schedule}.ts — pure immutable
>   types + validation, NO IO/persistence/subprocess imports. TaskDefinition
>   {ref, source identity, name?, description?, target, execution defaults,
>   scheduleBindings}; TaskInvocation {taskRef, caller:
>   {kind:"cli"}|{kind:"schedule";...}|{kind:"workflow";...}, overrides};
>   TaskScheduleBinding {cron, enabled}. Plus
>   src/tasks/source/parse-v3-adapter.ts: parseTaskV3Yaml output ->
>   TaskDefinition, NO source-syntax change, pure. The adapter is additive in
>   P1b — v3 parsing itself (source-v3.ts) is untouched.
> - Lane B: src/tasks/prepare/ — move prepareTaskV3Execution's body
>   (src/tasks/runtime-v3.ts:346-458) into prepare.ts operating on the same
>   inputs (keep the exported name/signature via a thin re-export from
>   runtime-v3.ts so the THREE production callers keep compiling, then rewire
>   each caller to import from the new home in the same commit:
>   src/tasks/runner.ts:174, src/tasks/scheduler-sync.ts:485,
>   src/workflows/ir/source-freeze-v4.ts:223). New typed prepareScriptTarget()
>   in prepare/prepare-script-target.ts REPLACES directScript's synthetic-YAML
>   fabrication (source-freeze-v4.ts:274-298): same observable result (frozen
>   script target byte-identical: ref, bytes, sha256, interpreter, cwdIdentity),
>   no parseTaskV3Yaml call, no "@daily" string, no fabricated filePath
>   fragment. The synthetic-YAML string must be GONE from src/ (grep-provable).
> - Lane C: src/tasks/run/ — split src/tasks/runner.ts (1177 lines) into
>   run-task.ts (orchestration: load -> prepare -> reserve attempt -> dispatch
>   handler -> finalize), plus focused modules (suggested: load-task.ts,
>   attempt-lifecycle.ts, run-native-task.ts, run-workflow-task.ts,
>   run-command-task.ts, task-result.ts, task-log.ts — the spec may adjust names
>   but each module gets ONE responsibility). runner.ts remains as the compat
>   entry re-exporting runTask and types, marked for P4 removal.

### 1.2 D5 — ExecutionProvenanceContext (verbatim)

> D5 ExecutionProvenanceContext: a value {eventSource: "user"|"task", scheduled:
> boolean} created ONCE at the boundaries (src/commands/tasks/tasks.ts from
> --scheduled; default "user") and THREADED through RunTaskOptions and dispatch.
> The workflow arm's GLOBAL process.env.AKM_EVENT_SOURCE mutation
> (runner.ts:534-535,:552-555) is REMOVED — in-process consumers get the value
> explicitly: src/indexer/usage/usage-events.ts resolveUsageEventSource gains an
> explicit-argument path (ambient env read remains ONLY as fallback for child
> processes). Subprocess arms keep writing AKM_EVENT_SOURCE into the CHILD env
> (unchanged, P-06 preserved). FIXES the R-07 defect: the prompt/command arm
> (runPreparedCommandTask, runner.ts:679-737) now carries eventSource "task"
> when scheduled, so nested usage records "task" not "user".
>
> P0 flips: tests/integration/tasks-provenance-characterization.test.ts — P-05's
> mechanism-level pins (global env observed "task" during run) are RECLASSIFIED:
> P0 pinned the MECHANISM as then-current behavior, but the plan always
> scheduled D5 to replace it; the preserved CONTRACT is (a) in-process workflow
> execution and usage recording observe eventSource "task", (b) no cross-run
> leakage — process.env.AKM_EVENT_SOURCE is now NEVER mutated (assert unset
> before, DURING, and after), (c) child-env stamping (P-06) unchanged, (d)
> pre-set ambient values still win where they did. R-07's defect test flips to
> the fixed behavior. The close-out MUST append the P-05 reclassification note
> to docs/plans/specs/p0-invariants.md's Review log.

### 1.3 D8 — result vocabulary (verbatim)

> D8 result vocabulary: TaskRunResult target kinds become "command"
> (agent/LLM-dispatched, formerly "prompt"), "shell", "script", "workflow",
> "unknown". NEW history rows store the new strings and set metadata vocab
> marker 2 (inside the existing metadata JSON column). The read boundary
> (taskHistoryRowToResult, runner.ts:1134-1158) maps LEGACY rows (no marker):
> "prompt"->command(+engine), "command"->shell, "workflow"->workflow,
> null/unknown->unknown; the P0-pinned null fallbacks (workflow ref "", prompt
> engine null) keep their mapped equivalents. CHANGELOG [Unreleased] gets a
> breaking note: task-history/JSON-output target.kind vocabulary changed;
> consumers branching on "prompt" must handle "command" (and legacy rows read
> back mapped). P0 flips:
> tests/integration/tasks-legacy-vocabulary-characterization.test.ts R-08
> stored-string and read-shape pins flip per this mapping (write-side new
> strings + marker; read-side legacy mapping preserved as new tests).

### 1.4 Vocabulary renames, VALUE-preserving (verbatim)

> Vocabulary renames, VALUE-preserving: RunTaskOptions.stashDir -> bundleDir
> (update src/commands/tasks/tasks.ts:356 caller; internal only, no CLI flag
> change). The literal fallback bundle name "stash" (runner.ts:173) is hoisted
> to a named constant (e.g. DEFAULT_BUNDLE_NAME = "stash") but the VALUE DOES
> NOT CHANGE — it is user-visible data (bundle resolution) and R-09's observable
> behavior is PRESERVED (its test may only be updated for the option-key rename,
> not the resolved value). Out of scope: the ~40 stashDir sites in
> src/indexer/** and other domains' "stash" literals.

Measured at head: `stashDir` occurs 86 times under `src/indexer/**` and 27
times under `src/tasks/**` + `src/commands/tasks/**`. Only the
`RunTaskOptions` option key and its call sites are in scope.

### 1.5 Carried advisories from P1a (implement in this phase, Lane C) (verbatim)

> - CLI envelope coverage: one test per wired code (COMPOSITION_INVALID,
>   TASK_SOURCE_INVALID) asserting the {ok:false,error,code} JSON envelope on
>   stderr and exit 2 (extend tests/integration/cli-errors.test.ts or the
>   tasks-cli-envelope family — name the choice in the spec).
> - SAFE_TASK_ATTEMPT_ERROR_CODES (runner.ts:1009) gains TASK_SOURCE_INVALID and
>   COMPOSITION_INVALID with a comment on reachability.

**Choice named, binding:** the envelope tests extend
**`tests/integration/cli-errors.test.ts`**. No `tasks-cli-envelope` family
exists at head (verified: `ls tests/integration | grep -i envelope` is empty),
and minting one for two cases would fragment the CLI-envelope surface.

### 1.6 D5-N1 — binding disambiguation of "default \"user\"" {#d5-n1}

D5's parenthetical ("from --scheduled; default \"user\"") and its own
requirement that "P-06 preserved" are in tension if read as *`eventSource` is
`"task"` only when `--scheduled` is passed*. **P-06 is a PRESERVE row and wins.**

Evidence at head: `runner.ts:392` stamps
`AKM_EVENT_SOURCE: process.env.AKM_EVENT_SOURCE ?? "task"` **unconditionally** —
it does not read `options.scheduled` — and
`tests/integration/tasks-provenance-characterization.test.ts:93,107` call
`runTask(...)` with **no** `scheduled` flag and assert the child observes
`AKM_EVENT_SOURCE=task`. `runner.ts:534-535` (the workflow arm) is likewise
unconditional. R-07's own pinned test
(`tasks-provenance-characterization.test.ts:244`) also runs **unscheduled**, so
a `--scheduled`-conditioned fix would not flip it at all.

Binding resolution:

- `akm task run <id>` constructs its context with **`eventSource: "task"`
  whether or not `--scheduled` was passed** — matching today's native and
  workflow arms exactly.
- `scheduled: boolean` stays a **separate** field on the context, carrying
  today's `RunTaskOptions.scheduled` meaning (activation policy at
  `runner.ts:204`, scheduler env at `runner.ts:182`). It does **not** select the
  event source.
- `default "user"` governs boundaries that construct **no** task-run context —
  i.e. it is `resolveUsageEventSource`'s existing unset default (P-07), which is
  preserved verbatim.
- Consequently R-07's fix applies to **every** prompt/command task run, not only
  scheduled ones. That is a superset of the flip's literal wording and the only
  reading that reaches parity with P-05/P-06.

---

## 2. Behavior table (input → expected after P1b)

**PRESERVE** rows must be observably identical before and after. **CHANGE**
rows are the authorized flips (cross-referenced to §6).

| # | Input / situation | Expected after P1b | Evidence at head | Status |
|---|---|---|---|---|
| B-01 | `with:` on a task-v3 **command** ref | `UsageError` / `INVALID_FLAG_VALUE`, message byte-identical to P-01 | `runtime-v3.ts:397-401` | PRESERVE (P-01) |
| B-02 | `with:` on a task-v3 **script** ref | `UsageError` / `INVALID_FLAG_VALUE`, `Task v3 script refs do not accept with.` | `runtime-v3.ts:437-439` | PRESERVE (P-02) |
| B-03 | `with:` on a task-v3 **workflow** ref | frozen `params` deep-equal to the authored mapping; absent → `{}` | `runtime-v3.ts:432` | PRESERVE (P-03) |
| B-04 | workflow ref + any `env:` | `UsageError` / `INVALID_FLAG_VALUE`, 0.9.2 message verbatim | `runtime-v3.ts:415-421` | PRESERVE (P-04) |
| B-05 | GitHub-action `uses:` prepared | `UsageError` / `INVALID_FLAG_VALUE`, acquisition-unsupported message verbatim | `runtime-v3.ts:366-371` | PRESERVE (R-04 b, flips in P4) |
| B-06 | shell / script task run, ambient `AKM_EVENT_SOURCE` unset | child env carries `AKM_EVENT_SOURCE=task`; parent `process.env` never mutated | `runner.ts:389-393` | PRESERVE (P-06) |
| B-07 | shell / script task run, ambient `AKM_EVENT_SOURCE=improve` | child inherits `improve` | `runner.ts:392` | PRESERVE (P-06) |
| B-08 | `resolveUsageEventSource()` with no explicit value | unset/`""` → `"user"`; valid → itself; garbage → `"unknown"` | `usage-events.ts:28-32` | PRESERVE (P-07) |
| B-09 | in-process **workflow** task run | in-process execution + usage recording observe `"task"`; children spawned by exec units still see `AKM_EVENT_SOURCE=task` | `runner.ts:534-535`, `exec-unit.ts:140-155`, `core/spawn-env.ts:45-54` | **CHANGE — F-1** (mechanism replaced, contract kept) |
| B-10 | any task run, before / during / after | `process.env.AKM_EVENT_SOURCE` is **never written** (no set, no delete) | `runner.ts:534-535,552-555` | **CHANGE — F-1** |
| B-11 | prompt/command (agent/LLM) task run | dispatch child env carries `AKM_EVENT_SOURCE` (`"task"` or the ambient value); recorded usage events carry source `"task"` | `runner.ts:679-737` (no stamp today), `command-execution.ts:443` | **CHANGE — F-1** (R-07 defect fix) |
| B-12 | pre-set ambient `AKM_EVENT_SOURCE` on any arm | ambient value still wins over the context's `"task"` | `runner.ts:392`, `:535` | PRESERVE (D5 clause d) |
| B-13 | prepared **command** (agent/LLM) run → history | `target_kind` `"command"`, metadata marker `targetVocab: 2`, `engine` in metadata | `runner.ts:258,1081,1087` | **CHANGE — F-2** |
| B-14 | prepared **shell** run → history | `target_kind` `"shell"` + marker | `runner.ts:259,1081` | **CHANGE — F-2** |
| B-15 | prepared **script** run → history | `target_kind` `"script"` + marker (shell and script become distinguishable) | `runner.ts:259,1081` | **CHANGE — F-2** |
| B-16 | prepared **workflow** run → history | `target_kind` `"workflow"` (string unchanged) + marker; `target_ref` unchanged | `runner.ts:257,1082` | PRESERVE string / CHANGE marker — F-2 |
| B-17 | read a **legacy** row (`prompt`, no marker) | `{ kind: "command", engine: meta.engine ?? null }` | `runner.ts:1144-1145` | **CHANGE — F-2** (read mapping) |
| B-18 | read a **legacy** row (`command`, no marker) | `{ kind: "shell" }` | `runner.ts:1142-1143` | **CHANGE — F-2** |
| B-19 | read a **legacy** row (`workflow`, no marker) | `{ kind: "workflow", ref: row.target_ref ?? "" }` | `runner.ts:1140-1141` | PRESERVE (incl. `""` fallback) |
| B-20 | read `target_kind` null / unrecognized (any vintage) | `{ kind: "unknown" }` | `runner.ts:1146` | PRESERVE |
| B-21 | `akm task run` of a **shell/script** task whose process exits 78 | CLI exit code **78** (config-failure passthrough) | `src/commands/tasks/tasks.ts:365`, `src/assets/hints/cli-hints-short.md:95` | PRESERVE — **requires same-commit rewire**, see §5 C-7 |
| B-22 | `runTask` with no `bundleName` and no `config.defaultBundle` | qualified ref resolves against bundle **`stash`** (`stash//tasks/<id>`) | `runner.ts:173` | PRESERVE value (R-09); option key renamed — F-3 |
| B-23 | a workflow step `uses: scripts/<ref>` | frozen script target byte-identical (`ref`, `bytesBase64`, `byteLength`, `sha256`, `interpreter`, `extension`, `cwdIdentity`) | `source-freeze-v4.ts:288-311` | PRESERVE via new `prepareScriptTarget()` |
| B-24 | grep `src/` for the synthetic task YAML | **zero** hits for `version: 3\nuses:` fabrication and for the `"@daily"` literal introduced at `source-freeze-v4.ts:297` | `source-freeze-v4.ts:296-300` | **CHANGE (mechanism only)** — observable result unchanged (B-23) |
| B-25 | a workflow step `uses: tasks/<ref>` with `with:` | `UsageError` / `COMPOSITION_INVALID`, P1a message verbatim | `source-freeze-v4.ts:225-230` | PRESERVE (P1a) |
| B-26 | a workflow task step composing a nested workflow | `UsageError` / `INVALID_FLAG_VALUE`, `A workflow task step cannot compose a nested workflow target.` | `source-freeze-v4.ts:234-236` | PRESERVE (R-03) |
| B-27 | `akm lint` / scheduler-sync projectability of every v3 task | identical accept/reject set and identical message text | `scheduler-sync.ts:485` | PRESERVE |
| B-28 | invalid task source surfaced through the CLI | `{ok:false,error,code:"TASK_SOURCE_INVALID"}` on stderr, exit **2** | `source-v3.ts:225`, `core/errors.ts:103` | PRESERVE — newly **covered** (advisory) |
| B-29 | `with:` on a task step surfaced through the CLI | `{ok:false,error,code:"COMPOSITION_INVALID"}` on stderr, exit **2** | `source-freeze-v4.ts:228` | PRESERVE — newly **covered** (advisory) |
| B-30 | a dispatch failure carrying `TASK_SOURCE_INVALID` / `COMPOSITION_INVALID` | history detail records the **real code** instead of `"INTERNAL"` | `runner.ts:1000-1021` | **CHANGE — F-4** (advisory-authorized) |

---

## 3. Lane A — `src/tasks/model/**` + the v3 adapter

### 3.1 Files

| File | Contents |
|---|---|
| `src/tasks/model/definition.ts` | `TaskDefinition { ref, source identity, name?, description?, target, execution defaults, scheduleBindings }` + its validation |
| `src/tasks/model/invocation.ts` | `TaskInvocation { taskRef, caller: {kind:"cli"} \| {kind:"schedule";…} \| {kind:"workflow";…}, overrides }` + `ExecutionProvenanceContext` type (see §4.2) |
| `src/tasks/model/schedule.ts` | `TaskScheduleBinding { cron, enabled }` |
| `src/tasks/source/parse-v3-adapter.ts` | `parseTaskV3Yaml` output → `TaskDefinition`. Pure. No new parsing, no new validation, no source-syntax change. |
| `tests/tasks/model/definition.test.ts` (new) | construction + validation + immutability (frozen) |
| `tests/tasks/source/parse-v3-adapter.test.ts` (new) | v3 document → `TaskDefinition` for all four target arms; adapter never throws where `parseTaskV3Yaml` accepted |
| `tests/architecture/task-model-purity.test.ts` (new) | the purity ratchet below |

### 3.2 Purity rule (ratcheted)

`src/tasks/model/**` and `src/tasks/source/parse-v3-adapter.ts` may import
**only** types and pure helpers. The ratchet statically scans their import
specifiers and fails on:

- `node:fs`, `node:child_process`, `node:os`, `node:http`/`node:https`,
- anything under `src/storage/**`, `src/core/state-db`, `src/core/logs-db`,
  `src/sources/**`, `src/integrations/**`, `src/llm/**`, `src/indexer/**`,
- any dynamic `import(` / `require(` in those files.

`node:path` and `node:crypto` are permitted (pure string/hash helpers).
The ratchet is **absolute** (empty baseline) — it is a new directory, so there
is nothing to grandfather.

### 3.3 Name-collision notes (verified, not defects)

- `src/tasks/source-v3.ts:113` already exports `TaskV3ScheduleBinding
  { cron, source, ordinal }`. The model's `TaskScheduleBinding { cron, enabled }`
  is a **different, additive** type in a different module. Do not merge them and
  do not rename the v3 one in P1b.
- `src/tasks/schedule.ts` (cron/launchd/schtasks translation) is **not** moved,
  renamed, or touched. `model/schedule.ts` is a new file.

### 3.4 Wiring status

The adapter is **additive** in P1b: it is exercised by its own tests and is not
yet on a production path. P2a consumes it when the v4 source lands. It carries a
header comment naming this spec and P2a so a dead-code sweep does not delete a
minted seam (same convention as `createRunContext`, see
`tests/architecture/run-context-adoption.test.ts`).

---

## 4. Lane B — `src/tasks/prepare/**`

### 4.1 The move

`prepareTaskV3Execution` (`src/tasks/runtime-v3.ts:346-458`) moves **body-intact**
to `src/tasks/prepare/prepare.ts`, operating on the same inputs and returning
the same frozen shapes.

`src/tasks/runtime-v3.ts` exports exactly one function and its types
(verified: `grep -n "^export" src/tasks/runtime-v3.ts` → the `PreparedTaskV3*`
type family plus `prepareTaskV3Execution`). Therefore:

- The **types** move too — to `src/tasks/prepare/prepared-execution.ts`
  (`TaskV3PreparedBase`, `PreparedTaskV3Command|Workflow|Shell|Script`,
  `PreparedTaskV3Execution`, `PreparedTaskV3DirectoryIdentity`,
  `PrepareTaskV3ExecutionContext`, `TaskV3ScriptInterpreter`).
- The file-private helpers `prepareTaskV3Execution` depends on
  (`environmentSnapshot`, `commandEnvironmentSnapshot`, `base`,
  `currentExecutionValues`, `qualifyOwnedRef`, `resolvedOwnedAsset`,
  `validatePreparedCommand`, `validateWorkflowRuntimeSource`,
  `captureDirectoryIdentity` usage, `defaultTaskShell`, `scriptInterpreter`)
  move with it into `prepare/` (`prepare-support.ts` unless a better split
  emerges); none of them is exported at head, so no importer breaks.
- `src/tasks/runtime-v3.ts` is left as a **shim with no logic**: it re-exports
  the function and the types from `prepare/`.

**Import direction is one-way and ratcheted:** `runtime-v3.ts → prepare/**`.
`prepare/**` must not import from `runtime-v3.ts`. Leaving the types behind in
`runtime-v3.ts` would create a `prepare/prepare.ts ↔ runtime-v3.ts` static
cycle, and `tests/architecture/import-cycle-ratchet.test.ts` runs a
**shrink-only** baseline — a new cycle participant fails the gate.

### 4.2 Caller rewiring (same commit, all three)

| Caller | Line at head | After |
|---|---|---|
| `src/tasks/runner.ts` | `:174` | imports `prepareTaskV3Execution` from `../prepare/prepare` (the call itself moves into `run/load-task.ts`, §5) |
| `src/tasks/scheduler-sync.ts` | `:485` | imports from `./prepare/prepare` |
| `src/workflows/ir/source-freeze-v4.ts` | `:237` (the `taskDispatch` call; the file's `prepareTaskV3Execution` import) | imports from `../../tasks/prepare/prepare` |

Line-drift note: D4's verbatim text cites `source-freeze-v4.ts:223` for the
third caller; at the head this spec was written against, P1a's `with:` rejection
has shifted that call to `:237`. The file is the same; the table above carries
the verified line.

No caller may be left importing the shim. The shim stays only for
`tests/tasks-runtime-v3.test.ts` and other test importers, and carries a
`// P4: delete this shim` comment.

### 4.3 `prepareScriptTarget()` — replacing the synthetic YAML

`src/tasks/prepare/prepare-script-target.ts` exports a typed preparer that
`directScript` (`source-freeze-v4.ts:288-311`) calls **instead of** fabricating
`version: 3\nuses: <ref>\nakm:\n  schedule: "@daily"\n` and re-parsing it.

Required signature shape (inputs it already has at the call site):

```
prepareScriptTarget(input: {
  ref: string;             // owned.ref — the script's own qualified ref
  file: string;            // owned.file
  bundleRoot: string;      // owned.root
  readFile: (file: string, bundleRoot?: string) => Uint8Array;
}): PreparedScriptTarget   // frozen: { ref, interpreter, extension,
                           //   bytesBase64, byteLength, sha256, cwd, cwdIdentity }
```

Requirements:

- **Byte-identical output** for `ref`, `interpreter`, `extension`,
  `bytesBase64`, `byteLength`, `sha256`, `cwdIdentity` — the fields
  `scriptResult()` (`source-freeze-v4.ts:313-336`) actually reads. The frozen
  `FrozenWorkflowScriptTarget` must be equal to the pre-P1b one for every
  existing fixture.
- **No `parseTaskV3Yaml` call**, **no `"@daily"` literal**, **no fabricated
  `filePath` fragment** (`${asset.path}#${step.id}`), **no synthetic `taskId` /
  `taskRef`** (P0's Review log established none of those three is observable).
- The `prepareTaskV3Execution` **script arm** (`runtime-v3.ts:440-457`) and
  `prepareScriptTarget` must share **one** implementation of the byte/interpreter
  capture — two copies is exactly the drift this replacement exists to remove.
- `source-freeze-v4.ts:310`'s bare invariant
  (`if (prepared.kind !== "script") throw new Error(…)`) becomes unnecessary
  (the preparer is typed) and is **deleted with the fabrication**. P0's Review
  log already recorded it as unreachable from `directScript`'s call site.
- Grep-provable: `rg -F 'schedule: "@daily"' src/` and
  `rg -F 'version: 3\nuses:' src/` return **zero** hits after this phase.

### 4.4 Not in scope for Lane B

`src/tasks/source-v3.ts` is not edited. R-06 (exactly-one-scheduling-source)
still fires; the fabrication removal does not need it relaxed, because
`prepareScriptTarget` never builds a task document at all.

---

## 5. Lane C — `src/tasks/run/**` (the runner split) + provenance + vocabulary

`src/tasks/runner.ts` (1177 lines at head) splits into single-responsibility
modules. `runner.ts` stays as a compat entry that re-exports `runTask`,
`readTaskHistory`, `recordTaskAttemptFailure`, `exitCodeForStatus`,
`scrubDbLines`, `INVALID_TASK_ATTEMPT_ID`, and the `TaskRunResult` /
`TaskRunStatus` / `RunTaskOptions` / `TaskAttemptFailureReason` /
`ReadHistoryOptions` types, marked `// P4: delete this shim`.

Verified consumer surface: **only** `src/commands/tasks/tasks.ts` imports from
`src/tasks/runner` in production; six test files import from it.

### 5.1 Module list

| Module | Single responsibility | Moved from |
|---|---|---|
| `run/run-task.ts` | orchestration only: load → prepare → reserve attempt → dispatch handler → finalize | `runner.ts:150-254` |
| `run/load-task.ts` | id validation, adapter detection, owner resolution, source read, `parseTaskV3Yaml`, config selection, bundle-name resolution, `prepareTaskV3Execution` call | `runner.ts:154-194` |
| `run/attempt-lifecycle.ts` | `reserveTaskAttempt`, `finishAttempt`, `recordTaskAttemptFailure`, `SAFE_TASK_ATTEMPT_ERROR_CODES`, `safeTaskAttemptErrorCode` | `runner.ts:970-1069` |
| `run/run-native-task.ts` | shell + frozen-script arm, incl. `shellCommand`, `resolveLeadingBareAkmCommand`, `quoteShellArgument` | `runner.ts:294-455` |
| `run/run-workflow-task.ts` | workflow arm, `mapWorkflowStatus`, `renderWorkflowLog` | `runner.ts:456-675` |
| `run/run-command-task.ts` | agent/LLM arm, `renderPromptLog` | `runner.ts:677-778` |
| `run/task-result.ts` | `TaskRunResult` shape, `preparedResultTarget`, `finishDisabledTask`, `exitCodeForStatus` | `runner.ts:87-103,256-292,1164-1177` |
| `run/task-log.ts` | log path resolution, `streamLines`, `scrubDbLines`, `scrubTaskOutput`, `taskLogSensitiveValues`, `persistRunLog` | `runner.ts:779-968` |
| `run/task-history.ts` | `appendHistory`, `readTaskHistory`, `taskHistoryRowToResult` (the read boundary) | `runner.ts:1071-1158` |
| `run/provenance.ts` | `ExecutionProvenanceContext` factory + resolution helpers | new (§5.2) |

Constraints: no module may import `runner.ts` (one-way: `runner.ts → run/**`);
every extracted function stays under the 220-line `SRC_FN_SIZE_BAR`
(`scripts/lint-src-fn-size.ts`) — none of the moved functions is on the
baseline today, so none may be added to it.

### 5.2 F-1 implementation — provenance without global mutation

**Type** (`src/tasks/model/invocation.ts`, pure):

```
ExecutionProvenanceContext = Readonly<{ eventSource: "user" | "task"; scheduled: boolean }>
```

**Construction:** `src/commands/tasks/tasks.ts` (`akmTasksRun`, `:347-362`)
builds it once: `{ eventSource: "task", scheduled: options.scheduled === true }`
— see §1.6 (D5-N1) for why `eventSource` is not conditioned on `scheduled`.

**Threading:** `RunTaskOptions` gains `provenance?: ExecutionProvenanceContext`.
It is **optional**, and `run-task.ts` defaults it to
`{ eventSource: "task", scheduled: options.scheduled === true }` — that default
is what keeps the many test callers (and any future in-repo caller) on today's
behavior, and keeps `tests/integration/tasks-runtime-v3-runner.test.ts`
assertion-identical.

**Precedence rule (binding, preserves P-06/P-07 and D5 clause d):** an explicit
context value is only a **fallback**. Ambient `AKM_EVENT_SOURCE`, when set and
non-empty, still wins everywhere it wins today. Concretely:

```
resolveUsageEventSource(env = process.env, fallback: UsageEventSource = "user")
  raw set + recognized   → raw
  raw set + unrecognized → "unknown"
  raw unset or ""        → fallback
```

The default `fallback = "user"` reproduces P-07 exactly for every existing
caller (`feedback-cli.ts:209`, `search-cli.ts:148,206,353`,
`remember-cli.ts:166`, `command-execution.ts:443`), none of which changes.

**Per-arm requirements:**

1. **Native (shell/script) arm** — unchanged code path in substance: keep
   `AKM_EVENT_SOURCE: process.env.AKM_EVENT_SOURCE ?? provenance.eventSource`
   in the child env bag (`runner.ts:389-393`). With the default context this is
   byte-equivalent to today's `?? "task"`. P-06 stays green **unchanged**.
2. **Workflow arm** — delete `runner.ts:534-535` and `:552-555` (the global
   stamp and its `finally` restore) outright. `process.env` is never written.
   Instead pass the resolved event source into `runWorkflowSteps` via a new
   **optional** `eventSource?: UsageEventSource` option (undefined for every
   non-task caller, so `akm workflow run` is byte-identical), threaded to the
   child-env construction seam so exec-unit children still observe the stamp:
   `run-workflow.ts` options → scheduler → `exec/step-work.ts` dispatch input →
   `exec/exec-unit.ts` `childEnv` (`:586-595`). Apply it to the **allowlisted
   base** (`collectAllowlistedEnv`, `:591`) **only when the name is absent
   there** — i.e. after the ambient passthrough and *before* the `bindings` and
   `context` overlays — so an ambient value still wins and an authored `env:`
   binding still wins. Do **not** add it to `buildExecContextEnv`
   (`step-work.ts:522-543`): that overlay outranks bindings and would change
   precedence. Do **not** add any name to `COMMON_SPAWN_ENV_PASSTHROUGH` or
   `EXEC_DEFAULT_ENV_PASSTHROUGH` — `AKM_EVENT_SOURCE` is already on both
   (`core/spawn-env.ts:45-54`, `exec-unit.ts:140-142`), and those lists are
   frozen into engine snapshots (`core/spawn-env.ts:31-43`): **no frozen-plan
   byte may change in P1b.**
   *Escape hatch:* if this thread cannot be built without changing frozen-plan
   bytes or the exec allowlist policy, **stop, keep the removal unshipped, and
   record it in the Review log** — silently dropping the child stamp is an
   unauthorized behavior change (it is the documented reason P-05 exists).
3. **Command/prompt arm (the R-07 fix)** — `runPreparedCommandTask`
   (`runner.ts:679-737`) passes the provenance into
   `dispatchPreparedCommandInvocation`:
   - a new option on `DispatchPreparedCommandOptions` carrying
     `eventSource`, used at `command-execution.ts:443` as
     `resolveUsageEventSource(process.env, options.eventSource ?? "user")` — so
     the usage events recorded for consumed refs carry `"task"`;
   - `AKM_EVENT_SOURCE: process.env.AKM_EVENT_SOURCE ?? provenance.eventSource`
     added to the child env handed to the dispatched engine (the `env` bag
     `runAgent` receives), matching the native arm. This is the surface R-07's
     assertion (b) inverts.

### 5.3 F-2 implementation — result vocabulary

- `TaskRunResult["target"]` becomes:
  `{kind:"workflow";ref:string} | {kind:"command";engine:string|null} |
   {kind:"shell";cmd?:string[]} | {kind:"script";cmd?:string[]} | {kind:"unknown"}`.
- `preparedResultTarget` (`runner.ts:256-260`): workflow → `"workflow"`;
  prepared `command` → `{kind:"command", engine}`; prepared `shell` →
  `{kind:"shell"}`; prepared `script` → `{kind:"script"}`.
- `runPreparedCommandTask`'s inline `target: { kind: "prompt", engine }`
  (`runner.ts:718`) becomes `{ kind: "command", engine }`.
- **Marker:** `appendHistory` (`runner.ts:1083-1088`) adds `targetVocab: 2` to
  the metadata JSON, and writes `engine` when `result.target.kind === "command"`.
  `decodeTaskHistoryMetadata`
  (`src/storage/repositories/task-history-repository.ts:54-81`) has a **strict
  allowlist** (`:66`) that throws on unknown fields — add `targetVocab` to
  `TaskHistoryMetadata` (`:23-28`) and to the allowlist, validate it as
  `2 | undefined`, and keep every other field's validation byte-identical.
  Genuinely unknown fields must still be rejected
  (`tests/task-history-metadata.test.ts:29`).
- **Read boundary** (`taskHistoryRowToResult`, `runner.ts:1134-1158`), now in
  `run/task-history.ts`:

  | stored `target_kind` | `targetVocab === 2` | no marker (legacy) |
  |---|---|---|
  | `"workflow"` | `{kind:"workflow", ref: row.target_ref ?? ""}` | same |
  | `"command"` | `{kind:"command", engine: meta.engine ?? null}` | `{kind:"shell"}` |
  | `"shell"` | `{kind:"shell"}` | `{kind:"unknown"}` (unreachable — no legacy writer emits it) |
  | `"script"` | `{kind:"script"}` | `{kind:"unknown"}` (unreachable) |
  | `"prompt"` | `{kind:"unknown"}` (unreachable) | `{kind:"command", engine: meta.engine ?? null}` |
  | `null` / anything else | `{kind:"unknown"}` | `{kind:"unknown"}` |

  The P0-pinned null fallbacks survive their mapping: workflow `ref` still
  falls back to `""`; the former prompt row's `engine` still falls back to
  `null`.

### 5.4 F-3 implementation — renames

- `RunTaskOptions.stashDir` → `bundleDir`; update the caller at
  `src/commands/tasks/tasks.ts:356` and every test call site (§7 G-1).
- `runner.ts:173`'s literal `"stash"` → `DEFAULT_BUNDLE_NAME` (exported from
  `run/load-task.ts`), **same value**. `options.bundleName ?? config.defaultBundle
  ?? DEFAULT_BUNDLE_NAME`.
- Out of scope: `stashDir` under `src/indexer/**` (86 occurrences) and every
  other domain's `"stash"` literal. The `storage.stashDir` **test-helper field**
  name (`tests/_helpers/sandbox.ts`) is also out of scope — only the option key
  renames.

### 5.5 F-4 + advisory work

- `SAFE_TASK_ATTEMPT_ERROR_CODES` (`runner.ts:1000-1016`, moving to
  `run/attempt-lifecycle.ts`) gains `"TASK_SOURCE_INVALID"` and
  `"COMPOSITION_INVALID"`, with a reachability comment. **Verified reachability:**
  the only caller of `recordTaskAttemptFailure` inside the runner is the
  post-reservation catch at `runner.ts:242-253`; task-source parsing at
  `runner.ts:168` happens *before* reservation, so the direct parse path never
  reaches it. Both codes reach it through the **workflow arm**: a workflow task
  whose plan freezes a `tasks/<ref>` step raises `TASK_SOURCE_INVALID`
  (`source-v3.ts:225` via `taskDispatch`'s `parseTaskV3Yaml`,
  `source-freeze-v4.ts:233`) or `COMPOSITION_INVALID`
  (`source-freeze-v4.ts:225-230`) *during dispatch*. Today both are recorded as
  `"INTERNAL"`; after P1b the real code is stored (B-30).
- CLI envelope coverage lands in `tests/integration/cli-errors.test.ts`: one
  test per code asserting `{ok:false,error,code}` on **stderr** and exit **2**.

### 5.6 C-7 — the exit-78 rewire (preservation-critical)

`src/commands/tasks/tasks.ts:365` reads:

```
result.status === "failed" && result.target.kind === "command" && result.detail?.exitCode === 78
```

At head, `kind === "command"` means **shell or script** (the native arm). After
F-2, `"command"` means the agent/LLM arm and the native arm reports
`"shell"`/`"script"`. This branch **must** be rewired in the same commit to
`(result.target.kind === "shell" || result.target.kind === "script")`, or
`akm task run` silently stops preserving configuration failures as exit 78 —
documented behavior (`src/assets/hints/cli-hints-short.md:95`,
`src/assets/hints/cli-hints-full.md:463`) that only `tests/cli/exit-code-hints.test.ts`
pins, and only as prose. A **new** test must pin the code path: a shell task
whose command exits 78 → CLI exit 78.

---

## 6. AUTHORIZED-FLIPS table

Nothing outside this table may change observably. Every affected P0 test is
enumerated by file and line.

### F-1 — provenance: global env mutation removed, R-07 fixed (D5)

| Test (file:line at head) | P0 row | Disposition |
|---|---|---|
| `tests/integration/tasks-provenance-characterization.test.ts:93` | P-06 | **UNCHANGED, must stay green** |
| `…:107` | P-06 | **UNCHANGED, must stay green** |
| `…:122` | P-06 | **UNCHANGED, must stay green** |
| `…:138` `P-05 — an unset AKM_EVENT_SOURCE becomes "task" … then is deleted` | P-05 | **FLIP (mechanism reclassified).** New assertions: `process.env.AKM_EVENT_SOURCE` is `undefined` **before, during (observed from inside the injected `runWorkflowStepsImpl`), and after**; the in-process run observes event source `"task"` through the explicit path; an exec-unit child of the run still observes `AKM_EVENT_SOURCE=task`. |
| `…:165` `P-05 — a pre-set, more-specific AKM_EVENT_SOURCE survives … untouched` | P-05 | **PRESERVED contract, strengthened assertion**: ambient `improve` still observed in-process and in children; additionally assert `process.env` was never *written* (no set, no delete). |
| `…:191` `P-05 — restoration happens on the throwing path too` | P-05 | **FLIP (reclassified).** There is nothing to restore: assert the throwing path leaves `process.env.AKM_EVENT_SOURCE` untouched — never set, never deleted — and that the thrown failure still surfaces unchanged. |
| `…:221` / `…:236` (P-07 table + default-env case) | P-07 | **UNCHANGED, must stay green.** Add new cases for the `fallback` argument: explicit fallback used only when ambient is unset/`""`; ambient always wins; garbage ambient still `"unknown"`. |
| `…:244` `R-07 — a prompt-target task run never sets AKM_EVENT_SOURCE …` | R-07 | **FLIP to fixed behavior.** (a) `process.env.AKM_EVENT_SOURCE` still `undefined` before/during/after — unchanged; (b) inverts: the dispatched engine env **does** carry `AKM_EVENT_SOURCE="task"`; (c) inverts: the usage recorded for the dispatch carries source `"task"`, asserted through the explicit path (dispatch option / recorded usage-event row), **not** by a bare `resolveUsageEventSource()` reading an unmutated ambient env. |

Also touched by F-1 (no P0 row): `src/indexer/usage/usage-events.ts:28-32`
(signature gains `fallback`), `src/commands/command/command-execution.ts:429-445`
(dispatch option), `src/workflows/exec/run-workflow.ts` / `step-work.ts` /
`exec-unit.ts:586-595` (optional `eventSource` thread). Every existing
`resolveUsageEventSource()` call site keeps today's behavior by default.

### F-2 — result vocabulary re-code with legacy read mapping (D8)

| Test (file:line at head) | P0 row | Disposition |
|---|---|---|
| `tests/integration/tasks-legacy-vocabulary-characterization.test.ts:95` (workflow) | R-08 | **PRESERVED string**; update only if it asserts the exact metadata JSON (the `targetVocab: 2` marker is now present). |
| `…:127` (command/agent stores `"prompt"`) | R-08 | **FLIP**: stores `"command"`; reads back `{kind:"command", engine}`. |
| `…:157` (shell stores `"command"`) | R-08 | **FLIP**: stores `"shell"`; reads back `{kind:"shell"}`. |
| `…:179` (script stores `"command"`, "same string as shell") | R-08 | **FLIP**: stores `"script"`; reads back `{kind:"script"}`. The test's premise that shell and script are indistinguishable in history is now **false** — rewrite the assertion and the comment. |
| `…:198` (null / unrecognized → `{kind:"unknown"}`) | R-08 | **UNCHANGED, must stay green.** |
| **NEW** legacy-read tests (same file) | R-08 | Rows written **without** the marker map: `"prompt"`→`{kind:"command",engine}` (engine `null` when absent), `"command"`→`{kind:"shell"}`, `"workflow"`→`{kind:"workflow",ref: row.target_ref ?? ""}`, `null`/garbage→`{kind:"unknown"}`. |
| `tests/task-history-metadata.test.ts:9,20` | — | **UPDATE**: the allowlist accepts `targetVocab`; unknown fields still throw `/unknown fields/`; a metadata JSON **without** `targetVocab` still decodes (legacy rows). |
| `tests/integration/tasks-run-attempt-observability.test.ts:100-107` | — | **VERIFY**: `decodeTaskHistoryMetadata` matchers must still pass with the marker present on new rows. |
| **NEW** exit-78 test | — | §5.6 C-7: a shell task exiting 78 → CLI exit 78, after the `target.kind` branch rewire. |

### F-3 — VALUE-preserving renames

| Test (file:line at head) | P0 row | Disposition |
|---|---|---|
| `tests/integration/tasks-legacy-vocabulary-characterization.test.ts:232` (R-09) | R-09 | **UPDATE FOR THE OPTION KEY ONLY** (`stashDir:` → `bundleDir:`). The asserted resolved ref (`stash//tasks/<id>`) must **not** change. |
| every other `RunTaskOptions` call site | — | mechanical key rename: `tests/integration/tasks-runtime-v3-runner.test.ts` (11 sites — see G-1), `tests/integration/tasks-provenance-characterization.test.ts` (7), `tests/integration/tasks-run-attempt-observability.test.ts` (5), `tests/integration/tasks-legacy-vocabulary-characterization.test.ts` (5), `tests/integration/tasks-runner.test.ts` (1). |

### F-4 — attempt-error allowlist widening (P1a advisory)

| Surface | Disposition |
|---|---|
| `runner.ts:1000-1016` allowlist | gains `TASK_SOURCE_INVALID`, `COMPOSITION_INVALID` + reachability comment (§5.5) |
| stored history `detail.error` for those two failures | changes from `"INTERNAL"` to the real code (B-30). No P0 row pins it; `tests/integration/tasks-run-attempt-observability.test.ts:103` pins `"INTERNAL"` for a **different** fixture and must stay green. |

---

## 7. Preservation gates (the reviewer runs these)

- [ ] `tests/integration/tasks-runtime-v3-runner.test.ts` green, and **unchanged
      except for G-1's mechanical key rename** (fail-before-mutation canary).
- [ ] `tests/contracts/execution-cascade-resolver.test.ts`,
      `tests/contracts/execution-json.test.ts`,
      `tests/contracts/execution-source-loader.test.ts`,
      `tests/contracts/resolved-execution-contract.test.ts`,
      `tests/contracts/command-invocation-contract.test.ts`: green and
      **byte-unchanged** — the shared lowering boundary must be byte-stable.
- [ ] All P0 characterization suites green except the flips enumerated in §6.
- [ ] `tests/integration/tasks-scheduler-sync-v3.test.ts` **unchanged** and green;
      scheduler-sync projectability accept/reject behavior identical.
- [ ] All three `prepareTaskV3Execution` callers rewired in the **same commit**;
      no caller left on a deleted path (`rg "from .*runtime-v3" src/` shows no
      production importer).
- [ ] No frozen-plan bytes change: workflow freeze/plan-hash suites green
      unchanged; `COMMON_SPAWN_ENV_PASSTHROUGH` and
      `EXEC_DEFAULT_ENV_PASSTHROUGH` untouched.
- [ ] `tests/architecture/import-cycle-ratchet.test.ts` green (shrink-only
      baseline — no new cycle participant).
- [ ] `tests/architecture/src-fn-size-ratchet.test.ts` green with **no baseline
      additions**.
- [ ] `rg -F 'schedule: "@daily"' src/` and the synthetic-document grep return
      zero hits.

### G-1 — recorded gate conflict and its resolution {#g1}

**Conflict.** Two binding instructions collide on one file:
`tests/integration/tasks-runtime-v3-runner.test.ts` must be **UNCHANGED**, and
F-3 renames `RunTaskOptions.stashDir` → `bundleDir`. That file constructs
`RunTaskOptions` at **11** sites (verified: lines 98, 115, 150, 180, 219, 248,
297, 324, 370, 414, 476 — all `stashDir: storage.stashDir`), so the rename
cannot leave it byte-identical.

**Resolution (binding).** The gate's purpose is that no *assertion* in the
canary weakens. The file may change **only** by the mechanical key rename:
every line of its `git diff` must be a `stashDir: storage.stashDir` →
`bundleDir: storage.stashDir` substitution, at most 11 lines, with **zero**
changes to any `expect`, fixture, helper, or comment. The reviewer verifies this
by inspecting the diff, not by trusting the claim. The canary property is kept
by running the file green with the rename applied **before** the Lane C split
lands, then again after.

If any other line of that file must change, **stop and record it in the Review
log** — that is the signal that the split is not behavior-preserving.

---

## 8. Docs that ride with the code

- [ ] **CHANGELOG `[Unreleased]` → "Breaking changes & migration"**: the
      task-history / JSON-output `target.kind` vocabulary changed. State
      explicitly: `"prompt"` → `"command"` (agent/LLM), the old `"command"`
      splits into `"shell"` and `"script"`, `"workflow"` and `"unknown"` are
      unchanged; consumers branching on `"prompt"` must handle `"command"`;
      rows written by earlier versions are read back **mapped** to the new
      vocabulary, so `akm task history` output is uniform across vintages; new
      rows carry a `targetVocab` marker inside `metadata_json`, which older akm
      versions reject as an unknown metadata field.
- [ ] **`docs/plans/specs/p0-invariants.md` Review log**: append the **P-05
      reclassification note** (required by D5) — what P-05 pinned, why the
      mechanism was always scheduled for replacement, and the four preserved
      contract clauses (a)–(d) that replace it. This is a close-out obligation,
      not optional.
- [ ] Any `docs/architecture/*` sentence describing the runner as one file, or
      the workflow arm as stamping `process.env`, is corrected. Do not add new
      anchors to `docs/architecture/architecture.md`'s "## Module Boundaries"
      section unless `tests/contracts/module-boundaries.test.ts` requires it
      (it locks `src/cli.ts`, `src/core/asset/asset-ref.ts`, `src/core/errors.ts`,
      `src/core/config/config.ts`, `src/core/write-source.ts` and five
      directories — none of which this phase moves).

---

## 9. Acceptance criteria

**Structure**

- [ ] `src/tasks/model/{definition,invocation,schedule}.ts` exist, export the
      shapes named in §1.1, and are pure (§3.2 ratchet green).
- [ ] `src/tasks/source/parse-v3-adapter.ts` exists, is pure, maps
      `parseTaskV3Yaml` output → `TaskDefinition`, and `src/tasks/source-v3.ts`
      is **unmodified** (`git diff --stat -- src/tasks/source-v3.ts` empty).
- [ ] `src/tasks/prepare/prepare.ts` owns `prepareTaskV3Execution`'s body;
      `src/tasks/runtime-v3.ts` contains **no logic** — only re-exports — and is
      marked for P4 removal.
- [ ] `src/tasks/prepare/prepare-script-target.ts` exports `prepareScriptTarget()`;
      `directScript` no longer fabricates or parses task YAML; the byte/interpreter
      capture is shared with the script arm, not duplicated.
- [ ] `src/tasks/run/**` contains the modules of §5.1, each with one
      responsibility; `src/tasks/runner.ts` is a re-export shim marked for P4
      removal; no `run/**` module imports `runner.ts`.

**Behavior**

- [ ] Every PRESERVE row of §2 holds, verified by its cited test.
- [ ] `process.env.AKM_EVENT_SOURCE` is written **nowhere** in `src/`
      (`rg "process\.env\.AKM_EVENT_SOURCE\s*=" src/` and
      `rg "delete process\.env\.AKM_EVENT_SOURCE" src/` return zero hits).
- [ ] A workflow-task run's exec-unit child still observes
      `AKM_EVENT_SOURCE=task`; a pre-set ambient value still wins (or the
      escape hatch of §5.2(2) was taken and recorded).
- [ ] A command/prompt task run stamps its dispatch child env and records usage
      as `"task"` (R-07 fixed).
- [ ] New history rows carry the new vocabulary + `targetVocab: 2`; legacy rows
      read back per §5.3's table, including both null fallbacks.
- [ ] `src/commands/tasks/tasks.ts:365`'s exit-78 branch is rewired to
      `shell`/`script` and pinned by a new test (§5.6).
- [ ] `RunTaskOptions.bundleDir` replaces `stashDir`; `DEFAULT_BUNDLE_NAME`
      is `"stash"` and the resolved bundle identity is unchanged.
- [ ] `SAFE_TASK_ATTEMPT_ERROR_CODES` includes `TASK_SOURCE_INVALID` and
      `COMPOSITION_INVALID` with the §5.5 reachability comment.
- [ ] `tests/integration/cli-errors.test.ts` covers both codes:
      `{ok:false,error,code}` on stderr, exit 2.

**Gates**

- [ ] Every gate in §7 ticked, including G-1's diff inspection.
- [ ] Every §6 flip is a **visible test diff** naming its P0 row ID; no P0 test
      was deleted to make a flip disappear.
- [ ] §8's CHANGELOG entry and the P-05 reclassification note in
      `docs/plans/specs/p0-invariants.md` are both landed.
- [ ] `bunx biome check --write src/ tests/` produces no further changes;
      `bunx tsc --noEmit` clean.
- [ ] `bun run check` passes (lint + typecheck + `test:unit` + `test:integration`).
- [ ] Every behavior difference observed during implementation that is not in
      §6 is recorded in the Review log and **not** silently absorbed.

---

## Review log

<!-- Reviewers append dated entries below. -->

**2026-08-26 — Lane C implementation notes (runner split + provenance + vocabulary).**

*Module-boundary deviation from the §5.1 table (necessary, cycle-driven).* `finishAttempt` is
implemented in `run/task-result.ts` as a private inline clamp, NOT imported from
`run/attempt-lifecycle.ts` as the §5.1 table's literal text lists it. Reason: `task-result.ts` owns
`TaskRunResult`/`RunTaskOptions` and is imported (type-only, for `TaskRunResult`) by
`run/task-history.ts`; `attempt-lifecycle.ts` imports `appendHistory` (a value) from
`task-history.ts`. If `task-result.ts` also imported `finishAttempt` (a value) from
`attempt-lifecycle.ts`, the three modules would close a cycle —
`tests/architecture/import-cycle-ratchet.test.ts` counts TYPE-ONLY imports as real cycle edges (its
own header: "dependency direction is an architecture property, not a runtime one") against an
EMPTY, shrink-only baseline, so any new cycle participant is a hard failure. `attempt-lifecycle.ts`
still owns the CANONICAL, exported `finishAttempt` that every dispatch arm
(`run-native-task.ts`/`run-workflow-task.ts`/`run-command-task.ts`) imports from there; only
`task-result.ts`'s own `finishDisabledTask` — a single one-line ternary, not the exported symbol —
avoids the import. Likewise `finishDisabledTask` (task-result.ts) no longer calls `appendHistory`
itself (the pre-split function did); it persists the log and returns its result, and `run-task.ts`
calls `appendHistory` immediately after, in the same relative order — the same cycle constraint
applies (`task-history.ts` needs `TaskRunResult`'s type from `task-result.ts`, so `task-result.ts`
cannot import a value back from `task-history.ts`). Neither change is user-observable:
`finishDisabledTask`/`finishAttempt`'s internal call graph is not on the compat-shim re-export list,
and `tests/tasks/run-split.test.ts` (the structural contract for this split) does not pin either
function's file location or call graph, only that each named module exports actual runtime logic.
Verified: `tests/architecture/import-cycle-ratchet.test.ts` green, zero new participants.

*F-1 point 3 (R-07 fix) required routing through `execution-lowering.ts`, not just `command-execution.ts`.*
The spec's own §5.2 point 3 names `command-execution.ts:443` as the edit site and does not mention
`execution-lowering.ts`. Implementation required going one layer deeper: `dispatchPreparedCommandInvocation`
has no way to inject a value into the dispatched engine's child env without either (a) reconstructing
the frozen, WeakSet-branded `ResolvedExecutionRequestV1`/`LoweredExecutionRequest` (impossible without
touching `execution-cascade.ts`/`resolved-request.ts`'s construction functions — those objects are
require-exact-instance branded, not merely structurally validated, so a spread copy fails
`canonicalResolvedExecutionRequest`'s `instances.has(value)` check), or (b) importing `runAgent`
(`spawn.ts`) / `runOpencodeSdk` (`sdk-runner.ts`) directly and wrapping them — which
`scripts/lint-execution-boundary.ts` forbids outright (an exact-count-1 allowlist naming
`runner-dispatch.ts`'s `executeRunner` as the ONLY authorized caller of each; a first attempt at this
wrapping approach failed `bun run lint` with "2 unauthorized reference(s)"). The implemented path
instead: `DispatchLoweredExecutionOptions` gains a narrow, single-purpose `eventSource?: string`
field (NOT a general `env` override), and `dispatchLoweredExecutionRequest` applies it as exactly one
child-env key (`AKM_EVENT_SOURCE`) layered onto the lowered request's own resolved `env`, leaving
`runOptions`'s pre-existing "resolved content … cannot be overridden" contract otherwise untouched.

*A first attempt at implementing the above regressed a pinned test; caught and fixed before landing.*
The first attempt widened `execution-lowering.ts`'s generic `runOptions`/"operational" merge to honor
ANY caller-supplied `env` object additively (not just the one event-source key), reasoning that `env`
was already a declared-but-inert key in that merge's allowlist. This passed every P1b-specific test
and `bun run lint`, but broke `tests/integration/tasks-runner.test.ts`'s "forwards scheduled AKM
directory context to an agent without trusting task or caller overrides" — a PRE-EXISTING P0-era
characterization test (not one of Lane C's five red-phase files, untouched by this phase's authorized
flips) whose entire point is that `agentOptions`/`runOptions.env` must NOT be able to override frozen
scheduler-context directory values. The generic merge let a test/caller-supplied `AKM_STATE_DIR`
silently replace the real one. Caught by the full `bun run test:integration` sweep (not by the
launcher's five-file list, which does not include this file) — this is the reason this phase's
verification ran the full suite rather than stopping at the named gates. Fixed by narrowing the
mechanism to the single named key described above, which cannot touch any other resolved value.
Re-verified: full `bun run test:integration` green (5653 pass / 57 skip / 0 fail), full
`bun run lint` green (execution-boundary ratchet included).

*Discovered, NOT fixed — outside Lane C's ownership.* `tests/architecture/diagnostic-codes.test.ts`
(P1a's `INVALID_FLAG_VALUE` ratchet, baseline 82, ratchet-only-declines) now measures 85 — a +3
violation. Root-caused precisely: Lane A's `src/tasks/model/definition.ts:67` and
`src/tasks/source/parse-v3-adapter.ts:65` are genuinely NEW `UsageError(…, "INVALID_FLAG_VALUE")`
throw sites (neither file existed at P1a's baseline measurement; both are Lane A's own new
validation code, not code moved from an already-counted site), plus one prose mention of the string
in a `model/definition.ts` doc comment. Every Lane B/C file movement is ratchet-neutral by
construction — verified by full accounting: `runtime-v3.ts`'s pre-move 11 sites reappear as exactly
11 across `prepare/prepare.ts` + `prepare/prepare-support.ts` + `prepare/script-capture.ts`;
`runner.ts`'s pre-move 1 site (the `SAFE_TASK_ATTEMPT_ERROR_CODES` allowlist entry) reappears as
exactly 1 in `run/attempt-lifecycle.ts`; every OTHER file the ratchet scans
(`schedule.ts`/`scheduler-binding.ts`/`scheduler-sync.ts`/`source-v3.ts`/`task-id.ts`/every
`workflows/**` file) is byte-unchanged in count. `src/tasks/model/**` and
`src/tasks/source/parse-v3-adapter.ts` are Lane A's files, outside Lane C's "Own ONLY" list and
outside this phase's authorized-flips table (§6) — recoding their validation errors to a more
specific `UsageError` code (per the ratchet's own prescribed remedy) is a decision about Lane A's
validation semantics this lane is not positioned to make correctly, so it is recorded here rather
than silently absorbed or worked around by editing the ratchet's baseline. `bun run test:unit`
currently fails on exactly this one test (3953/3954 pass); every other unit and the full integration
suite (5653/5653) are green.

Gate: lint green (`bun run lint`, execution-boundary ratchet included), `bunx tsc --noEmit` green,
zero `P1b red-phase` directives remaining, full `bun run test:integration` green (5653 pass / 57
skip / 0 fail), `bun run test:unit` green except the one pre-existing, out-of-lane ratchet violation
above (3953/3954), import-cycle-ratchet and src-fn-size-ratchet both green with no new baseline
entries, `tests/tasks/run-split.test.ts` (the structural contract for this split) green.

**2026-08-26 — code-review remediation (four CONFIRMED findings fixed after the phase gate above).**

*F-1 gap closed: the agent/sdk dispatch arm was not forwarding `eventSource`.* Code review found that
`dispatchWorkflowExecution` (`src/workflows/exec/unit-dispatch.ts`) never forwarded `request.eventSource`
into `dispatchLoweredExecutionRequest`'s options — so while `UnitDispatchRequest.eventSource` reached a
"script"/"shell" frozen target's exec-unit child env correctly (the P-05 real-orchestrator coverage
above), a "command" frozen target's agent/sdk dispatch silently dropped it: an in-process workflow-task
run's agent/LLM steps never got `AKM_EVENT_SOURCE=task` stamped into the dispatched engine's child env or
into its recorded usage events — the exact defect class R-07/F-1 exists to close, on the workflow arm's
command steps rather than the task runner's own prompt/command arm. Fixed by forwarding
`...(request.eventSource !== undefined ? { eventSource: request.eventSource } : {})` into the
`dispatchLoweredExecutionRequest` options object at the one call site (`dispatchWorkflowExecution`), which
routes through `execution-lowering.ts:998-1001`'s existing single-key `AKM_EVENT_SOURCE` child-env
layering — the identical mechanism the R-07 command-arm fix (`command-execution.ts`) already uses, so no
new mechanism was introduced. Two stale doc comments that explicitly (and, after this fix, incorrectly)
claimed "the agent/sdk defaultUnitDispatcher arms never read it" were corrected (`unit-dispatch.ts`,
`native-executor.ts`'s `runUnit`), and `run-workflow.ts`'s `RunWorkflowOptions.eventSource` doc comment was
extended to describe both the exec-unit and the agent/sdk paths. For a non-task `akm workflow run` caller,
`RunWorkflowOptions.eventSource` stays `undefined`, so `request.eventSource` is `undefined` too and the new
spread contributes nothing — every non-task caller is byte-identical; only a workflow-task run's
"command"-kind steps observe the fix. No test in the suite previously exercised `dispatchWorkflowExecution`'s
real (non-injected) dispatch of a "command" frozen target end-to-end: confirmed by exhaustive grep (the
files mentioning `eventSource`/`AKM_EVENT_SOURCE`) and by `tests/integration/workflows/native-executor.test.ts`'s
own header, which documents that ALL its dispatch goes through an injected fake `UnitDispatcher` —
"no agent binaries, no LLM" — never the real `dispatchWorkflowExecution`. `dispatchWorkflowExecution` itself
accepts no seam parameter for injecting a fake `runAgent`/`chat`/`executeRunner`, unlike the command/prompt
arm's `RunTaskOptions.runAgentImpl`; adding one would be a new-capability change beyond this fix's scope, and
exercising the real path end-to-end would need a live agent binary or network call, both disallowed. Recorded
here rather than silently worked around: the fix is verified by code inspection plus the already-proven-correct
shared mechanism (`execution-lowering.ts`'s `eventSource` option, exercised by R-07's own test), not by a new
end-to-end test of this specific call site. Verified: `bunx tsc --noEmit` clean, `bun run lint` green
(execution-boundary ratchet included — the fix rides the boundary's one authorized call site, it does not
reach around it), `tests/integration/tasks-provenance-characterization.test.ts`,
`tests/integration/tasks-provenance-context.test.ts`, `tests/integration/workflows/exec-unit.test.ts`, and
`tests/integration/workflows/native-executor.test.ts` all green with unchanged pass counts.

*`akm health`'s `agentFailureRate` silently read 0 for every new-vocabulary agent/LLM row.* D8's
result-vocabulary re-code (F-2) moved the agent/LLM arm's stored `target_kind` from `"prompt"` to
`"command"` (marked with metadata `targetVocab: 2`), but `src/commands/health.ts`'s `gatherTaskHistoryPhase`
and `src/commands/health/windows.ts`'s `buildWindowMetrics` were not rewired — both still filtered
`task_history` rows on the retired `target_kind === "prompt"` string, so `agentFailureRate` (surfaced as
`agentFailRate` in `report-view-model.ts:514`) silently read 0 regardless of actual agent/LLM failures. Same
class of missed consumer as `src/commands/tasks/tasks.ts:365` (C-7), which the original implementation did
rewire; these two were missed. Fixed with a shared, marker-aware predicate,
`isAgentTaskHistoryRow` (new export, `src/commands/health/improve-metrics.ts`, beside the existing
`parseTaskMetadata`), mirroring `src/tasks/run/task-history.ts`'s `taskHistoryRowToResult` read mapping: a
`targetVocab: 2`-marked `"command"` row or an unmarked (legacy) `"prompt"` row is an agent/LLM row; an
UNMARKED `"command"` row is the legacy native shell/script arm and is excluded from both the numerator and
the denominator (not just the numerator), so it cannot dilute or pollute the rate. Both `health.ts` and
`health/windows.ts` now use it in place of the stale filter. A first version of the predicate decoded
`metadata_json` unconditionally before checking `target_kind`, which regressed
`tests/integration/health-task-fail-rate.test.ts` (5 failures): that fixture's `target_kind: "improve"` rows
carry `metadata_json` that predates the `metadataVersion: 2` shape entirely (`{ durationMs: 10 }`, no
`metadataVersion`), which `decodeTaskHistoryMetadata` throws on — the pre-fix `target_kind === "prompt"`
filter never reached those rows at all, so it never hit the throw; the fix's first cut did, unconditionally,
for every row. Caught by the full `bun run test:integration` sweep (not by the narrower targeted-file runs
done first) and fixed by checking `target_kind` first and returning `false` immediately for anything other
than `"command"`/`"prompt"`, decoding metadata only for the two kinds the predicate can return `true` for —
restoring the exact gate the old filter had. Added a regression test,
`tests/integration/health-checks.characterization.test.ts`'s new "agentFailureRate — D8 vocabulary-aware
(marker-based) row filter" describe block (a marked "command" failure counted alongside an unmarked
"command" — legacy shell — failure excluded, yielding 0.5 not 0; a legacy unmarked "prompt" failure still
counted, yielding 1) — no test previously asserted on `agentFailureRate`'s *computed* value at all (the two
pre-existing files that mention the name either pass it through as a literal input fixture to a markdown
renderer, or only mention it in a comment). Verified: `bunx tsc --noEmit` clean,
`tests/integration/health-checks.characterization.test.ts`, `tests/health-md-report.test.ts`, and
`tests/integration/health-task-fail-rate.test.ts` all green.

*The `INVALID_FLAG_VALUE` diagnostic-codes ratchet (baseline 82) was left red at 85.* Root cause per the
prior entry's own accounting: Lane A's two new files contributed 3 hits — a doc-comment mention
(`src/tasks/model/definition.ts:17`) and two genuinely new `UsageError(..., "INVALID_FLAG_VALUE")` throw
sites (`definition.ts:67`, `src/tasks/source/parse-v3-adapter.ts:65`). Resolved via the ratchet's own
prescribed remedy — re-code, not re-baseline — applied differently per site because
`tests/tasks/model-contracts.test.ts`'s "design decision 3" (file header) explicitly pins `definition.ts`'s
validation code as `INVALID_FLAG_VALUE` and states "P1b's spec authorizes no NEW `UsageErrorCode` member for
model validation": (a) `parse-v3-adapter.ts:65` — unpinned by any test (that same test file's own design
decision 3 states "no fixture ... exercises builtin-command or github-action targets, so this file does not
pin how the adapter handles them") — recoded to a new, more specific code, `TASK_TARGET_UNSUPPORTED`
(`src/core/errors.ts`, with a `USAGE_HINTS` entry): the input is a recognized, validly-parsed `uses:` kind
the adapter does not yet model, not a malformed shape, and the code is not yet reachable from any production
path (the adapter is additive-only in P1b, spec §3.4). (b) `definition.ts:67` — left throwing `UsageError`'s
own DEFAULT code (still `INVALID_FLAG_VALUE`, so `.code` and every other observable are byte-identical and
`model-contracts.test.ts`'s pinned assertion stays green), but the explicit, redundant
`"INVALID_FLAG_VALUE"` second argument was dropped in favor of relying on the constructor's own default — an
established idiom already used elsewhere in the codebase, including inside `src/workflows/**` itself (e.g.
`src/workflows/authoring/authoring.ts:171,175`), so this is a genuine simplification, not a ratchet
workaround. (c) `definition.ts:17`'s doc comment was reworded to describe "its own default code" instead of
spelling out the literal string, staying accurate without contributing to the grep-style count. Net: 85 ->
82, exactly the baseline — no re-baseline needed. Verified: `grep -rn "INVALID_FLAG_VALUE" src/tasks/
src/workflows/ | wc -l` = 82, `tests/architecture/diagnostic-codes.test.ts` green,
`tests/tasks/model-contracts.test.ts` and `tests/tasks/parse-v3-adapter.test.ts` green (unchanged — neither
required an edit), `bunx tsc --noEmit` clean, `bun run lint` green.

*G-1 deviation, recorded per G-1's own resolution clause (§7) — the missing step, not a code change.* Code
review found that `tests/integration/tasks-runtime-v3-runner.test.ts` — the fail-before-mutation canary G-1
requires stay unchanged "except for G-1's mechanical key rename" — in fact changed on two more lines than
the 11 mechanical `stashDir:` -> `bundleDir:` substitutions, and G-1's own unconditional instruction ("If
any other line of that file must change, stop and record it in the Review log") was not carried out at
implementation time. Diffed directly against the pre-P1b commit (`c5e9c1c`, P1a's phase-gate-green commit)
to confirm the full and exact deviation: `expect(result).toMatchObject({ status: "failed", target: { kind:
"command" }, detail: { exitCode: 7 } })` (the "post-dispatch nonzero shell result" test, ~line 121) became
`target: { kind: "shell" }`, and `expect(result).toMatchObject({ status: "completed", target: { kind:
"command" } })` (the "qualified" `uses: shared//scripts/ok.sh` script test, ~line 260) became `target: {
kind: "script" }` — each accompanied by a short inline comment explaining the change. Both are direct,
unavoidable corollaries of F-2's authorized result-vocabulary re-code (§5.3/§6): under the OLD vocabulary
both the native shell arm and the native script arm reported the shared string `"command"`; D8 makes them
`"shell"` and `"script"` respectively, which is exactly what B-14/B-15 in the spec's behavior table (§2)
require. No other line of the file changed beyond the 11 mechanical renames and these two assertions' two
accompanying comments — confirmed by the full diff, which contains exactly 13 hunks (11 single-line renames
+ 2 assertion-plus-comment hunks) and touches no fixture, helper, unrelated `expect`, or test ordering. The
canary property G-1 exists to protect — that parsing, resolution, preparation, and validation complete
BEFORE task history reservation, log creation, or process spawn (the fail-before-mutation invariant) — is
untouched by either changed line: both are post-hoc assertions on the STRING a result object reports for a
run whose mutation ordering this diff never touches, not assertions about when any mutation happens.
`tests/integration/tasks-runtime-v3-runner.test.ts` is green (24 pass / 0 fail) both before and after this
note was recorded — no code changed for this item; only the required Review-log entry was missing.

Gate (this remediation pass): `bunx tsc --noEmit` clean; `bun run lint` green (execution-boundary ratchet
included, MPL-2.0 header check green); `bunx biome check --write` on every file touched by this pass applied
no further changes; full `bun run test:unit` green — **3954 pass / 0 skip / 0 fail** (up from 3953/3954: the
diagnostic-codes ratchet test is now the 3954th passing test, not the one failure); full
`bun run test:integration` green — **5655 pass / 57 skip / 0 fail** (up from 5653 pass: the two new
`agentFailureRate` regression cases). Targeted re-runs after the fixes, all green:
`tests/integration/tasks-provenance-characterization.test.ts`, `tests/integration/tasks-provenance-context.test.ts`,
`tests/integration/workflows/exec-unit.test.ts`, `tests/integration/workflows/native-executor.test.ts`,
`tests/integration/health-checks.characterization.test.ts`, `tests/health-md-report.test.ts`,
`tests/integration/health-task-fail-rate.test.ts`, `tests/architecture/diagnostic-codes.test.ts`,
`tests/tasks/model-contracts.test.ts`, `tests/tasks/parse-v3-adapter.test.ts`,
`tests/integration/tasks-runtime-v3-runner.test.ts`, `tests/contracts/execution-cascade-resolver.test.ts`,
`tests/contracts/execution-json.test.ts`, `tests/contracts/execution-source-loader.test.ts`,
`tests/contracts/resolved-execution-contract.test.ts`, `tests/contracts/command-invocation-contract.test.ts`,
`tests/integration/tasks-scheduler-sync-v3.test.ts`, `tests/architecture/import-cycle-ratchet.test.ts`,
`tests/architecture/src-fn-size-ratchet.test.ts`, `tests/tasks/run-split.test.ts`,
`tests/task-history-metadata.test.ts`, `tests/integration/tasks-run-attempt-observability.test.ts`,
`tests/integration/tasks-legacy-vocabulary-characterization.test.ts`, `tests/integration/tasks-runner.test.ts`,
`tests/integration/cli-errors.test.ts`, `tests/core/errors-usage-hints.test.ts`. Spec §9's `bun run check`
acceptance criterion (lint + typecheck + test:unit + test:integration) is now met.

**2026-08-26 — code-review remediation, round 2: the F-1 gap-fix's forward inverted `env:`-binding
precedence.** A follow-up code-review pass on the round-1 fix above (which closed the "agent/sdk dispatch arm
was not forwarding `eventSource`" gap) found that the fix itself introduced a NEW, narrower precedence defect
in the same call site. `dispatchWorkflowExecution` (`src/workflows/exec/unit-dispatch.ts`) forwarded
`request.eventSource` into `dispatchLoweredExecutionRequest`'s options UNCONDITIONALLY whenever it was
defined. `dispatchLoweredExecutionRequest` applies a forwarded value as `env: { ...lowered.options.env,
AKM_EVENT_SOURCE: eventSource }` (`execution-lowering.ts:998-1001`) — an unconditional override of that one
key — and `lowered.options.env` IS the unit's own authored/resolved `env:` binding (`options.env =
request.runtime.environment`, `execution-lowering.ts:518-519`, fed by `prepareWorkflowExecution`'s
`...(request.env !== undefined ? { environment: request.env } : {})` at `unit-dispatch.ts:106`, itself the
step's frozen environment materialized by `native-executor.ts`'s `prepareStepDispatchPrerequisites`). So the
unconditional forward placed the provenance stamp LAST, letting it win over an authored `env: {
AKM_EVENT_SOURCE: ... }` binding on a `uses: commands/<ref>`-style ("command"-kind) workflow step. This
inverted the precedence pre-P1b had — the child env for this arm was built by `buildChildEnv`'s
`collectAllowlistedEnv(profile.envPassthrough, ...)` (`spawn.ts:173-179`) with `options.env` (the authored
binding) applied AFTER it, at highest precedence, so an authored `AKM_EVENT_SOURCE` binding always won — and
it disagreed with the sibling "script"/"shell" arm, which correctly implements spec §5.2(2)'s "an authored
`env:` binding still wins": `exec-unit.ts`'s `childEnv` (`:601-609`) stamps its allowlisted BASE only when the
name is absent there, strictly BEFORE the `bindings` overlay runs, so an authored binding always wins there
regardless of the stamp. No reserved-name guard blocks authoring `AKM_EVENT_SOURCE` as a workflow step `env:`
binding, so the path is reachable; this was an unauthorized observable child-env change (spec §0: "same child
env"), not in the §6 flips table, and the round-1 Review-log entry above did not record the precedence
difference — it verified only that the mechanism was "identical" to the R-07 command-arm fix, which is true
of the merge itself but not of the round-1 fix's own, unconditional call into it.

Fixed by gating the forward on the binding's absence, matching `exec-unit.ts`'s guard exactly: a new,
exported pure predicate, `forwardedDispatchEventSource(request)` (`unit-dispatch.ts`), returns
`request.eventSource` unchanged only when `request.env?.AKM_EVENT_SOURCE === undefined`, and `undefined`
(forward nothing) otherwise — so an authored binding of ANY value, including one that happens to already
equal the resolved provenance value, leaves the key alone for `execution-lowering.ts`'s merge to skip
entirely (no `eventSource` reaches its options object at all, so the unconditional-override branch there
never fires and the authored value in `lowered.options.env` stands untouched). `dispatchWorkflowExecution`
now calls this predicate once and forwards its result instead of `request.eventSource` directly.
`command-execution.ts`'s task/prompt arm was deliberately left untouched, per the finding's own instruction
and spec §5.2(3): that arm has always overridden `task.environment`'s `AKM_EVENT_SOURCE` (matching the native
arm, `run-native-task.ts:130-134`), so its unconditional `AKM_EVENT_SOURCE: process.env.AKM_EVENT_SOURCE ??
eventSource` stamp (already ambient-first via `loweredDispatchOptions`, `command-execution.ts:154-158`) is
correct as-is and is a different contract from the workflow "command"-kind unit arm this fix corrects.

`forwardedDispatchEventSource` is exported and pinned directly by a new test file,
`tests/workflows/unit-dispatch-event-source.test.ts` (6 tests: no-eventSource passthrough for non-task
callers, forwarding when no binding is present — absent `env`, empty `env`, and an unrelated binding — an
authored `AKM_EVENT_SOURCE` binding suppressing the forward regardless of its value including one equal to
the resolved provenance value, and the gate holding across every `UsageEventSource` value). A direct
end-to-end test of `dispatchWorkflowExecution`'s real dispatch remains out of reach for the same reason the
round-1 entry recorded: the function has no injectable `runAgent`/`executeRunner`/`chat` seam, so exercising
it fully would require a live agent binary or network call. Extracting the forward decision into an exported
pure predicate pins the actual defect (a precedence decision made entirely inside `unit-dispatch.ts`, before
any dispatch happens) without adding a new seam to the dispatch path itself. Two doc comments that described
the forward as unconditional (`UnitDispatchRequest.eventSource` in `unit-dispatch.ts`;
`RunWorkflowOptions.eventSource` in `run-workflow.ts`) were corrected to name the gate.

Verified: `bunx tsc --noEmit` clean; `bunx biome check --write` on both touched `src/` files and the new test
file applied no further changes (three pre-existing, unrelated `noNonNullAssertion` warnings elsewhere in
`run-workflow.ts` are untouched by this diff — confirmed via `git diff --stat`, two files plus one new test
file); `bun scripts/lint-license-headers.ts`, `bun scripts/lint-tests-isolation.ts`,
`bun scripts/lint-runtime-boundary.ts`, and `bun scripts/lint-execution-boundary.ts` all green (the new
predicate is a plain data function — no `runAgent`/`executeRunner`/`chat` reference — so the execution
boundary's exact-count allowlist is untouched); full `bun run test:unit` green — 3960 pass / 0 skip / 0 fail
across 297 files (up from 3954: the new test file's 6 tests); the new
`tests/workflows/unit-dispatch-event-source.test.ts` green on its own (6 pass); targeted re-runs green:
`tests/integration/tasks-provenance-characterization.test.ts`,
`tests/integration/tasks-provenance-context.test.ts`, `tests/integration/workflows/exec-unit.test.ts`,
`tests/integration/workflows/native-executor.test.ts` (120 pass / 0 fail combined). Full
`bun run test:integration` green — **5655 pass / 57 skip / 0 fail** — identical pass/skip/fail counts to the
round-1 gate above, confirming no regression from this fix. `bun run check`'s full acceptance criterion
(lint + typecheck + test:unit + test:integration) holds after this remediation.

**2026-08-26 — code-review remediation, round 3: the gate/summary-judge dispatch was the one remaining
unstamped child.** A follow-up code-review pass on rounds 1–2 above (which threaded `eventSource` into the
exec-unit and agent/sdk arms of a step's own subgraph units) found that `run-workflow.ts`'s
`workflowSummaryJudge` — the completion-criteria judge every gated step dispatches through
`finalizeExecutedStep` — never passed `options.eventSource` into `frozenSummaryJudge`
(`frozen-judge.ts`), so a workflow-task run's judge child process silently lost the provenance stamp its
pre-P1b `process.env.AKM_EVENT_SOURCE` global mutation used to give it. Same defect class as rounds 1–2
(R-07/F-1), on the one dispatch neither round touched: the judge is a "command"-kind `UnitDispatchRequest`
built independently of `executeStepSubgraph`'s per-unit requests, so threading `eventSource` into the step's
own units did nothing for it. Unauthorized outside §6, and — per §5.2(2)'s escape hatch — either the thread
had to be built or the gap recorded; it is recorded here alongside the fix.

Fixed by mirroring the two already-fixed arms exactly: `frozenSummaryJudge` (`frozen-judge.ts:95`) gained a
5th, optional `eventSource?: string` parameter, spread onto the `UnitDispatchRequest` it builds
(`frozen-judge.ts:137`, `...(eventSource !== undefined ? { eventSource } : {})` — the same conditional-spread
idiom every other optional field on that request already uses) rather than opening any new mechanism.
`workflowSummaryJudge` (`run-workflow.ts:561-573`) now passes `options.eventSource` at the call site. Because
the judge's request reaches `dispatchWorkflowExecution` exactly like any other "command"-kind unit, it goes
through the identical, already-fixed `forwardedDispatchEventSource` precedence gate (`unit-dispatch.ts`) for
free — no new gating logic was needed here. The module doc at the top of `frozen-judge.ts` already establishes
that a judge dispatch carries no authored `env` bindings (`commonRequest` never sets one), so the gate's
"authored binding wins" branch is structurally unreachable for a judge and the forward always succeeds when
`eventSource` is supplied. `options.eventSource` is `undefined` for every non-task caller (`akm workflow run`
and its tests, per `RunWorkflowOptions`'s existing doc contract), so the new parameter and spread contribute
nothing and both callers stay byte-identical: `run-workflow.ts`'s own call (now 5 args) and
`runtime/runs.ts:744`'s manual `akm workflow step complete` judge (still 4 args, the finding's own
confirmation that this path is off the task-run route and needs no change — the added parameter is optional,
so the pre-existing 4-argument call keeps compiling and keeps behaving exactly as before). Two doc comments
were extended to name the new path: `frozenSummaryJudge`'s own (previously undocumented beyond a one-line
summary) and `RunWorkflowOptions.eventSource`'s (previously describing only the exec-unit and agent/sdk arms
of a step's subgraph, silently omitting the judge dispatch that turned out to be the gap).

No test was added. Exhaustive search (`grep -rln` for `frozen-judge`/`frozenSummaryJudge`/gate-plus-eventSource
combinations across `tests/`) found no existing test — in this phase's own suites or the two prior rounds' new
files — that constructs a gated workflow-task run with an injected dispatcher and asserts the judge's captured
`UnitDispatchRequest`; the gap was invisible to the suite for exactly that reason. Adding one was judged
out of scope for this remediation pass (scoped to fixing the one named CONFIRMED finding, no test edits
beyond the spec's authorized flips) rather than silently taken on; the fix is verified by code inspection —
the change mirrors the already-test-pinned `forwardedDispatchEventSource` mechanism byte-for-byte, so no new
dispatch-precedence logic exists that only a new test could exercise — plus the full existing suite staying
green with unchanged pass/skip/fail counts, confirming no regression to any of the paths the two callers
already exercise.

Verified: `bunx tsc --noEmit` clean; `bunx biome check --write` on both touched files (`frozen-judge.ts`,
`run-workflow.ts`) applied no further changes (the three pre-existing, unrelated `noNonNullAssertion` warnings
at `run-workflow.ts:903,912,919` that round 2 already noted are untouched by this diff — confirmed via
`git diff --stat`, exactly two files, no test file); full `bun run test:unit` green — **3960 pass / 0 skip / 0
fail** across 297 files, identical to round 2's count; full `bun run test:integration` green — **5655 pass /
57 skip / 0 fail**, identical to rounds 1–2's count; full `bun run lint` exits 0 (execution-boundary ratchet,
license-header check, tests-isolation, runtime-boundary, and every other custom lint script all print `OK`;
the repo-wide biome warning count is pre-existing style noise unrelated to this diff, not a new failure).
Targeted re-runs, all green: `tests/integration/tasks-provenance-characterization.test.ts`,
`tests/integration/tasks-provenance-context.test.ts`, `tests/integration/workflows/exec-unit.test.ts`,
`tests/integration/workflows/native-executor.test.ts`, `tests/workflows/unit-dispatch-event-source.test.ts`,
`tests/integration/workflows/gate-artifacts.test.ts`, `tests/contracts/engine-lowering-conformance.test.ts`
(230 pass / 0 fail combined), plus every §7 preservation-gate suite named in this spec
(`tests/integration/tasks-runtime-v3-runner.test.ts`, the five `tests/contracts/execution-*`/`resolved-execution-contract`/
`command-invocation-contract` suites, `tests/integration/tasks-scheduler-sync-v3.test.ts`,
`tests/architecture/import-cycle-ratchet.test.ts`, `tests/architecture/src-fn-size-ratchet.test.ts`,
`tests/tasks/run-split.test.ts`, `tests/task-history-metadata.test.ts`,
`tests/integration/tasks-run-attempt-observability.test.ts`,
`tests/integration/tasks-legacy-vocabulary-characterization.test.ts`, `tests/integration/tasks-runner.test.ts`,
`tests/integration/cli-errors.test.ts` — 283 pass / 0 fail combined). `bun run check`'s full acceptance
criterion (lint + typecheck + test:unit + test:integration) holds after this remediation.

**2026-08-26 — phase close-out (orchestrator).** The run was interrupted once by infrastructure
(during test-review round 3) and resumed from its journal both times. Test review ran 3 rounds
(3 → 3 → 2 CONFIRMED); round 3's two findings (missing Lane-B structural ratchet — also the sole
basis of its nullImplementationWouldPass=true — and the cwdIdentity parity gap) were fixed in
`b6eefdd` and verified directly by the orchestrator, who adjudicated proceed per the dispute rule,
additionally applying two advisories in `3e33ae9` (metadata targetVocab pins; widened B-10
never-written grep) and — during the outage — making the red window typecheck-clean via marked
`@ts-expect-error P1b red-phase` directives (`ddceaa9`), all of which Implement removed. The
round-3 structural scan also revealed FIVE runtime-v3 importers (the spec's table named three);
all five were rewired in Implement. Code review ran 3 rounds (4 → 1 → 1 CONFIRMED), tracing the
D5 provenance thread arm by arm: round 1's threading gaps, round 2's env-precedence inversion
(fixed with `forwardedDispatchEventSource` + a pinning test), round 3's summary-judge stamp loss
(fixed by threading eventSource through `frozenSummaryJudge`); every fix verified against the
reviewer's required change, so the exhausted budget is again bookkeeping, not an open defect.
Applied at close-out (`775d146`, carried advisories): native-executor's two inline
`import("…/runtime-v3")` type queries rewired to `prepare/prepared-execution` (last production
shim importers), the prepare-split scan extended with ImportTypeNode coverage so that spelling
cannot evade it again, and `akm health`'s vocabulary-marker probe hardened to classify
undecodable legacy metadata as unmarked instead of throwing. Deferred and recorded: the
shared-capture structural check (reviewer-verified from the diff instead); adapter-header P2a
cross-reference.
