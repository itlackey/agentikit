// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure improve planning projections.
 *
 * Filesystem/database snapshot collection stays in `preparation.ts`; this leaf
 * receives immutable values and is shared by dry preview and live execution.
 * Keeping the limit/lane projection here prevents the two entry paths from
 * independently reconstructing "what would run".
 */

import type { ImproveEligibleRef, ImproveExecutionPlan, ImprovePlanGate } from "../../core/improve-types";

export interface EffectiveRefSelection {
  loopRefs: ImproveEligibleRef[];
  distillOnlyRefs: ImproveEligibleRef[];
  limitRemoved: number;
}

/**
 * Apply the final global cap to an already-ranked candidate snapshot.
 * Replay remains additive to the ordinary cap, matching the live #610 rule.
 */
export function selectEffectiveImproveRefs(args: {
  rankedRefs: readonly ImproveEligibleRef[];
  distillOnlyRefs: readonly ImproveEligibleRef[];
  limit?: number;
  replayBudget: number;
}): EffectiveRefSelection {
  const distillOnlySet = new Set(args.distillOnlyRefs.map((entry) => entry.ref));
  const reflectAndDistill = args.rankedRefs.filter((entry) => !distillOnlySet.has(entry.ref));
  const distillOnly = args.rankedRefs.filter((entry) => distillOnlySet.has(entry.ref));
  // Preserve the established live ordering: ordinary reflect-path refs first,
  // then distill-only refs, with the rank order stable inside each partition.
  const allLoopRefs = [...reflectAndDistill, ...distillOnly];
  const replay = allLoopRefs.filter((entry) => entry.eligibilitySource === "replay");
  const ordinary = allLoopRefs.filter((entry) => entry.eligibilitySource !== "replay");
  const selectedOrdinary = args.limit === undefined ? ordinary : ordinary.slice(0, args.limit);
  const loopRefs = [...selectedOrdinary, ...replay.slice(0, args.replayBudget)];
  return {
    loopRefs,
    distillOnlyRefs: distillOnly,
    limitRemoved: allLoopRefs.length - loopRefs.length,
  };
}

export interface ImprovePlanProjectionInput {
  dryRun: boolean;
  snapshot: ImproveExecutionPlan["snapshot"];
  rawInScope: number;
  selectedRefs: readonly ImproveEligibleRef[];
  effectiveRefs: readonly ImproveEligibleRef[];
  distillOnlyRefs: ReadonlySet<string>;
  configuredLimits: { cli?: number; profile?: number; reflect?: number };
  effectiveLimit?: number;
  replayBudget: number;
  gates: readonly ImprovePlanGate[];
  proactive?: ImproveExecutionPlan["proactive"];
  consolidation: ImproveExecutionPlan["consolidation"];
  stageConfig: {
    extract: { enabled: boolean; reason: string };
    graphExtraction: { enabled: boolean; reason: string };
    memoryInference: { enabled: boolean; reason: string };
  };
  triage: ImproveExecutionPlan["triage"];
}

/** Build the stable public plan DTO from one invocation's selector observation. */
export function buildImproveExecutionPlan(input: ImprovePlanProjectionInput): ImproveExecutionPlan {
  const effectiveRefs = input.effectiveRefs.map((entry) => ({
    ref: entry.ref,
    lane: input.distillOnlyRefs.has(entry.ref) ? ("distill-only" as const) : (entry.eligibilitySource ?? "unknown"),
    reason: entry.reason,
  }));
  return {
    mode: input.dryRun ? "estimate" : "execution",
    dispatch: !input.dryRun,
    snapshot: { ...input.snapshot },
    candidates: {
      rawInScope: input.rawInScope,
      selected: input.selectedRefs.length,
      effective: effectiveRefs.length,
    },
    limits: {
      configured: { ...input.configuredLimits },
      ...(input.effectiveLimit !== undefined ? { effective: input.effectiveLimit } : {}),
      additiveReplayAllowance: input.replayBudget,
      ...(input.effectiveLimit !== undefined ? { totalCeiling: input.effectiveLimit + input.replayBudget } : {}),
    },
    gates: input.gates.map((gate) => ({ ...gate })),
    effectiveRefs,
    ...(input.proactive
      ? {
          proactive: {
            ...input.proactive,
            configured: { ...input.proactive.configured },
            effective: { ...input.proactive.effective },
            selectedRefs: [...input.proactive.selectedRefs],
          },
        }
      : {}),
    consolidation: {
      ...input.consolidation,
      configured: { ...input.consolidation.configured },
      effective: { ...input.consolidation.effective },
      gates: {
        profile: { ...input.consolidation.gates.profile },
        minimumPool: { ...input.consolidation.gates.minimumPool },
        delta: { ...input.consolidation.gates.delta },
      },
    },
    stages: [
      {
        name: "consolidation",
        wouldRun: input.consolidation.wouldRun,
        reason: input.consolidation.reason,
      },
      {
        name: "extract",
        wouldRun: input.stageConfig.extract.enabled,
        reason: input.stageConfig.extract.reason,
      },
      {
        name: "graph-extraction",
        wouldRun: input.stageConfig.graphExtraction.enabled,
        reason: input.stageConfig.graphExtraction.reason,
      },
      {
        name: "memory-inference",
        wouldRun: input.stageConfig.memoryInference.enabled,
        reason: input.stageConfig.memoryInference.reason,
      },
    ],
    triage: { ...input.triage },
  };
}
