// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { summarizeImproveRuns } from "../src/commands/health/improve-metrics";
import { openStateDatabase } from "../src/core/state-db";
import { recordImproveRun } from "../src/storage/repositories/improve-runs-repository";

describe("health v3 strategy metrics", () => {
  test("reads strategyFilteredRefs from v2 improve results", () => {
    const db = openStateDatabase();
    try {
      const now = new Date().toISOString();
      const result = {
        schemaVersion: 2 as const,
        ok: true,
        strategy: "nightly",
        scope: { mode: "all" as const },
        dryRun: false,
        memorySummary: { eligible: 1, derived: 0 },
        plannedRefs: [],
        actions: [],
        strategyFilteredRefs: [{ ref: "scripts/filtered", reason: "strategy_filtered_all_passes" as const }],
      };
      recordImproveRun(db, {
        id: "strategy-filtered-metric",
        startedAt: now,
        completedAt: now,
        stashDir: "/tmp/stash",
        dryRun: false,
        strategy: "nightly",
        scopeMode: "all",
        scopeValue: null,
        guidance: null,
        ok: true,
        result,
      });
      expect(summarizeImproveRuns(db, new Date(Date.now() - 60_000).toISOString()).metrics.strategyFilteredRefs).toBe(
        1,
      );
    } finally {
      db.close();
    }
  });
});
