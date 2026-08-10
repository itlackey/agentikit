/**
 * Tests for `supplementPathForSchedulerContext` in `core/spawn-env` — the PATH
 * repair every allowlisted-child spawn path shares (agent CLI, workflow `exec`).
 *
 * Verifies that:
 *   • PATH containing the user home directory is returned unchanged (interactive shell).
 *   • Stripped PATH (no home dir) is supplemented with candidates that exist on disk.
 *   • Candidates that do not exist on disk are not added.
 *   • Empty PATH receives only candidates that exist.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  COMMON_SPAWN_ENV_PASSTHROUGH,
  spawnEnvNamesFor,
  supplementPathForSchedulerContext,
} from "../../src/core/spawn-env";

const home = os.homedir();

describe("supplementPathForSchedulerContext", () => {
  test("returns PATH unchanged when it contains the home directory (interactive shell)", () => {
    const interactivePath = [path.join(home, ".bun", "bin"), "/usr/bin", "/bin"].join(path.delimiter);
    const result = supplementPathForSchedulerContext(interactivePath);
    expect(result).toBe(interactivePath);
  });

  test("returns PATH unchanged when a sub-path of home appears (e.g. ~/.cargo/bin already present)", () => {
    const withHome = [path.join(home, ".cargo", "bin"), "/usr/bin"].join(path.delimiter);
    const result = supplementPathForSchedulerContext(withHome);
    expect(result).toBe(withHome);
  });

  test("prepends existing candidate dirs when PATH is stripped (no home dir)", () => {
    // Use a PATH that definitely has no home-dir segment.
    const strippedPath = "/usr/bin:/bin";
    const result = supplementPathForSchedulerContext(strippedPath);
    // The result must still end with the original stripped PATH.
    expect(result.endsWith(strippedPath)).toBe(true);
    // Each prepended segment must be a real directory (the function only adds existing dirs).
    const prepended = result.slice(0, result.length - strippedPath.length).replace(/:$/, "");
    if (prepended.length > 0) {
      for (const segment of prepended.split(path.delimiter).filter(Boolean)) {
        // Every prepended segment must be one of the known candidates.
        const isKnownCandidate = [
          path.join(home, ".bun", "bin"),
          path.join(home, ".cargo", "bin"),
          path.join(home, ".local", "bin"),
          "/opt/homebrew/bin",
          "/opt/homebrew/sbin",
          "/usr/local/bin",
        ].includes(segment);
        expect(isKnownCandidate).toBe(true);
      }
    }
  });

  test("does not duplicate entries already present in a stripped PATH", () => {
    // /usr/local/bin is a candidate — if it's already in PATH it must not be added twice.
    const withLocalBin = "/usr/local/bin:/usr/bin:/bin";
    const result = supplementPathForSchedulerContext(withLocalBin);
    const segments = result.split(path.delimiter);
    const count = segments.filter((s) => s === "/usr/local/bin").length;
    expect(count).toBe(1);
  });

  test("only adds candidate dirs that exist on disk (stripped PATH case)", () => {
    // The function only prepends directories that fs.existsSync returns true for.
    // Verify all added segments are real existing directories.
    const strippedPath = "/usr/bin:/bin";
    const result = supplementPathForSchedulerContext(strippedPath);
    const added = result
      .split(path.delimiter)
      .filter((s) => !strippedPath.split(path.delimiter).includes(s))
      .filter(Boolean);
    for (const dir of added) {
      expect(existsSync(dir)).toBe(true);
    }
  });

  test("handles empty PATH string without throwing", () => {
    const result = supplementPathForSchedulerContext("");
    // Result should be either empty or contain only real directories.
    const segments = result.split(path.delimiter).filter(Boolean);
    for (const seg of segments) {
      expect(existsSync(seg)).toBe(true);
    }
  });

  test("a sibling dir that merely string-prefixes home does not read as interactive", () => {
    // `/home/al` must not be satisfied by `/home/alice/...`: the home check is
    // a path-boundary comparison, so this PATH is as stripped as one naming no
    // home at all and must be supplemented identically.
    const stripped = ["/usr/bin", "/bin"].join(path.delimiter);
    const sibling = [`${home}kit`, "/usr/bin", "/bin"].join(path.delimiter);
    const prefixOf = (result: string, original: string): string => result.slice(0, result.length - original.length);

    const supplementedResult = supplementPathForSchedulerContext(stripped);
    const siblingResult = supplementPathForSchedulerContext(sibling);

    expect(siblingResult.endsWith(sibling)).toBe(true);
    expect(prefixOf(siblingResult, sibling)).toBe(prefixOf(supplementedResult, stripped));
    // Non-vacuous wherever any candidate dir exists: the sibling PATH gets the
    // same repair the stripped one does, rather than being skipped.
    expect(siblingResult === sibling).toBe(supplementedResult === stripped);
  });
});

describe("spawnEnvNamesFor", () => {
  test("passes the caller's allowlist through unchanged off win32", () => {
    expect(spawnEnvNamesFor(["PATH", "HOME"], "linux")).toEqual(["PATH", "HOME"]);
    expect(spawnEnvNamesFor(["PATH", "HOME"], "darwin")).toEqual(["PATH", "HOME"]);
  });

  test("adds the win32 process-creation floor to any allowlist", () => {
    // The agent-CLI baseline carries none of these, yet a Windows child cannot
    // be created (SystemRoot) or resolve its command (PATHEXT) without them.
    const names = spawnEnvNamesFor(COMMON_SPAWN_ENV_PASSTHROUGH, "win32");
    for (const required of ["SystemRoot", "SystemDrive", "WINDIR", "COMSPEC", "PATHEXT"]) {
      expect(names).toContain(required);
    }
    // The caller's own names survive.
    for (const name of COMMON_SPAWN_ENV_PASSTHROUGH) {
      expect(names).toContain(name);
    }
  });

  test("does not re-add a floor name the caller already spells, in any case", () => {
    const names = spawnEnvNamesFor(["PATH", "SYSTEMROOT"], "win32");
    const systemRootSpellings = names.filter((name) => name.toUpperCase() === "SYSTEMROOT");
    expect(systemRootSpellings).toEqual(["SYSTEMROOT"]);
  });

  test("leaves config and install roots to the caller", () => {
    // Deliberately not a floor: a child is creatable without them.
    const names = spawnEnvNamesFor(["PATH"], "win32");
    expect(names).not.toContain("APPDATA");
    expect(names).not.toContain("ProgramFiles");
  });
});
