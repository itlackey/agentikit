// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The ONE allowlist-based child-environment primitive.
 *
 * Two akm code paths spawn a child from an explicit list of environment
 * variable NAMES — the agent-CLI spawn wrapper
 * (`integrations/agent/spawn.ts`, `profile.envPassthrough`) and the workflow
 * `exec` unit runner (`workflows/exec/exec-unit.ts`) — and both start from an
 * EMPTY environment and copy through named entries with
 * {@link collectAllowlistedEnv}. Keeping that in one leaf module is what makes
 * "allowlist" a single reviewable mechanism instead of two implementations
 * that drift apart.
 *
 * NOT covered: the opencode-sdk server spawn
 * (`integrations/harnesses/opencode-sdk/sdk-runner.ts`) keeps its own
 * hard-coded name list and does not route through here, so it gets neither the
 * platform floor below nor PATH supplementation.
 *
 * A LEAF: node built-ins only, so both the integrations layer and the workflow
 * engine can import it without opening a cycle.
 *
 * @module core/spawn-env
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The baseline env names every allowlisted akm child receives regardless of
 * what it runs: process identity (`HOME`, `USER`), tool resolution (`PATH`),
 * locale (`LANG`, `LC_ALL`), terminal (`TERM`), scratch space (`TMPDIR`), and
 * akm's own event provenance (`AKM_EVENT_SOURCE` — machine traffic, never a
 * secret). BOTH allowlists extend it — the agent-CLI profiles'
 * `COMMON_PASSTHROUGH` (`integrations/agent/profiles.ts`) and the workflow
 * exec unit's `EXEC_DEFAULT_ENV_PASSTHROUGH` (`workflows/exec/exec-unit.ts`)
 * — so a baseline name cannot drift into one child-spawn path but not the
 * other. NOTE: profile `envPassthrough` is frozen into workflow engine
 * snapshots, so growing this list changes frozen-plan content — extend
 * deliberately.
 */
export const COMMON_SPAWN_ENV_PASSTHROUGH = [
  "HOME",
  "PATH",
  "USER",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "AKM_EVENT_SOURCE",
] as const;

/**
 * The names Windows itself requires of ANY child, whatever the caller's
 * allowlist says. Applied at build time rather than added to
 * {@link COMMON_SPAWN_ENV_PASSTHROUGH} because profile `envPassthrough` is
 * frozen into workflow engine snapshots: growing the shared list would change
 * the bytes — and so the hashes — of every plan already on disk, to express
 * something that is not a policy choice at all.
 *
 * `SystemRoot`, `SystemDrive` and `WINDIR` are what PROCESS CREATION reads;
 * without them the loader cannot find system DLLs and the spawn fails before
 * the command runs. Without `PATHEXT` Windows never tries `bun.exe`/`bun.cmd`,
 * so a `bin: "bun"` profile is unresolvable, and `COMSPEC` is how `.bat`/`.cmd`
 * targets resolve at all. The rest are the win32 analogues of baseline names
 * the POSIX side already grants — `HOME` (`USERPROFILE`, `HOMEDRIVE`,
 * `HOMEPATH`) and `TMPDIR` (`TEMP`, `TMP`). None is a secret.
 *
 * Config and install roots (`APPDATA`, `LOCALAPPDATA`, `ProgramFiles`, …) are
 * deliberately NOT here: a child can be created and can resolve its command
 * without them, so which allowlist wants them stays a per-caller decision.
 */
const WIN32_SPAWN_ENV_FLOOR = [
  "SystemRoot",
  "SystemDrive",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "TEMP",
  "TMP",
] as const;

/**
 * The effective allowlist for `platform`: the caller's names, plus any floor
 * the operating system requires of every child regardless of allowlist.
 * Exported for tests, which must be able to ask for a platform they are not
 * running on.
 */
