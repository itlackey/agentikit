// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * R2 — the improve loop's
 * `asset_salience.rank_score` composes into user-facing ranking as a bounded
 * multiplicative boost, loaded fail-open from state.db.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { upsertAssetSalience } from "../../src/commands/improve/salience";
import { conceptIdFromTypeName } from "../../src/core/asset/resolve-ref";
import { acquireMaintenanceBarrier } from "../../src/core/maintenance-barrier";
import { getStateDbPath, openStateDatabase } from "../../src/core/state-db";
import type { IndexDocument } from "../../src/indexer/passes/metadata";
import { loadSalienceRankScores } from "../../src/indexer/search/ranking";
import { applyUtilityContributors, type UtilityRankingContext } from "../../src/indexer/search/ranking-contributors";
import type { RankedEntryInput } from "../../src/indexer/search/ranking-types";
import type { Database } from "../../src/storage/database";
import { type Cleanup, withIsolatedAkmStorage } from "../_helpers/sandbox";

function makeRanked(id: number, name: string, type = "lesson"): RankedEntryInput {
  const entry: IndexDocument = { name, type: type as IndexDocument["type"] };
  return {
    id,
    entry,
    filePath: `/stash/${type}s/${name}.md`,
    score: 1,
    rankingMode: "fts",
    itemRef: `stash//${conceptIdFromTypeName(type, name)}`,
  };
}

function makeCtx(salienceRankScores?: Map<number, number>): UtilityRankingContext {
  return {
    db: null as unknown as Database,
    query: "x",
    queryLower: "x",
    queryTokens: ["x"],
    graphContext: null,
    utilityScores: new Map(),
    salienceRankScores,
  };
}

describe("R2 — salience ranking contributor", () => {
  test("rank_score boosts the item score, bounded at 1.2×", () => {
    const item = makeRanked(1, "hot");
    applyUtilityContributors(item, makeCtx(new Map([[1, 1.0]])));
    expect(item.score).toBeCloseTo(1.2, 9); // 1 + 1.0 × 0.2, capped

    const half = makeRanked(2, "warm");
    applyUtilityContributors(half, makeCtx(new Map([[2, 0.5]])));
    expect(half.score).toBeCloseTo(1.1, 9);
  });

  test("absent/zero rank_score leaves the score untouched (fail-open parity)", () => {
    const missing = makeRanked(1, "unknown");
    applyUtilityContributors(missing, makeCtx(new Map()));
    expect(missing.score).toBe(1);

    const zero = makeRanked(2, "zero");
    applyUtilityContributors(zero, makeCtx(new Map([[2, 0]])));
    expect(zero.score).toBe(1);

    const noMap = makeRanked(3, "nomap");
    applyUtilityContributors(noMap, makeCtx(undefined));
    expect(noMap.score).toBe(1);
  });
});

describe("R2 — loadSalienceRankScores (state.db read path)", () => {
  let cleanup: Cleanup;

  beforeEach(() => {
    ({ cleanup } = withIsolatedAkmStorage());
  });

  afterEach(() => cleanup());

  test("maps stored asset_salience rank scores back to entry ids by ref", () => {
    const db = openStateDatabase();
    try {
      upsertAssetSalience(db, "stash//lessons/hot", {
        encoding: 0.8,
        outcome: 0.5,
        retrieval: 0.9,
        rankScore: 0.77,
      });
    } finally {
      db.close();
    }
    const items = [makeRanked(11, "hot"), makeRanked(12, "cold")];
    const scores = loadSalienceRankScores(items);
    expect(scores.get(11)).toBeCloseTo(0.77, 9);
    expect(scores.has(12)).toBe(false);
  });

  test("missing state.db → empty map, and the search path never CREATES the file", () => {
    // No openStateDatabase() call in this test: state.db does not exist yet.
    const dbPath = getStateDbPath();
    expect(fs.existsSync(dbPath)).toBe(false);
    const scores = loadSalienceRankScores([makeRanked(1, "anything")]);
    expect(scores.size).toBe(0);
    // The read-only search path must not have created or migrated state.db.
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  test("coordinates the canonical read-only handle with the maintenance barrier", () => {
    const db = openStateDatabase();
    try {
      upsertAssetSalience(db, "stash//lessons/hot", {
        encoding: 0.8,
        outcome: 0.5,
        retrieval: 0.9,
        rankScore: 0.77,
      });
    } finally {
      db.close();
    }
    const items = [makeRanked(11, "hot")];
    const releaseBarrier = acquireMaintenanceBarrier();
    try {
      expect(loadSalienceRankScores(items).size).toBe(0);
    } finally {
      releaseBarrier();
    }
    expect(loadSalienceRankScores(items).get(11)).toBeCloseTo(0.77, 9);
  }, 10_000);
});

describe("salience current item_ref read", () => {
  let cleanup: Cleanup;

  beforeEach(() => {
    ({ cleanup } = withIsolatedAkmStorage());
  });

  afterEach(() => cleanup());

  function makeRankedWithItemRef(id: number, name: string, itemRef: string, type = "lesson"): RankedEntryInput {
    return { ...makeRanked(id, name, type), itemRef };
  }

  test("ignores bare stored keys and reads fully-qualified item_ref keys", () => {
    const db = openStateDatabase();
    try {
      upsertAssetSalience(db, "lessons/retired-hot", {
        encoding: 0.8,
        outcome: 0.5,
        retrieval: 0.9,
        rankScore: 0.66,
      });
      upsertAssetSalience(db, "stash//lessons/new-hot", {
        encoding: 0.8,
        outcome: 0.5,
        retrieval: 0.9,
        rankScore: 0.66,
      });
    } finally {
      db.close();
    }

    const retiredItem = makeRankedWithItemRef(21, "retired-hot", "stash//lessons/retired-hot");
    const newItem = makeRankedWithItemRef(22, "new-hot", "stash//lessons/new-hot");

    const scores = loadSalienceRankScores([retiredItem, newItem]);
    expect(scores.has(21)).toBe(false);
    expect(scores.get(22)).toBeCloseTo(0.66, 9);
  });

  test("a fully-qualified item_ref row is not affected by a bare sibling", () => {
    const db = openStateDatabase();
    try {
      upsertAssetSalience(db, "lessons/dual", { encoding: 0, outcome: 0, retrieval: 0, rankScore: 0.1 });
      upsertAssetSalience(db, "stash//lessons/dual", { encoding: 0, outcome: 0, retrieval: 0, rankScore: 0.9 });
    } finally {
      db.close();
    }

    const item = makeRankedWithItemRef(30, "dual", "stash//lessons/dual");
    const scores = loadSalienceRankScores([item]);
    expect(scores.get(30)).toBeCloseTo(0.9, 9);
  });

  test("an item_ref-bearing asset does not read a bare stored key", () => {
    const db = openStateDatabase();
    try {
      upsertAssetSalience(db, "lessons/straggler", { encoding: 0, outcome: 0, retrieval: 0, rankScore: 0.42 });
    } finally {
      db.close();
    }
    const item = makeRankedWithItemRef(40, "straggler", "stash//lessons/straggler");
    const scores = loadSalienceRankScores([item]);
    expect(scores.has(40)).toBe(false);
  });
});
