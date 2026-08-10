// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `exec` unit runner — the ONE place a frozen workflow spawns a shell
 * command as a unit. The invariants it exists to hold:
 *
 *   - ARGV, NEVER A SHELL STRING. {@link IrExecSpec.command} is an argv ARRAY
 *     and the format has no shell-string spelling at all; the child is spawned
 *     directly, so `;`, `|`, `&&`, `$(…)`, backticks, `>` and `*` are inert
 *     literal argument BYTES. A workflow that wants a pipeline names the
 *     interpreter itself (`["bash", "-lc", "a | b"]`), visibly in frontmatter.
 *   - NON-BLOCKING. Everything on this path is async. A synchronous call here
 *     blocks the event loop and with it every concurrently-scheduled unit, the
 *     run's lease heartbeat, and abort handling.
 *   - NO LEAKED CHILDREN. {@link runManagedSubprocess} spawns DETACHED and runs
 *     a SIGTERM→SIGKILL ladder against the whole process group, so `--timeout`
 *     and Ctrl-C really do stop a running command and its descendants.
 *   - CONTAINMENT. `exec.cwd` is relative and `..`-free by construction (parser
 *     and frozen-plan decoder), which is necessary but not sufficient: a
 *     subdirectory can be a symlink. The RESOLVED path is therefore re-checked
 *     against the RESOLVED base immediately before spawning.
 *   - BOUNDED SPEND. A command is arbitrary code with no resource discipline of
 *     its own, so each resource it spends on akm's behalf has a ceiling in
 *     `workflows/resource-limits.ts`: wall clock ({@link DEFAULT_EXEC_TIMEOUT_MS}
 *     or the authored `timeout:`), retained output
 *     ({@link WORKFLOW_MAX_EXEC_OUTPUT_BYTES} per pipe) and the context
 *     environment ({@link execContextLimits}, checked BEFORE the spawn so an
 *     oversized artifact yields an actionable akm error, not a bare `E2BIG`).
 *   - ALLOWLISTED ENVIRONMENT. The child does NOT inherit akm's environment: it
 *     starts EMPTY and receives exactly {@link EXEC_DEFAULT_ENV_PASSTHROUGH}
 *     plus the unit's `exec.passEnv`, then the resolved `env:` bindings, then
 *     the engine-authored `AKM_*` context. `exec.inheritEnv` opts back into full
 *     inheritance. See {@link childEnv}.
 *
 * Secrets: `env` values reaching this module are already resolved from `env:`
 * bindings by NAME (`resolveEnvBinding`) — the plan never carries inline secrets
 * and the input hash only ever carries names. The caller scrubs the outcome with
 * `redactUnitOutcome` BEFORE anything is journaled, which is why this module may
 * return raw stdout/stderr diagnostics without knowing anything about redaction.
 *
 * Layering: a LEAF. Node built-ins, `core/spawn-env`, `core/subprocess` and the
 * import-free `workflows/resource-limits` (plus erased types) only, so the
 * executor can consume it without opening an import cycle.
 *
 * @module workflows/exec/exec-unit
 */

