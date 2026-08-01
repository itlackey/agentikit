---
type: workflow
description: Drive a batch of GitHub issues to merged PRs using a multi-agent development, review, and testing loop on isolated git worktrees.
tags: [example, github, multi-agent, parallel, worktrees]
params:
  repo: { type: string, description: "Target repository in `owner/name` form (e.g. `itlackey/akm`)." }
  issues: { type: array, description: "GitHub issue numbers to implement (e.g. `[142, 167, 171]`). The workflow will order and batch them." }
  base_branch: { type: string, description: "Branch to cut feature branches from and ultimately open PRs against. Defaults to `main` when omitted." }
  integration_branch: { type: string, description: "Optional long-lived branch name used when multiple issues must be delivered together. When omitted, each issue ships as its own PR." }
  reviewers: { type: array, description: "Reviewer agent roles required to approve each issue (e.g. `[\"senior-engineer\", \"security\", \"domain-expert\"]`). All listed reviewers must approve." }
  required_checks: { type: array, description: "Required status checks (e.g. `[\"lint\", \"typecheck\", \"unit\", \"integration\", \"e2e\"]`). All must pass before an issue is marked complete." }
  env: { type: string, description: "Optional `env:` ref with credentials needed for CI, deploy previews, or private package registries. Use `akm env run` for command-scoped env injection." }
defaults: { on_error: fail }
steps:
  - id: intake
    output: { type: object }
  - id: plan-and-order
    inputs: [steps.intake.output]
    output: { type: object }
  - id: prepare-worktrees
    inputs: [steps.plan-and-order.output]
  - id: implement
    inputs: [steps.prepare-worktrees.output]
    map:
      over: steps.plan-and-order.output.ordered_issues
      concurrency: 3
      unit: { isolation: worktree, retry: { max: 2, on: [timeout] } }
    # `output` describes the REDUCER RESULT: the default `collect` reducer
    # folds per-issue unit results into an array, one entry per issue.
    output: { type: array }
    # Retry lives here, not in a backward route: a rejected gate re-runs
    # THIS step's units with the judge's feedback, bounded by max_loops. If
    # the batch still isn't clean after 8 loops, the step (and the run)
    # fails — the escalation the original design wanted is exactly what a
    # failed run already is: a human resolves it via `akm workflow resume`
    # or `akm workflow abandon`.
    gate: { max_loops: 8 }
  - id: integrate
    inputs: [steps.implement.output]
  - id: open-prs
    inputs: [steps.integrate.output]
  - id: watch-and-respond
    inputs: [steps.open-prs.output]
  - id: archive
    inputs: [steps.watch-and-respond.output]
---

# GitHub Issues Parallel Implementer

This workflow drives a batch of GitHub issues to merged PRs. `implement` fans
out one unit per issue — each running in its own isolated git worktree, up to
3 at a time. `implement`'s own gate re-runs the step (with the judge's
feedback) up to 8 times when the batch is not yet clean; if it still isn't
clean after that, the step — and the run — fails, and a human resolves it
via `akm workflow resume` or `akm workflow abandon`, which is the escalation the
original design wanted. Adjust the `implement` step's `concurrency` in this
file's frontmatter to change how many issues run in parallel.

## intake

You are the **orchestrator agent** for this run. Before doing any coding
work, establish a clean baseline and confirm every parameter is actionable.

### Verify parameters

1. Parse the `issues` parameter. Fail the step with a precise diagnostic if it
   is not a non-empty list of positive integers.
2. Confirm the repository named by the `repo` parameter is reachable via
   `gh repo view <repo>`. If the CLI is unauthenticated, surface the error
   verbatim and fail the step — do not attempt to log in silently.
3. Resolve the `base_branch` parameter (default `main`) and confirm it
   exists on the remote with `git ls-remote --heads origin <base_branch>`.
4. If the `env` parameter is provided, call `akm show <env>` and verify every
   key the downstream tooling needs is declared. Do not print values. If any
   key is missing, fail the step with a diagnostic listing the missing keys.

### Capture ground truth for every issue

For each issue number in the `issues` parameter:

- Fetch the full issue body, labels, assignees, and linked PRs via
  `gh issue view <n> --json number,title,body,labels,assignees,comments,closedByPullRequestsReferences`.
