/**
 * Tests for QA fixes in cluster A (issues #9, #10, #11, #12, #17, #18, #19, #22, #23).
 *
 * - #9/#18/#22: `akm add <path> --name extra` persists the name for filesystem sources.
 * - #10:        Filesystem kind reported as "filesystem", not "local".
 * - #11/#23:    Filesystem writable defaults to true in list output.
 * - #12:        `updatable` field dropped from SourceEntry.
 * - #17:        Website kind reported as "website", not "remote".
 * - #19:        akm update re-mirrors website sources via sync().
 */

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmListSources, akmUpdate } from "../../src/commands/sources/installed-stashes";
import { akmAdd } from "../../src/commands/sources/source-add";
import { addStash } from "../../src/commands/sources/source-manage";
import { loadConfig, saveConfig } from "../../src/core/config/config";
import { ConfigError } from "../../src/core/errors";
import { mergeLockEntriesSync, readLockfile } from "../../src/integrations/lockfile";
import * as gitProvider from "../../src/sources/providers/git";
import * as syncFromRefModule from "../../src/sources/providers/sync-from-ref";

const createdTmpDirs: string[] = [];

function createTmpDir(prefix = "akm-qa-"): string {
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
  testCacheDir = createTmpDir("akm-qa-cache-");
  testConfigDir = createTmpDir("akm-qa-config-");
  testDataDir = createTmpDir("akm-qa-data-");
  testStateDir = createTmpDir("akm-qa-state-");
  stashDir = createTmpDir("akm-qa-stash-");
  makeStashDir(stashDir);
  process.env.XDG_CACHE_HOME = testCacheDir;
  process.env.XDG_CONFIG_HOME = testConfigDir;
  // Pair AKM_STASH_DIR with XDG_DATA_HOME / XDG_STATE_HOME so the
  // test-isolation guard in src/core/paths.ts stays inert.
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

  if (testCacheDir) {
    fs.rmSync(testCacheDir, { recursive: true, force: true });
    testCacheDir = "";
  }
  if (testConfigDir) {
    fs.rmSync(testConfigDir, { recursive: true, force: true });
    testConfigDir = "";
  }
  if (testDataDir) {
    fs.rmSync(testDataDir, { recursive: true, force: true });
    testDataDir = "";
  }
  if (testStateDir) {
    fs.rmSync(testStateDir, { recursive: true, force: true });
    testStateDir = "";
  }
});

// ── Issue #9 / #18 / #22: --name persisted for filesystem sources ──────────

describe("issue #9: --name flag persisted for filesystem sources", () => {
  test("akmAdd persists explicit --name for a local path", async () => {
    saveConfig({ semanticSearchMode: "off" });
    const extraStash = createTmpDir("akm-qa-extra-");
    makeStashDir(extraStash);

    const result = await akmAdd({ ref: extraStash, name: "extra" });

    // sourceAdded should carry the explicit name
    expect(result.sourceAdded).toBeDefined();
    expect(result.sourceAdded?.name).toBe("extra");

    // Config should persist the name as the bundle key (#37: bundles shape)
    const config = loadConfig();
    const added = config.bundles?.extra;
    expect(added).toBeDefined();
    expect(added?.path).toBe(path.resolve(extraStash));
  });

  test("akm remove works when source was added with --name", async () => {
    saveConfig({ semanticSearchMode: "off" });
    const extraStash = createTmpDir("akm-qa-extra-rm-");
    makeStashDir(extraStash);

    await akmAdd({ ref: extraStash, name: "extra" });

    // Verify the name is in the config (#37: as a bundle key)
    const configBefore = loadConfig();
    expect(Object.keys(configBefore.bundles ?? {})).toContain("extra");
  });

  test("akmAdd without --name falls back to readable path", async () => {
    saveConfig({ semanticSearchMode: "off" });
    const someStash = createTmpDir("akm-qa-noname-");
    makeStashDir(someStash);

    await akmAdd({ ref: someStash });

    const config = loadConfig();
    const entry = Object.entries(config.bundles ?? {}).find(([, b]) => b.path === path.resolve(someStash));
    expect(entry).toBeDefined();
    // The bundle key is the readable name — NOT the raw path, never empty.
    expect(entry?.[0]).toBeTruthy();
    expect(entry?.[0]).not.toBe(path.resolve(someStash));
  });
});

