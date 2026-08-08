// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `exec` unit runner — the ONE place a frozen workflow spawns a shell
 * command as a unit.
 *
 * ## Why argv, never a shell string
 *
 * {@link IrExecSpec.command} is an argv ARRAY and the format has no
 * shell-string spelling at all. The child is spawned directly
 * ({@link runManagedSubprocess} → the runtime spawn), so no shell ever parses
 * the words: `;`, `|`, `&&`, `$(…)`, backticks, `>` and `*` are inert literal
 * argument BYTES. The entire quoting/injection class that a
 * `sh -c "<string>"` surface opens is therefore structurally absent rather
 * than defended against. A workflow that genuinely wants a pipeline names the
 * interpreter itself (`["bash", "-lc", "a | b"]`) — which makes the decision
 * visible in the frontmatter diff instead of hiding it behind a convenience.
 *
 * ## Non-blocking, and no leaked children
 *
 * Everything here is async. `spawnSync` on the dispatch path would block the
 * event loop and with it every concurrently-scheduled unit, the run's lease
 * heartbeat, and abort handling — so it is never used.
 * {@link runManagedSubprocess} spawns the child DETACHED (its own process
 * group) and runs a SIGTERM→SIGKILL ladder against the whole group on timeout
 * or abort, so a killed command cannot leave orphaned descendants behind, and
 * `--timeout` / Ctrl-C really do stop a running command.
 *
 * ## Containment
 *
 * `exec.cwd` is relative and `..`-free by construction (the parser and the
 * frozen-plan decoder both reject anything else through
 * `isContainedRelativePath`). This module re-checks the RESOLVED path against
 * the resolved base with {@link isWithin} — symlinks included — immediately
 * before spawning, so a checkout that contains a symlinked subdirectory cannot
 * be used to step outside the unit's working tree (the run's work dir, or the
 * unit's fresh worktree under `isolation: worktree`).
 *
 * ## The child's environment is an ALLOWLIST
 *
 * The child does NOT inherit akm's environment. It starts EMPTY and receives
 * exactly {@link EXEC_DEFAULT_ENV_PASSTHROUGH} (plus the unit's own
 * `exec.passEnv` names), then the resolved `env:` bindings, then the
 * engine-authored `AKM_*` context. `exec.inheritEnv` opts back into full
 * inheritance. See {@link childEnv} for why.
 *
 * ## Secrets
 *
 * `env` values reaching this module are already resolved from `env:` bindings
 * by NAME (`resolveEnvBinding`) — the plan never carries inline secrets, and
 * the input hash only ever carries the names. The caller collects those exact
 * values through the shared `collectWorkflowDispatchSensitiveValues` and scrubs
 * the outcome with `redactUnitOutcome` BEFORE anything is journaled, which is
 * why this module may return raw stdout/stderr diagnostics without knowing
 * anything about redaction itself.
 *
 * Layering: a LEAF. It imports only node built-ins, `core/common`, and
 * `core/subprocess` (plus erased types), so the executor can consume it
 * without opening an import cycle.
 *
 * @module workflows/exec/exec-unit
 */

import fs from "node:fs";
import path from "node:path";
import { isWithin } from "../../core/common";
import { collectAllowlistedEnv } from "../../core/spawn-env";
import { runManagedSubprocess, type SpawnFn } from "../../core/subprocess";
import type { IrExecSpec } from "../ir/schema";
import type { UnitDispatchResult } from "./unit-dispatch";

/** Max characters of a failed command's stderr retained in the unit's `error` diagnostic. */
export const EXEC_STDERR_DIAGNOSTIC_CLIP = 2_000;

/**
 * The DEFAULT environment allowlist for an exec unit's child — the single
 * definition, mirrored nowhere else (the docs describe it, the tests assert
 * against it, and `exec.passEnv` extends it per unit).
 *
 * The child starts from an EMPTY environment and receives only these names,
 * matching how an agent harness child is already built
 * (`profile.envPassthrough` → `collectAllowlistedEnv`). Every entry earns its
 * place by being load-bearing for ordinary commands on some supported
 * platform:
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
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "TMPDIR",
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
  "AKM_EVENT_SOURCE",
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
   * declared inputs). Applied LAST so a binding can never shadow it.
   */
  context?: Record<string, string>;
  /** Resolved wall-clock budget; `null` = the author's explicit `timeout: none`. */
  timeoutMs: number | null;
  signal?: AbortSignal;
  /** Test seam: injected spawn (defaults to the runtime spawn inside `runManagedSubprocess`). */
  spawnFn?: SpawnFn;
}

