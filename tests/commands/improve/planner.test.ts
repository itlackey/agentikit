// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { buildImproveExecutionPlan, selectEffectiveImproveRefs } from "../../../src/commands/improve/planner";
import type { ImproveEligibleRef } from "../../../src/core/improve-types";

function ref(name: string, eligibilitySource: ImproveEligibleRef["eligibilitySource"]): ImproveEligibleRef {
  return { ref: `memories/${name}`, reason: "scope-type", eligibilitySource };
}

describe("selectEffectiveImproveRefs", () => {
  test("shares the ranked limit and additive replay rule without mutating the snapshot", () => {
    const ordinary = ref("ordinary", "signal-delta");
    const distillOnly = ref("distill-only", "signal-delta");
    const replay = ref("replay", "replay");
    const ranked = [ordinary, distillOnly, replay];
    const before = structuredClone(ranked);

    const selection = selectEffectiveImproveRefs({
      rankedRefs: ranked,
      distillOnlyRefs: [distillOnly],
      limit: 1,
      replayBudget: 1,
    });

    expect(selection.loopRefs.map((entry) => entry.ref)).toEqual([ordinary.ref, replay.ref]);
    expect(selection.distillOnlyRefs.map((entry) => entry.ref)).toEqual([distillOnly.ref]);
    expect(selection.limitRemoved).toBe(1);
    expect(ranked).toEqual(before);
  });

  test("distinguishes an omitted cap from an explicit zero", () => {
    const ranked = [ref("a", "proactive"), ref("b", "proactive")];
    expect(
      selectEffectiveImproveRefs({ rankedRefs: ranked, distillOnlyRefs: [], replayBudget: 0 }).loopRefs,
    ).toHaveLength(2);
    expect(
      selectEffectiveImproveRefs({ rankedRefs: ranked, distillOnlyRefs: [], limit: 0, replayBudget: 0 }).loopRefs,
    ).toEqual([]);
  });

  test("counts refs removed by both the ordinary cap and the replay budget", () => {
    const ranked = [ref("ordinary-a", "scope"), ref("ordinary-b", "scope"), ref("replay", "replay")];
    const selection = selectEffectiveImproveRefs({
      rankedRefs: ranked,
      distillOnlyRefs: [],
      limit: 1,
      replayBudget: 0,
    });

    expect(selection.loopRefs.map((entry) => entry.ref)).toEqual(["memories/ordinary-a"]);
    expect(selection.limitRemoved).toBe(2);
  });

  test("reports the additive replay allowance separately from the ordinary and total ceilings", () => {
    const ordinary = ref("ordinary", "proactive");
    const replay = ref("replay", "replay");
    const plan = buildImproveExecutionPlan({
      dryRun: true,
      snapshot: { status: "ready", reason: "test snapshot" },
      rawInScope: 2,
      selectedRefs: [ordinary, replay],
      effectiveRefs: [ordinary, replay],
      distillOnlyRefs: new Set(),
      configuredLimits: { cli: 1 },
      effectiveLimit: 1,
      replayBudget: 1,
      gates: [],
      consolidation: {
        configured: {},
        effective: { enabled: false, minPoolSize: 2, chunkSize: 2 },
        poolSize: 0,
        candidatePoolSize: 0,
        gates: {
          profile: { passed: false, reason: "disabled" },
          minimumPool: { passed: false, reason: "disabled" },
          delta: { passed: false, reason: "disabled" },
        },
        wouldRun: false,
        reason: "disabled",
        estimatedChunks: 0,
      },
      stageConfig: {
        extract: { enabled: false, reason: "disabled" },
        graphExtraction: { enabled: false, reason: "disabled" },
        memoryInference: { enabled: false, reason: "disabled" },
      },
      triage: { enabled: false, configuredMode: "queue", mode: "queue", maxAcceptsPerRun: 0 },
    });

    expect(plan.limits).toEqual({
      configured: { cli: 1 },
      effective: 1,
      additiveReplayAllowance: 1,
      totalCeiling: 2,
    });
  });
});
