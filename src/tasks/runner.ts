// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm task run <id>` — what cron / launchd / schtasks invoke at the
 * scheduled moment.
 *
 * Responsibilities:
 *
 *   1. Resolve the task file via `resolveAssetPath(stashDir, "task", id)`.
 *   2. Parse the task document. (Validation runs at `tasks add` /
 *      `tasks sync` time, not here — at run time we still want to attempt
 *      execution and surface the actual failure rather than re-fail on a
 *      validation error that the user already knows about.)
 *   3. Skip disabled tasks only when the invocation is scheduler-generated;
 *      explicit manual runs are allowed for catch-up and testing.
 *   4. Dispatch by target kind:
 *        • workflow → `runWorkflowSteps({ target: ref, params, signal, … })`
 *                     under a whole-run timeout (issue 11): an unattended run
 *                     gets the same abort path `akm workflow run --timeout`
 *                     gives an interactive one.
 *        • prompt   → common cascade → resolved lowerer → captured runner
 *   5. Capture stdout / stderr as structured rows in logs.db (task_logs) and,
 *      transitionally, as a flat text tail at `<cacheDir>/tasks/logs/<id>/<ts>.log`
 *      (per the #579 logs audit).
 *   6. Write a history row to state.db task_history table.
 *
 * Returns a structured result so the CLI handler can shape it for `output()`
 * and so tests can assert against it without scraping stdout.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { armAbortDeadline } from "../core/abort-deadline";
import { shouldSkipUnactivatedTask } from "../core/activation-policy";
import { assertNever } from "../core/assert";
import { placementSpecFor } from "../core/asset/asset-placement";
import { parseRefInput } from "../core/asset/resolve-ref";
import { loadConfig } from "../core/config/config";
import { AkmError, NotFoundError, rethrowIfTestIsolationError } from "../core/errors";
import {
  buildTaskRunId,
  insertTaskLogLines,
  openLogsDatabase,
  type TaskLogLevel,
  type TaskLogLineInput,
  type TaskLogStream,
} from "../core/logs-db";
import { getTaskLogDir } from "../core/paths";
import { redactCredentialPatterns, redactSensitiveText } from "../core/redaction";
import { withStateDb } from "../core/state-db";
import { runManagedSubprocess, type SpawnFn } from "../core/subprocess";
import { cloneExecutionJsonObject } from "../execution/json";
import type { LoweringNotice } from "../execution/resolved-request";
import type { UnresolvedExecutionDefaults } from "../execution/source";
import type { AgentRunResult, RunAgentOptions } from "../integrations/agent";
import {
  fallbackAnnouncement,
  NO_ENGINE_MESSAGE_SUFFIX,
  NO_ENGINE_REMEDY,
} from "../integrations/agent/engine-fallback";
import {
  type DispatchLoweredExecutionOptions,
  dispatchLoweredExecutionRequest,
  lowerResolvedExecutionRequest,
} from "../integrations/agent/execution-lowering";
import { prepareInlineExecution } from "../integrations/agent/inline-execution";
import type { chatCompletion } from "../llm/client";
import { resolveAssetPath } from "../sources/resolve";
import type { WorkflowRunStatus, WorkflowRunSummary } from "../sources/types";
import {
  decodeTaskHistoryMetadata,
  finalizeTaskHistoryAttempt,
  getTaskHistory,
  getTaskHistoryRuns,
  queryTaskHistory,
  reserveTaskHistoryAttempt,
  upsertTaskHistory,
} from "../storage/repositories/task-history-repository";
import { runWorkflowSteps } from "../workflows/exec/run-workflow";
import { findBareAkmExecutableIndex } from "./command-executable";
import { collectTaskLogSensitiveValues } from "./log-redaction";
import { parseTaskDocument } from "./parser";
import { resolveAkmInvocation } from "./resolve-akm-bin";
import { scheduledTaskContextEnv } from "./scheduler-invocation";
import type { TaskDocument } from "./schema";
import { validateTaskId } from "./task-id";

export type TaskRunStatus = "completed" | "blocked" | "failed" | "disabled" | "active";

export const INVALID_TASK_ATTEMPT_ID = "_invalid-task-id";

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
    | { kind: "prompt"; engine: string | null; legacyProfile?: string }
    | { kind: "command"; cmd?: string[] }
    | { kind: "unknown" };
  /** Workflow run id (for workflow targets) or agent reason/error (for prompt targets). */
  detail?: { runId?: string; reason?: string; error?: string; exitCode?: number | null };
  /** Secret-free optimistic-lowering diagnostics for prompt targets. */
  notices?: readonly Readonly<LoweringNotice>[];
}

export interface RunTaskOptions {
  /**
   * The stash directory the task asset resolves against. Resolved once at the
   * `akm task run` command boundary (WI-9.10 CLI-wide sweep) and threaded in —
   * this runner no longer reads the ambient stash-dir resolver.
   */
  stashDir: string;
  /** Override the agent runner (tests). Defaults to {@link runAgent}. */
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
  /** Extra args/env to pass through to runAgent (tests). */
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
}

