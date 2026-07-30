---
type: workflow
description: Perform a behavior-preserving architectural cleanup that reduces duplication and switchboard logic without turning the codebase into a framework. Use when the architecture is drifting but product behavior must stay exactly the same.
tags: [example, architecture, refactor, cleanup, no-behavior-change]
params:
  target_path: { type: string, description: "Repository root or subdirectory to clean up. Defaults to the current workspace root." }
  context_docs: { type: array, description: "Optional list of docs, ADRs, or specs to anchor the cleanup." }
  reference_skill: { type: string, description: "Skill to load for cleanup rules and references. Defaults to `skills/architecture-cleanup`." }
  base_branch: { type: string, description: "Branch to diff against when reviewing behavior parity. Defaults to `main`." }
  workspace_dir: { type: string, description: "Directory for run artefacts. Defaults to a per-run directory such as `.akm-run/<run-id>/`." }
  review_scope: { type: string, description: "Optional focus area such as `search`, `indexing`, `agent integrations`, or `session logs`." }
steps:
  - id: load-rules
  - id: map-hotspots
    inputs: [steps.load-rules.output]
  - id: define-seam
    inputs: [steps.map-hotspots.output]
  - id: establish-parity
    inputs: [steps.define-seam.output]
  - id: adapt-first
    inputs: [steps.establish-parity.output]
  - id: verify-parity
    inputs: [steps.adapt-first.output]
  - id: capture-decision
    inputs: [steps.verify-parity.output]
---

# Architecture Cleanup

This workflow is for narrow, behavior-preserving architectural cleanup. The
goal is to make the codebase easier to understand and extend without
changing what it does. Every path below is relative to the workspace
directory named by the `workspace_dir` parameter, unless stated otherwise.

## load-rules

Before touching code, anchor the work in the documented rules.

1. Load the skill named by the `reference_skill` parameter:

   ```sh
   akm show <reference_skill>
   ```

2. Read the relevant local reference docs listed by the skill. At minimum,
   inspect:

   - `docs/architecture/internals/functional-contract-patterns.md`
   - any docs listed in the `context_docs` parameter

3. Write `rules.md` summarising:
   - what must stay behavior-identical
   - what seams are allowed to change
   - explicit non-goals
   - how tests constrain the work

### gate

- The skill and local architecture docs are loaded.
- `rules.md` captures invariants, non-goals, and the no-behavior-change rule.

## map-hotspots

The cleanup should be anchored in concrete hotspots, not aesthetics, guided
by the rules written by `load-rules`, attached to this unit as input.

1. Review the path named by the `target_path` parameter and list the
   specific duplication or switchboard problems in `hotspots.md`.
2. For each hotspot, record:
   - file path
   - why it is hard to maintain
   - which repeated pattern applies
   - what should remain centralized
   - what is a candidate for extraction
3. If the `review_scope` parameter is set, prioritize only that slice.

### gate

- `hotspots.md` lists concrete targets with file paths.
- Every target is mapped to an approved pattern, not a speculative
  abstraction.

## define-seam

Do not jump to a large redesign. Pick the smallest seam that removes a
concrete problem, using the hotspot map produced by `map-hotspots`, attached
to this unit as input.

1. For the top hotspot, write `seam.md` describing:
   - the smallest new contract or module boundary
   - how existing logic will be adapted behind it
   - why this does not create a framework
   - why this does not change behavior
2. Explicitly state the composition rule for the seam:
   - accumulate
   - first-match
   - best-match
   - mutate-in-place
3. If you cannot explain the seam in a short paragraph, it is too abstract.

### gate

- `seam.md` defines one small contract with explicit composition semantics.
- The seam removes a real hotspot and does not broaden scope unnecessarily.

## establish-parity

Architectural cleanup is constrained by existing behavior, guarded by the
seam design from `define-seam`, attached to this unit as input.

1. Identify the existing tests that cover the target hotspot.
2. Run the smallest relevant subset and save the results to
   `parity-before.log`.
3. Write `parity-plan.md` documenting:
   - which tests prove behavior parity
   - which commands or manual checks prove runtime parity
   - which tests are not allowed to change except for imports

### gate

- A before-state test log exists.
- `parity-plan.md` names the checks that will guard the cleanup.

## adapt-first

Move code behind the seam before reorganizing behavior, following the plan
established by `establish-parity`, attached to this unit as input.

1. Introduce the new seam with the thinnest possible adapter layer.
2. Keep behavior in place initially; route current code through the seam.
3. Only after parity is preserved should you simplify or delete the old
   switchboard logic.
4. Do not change fixtures, assertions, expected outputs, or product behavior.
   If a test must change for any reason other than imports, stop and treat it
   as a separate bug-fix or feature decision.

### gate

- The seam exists and current behavior flows through it.
- Any test edits are import-only.
- No user-visible functionality changes were introduced.

## verify-parity

Re-run the parity checks and compare the results against the adaptation
performed by `adapt-first`, attached to this unit as input.

1. Re-run the test subset from `parity-plan.md` and save the results to
   `parity-after.log`.
2. Run any required command-level or integration-level checks for the
   affected surface.
3. Review the diff against the branch named by the `base_branch` parameter:

   ```sh
   git diff <base_branch>...HEAD
   ```

4. Confirm the diff reflects architectural cleanup only, not silent feature
   changes.

### gate

- Before/after parity logs exist.
- The guarded tests still pass with the same expectations.
- The diff is architectural cleanup only.

## capture-decision

Leave behind enough context so the next cleanup repeats the same discipline,
citing the parity evidence from `verify-parity`, attached to this unit as
input.

1. Write `cleanup-summary.md` covering:
   - hotspot addressed
   - seam introduced
   - what stayed centralized
   - what was extracted
   - proof that behavior did not change
   - explicit non-goals that stayed out of scope
2. If the cleanup surfaced reusable heuristics, record them with:

   ```sh
   akm remember "Architectural cleanup rule: adapt behind a seam first, then simplify. Do not change tests except for imports during refactor-only work."
   ```

3. Re-index if you added or updated stash-backed architectural guidance:

   ```sh
   akm index
   ```

### gate

- `cleanup-summary.md` explains the cleanup and the parity evidence.
- Durable heuristics are recorded when useful.
