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

## Locks

`akm index` takes no blocking lock. #872 deliberately removed the index
rebuild's earlier 12-hour age-based-stale lease: the index is a fully
regenerable cache, so two concurrent rebuilds only waste work rather than
corrupt anything, and a live-but-wedged holder passed that lease's
PID-liveness check forever — only the age clock could ever free it, and that
cost one real install a half-day indexing outage. The `index.db.write.lock`
lease that remains (`src/indexer/index-writer-lock.ts`) is unrelated to
indexing since that removal; it only serializes actual asset-content
mutations (`remember`, `import`, `source update`, proposal apply) so two
writers cannot both pass a git exact-path preflight before either commits.

#956 added a second, opt-in, advisory-only sentinel:
`<dataDir>/index.rebuild.lock` (`getIndexRebuildLockPath()`), acquired and
released by every explicit `akm index` command run
(`src/indexer/index-rebuild-lock.ts`, built on the same PID-liveness-only
mechanics in `src/core/run-lock.ts` that `akm improve`'s whole-run lock
uses — no age-based stale reclaim, per the #872 lesson). It changes nothing
by default: a plain `akm index` that finds the lock already held just warns
and proceeds, contending with the other run exactly as before this lock
existed. Only `akm index --skip-if-locked` (intended for scheduled/
opportunistic callers — the shipped `index-refresh` task passes it) treats a
live holder as a reason to skip the run entirely and exit 0. This is
distinct from `ensureIndex()`'s implicit inline reindex (the read path's
bootstrap when the index is otherwise unusable): that path never consults
this lock, since a caller reaching it has no usable index to serve either
way and must proceed.

The write path's targeted index upsert (`indexWrittenAssets`, used by
`remember`/`import`/`proposal accept`/`source clone`/extract session assets
to make a just-written asset searchable immediately) probes this same
rebuild lock before doing any work: a live holder means it skips the
upsert/embedding entirely with one log line and returns success right away
— the file write itself already succeeded, and the in-progress rebuild will
pick up the change on its own. This is a fail-open skip like every other
branch of `indexWrittenAssets`, not a failure: a caller that gates its own
result on this boolean (`proposal accept`, `source clone`) must not fail or
warn just because a rebuild happens to be running concurrently. It never
tries to acquire or reclaim the lock itself; reclaiming a dead-PID sentinel
stays `akm index`'s job.

## Mutation and finalization boundary

The canonical entry repository owns each complete synchronous mutation of
`index.db`: the `entries` row, its weighted `entries_fts` projection, its
separate `entry_fragments` / `entry_fragments_fts` body projection, and stale
vector invalidation are committed in one SQLite transaction. Entry deletion
removes FTS, fragment, vector, and utility children before the parent row.
Callers do not maintain a dirty queue or request an incremental FTS rebuild.
The full `rebuildFts()` operation remains only as an explicit recovery verifier
for this regenerable database.

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
`document_json` is the sole stored document projection. The v23 schema does not
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

## Embedding Phase

Once entries are upserted, `generateEmbeddingsForDb`
(`src/indexer/materialize-embeddings.ts`) generates and stores vectors for
every entry that does not already have one.

**Request batching** — `RemoteEmbedder.embedBatch` (`src/llm/embedders/remote.ts`)
groups texts into provider requests bounded by an estimated token budget
(`embedding.maxTokens`/`embedding.contextLength`, default 8000 tokens) and a
document-count safety cap (`embedding.batchSize`, default 100) — the token
budget is what actually keeps a request inside the endpoint's context window
and the 30s request timeout; the count cap only guards against many tiny
documents packing an oversized request. A single document whose own estimate
exceeds the token budget is isolated and skipped before ever going over HTTP.

