// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Compat shim (spec docs/plans/specs/p1b-model-extraction.md §5.1/§9).
 *
 * The 1177-line task runner this file used to hold is now split across
 * src/tasks/run/**, one module per responsibility (run-task.ts's
 * orchestration; load-task.ts's prepare-before-reserve boundary;
 * attempt-lifecycle.ts's reservation/finalization; run-native-task.ts,
 * run-workflow-task.ts, run-command-task.ts's dispatch arms; task-result.ts's
 * TaskRunResult shape and RunTaskOptions; task-log.ts's log persistence;
 * task-history.ts's task_history read/write boundary; provenance.ts's D5
 * ExecutionProvenanceContext factory). This file carries no logic of its
 * own — only re-exports — so pre-P1b importers keep compiling.
 *
 * P4: delete this shim.
 */

export { INVALID_TASK_ATTEMPT_ID, recordTaskAttemptFailure } from "./run/attempt-lifecycle";
export { runTask } from "./run/run-task";
export { DEFAULT_WORKFLOW_TASK_TIMEOUT_MS } from "./run/run-workflow-task";
export type { ReadHistoryOptions } from "./run/task-history";
export { readTaskHistory } from "./run/task-history";
export { scrubDbLines } from "./run/task-log";
export type { RunTaskOptions, TaskAttemptFailureReason, TaskRunResult, TaskRunStatus } from "./run/task-result";
export { exitCodeForStatus } from "./run/task-result";
