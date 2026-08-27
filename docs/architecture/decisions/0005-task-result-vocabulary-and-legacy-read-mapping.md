# 0005 — The D8 result-vocabulary re-code and its legacy read mapping

## Context

Before P1b's D8 vocabulary re-code, a task's result `target.kind` used
`"prompt"` for a prepared command/agent-LLM result and one shared
`"command"` for every native (shell/script) result, which conflated two
materially different execution shapes under one label and mislabeled an
LLM-routed dispatch as a literal "prompt". D8 renamed the written
vocabulary; the harder problem was that `task_history` is a durable,
already-populated table — existing rows on disk still carry the OLD labels,
and `readTaskHistory` has to keep returning a coherent shape for both
generations of rows forever.

## Decision

Moved verbatim from `src/tasks/run/task-result.ts`'s module header:

> `TaskRunResult` — the shape every dispatch arm returns — plus the small
> cluster of helpers that build one directly: `preparedResultTarget` (the D8
> result-vocabulary projection of a freshly prepared execution),
> `finishDisabledTask` (the disabled-task short-circuit), and
> `exitCodeForStatus` (the OS-scheduler exit-code mapping). `RunTaskOptions`
> — the public options bag `runTask()`, `load-task.ts`, and every dispatch
> arm read from — lives here too, alongside the other public-surface types
> the compat shim (`src/tasks/runner.ts`) re-exports.
>
> D8 (§5.3, §6 F-2): `preparedResultTarget`'s prepared-command arm now
> returns `{kind:"command", engine}` (formerly `{kind:"prompt", engine}`);
> its native arm now returns the bare `{kind:"shell"}` / `{kind:"script"}`
> (formerly one shared `{kind:"command"}`) — the arm-specific `cmd` is
> added by `run-native-task.ts` once it has actually built the argv,
> mirroring the pre-P1b shape where the bare disabled-task projection never
> carried `cmd` either.

And from `src/tasks/run/task-history.ts`'s module header (the WRITE half —
the READ half's mapping rule is kept in the code itself, not moved; see
below):

> The `task_history` read/write boundary: `appendHistory` (write) and
> `readTaskHistory` / `taskHistoryRowToResult` (read).
>
> D8 (spec §5.3, §6 F-2) result-vocabulary re-code, implemented entirely at
> this read/write boundary. WRITE: every row `appendHistory` writes now
> carries `targetVocab: 2` in its metadata, and the new target_kind strings
> ("command" for a prepared command/agent-LLM result, "shell", "script",
> "workflow" unchanged).

## Consequences

- Every NEW row written after D8 is unambiguous — `targetVocab: 2` plus the
  new `target_kind` strings mean a reader never has to guess which
  generation a row belongs to.
- Every OLD row (written before D8, no `targetVocab` marker at all) must
  keep reading correctly forever — this is not a migration that runs once
  and finishes; there is no "convert task_history in place" step, because
  the table is an append-only historical log, not authoring state. The
  read-side mapping rule is therefore a PERMANENT part of the codebase
  (`docs/plans/specs/p4-deletions-closeout.md` row B-51: "it reads old rows
  forever. Deleting it is a review-blocking violation.").
- The exact legacy mapping — kept in `src/tasks/run/task-history.ts` itself
  as a short invariant comment, not summarized here, because a maintainer
  reading `taskHistoryRowToResult` needs it right there — is: a legacy row
  (no `targetVocab` marker) maps `"prompt"` → `{kind:"command", engine}`,
  `"command"` → `{kind:"shell"}`, `"workflow"` unchanged, and anything else
  (including the new vocabulary's own strings written WITHOUT a marker,
  which no production writer ever does) → `"unknown"`. The P0-pinned null
  fallbacks survive: a workflow row's `ref` falls back to `""`, the
  command/prompt arm's `engine` falls back to `null`.
- `SAFE_TASK_ATTEMPT_ERROR_CODES` (`src/tasks/run/attempt-lifecycle.ts`) is a
  related but separate allowlist — it decides which error CODES are safe to
  surface verbatim in a `detail.error` column, not which result-kind
  strings are legal. Do not conflate the two when reading either file.

## Provenance

- Source: `src/tasks/run/task-result.ts` module header;
  `src/tasks/run/task-history.ts` module header (WRITE half only — the READ
  half's mapping rule stays in the code as a permanent invariant).
- Spec: `docs/plans/specs/p1b-model-extraction.md` §5.3, §6 F-2.
- Extracted: P4 (`docs/plans/specs/p4-deletions-closeout.md` §4.2), 2026-08-27.
