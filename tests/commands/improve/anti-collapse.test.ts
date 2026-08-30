// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS-3b Step 8 — anti-collapse merge guards — unit tests.
 *
 * Covers:
 *   - readAssetGeneration / computeMergedGeneration: frontmatter read + math.
 *   - computeBigramDiversity: n-gram diversity metric.
 *   - checkLexicalDiversity: low-diversity cluster detection.
 *   - anti-collapse guards default ON (R5 §4.1).
 */

import { describe, expect, test } from "bun:test";
import {
  checkLexicalDiversity,
  computeBigramDiversity,
  computeMergedGeneration,
  readAssetGeneration,
} from "../../../src/commands/improve/anti-collapse";

// ── readAssetGeneration / computeMergedGeneration ────────────────────────────

describe("readAssetGeneration", () => {
  test("returns 0 when generation field absent", () => {
    expect(readAssetGeneration({})).toBe(0);
    expect(readAssetGeneration({ description: "x" })).toBe(0);
  });

  test("returns 0 for non-numeric generation values", () => {
    expect(readAssetGeneration({ generation: "two" })).toBe(0);
    expect(readAssetGeneration({ generation: null })).toBe(0);
    expect(readAssetGeneration({ generation: Number.NaN })).toBe(0);
    expect(readAssetGeneration({ generation: -1 })).toBe(0);
  });

  test("returns the integer floor of the generation value", () => {
    expect(readAssetGeneration({ generation: 1 })).toBe(1);
    expect(readAssetGeneration({ generation: 3.7 })).toBe(3);
    expect(readAssetGeneration({ generation: 0 })).toBe(0);
  });
});

describe("computeMergedGeneration", () => {
  test("returns 1 when no source generations (first merge)", () => {
    expect(computeMergedGeneration([])).toBe(1);
  });

  test("returns max + 1", () => {
    expect(computeMergedGeneration([0, 1, 2])).toBe(3);
    expect(computeMergedGeneration([3, 3])).toBe(4);
    expect(computeMergedGeneration([0, 0])).toBe(1);
  });
});

// ── computeBigramDiversity ────────────────────────────────────────────────────

describe("computeBigramDiversity", () => {
  test("returns 1 for text that is too short to have bigrams", () => {
    expect(computeBigramDiversity("one")).toBe(1);
    expect(computeBigramDiversity("")).toBe(1);
  });

  test("returns 1 for text with all unique bigrams", () => {
    // "the quick brown fox" → 3 unique bigrams out of 3 = 1.0
    expect(computeBigramDiversity("the quick brown fox")).toBeCloseTo(1.0);
  });

  test("returns low value for highly repetitive text", () => {
    // All bigrams are "the the" → diversity = 1/N
    const result = computeBigramDiversity("the the the the the the the the");
    expect(result).toBeLessThan(0.3);
  });

  test("is case-insensitive", () => {
    const a = computeBigramDiversity("Hello World Foo");
    const b = computeBigramDiversity("hello world foo");
    expect(a).toBeCloseTo(b);
  });
});

// ── checkLexicalDiversity ─────────────────────────────────────────────────────

describe("checkLexicalDiversity", () => {
  test("returns lowDiversity=false when disabled", () => {
    const result = checkLexicalDiversity(["the the the the"], { enabled: false });
    expect(result.lowDiversity).toBe(false);
  });

  test("returns lowDiversity=false when lexicalDiversityCheck=false", () => {
    const result = checkLexicalDiversity(["the the the the"], { enabled: true, lexicalDiversityCheck: false });
    expect(result.lowDiversity).toBe(false);
  });

  test("returns lowDiversity=false for empty bodies list", () => {
    const result = checkLexicalDiversity([], { enabled: true });
    expect(result.lowDiversity).toBe(false);
  });

  test("detects low-diversity cluster (repetitive bodies)", () => {
    const bodies = ["the the the the the the the the the the", "the the the the the the the the the the"];
    const result = checkLexicalDiversity(bodies, { enabled: true });
    expect(result.lowDiversity).toBe(true);
    expect(result.diversity).toBeDefined();
    expect(result.diversity).toBeLessThan(0.3);
  });

  test("returns lowDiversity=false for diverse bodies", () => {
    const bodies = [
      "the quick brown fox jumps over the lazy dog",
      "a completely different sentence about cats and mice",
    ];
    const result = checkLexicalDiversity(bodies, { enabled: true });
    expect(result.lowDiversity).toBe(false);
  });
});

// ── R5: anti-collapse guards default ON ───────────────────────────────────────

describe("anti-collapse guards default ON (R5 §4.1)", () => {
  test("checkLexicalDiversity is active with an empty config (default on)", () => {
    // Single repeated token → 1 unique bigram / 5 total = 0.2 < the 0.30 floor.
    const repetitive = ["same same same same same same", "same same same same same same"];
    expect(checkLexicalDiversity(repetitive, {}).lowDiversity).toBe(true);
    expect(checkLexicalDiversity(repetitive, { enabled: false }).lowDiversity).toBe(false);
  });
});
