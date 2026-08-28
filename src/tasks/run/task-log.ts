// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Task-run log persistence: log path resolution, the flat per-run log file,
 * structured logs.db rows, and the shared redaction pass both sinks go
 * through before either is written.
 *
 * Moved body-intact from src/tasks/runner.ts (spec
 * docs/plans/specs/p1b-model-extraction.md §5.1, runner.ts:779-968).
 *
 * A DAG leaf with respect to the rest of src/tasks/run/**: nothing here
 * imports ./task-result, ./task-history, or ./attempt-lifecycle, so every
 * other run/** module can depend on this one without risking an import
 * cycle (tests/architecture/import-cycle-ratchet.test.ts counts type-only
 * imports as real edges too).
 */

import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../../core/config/config";
import { rethrowIfTestIsolationError } from "../../core/errors";
import {
  buildTaskRunId,
  insertTaskLogLines,
  openLogsDatabase,
  type TaskLogLevel,
  type TaskLogLineInput,
  type TaskLogStream,
} from "../../core/logs-db";
import { getTaskLogDir } from "../../core/paths";
import { redactCredentialPatterns, redactSensitiveText } from "../../core/redaction";
import { collectTaskLogSensitiveValues } from "../log-redaction";
import type { PreparedTaskV3Execution } from "../prepare/prepared-execution";

/**
 * A finished run's log in both shapes: the flat text written to the per-run
 * log file (transitional human tail) and the structured per-line rows written
 * to logs.db (the queryable record — see src/core/logs-db.ts and
 * the #579 logs audit).
 */
export interface RunLogContent {
  fileText: string;
  dbLines: readonly TaskLogLineInput[];
}

function taskLogPath(logDir: string, taskId: string, startedAtIso: string): string {
  const tsSlug = startedAtIso.replace(/[:.]/g, "-");
  return path.join(logDir, taskId, `${tsSlug}.log`);
}

export function resolveTaskLogPath(logDir: string | undefined, taskId: string, startedAtIso: string): string {
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
export function streamLines(text: string, stream: TaskLogStream, level: TaskLogLevel): TaskLogLineInput[] {
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
 * Exact secret values to scrub from this run's persisted output (#755).
 *
 * Best-effort by construction: this runs on the persistence path of a run that
 * has already finished, so a config that will not load must degrade to
 * "pattern-based redaction only" rather than fail the run. It does NOT degrade
 * to "log it anyway with no redaction at all" — `redactCredentialPatterns`
 * still runs unconditionally in the caller.
 */
function taskLogSensitiveValues(
  redactNames: readonly string[] | undefined,
  environment?: Readonly<Record<string, string>>,
): string[] {
  const env = { ...process.env, ...environment };
  try {
    return collectTaskLogSensitiveValues({
      env,
      config: loadConfig(),
      declaredNames: redactNames,
    });
  } catch (error) {
    rethrowIfTestIsolationError(error);
    // No config — the name heuristic and the task's own `redact:` list still apply.
    try {
      return collectTaskLogSensitiveValues({ env, declaredNames: redactNames });
    } catch (fallbackError) {
      rethrowIfTestIsolationError(fallbackError);
      return [];
    }
  }
}

/** Scrub one piece of durable-result text against a prepared task's own secrets. */
export function scrubTaskOutput(task: PreparedTaskV3Execution, text: string): string {
  const patterned = redactCredentialPatterns(text);
  const sensitive = taskLogSensitiveValues(task.redact, task.environment);
  return sensitive.length > 0 ? redactSensitiveText(patterned, sensitive) : patterned;
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
 * The DB write is best-effort, mirroring history recording: an unwritable
 * logs.db must never fail a task run.
 */
export function persistRunLog(input: {
  taskId: string;
  startedAtIso: string;
  finishedAtIso: string;
  logPath: string;
  fileText: string;
  dbLines: readonly TaskLogLineInput[];
  /** The task's `redact:` names, if any (#755). */
  redactNames?: readonly string[] | undefined;
  /** Prepared task-local env overrides ambient values of the same name. */
  environment?: Readonly<Record<string, string>> | undefined;
}): void {
  // Two arms, and both are needed. `redactCredentialPatterns` catches
  // credential SHAPES nobody listed; the exact-value pass catches configured
  // secrets whose value is shaped like nothing in particular (#755). The
  // command target had only the first, so a scheduled command that echoed an
  // ordinary-looking secret persisted it verbatim to both sinks. Applying the
  // exact pass here — the one sink all three target kinds funnel through —
  // covers every arm once rather than per-arm; prompt/workflow runs already
  // scrub upstream, and redaction is idempotent, so the overlap is free.
  const sensitive = taskLogSensitiveValues(input.redactNames, input.environment);
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
