# Indexing

`akm index` builds and refreshes the local SQLite search index.

By default it builds the local index and keeps metadata in the index. When an
LLM engine is selected (`defaults.llmEngine`, or `index.enrichment.engine`
overriding it) and `index.enrichment.enabled` is not `false`, metadata
enhancement runs during indexing. There is no top-level `llm` config key in
0.9 — it is retired and hard-rejected at load; per-call tuning lives on each
named engine under `engines.<name>.*`.

## High-Level Flow

```text
Resolve all sources (filesystem, git, website, npm) and materialise caches
        ↓
Walk files and classify assets
        ↓
Generate metadata from the asset
        ↓
Build weighted search fields
        ↓
Atomically apply entries + FTS projections + vector invalidation
        ↓
Reconcile removed sources and explicit --clean deletions
        ↓
Generate missing/stale embeddings when enabled
        ↓
Re-link preserved usage events and recompute utility scores
        ↓
Verify and report the final generation
```

Cache materialisation runs through each source's `sync()` method
(`src/sources/providers/`) before the indexer walks `path()`.

## Search Field Mapping

`src/indexer/search/search-fields.ts` builds five FTS columns:

| Column | Contents |
| --- | --- |
| `name` | normalized asset name |
| `description` | description text |
| `tags` | tags + aliases |
| `hints` | `searchHints`, `examples`, `usage`, intent text, wiki xrefs, wiki page kind |
| `content` | bounded native/adapter body projection, TOC headings, and parameter names/descriptions |

The `content` column is intentionally lowest-weight. AKM-native Markdown body
prose is normalized and bounded at the adapter boundary; secrets, env values,
raw sessions, and session checkpoints never enter it. Longer structured
guidance such as `usage` and `intent` continues to feed `hints`.

Lexical retrieval uses one central progressive plan: Unicode letter/number
tokens are deduplicated and capped, then FTS executes strict AND, prefix-AND,
and—only if both miss—one OR/prefix-OR recovery query. Every stage feeds the
same BM25 normalization and downstream ranker; callers do not strip stopwords
or maintain alternate result collections.

## Modes

- incremental (default): reprocesses changed directories/files
- full rebuild (`akm index --full`): rebuilds the search index from scratch

Full rebuilds preserve usage history and then re-link it to rebuilt entries by
ref.

## Mutation and finalization boundary

The canonical entry repository owns each complete synchronous mutation of
`index.db`: the `entries` row, its weighted `entries_fts` projection, and stale
vector invalidation are committed in one SQLite transaction. Entry deletion
removes FTS, vector, and utility children before the parent row. Callers do not
maintain a dirty queue or request an incremental FTS rebuild. The full
`rebuildFts()` operation remains only as an explicit recovery verifier for this
regenerable database.

An explicit `akm index --clean` reconciles missing files after the filesystem
walk and before embedding, utility recomputation, totals, and verification.
Consequently `totalEntries`, FTS state, semantic verification, and
`clean.removed` all describe the same committed generation.

## Indexed Identity and Location

Every current `entries` row carries a canonical fully qualified
`item_ref` (`bundle//conceptId`), its `bundle_id` and `concept_id` provenance,
and the absolute `file_path` of the materialized local asset. Search and show
use those required columns for identity and access rather than reconstructing
refs from a name or source path. `item_ref` is the sole upsert conflict key;
`document_json` is the sole stored document projection. The v21 schema does not
admit incomplete identity rows or retain an entry-key/path lookup fallback.
This preserves bundle identity when multiple sources contain the same concept.

## LLM Enrichment Pass

When metadata enhancement is enabled, the enrichment pass runs after the
filesystem-derived entries are upserted. Enhanced entries are written back
through the same canonical entry/FTS mutation. Key properties:

**Concurrency** — directories are enriched in parallel using a bounded
concurrency pool (`concurrentMap` from `src/core/concurrent.ts`). The pool
width defaults to 2 for remote LLM endpoints and 1 for local model servers
(localhost endpoints — one loaded model at a time), auto-derived by
`getDefaultLlmConcurrency` (`src/indexer/indexer.ts`). `engines.<name>.concurrency`
is a valid schema field, but it is **not honored** on this path — the engine
resolver used here (`resolveLlmEngineUse`) never copies `concurrency` into the
resolved connection, so setting it in config.json has no effect on indexing
concurrency. Individual entry failures within a directory are isolated; the
pool continues with remaining work.

**`quality: "enriched"` caching** — after a successful LLM enrichment call,
the entry's `quality` field is set to `"enriched"` and written back to the
index. On subsequent `akm index` runs, entries already marked `"enriched"`
are skipped unless the caller explicitly requests re-enrichment.

**Enrichment deadline** — the pass runs under an `AbortSignal.timeout()`
deadline sized as a per-entry timeout (default 10 minutes; `engines.<name>.timeoutMs`,
or an `index.enrichment.timeoutMs` / `index.defaults.timeoutMs` override,
takes precedence) multiplied by the number of entries being enriched. Once the
deadline fires, no new enrichment calls are started; entries that were not
reached are left at `quality: "generated"` and will be picked up on the next
eligible run.