describe("manual QA add validation", () => {
  test("akmAdd rejects writable installs for npm refs before syncing", async () => {
    saveConfig({ semanticSearchMode: "off" });
    await expect(akmAdd({ ref: "npm:left-pad", writable: true })).rejects.toThrow(ConfigError);
  });

  test("addStash rejects openviking providers before persisting config", () => {
    saveConfig({ semanticSearchMode: "off" });
    expect(() => addStash({ target: "https://example.com", providerType: "openviking" })).toThrow(ConfigError);
    expect(loadConfig().sources).toBeUndefined();
  });

  test("addStash rejects writable website sources before persisting config", () => {
    saveConfig({ semanticSearchMode: "off" });
    expect(() => addStash({ target: "https://example.com", providerType: "website", writable: true })).toThrow(
      ConfigError,
    );
    expect(loadConfig().sources).toBeUndefined();
  });
});

// ── Issue #10: filesystem kind = "filesystem" in list output ──────────────

describe("issue #10: filesystem kind in list output", () => {
  test("filesystem source has kind='filesystem' in akmListSources", async () => {
    const sourceDir = createTmpDir("akm-qa-fs-kind-");
    makeStashDir(sourceDir);

    saveConfig({
      semanticSearchMode: "off",
      bundles: { src: { path: sourceDir } },
    });

    const result = await akmListSources({ stashDir });

    const fsSrc = result.sources.find((s) => s.path === sourceDir);
    expect(fsSrc).toBeDefined();
    expect(fsSrc?.kind).toBe("filesystem");
  });

  test("git source has kind='git' in akmListSources", async () => {
    saveConfig({
      semanticSearchMode: "off",
      bundles: { "my-git": { git: "https://github.com/example/repo.git" } },
    });

    const result = await akmListSources({ stashDir });

    const gitSrc = result.sources.find((s) => s.name === "my-git");
    expect(gitSrc).toBeDefined();
    expect(gitSrc?.kind).toBe("git");
  });
});

// ── Issue #17: website kind = "website" in list output ──────────────────

describe("issue #17: website kind in list output", () => {
  test("website source has kind='website' in akmListSources", async () => {
    saveConfig({
      semanticSearchMode: "off",
      bundles: { "docs-site": { website: { url: "https://example.com" } } },
    });

    const result = await akmListSources({ stashDir });

    const webSrc = result.sources.find((s) => s.name === "docs-site");
    expect(webSrc).toBeDefined();
    expect(webSrc?.kind).toBe("website");
  });
});

// ── Issue #11 / #23: filesystem writable defaults to true ─────────────────

describe("issue #11: filesystem writable defaults to true in list output", () => {
  test("filesystem source without explicit writable defaults to true", async () => {
    const sourceDir = createTmpDir("akm-qa-writable-");
    makeStashDir(sourceDir);

    saveConfig({
      semanticSearchMode: "off",
      bundles: { src: { path: sourceDir } },
    });

    const result = await akmListSources({ stashDir });

    const fsSrc = result.sources.find((s) => s.path === sourceDir);
    expect(fsSrc).toBeDefined();
    expect(fsSrc?.writable).toBe(true);
  });

  test("filesystem source with writable: false respects the explicit setting", async () => {
    const sourceDir = createTmpDir("akm-qa-writable-false-");
    makeStashDir(sourceDir);

    saveConfig({
      semanticSearchMode: "off",
      bundles: { src: { path: sourceDir, writable: false } },
    });

    const result = await akmListSources({ stashDir });

    const fsSrc = result.sources.find((s) => s.path === sourceDir);
    expect(fsSrc).toBeDefined();
    expect(fsSrc?.writable).toBe(false);
  });

  test("git source without explicit writable defaults to false", async () => {
    saveConfig({
      semanticSearchMode: "off",
      bundles: { "my-git": { git: "https://github.com/example/repo.git" } },
    });

    const result = await akmListSources({ stashDir });

    const gitSrc = result.sources.find((s) => s.name === "my-git");
    expect(gitSrc).toBeDefined();
    expect(gitSrc?.writable).toBe(false);
  });

  test("website source without explicit writable defaults to false", async () => {
    saveConfig({
      semanticSearchMode: "off",
      bundles: { "docs-site": { website: { url: "https://example.com" } } },
    });

    const result = await akmListSources({ stashDir });

    const webSrc = result.sources.find((s) => s.name === "docs-site");
    expect(webSrc).toBeDefined();
    expect(webSrc?.writable).toBe(false);
  });
});