export async function runTask(id: string, options: RunTaskOptions): Promise<TaskRunResult> {
  const runAgentImpl = options.runAgentImpl;
  const runWorkflowStepsImpl = options.runWorkflowStepsImpl ?? runWorkflowSteps;
  const now = options.now ?? (() => new Date());
  const requestedStartedAt = now();

  try {
    validateTaskId(id);
  } catch (failure) {
    const attempt = reserveTaskAttempt(INVALID_TASK_ATTEMPT_ID, requestedStartedAt);
    recordTaskAttemptFailure({
      taskId: INVALID_TASK_ATTEMPT_ID,
      reason: "invalid_task_id",
      failure,
      startedAt: attempt.startedAt,
      finishedAt: now(),
      logDir: options.logDir,
      historyReserved: attempt.historyReserved,
    });
    throw failure;
  }

  const attempt = reserveTaskAttempt(id, requestedStartedAt);
  const startedAt = attempt.startedAt;
  let failureReason: TaskAttemptFailureReason = "task_load_failed";

  try {
    const stashDir = options.stashDir;
    const filePath = await resolveAssetPath(stashDir, "task", id);
    const yaml = fs.readFileSync(filePath, "utf8");

    failureReason = "task_parse_failed";
    const task = parseTaskDocument({ yaml, filePath, id });

    failureReason = "task_dispatch_failed";
    const startedIso = startedAt.toISOString();
    const logPath = resolveTaskLogPath(options.logDir, id, startedIso);

    if (shouldSkipUnactivatedTask({ enabled: task.enabled, scheduled: options.scheduled === true })) {
      const finishedAt = finishAttempt(startedAt, now());
      const disabledTarget: TaskRunResult["target"] =
        task.target.kind === "workflow"
          ? { kind: "workflow", ref: task.target.ref }
          : task.target.kind === "command"
            ? { kind: "command", cmd: task.target.cmd }
            : { kind: "prompt", engine: task.target.engine ?? null };
      const result: TaskRunResult = {
        id,
        status: "disabled",
        startedAt: startedIso,
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        log: logPath,
        target: disabledTarget,
      };
      const disabledLine = `[akm task] task "${id}" is disabled — skipping run.`;
      persistRunLog({
        taskId: id,
        startedAtIso: startedIso,
        finishedAtIso: result.finishedAt,
        logPath,
        fileText: `${disabledLine}\n`,
        dbLines: [{ line: disabledLine }],
        redactNames: task.redact,
      });
      appendHistory(result, attempt.historyReserved);
      return result;
    }

    if (task.target.kind === "workflow") {
      return await runWorkflowTask({
        task,
        logPath,
        startedAt,
        now,
        runWorkflowStepsImpl,
        historyReserved: attempt.historyReserved,
        ...(options.setTimeoutFn ? { setTimeoutFn: options.setTimeoutFn } : {}),
        ...(options.clearTimeoutFn ? { clearTimeoutFn: options.clearTimeoutFn } : {}),
      });
    }

    if (task.target.kind === "command") {
      return await runCommandTask({
        task,
        logPath,
        startedAt,
        now,
        historyReserved: attempt.historyReserved,
        ...(options.spawnFn ? { spawnFn: options.spawnFn } : {}),
        ...(options.setTimeoutFn ? { setTimeoutFn: options.setTimeoutFn } : {}),
        ...(options.clearTimeoutFn ? { clearTimeoutFn: options.clearTimeoutFn } : {}),
      });
    }

    return await runPromptTask({
      task,
      stashDir,
      logPath,
      startedAt,
      now,
      runAgentImpl,
      agentOptions: options.agentOptions,
      ...(options.chatCompletionImpl ? { chatCompletionImpl: options.chatCompletionImpl } : {}),
      historyReserved: attempt.historyReserved,
    });
  } catch (failure) {
    recordTaskAttemptFailure({
      taskId: id,
      reason: failureReason,
      failure,
      startedAt,
      finishedAt: now(),
      logDir: options.logDir,
      historyReserved: attempt.historyReserved,
    });
    throw failure;
  }
}

// ── command target ──────────────────────────────────────────────────────────

