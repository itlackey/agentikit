# P0 — invariant inventory for the task/workflow refactor

**Status:** ready for test authoring
**Phase:** P0 of the akm task/workflow refactor
**Owner artifacts:** tests only — **P0 changes no production code**

This document is the **single source of truth** for the three P0 test-writing
lanes. Lanes do **not** re-derive these facts from the codebase and do not read
the parent plan. Every file:line reference below was verified at the current
head of `claude/breaking-changes-0-9-2-3cfyvp` (== `release/0.9.2`).

---

## 0. What P0 is

P0 pins **current** behavior — including behavior we have already decided is
wrong — with **passing** characterization tests. Nothing is fixed here.

The contract that makes the later phases cheap:

- Every row in the two tables below gets at least one test that passes **today**.
- A row in **Behavior to replace** is a test that a later phase will
  **deliberately flip** — exactly one pinned test per deliberate change, so a
  reviewer of P1–P4 can see the behavior change as a test diff rather than
  having to reason about it.
- A row in **Behavior to preserve** is a test that must **keep** passing through
  every later phase. A later phase breaking one of these is a regression, not a
  decision.

Therefore:

- Pin the **observable** effect (thrown error type + `code` + message text,
  stored string, env var seen by a child, resulting shape), never the internal
  call path. Tests that assert on private helpers make the later phases harder,
  not safer.
- Where a message string is quoted below, pin it **verbatim**. Byte-identical
  duplicate messages (R-03) are pinned at each site separately so a later phase
  cannot collapse two rejections into one without a visible test diff.
- Do not "improve" anything you find while writing these tests. A defect you
  notice that is not in these tables belongs in the Review log, not in a fix.

### ID scheme

`P-nn` = preserve. `R-nn` = replace. Lanes cite these IDs in test names so the
phase that flips a row can find its test with a grep.

---

## Behavior to preserve

These are load-bearing today and stay load-bearing after the refactor.

| # | Behavior | Evidence (file:line) | Observable surface to pin | Lane |
|---|---|---|---|---|
| **P-01** | **Task-layer `with` on a *command* ref is rejected loudly.** The task layer, unlike the workflow layer (R-01), never silently drops `with`. | `src/tasks/runtime-v3.ts:397-401` | `UsageError`, code `INVALID_FLAG_VALUE`, message exactly:<br>`Task v3 command refs do not accept with; use akm/command with {ref, arguments} for portable arguments.` | B |
| **P-02** | **Task-layer `with` on a *script* ref is rejected loudly.** | `src/tasks/runtime-v3.ts:437-439` | `UsageError`, code `INVALID_FLAG_VALUE`, message exactly:<br>`Task v3 script refs do not accept with.` | B |
| **P-03** | **Task-layer `with` on a *workflow* ref is accepted and becomes the child workflow's params.** This is the one `with` consumer that works, and it is the shape P2b generalizes to workflow steps. | `src/tasks/runtime-v3.ts:432` — `params: Object.freeze({ ...(document.target.with ?? {}) })` | `prepareTaskV3Execution` returns `{ kind: "workflow", ref, params }` where `params` deep-equals the authored `with` mapping; absent `with` yields `{}` (not `undefined`); the object is frozen. | B |
| **P-04** | **A workflow-target task with any `env:` is rejected.** Adjacent to P-03 and read at the same site during spec authoring; lane B will hit it while building P-03 fixtures, so it is pinned rather than left as a surprise. | `src/tasks/runtime-v3.ts:415-421` | `UsageError`, code `INVALID_FLAG_VALUE`, message exactly:<br>`Task v3 workflow env cannot be consumed by the durable workflow runtime in 0.9.2; remove env or use a command target.`<br>Triggered when `Object.keys(environment).length > 0`. | B |
| **P-05** | **Task-runner provenance, workflow arm: `AKM_EVENT_SOURCE` is stamped on the *global* `process.env` for the duration of the run, then restored.** This arm executes in-process, so child `akm` invocations made by workflow steps inherit the stamp. A more specific pre-existing value wins. | `src/tasks/runner.ts:534-535` (stamp), `:552-555` (restore in `finally`) | During the run, `process.env.AKM_EVENT_SOURCE === "task"` when it was previously unset; it is `delete`d again afterward when it was previously `undefined`, and restored to the prior string otherwise — including on the throwing path (`finally`). A pre-set `AKM_EVENT_SOURCE=improve` survives untouched. | B |
| **P-06** | **Task-runner provenance, native shell/script arm: `AKM_EVENT_SOURCE` is passed in the *child* env only — `process.env` is never mutated.** | `src/tasks/runner.ts:389-393` — `AKM_EVENT_SOURCE: process.env.AKM_EVENT_SOURCE ?? "task"` inside the `runManagedSubprocess` `env` bag | The env handed to the spawn contains `AKM_EVENT_SOURCE="task"` (or the inherited more-specific value); the parent's `process.env.AKM_EVENT_SOURCE` is unchanged before, during, and after. | B |
| **P-07** | **`resolveUsageEventSource` defaults an unset/empty `AKM_EVENT_SOURCE` to `"user"`, and maps an unrecognized value to `"unknown"` rather than to `"user"`.** This default is what turns R-07 into a real defect; pin it so R-07's flip is unambiguous. | `src/indexer/usage/usage-events.ts:28-32` | `undefined`/`""` → `"user"`; each of `user`/`improve`/`task`/`audit`/`unknown` → itself; anything else → `"unknown"`. | B |
| **P-08** | **Multi-job YAML *parsing* is well-formed and canonical: 1–256 jobs, `needs` validated, jobs emitted in one canonical topological order.** R-05 replaces only the *execution-time* rejection; the parser's job model is the thing the P4 adapter boundary will be built on, so its behavior must not drift in the meantime. | `src/workflows/source-ir/github-yaml.ts:464-536`; `src/workflows/source-ir/ordering.ts` | 0 jobs or >256 jobs → failure code `job-count-limit`, message `workflow.jobs must contain 1 through 256 jobs.`<br>Unknown `needs` target → `missing-job-dependency`, message `Job <id> needs missing job <dep>.`<br>Cycle → `job-dependency-cycle`, message `Workflow jobs contain a dependency cycle.`<br>Duplicate `needs` entries → `duplicate-job-dependency`. `needs` is sorted. Ordering: emit the lexically-first ready job, then recompute readiness (`canonicalTopologicalJobs`) — pin the exact emitted order for a fixture with two independently-ready jobs. | A |

