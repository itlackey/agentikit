import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveEntryProvenance } from "../../../src/indexer/installations";
import type { IndexDocument } from "../../../src/indexer/passes/metadata";
import type { Database } from "../../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import { rebuildFts, searchFts } from "../../../src/storage/repositories/index-fts-repository";
import { type Cleanup, sandboxXdgCacheHome, sandboxXdgConfigHome } from "../../_helpers/sandbox";

// ── Temp directory management ───────────────────────────────────────────────

const createdTmpDirs: string[] = [];

function tmpDir(label = "db-scoring"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `akm-${label}-`));
  createdTmpDirs.push(dir);
  return dir;
}

function tmpDbPath(label = "db-scoring"): string {
  const dir = tmpDir(label);
  return path.join(dir, "test.db");
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Environment isolation ───────────────────────────────────────────────────

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  envCleanup = cfgResult.cleanup;
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<IndexDocument> & { name: string; type: IndexDocument["type"] }): IndexDocument {
  return {
    description: "A test entry",
    ...overrides,
  };
}

function insertTestEntry(
  db: Database,
  key: string,
  opts?: {
    dirPath?: string;
    filePath?: string;
    stashDir?: string;
    description?: string;
    searchText?: string;
    type?: IndexDocument["type"];
  },
): number {
  const type = opts?.type ?? "script";
  const entry = makeEntry({ name: key, type, description: opts?.description ?? `Description for ${key}` });
  return upsertEntry(
    db,
    opts?.filePath ?? `/test/dir/${key}.ts`,
    entry,
    opts?.searchText ?? `${key} ${entry.description}`,
    deriveEntryProvenance({ bundleId: "test-bundle", componentId: "test-bundle", adapterId: "akm" }, type, key),
  );
}

// ── Issue #2: Integration test — hyphenated search through searchFts ────────

describe("searchFts — hyphenated identifier search (Issue #2)", () => {
  test("searching for 'code-review' matches entry with code-review in search text", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "code-review", {
        description: "code-review skill for reviewing pull requests",
        searchText: "code-review skill for reviewing pull requests",
      });
      insertTestEntry(db, "deploy-prod", {
        description: "deploy-prod deploy to production servers",
        searchText: "deploy-prod deploy to production servers",
      });
      rebuildFts(db);

      const results = searchFts(db, "code-review", 10);
      expect(results.length).toBeGreaterThanOrEqual(1);
      // The code-review entry should be the top result
      expect(results[0]!.entry.name).toBe("code-review");
    } finally {
      closeDatabase(db);
    }
  });

  test("AND semantics: multi-word query only matches entries containing all terms", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "deploy-tool", {
        description: "deploy applications to production servers",
        searchText: "deploy applications to production servers",
      });
      insertTestEntry(db, "code-tool", {
        description: "code linting and formatting tool",
        searchText: "code linting and formatting tool",
      });
      insertTestEntry(db, "review-tool", {
        description: "review pull requests and merge code",
        searchText: "review pull requests and merge code",
      });
      rebuildFts(db);

      // With AND semantics, "code review" should NOT match "deploy-tool"
      // (which has neither "code" nor "review")
      // "review-tool" has both "review" and "code" in its search text
      const results = searchFts(db, "code review", 10);
      const names = results.map((r) => r.entry.name);
      expect(names).not.toContain("deploy-tool");
      // review-tool should match (it contains both "code" and "review")
      expect(names).toContain("review-tool");
    } finally {
      closeDatabase(db);
    }
  });
});

describe("searchFts candidate boundary expansion (#940)", () => {
  test("includes every row at the boundary but excludes strictly weaker rows", () => {
    const db = openIndexDatabase(tmpDbPath("fts-mixed-boundary"));
    try {
      for (const name of ["better-a", "better-b"]) {
        insertTestEntry(db, name, {
          description: "needle needle needle needle",
          searchText: "needle needle needle needle",
        });
      }
      for (const name of ["boundary-a", "boundary-b", "boundary-c"]) {
        insertTestEntry(db, name, { description: "needle", searchText: "needle" });
      }
      for (const name of ["worse-a", "worse-b"]) {
        const text = `needle ${"filler ".repeat(80)}`;
        insertTestEntry(db, name, { description: text, searchText: text });
      }
      rebuildFts(db);

      // N=3: two stronger rows plus the three-way boundary tie. The latter
      // must be complete; the strictly weaker rows remain outside the pool.
      expect(searchFts(db, "needle", 3).map((row) => row.entry.name)).toEqual([
        "better-a",
        "better-b",
        "boundary-a",
        "boundary-b",
        "boundary-c",
      ]);
    } finally {
      closeDatabase(db);
    }
  });

  test("applies typed and exclusion filters before finding the boundary", () => {
    const db = openIndexDatabase(tmpDbPath("fts-filtered-boundary"));
    try {
      insertTestEntry(db, "skill-a", { type: "skill", description: "needle", searchText: "needle" });
      insertTestEntry(db, "skill-b", { type: "skill", description: "needle", searchText: "needle" });
      insertTestEntry(db, "knowledge-a", { type: "knowledge", description: "needle", searchText: "needle" });
      rebuildFts(db);

      expect(searchFts(db, "needle", 1, "skill").map((row) => row.entry.name)).toEqual(["skill-a", "skill-b"]);
      expect(searchFts(db, "needle", 1, undefined, ["skill"]).map((row) => row.entry.name)).toEqual(["knowledge-a"]);
    } finally {
      closeDatabase(db);
    }
  });

  test("retains a large exact-BM25 boundary instead of silently choosing opaque row ids", () => {
    const db = openIndexDatabase(tmpDbPath("fts-boundary"));
    try {
      // The caller's final ranker owns contributor-aware tie resolution. A
      // lexical limit of 10 must therefore return all 3,000 exact BM25 ties,
      // not an arbitrary prefix selected by SQLite's generated entry id.
      // This is intentionally data-bound behavior, so the assertion records
      // the contract rather than treating it as an accidental overshoot.
      for (let index = 0; index < 3_000; index += 1) {
        insertTestEntry(db, `opaque-${index.toString().padStart(4, "0")}`, {
          description: "needle",
          searchText: "needle",
        });
      }
      rebuildFts(db);

      expect(searchFts(db, "needle", 0)).toEqual([]);

      const started = performance.now();
      const results = searchFts(db, "needle", 10);
      const elapsedMs = performance.now() - started;

      expect(results).toHaveLength(3_000);
      // Guard against a query-plan regression to repeated correlated scans;
      // leave generous room for slower CI runners while keeping this a real
      // indexed lookup rather than an accidental multi-second walk.
      expect(elapsedMs).toBeLessThan(5_000);
    } finally {
      closeDatabase(db);
    }
  });
});

// ── Issue #9: Single-character queries ──────────────────────────────────────

describe("single-character lexical queries (Issue #9)", () => {
  test("single character query returns FTS results when content matches", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "r-lang", {
        searchText: "R programming language for statistics",
      });
      insertTestEntry(db, "python-tool", {
        searchText: "Python scripting language",
      });
      rebuildFts(db);

      const results = searchFts(db, "R", 10);
      expect(results.length).toBeGreaterThanOrEqual(1);
    } finally {
      closeDatabase(db);
    }
  });
});
