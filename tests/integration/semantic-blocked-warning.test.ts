// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * F7/A2: the `blocked` semantic-search warning must be differentiated, the
 * same way the `pending` branch immediately above it already is
 * (db-search.ts splits on `!config.embedding?.endpoint || !config.embedding?.model`).
 *
 * Before this fix, `blocked` emitted ONE fixed string regardless of cause and
 * discarded `rawStatus.reason`/`rawStatus.message` — a genuinely failing
 * provider (auth, network, a stuck local-model download, …) and "nothing is
 * configured" produced byte-identical, unhelpful output.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmSearch } from "../../src/commands/read/search";
import { resetConfigCache, saveConfig } from "../../src/core/config/config";
import { akmIndex } from "../../src/indexer/indexer";
import { deriveSemanticProviderFingerprint, writeSemanticStatus } from "../../src/indexer/search/semantic-status";
import { type Cleanup, sandboxStashDir, sandboxXdgConfigHome, withEnv } from "../_helpers/sandbox";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "akm-sem-blocked-test-"));
}

let stashDir = "";
let envCleanup: Cleanup = () => {};
let cacheDir = "";
const originalCacheDir = process.env.AKM_CACHE_DIR;

beforeEach(async () => {
  const cfgResult = sandboxXdgConfigHome();
  const stashResult = sandboxStashDir(cfgResult.cleanup);
  stashDir = stashResult.dir;
  envCleanup = stashResult.cleanup;
  cacheDir = makeTmpDir();
  process.env.AKM_CACHE_DIR = cacheDir;

  fs.mkdirSync(path.join(stashDir, "skills"), { recursive: true });
  fs.writeFileSync(path.join(stashDir, "skills", "widget.md"), "---\ndescription: a widget skill\n---\n# Widget\n");
  await withEnv({ AKM_STASH_DIR: stashDir }, async () => {
    resetConfigCache();
    saveConfig({ semanticSearchMode: "off" });
    await akmIndex({ stashDir, full: true });
  });
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
  fs.rmSync(cacheDir, { recursive: true, force: true });
  if (originalCacheDir === undefined) delete process.env.AKM_CACHE_DIR;
  else process.env.AKM_CACHE_DIR = originalCacheDir;
});

describe("semantic 'blocked' warning (F7/A2)", () => {
  test("no embedding provider configured -> 'not configured' phrasing (not a fault)", async () => {
    saveConfig({ semanticSearchMode: "auto" });
    writeSemanticStatus({
      status: "blocked",
      reason: "remote-auth",
      message: "should be ignored — nothing is configured",
      providerFingerprint: deriveSemanticProviderFingerprint(undefined),
      lastCheckedAt: new Date().toISOString(),
    });

    const result = await akmSearch({ query: "widget", skipLogging: true });

    const joined = (result.warnings ?? []).join("\n");
    expect(joined).toContain("no embedding provider is configured");
    expect(joined).not.toContain("should be ignored");
  });

  test("a genuinely failing configured provider surfaces reason/message instead of one fixed string", async () => {
    saveConfig({
      semanticSearchMode: "auto",
      embedding: { endpoint: "https://example.invalid/embed", model: "test-model" },
    });
    writeSemanticStatus({
      status: "blocked",
      reason: "remote-auth",
      message: 'Forbidden access to file: "https://huggingface.co/example"',
      providerFingerprint: deriveSemanticProviderFingerprint({
        endpoint: "https://example.invalid/embed",
        model: "test-model",
      }),
      lastCheckedAt: new Date().toISOString(),
    });

    const result = await akmSearch({ query: "widget", skipLogging: true });

    const joined = (result.warnings ?? []).join("\n");
    expect(joined).toContain("Forbidden access to file");
    expect(joined).not.toBe(
      "Semantic search is currently blocked. Using keyword search until the semantic backend is healthy again.",
    );
  });
});