import fs from "node:fs";
import path from "node:path";
import { isWithinAsync } from "../../core/common";
import {
  COMMON_SPAWN_ENV_PASSTHROUGH,
  collectAllowlistedEnv,
  supplementPathForSchedulerContext,
} from "../../core/spawn-env";
import {
  type ManagedSubprocessResult,
  runManagedSubprocess,
  type SpawnFn,
  type StreamReadResult,
  streamCaptureFailure,
} from "../../core/subprocess";
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
 * definition, mirrored nowhere else (the docs describe it, the tests assert
 * against it, and `exec.passEnv` extends it per unit).
 *
 * The child starts from an EMPTY environment and receives only these names,
 * matching how an agent harness child is already built
 * (`profile.envPassthrough` → `collectAllowlistedEnv`) — and literally
 * extending the same {@link COMMON_SPAWN_ENV_PASSTHROUGH} baseline those
 * profiles start from, so the two child-spawn allowlists share one floor.
 * Every entry earns its place by being load-bearing for ordinary commands on
 * some supported platform:
 *
 *   - `PATH`        — command resolution. Without it only an absolute `argv[0]`
 *                     can ever be spawned.
 *   - `HOME`        — the config/cache root essentially every toolchain reads
 *                     (git, npm, bun, cargo, ssh). Absent, tools fall back to
 *                     `/` or fail outright.
 *   - `USER`, `LOGNAME` — process identity; git and ssh read them to attribute
 *                     and authenticate.
 *   - `SHELL`       — read by tools that re-exec a login shell for the user's
 *                     own environment (an explicit `["bash", "-lc", …]` argv
 *                     does not need it, but `git`'s pagers/editors do).
 *   - `LANG`, `LC_ALL`, `LC_CTYPE` — text encoding. Without a locale a command
 *                     falls back to the C locale and mangles non-ASCII stdout,
 *                     which IS this unit's artifact.
 *   - `TERM`        — some CLIs abort or emit raw escape bytes with no TERM.
 *   - `TZ`          — timestamps a command prints would otherwise silently
 *                     switch to the host default.
 *   - `TMPDIR`      — POSIX scratch space; absent, tools write to `/tmp` or
 *                     fail on read-only hosts.
 *   - `SystemRoot`, `SystemDrive`, `WINDIR` — Windows PROCESS CREATION itself
 *                     needs these: with an empty environment the loader cannot
 *                     find system DLLs and the spawn fails before the command
 *                     runs. Not optional on win32.
 *   - `COMSPEC`     — Windows resolves `.bat`/`.cmd` targets through cmd.exe.
 *   - `PATHEXT`     — Windows only treats these extensions as executable; an
 *                     absent PATHEXT makes `command: ["bun", …]` unresolvable
 *                     because `bun.exe`/`bun.cmd` are never tried.
 *   - `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH` — the Windows `HOME` analogues.
 *   - `APPDATA`, `LOCALAPPDATA` — Windows config/cache roots (npm, bun, git).
 *   - `TEMP`, `TMP` — the Windows `TMPDIR` analogues.
 *   - `ProgramData`, `ProgramFiles` — machine-wide install roots that Windows
 *                     toolchain shims resolve against.
 *   - `AKM_EVENT_SOURCE` — provenance, never a secret: an exec unit that calls
 *                     `akm` must record machine traffic rather than user
 *                     demand, exactly as the agent passthrough list does
 *                     (`integrations/agent/profiles.ts`, DRIFT-6).
 *
 * Deliberately ABSENT and reachable only through `exec.passEnv` / `env:` /
 * `exec.inheritEnv`: credentials of every kind, cloud/CI vars, and the proxy
 * family (`HTTP_PROXY` & friends) — proxy URLs routinely embed credentials,
 * which is why akm's redaction policy already treats URL-shaped passthrough
 * values as credential-bearing.
 */
export const EXEC_DEFAULT_ENV_PASSTHROUGH: readonly string[] = [
  // PATH, HOME, USER, LANG, LC_ALL, TERM, TMPDIR, AKM_EVENT_SOURCE
  ...COMMON_SPAWN_ENV_PASSTHROUGH,
  // POSIX names a raw shell command needs beyond the agent baseline
  "LOGNAME",
  "SHELL",
  "LC_CTYPE",
  "TZ",
  // Windows process creation, command resolution, and toolchain roots
  "SystemRoot",
  "SystemDrive",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
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
}

/**
 * Run one exec unit and map its process outcome onto the dispatch vocabulary:
 * non-zero exit → `non_zero_exit`, wall-clock expiry → `timeout`, cancellation
 * → `aborted`, a child that never started → `spawn_failed`. All four are
 * pre-existing `AgentFailureReason` members, so `retry.on` keeps working
 * unchanged. The out-of-taxonomy `exec_cwd_escape`, `exec_output_limit`,
 * `exec_context_too_large` and `exec_capture_incomplete` are deliberate: each is
 * tampering, a runaway, an authoring bug, or work that ALREADY RAN — never a
 * transient — so no `retry.on` value can ever re-dispatch one.
 *
 * ## An INCOMPLETE capture is a failure, never a partial artifact
 *
 * `exitCode === 0` is not on its own proof that stdout was fully read: a pipe
 * can error, and the stream-drain timeout can fire while the command LEADER has
 * already exited 0 because a background descendant still holds the stdout fd
 * open. Both leave a PREFIX, and promoting it would hand the next step, the gate
 * judge and `steps.<id>.output` a silently truncated artifact. So the unit fails
 * instead, through the same shared classifier (`streamCaptureFailure`) the agent
 * spawn path uses.
 *
 * Its reason is `exec_capture_incomplete`, deliberately OUTSIDE the `retry.on`
 * taxonomy, for the same reason `journal_write_failed` is: the command RAN TO
 * COMPLETION and exited 0 — what failed is akm's record of it. A retryable
 * reason here would let `retry.on: [spawn_failed]` re-dispatch byte-identical
 * argv for a command that already deployed, already published, already migrated.
 * `spawn_failed` keeps its documented meaning — the child never started.
 *
 * ## Output OVERFLOW does not fail a command that passed
 *
 * Crossing {@link WORKFLOW_MAX_EXEC_OUTPUT_BYTES} is a different condition: the
 * reader DID drain the pipe to its end, it just stopped RETAINING, so the child
 * never blocked and its exit code is real. Failing a passing-but-chatty test
 * suite over its log volume would be a tripwire, so overflow splits by what the
 * unit PROMISED about its output:
 *
 *   - NO declared `output:` schema → success, with the artifact carrying a
 *     {@link WORKFLOW_EXEC_OUTPUT_TRUNCATED_MARKER} block naming both byte
 *     counts, so truncated text can never pass for complete text.
 *   - a declared `output:` schema → `exec_output_limit`: stdout must parse as
 *     EXACTLY one JSON value, a truncated prefix cannot, and promoting it would
 *     corrupt every downstream reference to the typed artifact.
 *
 * stderr overflow never fails anything: stderr is a diagnostic channel, and
 * {@link EXEC_STDERR_DIAGNOSTIC_CLIP} already bounds and marks what reaches the
 * journal.
 */
export async function runExecUnit(input: RunExecUnitInput): Promise<UnitDispatchResult> {
  const cwd = await resolveExecCwd(input);
  if (!cwd.ok) return { ok: false, text: "", failureReason: cwd.failureReason, error: cwd.error };
  const context = checkExecContextSize(input);
  if (context) return context;

  const result = await runManagedSubprocess([...input.exec.command], {
    capture: true,
    cwd: cwd.path,
    env: childEnv(input.exec, input.env, input.context),
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
  const captureFailure = streamCaptureFailure(result.stdoutRead, result.stderrRead);
  if (captureFailure) {
    return {
      ok: false,
      text: "",
      failureReason: "exec_capture_incomplete",
      error:
        `exec unit "${input.unitId}" ran ${display} and the command COMPLETED (it exited 0), but its output could ` +
        `not be fully captured (${captureFailure}), so the stdout artifact would be incomplete. The unit is NOT ` +
        `retried: the command already ran, and re-dispatching identical argv to fix a capture problem would run its ` +
        `side effects a second time. A background descendant still holding stdout open is the usual cause — have ` +
        `the command wait for its children, or redirect their output${stderrTail(result.stderr)}`,
    };
  }
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
 * The child's environment, in three layers with fixed precedence:
 *
 *   1. the BASE — an allowlist by default ({@link EXEC_DEFAULT_ENV_PASSTHROUGH}
 *      plus the unit's `exec.passEnv` names), or the akm process's whole
 *      environment when the unit opted in with `exec.inheritEnv`;
 *   2. the unit's resolved `env:` bindings;
 *   3. the engine-authored `AKM_*` context, LAST so a workflow-supplied binding
 *      can never shadow the ids/item the engine is telling the command the
 *      truth about.
 *
 * ## Why the default is an allowlist
 *
 * Not because it stops an attacker: a command that runs at all can read the
 * same credentials off disk that the environment would have handed it, and a
 * workflow source is executed code either way (`docs/guides/run-workflows.md`,
 * "workflow sources are executed code"). The allowlist earns its place for
 * three narrower, real reasons:
 *
 *   - it bounds ACCIDENTAL exposure — the ambient shell of whoever ran
 *     `akm workflow run` (or the CI job that did) routinely carries tokens for
 *     unrelated services, and a third-party workflow step that merely prints
 *     its environment, or a tool that ships one in a crash report, should not
 *     get them for free;
 *   - it makes the environment surface EXPLICIT and REVIEWABLE — what a
 *     command can see is this constant plus lines in the frontmatter diff,
 *     rather than "whatever the invoking shell happened to export";
 *   - it matches the convention akm already applies to spawned children —
 *     `profile.envPassthrough` in `integrations/agent/spawn.ts` has always
 *     built agent-harness children this way, and the SAME
 *     {@link collectAllowlistedEnv} does it here, so there is one mechanism to
 *     review instead of two.
 *
 * `inheritEnv` is the honest escape hatch for a command that genuinely needs the
 * caller's whole environment. It passes everything through, PATH included —
 * supplemented for scheduler contexts exactly as {@link collectAllowlistedEnv}
 * does it, because the MORE permissive branch must never hand a command a WORSE
 * PATH than the restrictive default does under cron/launchd.
 */
function childEnv(
  exec: IrExecSpec,
  bindings: Record<string, string> | undefined,
  context: Record<string, string> | undefined,
): Record<string, string> {
  const env = exec.inheritEnv ? inheritedProcessEnv() : collectAllowlistedEnv(execAllowlist(exec));
  for (const [name, value] of Object.entries(bindings ?? {})) env[name] = value;
  for (const [name, value] of Object.entries(context ?? {})) env[name] = value;
  return env;
}

/** The unit's effective allowlist: the shared default plus its own `passEnv` names. */
function execAllowlist(exec: IrExecSpec): string[] {
  return exec.passEnv ? [...EXEC_DEFAULT_ENV_PASSTHROUGH, ...exec.passEnv] : [...EXEC_DEFAULT_ENV_PASSTHROUGH];
}

/**
 * The akm process's own environment (`exec.inheritEnv`), with the same
 * scheduler-context PATH supplementation {@link collectAllowlistedEnv} applies.
 */
function inheritedProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[name] = value;
  }
  if (env.PATH !== undefined) env.PATH = supplementPathForSchedulerContext(env.PATH);
  return env;
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
