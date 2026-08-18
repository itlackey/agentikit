// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * State.db-backed health metrics for `akm health`: the round-trip probe,
 * denominator-fixed coverage, the enrichment-vs-minting rollup, and the WS-5
 * per-run degradation metrics.
 */

import { rethrowIfTestIsolationError } from "../../core/errors";
import { decodeImproveResult } from "../../core/improve-result";
import { withStateDb } from "../../core/state-db";
import type { Database } from "../../storage/database";
import { insertEvent } from "../../storage/repositories/events-repository";
import { queryImproveRuns } from "../../storage/repositories/improve-runs-repository";
import { listStateProposals } from "../../storage/repositories/proposals-repository";
import { getObservedRetrievalSalience } from "../../storage/repositories/salience-repository";
import { roundRate, toFiniteNumber } from "./improve-metrics";
import {
  ENRICHMENT_LANES,
  type EnrichmentMintingRollup,
  type ImproveDegradationMetrics,
  type ImproveHealthMetrics,
  type OracleSpotCheckEntry,
} from "./types";

/** Event type appended + read back by the state.db round-trip probe. */
const HEALTH_PROBE_EVENT = "health_probe";

/**
 * Retrieval-salience Gini guardrails.
 *
 * These are distribution-shape thresholds, not quantiles tied to a corpus
 * size. Synthetic anchors pinned in monitor-liveness.test.ts are ~0.01 for a
 * near-uniform two-band distribution, 0.25 for a balanced 0.25/0.75 spread,
 * and ~0.82 for one dominant value among nine 0.01 values. Full-observation
 * production snapshots also sit stably in the neutral band: 0.2613 at n=1,209
 * (2026-07-12) and 0.2506 at n=1,454 (2026-08-17, missing rows excluded).
 */
const SALIENCE_UNIFORMITY_GINI_THRESHOLD = 0.08;
const SALIENCE_ENTRENCHMENT_GINI_THRESHOLD = 0.35;

/** Synthetic sentinel ref (ref-grammar decision D-R3): a colon-free
 * `<subsystem>/_<marker>` label. `health` has no asset stash-subdir, so
 * `health/_probe` names the subsystem. */
const HEALTH_PROBE_REF = "health/_probe";

/**
 * Verify state.db can accept a write and read it back — WITHOUT leaving any
 * permanent trace (R-030). Earlier versions appended a `health_probe` event
 * on every `akm health` invocation and never removed it: a read-only health
 * check ran on a cron would grow state.db without bound (the only purge is
 * `improve`'s retention pass, which a health-only user never runs). The probe
 * row inserted here is deleted again inside the SAME connection once the
 * round trip is confirmed, so the net effect on the `events` table is always
 * zero rows — the round trip still genuinely exercises append + read against
 * the real table, it just doesn't accumulate.
 */
