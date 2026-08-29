// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `exec` unit runner — the ONE place a frozen workflow spawns a shell
 * command as a unit: argv-only (never a shell string), non-blocking,
 * detached with a SIGTERM→SIGKILL ladder against the whole process group,
 * cwd-contained by a resolved-path recheck, resource-bounded (timeout,
 * output bytes, context size), and allowlisted-environment (see
 * {@link childEnv}). `env` values reaching this module are already resolved
 * from `env:` bindings by NAME — the caller scrubs the outcome with
 * `redactUnitOutcome` before anything is journaled. A LEAF module by
 * layering (Node built-ins, `core/spawn-env`, `core/subprocess`, `core/warn`,
 * the import-free `workflows/resource-limits` only).
 *
 * See docs/architecture/decisions/0003-child-env-allowlist-and-provenance.md
 * for the full per-invariant design history.
 *
 * @module workflows/exec/exec-unit
 */

import fs from "node:fs";
import path from "node:path";
import { isWithinAsync } from "../../core/common";
import { COMMON_SPAWN_ENV_PASSTHROUGH, collectAllowlistedEnv, WIN32_SPAWN_ENV_FLOOR } from "../../core/spawn-env";
import {
  type ManagedSubprocessResult,
  runManagedSubprocess,
  type SpawnFn,
  type StreamReadResult,
  streamCaptureFailure,
} from "../../core/subprocess";
import { warn } from "../../core/warn";
import type { IrExecSpec } from "../ir/schema";
import {
  type ExecContextLimits,
  execContextLimits,
  utf8Bytes,
  WORKFLOW_EXEC_OUTPUT_TRUNCATED_MARKER,
  WORKFLOW_MAX_EXEC_OUTPUT_BYTES,
  WORKFLOW_UNIT_DIAGNOSTIC_CLIP,
} from "../resource-limits";
import type { UnitDispatchResult } from "./unit-dispatch";

/**
 * Max characters of a failed command's stderr retained in the unit's `error`
 * diagnostic.
 *
 * Deliberately BELOW {@link WORKFLOW_UNIT_DIAGNOSTIC_CLIP}: the composed
 * diagnostic reads `<what happened>. stderr (last N chars): <tail>`, and the
 * journal clips that COMPOSED string head-first. Reserving 500 characters for
 * the prefix keeps the whole stderr tail — the part that actually says why the
 * command failed — inside the journaled and displayed diagnostic, instead of
 * losing its final few hundred characters to the outer clip.
 */
const EXEC_STDERR_DIAGNOSTIC_CLIP = WORKFLOW_UNIT_DIAGNOSTIC_CLIP - 500;

/**
 * The DEFAULT environment allowlist for an exec unit's child — the single
 * definition of the EXEC list; `exec.passEnv` extends it per unit. Extends
 * {@link COMMON_SPAWN_ENV_PASSTHROUGH} (the same baseline agent-harness
 * children use) plus POSIX/Windows names load-bearing for ordinary commands
 * (PATH, HOME, USER/LOGNAME, SHELL, locale, TERM, TZ, TMPDIR, the
 * {@link WIN32_SPAWN_ENV_FLOOR}, Windows toolchain roots) and
 * `AKM_EVENT_SOURCE` (provenance, DRIFT-6). Deliberately ABSENT and reachable
 * only through `exec.passEnv` / `env:`: credentials, cloud/CI vars, and the
 * proxy family.
 *
 * See docs/architecture/decisions/0003-child-env-allowlist-and-provenance.md
 * for the per-entry rationale and why the default is an allowlist at all.
 */
