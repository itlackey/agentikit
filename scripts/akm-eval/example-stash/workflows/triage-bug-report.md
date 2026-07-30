---
type: workflow
description: Triage a single bug report from intake to a reproducible failing test, a documented root cause, and a fix proposal — recording durable patterns to the knowledge base so the next similar bug is faster.
tags: [example, bugs, triage, wiki, memory]
params:
  bug_ref: { type: string, description: "Issue link or identifier for the bug being triaged (e.g. `gh:itlackey/akm#142`, `JIRA-1408`, or a freeform ID)." }
  repro_env: { type: string, description: "Environment where the bug must be reproduced (e.g. `node@20 + bun@1.1`, `staging`, `local-docker`)." }
  severity_hint: { type: string, description: "Reporter-provided severity hint (`low`, `medium`, `high`, `critical`). The triage step may revise this." }
  workspace_dir: { type: string, description: "Directory for run artefacts. Defaults to a per-run directory such as `.akm-run/<run-id>/`." }
  knowledge_wiki: { type: string, description: "AKM wiki to consult and update with durable patterns. Defaults to `engineering`." }
steps:
  - id: capture
  - id: reproduce
    inputs: [steps.capture.output]
  - id: localize
    inputs: [steps.reproduce.output]
  - id: propose-fix
    inputs: [steps.localize.output]
  - id: promote-lessons
    inputs: [steps.propose-fix.output]
  - id: handoff
    inputs: [steps.promote-lessons.output]
---

# Triage Bug Report

Bug triage is one of the most repetitive jobs an engineer does, and most of the
variance is friction: hunting for the last time we saw something similar,
reconstructing the reporter's environment, and forgetting to write down the
heuristic that finally cracked it. This workflow turns the work into a
checklist and writes its outputs back into the stash so the next triage
benefits. Every path below is relative to the workspace directory named by the
`workspace_dir` parameter, unless stated otherwise.

## capture

Pull the bug into the workspace before doing any analysis.

1. Create `report.md` with the verbatim bug body, reporter, timestamps,
   attachments, and any reproduction steps the reporter offered for the bug
   named by the `bug_ref` parameter.
2. Search the local stash for prior incidents that look related, using
   symptom keywords drawn from that bug report. Wiki pages are indexed like
   any other asset, so a plain stash search covers both (there is no
   `akm wiki search`):

   ```sh
   akm search "<symptom keywords>"
   ```

3. Record the top 5 hits in `prior-art.md` with one line of why each is
   relevant or why it was discarded. If a known-issue wiki page already
   documents the same root cause, link it and stop the workflow with
   `--state skipped --notes "duplicate of <wiki ref>"`.

### gate

- `report.md` captures the original report verbatim.
- `prior-art.md` lists the top stash and wiki hits with a relevance verdict.
- Duplicates are marked `skipped` with a pointer to the existing record.

## reproduce

A bug report you cannot reproduce is a bug report you cannot fix. Build the
smallest reliable repro before forming any hypotheses, starting from the
report and prior art captured by the `capture` step, attached to this unit as
input.

1. Stand up the environment named by the `repro_env` parameter from scratch —
   do not reuse a dirty local checkout.
2. Translate the reporter's steps into an executable script at `repro.sh` (or
   `repro.test.ts` if the bug surfaces in a test). Failing fast and noisily
   is the goal.
3. Run the script and capture stdout, stderr, and any relevant logs into
   `repro.log`.
4. If the bug does not reproduce, branch:
   - Add the missing details you needed (data fixtures, env vars, timing) to
     `report.md`.
   - Block the workflow with `--state blocked --notes "needs <missing detail>"`
     and request them from the reporter.

### gate

- `repro.sh` (or equivalent) reproduces the bug deterministically on a clean
  environment.
- `repro.log` shows the failing signal with timestamps.
- A non-reproducible report is blocked with a concrete information request,
  not silently closed.

## localize

Move from "it fails" to "this line, for this reason," using the repro
captured by the `reproduce` step, attached to this unit as input.