async function runCommandTask(input: {
  task: TaskDocument;
  logPath: string;
  startedAt: Date;
  now: () => Date;
  historyReserved: boolean;
  spawnFn?: SpawnFn;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}): Promise<TaskRunResult> {
  const { task, logPath, startedAt, now, historyReserved } = input;
  if (task.target.kind !== "command") throw new Error("invariant: command target");
  const { cmd } = task.target;
  const spawnCmd = resolveNestedAkmCommand(cmd);

  // Unset → the unattended default; `null` → the explicit no-timeout opt-out.
  const timeoutMs: number | null = task.timeoutMs !== undefined ? task.timeoutMs : DEFAULT_SCHEDULED_TASK_TIMEOUT_MS;

  const header = `[akm task] task=${task.id} kind=command cmd=${cmd.join(" ")}`;
  const logLines: string[] = [header];
  const dbLines: TaskLogLineInput[] = [{ line: header }];

  let exitCode: number | null = null;

  try {
    // Managed spawn (src/core/subprocess.ts): process-GROUP kill so a timeout
    // reaps the whole command tree (no orphans), and a SIGTERM→SIGKILL ladder
    // so a child that ignores SIGTERM can't wedge the run forever.
    const result = await runManagedSubprocess(spawnCmd, {
      capture: true,
      cwd: process.env.HOME ?? os.tmpdir(),
      // Stamp task-runner provenance so any akm invocation in the command tree
      // records usage events as machine traffic, not user demand (DRIFT-6).
      // A more specific stamp already in the environment (e.g. improve's
      // AKM_EVENT_SOURCE=improve on its child spawns) still wins in children.
      env: { ...process.env, AKM_EVENT_SOURCE: process.env.AKM_EVENT_SOURCE ?? "task" },
      timeoutMs,
      ...(input.spawnFn ? { spawnFn: input.spawnFn } : {}),
      ...(input.setTimeoutFn ? { setTimeoutFn: input.setTimeoutFn } : {}),
      ...(input.clearTimeoutFn ? { clearTimeoutFn: input.clearTimeoutFn } : {}),
    });
    // A synchronous spawn throw / exit rejection surfaces as spawn_error below.
    if (result.spawnError) throw result.spawnError;

    const { stdout, stderr, timedOut } = result;
    exitCode = result.exitCode ?? (timedOut ? 143 : 1);

    if (timedOut) {
      logLines.push(`timed_out=true timeout_ms=${timeoutMs}`);
      dbLines.push({ level: "error", line: `timed_out=true timeout_ms=${timeoutMs}` });
    }
    logLines.push(`exit_code=${exitCode}`);
    dbLines.push({ level: exitCode === 0 ? "info" : "error", line: `exit_code=${exitCode}` });
    if (stdout) {
      logLines.push("--- stdout ---");
      logLines.push(stdout);
      dbLines.push(...streamLines(stdout, "stdout", "info"));
    }
    if (stderr) {
      logLines.push("--- stderr ---");
      logLines.push(stderr);
      dbLines.push(...streamLines(stderr, "stderr", "error"));
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logLines.push(`spawn_error=${msg}`);
    dbLines.push({ level: "error", line: `spawn_error=${msg}` });
    exitCode = 1;
  }

  const finishedAt = finishAttempt(startedAt, now());
  persistRunLog({
    taskId: task.id,
    startedAtIso: startedAt.toISOString(),
    finishedAtIso: finishedAt.toISOString(),
    logPath,
    fileText: `${logLines.join("\n")}\n`,
    dbLines,
    redactNames: task.redact,
  });
  const status: TaskRunStatus = exitCode === 0 ? "completed" : "failed";
  const result: TaskRunResult = {
    id: task.id,
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    log: logPath,
    target: { kind: "command", cmd },
    detail: { exitCode },
  };
  appendHistory(result, historyReserved);
  return result;
}

/** Avoid a second PATH lookup when a task invokes the same AKM installation. */
function resolveNestedAkmCommand(cmd: string[]): string[] {
  const akmIndex = findBareAkmExecutableIndex(cmd);
  if (akmIndex === undefined) return cmd;
  return [...cmd.slice(0, akmIndex), ...resolveAkmInvocation().argv, ...cmd.slice(akmIndex + 1)];
}

// ── workflow target ─────────────────────────────────────────────────────────

/**
 * Whole-run timeout applied to a workflow-bound task that does not declare its
 * own `timeoutMs` — six hours.
 *
 * `akm workflow run` deliberately has NO default `--timeout`: a human is
 * watching, and Ctrl-C aborts the very same signal the flag's timer would.
 * A scheduled task has nobody watching. Without a default, its only bound is
 * the per-unit timeout — and a frozen plan may set `timeout: null` (unbounded),
 * so one wedged agent unit hangs the run until the machine reboots, holding the
 * run lease and silently skipping every later firing (issue 11).
 *
 * Six hours is deliberately generous rather than tight: the abort is graceful
 * (the engine breaks at the next step boundary and the run stays resumable), so
 * the cost of over-waiting is bounded while the cost of cutting a legitimate
 * long run short is a lost step. It matches the 6h idle window `akm health`
 * already uses to call a run stale (`commands/health/report-view-model.ts`),
 * and it lands well inside a `@daily` cadence, so a wedged run can never still
 * be holding the lease when the next day's firing arrives.
 *
 * An explicit `timeoutMs:` in the task file always wins; `timeoutMs: null` is
 * the explicit opt-out back to unbounded.
 */
export const DEFAULT_WORKFLOW_TASK_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/**
 * The same unattended default for command and prompt tasks.
 *
 * The reasoning above is about SCHEDULED runs, not about workflows: nobody is
 * watching, and one wedged run silently stops the schedule. Command tasks
 * defaulted to `null` (no kill timer) and prompt tasks inherited
 * DEFAULT_AGENT_TIMEOUT_MS, also null — so a hung `curl`, a prompting agent
 * waiting on stdin, or a stuck engine wedged the task forever while the
 * workflow arm was protected. Same value, same opt-out: an explicit
 * `timeoutMs:` wins, and `timeoutMs: null` restores unbounded.
 */
export const DEFAULT_SCHEDULED_TASK_TIMEOUT_MS = DEFAULT_WORKFLOW_TASK_TIMEOUT_MS;

async function runWorkflowTask(input: {
  task: TaskDocument;
  logPath: string;
  startedAt: Date;
  now: () => Date;
  runWorkflowStepsImpl: typeof runWorkflowSteps;
  historyReserved: boolean;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}): Promise<TaskRunResult> {
  const { task, logPath, startedAt, now, runWorkflowStepsImpl, historyReserved } = input;
  if (task.target.kind !== "workflow") throw new Error("invariant: workflow target");
  const workflowTarget = task.target;
  const ref = parseRefInput(workflowTarget.ref);
  if (ref.type !== "workflow") {
    throw new NotFoundError(
      `Task "${task.id}" workflow target must be a workflow ref (got "${workflowTarget.ref}").`,
      "WORKFLOW_NOT_FOUND",
    );
  }

  // Unset → the unattended default; `null` → the explicit no-timeout opt-out.
  const timeoutMs =
    workflowTarget.timeoutMs === undefined ? DEFAULT_WORKFLOW_TASK_TIMEOUT_MS : workflowTarget.timeoutMs;
  // The shared deadline `akm workflow run --timeout` also arms
  // ({@link armAbortDeadline}): one AbortController for the run's lifetime,
  // aborted by a timer. The engine reads `options.signal` at every step
  // boundary and breaks GRACEFULLY — in-flight units are cancelled, the journal
  // and the run lease are retained, and the run is left `active`, i.e.
  // resumable with `akm workflow resume`.
  const controller = new AbortController();
  const deadline = armAbortDeadline(controller, {
    timeoutMs,
    reason: `Workflow task "${task.id}" timed out after ${timeoutMs}ms.`,
    ...(input.setTimeoutFn ? { setTimeoutFn: input.setTimeoutFn } : {}),
    ...(input.clearTimeoutFn ? { clearTimeoutFn: input.clearTimeoutFn } : {}),
  });

  let detail: WorkflowRunSummary | undefined;
  let gateError: string | undefined;
  let error: Error | undefined;
  // The prompt path logs the engine-fallback announcement; a workflow-backed
  // task must leave the same trace rather than silently using a chosen engine.
  let runWarnings: string[] = [];
  // Stamp task-runner provenance for the duration of the run (DRIFT-6), as the
  // command and prompt arms do. This arm executes IN-PROCESS, so the stamp goes
  // on process.env — child akm invocations made by workflow steps inherit it.
  // Without it, workflow-task traffic was recorded as user demand. A more
  // specific stamp already present wins, matching the command arm.
  const priorEventSource = process.env.AKM_EVENT_SOURCE;
  process.env.AKM_EVENT_SOURCE = priorEventSource ?? "task";
  try {
    const execution = await runWorkflowStepsImpl({
      target: workflowTarget.ref,
      params: workflowTarget.params,
      signal: controller.signal,
      ...(workflowTarget.maxSteps !== undefined ? { maxSteps: workflowTarget.maxSteps } : {}),
      ...(workflowTarget.maxRetries !== undefined ? { maxRetries: workflowTarget.maxRetries } : {}),
    });
    detail = execution.run;
    runWarnings = execution.warnings ?? [];
    if (execution.gateRejection) {
      gateError = `Verification rejected step "${execution.gateRejection.stepId}": ${execution.gateRejection.feedback}`;
    }
  } catch (e) {
    if (e instanceof AkmError && e.kind === "config") throw e;
    error = e instanceof Error ? e : new Error(String(e));
  } finally {
    deadline.disarm();
    if (priorEventSource === undefined) delete process.env.AKM_EVENT_SOURCE;
    else process.env.AKM_EVENT_SOURCE = priorEventSource;
  }

  // A timeout is a failed ATTEMPT even though the engine stopped cleanly: the
  // aborted run comes back `active` (resumable), which on its own would map to
  // task status "active" and a 0 exit code, telling the OS scheduler nothing
  // went wrong. Surface it like the command target's `timed_out=true` instead.
  //
  // Unless the run COMPLETED anyway. The abort is observed between steps, so a
  // deadline landing in the run's final bookkeeping can set the flag on a run
  // that then finishes — and reporting that as a failure would tell an operator
  // to resume a run with nothing left to resume.
  const ranToCompletion = detail?.status === "completed";
  const timedOutAfterMs = deadline.timedOut() && timeoutMs !== null && !ranToCompletion ? timeoutMs : undefined;
  const timeoutError =
    timedOutAfterMs === undefined
      ? undefined
      : new Error(
          `Workflow run timed out after ${timedOutAfterMs}ms and was aborted at a step boundary` +
            (detail?.id ? ` — resume it with \`akm workflow resume ${detail.id}\`.` : "."),
        );

  // One failure value for the three sinks below (status, log line, history
  // detail): a thrown error outranks a gate rejection, which outranks the
  // deadline. Re-laddering per sink is how a log line ends up naming a
  // different cause than the history row it was written beside.
  const failure = error ?? (gateError ? new Error(gateError) : timeoutError);

  const finishedAt = finishAttempt(startedAt, now());
  const status: TaskRunStatus = failure ? "failed" : mapWorkflowStatus(detail?.status);
  const log = renderWorkflowLog({
    task,
    detail,
    error: failure,
    warnings: runWarnings,
    ...(timedOutAfterMs !== undefined ? { timedOutAfterMs } : {}),
  });
  persistRunLog({
    taskId: task.id,
    startedAtIso: startedAt.toISOString(),
    finishedAtIso: finishedAt.toISOString(),
    logPath,
    fileText: log.fileText,
    dbLines: log.dbLines,
    redactNames: task.redact,
  });

  const result: TaskRunResult = {
    id: task.id,
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    log: logPath,
    target: { kind: "workflow", ref: task.target.ref },
    detail: {
      runId: detail?.id,
      ...(failure ? { error: failure.message } : {}),
    },
  };
  appendHistory(result, historyReserved);
  // Don't re-throw on workflow failure: the OS scheduler reads exit codes,
  // not exceptions, and the CLI maps `status: "failed"` to a non-zero exit
  // via exitCodeForStatus(). Throwing here would route through the generic
  // runWithJsonErrors path and lose the structured result/history we just
  // recorded.
  return result;
}

/**
 * Map the workflow runtime's status into the task-runner status space.
 * A workflow normally reaches completed or failed in one orchestration call.
 * Active remains representable for explicit engine stops such as a gate.
 *
 * The parameter is typed as the runtime's `WorkflowRunStatus` union (plus the
 * `undefined` that `detail?.run.status` can produce when no detail is present).
 * Every union member is handled explicitly and the `default` arm calls
 * `assertNever`, so adding a new `WorkflowRunStatus` variant without mapping it
 * here is a *compile* error rather than silently collapsing to "completed".
 * The previous silent `default: "completed"` is preserved only for the
 * `undefined` (no-detail) case, which is handled up front.
 */
function mapWorkflowStatus(status: WorkflowRunStatus | undefined): TaskRunStatus {
  // No run detail → treat as completed (unchanged from the prior silent default).
  if (status === undefined) return "completed";
  switch (status) {
    case "completed":
    case "blocked":
    case "failed":
    case "active":
      return status;
    default:
      return assertNever(status, "mapWorkflowStatus");
  }
}

function renderWorkflowLog(input: {
  task: TaskDocument;
  detail?: WorkflowRunSummary;
  error?: Error;
  warnings?: readonly string[];
  /** Set when the whole-run timeout fired; mirrors the command target's line. */
  timedOutAfterMs?: number;
}): RunLogContent {
  const dbLines: TaskLogLineInput[] = [
    { line: `[akm task] task=${input.task.id} kind=workflow ref=${(input.task.target as { ref: string }).ref}` },
  ];
  for (const warning of input.warnings ?? []) dbLines.push({ level: "warn", line: warning });
  if (input.timedOutAfterMs !== undefined) {
    dbLines.push({ level: "error", line: `timed_out=true timeout_ms=${input.timedOutAfterMs}` });
  }
  if (input.detail) {
    dbLines.push({ line: `run_id=${input.detail.id} status=${input.detail.status}` });
    dbLines.push({ line: `workflow_title=${input.detail.workflowTitle}` });
  }
  if (input.error) {
    dbLines.push({ level: "error", line: `error=${input.error.message}` });
  }
  return { fileText: `${dbLines.map((entry) => entry.line).join("\n")}\n`, dbLines };
}

// ── prompt target ───────────────────────────────────────────────────────────

async function runPromptTask(input: {
  task: TaskDocument;
  stashDir: string;
  logPath: string;
  startedAt: Date;
  now: () => Date;
  runAgentImpl?: DispatchLoweredExecutionOptions["runAgent"];
  chatCompletionImpl?: typeof chatCompletion;
  agentOptions?: Partial<RunAgentOptions>;
  historyReserved: boolean;
}): Promise<TaskRunResult> {
  const { task, stashDir, logPath, startedAt, now, agentOptions } = input;
  if (task.target.kind !== "prompt") throw new Error("invariant: prompt target");
  const promptTarget = task.target;

  // Same implicit opencode-sdk fallback the workflow freeze boundary applies,
  // so a scheduled prompt task on an engine-less install behaves identically.
  const promptText = await resolvePromptText(task, stashDir);
  const inputConfig = loadConfig();
  const environment = { AKM_EVENT_SOURCE: "task", ...scheduledTaskContextEnv(), ...agentOptions?.env };
  const selectedAgentTimeout = agentOptions?.timeoutMs;
  const current = {
    ...(promptTarget.engine !== undefined ? { engine: promptTarget.engine } : {}),
    ...(promptTarget.model !== undefined ? { model: promptTarget.model } : {}),
    ...(promptTarget.llm !== undefined
      ? { inference: cloneExecutionJsonObject(promptTarget.llm, "task target llm") }
      : {}),
    ...(promptTarget.timeoutMs !== undefined ? { timeout: promptTarget.timeoutMs } : {}),
    workspace: agentOptions?.cwd ?? stashDir,
    environment,
    ...(Object.hasOwn(agentOptions ?? {}, "timeoutMs") && selectedAgentTimeout !== undefined
      ? { timeout: selectedAgentTimeout }
      : {}),
  } satisfies UnresolvedExecutionDefaults;
  let prepared = prepareInlineExecution({
    content: promptText,
    config: inputConfig,
    invocationKind: "task",
    current,
  });
  // Unattended agent transports keep the scheduler's bounded default; direct
  // LLM engines retain their own configured/default timeout.
  if (prepared.request.engine.kind !== "llm" && !Object.hasOwn(current, "timeout")) {
    const boundedCurrent = {
      ...current,
      timeout: DEFAULT_SCHEDULED_TASK_TIMEOUT_MS,
    } satisfies UnresolvedExecutionDefaults;
    prepared = prepareInlineExecution({
      content: promptText,
      config: inputConfig,
      invocationKind: "task",
      current: boundedCurrent,
    });
  }
  const engineName = prepared.request.engine.name;
  const engineAnnouncement = fallbackAnnouncement(prepared.fallbackEngineName, engineName);
  if (!engineName)
    throw new NotFoundError(`Task "${task.id}" ${NO_ENGINE_MESSAGE_SUFFIX} ${NO_ENGINE_REMEDY}`, "ASSET_NOT_FOUND");
  const lowered = lowerResolvedExecutionRequest(prepared.request, prepared.config);
  const result = await dispatchLoweredExecutionRequest(lowered, {
    ...(input.runAgentImpl ? { runAgent: input.runAgentImpl } : {}),
    ...(input.chatCompletionImpl ? { chat: input.chatCompletionImpl } : {}),
    ...(agentOptions ? { runOptions: agentOptions } : {}),
  });

  const finishedAt = finishAttempt(startedAt, now());
  const log = renderPromptLog({ task, engineName, result, engineAnnouncement, notices: lowered.notices });
  persistRunLog({
    taskId: task.id,
    startedAtIso: startedAt.toISOString(),
    finishedAtIso: finishedAt.toISOString(),
    logPath,
    fileText: log.fileText,
    dbLines: log.dbLines,
    redactNames: task.redact,
  });

  const status: TaskRunStatus = result.ok ? "completed" : "failed";
  const out: TaskRunResult = {
    id: task.id,
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    log: logPath,
    target: { kind: "prompt", engine: engineName },
    detail: result.ok
      ? { exitCode: result.exitCode }
      : { reason: result.reason, error: result.error, exitCode: result.exitCode },
    ...(lowered.notices.length > 0 ? { notices: lowered.notices } : {}),
  };
  appendHistory(out, input.historyReserved);
  return out;
}

async function resolvePromptText(task: TaskDocument, stashDir: string): Promise<string> {
  if (task.target.kind !== "prompt") throw new Error("invariant: prompt target");
  const src = task.target.source;
  if (src.kind === "inline") return src.text;
  if (src.kind === "file") {
    const taskDir = path.dirname(task.source.path);
    const filePath = path.isAbsolute(src.path) ? src.path : path.resolve(taskDir, src.path);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new NotFoundError(`Prompt file not found: ${filePath}`, "FILE_NOT_FOUND");
    }
    return fs.readFileSync(filePath, "utf8");
  }
  // asset
  const ref = parseRefInput(src.ref);
  // D11 — see the matching guard in validator.ts: `resolveAssetPath`
  // (src/sources/resolve.ts) is placement-dir-only and cannot route an
  // opaque adapter conceptId, which `parseRefInput` now otherwise accepts.
  if (placementSpecFor(ref.type) === undefined) {
    throw new NotFoundError(
      `Task "${task.id}" prompt asset ref "${src.ref}" is not an AKM-placed asset — adapter-owned (opaque) prompt sources are not resolvable as task inputs yet.`,
      "ASSET_NOT_FOUND",
    );
  }
  const assetPath = await resolveAssetPath(stashDir, ref.type, ref.name);
  return fs.readFileSync(assetPath, "utf8");
}