---

## Behavior to replace

Each row is a **deliberate future change**. P0 pins it passing; the named phase
flips exactly the pinned tests.

| # | Behavior (current, wrong) | Evidence (file:line) | Observable surface to pin | Flips in | Lane |
|---|---|---|---|---|---|
| **R-01** | **A workflow step's `with:` on `uses: tasks/<ref>` is accepted by the decoder and then silently DROPPED.** The decoder shape-checks `with` for every `uses` step but only the `builtin-command` target ever validates or consumes it; `taskDispatch` reads `source.with` nowhere. The authored mapping vanishes with no error, no warning, and no trace in the frozen plan. | Accepted: `src/workflows/source-ir/schema.ts:144` (field), `:389-393` (shape-check only), `:371` (target validation reached **only** for `builtin-command`).<br>Dropped: `src/workflows/ir/source-freeze-v4.ts:211-272` (`taskDispatch` — no `source.with` read); the sole consumption of `source.with` is the builtin-command branch at `:148`. | (a) A step `uses: tasks/x` with `with: {a: 1}` **decodes without error**.<br>(b) `scalarRecord(step.with, …, true)` still rejects a non-scalar `with` value and `:393` still fails a `with` without `uses` (`step <id> with is legal only with uses`).<br>(c) Freezing that step produces a resolved dispatch **byte-identical** to the same step with no `with:` at all — assert equality of the two frozen results, which is what makes the drop visible. | **P1a** rejects it; **P2b** implements real bindings | A |
| **R-02** | **`directScript` fabricates synthetic task YAML and re-parses it.** A `uses: scripts/<ref>` workflow step is executed by writing a task document as a string — including a fake `@daily` schedule that exists only to satisfy R-06 — and running it back through `parseTaskV3Yaml`. | `src/workflows/ir/source-freeze-v4.ts:274-298` | The synthetic document is exactly:<br>`version: 3\nuses: <owned.ref>\nakm:\n  schedule: "@daily"\n`<br>with `filePath = \`${context.asset.path}#${source.id}\``, `workspaceRoot = context.asset.sourcePath`, `taskId = source.id`, `taskRef = \`${context.asset.ref}#${source.id}\``. These identity fields are computed by `directScript()` but are **not observable** anywhere production surfaces: `scriptResult()` reads only `.sourceRef`/`.interpreter`/`.extension`/`.bytesBase64`/`.byteLength`/`.sha256`/`.cwdIdentity` off the prepared execution into `FrozenWorkflowScriptTarget` — never `.taskId`/`.taskRef` — and no persisted plan carries them. Pin **only** the observable surface: a script step freezes to a script dispatch carrying the script's own qualified ref (`FrozenWorkflowScriptTarget.ref`), its exact bytes, and its interpreter. The bare invariant at `:296` (`if (prepared.kind !== "script") throw new Error("direct script did not project as a script")`, exit 70, not a `UsageError`) is unreachable from `directScript`'s own call site — see the Review log — and is not pinned. | **P1b** (typed preparer) | A |
| **R-03** | **Nested-workflow targets are rejected at three call sites in source: two reachable independently, and one a documented-dead duplicate of the second.** | `src/workflows/source-ir/semantics.ts:141-146`; `src/workflows/ir/source-freeze-v4.ts:220-222`; `src/workflows/ir/source-freeze-v4.ts:237-239` (unreachable in practice — see the Review log) | Pin the **two independently reachable** sites; record the third rather than pinning it.<br>`semantics.ts`: `WorkflowSourceSemanticError`, code `nested-workflow-unsupported`, message `Nested workflow target "<value>" is unsupported in a workflow step.` (value JSON-stringified).<br>`source-freeze-v4.ts:220-222`: `UsageError`, code `INVALID_FLAG_VALUE`, message exactly `A workflow task step cannot compose a nested workflow target.`, firing on the parsed task document (`task.target.uses.kind === "workflow"`).<br>`source-freeze-v4.ts:237-239` guards the byte-identical message one call later in the same `taskDispatch`, on the condition `prepared.kind === "workflow"` — but `prepareTaskV3Execution` returns `kind: "workflow"` only when `document.target.uses.kind === "workflow"` (`runtime-v3.ts:415`), the exact fact the `:220` guard already tested on the same parsed `task` earlier in the same call. No fixture can pass `:220` and still reach `:237` with `prepared.kind === "workflow"`; it is a dead duplicate, not independently pinnable. | **P3** (child workflows) | A |
| **R-04** | **GitHub Action locators are parsed into a full typed target, then rejected downstream.** The grammar is live: `owner/repo[/path]@rev` classifies successfully with owner/repository/path/revision fields — and is then refused at both consumers. | Parse: `src/tasks/source-v3.ts:523` (`classifyTaskV3Uses`), `:562-588` (locator branch).<br>Reject (task prepare): `src/tasks/runtime-v3.ts:366-371`.<br>Reject (workflow step): `src/workflows/source-ir/semantics.ts:134-139`. | (a) `classifyTaskV3Uses("owner/repo@v1")` **returns** a frozen `{ kind: "github-action", ref, owner, repository, revision }`, and with a path `owner/repo/sub/dir@v1` adds `path: "sub/dir"`. Pin at least one accepted shape and one *rejected* locator falling through to the trailing throw: `Task v3 uses must be akm/command, a canonical commands/, workflows/, or scripts/ asset ref, or owner/repo[/path]@ref. Agent/task/local/Docker/ambiguous targets are not executable.`<br>(b) Preparing such a task throws `UsageError` / `INVALID_FLAG_VALUE`: `GitHub action "<ref>" is recognized but remote action acquisition is unsupported in 0.9.2.`<br>(c) The same locator in a workflow step throws `WorkflowSourceSemanticError` code `remote-action-acquisition-out-of-scope`: `Remote action acquisition is out of scope for "<value>".` | **P4** (grammar removal) | A + B |
| **R-05** | **Multi-job YAML parses fully, then execution refuses it.** Two independent rejection points on two paths, both after a complete parse. | Parse: `src/workflows/source-ir/github-yaml.ts:464-536` + `src/workflows/source-ir/ordering.ts` (see P-08).<br>Reject (freeze path): `src/workflows/ir/source-freeze-v4.ts:105-110`.<br>Reject (direct compile path): `src/workflows/ir/compile.ts:117-127`. | (a) A 2-job source **parses clean** and yields 2 ordered jobs (P-08 covers ordering).<br>(b) Freezing it throws `UsageError`, code `INVALID_FLAG_VALUE`, message exactly:<br>`Multi-job workflow cannot execute until job boundaries and needs have a durable runtime representation.`<br>(c) `compileWorkflowPlan` on the same IR **returns** (does not throw) `{ ok: false, errors: [{ line, message: "Current workflow execution requires exactly one source-IR job." }] }`, with `line` from the second job's span. Pin the return-vs-throw asymmetry — it is easy to lose in P4. | **P4** (adapter-boundary rejection) | A |
| **R-06** | **Task v3 requires *exactly one* scheduling source. Declaring neither `akm.schedule` nor `on:` is an error, and declaring both is the same error.** This is what forces R-02's fake `@daily`. | `src/tasks/source-v3.ts:636-651` | Both the neither-case and the both-case fail with the same source error text: `must declare exactly one scheduling source: akm.schedule or on.` (raised via `sourceError(ctx, [], …)` — pin the rendered message and the empty path).<br>Also pin the success shape of the `akm.schedule` arm: `{ manual: false, schedules: [{ cron: <schedule>, source: "akm.schedule", ordinal: 0 }] }`, frozen. | **P2a** (optional schedule) | B |
| **R-07** | **Task-runner provenance, prompt arm: `AKM_EVENT_SOURCE` is NEVER set — anywhere.** `runPreparedCommandTask` neither mutates `process.env` (as P-05 does) nor passes a child env (as P-06 does). Combined with P-07's `"user"` default, **a scheduled prompt-target task records its nested akm usage as user demand.** This is a DEFECT, pinned as-is. | `src/tasks/runner.ts:679-737` (whole arm — no `AKM_EVENT_SOURCE` occurrence); default at `src/indexer/usage/usage-events.ts:28-32` | Run a prompt-target task with `AKM_EVENT_SOURCE` unset. Assert: (a) `process.env.AKM_EVENT_SOURCE` is still `undefined` at every point of the run, including inside the injected `runAgent`/`chatCompletion` impl; (b) no `AKM_EVENT_SOURCE` reaches the dispatch; (c) consequently `resolveUsageEventSource()` observed from inside the arm returns `"user"`. Point (c) is the row's whole reason to exist — write it explicitly so P1b's flip to `"task"` is a one-line test diff. | **P1b** (defect fix) | B |
| **R-08** | **Task result vocabulary is inverted, and the inversion is persisted.** A prepared `command` (agent/LLM) becomes result kind `"prompt"`; a prepared shell **or** script becomes result kind `"command"`. Those exact strings are written to `task_history.target_kind` and read straight back out. | Mapping: `src/tasks/runner.ts:256-260` (`preparedResultTarget`) — `:257` workflow, `:258` command→`prompt`, `:259` shell/script→`command`.<br>Persist: `src/tasks/runner.ts:1081` — `target_kind: result.target.kind === "unknown" ? null : result.target.kind`.<br>Read back: `src/tasks/runner.ts:1134-1158`. | Per arm, pin the **stored string** and the round-trip:<br>• prepared `workflow` → `target_kind` `"workflow"`, read back as `{ kind: "workflow", ref }` (`ref` falls back to `""` when the column is null).<br>• prepared `command` → `target_kind` **`"prompt"`**, read back as `{ kind: "prompt", engine }` (engine from metadata, `null` when absent).<br>• prepared `shell` → `target_kind` **`"command"`**, read back as `{ kind: "command" }`.<br>• prepared `script` → `target_kind` **`"command"`** (same string as shell — the two arms are indistinguishable in history).<br>• `target_kind` null / unrecognized → `{ kind: "unknown" }` on read. | **P1b** (read-boundary mapping) | B |
| **R-09** | **Legacy "stash" naming survives at the task boundary.** `RunTaskOptions.stashDir` is the option name for what is now a bundle root, and the bundle-name resolution ends in the literal `"stash"`. | `src/tasks/runner.ts:111` (`stashDir`); `src/tasks/runner.ts:173` — `options.bundleName ?? config.defaultBundle ?? "stash"` | **Pin observable effects only — do not pin the identifier name.** With no `options.bundleName` and no `config.defaultBundle`, the task's fully-qualified ref is built against bundle `stash` (i.e. `stash//tasks/<id>`), and that is the bundle identity threaded into preparation. Pin the resulting ref string, not the option key: the option key is renamed in a later phase and a test asserting on it would fail for the wrong reason. | **P1b / P4b** (boundary rename) | B |