1. Bisect or trace through the failing path. Record each hypothesis you
   eliminate in `investigation.md` with a one-line note on why it was
   wrong — future-you needs the dead ends almost as much as the live ones.
2. When the failing site is identified, write a short root-cause explanation
   in `rootcause.md`:
   - the file and line range
   - the invariant that was violated
   - which inputs trigger it
   - which inputs do *not* trigger it (so the fix is not over-broad)
3. Re-rate severity using the impact you just measured, comparing it against
   the `severity_hint` parameter. Update `report.md` if it differs.

### gate

- `investigation.md` documents the eliminated hypotheses, not just the
  winning one.
- `rootcause.md` names a specific file, line range, and violated invariant.
- Severity is re-rated against measured impact, not the reporter's guess.

## propose-fix

Triage ends with a *proposal*, not a merged fix. The point is to hand a
reviewer a clean package, built on the root cause identified by the
`localize` step, attached to this unit as input.

1. Add a regression test that fails today and will pass after the fix.
   Place it next to existing tests for the affected module.
2. Sketch the smallest change that satisfies the failing test in
   `fix-proposal.md`:
   - the diff, or a precise description of the diff
   - why this is the minimal correct change
   - rejected alternatives and why
   - any follow-ups that should be tracked separately rather than bundled in
3. If the fix is mechanical and low-risk, you may also open a draft PR. If
   it is architecturally meaningful, stop here and let the regular feature
   workflow take over.

### gate

- A failing regression test exists and is committed to a feature branch.
- `fix-proposal.md` contains the minimal change, alternatives considered, and
  scope boundary.
- Larger refactors are explicitly *not* bundled into the fix.

## promote-lessons

The point of doing triage inside a workflow is that the *next* triage gets
faster. This step makes that real, drawing on the fix proposal produced by
`propose-fix`, attached to this unit as input. A wiki is a plain directory
(`schema.md` + `pages/`) that the agent edits directly with its normal file
tools — there is no `akm wiki` write command. Find the wiki's filesystem path
with `akm bundle list --format json` (the matching source's `path` field) if
you do not already have it, and follow that wiki's own `schema.md` for voice
and page-kind conventions.

1. Decide what about this bug is worth keeping:
   - Is the root cause an instance of a recurring pattern? If so, write or
     update a page under `pages/` in the wiki named by the `knowledge_wiki`
     parameter, describing the pattern, symptoms, and fix shape.
   - Is the diagnostic technique you used reusable? Add it to the same wiki
     under a `pages/techniques/` page.
2. Save personal heuristics that are not team-shareable (style preferences,
   intuitions, "always check this first") with `akm remember`:

   ```sh
   akm remember "When triaging FTS5 ranking bugs, always inspect the tokenizer
   config before the query parser."
   ```

3. Reindex so the new/updated page is searchable:

   ```sh
   akm index
   ```

### gate

- At least one of: a new/updated wiki page, a stored memory, or an explicit
  note that the bug carried no durable lesson.
- Any new/updated page was checked by hand against `schema.md` (xrefs
  resolve, sources cite real files) — there is no `akm wiki lint` command,
  and `akm lint` does not currently reach bundle-adapter content such as
  wiki pages.
- `akm search "<symptom>"` now returns the new page.

## handoff

Close the loop with the reporter and the team, referencing the lessons
promoted by the `promote-lessons` step, attached to this unit as input.

1. Post a triage summary on the bug ticket linking to:
   - `rootcause.md`
   - the regression test
   - `fix-proposal.md`
   - any wiki pages added in `promote-lessons`
2. Mark the ticket with the revised severity and assign the fix owner if it
   is not you.
3. Record this run's id and final state on the ticket so a later reader can
   find `akm workflow status <run-id>` for the audit trail.

### gate

- The bug ticket links to the rootcause, fix proposal, and regression test.
- Severity, owner, and next action are explicit.
- The run id is referenced on the ticket so the artefact trail is
  recoverable.