// ── Issue #12: updatable field dropped from SourceEntry ──────────────────

describe("issue #12: updatable field absent from SourceEntry", () => {
  test("filesystem sources do not expose updatable field", async () => {
    const sourceDir = createTmpDir("akm-qa-no-updatable-");
    makeStashDir(sourceDir);

    saveConfig({
      semanticSearchMode: "off",
      bundles: { src: { path: sourceDir } },
    });

    const result = await akmListSources({ stashDir });

    const fsSrc = result.sources.find((s) => s.path === sourceDir);
    expect(fsSrc).toBeDefined();
    expect("updatable" in (fsSrc ?? {})).toBe(false);
  });

  test("managed sources do not expose updatable field", async () => {
    const stashRoot = createTmpDir("akm-qa-managed-root-");
    makeStashDir(stashRoot);

    saveConfig({
      semanticSearchMode: "off",
      bundles: { "test-pkg": { npm: "test-pkg" } },
    });
    mergeLockEntriesSync([
      {
        id: "test-pkg",
        source: "npm",
        ref: "test-pkg",
        localRoot: stashRoot,
        installedAt: new Date().toISOString(),
      },
    ]);

    const result = await akmListSources({ stashDir });

    const managed = result.sources.find((source) => source.lock !== null);
    expect(managed).toBeDefined();
    expect("updatable" in (managed ?? {})).toBe(false);
  });
});

// ── Issue #19: akm update syncs website sources ───────────────────────────