**Concurrency** — provider batches are dispatched through a bounded pool
(`concurrentMap`) instead of strictly sequentially. Default width (unset
`embedding.concurrency`) — `resolveEmbeddingConcurrency`
(`src/llm/embedders/remote.ts`) derives it via the same shared
`defaultConcurrencyForEndpoint` classifier (`src/core/loopback.ts`) that
`getDefaultLlmConcurrency` above uses: **1** for a loopback endpoint (a
local model server serves one inference at a time; parallel requests
thrash it) and **2** for a remote one. `embedding.concurrency` (positive
integer, 1-16, #9541) overrides this default — an owner decision made after
field evidence that a multi-slot local server (llama.cpp `--parallel N`,
vLLM) genuinely serves parallel requests and sat idle under the fixed
default. Request SIZE remains the first throughput lever regardless (see
Request batching above); the override exists for a server that actually
serves parallel slots, not as a blanket "go faster" knob. A caller abort
(`signal.aborted`) still propagates once the pool drains, even though
`concurrentMap` itself swallows per-item throws.

**Context-size split-and-retry** — a batch rejected specifically for
exceeding the endpoint's context window (HTTP 413, or a recognised
context-size error body such as `exceed_context_size_error`) is split in half
and retried recursively rather than discarded whole, down to individual
documents; a single document that still fails this way becomes a
`context-window-exceeded` skip. Any other failure (network error, 5xx,
malformed response) keeps skipping the whole batch as a `batch-request-failed`
skip — a genuinely broken batch does not get retried into a storm of smaller
requests against a down endpoint.

