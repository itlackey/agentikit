---
type: workflow
description: Drive a recurring release from a quiet base branch to a tagged, deployed, retrospected release. Composes other workflows as nested runs — `weekly-dependency-audit`, `code-review-pr` (per release-blocker PR), and a final retrospective — so the orchestrator stays small and the heavy lifting lives in dedicated, individually testable workflows.
tags: [example, release, nested-workflows, orchestration, env]
params:
  release_version: { type: string, description: "Semver version being released (e.g. `1.4.0`). The workflow validates this against the changelog and tags." }
  base_branch: { type: string, description: "Branch the release is cut from. Defaults to `main`." }
  release_branch: { type: string, description: "Optional release branch (e.g. `release/1.4.x`). Defaults to `release/<release_version>` when omitted." }
  release_pr_query: { type: string, description: "GitHub search query that selects the PRs in scope for this release (e.g. `is:open milestone:1.4.0 label:release-blocker`). The orchestrator iterates this list." }
  deploy_env: { type: string, description: "Env ref with deploy credentials (e.g. `env/production`). Loaded only at the shell level, never echoed." }
  workspace_dir: { type: string, description: "Directory for run artefacts. Defaults to a per-run directory such as `.akm-run/<run-id>/`." }
  knowledge_wiki: { type: string, description: "AKM wiki for release notes and retrospectives. Defaults to `engineering`." }
  skip_dependency_audit: { type: boolean, description: "Set to `true` to skip the nested dependency audit (e.g. for hotfixes). Defaults to `false`." }
steps:
  - id: open-release-book
  - id: nested-dependency-audit
    inputs: [steps.open-release-book.output]
  - id: cut-release-branch
    inputs: [steps.nested-dependency-audit.output]
    output: { type: object, properties: { in_scope_prs: { type: array } }, required: [in_scope_prs] }
  - id: nested-pr-reviews
    map:
      over: steps.cut-release-branch.output.in_scope_prs
      concurrency: 3
    gate: { required: true }
  - id: tag-deploy-announce
    inputs: [steps.nested-pr-reviews.output]
  - id: nested-retrospective
    inputs: [steps.tag-deploy-announce.output]
  - id: close-release-book
    inputs: [steps.nested-retrospective.output]
---

# Release Train

This workflow is an **orchestrator**. It does very little real work itself.
Each major phase delegates to a *nested run* of another workflow in this
stash:

- pre-flight maintenance → `workflows/weekly-dependency-audit`
- per-PR sign-off → one `workflows/code-review-pr` run per blocker
- post-release learning → `workflows/release-retrospective` (a sibling
  workflow you can split out; see `nested-retrospective` below)

The pattern is intentional. Each nested workflow is *individually*
runnable, testable, and resumable. The orchestrator's only job is to
sequence them, stitch their outputs together, and own the cross-cutting
release artefacts (changelog, tag, deploy, announcement). Because every
nested run gets its own run id, an interrupted release can resume by asking
`akm workflow status` of the orchestrator and walking down to the nested
runs it spawned. Paths below are relative to the directory named by the
`workspace_dir` parameter, unless stated otherwise.

## open-release-book

Establish a single durable index of every artefact this release will
produce, including the IDs of nested runs.

1. Validate the `release_version` parameter is semver. Resolve the
   `release_branch` parameter to its default (`release/<release_version>`)
   if omitted.
2. Create `release-book.md` with these sections, all initially empty:
   - `Inputs` — params, base SHA, expected scope from `release_pr_query`.
   - `Nested runs` — IDs of each nested workflow run, with state.
   - `Artefacts` — changelog path, tag, deploy log, announcement.
   - `Anomalies` — anything that needed manual override.
3. Snapshot the current state of the query named by the `release_pr_query`
   parameter:

   ```sh
   gh pr list --search "<release_pr_query>" \
     --json number,title,author,labels,headRefName,statusCheckRollup \
     > in-scope-prs.json
   ```

   Block the run with a clear message if the list is empty *and*
   `skip_dependency_audit` is `true` — there is nothing to release.

### gate

- `release-book.md` exists and is the canonical index for this release.
- `in-scope-prs.json` lists every PR matched by `release_pr_query` at the
  point the release started.
- `release_branch` is resolved and recorded in `release-book.md`.

## nested-dependency-audit

