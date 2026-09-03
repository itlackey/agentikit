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

// ── Issue #929: the FTS cascade tops up instead of short-circuiting ─────────

describe("searchFts — additive tier cascade (Issue #929)", () => {
  test("a thin conjunctive match is topped up from the relaxed tier", () => {
    // The bug: the exact-AND tier returning ONE row ended the search, so a
    // sentence-shaped query needing several documents got exactly one, and the
    // caller could not tell that better candidates were never considered.
    const db = openIndexDatabase(tmpDbPath("fts-topup"));
    try {
      // Only this entry carries every term, so exact-AND matches it alone.
      insertTestEntry(db, "backup-retention-policy", {
        description: "vault backup retention policy snapshots",
      });
      // These carry two of the four terms — reachable only via the relaxed
      // tier, and above the two-token top-up floor.
      insertTestEntry(db, "vault-backup-schedule", { description: "vault backup nightly schedule" });
      insertTestEntry(db, "retention-policy-notes", { description: "retention policy for archives" });
      rebuildFts(db);

      const results = searchFts(db, "vault backup retention policy", 5);
      const names = results.map((r) => r.entry.name);

      expect(results.length).toBeGreaterThan(1);
      expect(names).toContain("backup-retention-policy");
      expect(names).toContain("vault-backup-schedule");
      expect(names).toContain("retention-policy-notes");
    } finally {
      closeDatabase(db);
    }
  });

  test("a top-up never admits a document matching only one query term", () => {
    // The precision half of the fix. Without the two-token floor, topping up a
    // correct conjunctive result set with a bare OR pass appends documents that
    // share a single common word — noise the caller did not ask for, promoted
    // into a result set that was already right.
    const db = openIndexDatabase(tmpDbPath("fts-floor"));
    try {
      insertTestEntry(db, "vault-backup-retention", {
        description: "vault backup retention policy",
      });
      // Shares only "policy" — must not appear.
      insertTestEntry(db, "unrelated-policy", { description: "expense travel reimbursement rules" });
      rebuildFts(db);

      const names = searchFts(db, "vault backup retention policy", 5).map((r) => r.entry.name);

      expect(names).toContain("vault-backup-retention");
      expect(names).not.toContain("unrelated-policy");
    } finally {
      closeDatabase(db);
    }
  });

  test("the conjunctive hit keeps first position — top-ups only append", () => {
    // The safety property that makes this change additive rather than a
    // reordering: every result the old code returned keeps its position,
    // because bm25 scores are comparable within a tier but not across tiers, so
    // a global re-sort would be meaningless.
    const db = openIndexDatabase(tmpDbPath("fts-order"));
    try {
      insertTestEntry(db, "backup-retention-policy", {
        description: "vault backup retention policy snapshots",
      });
      insertTestEntry(db, "vault-backup-schedule", { description: "vault backup nightly schedule" });
      rebuildFts(db);

      const results = searchFts(db, "vault backup retention policy", 5);

      expect(results[0]?.entry.name).toBe("backup-retention-policy");
      expect(results[0]?.lexicalMatch).toBe("exact");
    } finally {
      closeDatabase(db);
    }
  });

  test("each result keeps its own tier label, which the ranker depends on", () => {
    // Downstream ranking applies a score ceiling to relaxed-tier hits that do
    // not match on name. Mislabelling a topped-up row as `exact` would let it
    // bypass that ceiling.
    const db = openIndexDatabase(tmpDbPath("fts-labels"));
    try {
      insertTestEntry(db, "backup-retention-policy", {
        description: "vault backup retention policy snapshots",
      });
      insertTestEntry(db, "vault-backup-schedule", { description: "vault backup nightly schedule" });
      rebuildFts(db);

      const byName = new Map(
        searchFts(db, "vault backup retention policy", 5).map((r) => [r.entry.name, r.lexicalMatch]),
      );

      expect(byName.get("backup-retention-policy")).toBe("exact");
      expect(byName.get("vault-backup-schedule")).toBe("relaxed");
    } finally {
      closeDatabase(db);
    }
  });

  test("the relaxed FALLBACK is unfiltered, so zero-hit protection is preserved", () => {
    // When nothing matched conjunctively, a single-term hit beats returning
    // nothing. The two-token floor applies only to top-ups, never here.
    const db = openIndexDatabase(tmpDbPath("fts-fallback"));
    try {
      insertTestEntry(db, "vault-notes", { description: "vault notes and reminders" });
      rebuildFts(db);

      // No document carries every term, so the conjunctive tiers find nothing.
      const names = searchFts(db, "vault backup retention policy", 5).map((r) => r.entry.name);

      expect(names).toContain("vault-notes");
    } finally {
      closeDatabase(db);
    }
  });

  test("no duplicates when a document matches in more than one tier", () => {
    const db = openIndexDatabase(tmpDbPath("fts-dedupe"));
    try {
      insertTestEntry(db, "backup-retention-policy", {
        description: "vault backup retention policy snapshots",
      });
      insertTestEntry(db, "vault-backup-schedule", { description: "vault backup nightly schedule" });
      rebuildFts(db);

      const ids = searchFts(db, "vault backup retention policy", 5).map((r) => r.id);

      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      closeDatabase(db);
    }
  });

  test("limit is still respected once the pool is filled", () => {
    const db = openIndexDatabase(tmpDbPath("fts-limit"));
    try {
      insertTestEntry(db, "backup-retention-policy", {
        description: "vault backup retention policy snapshots",
      });
      for (let i = 0; i < 8; i++) {
        insertTestEntry(db, `vault-backup-${i}`, { description: `vault backup variant ${i}` });
      }
      rebuildFts(db);

      expect(searchFts(db, "vault backup retention policy", 3).length).toBeLessThanOrEqual(3);
      expect(searchFts(db, "vault backup retention policy", 1).length).toBe(1);
    } finally {
      closeDatabase(db);
    }
  });

  test("a query matching nothing in any tier still returns empty", () => {
    const db = openIndexDatabase(tmpDbPath("fts-empty"));
    try {
      insertTestEntry(db, "vault-notes", { description: "vault notes and reminders" });
      rebuildFts(db);

      expect(searchFts(db, "zzzznonexistent", 5)).toEqual([]);
    } finally {
      closeDatabase(db);
    }
  });
});