---

## Lane pin checklists

Three lanes work in parallel. Each lane owns its rows end to end; no row is
shared between lanes except R-04, which is split explicitly below.

### Lane A — workflows

Owns everything under `src/workflows/`.

- [ ] **R-01 (a)** A workflow step `uses: tasks/<ref>` with `with: {…}` of scalar values decodes with **no** error and **no** diagnostic.
- [ ] **R-01 (b)** Guardrails that *do* fire today still fire: a non-scalar `with` value fails via `scalarRecord` (`schema.ts:389`), and `with` without `uses` fails with `step <id> with is legal only with uses` (`schema.ts:393`).
- [ ] **R-01 (c)** The drop is proven by equality: freeze the same task step twice, once with `with:` and once without, and assert the two resolved dispatches are equal. This is the test P1a flips to an expected rejection.
- [ ] **R-01 (d)** Contrast case: the same `with:` on `uses: akm/command` **is** consumed (`source-freeze-v4.ts:148`) and target-validated (`schema.ts:371`). Pin it so P1a's rejection cannot accidentally cover the builtin-command path too.
- [ ] **R-02** A `uses: scripts/<ref>` step freezes to a script dispatch carrying the script's own qualified ref, exact bytes, and interpreter — the identity shape the synthetic document produces is not observable anywhere production surfaces (see the Review log) and is not pinned; likewise the bare-`Error` invariant at `source-freeze-v4.ts:296` is unreachable from `directScript`'s own call site and is not pinned.
- [ ] **R-03** Two tests, one per *reachable* site: `semantics.ts:141-146` (code `nested-workflow-unsupported`) and `source-freeze-v4.ts:220-222`. `source-freeze-v4.ts:237-239` guards the byte-identical message one call later in the same `taskDispatch`, but is unreachable in practice — no fixture can pass the `:220` guard and still reach `:237` with `prepared.kind === "workflow"` (see the Review log) — so it is recorded as a dead duplicate rather than pinned by a third test.
- [ ] **R-04 (c)** A GitHub-action locator in a **workflow step** throws code `remote-action-acquisition-out-of-scope`.
- [ ] **R-05 (a)** A 2-job source parses clean into 2 jobs.
- [ ] **R-05 (b)** Freezing it throws the exact multi-job `UsageError`.
- [ ] **R-05 (c)** `compileWorkflowPlan` **returns** `ok: false` with the exact message and the second job's line — not a throw.
- [ ] **P-08** Job-count bounds (0, 1, 256, 257), `needs` validation (missing / cycle / duplicate), `needs` sorting, and the canonical emission order for two independently-ready jobs.

