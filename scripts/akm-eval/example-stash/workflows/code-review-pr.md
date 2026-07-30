---
type: workflow
description: Review a single pull request against the project's actual conventions and prior decisions, leaving structured feedback that an author can act on without a follow-up call. Doubles as a way to capture review heuristics back into the stash.
tags: [example, code-review, pull-requests, feedback, memory]
params:
  pr_ref: { type: string, description: "Pull request reference (e.g. `gh:itlackey/akm#214`, or a freeform PR ID for non-GitHub forges)." }
  reviewer_persona: { type: string, description: "Optional persona ref to bias the review (e.g. `skills/senior-typescript-reviewer`, `skills/security-reviewer`). Defaults to a generalist reviewer." }
  workspace_dir: { type: string, description: "Directory for run artefacts. Defaults to a per-run directory such as `.akm-run/<run-id>/`." }
  conventions_query: { type: string, description: "Search query used to discover project conventions in the stash (e.g. `error handling conventions`, `react component style`). Defaults to the PR title." }
  knowledge_wiki: { type: string, description: "AKM wiki to consult for prior architectural decisions and to update with new heuristics. Defaults to `engineering`." }
steps:
  - id: load-context
  - id: read-with-intent
    inputs: [steps.load-context.output]
  - id: apply-rubric
    inputs: [steps.read-with-intent.output]
  - id: post-review
    inputs: [steps.apply-rubric.output]
  - id: capture-heuristics
    inputs: [steps.post-review.output]
---

# Code Review PR

A repeatable structure for high-signal PR review. The goal is to give the
author the smallest set of changes that materially improve the patch — not to
relitigate the architecture and not to nit-pick. The workflow also captures
durable lessons so the next reviewer benefits from this one's effort. Every
path below is relative to the workspace directory named by the
`workspace_dir` parameter, unless stated otherwise.

## load-context

A review starts with context the author already had, not a blank slate.

1. Pull the PR metadata and diff for the pull request named by the `pr_ref`
   parameter:

   ```sh
   gh pr view <pr_ref> --json title,body,author,headRefName,baseRefName,additions,deletions,files,labels
   gh pr diff <pr_ref> > pr.diff
   ```

   Cache the JSON in `pr-meta.json`.
2. Discover project conventions relevant to the changed surfaces, using the
   query named by the `conventions_query` parameter (or the PR title, if that
   parameter is empty). Wiki pages are indexed like any other asset, so a
   plain stash search covers both (there is no `akm wiki search`):

   ```sh
   akm search "<conventions_query>"
   ```

   Record the top 5 hits in `conventions.md` with a one-line note on whether
   each applies to this PR.
3. If the `reviewer_persona` parameter is set, load it and treat its review
   rubric as the authoritative checklist:

   ```sh
   akm show <reviewer_persona>
   ```

### gate

- `pr-meta.json` and `pr.diff` are saved to disk for offline re-reading.
- `conventions.md` lists relevant stash and wiki hits with applicability
  notes.
- The reviewer persona (if any) is loaded; otherwise the run notes
  explicitly state the generalist rubric is in use.

## read-with-intent

Three passes, in order. Do not skip ahead. Use the PR metadata and diff
gathered by `load-context`, attached to this unit as input.

1. **What is the PR trying to do?** Read the description and the linked
   issue. Write a one-paragraph summary in `intent.md`. If you cannot
   articulate the intent from the description, that is itself review
   feedback — record it.
2. **Does the diff implement the stated intent?** Walk the files in the
   order the author put them in the PR. For each file, note in
   `walkthrough.md`:
   - what changed in this file
   - whether it serves the intent or seems orthogonal
   - any callers/tests it implies but does not include
3. **What did the diff *not* change that you expected?** Missing test
   coverage, missing migration, missing changelog entry, missing
   documentation. Record those gaps separately under a `## Gaps` section
   in `walkthrough.md`.

### gate

- `intent.md` summarises the goal in your own words.
- `walkthrough.md` covers every file in the diff and lists expected-but-
  missing changes under `Gaps`.
