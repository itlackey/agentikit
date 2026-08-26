// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The task_history read/write boundary: `appendHistory` (write) and
 * `readTaskHistory` / `taskHistoryRowToResult` (read).
 *
 * Moved from src/tasks/runner.ts (spec docs/plans/specs/p1b-model-extraction.md
 * §5.1, §9, runner.ts:1071-1158). `appendHistory` was module-private at head;
 * it is exported here because every dispatch arm (run-native-task.ts,
 * run-workflow-task.ts, run-command-task.ts), attempt-lifecycle.ts, and
 * run-task.ts's disabled-task path all call it (spec §5.1's module split
 * moves what was one file's internal call graph across several files).
 *
 * D8 (spec §5.3, §6 F-2) result-vocabulary re-code, implemented entirely at
 * this read/write boundary:
 *   - WRITE: every row `appendHistory` writes now carries `targetVocab: 2` in
 *     its metadata, and the new target_kind strings ("command" for a prepared
 *     command/agent-LLM result, "shell", "script", "workflow" unchanged).
 *   - READ: `taskHistoryRowToResult` branches on the decoded metadata's
 *     `targetVocab` marker. Rows carrying `targetVocab: 2` read `target_kind`
 *     directly in the new vocabulary. LEGACY rows (no marker, written before
 *     this phase) are mapped: `"prompt"` -> `{kind:"command", engine}`,
 *     `"command"` -> `{kind:"shell"}`, `"workflow"` unchanged, anything else
 *     (including the new vocabulary's own "shell"/"script"/"prompt" written
 *     WITHOUT a marker, which no production writer ever does) -> `"unknown"`.
 *     The P0-pinned null fallbacks survive: workflow `ref` falls back to `""`,
 *     the command/prompt arm's `engine` falls back to `null`.
 *
 * A DAG leaf with respect to the rest of src/tasks/run/**: this module
 * imports TaskRunResult/TaskRunStatus's TYPE from ./task-result but no VALUE
 * from it, and nothing at all from ./task-log or ./attempt-lifecycle — so
 * nothing here risks closing an import cycle with a module that itself
 * imports appendHistory or readTaskHistory from here.
 */

import { rethrowIfTestIsolationError } from "../../core/errors";
import { withStateDb } from "../../core/state-db";
import {
  decodeTaskHistoryMetadata,
  finalizeTaskHistoryAttempt,
  getTaskHistory,
  getTaskHistoryRuns,
  queryTaskHistory,
  type TaskHistoryRow,
  upsertTaskHistory,
} from "../../storage/repositories/task-history-repository";
import type { TaskRunResult, TaskRunStatus } from "./task-result";

/** Append (or finalize a reserved attempt into) one task_history row. */
export function appendHistory(result: TaskRunResult, historyReserved = false): void {
  const row = {
    task_id: result.id,
    status: result.status,
    started_at: result.startedAt,
    completed_at: result.finishedAt,
    failed_at: result.status === "failed" ? result.finishedAt : null,
    log_path: result.log || null,
    target_kind: result.target.kind === "unknown" ? null : result.target.kind,
    target_ref: result.target.kind === "workflow" ? result.target.ref : null,
    metadata_json: JSON.stringify({
      metadataVersion: 2,
      durationMs: result.durationMs,
      detail: result.detail ?? null,
      // D8 (spec §5.3): every NEW row carries the vocabulary marker.
      targetVocab: 2,
      ...(result.target.kind === "command" ? { engine: result.target.engine } : {}),
    }),
  };
  try {
    withStateDb((db) => {
      if (historyReserved && finalizeTaskHistoryAttempt(db, row)) return;
      upsertTaskHistory(db, row);
    });
  } catch (error) {
    rethrowIfTestIsolationError(error);
    // History recording is fully best-effort and must not alter CLI output.
  }
}

/**
 * Read recent history rows for one or all tasks.
 *
 * Returns rows in reverse-chronological order, optionally limited.
 */
export interface ReadHistoryOptions {
  id?: string;
  limit?: number;
}

export function readTaskHistory(options: ReadHistoryOptions = {}): TaskRunResult[] {
  return withStateDb((db) => {
    if (options.limit === 0) return [];
    if (options.id) {
      // An id-scoped query used the single-row helper, so `--limit` was silently
      // discarded and `akm task history --id X --limit 20` always returned one
      // run. The CLI documents --limit as "Maximum rows to return"; honour it.
      if (options.limit !== undefined && options.limit > 0) {
        return getTaskHistoryRuns(db, options.id, options.limit).map(taskHistoryRowToResult);
      }
      const row = getTaskHistory(db, options.id);
      return row ? [taskHistoryRowToResult(row)] : [];
    }
    return queryTaskHistory(db, options.limit !== undefined && options.limit > 0 ? { limit: options.limit } : {}).map(
      taskHistoryRowToResult,
    );
  });
}

/**
 * Convert a `TaskHistoryRow` from state.db back to a `TaskRunResult` shape
 * that callers of `readTaskHistory()` expect.
 *
 * D8 read boundary (spec §5.3): branches on the decoded metadata's
 * `targetVocab` marker — see the module header's table.
 */
function taskHistoryRowToResult(row: TaskHistoryRow): TaskRunResult {
  const meta = decodeTaskHistoryMetadata(row.metadata_json);
  const marked = meta.targetVocab === 2;

  const target: TaskRunResult["target"] = (() => {
    switch (row.target_kind) {
      case "workflow":
        // PRESERVED for both vintages (incl. the null-ref fallback).
        return { kind: "workflow", ref: row.target_ref ?? "" };
      case "command":
        // NEW vocabulary: a prepared command (agent/LLM) result.
        // LEGACY vocabulary: the native shell/script arm's shared string.
        return marked ? { kind: "command", engine: meta.engine ?? null } : { kind: "shell" };
      case "shell":
        // Only the NEW vocabulary ever writes this string; an unmarked
        // "shell" row is unreachable from any production writer.
        return marked ? { kind: "shell" } : { kind: "unknown" };
      case "script":
        // Only the NEW vocabulary ever writes this string; an unmarked
        // "script" row is unreachable from any production writer.
        return marked ? { kind: "script" } : { kind: "unknown" };
      case "prompt":
        // Only LEGACY rows (pre-P1b) ever wrote this string.
        return marked ? { kind: "unknown" } : { kind: "command", engine: meta.engine ?? null };
      default:
        return { kind: "unknown" };
    }
  })();

  return {
    id: row.task_id,
    status: row.status as TaskRunStatus,
    startedAt: row.started_at,
    finishedAt: row.completed_at ?? row.failed_at ?? row.started_at,
    durationMs: meta.durationMs,
    log: row.log_path ?? "",
    target,
    ...(meta.detail ? { detail: meta.detail } : {}),
  };
}