function renderPromptLog(input: {
  task: TaskDocument;
  engineName: string;
  result: AgentRunResult;
  engineAnnouncement?: string;
  notices?: readonly Readonly<LoweringNotice>[];
}): RunLogContent {
  const lines: string[] = [];
  const dbLines: TaskLogLineInput[] = [];
  const header = `[akm task] task=${input.task.id} kind=prompt engine=${input.engineName}`;
  const summary = `ok=${input.result.ok} exit_code=${input.result.exitCode ?? "null"} duration_ms=${input.result.durationMs}`;
  lines.push(header, summary);
  dbLines.push({ line: header }, { level: input.result.ok ? "info" : "error", line: summary });
  if (input.engineAnnouncement) {
    lines.push(input.engineAnnouncement);
    dbLines.push({ level: "warn", line: input.engineAnnouncement });
  }
  for (const notice of input.notices ?? []) {
    const line = `lowering_notice=${notice.code} adapter=${notice.adapter} field=${notice.field ?? ""} message=${notice.message}`;
    lines.push(line);
    dbLines.push({ level: notice.severity === "warning" ? "warn" : "info", line });
  }
  if (!input.result.ok) {
    const failure = `reason=${input.result.reason ?? ""} error=${input.result.error ?? ""}`;
    lines.push(failure);
    dbLines.push({ level: "error", line: failure });
  }
  if (input.result.stdout) {
    lines.push("--- agent stdout ---");
    lines.push(input.result.stdout);
    dbLines.push(...streamLines(input.result.stdout, "stdout", "info"));
  }
  if (input.result.stderr) {
    lines.push("--- agent stderr ---");
    lines.push(input.result.stderr);
    dbLines.push(...streamLines(input.result.stderr, "stderr", "error"));
  }
  return { fileText: `${lines.join("\n")}\n`, dbLines };
}