- Off-topic refactors are flagged for the author to split out, not
  silently approved.

## apply-rubric

Score the PR against an explicit rubric so feedback is calibrated, not
vibes-based, drawing on the walkthrough produced by `read-with-intent`,
attached to this unit as input.

For each rubric item, write a verdict in `rubric.md`: `pass`, `concern`,
`block`, with one line of justification.

Default rubric (extend per the loaded `reviewer_persona`, if any):

1. **Correctness** — does it implement the stated intent and only that?
2. **Tests** — is the new behaviour covered, including edge cases the diff
   itself implies (boundary conditions, error paths, concurrency)?
3. **Conventions** — does it match the patterns in `conventions.md`, or
   if it diverges, is the divergence justified in the PR body?
4. **Security and data integrity** — any new input is validated, secrets
   never logged, no obvious injection or auth bypass.
5. **Reversibility** — can this be reverted cleanly? Database migrations
   and feature flag flips are called out.
6. **Diff hygiene** — no unrelated formatting, no dead code, no debug
   logging, commit messages explain the *why*.

Promote a `block` verdict only when the issue would harm production or
permanently regress a contract. A code style preference is a `concern`,
not a `block`.

### gate

- Every rubric item has a verdict and a one-line justification.
- `block` verdicts cite a concrete production or contract harm.
- Style preferences are filed as `concern`, not `block`.

## post-review

A good review reads as a single coherent message, not 14 separate inline
comments that contradict each other. Use the rubric verdicts produced by
`apply-rubric`, attached to this unit as input.

1. Draft `review.md` with this structure:
   - **Summary**: 2–3 sentences on what this PR does and overall verdict.
   - **Required to merge** (`block` items): each one tied to a file/line
     and the rubric item it failed.
   - **Strongly suggested** (`concern` items): same structure, but
     explicitly optional.
   - **Optional / nits**: clearly labelled, never promoted.
   - **What worked well**: at least one specific thing — calibration
     matters as much for praise as for criticism.
2. Post the review:

   ```sh
   gh pr review <pr_ref> --request-changes -F review.md
   ```

   (Use `--approve` or `--comment` instead if there are no `block`
   items.)
3. Record inline comments only for items that need to point to a specific
   line and would be ambiguous in the summary.

### gate

- A single review is posted with `block`, `concern`, and nit sections
  clearly separated.
- Inline comments exist only where a line reference is necessary.
- The review includes at least one specific positive observation.

## capture-heuristics

A review that taught you something should leave a trace beyond the PR
thread, drawing on the posted review from `post-review`, attached to this
unit as input. A wiki is a plain directory (`schema.md` + `pages/`) that the
agent edits directly with its normal file tools — there is no `akm wiki`
write command. Find the wiki's filesystem path with
`akm bundle list --format json` (the matching source's `path` field) if you
do not already have it.

1. If a recurring pattern surfaced (good or bad) that future reviews
   should look for, write or update a page under `pages/` in the wiki named
   by the `knowledge_wiki` parameter describing it. One page per pattern,
   not one mega-page.
2. Save personal review heuristics with `akm remember`:

   ```sh
   akm remember "When reviewing PRs that touch the FTS5 indexer, always
   check that schema-version bumps are handled in db.ts and not just in
   schema.ts."
   ```

3. If the `reviewer_persona` parameter was used and it surfaced a useful
   prompt or missed something important, signal that with `akm feedback`:

   ```sh
   akm feedback <reviewer_persona> --positive --reason "Caught an
   auth-bypass pattern I would have missed."
   # or
   akm feedback <reviewer_persona> --negative --reason "Missed an
   obvious test gap; rubric needs a coverage step."
   ```

4. Re-index so future reviews find the new material:

   ```sh
   akm index
   ```

### gate

- At least one of: a wiki page added/updated, a memory recorded, or an
  explicit note that this PR carried no durable lesson.
- If `reviewer_persona` was used, a feedback signal is recorded.
- `akm index` completes cleanly.