export const EXEC_DEFAULT_ENV_PASSTHROUGH: readonly string[] = [
  // PATH, HOME, USER, LANG, LC_ALL, TERM, TMPDIR, AKM_EVENT_SOURCE
  ...COMMON_SPAWN_ENV_PASSTHROUGH,
  // POSIX names a raw shell command needs beyond the agent baseline
  "LOGNAME",
  "SHELL",
  "LC_CTYPE",
  "TZ",
  // SystemRoot, SystemDrive, WINDIR, COMSPEC, PATHEXT, USERPROFILE, HOMEDRIVE,
  // HOMEPATH, TEMP, TMP. Named here as well as appended by `spawnEnvNamesFor`
  // because this list is consumed on POSIX too, where nothing is appended.
  ...WIN32_SPAWN_ENV_FLOOR,
  // Windows toolchain roots, deliberately not part of the floor
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
];

export interface RunExecUnitInput {
  /** Journal id of the attempt, for diagnostics. */
  unitId: string;
  exec: IrExecSpec;
  /**
   * Base working directory the unit's `cwd` resolves inside: the unit's fresh
   * detached worktree under `isolation: worktree`, otherwise the engine's work
   * dir (`ctx.workDir`, default `process.cwd()`).
   */
  baseDir: string;
  /** Resolved `env:` binding values, merged on top of the allowlisted base environment. */
  env?: Record<string, string>;
  /**
   * Engine-authored `AKM_*` context (ids, params, fan-out item + index,
   * declared inputs). Applied LAST so a binding can never shadow it, and size-
   * checked against {@link execContextLimits} for the CURRENT platform before
   * any spawn is attempted.
   */
  context?: Record<string, string>;
  /**
   * The unit declares an `output:` schema, so its stdout will be strictly JSON-
   * parsed and validated. Decides what an output-cap overflow means: a
   * truncated JSON prefix cannot be validated or promoted, so overflow is fatal
   * here and merely marked when absent. See {@link runExecUnit}.
   */
  hasOutputSchema?: boolean;
  /** Resolved wall-clock budget; `null` = the author's explicit `timeout: none`. */
  timeoutMs: number | null;
  signal?: AbortSignal;
  /** Test seam: injected spawn (defaults to the runtime spawn inside `runManagedSubprocess`). */
  spawnFn?: SpawnFn;
  /** Test seam: the platform whose spawn ceilings the context check uses. Defaults to the host's. */
  platform?: string;
  /**
   * F-1 (spec docs/plans/specs/p1b-model-extraction.md §5.2 point 2): the
   * task runner's resolved provenance event source. Typed as a bare `string`
   * (not `UsageEventSource`) to keep this module's LEAF import discipline —
   * see the module doc's Layering note. Applied to `childEnv`'s allowlisted
   * BASE only when the name is absent there, so an ambient AKM_EVENT_SOURCE
   * and an authored `env:` binding both still win (D5 clause d).
   */
  eventSource?: string;
}

/**
 * Run one exec unit and map its process outcome onto the dispatch vocabulary:
 * non-zero exit → `non_zero_exit`, wall-clock expiry → `timeout`, cancellation
 * → `aborted`, a child that never started → `spawn_failed` (all pre-existing
 * `AgentFailureReason` members, so `retry.on` keeps working). The
 * out-of-taxonomy `exec_cwd_escape`, `exec_output_limit`,
 * `exec_context_too_large` and `exec_capture_incomplete` are deliberate: each
 * is tampering, a runaway, an authoring bug, or work that ALREADY RAN — never
 * a transient — so no `retry.on` value can ever re-dispatch one. An
 * INCOMPLETE stdout capture is always a failure, never a partial artifact;
 * output OVERFLOW past {@link WORKFLOW_MAX_EXEC_OUTPUT_BYTES} does not fail a
 * command that otherwise passed unless the unit declared an `output:` schema
 * (a truncated JSON prefix cannot parse).
 *
 * See docs/architecture/decisions/0003-child-env-allowlist-and-provenance.md
 * for the full capture/overflow reasoning.
 */