// ── run logs ────────────────────────────────────────────────────────────────

/**
 * A finished run's log in both shapes: the flat text written to the per-run
 * log file (transitional human tail) and the structured per-line rows written
 * to logs.db (the queryable record — see src/core/logs-db.ts and
 * the #579 logs audit).
 */
interface RunLogContent {
  fileText: string;
  dbLines: readonly TaskLogLineInput[];
}

function taskLogPath(logDir: string, taskId: string, startedAtIso: string): string {
  const tsSlug = startedAtIso.replace(/[:.]/g, "-");
  return path.join(logDir, taskId, `${tsSlug}.log`);
}

function resolveTaskLogPath(logDir: string | undefined, taskId: string, startedAtIso: string): string {
  try {
    return taskLogPath(logDir ?? getTaskLogDir(), taskId, startedAtIso);
  } catch (error) {
    rethrowIfTestIsolationError(error);
    return "";
  }
}

/**
 * Redact logs.db rows against the SAME contiguous text the file sink sees.
 *
 * The rows arrive already split on "\n" (see {@link streamLines}), but the
 * redaction needles are whole env values — and a needle containing a newline
 * can never match inside a single line. Scrubbing row-by-row therefore left
 * multi-line secrets (PEM keys, multi-line service-account credentials) intact
 * in logs.db while the flat .log was correctly scrubbed, defeating all three
 * tiers including the explicit `redact:` opt-in.
 *
 * Consecutive rows sharing a stream and level are rejoined, scrubbed as one
 * string, and re-split, so a needle spanning lines matches. Collapsing a
 * multi-line secret into a single [REDACTED] row is the intended outcome.
 */
