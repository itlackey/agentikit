// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { _setClackForTests } from "../../src/cli/clack";
import { _setDangerousKeyScannerForTests } from "../../src/commands/sources/dangerous-env-audit";
import { _setUpdateTransactionHookForTests, akmUpdate } from "../../src/commands/sources/installed-stashes";
import { saveConfig } from "../../src/core/config/config";
import { getConfigPath, getDbPath, getLockfilePath, getRegistryCacheDir } from "../../src/core/paths";
import { akmIndex } from "../../src/indexer/indexer";
import { mergeLockEntriesSync, readLockfile } from "../../src/integrations/lockfile";
import * as gitProvider from "../../src/sources/providers/git";
import * as syncFromRefModule from "../../src/sources/providers/sync-from-ref";
import { getWebsiteCachePaths } from "../../src/sources/website-url";
import { closeDatabase, openReadonlyExistingDatabase } from "../../src/storage/repositories/index-connection";
import { getAllEntries } from "../../src/storage/repositories/index-entries-repository";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  withIsolatedAkmStorage,
  withMockedFetch,
  withTTY,
} from "../_helpers/sandbox";
import { overrideSeam } from "../_helpers/seams";

let storage: IsolatedAkmStorage;
const disposers: Array<() => void> = [];

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  storage.cleanup();
});

function makeBundle(prefix: string, env: string, marker: string): string {
  const root = makeSandboxDir(prefix);
  disposers.push(root.cleanup);
  writeBundle(root.dir, env, marker);
  return root.dir;
}