export async function runExecUnit(input: RunExecUnitInput): Promise<UnitDispatchResult> {
  const cwd = await resolveExecCwd(input);
  if (!cwd.ok) return { ok: false, text: "", failureReason: cwd.failureReason, error: cwd.error };
  const context = checkExecContextSize(input);
  if (context) return context;

  const result = await runManagedSubprocess([...input.exec.command], {
    capture: true,
    cwd: cwd.path,
    env: childEnv(input.exec, input.env, input.context, input.eventSource),
    timeoutMs: input.timeoutMs,
    // stdout IS this unit's artifact, so RETENTION is BOUNDED: an unbounded
    // capture is memory the akm process spends on a command's behalf with no
    // ceiling at all until it exits or the (default 10-minute) budget expires.
    // The cap discards past the bound rather than killing — the command's own
    // outcome is not akm's memory problem to solve.
    maxOutputBytes: WORKFLOW_MAX_EXEC_OUTPUT_BYTES,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.spawnFn ? { spawnFn: input.spawnFn } : {}),
  });

  const display = describeCommand(input.exec.command);
  if (result.spawnError) {
    return {
      ok: false,
      text: "",
      failureReason: "spawn_failed",
      error: `exec unit "${input.unitId}" could not start ${display}: ${result.spawnError.message}`,
    };
  }
  // Whatever this unit hands back as `text` is marked when stdout was truncated
  // — on the failure paths too, where `text` is a diagnostic that would
  // otherwise read like the command's whole output.
  const stdout = markTruncatedStdout(result);
  // Abort is checked BEFORE timeout: a budget/user cancellation that raced a
  // wall-clock expiry is still a cancellation, and reporting it as `timeout`
  // would let a `retry.on: [timeout]` policy re-dispatch work the caller just
  // cancelled.
  if (result.aborted) {
    return {
      ok: false,
      text: stdout,
      failureReason: "aborted",
      error: `exec unit "${input.unitId}" was cancelled while running ${display}${stderrTail(result.stderr)}`,
    };
  }
  if (result.timedOut) {
    return {
      ok: false,
      text: stdout,
      failureReason: "timeout",
      error:
        `exec unit "${input.unitId}" exceeded its ${input.timeoutMs}ms timeout running ${display} ` +
        `and its process group was terminated${stderrTail(result.stderr)}`,
    };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      text: stdout,
      failureReason: "non_zero_exit",
      error: `exec unit "${input.unitId}" ran ${display} and it exited ${result.exitCode}${stderrTail(result.stderr)}`,
    };
  }
  // An exit code of 0 does NOT prove the output was fully captured — see the
  // module note above. Checked before the artifact is promoted, so a partial
  // stdout can never become `steps.<id>.output`.
  const captureFailure = streamCaptureFailure(result.stdoutRead, DRAINED_CLEAN);
  if (captureFailure) {
    return {
      ok: false,
      text: "",
      failureReason: "exec_capture_incomplete",
      error:
        `exec unit "${input.unitId}" ran ${display} and the command COMPLETED (it exited 0), but its stdout could ` +
        `not be fully captured (${captureFailure}), so the stdout artifact would be incomplete. The unit is NOT ` +
        `retried: the command already ran, and re-dispatching identical argv to fix a capture problem would run its ` +
        `side effects a second time. A background descendant still holding stdout open is the usual cause — have ` +
        `the command wait for its children, or redirect their output${stderrTail(result.stderr)}`,
    };
  }
  reportStderrCaptureFailure(input, display, result);
  // The command exited 0 and the pipes drained to their end. The ONE thing an
  // overflow can still ruin is a TYPED artifact: a truncated prefix is not one
  // JSON value, so there is nothing to validate and nothing safe to promote.
  if (result.stdoutRead.overflowed && input.hasOutputSchema) {
    return outputLimitFailure(input, display, result);
  }
  // The promoted artifact is STDOUT. Trailing newlines are stripped, exactly
  // like shell command substitution `$(…)`, so a one-line command's artifact is
  // the value an author expects rather than the value plus a `\n`. stderr is a
  // diagnostic channel only and never contributes to the artifact. When stdout
  // overflowed, `stdout` already carries the truncation marker (which is
  // deliberately the LAST thing in the artifact, so it survives the strip).
  return { ok: true, text: stripTrailingNewlines(stdout) };
}

