// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `akm improve` autonomy gate (D8).
 *
 * `akm improve` stays ON by default. What this gates is **autonomy** — the lanes
 * that mutate a user's assets without review. A blanket experimental gate on the
 * whole feature was rejected because it would have turned installed schedules
 * into no-ops and removed the only normal producer of memory inference and graph
 * extraction; gating the autonomy resolves that without removing the feature.
 *
 * Five lanes are gated. `sync.push` deliberately is NOT: it publishes
 * already-committed content to a remote the user configured for that purpose and
 * has its own `sync.push: false` / `--no-push` controls.
 *
 * Three lanes are reachable through the strategy config, so the gate downgrades
 * that config in one place ({@link applyAutonomyGate}) rather than scattering
 * checks through the run. Two — the memory-cleanup and contradiction passes —
 * bypass the plan entirely (their only guard is `shouldAnalyzeMemoryCleanup`,
 * which reads scope and eligible-memory count and no strategy flag at all), so
 * they ask {@link isAutonomyLaneAllowed} directly at their call sites.
 *
 * **A gated lane must never become a silent no-op.** That is the whole design
 * constraint: `applyAutonomyGate` returns every downgrade it made so the caller
 * can emit an `improve_skipped` event naming the lane and the config key, and so
 * `akm tasks doctor` and the health advisory can report it. Whatever a user would
 * have seen happen, they now see explained.
 */

import type { ImproveProfileConfig } from "../../core/config/config";
import {
  type ExperimentalConfigHolder,
  IMPROVE_AUTONOMY_CONFIG_KEY,
  isImproveAutonomyEnabled,
} from "../../core/config/experimental";

/** The lanes `experimental.improveAutonomy` gates. */
export const AUTONOMY_LANES = [
  "consolidate",
  "memoryInference",
  "triagePromote",
  "memoryCleanup",
  "contradiction",
] as const;

export type AutonomyLane = (typeof AUTONOMY_LANES)[number];

/** One downgrade the gate applied, in the form the skip event needs. */
export interface GatedLane {
  lane: AutonomyLane;
  /** The config key that would enable it — user-facing, so it comes from one constant. */
  configKey: string;
  /** Why it was skipped, phrased for an operator reading `tasks doctor`. */
  reason: string;
}

const LANE_REASONS: Record<AutonomyLane, string> = {
  consolidate: "merges memories and deletes the superseded files",
  memoryInference: "writes derived memory children and rewrites parent frontmatter",
  triagePromote: "auto-accepts queued proposals into the stash (downgraded to queue)",
  memoryCleanup: "rewrites belief-state frontmatter and moves files into the cleanup archive",
  contradiction: "writes contradiction edges and belief-state transitions",
};

function gatedLane(lane: AutonomyLane): GatedLane {
  return { lane, configKey: IMPROVE_AUTONOMY_CONFIG_KEY, reason: LANE_REASONS[lane] };
}

/**
 * True when a lane may mutate. Used by the two lanes that bypass the strategy
 * config; the other three are handled by {@link applyAutonomyGate}.
 */
export function isAutonomyLaneAllowed(_lane: AutonomyLane, config: ExperimentalConfigHolder | undefined): boolean {
  // Every lane shares one opt-in today. The parameter is kept so a call site
  // names the lane it is asking about — that name is what reaches the operator
  // in the skip event — and so a future per-lane split does not have to revisit
  // every caller.
  return isImproveAutonomyEnabled(config);
}

/**
 * Downgrade a strategy config to review-first unless autonomy is opted into.
 *
 * Returns the config to actually run plus every downgrade made. With autonomy on
 * the input is returned untouched and `gated` is empty.
 */
export function applyAutonomyGate(
  strategy: ImproveProfileConfig,
  config: ExperimentalConfigHolder | undefined,
): { config: ImproveProfileConfig; gated: GatedLane[] } {
  if (isImproveAutonomyEnabled(config)) return { config: strategy, gated: [] };

  const gated: GatedLane[] = [];
  const processes = { ...(strategy.processes ?? {}) };

  if (processes.consolidate?.enabled === true) {
    processes.consolidate = { ...processes.consolidate, enabled: false };
    gated.push(gatedLane("consolidate"));
  }
  if (processes.memoryInference?.enabled === true) {
    processes.memoryInference = { ...processes.memoryInference, enabled: false };
    gated.push(gatedLane("memoryInference"));
  }
  // Triage stays ENABLED — queued proposals are still triaged, they just are not
  // auto-accepted. Disabling it would remove review work the user asked for,
  // which is the opposite of what a review-first default should do.
  if (processes.triage?.applyMode === "promote") {
    processes.triage = { ...processes.triage, applyMode: "queue" };
    gated.push(gatedLane("triagePromote"));
  }

  return { config: { ...strategy, processes }, gated };
}
