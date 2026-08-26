// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `TaskRunResult` — the shape every dispatch arm returns — plus the small
 * cluster of helpers that build one directly: `preparedResultTarget` (the D8
 * result-vocabulary projection of a freshly prepared execution),
 * `finishDisabledTask` (the disabled-task short-circuit), and
 * `exitCodeForStatus` (the OS-scheduler exit-code mapping). `RunTaskOptions`
 * — the public options bag `runTask()`, `load-task.ts`, and every dispatch
 * arm read from — lives here too, alongside the other public-surface types
 * the compat shim (src/tasks/runner.ts) re-exports.
 *
 * Moved from src/tasks/runner.ts (spec docs/plans/specs/p1b-model-extraction.md
 * §5.1, §9, runner.ts:87-103,105-143,256-292,1164-1177).
 *
 * D8 (§5.3, §6 F-2): `preparedResultTarget`'s prepared-command arm now
 * returns `{kind:"command", engine}` (formerly `{kind:"prompt", engine}`);
 * its native arm now returns the bare `{kind:"shell"}` / `{kind:"script"}`
 * (formerly one shared `{kind:"command"}`) — the arm-specific `cmd` is added
 * by run-native-task.ts once it has actually built the argv, mirroring the
 * pre-P1b shape where the bare disabled-task projection never carried `cmd`
 * either.
 *
 * F-3 (§5.4): `RunTaskOptions.stashDir` is renamed to `bundleDir` here —
 * VALUE-preserving, only the option key changed.
 *
 * Import direction: this module is a DAG leaf with respect to the rest of
 * src/tasks/run/** — it imports only ./task-log (persistRunLog, itself a
 * leaf) and, for `RunTaskOptions`'s override-seam types, the workflow
 * orchestrator's own exported symbol (safe: src/workflows/exec/run-workflow.ts
 * and everything it transitively imports never reaches back into
 * src/tasks/run/**). It deliberately does NOT import ./task-history
 * (appendHistory) or ./attempt-lifecycle (finishAttempt):
 * ./task-history.ts imports TaskRunResult's TYPE from here, and
 * tests/architecture/import-cycle-ratchet.test.ts counts type-only imports as
 * real cycle edges (shrink-only, empty baseline — see
 * scripts/lint-import-cycles.ts's header), so a value import back from here
 * would close a cycle. `finishDisabledTask` therefore only persists the LOG
 * (task-log.ts, safe) and returns its result; the caller (run-task.ts)
 * appends the history row right after, in the same relative order the
 * pre-split function ran in — an internal call-graph shape, not an
 * observable behavior change (finishDisabledTask is not on the compat-shim
 * re-export list). The same reasoning is why finishDisabledTask computes its
 * own finishedAt clamp inline rather than importing attempt-lifecycle.ts's
 * finishAttempt; the arm modules that do not risk a cycle
 * (run-native-task.ts, run-workflow-task.ts, run-command-task.ts) import the
 * real one from there.
 */

import type { SpawnFn } from "../../core/subprocess";
import type { LoweringNotice } from "../../execution/resolved-request";
import type { RunAgentOptions } from "../../integrations/agent";
import type { DispatchLoweredExecutionOptions } from "../../integrations/agent/execution-lowering";
import type { chatCompletion } from "../../llm/client";
import type { runWorkflowSteps } from "../../workflows/exec/run-workflow";
import type { ExecutionProvenanceContext } from "../model/invocation";
import type { PreparedTaskV3Execution, PreparedTaskV3Script, PreparedTaskV3Shell } from "../prepare/prepared-execution";
import { persistRunLog } from "./task-log";

export type TaskRunStatus = "completed" | "blocked" | "failed" | "disabled" | "active";

export type TaskAttemptFailureReason =
  | "invalid_task_id"
  | "task_load_failed"
  | "task_parse_failed"
  | "task_dispatch_failed";

export interface TaskRunResult {
  id: string;
  status: TaskRunStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  log: string;
  target:
    | { kind: "workflow"; ref: string }
    | { kind: "command"; engine: string | null }
    | { kind: "shell"; cmd?: string[] }
    | { kind: "script"; cmd?: string[] }
    | { kind: "unknown" };
  /** Workflow run id (for workflow targets) or agent reason/error (for command targets). */
  detail?: { runId?: string; reason?: string; error?: string; exitCode?: number | null };
  /** Secret-free optimistic-lowering diagnostics for command (agent/LLM) targets. */
  notices?: readonly Readonly<LoweringNotice>[];
}

