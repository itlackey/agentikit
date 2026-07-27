// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The state.db schema migration registry. The MIGRATIONS array is the single
// append-only ordered source of truth: new migrations are APPENDED here and an
// existing fragment is NEVER renumbered or reordered (that would corrupt the
// schema_migrations ledger on already-deployed databases). The shared runner
// at src/storage/engines/sqlite-migrations.ts applies them in array order.
//
// SQUASH NOTE (W3-M, 2026-07): this registry previously carried 20 fragments
// (`001-initial-schema` … `020-three-db-cutover`), accumulated across the
// 0.9.0 development chunks. No akm release ever shipped with state.db in the
// picture — every one of those 20 bodies ran only in pre-release dev/test
// databases, so none of them is guarded by a real deployed
// `schema_migrations` ledger. They have been squashed into this single
// `001-initial-schema` fragment, which creates exactly the end-state schema
// the 20-migration chain used to produce (verified by diffing a database
// built from the old chain against one built from this migration — see the
// W3-M package report). A local dev stash created before this squash will
// have an old-shaped ledger that no longer checksum-matches; per the
// migration-safety contract below that reads as "inconsistent" and the
// stash must be recreated (delete and re-init) rather than migrated forward.
//
// Two things the old chain built are deliberately NOT reproduced here:
//   - `improve_gate_thresholds` (old migration 012): the WS-4 per-phase
//     auto-tune store. Its only readers/writers died with the 0.9.0
//     confidence-gate deletion; it survived only because the old chain was
//     append-only. See `src/storage/repositories/improve-runs-repository.ts`.
//   - `consolidation_judged` and `recombine_hypotheses` (old migrations 007
//     and 014) plus `asset_outcome.review_pressure` (part of old migration
//     010): all three were CREATEd by earlier fragments and then DROPped by
//     old migration 018 once their features were deleted in Chunk 7. They
//     never existed in any end-state schema, so the squash simply never
//     creates them.
//   - `improve_cycle_metrics.accepted_actions` (part of old migration 016):
//     a hand-off from the sibling package that deleted the CHURN alert class
//     (its only production writer hardcoded this input to the literal `0`,
//     and the design doc's real source was unreachable from the detector —
//     a feature that never once fired pre-release, unshipped rather than
//     fixed). The column would otherwise be a live NOT-NULL column with
//     exactly one possible value forever. NOTE: as of this squash,
//     `src/storage/repositories/canaries-repository.ts` still names this
//     column in its `insertCycleMetrics`/`queryRecentCycleMetrics`/
//     `getLatestCycleMetrics` SQL — that repository (and its callers in
//     `src/commands/improve/collapse-detector.ts` and
//     `src/commands/health/advisories.ts`) is owned by the collapse/churn
//     detector package, not this one, and must drop its own references to
//     this column before/alongside this migration change lands, or its
//     writes will fail closed with "no such column".
import type { Database } from "../../storage/database";
import { type Migration, runMigrations as runSqliteMigrations } from "../../storage/engines/sqlite-migrations";