- Record the payload in the run notes so later steps can replay context
  without another API round-trip.
- Flag issues that are already `closed`, have a merged linked PR, or are
  marked `blocked` / `needs-triage`. These are removed from the working set
  and reported back to the user before planning.

### Prepare a shared workspace

- Create a scratch directory scoped to this run (outside of any existing
  worktree). Store issue payloads, plan artefacts, and per-issue logs here.
- Ensure the repo has no uncommitted changes on the current branch. If it
  does, abort with a `blocked` state — never stash or discard user work.
- Fetch the latest `base_branch` with `git fetch origin <base_branch>` so
  subsequent worktrees branch from fresh commits.

### Hand-off contract

The next step can assume:

- Every issue in the working set has a cached payload on disk.
- `base_branch` is up to date locally.
- Required secrets are declared (but not loaded into the agent context).

### gate

- `issues` parsed to a non-empty list of open, actionable GitHub issues.
- `repo`, `base_branch`, and (if provided) `env` all pass their health checks.
- Working set, scratch directory, and cached issue payloads are recorded in
  the run notes.
- Any excluded issues are listed with the reason they were dropped.

## plan-and-order

Produce a dependency-aware execution plan from the working set captured by
`intake`, attached to this unit as input. This step runs **exclusively in
planning mode** — no code changes, no branches, no worktrees.

### Dispatch the planner agent

Launch one planner agent with the cached issue payloads plus the current
codebase index. Instruct it to:

1. Read each issue and classify it by **type** (bug, feature, refactor,
   docs, infra) and **blast radius** (single-file, module, cross-cutting).
2. Identify **hard dependencies** — issue B explicitly says "after #A", a
   shared schema change, a migration that must land first. Represent these
   as a directed acyclic graph. Abort with `blocked` if a cycle is found and
   surface the cycle in notes.
3. Identify **soft conflicts** — two issues that touch overlapping files,
   tests, or public APIs. These may still run in parallel but must be
   flagged so the integration step can merge in a deterministic order.
4. Produce one ordered list of issue numbers — the working set arranged so
   that no issue precedes one it hard-depends on. This becomes
   `ordered_issues`, the list `implement` fans out over.
5. For each issue, draft a short **implementation brief**: acceptance
   criteria pulled from the issue body, files likely to change, test
   surfaces that must be exercised, and any risk callouts (perf, security,
   data migration).

### Validate the plan with a second agent

Spawn an independent **plan reviewer agent** with no memory of the planner's
reasoning. Give it only the issue payloads and the planner's output. Ask it
to:

- Challenge every dependency edge — is it real, or could the issues run in
  parallel?
- Challenge the ordering — is there a hidden conflict the planner missed
  (shared migrations, shared feature flags, shared API contracts)?
- Confirm each brief's acceptance criteria are testable. Reject vague
  criteria like "it should feel faster".

Iterate until the reviewer signs off or escalate to the user when the two
agents cannot converge within three rounds.

### Persist the plan

Report a structured result with:

- `ordered_issues`: the dependency-respecting order `implement` fans out
  over.
- `briefs`: map of issue number to `{ acceptance, files, tests, risks }`.
- `soft_conflicts`: list of `[issueA, issueB, reason]` tuples for the
  integration step.

Also write the plan to a `plan.md` artefact in the run's scratch directory,
recording the total issue count and any escalations, so an interrupted run
can resume from this artefact alone.

### gate

- `ordered_issues`, `briefs`, and `soft_conflicts` are all populated.
- The plan has been independently reviewed by a second agent and signed off.
- No dependency cycles remain; every dropped or re-ordered issue has a
  reason recorded.
- At least one testable acceptance criterion per issue.

## prepare-worktrees

Create one git worktree per issue in the working set so implementation
agents are fully isolated, using the plan from `plan-and-order`, attached to
this unit as input. `implement`'s own gate re-runs its units (with fresh
per-attempt isolation) when the batch isn't yet clean, so this step runs
once per run — it does not need to be repeated for a retry pass.

### For every issue in the working set