export function scrubDbLines(
  dbLines: readonly TaskLogLineInput[],
  scrub: (text: string) => string,
): TaskLogLineInput[] {
  const out: TaskLogLineInput[] = [];
  for (let i = 0; i < dbLines.length; ) {
    const { stream, level } = dbLines[i]!;
    let end = i;
    while (end < dbLines.length && dbLines[end]!.stream === stream && dbLines[end]!.level === level) end++;
    const joined = dbLines
      .slice(i, end)
      .map((entry) => entry.line)
      .join("\n");
    for (const line of scrub(joined).split("\n")) {
      if (line.length > 0) out.push({ stream, level, line });
    }
    i = end;
  }
  return out;
}

/** Split captured pipe output into per-line logs.db rows (blank lines dropped). */
function streamLines(text: string, stream: TaskLogStream, level: TaskLogLevel): TaskLogLineInput[] {
  return (
    text
      .split("\n")
      // Windows child output is CRLF-terminated. Splitting on "\n" alone left a
      // trailing "\r" on every row and turned blank CRLF lines into phantom
      // rows containing just "\r" (length 1 passes the filter below).
      .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
      .filter((line) => line.length > 0)
      .map((line) => ({ stream, level, line }))
  );
}

/**
 * Persist a finished run's log: the flat text file (so `log_path` in
 * task_history keeps resolving for humans and older consumers) plus
 * structured rows in logs.db keyed by `buildTaskRunId(taskId, startedAt)`.
 *
 * Both sinks are pattern-redacted (`redactCredentialPatterns`) before being
 * written — task output is raw command/agent/LLM text that can echo a
 * credential-bearing URL (e.g. a Discord webhook) nothing upstream expects to
 * scrub.
 *
 * The DB write is best-effort, mirroring {@link appendHistory}: an unwritable
 * logs.db must never fail a task run.
 */
