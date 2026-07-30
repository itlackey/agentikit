// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Inspect, or explicitly re-mint, the R5 collapse-detector canary set
 * (docs/architecture/specs/improve-collapse-churn-detector-design.md). The
 * detector NEVER auto-refreshes the canary set (silent re-baselining is how a
 * slow collapse hides), so this is the only re-baseline path.
 *
 * Maintainer tooling (STABILITY.md "Internal"): this used to ship as the
 * `akm improve canary [--refresh]` subcommand. It is operator-facing
 * maintenance, not part of an improve run, so it lives here instead —
 * `scripts/` may import `src/`, never the reverse.
 *
 * Usage:
 *   bun scripts/refresh-canary-set.ts [--refresh]
 *
 *   --refresh   Mint a new canary set and deactivate the old one; old rows
 *               and their cycle history are retained. Without this flag,
 *               only inspects the currently active set.
 *   --help      Print this usage and exit
 *
 * Prints a JSON summary ({ refreshed, warning?, canarySetId, canaries,
 * recentCycles }) to stdout.
 */

import { parseArgs } from "node:util";
import { refreshCanarySet } from "../src/commands/improve/collapse-detector";
import { loadConfig } from "../src/core/config/config";
import { withStateDb } from "../src/core/state-db";
import { getActiveCanaries, queryRecentCycleMetrics } from "../src/storage/repositories/canaries-repository";
import { closeDatabase, openExistingDatabase } from "../src/storage/repositories/index-connection";

export interface CanaryInspectionResult {
  refreshed: boolean;
  warning?: string;
  canarySetId: string | null;
  canaries: Array<{ id: number; anchorRef: string; query: string }>;
  recentCycles: Array<{
    ts: string;
    pass: string;
    meanRecall: number;
    meanNdcg: number;
    distinctContentRatio: number;
    mergeFloorViolations: number;
    alerts: string[];
  }>;
}

export function inspectCanarySet(options?: { refresh?: boolean }): CanaryInspectionResult {
  const config = loadConfig();
  const cfg = config.improve?.collapseDetector ?? {};

  return withStateDb((stateDb) => {
    let refreshOutcome: "refreshed" | "kept-old-set" | undefined;
    if (options?.refresh) {
      const indexDb = openExistingDatabase();
      try {
        // Mint-first, deactivate-after (refreshCanarySet): an empty/unreadable
        // index keeps the old baseline instead of destroying it.
        refreshOutcome = refreshCanarySet(stateDb, indexDb, cfg) === null ? "kept-old-set" : "refreshed";
      } finally {
        closeDatabase(indexDb);
      }
    }
    const canaries = getActiveCanaries(stateDb);
    const canarySetId = canaries[0]?.canary_set_id;
    const recentCycles = canarySetId ? queryRecentCycleMetrics(stateDb, canarySetId, cfg.windowCycles ?? 5) : [];
    return {
      refreshed: refreshOutcome === "refreshed",
      ...(refreshOutcome === "kept-old-set"
        ? { warning: "refresh skipped: no mintable learning entries in the index — existing canary set kept" }
        : {}),
      canarySetId: canarySetId ?? null,
      canaries: canaries.map((c) => ({ id: c.id, anchorRef: c.anchor_ref, query: c.query })),
      recentCycles: recentCycles.map((r) => ({
        ts: r.ts,
        pass: r.pass,
        meanRecall: r.mean_recall,
        meanNdcg: r.mean_ndcg,
        distinctContentRatio: r.distinct_content_ratio,
        mergeFloorViolations: r.merge_floor_violations,
        alerts: JSON.parse(r.alerts_json) as string[],
      })),
    };
  });
}

const USAGE = `Usage: bun scripts/refresh-canary-set.ts [options]

  --refresh   Mint a new canary set and deactivate the old one (old rows
              and their cycle history are retained)
  --help      Print this usage and exit
`;

function main(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      refresh: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  const result = inspectCanarySet({ refresh: values.refresh });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