export const STATE_MIGRATIONS: readonly Migration[] = [
  {
    id: "001-initial-schema",
    up: `
      -- ── events ──────────────────────────────────────────────────────────────
      --
      -- Replaces events.jsonl. Indexed (query) columns:
      --   id          INTEGER PK — monotonic rowid; replaces byte-offset cursor.
      --                            Callers store this as "sinceId" for resume.
      --   event_type  TEXT        — indexed; replaces the type filter in readEvents().
      --   ts          TEXT        — ISO-8601 UTC ms; indexed for range queries.
      --   ref         TEXT        — nullable asset ref; indexed for ref-scoped queries.
      --
      -- Extensible (metadata_json) columns:
      --   metadata_json TEXT      — JSON object storing all non-indexed payload
      --                             fields (tags, any future structured fields).
      --                             Maps directly to EventEnvelope.metadata.
      --
      -- TTL: rows where ts < NOW() - 90 days can be deleted by a maintenance job.
      -- No automatic deletion occurs here — callers call purgeOldEvents().
      --
      -- ADD COLUMN extension points (future migrations):
      --   ALTER TABLE events ADD COLUMN stash_dir TEXT DEFAULT NULL;
      --   ALTER TABLE events ADD COLUMN correlation_id TEXT DEFAULT NULL;
      --   ALTER TABLE events ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
      --
      CREATE TABLE IF NOT EXISTS events (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type     TEXT    NOT NULL,
        ts             TEXT    NOT NULL,
        ref            TEXT,
        metadata_json  TEXT    NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
      CREATE INDEX IF NOT EXISTS idx_events_ref  ON events(ref);
      CREATE INDEX IF NOT EXISTS idx_events_ts   ON events(ts);

      -- ── proposals ────────────────────────────────────────────────────────────
      --
      -- Replaces per-uuid JSON directories under <stashDir>/.akm/proposals/.
      --
      -- Indexed (query) columns:
      --   id          TEXT PK     — UUID (crypto.randomUUID()); stable directory name.
      --   stash_dir   TEXT        — absolute stash root; multi-stash installs need
      --                             this to partition proposal lists per stash.
      --   ref         TEXT        — target asset ref (e.g. "lessons/alpha");
      --                             indexed for ref-scoped queue views.
      --   status      TEXT        — "pending" | "accepted" | "rejected"; indexed
      --                             so pending-queue queries are fast.
      --   source      TEXT        — human-readable origin tag (e.g. "reflect").
      --   created_at  TEXT        — ISO-8601; used for ORDER BY created_at ASC.
      --   updated_at  TEXT        — ISO-8601; updated on accept/reject.
      --
      -- Large payload columns (NOT indexed):
      --   content     TEXT        — full markdown text; the proposal payload body.
      --   frontmatter_json TEXT   — JSON of parsed frontmatter (may be NULL when
      --                             the content has no frontmatter block).
      --
      -- Extensible (metadata_json) columns:
      --   metadata_json TEXT      — JSON object for future proposal fields.
      --                             Current fields stored here: sourceRun,
      --                             review, confidence, gateDecision (#577),
      --                             backupContent, eligibilitySource.
      --
      -- ADD COLUMN extension points (future migrations):
      --   ALTER TABLE proposals ADD COLUMN source_run TEXT DEFAULT NULL;
      --   ALTER TABLE proposals ADD COLUMN review_outcome TEXT DEFAULT NULL;
      --   ALTER TABLE proposals ADD COLUMN review_reason TEXT DEFAULT NULL;
      --   ALTER TABLE proposals ADD COLUMN review_decided_at TEXT DEFAULT NULL;
      --   ALTER TABLE proposals ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
      --
      CREATE TABLE IF NOT EXISTS proposals (
        id               TEXT    PRIMARY KEY,
        stash_dir        TEXT    NOT NULL,
        ref              TEXT    NOT NULL,
        status           TEXT    NOT NULL DEFAULT 'pending',
        source           TEXT    NOT NULL,
        created_at       TEXT    NOT NULL,
        updated_at       TEXT    NOT NULL,
        content          TEXT    NOT NULL DEFAULT '',
        frontmatter_json TEXT,
        metadata_json    TEXT    NOT NULL DEFAULT '{}'
      );

      -- Query patterns:
      --   SELECT … WHERE stash_dir = ? AND status = ?              → idx_proposals_stash_status
      --   SELECT … WHERE ref = ? AND status = ?                    → idx_proposals_ref_status
      --   SELECT … WHERE stash_dir = ? AND status = ? AND ref = ?
      --     AND source = ?   (transaction-scoped dedup probe)      → idx_proposals_stash_status_ref_source
      --   SELECT … WHERE id = ?                                    → PK
      CREATE INDEX IF NOT EXISTS idx_proposals_stash_status
        ON proposals(stash_dir, status);
      CREATE INDEX IF NOT EXISTS idx_proposals_ref_status
        ON proposals(ref, status);
      CREATE INDEX IF NOT EXISTS idx_proposals_stash_status_ref_source
        ON proposals(stash_dir, status, ref, source);

      -- ── task_history ─────────────────────────────────────────────────────────
      --
      -- Replaces per-task JSONL files under <cacheDir>/tasks/history/. A true
      -- per-run log: id is the AUTOINCREMENT primary key so every run appends a
      -- new row (task_id alone is NOT unique — the same task can run repeatedly).
      --
      -- Indexed (query) columns:
      --   id          INTEGER PK  — monotonic; one row per run.
      --   task_id     TEXT        — stable task identifier string; indexed, and
      --                             UNIQUE with started_at (same task cannot have
      --                             two runs starting at the same instant).
      --   status      TEXT        — terminal status (e.g. "completed", "failed",
      --                             "cancelled"); indexed for status-scoped queries.
      --   started_at  TEXT        — ISO-8601; indexed for time-range queries.
      --   target_kind TEXT        — kind of the target entity (e.g. "issue",
      --                             "workflow", "agent"); indexed for kind-scoped queries.
      --   target_ref  TEXT        — stable ref of the target entity; indexed for
      --                             per-target history lookups.
      --
      -- Non-indexed time columns:
      --   completed_at TEXT       — ISO-8601 or NULL if still running.
      --   failed_at    TEXT       — ISO-8601 or NULL.
      --
      -- Non-indexed diagnostic columns:
      --   log_path     TEXT       — absolute path to the task log file, if any.
      --
      -- Extensible (metadata_json) columns:
      --   metadata_json TEXT      — JSON object for future task fields (exit_code,
      --                             runner, priority, parent_task_id, …).
      --
      -- ADD COLUMN extension points (future migrations):
      --   ALTER TABLE task_history ADD COLUMN exit_code INTEGER DEFAULT NULL;
      --   ALTER TABLE task_history ADD COLUMN runner TEXT DEFAULT NULL;
      --   ALTER TABLE task_history ADD COLUMN parent_task_id TEXT DEFAULT NULL;
      --   ALTER TABLE task_history ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
      --
      CREATE TABLE IF NOT EXISTS task_history (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id       TEXT    NOT NULL,
        status        TEXT    NOT NULL,
        started_at    TEXT    NOT NULL,
        completed_at  TEXT,
        failed_at     TEXT,
        log_path      TEXT,
        target_kind   TEXT,
        target_ref    TEXT,
        metadata_json TEXT    NOT NULL DEFAULT '{}'
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_history_run
        ON task_history(task_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_task_history_task_id
        ON task_history(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_history_started
        ON task_history(started_at);
      CREATE INDEX IF NOT EXISTS idx_task_history_target
        ON task_history(target_kind, target_ref);
      CREATE INDEX IF NOT EXISTS idx_task_history_status
        ON task_history(status);

      -- ── improve_runs ─────────────────────────────────────────────────────────
      --
      -- Records every \`akm improve\` invocation as a durable row, replacing the
      -- legacy \`<stash>/.akm/runs/<runId>/improve-result.json\` artifact files.
      --
      -- The \`dry_run\` column is FIRST-CLASS and indexed so productivity audits can
      -- cleanly filter dry-run probes out of real-run analyses without parsing
      -- \`result_json\`. The dry-run/real-run artifact-trap (recorded in
      -- feedback_akm_dryrun_artifact_trap) was the specific motivating bug.
      --
      -- Indexed (query) columns:
      --   id            TEXT PK   — runId (\`buildImproveRunId()\` output).
      --   started_at    TEXT      — ISO-8601; indexed for time-range queries.
      --   stash_dir     TEXT      — absolute stash root; multi-stash scoping.
      --   dry_run       INTEGER   — 0/1; indexed for productivity audits.
      --   scope_mode    TEXT      — "all" | "type" | "ref"; indexed via composite
      --                              with stash_dir for stash-scoped scope queries.
      --   strategy      TEXT      — the selected improve strategy; indexed via
      --                              composite with started_at.
      --
      -- Non-indexed payload:
      --   completed_at  TEXT      — ISO-8601 or NULL if interrupted.
      --   profile       TEXT      — improve profile name (nullable).
      --   scope_value   TEXT      — type name or asset ref (nullable).
      --   guidance      TEXT      — user-provided guidance text, if any.
      --   ok            INTEGER   — 0/1; whether the run produced ok=true.
      --   result_json   TEXT      — full AkmImproveResult JSON.
      --   metrics_json  TEXT      — aggregate counts extracted from result, cheap
      --                              to query without parsing result_json.
      --
      -- Extensible (metadata_json) columns:
      --   metadata_json TEXT      — JSON object for future improve-run fields.
      --
      -- ADD COLUMN extension points (future migrations):
      --   ALTER TABLE improve_runs ADD COLUMN duration_ms INTEGER DEFAULT NULL;
      --   ALTER TABLE improve_runs ADD COLUMN host TEXT DEFAULT NULL;
      --
      -- TTL: rows where started_at < NOW() - 90 days can be deleted by
      -- \`purgeOldImproveRuns()\`. No automatic deletion occurs here.
      CREATE TABLE IF NOT EXISTS improve_runs (
        id            TEXT    PRIMARY KEY,
        started_at    TEXT    NOT NULL,
        completed_at  TEXT,
        stash_dir     TEXT    NOT NULL,
        dry_run       INTEGER NOT NULL DEFAULT 0,
        profile       TEXT,
        scope_mode    TEXT    NOT NULL,
        scope_value   TEXT,
        guidance      TEXT,
        ok            INTEGER NOT NULL,
        result_json   TEXT    NOT NULL,
        metrics_json  TEXT,
        metadata_json TEXT    NOT NULL DEFAULT '{}',
        strategy      TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_improve_runs_started
        ON improve_runs(started_at);
      CREATE INDEX IF NOT EXISTS idx_improve_runs_dry_run
        ON improve_runs(dry_run);
      CREATE INDEX IF NOT EXISTS idx_improve_runs_stash_scope
        ON improve_runs(stash_dir, scope_mode);
      CREATE INDEX IF NOT EXISTS idx_improve_runs_strategy_started
        ON improve_runs(strategy, started_at);

      -- ── extract_sessions_seen ────────────────────────────────────────────────
      --
      -- Tracks which platform sessions the extractor has processed, so the discovery
      -- pass in \`akm extract --since <window>\` skips sessions whose content hasn't
      -- changed since the last successful run.
      --
      -- Indexed (query) columns:
      --   harness          TEXT     — harness name (claude-code, opencode, ...).
      --   session_id       TEXT     — platform-native session identifier.
      --   processed_at     TEXT     — ISO-8601 UTC; when extract last ran on this session.
      --
      -- Non-indexed columns:
      --   session_ended_at TEXT     — session.endedAt at processing time; superseded
      --                                by content_hash below as the incrementality
      --                                signal, kept for forensics.
      --   outcome          TEXT     — "candidates_queued" | "no_candidates" |
      --                                "skipped" | "failed".
      --   candidate_count  INTEGER  — number of candidates the LLM produced.
      --   proposal_count   INTEGER  — number of proposals actually queued
      --                                (candidates may fail downstream validation).
      --   rationale        TEXT     — for "no_candidates", the LLM's explanation.
      --   source_run       TEXT     — sourceRun id for PROV-DM traceability.
      --   metadata_json    TEXT     — future-proofing (pre-filter stats, LLM
      --                                model+version, prompt token count, etc.).
      --   content_hash     TEXT     — content hash of the session; the byte-exact,
      --                                clock-independent incrementality signal.
      --                                NULL means "seen before content-hash
      --                                tracking existed → process once to backfill".
      --
      -- PK: (harness, session_id) — one row per session per harness. A re-extract
      -- updates the row in place via INSERT OR REPLACE.
      --
      -- TTL: no automatic deletion. Sessions stay tracked as long as the source
      -- session files exist on disk. Operator can \`DELETE FROM extract_sessions_seen
      -- WHERE processed_at < ?\` for cleanup if desired.
      CREATE TABLE IF NOT EXISTS extract_sessions_seen (
        harness          TEXT    NOT NULL,
        session_id       TEXT    NOT NULL,
        processed_at     TEXT    NOT NULL,
        session_ended_at TEXT,
        outcome          TEXT    NOT NULL,
        candidate_count  INTEGER NOT NULL DEFAULT 0,
        proposal_count   INTEGER NOT NULL DEFAULT 0,
        rationale        TEXT,
        source_run       TEXT,
        metadata_json    TEXT    NOT NULL DEFAULT '{}',
        content_hash     TEXT    DEFAULT NULL,
        PRIMARY KEY (harness, session_id)
      );

      CREATE INDEX IF NOT EXISTS idx_extract_sessions_harness
        ON extract_sessions_seen(harness);
      CREATE INDEX IF NOT EXISTS idx_extract_sessions_processed
        ON extract_sessions_seen(processed_at);

      -- ── proposal_fs_imports ──────────────────────────────────────────────────
      --
      -- One-shot ledger for the legacy filesystem→SQLite proposal import (#578).
      -- The legacy \`proposal.json\` import moved out of the live per-operation
      -- path and into the one-time migrator
      -- (\`scripts/akm-migrate/migrate/legacy/proposal-fs-import.ts\`), which no
      -- longer reads or writes this ledger; it is kept for a stash that already
      -- ran the live-path import before that move.
      --
      -- Indexed (query) columns:
      --   stash_dir    TEXT PK  — absolute stash root the import ran against.
      --
      -- Non-indexed columns:
      --   imported_at    TEXT     — ISO-8601 UTC; when the import completed.
      --   imported_count INTEGER  — rows actually inserted by the import.
      CREATE TABLE IF NOT EXISTS proposal_fs_imports (
        stash_dir      TEXT    PRIMARY KEY,
        imported_at    TEXT    NOT NULL,
        imported_count INTEGER NOT NULL DEFAULT 0
      );

      -- ── body_embeddings ──────────────────────────────────────────────────────
      --
      -- cacheHash-keyed body-embedding cache (WS-3a). Stores the embedding of the
      -- case-preserving stripped body so the dedup pre-pass and the consolidation
      -- clustering step share one computed vector per unique body, eliminating
      -- redundant embedding calls across runs.
      --
      -- Design:
      --   - PK is the \`cacheHash\` (sha256 of the stripped, case-preserving body).
      --   - \`embedding\` is a raw BLOB storing a Float32 array (384 floats × 4 B =
      --     1 536 B per entry for the default bge-small-en-v1.5 model; ~20 MB at
      --     13 k memories). This matches the native wire format and avoids JSON
      --     round-trip overhead.
      --   - \`model_id\` is MANDATORY. On mismatch (model changed) the entire table
      --     is dropped and rebuilt — stale vectors from the wrong metric space would
      --     produce silent cosine errors.
      --   - \`created_at\` is an INTEGER Unix ms timestamp for lazy orphan purges.
      --
      -- TTL: no automatic row deletion. Orphaned rows for bodies no longer in the
      -- stash stay until an operator prunes them.
      CREATE TABLE IF NOT EXISTS body_embeddings (
        content_hash TEXT    PRIMARY KEY,
        embedding    BLOB    NOT NULL,
        model_id     TEXT    NOT NULL,
        created_at   INTEGER NOT NULL
      );

      -- ── asset_salience (WS-1 salience vector) ───────────────────────────────
      --
      -- Per-asset salience vector persisted in state.db (canonical store).
      --
      -- Three independently-stored, independently-decayable sub-scores:
      --   encoding_salience  — intrinsic importance (Gap 1; v1 = type-weight stub).
      --   outcome_salience   — differential usefulness (WS-2).
      --   retrieval_salience — frequency × recency (the decayable term).
      --
      -- Plus the scalar projection for ranking:
      --   rank_score = (w_e·encoding + w_o·outcome + w_r·retrieval) × sizePenalty,
      --   normalized [0,1]. Every selector reads rank_score; individual sub-scores
      --   are available for telemetry and per-dimension thresholding.
      --
      -- Plasticity column:
      --   consecutive_no_ops INTEGER — number of consecutive improve cycles where
      --     this asset produced a no-op (reflect/distill produced no change).
      --     Dampens CONSOLIDATION-SELECTION only — intentionally NOT applied to
      --     rank_score (stable assets stay retrievable but skip LLM merge passes).
      --
      -- homeostatic_demoted_at INTEGER — last time retrieval_salience was demoted
      --   for this asset (WS-3b step 0a). NULL = never demoted (or re-promoted).
      --
      -- encoding_source TEXT — provenance of the stored encoding_salience (#644):
      --   "content" (distill-derived) or "type-stub" (fallback); NULL for legacy
      --   rows written before this column existed. \`upsertAssetSalience\` refuses
      --   to lower a "content" row to a "type-stub".
      --
      -- updated_at is an INTEGER Unix-ms timestamp for recency queries.
      --
      -- The canonical store is state.db, not frontmatter. An optional frontmatter
      -- mirror of the stable encodingSalience is allowed for portability (#608).
      --
      -- TTL: rows are overwritten on every run; orphaned rows for deleted assets
      -- accumulate harmlessly until an operator prunes them.
      CREATE TABLE IF NOT EXISTS asset_salience (
        asset_ref              TEXT    PRIMARY KEY,
        encoding_salience       REAL    NOT NULL DEFAULT 0.5,
        outcome_salience        REAL    NOT NULL DEFAULT 0.0,
        retrieval_salience      REAL    NOT NULL DEFAULT 0.0,
        rank_score               REAL    NOT NULL DEFAULT 0.0,
        consecutive_no_ops       INTEGER NOT NULL DEFAULT 0,
        updated_at                INTEGER NOT NULL DEFAULT 0,
        homeostatic_demoted_at    INTEGER DEFAULT NULL,
        encoding_source           TEXT    DEFAULT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_asset_salience_rank
        ON asset_salience(rank_score DESC);

      -- ── asset_outcome (WS-2 outcome loop) ────────────────────────────────────
      --
      -- Per-asset outcome loop persisted in state.db (S2 seam, WS-2).
      --
      -- Stores the differential "was this retrieval useful" signal so the salience
      -- vector's \`outcomeSalience\` sub-score (WS-1 \`W_OUTCOME\` term) is non-zero.
      --
      -- Columns:
      --   asset_ref TEXT PK             — \`type:name\` asset ref (FK to asset_salience).
      --   last_retrieved_at INTEGER     — Unix-ms of the most recent retrieval.
      --   retrieval_count INTEGER       — total retrieval count from the index DB.
      --   expected_retrieval_rate REAL  — EMA-smoothed expected count per cycle.
      --   negative_feedback_count INTEGER — cumulative negative-feedback events.
      --   accepted_change_count INTEGER — cumulative accepted proposals.
      --   outcome_score REAL            — differential outcome signal (can be negative).
      --   updated_at INTEGER            — Unix-ms timestamp of last update.
      --
      -- Design:
      --   - outcome_score is differential (prediction-error shaped), NOT a raw count,
      --     so it rewards assets that are retrieved MORE than their rolling mean AND
      --     accepted for change when retrieved. See outcome-loop.ts for the formula.
      --   - warm_start: seeded from utility EMA at row creation, clipped to [0, 0.3]
      --     so the first negative delta does not cause a spurious rank inversion.
      --   - Orphaned rows (deleted assets) accumulate harmlessly; operators can prune
      --     with \`DELETE FROM asset_outcome WHERE updated_at < ?\` if desired.
      CREATE TABLE IF NOT EXISTS asset_outcome (
        asset_ref                TEXT    PRIMARY KEY,
        last_retrieved_at        INTEGER NOT NULL DEFAULT 0,
        retrieval_count          INTEGER NOT NULL DEFAULT 0,
        expected_retrieval_rate  REAL    NOT NULL DEFAULT 0.0,
        negative_feedback_count  INTEGER NOT NULL DEFAULT 0,
        accepted_change_count    INTEGER NOT NULL DEFAULT 0,
        outcome_score            REAL    NOT NULL DEFAULT 0.0,
        updated_at               INTEGER NOT NULL DEFAULT 0
      );

      -- Sort assets by outcome_score DESC for outcomeSalience reads.
      CREATE INDEX IF NOT EXISTS idx_asset_outcome_score
        ON asset_outcome(outcome_score DESC);

      -- ── collapse/churn detector (R5) ─────────────────────────────────────────
      --
      -- Longitudinal store-health history for the improve pipeline
      -- (docs/architecture/specs/improve-collapse-churn-detector-design.md).
      --
      --   canary_queries — the fixed canary set, minted deterministically from the
      --     live stash on first detector run and NEVER auto-refreshed (silent
      --     re-baselining is how a slow collapse hides). \`canary_set_id\` groups one
      --     mint; deactivated sets keep their rows (active = 0) so historical cycle
      --     rows stay interpretable. Tens of rows; never purged.
      --
      --   improve_cycle_metrics — one row per qualifying improve cycle (a run where
      --     consolidate processed ≥1 op). Every column is a scalar or a size-capped
      --     JSON blob (< 2 KB/row by construction). Retention: 365 days via
      --     purgeOldCycleMetrics. Trend queries drive the collapse/churn alert
      --     evaluation and the health advisory; \`canary_set_id\` scoping prevents
      --     comparing across canary re-mints.
      CREATE TABLE IF NOT EXISTS canary_queries (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        canary_set_id TEXT    NOT NULL,
        anchor_ref    TEXT    NOT NULL,
        query         TEXT    NOT NULL,
        source        TEXT    NOT NULL DEFAULT 'auto',
        active        INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_canary_queries_active
        ON canary_queries(active, canary_set_id);

      CREATE TABLE IF NOT EXISTS improve_cycle_metrics (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id                  TEXT    NOT NULL,
        ts                      TEXT    NOT NULL,
        pass                    TEXT    NOT NULL,
        canary_set_id           TEXT    NOT NULL,
        mean_recall             REAL    NOT NULL,
        mean_ndcg               REAL    NOT NULL,
        mean_mrr                REAL    NOT NULL,
        canary_ranks_json       TEXT    NOT NULL,
        store_total             INTEGER NOT NULL,
        store_by_type_json      TEXT    NOT NULL,
        distinct_content_ratio  REAL    NOT NULL,
        mean_bigram_diversity   REAL    NOT NULL,
        over_generation_count   INTEGER NOT NULL,
        merge_floor_violations  INTEGER NOT NULL DEFAULT 0,
        alerts_json             TEXT    NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_improve_cycle_metrics_ts
        ON improve_cycle_metrics(ts);

      -- ── proposal_fingerprints ────────────────────────────────────────────────
      --
      -- Durable store for the §23.6 input fingerprints that replace the
      -- dedup/cooldown content-hash machinery: one row per processed
      -- fingerprint (scheme version + source + target ref + target before-hash +
      -- reserved evidence/guidance/evaluator terms + engine/model-id term). A
      -- matching fingerprint skips re-processing the same inputs unless
      -- explicitly forced; rows are pruned with the proposal retention window.
      -- Rejection backoff (the retained cooldown) keeps reading the proposals
      -- table itself and needs no schema.
      CREATE TABLE IF NOT EXISTS proposal_fingerprints (
        stash_dir TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        ref TEXT NOT NULL,
        source TEXT NOT NULL,
        model_id TEXT NOT NULL DEFAULT '',
        proposal_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (stash_dir, fingerprint)
      );
      CREATE INDEX IF NOT EXISTS idx_proposal_fingerprints_ref
        ON proposal_fingerprints(stash_dir, ref);

      -- ── three-DB cutover baseline DDL ────────────────────────────────────────
      --
      -- The state.db half of the three-DB merge (workflow.db + index.db +
      -- state.db collapsed to state.db alone). This DDL is additive
      -- (\`CREATE TABLE IF NOT EXISTS\` + indexes) only — the actual data
      -- movement (the workflow.db merge, the usage_events rescue from
      -- index.db, the old-ref→item_ref re-key, and the workflow.db delete /
      -- index.db quarantine) is CODE, a journaled step of the migrate-apply
      -- flow (\`scripts/akm-migrate/config-migrate.ts\` \`cutover-applied\` phase),
      -- driven by \`scripts/akm-migrate/migrate/legacy/three-db-cutover.ts\`.
      --
      -- \`workflow_runs\` / \`workflow_run_steps\` / \`workflow_run_units\` mirror the
      -- frozen pre-cutover workflow.db schema
      -- (\`scripts/akm-migrate/migrate/legacy/workflow-migrations-bodies.ts\`) at
      -- its final shape. \`usage_events\` mirrors index.db's former
      -- \`ensureUsageEventsSchema\` (\`src/indexer/usage/usage-events.ts\`), its new
      -- durable home. \`legacy_state\` mirrors \`ensureLegacyStateTable\`
      -- (\`src/storage/repositories/index-entries-repository.ts\`), the orphan
      -- quarantine archive re-homed from index.db.
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id                  TEXT PRIMARY KEY,
        workflow_ref        TEXT NOT NULL,
        workflow_entry_id   INTEGER,
        workflow_title      TEXT NOT NULL,
        status              TEXT NOT NULL CHECK (status IN ('active', 'completed', 'blocked', 'failed')),
        params_json         TEXT NOT NULL DEFAULT '{}',
        current_step_id     TEXT,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        completed_at        TEXT,
        scope_key           TEXT,
        agent_harness       TEXT,
        agent_session_id    TEXT,
        checkin_armed_at    TEXT,
        plan_json           TEXT,
        plan_hash           TEXT,
        engine_lease_until  TEXT,
        engine_lease_holder TEXT,
        plan_ir_version     INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_ref ON workflow_runs(workflow_ref);
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_scope_ref_status
        ON workflow_runs(scope_key, workflow_ref, status);
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_agent_session
        ON workflow_runs(agent_harness, agent_session_id);

      CREATE TABLE IF NOT EXISTS workflow_run_steps (
        run_id          TEXT NOT NULL,
        step_id         TEXT NOT NULL,
        step_title      TEXT NOT NULL,
        instructions    TEXT NOT NULL,
        completion_json TEXT,
        sequence_index  INTEGER NOT NULL,
        status          TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'blocked', 'failed', 'skipped')),
        notes           TEXT,
        evidence_json   TEXT,
        completed_at    TEXT,
        summary         TEXT,
        PRIMARY KEY (run_id, step_id),
        FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_run_sequence
        ON workflow_run_steps(run_id, sequence_index);

      CREATE TABLE IF NOT EXISTS workflow_run_units (
        run_id           TEXT NOT NULL,
        unit_id          TEXT NOT NULL,
        step_id          TEXT,
        node_id          TEXT NOT NULL,
        parent_unit_id   TEXT,
        phase            TEXT,
        runner           TEXT,
        model            TEXT,
        status           TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
        input_hash       TEXT,
        result_json      TEXT,
        tokens           INTEGER,
        failure_reason   TEXT,
        worktree_path    TEXT,
        started_at       TEXT,
        finished_at      TEXT,
        session_id       TEXT,
        last_checkin_at  TEXT,
        attempts         INTEGER NOT NULL DEFAULT 1,
        claim_holder     TEXT,
        claim_expires_at TEXT,
        engine           TEXT,
        PRIMARY KEY (run_id, unit_id),
        FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_workflow_run_units_run_step
        ON workflow_run_units(run_id, step_id);

      CREATE TABLE IF NOT EXISTS usage_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        query      TEXT,
        entry_id   INTEGER,
        entry_ref  TEXT,
        signal     TEXT,
        metadata   TEXT,
        source     TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_usage_events_entry ON usage_events(entry_id);
      CREATE INDEX IF NOT EXISTS idx_usage_events_type ON usage_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_usage_events_ref ON usage_events(entry_ref);
      CREATE INDEX IF NOT EXISTS idx_usage_events_source ON usage_events(source);

      CREATE TABLE IF NOT EXISTS legacy_state (
        surface        TEXT NOT NULL,
        old_ref        TEXT NOT NULL,
        row_count      INTEGER NOT NULL DEFAULT 0,
        reason         TEXT NOT NULL,
        quarantined_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (surface, old_ref)
      );
    `,
  },
];

/**
 * Apply every pending migration in a single transaction per migration.
 *
 * Delegates to the shared SQLite migration engine; state.db has no
 * pre-versioning bootstrap step, so no `bootstrap` hook is passed.
 *
 * Called automatically by `openStateDatabase()`.
 */
export function runMigrations(
  db: Database,
  options?: { applyPending?: boolean; generationMarker?: { operationId: string; phase: string } },
): void {
  runSqliteMigrations(db, STATE_MIGRATIONS, {
    applyPending: options?.applyPending,
    generationMarker: options?.generationMarker,
  });
}