/**
 * Exact secret values to scrub from this run's persisted output (#755).
 *
 * Best-effort by construction: this runs on the persistence path of a run that
 * has already finished, so a config that will not load must degrade to
 * "pattern-based redaction only" rather than fail the run. It does NOT degrade
 * to "log it anyway with no redaction at all" — `redactCredentialPatterns`
 * still runs unconditionally in the caller.
 */
function taskLogSensitiveValues(redactNames: readonly string[] | undefined): string[] {
  try {
    return collectTaskLogSensitiveValues({
      env: process.env,
      config: loadConfig(),
      declaredNames: redactNames,
    });
  } catch (error) {
    rethrowIfTestIsolationError(error);
    // No config — the name heuristic and the task's own `redact:` list still apply.
    try {
      return collectTaskLogSensitiveValues({ env: process.env, declaredNames: redactNames });
    } catch (fallbackError) {
      rethrowIfTestIsolationError(fallbackError);
      return [];
    }
  }
}

function persistRunLog(input: {
  taskId: string;
  startedAtIso: string;
  finishedAtIso: string;
  logPath: string;
  fileText: string;
  dbLines: readonly TaskLogLineInput[];
  /** The task's `redact:` names, if any (#755). */
  redactNames?: readonly string[] | undefined;
}): void {
  // Two arms, and both are needed. `redactCredentialPatterns` catches
  // credential SHAPES nobody listed; the exact-value pass catches configured
  // secrets whose value is shaped like nothing in particular (#755). The
  // command target had only the first, so a scheduled command that echoed an
  // ordinary-looking secret persisted it verbatim to both sinks. Applying the
  // exact pass here — the one sink all three target kinds funnel through —
  // covers every arm once rather than per-arm; prompt/workflow runs already
  // scrub upstream, and redaction is idempotent, so the overlap is free.
  const sensitive = taskLogSensitiveValues(input.redactNames);
  const scrub = (text: string): string =>
    sensitive.length > 0
      ? redactSensitiveText(redactCredentialPatterns(text), sensitive)
      : redactCredentialPatterns(text);
  const fileText = scrub(input.fileText);
  const dbLines = scrubDbLines(input.dbLines, scrub);
  if (input.logPath) {
    try {
      // Written at the process umask. #756 pinned 0600/0700 here; that went out
      // with the rest of akm's permission enforcement (#791) — the operator owns
      // the mode of their own data directory, and akm neither sets nor reports
      // on it.
      fs.mkdirSync(path.dirname(input.logPath), { recursive: true });
      fs.writeFileSync(input.logPath, fileText);
    } catch (error) {
      rethrowIfTestIsolationError(error);
      // Transitional file logging is fully best-effort.
    }
  }
  try {
    const db = openLogsDatabase();
    try {
      insertTaskLogLines(db, {
        taskId: input.taskId,
        runId: buildTaskRunId(input.taskId, input.startedAtIso),
        ts: input.finishedAtIso,
        lines: dbLines,
      });
    } finally {
      db.close();
    }
  } catch (error) {
    rethrowIfTestIsolationError(error);
    // Structured logging is fully best-effort and must not alter CLI output.
  }
}