export function spawnEnvNamesFor(names: Iterable<string>, platform: string = process.platform): string[] {
  const effective = [...names];
  if (platform !== "win32") return effective;
  // Windows env names are case-insensitive; dedupe that way so a caller
  // spelling `SYSTEMROOT` does not also receive `SystemRoot`.
  const present = new Set(effective.map((name) => name.toUpperCase()));
  for (const name of WIN32_SPAWN_ENV_FLOOR) {
    if (!present.has(name.toUpperCase())) effective.push(name);
  }
  return effective;
}

/**
 * Build a child environment from an allowlist: start EMPTY and copy through
 * exactly the named variables that exist in `source`. Names absent from the
 * source are simply absent from the child (never an empty string, which many
 * tools treat as "set but blank").
 *
 * `PATH`, when it comes through, is supplemented for scheduler contexts — see
 * {@link supplementPathForSchedulerContext}. That happens here rather than in
 * each caller so a child spawned from cron/launchd/Task Scheduler can find the
 * user's toolchain no matter which spawn path reached it. On win32 the names
 * in {@link WIN32_SPAWN_ENV_FLOOR} come through too, for the same reason: the
 * spawn cannot succeed without them, whichever caller built the list.
 */
export function collectAllowlistedEnv(
  names: Iterable<string>,
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of spawnEnvNamesFor(names)) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  if (env.PATH !== undefined) {
    env.PATH = supplementPathForSchedulerContext(env.PATH);
  }
  return env;
}

/**
 * Supplement `existingPath` with well-known user binary directories when
 * running in a scheduler context (cron/launchd) where PATH is stripped.
 *
 * Detection heuristic: if the current PATH does not contain the user's home
 * directory, we are likely in a stripped scheduler env. In an interactive
 * shell the user's home almost always appears (e.g. ~/.bun/bin, ~/.cargo/bin).
 *
 * Only directories that actually exist on disk are prepended, and only if
 * they are not already present, so interactive-shell PATH ordering is never
 * disturbed.
 */
export function supplementPathForSchedulerContext(existingPath: string): string {
  const home = os.homedir();
  // A home of `/` (system crontab, launchd, service accounts) or of `""`
  // prefixes EVERY entry, so a prefix test would read the most stripped
  // environments there are as interactive and skip the repair they exist for.
  const comparableHome = home === "" || home === path.sep ? undefined : home;
  // If PATH already contains the home directory, we are in an interactive
  // shell — skip supplementation entirely. Compared on a path boundary: a
  // sibling home (`/home/alice` next to `/home/al`) is not this user's.
  const isUnderHome = (dir: string): boolean =>
    comparableHome !== undefined && (dir === comparableHome || dir.startsWith(comparableHome + path.sep));
  if (existingPath.split(path.delimiter).some(isUnderHome)) {
    return existingPath;
  }
  const candidates = pathCandidatesForCurrentPlatform(home);
  const existing = new Set(existingPath.split(path.delimiter).filter(Boolean));
  const toAdd = candidates.filter((d) => !existing.has(d) && fs.existsSync(d));
  if (toAdd.length === 0) return existingPath;
  return [...toAdd, existingPath].filter(Boolean).join(path.delimiter);
}

function pathCandidatesForCurrentPlatform(home: string): string[] {
  if (process.platform === "win32") {
    // Windows: Bun + Cargo + Scoop + Chocolatey + system tools. Order favors
    // user-local installs over machine-global so the user's chosen toolchain
    // wins. These paths are commonly stripped from Task Scheduler / service
    // environments, mirroring the cron/launchd problem on POSIX.
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    const userProfile = process.env.USERPROFILE ?? home;
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    return [
      path.join(userProfile, ".bun", "bin"),
      path.join(localAppData, "Programs", "bun"),
      path.join(userProfile, ".cargo", "bin"),
      path.join(localAppData, "Programs", "Git", "cmd"),
      path.join(userProfile, "scoop", "shims"),
      path.join(programFiles, "Git", "cmd"),
      "C:\\ProgramData\\chocolatey\\bin",
    ];
  }
  return [
    path.join(home, ".bun", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
  ];
}