/**
 * Run one exec unit and map its process outcome onto the dispatch vocabulary.
 *
 * Failure-reason mapping (all values are pre-existing `AgentFailureReason`
 * members — the taxonomy gains nothing, so `retry.on` keeps working unchanged
 * and `tests/integration/workflows/schema-drift.test.ts` stays green):
 *
 *   - non-zero exit          → `non_zero_exit`
 *   - wall-clock expiry      → `timeout`   (after the TERM→KILL ladder)
 *   - cancellation           → `aborted`
 *   - the child never started → `spawn_failed` (missing binary, unusable cwd)
 *
 * The out-of-taxonomy `exec_cwd_escape` is deliberate: a `cwd` that resolves
 * outside its base is tampering or an authoring bug, never a transient, so no
 * `retry.on` value can ever re-dispatch it.
 */
export async function runExecUnit(input: RunExecUnitInput): Promise<UnitDispatchResult> {
  const cwd = resolveExecCwd(input);
  if (!cwd.ok) return { ok: false, text: "", failureReason: cwd.failureReason, error: cwd.error };

  const result = await runManagedSubprocess([...input.exec.command], {
    capture: true,
    cwd: cwd.path,
    env: childEnv(input.exec, input.env, input.context),
    timeoutMs: input.timeoutMs,
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
  // Abort is checked BEFORE timeout: a budget/user cancellation that raced a
  // wall-clock expiry is still a cancellation, and reporting it as `timeout`
  // would let a `retry.on: [timeout]` policy re-dispatch work the caller just
  // cancelled.
  if (result.aborted) {
    return {
      ok: false,
      text: result.stdout,
      failureReason: "aborted",
      error: `exec unit "${input.unitId}" was cancelled while running ${display}${stderrTail(result.stderr)}`,
    };
  }
  if (result.timedOut) {
    return {
      ok: false,
      text: result.stdout,
      failureReason: "timeout",
      error:
        `exec unit "${input.unitId}" exceeded its ${input.timeoutMs}ms timeout running ${display} ` +
        `and its process group was terminated${stderrTail(result.stderr)}`,
    };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      text: result.stdout,
      failureReason: "non_zero_exit",
      error: `exec unit "${input.unitId}" ran ${display} and it exited ${result.exitCode}${stderrTail(result.stderr)}`,
    };
  }
  // The promoted artifact is STDOUT. Trailing newlines are stripped, exactly
  // like shell command substitution `$(…)`, so a one-line command's artifact is
  // the value an author expects rather than the value plus a `\n`. stderr is a
  // diagnostic channel only and never contributes to the artifact.
  return { ok: true, text: stripTrailingNewlines(result.stdout) };
}

type ResolvedCwd = { ok: true; path: string } | { ok: false; failureReason: string; error: string };

/**
 * Resolve `exec.cwd` inside `baseDir` and prove containment against the
 * RESOLVED base (symlinks included). The syntactic checks the parser and the
 * decoder already ran are necessary but not sufficient: `reports` can be a
 * symlink to `/etc`, and only a realpath comparison catches that.
 */
function resolveExecCwd(input: RunExecUnitInput): ResolvedCwd {
  const base = path.resolve(input.baseDir);
  const target = input.exec.cwd ? path.resolve(base, input.exec.cwd) : base;
  if (!isWithin(target, base)) {
    return {
      ok: false,
      failureReason: "exec_cwd_escape",
      error:
        `exec unit "${input.unitId}" declares cwd ${JSON.stringify(input.exec.cwd ?? ".")}, which resolves to ` +
        `${target} — outside its working directory ${base}. Refusing to run outside the unit's tree.`,
    };
  }
  if (!isExistingDirectory(target)) {
    return {
      ok: false,
      failureReason: "spawn_failed",
      error: `exec unit "${input.unitId}" cannot run: its working directory ${target} does not exist or is not a directory.`,
    };
  }
  return { ok: true, path: target };
}

function isExistingDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
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
 * `inheritEnv` is the honest escape hatch for a command that genuinely needs
 * the caller's whole environment; it passes it through VERBATIM (no PATH
 * supplementation), which is precisely the pre-allowlist behavior.
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

/** The akm process's own environment, verbatim (`exec.inheritEnv`). */
function inheritedProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[name] = value;
  }
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
export function stripTrailingNewlines(text: string): string {
  return text.replace(/(?:\r?\n)+$/, "");
}
