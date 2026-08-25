// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../../src/core/config/config";
import { akmIndex } from "../../../src/indexer/indexer";
import { closeDatabase, openExistingDatabase } from "../../../src/storage/repositories/index-connection";
import { getAllEntries } from "../../../src/storage/repositories/index-entries-repository";
import { computeBodyHash, upsertLlmCacheEntry } from "../../../src/storage/repositories/index-llm-cache-repository";
import { type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage, withMockedFetch } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

test("an unchanged full index uses its canonical item_ref cache before credential preflight", async () => {
  const assetPath = path.join(storage.stashDir, "knowledge", "cached.md");
  const rawBody = "# Cached\n\nStable generated body.\n";
  fs.writeFileSync(assetPath, rawBody, "utf8");

  saveConfig({ semanticSearchMode: "off" });
  await akmIndex({ stashDir: storage.stashDir, full: true });

  const db = openExistingDatabase();
  let itemRef = "";
  try {
    const cachedAsset = getAllEntries(db).find((entry) => entry.conceptId === "knowledge/cached");
    expect(cachedAsset).toBeDefined();
    itemRef = cachedAsset?.itemRef ?? "";
    expect(itemRef).toMatch(/\/\/knowledge\/cached$/);
    upsertLlmCacheEntry(
      db,
      itemRef,
      computeBodyHash(rawBody),
      JSON.stringify({ description: "Cached description", searchHints: ["cached hint"], tags: ["cached"] }),
    );
  } finally {
    closeDatabase(db);
  }

  saveConfig({
    semanticSearchMode: "off",
    engines: {
      index: {
        kind: "llm",
        endpoint: "http://127.0.0.1:1/v1/chat/completions",
        model: "must-not-run",
        apiKey: "$AKM_ENRICH_CACHE_KEY",
      },
    },
    index: { defaults: { engine: "index" }, metadataEnhance: { enabled: true } },
  });

  let providerCalls = 0;
  await expect(
    withEnv({ AKM_ENRICH_CACHE_KEY: undefined }, () =>
      withMockedFetch(
        () => akmIndex({ stashDir: storage.stashDir, full: true }),
        () => {
          providerCalls++;
          throw new Error("canonical cache hit must not dispatch the provider");
        },
      ),
    ),
  ).resolves.toBeDefined();
  expect(providerCalls).toBe(0);
});
