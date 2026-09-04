// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Dependency-safe fixed FTS5 calibration shared by storage and ranking. */
const SCORE_FLOOR = 0.3;
const PARENT_CEILING = 0.8;
// Fragment BM25 is from a distinct FTS population. Its slightly higher ceiling
// is an explicit evidence policy, not a cross-table comparability claim: when
// a body fragment independently proves the query, prefer that actionable
// selector over the same parent's length-penalized whole-body row. Metadata
// and cross-fragment conjunctions cannot enter this population.
const FRAGMENT_CEILING = 0.82;
const BM25_REFERENCE = 0.000001;
const LOG_SHAPE = 3;

export type LexicalPopulation = "parent" | "fragment";

export function stableFtsScore(bm25Score: number, population: LexicalPopulation = "parent"): number {
  const ceiling = population === "fragment" ? FRAGMENT_CEILING : PARENT_CEILING;
  if (bm25Score === Number.NEGATIVE_INFINITY) return ceiling;
  if (!Number.isFinite(bm25Score) || bm25Score >= 0) return SCORE_FLOOR;
  const scaled = Math.log1p(-bm25Score / BM25_REFERENCE);
  if (!Number.isFinite(scaled)) return ceiling;
  return SCORE_FLOOR + (ceiling - SCORE_FLOOR) * (scaled / (scaled + LOG_SHAPE));
}