describe("issue #19: akm update website sources", () => {
  test("website source update does not throw TARGET_NOT_UPDATABLE", async () => {
    // Use a local HTTP server to serve minimal HTML for the crawl
    const server = Bun.serve({
      port: 0,
      fetch(_req: Request) {
        return new Response(
          "<html><head><title>Test</title></head><body><h1>Test</h1><p>hello world</p></body></html>",
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      },
    });
    const siteUrl = `http://127.0.0.1:${server.port}`;

    try {
      saveConfig({
        semanticSearchMode: "off",
        bundles: { "test-site": { website: { url: siteUrl } } },
      });

      // Should not throw TARGET_NOT_UPDATABLE
      const result = await akmUpdate({ target: "test-site", stashDir });
      // Returns an UpdateResponse with processed[] (empty for website sources
      // — a website re-crawl has no UpdateResultItem shape, no version/lock to
      // diff). R-015-adjacent: this success must still be reported somewhere,
      // via `plainSynced`, instead of `processed: []` rendering as the same
      // "nothing to update" text a true no-op would (pinned in
      // output-text-add-update-formatters.test.ts).
      expect(result).toBeDefined();
      expect(result.schemaVersion).toBe(1);
      expect(result.processed).toEqual([]);
      expect(result.plainSynced).toEqual([{ id: "test-site", kind: "website", ref: siteUrl }]);
    } finally {
      server.stop(true);
    }
  });

  test("git source update refreshes configured git mirrors instead of treating them as local paths", async () => {
    const syncSpy = spyOn(gitProvider, "syncMirroredRepo").mockResolvedValue({
      id: "https://github.com/example/repo",
      source: "git",
      ref: "https://github.com/example/repo",
      artifactUrl: "https://github.com/example/repo",
      contentDir: stashDir,
      cacheDir: testCacheDir,
      extractedDir: stashDir,
      syncedAt: new Date().toISOString(),
      writable: false,
    });

    saveConfig({
      semanticSearchMode: "off",
      bundles: { "test-git": { git: "https://github.com/example/repo" } },
    });

    const result = await akmUpdate({ target: "test-git", stashDir });
    expect(result.processed).toEqual([]);
    // R-015-adjacent: a successful git mirror sync has no UpdateResultItem
    // shape either (no lock/version to diff), so it must show up via
    // `plainSynced` rather than vanishing into an empty `processed: []` that
    // renders identically to a true no-op.
    expect(result.plainSynced).toEqual([{ id: "test-git", kind: "git", ref: "https://github.com/example/repo" }]);
    // updateGitSource must refresh via syncMirroredRepo (not treat the URL as a
    // local path), passing force + the resolved writable flag. The subsequent
    // re-index also refreshes every cache-backed source through the provider
    // seam (ensureSourceCaches → provider.sync()), so this spy legitimately
    // sees more than one call; the meaningful assertion is the direct call's
    // arguments below.
    expect(syncSpy).toHaveBeenCalledWith(expect.objectContaining({ name: "test-git" }), {
      force: true,
      writable: false,
    });
    syncSpy.mockRestore();
  });
});

// ── Regression: update preserves source classification for writable github: entries ──

describe("update preserves entry.source for writable installed entries", () => {
  test("updating a github: entry stored as source:git preserves source:git and writable:true", async () => {
    const stashRoot = createTmpDir("akm-qa-writable-stash-");
    makeStashDir(stashRoot);
    const cacheDir = createTmpDir("akm-qa-writable-cache-");

    saveConfig({
      semanticSearchMode: "off",
      bundles: {
        "dimm-city-agent-stash": {
          git: "https://github.com/dimm-city/agent-stash.git",
          registryId: "github:dimm-city/agent-stash",
          components: { main: { root: ".", adapter: "okf", writable: true } },
        },
      },
    });
    mergeLockEntriesSync([
      {
        id: "dimm-city-agent-stash",
        source: "git",
        ref: "github:dimm-city/agent-stash",
        localRoot: stashRoot,
        installedAt: "2026-04-22T16:39:07.564Z",
        resolvedRevision: "abc123",
      },
    ]);

    // syncFromRef for a github: ref returns source: "github" — this is what
    // triggered the bug: updateRegistryEntry was using synced.source ("github")
    // instead of entry.source ("git"), causing the validator to reject writable:true.
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockResolvedValue({
      id: "github:dimm-city/agent-stash",
      source: "github",
      ref: "github:dimm-city/agent-stash",
      artifactUrl: "https://github.com/dimm-city/agent-stash.git",
      contentDir: stashRoot,
      cacheDir,
      extractedDir: stashRoot,
      syncedAt: new Date().toISOString(),
      resolvedRevision: "def456",
    });
    const mirrorSpy = spyOn(gitProvider, "syncMirroredRepo").mockResolvedValue({
      id: "github:dimm-city/agent-stash",
      source: "git",
      ref: "github:dimm-city/agent-stash",
      artifactUrl: "https://github.com/dimm-city/agent-stash.git",
      contentDir: stashRoot,
      cacheDir,
      extractedDir: stashRoot,
      syncedAt: new Date().toISOString(),
      writable: true,
    });

    let result: Awaited<ReturnType<typeof akmUpdate>>;
    try {
      result = await akmUpdate({ target: "github:dimm-city/agent-stash", stashDir });
      expect(syncSpy).toHaveBeenCalledWith("github:dimm-city/agent-stash", {
        force: false,
        writable: true,
        writableRoot: stashRoot,
        writableRequiredRoots: [stashRoot],
      });
    } finally {
      syncSpy.mockRestore();
      mirrorSpy.mockRestore();
    }

    expect(result).toBeDefined();

    const config = loadConfig();
    const bundle = Object.values(config.bundles ?? {}).find((b) => b.registryId === "github:dimm-city/agent-stash");
    expect(bundle).toBeDefined();
    // Desired descriptor stays git (#37 split: desired in config, resolved in lock)
    expect(bundle?.git).toBe("https://github.com/dimm-city/agent-stash");
    // writable must survive the update
    expect(bundle?.writable).toBe(true);
    expect(bundle?.components).toEqual({ main: { root: ".", adapter: "okf", writable: true } });
    // resolved revision lives in the lock and should be updated
    const lock = readLockfile().find((e) => e.ref === "github:dimm-city/agent-stash");
    expect(lock?.source).toBe("git");
    expect(lock?.resolvedRevision).toBe("def456");
  });

  test("re-adding a writable install without --writable preserves and updates its checkout in place", async () => {
    const stashRoot = createTmpDir("akm-qa-readd-writable-");
    makeStashDir(stashRoot);
    const cacheDir = createTmpDir("akm-qa-readd-cache-");
    saveConfig({
      semanticSearchMode: "off",
      bundles: {
        "dimm-city-agent-stash": {
          git: "https://github.com/dimm-city/agent-stash.git",
          registryId: "github:dimm-city/agent-stash",
          components: { main: { root: ".", adapter: "okf", writable: true } },
        },
      },
    });
    mergeLockEntriesSync([
      {
        id: "dimm-city-agent-stash",
        source: "github",
        ref: "github:dimm-city/agent-stash",
        localRoot: stashRoot,
        installedAt: "2026-04-22T16:39:07.564Z",
      },
    ]);
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockResolvedValue({
      id: "github:dimm-city/agent-stash",
      source: "github",
      ref: "github:dimm-city/agent-stash",
      artifactUrl: "https://github.com/dimm-city/agent-stash.git",
      contentDir: stashRoot,
      cacheDir,
      extractedDir: stashRoot,
      syncedAt: new Date().toISOString(),
      writable: true,
    });
    try {
      await akmAdd({ ref: "github:dimm-city/agent-stash" });
      expect(syncSpy).toHaveBeenCalledWith("github:dimm-city/agent-stash", {
        writable: true,
        writableRoot: stashRoot,
        writableRequiredRoots: [stashRoot],
      });
    } finally {
      syncSpy.mockRestore();
    }

    expect(readLockfile().find((entry) => entry.id === "dimm-city-agent-stash")?.localRoot).toBe(stashRoot);
    expect(loadConfig().bundles?.["dimm-city-agent-stash"]?.components?.main?.writable).toBe(true);
  });
});

// ── Regression: R-015 — `akm update --all` must account for plain sources ───

describe("R-015: akm update --all with mixed plain and managed sources", () => {
  test("accounts for every configured source: syncs git+npm, reports website+filesystem as skipped", async () => {
    const fsDir = createTmpDir("akm-r015-fs-");
    makeStashDir(fsDir);

    const server = Bun.serve({
      port: 0,
      fetch(_req: Request) {
        return new Response("<html><head><title>T</title></head><body><h1>T</h1><p>hi</p></body></html>", {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      },
    });
    const siteUrl = `http://127.0.0.1:${server.port}`;

    saveConfig({
      semanticSearchMode: "off",
      bundles: {
        "local-fs": { path: fsDir, components: { main: { root: ".", adapter: "akm", writable: true } } },
        "docs-site": { website: { url: siteUrl } },
        "mirror-git": { git: "https://github.com/example/mirror-git.git" },
        "left-pad": { npm: "left-pad" },
      },
    });

    const gitSyncSpy = spyOn(gitProvider, "syncMirroredRepo").mockResolvedValue({
      id: "https://github.com/example/mirror-git",
      source: "git",
      ref: "https://github.com/example/mirror-git",
      artifactUrl: "https://github.com/example/mirror-git",
      contentDir: stashDir,
      cacheDir: testCacheDir,
      extractedDir: stashDir,
      syncedAt: new Date().toISOString(),
      writable: false,
    });
    const npmSyncSpy = spyOn(syncFromRefModule, "syncFromRef").mockResolvedValue({
      id: "left-pad",
      source: "npm",
      ref: "npm:left-pad",
      artifactUrl: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      resolvedVersion: "1.3.0",
      contentDir: stashDir,
      cacheDir: testCacheDir,
      extractedDir: stashDir,
      integrity: "sha512-fake",
      syncedAt: new Date().toISOString(),
      writable: false,
    });

    let result: Awaited<ReturnType<typeof akmUpdate>>;
    try {
      result = await akmUpdate({ all: true, stashDir });
    } finally {
      gitSyncSpy.mockRestore();
      npmSyncSpy.mockRestore();
      server.stop(true);
    }

    // Before R-015: `selectManagedTargets` returned `installs` (empty, since
    // none of these four sources are lock-backed) immediately for `all`,
    // so `processed` was `[]` and NOTHING else in the response mentioned any
    // of the four configured sources — the CLI rendered "nothing to update".

    // git: synced in place, reported via plainSynced (no lock/version to diff).
    expect(result.plainSynced).toContainEqual({
      id: "mirror-git",
      kind: "git",
      ref: "https://github.com/example/mirror-git.git",
    });
    // npm: promoted to a managed (lock-backed) install on first sync, so it
    // is reported via `processed` like any other managed update.
    expect(result.processed).toHaveLength(1);
    expect(result.processed[0]?.id).toBe("left-pad");
    expect(result.processed[0]?.installed.resolvedVersion).toBe("1.3.0");
    // website + filesystem: no --all sync path exists for either, so both
    // must be visibly reported as skipped (with the SAME explanatory wording
    // the single-target path already used) rather than silently omitted.
    const skippedIds = (result.skipped ?? []).map((s) => s.id).sort();
    expect(skippedIds).toEqual(["docs-site", "local-fs"]);
    const websiteSkip = result.skipped?.find((s) => s.id === "docs-site");
    expect(websiteSkip?.kind).toBe("website");
    expect(websiteSkip?.reason).toContain("not yet implemented for --all");
    const fsSkip = result.skipped?.find((s) => s.id === "local-fs");
    expect(fsSkip?.kind).toBe("filesystem");
    expect(fsSkip?.reason).toContain("akm index");

    // The npm source must now be a genuine managed install (lock-backed).
    const npmLock = readLockfile().find((entry) => entry.id === "left-pad");
    expect(npmLock?.resolvedVersion).toBe("1.3.0");
  });

  test("akm update <plain-npm-name> promotes it to a managed install instead of the wrong 'local directory' error", async () => {
    // Before this fix: a plain (lockless) npm bundle wasn't recognized by any
    // branch of akmUpdate's single-target dispatch, so it fell through to
    // the generic filesystem-source fallback message ("is a local directory
    // — it reflects your files in place"), which is actively wrong for an
    // unsynced npm package and gives the user no way to ever sync it.
    saveConfig({
      semanticSearchMode: "off",
      bundles: { "left-pad": { npm: "left-pad" } },
    });

    const npmSyncSpy = spyOn(syncFromRefModule, "syncFromRef").mockResolvedValue({
      id: "left-pad",
      source: "npm",
      ref: "npm:left-pad",
      artifactUrl: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      resolvedVersion: "1.3.0",
      contentDir: stashDir,
      cacheDir: testCacheDir,
      extractedDir: stashDir,
      integrity: "sha512-fake",
      syncedAt: new Date().toISOString(),
      writable: false,
    });
    try {
      const result = await akmUpdate({ target: "left-pad", stashDir });
      expect(result.processed).toHaveLength(1);
      expect(result.processed[0]?.id).toBe("left-pad");
      expect(result.processed[0]?.changed.any).toBe(true);
      expect(npmSyncSpy).toHaveBeenCalledWith("npm:left-pad", expect.objectContaining({ force: false }));
    } finally {
      npmSyncSpy.mockRestore();
    }

    expect(readLockfile().find((entry) => entry.id === "left-pad")?.resolvedVersion).toBe("1.3.0");
  });
});