Unless the `skip_dependency_audit` parameter is `true`, every release
passes through the same weekly dependency audit before opening the release
branch, building on the release book opened by `open-release-book`,
attached to this unit as input. We do not duplicate that logic here — we
*call* it.

1. If `skip_dependency_audit` is `true`, mark this step
   `--state skipped --notes "hotfix release"` and continue. Otherwise:
2. Start the nested run, passing through the parameters it needs:

   ```sh
   akm workflow start workflows/weekly-dependency-audit \
     --params '{"package_manager":"bun","base_branch":"<base_branch>",
                "freeze_list":[]}'
   ```

   Capture the returned run id — call it `DEP_RUN_ID` — and append it to
   the `Nested runs` section of `release-book.md`.
3. Drive the nested run to completion exactly as a human would. Each
   call returns the next actionable step:

   ```sh
   akm workflow next $DEP_RUN_ID
   # ... do the work for that step ...
   akm workflow complete $DEP_RUN_ID --step <step-id> --state completed \
     --notes "..." --evidence '{"artefact":"path/to/output"}'
   ```

   Repeat until `akm workflow status $DEP_RUN_ID` reports the run as
   `completed`.
4. Read the nested run's `handoff.md` artefact. If it produced a
   green-band PR, add that PR to `in-scope-prs.json` for this release.
   If it produced any red-band issues, link them in `release-book.md`
   under `Anomalies` so the retrospective can pick them up.
5. If the nested run finishes in `blocked` or `failed`, do not paper
   over it. Block this orchestrator step with the nested run id in the
   notes — the release does not advance until the dependency audit is
   resolved (which may itself need `akm workflow resume`).

### gate

- Either the dep-audit run is in state `completed` and its outputs are
  reflected in this release's book, or this step is `skipped` for a
  hotfix with an explicit note.
- The nested run id is recorded in `release-book.md` so the audit trail
  is recoverable from the orchestrator alone.
- A failed nested run blocks the orchestrator instead of being silently
  ignored.

## cut-release-branch

With dependencies green, lock the scope of what this release contains,
using the outcome of `nested-dependency-audit`, attached to this unit as
input. Report a structured result with `in_scope_prs`: the final list of
PR numbers in scope for this release.

1. Cut the branch named by the `release_branch` parameter from the branch
   named by the `base_branch` parameter:

   ```sh
   git fetch origin <base_branch>
   git switch -c <release_branch> <base_branch>
   git push -u origin <release_branch>
   ```

2. Re-run the PR query and diff it against `in-scope-prs.json`. New PRs
   matching the query after the release started are *not* automatically
   included — append them to `Anomalies` in `release-book.md` and require
   an explicit decision before adding them to scope.
3. Generate a changelog draft at `CHANGELOG.draft.md` using PR titles,
   labels, and bodies from `in-scope-prs.json`. Group into `Features`,
   `Fixes`, `Internal`, `Breaking`. Mark anything `Breaking` for explicit
   reviewer attention in the next step.

### gate

- `release_branch` exists on the remote and is based on a known
  `base_branch` SHA recorded in `release-book.md`.
- `CHANGELOG.draft.md` covers every PR in `in-scope-prs.json`, grouped
  and with `Breaking` items flagged.
- Late-arriving PRs are surfaced in `Anomalies`, never silently merged.

## nested-pr-reviews

This section is the **map unit template** — the engine dispatches one unit
per PR in `in_scope_prs`, up to 3 in parallel. For the PR number you were
given, drive it through the standard review workflow as a nested run and
report back its outcome.