1. Derive a branch name from the issue: `agents/<run-id>/issue-<n>-<slug>`
   where `<run-id>` is this run's id and `<slug>` is a kebab-cased,
   length-capped form of the issue title.
2. Create the worktree:
   `git worktree add <scratch-dir>/wt/<n> -b <branch> origin/<base_branch>`.
3. Seed the worktree with any run-scoped context files it needs (the brief,
   the acceptance criteria, the relevant test commands). Do not copy
   secrets.
4. Inside the worktree, run the project bootstrap: install dependencies,
   run a baseline build, and run the full test suite once. Record the
   baseline results (pass/fail counts, duration) so regressions introduced
   by the implementer are unambiguous.

### Failure handling

- If bootstrap or the baseline test run fails on an untouched worktree, the
  issue is marked `blocked` with the failing output in notes. The workflow
  does not pretend a broken baseline is acceptable.
- If a worktree already exists from a previous run, reuse it only after
  running `git worktree prune` and confirming the branch head matches the
  expected commit. Otherwise remove and re-create it.

### gate

- Every outstanding issue has a dedicated worktree on a fresh branch from
  `base_branch`.
- A green baseline build and test run is recorded for each worktree.
- Any issue that failed bootstrap is explicitly marked `blocked` with a
  diagnostic excerpt.

## implement

This section is the **map unit template** — the engine dispatches one unit
per issue in `ordered_issues`, up to 3 in parallel, each inside its own
isolated worktree (retried up to twice on a timeout). Drive a closed loop
between **implementer**, **reviewer(s)**, and **tester** roles, playing each
role yourself in sequence, until the issue you were given is either accepted
or escalated.

### Roles

- **Implementer**: owns the code changes for this issue inside its
  worktree. May consult skills, run tooling, and inspect the codebase, but
  never bypasses tests or linters.
- **Reviewers**: one per role listed in the `reviewers` parameter. Each
  reviewer reads only the diff, the brief, and the test output — not the
  implementer's reasoning. Reviewers vote independently.
- **Tester**: runs the suite named by the `required_checks` parameter,
  reports raw results, and never fixes failures. The tester is the source
  of truth for whether checks pass.

### Iteration protocol

Each round proceeds in this order. Do not skip steps even when a round feels
trivial.

1. **Implement**: apply focused changes mapped to the brief's acceptance
   criteria. Diffs must stay on-topic — drive-by refactors are rejected by
   the reviewer unless the brief asks for them.
2. **Self-check**: run lint, typecheck, and the fast test subset locally
   before requesting review. If any fail, iterate before handing off.
3. **Test**: run every command in `required_checks`, capture the full
   output to a per-round log, and produce a structured pass/fail map. Flaky
   tests are re-run once and annotated.
4. **Review**: render an independent verdict of `approve`, `request_changes`,
   or `block` for each reviewer role. Cite file paths and line numbers.
   Reviews are posted as structured comments on the worktree branch for
   auditability.
5. **Adjudicate**: the round passes only when **all** reviewers approve
   **and** every required check is green. Any `block` verdict halts the
   loop and escalates.

### Quality gates that must be enforced every round

- No test is skipped, `.only`-focused, or commented out to make the suite
  pass.
- Public API changes include updated type definitions and documentation in
  the same diff.
- Any new dependency requires an explicit note in the PR description
  explaining why an existing one did not suffice.
- Security-sensitive diffs (auth, crypto, shell invocation, SQL,
  deserialization) require the `security` reviewer to approve explicitly
  even when not listed by default.
- Performance-sensitive paths include a before/after measurement captured
  during the test phase.

### Reporting your result

Report a structured result for the issue you were given, with at least a
`status` field:

- `"clean"` — every reviewer in `reviewers` approved, every check in
  `required_checks` is green against the head commit, the diff is focused
  on the brief, and a short summary plus the reviewer verdicts and tester
  log are written under the run's scratch directory.
- anything else (e.g. `"blocked"`) — the issue could not be brought to a
  clean state this round; include the last round's artefacts and the reason
  in the summary.

Every unit's result becomes one entry of `steps.implement.output`, the
array `integrate` and `open-prs` read below.