**Circuit breaker** (#9541 decision 7) — after 3 consecutive
`batch-request-failed` batches (never `context-window-exceeded`, which
proves the provider IS reachable and resets the streak instead), the
embedding phase stops dispatching further provider requests and ends the
pass as a failure: `embedding provider failed 3 consecutive batches (last:
<reason>); stopped after <N> embeddings were stored — rerun akm index when
the endpoint is healthy`. Every batch already committed is kept; a genuine
caller abort (Ctrl-C, the improve budget) is a separate code path and stays
distinguishable. Mechanically, the materializer's `onSkip` callback (policy
lives with the caller, not the embedder) returns `false` on the batch that
trips the threshold; `RemoteEmbedder.embedBatch` honors that through its
existing dispatch-abort controller — the same one an `onBatch` persistence
failure already used to stop further dispatch — with a distinct reason, and
resolves normally with whatever results already landed rather than
rejecting. This is what turns an hours-long grind against a dead provider
(the field report's own symptom) into a fast, visible failure instead.

**Per-batch commit** — each provider (or local-embedder) batch is written to
`index.db` inside its own short `db.transaction()` as it completes, via an
`onBatch` callback threaded through both `RemoteEmbedder` and `LocalEmbedder`.
Earlier releases buffered every vector in memory and wrote them all in one
transaction at the very end of the whole run — an interruption (a competing
indexer collision, a killed process, any thrown error) discarded everything
already computed. Per-batch commit keeps whatever landed before the
interruption and keeps the exclusive-write window short enough for
`akm remember`/`akm improve` to interleave on the same stash.

**Progress and throughput** — a progress line (`Embedded N/M entries.`) is
emitted after EVERY committed batch (#9541 — the earlier 500-stored-entries
bucketing left a non-verbose run silent for its entire embedding phase on
any run smaller than 500 entries), and the heartbeat (every 15s while
waiting on the provider) names both the live stored AND failed counts:
`Still generating embeddings: X/N stored, F failed; waiting on embedding
provider.` The final line reports throughput: `Stored N embeddings in Xs
(Y.Y entries/s, ~Z tokens/s).` A failed provider batch itself logs at the
default `warn` level, not `--verbose`-only, naming the batch size and
reason — a silently grinding, hours-long run against a dead provider with
one aggregate warning at the very end was the field report's own symptom.
In the `akm index` CLI, phase-start messages and the heartbeat reach stderr
in non-verbose JSON/yaml output mode too (via `info()`); text mode keeps
its spinner instead, and `--verbose` gets everything, including the
high-frequency per-batch line JSON mode deliberately omits.

**Fingerprint verification (canary)** — a stored provider fingerprint
(`index_meta.embeddingFingerprint`, `{model, dimension}` derived from
`embedding.*`) that no longer matches the current config does NOT purge
unconditionally (#955). `generateEmbeddingsForDb` re-embeds a small sample
(up to 8) of already-stored entries with the current config and compares:

- the server-reported model identity (`index_meta.embeddingIdentity`,
  `remote:<model id the endpoint returned>|<vector width>` for a remote
  config, `local:<localModel>|<vector width>` for a local one) against what
  the canary observes this run — an exact match keeps the index without
  even looking at the vectors, since a config-only rename that still hits
  the same server-reported model cannot have changed the vectors;
- otherwise, the MEDIAN cosine similarity between each sampled stored
  vector and its freshly re-embedded counterpart — a rename that still
  resolves to the same underlying model lands its similarities at ~1.0,
  while a genuinely different model does not get there by chance. A median
  ≥ 0.999 keeps the index.

A sample whose re-embed FAILED (the provider skipped or errored on that
specific text) is excluded from the median rather than scored as zero
similarity: a partial provider failure is not evidence of a different
model. A dimension mismatch on a successful re-embed still counts as zero
(that IS evidence). If half or fewer of the sampled entries re-embedded
successfully, the run is `unverifiable` — the same outcome as a canary
that cannot reach the endpoint at all, below.

A kept index adopts the new fingerprint (and identity) immediately; a purge
writes them in the SAME transaction as the purge, before any embedding
request, so an interruption partway through a rebuild resumes on the next
run (only the still-missing entries get re-embedded) instead of purging
again from zero. A canary that cannot reach the endpoint at all leaves the
existing vectors and the OLD fingerprint untouched and reports failure, so
a down server does not destroy a working index — the next `akm index`
retries. `akm index --reembed` bypasses the canary entirely and forces a
purge + full re-embed. A genuine dimension change is unaffected: it is
caught earlier and unconditionally by `ensureSchema`
(`src/storage/repositories/index-schema.ts`), independent of this
fingerprint mechanism, since a change in vector width leaves nothing for
the canary to meaningfully compare.

## Progress Reporting

- text mode: shows a spinner with processed-versus-total source counts
- `--verbose`: prints phase progress to stderr
- structured output (`json`, `yaml`, `jsonl`): emits clean machine-readable output without spinner noise

## Database Tables

`index.db`'s schema (`ensureSchema()`,
`src/storage/repositories/index-schema.ts`) creates 16 unconditional logical
tables, including two FTS5 virtual tables. When the optional `sqlite-vec`
extension loads, it also creates `entries_vec`, a third, conditional virtual
table. Full column-level detail lives in
[Storage Locations](storage-locations.md#dataindexdb--main-search-index);
this is a purpose summary:

| Table | Purpose |
| --- | --- |
| `entries` | normalized asset records |
| `entries_fts` (virtual, FTS5) | multi-column full-text index |
| `entry_fragments` | safe Markdown projection retained per parent entry for fragment resolution |
| `entry_fragments_fts` (virtual, FTS5) | separate lexical body-fragment index; no copied parent metadata |
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
current generation is exactly v23. `ensureSchema()`
(`src/storage/repositories/index-schema.ts`) accepts an existing generation
only when `index_meta.version`, the complete `entries` fingerprint, and the
three logical search surfaces (`entries_fts`, `entry_fragments`, and
`entry_fragments_fts`) match the canonical contract. The fingerprint includes
`AUTOINCREMENT`, required columns, constraints, indexes, collation,
hidden-column absence, and exact regular/virtual-table DDL for the search
surfaces. An incompatible generation is discarded: AKM drops the
entry-dependent derived tables and caches, creates the canonical v23 schema,
and rebuilds it from current sources and durable usage state. In particular,
v22 is discarded because it predates the isolated fragment FTS population; v21
also predates entry-owned synchronous FTS publication and may contain stale
dirty-queue state. Current read-only and existing-database openers reject an
incompatible generation instead of serving it. Durable workflow, task,
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
- provider fingerprints include model/dimension for remote configs, deliberately EXCLUDING the endpoint — moving the same model+dimension to a different host does not force a rebuild
- fingerprint changes force semantic status back to pending until a rebuild
- `sqlite-vec` is optional; JS vector fallback still supports embeddings
