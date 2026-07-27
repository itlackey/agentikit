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
import { akmSearch } from "../../src/commands/read/search";
import { akmShowUnified } from "../../src/commands/read/show";
import { parseBundleRef } from "../../src/core/asset/asset-ref";
import { resetConfigCache, saveConfig } from "../../src/core/config/config";
import { akmIndex, lookupBundleRef } from "../../src/indexer/indexer";
import type { SourceSearchHit } from "../../src/sources/types";
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
const WEBSITE_ROOT = path.resolve(__dirname, "../fixtures/bundles/website-snapshot");
const GENERIC_ROOT = path.resolve(__dirname, "../fixtures/bundles/generic-files");

function _createTmpDir(prefix = "akm-parity-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

function copyFixtureToTmp(sourceRoot: string): string {
  const parent = _createTmpDir("akm-parity-fixture-");
  const root = path.join(parent, path.basename(sourceRoot));
  fs.cpSync(sourceRoot, root, { recursive: true });
  return root;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

async function indexAdapterBundle(
  bundleId: string,
  root: string,
  adapter: "website-snapshot" | "generic-files",
  writable: boolean,
): Promise<void> {
  saveConfig({
    semanticSearchMode: "off",
    defaultBundle: "local",
    bundles: {
      local: {
        path: stashDir,
        writable: true,
        components: { main: { root: ".", adapter: "akm", writable: true } },
      },
      [bundleId]: {
        path: root,
        writable,
        components: { main: { root: ".", adapter, writable } },
      },
    },
  });
  resetConfigCache();
  await akmIndex({ stashDir, full: true });
}

async function onlyHit(bundleId: string, query: string): Promise<SourceSearchHit> {
  const result = await akmSearch({
    query,
    source: bundleId,
    skipLogging: true,
    disableProjectContext: true,
    disableScopedUtility: true,
  });
  const hits = result.hits.filter((hit): hit is SourceSearchHit => "path" in hit);
  expect(hits).toHaveLength(1);
  const hit = hits[0];
  if (!hit) throw new Error(`expected one search hit for ${bundleId}:${query}`);
  return hit;
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

  test("website search results retain their indexed projection through show", async () => {
    await indexAdapterBundle("website-fixture", WEBSITE_ROOT, "website-snapshot", false);

    const hit = await onlyHit("website-fixture", "second crawled");
    const indexed = await lookupBundleRef(parseBundleRef(hit.ref));
    const shown = await akmShowUnified({ ref: hit.ref, skipLogging: true });

    expect(hit).toMatchObject({
      type: "website",
      name: "About Example",
      ref: "website-fixture//example-com/about",
      description: "Snapshot of https://example.com/about",
    });
    expect(indexed).toMatchObject({ adapterId: "website-snapshot", type: "website" });
    expect(shown).toMatchObject({
      type: hit.type,
      name: hit.name,
      ref: hit.ref,
      path: hit.path,
      description: hit.description,
      content: indexed?.document?.content,
    });
  });

  test("generic Markdown search results retain their indexed document type through show", async () => {
    await indexAdapterBundle("generic-fixture", copyFixtureToTmp(GENERIC_ROOT), "generic-files", true);

    const hit = await onlyHit("generic-fixture", "special structure");
    const indexed = await lookupBundleRef(parseBundleRef(hit.ref));
    const shown = await akmShowUnified({ ref: hit.ref, skipLogging: true });

    expect(hit).toMatchObject({ type: "document", name: "notes", ref: "generic-fixture//notes" });
    expect(indexed).toMatchObject({ adapterId: "generic-files", type: "document" });
    expect(shown).toMatchObject({
      type: hit.type,
      name: hit.name,
      ref: hit.ref,
      path: hit.path,
      content: indexed?.document?.content,
    });
  });

  test("generic non-Markdown search results can be shown from their indexed projection", async () => {
    await indexAdapterBundle("generic-fixture", copyFixtureToTmp(GENERIC_ROOT), "generic-files", true);

    const hit = await onlyHit("generic-fixture", "alpha");
    const indexed = await lookupBundleRef(parseBundleRef(hit.ref));
    const shown = await akmShowUnified({ ref: hit.ref, skipLogging: true });

    expect(hit).toMatchObject({ type: "file", name: "data.csv", ref: "generic-fixture//data.csv" });
    expect(indexed).toMatchObject({ adapterId: "generic-files", type: "file" });
    expect(shown).toMatchObject({
      type: hit.type,
      name: hit.name,
      ref: hit.ref,
      path: hit.path,
      content: indexed?.document?.content,
    });
  });
});
