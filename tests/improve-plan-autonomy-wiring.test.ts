// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * D8 — `resolveImprovePlan` applies the autonomy gate.
 *
 * `tests/improve-autonomy-gate.test.ts` pins the gate's decisions in isolation.
 * This pins that the plan resolver actually USES it — the wiring, which a gate
 * with perfect unit tests can still be missing.
 *
 * The `consolidate` strategy is the discriminating fixture: consolidate is its
 * only LLM-backed process, so with autonomy OFF the gate disables it and the
 * plan resolves with no engine configured at all. With autonomy ON the same
 * call demands an engine and throws `LLM_NOT_CONFIGURED`. That asymmetry is
 * only possible if the gate runs BEFORE the LLM preflight, which is the
 * ordering the choke point depends on.
 */

import { describe, expect, test } from "bun:test";
import { resolveImprovePlan } from "../src/commands/improve/improve-strategies";
import { IMPROVE_AUTONOMY_CONFIG_KEY } from "../src/core/config/experimental";

const BASE = { configVersion: "0.9.0" } as unknown as Parameters<typeof resolveImprovePlan>[1];

function configWith(experimental?: { improveAutonomy?: boolean }): Parameters<typeof resolveImprovePlan>[1] {
  return { ...BASE, ...(experimental ? { experimental } : {}) } as Parameters<typeof resolveImprovePlan>[1];
}

describe("resolveImprovePlan applies the autonomy gate", () => {
  test("autonomy OFF disables consolidate and reports it", () => {
    const plan = resolveImprovePlan("consolidate", configWith());

    expect(plan.processes.consolidate.enabled).toBe(false);
    expect(plan.autonomyGated.map((g) => g.lane)).toEqual(["consolidate"]);
    expect(plan.autonomyGated[0]?.configKey).toBe(IMPROVE_AUTONOMY_CONFIG_KEY);
  });

  test("autonomy OFF needs no LLM engine, because the gate precedes the preflight", () => {
    // If the gate ran after buildImprovePlan this would throw LLM_NOT_CONFIGURED.
    expect(() => resolveImprovePlan("consolidate", configWith())).not.toThrow();
  });

  test("autonomy ON restores the lane, and then the engine really is required", () => {
    // The mirror of the previous case: with the lane enabled the preflight has
    // something to demand, which proves the OFF case was gated rather than
    // merely misconfigured.
    expect(() => resolveImprovePlan("consolidate", configWith({ improveAutonomy: true }))).toThrow(
      /requires an LLM engine/,
    );
  });

  // The "already review-first strategy reports no downgrades" case lives in
  // tests/improve-autonomy-gate.test.ts: asserting it here would need an
  // `engines` fixture purely to get past the preflight for reflect, which adds
  // setup without adding signal the three cases above do not already give.
});
