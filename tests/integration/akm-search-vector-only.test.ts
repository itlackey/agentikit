// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * VALUE-02 residual (issue #787): a test that deterministically forces
 * `akmSearch` down its vector-only match path (a hit with no FTS match at
 * all, surfaced purely from `embedScoreMap` — `rankingMode: "semantic"` in
 * src/indexer/search/ranking.ts).
 *
 * The prior pass (8cf96889) deleted a false "vec-only" test that never
 * actually exercised this path, and flagged the gap as unresolved because
 * the deterministic feature-hashing embedder (src/llm/embedders/deterministic.ts)
 * has no real semantic understanding — "vector-only" isn't cheap to force by
 * picking synonyms the way it would be against a real model.
 *
 * The reliable trigger is a structural asymmetry in the FTS vs. vector query
 * paths, not a semantic one:
 *
 *   - `buildLexicalQueryPlan` (src/indexer/search/fts-query.ts) caps a query
 *     at `MAX_LEXICAL_QUERY_TOKENS` (16) UNIQUE tokens before building the
 *     FTS `exact`/`exactPrefix`/`relaxed` MATCH strings — anything past the
 *     16th unique token is silently dropped from every FTS query variant
 *     `searchFts` tries (src/storage/repositories/index-fts-repository.ts).
 *   - `tryVecScores` (src/indexer/search/db-search.ts) embeds the FULL raw
 *     query string with no such cap.
 *
 * So: 16 unique filler tokens that appear nowhere in the index, plus a 17th
 * token that is the ONLY word in one entry's content, guarantees FTS finds
 * nothing (exact/prefix/relaxed all miss — none of the searched 16 tokens
 * occur anywhere) while the embedder still hashes the 17th token and finds
 * the entry as a vector neighbor. `search.minScore` is set to 0 so the
 * result isn't sensitive to the feature-hashing embedder's actual cosine
 * magnitude — only that a match exists at all.
 *
 * Verified for real, not just plausible: this test was run against a
 * deliberately broken vector path (see the commit body / PR description for
 * this change) and observed to fail there, then the break was reverted.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmSearch } from "../../src/commands/read/search";
import { saveConfig } from "../../src/core/config/config";
import { akmIndex } from "../../src/indexer/indexer";
import { withIsolatedAkmStorage } from "../_helpers/sandbox";

// 16 unique filler tokens, deliberately absent from every entry's content so
// neither the exact (AND) nor relaxed (OR) FTS query can match anything.
const FILLER_TOKENS = Array.from({ length: 16 }, (_, i) => `qfiller${i}xzq`);
// The 17th token: past the FTS lexical-plan cap, but embedded in full by the
// vector path. This is the ONLY word in the target entry's content.
const TARGET_TOKEN = "qzorbnitkelvin";
const QUERY = [...FILLER_TOKENS, TARGET_TOKEN].join(" ");

describe("akmSearch: vector-only match path (VALUE-02)", () => {
  test("a query token past the FTS 16-token cap surfaces a vector-only hit", async () => {
    const storage = withIsolatedAkmStorage({ AKM_EMBED_DETERMINISTIC: "1" });
    try {
      const knowledgeFile = path.join(storage.stashDir, "knowledge", "target.md");
      fs.mkdirSync(path.dirname(knowledgeFile), { recursive: true });
      fs.writeFileSync(knowledgeFile, `---\ndescription: ${TARGET_TOKEN}\n---\n${TARGET_TOKEN}\n`, "utf8");

      saveConfig({
        semanticSearchMode: "auto",
        bundles: { stash: { path: storage.stashDir } },
        defaultBundle: "stash",
        registries: [],
        search: { minScore: 0 },
      });
      await akmIndex({ stashDir: storage.stashDir, full: true });

      // Control: with semantic search off, the same 17-token query must find
      // nothing at all — this is what proves the 16-token FTS cap actually
      // drops the 17th token rather than the entry just being unindexed.
      saveConfig({
        semanticSearchMode: "off",
        bundles: { stash: { path: storage.stashDir } },
        defaultBundle: "stash",
        registries: [],
        search: { minScore: 0 },
      });
      const ftsOnly = await akmSearch({ query: QUERY, skipLogging: true });
      expect(ftsOnly.hits.some((hit) => "path" in hit && hit.path === knowledgeFile)).toBe(false);

      // With semantic search back on, the vector path (which embeds the full
      // query, no 16-token cap) must find the entry purely via cosine
      // similarity — a genuine vector-only hit.
      saveConfig({
        semanticSearchMode: "auto",
        bundles: { stash: { path: storage.stashDir } },
        defaultBundle: "stash",
        registries: [],
        search: { minScore: 0 },
      });
      const hybrid = await akmSearch({ query: QUERY, skipLogging: true });
      const hit = hybrid.hits.find((h) => "path" in h && h.path === knowledgeFile);
      expect(hit).toBeDefined();
      // `rankingMode: "semantic"` (vector-only, no FTS match) is the only
      // ranking mode that produces this exact reason string
      // (buildWhyMatched in src/indexer/search/db-search.ts).
      expect(hit?.whyMatched).toContain("semantic similarity");
    } finally {
      storage.cleanup();
    }
  });
});
