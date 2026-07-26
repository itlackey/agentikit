/**
 * Parity regression for Phase 4 (spec §10 step 4 / §6.2).
 *
 * `akm show` consults `indexer.lookupBundleRef(ref)` first, then reads the file
 * from disk. The risk called out in the v1 implementation plan is that
 * bundle-qualified refs silently regress when the
 * indexer is consulted instead of the directory walker.
 *
 * This test pins both forms — bare ref and origin-prefixed ref — and asserts
 * that `indexer.lookupBundleRef` returns the same on-disk path that `akmShowUnified`
 * resolves to. If a future refactor changes how the indexer keys assets, this
 * test fails fast instead of silently breaking show for installed sources.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmShowUnified } from "../../src/commands/read/show";
import { parseBundleRef } from "../../src/core/asset/asset-ref";
import { resetConfigCache, saveConfig } from "../../src/core/config/config";
import { akmIndex, lookupBundleRef } from "../../src/indexer/indexer";
import { closeDatabase, openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { getMeta } from "../../src/storage/repositories/index-meta-repository";
import { searchVec } from "../../src/storage/repositories/index-vec-repository";
import "../../src/sources/providers/index";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
} from "../_helpers/sandbox";

const createdTmpDirs: string[] = [];

function _createTmpDir(prefix = "akm-parity-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function createMockEmbeddingServer(embedding: number[] = [1, 0, 0, 0]): {
  url: string;
  server: ReturnType<typeof Bun.serve>;
} {
  const server = Bun.serve({
    port: 0,
    async fetch() {
      return new Response(JSON.stringify({ data: [{ embedding }] }), {
        status: 200,
        headers: { "Content-Type": "application/json", Connection: "close" },
      });
    },
  });
  return { url: `http://localhost:${server.port}/v1/embeddings`, server };
}

let stashDir = "";
let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const dataResult = sandboxXdgDataHome();
  const cacheResult = sandboxXdgCacheHome(dataResult.cleanup);
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const stashResult = sandboxStashDir(cfgResult.cleanup);
  stashDir = stashResult.dir;
  envCleanup = stashResult.cleanup;
  resetConfigCache();
  saveConfig({ semanticSearchMode: "off" });
  resetConfigCache();
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
  stashDir = "";
});

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Phase 4 parity: indexer.lookupBundleRef ↔ akmShowUnified", () => {
  test("indexed asset lookup returns the same file akmShow renders", async () => {
    const skillBody = [
      "---",
      "name: parity-skill",
      "description: A skill used to verify Phase 4 parity",
      "---",
      "# Parity skill",
      "",
      "Body content used by the parity test.",
    ].join("\n");
    // Skills live at skills/<name>/SKILL.md (see asset-spec.ts)
    writeFile(path.join(stashDir, "skills", "parity-skill", "SKILL.md"), skillBody);

    await akmIndex({ stashDir, full: true });

    const indexed = await lookupBundleRef(parseBundleRef("skills/parity-skill"));
    expect(indexed).not.toBeNull();
    if (!indexed) return;

    expect(indexed.type).toBe("skill");
    expect(indexed.name).toBe("parity-skill");
    expect(indexed.itemRef).toMatch(/\/\/skills\/parity-skill$/);

    // Reading the indexer-resolved path should yield the on-disk content.
    const fileBody = fs.readFileSync(indexed.filePath, "utf8");
    expect(fileBody).toBe(skillBody);

    // akmShow returns the same path in its rendered response.
    const shown = await akmShowUnified({ ref: "skills/parity-skill" });
    expect(shown.path).toBe(indexed.filePath);
    expect(indexed.itemRef).toMatch(/\/\/skills\/parity-skill$/);
    expect(shown.ref).toBe("skills/parity-skill");
  });

  test("a missing qualified bundle does not retarget to the primary stash", async () => {
    const body = ["---", "name: origin-skill", "description: Test", "---", "# origin"].join("\n");
    writeFile(path.join(stashDir, "skills", "origin-skill", "SKILL.md"), body);

    await akmIndex({ stashDir, full: true });

    const bare = await lookupBundleRef(parseBundleRef("skills/origin-skill"));
    const local = await lookupBundleRef(parseBundleRef("local//skills/origin-skill"));
    expect(bare).not.toBeNull();
    expect(local).toBeNull();

    const shownBare = await akmShowUnified({ ref: "skills/origin-skill" });
    await expect(akmShowUnified({ ref: "local//skills/origin-skill" })).rejects.toThrow();
    expect(shownBare.path).toBe(bare?.filePath as string);
  });

  test("lookup does not fall back to entry_key for an incomplete provenance row", async () => {
    writeFile(path.join(stashDir, "knowledge", "legacy.md"), "# Legacy\n");
    await akmIndex({ stashDir, full: true });

    const dbPath = path.join(process.env.XDG_DATA_HOME as string, "akm", "index.db");
    const db = openIndexDatabase(dbPath);
    try {
      db.prepare(
        "UPDATE entries SET item_ref = NULL, bundle_id = NULL, concept_id = NULL WHERE entry_type = 'knowledge'",
      ).run();
    } finally {
      closeDatabase(db);
    }

    const indexed = await lookupBundleRef(parseBundleRef("knowledge/legacy"));
    expect(indexed).toBeNull();
  });

  test("lookup and show do not downgrade embedding dimension metadata", async () => {
    const { url, server } = createMockEmbeddingServer();
    const body = ["---", "name: embed-skill", "description: Test", "---", "# embed"].join("\n");
    writeFile(path.join(stashDir, "skills", "embed-skill", "SKILL.md"), body);

    saveConfig({
      semanticSearchMode: "auto",
      embedding: {
        provider: "openai-compatible",
        endpoint: url,
        model: "test-embed",
        dimension: 4,
      },
    });
    resetConfigCache();

    try {
      await akmIndex({ stashDir, full: true });
      await lookupBundleRef(parseBundleRef("skills/embed-skill"));
      await akmShowUnified({ ref: "skills/embed-skill" });

      const db = openIndexDatabase(path.join(process.env.XDG_DATA_HOME as string, "akm", "index.db"), {
        embeddingDim: 4,
      });
      try {
        expect(getMeta(db, "embeddingDim")).toBe("4");
        expect(getMeta(db, "hasEmbeddings")).toBe("1");
        expect(searchVec(db, [1, 0, 0, 0], 10)).toHaveLength(1);
      } finally {
        closeDatabase(db);
      }
    } finally {
      server.stop(true);
    }
  });

  test("missing asset lookup returns null", async () => {
    await akmIndex({ stashDir, full: true });
    const result = await lookupBundleRef(parseBundleRef("skills/does-not-exist"));
    expect(result).toBeNull();
  });
});
