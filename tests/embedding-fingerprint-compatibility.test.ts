// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #955: `decideEmbeddingCompatibility` is the pure decision function behind
 * the embedding-fingerprint canary — given pairs of (stored vector, freshly
 * re-embedded vector) it decides whether the stored index survives a
 * `embedding.model` string change or must be purged and rebuilt. Pure/
 * in-memory, no database — belongs under tests/, not tests/integration/.
 */

import { describe, expect, test } from "bun:test";
import { decideEmbeddingCompatibility, type EmbeddingCanaryPair } from "../src/indexer/materialize-embeddings";

function pair(stored: number[], fresh: number[] | undefined): EmbeddingCanaryPair {
  return { stored, fresh };
}

describe("decideEmbeddingCompatibility", () => {
  test("keeps when every pair is (near-)identical", () => {
    const pairs = [pair([1, 0, 0], [1, 0, 0]), pair([0, 1, 0], [0, 1, 0]), pair([0, 0, 1], [0, 0, 1])];
    expect(decideEmbeddingCompatibility(pairs)).toBe("keep");
  });

  test("keeps at median >= 0.999 even with one bad pair among many good ones", () => {
    // 7 near-identical pairs and 1 wildly different pair — the median still
    // clears the threshold, so one stale/edited sample does not discard an
    // otherwise-compatible index.
    const good = Array.from({ length: 7 }, () => pair([1, 0, 0], [1, 0, 0]));
    const bad = pair([1, 0, 0], [0, 1, 0]);
    expect(decideEmbeddingCompatibility([...good, bad])).toBe("keep");
  });

  test("rebuilds on genuinely low similarity (a different model)", () => {
    const pairs = [pair([1, 0, 0], [0, 1, 0]), pair([0, 1, 0], [1, 0, 0]), pair([0, 0, 1], [1, 0, 0])];
    expect(decideEmbeddingCompatibility(pairs)).toBe("rebuild");
  });

  test("rebuilds on a dimension mismatch (cosineSimilarity's own 0-on-mismatch guard)", () => {
    const pairs = [pair([1, 0, 0], [1, 0, 0, 0]), pair([0, 1, 0], [0, 1, 0, 0])];
    expect(decideEmbeddingCompatibility(pairs)).toBe("rebuild");
  });

  test("rebuilds when the median of an even number of pairs falls short", () => {
    // Median of two similarities straddling the threshold from below.
    const pairs = [pair([1, 0], [1, 0]), pair([1, 0], [0, 1])];
    expect(decideEmbeddingCompatibility(pairs)).toBe("rebuild");
  });

  test("treats a missing fresh vector (embed failure for that sample) as zero similarity", () => {
    const pairs = [pair([1, 0, 0], undefined), pair([1, 0, 0], [1, 0, 0])];
    expect(decideEmbeddingCompatibility(pairs)).toBe("rebuild");
  });

  test("an empty sample keeps — nothing to verify, nothing to lose", () => {
    expect(decideEmbeddingCompatibility([])).toBe("keep");
  });
});