### Lane B — tasks

Owns everything under `src/tasks/` plus the `usage-events` default.

- [ ] **P-01** `with` + command ref → exact `UsageError` message, code `INVALID_FLAG_VALUE`.
- [ ] **P-02** `with` + script ref → exact `UsageError` message, code `INVALID_FLAG_VALUE`.
- [ ] **P-03** `with` + workflow ref → `params` deep-equals the authored mapping; absent `with` → `{}`; result frozen.
- [ ] **P-04** workflow ref + any `env:` → exact `UsageError` message.
- [ ] **P-05** Workflow arm stamps and restores **global** `process.env.AKM_EVENT_SOURCE`; restoration happens on the throwing path too; a pre-set more-specific value survives.
- [ ] **P-06** Native shell/script arm sets it in the **child** env only; parent `process.env` never mutated.
- [ ] **P-07** `resolveUsageEventSource` table: unset/`""` → `"user"`; each valid value → itself; garbage → `"unknown"`.
- [ ] **R-06** Neither-and-both scheduling sources produce the same error text; the `akm.schedule` success shape (`source: "akm.schedule"`, `ordinal: 0`, `manual: false`) is pinned.
- [ ] **R-07** Prompt arm sets `AKM_EVENT_SOURCE` **nowhere**, and `resolveUsageEventSource()` observed from inside it returns `"user"`. Assert (c) explicitly.
- [ ] **R-08** Four arms × (stored `target_kind` string, read-back shape), plus the null/unrecognized → `{ kind: "unknown" }` case. Shell and script must both be pinned even though they store the same string.
- [ ] **R-09** With no `bundleName` and no `defaultBundle`, the qualified task ref resolves against bundle `stash`. Assert the ref string, never the option key.

