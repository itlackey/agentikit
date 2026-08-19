// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { decodeImproveResult } from "../src/core/improve-result";
import type { ImproveExecutionPlan } from "../src/core/improve-types";

const common = {
  ok: true,
  scope: { mode: "all" },
  dryRun: false,
  memorySummary: { eligible: 1, derived: 0 },
  plannedRefs: [],
  actions: [],
};

describe("decodeImproveResult", () => {
  const plan = {
    mode: "estimate",
    dispatch: false,
    snapshot: { status: "ready", reason: "loaded the existing index read-only" },
    candidates: { rawInScope: 2, selected: 1, effective: 1 },
    limits: { configured: { cli: 1, reflect: 25 }, effective: 1 },
    gates: [{ name: "limit", removed: 1, reason: "deferred" }],
    effectiveRefs: [{ ref: "skills/a", lane: "proactive", reason: "scope-type" }],
    proactive: {
      configured: { dueDays: 30, maxPerRun: 10 },
      effective: { dueDays: 30, maxPerRun: 10 },
      candidatePool: 2,
      dueTotal: 2,
      neverReflected: 2,
      selected: 1,
      selectedRefs: ["skills/a"],
    },
    consolidation: {
      configured: { enabled: true, minPoolSize: 3, limit: 4, maxChunkSize: 2 },
      effective: { enabled: true, minPoolSize: 3, limit: 4, chunkSize: 2 },
      poolSize: 5,
      candidatePoolSize: 4,
      gates: {
        profile: { passed: true, reason: "enabled" },
        minimumPool: { passed: true, reason: "large enough" },
        delta: { passed: true, reason: "changed" },
      },
      wouldRun: true,
      reason: "all gates pass",
      estimatedChunks: 2,
    },
    stages: [
      { name: "consolidation", wouldRun: true, reason: "all gates pass" },
      { name: "extract", wouldRun: false, reason: "disabled" },
      { name: "graph-extraction", wouldRun: false, reason: "disabled" },
      { name: "memory-inference", wouldRun: false, reason: "disabled" },
    ],
    triage: {
      enabled: true,
      configuredMode: "promote",
      mode: "queue",
      maxAcceptsPerRun: 7,
      maxDiffLines: 20,
    },
  } satisfies ImproveExecutionPlan;

  test("decodes the v2 strategy envelope", () => {
    const decoded = decodeImproveResult({ schemaVersion: 2, strategy: "thorough", ...common });
    expect(decoded.strategy).toBe("thorough");
    expect(decoded.envelope.strategy).toBe("thorough");
  });

  test("strictly decodes the additive improve plan", () => {
    const decoded = decodeImproveResult({ schemaVersion: 2, strategy: "default", ...common, plan });
    expect(decoded.envelope.plan).toEqual(plan);
    expect(() =>
      decodeImproveResult({
        schemaVersion: 2,
        strategy: "default",
        ...common,
        plan: { ...plan, candidates: { ...plan.candidates, invented: 1 } },
      }),
    ).toThrow(/unknown field/);
    expect(() =>
      decodeImproveResult({
        schemaVersion: 2,
        strategy: "default",
        ...common,
        plan: { ...plan, effectiveRefs: [{ ...plan.effectiveRefs[0], lane: "invented" }] },
      }),
    ).toThrow(/lane/);
    expect(() =>
      decodeImproveResult({
        schemaVersion: 2,
        strategy: "default",
        ...common,
        plan: { ...plan, snapshot: { status: "invented", reason: "not real" } },
      }),
    ).toThrow(/snapshot.status/);
    expect(() =>
      decodeImproveResult({
        schemaVersion: 2,
        strategy: "default",
        ...common,
        plan: { ...plan, dispatch: true },
      }),
    ).toThrow(/dispatch/);
    expect(() =>
      decodeImproveResult({
        schemaVersion: 2,
        strategy: "default",
        ...common,
        plan: { ...plan, candidates: { ...plan.candidates, effective: 2 } },
      }),
    ).toThrow(/effectiveRefs.length/);
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
