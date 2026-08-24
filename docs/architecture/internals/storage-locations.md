# AKM Storage Locations

This document is the authoritative reference for every location on disk where akm reads or writes persistent data: databases, event streams, config files, asset files, caches, locks, and OS-native task scheduler entries.

## Path Variables

All paths below use these resolved base directories:

| Variable | Default (Linux/macOS) | Default (Windows) | Override |
|---|---|---|---|
| `$CONFIG` | `~/.config/akm` | `%APPDATA%\akm` | `AKM_CONFIG_DIR` |
| `$CACHE` | `~/.cache/akm` | `%LOCALAPPDATA%\akm` | `AKM_CACHE_DIR` |
| `$DATA` | `~/.local/share/akm` | `%LOCALAPPDATA%\akm\data` | `AKM_DATA_DIR` |
| `$STATE` | `~/.local/state/akm` | `%LOCALAPPDATA%\akm\state` | `AKM_STATE_DIR` |
| `$STASH` | `~/akm` | `%USERPROFILE%\Documents\akm` | `AKM_BUNDLE_DIR` |

akm uses four XDG-compliant directories. Durable data (`index.db`, `state.db`, `akm.lock`) lives in `$DATA`; the event log is stored in the `events` table in `state.db`.

---

## SQLite Databases

### `$DATA/index.db` — Main Search Index

Schema managed by `ensureSchema()` (`src/storage/repositories/index-schema.ts`), gated by a `DB_VERSION` constant used only as a forensic stamp in `index_meta`. WAL mode, `busy_timeout = 5000 ms`, foreign keys ON. Optionally loads the `sqlite-vec` extension for fast ANN (approximate nearest-neighbour) vector search.

Opened by:
- `openDatabase()` — full schema init, called by `akm index`
- `openExistingDatabase()` — read/write without schema mutation, called by search/show/curate

**Retention:** `index.db` is a fully regenerable derived cache. Schema convergence is additive and non-destructive — every table is `CREATE ... IF NOT EXISTS`, column additions go through guarded `ALTER`s, and targeted migrations handle structural changes; there is no drop-and-recreate-on-version-mismatch path. `clearStaleCacheEntries()` removes orphaned LLM cache rows.

#### Table: `index_meta`

| Column | Type | Notes |
|---|---|---|
| `key` | TEXT PRIMARY KEY | Metadata key |
| `value` | TEXT NOT NULL | String-encoded value |

Known keys: `version` (stored DB_VERSION), `embeddingDim` (e.g. `"384"`), `hasEmbeddings` (`"0"` or `"1"`).

#### Table: `entries`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | Internal row ID |
| `entry_key` | TEXT NOT NULL UNIQUE | `<stash_dir>:<type>:<name>` (legacy identity column) |
| `dir_path` | TEXT NOT NULL | Parent directory of the asset file |
| `file_path` | TEXT NOT NULL | Absolute path to the asset file |
| `stash_dir` | TEXT NOT NULL | Root bundle directory |
| `entry_json` | TEXT NOT NULL | Full `StashEntry` as JSON |
| `search_text` | TEXT NOT NULL | Pre-built BM25 search string |
| `entry_type` | TEXT NOT NULL | Asset type: `memory`, `skill`, `lesson`, etc. |
| `derived_from` | TEXT | Set on entries derived from another asset (e.g. `.derived` memories) |
| `item_ref` | TEXT | Bundle-adapter identity: the durable `<bundle>//<concept-id>` spelling. Now the primary conflict target for the entries upsert; nullable only on partially-migrated rows. |
| `bundle_id`, `component_id`, `concept_id`, `adapter_id` | TEXT | Bundle-adapter provenance columns, additive alongside the legacy columns above |
| `type` | TEXT | Bundle-adapter item type (parallel to `entry_type`) |
| `content_hash` | TEXT | Content hash for change detection |
| `document_json` | TEXT | Bundle-adapter document payload |

Indexes: `idx_entries_dir` on `dir_path`, `idx_entries_type` on `entry_type`, `idx_entries_file_path` on `file_path`, a UNIQUE index on `item_ref`.

#### Virtual Table: `entries_fts` (FTS5)

BM25-weighted full-text search. Tokenizer: `porter unicode61`.

| Column | BM25 weight |
|---|---|
| `name` | 10.0 |
| `description` | 5.0 |
| `tags` | 3.0 |
| `hints` | 2.0 |
| `content` | 1.0 |

#### Table: `entries_fts_dirty`

| Column | Type | Notes |
|---|---|---|
| `entry_id` | INTEGER PRIMARY KEY | Entry needing FTS rebuild |

Dirty queue drained during incremental `akm index`. Avoids full FTS wipe on every run.

#### Table: `embeddings`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PRIMARY KEY | Matches `entries.id` |
| `embedding` | BLOB NOT NULL | Float32 vector, little-endian IEEE-754 |

Used by JS cosine-similarity fallback when `sqlite-vec` is absent.

#### Virtual Table: `entries_vec` (conditional)

Created only when `sqlite-vec` is loadable. Columns: `id INTEGER PRIMARY KEY`, `embedding FLOAT[<dim>]`. Dropped and recreated if embedding dimension changes.

#### Workflow source indexing

Peer `.md` and `.yml` workflow sources compile directly to source IR version 1.
The index stores the ordinary normalized `entries` row and metadata derived from
that IR; there is no workflow-specific AST cache or parallel persisted source
representation. Executable durable plans belong only to `state.db`.

#### Table: `index_dir_state`

| Column | Type | Notes |
|---|---|---|
| `dir_path` | TEXT PRIMARY KEY | Absolute path to the directory |
| `file_set_hash` | TEXT NOT NULL | Hash of file names in directory |
| `file_mtime_max_ms` | REAL NOT NULL | Max file mtime across directory (ms since epoch) |
| `reason` | TEXT NOT NULL | Human-readable description |
| `updated_at` | TEXT NOT NULL | ISO-8601 |

