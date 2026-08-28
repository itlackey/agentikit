# P4 — deletions, vocabulary close-out, and the 25-criteria acceptance sweep

**Status:** ready for implementation
**Phase:** P4 (final) of the akm task/workflow refactor — P5 folded in
**Owner artifacts:** the three deletion families
(`src/tasks/source-v3.ts`'s GitHub-locator grammar and its two consumers;
task source v3 acceptance across `src/**`; the multi-job parse/ordering
machinery), the compat shims P1b/P2b left behind
(`src/tasks/runtime-v3.ts`, `src/tasks/runner.ts`,
`src/workflows/ir/source-freeze-v4.ts`), the `stash`/`prompt` vocabulary
remnants at task/workflow boundaries, the historical-essay → ADR move,
`docs/plans/0.9.2-architecture-deletion-audit.md`, `STABILITY.md`,
`docs/architecture/specs/driver-protocol-keep-or-cut.md`, `CHANGELOG.md`,
`docs/migration/v0.9.1-to-v0.9.2.md` +
`docs/migration/release-notes/0.9.2.md`, the test floors in
`scripts/test-{unit,integration}.sh`, the `INVALID_FLAG_VALUE` ratchet in
`tests/architecture/diagnostic-codes.test.ts`, the v3-fixture inventory
ratchet in `tests/architecture/task-fixture-vocabulary.test.ts`,
`tests/contracts/ci-test-paths.test.ts`, the §7 authorized flips, and the
§10 acceptance sweep appended to this file.

This document is the **single source of truth** for P4. Lanes do not
re-derive these facts from the codebase and do not read the parent plan.
Every `file:symbol` reference below was verified at the head of
`claude/breaking-changes-0-9-2-3cfyvp` while P3b was landing (`f35d433d`
plus P3b's in-flight tree). **Cite symbols, not line numbers** — P3b is
committing concurrently and every line number in the tree will drift.

---

## 0. What P4 is (and is not)

P0 pinned. P1a fixed the fail-closed violation and built the shared
target-ref classifier. P1b extracted the task model, split the runner and
killed the global env mutation. P2a/P2b landed task source v4, the input
contract, real `with:` bindings, delivery, `akm task explain`, and the
v3→v4 migrator. P3a/P3b landed child workflows end to end.

Every one of those phases left something behind **on purpose**, with a
`P4:` marker in the code or a row in a Review log. P4 collects the debt and
closes the branch.

P4 **is**:

- **three deletion families**, one commit each, each preceded by a
  zero-consumer proof and followed by a dead-code sweep and a green
  `bun run check` (§3):
  1. the **GitHub Action locator grammar** out of task-v3 classification and
     out of workflow-step semantics (§3.1);
  2. **task source v3 acceptance out of `src/`** — `version: 3` documents
     now fail with `TASK_SCHEMA_VERSION_UNSUPPORTED` naming the migrator;
     the v3 parser survives only **vendored** inside `scripts/akm-migrate/`;
     the second scheduling syntax (`akm.schedule` / task-level `on:`) dies
     with it; the P1b/P2b compat shims delete (§3.2);
  3. **multi-job YAML confined to ONE adapter-boundary rejection** — the
     ordering machinery and the two downstream duplicate rejections delete
     (§3.3);
- **a vocabulary and documentation close-out** (§4): `stash`/`prompt`
  remnants, historical essays moved to ADRs, the deletion-audit net-LOC
  checkpoint refreshed, `STABILITY.md` de-staled, the driver-protocol
  decision record flipped PROPOSAL → RESOLVED, `CHANGELOG [Unreleased]`
  completed, and the **migration guide + release notes reconciled with the
  whole refactor** (they ship in the npm tarball and are the upgrader's
  first read);
- **floors, ratchets and CI-path contracts brought to their terminal
  state** (§5): the `INVALID_FLAG_VALUE` ratchet driven to zero outside
  genuine flag parsing, the v3-fixture inventory ratchet reduced to the
  migrator surfaces, the test floors re-measured with the delta in the
  commit body, and `ci-test-paths` green against every renamed suite;
- **a report-only acceptance sweep** over the original brief's 25 criteria,
  reproduced verbatim in §10, with a grep or `file:symbol` citation per
  criterion and an explicit UNMET list (§10).

P4 is **not**:

- **a file-rename phase.** `src/workflows/ir/schema-v4.ts`,
  `freeze-v4.ts`, `environment-v4.ts`, `src/tasks/source-v3.ts` (once
  shrunk) and the `PreparableTaskDocument` / `TaskV3*` type family keep
  their names. P3a §0 and P3b §0 both wrote "P4 owns the rename"; §8 R-R1
  dispositions that hand-off to a **follow-up** commit after the sweep is
  green. Rationale is binding: the deletion audit's rule is *deletions must
  show*, and a rename storm across ~40 import sites buries the deletion
  diff it is supposed to prove.
- **a behavior-improvement phase.** Every carried advisory that would
  require new behavior (P2a's four message/secret advisories, P2b's
  hash-coverage and diagnostic-wording advisories) is dispositioned in §8
  and left unfixed.
- **a grammar-extension phase.** No new task or workflow source syntax.
  `WORKFLOW_MAX_*` limits, plan `irVersion` 5, `hashVersion` 6 and the
  `\0v1\0` child-invocation vocabulary are all unchanged. **A P4 commit
  that changes any of those three numbers is a review-blocking violation.**
- **a second-executor or compatibility-shim phase.** Nothing deleted here
  gets a fallback path.

Rules of engagement (unchanged since P1b):

- A defect discovered that is **not** in §7 is recorded in the Review log
  and left unfixed. Do not "improve" anything on the way past.
- If preserving a behavior and implementing an authorized deletion appear
  to conflict, **stop and record it** — preserving wins until the Review
  log says otherwise.
- Editing a **pre-existing** test that §7 does not name is a
  **review-blocking violation**.
- **Nothing is deleted that §3/§4/§5 does not name, and nothing §3/§4/§5
  names is left undeleted.** §7 exists so a reviewer can check both halves
  mechanically.

### 0.1 Naming discipline (binding, D1)

Carried forward verbatim from P3a §0.1 and P3b §0.1:

| Counter | Value in P4 | Where it lives |
|---|---|---|
| Workflow plan schema | **plan `irVersion` 5** — UNCHANGED | `WORKFLOW_IR_V5_VERSION`, `plan.irVersion`, `workflow_runs.plan_ir_version` |
| Unit / gate input hash | **`hashVersion` 6** — UNCHANGED | `akm.workflow.unit\0v6\0`, `akm.workflow.gate\0v6\0` |
| Child invocation key | **`\0v1\0`** — UNCHANGED | `akm.workflow.child-invocation\0v1\0` |
| Task source | **task source v4** | `TASK_SOURCE_V4_VERSION`, `src/tasks/source/` |

Never write a bare `v3`/`v4`/`v5`/`v6` in prose, a comment, a test name or a
commit message. Write "task source v4", "plan `irVersion` 5",
"`hashVersion` 6". The one permitted bare form is **"task v3"** when naming
the *retired* source version in an error message, a CHANGELOG entry or a
migration doc — users have that word in their files.

### 0.2 Commit ladder (binding)

Each row is one commit, pushed by the agent that wrote it (see §0.3). Every
commit is **`bunx tsc --noEmit` green and `bun run check` green on its own**.

| # | Commit | Lane | Contents |
|---|---|---|---|
| 1 | `docs(p4): behavior spec for deletions, vocabulary close-out, and acceptance sweep` | — | **this file only** |
| 2 | `refactor(p4): delete the GitHub Action locator grammar` | A | §3.1 + its §7 flips + sweep |
| 3 | `refactor(p4): remove task source v3 acceptance from src` | A | §3.2 + its §7 flips + sweep |
| 4 | `refactor(p4): confine multi-job YAML to one adapter-boundary rejection` | A | §3.3 + its §7 flips + sweep |
| 5 | `refactor(p4): task and workflow vocabulary consolidation` | B | §4.1 + §4.8 |
| 6 | `docs(p4): move design history to architecture decision records` | B | §4.2 |
| 7 | `docs(p4): deletion audit, stability index, and the driver-protocol decision` | B | §4.3–§4.5 |
| 8 | `docs(p4): changelog, migration guide, and 0.9.2 release notes` | B | §4.6–§4.7 |
| 9 | `test(p4): terminal diagnostics ratchet, v3 fixture ratchet, floors, and CI paths` | C | §5 |
| 10 | `docs(p4): 25-criteria acceptance sweep` | D | §10's report appended to **this file** + the Review log close-out |

**Sequencing (binding).** Commits 2 → 3 → 4 are strictly ordered: 3 depends
on 2 (the vendored migrator parser must carry the locator grammar the
moment `src` stops holding it), 4 is independent of both but lands after so
each family's sweep sees a settled tree. Lane B (5–8) may run **in parallel
with Lane A** only because §6's file lists are disjoint; commit 7's net-LOC
numbers and commit 8's CHANGELOG deletion entries must be **re-measured
against Lane A's head** before they land, so in practice 7 and 8 rebase
onto commit 4. **Lane C (9) is strictly last** among A/B/C: its ratchet
numbers and floors are measurements of the tree Lane A and Lane B produce.
Lane D (10) runs only when 2–9 are all green.

### 0.3 Standing process rules (binding)

- **Self-commit + push per agent, with rebase-retry.** Every agent that
  writes files commits and pushes its own lane's files as soon as they are
  formatted and `bunx tsc --noEmit` green (commit-granularity rule,
  2026-08-26). On a non-fast-forward push: `git pull --rebase` then push,
  up to 4 attempts with backoff. Never `--force`.
- **Red-phase directives are P4-marked.** A type-level pin of an API that
  only exists after a later commit in the ladder ships with
  `// @ts-expect-error P4 red-phase: <symbol> lands in <commit> (remove with the implementation)`.
  The commit that lands the symbol **must** remove the directive — an
  unused directive fails `tsc`, so the gate enforces it.
- **`bunx tsc --noEmit` is green at every commit.** Never classify a type
  error as "pre-existing" without `git stash` proof against the parent
  commit.
- **Raw-output gate.** The gate agent reports from raw command output, never
  from a wrapper exit code (a pipeline `tail` masked a red gate once).
- **`MAX_REVIEW_ROUNDS = 2`** for this mechanical phase, with
  auto-adjudication on budget exhaustion: if the last round's fixes were
  applied and its own findings were the sole basis of an abort flag, log the
  adjudication in the Review log and **proceed**. Return `blocked` only when
  a round produced findings that were never fixed.
- Agents run `bunx biome check --write src/ tests/` on touched files before
  committing; `bun run check` runs before every Lane A deletion commit and
  at the phase gate.

---

## 1. Binding design decisions (verbatim)

§1.1–§1.5 are copied **verbatim** from the phase decisions and the original
brief and are binding. §1.6 records the disambiguations this spec adds.

### 1.1 D7 — diagnostics (verbatim)

> **D7 Diagnostics:** new `UsageErrorCode`s (exit-code contract untouched):
> `TASK_SOURCE_INVALID` (replaces the `sourceError` funnel),
> `WORKFLOW_SOURCE_INVALID`, `TARGET_REF_INVALID`, `COMPOSITION_INVALID`
> (with-on-task rejection, nested-workflow, cycles/depth/size, multi-job
> adapter rejection), `INPUT_BINDING_INVALID`; reuse
> `TASK_SCHEMA_VERSION_UNSUPPORTED` for P4's v3 rejection.
> `child_workflow_failed` is a journal `failure_reason`, not an error code.
> New ratchet `tests/architecture/diagnostic-codes.test.ts` pins a declining
> `INVALID_FLAG_VALUE` count in task/workflow domains (→0 outside true flag
> parsing by P4).

### 1.2 D11 — v3 compatibility timeline (verbatim)

> **D11 v3 compatibility timeline:** v3 sources parse through the adapter in
> P1–P3; P4a removes v3 acceptance from `src`
> (`TASK_SCHEMA_VERSION_UNSUPPORTED` + `akm-migrate` hint); v3 parser
> survives only vendored in `scripts/akm-migrate` (frozen-migrator
> principle, `AKM_MIGRATE_ENTRY=1` re-exec packaging). The ~150-site
> `@daily` fixture sweep runs in **P2c**, isolating P4's blast radius.
> Pre-v5 workflow plans: complete-or-abandon, no second executor.

### 1.3 Brief §9 — complexity to remove (verbatim, P4's rows only)

> | Current complexity | Recommended action | Rationale |
> |---|---|---|
> | GitHub Action locator in task schema | Remove from native task v4 and shared target union | Recognized only to fail; external execution is deferred |
> | `akm.schedule` and task-level `on` | Select one canonical v4 form; migrate both v3 forms | Two syntaxes provide no additional AKM capability |
> | Multi-job YAML parsing without execution | Reject at YAML adapter boundary; remove from next core IR | Display-only graph semantics add cost and confuse agents |
> | Workflow target rejection in multiple layers | Replace with one child-workflow resolver and cycle detection | One authoritative composition policy |
> | `stashDir` and `"stash"` internal fallback | Rename to workspace/bundle terminology | Keep legacy vocabulary at compatibility boundaries only |
> | `prompt` result kind for command execution | Normalize target/result vocabulary | Improves logs, JSON output, and supportability |
> | Generic `INVALID_FLAG_VALUE` errors | Add phase-specific diagnostic codes | Makes failures searchable and actionable |
> | Historical essays inside large modules | Keep invariant comments locally; move design history to ADRs | Reduce cognitive load without deleting important reasoning |

### 1.4 Brief §10 — multi-job and GitHub-shaped YAML policy (verbatim)

> AKM should continue to support declarative YAML. That does not require it
> to imitate GitHub Actions beyond the useful subset.
>
> The public position should become:
>
> > AKM YAML uses a familiar GitHub-step-shaped syntax but is an AKM
> > workflow format, executed by AKM's native engine.
>
> The implementation should not imply: Marketplace action compatibility,
> GitHub contexts, GitHub expressions, hosted runner images, service
> containers, matrix compatibility, job permissions, remote reusable
> workflows, full multi-job execution.
>
> For compatibility, the current YAML adapter may continue accepting
> `name:`/`on:`/`jobs:` … **But it should require exactly one job.**
>
> … The immediate priority is to remove non-executable multi-job behavior
> from the internal contract.

### 1.5 Brief §15 — keep comments about invariants, not history (verbatim)

> Local comments should explain: Why mutation is delayed. Why a hash
> includes a field. Why a transaction boundary exists. Why a source is
> revalidated. Why a child invocation is idempotent.
>
> Historical review narratives and superseded alternatives belong in
> architecture documents.

### 1.6 Disambiguations this spec adds (binding)

- **P4-N1 — the migrator vendors the v3 parser; `src` never imports
  `scripts`.** Today three migrator modules import live v3 symbols from
  `src/tasks/source-v3.ts` (`task-files-to-v3.ts` → `parseTaskV3Yaml`;
  `task-to-v3.ts` → `classifyTaskV3Uses`, `TaskV3UsesTarget`, the resource
  bounds; `task-to-v4.ts` → `assertBoundedTaskYamlDocument`,
  `classifyTaskV3Uses`, `TASK_V3_MAX_SOURCE_BYTES`, `TaskV3UsesTarget`).
  §3.2 **vendors** what they need into `scripts/akm-migrate/migrate/`. The
  vendored copy **retains the full GitHub locator grammar** §3.1 deletes
  from `src` — `task-to-v4.ts` must keep classifying a locator so it can
  emit its `github-action-target-removed` blocked reason rather than
  guessing.
- **P4-N2 — the multi-job rejection lives at the source adapter, and the
  UsageError code it surfaces as is `COMPOSITION_INVALID`.** Two layers,
  do not conflate them: the ADAPTER raises a `WorkflowSourceFailure` with
  the kebab source-error `code` (§3.3 names it), and the freeze boundary's
  wrapper maps a compile result whose single error carries that code onto
  `UsageError` code `COMPOSITION_INVALID`; every other compile failure maps
  onto `WORKFLOW_SOURCE_INVALID`. The wrapper must not blanket-recode: a
  YAML syntax error is not a composition failure.
- **P4-N3 — `classifyTaskV3Triggers` is workflow-side and survives.** It is
  the classifier `src/workflows/source-ir/compile.ts` injects to
  cross-check GitHub-YAML `on:` triggers (`github-yaml.ts`'s
  `trigger-classifier-drift` guard). "The second scheduling syntax dies
  with v3" is about a **task document's** `akm.schedule` / top-level `on:`,
  never about a workflow's `on:`. §3.2 re-homes this function but does not
  delete it.
- **P4-N4 — the prepare seam keeps its type shape.** `PreparableTaskDocument`
  (= `TaskV3SourceDocument`) is produced only by `projectTaskSourceV4` after
  §3.2. Its NAME and the `TaskV3*` type family stay (§0, R-R1). Guards on
  that seam that become unreachable-from-any-source but remain
  type-permitted are **kept as defense-in-depth with a one-line invariant
  comment**, not deleted — see §3.2's disposition table for the exact three.
- **P4-N5 — floors move to the measured reality, in whichever direction the
  measurement points.** The scripts' own convention is "set below the
  current count with room for churn; raise it as the suite grows;
  LOWERING it is the thing to argue about in review." P4's binding rule:
  new floor = `floor(measured_executed × 0.95 / 100) × 100`, where
  `measured_executed = pass + skip` at the phase head. If that value is
  **below** the current floor, the commit body must additionally carry the
  per-suite deleted-test inventory and the deletion rationale (§5.3).
- **P4-N6 — a v4 task's `enabled` is per schedule binding, and the
  document-level skip dies with v3.** `prepare-support.ts` derives
  `enabled: document.akm?.enabled !== false`, and `projectTaskSourceV4`'s
  `projectAkm` never emits `akm.enabled` — so after §3.2 every prepared task
  is `enabled: true` and `run-task.ts`'s `shouldSkipUnactivatedTask` skip is
  unreachable. §3.2 deletes it and re-points `akm task add --disabled` at
  `schedule[].enabled`, which is where task source v4 represents the state
  and where `scheduler-sync` already reads it.

---

## 2. Behavior tables (input → old outcome → new outcome)

Every row is an **observable** surface: a thrown error's type + `code` +
message, a rendered CLI envelope, a stored value, a parse result. Rows are
cited by ID from §3–§5 and from the §7 flips table.

### 2.1 Family A1 — the GitHub Action locator grammar

| # | Input | Old outcome | New outcome after P4 |
|---|---|---|---|
| **B-01** | `classifyTaskV3Uses("owner/repo@v1")` | returns frozen `{kind:"github-action", ref, owner, repository, revision}` | the symbol no longer exists (deleted with §3.2); until then, throws `UsageError`/`INVALID_FLAG_VALUE` with the trailing classification message, minus its `owner/repo[/path]@ref` clause |
| **B-02** | `classifyTaskV3Uses("owner/repo/sub/dir@v1")` | frozen target with `path: "sub/dir"` | same as B-01 |
| **B-03** | Trailing classification message | `Task v3 uses must be akm/command, a canonical commands/, workflows/, or scripts/ asset ref, or owner/repo[/path]@ref. Agent/task/local/Docker/ambiguous targets are not executable.` | `Task v3 uses must be akm/command, a canonical commands/, workflows/, or scripts/ asset ref. Agent/task/local/Docker/remote-action/ambiguous targets are not executable.` |
| **B-04** | A task document whose `uses:` is a locator, prepared | `UsageError`/`INVALID_FLAG_VALUE`: `GitHub action "<ref>" is recognized but remote action acquisition is unsupported in 0.9.2.` | unreachable — the document fails at **parse**, at `uses:`, with the B-03 message under `TASK_SOURCE_INVALID`. The prepare-side arm is deleted. |
| **B-05** | Workflow step `uses: actions/checkout@v4` | `WorkflowSourceSemanticError` code `remote-action-acquisition-out-of-scope`: `Remote action acquisition is out of scope for "actions/checkout@v4".` | `WorkflowSourceSemanticError` code `unsupported-uses-target`, message derived from `TARGET_REF_INVALID`'s text (`usesFailure` wraps the cause) |
| **B-06** | Workflow step `uses: docker://alpine:latest` | `docker-action-unsupported` | **unchanged** — `usesFailure`'s prefix classifications are untouched |
| **B-07** | Workflow step `uses: ./actions/review` | `local-action-path-unsupported` | **unchanged** |
| **B-08** | Workflow step `uses: agents/reviewer` | `non-executable-asset-ref` | **unchanged** |
| **B-09** | Workflow step `uses: tasks/nightly` with an **injected** classifier that rejects task refs | classified `{kind:"task"}` without ever calling the classifier (`canonicalTaskTarget` ran first) | the classifier is called; the default (`classifyWorkflowSourceUses` → `classifyTargetRef`) still returns `{kind:"task", ref}`. `canonicalTaskTarget` is deleted. |
| **B-10** | `schemas/akm-task.json` validated against `uses: actions/checkout@v4` | the v3 arm accepts it (`githubActionRef`) | no arm accepts it; `githubActionRef` and both `$ref`s to it are gone |
| **B-11** | A **task source v4** document with `uses: actions/checkout@v4` | `TASK_SOURCE_INVALID`: `GitHub Action targets were removed in task source v4 — the github-action uses: variant no longer exists. …` | **unchanged** — this upgrade-helpfulness message stays; only its in-code comment referencing `classifyTaskV3Uses` is rewritten |
| **B-12** | `scripts/akm-migrate task-v4-apply` on a v3 doc whose `uses:` is a locator | blocked, reason `github-action-target-removed` | **unchanged** — the vendored parser keeps the grammar (P4-N1) |

### 2.2 Family A2 — task source v3 acceptance out of `src/`

| # | Input | Old outcome | New outcome after P4 |
|---|---|---|---|
| **B-13** | `parseTaskSource` on a document with `version: 4` | routes to `parseTaskSourceV4Document` | **unchanged** |
| **B-14** | `parseTaskSource` on a document with `version: 3` | routes to `parseTaskV3Document`; parses | `UsageError` code `TASK_SCHEMA_VERSION_UNSUPPORTED`, message `TASK_SCHEMA_VERSION_UNSUPPORTED: Task at <path> uses task schema version 3, which this release does not accept.`, hint `Run \`akm migrate apply --dry-run\` to preview the task-v3 to task-source-v4 conversion, then run \`akm migrate apply\`.` |
| **B-15** | `parseTaskSource` on a document with `version: 2` | `TASK_SCHEMA_VERSION_UNSUPPORTED` naming the v2→v3 conversion | `TASK_SCHEMA_VERSION_UNSUPPORTED` with the **same hint as B-14** (the migrator runs both generations — §3.2.5) |
| **B-16** | `parseTaskSource` on a document with no `version:` key, or any other value | v3's own `version is required and must be 3.` / `must be exactly 3.` under `TASK_SOURCE_INVALID` | `must be exactly 4.` / `is required and must be 4.` under `TASK_SOURCE_INVALID` (P2a §3.4's recorded wart closes here) |
| **B-17** | The bounded YAML front end's own pre-version failures (not a string, too large, YAML parse/expansion) | rendered with the label `task v3 source` | rendered with the label `task source` (P2a §3.4's second recorded wart closes here) |
| **B-18** | A task document declaring neither `akm.schedule` nor `on:` | `TASK_SOURCE_INVALID`: `must declare exactly one scheduling source: akm.schedule or on.` | unreachable — the document is `version: 3` and fails at B-14. Task source v4's optional `schedule:` (D2-N6) is the only scheduling grammar. |
| **B-19** | A task document declaring **both** `akm.schedule` and `on:` | same message as B-18 | unreachable — same as B-18 |
| **B-20** | `akm task add --workflow workflows/x --params '{"a":1}'` | writes `version: 3` with `uses: workflows/x` + `with: {a: 1}` | writes `version: 4` with `uses: workflows/x` and `inputs: {a: {type: "number", default: 1}}`; the declared inputs reach the child run's params through `load-task.ts`'s existing v4 delivery override |
| **B-21** | `akm task add --disabled …` | writes `akm: {enabled: false}`; `runTask --scheduled` skips the dispatch | writes `schedule: [{cron: …, enabled: false}]` when a schedule is given; with no schedule the flag is a usage error naming `--schedule`. `scheduler-sync` already refuses to install a disabled binding, so a disabled task never fires. |
| **B-22** | `akm task run <id> --scheduled` on a task whose document-level `enabled` is false | skipped with the unactivated-task result | unreachable — task source v4 has no document-level `enabled`; the skip is deleted (P4-N6) |
| **B-23** | `akm setup`'s scheduled-task review step on a shipped task | parses through `parseTaskV3Yaml`; toggles via `setTaskV3EnabledInYaml` | parses through `parseTaskSource`; toggles the shipped v4 document's `schedule[].enabled` |
| **B-24** | Any of the 10 shipped assets under `src/assets/tasks/**` | `version: 3` with an `akm:` bag | `version: 4` with top-level `schedule:` / `description:`; identical cron, identical target, identical enablement |
| **B-25** | `import … from "src/tasks/runtime-v3"` | re-exports `prepareTaskV3Execution` + the `PreparedTaskV3*` types | module does not exist |
| **B-26** | `import … from "src/tasks/runner"` | re-exports `runTask`, `readTaskHistory`, … | module does not exist; importers use `src/tasks/run/**` directly |
| **B-27** | `import … from "src/workflows/ir/source-freeze-v4"` | re-exports `resolveWorkflowSourceV4` | module does not exist; `ir/freeze-v4.ts` imports `../freeze/source-freeze` |
| **B-28** | A task document whose `uses:` targets a workflow and that authors `with:` | prepared `params` deep-equal the authored mapping (P0 P-03) | unreachable — task source v4 rejects `with:` on any target but `akm/command`. `prepared.params` is the task's **defaulted declared inputs**, or `{}`. |
| **B-29** | A workflow step composing a task whose own `with:` shape is `{from: "steps.x.output"}` | that value gains **reference** semantics at freeze while `akm task run` treats it as a literal (P3a Review log R9) | unreachable — no task document can author `with:` on a workflow target any more. R9 is resolved by deletion (§8 R-R2). |
| **B-30** | `taskDispatch`'s `authoredInputs` for a task-wrapped child workflow | `{kind:"bindings"}` when the task declares `inputs:`, else `{kind:"with", value: prepared.params}` | always `{kind:"bindings", value: bindings}` — the `{kind:"with"}` ternary arm is deleted from `taskDispatch` (it is still reached by the **direct** composition path in `resolve-steps.ts`, which is untouched) |
| **B-31** | `akm migrate status` | reports the task-v2 → task-v3 generation only | reports both generations: v2 → v3, then v3 → task source v4 |
| **B-32** | `akm migrate apply [--dry-run]` | converts task-v2 files to task v3 | runs both generations in order against the same tree, each keeping its own lock / `O_EXCL` backup / prevalidate / TOCTOU-recheck / atomic-replace / rollback / convergence ladder |
| **B-33** | `akm-migrate task-v4-status` / `task-v4-apply` | the v3 → task source v4 generation | **unchanged** — the frozen-migrator surface keeps both verbs |