1. Start the nested run for your PR:

   ```sh
   akm workflow start workflows/code-review-pr \
     --params '{"pr_ref":"gh:itlackey/akm#<n>","conventions_query":"<pr title>",
                "knowledge_wiki":"<knowledge_wiki>"}'
   ```

   Record the returned run id in your own status file (e.g. a
   `review-status/<n>.md` under this run's scratch area) rather than
   appending directly to a shared worklist file — the workflow's final
   steps aggregate every unit's status file once the fan-out completes.
2. Drive it via `akm workflow next` / `akm workflow complete` until the
   nested run reports `completed`.
3. Re-read its `rubric.md` artefact:
   - If every rubric item is `pass` or `concern`, report your PR as
     reviewed.
   - If any rubric item is `block`, the PR is *not* releasable this round.
     Report it as blocked with the rubric excerpt — a human decides
     whether to wait for a fix and re-run this unit on the new commit, or
     remove the PR from scope.

### gate

- Every in-scope PR has a corresponding nested `code-review-pr` run id
  recorded in its own status file, or a recorded reason it was excluded.
- No PR with a `block` rubric verdict is reported as reviewed.
- Once every unit settles, `CHANGELOG.draft.md` is regenerated against the
  actual merged set and promoted to `CHANGELOG.md` on the release branch.

## tag-deploy-announce

The orchestrator owns these cross-cutting steps directly — they are not
themselves multi-step procedures and do not need a nested workflow. Proceed
only once every unit from `nested-pr-reviews`, attached to this unit as
input, is reviewed and merged.

1. Verify all CI on `release_branch` is green:

   ```sh
   gh pr checks <release_branch>
   ```

2. Tag and push:

   ```sh
   git tag -a v<release_version> -m "Release <release_version>"
   git push origin v<release_version>
   ```

3. Load deploy credentials only into the deploy shell, using the
   `deploy_env` parameter:

   ```sh
   akm env run <deploy_env> -- ./scripts/deploy.sh <release_version> | tee deploy.log
   ```

   Verify the deploy health check passes before continuing. If it
   fails, mark this step `--state failed` and let the retrospective run
   pick up the incident — do not attempt to clean up the partial deploy
   here.
4. Post the release announcement using `CHANGELOG.md` as the body. Link
   to this run's id and to each nested run id so reviewers can audit the
   path the release took.

### gate

- The `v<release_version>` tag exists on the remote and points at the
  release branch's tip SHA.
- `deploy.log` shows a successful deploy and a passing health check.
- The announcement links to the orchestrator's run id for full audit
  traceability.

## nested-retrospective

Every release ends with a small retrospective so the *next* release
inherits this one's lessons, drawing on the deploy performed by
`tag-deploy-announce`, attached to this unit as input. We delegate to a
focused workflow rather than burying the retro inside the orchestrator.

1. Start the nested retrospective run:

   ```sh
   akm workflow start workflows/release-retrospective \
     --params '{"release_version":"<release_version>",
                "orchestrator_run_id":"<run-id>",
                "knowledge_wiki":"<knowledge_wiki>"}'
   ```

   Append the run id to `release-book.md` under `Nested runs`.
2. Drive the nested run to completion. Its responsibilities (defined in
   that workflow, not here) are:
   - read `release-book.md` and every nested run's notes
   - extract patterns: which steps blocked, which `Anomalies` recurred
     across releases, which nested workflows themselves need updates
   - publish a retrospective page under
     `pages/releases/<release_version>.md` in the wiki named by the
     `knowledge_wiki` parameter
   - file follow-up issues for each actionable lesson
3. When the retro finishes, link its wiki page from `release-book.md`
   under `Artefacts`.

If `workflows/release-retrospective` does not yet exist in the stash,
this step blocks with a note pointing the next agent to create it —
that creation work is itself a small `ship-feature-from-spec` run, and
recording the gap in the run is more valuable than papering it over with
ad-hoc notes here.

### gate

- A nested retro run is started, completed, and its run id is recorded.
- A retrospective wiki page exists at
  `pages/releases/<release_version>.md` in the `knowledge_wiki` wiki and
  is linked from `release-book.md`.
- Every actionable lesson is filed as a tracked issue, not left as a
  bullet in the wiki page.

## close-release-book

Make the orchestrator's audit trail self-contained, using the retrospective
produced by `nested-retrospective`, attached to this unit as input.

1. Update `release-book.md` so every section has a real value:
   `Inputs`, `Nested runs` (with each id and final state), `Artefacts`
   (changelog, tag, deploy log, retro), `Anomalies`.
2. Save this run's id and the release version as a memory so future
   releases can pattern-match:

   ```sh
   akm remember "Release <release_version> ran via orchestrator
   run <run-id>; deploy succeeded on first attempt; nested
   dependency audit produced 2 follow-up issues."
   ```

3. Refresh the stash index so the retrospective's wiki page (written by
   the nested run in the previous step) is searchable — wiki pages are
   plain files edited directly with file tools, and there is no
   `akm wiki` command family to ingest or lint them:

   ```sh
   akm index
   ```

### gate

- `release-book.md` has no empty sections.
- A memory linking this orchestrator run to its release version is
  stored.
- `akm index` completes cleanly.