interface ReservedTaskAttempt {
  startedAt: Date;
  historyReserved: boolean;
}

/** Reserve a collision-free identity through state.db's existing unique index. */
function reserveTaskAttempt(taskId: string, requestedStartedAt: Date): ReservedTaskAttempt {
  try {
    return withStateDb((db) => {
      for (let offsetMs = 0; ; offsetMs++) {
        const startedAt = new Date(requestedStartedAt.getTime() + offsetMs);
        const reserved = reserveTaskHistoryAttempt(db, {
          task_id: taskId,
          status: "active",
          started_at: startedAt.toISOString(),
          completed_at: null,
          failed_at: null,
          log_path: null,
          target_kind: null,
          target_ref: null,
          metadata_json: JSON.stringify({ metadataVersion: 2, durationMs: 0, detail: null }),
        });
        if (reserved) return { startedAt, historyReserved: true };
      }
    });
  } catch (error) {
    rethrowIfTestIsolationError(error);
    // Attempt recording cannot prevent or replace task execution.
    return { startedAt: requestedStartedAt, historyReserved: false };
  }
}

function finishAttempt(startedAt: Date, observedFinishedAt: Date): Date {
  return observedFinishedAt.getTime() < startedAt.getTime() ? new Date(startedAt) : observedFinishedAt;
}

const SAFE_TASK_ATTEMPT_ERROR_CODES = new Set([
  "CONFIG_DIR_UNRESOLVABLE",
  "STASH_DIR_NOT_FOUND",
  "STASH_DIR_NOT_A_DIRECTORY",
  "STASH_DIR_UNREADABLE",
  "LLM_NOT_CONFIGURED",
  "INVALID_CONFIG_FILE",
  "UNSUPPORTED_CONFIG_VERSION",
  "TEST_ISOLATION_MISSING",
  "INVALID_FLAG_VALUE",
  "MISSING_REQUIRED_ARGUMENT",
  "PATH_ESCAPE_VIOLATION",
  "TASK_SCHEMA_VERSION_UNSUPPORTED",
  "ASSET_NOT_FOUND",
  "WORKFLOW_NOT_FOUND",
  "FILE_NOT_FOUND",
]);

function safeTaskAttemptErrorCode(failure: unknown): string {
  if (failure instanceof AkmError && SAFE_TASK_ATTEMPT_ERROR_CODES.has(failure.code)) return failure.code;
  return "INTERNAL";
}

export function recordTaskAttemptFailure(input: {
  taskId: string;
  reason: TaskAttemptFailureReason;
  failure: unknown;
  startedAt: Date;
  finishedAt?: Date;
  logDir?: string;
  /** Internal: runTask already reserved this identity. */
  historyReserved?: boolean;
}): void {
  let taskId = input.taskId;
  try {
    validateTaskId(taskId);
  } catch {
    taskId = INVALID_TASK_ATTEMPT_ID;
  }
  const attempt =
    input.historyReserved === undefined
      ? reserveTaskAttempt(taskId, input.startedAt)
      : { startedAt: input.startedAt, historyReserved: input.historyReserved };
  const finishedAt = finishAttempt(attempt.startedAt, input.finishedAt ?? new Date());
  const startedAtIso = attempt.startedAt.toISOString();
  const finishedAtIso = finishedAt.toISOString();
  const errorCode = safeTaskAttemptErrorCode(input.failure);
  const logPath = resolveTaskLogPath(input.logDir, taskId, startedAtIso);
  const line = `[akm task] status=failed reason=${input.reason} code=${errorCode}`;
  const result: TaskRunResult = {
    id: taskId,
    status: "failed",
    startedAt: startedAtIso,
    finishedAt: finishedAtIso,
    durationMs: Math.max(0, finishedAt.getTime() - attempt.startedAt.getTime()),
    log: logPath,
    target: { kind: "unknown" },
    detail: { reason: input.reason, error: errorCode },
  };

  persistRunLog({
    taskId,
    startedAtIso,
    finishedAtIso,
    logPath,
    fileText: `${line}\n`,
    dbLines: [{ level: "error", line }],
  });
  appendHistory(result, attempt.historyReserved);
}

// ── history ─────────────────────────────────────────────────────────────────

function appendHistory(result: TaskRunResult, historyReserved = false): void {
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
      ...(result.target.kind === "prompt" ? { engine: result.target.engine } : {}),
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
 */
function taskHistoryRowToResult(
  row: import("../storage/repositories/task-history-repository").TaskHistoryRow,
): TaskRunResult {
  const meta = decodeTaskHistoryMetadata(row.metadata_json);

  const target: TaskRunResult["target"] =
    row.target_kind === "workflow"
      ? { kind: "workflow", ref: row.target_ref ?? "" }
      : row.target_kind === "command"
        ? { kind: "command" }
        : row.target_kind === "prompt"
          ? meta.metadataVersion === 1
            ? {
                kind: "prompt",
                engine: null,
                ...(meta.legacyProfile !== undefined ? { legacyProfile: meta.legacyProfile } : {}),
              }
            : { kind: "prompt", engine: meta.engine ?? null }
          : { kind: "unknown" };

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