### 2.3 Family A3 — multi-job confinement

| # | Input | Old outcome | New outcome after P4 |
|---|---|---|---|
| **B-34** | GitHub-shaped YAML with 2 jobs | parses clean into 2 ordered jobs | `compileGithubWorkflowSource` returns `ok: false` with one error, code `multi-job-unsupported`, message `AKM workflow YAML requires exactly one job; this document declares <n>. AKM's YAML is an AKM workflow format executed by AKM's native engine, not GitHub Actions — split the jobs into separate workflows.`, `line` = the second job's span start |
| **B-35** | GitHub-shaped YAML with 0 jobs (`jobs: {}`) | `job-count-limit`: `workflow.jobs must contain 1 through 256 jobs.` | code `multi-job-unsupported`, same policy message with `<n>` = 0 |
| **B-36** | GitHub-shaped YAML with 257 jobs | `job-count-limit` | code `multi-job-unsupported` (the 256 bound and its message are deleted with the machinery) |
| **B-37** | One job with a non-empty `needs:` | `missing-job-dependency`: `Job <id> needs missing job <dep>.` | code `multi-job-unsupported` with the message `Job <id> declares needs, but an AKM workflow has exactly one job; remove needs.` |
| **B-38** | Two jobs where one `needs` a missing job | `missing-job-dependency` | B-34's rejection (the document never reaches dependency validation) |
| **B-39** | Jobs forming a dependency cycle | `job-dependency-cycle`: `Workflow jobs contain a dependency cycle.` | B-34's rejection |
| **B-40** | Duplicate `needs` entries | `duplicate-job-dependency` | B-37's rejection (still one job) |
| **B-41** | Two independently-ready jobs | emitted in canonical topological, lexical-tie-break order | B-34's rejection; `canonicalTopologicalJobs` is deleted |
| **B-42** | `decodeWorkflowSourceIrV1` on an IR carrying 2 jobs | `jobs must contain 1 through 256 entries` / topological-order checks | `jobs must contain exactly 1 entry` — the decoder's `validateTopologicalJobs` and its 256 bound are deleted |
| **B-43** | `compileWorkflowPlan` on a 2-job IR | **returns** `{ok:false, errors:[{line, message:"Current workflow execution requires exactly one source-IR job."}]}` | unreachable — the IR cannot carry 2 jobs. The check is deleted; the return-vs-throw asymmetry P0 R-05(c) pinned disappears with it. |
| **B-44** | Freezing a workflow whose source declared 2 jobs | `UsageError`/`INVALID_FLAG_VALUE`: `Multi-job workflow cannot execute until job boundaries and needs have a durable runtime representation.` | `UsageError` code **`COMPOSITION_INVALID`**, message `Workflow source cannot be frozen: <B-34's adapter message>` — one rejection, raised at the adapter and surfaced through the freeze wrapper (P4-N2) |
| **B-45** | Freezing a workflow whose source fails for any **other** reason | `UsageError`/`INVALID_FLAG_VALUE`: `Workflow source cannot be frozen: …` | `UsageError` code **`WORKFLOW_SOURCE_INVALID`**, message byte-identical |
| **B-46** | A **single-job** GitHub-shaped YAML document (`single-job/single-job.yml`) | parses, compiles, freezes | **unchanged** — this is the acceptance baseline (brief §10: "it should require exactly one job") |
| **B-47** | A Markdown workflow source | compiles to a one-job IR | **unchanged** |

### 2.4 Lane B — vocabulary and documentation

| # | Surface | Old | New after P4 |
|---|---|---|---|
| **B-48** | `DEFAULT_BUNDLE_NAME` value | `"stash"` | **unchanged** — it is user data compatibility (P0 R-09). Only stray `"stash"` literals at task/workflow boundaries consolidate onto the constant. |
| **B-49** | `RunTaskOptions` legacy aliases | `bundleDir` only (P1b F-3 already renamed `stashDir`) | **unchanged**; §4.1 proves the absence rather than performing a rename |
| **B-50** | `src/indexer/**`'s `stashDir` | present | **unchanged — OUT OF SCOPE**, recorded since P0 R-09 |
| **B-51** | The D8 legacy read mapping in `run/task-history.ts` (`"prompt"` → `{kind:"command", engine}`, legacy `"command"` → `{kind:"shell"}`) | present | **unchanged — it reads old rows forever**. Deleting it is a review-blocking violation. |
| **B-52** | `"prompt"` as a **written** result kind anywhere in `src/` | already absent | proven absent by grep and pinned (§5.2) |
| **B-53** | `WORKFLOW_SOURCE_INVALID`'s usage hint | `Run \`akm workflow validate <ref>\` to see the failing source location.` (names a verb that does not exist) | `Run \`akm lint\` to see the failing source location, or \`akm workflow plan <ref>\` to compile it without writing.` |
| **B-54** | `TASK_TARGET_UNSUPPORTED`'s usage hint | `… akm/command and GitHub-action targets are not yet representable here.` | `Task definitions support command, script, workflow, and shell (run:) targets; akm/command is layered by callers.` |
| **B-55** | `SAFE_TASK_ATTEMPT_ERROR_CODES` | includes `TASK_SOURCE_INVALID`, `COMPOSITION_INVALID` | additionally includes `TARGET_REF_INVALID`, `WORKFLOW_SOURCE_INVALID`, `INPUT_BINDING_INVALID`, `TASK_TARGET_UNSUPPORTED` — every code §5.2's re-codes make reachable from a task attempt |
| **B-56** | `docs/architecture/specs/driver-protocol-keep-or-cut.md` status line | `Status: PROPOSAL — decision requested.` | `Status: RESOLVED (2026-08-27) — Option B, cut. Executed ahead of this record by the 0.9.2 reconstruction.` plus a §10 "Decision and evidence" section carrying the three verification greps |
| **B-57** | `STABILITY.md`'s Tasks bullet | "strict version-2 YAML for scheduled tasks. Prompt tasks use named engines…" | "task source v4 YAML (typed `inputs:`, optional `schedule:`); task v3 and task v2 sources are converted by `akm migrate apply`. Command tasks use named engines…" |
| **B-58** | `STABILITY.md`'s command tier index | no row for `akm task explain` or `akm workflow plan` | both present, tier **Evolving**, with the note "secret-free provenance output" |

