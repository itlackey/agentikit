---
type: workflow
description: Take a written spec or issue from "agreed on the shape" to a merged, deployed change. Optimised for the case where the work is too small to need full release-train ceremony but too important to YOLO straight into main.
tags: [example, features, delivery, tdd, env]
params:
  spec_ref: { type: string, description: "Reference to the agreed spec — a stash asset (e.g. `knowledge/engineering/spec-foo`), an issue (`gh:itlackey/akm#214`), or a path under the run workspace." }
  base_branch: { type: string, description: "Branch to cut the feature branch from. Defaults to `main`." }
  feature_slug: { type: string, description: "Short kebab-case slug used in branch and PR names (e.g. `fts5-tokenizer-v2`)." }
  workspace_dir: { type: string, description: "Directory for run artefacts. Defaults to a per-run directory such as `.akm-run/<run-id>/`." }
  env: { type: string, description: "Optional env ref for any credentials the test or deploy needs (e.g. `env/integration-tests`)." }
  knowledge_wiki: { type: string, description: "AKM wiki to consult for prior decisions and update with new ones. Defaults to `engineering`." }
steps:
  - id: anchor-spec
  - id: failing-test
    inputs: [steps.anchor-spec.output]
  - id: implement
    inputs: [steps.failing-test.output]
  - id: tidy
    inputs: [steps.implement.output]
  - id: verify-integration
    inputs: [steps.tidy.output]
    # Retry lives here, not in a backward route: a gap found during
    # integration is fixed and re-verified inside this same step, re-run
    # (with the judge's feedback) up to 3 times by the gate below.
    gate: { max_loops: 3 }
  - id: open-pr-and-document
    inputs: [steps.verify-integration.output]
---

# Ship Feature From Spec

A pragmatic delivery loop: read the spec, write the test first, make it
pass, leave the codebase a little better than you found it, and document
the decision so the next person who touches this code finds your reasoning
instead of guessing it. Every path below is relative to the workspace
directory named by the `workspace_dir` parameter, unless stated otherwise.

## anchor-spec

Before writing any code, make sure you actually understand the spec the same
way the person who wrote it does.

1. Resolve the spec named by the `spec_ref` parameter and copy its content
   into `spec.md`. If the spec lives in the wiki:

   ```sh
   akm show <spec_ref> > spec.md
   ```

2. Search for related decisions and prior implementations, using the
   `feature_slug` parameter as the query. Wiki pages are indexed like any
   other asset, so a plain stash search covers both (there is no
   `akm wiki search`):

   ```sh
   akm search "<feature_slug>"
   ```

   Capture relevant hits in `related.md` with one line on why each matters.
3. Write `understanding.md` in your own words: what is in scope, what is
   explicitly out of scope, what the success criteria are, and any open
   questions. If there are open questions, block the run and ask them — do
   not guess.

### gate

- `spec.md` is a verbatim copy of the agreed spec.
- `related.md` lists prior art and notes whether each constrains this work.
- `understanding.md` states scope, non-goals, and success criteria; open
  questions either resolved or surfaced as blockers.

## failing-test

Test-first is non-negotiable here. The test encodes the spec; the test
passing is the definition of done. Ground this step in the understanding
written by `anchor-spec`, attached to this unit as input.

1. Cut the branch from a fresh base, named by the `base_branch` parameter:

   ```sh
   git fetch origin <base_branch>
   git switch -c feat/<feature_slug> <base_branch>
   ```

2. Write the smallest test that demonstrates the new behaviour, named to
   match the spec's success criterion. Place it next to the existing tests
   for the affected module.
3. Run the test and capture the failing output to `red.log`. The failure
   must be for the *right* reason — a missing implementation, not a typo or
   import error.
4. If the spec implies multiple behaviours, write the failing test for the
   most important one first. Stash the rest as `## Pending tests` in
   `test-plan.md`.

### gate

- A feature branch exists from a fresh base, named after the `feature_slug`
  parameter.
- A failing test exists and is committed; `red.log` shows it failing for
  the intended reason.
- `test-plan.md` lists the remaining tests to add as the implementation
  progresses.

## implement

Resist the urge to refactor while implementing. Make it work first; tidy
in a separate step. Turn the failing test from `failing-test`, attached to
this unit as input, into a passing one.

