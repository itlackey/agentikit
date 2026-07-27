// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Regression tests for F1/R-058: `akm update` could `rm -rf` a previous
 * install directory with NO confirmation gate and NO `--yes` flag at all,
 * while `akm remove` already refused in non-interactive mode without
 * `--yes`. The asymmetry: `updateManagedInstall` (installed-stashes.ts)
 * deletes `managed.localRoot` via `cleanupDirectoryBestEffort` whenever the
 * resolved content directory (`synced.contentDir`) differs from it, the
 * source isn't "local", and the install isn't writable.
 *
 * The fix gates ONLY that branch with `confirmDestructive` (same helper
 * `remove` uses) and a new `-y/--yes` flag threaded through `akmUpdate`. A
 * normal refresh — the overwhelming majority of `akm update` invocations,
 * where the resolved content directory does NOT move — must stay completely
 * unaffected: no prompt, no flag required, unchanged exit code. These tests
 * pin BOTH halves: the gated destructive path AND the untouched normal path.
 */

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmUpdate } from "../../src/commands/sources/installed-stashes";
import { saveConfig } from "../../src/core/config/config";
import { mergeLockEntriesSync, readLockfile } from "../../src/integrations/lockfile";
import * as syncFromRefModule from "../../src/sources/providers/sync-from-ref";

const createdTmpDirs: string[] = [];

function createTmpDir(prefix = "akm-update-confirm-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

function makeStashDir(base: string): void {
  for (const sub of ["skills", "commands", "agents", "knowledge", "scripts"]) {
    fs.mkdirSync(path.join(base, sub), { recursive: true });
  }
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// ── stdin.isTTY override (matches tests/confirm-destructive.test.ts) ──────────
function withTTY<T>(isTTY: boolean, fn: () => Promise<T>): Promise<T> {
  const original = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { value: isTTY, configurable: true });
  return fn().finally(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: original, configurable: true });
  });
}

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalXdgStateHome = process.env.XDG_STATE_HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalStashDir = process.env.AKM_STASH_DIR;
let testCacheDir = "";
let testConfigDir = "";
let testDataDir = "";
let testStateDir = "";
let stashDir = "";

beforeEach(() => {
  testCacheDir = createTmpDir("akm-update-confirm-cache-");
  testConfigDir = createTmpDir("akm-update-confirm-config-");
  testDataDir = createTmpDir("akm-update-confirm-data-");
  testStateDir = createTmpDir("akm-update-confirm-state-");
  stashDir = createTmpDir("akm-update-confirm-stash-");
  makeStashDir(stashDir);
  process.env.XDG_CACHE_HOME = testCacheDir;
  process.env.XDG_CONFIG_HOME = testConfigDir;
  process.env.XDG_DATA_HOME = testDataDir;
  process.env.XDG_STATE_HOME = testStateDir;
  process.env.AKM_STASH_DIR = stashDir;
});

afterEach(() => {
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;

  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;

  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdgDataHome;

  if (originalXdgStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = originalXdgStateHome;

  if (originalStashDir === undefined) delete process.env.AKM_STASH_DIR;
  else process.env.AKM_STASH_DIR = originalStashDir;
});

/** Configure a non-local, non-writable managed bundle whose lock localRoot is `oldRoot`. */
function configureManagedBundle(id: string, oldRoot: string): void {
  saveConfig({
    semanticSearchMode: "off",
    bundles: {
      [id]: { npm: id },
    },
  });
  mergeLockEntriesSync([
    {
      id,
      source: "npm",
      ref: `npm:${id}`,
      localRoot: oldRoot,
      installedAt: "2026-04-22T16:39:07.564Z",
    },
  ]);
}

describe("akm update — destructive-branch confirmation gate (F1/R-058)", () => {
  test("resolved content dir MOVES, non-interactive, no --yes: BLOCKED, old root untouched", async () => {
    const oldRoot = createTmpDir("akm-update-confirm-old-");
    const newRoot = createTmpDir("akm-update-confirm-new-");
    fs.writeFileSync(path.join(oldRoot, "marker.txt"), "old content");
    configureManagedBundle("left-pad", oldRoot);

    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockResolvedValue({
      id: "left-pad",
      source: "npm",
      ref: "npm:left-pad",
      artifactUrl: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      resolvedVersion: "1.3.0",
      contentDir: newRoot,
      cacheDir: testCacheDir,
      extractedDir: newRoot,
      integrity: "sha512-fake",
      syncedAt: new Date().toISOString(),
      writable: false,
    });

    try {
      await withTTY(false, async () => {
        await expect(akmUpdate({ target: "left-pad", stashDir })).rejects.toMatchObject({
          code: "NON_INTERACTIVE_REQUIRES_YES",
        });
      });
    } finally {
      syncSpy.mockRestore();
    }

    // The gate must fire BEFORE cleanup: the old directory is still there.
    expect(fs.existsSync(path.join(oldRoot, "marker.txt"))).toBe(true);
  });

  test("resolved content dir MOVES, --yes passed: proceeds and deletes the old root", async () => {
    const oldRoot = createTmpDir("akm-update-confirm-old-");
    const newRoot = createTmpDir("akm-update-confirm-new-");
    fs.writeFileSync(path.join(oldRoot, "marker.txt"), "old content");
    configureManagedBundle("left-pad", oldRoot);

    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockResolvedValue({
      id: "left-pad",
      source: "npm",
      ref: "npm:left-pad",
      artifactUrl: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      resolvedVersion: "1.3.0",
      contentDir: newRoot,
      cacheDir: testCacheDir,
      extractedDir: newRoot,
      integrity: "sha512-fake",
      syncedAt: new Date().toISOString(),
      writable: false,
    });

    let result: Awaited<ReturnType<typeof akmUpdate>>;
    try {
      result = await withTTY(false, () => akmUpdate({ target: "left-pad", stashDir, yes: true }));
    } finally {
      syncSpy.mockRestore();
    }

    expect(result.processed).toHaveLength(1);
    expect(readLockfile().find((e) => e.id === "left-pad")?.localRoot).toBe(newRoot);
    // The confirmed deletion actually ran.
    expect(fs.existsSync(oldRoot)).toBe(false);
  });

  test("normal refresh (resolved content dir UNCHANGED) needs no --yes and prompts nothing", async () => {
    const root = createTmpDir("akm-update-confirm-stable-");
    fs.writeFileSync(path.join(root, "marker.txt"), "stable content");
    configureManagedBundle("left-pad", root);

    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockResolvedValue({
      id: "left-pad",
      source: "npm",
      ref: "npm:left-pad",
      artifactUrl: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      resolvedVersion: "1.3.0",
      contentDir: root,
      cacheDir: testCacheDir,
      extractedDir: root,
      integrity: "sha512-fake",
      syncedAt: new Date().toISOString(),
      writable: false,
    });

    let result: Awaited<ReturnType<typeof akmUpdate>>;
    try {
      // Non-interactive AND no --yes: must NOT throw, because the
      // destructive branch is never reached (contentDir === localRoot).
      result = await withTTY(false, () => akmUpdate({ target: "left-pad", stashDir }));
    } finally {
      syncSpy.mockRestore();
    }

    expect(result.processed).toHaveLength(1);
    expect(result.processed[0]?.changed.version).toBe(true);
    // The (only) directory in play was never touched by any cleanup path.
    expect(fs.existsSync(path.join(root, "marker.txt"))).toBe(true);
  });
});