Incremental indexing cache. Directory skipped if hash + mtime unchanged.

#### Table: `llm_enrichment_cache`

| Column | Type | Notes |
|---|---|---|
| `asset_ref` | TEXT NOT NULL | Absolute file path or `entryKey:passId` |
| `cache_variant` | TEXT NOT NULL | Extractor/cache fingerprint. Graph extraction uses an extractor-specific variant; other passes currently use the empty-string default. |
| `body_hash` | TEXT NOT NULL | SHA-256 hex digest of file body |
| `result_json` | TEXT NOT NULL | Serialized LLM enrichment result |
| `updated_at` | INTEGER NOT NULL | Unix ms timestamp |

Primary key: `(asset_ref, cache_variant)`.

Cache miss on body change or cache-variant change. Stale rows removed by
`clearStaleCacheEntries()`. The cache can also be bypassed by internal forced
re-enrichment callers.

**What is cached:** metadata enhancement results, graph extraction (entities + relations), memory inference results.

#### Table: `utility_scores`

| Column | Type | Notes |
|---|---|---|
| `entry_id` | INTEGER PRIMARY KEY | FK → `entries(id)` ON DELETE CASCADE |
| `utility` | REAL NOT NULL DEFAULT 0 | Aggregated MemRL utility in [0, 1] |
| `show_count` | INTEGER NOT NULL DEFAULT 0 | Times shown in search results |
| `search_count` | INTEGER NOT NULL DEFAULT 0 | Searches that returned this entry |
| `select_rate` | REAL NOT NULL DEFAULT 0 | Fraction of shows that led to a selection |
| `last_used_at` | TEXT | ISO-8601; NULL if never selected |
| `updated_at` | TEXT NOT NULL | ISO-8601 |

A companion `utility_scores_scoped` table (`entry_id, scope_key` PK) tracks the
same EMA per `(entry, project-anchor)` pair so an asset useful in one project
doesn't pollute rankings in another; `utility_scores` is preserved as the
global fallback / cold-start signal.

