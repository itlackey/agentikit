// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Parent-death watchdog (#9543 addendum).
 *
 * The published launcher (`scripts/node-runtime/akm`) now forwards SIGTERM to
 * its child, so a `kill <launcher-pid>` no longer orphans it — but a launcher
 * that dies WITHOUT delivering a signal (SIGKILL, an out-of-memory kill, a
 * supervisor that force-removes the process) still reparents the child to
 * init with nothing to catch. Field evidence: 40 orphaned
 * `bun …/dist/cli.js` processes over one day, up to 10h old, some created by
 * a curate hook killing its own launcher on timeout — every akm invocation
 * under the launcher is exposed to this, not only `akm index`, so this
 * watchdog runs for every command (wired at the CLI entry point in
 * `src/cli.ts`), not just index.
 *
 * `process.ppid` on POSIX changes the instant the parent exits (the child is
 * reparented, usually to pid 1) — polling it is the standard orphan-detection
 * trick when no direct death notification exists. This module owns only the
 * poll/compare mechanics; the caller's `onOrphaned` decides what "stop"
 * means. `src/cli.ts` wires it to `process.kill(process.pid, "SIGTERM")` so
 * every command reuses the exact same shutdown path a real SIGTERM already
 * takes (`akm index`'s own AbortController, `exit` handlers for lock
 * release elsewhere) instead of a second, parallel one.
 */

/** Pure comparison seam: true once the observed ppid differs from the one seen at startup. */
export function isReparented(initialPpid: number, currentPpid: number): boolean {
  return currentPpid !== initialPpid;
}

export interface ParentDeathWatchdogOptions {
  /** The parent pid observed when the watchdog starts — compared against later polls. */
  initialPpid: number;
  /** Invoked at most once, the first time a poll observes a changed ppid. */
  onOrphaned: () => void;
  /** Poll interval in ms. Default 2000. */
  intervalMs?: number;
  /** Reads the current ppid. Defaults to `() => process.ppid` — injectable for tests. */
  getPpid?: () => number;
  /** `setInterval` shim. Defaults to the global. Tests pass a synchronous driver. */
  setIntervalFn?: typeof setInterval;
  /** `clearInterval` shim. Defaults to the global. */
  clearIntervalFn?: typeof clearInterval;
}

export interface ParentDeathWatchdog {
  /** Stop polling. Idempotent. */
  stop(): void;
}

/**
 * Start polling `getPpid()` every `intervalMs` and invoke `onOrphaned` once,
 * the first time the observed ppid no longer matches `initialPpid`. The timer
 * is unref'ed so it never keeps the process alive on its own — a command that
 * finishes normally still exits promptly.
 */
export function startParentDeathWatchdog(options: ParentDeathWatchdogOptions): ParentDeathWatchdog {
  const { initialPpid, onOrphaned } = options;
  const intervalMs = options.intervalMs ?? 2000;
  const getPpid = options.getPpid ?? (() => process.ppid);
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;

  let fired = false;
  const timer = setIntervalFn(() => {
    if (fired) return;
    if (isReparented(initialPpid, getPpid())) {
      fired = true;
      onOrphaned();
    }
  }, intervalMs);
  if (typeof timer !== "number") timer.unref?.();

  return {
    stop: () => clearIntervalFn(timer),
  };
}
