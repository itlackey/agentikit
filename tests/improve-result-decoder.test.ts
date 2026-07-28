// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { decodeImproveResult } from "../src/core/improve-result";

const common = {
  ok: true,
  scope: { mode: "all" },
  dryRun: false,
  memorySummary: { eligible: 1, derived: 0 },
  plannedRefs: [],
  actions: [],
};

describe("decodeImproveResult", () => {
  test("decodes the v2 strategy envelope", () => {
    const decoded = decodeImproveResult({ schemaVersion: 2, strategy: "thorough", ...common });
    expect(decoded.strategy).toBe("thorough");
    expect(decoded.envelope.strategy).toBe("thorough");
  });

  test("rejects complete and interrupted v1 envelopes", () => {
    const { memorySummary: _memorySummary, ...withoutSummary } = common;
    for (const v1 of [
      { schemaVersion: 1, profile: "nightly", ...common },
      {
        schemaVersion: 1,
        profile: "nightly",
        ...withoutSummary,
        ok: false,
        terminated: { reason: "signal", at: "2026-07-01T00:00:00Z" },
      },
    ]) {
      expect(() => decodeImproveResult(v1)).toThrow(/unsupported schemaVersion: 1/);
    }
  });

  test("rejects retired v1 fields and result aliases", () => {
    for (const retired of [
      { profile: "old" },
      { profileFilteredRefs: [] },
      { stalenessDetection: {} },
      { executionLogCandidates: [] },
      { recombination: {} },
      { proceduralCompilation: {} },
    ]) {
      expect(() => decodeImproveResult({ schemaVersion: 2, strategy: "default", ...common, ...retired })).toThrow(
        /unknown field/,
      );
    }
  });

  test("rejects unknown versions, unknown fields, and malformed required fields", () => {
    expect(() => decodeImproveResult({ schemaVersion: 3, ...common })).toThrow(/unsupported schemaVersion/);
    expect(() => decodeImproveResult({ schemaVersion: 2, strategy: "default", extra: true, ...common })).toThrow(
      /unknown field/,
    );
    expect(() => decodeImproveResult({ schemaVersion: 2, strategy: "", ...common })).toThrow(/non-empty/);
    expect(() =>
      decodeImproveResult({ schemaVersion: 2, strategy: "default", ...common, strategyFilteredRefs: {} }),
    ).toThrow(/strategyFilteredRefs/);
    const { memorySummary: _memorySummary, ...withoutSummary } = common;
    expect(() => decodeImproveResult({ schemaVersion: 2, strategy: "default", ...withoutSummary })).toThrow(
      /memorySummary/,
    );
    expect(() => decodeImproveResult("not json")).toThrow(/not valid JSON/);
  });
});
