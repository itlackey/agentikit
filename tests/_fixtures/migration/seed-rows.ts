// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Row-level seeding helpers shared by the chunk-0b migration DB fixture
 * builders (`orphan-state.ts`, `rc-train-state.ts`).
 *
 * Both builders apply the REAL migration chain (via
 * `src/core/state-db.ts#openStateDatabase` — never hand-written DDL) and then
 * insert rows into `asset_salience` / `asset_outcome`. This module centralizes
 * the exact, HEAD-verified column lists so there is exactly one place that
 * INSERT statement lives, instead of two copies that could silently drift out
 * of sync with the live schema.
 *
 * Column sets verified directly against `src/core/state/migrations.ts` at
 * chunk-0b's capture HEAD (`3c178568`, 2026-07-17):
 *
 *   - `asset_salience` (migration `009-asset-salience` :507-523 CREATE TABLE,
 *     `011-asset-salience-homeostatic-demoted-at` :591-596 ADD COLUMN
 *     `homeostatic_demoted_at`, `015-asset-salience-encoding-source` :715-720
 *     ADD COLUMN `encoding_source`): asset_ref, encoding_salience,
 *     outcome_salience, retrieval_salience, rank_score, consecutive_no_ops,
 *     updated_at, homeostatic_demoted_at, encoding_source. Nothing dropped.
 *
 *   - `asset_outcome` (migration `010-asset-outcome` :555-577 CREATE TABLE;
 *     `review_pressure` DROPPED by migration `018-drop-dead-lane-schema`
 *     :803-813): asset_ref, last_retrieved_at, retrieval_count,
 *     expected_retrieval_rate, negative_feedback_count, accepted_change_count,
 *     outcome_score, updated_at. `review_pressure` is NOT a live column at
 *     this HEAD — it must never appear in an INSERT here.
 */

import fs from "node:fs";
import path from "node:path";
import { STATE_MIGRATIONS } from "../../../src/core/state/migrations";
import { type Database, openDatabaseFinalizing } from "../../../src/storage/database";
import { runMigrations as runSqliteMigrations } from "../../../src/storage/engines/sqlite-migrations";
import { applyStandardPragmas } from "../../../src/storage/sqlite-pragmas";

/**
 * Open a fully-migrated state.db via the real shared migration runner (never
 * hand-written DDL — the checksum stays sealed). Caller owns the returned
 * handle (seed, then close).
 *
 * W3-M note: this fixture used to be built at an explicit PRE-CUTOVER
 * ceiling id (`019-proposal-fingerprints`, a prefix of the old 20-fragment
 * STATE_MIGRATIONS chain), one migration short of the WI-8.2 three-DB cutover
 * DDL (the old `020-three-db-cutover`) — so the cutover-apply flow under test
 * had something to apply. That distinction no longer exists: the W3-M
 * migration squash folded the whole chain (including the cutover DDL) into a
 * single fragment, so there is no schema state between "unmigrated" and
 * "fully migrated" to pin a FROM-state fixture at. This is also a MORE
 * faithful FROM-state than the old ceiling ever was: even pre-squash, the
 * real `migrate apply` flow's `state-applied` phase always ran the FULL
 * pending chain (including 020) before the `cutover-applied` phase moved any
 * data — so by the time a real cutover ran, the DDL (workflow_runs,
 * usage_events, legacy_state, …) already existed, just empty. Building this
 * fixture at "fully migrated, no cutover data yet" reproduces exactly that.
 */
export function openFreshStateDb(dbPath: string): Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDatabaseFinalizing(dbPath);
  applyStandardPragmas(db, { dataDir: path.dirname(dbPath) });
  runSqliteMigrations(db, STATE_MIGRATIONS);
  return db;
}

export interface AssetSalienceSeedRow {
  assetRef: string;
  encodingSalience: number;
  outcomeSalience: number;
  retrievalSalience: number;
  rankScore: number;
  consecutiveNoOps: number;
  updatedAt: number;
  homeostaticDemotedAt: number | null;
  encodingSource: string | null;
}

export interface AssetOutcomeSeedRow {
  assetRef: string;
  lastRetrievedAt: number;
  retrievalCount: number;
  expectedRetrievalRate: number;
  negativeFeedbackCount: number;
  acceptedChangeCount: number;
  outcomeScore: number;
  updatedAt: number;
}

/** Insert one `asset_salience` row using the live (HEAD-verified) column set. */
export function insertAssetSalienceRow(db: Database, row: AssetSalienceSeedRow): void {
  db.prepare(
    `INSERT INTO asset_salience
       (asset_ref, encoding_salience, outcome_salience, retrieval_salience,
        rank_score, consecutive_no_ops, updated_at, homeostatic_demoted_at, encoding_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.assetRef,
    row.encodingSalience,
    row.outcomeSalience,
    row.retrievalSalience,
    row.rankScore,
    row.consecutiveNoOps,
    row.updatedAt,
    row.homeostaticDemotedAt,
    row.encodingSource,
  );
}

/**
 * Insert one `asset_outcome` row using the live (HEAD-verified) column set.
 * Deliberately has no `reviewPressure` field — that column was dropped by
 * migration 018 and must not be resurrected (chunk-0b brief trap list #6).
 */
export function insertAssetOutcomeRow(db: Database, row: AssetOutcomeSeedRow): void {
  db.prepare(
    `INSERT INTO asset_outcome
       (asset_ref, last_retrieved_at, retrieval_count, expected_retrieval_rate,
        negative_feedback_count, accepted_change_count, outcome_score, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.assetRef,
    row.lastRetrievedAt,
    row.retrievalCount,
    row.expectedRetrievalRate,
    row.negativeFeedbackCount,
    row.acceptedChangeCount,
    row.outcomeScore,
    row.updatedAt,
  );
}