/**
 * A drain report with nothing wrong in it, passed as the OTHER pipe so
 * {@link streamCaptureFailure} classifies exactly one of them.
 *
 * The classifier stays shared with the agent path — what a failed drain means
 * must not drift — while each caller decides which pipes are fatal for IT.
 */
const DRAINED_CLEAN: StreamReadResult = {
  text: "",
  timedOut: false,
  overflowed: false,
  bytesRead: 0,
  retainedBytes: 0,
};

/**
 * Report a stderr drain that did not finish on an otherwise successful unit.
 *
 * Warn-only by construction: the artifact is stdout, which was captured whole,
 * so there is nothing wrong with the unit's RESULT — only with how much of its
 * log tail akm holds. A dispatch result has no channel for a non-fatal note, so
 * the operator surface is the warn stream.
 */
function reportStderrCaptureFailure(input: RunExecUnitInput, display: string, result: ManagedSubprocessResult): void {
  const stderrFailure = streamCaptureFailure(DRAINED_CLEAN, result.stderrRead);
  if (!stderrFailure) return;
  warn(
    `exec unit "${input.unitId}" ran ${display} and it exited 0 with its stdout fully captured, but ` +
      `${stderrFailure}. stderr is a diagnostic channel and never contributes to the artifact, so the unit stands; ` +
      `any stderr shown for it may be missing its tail. A background descendant still holding stderr open is the ` +
      `usual cause.`,
  );
}

/** The sentence naming what the retention cap discarded, shared by both reports below. */
function truncationNote(read: StreamReadResult): string {
  return (
    `the command wrote ${read.bytesRead} bytes to stdout and only the first ${read.retainedBytes} were retained ` +
    `(the ${WORKFLOW_MAX_EXEC_OUTPUT_BYTES}-byte per-pipe capture limit)`
  );
}

/**
 * The captured stdout, with an unmistakable truncation block appended when the
 * retention cap discarded part of it.
 *
 * Same idiom, same reason as `WORKFLOW_EVIDENCE_TRUNCATED_MARKER`
 * (`runtime/runs.ts`): truncated data must never be mistakable for complete
 * data. The block names both byte counts, so a reader can see exactly how much
 * is missing rather than inferring it from a suspiciously round length.
 */
function markTruncatedStdout(result: ManagedSubprocessResult): string {
  const read = result.stdoutRead;
  if (!read.overflowed) return result.stdout;
  const discarded = read.bytesRead - read.retainedBytes;
  return (
    `${result.stdout}\n\n[${WORKFLOW_EXEC_OUTPUT_TRUNCATED_MARKER}] ` +
    `stdout was TRUNCATED: ${truncationNote(read)}. ` +
    `The remaining ${discarded} bytes were read and discarded — the command itself ran to completion, ` +
    `so its exit code is real, but THIS TEXT IS INCOMPLETE and must not be treated as the command's whole output. ` +
    `Have the command write bulk output to a file and print the path, or quiet it down.`
  );
}

/**
 * The output-cap failure for a unit that declared an `output:` schema —
 * deliberately UNMISTAKABLE.
 *
 * `text` is emptied rather than carrying the partial capture: for a failed unit
 * `text` is only a diagnostic (the durable evidence graph keeps a failure's
 * `failureReason` alone), and handing back several megabytes of a runaway
 * command's output as "the text" would just move the memory problem one layer
 * up. The byte counts go in the message instead, so the operator can see how far
 * past the cap the command ran.
 */