function writeBundle(root: string, env: string, marker: string): void {
  fs.mkdirSync(path.join(root, "env"), { recursive: true });
  fs.mkdirSync(path.join(root, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(root, "env", "default.env"), env);
  fs.writeFileSync(
    path.join(root, "knowledge", "revision.md"),
    `---\ntype: knowledge\ndescription: Update audit revision ${marker}\n---\n\n# Revision ${marker}\n`,
  );
}

function indexedRows(): Array<{ bundleId: string; filePath: string; ref: string }> {
  const db = openReadonlyExistingDatabase(getDbPath());
  if (!db) return [];
  try {
    return getAllEntries(db)
      .map((row) => ({ bundleId: row.bundleId, filePath: row.filePath, ref: row.entryKey }))
      .sort((a, b) => a.filePath.localeCompare(b.filePath));
  } finally {
    closeDatabase(db);
  }
}

function indexedSearchText(): string {
  const db = openReadonlyExistingDatabase(getDbPath());
  if (!db) return "";
  try {
    return getAllEntries(db)
      .map((row) => row.searchText)
      .sort()
      .join("\n");
  } finally {
    closeDatabase(db);
  }
}

function managedCachePaths(id: string): { cacheDir: string; contentDir: string } {
  const cacheDir = path.join(getRegistryCacheDir(), `${id}-cache`);
  return { cacheDir, contentDir: path.join(cacheDir, "content") };
}

async function configureCanonicalManagedBundle(opts: {
  id: string;
  env: string;
  marker: string;
  source?: "git" | "npm";
  revision?: string;
  adapter?: boolean;
}): Promise<{ cacheDir: string; contentDir: string; ref: string }> {
  const source = opts.source ?? "npm";
  const ref = source === "npm" ? `npm:${opts.id}` : `github:example/${opts.id}`;
  const paths = managedCachePaths(opts.id);
  writeBundle(paths.contentDir, opts.env, opts.marker);
  saveConfig({
    semanticSearchMode: "off",
    bundles: {
      [opts.id]: {
        ...(source === "npm" ? { npm: opts.id } : { git: `https://github.com/example/${opts.id}.git` }),
        components: {
          main: { root: ".", ...(opts.adapter === false ? {} : { adapter: "akm" }), writable: false },
        },
      },
    },
  });
  mergeLockEntriesSync([
    {
      id: opts.id,
      source,
      ref,
      ...(source === "npm"
        ? { resolvedVersion: opts.revision ?? "1.0.0" }
        : { resolvedRevision: opts.revision ?? "old-revision" }),
      localRoot: paths.contentDir,
      installedAt: "2026-08-18T00:00:00.000Z",
    },
  ]);
  await akmIndex({ stashDir: storage.stashDir, hydrateSources: false, persistDetectedAdapters: false });
  return { ...paths, ref };
}

function stageManagedCandidate(
  cacheRootDir: string,
  opts: {
    id: string;
    env: string;
    marker: string;
    source?: "git" | "npm";
    revision?: string;
  },
): Awaited<ReturnType<typeof syncFromRefModule.syncFromRef>> {
  const source = opts.source ?? "npm";
  const cacheDir = path.join(cacheRootDir, `${opts.id}-cache`);
  const contentDir = path.join(cacheDir, "content");
  writeBundle(contentDir, opts.env, opts.marker);
  return {
    id: opts.id,
    source,
    ref: source === "npm" ? `npm:${opts.id}` : `github:example/${opts.id}`,
    artifactUrl:
      source === "npm" ? `https://registry.example/${opts.id}.tgz` : `https://github.com/example/${opts.id}.git`,
    ...(source === "npm"
      ? { resolvedVersion: opts.revision ?? "2.0.0" }
      : { resolvedRevision: opts.revision ?? "new-revision" }),
    contentDir,
    cacheDir,
    extractedDir: contentDir,
    syncedAt: "2026-08-19T00:00:00.000Z",
    writable: false,
  };
}

function requiredStagingRoot(options: { cacheRootDir?: string } | undefined): string {
  if (!options?.cacheRootDir) throw new Error("update did not provide an isolated cacheRootDir");
  return options.cacheRootDir;
}

function snapshotState(): {
  config: string;
  lock: string | null;
  indexExists: boolean;
  rows: ReturnType<typeof indexedRows>;
  text: string;
} {
  const lockPath = getLockfilePath();
  return {
    config: fs.readFileSync(getConfigPath(), "utf8"),
    lock: fs.existsSync(lockPath) ? fs.readFileSync(lockPath, "utf8") : null,
    indexExists: fs.existsSync(getDbPath()),
    rows: indexedRows(),
    text: indexedSearchText(),
  };
}

function expectState(snapshot: ReturnType<typeof snapshotState>): void {
  expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(snapshot.config);
  const lockPath = getLockfilePath();
  expect(fs.existsSync(lockPath) ? fs.readFileSync(lockPath, "utf8") : null).toBe(snapshot.lock);
  expect(fs.existsSync(getDbPath())).toBe(snapshot.indexExists);
  expect(indexedRows()).toEqual(snapshot.rows);
  expect(indexedSearchText()).toBe(snapshot.text);
}

describe("akm bundle update dangerous-key gate (#765)", () => {
  test("safe revision -> dangerous revision is rejected before bytes, lock, or index are published", async () => {
    const safeRoot = makeBundle("akm-765-safe-", "API_TOKEN=safe\n", "safe");
    const dangerousRoot = makeBundle(
      "akm-765-dangerous-",
      "# akm-lint-ok: dangerous-env-key\nLD_PRELOAD=/tmp/evil.so\n",
      "dangerous",
    );
    saveConfig({
      semanticSearchMode: "off",
      bundles: {
        audited: {
          git: "https://github.com/example/audited.git",
          components: { main: { root: ".", adapter: "akm", writable: false } },
        },
      },
    });
    mergeLockEntriesSync([
      {
        id: "audited",
        source: "git",
        ref: "github:example/audited",
        resolvedRevision: "safe-revision",
        localRoot: safeRoot,
        installedAt: "2026-08-18T00:00:00.000Z",
      },
    ]);
    await akmIndex({ stashDir: storage.stashDir });

    const lockBefore = fs.readFileSync(getLockfilePath(), "utf8");
    const indexBefore = indexedRows();
    expect(indexBefore.some((row) => row.filePath.startsWith(safeRoot))).toBe(true);

    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockResolvedValue({
      id: "example/audited",
      source: "github",
      ref: "github:example/audited",
      artifactUrl: "https://github.com/example/audited/archive/dangerous-revision.tar.gz",
      resolvedRevision: "dangerous-revision",
      contentDir: dangerousRoot,
      cacheDir: dangerousRoot,
      extractedDir: dangerousRoot,
      syncedAt: "2026-08-19T00:00:00.000Z",
      writable: false,
    });

    try {
      await withTTY(false, async () => {
        await expect(akmUpdate({ target: "audited", stashDir: storage.stashDir, yes: true })).rejects.toMatchObject({
          code: "DANGEROUS_ENV_KEY",
        });
      });
    } finally {
      syncSpy.mockRestore();
    }

    expect(fs.readFileSync(path.join(safeRoot, "env", "default.env"), "utf8")).toBe("API_TOKEN=safe\n");
    expect(readLockfile().find((entry) => entry.id === "audited")?.resolvedRevision).toBe("safe-revision");
    expect(fs.readFileSync(getLockfilePath(), "utf8")).toBe(lockBefore);
    expect(indexedRows()).toEqual(indexBefore);
    expect(indexedRows().some((row) => row.filePath.startsWith(dangerousRoot))).toBe(false);
  });

  test("--allow-insecure explicitly approves a staged dangerous same-version npm promotion", async () => {
    const live = await configureCanonicalManagedBundle({
      id: "approved",
      env: "API_TOKEN=old\n",
      marker: "approved-old",
      revision: "1.0.0",
    });
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) =>
      stageManagedCandidate(requiredStagingRoot(options), {
        id: "approved",
        env: "LD_PRELOAD=/reviewed.so\n",
        marker: "approved-new",
        revision: "1.0.0",
      }),
    );

    try {
      const result = await withTTY(false, () =>
        akmUpdate({
          target: "approved",
          stashDir: storage.stashDir,
          force: true,
          yes: true,
          allowInsecure: true,
        }),
      );
      expect(result.processed[0]?.changed.any).toBe(false);
    } finally {
      syncSpy.mockRestore();
    }

    expect(fs.readFileSync(path.join(live.contentDir, "env", "default.env"), "utf8")).toBe("LD_PRELOAD=/reviewed.so\n");
    expect(indexedSearchText()).toContain("approved-new");
    expect(indexedSearchText()).not.toContain("approved-old");
  });

  test("TTY confirmation observes only the old live bytes/lock/index before approving publication", async () => {
    const live = await configureCanonicalManagedBundle({
      id: "interactive",
      env: "API_TOKEN=old\n",
      marker: "interactive-old",
      revision: "old-revision",
      source: "git",
    });
    const before = snapshotState();
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) =>
      stageManagedCandidate(requiredStagingRoot(options), {
        id: "interactive",
        env: "NODE_OPTIONS=--require=/tmp/evil.js\n",
        marker: "interactive-new",
        revision: "new-revision",
        source: "git",
      }),
    );
    let promptObserved = false;
    overrideSeam(_setClackForTests, {
      isCancel: () => false,
      confirm: async (config: { message: string }) => {
        expect(config.message).toBe("Update anyway?");
        expect(fs.readFileSync(path.join(live.contentDir, "env", "default.env"), "utf8")).toBe("API_TOKEN=old\n");
        expectState(before);
        expect(indexedSearchText()).not.toContain("interactive-new");
        promptObserved = true;
        return true;
      },
    });

    try {
      await withTTY(true, () => akmUpdate({ target: "interactive", stashDir: storage.stashDir, yes: true }));
    } finally {
      syncSpy.mockRestore();
    }

    expect(promptObserved).toBe(true);
    expect(fs.readFileSync(path.join(live.contentDir, "env", "default.env"), "utf8")).toContain("NODE_OPTIONS");
    expect(readLockfile().find((entry) => entry.id === "interactive")?.resolvedRevision).toBe("new-revision");
    expect(indexedSearchText()).toContain("interactive-new");
  });

  test("an audit scanner fault fails closed before publication", async () => {
    const live = await configureCanonicalManagedBundle({
      id: "audit-fault",
      env: "API_TOKEN=old\n",
      marker: "audit-fault-old",
    });
    const before = snapshotState();
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) =>
      stageManagedCandidate(requiredStagingRoot(options), {
        id: "audit-fault",
        env: "API_TOKEN=new\n",
        marker: "audit-fault-new",
      }),
    );
    overrideSeam(_setDangerousKeyScannerForTests, () => {
      throw new Error("scanner boundary fault");
    });

    try {
      await expect(
        withTTY(false, () => akmUpdate({ target: "audit-fault", stashDir: storage.stashDir, yes: true })),
      ).rejects.toMatchObject({ code: "DANGEROUS_ENV_AUDIT_FAILED" });
    } finally {
      syncSpy.mockRestore();
    }

    expect(fs.readFileSync(path.join(live.contentDir, "env", "default.env"), "utf8")).toBe("API_TOKEN=old\n");
    expectState(before);
  });

  test("a publication-boundary fault restores exact live bytes, lock, config, and searchable index", async () => {
    const live = await configureCanonicalManagedBundle({
      id: "publish-fault",
      env: "API_TOKEN=old\n",
      marker: "publish-fault-old",
      adapter: false,
    });
    const before = snapshotState();
    expect(before.config).not.toContain('"adapter"');
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) =>
      stageManagedCandidate(requiredStagingRoot(options), {
        id: "publish-fault",
        env: "API_TOKEN=new\n",
        marker: "publish-fault-new",
      }),
    );
    overrideSeam(_setUpdateTransactionHookForTests, (point) => {
      if (point === "published") throw new Error("publication boundary fault");
    });

    try {
      await expect(
        withTTY(false, () => akmUpdate({ target: "publish-fault", stashDir: storage.stashDir, yes: true })),
      ).rejects.toThrow("publication boundary fault");
    } finally {
      syncSpy.mockRestore();
    }

    expect(fs.readFileSync(path.join(live.contentDir, "env", "default.env"), "utf8")).toBe("API_TOKEN=old\n");
    expectState(before);
    expect(indexedSearchText()).not.toContain("publish-fault-new");
  });

  test("a fault after the new index commits restores the prior content, lock, config, and DB generation", async () => {
    const live = await configureCanonicalManagedBundle({
      id: "index-fault",
      env: "API_TOKEN=old\n",
      marker: "index-fault-old",
    });
    const before = snapshotState();
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) =>
      stageManagedCandidate(requiredStagingRoot(options), {
        id: "index-fault",
        env: "API_TOKEN=new\n",
        marker: "index-fault-new",
      }),
    );
    overrideSeam(_setUpdateTransactionHookForTests, (point) => {
      if (point === "indexed") throw new Error("post-index boundary fault");
    });

    try {
      await expect(
        withTTY(false, () => akmUpdate({ target: "index-fault", stashDir: storage.stashDir, yes: true })),
      ).rejects.toThrow("post-index boundary fault");
    } finally {
      syncSpy.mockRestore();
    }

    expect(fs.readFileSync(path.join(live.contentDir, "env", "default.env"), "utf8")).toBe("API_TOKEN=old\n");
    expectState(before);
    expect(indexedSearchText()).toContain("index-fault-old");
    expect(indexedSearchText()).not.toContain("index-fault-new");
  });

  test("a concurrent lock generation cannot prevent content and index compensation", async () => {
    const live = await configureCanonicalManagedBundle({
      id: "lock-race",
      env: "API_TOKEN=old\n",
      marker: "lock-race-old",
    });
    const thirdRoot = makeBundle("akm-765-lock-race-third-", "API_TOKEN=third\n", "lock-race-third");
    const before = snapshotState();
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) =>
      stageManagedCandidate(requiredStagingRoot(options), {
        id: "lock-race",
        env: "API_TOKEN=new\n",
        marker: "lock-race-new",
      }),
    );
    overrideSeam(_setUpdateTransactionHookForTests, (point) => {
      if (point !== "before-index") return;
      fs.writeFileSync(
        getLockfilePath(),
        `${JSON.stringify(
          [
            {
              id: "lock-race",
              source: "npm",
              ref: "npm:lock-race",
              localRoot: thirdRoot,
            },
          ],
          null,
          2,
        )}\n`,
      );
      throw new Error("fault after concurrent lock publication");
    });

    try {
      await expect(
        withTTY(false, () => akmUpdate({ target: "lock-race", stashDir: storage.stashDir, yes: true })),
      ).rejects.toThrow("changed concurrently");
    } finally {
      syncSpy.mockRestore();
    }

    expect(readLockfile().find((entry) => entry.id === "lock-race")?.localRoot).toBe(thirdRoot);
    expect(fs.readFileSync(path.join(live.contentDir, "env", "default.env"), "utf8")).toBe("API_TOKEN=old\n");
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before.config);
    expect(indexedRows()).toEqual(before.rows);
    expect(indexedSearchText()).toBe(before.text);
    expect(indexedSearchText()).not.toContain("lock-race-new");
  });

  test("update --all continues per bundle and reports updated, blocked, and failed outcomes", async () => {
    const ids = ["danger-all", "safe-all", "broken-all"] as const;
    for (const id of ids) writeBundle(managedCachePaths(id).contentDir, "API_TOKEN=old\n", `${id}-old`);
    saveConfig({
      semanticSearchMode: "off",
      bundles: Object.fromEntries(
        ids.map((id) => [id, { npm: id, components: { main: { root: ".", adapter: "akm", writable: false } } }]),
      ),
    });
    mergeLockEntriesSync(
      ids.map((id) => ({
        id,
        source: "npm" as const,
        ref: `npm:${id}`,
        resolvedVersion: "1.0.0",
        localRoot: managedCachePaths(id).contentDir,
        installedAt: "2026-08-18T00:00:00.000Z",
      })),
    );
    await akmIndex({ stashDir: storage.stashDir, hydrateSources: false });

    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (ref, options) => {
      const id = ref.slice("npm:".length);
      if (id === "broken-all") throw new Error("provider failed");
      return stageManagedCandidate(requiredStagingRoot(options), {
        id,
        env: id === "danger-all" ? "LD_PRELOAD=/tmp/evil.so\n" : "API_TOKEN=new\n",
        marker: `${id}-new`,
      });
    });

    let result: Awaited<ReturnType<typeof akmUpdate>>;
    try {
      result = await withTTY(false, () => akmUpdate({ all: true, stashDir: storage.stashDir, yes: true }));
    } finally {
      syncSpy.mockRestore();
    }

    expect(result.processed.map((item) => item.id)).toEqual(["safe-all"]);
    expect(result.skipped).toContainEqual(
      expect.objectContaining({ id: "danger-all", status: "blocked", code: "DANGEROUS_ENV_KEY" }),
    );
    expect(result.skipped).toContainEqual(expect.objectContaining({ id: "broken-all", status: "failed" }));
    expect(fs.readFileSync(path.join(managedCachePaths("danger-all").contentDir, "env", "default.env"), "utf8")).toBe(
      "API_TOKEN=old\n",
    );
    expect(fs.readFileSync(path.join(managedCachePaths("safe-all").contentDir, "env", "default.env"), "utf8")).toBe(
      "API_TOKEN=new\n",
    );
    expect(readLockfile().find((entry) => entry.id === "danger-all")?.resolvedVersion).toBe("1.0.0");
    expect(readLockfile().find((entry) => entry.id === "safe-all")?.resolvedVersion).toBe("2.0.0");
    expect(readLockfile().find((entry) => entry.id === "broken-all")?.resolvedVersion).toBe("1.0.0");
    expect(indexedSearchText()).toContain("danger-all-old");
    expect(indexedSearchText()).not.toContain("danger-all-new");
    expect(indexedSearchText()).toContain("safe-all-new");
    expect(indexedSearchText()).toContain("broken-all-old");
  });

  for (const writable of [false, true]) {
    test(`plain ${writable ? "writable" : "read-only"} git audits its staged checkout without changing the active cache`, async () => {
      const url = `https://github.com/example/plain-${writable ? "writable" : "readonly"}.git`;
      const livePaths = gitProvider.getCachePaths(url);
      writeBundle(livePaths.repoDir, "API_TOKEN=old\n", `plain-${writable}-old`);
      fs.writeFileSync(livePaths.indexPath, "[]\n");
      saveConfig({
        semanticSearchMode: "off",
        bundles: {
          plain: {
            git: url,
            components: { main: { root: ".", adapter: "akm", writable } },
          },
        },
      });
      await akmIndex({ stashDir: storage.stashDir, hydrateSources: false });
      const before = snapshotState();
      const syncSpy = spyOn(gitProvider, "syncMirroredRepo").mockImplementation(async (_source, options) => {
        const stagedPaths = gitProvider.getCachePaths(url, requiredStagingRoot(options));
        writeBundle(stagedPaths.repoDir, "LD_PRELOAD=/tmp/evil.so\n", `plain-${writable}-new`);
        fs.writeFileSync(stagedPaths.indexPath, "[]\n");
        return {
          id: url,
          source: "git",
          ref: url,
          artifactUrl: url,
          contentDir: stagedPaths.repoDir,
          cacheDir: stagedPaths.rootDir,
          extractedDir: stagedPaths.repoDir,
          syncedAt: "2026-08-19T00:00:00.000Z",
          writable,
        };
      });

      try {
        await expect(
          withTTY(false, () => akmUpdate({ target: "plain", stashDir: storage.stashDir, yes: true })),
        ).rejects.toMatchObject({ code: "DANGEROUS_ENV_KEY" });
      } finally {
        syncSpy.mockRestore();
      }

      expect(fs.readFileSync(path.join(livePaths.repoDir, "env", "default.env"), "utf8")).toBe("API_TOKEN=old\n");
      expectState(before);
      expect(indexedSearchText()).not.toContain(`plain-${writable}-new`);
    });
  }

  test("an all-blocked --all response never hydrates the blocked plain source a second time", async () => {
    const url = "https://github.com/example/all-blocked.git";
    const livePaths = gitProvider.getCachePaths(url);
    writeBundle(livePaths.repoDir, "API_TOKEN=old\n", "all-blocked-old");
    fs.writeFileSync(livePaths.indexPath, "[]\n");
    saveConfig({
      semanticSearchMode: "off",
      bundles: {
        blocked: {
          git: url,
          components: { main: { root: ".", adapter: "akm", writable: false } },
        },
      },
    });
    const before = snapshotState();
    let syncCalls = 0;
    const syncSpy = spyOn(gitProvider, "syncMirroredRepo").mockImplementation(async (_source, options) => {
      syncCalls += 1;
      const stagedPaths = gitProvider.getCachePaths(url, requiredStagingRoot(options));
      writeBundle(stagedPaths.repoDir, "LD_PRELOAD=/tmp/evil.so\n", "all-blocked-new");
      fs.writeFileSync(stagedPaths.indexPath, "[]\n");
      return {
        id: url,
        source: "git",
        ref: url,
        artifactUrl: url,
        contentDir: stagedPaths.repoDir,
        cacheDir: stagedPaths.rootDir,
        extractedDir: stagedPaths.repoDir,
        syncedAt: "2026-08-19T00:00:00.000Z",
        writable: false,
      };
    });

    let result: Awaited<ReturnType<typeof akmUpdate>>;
    try {
      result = await withTTY(false, () => akmUpdate({ all: true, stashDir: storage.stashDir, yes: true }));
    } finally {
      syncSpy.mockRestore();
    }

    expect(syncCalls).toBe(1);
    expect(result.processed).toEqual([]);
    expect(result.plainSynced ?? []).toEqual([]);
    expect(result.skipped).toContainEqual(
      expect.objectContaining({ id: "blocked", status: "blocked", code: "DANGEROUS_ENV_KEY" }),
    );
    expect(fs.readFileSync(path.join(livePaths.repoDir, "env", "default.env"), "utf8")).toBe("API_TOKEN=old\n");
    expectState(before);
    expect(indexedSearchText()).not.toContain("all-blocked-new");
  });

  test("website cache promotion rolls back its active root on a publication fault", async () => {
    const url = "http://127.0.0.1:45678/atomic-site";
    const livePaths = getWebsiteCachePaths(url);
    writeBundle(livePaths.stashDir, "API_TOKEN=old\n", "website-old");
    fs.writeFileSync(livePaths.manifestPath, "{}\n");
    saveConfig({
      semanticSearchMode: "off",
      bundles: {
        site: { website: { url }, components: { main: { root: ".", adapter: "akm", writable: false } } },
      },
    });
    await akmIndex({ stashDir: storage.stashDir, hydrateSources: false });
    const before = snapshotState();
    overrideSeam(_setUpdateTransactionHookForTests, (point) => {
      if (point === "published") throw new Error("website publication fault");
    });

    await withMockedFetch(
      async () => {
        await expect(akmUpdate({ target: "site", stashDir: storage.stashDir })).rejects.toThrow(
          "website publication fault",
        );
      },
      () =>
        new Response("<html><head><title>New site</title></head><body><h1>New site</h1></body></html>", {
          headers: { "content-type": "text/html" },
        }),
    );

    expect(fs.readFileSync(path.join(livePaths.stashDir, "env", "default.env"), "utf8")).toBe("API_TOKEN=old\n");
    expectState(before);
    expect(indexedSearchText()).toContain("website-old");
    expect(indexedSearchText()).not.toContain("New site");
  });
});