### 2.5 Lane C — floors and ratchets

| # | Surface | Old | New after P4 |
|---|---|---|---|
| **B-59** | `INVALID_FLAG_VALUE_BASELINE` in `tests/architecture/diagnostic-codes.test.ts` | `82`, comment "re-measure and lower when future work recodes more sites" | the measured terminal count (§5.2's target table predicts **34**), comment rewritten to say **terminal**: the remaining occurrences are genuine flag/argument-value parsing plus one allowlist membership line, and any increase is a defect |
| **B-60** | The classification import-seam assertion | `semantics.ts`/`uses.ts` import nothing from `tasks/source-v3`; `compile.ts` imports only `classifyTaskV3Triggers` | strengthened per P1a's carried advisory: the scan covers named imports, **namespace imports, `export … from` re-exports, `import type`/`ImportTypeNode` queries and dynamic `import()` specifiers**, and `compile.ts`'s allowed binding list follows §3.2's re-home of `classifyTaskV3Triggers` |
| **B-61** | `tests/architecture/task-fixture-vocabulary.test.ts`'s allowed set | 3 directory prefixes + ~25 exact files | terminal: prefixes `tests/fixtures/execution-contracts/tasks/v2/` and `…/v3-to-v4/`; exact files `tests/migrate/task-v2-to-v3-files.test.ts`, `tests/tasks/migrate-v2-to-v3.test.ts`, `tests/migrate/task-v3-to-v4.test.ts` — the three migrator suites and nothing else |
| **B-62** | `AKM_MIN_UNIT_TESTS` / `AKM_MIN_INTEGRATION_TESTS` | `3500` / `5000` | P4-N5's measured values, with the before/after counts and the deletion rationale **in the commit body** |
| **B-63** | `tests/contracts/ci-test-paths.test.ts` | green | green — every `tests/**.test.ts` path named in `.github/workflows/*.yml` still exists after §3's deletions, or the workflow was edited in the same commit |

---

## 3. Lane A — grammar and version deletions

**One commit per family. Each family: (1) prove zero remaining consumers by
grep, (2) delete, (3) run the dead-code sweep of §3.4, (4) `bun run check`,
(5) commit + push.**

### 3.1 Family A1 — the GitHub Action locator grammar (commit 2)

#### 3.1.1 Zero-consumer proof (run FIRST, paste into the commit body)

```
rg -n 'github-action|githubActionRef|GITHUB_OWNER|GITHUB_REPOSITORY|GITHUB_ACTION_PATH_SEGMENT|GITHUB_REF_FORBIDDEN|validGithubRevision|hasForbiddenGithubRefCharacter|isGithubLocatorShape|isGithubLocatorRevisionShape|remote-action-acquisition' src/ scripts/ schemas/
```

The expected pre-deletion hit set is exactly: `src/tasks/source-v3.ts`
(type member, four regex/helper declarations, the locator branch),
`src/tasks/prepare/prepare.ts` (the acquisition-unsupported arm),
`src/workflows/source-ir/semantics.ts` (`isGithubLocatorShape`,
`isGithubLocatorRevisionShape`, the catch-arm override, the
`kind === "github-action"` arm), `src/workflows/source-ir/uses.ts` (the type
member and its doc comment), `src/tasks/source/task-source-v4.ts` (comments
and the B-11 message), `src/tasks/source/parse-v3-adapter.ts` (a comment),
`src/core/errors.ts` (`TASK_TARGET_UNSUPPORTED`'s comment and hint),
`schemas/akm-task.json` (`githubActionRef` + two `$ref`s), and
`scripts/akm-migrate/migrate/task-to-v4.ts` (the blocked-reason arm, which
**stays**). Any other hit is recorded before deleting anything.

#### 3.1.2 Deletions

| Site | Action |
|---|---|
| `src/tasks/source-v3.ts` → `TaskV3UsesTarget` | DELETE the `github-action` union member. The type becomes `builtin-command \| command \| workflow \| script`. |
| `src/tasks/source-v3.ts` → `GITHUB_OWNER`, `GITHUB_REPOSITORY`, `GITHUB_ACTION_PATH_SEGMENT`, `GITHUB_REF_FORBIDDEN`, `hasForbiddenGithubRefCharacter`, `validGithubRevision` | DELETE (all module-private) |
| `src/tasks/source-v3.ts` → `classifyTaskV3Uses` | DELETE the trailing `const at = value.lastIndexOf("@") …` locator branch; rewrite the trailing throw's message to B-03 |
| `src/tasks/prepare/prepare.ts` | DELETE the `if (target.kind === "github-action")` arm and its message (row B-04) |
| `src/workflows/source-ir/semantics.ts` | DELETE `isGithubLocatorShape`, `isGithubLocatorRevisionShape`, the `catch`-arm override that promotes an `unsupported-uses-target` failure to `remote-action-acquisition-out-of-scope`, and the `if (target.kind === "github-action")` arm. The `catch` becomes `throw usesFailure(value, cause);` with no override. |
| `src/workflows/source-ir/semantics.ts` → `canonicalTaskTarget` | DELETE the helper and its call. `classifyWorkflowStepUses`'s evaluation order becomes: expression check → shape check → `classifier(value)` → return. (P1a §4.3 kept it "first, without calling the classifier" purely for locator parity; with the locator gone, `classifyTargetRef`'s `tasks/` arm is the one authority — brief §8.1.) |
| `src/workflows/source-ir/uses.ts` | DELETE the `github-action` member of `WorkflowSourceUsesTarget` and rewrite the doc comment that explains why it was retained as a type |
| `src/core/errors.ts` | Rewrite `TASK_TARGET_UNSUPPORTED`'s hint to B-54 and drop "github-action" from its declaration comment |
| `schemas/akm-task.json` | DELETE the `githubActionRef` definition and both `$ref`s to it from the v3 arm; update the root `description`'s "GitHub action refs are recognized source syntax" clause |
| `src/tasks/source/task-source-v4.ts` | Rewrite the three comments that explain the v4 rejection by reference to `classifyTaskV3Uses`'s locator grammar. **The B-11 rejection message itself is unchanged.** |

`remote-action-acquisition-out-of-scope` must survive **nowhere** in `src/`
after this commit. It survives in `tests/` only where §7 keeps a pinned
historical string; it survives in docs only in the CHANGELOG's breaking-change
entry.

#### 3.1.3 What A1 does NOT touch

- `scripts/akm-migrate/migrate/task-to-v4.ts`'s
  `github-action-target-removed` arm and its message (P4-N1).
- The `usesFailure` prefix classifications (`docker://`, `./`, `../`, `/`,
  `agents/`) — rows B-06…B-08.
- Task source v4's own B-11 message.

### 3.2 Family A2 — task source v3 acceptance out of `src/` (commit 3)

#### 3.2.1 Zero-consumer proof (run FIRST, paste into the commit body)

```
rg -n 'parseTaskV3Yaml|parseTaskV3Document|classifyTaskV3Uses|TASK_V3_SCHEMA_VERSION|taskV2UnsupportedError|setTaskV3EnabledInYaml' src/ scripts/
rg -n 'from "[^"]*tasks/source-v3"|from "\./source-v3"|from "\.\./source-v3"' src/ scripts/
```

The pre-deletion production callers of `parseTaskV3Yaml` are exactly three:
`src/tasks/embedded.ts`, `src/setup/steps/tasks.ts`, and (via
`parseTaskV3Document`) `src/tasks/source/parse-task-source.ts`. All three are
rewired below. Any fourth is recorded before deleting anything.

#### 3.2.2 The routing flip

`src/tasks/source/parse-task-source.ts` is the one version router. After A2:

- `version: 4` → `parseTaskSourceV4Document` (unchanged, row B-13);
- **anything else** → `UsageError` code `TASK_SCHEMA_VERSION_UNSUPPORTED`
  (rows B-14, B-15) with the migrator hint, EXCEPT that a document with no
  `version:` key, or a `version:` that is not a number, keeps producing
  task source v4's own `TASK_SOURCE_INVALID` field error (row B-16) — a
  missing `version` is a malformed v4 document, not a legacy one;
- the front end's `sourceLabel` becomes `task source` (row B-17).

`ParsedTaskSource` collapses to the single-member shape
`Readonly<{version: 4; v4: TaskSourceV4Document}>`. Every consumer that
branches on `parsed.version === 4` simplifies; the branches are enumerated
in §3.2.7.

#### 3.2.3 What `src/tasks/source-v3.ts` keeps, and what it loses

The file **shrinks in place** — it is not renamed (§0, R-R1). Its surviving
purpose is stated in a rewritten header: *the prepare seam's document
vocabulary plus the workflow-side trigger classifier; the v3 grammar that
named it lives on only in the frozen migrator.*

| Export | Disposition |
|---|---|
| `parseTaskV3Yaml`, `parseTaskV3Document` | **DELETE** — vendored into the migrator |
| `classifyTaskV3Uses` | **DELETE** — vendored into the migrator (with its A1-deleted locator grammar restored there) |
| `taskV2UnsupportedError`, `TASK_V2_MIGRATION_HINT` | **DELETE** — B-15's rejection is raised by the router with the B-14 hint |
| `TASK_V3_SCHEMA_VERSION` | **DELETE** — `projectTaskSourceV4` stops asserting `version: 3` (see §3.2.7) |
| the module-private parse helpers `parseAkm`, `parseOn`, `compileTriggers`'s v3-document arms, `parseTaskV3TriggerFields`, `nullableSelector`, the `AKM_KEYS`/`ON_KEYS`/`TOP_LEVEL_KEYS` tables | **DELETE**, except the parts `classifyTaskV3Triggers` needs (below) |
| `classifyTaskV3Triggers`, `ClassifyTaskV3TriggersOptions`, `TaskV3TriggerPlan`, `TaskV3ScheduleBinding` | **KEEP and RE-HOME** (P4-N3) into `src/workflows/source-ir/triggers.ts`, renamed `classifyWorkflowYamlTriggers` / `WorkflowYamlTriggerPlan` / `WorkflowYamlScheduleBinding`. `compile.ts` imports the new name; `github-yaml.ts`'s drift-guard message becomes `The workflow trigger parser disagrees with the canonical workflow YAML trigger classifier.` After this, **`src/workflows/**` imports nothing at all from `src/tasks/**` source modules** — §5.2's seam assertion tightens to the empty list for all three files. |
| `taskV3SourceErrorDetail` | **KEEP**, renamed `taskSourceErrorDetail`; consumers are `scheduler-sync.ts`, `akm-lint.ts`, `akm-task-adapter.ts` |
| `TASK_EXTENSION`, `TASK_NEAR_MISS_EXTENSION`, `taskExtensionDetail` | **KEEP** unchanged |
| `TASK_V3_HOST_SHELLS`, `TaskV3HostShell` | **KEEP** — task source v4 imports both |
| `TaskV3SourceDocument`, `TaskV3Target`, `TaskV3UsesTarget`, `TaskV3Environment`, `TaskV3AkmOptions` | **KEEP** — the prepare seam's shape (P4-N4) |
| the re-export block (`assertBoundedTaskYamlDocument`, `TASK_V3_MAX_*`, `yamlAstError`, `yamlProblem`) | **KEEP** only the names a surviving `src` consumer still imports; delete the rest. `TASK_V3_MAX_SCHEDULES` and `TASK_V3_MAX_SOURCE_BYTES` are the known survivors. |

#### 3.2.4 The migrator's vendored parser (P4-N1)

New file `scripts/akm-migrate/migrate/task-source-v3-frozen.ts`, MPL-2.0
header, module header stating the frozen-migrator principle:

> This is the frozen task-v3 reader. `src/` no longer accepts task v3; this
> copy exists so the migrator can still READ what it converts. It is frozen:
> it is never extended, and a change to task source v4 never propagates
> here. It deliberately duplicates code that used to live in
> `src/tasks/source-v3.ts`.

Contents, moved **body-intact** from `src/tasks/source-v3.ts` at the commit-2
parent (i.e. **including** the GitHub locator grammar A1 deleted):
`parseTaskV3Yaml`, `parseTaskV3Document`, `classifyTaskV3Uses`,
`classifyTaskV3Triggers`'s v3-document arm, the private parse helpers, the
`TaskV3*` types the migrator names, and the bounded-document front end it
needs (it may keep importing `src/tasks/source/bounded-document.ts` and
`src/core/**` — the frozen-migrator rule forbids **`src` importing
`scripts`**, not the reverse).

The three migrator modules re-point their imports:
`task-files-to-v3.ts`, `task-to-v3.ts`, `task-to-v4.ts`.

**Binding constraint:** `rg -n 'from "\.\./\.\./scripts|from "\.\./scripts|scripts/akm-migrate' src/` returns zero hits, before and after.

#### 3.2.5 Wiring the v3 → task source v4 generation into `akm migrate`

Today `akm migrate status|apply` runs the v2 → v3 generation only; the
v3 → v4 generation is reachable only as `akm-migrate task-v4-status` /
`task-v4-apply`. B-14's hint would therefore name a command that does not do
the conversion. A2 fixes that (rows B-31, B-32):

- `src/commands/migrate-cli.ts` — `status` calls both inspectors and prints
  one combined plan; `apply [--dry-run]` runs the v2→v3 generation to
  convergence and then the v3→v4 generation against the resulting tree.
  **No new subcommand is added**, so `tests/contracts/command-cli-contract.test.ts`'s
  verb set is unchanged; the two `meta.description` strings do change and any
  contract pin on them is co-updated in this commit.
- Each generation keeps its own `withConfigLock` + `O_EXCL` backup root +
  prevalidate + TOCTOU recheck + atomic replace + reverse rollback +
  convergence check. **Do not interleave them.** A blocked file in
  generation 1 does not stop generation 2 from running on the files that are
  already v3.
- `scripts/akm-migrate/help.txt` and `src/commands/migrate-cli.ts`'s
  descriptions are updated to say "task-v2 and task-v3 sources to task
  source v4".

#### 3.2.6 Shipped assets, authoring, and setup

- **`src/assets/tasks/**` (10 files, row B-24)** — convert every one to
  `version: 4`: `akm.schedule` → top-level `schedule:` string shorthand,
  `akm.description` → top-level `description:`, `akm.enabled: true` → drop
  (v4 bindings default to enabled), `akm.enabled: false` → `schedule: [{cron: …, enabled: false}]`.
  Cron strings, targets and enablement are preserved byte-for-byte in
  meaning. A conversion that changes any cron is a review-blocking violation.
- **`src/commands/tasks/tasks.ts` → `renderTaskYaml`** — emit `version: 4`
  (row B-20). `--params` renders `inputs:` declarations with `default:`
  values, typed from each JSON value's runtime type
  (`string`/`number`/`boolean`/`object`/`array`); it must **not** emit
  `with:` on a non-`akm/command` target. `--prompt` keeps rendering
  `uses: akm/command` with `with: {content}` (still legal in v4).
- **`src/commands/tasks/tasks.ts` → `setEnabledInYaml`** and
  **`src/setup/steps/tasks.ts` → `setTaskV3EnabledInYaml`** — retarget both
  at `schedule[].enabled` (rows B-21, B-23). Keep them as YAML-text splices;
  do not introduce a round-trip re-serializer.
- **`src/setup/steps/tasks.ts`** — replace both `parseTaskV3Yaml` calls with
  `parseTaskSource` and read the v4 document (row B-23).
- **`src/tasks/embedded.ts`** — replace `parseTaskV3Yaml` with
  `parseTaskSource`.

#### 3.2.7 Shim deletions and dead-branch collapses

| Site | Action |
|---|---|
| `src/tasks/runtime-v3.ts` | **DELETE the file** (row B-25). Zero `src` importers today; four test importers re-point at `src/tasks/prepare/prepare` + `prepare/prepared-execution`. §5.2's structural assertion flips from "no `src` file imports it" to "the file does not exist". |
| `src/tasks/runner.ts` | **DELETE the file** (row B-26). Re-point `src/commands/tasks/tasks.ts` (its one production importer) and six test files at `run/run-task`, `run/task-history`, `run/task-result`, `run/attempt-lifecycle`, `run/task-log`, `run/run-workflow-task`. |
| `src/workflows/ir/source-freeze-v4.ts` | **DELETE the file** (row B-27). `src/workflows/ir/freeze-v4.ts` imports `resolveWorkflowSourceV4` from `../freeze/source-freeze` directly. |
| `src/tasks/source/parse-v3-adapter.ts` | **DELETE the file** — `taskDefinitionFromV3` is the v3 → internal-model transition adapter D11 scoped to "a transition period"; the period ends here. It has **zero** production importers today. |
| `src/tasks/model/definition.ts`, `src/tasks/model/schedule.ts` | **DELETE** — after the adapter goes, both have zero importers. Record the supersession of P1b §9's structure criterion in the Review log, exactly as P2a superseded P1b's "`source-v3.ts` unmodified" criterion. `src/tasks/model/invocation.ts` **STAYS** (`TaskInvocation`, `ExecutionProvenanceContext` — six live importers). |
| `src/core/errors.ts` → `TASK_TARGET_UNSUPPORTED` | **KEEP the code**; §5.2 gives it a live consumer (`prepare/script-capture.ts`'s interpreter rejections). Its hint is B-54. |
| `src/tasks/run/run-task.ts` → `shouldSkipUnactivatedTask` | **DELETE** the call and the helper (rows B-22, P4-N6), plus `prepare-support.ts`'s `enabled: document.akm?.enabled !== false` derivation and the `enabled` field on the prepared task if nothing else reads it. Prove with a grep in the commit body. |
| `src/tasks/scheduler-sync.ts` | Collapse `enabled: parsed.version === 4 ? true : parsed.v3.akm?.enabled !== false` to `enabled: true`, and every other `parsed.version === 4` branch to its v4 arm |
| `src/tasks/run/load-task.ts` | Collapse the `inputContract` ternary and the `deliverySource` guard's `parsed.version === 4 &&` conjunct |
| `src/tasks/source/project-v4.ts` | Drop the `version: TASK_V3_SCHEMA_VERSION` field's dependence on the deleted constant — emit the literal the prepare seam's discriminant requires and say so in one line (P2a §3.5's recorded wart is resolved by this note, not by a type rename) |
| `src/workflows/freeze/targets/task.ts` → `taskDispatch` | Collapse the `authoredInputs` ternary to `{kind: "bindings", value: bindings}` (row B-30). `AuthoredChildInputs`'s `{kind:"with"}` member **STAYS** — `resolve-steps.ts`'s direct-composition path still produces it. |
| `src/tasks/prepare/prepare.ts` → the `with`-on-command and `with`-on-script guards | **KEEP** (P4-N4), reworded to drop the `Task v3` prefix, each gaining ONE line: `// Unreachable from any parsed source: task source v4 accepts with: only on uses: akm/command. Kept as a seam invariant — this function takes a structurally-typed document.` |
| `src/tasks/prepare/prepare.ts` → the workflow-target `env` guard | **KEEP** and reword — it stays reachable (task source v4 has a top-level `env:`) |

#### 3.2.8 The second scheduling syntax

There is no separate deletion step. `akm.schedule` and a task document's
top-level `on:` are grammar constructs of the v3 parser; they die with
§3.2.3's parser deletion. What A2 must **prove** in the commit body:

```
rg -n 'akm\.schedule|"akm"\s*,\s*"schedule"|ON_KEYS|workflow_dispatch' src/tasks/
```

returns only task-source-v4 code paths and comments naming the retired
syntax historically. The one canonical form is task source v4's top-level
`schedule:` (D2).

### 3.3 Family A3 — multi-job confinement (commit 4)

#### 3.3.1 Zero-consumer proof

```
rg -n 'canonicalTopologicalJobs|compareWorkflowSourceCodePoints|job-count-limit|missing-job-dependency|job-dependency-cycle|duplicate-job-dependency|exactly one source-IR job|Multi-job workflow cannot execute' src/
```

`compareWorkflowSourceCodePoints` has an unrelated consumer
(`src/commands/lint/index.ts` sorts names with it) — it **survives** and
moves to `src/workflows/source-ir/compare.ts` when `ordering.ts` is deleted.

#### 3.3.2 The one rejection

`src/workflows/source-ir/github-yaml.ts` → `parseJobs` becomes the ONLY
place a job-count or job-dependency policy is enforced:

```
if (fields.size !== 1) reader.fail("multi-job-unsupported", <B-34/B-35 message>, node);
```
followed, after `parseJob`, by the single-job `needs` check (row B-37). The
256 bound, `canonicalTopologicalJobs`, and the three dependency failure
codes are deleted with the machinery.

#### 3.3.3 Deletions

| Site | Action |
|---|---|
| `src/workflows/source-ir/ordering.ts` | **DELETE the file**; move `compareWorkflowSourceCodePoints` to `src/workflows/source-ir/compare.ts` |
| `src/workflows/source-ir/github-yaml.ts` | Replace `parseJobs`' count bound + `canonicalTopologicalJobs` call + the three `WorkflowSourceFailure` throws with §3.3.2's two checks |
| `src/workflows/source-ir/schema.ts` | DELETE `validateTopologicalJobs`; change the `jobs` array validation to `exactly 1 entry` (row B-42); drop the `canonicalTopologicalJobs` import |
| `src/workflows/ir/compile.ts` | DELETE the `sourceIr.jobs.length !== 1` early return and its message (row B-43). `compileWorkflowPlan` reads `sourceIr.jobs[0]` with the decoder's guarantee behind it. |
| `src/workflows/freeze/source-freeze.ts` | DELETE the `compiled.ir.jobs.length !== 1` throw (row B-44); re-code the surviving `Workflow source cannot be frozen` wrapper per P4-N2 (row B-45) |
| `src/workflows/source-ir/schema.ts` → `WorkflowSourceJob.needs` | **KEEP** the field and its sorted-normalization — the grammar still accepts an empty `needs:` for GitHub-shape familiarity; a non-empty one is B-37 |

#### 3.3.4 The freeze wrapper's code mapping (P4-N2)

In `src/workflows/freeze/source-freeze.ts`:

- if `compiled.errors.length === 1 && compiled.errors[0].code === "multi-job-unsupported"` → `UsageError(…, "COMPOSITION_INVALID")`;
- otherwise → `UsageError(…, "WORKFLOW_SOURCE_INVALID")`.

The message text (`Workflow source cannot be frozen: <joined messages>`) is
byte-identical in both arms. The same mapping is applied at the other two
places a compile result becomes a `UsageError`
(`src/workflows/ir/freeze-v4.ts`, `src/tasks/prepare/prepare-support.ts`'s
projectability check) so a caller sees one code per failure family.

### 3.4 Dead-code sweep (after EACH family, before its commit)

A knip-style manual audit, run and **reported in the commit body**:

1. `bunx tsc --noEmit` — no unused-import or unreachable-code errors.
2. `bun run lint` — biome's `noUnusedVariables`/`noUnusedImports` clean on
   touched files.
3. For every symbol the family deleted, `rg` its name across
   `src/ tests/ scripts/ docs/ schemas/` and confirm the only surviving hits
   are (a) historical prose in `docs/`, (b) the migrator's vendored copy,
   (c) a §7-authorized pinned string in a test.
4. For every FILE the family deleted, `rg` its basename the same way.
5. Reverse direction — the half reviewers forget: for every module the
   family **edited**, list its exports and grep each for importers. Any
   export that lost its last importer is either deleted in the same commit
   or named in the commit body with the reason it stays.
6. `bun run check` green.

---

## 4. Lane B — vocabulary, ADRs, ledger, docs

### 4.1 `stash` / `prompt` vocabulary at task and workflow boundaries (commit 5)

This is mostly a **proof** task; P1b already did the renames. Required
outcome:

- `DEFAULT_BUNDLE_NAME` stays `"stash"` (row B-48) — it is the on-disk
  bundle name users have. Every other bare `"stash"` string literal inside
  `src/tasks/**`, `src/workflows/**`, `src/execution/**` and
  `src/commands/tasks/**` references the constant instead. Proof:
  `rg -n '"stash"' src/tasks/ src/workflows/ src/execution/ src/commands/tasks/`
  returns exactly the constant's own declaration.
- `RunTaskOptions` carries **no** legacy alias: `rg -n 'stashDir' src/tasks/ src/workflows/ src/commands/tasks/` returns zero hits (row B-49).
- `src/indexer/**` is untouched (row B-50). Say so in the commit body so a
  reviewer does not read the untouched hits as an oversight.
- `"prompt"` appears in `src/` only inside the D8 legacy read mapping in
  `src/tasks/run/task-history.ts` and in prose describing it (rows B-51,
  B-52). Proof: `rg -n '"prompt"' src/tasks/ src/workflows/`.
- `src/core/errors.ts`: hints B-53 and B-54; `SAFE_TASK_ATTEMPT_ERROR_CODES`
  gains the four codes of B-55 with the reachability comment P1b's §5.5
  established.
- `src/storage/repositories/workflow-runs-repository.ts`: add the
  one-line must-move-together invariant comment at BOTH
  `insertRun`'s column list and `publishChildWorkflowRun`'s hand-rolled
  INSERT (§8 R-R3), each naming the other and citing the ADR of §4.2.

### 4.2 Historical essays → ADRs (commit 6)

Create `docs/architecture/decisions/` with a `README.md` stating the format
(one file per decision, `NNNN-kebab-title.md`, front-matter-free, sections:
Context / Decision / Consequences / Provenance) and an index table.

**Scope is closed**: only files this refactor touched
(`git diff --name-only origin/release/0.9.2...HEAD -- 'src/**/*.ts'`). No
repo-wide sweep. A comment block moves only if it is **historical narrative**
— "peer review R1 found…", "an earlier draft…", "round 2 changed…", a
superseded alternative, or a phase-by-phase chronology. A comment that says
*why a hash includes a field*, *why mutation is delayed*, *why a transaction
boundary exists*, *why a source is revalidated*, *why a child invocation is
idempotent* **stays in the code** (§1.5).

Each moved essay leaves behind a one-line invariant comment plus a relative
link to its ADR.

Minimum ADR set (the essays measured at ≥ 25 lines in refactor-touched
files; the implementer may merge related ones and must list the final set in
the commit body):

| ADR | Source essay |
|---|---|
| `0001-no-interpolation-attached-structured-context.md` | `src/workflows/exec/native-executor.ts`'s module header (the data-flow / reference-scope / peer-review-R1 narrative) |
| `0002-unit-reuse-and-input-hash-scope.md` | `src/workflows/exec/step-work.ts`'s two long blocks |
| `0003-child-env-allowlist-and-provenance.md` | `src/workflows/exec/exec-unit.ts`'s four long blocks |
| `0004-task-input-contract-and-flag-coercion.md` | `src/execution/input-contract.ts`'s header |
| `0005-task-result-vocabulary-and-legacy-read-mapping.md` | `src/tasks/run/task-result.ts` + `src/tasks/run/task-history.ts` headers (the D8 narrative; the mapping's own one-line invariant stays) |
| `0006-task-source-version-routing.md` | `src/tasks/source/parse-task-source.ts`'s routing-table header (rewritten for the post-A2 single-version reality) |
| `0007-workflow-composition-bounds.md` | `src/workflows/resource-limits.ts`'s header |
| `0008-task-binding-normalization.md` | `src/workflows/freeze/task-bindings.ts`'s two blocks |
| `0009-child-run-publication-column-parity.md` | the R11 duplication note (§8 R-R3) — new content, not a move |
| `0010-driver-protocol-cut.md` | a stub pointing at `docs/architecture/specs/driver-protocol-keep-or-cut.md` (§4.5) so the index is complete |

**Binding:** no ADR may delete reasoning. The essay's text moves; it is not
summarized away. Where an essay describes behavior P4 itself deleted, the ADR
records the behavior AND its removal date.

### 4.3 The deletion audit's net-LOC checkpoint (commit 7)

`docs/plans/0.9.2-architecture-deletion-audit.md` → the **Size checkpoint**
section is rewritten with measured numbers. Required content:

- the branch-level figure from `git diff --shortstat origin/release/0.9.2...HEAD`
  at the head of commit 6, split three ways: `-- src/`, `-- tests/`,
  `-- docs/` (for the last measured state, `+8789/-2984` src,
  `+18358/-296` tests, `+10185/-70` docs, `241 files changed` overall);
- a **deletions this phase lands** table, one row per §3 family, each with
  the exact `git diff --shortstat <family-parent>..<family-commit> -- src/`
  numbers and the files deleted outright;
- the audit's own rule restated: *deletions must show*. If `src/` is still
  net-positive against `origin/release/0.9.2` — which it will be, because
  P2/P3 added child workflows, bindings and two new CLI verbs — the
  checkpoint says so explicitly and names the capabilities the additions
  bought, rather than implying a shrink that did not happen. **A
  hand-waved "significantly reduced" is a review-blocking violation.**
- the **Active audit** section's first bullet ("audit remaining source
  modules for old dispatchers or compatibility aliases") is closed out with
  the §3 sweeps as evidence, or restated with what remains.

### 4.4 `STABILITY.md` (commit 7)

- Fix the stale Tasks bullet (row B-57).
- Add `akm task explain` and `akm workflow plan` to the command tier index
  as **Evolving** (row B-58), and add a sentence to the Evolving section's
  Tasks bullet naming both as secret-free provenance surfaces.
- The `akm workflow *` group is **Stable**: confirm the index still reads
  Stable for `status`/`list`/`create`/`resume`/`abandon`/`run` and that
  `plan` is the only new row. P3b added fields, not breaking changes.
- Every `akm …` example in the file passes
  `bun scripts/lint-doc-examples.ts` (it is chained into `bun run lint`).

### 4.5 The driver-protocol decision record (commit 7)

`docs/architecture/specs/driver-protocol-keep-or-cut.md`:

- Status line → row B-56.
- New final section **"10. Decision and evidence (2026-08-27)"** recording:
  - the decision: **Option B — cut both verbs** — reached not by this
    document's own process but by the 0.9.2 reconstruction, which deleted the
    subject before the record was flipped; the record is therefore
    ratified after the fact and says so;
  - the three verification greps and their **zero** results, pasted:
    ```
    rg -n 'brief\.ts|report\.ts' src/workflows/exec/
    rg -n 'experimental\.workflowEngine|workflowEngine' src/
    rg -n 'workflow (brief|report)|--settle' src/commands/
    ```
  - cross-references to `workflow-engine-buy-vs-build.md` **§7
    (Recommendation)** — whose build verdict this decision completes — and
    to `docs/plans/0.9.2-architecture-deletion-audit.md`'s "Deleted
    architecture" table;
  - the §9 sequencing note's condition is marked satisfied: B landed
    **before** the task/workflow unification work, so `workflow_run_units`
    had one consumer throughout P3a's `irVersion` 5 + `hashVersion` 6 bump.
- `docs/plans/0.9.2-architecture-deletion-audit.md`'s "Deleted architecture"
  table gains a row: `External driver protocol (\`workflow brief\` / \`workflow report\` / \`--settle\`) | Removed; decision record RESOLVED (Option B)`.

### 4.6 `CHANGELOG.md` `[Unreleased]` (commit 8)

Four new **Breaking changes & migration** entries, each naming the observable
change, the code a script would branch on, and the remedy:

1. **Task v3 sources no longer parse.** `version: 3` (and `version: 2`)
   documents fail with `TASK_SCHEMA_VERSION_UNSUPPORTED` (exit 2) instead of
   executing. Run `akm migrate apply --dry-run`, review every `changed` /
   `skipped` / `blocked` result, then `akm migrate apply` — the command now
   runs the task-v2 → task-v3 and task-v3 → task-source-v4 generations in
   one pass. `akm task add` authors task source v4; a task's `--params`
   becomes typed `inputs:` with defaults; a task's enabled state is now per
   schedule binding (`schedule[].enabled`), and the document-level
   `akm.enabled` skip is gone.
2. **GitHub Action locators are no longer recognized anywhere.** A task's
   `uses: owner/repo[/path]@rev` is a source error at parse; a workflow
   step's is `unsupported-uses-target` instead of
   `remote-action-acquisition-out-of-scope`. Nothing acquired or executed a
   remote action in any release — this deletes the recognition, not a
   capability. The migrator still names the target explicitly when it
   blocks a file (`github-action-target-removed`).
3. **Multi-job YAML is rejected at the adapter boundary.** A document whose
   `jobs:` map does not contain exactly one job fails at
   `compileGithubWorkflowSource` with `multi-job-unsupported`, surfaced from
   `akm workflow run` as `COMPOSITION_INVALID` (exit 2). Previously a
   multi-job document parsed and ordered cleanly and was refused later, in
   two different places, with two different shapes (one throw, one
   `ok: false`). Split multi-job documents into separate workflows and
   compose them with a child-workflow step. Every other workflow-source
   compile failure now reports `WORKFLOW_SOURCE_INVALID` rather than
   `INVALID_FLAG_VALUE`.
4. **The second task scheduling syntax is removed.** `akm.schedule` and a
   task document's top-level `on:` are gone with task v3; task source v4's
   optional top-level `schedule:` is the one canonical form, and a task with
   no `schedule:` is manual-only and fully composable.

Plus a **Changed** entry for the diagnostics: `INVALID_FLAG_VALUE` no longer
appears in task or workflow domain failures — scripts branch on
`TASK_SOURCE_INVALID`, `TARGET_REF_INVALID`, `COMPOSITION_INVALID`,
`WORKFLOW_SOURCE_INVALID`, `INPUT_BINDING_INVALID`,
`TASK_SCHEMA_VERSION_UNSUPPORTED` or `TASK_TARGET_UNSUPPORTED`. Exit codes
are unchanged.

### 4.7 Migration guide and release notes (commit 8) — the upgrader's first read

Both files ship in the npm tarball. They must be **complete and correct for
the whole refactor**, not incremental fragments. Reconcile against
everything P0–P4 landed.

**`docs/migration/v0.9.1-to-v0.9.2.md`** — restructure so the reader meets
the breaks in the order they will hit them:

1. *Before you upgrade* — `akm workflow list --active`; finish or abandon
   in-flight runs (pre-`irVersion`-5 plans are complete-or-abandon).
2. *Task sources* — the existing "Before: 0.9.1 task v2 / After: 0.9.2 task
   v3" sections are **stale and must be rewritten**: the destination is task
   source v4. Show a v2, a v3 and the v4 result side by side; show the
   `akm:` bag hoisting (`akm.schedule` → `schedule:`, `akm.maxSteps` /
   `akm.maxRetries` → top-level), `on.workflow_dispatch` dropping with a
   notice, optional `schedule:`, typed `inputs:` with defaults and
   `required:`, the single bounded `output:` schema, and the removed
   `github-action` target.
3. *The migration procedure* — preview, review `changed`/`skipped`/`blocked`,
   apply; both generations; the blocked reasons the v3→v4 migrator can emit
   (`github-action-target-removed`, `with-on-non-command-target`,
   `ambiguous-scheduling-source`, `enabled-false-without-schedule`,
   `read-only-source`, `invalid-v3-task`) and what to do about each.
4. *Workflow cutover* — keep the existing `irVersion` 5 section; add the
   **multi-job** break and the **GitHub locator** break with before/after
   error text.
5. *`with:` on a task-composed step* — keep and extend: it binds when the
   target declares `inputs:`, rejects with `COMPOSITION_INVALID` when it
   does not, and is rejected outright on `commands/` and `scripts/` steps.
6. *Child workflows* — new: both authoring forms (direct
   `uses: workflows/<ref>` and task-wrapped), the parent/child status tree,
   independent resume, cancellation propagation, the composition bounds
   (depth, cycle, aggregate embedded-plan bytes) and their
   `COMPOSITION_INVALID` failures.
7. *Workflow `outputs:`* — new: declaring them, and how a composing parent
   step promotes a child's outputs.
8. *New commands* — `akm task explain <ref>` and `akm workflow plan <ref> --json`,
   both secret-free, with one example each.
9. *Diagnostics* — the code table of §4.6's Changed entry.
10. *Validate the upgrade* — keep and extend the existing checklist.

**`docs/migration/release-notes/0.9.2.md`** — the short-form notes are
**badly stale**: they still say "Task sources now use Task v3" and describe
plan v4 as the executable format. Rewrite so every paragraph is true at
0.9.2 release: task source v4 (with the migrator), plan `irVersion` 5 and
the complete-or-abandon policy, child workflows, workflow `outputs:`, `with:`
bindings, the three deletions, the two new verbs, and the diagnostics table
— each in one short paragraph, each linking to the long-form guide's anchor.
Keep the state-DB paragraphs unchanged.

**Every `akm …` example in both files must pass
`bun scripts/lint-doc-examples.ts`.**

### 4.8 Where Lane B may and may not edit code

Lane B touches `src/` only for: the vocabulary constants and hints of §4.1,
the two repository comments of §4.1, and the **comment-only** essay
extractions of §4.2. **No logic change, no signature change, no control-flow
change.** A Lane B commit whose `git diff` shows a changed statement outside
those named sites is a review-blocking violation. Essays living in files
Lane A owns (§6) are extracted by **Lane A**, in that file's own family
commit.

---

## 5. Lane C — floors, ratchets, CI paths, and the P0 close-out (commit 9)

Lane C runs **after** Lane A and Lane B (§0.2). Every number it writes is a
measurement of the tree at its own parent commit, taken from raw command
output pasted into the commit body.

### 5.1 `tests/contracts/ci-test-paths.test.ts`

Green with no edit if §3's deletions renamed or removed no CI-named suite.
The suites named in `.github/workflows/*.yml` today are
`tests/integration/semantic-search-e2e.test.ts`,
`tests/integration/docker-install.test.ts`,
`tests/integration/linux-standalone-scheduler.test.ts`,
`tests/integration/native-scheduler.test.ts`,
`tests/integration/workflow-release.test.ts` — none is on §7's delete list,
so the expected outcome is **no change**. Lane C's duty is to *verify* that
and say so; if any §7 deletion did rename a CI-named suite, the workflow
YAML is edited **in the same commit** as the rename, not here.

### 5.2 The `INVALID_FLAG_VALUE` ratchet → terminal

**Classification rule (binding).** An `INVALID_FLAG_VALUE` occurrence inside
`src/tasks/**` or `src/workflows/**` may remain if and only if it is:

(a) the rejection of a **scalar value a user typed** as a CLI flag or
positional argument, or an argv-projected scheduler binding value — a task
id, a cron expression, a workflow parameter flag, a workflow-ref filter; or
(b) a **membership entry** in a code allowlist (not a throw).

Everything else re-codes to the D7 code naming its failure family.

**Target table** (the implementer MEASURES and records deviations):

| File | Count today | Disposition |
|---|---|---|
| `src/tasks/schedule.ts` | 12 | **KEEP** — cron-expression parsing and per-backend expressibility of the user's cron scalar (rule a) |
| `src/tasks/scheduler-binding.ts` | 10 | **KEEP** — argv/expectation scalar validation (rule a) |
| `src/tasks/task-id.ts` | 7 | **KEEP** — the `<id>` argument (rule a) |
| `src/workflows/ir/params.ts` | 2 | **KEEP** — `Workflow parameter "--<name>" …` (rule a) |
| `src/workflows/runtime/runs.ts` | 2 | **KEEP** — workflow-ref **filter** flags (rule a) |
| `src/tasks/run/attempt-lifecycle.ts` | 1 | **KEEP** — `SAFE_TASK_ATTEMPT_ERROR_CODES` membership (rule b) |
| `src/tasks/source-v3.ts` | 5 | **GONE** — all inside `classifyTaskV3Uses` (§3.1, §3.2) |
| `src/tasks/prepare/prepare.ts` | 4 | 1 GONE (§3.1); 3 → `COMPOSITION_INVALID` |
| `src/tasks/prepare/prepare-support.ts` | 4 | secret-shaped env + timeout → `TASK_SOURCE_INVALID`; both projectability failures → `WORKFLOW_SOURCE_INVALID` |
| `src/tasks/prepare/script-capture.ts` | 3 | interpreter + Bun-required → `TASK_TARGET_UNSUPPORTED`; cwd-unverifiable → `TASK_SOURCE_INVALID` |
| `src/tasks/source/bounded-document.ts` | 1 | → `TASK_SOURCE_INVALID` (closes P1a's recorded "seven direct throws stay `INVALID_FLAG_VALUE`" gap) |
| `src/tasks/scheduler-sync.ts` | 3 | source-set rejection → `TASK_SOURCE_INVALID`; the two compile/plan failures → `WORKFLOW_SOURCE_INVALID` |
| `src/workflows/source-files.ts` | 5 | → `WORKFLOW_SOURCE_INVALID` (the `PATH_ESCAPE_VIOLATION` ternary keeps its other arm) |
| `src/workflows/runtime/workflow-asset-loader.ts` | 4 | ref-shape rejections → `TARGET_REF_INVALID`; adapter-unsupported → `WORKFLOW_SOURCE_INVALID` |
| `src/workflows/ir/environment-v4.ts` | 3 | → `WORKFLOW_SOURCE_INVALID` |
| `src/workflows/freeze/environment.ts` | 3 | → `WORKFLOW_SOURCE_INVALID` |
| `src/workflows/ir/freeze-v4.ts` | 2 | → `WORKFLOW_SOURCE_INVALID` (P4-N2's mapping applies to the compile-failure one) |
| `src/workflows/freeze/source-freeze.ts` | 2 | 1 GONE (§3.3); 1 → P4-N2's two-arm mapping |
| `src/workflows/freeze/resolve-steps.ts` | 1 | → `WORKFLOW_SOURCE_INVALID` |
| `src/workflows/freeze/identity.ts` | 1 | → `WORKFLOW_SOURCE_INVALID` |

Predicted terminal count: **34** (`12+10+7+2+2+1`). Measure with
`grep -rn "INVALID_FLAG_VALUE" src/tasks/ src/workflows/ | wc -l`, hardcode
the real number, and rewrite the ratchet's header comment: the baseline is
**terminal**, the survivors are enumerated by the table above, and **any**
increase — not merely an increase past a shrinking bar — is a defect.

Every re-code needs its CLI-envelope coverage: extend
`tests/integration/cli-errors.test.ts`'s table so each newly-reachable code
is asserted as `{ok:false,error,code}` on stderr with exit 2 (P1a's carried
advisory).

### 5.3 Test floors

1. Run `bun run test:unit` and `bun run test:integration` at Lane C's parent
   commit; read `pass` and `skip` from raw output.
2. Compute the new floors per P4-N5.
3. Edit `MIN_TESTS="${AKM_MIN_UNIT_TESTS:-…}"` and
   `MIN_TESTS="${AKM_MIN_INTEGRATION_TESTS:-…}"`.
4. **Commit body must carry**, and a reviewer must be able to check:
   - before/after executed counts for both suites;
   - before/after floor values;
   - a per-suite table of every test file §7 deleted, with its test count and
     the deletion family that authorized it;
   - the arithmetic showing the new floor.

   The last measured counts before P4 were unit **4284 pass / 0 skip** and
   integration **5760 pass / 57 skip** (P3a close-out), with floors 3500 and
   5000; P3b adds to both. On those numbers the floors **rise**, they do not
   fall — an unexplained *fall* is review-blocking, and so is leaving a floor
   thousands of tests below reality.

### 5.4 The v3-fixture inventory ratchet

`tests/architecture/task-fixture-vocabulary.test.ts` → row B-61. Every entry
removed from `ALLOWED_EXACT_FILES` must correspond to a file §7 either
converted to task source v4 or deleted. The file's header comment is
rewritten: the sweep is over, and the allowed set is now the frozen
migrator's own surface, permanently.

### 5.5 The P0 Review log's final entry

Append ONE dated entry to `docs/plans/specs/p0-invariants.md`'s Review log
(prose only — **do not edit any pinned row's text**) listing the final
disposition of every R row and of the P rows P4 supersedes:

| Row | Final disposition |
|---|---|
| **R-01** | RESOLVED — P1a rejected the silent `with:` drop (`COMPOSITION_INVALID`); P2b replaced the rejection with real bindings when the target declares `inputs:`. |
| **R-02** | RESOLVED — P1b's `prepareScriptTarget()` deleted the synthetic task YAML; no `src` file fabricates a task-source header (`tests/workflows/direct-script-typed.test.ts`'s source scan). |
| **R-03** | RESOLVED — P3a replaced all three nested-workflow rejections with the ONE recursive child-workflow resolver; the documented-dead duplicate went with them. |
| **R-04** | RESOLVED by deletion — P4 §3.1. The grammar, both consumers and the `remote-action-acquisition-out-of-scope` code are gone from `src`; the frozen migrator keeps a copy so it can still name the target when it blocks a file. |
| **R-05** | RESOLVED by deletion — P4 §3.3. Parse-then-reject becomes one adapter-boundary rejection; the return-vs-throw asymmetry the row pinned no longer exists. |
| **R-06** | RESOLVED by deletion — P2a made scheduling optional for task source v4; P4 §3.2 removed v3 acceptance, so the exactly-one-scheduling-source rule has no document left to apply to. |
| **R-07** | RESOLVED — P1b threaded `ExecutionProvenanceContext`; the prompt/command arm records `"task"`. |
| **R-08** | RESOLVED — P1b's D8 vocabulary + read-boundary mapping. The mapping itself is a PRESERVE surface forever (row B-51). |
| **R-09** | RESOLVED at the boundary — P1b renamed `stashDir` → `bundleDir`; P4 §4.1 consolidated the stray literals onto `DEFAULT_BUNDLE_NAME`, whose VALUE stays `"stash"` for user-data compatibility. `src/indexer/**` was out of scope from P0 onward. |
| **P-01 / P-02** | SUPERSEDED by P4 §3.2 — unreachable from any parseable source (task source v4 accepts `with:` only on `uses: akm/command`). The seam guards are retained as invariants (P4-N4); the pinned tests are deleted with floor accounting. |
| **P-03** | SUPERSEDED by P4 §3.2 — a task document can no longer author `with:` on a workflow target; `prepared.params` is the task's defaulted declared inputs, or `{}`. |
| **P-04** | PRESERVED, re-fixtured — task source v4 still has a top-level `env:`, so the workflow-target env rejection stays reachable and stays pinned. |
| **P-05 / P-06 / P-07** | PRESERVED (P-05 reclassified by P1b's D5 — see the 2026-08-26 entries). |
| **P-08** | SUPERSEDED by P4 §3.3 — the multi-job parser's job model was pinned as the thing the P4 adapter boundary would be built on; the boundary was built by **deleting** it instead, per brief §10. Job-count bounds, `needs` validation, cycle/duplicate detection and canonical ordering are all unreachable with exactly one job. |

---

## 6. Per-lane file lists (DISJOINT)

A lane writes **only** its own list. Any file not on a list is untouched by
P4. Reading anything is always allowed.

### Lane A (commits 2–4)

```
src/tasks/source-v3.ts
src/tasks/source/parse-task-source.ts
src/tasks/source/project-v4.ts
src/tasks/source/task-source-v4.ts          (comments + import updates only)
src/tasks/source/bounded-document.ts
src/tasks/source/parse-v3-adapter.ts        (DELETE)
src/tasks/model/definition.ts               (DELETE)
src/tasks/model/schedule.ts                 (DELETE)
src/tasks/prepare/prepare.ts
src/tasks/prepare/prepare-support.ts
src/tasks/prepare/script-capture.ts
src/tasks/prepare/prepared-execution.ts
src/tasks/runtime-v3.ts                     (DELETE)
src/tasks/runner.ts                         (DELETE)
src/tasks/run/run-task.ts
src/tasks/run/load-task.ts
src/tasks/embedded.ts
src/tasks/scheduler-sync.ts
src/workflows/source-ir/semantics.ts
src/workflows/source-ir/uses.ts
src/workflows/source-ir/compile.ts
src/workflows/source-ir/github-yaml.ts
src/workflows/source-ir/schema.ts
src/workflows/source-ir/ordering.ts          (DELETE)
src/workflows/source-ir/compare.ts           (NEW)
src/workflows/source-ir/triggers.ts          (NEW)
src/workflows/ir/compile.ts
src/workflows/ir/freeze-v4.ts
src/workflows/ir/source-freeze-v4.ts         (DELETE)
src/workflows/freeze/source-freeze.ts
src/workflows/freeze/targets/task.ts
src/commands/lint/index.ts
src/commands/tasks/tasks.ts
src/commands/migrate-cli.ts
src/core/adapter/adapters/akm-lint.ts
src/core/adapter/adapters/akm-task-adapter.ts
src/core/adapter/adapters/akm-metadata.ts
src/setup/steps/tasks.ts
src/assets/tasks/**                          (10 files)
schemas/akm-task.json
scripts/akm-migrate/**
tests/**                                     (only the files §7 names for Lane A)
```

### Lane B (commits 5–8)

```
src/core/errors.ts
src/tasks/run/task-history.ts                (comment only)
src/tasks/run/task-result.ts                 (comment only)
src/tasks/run/attempt-lifecycle.ts           (SAFE_TASK_ATTEMPT_ERROR_CODES + comment)
src/execution/input-contract.ts              (comment only)
src/workflows/exec/native-executor.ts        (comment only)
src/workflows/exec/step-work.ts              (comment only)
src/workflows/exec/exec-unit.ts              (comment only)
src/workflows/exec/run-workflow.ts           (comment only)
src/workflows/resource-limits.ts             (comment only)
src/workflows/freeze/task-bindings.ts        (comment only)
src/storage/repositories/workflow-runs-repository.ts   (comment only)
docs/architecture/decisions/**               (NEW)
docs/architecture/specs/driver-protocol-keep-or-cut.md
docs/plans/0.9.2-architecture-deletion-audit.md
docs/migration/v0.9.1-to-v0.9.2.md
docs/migration/release-notes/0.9.2.md
docs/reference/tasks.md
docs/reference/workflow-schema.md
docs/reference/workflows.md
STABILITY.md
CHANGELOG.md
```

> `src/tasks/run/attempt-lifecycle.ts` is Lane B's only code edit outside a
> comment; Lane A does not touch it. `src/tasks/run/task-result.ts` and
> `task-history.ts` are Lane B (comments); `run-task.ts` and `load-task.ts`
> are Lane A (dead-branch collapses). `src/tasks/source/task-source-v4.ts`'s
> comments are Lane A's because §3.1/§3.2 also change its imports.

### Lane C (commit 9)

```
scripts/test-unit.sh
scripts/test-integration.sh
tests/architecture/diagnostic-codes.test.ts
tests/architecture/task-fixture-vocabulary.test.ts
tests/contracts/ci-test-paths.test.ts
tests/integration/cli-errors.test.ts
.github/workflows/*.yml                      (only if a §7 rename requires it)
docs/plans/specs/p0-invariants.md            (Review log append ONLY)
```

### Lane D (commit 10)

```
docs/plans/specs/p4-deletions-closeout.md    (§10 report + Review log)
```

---

## 7. AUTHORIZED-FLIPS table

Every pre-existing test whose expectations change, whose fixtures convert,
or which is deleted. **An edit to any pre-existing test not listed here is a
review-blocking violation.** Rows are grouped by the commit that owns them.
Each row is `FLIP` (assertions change), `CONVERT` (fixtures move to task
source v4, assertions unchanged), `DELETE` (with floor accounting in §5.3),
or `KEEP` (listed because a reviewer would reasonably expect it to move).

### 7.1 Commit 2 — GitHub locator grammar

| # | File | Site | Action |
|---|---|---|---|
| **F-A1.1** | `tests/tasks/source-v3.test.ts` | the `classifyTaskV3Uses` accept table's `actions/checkout@v4` and `owner/repo/sub/dir@v1` rows | **FLIP** to rejections; the file is DELETED in commit 3 (F-A2.1) but must be green in commit 2 |
| **F-A1.2** | `tests/tasks/source-v3.test.ts` | the reject list's locator near-misses (`owner/repo@refs/heads/../main`, `owner/repo@feature..main`, `owner/repo@refs/.hidden/main`, `owner/repo@refs/heads/main.`, `owner/repo@main.lock`, ` owner/repo@v1`, `owner/repo@v1 `, `owner/repo@@v1`) | **KEEP** — still rejected, by the generic path |
| **F-A1.3** | `tests/workflows/characterization-classification.test.ts` | R-04(a) accept test | **FLIP** to a rejection asserting the B-03 message |
| **F-A1.4** | `tests/workflows/characterization-classification.test.ts` | R-04(a) near-miss test (`owner/repo`) | **FLIP** — the pinned trailing message becomes B-03 |
| **F-A1.5** | `tests/workflows/characterization-classification.test.ts` | R-04(b) prepare-rejection test | **DELETE** — no document can reach prepare with such a target |
| **F-A1.6** | `tests/workflows/characterization-classification.test.ts` | R-04(c) workflow-step test | **FLIP** to code `unsupported-uses-target` |
| **F-A1.7** | `tests/execution/target-ref.test.ts` | the rejection table's `actions/checkout@v4` row and the ten locator-parity rows P1a's close-out pinned (`owner/.github@v1`, `owner/_repo@v1`, `owner/-repo@v1`, `owner/repo@v1.0+meta`, `owner/repo@%40`, `owner/repo/../x@v1`, `owner/repo/.@v1`, `o.wner/repo@v1`, `own_er/repo@v1`, the >39-char owner) | **FLIP** — every one becomes `unsupported-uses-target`; delete the A-1 accepted-deviation comment block, which the deletion retires |
| **F-A1.8** | `tests/execution/target-ref.test.ts` | `actions/checkout@bad:ref` → `unsupported-uses-target` | **KEEP** — already the new answer |
| **F-A1.9** | `tests/workflows/source-ir-contract.test.ts` | the parity table's `actions/checkout@v4` row | **FLIP** to `unsupported-uses-target`. P1a §4.5 declared this file "must stay green UNCHANGED"; P4 supersedes that for exactly this one row and the header comment that states it. |
| **F-A1.10** | `tests/workflows/source-ir-contract.test.ts` | the decoded-step case that swaps in `uses: actions/checkout@v4` | **KEEP if it asserts only rejection; FLIP if it asserts the code** — verify and record |
| **F-A1.11** | `tests/integration/tasks-schema.test.ts` | the `githubActionRef` pattern probes and the accept row | **DELETE** those probes |
| **F-A1.12** | `tests/integration/tasks-schema.test.ts` | "published task schema's v4 arm removes the github-action uses: target while the v3 arm keeps it (B-13)" | **FLIP** in commit 2 to "no arm accepts a github-action uses: shape"; **DELETE** the v3 half in commit 3 |
| **F-A1.13** | `tests/fixtures/execution-contracts/workflows/manifest.json` | `rejected[].unsupported-remote-action.reasonCode` | **FLIP** to `unsupported-uses-target`. The fixture FILE stays — it is still a rejected fixture. |
| **F-A1.14** | `tests/integration/tasks-runtime-v3-runner.test.ts` | the `["remote action", …]` row | **FLIP** in commit 2 (new reason), then **CONVERT** with the file in commit 3 |
| **F-A1.15** | `tests/integration/tasks-scheduler-sync-v3.test.ts` | the `["remote action", "actions/checkout@v4", …]` row | **FLIP** in commit 2; the file is DELETED in commit 3 (F-A2.6) |
| **F-A1.16** | `tests/tasks-runtime-v3.test.ts` | the locator prepare case | **DELETE** (the file goes in commit 3, F-A2.2) |
| **F-A1.17** | `tests/tasks/source-v4.test.ts` | the B-13 "GitHub Action targets were removed in task source v4" message test | **KEEP** — row B-11; only the surrounding comment naming `classifyTaskV3Uses` updates |
| **F-A1.18** | `tests/migrate/task-v3-to-v4.test.ts` | `github-action-target-removed` coverage and the `blocked/github-action.yml` fixture | **KEEP — preservation gate.** The migrator's vendored grammar must keep this green (P4-N1). |
| **F-A1.19** | `tests/integration/workflows/immutable-resolution-v4-red.test.ts`, `tests/integration/scan/drain-broken-workflow.test.ts`, `tests/core/adapter/akm-workflow-yaml-adapter.test.ts`, `tests/integration/tasks-scheduler-durable-v4-red.test.ts`, `tests/integration/lint-workflow-yaml-peer.test.ts` | fixtures using `uses: actions/checkout@v4` as "an invalid workflow" | **KEEP** — the document is still invalid. Verify each; any that asserts the old code or message **FLIPs** and is added to this table by the implementer, with the addition recorded in the Review log. |

### 7.2 Commit 3 — task source v3 acceptance

| # | File | Action |
|---|---|---|
| **F-A2.1** | `tests/tasks/source-v3.test.ts` | **DELETE** — its subject is the deleted parser. The `classifyTaskV3Triggers` cases MOVE to a new `tests/workflows/source-ir-triggers.test.ts` covering the re-homed `classifyWorkflowYamlTriggers` (§3.2.3). |
| **F-A2.2** | `tests/tasks-runtime-v3.test.ts` | **DELETE** — its subject is the deleted shim (row B-25) |
| **F-A2.3** | `tests/tasks/parse-v3-adapter.test.ts` | **DELETE** — its subject is the deleted adapter |
| **F-A2.4** | `tests/tasks/model-contracts.test.ts` | **FLIP** — delete the `TaskDefinition` / `TaskScheduleBinding` blocks; keep the `TaskInvocation` / `ExecutionProvenanceContext` blocks and the purity ratchet scoped to `model/invocation.ts` |
| **F-A2.5** | `tests/integration/tasks-runtime-v3-runner.test.ts` | **FLIP + CONVERT** — the fail-before-mutation canary stays (P3a named it a preservation gate). Its v3 fixtures convert to task source v4; the `["v2", …, "TASK_SCHEMA_VERSION_UNSUPPORTED"]` row stays and gains a `["v3", …, "TASK_SCHEMA_VERSION_UNSUPPORTED"]` sibling (row B-14); the `exactly one source-IR job` expectation moves to commit 4's F-A3.5. |
| **F-A2.6** | `tests/integration/tasks-scheduler-sync-v3.test.ts` | **DELETE** — 23 tests whose subject is v3 scheduler sync. Before deleting, diff its cases against `tasks-scheduler-sync-v4.test.ts` and **port any behavior only it covers**; list the ported cases in the commit body. This is the single largest floor contributor. |
| **F-A2.7** | `tests/integration/tasks-scheduling-characterization.test.ts` | **DELETE** — all three tests are R-06, resolved by deletion (§5.5) |
| **F-A2.8** | `tests/integration/tasks-with-classification-characterization.test.ts` | **FLIP** — DELETE the P-01 and P-02 blocks (unreachable, §5.5); DELETE the P-03 block's "params deep-equal the authored mapping" case and keep a converted case asserting `params` is `{}` for a v4 workflow-target task with no `inputs:` (row B-28); **CONVERT** the P-04 block to a v4 document — it stays reachable and stays pinned |
| **F-A2.9** | `tests/integration/tasks-legacy-vocabulary-characterization.test.ts` | **CONVERT** — R-08's four arms and the legacy read-back rows all stay; only the fixtures move to v4. The legacy-row mapping cases are **KEEP, byte-unchanged** (row B-51). |
| **F-A2.10** | `tests/integration/tasks-provenance-characterization.test.ts` | **CONVERT** — fixtures to v4; every P-05/P-06/R-07 assertion unchanged |
| **F-A2.11** | `tests/tasks/bounded-document.test.ts` | **FLIP** — the front end's `sourceLabel` assertions move to `task source` (row B-17) |
| **F-A2.12** | `tests/tasks/source-v4.test.ts` | **FLIP** — the D2-N2 routing-table pins change: `version: 3` now raises `TASK_SCHEMA_VERSION_UNSUPPORTED` (was: routed to the v3 parser); the "missing/other version falls through to the v3 parser's own wording" divergence pin becomes row B-16's `must be exactly 4.` |
| **F-A2.13** | `tests/tasks/source-v4-adapter.test.ts` | **FLIP** — routing fixtures follow F-A2.12 |
| **F-A2.14** | `tests/integration/task-source-v4-route-call-sites.test.ts` | **FLIP** — every call site now has exactly one accepted version |
| **F-A2.15** | `tests/tasks/prepare-split.test.ts` | **FLIP** — the structural scan's "no `src` file imports `runtime-v3`" assertions become "`src/tasks/runtime-v3.ts` does not exist" (rows B-25, §5.2's seam widening applies here too); its own `parseTaskV3Yaml` fixture converts |
| **F-A2.16** | `tests/tasks/run-split.test.ts` | **FLIP** — imports move off `src/tasks/runner` (row B-26); any assertion that the shim re-exports a name becomes an assertion that the file is gone |
| **F-A2.17** | `tests/integration/tasks-runner.test.ts`, `tests/integration/tasks-result-vocabulary.test.ts`, `tests/integration/tasks-run-attempt-observability.test.ts`, `tests/integration/tasks-provenance-context.test.ts`, `tests/tasks/log-redaction.test.ts` | **FLIP** (import path only, row B-26) **+ CONVERT** where the file carries v3 fixtures. `tasks-runner.test.ts`'s disabled-dispatch-skip cases **DELETE** with the skip (row B-22). |
| **F-A2.18** | `tests/integration/commands/tasks-cli-envelope.test.ts` | **FLIP** — its disabled-dispatch cases DELETE with row B-22; the rest CONVERT |
| **F-A2.19** | `tests/integration/commands/tasks-lifecycle.test.ts` | **FLIP** — the `setEnabledInYaml` case retargets `schedule[].enabled` (row B-21); the rest CONVERT |
| **F-A2.20** | `tests/setup-scheduled-tasks.test.ts` | **FLIP + CONVERT** — `akm setup`'s task step is routed and its shipped fixtures are v4 (rows B-23, B-24) |
| **F-A2.21** | `tests/core/adapter/akm-validate.test.ts` | **FLIP** — every "v3 parsing" case becomes its v4 equivalent, plus one new case pinning row B-14 |
| **F-A2.22** | `tests/core/adapter/akm-task-adapter.test.ts`, `tests/integration/static-index.test.ts`, `tests/integration/output-baseline-graph.test.ts`, `tests/integration/install-ref.characterization.test.ts` | **CONVERT** |
| **F-A2.23** | `tests/tasks-embedded.test.ts` | **CONVERT** — the shipped-asset assertions follow row B-24 |
| **F-A2.24** | `tests/workflows/characterization-fixture-contracts.test.ts` | **FLIP** — DELETE the `tasks/v3-migration` describe block with its fixture family; the `single-job`, `plan-v4` and read-set blocks are **KEEP, byte-unchanged** |
| **F-A2.25** | `tests/fixtures/execution-contracts/tasks/v3-migration/**` (8 fixtures + manifest) | **DELETE** — its only consumers are F-A2.3 and F-A2.24's deleted block |
| **F-A2.26** | `tests/fixtures/execution-contracts/tasks/v2/**`, `tests/fixtures/execution-contracts/tasks/v3-to-v4/**` | **KEEP — preservation gate.** The migrator's own input fixtures. |
| **F-A2.27** | `tests/tasks/migrate-v2-to-v3.test.ts`, `tests/migrate/task-v2-to-v3-files.test.ts`, `tests/migrate/task-v3-to-v4.test.ts` | **KEEP — preservation gate**, byte-unchanged except import paths if the vendored parser's module specifier changes. All three must stay green. |
| **F-A2.28** | `tests/integration/migrate-format.test.ts`, `tests/integration/migration-help.test.ts` | **FLIP** — `akm migrate status`/`apply` now report and run both generations (rows B-31, B-32); `help.txt`'s pinned text updates |
| **F-A2.29** | `tests/workflows/child-workflow-freeze.test.ts`, `tests/integration/workflows/child-freeze-read-set.test.ts`, `tests/workflows/child-output-references.test.ts` | **CONVERT** — P3a's B-12/B-14/B-22 fixtures are `version: 3` tasks whose own `uses:` targets a workflow. Convert to v4 tasks that declare `inputs:`; the composition assertions are unchanged, but the case that pinned "the task's own `with:` becomes the child's params" **FLIPs** to the declared-inputs path (row B-28). |
| **F-A2.30** | `tests/workflows/task-binding-identity.test.ts`, `tests/workflows/with-rejection.test.ts`, `tests/workflows/task-input-bindings.test.ts` | **CONVERT** — their "declares no inputs" fixtures were v3 for a reason that no longer exists; a `version: 4` task with no `inputs:` key is now the faithful fixture. Assertions unchanged. |
| **F-A2.31** | `tests/workflows/task-source-v4-deferral.test.ts` | **FLIP or DELETE** — the LC-N1 deferral it pinned was already lifted by P2b; with v3 gone its remaining v3 fixtures have no subject. Verify and record. |
| **F-A2.32** | `tests/workflows/direct-script-typed.test.ts` | **FLIP** — its source-text scan for a fabricated task-source header must keep passing; its own v3 fixtures convert |
| **F-A2.33** | `tests/workflows/guarded-execution-source-red.test.ts`, `tests/integration/workflows/frozen-plan.test.ts`, `tests/integration/tasks-scheduler-sync-v4.test.ts`, `tests/integration/tasks-scheduler-source-snapshot.test.ts`, `tests/integration/commands/tasks-explain.test.ts`, `tests/integration/tasks-schedule-inputs.test.ts` | **CONVERT** — one or two fixtures each, assertions unchanged. `tasks-scheduler-sync-v4.test.ts`'s "v3 alongside v4 coexistence" case **FLIPs** to a two-v4-task case, since coexistence is no longer expressible. |
| **F-A2.34** | `tests/integration/registry-*.test.ts` (search, index-v2, cli, credential-safety, network-boundary, build-index) | **KEEP** — their `version: 3` occurrences are registry-index versions, not task sources. Verified by inspection; listed here so a reviewer does not chase them. |
| **F-A2.35** | `tests/integration/cli-errors.test.ts` | **FLIP** — add rows B-14/B-15's `TASK_SCHEMA_VERSION_UNSUPPORTED` envelope (Lane C extends the same table further in §5.2) |

### 7.3 Commit 4 — multi-job

| # | File | Action |
|---|---|---|
| **F-A3.1** | `tests/workflows/characterization-classification.test.ts` | **DELETE** the whole "multi-job source IR (P-08, R-05(a)) — parses and orders deterministically" describe block: canonical ordering, `needs` sorting, the 0/256/257 job-count bounds, missing-`needs`, cycle, duplicate-`needs` (7 tests). Every one requires a document the adapter now refuses (§5.5, P-08). |
| **F-A3.2** | `tests/workflows/characterization-classification.test.ts` | **FLIP** the "R-05 — multi-job parses clean, but the current runtime refuses to execute it" block: the R-05(a) parse-clean test becomes a rejection at compile (row B-34); the R-05(c) `compileWorkflowPlan` return-vs-throw test **DELETES** (row B-43); the R-05(b) freeze test **FLIPs** to `COMPOSITION_INVALID` with the adapter message (row B-44) |
| **F-A3.3** | `tests/workflows/source-ir-contract.test.ts` | **FLIP** the case asserting `exactly one source-IR job` to the new adapter code and message |
| **F-A3.4** | `tests/workflows/characterization-fixture-contracts.test.ts` | **KEEP** the `workflows/single-job` block byte-unchanged — it is row B-46, the acceptance baseline. Its describe text ("the acceptance R-05/P-08's multi-job rejection contrasts against") may be reworded only to drop the retired row IDs. |
| **F-A3.5** | `tests/integration/tasks-runtime-v3-runner.test.ts` | **FLIP** the `/exactly one source-IR job/i` expectation to the new adapter message |
| **F-A3.6** | `tests/fixtures/execution-contracts/workflows/manifest.json` | **FLIP** — `singleJob.description` drops the retired row IDs; optionally add a `rejected[]` entry for a two-job fixture so the new rejection has a registered fixture. If added, the fixture file is new (not a flip) and is named in the commit body. |
| **F-A3.7** | Any suite asserting `INVALID_FLAG_VALUE` for a workflow-source compile failure | **FLIP** to `WORKFLOW_SOURCE_INVALID` (row B-45). The implementer enumerates them with `rg -n 'Workflow source cannot be frozen' tests/` and adds each to this table, recording the addition in the Review log. |

### 7.4 Commits 5–9 — vocabulary, docs, ratchets

| # | File | Action |
|---|---|---|
| **F-B.1** | `tests/core/errors-usage-hints.test.ts` | **FLIP** — the pinned `WORKFLOW_SOURCE_INVALID` and `TASK_TARGET_UNSUPPORTED` hint strings (rows B-53, B-54) |
| **F-B.2** | `tests/tasks/run-split.test.ts` | **FLIP** — `SAFE_TASK_ATTEMPT_ERROR_CODES`'s membership pin gains the four codes of row B-55 |
| **F-B.3** | `tests/integration/commands/*.test.ts` golden/passthrough shapes touching `akm migrate` help text | **FLIP** — §3.2.5's description changes |
| **F-C.1** | `tests/architecture/diagnostic-codes.test.ts` | **FLIP** — row B-59 (terminal baseline) and row B-60 (widened seam scan) |
| **F-C.2** | `tests/architecture/task-fixture-vocabulary.test.ts` | **FLIP** — row B-61 (terminal allowed set) |
| **F-C.3** | `scripts/test-unit.sh`, `scripts/test-integration.sh` | **FLIP** — row B-62, with §5.3's commit body |
| **F-C.4** | `tests/contracts/ci-test-paths.test.ts` | **KEEP** — expected to need no edit (§5.1); a required edit is recorded |
| **F-C.5** | `docs/plans/specs/p0-invariants.md` | **APPEND ONLY** — §5.5's Review-log entry. No pinned row's text is edited. |

### 7.5 Explicit KEEP list (a reviewer will look for these)

| Surface | Why it stays |
|---|---|
| The D8 legacy read mapping and its tests (`"prompt"` → `{kind:"command"}`, legacy `"command"` → `{kind:"shell"}`) | It reads rows written by every previous release, forever (row B-51) |
| `DEFAULT_BUNDLE_NAME === "stash"` | User data compatibility (row B-48) |
| `src/indexer/**`'s `stashDir` | Out of scope since P0 (row B-50) |
| All three migrator suites and both migrator fixture families | The frozen migrator must keep working on the sources `src` just stopped accepting (F-A1.18, F-A2.26, F-A2.27) |
| Every P1–P3 feature suite: `with-rejection`, `task-input-bindings`, `task-binding-resolution`, `task-inputs-delivery`, `child-workflow-freeze`, `child-workflow-limits`, `plan-v5-schema`, `child-invocation-key`, `workflow-outputs`, the status-tree and `workflow plan` suites, `chaos`, `run-lease`, `workflow-crash-windows`, `v4-atomic-publication-red`, `state-migration-023` | §9's preservation gates — green, and byte-unchanged except where §7 names them |
| `tests/workflows/direct-script-typed.test.ts`'s fabricated-header source scan | R-02's permanent guard: no `src` file may fabricate task source to reuse a parser |
| The exit-code table in `src/cli/shared.ts` | D7: the diagnostics work never touches exit codes |

---

## 8. Carried-advisory dispositions

Every advisory and decision point that an earlier phase's Review log handed
forward. **A P4 close-out that leaves a row here undispositioned is
incomplete.**

| ID | Source | Advisory | P4 disposition |
|---|---|---|---|
| **R-R1** | P3a §0, P3b §0 | "P4 owns the rename" of `schema-v4.ts` / `freeze-v4.ts` / `environment-v4.ts` / the `TaskV3*` and `PreparableTaskDocument` type family | **DEFERRED to a follow-up commit after §10's sweep is green.** Rationale (binding, §0): a rename storm across ~40 import sites buries the deletion diff the deletion audit exists to prove. Recorded in §4.3's checkpoint as named remaining work. |
| **R-R2** | P3a Review log R9 | A v3 task's authored `with:` gains reference semantics only when composed | **RESOLVED BY DELETION** — §3.2 removes the only grammar that could author it (row B-29); §3.2.7 collapses the `taskDispatch` ternary that carried it (row B-30). Neither of R9's two options is needed. |
| **R-R3** | P3a Review log R11 | `publishChildWorkflowRun` hand-rolls `insertRun`'s 13-column list | **RESOLVED AS AN INVARIANT, not a refactor** — §4.1 adds the one-line must-move-together comment at both sites, each naming the other, plus ADR `0009`. A signature refactor now, with P3b's caller one commit old, is exactly the guess R11 declined to make. |
| **R-R4** | P1a close-out | Import-seam ratchet must harden against namespace-import / re-export / dynamic-import evasion — "the seam must hold through the grammar deletion" | **RESOLVED** — row B-60 / §5.2. |
| **R-R5** | P1a close-out | `WORKFLOW_SOURCE_INVALID`'s hint names `akm workflow validate`, which does not exist | **RESOLVED** — row B-53. |
| **R-R6** | P1a close-out | `SAFE_TASK_ATTEMPT_ERROR_CODES` must track the new codes | **RESOLVED** — row B-55. |
| **R-R7** | P1a close-out | CLI envelope + exit-2 coverage for the new codes | **RESOLVED** — §5.2's `cli-errors.test.ts` extension. |
| **R-R8** | P1a Review log | Seven direct `UsageError` throws in the task-source front end keep `INVALID_FLAG_VALUE` in 0.9.2 | **RESOLVED** — §5.2 re-codes `bounded-document.ts` to `TASK_SOURCE_INVALID`. The CHANGELOG entry P1a wrote to qualify this is updated by §4.6's Changed entry. |
| **R-R9** | P1a accepted deviation A-1 | Locator-shaped values widened from `unsupported-uses-target` to `remote-action-acquisition-out-of-scope` | **RETIRED** — §3.1 deletes the row entirely; F-A1.7 flips all ten pinned values back. |
| **R-R10** | P1b close-out | Shared-capture structural check deferred; adapter-header P2a cross-reference deferred | **RECORDED, NOT FIXED** — neither is a deletion; both survive P4 unchanged. Re-recorded here so they are not lost. |
| **R-R11** | P2a advisory 1 | A secret-shaped task **input default** warns with workflow-parameter prose that is false for a task input | **RECORDED, NOT FIXED** — a message-quality change, outside P4's charter. Carried to post-0.9.2. |
| **R-R12** | P2a advisory 2 | `akm task run --token <secret>` echoes the value in the error envelope on a type mismatch | **RECORDED, NOT FIXED — but flagged as the highest-severity carried item.** It is a credential-disclosure path on a NEW surface. P4 does not fix it (redaction is new behavior, and `akm task explain`'s secret-freeness is criterion 24's actual subject); §10's sweep must cite it explicitly under criterion 24 so the decision is visible, not buried. |
| **R-R13** | P2a advisory 3 | A `required: true` input with no default makes every scheduled run fail, with no parse- or sync-time warning | **RECORDED, NOT FIXED** — a new diagnostic is new behavior. §4.7's migration guide **must** document the trap in the task-source-v4 section. |
| **R-R14** | P2a advisory 4 | Doubled `$` path root in a schedule-inputs error; a `uses:` error that lists `tasks/` as valid | **PARTIALLY RESOLVED** — the second half is fixed for free if §3.1's message rewrite touches `classifyTargetRef`'s text; if it does not, both halves are RECORDED, NOT FIXED. State which in the Review log. |
| **R-R15** | P2b advisory 1 | A reference binding's RESOLVED value is outside `computeUnitInputHash`; a resumed run can reuse a unit carrying a stale bound value | **RECORDED, NOT FIXED.** It is a `hashVersion` change and §0 forbids one. This is the most consequential open item on the branch — §10's sweep cites it under criterion 8, and §4.7's migration guide notes the resume caveat. |
| **R-R16** | P2b advisory 2 | `{from: "params.<name>"}` bindings are unreachable: no front end that can express `uses: tasks/<ref>` has a `params:` authoring surface | **RECORDED, NOT FIXED** — retiring the arm or opening a `params:` surface are both behavior changes. §4.7 documents that `{from: "steps.<id>.output…"}` is the reachable reference form today. |
| **R-R17** | P2b advisory 3 | An unresolvable `uses: tasks/<ref>` with a `with:` reports "declares no inputs" instead of the asset-resolution failure | **RECORDED, NOT FIXED** — message quality. |
| **R-R18** | P2b advisory 4 | `akm task explain`'s text and `--json` output are byte-identical raw JSON | **RESOLVED IN DOCS** — §4.7 and `docs/reference/tasks.md` state explicitly that `akm task explain` emits JSON in both formats. No renderer is added. |
| **R-R19** | P2b advisory 5 | The P2b commit ladder ran out of order, so its "commit 2 green in isolation" gate could not be ticked | **CLOSED — historical.** P4's own ladder (§0.2) is ordered and each commit is green on its own. |
| **R-R20** | P2b §3.1 | "Re-homing `environment-v4.ts` is P4's" | **DEFERRED with R-R1** — a pure move with two importers and zero deletions. |
| **R-R21** | P0 close-out | Five recorded advisories on P0 test precision (R-05(a) grep anchor, P-08's 1-job bound cited only via fixtures, delegation call-count assertions pinning an internal seam, P-06's stdout-based child-env observation, R-07's positional `args[2]` capture) | **RETIRED BY DELETION** — every one of the five sits in a test §7 deletes or flips (F-A1.3–F-A1.6, F-A3.1, F-A3.2, F-A2.8, F-A2.10). Confirm in the Review log rather than fixing them in place. |

---

## 9. Preservation gates (the reviewer runs these)

- [ ] `bun run check` green at every commit in §0.2 — lint (including all
      chained repo checks: `lint-tests-isolation`, `lint-license-headers`,
      `lint-runtime-boundary`, `lint-write-source-chokepoint`,
      `lint-secret-resolver-boundary`, `lint-execution-boundary`,
      `lint-process-argv`, `lint-repository-sql`, `lint-goldens-presence`,
      `lint-golden-captured-at-head`, `lint-shipped-assets`,
      `lint-doc-examples`, `gen-config-schema --check`,
      `lint-active-docs-terminology`), `bunx tsc --noEmit`, `test:unit`,
      `test:integration`.
- [ ] **Every P1–P3 feature suite green and byte-unchanged** except where §7
      names it: `tests/workflows/with-rejection.test.ts`,
      `task-input-bindings.test.ts`, `task-binding-identity.test.ts`,
      `child-workflow-freeze.test.ts` (cycle/depth/size bounds),
      `child-workflow-dispatch-guard.test.ts`,
      `child-output-references.test.ts`, `workflow-outputs-source.test.ts`,
      `plan-v4-retirement.test.ts`,
      `plan-v5-schema.test.ts`, `child-invocation-key.test.ts`,
      `tests/integration/workflows/workflow-outputs-runtime.test.ts`,
      `tests/integration/workflows/task-binding-resolution.test.ts`,
      `task-inputs-delivery.test.ts`, `frozen-plan.test.ts`,
      `v4-atomic-publication-red.test.ts`, `chaos.test.ts`,
      `run-lease.test.ts`, `schema-drift.test.ts`,
      `shared-physical-owner-authority.test.ts`,
      `tests/integration/workflow-crash-windows.test.ts`,
      `tests/integration/state-migration-023.test.ts`, plus every P3b suite.
      Verify with `git diff <p4-base> --stat` per file.
- [ ] **The D8 legacy read mapping tests are byte-unchanged**
      (`tests/integration/tasks-legacy-vocabulary-characterization.test.ts`'s
      legacy-row cases, `tests/task-history-metadata.test.ts`).
- [ ] **The migrator suites are green**:
      `tests/tasks/migrate-v2-to-v3.test.ts`,
      `tests/migrate/task-v2-to-v3-files.test.ts`,
      `tests/migrate/task-v3-to-v4.test.ts` — including
      `github-action-target-removed`, which proves the vendored grammar
      survived §3.1.
- [ ] `rg -n 'from "\.\./\.\./scripts|scripts/akm-migrate' src/` → **zero**.
- [ ] `rg -n 'github-action|remote-action-acquisition|isGithubLocatorShape|GITHUB_OWNER' src/ schemas/` → **zero**.
- [ ] `rg -n 'parseTaskV3Yaml|parseTaskV3Document|classifyTaskV3Uses|TASK_V3_SCHEMA_VERSION' src/` → **zero**.
- [ ] `rg -n 'canonicalTopologicalJobs|job-count-limit|missing-job-dependency|job-dependency-cycle|duplicate-job-dependency|exactly one source-IR job|Multi-job workflow cannot execute' src/` → **zero**.
- [ ] `ls src/tasks/runtime-v3.ts src/tasks/runner.ts src/workflows/ir/source-freeze-v4.ts src/workflows/source-ir/ordering.ts src/tasks/source/parse-v3-adapter.ts` → **all absent**.
- [ ] `rg -n '^version: 3' src/assets/ tests/fixtures/` → hits only under
      `tests/fixtures/execution-contracts/tasks/v2/` and `…/v3-to-v4/`.
- [ ] `rg -n 'brief\.ts|report\.ts' src/workflows/exec/` and
      `rg -n 'experimental\.workflowEngine' src/` → **zero** (recorded in
      §4.5's decision record).
- [ ] Plan `irVersion` is still 5, `hashVersion` is still 6, the
      child-invocation prefix is still `\0v1\0`:
      `rg -n 'WORKFLOW_IR_V5_VERSION|akm\.workflow\.(unit|gate)\\0v6\\0|child-invocation\\0v1\\0' src/`
      shows the same constants as at P4's base.
- [ ] `EXIT_CODES` in `src/cli/shared.ts` is byte-unchanged.
- [ ] Tar-gate files present and rewritten in place, never renamed or
      deleted: `schemas/akm-task.json`, `docs/reference/tasks.md`,
      `docs/reference/workflow-schema.md`.
- [ ] `bun scripts/lint-doc-examples.ts` green — every `akm …` example in
      `STABILITY.md`, the migration guide, the release notes, the ADRs and
      the reference docs.
- [ ] Both test floors carry §5.3's commit-body evidence.
- [ ] `tests/architecture/diagnostic-codes.test.ts`'s baseline is a MEASURED
      number, its comment says **terminal**, and the §5.2 table's deviations
      (if any) are in the Review log.
- [ ] Every §7 row is either done or explicitly re-dispositioned in the
      Review log. Every §8 row is dispositioned.

---

## 10. Lane D — the 25-criteria acceptance sweep (commit 10)

### 10.1 Protocol

ONE report-only agent. It **writes no code and edits no test**. It runs after
commits 2–9 are green. It walks the 25 criteria of §10.2 **in order** and, for
each, produces:

- **Verdict**: `MET` / `MET WITH CAVEAT` / `UNMET`.
- **Citation**: a runnable `rg` command with its result, or a
  `path/to/file.test.ts:describeOrTestName` / `path/to/module.ts:symbolName`.
  A citation that names only a file is insufficient — name the symbol or the
  test.
- **One sentence** saying what the citation proves.
- For `MET WITH CAVEAT` and `UNMET`: **exactly what remains**, in
  imperative form, with the file it lives in. The sweep **never papers over
  a gap** — a criterion that is partly met is not `MET`.

The sweep must consult §8's disposition table and surface every
`RECORDED, NOT FIXED` row under the criterion it bears on — R-R12 under
criterion 24, R-R15 under criterion 8, R-R16 under criterion 6, R-R13 under
criterion 4.

Output is appended to **this file** as §10.3 and returned verbatim to the
orchestrator. The agent needs no source other than this document.

### 10.2 The 25 criteria (verbatim from the brief, §16)

> The work is complete when all of the following are true:
>
> 1. AKM still uses its native workflow engine with no new external runtime dependency.
> 2. Existing command, shell, script, retry, gate, worktree, and resume behavior remains intact.
> 3. A workflow task call can no longer silently discard `with`.
> 4. Tasks can exist and compose without schedule metadata.
> 5. CLI, scheduler, and workflow calls use one task-invocation resolver.
> 6. Typed task inputs support defaults, validation, literals, and explicit workflow references.
> 7. Task inputs are attached as structured context and are not interpolated into arbitrary prose.
> 8. Effective task inputs participate in durable execution identity.
> 9. Task output contracts are enforced consistently.
> 10. Direct workflow references and task-wrapped workflow references lower to the same child-workflow target.
> 11. Child plans are frozen before parent publication.
> 12. Child source edits cannot alter an in-flight parent run.
> 13. Parent-child run creation is idempotent across crash windows.
> 14. Parent cancellation propagates to the child.
> 15. Parent and child runs are independently resumable and clearly linked.
> 16. Composition cycles fail before durable mutation.
> 17. No internal path fabricates YAML to reuse another parser.
> 18. Native target classification contains no GitHub Action variant.
> 19. Workflow source classification no longer depends on the task source parser.
> 20. The task runner no longer mutates global process environment state.
> 21. Runtime vocabulary no longer exposes `stash` or mislabels commands as prompts.
> 22. Domain failures use stable, phase-specific diagnostic codes.
> 23. Multi-job YAML is either executable or rejected at the adapter boundary; it is not display-only core behavior.
> 24. Task and workflow explain/plan output exposes target, input, source, and child provenance without secrets.
> 25. All fail-before-mutation, crash-window, source-CAS, plan-hash, and replay-divergence tests pass.

### 10.3 Sweep starting points (guidance, not a substitute for verification)

The sweep verifies independently; these are where to look first.

| # | Where to look |
|---|---|
| 1 | `package.json` dependencies diffed against `origin/release/0.9.2`; `src/workflows/exec/native-executor.ts` is still the only executor |
| 2 | `tests/contracts/execution-*`, `resolved-execution-contract`, `command-invocation-contract`, `tests/integration/workflows/run-lease.test.ts`, `chaos.test.ts`, `worktree`-scoped suites |
| 3 | `src/workflows/freeze/targets/task.ts:noDeclaredInputsError`; `tests/workflows/with-rejection.test.ts` |
| 4 | `src/tasks/source/task-source-v4.ts`'s optional `schedule:`; `tests/tasks/source-v4.test.ts`; R-R13's caveat |
| 5 | `src/tasks/prepare/prepare.ts:prepareTaskV3Execution`'s three callers (`run/load-task.ts`, `scheduler-sync.ts`, `freeze/targets/task.ts`); `tests/tasks/prepare-split.test.ts` |
| 6 | `src/execution/input-contract.ts`; `src/workflows/freeze/task-bindings.ts:normalizeOneEntry`; R-R16's caveat on the `params.` arm |
| 7 | `src/workflows/exec/step-work.ts:buildUnitPrompt`; `src/workflows/exec/exec-unit.ts`'s `AKM_TASK_INPUTS`; the zero-prose-interpolation assertion in the P2b delivery suites |
| 8 | `src/workflows/exec/step-work.ts:computeUnitInputHash`'s preimage; R-R15's caveat |
| 9 | `src/tasks/source/task-source-v4.ts`'s single bounded `output:`; `src/core/json-schema.ts:validateJsonSchemaSubset` |
| 10 | `src/workflows/freeze/targets/child-workflow.ts:childWorkflowDispatch` — one resolver, two callers (`resolve-steps.ts`, `targets/task.ts`) |
| 11–16 | `tests/workflows/child-workflow-freeze.test.ts` (freeze-before-publication, cycle/depth/size bounds), `tests/integration/storage/child-run-publication.test.ts` (idempotency), `tests/integration/workflows/child-freeze-read-set.test.ts` (source CAS over child sources), P3b's crash-window and cancellation suites |
| 17 | `tests/workflows/direct-script-typed.test.ts`'s source-text scan; `src/tasks/prepare/prepare-script-target.ts` |
| 18 | §9's `github-action` grep → zero |
| 19 | §5.2's widened seam assertion; after §3.2's re-home, `src/workflows/**` imports nothing from `src/tasks/**` source modules |
| 20 | `rg 'process\.env\.AKM_EVENT_SOURCE\s*=' src/` and `rg 'delete process\.env\.AKM_EVENT_SOURCE' src/` → zero |
| 21 | §4.1's greps; note the two deliberate survivals (rows B-48, B-51) explicitly |
| 22 | §5.2's terminal ratchet; `src/core/errors.ts`'s `UsageErrorCode` union |
| 23 | §3.3; row B-46's single-job baseline still compiles |
| 24 | `src/commands/tasks/explain.ts`, P3b's `akm workflow plan`, `src/workflows/exec/param-secrets.ts`, `src/workflows/exec/dispatch-redaction.ts`; **cite R-R12 explicitly** |
| 25 | `tests/integration/tasks-runtime-v3-runner.test.ts` (fail-before-mutation), `workflow-crash-windows.test.ts`, `guarded-execution-source-red.test.ts` (source CAS), `plan-hash`/`schema-drift`, P3b's replay-determinism suite |

---

## 11. Docs that ride with the code

| Doc | Change | Lane / commit |
|---|---|---|
| `docs/reference/tasks.md` | task source v4 is the only accepted version; `akm task add` authors v4; `--params` → `inputs:`; enablement is per schedule binding; `akm task explain` emits JSON in both formats (R-R18) | B / 8 |
| `docs/reference/workflow-schema.md` | exactly one job (brief §10's public position quoted); no GitHub locators; the composition section's `with:` semantics | B / 8 |
| `docs/reference/workflows.md` | child workflows, `outputs:`, `akm workflow plan` | B / 8 |
| `CHANGELOG.md` | §4.6 | B / 8 |
| `docs/migration/v0.9.1-to-v0.9.2.md` | §4.7 | B / 8 |
| `docs/migration/release-notes/0.9.2.md` | §4.7 | B / 8 |
| `STABILITY.md` | §4.4 | B / 7 |
| `docs/plans/0.9.2-architecture-deletion-audit.md` | §4.3 + the driver-protocol row | B / 7 |
| `docs/architecture/specs/driver-protocol-keep-or-cut.md` | §4.5 | B / 7 |
| `docs/architecture/decisions/**` | §4.2 | B / 6 |
| `scripts/akm-migrate/help.txt` | both generations | A / 3 |
| `docs/plans/specs/p0-invariants.md` | §5.5 Review-log append | C / 9 |

`.github/workflows/ci.yml` ignores docs-only changes, so commits 6–8 will
not get normal CI coverage. Each must therefore be verified locally with
`bun run lint` (which chains `lint-doc-examples` and
`lint-active-docs-terminology`) before pushing, and the phase gate re-runs
`bun run check` over the combined tree.

---

## 12. Acceptance criteria

**Structure**

- [ ] The three deletion families landed as three commits in the §0.2 order,
      each with its zero-consumer proof, its dead-code sweep report and its
      `bun run check` result in the commit body.
- [ ] Every file on §6's DELETE list is absent; every symbol §3 names is
      gone from `src/`; §9's greps all return zero.
- [ ] `scripts/akm-migrate/migrate/task-source-v3-frozen.ts` exists, carries
      the frozen-migrator header, retains the GitHub locator grammar, and is
      the only v3 parser in the repository. `src/` imports nothing from
      `scripts/`.
- [ ] `akm migrate status` / `apply` cover both migration generations; the
      `TASK_SCHEMA_VERSION_UNSUPPORTED` hint names a command that performs
      the conversion.
- [ ] All 10 shipped assets under `src/assets/tasks/**` are task source v4
      with unchanged cron, target and enablement.
- [ ] `docs/architecture/decisions/` exists with a README and the §4.2 ADR
      set; every extracted essay left a one-line invariant comment linking to
      its ADR; no reasoning was deleted.

**Behavior**

- [ ] Every row of §2's behavior tables holds, verified by its §7 test.
- [ ] Every §7 flip is a **visible test diff**; no test was deleted to make a
      flip disappear, and every deletion is accounted for in §5.3's floor
      evidence.
- [ ] `bun run check` green with the new floors, the terminal ratchet, and
      the terminal v3-fixture allowed set.
- [ ] Plan `irVersion`, `hashVersion`, the child-invocation prefix, the
      `WORKFLOW_MAX_*` limits and `EXIT_CODES` are all unchanged.

**Close-out**

- [ ] §4.3's net-LOC checkpoint carries measured numbers and states honestly
      whether `src/` shrank.
- [ ] `driver-protocol-keep-or-cut.md` is RESOLVED with its three greps
      pasted and both cross-references in place.
- [ ] The CHANGELOG, migration guide and release notes describe the **whole**
      refactor and are internally consistent with each other and with
      `STABILITY.md`.
- [ ] Every §8 row is dispositioned; every `RECORDED, NOT FIXED` row appears
      in §10.3's sweep under the criterion it bears on.
- [ ] §5.5's P0 Review-log entry lists R-01…R-09 and the superseded P rows.
- [ ] §10's sweep is appended to this file, covers all 25 criteria, cites a
      grep or `file:symbol` for each, and lists every UNMET criterion with
      exactly what remains.
- [ ] Every behavior difference observed during implementation that is not in
      §7 is recorded in the Review log and **not** silently absorbed.

---

## Review log

<!-- Reviewers append dated entries below. -->

**2026-08-28 — Family A2 (task source v3 acceptance out of `src`, commit 3) implementation notes.**

*P1b §9's structure criterion is superseded (§3.2.7's `src/tasks/model/definition.ts`/`schedule.ts` row), exactly as P2a superseded P1b's "`source-v3.ts` unmodified" criterion (`docs/plans/specs/p2a-task-source-v4.md:988`).* P1b §9's acceptance criteria required "`src/tasks/source/parse-v3-adapter.ts` exists, is pure, maps `parseTaskV3Yaml` output → `TaskDefinition`" and "`src/tasks/model/{definition,invocation,schedule}.ts` exist, export the shapes named in §1.1, and are pure." This family deletes both `parse-v3-adapter.ts` and `model/definition.ts` + `model/schedule.ts` (§3.2.7): the adapter's own docstring already scoped itself to "a transition period" that "ends here" once task source v3 acceptance retires, and once the adapter goes, `definition.ts`/`schedule.ts` have zero remaining importers. `model/invocation.ts` (`TaskInvocation`, `ExecutionProvenanceContext`) stays untouched — its six live importers are structurally independent of the deleted pair. P1b §9 was that phase's own acceptance criterion, not a standing invariant across the whole refactor; P4 supersedes it by design, per §0's framing ("P4 collects the debt and closes the branch"). Verified zero-importer before deletion: `rg -n 'from ".*tasks/model/definition"' src/ tests/`, the equivalent for `tasks/model/schedule` and `tasks/source/parse-v3-adapter`, each returning zero hits against the post-deletion tree (`src/tasks/schedule.ts` — the unrelated scheduler-backend module `scheduler-sync.ts`/`scheduler-binding.ts` import via `./schedule` — is a same-name-different-path false positive a looser pattern would catch; the precise `tasks/model/schedule` substring excludes it).

*The workflow-side re-home (P4-N3) tightens `src/workflows/**` importing nothing from `src/tasks/**` source modules — a naming discipline note.* `classifyTaskV3Triggers` moved to `src/workflows/source-ir/triggers.ts` as `classifyWorkflowYamlTriggers`; its one surviving test case moved with it into a new `tests/workflows/source-ir-triggers.test.ts` rather than staying in the deleted `tests/tasks/source-v3.test.ts` (F-A2.1). No behavior change — the classifier's logic is unmodified, only its file and export name.

*One pre-existing, unrelated test failure discovered and left unfixed (rule: "a defect discovered that is not in §7 is recorded in the Review log and left unfixed").* `tests/integration/migration-help.test.ts`'s "the 0.9.2 terminal note points task-v2 users at the fail-closed migration" test asserts `result.toContain("Task v3")` against the rendered migration-notes changelog copy, which already (correctly) reads "task-v3"/"task-v2" (lowercase, hyphenated) rather than "Task v3". `git blame` traces this assertion to commit `2bd8c146` ("test(state): parse complete safety copy diagnostics"), unrelated to any task-source phase. Not in §7's flip/convert/delete table for this family, so left unfixed here.
