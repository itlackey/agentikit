import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assembleInfo } from "../../src/commands/sources/info";
import { loadConfig, resetConfigCache, saveConfig } from "../../src/core/config/config";
import type { IndexDocument } from "../../src/indexer/passes/metadata";
import { closeDatabase, openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../src/storage/repositories/index-entries-repository";
import { rebuildFts } from "../../src/storage/repositories/index-fts-repository";
import { setMeta } from "../../src/storage/repositories/index-meta-repository";
import { searchVec, upsertEmbedding } from "../../src/storage/repositories/index-vec-repository";
import { runCliCapture } from "../_helpers/cli";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
} from "../_helpers/sandbox";

// ── Temp directory management ───────────────────────────────────────────────

const createdTmpDirs: string[] = [];

function tmpDir(label = "info"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `akm-${label}-`));
  createdTmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Environment isolation ───────────────────────────────────────────────────

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const dataResult = sandboxXdgDataHome();
  const cacheResult = sandboxXdgCacheHome(dataResult.cleanup);
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const stashResult = sandboxStashDir(cfgResult.cleanup);
  envCleanup = stashResult.cleanup;
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeStashDir(): string {
  const dir = tmpDir("stash");
  // Create minimal stash structure
  fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
  return dir;
}

function makeEntry(type: string, name: string): IndexDocument {
  return {
    type,
    name,
    description: `A test ${type}`,
    tags: ["test"],
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("assembleInfo", () => {
  test("returns a version string", () => {
    const info = assembleInfo();

    expect(typeof info.version).toBe("string");
    expect(info.version.length).toBeGreaterThan(0);
  });

  test("returns assetTypes array with built-in types", () => {
    const info = assembleInfo();

    expect(Array.isArray(info.assetTypes)).toBe(true);
    expect(info.assetTypes).toContain("skill");
    expect(info.assetTypes).toContain("command");
    expect(info.assetTypes).toContain("agent");
    expect(info.assetTypes).toContain("knowledge");
    expect(info.assetTypes).toContain("script");
    expect(info.assetTypes).toContain("memory");
  });

  test("returns searchModes array", () => {
    const info = assembleInfo();

    expect(Array.isArray(info.searchModes)).toBe(true);
    // fts is always available
    expect(info.searchModes).toContain("fts");
  });

  test("works without an index (entryCount: 0)", () => {
    const info = assembleInfo();

    expect(info.indexStats.entryCount).toBe(0);
    expect(info.indexStats.hasEmbeddings).toBe(false);
  });

  test("returns registries from config", () => {
    const info = assembleInfo();

    expect(Array.isArray(info.registries)).toBe(true);
    // Default config has registries
    const config = loadConfig();
    const expected = config.registries ?? [];
    expect(info.registries.length).toBe(expected.length);
  });

  test("includes indexStats when index exists with entries", () => {
    const stashDir = makeStashDir();

    // Create an index with some entries
    const dbPath = path.join(tmpDir("db"), "test.db");
    const db = openIndexDatabase(dbPath);
    const entry = makeEntry("skill", "test-skill");
    upsertEntry(db, "skills/test-skill", "/fake/skill", "/fake/skill/test-skill", stashDir, entry, "test skill");
    rebuildFts(db);
    setMeta(db, "builtAt", "2026-03-17T00:00:00Z");
    closeDatabase(db);

    const info = assembleInfo({ dbPath });

    expect(info.indexStats.entryCount).toBe(1);
    expect(info.indexStats.lastBuiltAt).toBe("2026-03-17T00:00:00Z");
    expect(typeof info.indexStats.vecAvailable).toBe("boolean");
  });

  test("does not downgrade embedding metadata when reading info", () => {
    const stashDir = makeStashDir();

    const dbPath = path.join(tmpDir("db"), "test.db");
    let db = openIndexDatabase(dbPath, { embeddingDim: 4 });
    const entry = makeEntry("skill", "embed-skill");
    const id = upsertEntry(
      db,
      "skills/embed-skill",
      "/fake/skill",
      "/fake/skill/embed-skill",
      stashDir,
      entry,
      "embed skill",
    );
    upsertEmbedding(db, id, [1, 0, 0, 0]);
    setMeta(db, "hasEmbeddings", "1");
    rebuildFts(db);
    closeDatabase(db);

    const info = assembleInfo({ dbPath });

    expect(info.indexStats.entryCount).toBe(1);

    db = openIndexDatabase(dbPath, { embeddingDim: 4 });
    try {
      expect(searchVec(db, [1, 0, 0, 0], 10)).toHaveLength(1);
    } finally {
      closeDatabase(db);
    }
  });

  test("returns sourceProviders from config", () => {
    const info = assembleInfo();

    expect(Array.isArray(info.sourceProviders)).toBe(true);
  });

  // Precondition for consolidate-wave2-e.test.ts's D5 deletion (Phase 2
  // triage): that file's "assembleInfo — sourceProviders populated" test only
  // asserted `typeof assembleInfo === "function"`. This strengthens the real
  // coverage: sourceProviders is empty with no configured bundle, and once a
  // bundle IS configured it projects the bundle → source shape assembleInfo
  // actually emits (src/commands/sources/info.ts:47-56).
  test("sourceProviders is empty with no configured bundle, and reflects a configured bundle", () => {
    expect(assembleInfo().sourceProviders).toEqual([]);

    const stashDir = makeStashDir();
    const config = loadConfig();
    config.bundles = { primary: { path: stashDir } };
    config.defaultBundle = "primary";
    saveConfig(config);

    const info = assembleInfo();
    expect(info.sourceProviders).toEqual([{ type: "filesystem", name: "primary", path: stashDir }]);
  });

  test("output is valid JSON-serializable", () => {
    const info = assembleInfo();
    const json = JSON.stringify(info);
    const parsed = JSON.parse(json);

    expect(parsed.version).toBe(info.version);
    expect(parsed.assetTypes).toEqual(info.assetTypes);
    expect(parsed.searchModes).toEqual(info.searchModes);
    expect(parsed.indexStats).toEqual(info.indexStats);
  });

  // Owner ruling 9 (R-039): the runtime default flipped from "auto" to "off",
  // so a bare install never silently downloads the ~130 MB embedding model.
  // `akm info` on a fresh install therefore reports mode "off" / status
  // "disabled" rather than "auto" / "pending". The "auto" case is pinned
  // separately below so the pending-status path keeps its coverage.
  test("reports semantic search off by default (R-039)", () => {
    const info = assembleInfo();

    expect(info.searchModes).toContain("fts");
    expect(info.searchModes).not.toContain("semantic");
    expect(info.searchModes).not.toContain("hybrid");
    expect(info.semanticSearch.mode).toBe("off");
    expect(info.semanticSearch.status).toBe("disabled");
  });

  test("reports pending semantic search status when the user opts in to auto", () => {
    const config = loadConfig();
    config.semanticSearchMode = "auto";
    saveConfig(config);
    resetConfigCache();

    const info = assembleInfo();

    expect(info.searchModes).toContain("fts");
    expect(info.searchModes).not.toContain("semantic");
    expect(info.searchModes).not.toContain("hybrid");
    expect(info.semanticSearch.mode).toBe("auto");
    expect(info.semanticSearch.status).toBe("pending");
  });

  test("does not leak apiKey from registry options", () => {
    // Write a config with a registry that has an apiKey in its options
    const config = loadConfig();
    config.registries = [
      {
        url: "https://example.com/registry",
        name: "test-registry",
        provider: "static-index",
        options: { apiKey: "super-secret-key-12345" },
      },
    ];
    saveConfig(config);

    const info = assembleInfo();

    expect(info.registries).toHaveLength(1);
    expect(info.registries[0]!.url).toBe("https://example.com/registry");
    expect(info.registries[0]!.name).toBe("test-registry");
    // Ensure apiKey is not present anywhere in the serialized output
    const serialized = JSON.stringify(info);
    expect(serialized).not.toContain("super-secret-key-12345");
    expect(serialized).not.toContain("apiKey");
  });
});

// ── WS2: info honors --format (already supported; regression guard) ───────────
describe("akm info --format", () => {
  test("--format text differs from --format json (info honors --format)", async () => {
    resetConfigCache();
    const json = await runCliCapture(["info", "--format", "json"]);
    resetConfigCache();
    const text = await runCliCapture(["info", "--format", "text"]);
    expect(json.code).toBe(0);
    expect(text.code).toBe(0);
    // JSON output parses as JSON; text output does not.
    expect(() => JSON.parse(json.stdout)).not.toThrow();
    expect(json.stdout).not.toBe(text.stdout);
  });
});