function outputLimitFailure(
  input: RunExecUnitInput,
  display: string,
  result: ManagedSubprocessResult,
): UnitDispatchResult {
  return {
    ok: false,
    text: "",
    failureReason: "exec_output_limit",
    error:
      `exec unit "${input.unitId}" ran ${display}, it exited 0, but ${truncationNote(result.stdoutRead)}. ` +
      `This unit declares an output: schema, so its stdout must parse as exactly one JSON value — a truncated ` +
      `prefix cannot, and promoting it would silently corrupt every downstream reference to the typed artifact. ` +
      `NO artifact was promoted. Have the command write bulk output to a file and print the path, quiet it down, ` +
      `or drop the output: schema if the step does not actually need a typed artifact.`,
  };
}

/**
 * Refuse to spawn when the engine-authored `AKM_*` context would not fit in the
 * child's environment ON THIS PLATFORM.
 *
 * A workflow artifact has no bound comparable to an OS environment entry, so a
 * perfectly legitimate declared input can serialize into an `AKM_INPUTS` far
 * past what `execve` accepts. Left unchecked that surfaces as a bare `E2BIG`
 * from the spawn syscall — reported as `spawn_failed` with a message about
 * "argument list too long" that names neither the variable nor the artifact
 * that produced it. Checking here converts it into a located, actionable
 * failure BEFORE process creation is attempted.
 *
 * ## The ceiling is the CURRENT platform's, never the smallest one
 *
 * That translation is this check's ONLY job, which fixes its bound exactly: the
 * limits come from {@link execContextLimits} for the platform the run is on. A
 * guard that applied Windows' 32 767-character ceiling on Linux would fail
 * spawns the kernel would happily have accepted — inventing a failure instead of
 * explaining an inevitable one, which is a tripwire and not a guard. Workflows
 * that must also run on Windows should stay under the smaller bound; that is
 * documented guidance (`docs/reference/workflow-schema.md`), not something a
 * Linux host enforces.
 *
 * Only the engine-authored context is measured. The unit's `env:` bindings are
 * authored values a human wrote and sized; this is the surface where the SIZE
 * is data-dependent and therefore surprising.
 */
function checkExecContextSize(input: RunExecUnitInput): UnitDispatchResult | undefined {
  const limits = execContextLimits(input.platform ?? process.platform);
  const entries = Object.entries(input.context ?? {});
  let total = 0;
  for (const [name, value] of entries) {
    const bytes = utf8Bytes(value);
    total += bytes + utf8Bytes(name) + 1;
    if (bytes > limits.perVarBytes) {
      return contextTooLarge(
        input,
        `its ${name} context variable is ${bytes} bytes, over the ${limits.perVarBytes}-byte per-variable limit`,
        name,
        limits,
      );
    }
  }
  if (total > limits.totalBytes) {
    return contextTooLarge(
      input,
      `its AKM_* context variables total ${total} bytes, over the ${limits.totalBytes}-byte limit`,
      entries.map(([name]) => name).join(", "),
      limits,
    );
  }
  return undefined;
}

function contextTooLarge(
  input: RunExecUnitInput,
  what: string,
  names: string,
  limits: ExecContextLimits,
): UnitDispatchResult {
  return {
    ok: false,
    text: "",
    failureReason: "exec_context_too_large",
    error:
      `exec unit "${input.unitId}" cannot be spawned: ${what}. ` +
      `Environment variables (${names}) are how a frozen argv receives data, and this platform caps them ` +
      `(${limits.source}) — spawning would fail with a bare E2BIG. ` +
      `Have the producing step emit a REFERENCE (a file path, an id) instead of inline bulk data, narrow the step's ` +
      `declared inputs:, or reduce the fan-out item size.`,
  };
}

type ResolvedCwd = { ok: true; path: string } | { ok: false; failureReason: string; error: string };

/**
 * Resolve `exec.cwd` inside `baseDir` and prove containment against the
 * RESOLVED base (symlinks included). The syntactic checks the parser and the
 * decoder already ran are necessary but not sufficient: `reports` can be a
 * symlink to `/etc`, and only a realpath comparison catches that.
 *
 * Async on purpose: this runs once per unit — up to 10 000 times for one map
 * step — on the dispatch path that must never block (see the module note).
 */