1. Implement the smallest change that turns `red.log` into a passing run.
   Avoid touching files unrelated to the failing test.
2. Run the project's gates after each meaningful edit:

   ```sh
   bunx biome check --write src/ tests/
   bunx tsc --noEmit
   bun test
   ```

3. As each pending test from `test-plan.md` becomes relevant, add it,
   watch it fail, then make it pass. Commit per logical change with a
   message that explains *why*, not what.
4. If a planned approach hits a wall, do not silently change the spec.
   Stop, document the wall in `blockers.md`, and either revise
   `understanding.md` (if the user agrees) or block the run.

### gate

- All tests in `test-plan.md` are added and passing.
- Lint, typecheck, and test gates pass cleanly on the branch.
- Every commit message names the *why*, not just the *what*.

## tidy

Now you are allowed to refactor — but only what you touched, and only what
the diff already justifies. Review the implementation from `implement`,
attached to this unit as input.

1. Re-read the diff (`git diff <base_branch>...HEAD`) as if you were the
   reviewer:
   - Are there obvious naming improvements in code you already changed?
   - Is there a comment explaining a non-obvious invariant where it would
     genuinely help?
   - Is there dead code, debug logging, or commented-out blocks?
2. Apply only changes that the existing diff already justifies. Resist
   sweeping refactors; file them as follow-up issues instead.
3. Re-run gates. If anything regresses, the tidy was too aggressive —
   revert and try a smaller pass.

### gate

- The diff contains no dead code, debug prints, or unrelated formatting.
- Refactors are confined to files the feature already touched.
- Out-of-scope cleanups are filed as follow-up issues, not bundled in.

## verify-integration

Unit tests are necessary, not sufficient. Exercise the change through the
real entry points before opening the PR, using the tidied diff from `tidy`,
attached to this unit as input.

1. If the change has a CLI surface, run it end-to-end with realistic
   inputs and capture the transcripts to `integration.log`.
2. If the change has a UI surface, run it in the dev server and verify the
   golden path *and* the most plausible edge cases. Note explicitly in
   `integration.log` if you could not exercise the UI.
3. If integration requires credentials, load them only into the test
   shell, using the `env` parameter:

    ```sh
    akm env run <env> -- <integration-command>
    ```

   The credentials must never appear in `integration.log`.
4. If integration uncovers a gap, do not report it and move on: add the
   missing test right here (next to the others from `failing-test`), watch
   it fail, implement the fix, tidy it, and re-run this step's checks
   before reporting again. If you are re-entering this step because the
   gate below rejected a previous attempt, its feedback names exactly what
   was missing — close that gap specifically rather than re-verifying from
   scratch.

### gate

- `integration.log` shows the change exercised through realistic entry
  points, with no known gap left unaddressed.
- Any UI changes were verified manually and that verification is recorded.
- Credentials never appear in any artefact written to the workspace.

## open-pr-and-document

The PR is the durable artefact. Make it readable, using the verification
evidence from `verify-integration`, attached to this unit as input.

1. Push the branch and open the PR:

   ```sh
   git push -u origin feat/<feature_slug>
   gh pr create --base <base_branch> --title "feat: <feature_slug>" \
     --body-file pr-body.md
   ```

   Build `pr-body.md` from `understanding.md` (intent and scope),
   `test-plan.md` (verification), and a manual test plan derived from
   `integration.log`.
2. If the spec implied a non-trivial architectural choice, write or
   update an ADR-style page under `pages/decisions/` in the wiki named by
   the `knowledge_wiki` parameter, recording the choice, the rejected
   alternatives, and the reasoning. Pages are edited directly with your
   file tools — there is no `akm wiki` write command; find the wiki's
   filesystem path with `akm bundle list --format json` if you do not
   already have it.
3. Re-index so the new decision is searchable:

   ```sh
   akm index
   ```

4. Record any heuristics you'd want next time:

   ```sh
   akm remember "When implementing tokenizer features, write the FTS5
   round-trip test before touching the parser — saved an afternoon."
   ```

### gate

- A PR is open with a body that summarises intent, verification, and
  manual test plan.
- Architectural decisions implied by the spec are recorded as a wiki
  page under `pages/decisions/`.
- `akm index` completes cleanly so the new decision page is searchable.