If a reviewer posts `block` (as opposed to `request_changes`), report
`blocked` immediately — a `block` verdict means the approach itself is
wrong and more iteration will not fix it. The gate on this step bounds
retries to 8 loops for the whole batch; if the batch still isn't clean
after that, this step (and the run) fails rather than shipping a partial
result — a human resolves it via `akm workflow resume`, which is the
escalation the original design wanted.

### gate

This gate judges the whole batch's array of per-issue results, not one
issue in isolation — so it can pass a batch that is a legitimate mix of
accepted and explicitly-blocked issues, and only rejects (triggering a
retry of the batch) when an issue was left in an indeterminate state.

- Every issue in the batch reached a terminal `status`: `"clean"` (every
  listed reviewer approved, every required check is green) or explicitly
  `"blocked"` with a reason — none left in-progress.
- Every accepted issue has a diff focused on the brief (unrelated files
  reverted) and a short implementer summary, reviewer verdicts, and tester
  log written to the run's scratch directory.

## integrate

Accepted issue branches may still conflict when combined. This step merges
them in a controlled order and re-validates the combined result, using the
per-issue results from `implement`, attached to this unit as input (an
array with one entry per issue).

### Determine integration mode

- If the `integration_branch` parameter is empty, skip merging — each
  accepted issue will ship its own PR in the next step. Jump to the
  completion criteria.
- If `integration_branch` is set, create it from `base_branch` and
  fast-forward or merge each accepted issue branch in `ordered_issues`
  order, honouring the `soft_conflicts` the planner recorded.

### Merge procedure for the integration branch

1. Check out the integration branch in a dedicated worktree.
2. For each accepted issue, in plan order:
   - Merge with `git merge --no-ff` to preserve per-issue history.
   - Run the full `required_checks` suite after each merge. A failure
     triggers a rollback of just that merge (`git reset --hard HEAD~1`) and
     an entry in notes; mark that issue `blocked` with a conflict-aware
     brief for a follow-up run rather than reworking it inside this one.
3. After all merges land, run the test suite one more time from a clean
   install to catch caching or lockfile drift.
4. Generate a combined diff summary and feed it to one **integration
   reviewer** agent. Its only job is to catch semantic conflicts that
   per-issue reviews could not see — overlapping feature flags, duplicated
   utilities, inconsistent logging, redundant migrations.

### Hygiene

- Update lockfiles and regenerated artefacts in a single dedicated commit so
  the PR remains reviewable.
- If any accepted issue must be reverted to stabilise the integration
  branch, mark that issue `blocked` and reopen it in the next run — never
  silently drop work.

### gate

- Integration branch exists, builds cleanly, and passes every
  `required_checks` entry from a clean install.
- Integration reviewer has approved the combined diff or escalated with
  specific file references.
- Any reverted issue is explicitly marked `blocked` with a new brief for a
  follow-up run.
- Skipped entirely when `integration_branch` is empty (and this fact is
  recorded in notes).

## open-prs

Turn the accepted branches into pull requests that a human reviewer can
approve without reconstructing the run, using the integration result,
attached to this unit as input.

### For each PR to open

1. Push the branch with `git push -u origin <branch>`. Retry network errors
   up to four times with exponential backoff (2s, 4s, 8s, 16s). Do not use
   `--force` or `--no-verify`.
2. Open the PR against `base_branch` with `gh pr create`. The title must
   reference the issue (`Fixes #<n>: <short title>`). The body must
   include:
   - A one-paragraph summary of the change.
   - The acceptance criteria from the brief, each with a check mark and a
     one-line proof (commit sha, test name, or screenshot path).
   - The reviewer verdicts from `implement` with agent role and timestamp.
   - The full `required_checks` result matrix for the head commit.
   - Links to the run notes and per-issue summary.
3. Request the human reviewers configured on the repo (CODEOWNERS, default
   reviewers, or the users specified in the issue). Do not request AI
   agents as GitHub reviewers — agent approval is captured in the body.
4. Apply the labels the planner recommended (e.g. `type:bug`, `area:cli`,
   `risk:low`). Never add a `ready-to-merge` or equivalent label — that is
   a human decision.

### If using an integration branch

Open a single PR for `integration_branch -> base_branch`. Its body must
enumerate every included issue, link each issue's individual summary file,
and preserve the per-issue reviewer verdicts.