See [Utility Score Pipeline](#utility-score-pipeline) below.

`usage_events` (search/show/feedback telemetry) is **not** an `index.db` table —
since the three-DB cutover (Chunk-8 WI-8.3) it lives in `state.db`. See the
`state.db` section below.

#### Table: `registry_index_cache`

Registry index cache: `registry_url` PK, `fetched_at`, `etag`, `last_modified`, `index_json`. TTL enforced by `getRegistryIndexCache()`. Replaces flat JSON files in `$CACHE/registry-index/`.

| Column | Type | Notes |
|---|---|---|
| `slug` | TEXT PRIMARY KEY | Same slug as former filename; registry URL with non-alphanumeric → `-`, max 120 chars |
| `body_json` | TEXT NOT NULL | Raw registry index JSON |
| `fetched_at` | TEXT NOT NULL | ISO-8601 |
| `fresh_until` | TEXT NOT NULL | ISO-8601; used for TTL check |
| `stale_until` | TEXT NOT NULL | ISO-8601; used for stale-fallback |

---

### Workflow Run State — tables in `$DATA/state.db`

The 0.9.0 cutover folded the former `$DATA/workflow.db` into `state.db`; the
`workflow_runs` / `workflow_run_steps` / `workflow_run_units` /
`workflow_run_unit_attempts` tables documented here now live in `state.db` (see
the `state.db` section below) and are deleted along with the physical
`workflow.db` by `akm migrate apply`. WAL mode, foreign keys ON. No automatic
cleanup — runs persist indefinitely.

#### Table: `workflow_runs`

New starts persist plan IR v4, the sole executable plan format. Pre-v4 stored
plans are rejected rather than upgraded or replayed through another runtime.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PRIMARY KEY | UUID v4 |
| `workflow_ref` | TEXT NOT NULL | e.g. `workflows/review-todos` |
| `scope_key` | TEXT | Directory hash; isolates runs per project |
| `workflow_entry_id` | INTEGER | Optional FK into `index.db entries.id` |
| `workflow_title` | TEXT NOT NULL | Human-readable title |
| `status` | TEXT NOT NULL | `active`, `completed`, `blocked`, `failed` |
| `params_json` | TEXT NOT NULL DEFAULT '{}' | Run parameters |
| `current_step_id` | TEXT | NULL when completed |
| `created_at` | TEXT NOT NULL | ISO-8601 |
| `updated_at` | TEXT NOT NULL | ISO-8601 |
| `completed_at` | TEXT | ISO-8601; NULL while active |
| `agent_harness`, `agent_session_id` | TEXT | Invoking harness/session identity, recorded at start (see the check-in mechanism in `docs/reference/workflows.md`) |
| `checkin_armed_at` | TEXT | ISO-8601 timestamp; a stall past the check-in window surfaces a `continue` directive on the next poll |
| `plan_json`, `plan_hash` | TEXT | Frozen executable plan and its integrity hash; current v4 plans include guarded source reads, immutable targets, and symbolic environment bindings |
| `engine_lease_until`, `engine_lease_holder` | TEXT | Engine concurrency lease bookkeeping for the run |
| `plan_ir_version` | INTEGER | Schema version of `plan_json`'s IR |

Indexes: `idx_workflow_runs_ref`, `idx_workflow_runs_status`, `idx_workflow_runs_scope_ref_status`, `idx_workflow_runs_agent_session`.

#### Table: `workflow_run_steps`

| Column | Type | Notes |
|---|---|---|
| `run_id` | TEXT NOT NULL | FK → `workflow_runs(id)` ON DELETE CASCADE |
| `step_id` | TEXT NOT NULL | Step identifier from workflow definition |
| `step_title` | TEXT NOT NULL | |
| `instructions` | TEXT NOT NULL | Full step instruction text |
| `completion_json` | TEXT | JSON array of completion criteria; NULL if none |
| `sequence_index` | INTEGER NOT NULL | 0-based ordinal |
| `status` | TEXT NOT NULL | `pending`, `completed`, `blocked`, `failed`, `skipped` |
| `notes` | TEXT | Agent-provided completion notes |
| `evidence_json` | TEXT | Structured evidence key-value pairs |
| `completed_at` | TEXT | ISO-8601; NULL while pending |
| `summary` | TEXT | Required completion summary, validated against `completion_json` by an LLM gate when both are present |

Primary key: `(run_id, step_id)`.

#### Table: `workflow_run_units`

The current status projection for execution units (one row per node in a
run's execution graph), keyed `(run_id, unit_id)` with a FK to `workflow_runs`.
The `workflow_run_unit_attempts` table is append-only; it receives every
external reservation and terminal result, while this table remains the
public status projection. Columns include
`node_id`, `parent_unit_id`, `phase`,
`runner`, `model`, `status`
(`pending`/`running`/`completed`/`failed`/`skipped`), `result_json`, `tokens`,
`failure_reason`, `worktree_path`, `session_id`, timing columns, and per-unit
check-in/claim fields (`last_checkin_at`, `attempts`, `claim_holder`,
`claim_expires_at`, `engine`). See `docs/reference/workflows.md`.

#### Table: `workflow_run_unit_attempts`

Append-only durable-v4 external-dispatch journal. Primary key: `(run_id, unit_id, attempt)`.
`dispatch_id` also has a unique index. A crash
reclaim keeps the stable dispatch identity for the same attempt; an explicit
retry appends a new numbered attempt instead of overwriting history.

| Column | Type | Notes |
|---|---|---|
| `run_id` | TEXT NOT NULL | FK to `workflow_runs(id)` with cascade delete |
| `unit_id` | TEXT NOT NULL | Stable v4 unit identity across explicit retries |
| `attempt` | INTEGER NOT NULL | One-based append-only attempt ordinal |
| `dispatch_id` | TEXT NOT NULL UNIQUE | Stable identity reused by crash reclaim |
| `step_id`, `node_id` | TEXT NOT NULL | Owning workflow step and node |
| `phase` | TEXT NOT NULL | `unit` or `gate` |
| `runner`, `engine`, `model` | TEXT | Frozen dispatch classification; values may be absent where inapplicable |
| `input_hash` | TEXT NOT NULL | Integrity/replay identity for the dispatch input |
| `status` | TEXT NOT NULL | `running`, `completed`, `failed`, or `skipped` |
| `result_json`, `tokens`, `failure_reason` | mixed | Terminal result, known usage, and safe failure reason |
| `session_id`, `worktree_path` | TEXT | External session and isolation-worktree evidence |
| `started_at`, `finished_at` | TEXT | Attempt timing |
| `claim_holder`, `claim_expires_at` | TEXT NOT NULL | Lease fencing for reclaim and stale-terminal refusal |

---

### `$DATA/state.db` — Migration-safe Durable State Database

WAL mode, foreign keys ON. Schema uses Flyway-pattern migrations — never drops durable rows. Created on first event write.

#### Table: `schema_migrations`

Tracks applied migration IDs.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PRIMARY KEY | Migration identifier |
| `applied_at` | TEXT NOT NULL | ISO-8601 |

#### Table: `events`

Replaces `events.jsonl`. Indexed on `event_type`, `ref`, `ts`. Monotonic rowid replaces byte-offset cursor. Defined by migration `001-initial-schema` in `src/core/state/migrations.ts` (`CREATE TABLE IF NOT EXISTS events`); no later migration alters it.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | Monotonic cursor (replaces JSONL byte offset) |
| `event_type` | TEXT NOT NULL | See event type catalog below |
| `ts` | TEXT NOT NULL | ISO-8601 |
| `ref` | TEXT | Asset ref or NULL |
| `metadata_json` | TEXT NOT NULL DEFAULT '{}' | JSON object; maps to `EventEnvelope.metadata` |

Indexes: `idx_events_type` on `event_type`, `idx_events_ref` on `ref`, `idx_events_ts` on `ts`.

#### Table: `proposals`

Replaces per-uuid JSON directories under `$STASH/.akm/proposals/`. Indexed on `stash_dir+status`, `ref+status`.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PRIMARY KEY | UUID v4 |
| `ref` | TEXT NOT NULL | Asset ref |
| `stash_dir` | TEXT NOT NULL | Bundle root directory |
| `status` | TEXT NOT NULL | `pending`, `accepted`, `rejected` |
| `source` | TEXT | Origin (e.g. `reflect`) |
| `payload_json` | TEXT NOT NULL | Full proposal payload JSON |
| `created_at` | TEXT NOT NULL | ISO-8601 |
| `updated_at` | TEXT NOT NULL | ISO-8601 |

Indexes: `idx_proposals_stash_status` on `(stash_dir, status)`, `idx_proposals_ref_status` on `(ref, status)`.

#### Table: `task_history`

Replaces per-task JSONL files. Indexed on `task_id`, `started_at`.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `task_id` | TEXT NOT NULL | Task identifier |
| `status` | TEXT NOT NULL | |
| `started_at` | TEXT NOT NULL | ISO-8601 |
| `completed_at` | TEXT | ISO-8601; NULL while incomplete |
| `failed_at` | TEXT | ISO-8601; NULL unless failed |
| `log_path` | TEXT | Transitional flat log path |
| `target_kind` / `target_ref` | TEXT | Task target identity |
| `metadata_json` | TEXT | Versioned metadata: v2 records `durationMs`, `detail`, and prompt `engine`; unversioned historical metadata keeps `profile` as `legacyProfile` |

Indexes: `idx_task_history_task` on `task_id`, `idx_task_history_started` on `started_at`.

#### Table: `usage_events`

Moved here from `index.db` at the three-DB cutover (Chunk-8 WI-8.3) — durable,
non-regenerable telemetry does not belong in a rebuildable derived cache.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `event_type` | TEXT NOT NULL | `search`, `show`, `curate`, `feedback` |
| `query` | TEXT | Search query (NULL for non-search events) |
| `entry_id` | INTEGER | `index.db` entry id; NULL until re-linked after a rebuild |
| `entry_ref` | TEXT | Stable ref string (survives entry ID changes across index rebuilds) |
| `signal` | TEXT | Feedback signal: `positive` or `negative` |
| `metadata` | TEXT | JSON free-form metadata |
| `source` | TEXT NOT NULL DEFAULT 'user' | Provenance: `user`, `improve`, `task`, `audit`, or `unknown`. The SQL default is retained in the cutover schema; runtime writers always pass an explicit value. |
| `created_at` | TEXT NOT NULL | ISO-8601 |

Indexes: `idx_usage_events_entry`, `idx_usage_events_type`, `idx_usage_events_ref`, `idx_usage_events_source`.

Preserved across `index.db` schema changes and full rebuilds. `relinkUsageEvents()` re-associates rows to new entry IDs via `entry_ref` after a full rebuild.
Pre-provenance rows rescued during the three-DB cutover are explicitly stored as
`unknown`, never promoted to user demand by the historical SQL default.

#### Table: `legacy_state`

Orphan quarantine archive populated by the one-time three-DB-cutover ref-rekey
migration (§11.4): rows from durable state keyed off a ref that could not be
re-keyed onto `item_ref` land here instead of being silently dropped.

---

### `$DATA/logs.db` — Task/Run Log Lines

Separate SQLite database from `state.db` (`src/core/logs-db.ts`, `getLogsDbPath()`). WAL mode, `busy_timeout = 30000 ms`, foreign keys OFF. Structured replacement for grepping the per-run flat log files under `$CACHE/tasks/logs/<task-id>/<ISO-ts>.log` (that per-run text file is still written as a transitional human-readable tail). Can grow large in practice — live installs have been observed at roughly 1 GB — because every scheduled task run appends its stdout/stderr lines here with no default cap on total size (only an age-based purge, see below).

#### Table: `task_logs`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `ts` | TEXT NOT NULL | ISO-8601 |
| `task_id` | TEXT NOT NULL | Task identifier |
| `run_id` | TEXT NOT NULL | `buildTaskRunId(task_id, started_at)` — joins to `state.db`'s `task_history` row |
| `stream` | TEXT NOT NULL DEFAULT 'stdout' | `stdout` or `stderr` |
| `level` | TEXT NOT NULL DEFAULT 'info' | `info`, `warn`, or `error` |
| `line` | TEXT NOT NULL | One captured log line (no trailing newline) |

Indexes: `idx_task_logs_ts` on `ts`, `idx_task_logs_task_id` on `task_id`, `idx_task_logs_run_id` on `run_id`.

**Retention:** `purgeOldTaskLogs()` deletes rows older than 90 days by default; it runs as part of the improve maintenance stage (`loop-stages.ts`) alongside the `state.db` purges. Age-based only — there is no size cap, which is why the file can reach ~1 GB.

---

## JSONL Event Streams

### `$CACHE/events.jsonl` — **Replaced by `events` table in `$DATA/state.db`**

The JSONL file at `$CACHE/events.jsonl` is no longer read or written by akm.

**Wire format (one object per line, historical reference):**
```json
{"schemaVersion":1,"ts":"2026-05-11T01:37:00.000Z","eventType":"<verb>","ref":"<type:name>","metadata":{}}
```

> `id` was the byte offset of the line — assigned at read time via `readEvents()`, not stored on disk. In the new `events` table, the monotonic `INTEGER PRIMARY KEY` replaces the byte-offset cursor.

**Full event type catalog:**

| `eventType` | Emitted by | Key `metadata` fields |
|---|---|---|
| `add` | `akm bundle add` | `target`, `provider`, `name`, `writable` |
| `remove` | `akm bundle remove` | `target`, `ref` |
| `update` | `akm bundle update` | `target`, `all`, `processed` |
| `remember` | `akm remember` | `path`, `force`, `tagCount`, `enriched`, `auto`, `scope` |
| `import` | `akm import` | `source`, `path`, `force` |
| `save` | `akm sync` | `name`, `message`, `ok` |
| `feedback` | `akm feedback` | `signal` (positive\|negative), `reason`, `tags` |
| `promoted` | `akm proposal accept` | `proposalId`, `source`, `assetPath` |
| `rejected` | `akm proposal reject` | `proposalId`, `source`, `reason` |
| `reflect_invoked` | reflect pass inside `akm improve` | `task`, `engine`, `eligibilitySource` |
| `propose_invoked` | `akm proposal new` | `type`, `name`, `task`, `engine` |
| `distill_invoked` | distill pass inside `akm improve` | `outcome` (queued\|skipped\|validation_failed\|quality_rejected), `lessonRef`, `score`, `reason` |
| `search` | `akm search` | `query`, `hitCount`, `resultRefs[]`, `mode` (semantic\|keyword) |
| `show` | `akm show` | `type`, `name` |
| `select` | `akm show` (when preceded by search within 60s) | `query`, `searchTs`, `rankPosition` |
| `improve_invoked` | `akm improve` | `strategy`, `scope`, `dryRun`, `eligibleCount` |
| `improve_skipped` | `akm improve` (cooldown guards) | `reason` (reflect_cooldown\|distill_cooldown\|consolidation_cooldown\|budget_exhausted), `cooldownDays`, `lastEventTs` |
| `consolidate_completed` | `akm improve` (post-consolidation) | `processed`, `merged` |
| `schema_repair_invoked` | `akm improve` (repair pass) | `outcome` (queued\|error), `reason`, `proposalId?`, `error?` |
| `reflect_completed` | reflect pass inside `akm improve` (after proposal created) | `proposalId`, `source` |
| `workflow_started` | workflow engine | `runId` |
| `workflow_step_completed` | workflow engine (genuine `completed` transition only) | `runId`, `stepId`, `status` |
| `workflow_step_updated` | workflow engine (every non-`completed` transition: `failed`/`skipped`/`blocked`) | `runId`, `stepId`, `status` |
| `workflow_finished` | workflow engine | `runId` |

**Read API:** `readEvents(options)` — filter by `since`, `sinceOffset` (row id cursor), `type`, `ref`, `includeTags`, `excludeTags`. Returns `{ events, nextOffset }`. `tailEvents()` provides a polling loop.

**Consumers and purpose:**

| Consumer | Filter used | Purpose |
|---|---|---|
| `akm improve` | `feedback` within 30d | Signal-filter candidate selection |
| `akm improve` | `reflect_invoked` per ref | Reflect cooldown guard (7d / 14d / 3d tier) |
| `akm improve` | `distill_invoked` per ref | Distill cooldown guard (30d) |
| `akm improve` | `consolidate_completed` | Consolidation cooldown guard (14d) |
| `akm improve` | `schema_repair_invoked` per ref | Schema repair cooldown guard (7d) |
| `akm improve` (distill pass) | `feedback` per ref | Builds LLM prompt context (last 20 events) |
| `akm improve` (reflect pass) | `feedback` per ref | Builds agent prompt context (last 10 per-ref / 20 global) |
| `akm show` | `show` per ref | Loop detection: warns at 3+ repeated shows |
| `akm log --type promoted\|rejected` | `promoted`, `rejected` | Proposal lifecycle trail (0.9.0: `akm history --include-proposals` was removed; this is the surviving read path) |
| `akm log` | user-supplied | Direct inspection |

---

### `$STATE/tasks/history/<task-id>.jsonl` — Task Run History (legacy)

These JSONL files are no longer written or read by akm. Existing files at `$CACHE/tasks/history/` or `$STATE/tasks/history/` can be imported into the `task_history` table in `state.db` using the migration script. See Step 7 of `akm-migrate storage`.

One line per execution: `{ id, status, startedAt, finishedAt, durationMs, log, target, detail? }`. No cleanup.

### `$STASH/.akm/memory-cleanup/belief-transitions.jsonl` — Belief State Log

One line per memory belief-state transition: `{ appliedAt, ref, parentRef, fromState, toState, reason, relatedRef? }`. Observability only; no programmatic consumer reads this file.

---

## JSON / Config Files

| Path | Contents | Retention |
|---|---|---|
| `$CONFIG/config.json` | User config (bundle dirs, sources, LLM endpoints, feature flags, registries). JSONC — `//` and `/* */` comments stripped at parse time. | Manual |
| `<cwd>/.akm/config.json` | Project-scoped config overrides. Walked up to filesystem root; all ancestors merged. | Manual |
| `$CACHE/config-backups/config-<ISO-ts>.json` | Pre-save snapshot of `config.json`, written by `backupExistingConfig()` in `src/core/config/config-io.ts` before each config write. `config.latest.json` is a second copy (not a symlink) always overwritten with the newest snapshot. Dir created/chmod'd `0700`; both the timestamped file and `config.latest.json` are chmod'd `0600` (08-F4, mirroring the env-cli write-mode convention). This is the only live backup location — legacy `$DATA/config-backups/` and `$CONFIG/config-backups/` write paths have been removed. | Capped at `MAX_CONFIG_BACKUPS = 5` most-recent timestamped snapshots; `pruneOldBackups()` deletes the rest on every write |
| `$CONFIG/akm.lock` | Legacy location. Removed in v0.8.0 — akm reads ONLY from `$DATA/akm.lock`. Run the migration script to copy this file to `$DATA/akm.lock` before upgrading. | Legacy |
| `$DATA/akm.lock` | Installed bundle lockfile (moved from `$CONFIG`). Application-managed install state. Same format as `$CONFIG/akm.lock`. | Managed by `akm bundle add`/`akm bundle remove` |
| `$CACHE/semantic-status.json` | Embedding provider health: `status` (pending/ready-js/ready-vec/blocked), `reason`, `providerFingerprint`, `lastCheckedAt`, `entryCount`, `embeddingCount`. Blocked status auto-expires after 24h. | Reset on `akm index --full` |
| `$CACHE/registry-index/<slug>.json` | Removed in v0.8.0 — data now stored in `registry_index_cache` table in `$DATA/index.db`. Delete these files after running the migration script. | — |
| `$CACHE/registry-index/skills-sh-search-<md5>.json` | Skills.sh search result cache. Fresh 15min; stale 1d. Key = MD5 of `url + query + limit`. | TTL |
| `$STASH/.akm/consolidate-journal.json` | Legacy consolidation journal; current advisory consolidation does not read or write it. | Safe to remove |
| `$DATA/index.db` (`graph_*` tables) | Knowledge graph index data: per-bundle graph metadata plus per-file entities and relations extracted from assets via LLM. `graph_files` is keyed on `entry_id INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE` with `(stash_root, file_path)` as `UNIQUE`; `body_hash` is `NOT NULL`; every considered file persists a `status` and `reason`; `graph_file_entities` stores both canonical `entity` and normalized `entity_norm`; `graph_file_relations` stores canonical endpoints plus `from_entity_norm` / `to_entity_norm`; `extraction_run_id` (on `graph_files` and `graph_meta`) and `extractor_id` (on `graph_meta`) record extraction provenance. `graph_meta` also stores the latest graph telemetry: model, prompt version, batch size, cache hits/misses, truncation count, and failure count. A companion `graph_extraction_queue` table holds a lazy, priority-ordered backlog of files awaiting extraction. Indexes: `idx_graph_files_stash_order`, `idx_graph_file_entities_entity_norm(stash_root, entity_norm)`, `idx_entries_file_path` on `entries(file_path)`. | Refreshed by graph extraction; regenerated on the next `akm index`/`akm improve` since `index.db` is a fully rebuildable cache |

---

## Markdown / Asset Files

### Primary Bundle Content

All asset files live under `$STASH/` in type-specific subdirectories defined by the `PLACEMENT_SPECS` map in `src/core/asset/asset-placement.ts`:

The `workflows/` directory holds peer `.md` and `.yml` workflow sources. The
`tasks/` directory holds strict `.yml` task v3 sources.

| Subdirectory | Asset Type | Format |
|---|---|---|
| `skills/<name>/SKILL.md` | skill | YAML-FM + Markdown |
| `commands/<name>.md` | command | YAML-FM + Markdown |
| `agents/<name>.md` | agent | YAML-FM + Markdown |
| `knowledge/<name>.md` | knowledge | YAML-FM + Markdown |
| `instructions/<name>.md` | instruction | YAML-FM + Markdown |
| `workflows/<name>.md` / `workflows/<name>.yml` | workflow | Peer `.md` Markdown and `.yml` GitHub-shaped sources; both compile through source IR v1 |
| `scripts/<name>.<ext>` | script | sh / ts / js / ps1 etc. |
| `memories/<name>.md` | memory | YAML-FM + Markdown |
| `env/<name>.env` | env | `KEY=VALUE` pairs |
| `secrets/<name>` | secret | raw secret bytes |
| `facts/<name>.md` | fact | YAML-FM + Markdown |
| `lessons/<name>.md` | lesson | YAML-FM + Markdown (required: `description`, `when_to_use`) |
| `tasks/<name>.yml` | task | Strict task v3 YAML source with root `version: 3`; `.yaml` is not recognized |
| `sessions/<harness>/<session-id>.md` | session | YAML-FM + Markdown; generated by the `extract` pass, not user-authored |

`wikis/<name>/` is a separate convention: a bundle root recognized by the
`llm-wiki` adapter, not a `PLACEMENT_SPECS` type directory. `wiki` is not an
item type (see [Classification](classification.md)).

### Wiki File Structure

Each `$STASH/wikis/<wikiName>/` (or any other bundle root the `llm-wiki`
adapter recognizes — `schema.md` + `pages/` is the probe) contains:

| File | Purpose |
|---|---|
| `schema.md` | Content structure definition (reserved, never indexed as a concept) |
| `index.md` | Table of contents (reserved, never indexed as a concept) |
| `log.md` | Recent activity log (reserved, never indexed as a concept) |
| `raw/.gitkeep` | Ensures `raw/` survives clean clones |
| `raw/<slug>.md` | Immutable ingested raw sources (adapter type `wiki-source`) |
| `pages/<page>.md` | Agent-authored, synthesized wiki pages (open type from frontmatter `pageKind`, default `note`) |
| `pages/<subdir>/<page>.md` | Pages may nest under subdirectories (e.g. `pages/entities/`) |

### Improvement Pipeline Files

| Path | Contents | Retention |
|---|---|---|
| `$DATA/state.db` (`proposals` table) | Proposal queue: `id`, `stash_dir`, `ref`, `status` (`pending`\|`accepted`\|`rejected`\|`reverted`), `source`, `created_at`, `updated_at`, `content`, `frontmatter_json`, `metadata_json`. Replaces the pre-0.9.0 per-uuid `$STASH/.akm/proposals/<uuid>/proposal.json` filesystem layout — archival is a status flip, not a directory move (`src/commands/proposal/repository.ts`). | Durable; `archiveRetentionDays` (default 90d) governs when pending proposals age out |
| `$STASH/.akm/archive/<ts>-<i>-<name>.md` | Legacy consolidation archive. Current advisory consolidation does not create or manage these files. | Review before manual removal |
| `$STASH/.akm/consolidate-backup/<ts>/<name>.md` | Legacy pre-0.9 consolidation backups; current advisory consolidation does not create them. | Safe to remove after review |
| `$STASH/.akm/memory-cleanup/archive/<ts>-<ref>/` | Belief-state archived memory files + `cleanup.md` audit record | No cleanup |
| `$STASH/.akm/distill-rejected/<ts>-<lessonRef>.md` | Lessons that failed the LLM-as-judge quality gate. Frontmatter: `{ score, reason }`. | No cleanup |
| `$STASH/memories/MEMORY.md` | Human-maintained memory index. Budget: warn at 180 lines, hard cap at 200. Read-only for akm (not written by current code). | Manual |
| `<dir>/.stash.json` | Legacy per-directory metadata manifest (pre-0.9.0). The live indexer no longer reads it; only the storage migrator reads and folds it into inline asset metadata before deleting it. | Manual |

---

## Lock / Sentinel Files

| Path | Format | Purpose |
|---|---|---|
| `$DATA/akm.lock.lck` | Plain text (PID) | Advisory write-lock for `akm.lock` mutations. Created with `O_EXCL`; stale locks (dead PIDs) auto-reclaimed. Best-effort: 3 retries × 100ms. |
| `$STASH/.akm/improve.lock` | JSON `{ pid, startedAt, lockId }` | Serializes the complete live `akm improve` mutation window from triage through final sync. Exact ownership protects successor locks during release. Stale locks are reclaimed when the PID is dead or after the larger of four hours and the configured run budget plus ten minutes. |

---

## Cache Directories

| Path | Contents | TTL / Retention |
|---|---|---|
| `$CACHE/registry/<src>/<id>/<ver>/` | Downloaded bundle packages (npm tarballs + extracted trees) | No TTL |
| `$CACHE/registry/<src>/<id>/repo/` | Git mirror working trees for git-sourced bundles | 12h fresh; 7d stale |
| `$CACHE/registry-index/website-<sha256-16>/` | Scraped website content as knowledge markdown files + `manifest.json` freshness marker | 12h fresh; 7d stale |
| `$CACHE/registry-build/build-<random>/` | Temp archive extraction for registry index building | Deleted in `finally` after each run |
| `$CACHE/tasks/logs/<task-id>/` | Per-run stdout/stderr log files (`<ISO-ts>.log`) | No cleanup |
| `$CACHE/bin/rg` | Auto-downloaded ripgrep binary | Permanent |

Cache-backed bundles (`git`, `website`, `npm`) are materialised into `$CACHE`
before indexing — each provider's `sync()` method (`src/sources/providers/`)
is invoked through `ensureSourceCaches()`, and the materialised tree is then
indexed like a local filesystem bundle.

---

## OS-Native Task Scheduler Files

### macOS (launchd)

**Plist:** `~/Library/LaunchAgents/com.akm.task.<id>.plist` — XML plist. Contains label, `ProgramArguments` (`akm task run <id>`), `StandardOutPath`, `StandardErrorPath`, trigger (`StartInterval` or `StartCalendarInterval`), and `EnvironmentVariables` (PATH captured at install time).

Registered via `launchctl bootstrap gui/<uid> <plist>`.

### Linux (cron)

No files written. User crontab edited in-place via `crontab -l` / `crontab -`. Each task is bracketed with sentinels:

```
# akm:task <id> BEGIN
<cronexpr> /abs/akm task run <id> >> ~/.cache/akm/tasks/logs/<id>.log 2>&1
# akm:task <id> END
```

Disabled tasks get `# akm:disabled ` prepended to the cron line.

### Windows (Task Scheduler)

Task definition XML written to `%TEMP%\akm-task-<id>-<ts>.xml`, used to register via `schtasks /Create`, then deleted in the `finally` block. Persistent state is in the Windows Task Scheduler (OS-managed).

---

## Companion Plugin State (Claude Code / OpenCode Harnesses)

These directories are written by the akm-plugins hook scripts (`akm-plugins` repo — the Claude Code and OpenCode integration layer that shells out to this `akm` CLI), not by the `akm` binary itself. They are part of the overall akm-ecosystem storage footprint and have been observed to grow large in practice (hundreds of MB) with **no retention/prune policy in code today** — no purge, TTL, or size cap was found in the hook sources.

### `$XDG_STATE_HOME/akm-claude/` (Linux/macOS default `~/.local/state/akm-claude/`) — Claude Code Hook State

Path resolved by `getHarnessStateDir("claude-code")` / `STATE_DIR` in `akm-plugins/claude/hooks/akm-hook.ts` and `akm-plugins/claude/shared/memory-events.ts`.

| Path | Contents | Retention |
|---|---|---|
| `events.jsonl` | Append-only memory-event log (`AkmMemoryEvent`: session/tool/workflow/feedback observations), written via `appendMemoryEvent()` | No cleanup |
| `memory-candidates.jsonl` | Candidate memories extracted from session activity, written via `getCandidateLogPath()` in `akm-plugins/claude/shared/memory-candidates.ts` | No cleanup |
| `curated/prompt-<sessionId>.md`, `curated/session-<sessionId>.md` | Curated bundle context written per prompt/session for the model to read (`CURATED_DIR`) | No cleanup |
| `sessions/` | Per-session hook working state (`SESSIONS_DIR`) | No cleanup |
| `session.log`, `feedback.log`, `memory.log` | Human-readable hook activity logs | No cleanup |
| `quality-cache.tsv` | Cached asset-quality lookups | No cleanup |
| `setup.stamp` | One-time setup marker | Manual |

### `$XDG_STATE_HOME/akm-opencode/` (Linux/macOS default `~/.local/state/akm-opencode/`) — OpenCode Hook State

Same shared helpers as above with `harness: "opencode"` (`getHarnessStateDir()` / `getCandidateLogPath()` in `akm-plugins/claude/shared/`).

| Path | Contents | Retention |
|---|---|---|
| `events.jsonl` | Append-only memory-event log, same schema as the Claude Code tier | No cleanup |
| `memory-candidates.jsonl` | Candidate memories extracted from OpenCode session activity | No cleanup |

Note: the OpenCode plugin's curated-prompt files (`CURATED_DIR` in `akm-plugins/opencode/index.ts`) are written under the OS temp directory, not this state tier.

---

## External / Read-Only Inputs

These paths are read by `akm improve` to scan for repeated failure patterns in agent session logs. akm never writes to them.

| Path | Agent |
|---|---|
| `~/.claude/projects/**/*.jsonl` | Claude Code |
| `~/.local/share/opencode/` (Linux) | OpenCode |
| `~/Library/Application Support/opencode/` (macOS) | OpenCode |

---

## Utility Score Pipeline

How utility scores flow through the system:

```
akm search / akm show
  → insertUsageEvent()       → usage_events table (SQL aggregation)
  → bumpUtilityScoresBatch() → utility_scores (between-index EMA bump)
       formula: next = clamp(current + 0.1 × (1.0 − current), 0, 1)

akm feedback
  → insertUsageEvent()       → usage_events (signal column)
  → appendEvent()            → events table in state.db (for improve/distill/reflect pipeline)

akm index  (recomputeUtilityScores)
  → reads source='user' usage_events aggregates per entry
       selectRate   = min(1, show_count / search_count)
       feedbackRate = (positive_count − negative_count) / total_feedback
       effectiveRate = max(selectRate, feedbackRate)
       decay        = 0.7 ^ elapsedDays
       utility      = prevUtility × decay + effectiveRate × (1 − decay)
  → overwrites/decays the union of aggregated entries and existing utility rows

akm search  (ranking phase)
  → recencyFactor = exp(−daysSinceLastUse / 30)
  → score        *= min(1 + utility × recencyFactor × 0.5, 1.5)
```

`usage_events` and the general `events` log are both durable tables in
`$DATA/state.db`. Utility recomputation reads usage telemetry there and joins
entry ids against the regenerable `index.db` catalog in application code.
Only `source='user'` contributes demand or utility. `improve`, `task`, `audit`,
`unknown`, and unrecognized extension values remain inspectable telemetry but do
not affect ranking, salience, real-query labels, or GRR.

---

## Summary Index

| # | Path | Format | Purpose |
|---|---|---|---|
| 1 | `$DATA/index.db` | SQLite 3 (WAL) | Main search index, embeddings, utility scores, LLM cache, registry index cache |
| 2 | `$DATA/workflow.db` | — | **Removed in 0.9.0** — folded into `$DATA/state.db`. Deleted by `akm migrate apply`. |
| 3 | `$DATA/state.db` | SQLite 3 (WAL) | Durable event and usage logs, proposals, task history, and workflow run state (migration-safe) |
| 4 | `$STATE/tasks/history/<id>.jsonl` | JSONL | Per-task execution history (legacy location, removed in v0.8.0; import into state.db via migration script) |
| 5 | `$STASH/.akm/memory-cleanup/belief-transitions.jsonl` | JSONL | Belief state transition audit log |
| 6 | `$CONFIG/config.json` | JSONC | User configuration |
| 7 | `<cwd>/.akm/config.json` | JSONC | Project-scoped config overrides |
| 8 | `$CACHE/config-backups/config-<ts>.json` | JSON | Config pre-save backups (0600 files / 0700 dir; capped at 5, only live backup location) |
| 9 | `$DATA/akm.lock` | JSON | Installed bundle lockfile (moved from $CONFIG) |
| 10 | `$CONFIG/akm.lock` | JSON | Legacy location (removed in v0.8.0). Run migration script to move to `$DATA/akm.lock`. |
| 11 | `$DATA/akm.lock.lck` | Text (PID) | Write-lock sentinel for lockfile |
| 12 | `$CACHE/semantic-status.json` | JSON | Embedding provider health cache |
| 13 | `$CACHE/registry-index/<slug>.json` | JSON | Removed in v0.8.0 — replaced by `registry_index_cache` table in `$DATA/index.db`. Safe to delete after migration. |
| 14 | `$CACHE/registry-index/skills-sh-search-<md5>.json` | JSON | Skills.sh query result cache |
| 15 | `$STASH/.akm/consolidate-journal.json` | JSON | Legacy consolidation journal; no longer used |
| 16 | `$DATA/index.db` (`graph_*` tables) | SQLite | Knowledge graph data — there is no `graph.json` file; see the `graph_*` table row above |
| 17 | `$DATA/state.db` (`proposals` table) | SQLite | Proposal queue, pending and archived alike — archival is a `status` flip, not a separate directory |
| 18 | `$STASH/.akm/archive/<ts>-<i>-<name>.md` | FM+Markdown | Legacy consolidation archive; no longer managed |
| 19 | `$STASH/.akm/consolidate-backup/<ts>/<name>.md` | Markdown | Legacy consolidation backups; no longer created |
| 20 | `$STASH/.akm/memory-cleanup/archive/<ts>-<ref>/` | Markdown | Belief-state archived memories |
| 21 | `$STASH/.akm/distill-rejected/<ts>-<ref>.md` | FM+Markdown | Quality-gate rejected lessons |
| 22 | `$STASH/.akm/improve.lock` | JSON | Improve run mutex |
| 23 | `$STASH/{skills,commands,agents,...}/` | FM+Markdown | Asset files (working bundle) |
| 24 | `$STASH/wikis/<name>/` | Markdown | `llm-wiki`-adapter bundle content (schema/index/log + `raw/` + `pages/`) |
| 25 | `<dir>/.stash.json` | JSON | Legacy metadata (read-only) |
| 26 | `$STASH/memories/MEMORY.md` | Markdown | Memory index (user-maintained, read-only for akm) |
| 27 | `$CACHE/registry/<src>/<id>/<ver>/` | Binary+FS | Downloaded bundle package cache |
| 28 | `$CACHE/registry/<src>/<id>/repo/` | Git tree | Git source mirror cache |
| 29 | `$CACHE/registry-index/website-<hash>/` | JSON+MD | Website mirror cache |
| 30 | `$CACHE/registry-build/` | JSON+FS | Registry build workspace |
| 31 | `$CACHE/tasks/logs/<id>/` | Plain text | Task run stdout/stderr |
| 32 | `$CACHE/bin/rg` | Binary | Auto-downloaded ripgrep |
| 33 | `~/Library/LaunchAgents/com.akm.task.<id>.plist` | XML | macOS scheduled task (launchd) |
| 34 | User crontab | Cron text | Linux scheduled tasks |
| 35 | Windows Task Scheduler `\akm\<id>` | XML | Windows scheduled tasks |
| 36 | `~/.claude/projects/**/*.jsonl` | JSONL | Claude Code session logs (read-only input) |
| 37 | `~/.local/share/opencode/` | JSONL | OpenCode session logs (read-only input) |
| 38 | `$DATA/logs.db` | SQLite 3 (WAL) | Task/run log lines (`task_logs`); observed ~1 GB on live installs; 90d age-based purge only, not size-capped |
| 39 | `$XDG_STATE_HOME/akm-claude/` | JSONL+Markdown+text | Claude Code plugin hook state (events, memory candidates, curated prompts, logs); written by akm-plugins, not core akm; no retention policy today |
| 40 | `$XDG_STATE_HOME/akm-opencode/` | JSONL | OpenCode plugin hook state (events, memory candidates); written by akm-plugins, not core akm; no retention policy today |

---

Check `src/core/paths.ts` for the canonical path resolution functions (`getCacheDir`, `getConfigDir`, `getDataDir`, `getDbPath`, `getStateDbPathInDataDir`, `getSemanticStatusPath`).