export function probeStateDbRoundTrip(stateDbPath: string): { ok: boolean; durationMs: number | null; error?: string } {
  const started = Date.now();
  try {
    return withStateDb(
      (db) => {
        const ts = new Date().toISOString();
        const insertedId = insertEvent(db, {
          eventType: HEALTH_PROBE_EVENT,
          ts,
          ref: HEALTH_PROBE_REF,
          metadata: { source: "akm health" },
        });
        const durationMs = Date.now() - started;
        if (insertedId === undefined) {
          return { ok: false, durationMs, error: "probe event insert did not return a row id" };
        }
        // The round-trip matches on the exact (id, eventType, ref) triple
        // written above, then removes the row regardless of outcome — a
        // failed round trip must not leak a row any more than a successful
        // one should.
        let roundTripOk = false;
        try {
          const row = db
            .prepare("SELECT 1 AS present FROM events WHERE id = ? AND event_type = ? AND ref = ?")
            .get(insertedId, HEALTH_PROBE_EVENT, HEALTH_PROBE_REF) as { present: number } | undefined;
          roundTripOk = row !== undefined;
        } finally {
          db.prepare("DELETE FROM events WHERE id = ?").run(insertedId);
        }
        if (!roundTripOk) {
          return { ok: false, durationMs, error: "probe event was not readable after append" };
        }
        return { ok: true, durationMs };
      },
      { path: stateDbPath },
    );
  } catch (err) {
    rethrowIfTestIsolationError(err);
    return { ok: false, durationMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── WS-5 Observability helpers ───────────────────────────────────────────────

/**
 * Compute WS-5 denominator-fixed coverage metrics.
 *
 * `coverage = accepted_proposals / total_assets` (Part V §3).
 * The denominator is the TOTAL stash size (not the moving eligible set) so
 * more-inclusive WS-1 ranking cannot spuriously inflate coverage.
 * `eligibleFraction = eligible_assets / total_assets` is reported separately.
 *
 * Proposals are counted only when their `updatedAt` falls within `[since, until)`
 * so the rate is genuinely window-scoped (matching the JSDoc on the type).
 *
 * @param db - Open state.db connection.
 * @param totalAssets - Total stash asset count (eligible + derived) from the
 *   most recent run's memorySummary. 0 = denominator unknown, returns NaN rates.
 * @param eligibleAssets - Eligible (non-derived) asset count from the most recent run.
 * @param since - Window start (ISO-8601). Proposals accepted before this are excluded.
 * @param until - Window end (ISO-8601, exclusive). Absent = open-ended (up to now).
 * @param stashDir - Optional: scope accepted proposals to one stash. Absent = all stashes.
 */
export function computeDenominatorFixedCoverage(
  db: Database,
  totalAssets: number,
  eligibleAssets: number,
  since: string,
  until?: string,
  stashDir?: string,
): ImproveHealthMetrics["coverage"] {
  let acceptedProposals = 0;
  let distinctRefs = 0;
  try {
    const proposals = listStateProposals(db, {
      status: "accepted",
      ...(stashDir ? { stashDir } : {}),
    }).filter((p) => {
      const updatedAt = p.updatedAt ?? "";
      if (updatedAt < since) return false;
      if (until !== undefined && updatedAt >= until) return false;
      return true;
    });
    acceptedProposals = proposals.length;
    // Coverage counts DISTINCT refs: N accepted rewrites of one asset are
    // churn, not coverage. The raw proposal count is kept alongside so the
    // churn ratio (proposals ÷ distinct refs) stays visible.
    distinctRefs = new Set(proposals.map((p) => p.ref)).size;
  } catch {
    // Fail open: table may not exist on older installs.
  }

  const churnRatio = distinctRefs > 0 ? roundRate(acceptedProposals / distinctRefs) : Number.NaN;

  if (totalAssets === 0) {
    return {
      rate: Number.NaN,
      eligibleFraction: Number.NaN,
      acceptedProposals,
      distinctRefs,
      churnRatio,
      totalAssets: 0,
    };
  }

  return {
    rate: roundRate(distinctRefs / totalAssets),
    eligibleFraction: roundRate(eligibleAssets / totalAssets),
    acceptedProposals,
    distinctRefs,
    churnRatio,
    totalAssets,
  };
}

/**
 * Compute the enrichment-vs-minting rollup over the window's accepted,
 * lane-attributed proposals (reporting-only; see {@link EnrichmentMintingRollup}).
 *
 * SQL-side `json_extract` keeps the (potentially large) `backupContent` blobs
 * out of process memory. Pre-Phase-6C rows without an `eligibilitySource`
 * cannot be lane-classified and are excluded. Fails open (undefined) when the
 * proposals table is absent.
 */
export function computeEnrichmentMintingRollup(
  db: Database,
  since: string,
  until?: string,
): EnrichmentMintingRollup | undefined {
  try {
    const rows = db
      .prepare(
        `SELECT
           json_extract(metadata_json, '$.eligibilitySource') AS lane,
           CASE WHEN json_extract(metadata_json, '$.backupContent') IS NULL THEN 1 ELSE 0 END AS is_minted,
           COUNT(*) AS cnt
         FROM proposals
         WHERE status = 'accepted'
           AND updated_at >= ?
           AND (? IS NULL OR updated_at < ?)
           AND json_extract(metadata_json, '$.eligibilitySource') IS NOT NULL
           AND json_extract(metadata_json, '$.eligibilitySource') != ''
         GROUP BY lane, is_minted`,
      )
      .all(since, until ?? null, until ?? null) as Array<{ lane: string; is_minted: number; cnt: number }>;
    if (rows.length === 0) return undefined;

    const byLane: Record<string, { minted: number; updated: number }> = {};
    for (const row of rows) {
      byLane[row.lane] ??= { minted: 0, updated: 0 };
      const entry = byLane[row.lane]!;
      if (row.is_minted === 1) entry.minted += row.cnt;
      else entry.updated += row.cnt;
    }

    let minted = 0;
    let updated = 0;
    for (const lane of ENRICHMENT_LANES) {
      const entry = byLane[lane];
      if (!entry) continue;
      minted += entry.minted;
      updated += entry.updated;
    }
    const decided = minted + updated;
    return {
      minted,
      updated,
      share: decided > 0 ? roundRate(minted / decided) : Number.NaN,
      byLane,
    };
  } catch {
    // Fail open: proposals table may not exist on older installs.
    return undefined;
  }
}

/**
 * Compute WS-5 per-run degradation metrics (Part V §4).
 *
 * Health VIEWS only — reads from state.db tables populated by prior improve
 * runs. Gracefully returns partial data when tables are absent (pre-WS-1/2).
 *
 * @param db - Open state.db connection.
 * @param since - Window start (ISO-8601).
 * @param until - Window end (ISO-8601).
 */
export function computeDegradationMetrics(
  db: Database,
  since: string,
  until: string,
): ImproveDegradationMetrics | undefined {
  // (a) Corpus diversity — distribution of every observed retrieval-salience
  // value for a currently resolvable asset. Zero is the no-observation floor
  // and is excluded: the diagnostic measures discrimination among assets that
  // have a retrieval signal, not corpus coverage.
  //
  // Do not preselect by rank_score here. The old top-100 sample truncated the
  // distribution before measuring it, producing a low Gini even when the full
  // observed corpus had a healthy spread.
  let corpusCentroidDistance = Number.NaN;
  let retrievalSalienceSampleSize = 0;
  let entrenchmentFlagged: boolean | undefined;
  let salienceUniformityFlagged: boolean | undefined;
  try {
    // Fail-open: the asset_salience table may not exist yet (pre-WS-1 install).
    const rows = getObservedRetrievalSalience(db);
    retrievalSalienceSampleSize = rows.length;
    if (rows.length >= 5) {
      // The repository returns ascending values. Keep a defensive sort so the
      // O(n log n) closed-form Gini remains correct if that contract changes.
      const vals = rows.map((r) => r.retrieval_salience).sort((a, b) => a - b);
      const n = vals.length;
      const sum = vals.reduce((acc, value) => acc + value, 0);
      const weightedSum = vals.reduce((acc, value, index) => acc + (index + 1) * value, 0);
      // Closed-form Gini for sorted non-negative values. This is O(n log n)
      // including the defensive sort; the previous pairwise implementation
      // was O(n²) and only safe because the sample was capped at 100.
      const gini = sum > 0 ? (2 * weightedSum) / (n * sum) - (n + 1) / n : 0;
      // Re-express as a diversity proxy in [0,1]: high gini = low diversity.
      // corpusCentroidDistance approximation: gini is "distance from uniform".
      // Two-tailed: high concentration flags entrenchment; very low spread
      // flags near-uniformity. Calibration provenance is documented with the
      // constants above and pinned by synthetic distribution tests.
      corpusCentroidDistance = roundRate(gini);
      entrenchmentFlagged = gini > SALIENCE_ENTRENCHMENT_GINI_THRESHOLD;
      salienceUniformityFlagged = gini < SALIENCE_UNIFORMITY_GINI_THRESHOLD;
    }
  } catch {
    // Table not present (pre-WS-1 install) — leave NaN.
  }

  // (b) Merge fidelity — fraction of consolidate accepted proposals in the window
  // whose ref also has a consolidate skip-reason of "contradict_target_missing"
  // or an event indicating contradiction. Uses the improve_runs result_json
  // consolidation.contradicted count as a proxy.
  // Simple implementation: contradictionRate = total_contradicted / max(1, total_processed)
  // sourced from the window's consolidation envelope.
  // (The full "merge proposal → later contradiction" correlation requires cross-run
  // history; this is the available proxy.)
  let mergeFidelityContradictionRate = 0;
  try {
    const runs = queryImproveRuns(db, since, until);
    let totalContradicted = 0;
    let totalProcessed = 0;
    for (const row of runs) {
      try {
        const result = decodeImproveResult(row.result_json).envelope as unknown as Record<string, unknown>;
        const cons = result.consolidation as Record<string, unknown> | undefined;
        if (cons) {
          totalContradicted += toFiniteNumber(cons.contradicted);
          totalProcessed += toFiniteNumber(cons.processed);
        }
      } catch {
        // Skip malformed rows.
      }
    }
    if (totalProcessed > 0) {
      mergeFidelityContradictionRate = roundRate(totalContradicted / totalProcessed);
    }
  } catch {
    // Fail open.
  }

  // (c) highGenerationFraction was DELETED (meta-review 05 DRIFT-3): it
  // approximated "LLM-merge generations" from consecutive_no_ops — which counts
  // the opposite condition (cycles where nothing was changed) — and its own
  // in-code TODO admitted the proxy. Display-only, never actionable; removed
  // rather than instrumented.

  // (d) Oracle spot-check — up to 5 recently accepted proposals in the window.
  const oracleSpotCheck: OracleSpotCheckEntry[] = [];
  try {
    const accepted = listStateProposals(db, { status: "accepted" }).filter((p) => {
      const updatedAt = p.updatedAt ?? "";
      return updatedAt >= since && updatedAt < until;
    });
    // Sample up to 5: pick evenly spaced (not just the first 5).
    const step = Math.max(1, Math.floor(accepted.length / 5));
    for (let i = 0; i < accepted.length && oracleSpotCheck.length < 5; i += step) {
      const p = accepted[i];
      if (p) {
        oracleSpotCheck.push({
          proposalId: p.id,
          ref: p.ref,
          source: p.source ?? "unknown",
          acceptedAt: p.updatedAt ?? p.createdAt ?? "",
        });
      }
    }
  } catch {
    // Fail open.
  }

  return {
    corpusCentroidDistance,
    retrievalSalienceSampleSize,
    entrenchmentFlagged,
    salienceUniformityFlagged,
    mergeFidelityContradictionRate,
    oracleSpotCheck,
  };
}