**Harness note for P-05 (and P-06's negative half):** `tests/_preload.ts` installs
a tripwire that **throws** if a test leaks an `AKM_*` env var that was not
present at preload time (AGENTS.md, "Test-isolation harness"). P-05 exercises a
production path that mutates `process.env.AKM_EVENT_SOURCE` on purpose. Observe
the stamp from **inside** the run (via an injected `runWorkflowStepsImpl`) and
let the production `finally` restore it; never leave the var set across the test
boundary and never set it by hand outside the sandbox helpers.

### Lane C — fixtures

Owns the shared fixture surface both other lanes build on. Lane C lands first;
A and B consume it.

- [ ] A **task-step-with-`with`** workflow fixture pair: identical sources differing only by the `with:` block (R-01 c needs both halves).
- [ ] A **builtin-command-with-`with`** workflow fixture (R-01 d), so the consumed path and the dropped path sit side by side.
- [ ] A **script-step** workflow fixture (R-02).
- [ ] Two **nested-workflow** fixtures, one per *reachable* R-03 site: a workflow step naming a workflow directly (`semantics.ts:141-146`) and a task document whose `uses` is a workflow (`source-freeze-v4.ts:220-222`). `source-freeze-v4.ts:237-239` is a documented-dead duplicate of the second site (see the Review log) and is not a fixture requirement.
- [ ] **GitHub-action** fixtures (R-04): a task document with an action `uses`, and a workflow step with the same locator. Include one *near-miss* locator that falls through to the trailing `classifyTaskV3Uses` throw.
- [ ] **Multi-job** fixtures (R-05, P-08): a valid 2-job source with `needs`; a 0-job source; a >256-job source; a missing-`needs` source; a cycle; a duplicate-`needs` source; and a two-independently-ready-jobs source for canonical ordering.
- [ ] **Scheduling** fixtures (R-06): neither source, both sources, `akm.schedule` only, `on:` only.
- [ ] **Task target** fixtures covering all four prepared arms — workflow, command (agent/LLM), shell, script — reused by R-08 and by P-05/P-06/R-07.
- [ ] Fixtures use `tests/_helpers/sandbox.ts` (`sandboxStashDir()`, `writeSandboxConfig()`); no `process.env.HOME` mutation, no `process.chdir`, no `globalThis.fetch =` (`scripts/lint-tests-isolation.ts` enforces this).
- [ ] Every new test file carries the MPL-2.0 header (`scripts/lint-license-headers.ts`).

---

## Acceptance criteria

- [ ] `docs/plans/specs/p0-invariants.md` exists and is the only file changed by the spec commit.
- [ ] **No file under `src/` is modified in P0.** `git diff --stat release/0.9.2..HEAD -- src/` is empty at the end of the phase.
- [ ] Every row P-01…P-08 has at least one test that **passes at current head**.
- [ ] Every row R-01…R-09 has at least one test that **passes at current head**.
- [ ] Each test names its row ID (e.g. `R-08`) in its `describe`/`it` title, so the phase that flips a row can find it with a grep.
- [ ] R-03's two *reachable* sites (`semantics.ts:141-146`, `source-freeze-v4.ts:220-222`) are each covered by a distinct test reaching that distinct code site, distinguishable by fixture rather than by message text; the third site (`source-freeze-v4.ts:237-239`) is a documented-dead duplicate recorded in the Review log rather than pinned.
- [ ] R-05 pins both the throwing freeze path and the non-throwing `compileWorkflowPlan` return path.
- [ ] R-07 asserts the `"user"` resolution explicitly, not merely the absence of the env var.
- [ ] R-08 pins the stored `target_kind` string for all four prepared arms plus the null/unrecognized read-back.
- [ ] R-09 asserts a resulting ref string, not the `stashDir` option name.
- [ ] No test asserts on a private helper where an observable surface (error type + code + message, stored string, child env, returned shape) was available.
- [ ] All new tests use `tests/_helpers/sandbox.ts`; `bun scripts/lint-tests-isolation.ts` passes.
- [ ] Every new test file carries the MPL-2.0 header; `bun scripts/lint-license-headers.ts` passes.
- [ ] `bunx biome check --write src/ tests/` produces no further changes; `bunx tsc --noEmit` is clean.
- [ ] `bun run check` passes (lint + typecheck + `test:unit` + `test:integration`).
- [ ] Any defect discovered while writing these tests but **not** listed in the tables is recorded in the Review log below and left unfixed.

---

## Review log

<!-- Reviewers append dated entries below. -->

**2026-08-25 — R-03's third site (`src/workflows/ir/source-freeze-v4.ts:237-239`) is unreachable in
practice.** That guard fires on `prepared.kind === "workflow"`, where `prepared` is the return of
`prepareTaskV3Execution`. `prepareTaskV3Execution` (`src/tasks/runtime-v3.ts:415`) returns
`kind: "workflow"` only when the parsed task document's `target.uses.kind === "workflow"` —
exactly the condition the `:220-222` guard in the same `taskDispatch` call already tests, on the
same parsed `task` object, before `prepareTaskV3Execution` is ever invoked. No fixture can pass the
`:220` guard and still reach `:237` with `prepared.kind === "workflow"`: the two sites guard one
condition twice, not two independently reachable failures. The R-03 row and the Lane A checklist
have been amended to name two reachable sites (`semantics.ts:141-146`,
`source-freeze-v4.ts:220-222`) plus this documented-dead duplicate, rather than requiring a third,
unreachable pin. Left unfixed — no production change in P0.

**2026-08-25 — R-02's bare invariant (`src/workflows/ir/source-freeze-v4.ts:296`,
`if (prepared.kind !== "script") throw new Error("direct script did not project as a script")`) is
unreachable from `directScript`'s own call site.** `directScript` is invoked only from `resolveStep`
(`source-freeze-v4.ts:144`) when `target.kind === "script"`, and the synthetic task document it
fabricates always sets `uses: <owned.ref>` where `owned.ref` is built with `plural = "scripts"`
(`resolveOwnedAssetCore`) — so the synthetic document's `uses:` always classifies, and always
prepares, as `kind: "script"`. No fixture reachable through `directScript`'s own call site can make
`prepareTaskV3Execution` return anything else. Exercising the `:296` throw would require calling
`directScript` (or `prepareTaskV3Execution`) with an argument shape it never receives in production.
The R-02 row has been amended to not require pinning this invariant. Left unfixed — no production
change in P0.