async function resolveExecCwd(input: RunExecUnitInput): Promise<ResolvedCwd> {
  const base = path.resolve(input.baseDir);
  const target = input.exec.cwd ? path.resolve(base, input.exec.cwd) : base;
  if (!(await isWithinAsync(target, base))) {
    return {
      ok: false,
      failureReason: "exec_cwd_escape",
      error:
        `exec unit "${input.unitId}" declares cwd ${JSON.stringify(input.exec.cwd ?? ".")}, which resolves to ` +
        `${target} — outside its working directory ${base}. Refusing to run outside the unit's tree.`,
    };
  }
  if (!(await isExistingDirectory(target))) {
    return {
      ok: false,
      failureReason: "spawn_failed",
      error: `exec unit "${input.unitId}" cannot run: its working directory ${target} does not exist or is not a directory.`,
    };
  }
  return { ok: true, path: target };
}

async function isExistingDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The child's environment, in three layers with fixed precedence: (1) the
 * BASE — {@link EXEC_DEFAULT_ENV_PASSTHROUGH} plus the unit's `exec.passEnv`
 * names; (2) the unit's resolved `env:` bindings; (3) the engine-authored
 * `AKM_*` context, LAST so a workflow-supplied binding can never shadow the
 * ids/item the engine is telling the command the truth about.
 *
 * See docs/architecture/decisions/0003-child-env-allowlist-and-provenance.md
 * for why the default is an allowlist rather than full inheritance.
 */
function childEnv(
  exec: IrExecSpec,
  bindings: Record<string, string> | undefined,
  context: Record<string, string> | undefined,
  eventSource: string | undefined,
): Record<string, string> {
  const env = collectAllowlistedEnv(execAllowlist(exec));
  // F-1 (spec §5.2 point 2): applied to the allowlisted BASE only when the
  // ambient passthrough above left the name absent — an ambient
  // AKM_EVENT_SOURCE already collected into `env` still wins, and this runs
  // strictly BEFORE the bindings/context overlays below, so an authored
  // `env:` binding (or the engine-authored context) still wins too.
  if (eventSource !== undefined && env.AKM_EVENT_SOURCE === undefined) {
    env.AKM_EVENT_SOURCE = eventSource;
  }
  for (const [name, value] of Object.entries(bindings ?? {})) env[name] = value;
  for (const [name, value] of Object.entries(context ?? {})) env[name] = value;
  return env;
}

/** The unit's effective allowlist: the shared default plus its own `passEnv` names. */
function execAllowlist(exec: IrExecSpec): string[] {
  return exec.passEnv ? [...EXEC_DEFAULT_ENV_PASSTHROUGH, ...exec.passEnv] : [...EXEC_DEFAULT_ENV_PASSTHROUGH];
}

/** `argv[0]` plus its argument count — never the full argv, which can carry values. */
function describeCommand(command: readonly string[]): string {
  const rest = command.length - 1;
  return `${JSON.stringify(command[0])} (${rest} argument${rest === 1 ? "" : "s"})`;
}

/** The tail of a failed command's stderr, clipped and explicitly marked when truncated. */
function stderrTail(stderr: string): string {
  const trimmed = stderr.trim();
  if (!trimmed) return "";
  if (trimmed.length <= EXEC_STDERR_DIAGNOSTIC_CLIP) return `. stderr:\n${trimmed}`;
  return `. stderr (last ${EXEC_STDERR_DIAGNOSTIC_CLIP} chars):\n…${trimmed.slice(-EXEC_STDERR_DIAGNOSTIC_CLIP)}`;
}

/** Strip trailing line terminators, matching shell `$(…)` command substitution. */
function stripTrailingNewlines(text: string): string {
  return text.replace(/(?:\r?\n)+$/, "");
}
