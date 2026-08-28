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
| **F-A3.7** | Any suite asserting `INVALID_FLAG_VALUE` for a workflow-source compile failure | **FLIP** to `WORKFLOW_SOURCE_INVALID` (row B-45). The implementer enumerates them with `rg -n 'Workflow source cannot be frozen' tests/` and adds each to this table, recording the addition in the Review log. `rg` returned **zero** hits (no pre-existing test asserted that literal phrase) — F-A3.7 itself contributes no rows. F-A3.8–F-A3.11 below are what the broader investigation §3.3's actual behavior change required (recorded in the Review log per this row's own instruction). |
| **F-A3.8** | `tests/workflows/source-ir-contract.test.ts` | **DISCOVERED FLIP**, recorded in the Review log. Three tests in the "workflow source IR portable contract" describe block assumed a multi-job document parses: (a) "normalizes a multi-job graph into deterministic dependency order" **DELETE** — both its 3-job fixtures no longer parse, so there is nothing left to normalize; (b) "uses locale-independent code-point ordering for ready jobs and mapping keys" **FLIP** (renamed "… for with: mapping keys") — the ready-job-ordering half has no reachable scenario at one job; the mapping-key half (unrelated to job count) survives on a single-job fixture; (c) "rejects missing and cyclic job dependencies before an IR is returned" **FLIP** (renamed "rejects a job needs (single-job) and a job-count mismatch (multi-job) with multi-job-unsupported") — both `expectGithubError` codes become `multi-job-unsupported` (rows B-37, B-39 via B-34). |
| **F-A3.9** | `tests/workflows/source-ir-contract.test.ts` | **DISCOVERED FLIP** (DELETE), recorded in the Review log. "uses one greedy lexical topological order in producer and decoder" pinned cross-job topological/decoder-idempotence behavior for a 3-job document — unreachable once a source is confined to exactly one job (row B-34); no single-job equivalent exists to substitute. |
| **F-A3.10** | `tests/workflows/source-ir-contract.test.ts` | **DISCOVERED FLIP**, recorded in the Review log. "rejects noncanonical trigger, needs, and ready-job ordering" (renamed "… and a job count other than 1") — the `triggers` sub-case is unchanged; the `jobs` sub-case (a hand-built 2-job array probing `validateTopologicalJobs`'s deleted "canonical dependency-topological order" message) now probes the decoder's own jobs-array-length check instead, asserting `/jobs must contain exactly 1 entry/i` (row B-42); the `needs` sub-case's per-job canonical-order check SURVIVES (it is independent of job count) but moves onto a single job with an unsorted `needs:` array, since its old 3-job fixture no longer decodes. |
| **F-A3.11** | `tests/integration/workflows/immutable-resolution-v4-red.test.ts` | **DISCOVERED FLIP**, recorded in the Review log. The `test.each` "multi-job" row's pattern `/multi-job\|job boundaries\|needs/i` was written against `source-freeze.ts`'s now-deleted "Multi-job workflow cannot execute until job boundaries and needs have a durable runtime representation." message (row B-44's old outcome); none of its three alternatives appears in the new adapter-boundary message, so it FLIPs to `/requires exactly one job/i`. |

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

- [x] The three deletion families landed as three commits in the §0.2 order,
      each with its zero-consumer proof, its dead-code sweep report and its
      `bun run check` result in the commit body.
- [x] Every file on §6's DELETE list is absent; every symbol §3 names is
      gone from `src/`; §9's greps all return zero.
- [x] `scripts/akm-migrate/migrate/task-source-v3-frozen.ts` exists, carries
      the frozen-migrator header, retains the GitHub locator grammar, and is
      the only v3 parser in the repository. `src/` imports nothing from
      `scripts/`.
- [x] `akm migrate status` / `apply` cover both migration generations; the
      `TASK_SCHEMA_VERSION_UNSUPPORTED` hint names a command that performs
      the conversion.
- [x] All 10 shipped assets under `src/assets/tasks/**` are task source v4
      with unchanged cron, target and enablement.
- [x] `docs/architecture/decisions/` exists with a README and the §4.2 ADR
      set; every extracted essay left a one-line invariant comment linking to
      its ADR; no reasoning was deleted. (Authored late — ADR 0006 was
      missing until review-fix commit `f9ea73b8` — see the Review log's
      final entry, Scope 1 F7 / Scope 2 Finding 2.)

**Behavior**

- [x] Every row of §2's behavior tables holds, verified by its §7 test.
- [x] Every §7 flip is a **visible test diff**; no test was deleted to make a
      flip disappear, and every deletion is accounted for in §5.3's floor
      evidence. (The one close call — the bounded-document hostile-input
      suite deleted alongside `source-v3.test.ts` while its actual subject
      survived — is fixed; see the Review log's final entry, Scope 1 F3.)
- [x] `bun run check` green with the new floors, the terminal ratchet, and
      the terminal v3-fixture allowed set. (Briefly false between commits
      `d24f432a` and `f9ea73b8` — `migration-help.test.ts` — fixed and
      reconfirmed green at final HEAD; see the Review log's final entry,
      Scope 2 Finding 3.)
- [x] Plan `irVersion`, `hashVersion`, the child-invocation prefix, the
      `WORKFLOW_MAX_*` limits and `EXIT_CODES` are all unchanged.

**Close-out**

- [x] §4.3's net-LOC checkpoint carries measured numbers and states honestly
      whether `src/` shrank. (Authored late, by review-fix commit `5393e1ca`
      — the section was byte-unchanged and stale through commit 8; see the
      Review log's final entry, Scope 2 Finding 1.)
- [x] `driver-protocol-keep-or-cut.md` is RESOLVED with its three greps
      pasted and both cross-references in place.
- [x] The CHANGELOG, migration guide and release notes describe the **whole**
      refactor and are internally consistent with each other and with
      `STABILITY.md`. (Seven ledger-truth drifts — GitHub-locator error
      text, the `INVALID_FLAG_VALUE` claim, the two-arm-`oneOf` claim, the
      workflow-schema multi-job text, the v3-task-wrapped claim, the
      `{from: "params.<name>"}` caveat, and the D8 `target.kind` break —
      found and fixed by review-fix commit `120e1c0b`; see the Review log's
      final entry, Scope 2 Findings 4-10.)
- [x] Every §8 row is dispositioned; every `RECORDED, NOT FIXED` row appears
      in §10.3's sweep under the criterion it bears on.
- [x] §5.5's P0 Review-log entry lists R-01…R-09 and the superseded P rows.
- [x] §10's sweep is appended to this file, covers all 25 criteria, cites a
      grep or `file:symbol` for each, and lists every UNMET criterion with
      exactly what remains. (0 UNMET, 19 MET, 6 MET WITH CAVEAT — see §10.3,
      appended to the Review log's final entry below.)
- [x] Every behavior difference observed during implementation that is not in
      §7 is recorded in the Review log and **not** silently absorbed. (Four
      ADVISORY-tier items — Scope 1 F5/F6, Scope 2 A1/A2 — remain open at
      final HEAD; auto-adjudicated non-blocking and recorded, not absorbed,
      in the Review log's final entry.)

---

## Review log

<!-- Reviewers append dated entries below. -->

**2026-08-28 — Family A2 (task source v3 acceptance out of `src`, commit 3) implementation notes.**

*P1b §9's structure criterion is superseded (§3.2.7's `src/tasks/model/definition.ts`/`schedule.ts` row), exactly as P2a superseded P1b's "`source-v3.ts` unmodified" criterion (`docs/plans/specs/p2a-task-source-v4.md:988`).* P1b §9's acceptance criteria required "`src/tasks/source/parse-v3-adapter.ts` exists, is pure, maps `parseTaskV3Yaml` output → `TaskDefinition`" and "`src/tasks/model/{definition,invocation,schedule}.ts` exist, export the shapes named in §1.1, and are pure." This family deletes both `parse-v3-adapter.ts` and `model/definition.ts` + `model/schedule.ts` (§3.2.7): the adapter's own docstring already scoped itself to "a transition period" that "ends here" once task source v3 acceptance retires, and once the adapter goes, `definition.ts`/`schedule.ts` have zero remaining importers. `model/invocation.ts` (`TaskInvocation`, `ExecutionProvenanceContext`) stays untouched — its six live importers are structurally independent of the deleted pair. P1b §9 was that phase's own acceptance criterion, not a standing invariant across the whole refactor; P4 supersedes it by design, per §0's framing ("P4 collects the debt and closes the branch"). Verified zero-importer before deletion: `rg -n 'from ".*tasks/model/definition"' src/ tests/`, the equivalent for `tasks/model/schedule` and `tasks/source/parse-v3-adapter`, each returning zero hits against the post-deletion tree (`src/tasks/schedule.ts` — the unrelated scheduler-backend module `scheduler-sync.ts`/`scheduler-binding.ts` import via `./schedule` — is a same-name-different-path false positive a looser pattern would catch; the precise `tasks/model/schedule` substring excludes it).

*The workflow-side re-home (P4-N3) tightens `src/workflows/**` importing nothing from `src/tasks/**` source modules — a naming discipline note.* `classifyTaskV3Triggers` moved to `src/workflows/source-ir/triggers.ts` as `classifyWorkflowYamlTriggers`; its one surviving test case moved with it into a new `tests/workflows/source-ir-triggers.test.ts` rather than staying in the deleted `tests/tasks/source-v3.test.ts` (F-A2.1). No behavior change — the classifier's logic is unmodified, only its file and export name.

*CORRECTED (review finding, dated below): a `migration-help.test.ts` failure was recorded here as "pre-existing, unrelated," established by `git blame` on the failing ASSERTION rather than by running the suite at the phase base — `git blame` proves only who last touched the assertion LINE, not when the RENDERED TEXT it compares against last changed underneath it. Measured directly instead: `bun test tests/integration/migration-help.test.ts` is **12 pass / 0 fail** at `0f16f70fdc61` (P4's base, immediately before any P4 commit landed) and **11 pass / 1 fail** at this family's own head. The regression is real and P4-introduced, not pre-existing.* `tests/integration/migration-help.test.ts`'s "the 0.9.2 terminal note points task-v2 users at the fail-closed migration" test asserted `result.toContain("Task v3")` against `docs/migration/release-notes/0.9.2.md`'s rendered copy. Commit `d24f432a` ("docs(p4): changelog, migration guide, release notes, and reference docs", §4.7) rewrote that file's Task-sources paragraph off the pre-P4 capitalized "Task v3" proper-noun wording ("Task sources now use Task v3.") onto the post-P4 vocabulary ("Task sources now use task source v4. Normal execution rejects task-v3 and task-v2 files…", §0.1's naming discipline: "task-v3" lowercase-hyphenated is the one permitted bare "task v3" form) — landing four commits (`2d6558b1`, `d489e795`, `6a06b4ab`, `09691628`) after `d24f432a` itself with no update to this test, and the file was never re-run against the base commit to notice. §7.2's F-A2.28 already authorizes flipping this exact file ("`akm migrate status`/`apply` now report and run both generations… `help.txt`'s pinned text updates"), so this is a fix inside an already-authorized flip, not a new one. FIXED here: the assertion now checks for "task source v4" / "`TASK_SCHEMA_VERSION_UNSUPPORTED`" (present in the rewritten copy) instead of the retired "Task v3" string; re-measured **12 pass / 0 fail**. §9's first preservation gate ("`bun run check` green at every commit") and §12's "`bun run check` green" were UNMET from `d24f432a` through this correction; both are MET now.

**2026-08-28 — Family A3 (multi-job confinement, commit 4) implementation notes.**

*Zero-consumer proof (§3.3.1), pre-deletion — matched the spec's predicted hit set exactly, no surprises:*
```
rg -n 'canonicalTopologicalJobs|compareWorkflowSourceCodePoints|job-count-limit|missing-job-dependency|job-dependency-cycle|duplicate-job-dependency|exactly one source-IR job|Multi-job workflow cannot execute' src/

src/commands/lint/index.ts:34:import { compareWorkflowSourceCodePoints } from "../../workflows/source-ir/ordering";
src/commands/lint/index.ts:134:    .sort((left, right) => compareWorkflowSourceCodePoints(left.name, right.name))) {
src/commands/lint/index.ts:146:  return results.sort(compareWorkflowSourceCodePoints);
src/commands/lint/index.ts:178:  return { files: ownedFiles.sort(compareWorkflowSourceCodePoints), issues };
src/workflows/source-ir/ordering.ts:11:export function canonicalTopologicalJobs<T extends { id: string; needs: readonly string[] }>(
src/workflows/source-ir/ordering.ts:42:export function compareWorkflowSourceCodePoints(left: string, right: string): number {
src/workflows/source-ir/ordering.ts:47:  return compareWorkflowSourceCodePoints(left, right);
src/workflows/source-ir/schema.ts:41:import { canonicalTopologicalJobs, compareWorkflowSourceCodePoints } from "./ordering";
src/workflows/source-ir/schema.ts:471:  const result = canonicalTopologicalJobs(jobs);
src/workflows/source-ir/schema.ts:482:  return compareWorkflowSourceCodePoints(left, right);
src/workflows/freeze/source-freeze.ts:75:      "Multi-job workflow cannot execute until job boundaries and needs have a durable runtime representation.",
src/workflows/source-ir/github-yaml.ts:7:import { canonicalTopologicalJobs } from "./ordering";
src/workflows/source-ir/github-yaml.ts:466:    reader.fail("job-count-limit", "workflow.jobs must contain 1 through 256 jobs.", node);
src/workflows/source-ir/github-yaml.ts:469:  const ordered = canonicalTopologicalJobs(jobs);
src/workflows/source-ir/github-yaml.ts:473:      "missing-job-dependency",
src/workflows/source-ir/github-yaml.ts:479:    "job-dependency-cycle",
src/workflows/source-ir/github-yaml.ts:536:    reader.fail("duplicate-job-dependency", `Job ${jobId} has duplicate needs entries.`, pair.value);
src/workflows/ir/compile.ts:129:          message: "Current workflow execution requires exactly one source-IR job.",
```
Post-deletion sweep (§3.4 point 3/4) confirms zero live-code survivors: the same `rg` against `src/ tests/ scripts/ docs/ schemas/` plus a basename search for `ordering.ts` returns hits only in (a) `docs/plans/specs/p0-invariants.md`'s pinned P-08/R-05 rows (untouched, as required), (b) this spec's own §3/§7 prose describing the deletion, and (c) new explanatory comments this commit added in `src/workflows/source-ir/{github-yaml,compare}.ts` and `tests/workflows/source-ir-contract.test.ts` naming the deleted symbols for context.

*P4-N2 names two places beyond `source-freeze.ts` where "the same mapping is applied"; a THIRD exists and is necessary for row B-44 to hold on the path every flipped freeze-level test actually exercises.* `src/workflows/runtime/workflow-asset-loader.ts`'s `compileWorkflowSourceFromDisk` — not on Lane A's §6 file list — compiles a workflow's own source and throws a bare `UsageError` (implicit default code `INVALID_FLAG_VALUE`, `src/core/errors.ts:277`) on failure. `startWorkflowRun` (`src/workflows/runtime/runs.ts:289,294`) calls `loadWorkflowAsset` (which calls this) BEFORE it ever calls `compileResolveFreezeWorkflowV4` — so for the most common entry point, a multi-job document never reaches `source-freeze.ts`'s wrapper at all; it fails here first. This was discovered empirically, not by inspection: F-A3.2's flipped R-05(b) test ("throws COMPOSITION_INVALID wrapping the adapter's multi-job-unsupported rejection") failed with `INVALID_FLAG_VALUE` until this site got the identical two-arm P4-N2 mapping applied (message text is UNCHANGED — this site's own "Workflow source has N error(s):" framing is unrelated to `source-freeze.ts`'s "Workflow source cannot be frozen:" text, and no test pinned it; only the `UsageError` code argument changes). Touching this file is a necessary completion of the authorized P4-N2 mapping (B-44's own promise), not a new capability — recorded here per §0's "if preserving a behavior and implementing an authorized deletion appear to conflict, stop and record it" and the acceptance criteria's "every behavior difference observed during implementation that is not in §7 is recorded in the Review log and not silently absorbed."

*Six discovered test-level changes across two files, beyond F-A3.1–F-A3.7, added to §7.3 as rows F-A3.8–F-A3.11 (rule established by F-A1.19 and F-A3.7's own text: "any that asserts the old code or message FLIPs and is added to this table by the implementer, with the addition recorded in the Review log").* All six live in `tests/workflows/source-ir-contract.test.ts` (F-A3.8's three sub-parts, F-A3.9, F-A3.10) and `tests/integration/workflows/immutable-resolution-v4-red.test.ts` (F-A3.11) — files with 2+ inline `runs-on:` occurrences that a first-pass grep for the deleted symbol/message strings did not catch, because they asserted on job COUNT or ORDER outcomes, not the retired failure codes by name. Found by manually reading every test file with 2-or-more `runs-on:` occurrences project-wide (15 files matched that filter; every one besides these two was confirmed single-job-per-fixture, multiple fixtures per file) and every workflow YAML fixture under `tests/fixtures/execution-contracts/workflows/**` (all single-job, confirming F-A3.6 is the only fixture-family edit needed). F-A3.8(a) and F-A3.9 delete two tests whose entire subject (cross-job topological ordering, decoder idempotence across jobs) has no reachable input once a source is confined to one job — no equivalent exists to substitute, so nothing is silently lost, the capability itself is gone (row B-41). F-A3.10's `needs` sub-case preserves the still-reachable per-job needs-canonical-order check (`validateJob`'s own sort-order assertion, independent of job count) by moving its probe onto a single-job fixture. F-A3.11 is a plain message-regex flip, same root cause as F-A3.5.

*Deletion discipline, final check.* `ls src/workflows/source-ir/ordering.ts` → absent. `src/workflows/source-ir/compare.ts` exists, carries `compareWorkflowSourceCodePoints` body-identical, and both its importers (`schema.ts`, `commands/lint/index.ts`) repoint cleanly. `rg -n 'from "\.\./\.\./scripts|scripts/akm-migrate' src/` → zero (untouched by this family; carried from commit 3). `bunx tsc --noEmit`, `bunx biome check --write` on every touched file (no fixes applied — already clean), `bun run lint`, `bun run test:unit` (4213 pass / 0 skip / 0 fail, 315/315 files) and `bun run test:integration` (5825 pass / 57 skip / 1 fail, 438/438 files, AT THE TIME OF THIS COMMIT — the ONE failure is the `migration-help.test.ts` regression the Family A2 entry above now records as P4-introduced (commit `d24f432a`), corrected and fixed there — not this family's fault, and not pre-existing/unrelated as this entry's own git-blame check first assumed) all green except that one measured, since-fixed regression.

**2026-08-28 — Lane C (floors, terminal diagnostics ratchet, R-row dispositions, commit 9) implementation notes.**

*§5.2's re-coding sweep touches `src/` files §6's Lane C list does not name — recorded, not a lane-boundary violation.* §6's per-lane file lists are DISJOINT and, read naively, Lane C's list (`scripts/test-{unit,integration}.sh`, `tests/architecture/diagnostic-codes.test.ts`, `tests/architecture/task-fixture-vocabulary.test.ts`, `tests/contracts/ci-test-paths.test.ts`, `tests/integration/cli-errors.test.ts`, `.github/workflows/*.yml`, `docs/plans/specs/p0-invariants.md`) names no `src/` file at all. But §5.2 — governed entirely by commit 9 per the §0.2 ladder ("`test(p4): terminal diagnostics ratchet, v3 fixture ratchet, floors, and CI paths` | C | §5") — is an explicit, binding, per-file `UsageErrorCode` re-coding table spanning twelve `src/tasks/**` + `src/workflows/**` files, most of which Lane A's own §6 list also does not name (only `prepare.ts`, `prepare-support.ts`, `script-capture.ts`, `bounded-document.ts`, `scheduler-sync.ts`, `freeze-v4.ts`, and `source-freeze.ts` are on Lane A's list, and Lane A's own commits only partially executed the recode on those — see below). Precedent for touching a file beyond an authored §6 list when a later-numbered, binding spec section requires it is Lane A's own (`workflow-asset-loader.ts`, recorded in the Family A3 entry above). This entry does the same for §5.2's full table: `src/tasks/prepare/prepare-support.ts`, `src/tasks/prepare/prepare.ts` (the 2 sites §5.2 authorizes; see the P-04 deviation below for the 3rd), `src/tasks/prepare/script-capture.ts`, `src/tasks/source/bounded-document.ts`, `src/tasks/scheduler-sync.ts`, `src/workflows/source-files.ts`, `src/workflows/runtime/workflow-asset-loader.ts`, `src/workflows/ir/environment-v4.ts`, `src/workflows/freeze/environment.ts` (2 of 3; see the B-11 deviation below), `src/workflows/ir/freeze-v4.ts`, `src/workflows/freeze/resolve-steps.ts`, `src/workflows/freeze/identity.ts`. `src/workflows/freeze/source-freeze.ts` needed no edit — its two `INVALID_FLAG_VALUE` sites were already fully recoded (one GONE with §3.3, one via the P4-N2 mapping) by the time Lane A's commit 4 landed.

*Measured terminal count: 38, not §5.2's predicted 34 — three individually-recorded deviations, each a preservation-gate conflict the table's per-file dispositions did not anticipate.* Per §0's own rule ("if preserving a behavior and implementing an authorized deletion appear to conflict, stop and record it — preserving wins"):
  - `src/tasks/prepare/prepare.ts`'s workflow-target `env:` guard stays `INVALID_FLAG_VALUE` rather than the table's "3 → COMPOSITION_INVALID" (only the with-on-command and with-on-script guards recode). `tests/integration/tasks-with-classification-characterization.test.ts`'s P-04 block is dispositioned **CONVERT** by §7.2 F-A2.8 ("stays reachable and stays pinned") and §5.5's own P0 disposition table (appended to `p0-invariants.md` in this same commit) says P-04 is "PRESERVED... stays pinned" — CONVERT means assertions unchanged per §7's own legend. The test's title literally names the code ("throws UsageError INVALID_FLAG_VALUE").
  - `src/workflows/freeze/environment.ts`'s `resolveOwnedAsset` "Workflow source target ... was not found" throw stays `INVALID_FLAG_VALUE` rather than the table's flat "→ WORKFLOW_SOURCE_INVALID" for all 3 of this file's sites (only the other 2 recode). `tests/workflows/child-workflow-freeze.test.ts`'s B-11 case — "workflows/<ref> that does not resolve fails the existing asset-resolution failure, **unchanged in code and shape**" — pins this exact code by title; this file is one of §9's named-byte-unchanged preservation-gate suites.
  - `src/tasks/source/bounded-document.ts` carries one explanatory doc-comment line naming the retired code by string, to explain why the six front-end throws it sits beside (§5.2 row R-R8) now carry `TASK_SOURCE_INVALID` explicitly instead of the pre-P4 ratchet-gaming trick (an omitted `code` argument, relying on the `UsageError` constructor's `INVALID_FLAG_VALUE` default — `src/core/errors.ts:277` — specifically so the literal string stayed out of the grep-style count while the effective code stayed generic). This closes R-R8's gap for real (the code is now explicit and correct, not merely absent from the count) rather than perpetuating the trick.

  Both preservation-gate deviations were caught empirically, not by inspection: `bun run test:unit` failed once on `child-workflow-freeze.test.ts`'s B-11 case after the first full recode pass (`prepare-support.ts`/`prepare.ts`/`script-capture.ts`/`bounded-document.ts`/`scheduler-sync.ts`/`source-files.ts`/`workflow-asset-loader.ts`/`environment-v4.ts`/`freeze/environment.ts`/`freeze-v4.ts`/`resolve-steps.ts`/`identity.ts` all recoded per the table verbatim); the P-04 site was caught by grepping every touched message string against `tests/` before running the suite, specifically because §5.2's table is a table of *dispositions*, not a table of *verified-safe* dispositions — its own framing says so ("the implementer MEASURES and records deviations").

  12 (schedule.ts) + 10 (scheduler-binding.ts) + 7 (task-id.ts) + 2 (params.ts) + 2 (runs.ts) + 2 (attempt-lifecycle.ts: 1 membership entry + 1 pre-existing Lane B doc-comment line naming the term) = 35, + 1 (prepare.ts P-04) + 1 (freeze/environment.ts B-11) + 1 (bounded-document.ts comment) = **38**. `grep -rn "INVALID_FLAG_VALUE" src/tasks/ src/workflows/ | wc -l` confirms 38. `tests/architecture/diagnostic-codes.test.ts`'s baseline is hardcoded to this measured number, its comment rewritten to say TERMINAL (an increase is always a defect — P4 was the phase authorized to lower it by re-coding, and no more `rule a`/`rule b` survivors remain to convert), and its per-file breakdown documents all three deviations inline so a future increase past 38 is diagnosable from the test file alone.

*Row B-60's widened import-seam scan is implemented, not merely reserved.* The pre-P4 `importBindingsFrom` (named/default static imports, top-level only) is replaced by `moduleReferencesFrom`, a recursive AST walk (`ts.forEachChild`, not `source.forEachChild`) that additionally catches namespace imports (`import * as ns from "..."`), `export ... from` re-exports (both the `export *` and named-element forms), `import(...)` type queries (`ts.isImportTypeNode`, matching the `type T = import("module").Member` shape), and dynamic `import()` calls (a `CallExpression` whose callee `SyntaxKind` is `ImportKeyword`) — all checked ANYWHERE in the file, since a type query or dynamic import can appear nested inside an expression or type position, not only at the top level. Sanity-checked against six synthetic fixture files (one per evasion shape, plus a clean control) in a throwaway script before wiring it into the test — all six were correctly detected, the clean file correctly returned empty. Re-run against `semantics.ts`/`uses.ts`/`compile.ts`: still zero references to `tasks/source-v3` through any shape.

*Two DISCOVERED FLIPs, beyond §7's table, caused by the §5.2 recode and added here per the established rule (F-A1.19/F-A3.7's own text: "any that asserts the old code or message FLIPs ... recorded in the Review log").* Found by running the full suite after the recode, not by a pre-emptive grep of every possible consumer (§5.2's own table does not enumerate consuming tests the way §7 enumerates them for the deletion families):
  - `tests/integration/commands/workflow-cli-contract.test.ts` — "akm workflow refs — unknown bundles fail consistently" asserted `code: "INVALID_FLAG_VALUE"` for `akm workflow run/list/status ghost//missing`, which resolves through `workflow-asset-loader.ts`'s "Bundle ... was not found among configured sources" (now `WORKFLOW_SOURCE_INVALID` per §5.2's table — this site is NOT the same as the B-11-pinned `freeze/environment.ts` site above; different function, different preservation status). This file carries no "byte-unchanged" marker anywhere in §7 or §9; its own docstring frames it as a CLI-contract pin that tracks current behavior, not a characterization test. FLIPped to `WORKFLOW_SOURCE_INVALID`.
  - `tests/integration/workflows/workflow-source-collision.test.ts` — three `code: "INVALID_FLAG_VALUE"` assertions (a repeated-suffix alias rejection, and a symlink-format-mismatch rejection asserted twice — `loadWorkflowAsset` and `akmShowUnified`) resolve through `src/workflows/source-files.ts`'s `WorkflowSourceNameError`/`WorkflowSourceLinkIdentityError` (now `WORKFLOW_SOURCE_INVALID` per §5.2's table). Not named in §7 or §9. FLIPped, message assertions unchanged.

  Both files were re-run green after the flip; the full suite was re-run green after both (see the verification line below).

*CLI-envelope coverage (§5.2's closing instruction, R-R7) added for one code, investigated and found infeasible for two.* `tests/integration/cli-errors.test.ts` already carried `{ok:false,code}` + exit-2 coverage for `TASK_SOURCE_INVALID`, `TASK_SCHEMA_VERSION_UNSUPPORTED`, and `COMPOSITION_INVALID`; `WORKFLOW_SOURCE_INVALID` and `INPUT_BINDING_INVALID` already had equivalent coverage elsewhere at the same CLI/integration level (`tests/integration/workflows/workflow-source-collision.test.ts`, `tests/integration/commands/workflow-cli-contract.test.ts`, `tests/integration/commands/tasks-input-flags.test.ts`). Two codes had none:
  - `TARGET_REF_INVALID` — investigated first as the obvious gap (declared since P1a, zero integration-level hits by grep). A first attempt (a v4 task with `uses: nonsense/target`) measured `TASK_SOURCE_INVALID`, not `TARGET_REF_INVALID`: `classifyTargetRef`'s only two callers (`src/tasks/source/task-source-v4.ts`'s `parseTarget`, `src/workflows/source-ir/uses.ts`'s `classifyWorkflowSourceUses`) each immediately re-code its thrown `UsageError` before any CLI boundary — the task-source front end via `sourceError(ctx, ["uses"], cause.message)` (always `TASK_SOURCE_INVALID`), the workflow-compile front end via `usesFailure`'s `WorkflowSourceSemanticError` wrapping, itself later recoded onto `WORKFLOW_SOURCE_INVALID`/`COMPOSITION_INVALID` by the P4-N2 freeze-wrapper mapping. `TARGET_REF_INVALID`'s raw `.code` is therefore reachable only at the unit level (`tests/execution/target-ref.test.ts`), never through any live `akm` invocation today.
  - `TASK_TARGET_UNSUPPORTED` — its two live throw sites in `script-capture.ts`'s `scriptInterpreter` (added by this same recode) are structurally unreachable in this runtime: `SCRIPT_EXTENSIONS` (`src/core/recognition-util.ts`) and `SCRIPT_INTERPRETERS`'s key set (`script-capture.ts`) are the identical 16 extensions, so a script asset can only ever resolve (a prerequisite `resolveAssetPath` gate reached before `scriptInterpreter` runs) with an extension `scriptInterpreter` then accepts — the "no closed runtime interpreter" arm has no reachable input. The "requires Bun" arm's guard (`!process.versions.bun`) is always false under `bun test`.

  A fabricated assertion of an unreachable code would be worse than no coverage, so neither gets a test; both findings are recorded as a comment in `cli-errors.test.ts` itself (searchable at the point a future reader would look for exactly this coverage) rather than only here. Not silently absorbed, per the acceptance criteria's own rule.

*§5.3 test floors — RAISED, with the measured before/after and the deletion-family accounting the rule requires.* `bun run test:unit` at Lane C's head (after all of the above): **4213 pass / 0 skip / 0 fail** (was 4284/0 at P3a close-out per §5.3's own citation; P3b and P4's deletions net to a decrease here, expected — P4 §3 deletes whole suites). `bun run test:integration`: **5825 pass / 57 skip / 1 fail** (was 5760/57 at P3a close-out; the 1 fail is the `migration-help.test.ts` regression the Family A2 entry above records as P4-introduced by commit `d24f432a` and fixes — not pre-existing/out-of-scope as first recorded there; the fix does not change this floor computation, since `executed = pass + skip` excludes the failing test either way). P4-N5's formula, `floor(executed * 0.95 / 100) * 100` where `executed = pass + skip`:
  - unit: executed 4213 (0 skip). `floor(4213 * 0.95 / 100) * 100 = floor(40.0235) * 100` → **4000** (was 3500).
  - integration: executed 5882 (5825 + 57). `floor(5882 * 0.95 / 100) * 100 = floor(55.879) * 100` → **5500** (was 5000).

  Both floors RISE, as §5.3 predicts they must. Per-suite deleted-test accounting (whole-file deletions only; partial in-file deletions — `characterization-classification.test.ts`'s 7-test multi-job describe block (F-A3.1), `tasks-with-classification-characterization.test.ts`'s P-01/P-02 blocks (F-A2.8), `tasks-runner.test.ts`/`tasks-cli-envelope.test.ts`'s disabled-dispatch cases (F-A2.17/F-A2.18), and others — reduced the surviving files' own counts but are not separately tabulated below, since the table's unit is "a file §7 deleted," not "a test §7 deleted"). Counts below are `test(`/`it(` top-level declaration counts read from the pre-deletion commit (`git show 09691628^:<path> | grep -cE '^\s*(test|it)\('`) — an approximation that does not expand `test.each` rows into their per-row count, so it understates true executed-test totals for the 2 files that use `test.each` (noted); where the spec's own AUTHORIZED-FLIPS table already states a test count, that number is used instead and matches this method's count independently:

  | File | Test count (method) | Family / row |
  |---|---|---|
  | `tests/tasks/source-v3.test.ts` | 14 declarations (+4 `test.each` blocks, unexpanded) | commit 3 (Family A2), F-A2.1 — DELETE, subject is the deleted v3 parser |
  | `tests/tasks-runtime-v3.test.ts` | 8 | commit 3 (Family A2), F-A2.2 — DELETE, subject is the deleted `runtime-v3.ts` shim |
  | `tests/tasks/parse-v3-adapter.test.ts` | 9 | commit 3 (Family A2), F-A2.3 — DELETE, subject is the deleted `parse-v3-adapter.ts` |
  | `tests/integration/tasks-scheduler-sync-v3.test.ts` | 23 (+3 `test.each` blocks, unexpanded) | commit 3 (Family A2), F-A2.6 — DELETE, subject is v3 scheduler sync (spec text independently states "23 tests") |
  | `tests/integration/tasks-scheduling-characterization.test.ts` | 3 | commit 3 (Family A2), F-A2.7 — DELETE, all three are R-06, resolved by deletion (spec text independently states "all three tests") |

  Every deleted `.test.ts` file above is confirmed absent (`ls` → not found); `tests/fixtures/execution-contracts/tasks/v3-migration/**` (8 fixtures + manifest, F-A2.25) is also gone but is fixture data, not a `.test.ts` file, so it contributes no count to either floor.

*§5.4 — the v3-fixture inventory ratchet was already at its verified-accurate terminal state; only its header needed closing.* `tests/architecture/task-fixture-vocabulary.test.ts`'s `ALLOWED_EXACT_FILES` was NOT further trimmed in this commit: it was already narrowed, file by file, as Lane A's commits 2–4 landed (each commit had to keep this ratchet green, since it runs under `bun run test:unit`), and the ratchet was measured GREEN (0 offenders, 0 stale entries) before this commit touched it at all. Row B-59's own summary text ("terminal: ... exact files [the three migrator suites] and nothing else") is imprecise against the verified-accurate boundary: roughly a dozen exact-file entries beyond the three migrator suites remain, each with its own dated citation to a specific §7.2 F-A2.x row, and each is a test whose SUBJECT is proving `src` correctly REJECTS a v3/v2 document (`TASK_SCHEMA_VERSION_UNSUPPORTED`, the migrate-hint text, the version-routing table) — a claim exactly as permanent as the frozen migrator's own conversion claim, needing exactly as genuine a v3 fixture. Trimming these to match the summary row's literal "and nothing else" would delete the only regression coverage for CHANGELOG.md's "Task v3 sources no longer parse" breaking-change entry (§4.6) — precisely the outcome this ratchet exists to prevent, not a legitimate tightening. This is a recorded, reasoned deviation from a summary table cell in favor of the empirically-verified boundary and the underlying per-file §7.2 dispositions, the same posture the P-04/B-11 deviations above take. The file's header comment is rewritten to mark the sweep TERMINAL and to state this reconciliation explicitly, so a future reader does not chase the summary row's smaller number.

*§5.5 — the P0 Review log's final entry is appended to `docs/plans/specs/p0-invariants.md`, prose-only, no pinned row edited* — §5.5's disposition table (R-01…R-09, P-01…P-08) verbatim, plus two observed-not-asserted notes tying P-04 and R-08's "PRESERVE forever" dispositions to what this same commit's own §5.2 sweep actually measured (both held).

*Verification, this commit, final state.* `bunx tsc --noEmit` clean throughout every edit in this entry. `bunx biome check --write src/ tests/` — 2 files reformatted (line-wrap only, on `bounded-document.ts` and `workflow-asset-loader.ts`; content diff confirmed unchanged by `git diff` before/after). `bun run lint` exit 0 (every named sub-check reports OK; the ~1400 biome warnings surfaced are pre-existing repo-wide `noNonNullAssertion` style warnings in files this commit does not touch, e.g. `scripts/lint-doc-examples.ts`, `tests/workflows/unit-checkin.test.ts` — not a P4 concern, not fixed here). `bun run test:unit`: **4213 pass / 0 skip / 0 fail**, 315/315 files. `bun run test:integration`: **5825 pass / 57 skip / 1 fail**, 438/438 files, AT THE TIME OF THIS COMMIT — the one failure is the `migration-help.test.ts` regression the Family A2 entry above measures as P4-introduced (base `0f16f70fdc61`: 12 pass / 0 fail; P4 head before the fix: 11 pass / 1 fail) and fixes, not a pre-existing/out-of-scope defect as first recorded there. Both new floors (4000, 5500) clear against these executed counts regardless (the floor formula excludes fail counts). `tests/contracts/ci-test-paths.test.ts` green with no edit — verified none of the five CI-named suites (`semantic-search-e2e`, `docker-install`, `linux-standalone-scheduler`, `native-scheduler`, `workflow-release`) were touched by any P4 family, and all five files still exist. No `.github/workflows/*.yml` edit was needed for the same reason.

**2026-08-28 — Final close-out: review scope verdicts, gate summary, and the 25-criteria acceptance sweep.**

This entry closes Lane D (commit 10, §10). It records, in order: (1) the
verdicts of the two scoped adversarial reviews run against the full P4
diff, what each found, and what landed to fix it; (2) the residual
advisory-tier findings neither review's follow-up commits touched,
auto-adjudicated here per §0.3; (3) a freshly re-run gate summary at final
HEAD; and (4) the full 25-criteria acceptance sweep (§10, Lane D's own
report), appended verbatim below as §10.3, independently spot-checked
before appending.

### Review scope verdicts

Two independent scoped adversarial reviews ran against the complete P4
diff before this close-out. Both are stored in full under
`/root/.claude/projects/-home-user-akm/ab1e859c-154d-5696-a33a-d338372a4c43/scratch/`
(`p4-review-deletions.findings.md`, `p4-review-closeout.findings.md`) and
are summarized here so every finding's disposition is visible in this file,
not only in a scratch directory outside the repo.

**Scope 1 — deletion completeness & safety** (reviewer lane (a)-(h) of §3;
range `0f16f70fdc61..HEAD` at review time). Verified CLEAN: the §9
file-absence gate, every deleted path accounted for by a §6/§7 row, the §9
grammar/symbol greps, the frozen migrator (P4-N1), all 10 shipped task-v4
assets, `akm task add`'s v4 authoring, the `TASK_SCHEMA_VERSION_UNSUPPORTED`
migrate hint, and every named preservation-gate suite (54 pass / 0 fail).
Seven findings — four CONFIRMED-and-required, one CONFIRMED-and-shared with
Scope 2, two ADVISORY:

| # | Finding | Verdict | Disposition |
|---|---|---|---|
| F1 | `task-result.ts:finishDisabledTask` (+ its sole helper, the `"disabled"` `TaskRunStatus` member, and `exitCodeForStatus`'s dead arm) was dead code left behind when P4-N6 deleted its only caller | CONFIRMED | **FIXED** — `9902d86b` deletes all four |
| F2 | The task-v3 `akm:` options-bag grammar (`AKM_KEYS`, `parseAkm`, the "exactly one scheduling source" rejection) survived P4-N3's re-home into `src/workflows/source-ir/triggers.ts`, unreachable from the one production caller | CONFIRMED | **FIXED** — `9902d86b` deletes it per §3.2.3's own "DELETE, except the parts `classifyTaskV3Triggers` needs" instruction; narrows `checkKeys` to `["on"]`; makes §5.5's R-06 disposition true of the code, not just the retired grammar |
| F3 | The bounded-document front end's hostile-input/resource-bound suite (Proxy, prototype, cycle, depth, byte-bound, hostile-YAML — 7 cases incl. a 5-row `test.each`) was deleted along with `tests/tasks/source-v3.test.ts`, but its actual subject (`bounded-document.ts`) survived and is still routed through by the v4 parser, leaving it with zero regression coverage | CONFIRMED | **FIXED** — `9902d86b` ports the block into `tests/tasks/bounded-document.test.ts` against the v4 entry points |
| F4 | `src/tasks/source-v3.ts` carried a dead `export { UsageError }` (plus its now-solely-supporting import), added during the file's shrink purely to silence biome, with zero importers anywhere | CONFIRMED | **FIXED** — `9902d86b` deletes both |
| F5 | Five exports lost their last external importer to a Lane-A-deleted shim and were neither deleted nor named in a commit body, as §3.4 step 5 requires (`ReadHistoryOptions`, `INVALID_TASK_ATTEMPT_ID`, `ResolvedWorkflowSourceV4`, `yamlAstError`/`yamlProblem`/`TASK_V3_MAX_JSON_DEPTH`/`TASK_V3_MAX_JSON_NODES`/`TASK_V3_MAX_OBJECT_KEYS`, `buildArtifactSummary`) | ADVISORY | **RECORDED, NOT FIXED — auto-adjudicated below.** Re-verified still present at final HEAD. |
| F6 | Four comments in surviving modules still describe a deleted file in the present tense (`tasks/model/definition.ts`, `tasks/runner.ts`) | ADVISORY | **RECORDED, NOT FIXED — auto-adjudicated below.** Re-verified still present at final HEAD. |
| F7 | Required ADR `0006-task-source-version-routing.md` was never authored; the ADR-index README links to a nonexistent file and the pre-P4 routing reasoning it was to carry is gone from the code it once lived in | CONFIRMED (= Scope 2 Finding 2, one shared fix) | **FIXED** — `f9ea73b8` authors the ADR with the pre-P4 three-generation routing table and both recorded warts verbatim, plus removal dates; updates the README index row |

**Scope 2 — docs/ledger truth, net-LOC, STABILITY, driver-protocol, ADRs,
floors, lint-doc-examples** (range `0f16f70fdc61..HEAD`, 14 commits, at
review time). Verified CLEAN: the driver-protocol decision record and its
three zero-hit greps, `STABILITY.md`'s tier index, all ten ADRs' in-code
invariant backlinks, both test floors' arithmetic, `lint-doc-examples`, and
the migration guide's ten-section structure. Ten findings, all CONFIRMED
and required (Finding 2 = Scope 1's F7, one shared fix), plus three
advisories:

| # | Finding | Verdict | Disposition |
|---|---|---|---|
| 1 | §4.3's net-LOC checkpoint section was never written — `docs/plans/0.9.2-architecture-deletion-audit.md`'s Size checkpoint was still citing a stale `origin/main` baseline from before P3a/P3b/P4 | CONFIRMED | **FIXED** — `5393e1ca`, §4.3's four required items, all measured at that commit |
| 2 | ADR `0006` indexed but the file did not exist (= Scope 1 F7) | CONFIRMED | **FIXED** — `f9ea73b8` (shared fix) |
| 3 | `bun run check` was RED at HEAD: `migration-help.test.ts` was a P4-introduced regression (commit `d24f432a` rewrote the string the test pinned), twice misrecorded in this Review log as pre-existing via a `git blame`-on-the-assertion check that cannot detect a doc-content regression | CONFIRMED | **FIXED** — `f9ea73b8` fixes the assertion and replaces all four false Review-log provenance claims with the measured base-vs-HEAD result |
| 4 | The migration guide's GitHub-locator "0.9.2" error block quoted a task-v3 parser message (`classifyTaskV3Uses`'s, deleted from `src/` by §3.2) under a workflow-step heading | CONFIRMED | **FIXED** — `120e1c0b` replaces it with the message `target-ref.ts:targetRefInvalid` actually emits (row B-05), pinned byte-exact by `tests/execution/target-ref.test.ts` |
| 5 | CHANGELOG + migration guide both claimed `INVALID_FLAG_VALUE` no longer appears in task/workflow domain failures at all; two deliberate preservation-gate survivors (Lane C's P-04/B-11 deviations) contradict it | CONFIRMED | **FIXED** — `120e1c0b` names both exceptions in both docs, matching the measured 38-site terminal count |
| 6 | CHANGELOG claimed the published task schema is a two-arm `oneOf`; it is single-arm at HEAD | CONFIRMED | **FIXED** — `120e1c0b` rewrites the bullet |
| 7 | CHANGELOG's child-workflow entry still advertised task-wrapped composition "from either a v3 or v4 task" and benchmarked new behavior against a removed `version: 3` task target | CONFIRMED | **FIXED** — `120e1c0b`, matching the fix `7a7013b5` had already applied to `docs/reference/workflow-schema.md` |
| 8 | `docs/reference/workflow-schema.md` still said multi-job documents are "dependency-validated, indexed, and displayable" — the pre-P4, display-only-core-behavior description brief §10 and §3.3 exist to delete — directly contradicting its own "`jobs:` must contain exactly one job" bullet three lines above | CONFIRMED | **FIXED** — `120e1c0b` deletes the stale sentence |
| 9 | Release notes and CHANGELOG presented `{from: "params.<name>"}` as a usable reference form without R-R16's unreachability caveat (already applied to the long-form guide by `2329715c`) | CONFIRMED | **FIXED** — `120e1c0b` adds the caveat to both |
| 10 | The D8 `target.kind` vocabulary break — including its one-way `targetVocab: 2` mixed-fleet ordering constraint — was a CHANGELOG Breaking entry with zero coverage in the migration guide or release notes | CONFIRMED | **FIXED** — `120e1c0b` adds a migration-guide section, a release-notes paragraph, and a "Before you upgrade" checklist item |
| A1 | The deletion audit's "Target architecture" and "Kept boundaries" sections (outside §4.3's named scope) still describe the pre-refactor world (task v3, plan IR v4) | ADVISORY | **RECORDED, NOT FIXED — auto-adjudicated below.** Re-verified still present at final HEAD. |
| A2 | The migration guide's hand-off to `tasks.md`'s correct R-R13 documentation mislabels the trap as "the 'no document-level enabled' trap" (a different subject) rather than naming it | ADVISORY | **RECORDED, NOT FIXED — auto-adjudicated below.** Re-verified still present at final HEAD. |
| A3 | Process note: the §0.2 commit ladder ran out of its binding order (Lane B's docs commits 5-8 landed before Lane A's deletion commits 3-4), the single root cause of Findings 4-8 | ADVISORY (process) | **CLOSED — historical.** No standing defect once Findings 4-10 are fixed; recorded as a lesson for future phases, not an action item. |

Combined: **14 distinct CONFIRMED findings** across both scopes (Scope 1's
F1-F4 and F7, Scope 2's Findings 1, 3-10, with F7/Finding-2 counted once),
covered by four follow-up commits (`9902d86b`, `f9ea73b8`, `120e1c0b`,
`5393e1ca`) whose commit-message numbering (findings 1-15, two of which —
5 and 15 — share one fix) reconciles exactly against this table. **All 14
are re-verified FIXED at this entry's own re-check of final HEAD**, not
merely trusted from the fix commits' own claims:
`ls docs/architecture/decisions/0006-task-source-version-routing.md`
(6865 bytes, present); the rewritten `## Size checkpoint` section read in
full from `docs/plans/0.9.2-architecture-deletion-audit.md`; zero hits for
the two-arm-`oneOf` / "from either a v3 or v4" / `version: 3\` task target`
phrasings in `CHANGELOG.md`; zero hits for "dependency-validated, indexed"
in `docs/reference/workflow-schema.md`; `tests/integration/migration-help.test.ts`
folded into the full green `test:integration` run below. **Four items stay
open — F5, F6, A1, A2, all ADVISORY-tier, none CONFIRMED —** adjudicated
next.

### Residual advisories — auto-adjudicated per §0.3, recorded and left open

§0.3 caps this mechanical phase at `MAX_REVIEW_ROUNDS = 2` with
auto-adjudication on budget exhaustion: "if the last round's fixes were
applied and its own findings were the sole basis of an abort flag, log the
adjudication in the Review log and **proceed**." Round 1 (the two scoped
reviews above) is exhausted; every CONFIRMED, required finding it raised is
fixed and re-verified. No round 2 ran, and none is needed: the four
remaining items are all ADVISORY-tier by the reviewing agents' own
classification, none is cited by either review as blocking, and each is
adjudicated individually below rather than silently dropped (§12's own
closing acceptance criterion: "every behavior difference observed during
implementation that is not in §7 is recorded in the Review log and **not**
silently absorbed").

- **F5 — five orphaned exports.** `src/tasks/run/task-history.ts`'s
  `ReadHistoryOptions`, `src/tasks/run/attempt-lifecycle.ts`'s
  `INVALID_TASK_ATTEMPT_ID`, `src/workflows/freeze/source-freeze.ts`'s
  `ResolvedWorkflowSourceV4`, `src/tasks/source/bounded-document.ts`'s
  `yamlAstError`/`yamlProblem`/`TASK_V3_MAX_JSON_DEPTH`/`TASK_V3_MAX_JSON_NODES`/`TASK_V3_MAX_OBJECT_KEYS`,
  and `src/workflows/exec/step-work.ts`'s `buildArtifactSummary` all lost
  their last importer outside their own module when a Lane A shim was
  deleted, and none was named in the deleting commit's body as §3.4 step 5
  requires. Adjudicated **non-blocking**: every symbol is still used inside
  its own module (only the `export` keyword, not the code, is dead), each
  file is used correctly and completely by its live consumers, dropping the
  keyword is a zero-behavior biome-safe cleanup, and §0 forbids "improving"
  anything on the way past that §7 does not name — deleting five unrelated
  `export` keywords now is exactly that kind of drive-by. Named here per
  F5's own offered resolution ("list them in the Review log with the reason
  they stay exported"), which discharges §3.4 step 5's disjunctive
  requirement retroactively. Carried to a future housekeeping pass, not to
  0.9.2's release blockers.
- **F6 — four stale present-tense comments.** `tasks/model/invocation.ts:25`
  ("`src/tasks/model/definition.ts` is unchanged"), `task-source-v4.ts:240`
  (a file:line citation into the same deleted file), `task-result.ts:13`
  ("the compat shim (`src/tasks/runner.ts`) re-exports"), and two
  present-tense mentions of `tasks/runner.ts` in
  `workflow-cli.ts`/`abort-deadline.ts` all cite files P4 deleted.
  Adjudicated **non-blocking**: these are prose citations with no
  behavioral weight — nothing reads or resolves them at runtime — and a
  stale file:line pointer in a comment is a documentation nit, not a
  correctness or completeness defect. Carried to the same future
  housekeeping pass as F5.
- **A1 — the deletion audit's "Target architecture" / "Kept boundaries"
  sections are stale** (task v3, plan IR v4 language, outside §4.3's four
  named items). Adjudicated **non-blocking** on the reviewing agent's own
  terms: "outside the letter of P4's charter." §4.3's actual four required
  items (Size checkpoint, per-family deletion table, honest net-positive
  statement, Active-audit close-out) are all fixed and verified above;
  these two sections were never in scope, and correcting them is a
  legitimate, low-cost future cleanup rather than a P4 obligation.
- **A2 — the migration guide's R-R13 hand-off mislabels the trap it points
  to.** `docs/reference/tasks.md#typed-inputs-and-output` documents R-R13's
  actual trap (a `required: true` input with no default failing every
  scheduled run) correctly and completely — confirmed by both this review
  and the earlier closeout review's own "Verified CLEAN" section. The one
  open item is that the migration guide's *inline* sentence names the wrong
  clause when it hands the reader to that correct documentation. Adjudicated
  **non-blocking**: §8 R-R13's binding requirement — "§4.7's migration
  guide must document the trap" — is met by the correct target document;
  this is a cross-reference wording polish, not a missing disclosure.

None of F5, F6, A1, or A2 falsifies any sentence of §12's acceptance
criteria at final HEAD; all four are appropriate candidates for a routine
post-0.9.2 documentation-and-lint pass alongside R-R1/R-R20's
already-deferred rename (§8).

### Gate summary — final, all green

Independently re-run at this entry's own HEAD (`5393e1ca` — this append is
docs-only and changes nothing that would move it):

```
$ bunx tsc --noEmit
(exit 0, no output)

$ bun run lint
lint-tests-isolation: OK
MPL-2.0 header present in all 651 src/**/*.ts files.
lint-runtime-boundary: OK
lint-write-source-chokepoint: OK
lint-secret-resolver-boundary: OK
lint-execution-boundary: OK
lint-process-argv: OK
lint-repository-sql: OK
lint-goldens-presence: OK — 51 designated golden asset(s) present
lint-golden-captured-at-head: OK — 13/17 judged pins resolve; 4 unjudged (shallow clone)
lint-shipped-assets: OK - 0 dead type:name ref token(s)
lint-doc-examples: OK - 0 doc-example violations found.
schemas/akm-config.json is up to date.
lint-active-docs-terminology: OK - 0 "stash" terminology violations across 91 active doc file(s).
Found 1397 warnings.   <- pre-existing repo-wide noNonNullAssertion style
Found 2 infos.             notices in files P4 did not touch; exit 0
(exit 0)

$ bun run test:unit
── unit: 4 shards over 315 files
── unit: 4227 pass / 0 skip / 0 fail across 4 process-shards (315/315 files)

$ bun run test:integration
── integration: 4 shards over 438 files
── integration: 5826 pass / 57 skip / 0 fail across 4 process-shards (438/438 files)
```

`bun run check` (lint && `tsc --noEmit` && test:unit && test:integration)
is **green** — every named check passes, zero test failures across 753
executed files (315 unit + 438 integration). The unit count (4227) is 14
above Lane C's own recorded 4213 and the acceptance sweep's own citation,
matching exactly the net new tests Scope-1 F3's port added (`9902d86b`,
landing after both Lane C's floor commit and the sweep's run); the unit
floor (4000) and the integration floor (5500) both clear with room, as
§5.3 predicts they must once §7's whole-file deletions are the only
floor-relevant change. This closes out the one gate that was genuinely RED
mid-phase (Scope 2 Finding 3, `migration-help.test.ts`, live between
commits `d24f432a` and `f9ea73b8`) — confirmed green at every commit from
`f9ea73b8` onward, and, independently, right now at final HEAD.

Also re-verified directly in this entry, not merely inherited from the
sweep: every §9 grammar/symbol/machinery grep (`github-action`,
`remote-action-acquisition`, `isGithubLocatorShape`, `GITHUB_OWNER`,
`parseTaskV3Yaml`, `parseTaskV3Document`, `classifyTaskV3Uses`,
`TASK_V3_SCHEMA_VERSION`, `canonicalTopologicalJobs`, `job-count-limit`,
`missing-job-dependency`, `job-dependency-cycle`,
`duplicate-job-dependency`, `exactly one source-IR job`, `Multi-job
workflow cannot execute`) returns only historical prose or the frozen
migrator's own vendored copy, never live `src/` grammar; every §6 DELETE-list
file (`runtime-v3.ts`, `runner.ts`, `ir/source-freeze-v4.ts`,
`source-ir/ordering.ts`, `source/parse-v3-adapter.ts`, `model/definition.ts`,
`model/schedule.ts`) is absent; `src/` imports nothing from `scripts/`
(the two live `scripts/akm-migrate*` references in
`migration-tool.ts` are a spawn-path `new URL(...)`/`fileURLToPath(...)`
construction, not an `import` statement); `^version: 3` fixtures are
confined to the two migrator-input directories; the driver-protocol greps
(`brief.ts|report.ts`, `experimental.workflowEngine`) are zero;
`git diff 0f16f70fdc61..HEAD -- src/cli/shared.ts` is empty (`EXIT_CODES`
byte-unchanged); and `WORKFLOW_IR_V5_VERSION` is still `5`.

### §12 acceptance checkboxes — final disposition

All 17 checkboxes in §12 below (Structure, Behavior, Close-out) are ticked
at their original location in this document, on the evidence assembled
above plus §10.3's sweep appended next. None is unmet at final HEAD. The
one item worth flagging explicitly rather than silently ticking: §9's
separate "green at every commit in §0.2" gate (not itself a §12 checkbox)
was briefly violated between `d24f432a` and `f9ea73b8` (Scope 2 Finding 3)
— corrected, and green at every commit from `f9ea73b8` onward and at final
HEAD, which is what §12's own undated `bun run check` criterion asks for.

### The 25-criteria acceptance sweep (§10, Lane D's report — appended as §10.3)

Produced by the report-only Lane D sweep agent per §10.1's protocol,
walking all 25 criteria of §10.2 against final HEAD (`5393e1ca`).
Spot-verified independently in this entry — the DELETE-list `ls`, the
grammar/symbol/machinery greps, `EXIT_CODES`, `WORKFLOW_IR_V5_VERSION`, and
the full gate run above all reproduce the sweep's own citations — before
being appended below exactly as produced. Only its Markdown heading levels
are nested one level deeper (`##`→`###`, `###`→`####`) to sit inside this
Review log entry; no wording, table, code block, or citation was altered.

### 10.3 The acceptance sweep (Lane D, report-only)

Run at `5393e1ca` (head of `claude/breaking-changes-0-9-2-3cfyvp`, commits 2-9 plus
the review-round fix commits all landed). Base for all diffs:
`origin/release/0.9.2` = `2aaaf98d`. Protocol per §10.1: verdict, a runnable
citation, one sentence of what it proves, and for anything short of MET, exactly
what remains. §8's `RECORDED, NOT FIXED` rows are surfaced under the criterion
they bear on.

---

#### 1. AKM still uses its native workflow engine with no new external runtime dependency. — **MET**

**Citation.**
```
$ git diff origin/release/0.9.2...HEAD -- package.json
(no output — the file is byte-identical)
$ rg -n 'experimental\.workflowEngine|workflowEngine' src/     -> exit 1, zero hits
$ rg -n 'brief\.ts|report\.ts' src/workflows/exec/             -> exit 1, zero hits
$ rg -n 'from "\./native-executor"' src/
src/workflows/exec/run-workflow.ts:39:} from "./native-executor";
```
`package.json`'s `dependencies` are unchanged across the entire refactor
(`@clack/prompts`, `@huggingface/transformers`, `@opencode-ai/sdk`, `citty`,
`dotenv`, `fast-xml-parser`, `node-html-parser`, `semver`, `turndown`, `yaml`,
`zod` — the same 11, no additions), and `src/workflows/exec/run-workflow.ts` still
reaches exactly one executor module, so the 328-file diff bought child workflows
and bindings without an engine or a runtime dependency.

---

#### 2. Existing command, shell, script, retry, gate, worktree, and resume behavior remains intact. — **MET**

**Citation.**
```
$ bun test tests/contracts/resolved-execution-contract.test.ts \
    tests/contracts/command-invocation-contract.test.ts \
    tests/contracts/command-execution-preparation.test.ts \
    tests/contracts/execution-cascade-resolver.test.ts \
    tests/contracts/engine-lowering-conformance.test.ts --timeout=120000
160 pass / 0 fail / 1888 expect() calls  (5 files)

$ bun test tests/integration/workflows/run-lease.test.ts \
    tests/integration/workflows/chaos.test.ts \
    tests/integration/workflows/worktree-concurrency.test.ts \
    tests/integration/workflow-worktree-leftovers.test.ts \
    tests/integration/workflows/gate-artifacts.test.ts \
    tests/integration/workflows/run-controls.test.ts \
    tests/integration/workflows/native-executor.test.ts --timeout=120000
130 pass / 0 fail / 854 expect() calls  (7 files)

$ git diff --numstat 0f16f70fdc61..HEAD -- <each of the 11 files above>
(no output for any of them — all byte-unchanged across every P4 commit)
```
All eleven suites are green AND byte-unchanged across the whole of P4 (base
`0f16f70f`, P3b's last commit, to head), so command/shell/script preparation,
retry and gate artifacts, worktree lifecycle and lease-based resume all pass
against assertions P4 never touched — the strongest available form of "intact",
since the tests could not have been bent to fit.

---

#### 3. A workflow task call can no longer silently discard `with`. — **MET**

**Citation.** `src/workflows/freeze/targets/task.ts:noDeclaredInputsError` +
`src/workflows/freeze/targets/task.ts:taskDispatch`:
```ts
function noDeclaredInputsError(stepId: string, ref: string): UsageError {
  return new UsageError(
    `Workflow step ${stepId} cannot pass with: to task target ${ref}; ${ref} declares no inputs.`,
    "COMPOSITION_INVALID",
  );
}
...
if (source.with !== undefined && contract === undefined) {
  throw noDeclaredInputsError(source.id, refInput);
}
```
```
$ bun test tests/workflows/with-rejection.test.ts \
    tests/workflows/task-input-bindings.test.ts \
    tests/workflows/characterization-with-drop.test.ts --timeout=120000
42 pass / 0 fail
```
Both halves are closed: an authored `with:` on a target with no `inputs:` throws
`COMPOSITION_INVALID` on **any** shape including `{}` (the guard is
`!== undefined`, pinned by `with-rejection.test.ts:"B-03: an empty with: {}
mapping rejects identically to a non-empty one"`), the rejection fires even when
the ref is unresolvable so it cannot be lost behind an asset error
(`:"B-02b: the with: rejection fires before resolveOwnedAsset"`), and when the
target DOES declare `inputs:` the mapping is bound rather than dropped
(`task-input-bindings.test.ts`) — so there is no path left on which a `with:` is
accepted and ignored.

---

#### 4. Tasks can exist and compose without schedule metadata. — **MET**

**Citation.** `src/tasks/source/task-source-v4.ts:parseSchedule` /
`parseTaskSourceV4Document`:
```ts
if (!own(input, "schedule")) return Object.freeze([]);
...
schedule,
manualOnly: schedule.length === 0,
```
`tests/tasks/source-v4.test.ts:"absent schedule: parses as valid, manual-only,
and akm task sync's projection input (B-06, D2-N6)"` pins *exists*;
`tests/workflows/task-input-bindings.test.ts`'s `tasks/nightly-v4.yml` and
`tasks/no-inputs-v4.yml` fixtures (both `version: 4` with no `schedule:` key)
are composed from workflow steps throughout that suite, pinning *composes*.
The old grammar that forced the choice is gone: §3.2's parser deletion took
`akm.schedule` and a task's top-level `on:` with it, and the v4 parser now
rejects an `on:` key outright (`task-source-v4.ts`: `"is removed in task source
v4; declare a top-level schedule: instead."`).

**Carried advisory surfaced here per §10.1 — R-R13 (RECORDED, NOT FIXED).**
A `required: true` input with no `default:` makes every *scheduled* run fail at
dispatch, with no parse-time or `akm task sync`-time warning. It does not bear
on this criterion's own claim (it is a scheduled-task trap, not a
schedule-less-task one) and P4 declined to fix it because a new diagnostic is
new behavior. §4.7's documentation obligation IS discharged:
`docs/migration/v0.9.1-to-v0.9.2.md` (Typed `inputs:` bullet) names "the
'no document-level enabled' trap for a `required: true` input with no default
on a scheduled task" and links `docs/reference/tasks.md#typed-inputs-and-output`.

---

#### 5. CLI, scheduler, and workflow calls use one task-invocation resolver. — **MET**

**Citation.** `src/tasks/prepare/prepare.ts:prepareTaskV3Execution` is the only
exported task-invocation resolver, reached by every invocation path:
```
$ rg -n 'prepareTaskV3Execution' src/ --glob '!**/*.md' | rg -v '^\S+:\d+: \*|//'
src/tasks/run/load-task.ts:116          <- CLI:       akm task run
src/tasks/scheduler-sync.ts:524         <- scheduler: akm task sync
src/workflows/freeze/targets/task.ts:143<- workflow:  uses: tasks/<ref> composition
src/commands/tasks/tasks.ts:197         <- CLI:       akm task add (authoring validation)
src/tasks/prepare/prepare.ts:42         <- the definition
```
```
$ bun test tests/tasks/prepare-split.test.ts --timeout=120000
4 pass / 0 fail
```
`prepare-split.test.ts` pins each caller's context shape by name
(`:"run/load-task.ts's context shape…"`, `:"scheduler-sync.ts's context
shape…"`, `:"workflows/freeze/targets/task.ts's context shape…"`) and
`:"does not exist — every caller is rewired to prepare/prepare.ts directly"`
pins that `src/tasks/runner.ts`'s re-export shim is gone, so no caller reaches
the resolver through an alias. Upstream of it, `parseTaskSource` is likewise the
one version router and now has a single accepted version (§3.2), so the four
paths share both the parse and the resolve step.

**Two observations that do not change the verdict, recorded so a reviewer does
not read them as drift.**
1. §10.3's starting point says "three callers"; there are now **four** — `akm
   task add` (`src/commands/tasks/tasks.ts:akmTasksAdd`) prepares the document
   it just authored as a write-time validation. That is a fourth *caller of the
   one resolver*, which is what the criterion asks for, not a fourth resolver.
2. `akm task explain` (`src/commands/tasks/explain.ts`) deliberately does NOT
   call it — its module header states it never resolves or executes — and
   reaches provenance through `parseTaskSource` + `projectTaskSourceV4` +
   `prepareResolvedExecution` instead. Explain is not an invocation, so this is
   by design, not a second invocation path.

---

#### 6. Typed task inputs support defaults, validation, literals, and explicit workflow references. — **MET WITH CAVEAT**

**Citation.** All four capabilities exist and three of four are reachable from
authored source:

| Capability | Symbol | Reachable? |
|---|---|---|
| defaults | `src/execution/input-contract.ts:applyInputDefaults` | yes |
| validation | `src/execution/input-contract.ts:validateInputs` (+ `materializeInputFlags` for the CLI coercion) | yes |
| literals | `src/workflows/freeze/task-bindings.ts:normalizeOneEntry` — `return Object.freeze({ kind: "literal", name, value })` | yes |
| references — `{from: "steps.<id>.output…"}` | `normalizeOneEntry`'s `parsed.expr.kind === "stepOutput"` arm, gated on `earlierStepIds` | yes |
| references — `{from: "params.<name>"}` | `normalizeOneEntry`'s `declaredParamNames` arm | **no — unauthorable** |

```
$ bun test tests/workflows/task-input-bindings.test.ts \
    tests/integration/workflows/task-binding-resolution.test.ts \
    tests/integration/workflows/task-inputs-delivery.test.ts --timeout=120000
42 pass / 0 fail
```
`task-input-bindings.test.ts:"B-14: a {from: steps.<id>.output.<path>} with:
value freezes to a kind:reference binding naming the parsed reference"` proves
the reachable reference form end to end; `:"B-16c: {from: \"steps.x\"}
(incomplete reference grammar) is rejected, never reinterpreted as a literal"`
proves the literal/reference discrimination is fail-closed.

**Caveat — R-R16 (§8, RECORDED, NOT FIXED), independently re-verified here.**
The `{from: "params.<name>"}` arm is dead at authoring time, and I confirmed the
mechanism rather than taking the advisory's word for it:
- `src/workflows/freeze/step-values.ts:declaredParamNames` reads
  `sourceIr.params`, which only `src/workflows/source-ir/compile.ts` populates —
  from `parsed.document.params`, i.e. the **Markdown** front end's front-matter.
- `rg -n '\bparams\b' src/workflows/source-ir/github-yaml.ts` → **zero hits**:
  the GitHub-YAML front end, the only one that can author `uses: tasks/<ref>`,
  has no `params:` surface at all.
- `src/workflows/source-ir/compile.ts:markdownStep` can only ever emit
  `uses: "akm/command"` (hardcoded in its return), `exec`, or `run` — a Markdown
  step cannot name a task target.

So no document can simultaneously declare `params:` and compose a task with a
`with:`. `tests/integration/workflows/task-binding-resolution.test.ts` already
carries an in-code note to the same effect.

**What remains (imperative).** Either open a `params:` authoring surface on the
GitHub-YAML front end in `src/workflows/source-ir/github-yaml.ts` so the arm
becomes reachable, or delete the `declaredParamNames` arm from
`src/workflows/freeze/task-bindings.ts:normalizeOneEntry` and its
`declaredParamNames` plumbing in `src/workflows/freeze/step-values.ts`. Both are
behavior changes and are correctly out of P4's charter; `docs/migration/v0.9.1-to-v0.9.2.md`
discharges §8's documentation obligation by stating that
`{from: "steps.<id>.output…"}` is the reachable reference form today.

---

#### 7. Task inputs are attached as structured context and are not interpolated into arbitrary prose. — **MET**

**Citation.** Two delivery channels, both append-only and both structured:
- command targets — `src/workflows/exec/step-work.ts:buildUnitPrompt`:
  ```ts
  ? `\n\n## Task inputs\nThe composed task's declared inputs resolved to:\n\`\`\`json\n${canonicalInputJson(taskInputs)}\n\`\`\``
  ```
  a fenced JSON block **appended** to the authored prose — no template token, no
  `${...}` splice into the prose body.
- shell/script targets — `src/workflows/exec/step-work.ts:buildExecContextEnv`:
  ```ts
  if (ctx.taskInputsJson !== undefined) env.AKM_TASK_INPUTS = ctx.taskInputsJson;
  ```
  exactly one env var carrying canonical JSON, never per-input vars.

```
$ bun test tests/integration/workflows/task-inputs-delivery.test.ts --timeout=120000
10 pass / 0 fail
```
The suite pins both the structure and the non-interpolation directly:
`:"the assembled prompt carries the resolved inputs as a fenced JSON block; the
composed command's authored prose survives byte-exact; the bound value is never
spliced into prose"` (B-38/B-N2), and
`:"a shell-target (run:/shell:) task receives AKM_TASK_INPUTS with the exact
canonical JSON, and no per-input var exists under any spelling"` (B-35), whose
assertion is a set equality against an empirical baseline
(`expect(boundAkmNames.sort()).toEqual([...baselineAkmNames, "AKM_TASK_INPUTS"].sort())`)
— so a leaked per-input variable under any name would fail. The empty case is
pinned too: `:"the target declares no inputs: at all — the prompt has no '## Task
inputs' heading, and the authored prose is byte-unchanged"` (B-39), meaning the
attachment is absent rather than an empty stub when there is nothing to attach.

---

#### 8. Effective task inputs participate in durable execution identity. — **MET WITH CAVEAT**

**Citation.** `src/workflows/exec/step-work.ts:computeUnitInputHash`, the whole
preimage:
```ts
createHash("sha256")
  .update("akm.workflow.unit\0v6\0")
  .update(canonicalJsonString({
    hashVersion: 6, role: "unit",
    stepId, nodeId, template, item,
    inputs: ctx.resolvedInputs,
    params: ctx.input.params,
    frozenTarget: ctx.target,        // <- carries the frozen `inputBindings`
    environment, schema, isolation, ...gateFeedback,
  }))
```
```
$ bun test tests/workflows/task-binding-identity.test.ts --timeout=120000
3 pass / 0 fail
```
`frozenTarget` is the frozen dispatch target and carries
`inputBindings?: readonly TaskInputBinding[]`
(`src/workflows/ir/schema-v4.ts:93/104/121/146`), so:
- a **`{kind:"literal"}`** binding's `value` is inside the preimage — its
  effective value *is* its frozen value, so literals fully participate;
- absence-when-empty is identity-preserving, pinned by
  `task-binding-identity.test.ts:"a task-composing step whose target declares no
  inputs: at all, with no with:, freezes a target with no OWN inputBindings key"`,
  so adding the feature did not perturb the identity of unbound steps;
- freeze is deterministic over bindings, pinned by `:"two independent freezes of
  the same with:-bound task-composing step produce byte-identical plan hashes
  and unit input hashes"`.

**Caveat — R-R15 (§8, RECORDED, NOT FIXED; the spec calls it "the most
consequential open item on the branch"). Independently confirmed here.**
A `{kind:"reference"}` binding contributes only its **authored shape**
(`{kind, name, from, schema}`) to the preimage, never its **resolved value**.
The resolution happens first — `step-work.ts:398`,
`const taskInputsResolution = resolveTaskInputBindings(...)` — and its output is
on the very context object the hash function receives
(`ctx.taskInputs`, set at `step-work.ts:494`, read at `:581` by
`computeUnitInputHash(ctx, item)`), yet the preimage at `:677` does not read it.
So two runs of the same plan in which an earlier step's output differs compute
the **same** unit input hash, and a resumed run can reuse a unit whose bound
value is stale. For reference bindings the criterion's word "effective" is not
satisfied.

**What remains (imperative).** Add `ctx.taskInputs` (or equivalently
`taskInputsJson`) to the preimage object in
`src/workflows/exec/step-work.ts:computeUnitInputHash` and bump the unit/gate
`hashVersion` from 6 to 7 (`akm.workflow.unit\0v7\0`,
`akm.workflow.gate\0v7\0`) with the corresponding plan-compatibility handling.
P4 correctly did not do this: §0 declares a P4 commit that changes
`hashVersion` "a review-blocking violation", and §4.7's migration guide carries
the resume caveat instead.

---

#### 9. Task output contracts are enforced consistently. — **MET**

**Citation.** One declaration site, one definition checker, one value validator.

*Declaration* — `src/tasks/source/task-source-v4.ts:parseOutputSchema` is the
single bounded `output:` key that replaced v3's `akm.outputSchema`:
```ts
const schema = asRecord(value, ctx, ["output"]);
const issue = checkJsonSchemaDefinition(schema as Record<string, unknown>)[0];
if (issue) sourceError(ctx, ["output"], `is not a supported JSON schema: ${issue.message}`);
```

*Definition checking is shared with the workflow side* —
`src/core/json-schema.ts:checkJsonSchemaDefinition` has exactly four callers,
covering both domains:
```
src/tasks/source/task-source-v4.ts:457   (task inputs + output)
src/workflows/source-ir/schema.ts:740    (workflow source schemas)
src/workflows/parser.ts:1470             (markdown workflow schemas)
```

*Value validation is likewise shared* —
`src/core/json-schema.ts:validateJsonSchemaSubset` is called from
`src/workflows/exec/step-work.ts:869` (a step unit's evidence against
`plan.outputSchema`), `src/workflows/exec/native-executor.ts:1331`,
`src/workflows/runtime/run-outputs.ts:100` (a workflow's declared `outputs:`),
and `src/execution/input-contract.ts:129` (task inputs) — one implementation,
never a per-domain reimplementation.

*The task's declaration reaches both execution paths from the same field* —
`src/tasks/source/project-v4.ts`: `if (document.output !== undefined)
out.outputSchema = document.output;`, which then lowers into a direct engine
dispatch (`src/integrations/agent/execution-lowering.ts:735`
`chatOptions.responseSchema = request.outputSchema`) and into the frozen unit
for a workflow-composed task (`src/workflows/freeze/targets/command.ts:92`,
`...(request.outputSchema ? { output: request.outputSchema } : {})`).

```
$ bun test tests/tasks/source-v4.test.ts tests/workflows/workflow-outputs-source.test.ts --timeout=120000
114 pass / 0 fail
```
`source-v4.test.ts:"a malformed output schema is TASK_SOURCE_INVALID, re-rooted
at 'output' (not 'akm.outputSchema')"` pins the fail-closed definition check and
the single-key vocabulary; `:"output: is optional; absent leaves doc.output
undefined"` pins that undeclared means unenforced rather than a defaulted stub.

---

#### 10. Direct workflow references and task-wrapped workflow references lower to the same child-workflow target. — **MET**

**Citation.** `src/workflows/freeze/targets/child-workflow.ts:childWorkflowDispatch`
is one resolver with exactly two callers, one per authoring form:
```
$ rg -n 'childWorkflowDispatch' src/
src/workflows/freeze/resolve-steps.ts:29        <- direct: uses: workflows/<ref>
src/workflows/freeze/targets/task.ts:173        <- task-wrapped: uses: tasks/<ref> whose own target is a workflow
src/workflows/freeze/targets/child-workflow.ts:177  <- the definition
```
The two forms differ only by a discriminant the resolver takes as a parameter
(`readonly via: "direct" | "task"`, plus `taskRef` present only when
`via === "task"`), and both are inside the target's own content hash
(`childWorkflowContentHash({ ref, planHash, via, taskRef, inputBindings })`), so
the distinction is durable rather than erased.

```
$ bun test tests/workflows/child-workflow-freeze.test.ts \
    tests/workflows/child-workflow-dispatch-guard.test.ts \
    tests/workflows/child-output-references.test.ts \
    tests/workflows/child-invocation-key.test.ts \
    tests/workflows/plan-v5-schema.test.ts --timeout=120000
37 pass / 0 fail
```
The criterion is pinned literally by
`child-workflow-freeze.test.ts:"a direct step and a task-wrapped step composing
the same child with the same effective params freeze to structurally equal
child-workflow targets — only via/taskRef (and contentHash, whose preimage
covers them) differ"`, with the two shapes independently asserted at
`expect(target).toMatchObject({ kind: "child-workflow", via: "direct" })` and
`... via: "task" })`.

---

**Criteria 11–16 share one suite run.** All citations below draw on:
```
$ bun test tests/workflows/child-workflow-freeze.test.ts \
    tests/workflows/child-workflow-dispatch-guard.test.ts \
    tests/workflows/child-invocation-key.test.ts \
    tests/workflows/plan-v5-schema.test.ts \
    tests/workflows/child-output-references.test.ts --timeout=120000
37 pass / 0 fail

$ bun test tests/integration/workflows/child-freeze-read-set.test.ts \
    tests/integration/workflows/child-cancellation.test.ts \
    tests/integration/workflows/status-tree.test.ts \
    tests/integration/storage/child-run-publication.test.ts \
    tests/integration/workflow-child-crash-windows.test.ts \
    tests/integration/workflows/child-nesting.test.ts --timeout=120000
47 pass / 0 fail
```

#### 11. Child plans are frozen before parent publication. — **MET**

**Citation.** `src/workflows/runtime/runs.ts:startWorkflowRun` orders the two
operations unambiguously — `compileResolveFreezeWorkflowV4(asset, loadConfig())`
at `runs.ts:294`, `repo.publishWorkflowRunV4({...})` at `runs.ts:349` — and the
child's plan is embedded *in the parent's frozen plan*, not fetched later:
`src/workflows/ir/schema-v4.ts:454` decodes a child-workflow target's fields as
`["kind","ref","planHash","frozenPlan","contentHash","via","taskRef","inputBindings"]`.
`child-workflow-freeze.test.ts:"B-04: a direct uses: workflows/<ref> step freezes
to a child-workflow target with the embedded frozen child plan and its planHash"`
proves the embedding, and `:"B-09: with: naming an undeclared child param fails
INPUT_BINDING_INVALID at freeze, before publication"` proves the ordering is
load-bearing — a composition error is raised while nothing durable has been
written.

#### 12. Child source edits cannot alter an in-flight parent run. — **MET**

**Citation.** `tests/integration/workflows/child-freeze-read-set.test.ts` closes
both windows:
- after publication —
  `:"re-reading the stored run's plan_json shows the ORIGINAL child content,
  byte-identical, not the edited one"` (B-06): the parent replays from its own
  embedded copy, so an edit is simply not consulted;
- between freeze and publication —
  `:"revalidate() (the same call publishWorkflowRunV4 runs first, inside
  IMMEDIATE, before any write) throws once the child has been mutated"` and
  `:"publishing through the real repository call with that same
  revalidateSources writes NO run row"` (B-07): the source-CAS check runs inside
  the publication transaction before any write, so a mid-flight edit aborts
  publication rather than producing a run bound to source nobody froze.
The read set that CAS covers is transitive, pinned by
`:"child doc + its direct command ref + its task ref's OWN command ref all
appear as relative paths"` (B-05) — an edit to a grandchild command is caught
too, not just the child document.

#### 13. Parent-child run creation is idempotent across crash windows. — **MET**

**Citation.** `src/storage/repositories/workflow-runs-repository.ts:publishChildWorkflowRun`,
keyed on `(parentRunId, invocationKey)`. Idempotency is pinned at three levels:
- repository — `tests/integration/storage/child-run-publication.test.ts:"a second
  call with the same (parentRunId, invocationKey) returns the SAME child row —
  no second insert, event, or step set"` (C-08), plus `:"the loser reads the
  winner's row — never a duplicate row, never a thrown conflict"` (C-09) and
  `:"recognizes a winner row it did not insert itself — no second insert, no
  second event"`;
- real crash windows — `tests/integration/workflow-child-crash-windows.test.ts:"CW-1
  (C-01): SIGKILL as soon as the child row is published → resume finds it by
  invocation_key, no duplicate child, no duplicate workflow_started event"`,
  `:"CW-2 (C-02): SIGKILL mid-child-unit-dispatch → both runs resumable; resume
  re-dispatches ONLY the interrupted child unit, once"`, and `:"CW-3 (C-03):
  SIGKILL after the child completes but before the parent's composing unit
  finalizes → resume completes the parent WITHOUT re-running the child"`;
- genuine process contention — `:"two genuinely concurrent publishers racing the
  identical (parentRunId, invocationKey) converge on one child row, one
  workflow_started event, and the same returned id"` (C-04).
The key itself is stable and versioned (`akm.workflow.child-invocation\0v1\0`),
pinned by `tests/workflows/child-invocation-key.test.ts`.

#### 14. Parent cancellation propagates to the child. — **MET**

**Citation.** `tests/integration/workflows/child-cancellation.test.ts`:
- `:"A-28: the child drive returns ok: false, failureReason 'aborted', once the
  signal fires mid-drive"` — an explicit parent `AbortSignal` reaches the child;
- `:"A-30: the heartbeat's lost-lease abort cascades into the child; the parent
  rejects loudly (assertAlive); the child is left resumable"` — the *implicit*
  cancellation (parent loses its run lease) propagates too, which is the harder
  half;
- `:"A-29: after the abort, the child's own lease is released and the child run
  stays active (resumable)"` — propagation cancels the *drive*, it does not
  orphan or corrupt the child run, which is what makes criterion 15 hold after a
  cancellation.

#### 15. Parent and child runs are independently resumable and clearly linked. — **MET**

**Citation.** *Independently resumable*:
`child-cancellation.test.ts:"A-29: … the child run stays active (resumable)"`
and `workflow-child-crash-windows.test.ts:"CW-2 … both runs resumable; resume
re-dispatches ONLY the interrupted child unit, once"`; a child blocked on its
own gate carries its own resume instruction —
`status-tree.test.ts:"B-35: a blocked child carries a resume {command, then}"`.
*Clearly linked*: `status-tree.test.ts:"a parent with one child gains children:
[...] carrying the documented shape, ordered by created_at then id"` (B-34) and
`:"children nest recursively — depth of the rendered tree equals composition
depth"` (B-37) for a 3-level tree, with `:"B-38: a children: block renders after
steps:, one glyph-prefixed line per child"` for the text renderer. The link is
additive, not a reshaping of the existing contract:
`:"the JSON envelope carries no children key, and the text renderer's line shape
is exactly today's"` (B-33, PRESERVE) and `:"akm workflow list on a childless
scope carries no parentRunId/spawnedByUnitId/outputs on any run"` (B-45).

#### 16. Composition cycles fail before durable mutation. — **MET**

**Citation.** `tests/workflows/child-workflow-freeze.test.ts`'s "composition
bounds" describe block — every one of these is a **freeze-time** rejection, and
freeze precedes publication (criterion 11):
- `:"B-20: a direct self-reference (A -> A) fails COMPOSITION_INVALID naming the
  cycle path"`;
- `:"B-21: an indirect cycle (A -> B -> A) fails COMPOSITION_INVALID naming
  A -> B -> A"`;
- `:"B-22: a task-mediated cycle (A -> tasks/w -> B -> A) fails
  COMPOSITION_INVALID, the reported path naming the intermediate task ref"` —
  the cycle detector sees through the task indirection, which is the case a
  per-form check would miss;
- the neighbouring bounds fail the same way and at the same moment:
  `:"B-18: a composition chain 9 levels deep … fails COMPOSITION_INVALID naming
  the depth limit and the ref path"` and `:"B-24: aggregate embedded child plan
  bytes over the 1 MiB cap fails COMPOSITION_INVALID naming the cap, the running
  total, and the child that crossed it"`;
- and the detector is not over-eager: `:"B-23: the same workflow reached twice on
  disjoint branches (a diamond) is not a cycle and freezes, each occurrence
  embedding its own copy"`.

---

#### 17. No internal path fabricates YAML to reuse another parser. — **MET**

**Citation.** `src/tasks/prepare/prepare-script-target.ts:prepareScriptTarget`
replaced `directScript`'s synthetic-task-YAML fabrication, and
`tests/workflows/direct-script-typed.test.ts` guards it with a **source-text
scan over every file under `src/`**, not a single-file check — the distinction
its own header calls out, because a one-file assertion would only prove the
fabrication moved:
```
$ bun test tests/workflows/direct-script-typed.test.ts --timeout=120000
7 pass / 0 fail
```
- `:"the literal fabricated schedule string is absent from every file under src/"`
- `:"the synthetic 'version: 3' task-document template is absent from every file under src/"`
- `:"the fabricated fragment filePath fed to parseTaskV3Yaml is absent from every file under src/"`
- `:"directScript's body contains no parseTaskV3Yaml(...) call and does contain a prepareScriptTarget(...) call"`
- `:"taskDispatch (the same file, unrelated to R-02) still legitimately resolves a real document via resolveTaskForComposition -> parseTaskSource(...)"`
  — the positive control, so the scan cannot pass by having deleted real parsing too.

Independently re-run outside the suite:
```
$ rg -Fn 'schedule: "@daily"' src/     -> exit 1, zero hits
```
P4 strengthened this structurally rather than merely leaving it green: the
parser the fabrication existed to reach (`parseTaskV3Yaml`) no longer exists in
`src/` at all (§3.2), so the class of defect is now unreachable, not just
unrepresented.

**Two `version: N` literals in `src/` that are NOT fabrication, checked so a
reviewer does not misread the grep.**
- `src/tasks/source/project-v4.ts:93` — `version: 3,` is a TypeScript object
  **discriminant** on the prepare seam's `PreparableTaskDocument`, never
  serialized to YAML and never parsed. §3.2.7 authorizes exactly this and §0/R-R1
  defers renaming the type family.
- `src/commands/tasks/tasks.ts:1526` — `{ version: 4 }` in `renderTaskYaml` is
  `akm task add` **authoring the user's real file**, which is then re-read
  through the one router (`parseTaskSource`, `tasks.ts:194`) as write-time
  validation. Synthesizing the artifact a command exists to create is not
  fabricating input to borrow a parser.

---

#### 18. Native target classification contains no GitHub Action variant. — **MET**

**Citation.** All three classification unions are now four-way, with no
`github-action` member:
```ts
// src/execution/target-ref.ts  (the shared classifier)
export type TargetRefKind = "command" | "script" | "task" | "workflow";

// src/tasks/source-v3.ts        (the prepare seam's document vocabulary)
export type TaskV3UsesTarget =
  | Readonly<{ kind: "builtin-command"; ref: "akm/command" }>
  | Readonly<{ kind: "command" | "workflow" | "script"; ref: string }>;

// src/workflows/source-ir/uses.ts
export type WorkflowSourceUsesTarget =
  | { readonly kind: "command" | "script" | "task" | "workflow"; readonly ref: string }
  | { readonly kind: "builtin-command"; readonly ref: "akm/command" };
```
```
$ rg -n '"github-action"' src/     -> exit 1, zero hits (no arm, no discriminant)
$ rg -n 'githubActionRef' schemas/ src/  -> exit 1, zero hits (the JSON Schema definition and both $refs are gone)
$ bun test tests/execution/target-ref.test.ts \
    tests/workflows/characterization-classification.test.ts \
    tests/workflows/source-ir-contract.test.ts --timeout=120000
68 pass / 0 fail
```
§9's broader gate grep
(`rg -n 'github-action|remote-action-acquisition|isGithubLocatorShape|GITHUB_OWNER' src/ schemas/`)
is not literally empty, and I checked every surviving hit rather than treating
the gate as failed:
- `src/workflows/source-ir/uses.ts:22`, `src/tasks/source/task-source-v4.ts:16/214/216/217`
  — **comments** stating the absence (`"has no github-action member, typed or
  …"`); prose, not grammar;
- `src/tasks/source/task-source-v4.ts:260` — the **B-11 upgrade-helpfulness
  message**, which §3.1.3 explicitly preserves ("Task source v4's own B-11
  message" is on the do-not-touch list);
- `schemas/akm-task.json:5` — the root `description` telling an upgrader "there
  is no github-action uses: target".
`remote-action-acquisition`, `isGithubLocatorShape` and `GITHUB_OWNER` return
zero hits of any kind. So the gate's intent — no live grammar — holds; only its
literal string form catches the sentences announcing the deletion.

---

#### 19. Workflow source classification no longer depends on the task source parser. — **MET WITH CAVEAT**

**Citation — the criterion itself holds.** `src/workflows/source-ir/semantics.ts:classifyWorkflowStepUses`
takes its classifier as a parameter defaulting to the workflow-side one:
```ts
classifier: WorkflowSourceUsesClassifier = classifyWorkflowSourceUses,   // semantics.ts:112
target = classifier(value);                                             // semantics.ts:128
```
`classifyWorkflowSourceUses` (`src/workflows/source-ir/uses.ts:60`) delegates to
the shared `classifyTargetRef`, never to a task-source parser. Neither
`compile.ts` nor `uses.ts` imports anything from `src/tasks/**` at all
(`rg -n 'from ".*tasks' src/workflows/source-ir/compile.ts` → exit 1), and the
ratchet confirms it:
```
$ bun test tests/architecture/diagnostic-codes.test.ts --timeout=120000
2 pass / 0 fail
```
`tests/architecture/diagnostic-codes.test.ts:"semantics.ts, uses.ts, and
compile.ts reference nothing from tasks/source-v3 (named, namespace, re-export,
import-type, or dynamic import)"` — and row B-60's widening is real, not
reserved: the helper is `moduleReferencesFrom`, a recursive AST walk covering
namespace imports, `export … from`, `ImportTypeNode` queries and dynamic
`import()`.

**Caveat 1 — §3.2.3's stronger stated outcome is not true at head, and the
ratchet does not enforce it.** §3.2.3 asserts: "After this, `src/workflows/**`
imports nothing at all from `src/tasks/**` source modules — §5.2's seam
assertion tightens to the empty list for all three files." Neither half holds:
```
$ rg -n 'from ".*tasks/' src/workflows/source-ir/
src/workflows/source-ir/semantics.ts:11:import { parseSchedule } from "../../tasks/schedule";
src/workflows/source-ir/triggers.ts:67:} from "../../tasks/source/bounded-document";
```
`src/workflows/source-ir/triggers.ts` — the file §3.2.3 itself created to
re-home the trigger classifier — imports eleven symbols
(`asRecord`, `BoundedDocumentContext`, `checkKeys`, `cloneBoundedJson`,
`noGithubExpression`, `own`, `presentJsonValue`, `sourceError`, `stringField`,
`TASK_V3_MAX_SCHEDULES`, `ExecutionJsonObject`) from
`src/tasks/source/bounded-document.ts`, a module literally under
`src/tasks/source/`. And `src/workflows/source-ir/compile.ts:20` imports
`classifyWorkflowYamlTriggers` from `./triggers`, so **workflow source
compilation transitively depends on the task-source bounded-document front
end**. (`semantics.ts`'s `parseSchedule` import is from `src/tasks/schedule.ts`,
the cron module — not a source module — so that one is consistent with the
claim.)

This does not falsify the criterion: `bounded-document.ts` is the shared bounded
YAML/field-reading layer, not the task **parser** — the v3 grammar
(`parseTaskV3Yaml`, `classifyTaskV3Uses`) is genuinely gone from `src/`
(§9 gate G2 returns only comments). But the seam is weaker than the spec says it
is, and nothing detects a regression.

**Caveat 2 — the seam scan's file set and specifier were never widened to match
the re-home.** The assertion still scans exactly `semantics.ts`, `uses.ts`,
`compile.ts` for exactly the specifier `"tasks/source-v3"`. `triggers.ts` — now
part of the classification path — is not scanned at all, and the specifier the
dependency actually uses (`tasks/source/bounded-document`) is not checked
anywhere.

**What remains (imperative).** In
`tests/architecture/diagnostic-codes.test.ts`, add
`src/workflows/source-ir/triggers.ts` to the scanned file set and assert against
the `tasks/source/` prefix (not just `tasks/source-v3`), then either (a) hoist
the bounded-document primitives `triggers.ts` needs into a
domain-neutral module such as `src/core/bounded-document.ts` that both
`src/tasks/source/` and `src/workflows/source-ir/` import, or (b) amend
`docs/plans/specs/p4-deletions-closeout.md` §3.2.3's "imports nothing at all
from `src/tasks/**` source modules" sentence to name the one intended exception
and say why. Neither is a P4 deletion, so leaving it is defensible — but leaving
the spec's claim unqualified and the ratchet unwidened is not.

---

#### 20. The task runner no longer mutates global process environment state. — **MET**

**Citation.** §10.3's two named greps, plus a deliberately broader one I ran to
make sure the property is not merely true for the one variable P1b removed:
```
$ rg -n 'process\.env\.AKM_EVENT_SOURCE\s*=' src/            -> exit 1, zero hits
$ rg -n 'delete process\.env\.AKM_EVENT_SOURCE' src/         -> exit 1, zero hits
$ rg -n 'process\.env\.[A-Za-z_]+\s*=[^=]|delete process\.env' src/tasks/ src/workflows/
                                                             -> exit 1, zero hits
```
No assignment to, and no deletion of, ANY `process.env` key anywhere under
`src/tasks/**` or `src/workflows/**` — so this is a structural property of both
domains now, not a single patched call site.

The replacement mechanism is explicit threading: provenance travels as
`ExecutionProvenanceContext` (`src/tasks/model/invocation.ts`, the one member of
the task model that P4 §3.2.7 deliberately kept) and is stamped into the
**child's** env at spawn
(`src/commands/command/command-execution.ts:157`:
`return { ...rest, eventSource: process.env.AKM_EVENT_SOURCE ?? eventSource };`
— a read of the ambient value, never a write).

```
$ bun test tests/integration/tasks-provenance-context.test.ts \
    tests/integration/tasks-provenance-characterization.test.ts \
    tests/workflows/unit-dispatch-event-source.test.ts --timeout=120000
43 pass / 0 fail
```
`tasks-provenance-context.test.ts:"an explicit provenance.eventSource reaches
runWorkflowSteps's eventSource option, and process.env is never mutated"` asserts
the non-mutation directly, and `:"a pre-set ambient AKM_EVENT_SOURCE still wins
over an explicit non-default provenance.eventSource"` proves the runner reads
the ambient value rather than overwriting it. The repo-wide harness backstops
this independently: `tests/_preload.ts`'s tripwire **throws** if any test leaks
an `AKM_*` env var that was not present at preload, so a reintroduced mutation
would fail the whole suite, not just this one.

---

#### 21. Runtime vocabulary no longer exposes `stash` or mislabels commands as prompts. — **MET WITH CAVEAT**

**The `prompt` half — fully MET.**
```
$ rg -n '"prompt"' src/tasks/ src/workflows/
src/tasks/run/run-command-task.ts:20:  * — formerly `{kind:"prompt", engine}`.        (comment)
src/tasks/run/task-history.ts:25/27:                                              (comments)
src/tasks/run/task-history.ts:141:      case "prompt":                           (the D8 legacy READ mapping)
```
The only live occurrence is `task-history.ts:141`'s `case "prompt":`, which is
row B-51's PRESERVE surface — it reads rows written by every previous release
and deleting it is a review-blocking violation. Nothing **writes** `"prompt"` as
a result kind (row B-52 proven by the same grep); the written vocabulary is
`{kind:"command", engine}` / `{kind:"shell"}`
(`src/tasks/run/run-command-task.ts`). The legacy mapping's own tests are
byte-unchanged per §9.

**The `stash` half — one deliberate survival (fine) and one real leak (not).**

*Deliberate and authorized:* `src/tasks/run/load-task.ts:46`
`export const DEFAULT_BUNDLE_NAME = "stash";` — row B-48, user on-disk data
compatibility. §4.1's first proof holds exactly as written:
```
$ rg -n '"stash"' src/tasks/ src/workflows/ src/execution/ src/commands/tasks/
src/tasks/run/load-task.ts:44:  * `"stash"` became this at the P1b runner.ts split.   (comment)
src/tasks/run/load-task.ts:46:export const DEFAULT_BUNDLE_NAME = "stash";
```
`src/indexer/**` is out of scope by row B-50, recorded since P0.

*The leak.* §4.1's second proof — row B-49, "`rg -n 'stashDir' src/tasks/
src/workflows/ src/commands/tasks/` returns zero hits" — **is false at head**:
```
$ rg -n 'stashDir' src/tasks/ src/workflows/ src/commands/tasks/ | wc -l
34
```
Most are internal local variable names, but one reaches the user:
```ts
// src/workflows/authoring/authoring.ts:64
export function createWorkflowAsset(input: {...}): { ref: string; path: string; stashDir: string; }

// src/commands/workflow-cli.ts:168
output("workflow-create", { ok: true, ...result });
```
so **`akm workflow create` emits a `stashDir` key in its JSON envelope** — live
runtime vocabulary exposing `stash`, on a Stable-tier command. Row B-49's own
narrow claim (that `RunTaskOptions` carries no legacy alias) IS true —
`src/commands/tasks/tasks.ts:329` passes `bundleDir: stashDir` — but the grep the
spec offers as its proof does not prove it, and the wider property the criterion
states is not achieved.

P4 could not have fixed this without a lane violation: `src/workflows/authoring/**`
and `src/commands/workflow-cli.ts` are on **no** lane's §6 file list, and §4.8
forbids Lane B any signature change. So this is correctly *not* P4 work — but it
is unfinished work, and §4.1 states it as done.

**What remains (imperative).** (1) Rename the `stashDir` member of
`createWorkflowAsset`'s return type in `src/workflows/authoring/authoring.ts` to
`bundleDir` and update `src/commands/workflow-cli.ts:168`'s envelope, treating
it as a documented breaking change to the `akm workflow create --json` shape
(add a CHANGELOG entry — `akm workflow *` is **Stable** in `STABILITY.md`).
(2) Correct row B-49 / §4.1 in
`docs/plans/specs/p4-deletions-closeout.md` so the grep it publishes matches the
claim it makes — today a reviewer running the stated command sees 34 hits and
cannot tell whether the phase failed or the proof was mis-specified.

**Adjacent finding, same family — a shipped user-facing asset still teaches the
deleted task v3 vocabulary.** Not `stash`/`prompt`, so it does not change this
criterion's verdict, but it is a vocabulary close-out miss and nothing in the
repo detects it:
```
$ rg -n 'task v3|version: 3|akm\.enabled|akm\.timeout' src/assets/
src/assets/hints/cli-hints-full.md:369:Task files use strict task v3 (`version: 3`). To disable one, set
src/assets/hints/cli-hints-full.md:370:`akm.enabled: false` and run `akm task sync`
src/assets/hints/cli-hints-full.md:372:`akm task sync` — the scheduler entry is unbound. Per-task `akm.timeout` may
```
This file is embedded into the binary
(`src/output/cli-hints.ts:14`, `import EMBEDDED_HINTS_FULL from
"../assets/hints/cli-hints-full.md" with { type: "text" }`), so the CLI now
instructs users to author `version: 3` documents that fail with
`TASK_SCHEMA_VERSION_UNSUPPORTED`, and to set an `akm.enabled: false` key P4-N6
deleted. Neither lint catches it: `scripts/lint-shipped-assets.ts` scans
`src/assets` but only for dead `type:name` ref tokens, and
`scripts/lint-active-docs-terminology.ts`'s `SCAN_FILES`/`SCAN_DIRS` cover only
`README.md`, `.github/README.npm.md`, `docs/README.md` and four `docs/`
subtrees — never `src/assets`.
**What remains (imperative).** Rewrite `src/assets/hints/cli-hints-full.md`'s
task paragraph for task source v4 (`version: 4`, `schedule[].enabled`,
top-level `timeout:`, and `akm migrate apply` for task-v2 **and** task-v3), and
add `src/assets/**` to `scripts/lint-active-docs-terminology.ts`'s scan roots so
the next grammar deletion cannot leave a shipped hint stale.

---

#### 22. Domain failures use stable, phase-specific diagnostic codes. — **MET WITH CAVEAT**

**Citation.** All six D7 codes are declared on the one union and carry usage
hints — `src/core/errors.ts:UsageErrorCode`:
```
102:  | "COMPOSITION_INVALID"     106:  | "TASK_SOURCE_INVALID"
111:  | "TARGET_REF_INVALID"      114:  | "WORKFLOW_SOURCE_INVALID"
117:  | "INPUT_BINDING_INVALID"   128:  | "TASK_TARGET_UNSUPPORTED"
```
and the exit-code contract is untouched, as D7 requires:
```
$ git diff 0f16f70fdc61..HEAD -- src/cli/shared.ts | wc -l
0
```
The ratchet is genuinely terminal and self-documenting:
`tests/architecture/diagnostic-codes.test.ts` — `const INVALID_FLAG_VALUE_BASELINE = 38;
// TERMINAL (spec §5.2, row B-59) … An increase is a defect, not a number to
re-measure and accept.` I re-measured it independently:
```
$ grep -rn "INVALID_FLAG_VALUE" src/tasks/ src/workflows/ | wc -l
38
$ grep -rn "INVALID_FLAG_VALUE" src/tasks/ src/workflows/ | cut -d: -f1 | sort | uniq -c | sort -rn
  12 src/tasks/schedule.ts            (rule a — cron scalar)
  10 src/tasks/scheduler-binding.ts   (rule a — argv scalar)
   7 src/tasks/task-id.ts             (rule a — the <id> argument)
   2 src/workflows/runtime/runs.ts    (rule a — ref filter flags)
   2 src/workflows/ir/params.ts       (rule a — --<name> param flags)
   2 src/tasks/run/attempt-lifecycle.ts (rule b membership + 1 doc comment)
   1 src/workflows/freeze/environment.ts   <- deviation
   1 src/tasks/source/bounded-document.ts  <- doc comment only
   1 src/tasks/prepare/prepare.ts          <- deviation
```
`TARGET_REF_INVALID` is CLI-observable despite Lane C's note that
`classifyTargetRef`'s own throw is re-coded by both its callers: it has two
further throw sites on the live `akm workflow run` path —
`src/workflows/runtime/workflow-asset-loader.ts:55/61`
(`parseWorkflowRefInput`), reached from `src/workflows/runtime/runs.ts:289`
`loadWorkflowAsset(ref)`.

**Caveat — two genuine domain failures still carry the generic code, by
deliberate, recorded choice.** §5.2's classification rule permits a survivor
only if it is (a) a user-typed scalar or (b) an allowlist membership entry.
These two are neither:
- `src/tasks/prepare/prepare.ts:119` — the workflow-target `env:` rejection, a
  **composition** failure, kept as `INVALID_FLAG_VALUE` because
  `tests/integration/tasks-with-classification-characterization.test.ts`'s P-04
  block is dispositioned **CONVERT** (assertions unchanged) by §7.2 F-A2.8 and
  its test title literally names the code.
- `src/workflows/freeze/environment.ts:114` —
  `throw new UsageError(\`Workflow source target ${refInput} was not found.\`, "INVALID_FLAG_VALUE");`,
  a **workflow-source** failure, kept because row B-11 in
  `tests/workflows/child-workflow-freeze.test.ts` pins it as "unchanged in code
  and shape" and that file is a §9 byte-unchanged preservation gate.

Both are correctly resolved in favour of preservation per §0 ("preserving wins
until the Review log says otherwise") and both are recorded in the Lane C
Review-log entry. The verdict is not MET because the criterion says domain
failures use phase-specific codes and two of them still do not — a script
branching on `COMPOSITION_INVALID` for an env-on-workflow-target rejection, or
on `WORKFLOW_SOURCE_INVALID` for an unresolvable workflow target, gets
`INVALID_FLAG_VALUE` instead.

**What remains (imperative).** In one post-0.9.2 commit, re-code
`src/tasks/prepare/prepare.ts:119` to `COMPOSITION_INVALID` and
`src/workflows/freeze/environment.ts:114` to `WORKFLOW_SOURCE_INVALID`, flipping
the two pinned tests in the same commit
(`tests/integration/tasks-with-classification-characterization.test.ts`'s P-04
title and assertion; `tests/workflows/child-workflow-freeze.test.ts`'s B-11
case), and lower `INVALID_FLAG_VALUE_BASELINE` from 38 to 36 in
`tests/architecture/diagnostic-codes.test.ts`. That requires authorization to
edit two preservation-gate tests, which is precisely why P4 could not do it.

---

#### 23. Multi-job YAML is either executable or rejected at the adapter boundary; it is not display-only core behavior. — **MET**

**Citation — one rejection, at the adapter.**
`src/workflows/source-ir/github-yaml.ts:parseJobs`:
```ts
if (fields.size !== 1 || !first) {
  reader.fail("multi-job-unsupported",
    `AKM workflow YAML requires exactly one job; this document declares ${fields.size}. AKM's YAML is an AKM workflow format executed by AKM's native engine, not GitHub Actions — split the jobs into separate workflows.`,
    second ? second[1].key : node);
}
const [id, pair] = first;
const job = parseJob(reader, id, pair, options);
if (job.needs.length > 0) {
  reader.fail("multi-job-unsupported",
    `Job ${job.id} declares needs, but an AKM workflow has exactly one job; remove needs.`, pair.key);
}
```

**The display-only machinery is gone, not merely bypassed.**
```
$ ls src/workflows/source-ir/ordering.ts   -> No such file or directory
$ rg -n 'validateTopologicalJobs|canonicalTopologicalJobs' src/
src/workflows/source-ir/compare.ts:11:  * `canonicalTopologicalJobs`, existed only to order MULTIPLE ready jobs — (comment)
$ rg -n 'jobs\.length' src/workflows/ir/compile.ts src/workflows/freeze/source-freeze.ts -> exit 1
```
`compileWorkflowPlan`'s `sourceIr.jobs.length !== 1` early return (row B-43, the
return-vs-throw asymmetry P0 R-05(c) pinned) and `source-freeze.ts`'s
"Multi-job workflow cannot execute…" throw (row B-44) are both deleted, and the
decoder now enforces the invariant structurally —
`src/workflows/source-ir/schema.ts:259`, `fail("jobs must contain exactly 1
entry")` (row B-42). So there is no longer a layer that parses a multi-job graph
successfully and refuses it later.

**P4-N2's code mapping is applied at all four compile→UsageError boundaries**,
not the two the note names — I checked each:
```
src/workflows/freeze/source-freeze.ts:74
src/workflows/ir/freeze-v4.ts:97
src/workflows/runtime/workflow-asset-loader.ts:183     <- the one Lane A discovered empirically
src/tasks/prepare/prepare-support.ts:188
```
each with the identical two-arm shape (`errors.length === 1 && code ===
"multi-job-unsupported"` → `COMPOSITION_INVALID`, else
`WORKFLOW_SOURCE_INVALID`) and no blanket recoding — a YAML syntax error is
still `WORKFLOW_SOURCE_INVALID`. The fourth site matters:
`workflow-asset-loader.ts` sits **before** `source-freeze.ts` on the
`akm workflow run` path (`runs.ts:289` `loadWorkflowAsset` precedes `:294`
`compileResolveFreezeWorkflowV4`), so without it row B-44 would not hold on the
commonest entry point.

```
$ bun test tests/workflows/characterization-fixture-contracts.test.ts \
    tests/workflows/source-ir-contract.test.ts \
    tests/workflows/characterization-classification.test.ts --timeout=120000
78 pass / 0 fail
```
Row B-46's acceptance baseline is intact: `characterization-fixture-contracts.test.ts`'s
`workflows/single-job` block is byte-unchanged and green, so a single-job
GitHub-shaped document still parses, compiles and freezes — the criterion's
"either executable or rejected" half.

---

#### 24. Task and workflow explain/plan output exposes target, input, source, and child provenance without secrets. — **MET WITH CAVEAT**

```
$ bun test tests/integration/commands/tasks-explain.test.ts \
    tests/integration/commands/workflow-cli-envelope.test.ts --timeout=120000
21 pass / 0 fail
$ bun test tests/commands/workflow-plan.test.ts --timeout=120000
19 pass / 0 fail
```

**`akm task explain` — target, input and schedule provenance, secret-free.**
`tests/integration/commands/tasks-explain.test.ts`:
- coverage — `:"prints declarations+defaults, target kind+ref, effective
  execution settings, and schedule bindings"`;
- *structural* provenance, not string-sniffing —
  `:"an unflagged input's supplied value is attributed to its DEFAULT,
  structurally — not merely because the word 'default' appears anywhere in the
  envelope"`, `:"--scope urgent overrides the default: … attributed to FLAG
  provenance, structurally"`, and `:"the schedule binding's own inputs are
  attributed to SCHEDULE-BINDING provenance — coexisting with, and distinct
  from, the CURRENT row's default/flag provenance for the identical input
  name"`;
- secret-freeness by **enumerated ban in both formats** —
  `:"never prints a resolved env: value, a prompt body, or a run:/script
  sentinel — in EITHER output format"` and `:"a shell task's run: command text
  never appears — only its target kind/ref"`;
- and it is genuinely read-only: `:"isTaskRunWithId — akm task explain never
  classifies as a task run (B-59, PRESERVE)"`.

**`akm workflow plan` — source and child provenance, secret-free.**
`tests/commands/workflow-plan.test.ts`:
- the envelope is a **closed key set**, which is what makes secret-freeness
  enforceable rather than aspirational — `:"prints one JSON object with the
  exact closed key set"`;
- child provenance — `:"a per-step expansion names via: child, the child ref,
  its planHash, and its declared output names"`;
- source provenance without host paths — `:"every sourceReadSet entry is a
  relative path"`;
- no durable side effects and no stderr leakage — `:"zero new rows across every
  workflow table, the events table, and usage_events — either mode"` and
  `:"emits no warn()/log output — stderr stays empty on a successful plan"`.

The runtime redaction machinery backing the executor is separate and intact:
`src/workflows/exec/param-secrets.ts:detectSecretShapedParams` and
`src/workflows/exec/dispatch-redaction.ts:{collectWorkflowDispatchSensitiveValues,
redactUnitOutcome, withDispatchRedaction}`.

**Caveat — R-R12 (§8, RECORDED, NOT FIXED, flagged by the spec as "the
highest-severity carried item"). Cited explicitly here per §10.1, and confirmed
still live at head.** The defect is not in explain/plan output; it is in the
**sibling input surface the same refactor added**,
`akm task run <id> --<input> <value>`:
```ts
// src/execution/input-contract.ts:coerceFlagValue — final line
throw diagnostics.invalidValue(name, `must be ${types.join(" | ")}; received ${JSON.stringify(raw)}`);
```
`TASK_INPUT_DIAGNOSTICS.invalidValue` (`src/tasks/source/task-input-diagnostics.ts`)
renders that into an `INPUT_BINDING_INVALID` envelope on stderr, so
`akm task run deploy --token hunter2` against an input declared
`type: number` prints `received "hunter2"` — the credential, verbatim, in the
error output, which is exactly where CI logs and issue reports get pasted. It is
the **only** `${JSON.stringify(raw)}` of a user-supplied value in that module;
the neighbouring diagnostics (`unknownFlag`, `duplicateNonArray`,
`malformedJson`, `contractViolation`, and `coerceFlagValue`'s own boolean arm at
`:225`) all name the input and its expected type without echoing the value, so
the fix is narrow. No test asserts the echoed value, so removing it breaks
nothing:
```
$ rg -n 'received' tests/integration/commands/tasks-input-flags.test.ts tests/integration/cli-errors.test.ts
(no output)
```
P4 correctly declined: redaction is new behavior and outside the charter.
`STABILITY.md`'s note calling `akm task explain` / `akm workflow plan`
"secret-free provenance output" is true as written — but a reader could
reasonably generalize it to the task-input CLI surface, where it is false.

**What remains (imperative).** Change
`src/execution/input-contract.ts:coerceFlagValue`'s final throw to
`` `must be ${types.join(" | ")}` `` (dropping `; received
${JSON.stringify(raw)}`), or route the value through the existing redactor
before interpolating it, and add a regression case to
`tests/integration/commands/tasks-input-flags.test.ts` asserting that a
type-mismatched flag value does not appear anywhere in the stderr envelope.

---

#### 25. All fail-before-mutation, crash-window, source-CAS, plan-hash, and replay-divergence tests pass. — **MET**

**Citation — the whole suite, at head, not a selection.**
```
$ bun run test:unit
── unit: 4 shards over 315 files
── unit: 4227 pass / 0 skip / 0 fail across 4 process-shards (315/315 files)

$ bun run test:integration
── integration: 4 shards over 438 files
── integration: 5826 pass / 57 skip / 0 fail across 4 process-shards (438/438 files)
```
Zero failures in either target, all 753 files executed. This also closes the one
red gate the Lane C Review-log entry recorded (`migration-help.test.ts`, 1 fail
at that commit) — it is green at head.

Each named family, with the specific test:
| Family | Test |
|---|---|
| fail-before-mutation | `tests/integration/tasks-runtime-v3-runner.test.ts:"<label> source fails before any history or log mutation"` (the parameterized canary P3a named a preservation gate), plus `:"a multi-job workflow target fails the 0.9.2 runtime boundary before attempt reservation"` — P4's own §3.3 rejection, still ahead of the mutation boundary — and `:"workflow task env fails closed before history because the workflow start contract has no consumer"` |
| crash windows | `tests/integration/workflow-crash-windows.test.ts`; `tests/integration/workflow-child-crash-windows.test.ts:"CW-1/CW-2/CW-3"` (criterion 13) |
| source CAS | `tests/workflows/guarded-execution-source-red.test.ts:"fails closed when before/after fstat proves a read-time mutation"`, `:"rejects an oversized source at the guarded descriptor boundary"`, `:"rejects invalid UTF-8 rather than returning lossy adapter input"`; child-scope CAS in `tests/integration/workflows/child-freeze-read-set.test.ts` (criterion 12) |
| plan hash / schema drift | `tests/integration/workflows/schema-drift.test.ts`, `tests/integration/workflows/v4-atomic-publication-red.test.ts`, `tests/workflows/plan-v5-schema.test.ts`, `tests/workflows/task-binding-identity.test.ts` |
| replay divergence | `tests/integration/workflows/child-replay-determinism.test.ts:"the composing unit is REUSED from the journal on resume — the child's own leaf unit is never re-dispatched, and the composing step's evidence is byte-identical"` and `:"engine resume fails the run loudly, naming the tampered composing unit — the child is never touched"` |

The floors are consistent with these counts under P4-N5
(`floor(executed × 0.95 / 100) × 100`):
`scripts/test-unit.sh:61` `MIN_TESTS="${AKM_MIN_UNIT_TESTS:-4000}"` — executed
4227 → 4000; `scripts/test-integration.sh:53`
`MIN_TESTS="${AKM_MIN_INTEGRATION_TESTS:-5500}"` — executed 5883 → 5500. Both
rose from 3500 / 5000, as §5.3 requires.

**Read this verdict against criterion 8's caveat.** Every replay-divergence test
passes, and R-R15 is not a failing test — it is a divergence the current
`hashVersion` 6 preimage cannot *detect*, so no test exists to fail. The suite
being green is not evidence against R-R15.

---

### Sweep close-out

#### Gate state at head (`5393e1ca`)

```
$ bunx tsc --noEmit                 -> exit 0, no output
$ bun run lint                      -> exit 0
   lint-tests-isolation OK · MPL-2.0 headers OK (651 files) · lint-runtime-boundary OK
   lint-write-source-chokepoint OK · lint-secret-resolver-boundary OK
   lint-execution-boundary OK · lint-process-argv OK · lint-repository-sql OK
   lint-goldens-presence OK · lint-golden-captured-at-head OK (13/17 judged; 4 unjudged, shallow clone)
   lint-shipped-assets OK · lint-doc-examples OK · gen-config-schema --check up to date
   lint-active-docs-terminology OK (0 violations across 91 active doc files)
$ bun run test:unit                 -> 4227 pass / 0 skip / 0 fail (315/315 files)
$ bun run test:integration          -> 5826 pass / 57 skip / 0 fail (438/438 files)
```
So `bun run check` is green at head. (`bun run lint`'s 1397 biome *warnings* are
pre-existing repo-wide `noNonNullAssertion` style notices in files P4 did not
touch; the command's exit status is 0.)

#### §12 close-out items spot-checked while sweeping

| Item | Result |
|---|---|
| Plan `irVersion` unchanged | `src/workflows/ir/schema-v4.ts:38` `export const WORKFLOW_IR_V5_VERSION = 5 as const;` |
| `hashVersion` unchanged | `src/workflows/exec/step-work.ts:679` `"akm.workflow.unit\0v6\0"`, `:1948` `"akm.workflow.gate\0v6\0"` |
| Child-invocation prefix unchanged | `src/workflows/exec/child-invocation.ts:45` `"akm.workflow.child-invocation\0v1\0"` |
| `EXIT_CODES` byte-unchanged | `git diff 0f16f70fdc61..HEAD -- src/cli/shared.ts \| wc -l` → `0` |
| Frozen migrator parser exists, keeps the locator grammar | `scripts/akm-migrate/migrate/task-source-v3-frozen.ts` present (23 211 bytes); 9 lines matching `classifyTaskV3Uses\|parseTaskV3Yaml\|github-action` |
| `src/` imports nothing from `scripts/` | no `import … from` a `scripts/` specifier; `src/commands/migration-tool.ts:migrationEntryPoint` builds a **spawn path** with `fileURLToPath(new URL("../scripts/akm-migrate.js", import.meta.url))` and `fs.existsSync`, not an import — the binding constraint holds, though §3.2.4/§9's literal grep does return those prose/spawn hits |
| Files on §6's DELETE list absent | `runtime-v3.ts`, `runner.ts`, `ir/source-freeze-v4.ts`, `source-ir/ordering.ts`, `source/parse-v3-adapter.ts`, `model/definition.ts`, `model/schedule.ts` — all "No such file or directory" |
| `version: 3` fixtures confined | only under `tests/fixtures/execution-contracts/tasks/v3-to-v4/**` (and `…/v2/**`), the migrator's own inputs |
| ADRs exist | `docs/architecture/decisions/` — `README.md` + `0001`…`0011` (§4.2 asked for `0001`…`0010`; `0011-engine-run-loop-invariants.md` is an extra the implementer added) |
| Driver-protocol record flipped | `docs/architecture/specs/driver-protocol-keep-or-cut.md:3` `Status: RESOLVED (2026-08-27) — Option B, cut.` |
| Test floors raised | 3500 → 4000 (unit), 5000 → 5500 (integration) |
| Diagnostics ratchet terminal | `INVALID_FLAG_VALUE_BASELINE = 38`, measured, comment says TERMINAL |

#### §8 carried-advisory rows, surfaced where §10.1 directs

Placed under their criterion above: **R-R13** → 4 · **R-R16** → 6 ·
**R-R15** → 8 · **R-R12** → 24.

The remaining `RECORDED, NOT FIXED` / `DEFERRED` rows bear on no single
criterion; recorded here so none is lost:

| ID | Status | Note |
|---|---|---|
| **R-R1**, **R-R20** | DEFERRED | The `schema-v4.ts` / `freeze-v4.ts` / `environment-v4.ts` and `TaskV3*` / `PreparableTaskDocument` renames, and `environment-v4.ts`'s re-home. Confirmed still pending: `src/tasks/source/project-v4.ts:93` still emits the `version: 3` discriminant and `src/tasks/source-v3.ts` still holds the `TaskV3*` family. Correctly deferred (§0's rationale: a ~40-site rename storm would bury the deletion diff), but it is now the only named remaining work on the branch. |
| **R-R10** | RECORDED, NOT FIXED | P1b's shared-capture structural check and the adapter-header P2a cross-reference. Neither is a deletion; both survive P4 unchanged. |
| **R-R11** | RECORDED, NOT FIXED | Secret-shaped task **input default** warns with workflow-parameter prose. Adjacent to criterion 24's subject but a message-quality issue, not a disclosure. |
| **R-R14** | RECORDED, NOT FIXED (both halves) | The doubled `$` path root in a schedule-inputs error, and a `uses:` error listing `tasks/` as valid. §3.1's message rewrite did **not** touch `classifyTargetRef`'s text — `src/execution/target-ref.ts:49` (inside `targetRefInvalid`) still reads `must be a canonical commands/, scripts/, tasks/, or workflows/ asset ref.`, i.e. it still lists `tasks/` — so the conditional "fixed for free" in R-R14 did not trigger. Per that row's own instruction ("State which in the Review log"), the answer is: **neither half fixed**. |
| **R-R17** | RECORDED, NOT FIXED | An unresolvable `uses: tasks/<ref>` with a `with:` reports "declares no inputs". Confirmed by inspection at `src/workflows/freeze/targets/task.ts:101`, `if (source.with !== undefined) throw noDeclaredInputsError(source.id, refInput);` inside the `catch` around `resolveOwnedAsset` — the asset-resolution cause is swallowed. Deliberate (it is what makes criterion 3's B-02b case fail-closed), so the fix is to improve the message, not the control flow. |
| **R-R2 – R-R9, R-R18, R-R19, R-R21** | RESOLVED / RETIRED / CLOSED | Verified in passing by the criteria above: R-R2/R-R9 by criterion 18's zero greps, R-R4 by criterion 19's `moduleReferencesFrom`, R-R5/R-R6 by `src/core/errors.ts`'s hints and `SAFE_TASK_ATTEMPT_ERROR_CODES`, R-R7/R-R8 by the `cli-errors.test.ts` extension and `bounded-document.ts`'s explicit `TASK_SOURCE_INVALID`, R-R3 by criterion 13's publication tests plus ADR `0009`. |

#### Findings this sweep raised that no §8 row covers

Both are stated in full under their criterion; listed together so they are not
lost in a long document.

1. **`akm workflow create --json` emits a `stashDir` key** (criterion 21).
   `src/workflows/authoring/authoring.ts:createWorkflowAsset` returns
   `{ ref, path, stashDir }` and `src/commands/workflow-cli.ts:168` spreads it
   into the envelope. Row B-49's proof grep (`rg -n 'stashDir' src/tasks/
   src/workflows/ src/commands/tasks/` → "zero hits") returns 34 hits at head,
   so §4.1 publishes a proof that does not hold.
2. **A shipped, embedded CLI hint still teaches task v3** (criterion 21).
   `src/assets/hints/cli-hints-full.md:369-372` tells users to author
   `version: 3` and set `akm.enabled: false`; both now fail. No lint covers it —
   `lint-shipped-assets` scans `src/assets` only for dead `type:name` tokens,
   and `lint-active-docs-terminology`'s roots are `docs/` + three README files.

A third, milder one is under criterion 19: §3.2.3's claim that
`src/workflows/**` imports nothing from `src/tasks/**` source modules is false
(`src/workflows/source-ir/triggers.ts` → `src/tasks/source/bounded-document`),
and the seam ratchet does not scan `triggers.ts`.

#### Verdict table

| # | Criterion (abbreviated) | Verdict |
|---|---|---|
| 1 | Native engine, no new runtime dependency | MET |
| 2 | Command/shell/script/retry/gate/worktree/resume intact | MET |
| 3 | A workflow task call cannot silently discard `with` | MET |
| 4 | Tasks exist and compose without schedule metadata | MET |
| 5 | One task-invocation resolver | MET |
| 6 | Typed inputs: defaults, validation, literals, references | **MET WITH CAVEAT** — the `{from: "params.<name>"}` arm is unauthorable (R-R16) |
| 7 | Inputs attached as structured context, never interpolated | MET |
| 8 | Effective inputs participate in durable identity | **MET WITH CAVEAT** — a reference binding's *resolved* value is outside `computeUnitInputHash` (R-R15) |
| 9 | Output contracts enforced consistently | MET |
| 10 | Direct and task-wrapped refs lower to one child target | MET |
| 11 | Child plans frozen before parent publication | MET |
| 12 | Child source edits cannot alter an in-flight parent | MET |
| 13 | Parent-child creation idempotent across crash windows | MET |
| 14 | Parent cancellation propagates to the child | MET |
| 15 | Parent and child independently resumable and linked | MET |
| 16 | Composition cycles fail before durable mutation | MET |
| 17 | No internal path fabricates YAML to reuse a parser | MET |
| 18 | No GitHub Action variant in native classification | MET |
| 19 | Workflow classification independent of the task parser | **MET WITH CAVEAT** — §3.2.3's stronger claim is false and the seam ratchet does not enforce it |
| 20 | Task runner mutates no global process env | MET |
| 21 | No `stash` vocabulary; commands not mislabelled prompts | **MET WITH CAVEAT** — `akm workflow create` emits `stashDir`; a shipped hint still teaches task v3 |
| 22 | Domain failures use phase-specific diagnostic codes | **MET WITH CAVEAT** — two domain failures keep `INVALID_FLAG_VALUE` to preserve pinned tests |
| 23 | Multi-job rejected at the adapter boundary | MET |
| 24 | Explain/plan expose provenance without secrets | **MET WITH CAVEAT** — R-R12: `akm task run --<input> <secret>` echoes the value on a type mismatch |
| 25 | Fail-before-mutation / crash-window / CAS / hash / replay pass | MET |

**19 MET, 6 MET WITH CAVEAT, 0 UNMET.** No criterion is unproven. Every caveat
is either an §8 row P4 deliberately declined (6, 8, 24, and half of 22) or a
spec-claim/ratchet gap this sweep found (19, 21, and the other half of 22); none
requires reopening a P4 commit, and each carries an imperative fix above.

---

**2026-08-28 — External review of PR itlackey/akm#844 (Codex), dispositions and
close-out.**

*Provenance.* After the sweep above, the PR owner asked the repo's Codex
reviewer for a deep pass over the whole branch. It reviewed commit
`e640a23a` and left **ten** inline threads
(`https://github.com/itlackey/akm/pull/844#pullrequestreview-5048104859`,
2026-08-28 05:13 UTC; the parallel Copilot review found no specific bug and
generated zero comments). Those ten, plus **F11** — this document's own
criterion-21 sweep finding, `akm workflow create --json` emitting `stashDir`,
which no §8 row covered — were adjudicated as one batch of eleven under the
ids `F1`–`F11` used by the fix lanes. Every id below was worked to a verdict
against the real code: **CONFIRMED** only with the defect demonstrated (call
path traced, and where cheap a red-before/green-after test), **REFUTED** only
with the code that makes the claimed behavior impossible cited.

*Verdicts: 9 CONFIRMED, 2 REFUTED. Fixes landed for 10 of 11 — every
CONFIRMED finding, plus F9, whose parse-time rejection was directed as
defense-in-depth even though the finding as filed was refuted.*

| ID | Codex finding (its own title) | Reviewed at | Verdict | Disposition |
|---|---|---|---|---|
| **F1** | Honor non-array branches in array union inputs | `src/execution/input-contract.ts:203` | **CONFIRMED** | `f5aa5fc9` — the array branch is taken unconditionally only when `array` is the sole declared type or more than one flag occurrence was supplied; a single non-bracketed value against a union routes through `coerceFlagValue` with the FULL schema. Array-only, JSON-array shorthand, and repeated-flag grouping unchanged. |
| **F2** | Reject malformed `workflow_dispatch` triggers before migration | `scripts/akm-migrate/migrate/task-to-v4.ts:298` | **CONFIRMED** | `3c4ff8ef` — `planV3DataToV4`'s `on:` block now mirrors the frozen v3 reader's `parseOn` gates: an empty `on: {}` and a non-empty `on.workflow_dispatch` both `blocked` as `invalid-v3-task` instead of being laundered into runnable v4 bytes with a false manual-dispatch notice. |
| **F3** | Omit null legacy output schemas during v4 conversion | `scripts/akm-migrate/migrate/task-to-v4.ts` | **CONFIRMED** | `3c4ff8ef` — an explicit `akm.outputSchema: null` (v3 for "no schema") is omitted rather than emitted as `output: null`, which the real `parseTaskSourceV4` rejects; one such file previously blocked the whole migration plan. Extended by `385408bc` (below). |
| **F4** | Replace the embedded task-v3 instructions | `src/assets/hints/cli-hints-full.md:365` | **CONFIRMED** | `dbf1a6dc` — the shipped hint's "Scheduled Tasks" section now teaches `version: 4`, per-entry `schedule[].enabled`, top-level `timeout`, and typed `inputs:`/`output:`; `scripts/lint-active-docs-terminology.ts`'s scan roots widen to include `src/assets/hints` so the shipped help cannot silently drift again. Closes half of criterion 21's caveat. |
| **F5** | Compile the child bytes recorded in the read set | `src/workflows/freeze/targets/child-workflow.ts:184` | **REFUTED** | No window exists: the embedded child plan is compiled FROM the captured bytes. `ir/freeze-v4.ts:79` calls `captureWorkflowSource` first — `guarded-source.ts:196-224` reads the file once and stores `content` beside the sha256 that enters the read set — and `freeze/source-freeze.ts:66` compiles `workflowSource.content`, that same buffer; `freeze-v4.ts:88` builds the plan from the resulting `compiled.ir`. `loadWorkflowAsset`'s own `asset.sourceIr` is used for ref/adapter identity, never to build the embedded plan, so capture and compile cannot disagree. No change. |
| **F6** | Hash resolved task bindings before reusing units | `src/workflows/exec/step-work.ts:494` | **CONFIRMED** | `e2ad3679` — reproduced against the round base in a throwaway worktree: one fixture, two different resolved values for the same frozen `{from: "steps.prev.output"}` binding, produced the IDENTICAL unit hash under `hashVersion` 6. `computeUnitInputHash` gains the conditional `taskInputs` field and both prefixes bump 6 → 7. §8 **R-R15** and criterion 8's caveat are hereby closed (see "Supersessions" below). |
| **F7** | Reject the unsupported `scheduled` flag on task explain | `src/commands/tasks/tasks-cli.ts:361` | **CONFIRMED** | `64d73c26` — `akm task explain <ref> --scheduled` exited 0 with the flag silently discarded by the shared scanner's reserved set; it now fails `UNKNOWN_FLAG` (exit 2) before `parseTaskInputFlags` runs. `task run`'s own reserved set is untouched. Widened to every spelling by `385408bc` (below). |
| **F8** | Enforce output schemas for every accepted task target | `src/tasks/source/task-source-v4.ts` | **CONFIRMED** | `c09ad27b` — `output:` is rejected (`TASK_SOURCE_INVALID`) on `run:`, `uses: scripts/`, and `uses: workflows/` targets, whose runtimes never consume it; command targets are unchanged. The published `schemas/akm-task.json` was brought into agreement by `9fe86464` (below). |
| **F9** | Reject scheduled tasks missing required input values | `src/tasks/source/task-source-v4.ts:680` | **REFUTED** (fixed anyway) | The finding's operative half — "parses and **syncs successfully** … leaving an installed schedule that can never run" — was already false at the reviewed commit: `src/tasks/scheduler-sync.ts:503-521` applies defaults and validates EVERY entry against the declared contract and throws `TASK_SOURCE_INVALID` at sync, so such a binding could never be installed. The parse half was real, and the parent directed the earlier gate regardless: `585a3afb` runs the same `applyInputDefaults` + `validateInputs` pair for every schedule entry at parse, including the `schedule: "<cron>"` shorthand and an entry with no `inputs:` key, which were the two shapes no check covered. |
| **F10** | Classify canonical refs before GitHub locator lookalikes | `src/tasks/source/task-source-v4.ts` | **CONFIRMED** | `b73cf9ff` — `classifyTaskSourceV4Uses` delegates to `classifyTargetRef` first and runs the github-locator lookalike diagnostic only on its catch path, so a valid `commands/review@v2` is no longer rejected as a removed GitHub Action target. |
| **F11** | (Not Codex — this document's criterion-21 sweep finding) `akm workflow create --json` emits a `stashDir` key | `src/workflows/authoring/authoring.ts` | **CONFIRMED** | `71703e76` — `createWorkflowAsset` returns `bundleDir`; the one consumer (`src/commands/workflow-cli.ts:167-169`) is updated and the envelope key is pinned in `tests/integration/commands/workflow-cli-envelope.test.ts`. The indexer's own `IndexOptions.stashDir` is not a CLI surface and stays (row B-50). Closes the other half of criterion 21's caveat. |

*Two follow-on review rounds over those fixes (§0.3's `MAX_REVIEW_ROUNDS = 2`,
both exhausted).* The lane fixes were themselves reviewed twice, and both
rounds' CONFIRMED findings were fixed before this entry:

- **Round 1 — 4 findings, 3 CONFIRMED, all fixed in `385408bc`.** (a) F3's
  migrator hoist regressed under F8's new grammar: hoisting `akm.outputSchema`
  onto a non-command target emitted bytes the real parser now rejects, so a
  valid v3 file came back `generated-v4-validation-failed` and one blocked file
  aborts the whole plan; the hoist gained an explicit target-kind arm that
  drops the (already inert) field and says so in a notice, keeping the
  `changed` outcome §5.3 mandates. (b) F7's gate keyed on whole argv tokens, so
  `--scheduled=false` walked past it; a `hasFlagNamed` helper splits on the
  first `=` exactly as `parseTaskInputFlags` does — and the identical
  whole-token hole in `rejectRetiredTaskTargetFlag` meant `--target=team` was
  rejected by nothing at all and the caller's bundle silently ignored, so it
  uses the same helper now. (c) Active docs and comments stating the unit-hash
  vocabulary caught up with `hashVersion` 7 (ADR `0002`,
  `docs/architecture/workflow-engine.md`, two child-executor comments).
- **Round 2 — 6 findings, 4 CONFIRMED, all fixed in `9fe86464`.** (a) Round 1's
  by-name `--target` rejection made a legally-declared input named `target`
  unreachable through every spelling, so `target` joins the reserved input-name
  set via `TASK_RUN_SELF_DIAGNOSED_FLAGS` (deliberately OUT of the two scanner
  sets, so `parseTaskInputFlags`' behavior is unchanged) and such a declaration
  now fails at authoring time. (b) `schemas/akm-task.json` still validated the
  documents F8 taught the parser to reject — the schema ships in `files` and is
  served at its `$id`, so an author's editor green-lit a file `akm task run`
  refuses; the root `oneOf` now forbids `output:` on the `run:` arm and allows
  it on the executable-ref arm only for a commands-only `akmCommandRef`, pinned
  by an Ajv agreement test. (c) The `generated-v4-validation-failed` row in the
  migrator's blocked-reason table described behavior round 1 removed. (d) The
  same round's docs pass corrected the remaining stale prose.

**Auto-adjudication (§0.3), invoked.** §0.3 caps this phase at
`MAX_REVIEW_ROUNDS = 2` "with auto-adjudication on budget exhaustion: if the
last round's fixes were applied and its own findings were the sole basis of an
abort flag, log the adjudication in the Review log and **proceed**. Return
`blocked` only when a round produced findings that were never fixed." Round 2
is the budget's end; every CONFIRMED finding it raised is fixed and re-verified
in `9fe86464`, and no finding from either round is left unfixed. The branch
therefore **proceeds**; no round-3 review was run, and none is owed.

*Supersessions and criterion movement.* This round changes four earlier
dispositions in this document, and nothing else:

| Item | Was | Now |
|---|---|---|
| §8 **R-R15** (`:1278`) | RECORDED, NOT FIXED — "a divergence the current `hashVersion` 6 preimage cannot detect" | **RESOLVED** by `e2ad3679`. The bump ADR `0002`'s own rule demands rode with it. |
| Criterion **8** (`:2158`, `:3037`) | MET WITH CAVEAT — a reference binding's resolved value sits outside `computeUnitInputHash` | **MET.** The caveat's subject is now a preimage field. |
| Criterion **21** | MET WITH CAVEAT — `akm workflow create` emits `stashDir`; a shipped hint still teaches task v3 | **MET.** `71703e76` (F11) and `dbf1a6dc` (F4) close both halves; the terminology lint now scans `src/assets/hints`. |
| §8 **R-R13** | RECORDED, NOT FIXED — "a new diagnostic is new behavior" | **RESOLVED at both gates**: `scheduler-sync.ts:503-521` already refused to install an unsatisfiable binding, and `585a3afb` now refuses to parse one. Licensed by p2a's own review log (`p2a-task-source-v4.md:1362-1364`), which named a parse-time rejection as an acceptable fix. |
| Advisory **A2** (this sweep) | non-blocking — the migration guide's hand-off names the wrong clause | **DISCHARGED.** `docs/migration/v0.9.1-to-v0.9.2.md` now states the rule itself (a `required: true` input must be named by every `schedule:` entry, rejected at parse) instead of pointing at a "trap". |

The sweep's remaining caveats (criteria 6, 19, 22, 24) and the residual
advisories F5/F6/A1 recorded above are untouched by this round and stand as
adjudicated.

*Docs this entry updates alongside itself.* `CHANGELOG.md` `[Unreleased]` — the
`hashVersion` line moves 5 → 6 to **5 → 7** with the conditional `taskInputs`
field described, the "no plan/hash version changed" claim about `with:`
bindings is restated as preimage-SHAPE stability, `target` joins the reserved
input-name list, and three new Breaking entries (the `output:` command-target
rule, the schedule-satisfies-inputs rejection, the `stashDir` → `bundleDir`
envelope rename) plus a `Fixed` section (F1's union coercion, the
`--target=<value>` hole, the embedded hint) are added.
`docs/plans/specs/p3a-plan-v5-child-freeze.md` §3.3's preimage table is amended
to the shipped `hashVersion` 7 — its documented exclusion 4 struck, `taskInputs`
added as a conditional field — with §2.2's A-11/A-12 rows annotated and a new
A-17 row for the resolved-value case; every other `hashVersion` 6 mention in
that document is P3a's phase history and is left as written, with §3.3 named as
the authority.

*Gate at this entry's HEAD (`9fe86464`; this append is docs-only).* Raw output,
per §0.3's raw-output rule:

```
$ bun run lint                      -> exit 0
   biome: checked 1523 files, no fixes applied, 1409 warnings + 2 infos
          (pre-existing repo-wide noNonNullAssertion notices; exit status 0)
   lint-tests-isolation OK · MPL-2.0 headers OK (653 files) · lint-runtime-boundary OK
   lint-write-source-chokepoint OK · lint-secret-resolver-boundary OK
   lint-execution-boundary OK · lint-process-argv OK · lint-repository-sql OK
   lint-goldens-presence OK — 51 golden asset(s), 27 frozen and hash-verified
   lint-golden-captured-at-head OK — 13 of 17 pins judged; 4 unjudged (shallow clone)
   lint-shipped-assets OK — 0 dead type:name ref token(s)
   lint-doc-examples OK — 0 violations · gen-config-schema --check up to date
   lint-active-docs-terminology OK — 0 "stash" violations across 93 active doc files
$ bunx tsc --noEmit                 -> exit 0 (no output — zero diagnostics)
$ bun run test:unit                 -> exit 0
   4304 pass / 0 skip / 0 fail across 4 process-shards (317/317 files)
$ bun run test:integration          -> exit 0
   5860 pass / 57 skip / 0 fail across 4 process-shards (442/442 files)
```

Both §5.3 floors hold with room (`4304 >= 4000`, `5860 >= 5500`), and both
counts rose against the sweep's own numbers (`4227` / `5826`) purely by
regression tests added for the findings above. The terminology lint's 91
scanned files became 93 for a different reason: F4 added
`src/assets/hints`'s two shipped `.md` assets to its roots. `bun run check` is
green at head.
