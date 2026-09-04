// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { combineSearchScores, normalizeFtsScores } from "../src/indexer/search/ranking";
import type { DbSearchResult } from "../src/storage/repositories/index-entry-types";

function result(id: number, bm25Score: number): DbSearchResult {
  return {
    id,
    bm25Score,
    filePath: `/stash/knowledge/${id}.md`,
    searchText: "",
    entry: { name: `entry-${id}`, type: "knowledge", description: "fixture", filename: `${id}.md` },
    itemRef: `stash//knowledge/${id}`,
    bundleId: "stash",
    conceptId: `knowledge/${id}`,
    adapterId: "filesystem",
    lexicalMatch: "exact",
  };
}

function scoreFor(results: DbSearchResult[], id: number): number {
  const scored = normalizeFtsScores(results).get(id);
  expect(scored).toBeDefined();
  return scored!.score;
}

describe("stable FTS score calibration (#933)", () => {
  test("returns an empty map for no lexical candidates", () => {
    expect(normalizeFtsScores([])).toEqual(new Map());
  });

  test("is monotone for BM25 relevance even when input is not BM25-sorted", () => {
    const scores = normalizeFtsScores([result(1, -0.1), result(2, -4), result(3, -1)]);
    expect(scores.get(2)!.score).toBeGreaterThan(scores.get(3)!.score);
    expect(scores.get(3)!.score).toBeGreaterThan(scores.get(1)!.score);
  });

  test("does not rewrite leaders when strictly weaker candidates are appended", () => {
    const leaders = [result(1, -4), result(2, -1), result(3, -0.1)];
    const before = normalizeFtsScores(leaders);
    const after = normalizeFtsScores([...leaders, result(4, -0.01), result(5, -0.001)]);

    for (const leader of leaders) {
      expect(after.get(leader.id)!.score).toBeCloseTo(before.get(leader.id)!.score, 12);
    }
  });

  test("keeps equal BM25 values equal and produces bounded finite values at the boundary", () => {
    const candidates = [
      result(1, -Infinity),
      result(2, -Number.MAX_VALUE),
      result(3, -1),
      result(4, -1),
      result(5, -0),
      result(6, Number.POSITIVE_INFINITY),
      result(7, Number.NaN),
    ];
    const scores = normalizeFtsScores(candidates);

    expect(scores.get(3)!.score).toBe(scores.get(4)!.score);
    for (const candidate of candidates) {
      const score = scores.get(candidate.id)!.score;
      expect(Number.isFinite(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(0.3);
      expect(score).toBeLessThanOrEqual(0.8);
    }
    expect(scores.get(1)!.score).toBe(0.8);
    expect(scores.get(2)!.score).toBeLessThanOrEqual(0.8);
    expect(scores.get(5)!.score).toBe(0.3);
    expect(scores.get(6)!.score).toBe(0.3);
    expect(scores.get(7)!.score).toBe(0.3);
  });

  test("keeps lexical-only, semantic-only, and hybrid contributions deliberately ordered", () => {
    const lexicalResult = result(1, -1);
    const lexicalOnly = combineSearchScores({
      ftsScoreMap: normalizeFtsScores([lexicalResult]),
      embedScoreMap: new Map(),
      getEntryById: () => undefined,
    })[0]!;
    const semanticOnly = combineSearchScores({
      ftsScoreMap: new Map(),
      embedScoreMap: new Map([[2, 0.9]]),
      getEntryById: () => ({
        entry: result(2, -1).entry,
        filePath: "/stash/knowledge/2.md",
        itemRef: "stash//knowledge/2",
        bundleId: "stash",
        conceptId: "knowledge/2",
      }),
    })[0]!;
    const hybrid = combineSearchScores({
      ftsScoreMap: normalizeFtsScores([lexicalResult]),
      embedScoreMap: new Map([[1, 0.9]]),
      getEntryById: () => undefined,
    })[0]!;

    expect(hybrid.score).toBeGreaterThan(lexicalOnly.score);
    expect(lexicalOnly.score).toBeGreaterThan(semanticOnly.score);
    expect(semanticOnly.score).toBeCloseTo(0.27, 12);
  });

  test("exposes no candidate-set dependence through a single-result lookup", () => {
    expect(scoreFor([result(1, -1)], 1)).toBeCloseTo(scoreFor([result(1, -1), result(2, -0.01)], 1), 12);
  });
});