export interface RunTaskOptions {
  /**
   * The bundle directory the task asset resolves against. Resolved once at
   * the `akm task run` command boundary (WI-9.10 CLI-wide sweep) and threaded
   * in — this runner no longer reads the ambient stash-dir resolver.
   *
   * F-3 (spec §5.4): renamed from `stashDir` — VALUE-preserving, the option
   * key is a replacement, not an addition (a `stashDir`-only options object
   * does not resolve the task).
   */
  bundleDir: string;
  /** Durable bundle identity for fully-qualified refs. */
  bundleName?: string;
  /** Configured adapter for the selected component root. */
  adapterId?: string;
  /** Override the common command dispatch's agent runner (tests). */
  runAgentImpl?: DispatchLoweredExecutionOptions["runAgent"];
  /**
   * Override the workflow orchestrator (tests). Defaults to
   * {@link runWorkflowSteps}.
   */
  runWorkflowStepsImpl?: typeof runWorkflowSteps;
  /** Override clock (tests). */
  now?: () => Date;
  /** Override log dir (tests). */
  logDir?: string;
  /** Extra args/env to pass through the common command dispatcher (tests). */
  agentOptions?: Partial<RunAgentOptions>;
  /** Override plain LLM prompt dispatch (tests). */
  chatCompletionImpl?: typeof chatCompletion;
  /** Override the command-target spawn (tests). Defaults to the runtime spawn. */
  spawnFn?: SpawnFn;
  /**
   * Override the timeout timers (tests). Default to the globals. Used by both
   * the command-target kill ladder and the workflow-target whole-run timeout.
   */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  /** True only for an invocation generated by a scheduler backend. */
  scheduled?: boolean;
  /**
   * D5 (spec §1.2/§5.2): execution provenance threaded from the invocation
   * boundary. Optional — absent, `runTask` defaults it to
   * `{ eventSource: "task", scheduled: options.scheduled === true }`
   * (run/provenance.ts's `createExecutionProvenanceContext`), which is what
   * keeps every existing caller — and this option's own absence — byte-
   * equivalent to pre-P1b behavior.
   */
  provenance?: ExecutionProvenanceContext;
  /** Runs after immutable preparation/history reservation and before native dispatch (tests). */
  beforeNativeDispatch?: (task: PreparedTaskV3Shell | PreparedTaskV3Script) => void;
}

/** D8 (spec §5.3): the result-vocabulary projection of a freshly prepared execution. */
function preparedResultTarget(task: PreparedTaskV3Execution): TaskRunResult["target"] {
  if (task.kind === "workflow") return { kind: "workflow", ref: task.ref };
  if (task.kind === "command") return { kind: "command", engine: task.invocation.request.engine.name ?? null };
  if (task.kind === "shell") return { kind: "shell" };
  return { kind: "script" };
}

/**
 * A disabled task's short-circuited result. Persists the log itself
 * (task-log.ts is a safe, cycle-free dependency); the caller appends the
 * history row right after — see the module header for why that one call
 * lives one level up.
 */
export function finishDisabledTask(
  task: PreparedTaskV3Execution,
  logPath: string,
  startedAt: Date,
  observedFinishedAt: Date,
): TaskRunResult {
  // Same clamp as attempt-lifecycle.ts's finishAttempt (never let a mocked
  // clock report a finish before its own start) — inlined rather than
  // imported; see the module header for why.
  const finishedAt = observedFinishedAt.getTime() < startedAt.getTime() ? new Date(startedAt) : observedFinishedAt;
  const line = `[akm task] task "${task.taskId}" is disabled — skipping run.`;
  const result: TaskRunResult = {
    id: task.taskId,
    status: "disabled",
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    log: logPath,
    target: preparedResultTarget(task),
  };
  persistRunLog({
    taskId: task.taskId,
    startedAtIso: result.startedAt,
    finishedAtIso: result.finishedAt,
    logPath,
    fileText: `${line}\n`,
    dbLines: [{ line }],
    redactNames: task.redact,
    environment: task.environment,
  });
  return result;
}

/**
 * The exit code surfaced to the OS scheduler. Mapped from {@link TaskRunStatus}
 * so cron / launchd / schtasks see a useful return value.
 */
export function exitCodeForStatus(status: TaskRunStatus): number {
  switch (status) {
    case "completed":
      return 0;
    case "active":
      return 0;
    case "blocked":
      return 1;
    case "failed":
      return 1;
    case "disabled":
      return 0;
  }
}