**Eligibility** — only entries with `quality: "generated"` are enriched by
default. Entries with `quality: "curated"` or `quality: "enriched"` are
skipped unless the caller explicitly requests re-enrichment.

## Progress Reporting

- text mode: shows a spinner with processed-versus-total source counts
- `--verbose`: prints phase progress to stderr
- structured output (`json`, `yaml`, `jsonl`): emits clean machine-readable output without spinner noise

## Database Tables

`index.db`'s schema (`ensureSchema()`,
`src/storage/repositories/index-schema.ts`) creates 15 tables (2 of them
virtual). Full column-level detail lives in
[Storage Locations](storage-locations.md#dataindexdb--main-search-index);
this is a purpose summary:

| Table | Purpose |
| --- | --- |
| `entries` | normalized asset records |
| `entries_fts` (virtual, FTS5) | multi-column full-text index |
| `embeddings` | stored embedding vectors (JS cosine-similarity fallback) |
| `entries_vec` (virtual, conditional) | `sqlite-vec` ANN index, created only when the extension loads |
| `utility_scores` | recomputed utility boost state (global) |
| `utility_scores_scoped` | same EMA per `(entry, project-anchor)` pair |
| `index_meta` | schema/version/runtime metadata |
| `index_dir_state` | incremental-indexing cache (per-directory hash + mtime) |
| `llm_enrichment_cache` | cached LLM enrichment/graph-extraction/memory-inference results |
| `registry_index_cache` | cached registry index JSON (replaces flat cache files) |
| `graph_meta` | per-bundle knowledge-graph telemetry (model, prompt version, cache hits) |
| `graph_files` | per-file graph-extraction status |
| `graph_file_entities` | extracted entities per file |
| `graph_file_relations` | extracted entity relations per file |
| `graph_extraction_queue` | lazy, priority-ordered backlog of files awaiting graph extraction |

`usage_events` (search/show/feedback telemetry) and workflow runtime state
both live in `state.db`, not `index.db`, so rebuildable search state remains
separate from durable runtime state.

## Schema Versioning

`index.db` is ephemeral — fully rebuildable from sources by `akm index`. The
current generation is exactly v21. `ensureSchema()`
(`src/storage/repositories/index-schema.ts`) accepts an existing generation
only when both `index_meta.version` and the complete `entries` fingerprint
match the canonical contract, including `AUTOINCREMENT`, required columns,
constraints, indexes, collation, and hidden-column absence. An incompatible
generation is discarded: AKM drops the entry-dependent derived tables and
caches, creates the canonical v21 schema, and rebuilds it from current sources
and durable usage state. Current read-only and existing-database openers reject
an incompatible generation instead of serving it. Durable workflow, task,
proposal, event, and usage state in `state.db` is never touched by this path.

Workflow `.md` and `.yml` adapters compile directly to source IR version 1.
The index stores only the ordinary normalized `entries` row and searchable
metadata derived from that IR. It does not cache a second workflow AST or an
executable plan. Starting a run recompiles the authored source once and freezes
the sole durable plan format into `state.db`.

## Metadata Sources

AKM now treats file-derived metadata as the primary runtime source. It derives
metadata from signals such as:

- frontmatter
- comments / headers
- filenames
- `package.json`
- renderer-specific extraction (workflow params, TOC, vault key hints, wiki metadata)

The live indexer no longer reads `.stash.json` at all — since the 0.9.0
cutover it is a migrator-only concern: the storage migrator folds each
sidecar's overrides into the asset's inline metadata (frontmatter or header
comments) and deletes the sidecar. See `docs/architecture/internals/storage-locations.md`.

## Parameters

Structured parameters can come from:

- command placeholders (`$ARGUMENTS`, `$1`-`$9`, `{{named}}`)
- frontmatter `params`
- script comment extraction
- workflow markdown parameters

Parameter names and descriptions are stored structurally and also fed into the
lowest-weight `content` field.

## Quality Values

The `quality` field on an index entry tracks how its metadata was produced.
Well-known values (defined in `src/indexer/passes/metadata.ts`):

| Value | Meaning |
| --- | --- |
| `"generated"` | metadata derived automatically from file content |
| `"enriched"` | metadata produced by or updated via an LLM enrichment pass |
| `"curated"` | metadata written or explicitly approved by a human |
| `"proposed"` | metadata from a proposal awaiting review |

The `"enriched"` marker is set by the indexer after a successful metadata
enrichment pass during plain `akm index` and prevents unnecessary re-enrichment
on the next run (see LLM Enrichment Pass above).

## Utility Recomputation

Utility scores are rebuilt from `usage_events`.

- old events are purged on a rolling window
- event history is preserved through schema resets/full rebuilds
- decay is based on elapsed time, not on how often indexing runs
- utility is a secondary boost, not the primary ranking signal

## Semantic Search Integration

When semantic search is enabled:

- semantic readiness is tracked in `semantic-status.json`
- provider fingerprints include endpoint/model/dimension for remote configs
- fingerprint changes force semantic status back to pending until a rebuild
- `sqlite-vec` is optional; JS vector fallback still supports embeddings