**2026-08-25 — R-02's synthetic-document identity fields (`filePath`, `taskId`, `taskRef`) are
computed but not observable anywhere production surfaces.** `directScript` (`source-freeze-v4.ts:274-298`)
fabricates `filePath = \`${asset.path}#${step.id}\``, `taskId = step.id`, and
`taskRef = \`${asset.ref}#${step.id}\``, and threads them through `prepareTaskV3Execution` via the
synthetic document. But `scriptResult()` — the only reader of that prepared execution — copies just
`.sourceRef`/`.interpreter`/`.extension`/`.bytesBase64`/`.byteLength`/`.sha256`/`.cwdIdentity` into
`FrozenWorkflowScriptTarget`; `.taskId`/`.taskRef` are dropped. No seam at head re-exposes them
either: the one other exported entry point over this path, `resolveWorkflowSourceV4`, returns the
same `FrozenWorkflowTarget` shape. A characterization test can therefore only pin these fields by
hand-constructing the same literals `directScript` computes and feeding them to
`parseTaskV3Yaml`/`prepareTaskV3Execution` directly (as
`tests/workflows/characterization-classification.test.ts`'s R-02 identity-contract test does) —
which asserts the test's own inputs round-trip, not a surface `directScript` itself could break. The
R-02 row has been amended to name only the surfaces that are observable (script ref, bytes,
interpreter), pinned by the row's companion end-to-end test. Left unfixed — no production change in
P0.