### Verify the PR

- Confirm the PR number, URL, and head sha are recorded in the run notes.
- Trigger CI with a comment (`gh pr comment <n> --body "/ci run"` or the
  repo's convention) only if CI does not fire automatically on push.
- If a PR cannot be opened (permission denied, branch protection
  violation), mark the step `blocked` with the error and do not retry
  silently.

### gate

- Every accepted issue has an open PR with the required body sections
  populated.
- Every PR references its issue via `Fixes #<n>` (or the repo's equivalent
  keyword).
- PR numbers, URLs, and head shas are captured in the run notes.
- No PR was force-pushed or opened with verification skipped.

## watch-and-respond

PRs are not done when they are opened; they are done when they merge or are
explicitly closed. This step is long-running and intentionally re-enterable,
working from the PRs opened by `open-prs`, attached to this unit as input.

### CI watch

- Poll PR checks via `gh pr checks <n>` until every required check settles.
  Do not sleep-poll from the agent loop — use the CI provider's
  webhook/subscription when available and fall back to timed polling with
  exponential backoff.
- On a red check, fetch the failing job logs and produce a minimal
  reproduction. Do not patch the red check in isolation on this branch —
  file a `ci-regression` brief and drive the fix through a fresh full run so it
  goes through the implement/review/test loop again rather than landing
  unreviewed:

  ```sh
  akm workflow run workflows/github-issues-parallel-implementer \
    --repo "<repo>" \
    --issues '[<n>]' \
    --base_branch "<base_branch>" \
    --reviewers '<reviewers-json-array>' \
    --required_checks '<required-checks-json-array>'
  ```

### Review feedback

- When a human reviewer leaves comments, route each comment to the
  implementer for response. Each response must either:
  - Update the code and the PR with a follow-up commit, or
  - Reply explaining why the suggestion does not apply, citing the brief, a
    constraint, or a measurement.
- Never resolve a review thread on behalf of the human reviewer — only the
  reviewer or the repo maintainer resolves their own threads.

### Merge readiness

An agent may request merge when:

- All required checks are green on the latest head sha.
- All human reviewers have approved or explicitly deferred.
- No unresolved blocking comments remain.
- The PR branch is up to date with `base_branch` — if not, rebase (or
  merge, per repo convention) and re-run CI before requesting merge.

Actual merging is a human decision unless the user has previously
authorised auto-merge for this workflow; in that case use
`gh pr merge --auto --squash` (or the repo's convention) and record the
request in notes.

### gate

- Every PR is in one of these terminal states: merged, closed with reason,
  or handed off to a named human owner with an explicit note.
- Every CI regression triggered a full re-run of the implement loop, not a
  bypass.
- Every human review comment has either a follow-up commit or a written
  response — none are silently ignored.

## archive

Leave the environment in the state a fresh run would expect to find it,
using the merge/close outcome from `watch-and-respond`, attached to this
unit as input.

### Artefacts

- Move the run's scratch directory to a long-term location (e.g. an
  `.akm-archive/` directory inside the stash, or an external artefact store
  configured by the user). Keep the plan, per-issue summaries, and final PR
  metadata — they are the audit trail for the run.
- Redact any accidentally captured secrets from logs before archiving. Use
  the keys declared in `env` as a denylist during redaction.

### Worktrees and branches

- For every worktree this run created, run `git worktree remove` after
  confirming the branch is either merged or explicitly preserved.
- Never delete a branch that has unmerged commits unless the user has
  approved it in this run.
- Prune stale worktree metadata with `git worktree prune` and leave the
  main checkout on its original branch.

### Run summary

Emit a final summary to the user covering:

- Count of issues processed, accepted, blocked, and deferred.
- Links to every PR with its merge state.
- Wall-clock duration per step and the total number of implement rounds
  consumed.
- Any escalations that still need a human decision, grouped so they can be
  handed off in a single message.

### gate

- Run artefacts archived or deliberately discarded with the user's
  acknowledgement.
- All temporary worktrees removed; no orphaned branches left on the local
  repo or remote.
- Final summary delivered to the user with explicit pointers to every PR
  and every outstanding escalation.
