// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import type { BundleAdapter } from "../core/adapter/bundle-adapter";
import { detectAdapterId } from "../core/adapter/detect-adapter";
import { adapterForId } from "../core/adapter/registry";
import type { BundleComponent } from "../core/adapter/types";
import { isHttpUrl, toErrorMessage } from "../core/common";
import { concurrentMap } from "../core/concurrent";
import type { AkmConfig, LlmConnectionConfig } from "../core/config/config";
import { isLoopbackEndpoint } from "../core/loopback";
import { classifyPathAccess, describeInaccessiblePath } from "../core/path-access";
import { getDbPath } from "../core/paths";
import { SCRIPT_EXTENSIONS } from "../core/recognition-util";
import { withStateDb } from "../core/state-db";
import { isVerbose, warn, warnVerbose } from "../core/warn";
import { resolveIndexPassLLM } from "../llm/index-passes";
import { resolveSourcesForOrigin } from "../registry/origin-resolve";
/**
 * M-4 / #395 — Index Consistency Architecture Decision Record
 *
 * AKM maintains four indexes per stash:
 *   1. Frontmatter index (SQLite `entries` table) — asset metadata.
 *   2. FTS5 full-text search index (SQLite `entries_fts` virtual table).
 *   3. Vector (embedding) index (SQLite `embedding` / `vec_entries` table).
 *   4. Graph index (SQLite `graph_nodes`, `graph_edges` tables).
 *
 * Decision (2026-05-16): No transactional boundary spans all four indexes.
 * Each step is individually crash-tolerant; cross-step consistency is
 * **opportunistic recovery** — subsequent index runs detect and heal drift.
 *
 * Audit findings:
 *   - FTS5 is redundant with the main `entries` table when semantic search is
 *     on, but is the primary search path for keyword-only stashes.
 *   - The vector index depends on the `entries` table for entry IDs; orphan
 *     detection in `clearStaleCacheEntries` covers most drift cases.
 *   - The graph index is rebuilt from scratch on each extraction pass; it is
 *     not incremental, so cross-step drift resolves on the next extraction.
 *   - Eliminating any of the four indexes would break the current keyword/
 *     semantic/graph search paths. Merge is not currently feasible.
 *
 * Accepted strategy: opportunistic recovery (reindex heals drift).
 * CRDT-based convergence (Shapiro et al. 2011) would require per-operation
 * CRDTs for all four stores — deferred pending a dedicated storage refactor.
 *
 * See the index-consistency ADR (2026-06) for the full analysis.
 */
import type { Database } from "../storage/database";
import { closeDatabase, openExistingDatabase, openIndexDatabase } from "../storage/repositories/index-connection";
import {
  deleteEntriesByDirAndStash,
  deleteEntriesByDirExceptKeys,
  deleteEntriesByIds,
  deleteEntriesByStashDir,
  deleteUsageEventsByEntryIds,
  findEntryIdByRef,
  getAllEntries,
  getEmbeddableEntryCount,
  getEntryCount,
  getIndexedDirPathsByStashDir,
  getIndexedStashDirsByDir,
  relinkUsageEvents,
  upsertEntry,
  upsertWorkflowDocument,
} from "../storage/repositories/index-entries-repository";
import type { EntryProvenance } from "../storage/repositories/index-entry-types";
import { rebuildFts } from "../storage/repositories/index-fts-repository";
import { clearStaleCacheEntries } from "../storage/repositories/index-llm-cache-repository";
import {
  deleteIndexDirState,
  deleteIndexDirStatesByStashDir,
  deleteMeta,
  getMeta,
  setMeta,
  upsertIndexDirState,
} from "../storage/repositories/index-meta-repository";
import { upsertUtilityScore } from "../storage/repositories/index-utility-repository";
import {
  getAllEntriesForEmbedding,
  getEmbeddingCount,
  isVecAvailable,
  isVecFastPathReady,
  purgeEmbeddings,
  setVecFastPathReady,
  upsertEmbedding,
  warnIfVecMissing,
} from "../storage/repositories/index-vec-repository";
import { takeWorkflowDocument } from "../workflows/runtime/document-cache";
import { deleteStoredGraph } from "./db/graph-db";
import { withIndexWriterLease } from "./index-writer-lock";
import { deriveEntryProvenance, deriveInstallations } from "./installations";
import {
  canUseIncrementalSkip,
  computeDirFingerprint,
  getCachedZeroRowDirState,
  getDirIndexState,
  inferZeroRowReason,
} from "./passes/dir-staleness";
import { type IndexDocument, isEnrichmentComplete, isWorkflowSkipWarning, type StashFile } from "./passes/metadata";
import { drainDirDocuments } from "./scan/drain-dir";
import { buildSearchText } from "./search/search-fields";
import type { SearchSource } from "./search/search-source";
import {
  classifySemanticFailure,
  clearSemanticStatus,
  deriveSemanticProviderFingerprint,
  writeSemanticStatus,
} from "./search/semantic-status";
import { purgeOldUsageEvents } from "./usage/usage-events";
import type { FileContext } from "./walk/file-context";
import type { IndexRunContext, IndexVerification } from "./walk/index-context";
import { walkStashFlatWithStatus } from "./walk/walker";

// ── Types ───────────────────────────────────────────────────────────────────

export interface IndexCleanResult {
  /** Number of entries checked for disk presence. */
  checked: number;
  /** Number of entries deleted (0 when dryRun is true). */
  removed: number;
  /** Refs of entries whose source file was missing (also populated in dry-run). */
  removedRefs: string[];
  /** Whether the run was a dry-run (no deletions performed). */
  dryRun: boolean;
}

export interface IndexResponse {
  stashDir: string;
  totalEntries: number;
  generatedMetadata: number;
  indexPath: string;
  mode: "full" | "incremental";
  directoriesScanned: number;
  directoriesSkipped: number;
  warnings?: string[];
  verification: IndexVerification;
  /** Timing counters in milliseconds */
  timing?: {
    totalMs: number;
    walkMs: number;
    llmMs: number;
    embedMs: number;
    ftsMs: number;
    finalizeMs: number;
    cleanMs: number;
    preflightMs: number;
    leaseWaitMs: number;
    sourceCacheMs: number;
    endToEndMs: number;
  };
  /** Present when --clean was passed: stale-entry purge results. */
  clean?: IndexCleanResult;
  /**
   * Present when this run auto-detected a bundle's adapter and persisted it
   * to config.json (`bundles.<id>.components.<component>.adapter`) — a
   * maintenance-command config write that would otherwise be invisible
   * (R-056). Keyed by bundle id, valued by the detected adapter id.
   */
  configUpdated?: { detectedAdapters: Record<string, string> };
}

export interface IndexProgressEvent {
  phase: "summary" | "preflight" | "scan" | "llm" | "embeddings" | "fts" | "finalize" | "verify";
  message: string;
  processed?: number;
  total?: number;
}

interface IndexOptions {
  /**
   * The stash directory to index. Resolved once at each command boundary
   * (WI-9.10 CLI-wide sweep) and threaded in — the indexer no longer reads the
   * ambient stash-dir resolver. Every caller (source add, wiki, workflow,
   * setup, ensure-index, tests) already passes it.
   */
  stashDir: string;
  full?: boolean;
  /**
   * When true, run a post-pass after indexing that removes entries whose source
   * file no longer exists on disk. Remote entries (empty file_path) are skipped.
   */
  clean?: boolean;
  /**
   * When true (and `clean` is also true), report which entries would be removed
   * without actually deleting them.
   */
  dryRun?: boolean;
  onProgress?: (event: IndexProgressEvent) => void;
  signal?: AbortSignal;
  /**
   * Whether this run may materialize (clone/pull/fetch) cache-backed sources.
   * Default `true` — the sanctioned materialization callers (`akm index`,
   * source add/update/sync, improve's blocking preflight). A READ command's
   * inline auto-index passes `false` so query time never touches the network
   * (spec §14.3 / D11): absent source caches are skipped with a warning instead
   * of cloned.
   */
  hydrateSources?: boolean;
  /**
   * Whether adapter auto-detection may persist into config.json. Source-update
   * transactions disable this so a failed publication can restore lock/content/
   * index without also having to compensate an unrelated config write.
   */
  persistDetectedAdapters?: boolean;
  /**
   * Whether this run was triggered implicitly by another command's inline
   * auto-index rather than by an explicit `akm index`.
   *
   * Only affects DISCLOSURE, never behavior. The adapter-detection config
   * write (R-056) is always reported in the result envelope, but its stderr
   * notice is suppressed for implicit runs: a read command's stderr carries
   * its JSON error envelope, so an extra human-readable line there makes the
   * envelope unparseable for callers doing `JSON.parse(stderr)` — and would
   * also leak past `--quiet`, which a read command is entitled to honor.
   */
  implicit?: boolean;
}

interface IndexedDirCandidate {
  stash: StashFile | null;
  staleFiles: string[];
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("index interrupted");
  }
}

export function getDefaultLlmConcurrency(llmConfig?: LlmConnectionConfig): number {
  if (typeof llmConfig?.concurrency === "number") return llmConfig.concurrency;
  // Local model servers stay at 1 (single loaded model; parallel requests
  // trigger reload thrash); an absent or unparseable endpoint fails safe as
  // local. ONE classifier decides what "local" means (`core/loopback.ts`,
  // shared with the workflow engine's frozen concurrency default).
  if (isLoopbackEndpoint(llmConfig?.endpoint)) return 1;
  // Remote endpoints default to a modest 2-wide pool (owner ruling 2026-07-21):
  // enough to overlap request latency without hammering rate-limited APIs.
  // The explicit-override branch above only fires for
  // callers that put `concurrency` on the connection themselves —
  // `engines.<name>.concurrency` is a valid schema field but `resolveLlmEngineUse`
  // does NOT copy it into the resolved connection, so on the enrichment path the
  // auto-derived 1/2 is what runs (see docs/architecture/internals/indexing.md).
  return 2;
}

// ── Phase functions ──────────────────────────────────────────────────────────

/**
 * Source cache phase: ensure git stash caches are up to date and purge orphaned
 * entries from removed sources (incremental only).
 */
async function runSourceCachePhase(ctx: IndexRunContext): Promise<void> {
  const { db, config, sourceDirs, isIncremental, full } = ctx;

  if (isIncremental && !full) {
    // Purge entries from stash dirs that have been removed since the last run
    // (e.g. after `akm remove`) so orphaned entries don't linger.
    const prevStashDirsJson = getMeta(db, "stashDirs");
    if (prevStashDirsJson) {
      let prevStashDirs: string[] = [];
      try {
        const parsed: unknown = JSON.parse(prevStashDirsJson);
        if (Array.isArray(parsed)) {
          prevStashDirs = parsed.filter((d): d is string => typeof d === "string");
        } else {
          warn("index_meta stashDirs value is not an array — treating as empty");
        }
      } catch {
        warn("index_meta stashDirs value is corrupt JSON — treating as empty");
      }
      const currentSet = new Set(sourceDirs);
      for (const dir of prevStashDirs) {
        if (!currentSet.has(dir)) {
          ctx.hadRemovedSources = true;
          ctx.removedSourceDirs.push(dir);
        }
      }
    }
  }
  // Source caches are hydrated before akmIndex() calls this phase; nothing
  // further to do here. The flag is exposed on ctx for runWalkPhase().
  void config;
}

function applyRemovedSources(ctx: IndexRunContext): void {
  if (!ctx.scanComplete) return;
  for (const dir of ctx.removedSourceDirs) {
    deleteEntriesByStashDir(ctx.db, dir);
    deleteIndexDirStatesByStashDir(ctx.db, dir);
    deleteStoredGraph(ctx.db, dir);
  }
}

/**
 * Walk phase: scan the filesystem, generate metadata, and persist entries to
 * the database. Also kicks off LLM enrichment for directories that need it.
 *
 * Writes `ctx.scannedDirs`, `ctx.skippedDirs`, `ctx.generatedCount`,
 * `ctx.walkWarnings`, and `ctx.dirsNeedingLlm` for downstream phases.
 */
async function runWalkPhase(ctx: IndexRunContext): Promise<void> {
  const { db, sources, isIncremental, builtAtMs, hadRemovedSources, full, clean, signal, onProgress, config } = ctx;

  throwIfAborted(signal);

  ctx.timing.tWalkStart = Date.now();

  const doFullDelete = full || !isIncremental;
  const { scannedDirs, skippedDirs, generatedCount, dirsNeedingLlm, warnings, complete } = await indexEntries(
    db,
    sources,
    isIncremental,
    builtAtMs,
    hadRemovedSources,
    doFullDelete,
    onProgress,
    !clean,
  );

  ctx.scannedDirs = scannedDirs;
  ctx.skippedDirs = skippedDirs;
  ctx.generatedCount = generatedCount;
  ctx.walkWarnings = warnings;
  ctx.dirsNeedingLlm = dirsNeedingLlm;
  ctx.scanComplete = complete;

  onProgress({
    phase: "scan",
    message: `Scanned ${scannedDirs} ${scannedDirs === 1 ? "directory" : "directories"} and skipped ${skippedDirs}.`,
  });

  // Workflow validation noise gate (issue #273): suppress per-spec stderr lines
  // at default verbosity and emit a single summary instead.
  // In verbose mode the per-spec lines are already printed by
  // buildMetadataSkipWarning at generation time — no second pass needed here.
  if (!isVerbose()) {
    const workflowSkipWarnings = warnings.filter(isWorkflowSkipWarning);
    const skippedWorkflowCount = workflowSkipWarnings.length;
    if (skippedWorkflowCount > 0) {
      const noun = skippedWorkflowCount === 1 ? "workflow spec" : "workflow specs";
      warn(
        `${skippedWorkflowCount} ${noun} skipped due to validation errors; ` +
          "rerun with --verbose (or AKM_VERBOSE=1) to see details.",
      );
    }
  }

  ctx.timing.tWalkEnd = Date.now();

  throwIfAborted(signal);

  // LLM enrichment for directories that need it
  await enhanceDirsWithLlm(db, config, dirsNeedingLlm, onProgress, signal);
  onProgress({
    phase: "llm",
    message: resolveIndexPassLLM("enrichment", config)
      ? `LLM enhancement reviewed ${dirsNeedingLlm.length} ${dirsNeedingLlm.length === 1 ? "directory" : "directories"}.`
      : "LLM enhancement disabled.",
  });

  ctx.timing.tLlmEnd = Date.now();
}

/**
 * Embedding phase: generate and store vector embeddings for all unembedded
 * entries. Writes `ctx.embeddingResult` for the finalize phase.
 */
async function runEmbeddingPhase(ctx: IndexRunContext): Promise<void> {
  const { db, config, signal, onProgress } = ctx;

  throwIfAborted(signal);

  // Forward the signal. Without it generateEmbeddingsForDb's abort machinery was
  // inert — its throwIfAborted checks and the signal it threads into embedBatch
  // (which RemoteEmbedder passes to every fetch and LocalEmbedder honours between
  // chunks) never saw a controller. Ctrl-C and the improve budget abort could not
  // stop the embedding phase, the longest phase of an index run.
  ctx.embeddingResult = await generateEmbeddingsForDb(db, config, onProgress, signal);
  ctx.timing.tEmbedEnd = Date.now();
}

/**
 * Finalize phase: rebuild FTS, re-link usage events, recompute utility scores,
 * regenerate wiki indexes, update index metadata, and emit the verify event.
 */
async function runFinalizePhase(ctx: IndexRunContext): Promise<void> {
  const { db, config, sources, sourceDirs, isIncremental, stashDir, signal, onProgress } = ctx;
  ctx.timing.tFinalizeStart = Date.now();

  // Rebuild FTS after all inserts. Use incremental mode when this whole
  // index run is incremental — only entries touched by `upsertEntry`
  // since the last rebuild are re-indexed.
  rebuildFts(db, { incremental: isIncremental });
  onProgress({
    phase: "fts",
    message: isIncremental ? "Rebuilt full-text search index (dirty rows only)." : "Rebuilt full-text search index.",
  });
  ctx.timing.tFtsEnd = Date.now();

  // Re-link detached usage_events and recompute utility scores. The one-time
  // §11.4 legacy→item_ref re-key is owned by the migration cutover
  // (020-three-db-cutover) now, so index finalize only re-resolves entry_ids
  // (idempotent) — every stored `entry_ref` is already the item_ref spelling.
  //
  // Chunk-8 WI-8.3: usage_events lives in state.db now (index.db no longer holds
  // it), so these cross-DB passes take both handles — entries in `db` (index.db),
  // usage_events in the loaned state.db.
  withStateDb((stateDb) => {
    onProgress({ phase: "finalize", message: "Relinking usage events." });
    relinkUsageEvents(db, stateDb, { sources, defaultStashDir: stashDir });
    onProgress({ phase: "finalize", message: "Recomputing utility scores." });
    recomputeUtilityScores(db, stateDb);
  });

  // Purge LLM cache entries for assets that no longer exist in the index.
  try {
    onProgress({ phase: "finalize", message: "Clearing stale LLM cache entries." });
    clearStaleCacheEntries(db);
  } catch {
    /* ignore */
  }

  throwIfAborted(signal);

  // An incomplete run preserves the prior freshness watermark. Advancing it
  // could make a recovered source look unchanged even though this run never
  // persisted its files.
  const embeddingResult = ctx.embeddingResult ?? { success: false };
  if (ctx.scanComplete) {
    setMeta(db, "builtAt", new Date().toISOString());
    setMeta(db, "stashDir", stashDir);
    setMeta(db, "stashDirs", JSON.stringify(sourceDirs));
  }
  setMeta(db, "hasEmbeddings", embeddingResult.success ? "1" : "0");

  // Stash-organization conventions (SPEC-8): track which `index.indexBodyOpening`
  // state the index was built with, and warn while the flag diverges from it.
  const bodyOpeningWarning = reconcileBodyOpeningIndexState(
    db,
    config.index?.indexBodyOpening === true,
    (ctx.full || !isIncremental) && ctx.scanComplete,
  );
  if (bodyOpeningWarning) warn(bodyOpeningWarning);

  warnIfVecMissing(db);

  const totalEntries = getEntryCount(db);
  const semanticEntryCount = getEmbeddableEntryCount(db);
  onProgress({ phase: "finalize", message: "Verifying semantic search state." });
  const verification = verifyIndexState(db, config, semanticEntryCount, embeddingResult);

  if (config.semanticSearchMode === "off") {
    clearSemanticStatus();
  } else {
    writeSemanticStatus({
      status: verification.semanticStatus === "disabled" ? "pending" : verification.semanticStatus,
      ...(embeddingResult.reason ? { reason: embeddingResult.reason } : {}),
      ...(embeddingResult.message ? { message: embeddingResult.message } : {}),
      providerFingerprint: deriveSemanticProviderFingerprint(config.embedding),
      lastCheckedAt: new Date().toISOString(),
      entryCount: verification.entryCount,
      embeddingCount: verification.embeddingCount,
    });
  }
  onProgress({ phase: "verify", message: verification.message });

  // Store verification result and totalEntries on ctx for the caller to use
  ctx.verification = verification;
  ctx.totalEntries = totalEntries;
  ctx.timing.tFinalizeEnd = Date.now();

  // suppress unused warning — sources was previously used inline
  void sources;
}

/**
 * Stash-organization conventions (SPEC-8): reconcile the `index.indexBodyOpening`
 * flag with the state the index was last FULLY built with (index_meta key
 * `indexBodyOpening`), returning a warning message while they diverge.
 *
 * Incremental runs re-extract only changed files (and embeddings are only
 * generated for rows lacking one), so a flag toggle leaves the index MIXED
 * until a full rebuild — `akm index --full` re-extracts every entry and wipes
 * embeddings so they regenerate from the new text. The warning therefore
 * repeats on every incremental run until a full walk records the flag state
 * as applied.
 *
 * A missing meta key on an incremental run means the index predates this
 * feature, i.e. it was necessarily built with the flag OFF — so the absent
 * key reads (and is seeded) as "0", never as the current flag value. This
 * keeps the most likely real toggle scenario — upgrade, enable the flag, run
 * a plain `akm index` — warning until `--full` runs (review finding).
 *
 * Exported for tests; production's only caller is the finalize phase above.
 */
export function reconcileBodyOpeningIndexState(
  db: Database,
  flagEnabled: boolean,
  isFullWalk: boolean,
): string | undefined {
  const bodyOpeningFlag = flagEnabled ? "1" : "0";
  const prevBodyOpeningFlag = getMeta(db, "indexBodyOpening") ?? "0";
  // Only a full walk (which includes the first build ever) may record the
  // current flag as the applied state; incremental runs preserve — or, for a
  // pre-feature index, seed — the state of the last full build.
  setMeta(db, "indexBodyOpening", isFullWalk ? bodyOpeningFlag : prevBodyOpeningFlag);
  if (isFullWalk || prevBodyOpeningFlag === bodyOpeningFlag) return undefined;
  return (
    `index.indexBodyOpening is ${flagEnabled ? "enabled" : "disabled"} but the index was built with it ` +
    `${flagEnabled ? "disabled" : "enabled"}. Incremental runs only re-extract changed files, so ` +
    "indexed text and embeddings are stale for unchanged entries. Run `akm index --full` to apply the new " +
    "setting everywhere (embeddings regenerate), and re-mint collapse-detector canary baselines via " +
    "`bun scripts/refresh-canary-set.ts --refresh` if you use them."
  );
}

// ── Clean pass ───────────────────────────────────────────────────────────────

/**
 * Post-index clean pass: scan the `entries` table for rows whose source file
 * no longer exists on disk and remove them (unless `dryRun` is true).
 *
 * Only rows with a non-empty `file_path` are checked — remote/virtual entries
 * that have no local path are always skipped.
 *
 * "No longer exists" means ABSENT, never merely unreadable (#791). This pass
 * DELETES rows, and `fs.existsSync` reported `false` for a file akm lacked
 * permission to look at exactly as for one that had been removed — so a
 * bundle temporarily mounted read-restricted (a uid mismatch, a tightened
 * parent directory) had its whole index wiped, and the run reported the
 * deletions as a clean success. Unreadable files keep their rows and are
 * reported instead.
 */
function runCleanPass(db: Database, dryRun: boolean): IndexCleanResult {
  const allEntries = db.prepare("SELECT id, entry_key AS ref, file_path AS path FROM entries").all() as {
    id: number;
    ref: string;
    path: string;
  }[];

  // Only check entries that have a non-empty local path (skip remote/virtual).
  const localEntries = allEntries.filter((e) => typeof e.path === "string" && e.path.trim() !== "");

  const missing: typeof localEntries = [];
  const unreadable: Array<{ path: string; code?: string }> = [];
  for (const entry of localEntries) {
    const { access, code } = classifyPathAccess(entry.path);
    if (access === "absent") missing.push(entry);
    else if (access === "inaccessible") unreadable.push({ path: entry.path, ...(code ? { code } : {}) });
  }
  if (unreadable.length > 0) {
    const shown = unreadable.slice(0, 5).map((u) => describeInaccessiblePath(u.path, u.code));
    warn(
      `Index clean pass kept ${unreadable.length} entr${unreadable.length === 1 ? "y" : "ies"} whose file akm cannot ` +
        `read (unreadable is not deleted): ${shown.join("; ")}${unreadable.length > shown.length ? "; …" : ""}`,
    );
  }

  if (!dryRun && missing.length > 0) {
    deleteEntriesByIds(
      db,
      missing.map((e) => e.id),
    );
  }

  return {
    checked: localEntries.length,
    removed: dryRun ? 0 : missing.length,
    removedRefs: missing.map((e) => e.ref),
    dryRun,
  };
}

// ── Indexer ──────────────────────────────────────────────────────────────────

// ── Test seam ────────────────────────────────────────────────────────────────
// Swap-and-restore override. Inert in production; only tests call the setter.
let akmIndexOverride: typeof akmIndexReal | undefined;

/** TEST-ONLY. Swap the implementation of `akmIndex`; pass undefined to restore. */
export function _setAkmIndexForTests(fake?: typeof akmIndexReal): void {
  akmIndexOverride = fake;
}

export async function akmIndex(options: IndexOptions): Promise<IndexResponse> {
  if (akmIndexOverride) return akmIndexOverride(options);
  return akmIndexReal(options);
}

/**
 * Named observation points fired from INSIDE the reindex write transaction
 * (see {@link persistDirRecords}). TEST-ONLY.
 *
 *  - `full-delete-applied` — every `DELETE` of the full-rebuild wipe has run,
 *    but the re-insert has not started. This is the instant at which a
 *    non-atomic implementation would expose an empty database.
 *  - `records-persisted` — all rows are re-inserted, but the transaction has
 *    not committed yet, so the new generation is still invisible outside.
 */
export type IndexTransactionPoint = "full-delete-applied" | "records-persisted";

let indexTransactionHookForTests: ((point: IndexTransactionPoint) => void) | undefined;

/**
 * TEST-ONLY. Observe the in-flight reindex transaction; `undefined` restores.
 *
 * Exists because the delete-then-reinsert atomicity guarantee is, by
 * construction, invisible from outside the transaction: by the time
 * `akmIndex()` resolves, the commit has already collapsed both generations
 * into one observable state. Concurrency tests install a hook that opens a
 * SECOND connection at these points and asserts it still sees the previous
 * complete generation. Inert in production (one `undefined?.()` per reindex).
 */
export function _setIndexTransactionHookForTests(hook?: (point: IndexTransactionPoint) => void): void {
  indexTransactionHookForTests = hook;
}

/** Fire a named in-transaction observation point (no-op outside tests). */
function indexTransactionHook(point: IndexTransactionPoint): void {
  indexTransactionHookForTests?.(point);
}

/**
 * Detect an adapter for every resolvable source that does not declare one, and
 * persist each detection into `config.json`.
 *
 * R-056: this config write previously had zero disclosure — it appeared in no
 * result, on no stream, and in no doc. The returned `persistedAdapters` records
 * exactly which bundle→adapter pairs the mutate callback actually applied, so
 * the caller can surface them in the result envelope; a stderr notice is
 * emitted here. The map is cleared at the top of every callback invocation
 * because `mutateConfig` may retry optimistically, and a retry must not report
 * a superseded attempt.
 *
 * Extracted from `akmIndexReal` as one self-contained named pass, both to keep
 * that function under the src-wide function-size bar and because the detection
 * and its disclosure belong together.
 */
function detectAndPersistBundleAdapters(
  allSourceEntries: SearchSource[],
  config: AkmConfig,
  mutateConfig: typeof import("../core/config/config.js").mutateConfig,
  opts: { announce: boolean; persist: boolean },
): { config: AkmConfig; persistedAdapters: Record<string, string> } {
  const detectedByBundle = new Map<string, string>();
  for (const source of allSourceEntries) {
    if (source.adapterId || source.unresolved) continue;
    if (allSourceRootsReadable([source.path])) {
      source.adapterId = detectAdapterId(source.path);
      if (source.registryId) detectedByBundle.set(source.registryId, source.adapterId);
    }
  }

  const persistedAdapters: Record<string, string> = {};
  if (detectedByBundle.size === 0 || !opts.persist) return { config, persistedAdapters };

  const nextConfig = mutateConfig(
    (current) => {
      if (!current.bundles) return current;
      let changed = false;
      const bundles = { ...current.bundles };
      for (const key of Object.keys(persistedAdapters)) delete persistedAdapters[key];
      for (const [bundleId, adapter] of detectedByBundle) {
        const bundle = bundles[bundleId];
        if (!bundle) continue;
        const componentEntries = Object.entries(bundle.components ?? {});
        const [componentId, component] = componentEntries[0] ?? ["main", {}];
        if (component.adapter) continue;
        bundles[bundleId] = { ...bundle, components: { [componentId]: { ...component, adapter } } };
        changed = true;
        persistedAdapters[bundleId] = adapter;
      }
      return changed ? { ...current, bundles } : current;
    },
    { absentNoop: true },
  ).config;

  const persistedCount = Object.keys(persistedAdapters).length;
  if (persistedCount > 0 && opts.announce) {
    const summary = Object.entries(persistedAdapters)
      .map(([bundleId, adapter]) => `${bundleId} → ${adapter}`)
      .join(", ");
    warn(
      `[index] Detected adapter${persistedCount === 1 ? "" : "s"} for ${summary}; persisted to config.json ` +
        "(bundles.<id>.components.<component>.adapter).",
    );
  }
  return { config: nextConfig, persistedAdapters };
}

async function akmIndexReal(options: IndexOptions): Promise<IndexResponse> {
  // R-022: `dryRun` only ever gated the `--clean` stale-entry removal pass
  // (see `runCleanPass` below) — every other phase (walk, LLM enrichment,
  // embeddings, FTS, the adapter-detection config write) ran for real
  // regardless, so `akm index --dry-run` alone silently performed a full,
  // real index. The flag's own docs (`IndexOptions.dryRun` above, and the
  // CLI help in stash-cli.ts) already scope it to `--clean`; reject the
  // combination that was never implemented instead of quietly doing
  // something other than what "dry run" promised. Checked before the writer
  // lease is even requested so a bad invocation fails instantly.
  if (options?.dryRun === true && options?.clean !== true) {
    const { UsageError } = await import("../core/errors.js");
    throw new UsageError(
      "`--dry-run` only applies together with `--clean` (it previews which stale entries `--clean` would remove). " +
        "Pass `akm index --clean --dry-run`, or drop `--dry-run` to run a real index.",
      "INVALID_FLAG_VALUE",
      "Run `akm index --clean --dry-run` to preview, or `akm index --clean` to apply.",
    );
  }
  const requestedAt = Date.now();
  let acquiredAt = requestedAt;
  return withIndexWriterLease(
    {
      purpose: "akm-index",
      signal: options?.signal,
      onWait: ({ waitedMs }) => {
        options?.onProgress?.({
          phase: "preflight",
          message: `Waiting for index writer lease (${Math.round(waitedMs / 1000)}s elapsed).`,
        });
      },
      onAcquired: ({ waitedMs }) => {
        acquiredAt = requestedAt + waitedMs;
      },
    },
    async () => {
      const stashDir = options.stashDir;
      const onProgress = options?.onProgress ?? (() => {});
      const signal = options?.signal;
      const full = options?.full === true;
      const clean = options?.clean === true;
      const dryRun = options?.dryRun === true;

      // Load config and resolve all stash sources
      const { loadConfig, mutateConfig } = await import("../core/config/config.js");
      let config = loadConfig();

      // Durable state must be runtime-compatible before source hydration,
      // adapter persistence, or index.db creation can mutate the installation.
      onProgress({ phase: "preflight", message: "Validating durable state." });
      withStateDb(() => undefined);

      // Ensure git stash caches are extracted before resolving stash dirs,
      // so their content directories exist on disk for the walker to discover.
      const sourceCacheStart = Date.now();
      onProgress({ phase: "preflight", message: "Hydrating source caches." });
      const { ensureSourceCaches, resolveSourceEntries } = await import("./search/search-source.js");
      // Inject the store-backed secret resolver from here — a composition root
      // ABOVE the provider/fetcher import cycle (this module reaches
      // search-source only via dynamic import). This is what lets a website
      // source's X fetcher resolve `secrets/x-bearer-token` during
      // bundle-update / hydrate, not just from the command-layer URL-ingest
      // path. `secret-seam` is imported here, never from inside the cycle.
      const { storeSecretResolver } = await import("../sources/snapshot-fetchers/secret-seam.js");
      await ensureSourceCaches(config, {
        force: full,
        materialize: options.hydrateSources !== false,
        secrets: storeSecretResolver,
      });
      const sourceCacheEnd = Date.now();
      const allSourceEntries = resolveSourceEntries(stashDir, config);
      const detected = detectAndPersistBundleAdapters(allSourceEntries, config, mutateConfig, {
        announce: options.implicit !== true,
        persist: options.persistDetectedAdapters !== false,
      });
      config = detected.config;
      const persistedAdapters = detected.persistedAdapters;
      const allSourceDirs = allSourceEntries.map((s) => s.path);
      onProgress({
        phase: "preflight",
        message: `Resolved ${allSourceDirs.length} stash source${allSourceDirs.length === 1 ? "" : "s"}.`,
      });

      const t0 = Date.now();

      // Open database — pass embedding dimension from config if available
      const dbPath = getDbPath();
      const embeddingDim = config.embedding?.dimension;
      const db = openIndexDatabase(dbPath, embeddingDim ? { embeddingDim } : undefined);

      try {
        // Determine incremental vs full mode
        const prevStashDir = getMeta(db, "stashDir");
        const prevBuiltAt = getMeta(db, "builtAt");
        const isIncremental = !full && prevStashDir === stashDir && !!prevBuiltAt;
        const builtAtMs = isIncremental && prevBuiltAt ? new Date(prevBuiltAt).getTime() : 0;

        // Assemble the run context
        const ctx: IndexRunContext = {
          db,
          config,
          sources: allSourceEntries,
          sourceDirs: allSourceDirs,
          full,
          clean,
          stashDir,
          onProgress,
          signal,
          timing: {
            t0,
            tWalkStart: t0,
            tWalkEnd: t0,
            tLlmEnd: t0,
            tFtsEnd: t0,
            tEmbedEnd: t0,
            tFinalizeStart: t0,
            tFinalizeEnd: t0,
          },
          isIncremental,
          builtAtMs,
          hadRemovedSources: false,
          removedSourceDirs: [],
          scanComplete: true,
          scannedDirs: 0,
          skippedDirs: 0,
          generatedCount: 0,
          walkWarnings: [],
          dirsNeedingLlm: [],
          embeddingResult: null,
        };

        onProgress({
          phase: "summary",
          message: buildIndexSummaryMessage({
            mode: isIncremental ? "incremental" : "full",
            sourcesCount: allSourceDirs.length,
            semanticSearchMode: config.semanticSearchMode,
            embeddingProvider: getEmbeddingProvider(config.embedding),
            llmEnabled: !!resolveIndexPassLLM("enrichment", config),
            vecAvailable: isVecAvailable(db),
          }),
        });

        // ── Phase sequence ───────────────────────────────────────────────────────
        await runSourceCachePhase(ctx);
        await runWalkPhase(ctx);
        applyRemovedSources(ctx);
        await runEmbeddingPhase(ctx);
        await runFinalizePhase(ctx);
        // ────────────────────────────────────────────────────────────────────────

        // runFinalizePhase always populates these before returning.
        const verification = ctx.verification as IndexVerification;
        const totalEntries = ctx.totalEntries as number;
        const { timing } = ctx;

        // ── Clean pass ───────────────────────────────────────────────────────────
        // After the normal index completes, remove entries whose source files no
        // longer exist on disk. Remote entries (empty file_path) are skipped.
        let cleanResult: IndexCleanResult | undefined;
        const cleanStart = Date.now();
        if (clean) {
          onProgress({
            phase: "finalize",
            message: dryRun ? "Scanning for stale index entries (dry run)." : "Removing stale index entries.",
          });
          if (ctx.scanComplete) {
            cleanResult = runCleanPass(db, dryRun);
          } else {
            warn("[index] --clean skipped because one or more configured sources were not scanned completely.");
            cleanResult = { checked: 0, removed: 0, removedRefs: [], dryRun };
          }
        }
        const cleanEnd = Date.now();
        // ────────────────────────────────────────────────────────────────────────

        return {
          stashDir,
          totalEntries,
          generatedMetadata: ctx.generatedCount,
          indexPath: dbPath,
          mode: isIncremental ? "incremental" : "full",
          directoriesScanned: ctx.scannedDirs,
          directoriesSkipped: ctx.skippedDirs,
          ...(ctx.walkWarnings.length > 0 ? { warnings: ctx.walkWarnings } : {}),
          ...(Object.keys(persistedAdapters).length > 0
            ? { configUpdated: { detectedAdapters: persistedAdapters } }
            : {}),
          verification,
          timing: {
            totalMs: Date.now() - timing.t0,
            walkMs: timing.tWalkEnd - timing.tWalkStart,
            llmMs: timing.tLlmEnd - timing.tWalkEnd,
            embedMs: timing.tEmbedEnd - timing.tLlmEnd,
            ftsMs: timing.tFtsEnd - timing.tEmbedEnd,
            finalizeMs: timing.tFinalizeEnd - timing.tFinalizeStart,
            cleanMs: clean ? cleanEnd - cleanStart : 0,
            preflightMs: timing.t0 - requestedAt,
            leaseWaitMs: acquiredAt - requestedAt,
            sourceCacheMs: sourceCacheEnd - sourceCacheStart,
            endToEndMs: Date.now() - requestedAt,
          },
          ...(cleanResult !== undefined ? { clean: cleanResult } : {}),
        };
      } finally {
        closeDatabase(db);
      }
    },
  );
}

// ── Extracted helpers for indexing ────────────────────────────────────────────

type DirScanReason = {
  kind:
    | "duplicate-dir"
    | "no-indexable-files"
    | "unchanged"
    | "index-context-changed"
    | "full-rebuild"
    | "no-previous-rows"
    | "cached-zero-row-state"
    | "mtime-changed"
    | "file-set-changed"
    | "missing-file"
    | "not-in-source-snapshot";
  detail?: string;
};

type DirRecord = {
  dirPath: string;
  currentStashDir: string;
  files: string[];
  stash: StashFile | null;
  skip: boolean;
  reason?: DirScanReason;
  persistedRowCount?: number;
  /**
   * F4a M-core-2: `doc.hash` keyed by recognized-file absolute path, produced by
   * the per-dir document drain. Read by the persist layer to populate
   * `content_hash`. Absent on skipped dirs (nothing drained).
   */
  hashByFile?: Map<string, string>;
  /**
   * `doc.conceptId` keyed by recognized-file absolute path — the OWNING
   * adapter's identity, preferred by the persist layer over akm's
   * `stashDirFor` re-derivation (D-R3 identity fidelity for non-akm adapters).
   */
  conceptIdByFile?: Map<string, string>;
  /** Adapter id/version folded into incremental directory freshness. */
  indexVariant?: string;
  /** Persisted directory omitted by the current successful adapter walk. */
  remove?: boolean;
  /** False when traversal uncertainty makes absent-file pruning unsafe. */
  pruneMissing?: boolean;
};

type DirNeedingLlm = {
  dirPath: string;
  files: string[];
  currentStashDir: string;
  stash: StashFile;
};

type SourceScanPlan = {
  currentStashDir: string;
  component: BundleComponent;
  adapter?: BundleAdapter;
  indexVariant?: string;
  dirGroups: Map<string, FileContext[]>;
  removals: Array<DirRecord & { reason: DirScanReason }>;
  walkComplete: boolean;
};

type SourceScanResult = {
  dirRecords: DirRecord[];
  scannedDirs: number;
  skippedDirs: number;
  generatedCount: number;
  warnings: string[];
  complete: boolean;
};

function removalsFirst(records: DirRecord[]): DirRecord[] {
  return [...records.filter((record) => record.remove), ...records.filter((record) => !record.remove)];
}

function addEntryIds(target: Set<number>, ids: number[]): void {
  for (const id of ids) target.add(id);
}

/**
 * Map each source root → its durable `BundleComponent` (`deriveInstallations`,
 * batch-unique bundle ids, source order preserved). The per-dir document drain
 * dispatches `adapterForId(component.adapter).recognize` for this component. The
 * component id only surfaces on `IndexDocument.ref`, which the persist layer
 * re-derives independently — so a source missing from the map (never happens: the
 * map is built from the same sources) is harmless.
 */
function buildComponentBySource(sources: SearchSource[]): Map<string, BundleComponent> {
  const map = new Map<string, BundleComponent>();
  const installations = deriveInstallations(sources);
  sources.forEach((source, i) => {
    const component = installations[i]?.components[0];
    if (component) map.set(source.path, component);
  });
  return map;
}

function componentForSource(components: Map<string, BundleComponent>, sourcePath: string): BundleComponent {
  return (
    components.get(sourcePath) ?? {
      id: sourcePath,
      adapter: "akm",
      root: sourcePath,
      writable: false,
    }
  );
}

function groupFileContextsByDir(fileContexts: FileContext[]): Map<string, FileContext[]> {
  const groups = new Map<string, FileContext[]>();
  for (const ctx of fileContexts) {
    const group = groups.get(ctx.parentDirAbs);
    if (group) group.push(ctx);
    else groups.set(ctx.parentDirAbs, [ctx]);
  }
  return groups;
}

function sourceSnapshotRemovals(
  db: Database,
  currentStashDir: string,
  currentDirs: ReadonlySet<string>,
  allIndexedDirsBySource?: ReadonlyMap<string, ReadonlySet<string>>,
): Array<DirRecord & { reason: DirScanReason }> {
  const indexedDirs =
    allIndexedDirsBySource?.get(path.resolve(currentStashDir)) ?? getIndexedDirPathsByStashDir(db, currentStashDir);
  return [...indexedDirs]
    .map((dirPath) => path.resolve(dirPath))
    .filter((dirPath) => !currentDirs.has(dirPath))
    .map((dirPath) => ({
      dirPath,
      currentStashDir,
      files: [],
      stash: null,
      skip: false,
      remove: true,
      reason: { kind: "not-in-source-snapshot" },
    }));
}

function buildSourceScanPlans(
  db: Database,
  allSourceEntries: SearchSource[],
  isIncremental: boolean,
  reconcileMissingDirs: boolean,
): { plans: SourceScanPlan[]; handoffDirs: Set<string> } {
  const componentBySource = buildComponentBySource(allSourceEntries);
  const handoffDirs = new Set<string>();
  const plans = allSourceEntries.map((sourceAdded): SourceScanPlan => {
    const currentStashDir = sourceAdded.path;
    const component = componentForSource(componentBySource, currentStashDir);
    if (sourceAdded.unresolved) {
      return {
        currentStashDir,
        component,
        adapter: undefined,
        indexVariant: undefined,
        dirGroups: new Map(),
        removals: [],
        walkComplete: false,
      };
    }
    const walked = walkStashFlatWithStatus(currentStashDir, {
      includeAllDirectories: component.adapter === "okf",
    });
    const dirGroups = groupFileContextsByDir(walked.files);
    const adapter = adapterForId(component.adapter);
    return {
      currentStashDir,
      component,
      adapter,
      indexVariant: adapter ? `${adapter.id}@${adapter.version}` : undefined,
      dirGroups,
      removals: [],
      walkComplete: walked.complete,
    };
  });

  const removalKeys = new Set<string>();
  const addRemoval = (plan: SourceScanPlan, dirPath: string, stashDir: string) => {
    const resolvedDir = path.resolve(dirPath);
    const key = `${resolvedDir}\0${path.resolve(stashDir)}`;
    if (removalKeys.has(key)) return;
    removalKeys.add(key);
    plan.removals.push({
      dirPath,
      currentStashDir: stashDir,
      files: [],
      stash: null,
      skip: false,
      remove: true,
      reason: { kind: "not-in-source-snapshot" },
    });
    handoffDirs.add(resolvedDir);
  };

  const allComplete = plans.every((plan) => plan.walkComplete && plan.adapter !== undefined);

  // A full, globally-complete run uses the atomic table wipe below. Every
  // other run reconciles only sources that produced trustworthy snapshots.
  if (reconcileMissingDirs && (isIncremental || !allComplete)) {
    const allIndexedDirsBySource = !isIncremental ? new Map<string, Set<string>>() : undefined;
    if (allIndexedDirsBySource) {
      for (const entry of getAllEntries(db)) {
        const sourceRoot = path.resolve(entry.stashDir);
        const dirs = allIndexedDirsBySource.get(sourceRoot) ?? new Set<string>();
        dirs.add(path.resolve(entry.dirPath));
        allIndexedDirsBySource.set(sourceRoot, dirs);
      }
    }
    for (const plan of plans) {
      if (!plan.walkComplete || !plan.adapter) continue;
      const currentDirs = new Set([...plan.dirGroups.keys()].map((dirPath) => path.resolve(dirPath)));
      for (const removal of sourceSnapshotRemovals(db, plan.currentStashDir, currentDirs, allIndexedDirsBySource)) {
        addRemoval(plan, removal.dirPath, removal.currentStashDir);
      }
    }
  }

  // Cross-source ownership handoffs can delete another source's rows, so they
  // still require every possible owner to have completed its scan.
  if (!allComplete) return { plans, handoffDirs };

  // The first configured source that exposes a physical directory owns it.
  // Remove rows left by a prior owner even when both adapters are identical.
  const claimedDirs = new Set<string>();
  for (const plan of plans) {
    for (const dirPath of plan.dirGroups.keys()) {
      const resolvedDir = path.resolve(dirPath);
      if (claimedDirs.has(resolvedDir)) continue;
      claimedDirs.add(resolvedDir);
      for (const priorOwner of getIndexedStashDirsByDir(db, dirPath)) {
        if (path.resolve(priorOwner) !== path.resolve(plan.currentStashDir)) {
          addRemoval(plan, dirPath, priorOwner);
        }
      }
    }
  }
  return { plans, handoffDirs };
}

/**
 * Phase 1 (async): walk every source directory and pre-generate all metadata
 * outside any transaction, producing the per-directory scan records that
 * {@link persistDirRecords} later writes.
 *
 * The per-dir document drain (`drainDirDocuments` × the component's dispatched
 * `adapter.recognize`, F4a M-core-2) is synchronous, but the walk still runs
 * outside `db.transaction()` so the persist pass can be a single synchronous
 * transaction.
 */
function reportSourceScanProgress(
  onProgress: ((event: IndexProgressEvent) => void) | undefined,
  processed: number,
  total: number,
  message: string,
): void {
  onProgress?.({ phase: "scan", message, processed, total });
}

async function scanSourceDirs(
  db: Database,
  allSourceEntries: SearchSource[],
  isIncremental: boolean,
  builtAtMs: number,
  hadRemovedSources: boolean,
  onProgress?: (event: IndexProgressEvent) => void,
  reconcileMissingDirs = true,
): Promise<SourceScanResult> {
  let scannedDirs = 0;
  let skippedDirs = 0;
  let generatedCount = 0;
  const warnings: string[] = [];
  const seenPaths = new Set<string>();
  const { plans, handoffDirs } = buildSourceScanPlans(db, allSourceEntries, isIncremental, reconcileMissingDirs);

  const dirRecords: DirRecord[] = [];
  let processedDirs = 0;
  let priorDirsChanged = hadRemovedSources;

  const reportScanProgress = (message: string) =>
    reportSourceScanProgress(onProgress, processedDirs, allSourceEntries.length, message);

  const reportDirDecision = (
    kind: "scan" | "skip",
    dirPath: string,
    currentStashDir: string,
    reason: DirScanReason,
    persistedRowCount?: number,
  ) => {
    if (!isVerbose()) return;
    const detail = reason.detail ? ` (${reason.detail})` : "";
    const rowInfo = persistedRowCount !== undefined ? `; previous rows=${persistedRowCount}` : "";
    reportScanProgress(
      `${kind === "scan" ? "Rescanning" : "Skipping"} ${path.relative(currentStashDir, dirPath) || "."} ` +
        `from ${currentStashDir}: ${reason.kind}${detail}${rowInfo}`,
    );
  };

  // Only the first source that exposes a physical directory may index it.
  const markSeenOrSkipDuplicate = (dirPath: string, currentStashDir: string, files: string[]): boolean => {
    const resolved = path.resolve(dirPath);
    if (seenPaths.has(resolved)) {
      const reason = { kind: "duplicate-dir" } satisfies DirScanReason;
      dirRecords.push({ dirPath, currentStashDir, files, stash: null, skip: true, reason });
      reportDirDecision("skip", dirPath, currentStashDir, reason);
      return true;
    }
    seenPaths.add(resolved);
    return false;
  };

  // Incremental freshness gate shared by both branches: consult the persisted
  // dir state and record either a skip (unchanged + eligible for incremental
  // skip) or a scan record carrying the candidate stash.
  const recordFreshnessDecision = (
    dirPath: string,
    currentStashDir: string,
    stateFiles: string[],
    stash: StashFile | null,
    hashByFile: Map<string, string>,
    conceptIdByFile: Map<string, string>,
    indexVariant: string,
    forceScan: boolean,
    pruneMissing: boolean,
  ): void => {
    const previousState = getDirIndexState(db, dirPath, stateFiles, builtAtMs, indexVariant);
    if (isIncremental && !forceScan && !previousState.stale && canUseIncrementalSkip(previousState, priorDirsChanged)) {
      skippedDirs++;
      dirRecords.push({
        dirPath,
        currentStashDir,
        files: stateFiles,
        stash: null,
        skip: true,
        reason: previousState.reason,
        indexVariant,
      });
      reportDirDecision("skip", dirPath, currentStashDir, previousState.reason, previousState.persistedRowCount);
      return;
    }

    scannedDirs++;
    priorDirsChanged = true;
    const reason = isIncremental ? previousState.reason : ({ kind: "full-rebuild" } satisfies DirScanReason);
    dirRecords.push({
      dirPath,
      currentStashDir,
      files: stateFiles,
      stash,
      skip: false,
      reason,
      persistedRowCount: previousState.persistedRowCount,
      hashByFile,
      conceptIdByFile,
      indexVariant,
      pruneMissing,
    });
    reportDirDecision("scan", dirPath, currentStashDir, reason, previousState.persistedRowCount);
  };

  for (const plan of plans) {
    const { currentStashDir, component, adapter, dirGroups, removals, walkComplete } = plan;
    processedDirs++;
    reportScanProgress(
      `Processed ${processedDirs}/${allSourceEntries.length} source${allSourceEntries.length === 1 ? "" : "s"}.`,
    );

    if (!walkComplete) {
      for (const dirPath of dirGroups.keys()) seenPaths.add(path.resolve(dirPath));
      warn(`[index] source "${component.id}" was not scanned completely; preserving its last-known-good rows.`);
      continue;
    }

    // Owner ruling 2026-07-21: dispatch each component's DETECTED adapter (§4).
    // An unknown adapter id has no `adapterForId` match → skip the whole
    // component with a warning (one bundle = one component = one adapter).
    if (!adapter) {
      for (const dirPath of dirGroups.keys()) seenPaths.add(path.resolve(dirPath));
      warn(`Skipping component "${component.id}": unknown adapter id "${component.adapter}".`);
      continue;
    }
    const indexVariant = plan.indexVariant ?? `${adapter.id}@${adapter.version}`;

    for (const removal of removals) {
      dirRecords.push(removal);
      scannedDirs++;
      priorDirsChanged = true;
      reportDirDecision("scan", removal.dirPath, currentStashDir, removal.reason);
    }

    for (const [dirPath, ctxs] of dirGroups) {
      // Adapter-owned filtering (owner ruling 2026-07-21): the drain no longer
      // pre-filters with AKM-stash policy — each adapter's `recognize` claims or
      // abstains on its own bundle's walked files. The core walk keeps only the
      // universal hygiene `walkStashFlat` already applies (.git/dot-dirs/etc.).
      const indexableFiles = ctxs.map((ctx) => ctx.absPath);
      const forceScan = handoffDirs.has(path.resolve(dirPath));

      if (markSeenOrSkipDuplicate(dirPath, currentStashDir, indexableFiles)) continue;

      if (indexableFiles.length === 0) {
        skippedDirs++;
        const reason = { kind: "no-indexable-files" } satisfies DirScanReason;
        dirRecords.push({ dirPath, currentStashDir, files: indexableFiles, stash: null, skip: true, reason });
        reportDirDecision("skip", dirPath, currentStashDir, reason);
        continue;
      }

      const cachedZeroRowState =
        isIncremental &&
        !forceScan &&
        getCachedZeroRowDirState(db, dirPath, indexableFiles, builtAtMs, priorDirsChanged, indexVariant);
      if (cachedZeroRowState) {
        skippedDirs++;
        dirRecords.push({
          dirPath,
          currentStashDir,
          files: indexableFiles,
          stash: null,
          skip: true,
          reason: cachedZeroRowState.reason,
          indexVariant,
        });
        reportDirDecision(
          "skip",
          dirPath,
          currentStashDir,
          cachedZeroRowState.reason,
          cachedZeroRowState.persistedRowCount,
        );
        continue;
      }

      // F4a M-core-2 (the flip): drain the dir's `IndexDocument` stream via the
      // component's dispatched `adapter.recognize` (broken workflows dropped-with-
      // warning at the drain layer) and reconstruct the durable `IndexDocument`s.
      const drained = drainDirDocuments(adapter, component, ctxs);
      if (drained.warnings.length) warnings.push(...drained.warnings);
      const generated: StashFile = drained.warnings.length
        ? { entries: drained.entries, warnings: drained.warnings }
        : { entries: drained.entries };

      // `.stash.json` sidecar overrides retired (#39): the cutover's content
      // migration folded sidecar metadata into frontmatter and deleted the
      // files; the runtime no longer reads them.
      const { stash, staleFiles } = buildIndexedDirCandidate(dirPath, indexableFiles, generated);

      if (generated.entries.length > 0) {
        generatedCount += generated.entries.length;
      }

      recordFreshnessDecision(
        dirPath,
        currentStashDir,
        staleFiles,
        stash,
        drained.hashByFile,
        drained.conceptIdByFile,
        indexVariant,
        forceScan,
        walkComplete,
      );
    }
  }

  return {
    dirRecords: removalsFirst(dirRecords),
    scannedDirs,
    skippedDirs,
    generatedCount,
    warnings,
    complete: plans.every((plan) => plan.walkComplete && plan.adapter !== undefined),
  };
}

function preserveExistingIndex(
  doFullDelete: boolean,
  dirRecords: DirRecord[],
  sourceRoots: readonly string[],
): boolean {
  if (!doFullDelete) return false;
  const incomingDocCount = dirRecords.reduce(
    (n, record) => n + (record.skip ? 0 : (record.stash?.entries.length ?? 0)),
    0,
  );
  if (incomingDocCount > 0 || allSourceRootsReadable(sourceRoots)) return false;
  warn(
    "[index] --full produced zero documents while one or more source roots are missing or unreadable — " +
      "preserving the existing index (last-known-good) rather than wiping it. Re-run once the sources are available.",
  );
  return true;
}

/**
 * #624-P1 zero-document preflight probe. A source root counts as "readable"
 * when it exists on disk as a directory whose listing can be read. A root that
 * is missing or unreadable (a transient mount failure, a permission race, or a
 * source that vanished mid-run) makes a zero-document scan untrustworthy: the
 * walk saw nothing not because the stash is empty but because it could not be
 * read. Returns true only when EVERY root is readable, so a single unreadable
 * root blocks the full-rebuild wipe.
 */
function allSourceRootsReadable(roots: readonly string[]): boolean {
  for (const root of roots) {
    try {
      const st = fs.statSync(root);
      if (!st.isDirectory()) return false;
      fs.readdirSync(root); // probe readability, not just existence
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Phase 2 (sync): write all pre-generated scan records inside a single
 * transaction, returning the directories that still need LLM enrichment.
 */
function persistDirRecords(
  db: Database,
  dirRecords: DirRecord[],
  doFullDelete: boolean,
  warnings: string[],
  sourceRoots: readonly string[],
  scanComplete: boolean,
  bundleByRoot: ReadonlyMap<string, { bundleId: string; componentId: string; adapterId: string }>,
): { dirsNeedingLlm: DirNeedingLlm[] } {
  const dirsNeedingLlm: DirNeedingLlm[] = [];
  const fullDelete = doFullDelete && scanComplete;

  // #624-P1 zero-document preflight (spec §4). A full-rebuild wipe is a
  // legitimate mass-delete ONLY when the scan legitimately found nothing. If
  // the walk produced zero documents AND any configured source root is missing
  // or unreadable, the empty result is almost certainly a transient scan
  // failure, not an emptied stash — wiping here would cascade-destroy the
  // last-known-good index (entries + embeddings + utility/usage). Preserve it
  // and warn instead; the next successful run reconciles. A genuinely empty
  // stash whose roots ARE readable still wipes, as before.
  if (preserveExistingIndex(fullDelete, dirRecords, sourceRoots)) return { dirsNeedingLlm };

  // Per-source dedup: the same logical asset can appear more than once within
  // one owning source, where source order still makes the first occurrence win.
  // The owner is part of the key so identical concepts in different bundles
  // remain distinct indexed rows.
  const indexedAssetIdentities = new Set<string>();
  const deletedUsageEntryIds = new Set<number>();

  const insertTransaction = db.transaction(() => {
    // Perform the full-rebuild wipe as the FIRST step of the insert
    // transaction so delete and re-insert are atomic — a concurrent reader
    // never observes an empty database between the two operations.
    if (fullDelete) {
      try {
        db.exec("DELETE FROM embeddings");
      } catch {
        /* ignore */
      }
      if (isVecAvailable(db)) {
        try {
          db.exec("DELETE FROM entries_vec");
        } catch {
          /* ignore */
        }
      }
      db.exec("DELETE FROM entries_fts");
      db.exec("DELETE FROM utility_scores");
      db.exec("DELETE FROM index_dir_state");
      // Chunk-8 WI-8.3: usage_events lives in state.db now (not index.db), so the
      // wipe no longer detaches it here. The finalize pass's relinkUsageEvents
      // (cross-DB) nulls entry_ids that no longer resolve to a rebuilt entry and
      // re-resolves the rest by entry_ref — subsuming the old detach.
      db.exec("DELETE FROM entries");
      // Atomicity observation point: inside the transaction the tables are now
      // empty, but no other connection may observe that. See
      // tests/integration/indexer/reindex-generation-atomicity.test.ts.
      indexTransactionHook("full-delete-applied");
    }

    for (const {
      dirPath,
      currentStashDir,
      files,
      stash,
      skip,
      reason,
      hashByFile,
      conceptIdByFile,
      indexVariant,
      remove,
      pruneMissing,
    } of dirRecords) {
      if (remove) {
        const removedIds = deleteEntriesByDirAndStash(db, dirPath, currentStashDir, { cleanupUsageEvents: false });
        addEntryIds(deletedUsageEntryIds, removedIds);
        deleteIndexDirState(db, dirPath);
        continue;
      }
      if (skip) {
        if (reason?.kind === "unchanged") {
          const fingerprint = computeDirFingerprint(dirPath, files, indexVariant);
          upsertIndexDirState(db, {
            dirPath,
            fileSetHash: fingerprint.fileSetHash,
            fileMtimeMaxMs: fingerprint.fileMtimeMaxMs,
            reason: reason.kind,
          });
        }
        continue;
      }

      // Diff-persist (F4a M-core-2, spec §14.2): upsert the current file set
      // FIRST (ON CONFLICT preserving `entries.id` so embeddings / utility /
      // usage stay attached to unchanged rows), tracking every upserted
      // `entry_key`, then prune only the DEPARTED rows below. Replaces the old
      // `deleteEntriesByDir` truncate-and-reinsert (which discarded ids).
      const keptEntryKeys = new Set<string>();

      let persistedRows = 0;
      let dedupedRows = 0;

      if (stash) {
        const bundle = bundleByRoot.get(path.resolve(currentStashDir));
        if (!bundle) throw new Error(`Missing bundle provenance for indexed source ${currentStashDir}`);
        const ownerIdentity = bundle.bundleId;
        for (const entry of stash.entries) {
          const entryPath = entry.filename ? path.join(dirPath, entry.filename) : null;
          if (!entryPath) {
            warn(`Skipping entry with no resolvable path in ${dirPath}`);
            continue;
          }

          const adapterConceptId = conceptIdByFile?.get(entryPath);
          if (!adapterConceptId) {
            warn(`Skipping entry without adapter-owned concept identity: ${entryPath}`);
            continue;
          }
          // Adapter-owned concept identity is path-based and cannot be replaced
          // by presentation fields such as type/title.
          const identityKey = `${ownerIdentity}\0${adapterConceptId}`;
          if (indexedAssetIdentities.has(identityKey)) {
            dedupedRows++;
            continue;
          }
          indexedAssetIdentities.add(identityKey);

          const entryKey =
            bundle?.adapterId !== "akm" && adapterConceptId
              ? `${currentStashDir}:concept:${adapterConceptId}`
              : `${currentStashDir}:${entry.type}:${entry.name}`;
          keptEntryKeys.add(entryKey);
          const searchText = buildSearchText(entry);
          const entryWithSize = attachFileSize(entry, entryPath);
          // content_hash = doc.hash from the drain, keyed by the recognized
          // file's path. A missing hash preserves the existing value on upsert.
          const contentHash = hashByFile?.get(entryPath);

          const provenance = deriveEntryProvenance(bundle, entry.type, entry.name, adapterConceptId);

          const entryId = upsertEntry(
            db,
            entryKey,
            dirPath,
            entryPath,
            currentStashDir,
            entryWithSize,
            searchText,
            provenance,
            contentHash,
          );
          persistedRows++;

          if (entry.type === "workflow") {
            const doc = takeWorkflowDocument(entry);
            if (doc) {
              upsertWorkflowDocument(db, entryId, doc, fs.readFileSync(entryPath));
            }
          }
        }

        // Collect dirs needing LLM enhancement during the first walk.
        // Only dirs with "generated" entries need enrichment.
        if (stash.entries.some((e) => e.quality === "generated")) {
          dirsNeedingLlm.push({ dirPath, files, currentStashDir, stash });
        }
      }

      // Prune the departed rows: everything under this dir NOT re-upserted above
      // (files deleted, deduped away, or abstained on by the adapter). With
      // an empty kept-set this deletes every row for the dir — the exact net
      // effect of the old unconditional `deleteEntriesByDir`, minus the id churn.
      if (pruneMissing !== false) {
        addEntryIds(
          deletedUsageEntryIds,
          deleteEntriesByDirExceptKeys(db, dirPath, currentStashDir, keptEntryKeys, { cleanupUsageEvents: false }),
        );
      }

      const fingerprint = computeDirFingerprint(dirPath, files, indexVariant);
      const persistedReason =
        persistedRows === 0
          ? inferZeroRowReason(stash, reason, warnings, dirPath, dedupedRows)
          : reason?.kind === "full-rebuild"
            ? "full-rebuild"
            : (reason?.kind ?? "updated");
      upsertIndexDirState(db, {
        dirPath,
        fileSetHash: fingerprint.fileSetHash,
        fileMtimeMaxMs: fingerprint.fileMtimeMaxMs,
        reason: persistedReason,
      });
      if (persistedRows === 0) {
        // Warn only when the dir had files that *could* produce entries (.md or
        // known script extensions). Dirs with only non-indexable types (.json,
        // .yaml, .conf, .env, .gitkeep) or deduped-only rows are expected and
        // not actionable at normal log level.
        const hasIndexableExtension = files.some((f) => {
          const ext = path.extname(f).toLowerCase();
          return ext === ".md" || SCRIPT_EXTENSIONS.has(ext);
        });
        if (persistedReason !== "deduped-zero-row" && hasIndexableExtension) {
          warn(`[index] zero-row ${dirPath}: ${persistedReason}`);
        } else {
          warnVerbose(`[index] zero-row ${dirPath}: ${persistedReason}`);
        }
      }
    }
    // Atomicity observation point: the new generation is fully written but
    // uncommitted, so it must still be invisible to other connections.
    indexTransactionHook("records-persisted");
  });

  insertTransaction();
  deleteUsageEventsByEntryIds([...deletedUsageEntryIds]);

  return { dirsNeedingLlm };
}

async function indexEntries(
  db: Database,
  allSourceEntries: SearchSource[],
  isIncremental: boolean,
  builtAtMs: number,
  hadRemovedSources: boolean,
  doFullDelete = false,
  onProgress?: (event: IndexProgressEvent) => void,
  reconcileMissingDirs = true,
): Promise<{
  scannedDirs: number;
  skippedDirs: number;
  generatedCount: number;
  warnings: string[];
  dirsNeedingLlm: DirNeedingLlm[];
  complete: boolean;
}> {
  // Phase 1 (async): walk directories and pre-generate all metadata outside the
  // transaction.
  const { dirRecords, scannedDirs, skippedDirs, generatedCount, warnings, complete } = await scanSourceDirs(
    db,
    allSourceEntries,
    isIncremental,
    builtAtMs,
    hadRemovedSources,
    onProgress,
    reconcileMissingDirs,
  );

  // Phase 2 (sync): write all pre-generated metadata inside a single transaction.
  // Source roots feed the #624-P1 zero-document preflight (a full-rebuild wipe
  // is suppressed when the scan is empty because roots are unreadable).
  const sourceRoots = allSourceEntries.map((s) => s.path);
  // Chunk-5 Step 2 (spec §14.4): map each source root → its durable bundle id so
  // the writer can persist `item_ref = <bundle>//<conceptId>` and the component/
  // adapter provenance alongside the legacy columns. `deriveInstallations`
  // preserves source order, so a positional zip yields the SAME bundle id the
  // dispatched `adapter.recognize` emits as `IndexDocument.ref` for that root.
  const installations = deriveInstallations(allSourceEntries);
  const bundleByRoot = new Map<string, { bundleId: string; componentId: string; adapterId: string }>();
  allSourceEntries.forEach((source, i) => {
    const inst = installations[i];
    if (!inst) return;
    const component = inst.components[0];
    bundleByRoot.set(path.resolve(source.path), {
      bundleId: inst.id,
      componentId: component?.id ?? inst.id,
      adapterId: component?.adapter ?? "akm",
    });
  });
  const { dirsNeedingLlm } = persistDirRecords(
    db,
    dirRecords,
    doFullDelete,
    warnings,
    sourceRoots,
    complete,
    bundleByRoot,
  );

  return { scannedDirs, skippedDirs, generatedCount, warnings, dirsNeedingLlm, complete };
}

function indexedProvenanceForFile(db: Database, filePath: string): EntryProvenance {
  const row = db
    .prepare(
      "SELECT item_ref AS itemRef, bundle_id AS bundleId, component_id AS componentId, " +
        "concept_id AS conceptId, adapter_id AS adapterId FROM entries WHERE file_path = ? LIMIT 1",
    )
    .get(filePath) as
    | {
        itemRef: string | null;
        bundleId: string | null;
        componentId: string | null;
        conceptId: string | null;
        adapterId: string | null;
      }
    | undefined;
  if (!row?.itemRef || !row.bundleId || !row.componentId || !row.conceptId || !row.adapterId) {
    throw new Error(`Missing indexed provenance for ${filePath}`);
  }
  return {
    itemRef: row.itemRef,
    bundleId: row.bundleId,
    componentId: row.componentId,
    conceptId: row.conceptId,
    adapterId: row.adapterId,
  };
}

async function enhanceDirsWithLlm(
  db: Database,
  config: import("../core/config/config").AkmConfig,
  dirsNeedingLlm: Array<{
    dirPath: string;
    files: string[];
    currentStashDir: string;
    stash: StashFile;
  }>,
  onProgress?: (event: IndexProgressEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  // Resolve per-pass LLM config via the unified shim. Returns undefined when
  // either no `akm.llm` is configured or the user opted this pass out via
  // `index.enrichment.llm = false`. (#208)
  const llmConfig = resolveIndexPassLLM("enrichment", config);
  if (!llmConfig || dirsNeedingLlm.length === 0) return;

  // Aggregate per-entry failures so a misconfigured LLM endpoint surfaces
  // as a single visible warning instead of silently degrading every entry
  // and leaving the user wondering why nothing got enhanced.
  const summary: LlmEnhancementSummary = { attempted: 0, succeeded: 0, skipped: 0, failureSamples: [] };
  let completedDirs = 0;
  let completedEntries = 0;
  const totalDirs = dirsNeedingLlm.length;
  const totalEntries = dirsNeedingLlm.reduce((sum, { stash }) => {
    const entriesToEnhance = stash.entries.filter((e) => {
      if (e.quality !== "generated") return false;
      if (isEnrichmentComplete(e)) return false;
      return true;
    });
    return sum + entriesToEnhance.length;
  }, 0);

  // P3 — wall-clock budget for the enrichment pass. Defaults to the resolved
  // engine's timeoutMs (or 10 minutes if not set). Users can extend it via
  // `index.enrichment.timeoutMs` (or `index.defaults.timeoutMs`, or the
  // engine's own `engines.<name>.timeoutMs`) — no separate knob needed.
  const enrichDeadline = createEnrichmentDeadline(llmConfig.timeoutMs, totalEntries);
  let deadlineHit = false;
  const enrichSignal: AbortSignal = (() => {
    if (!enrichDeadline) return signal ?? new AbortController().signal;
    if (!signal) return enrichDeadline;
    // Combine: abort when either fires.
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    enrichDeadline.addEventListener(
      "abort",
      () => {
        deadlineHit = true;
        controller.abort();
      },
      { once: true },
    );
    return controller.signal;
  })();

  if (totalEntries > 0) {
    onProgress?.({
      phase: "llm",
      message:
        `LLM enhancement starting for ${totalEntries} entr${totalEntries === 1 ? "y" : "ies"} ` +
        `across ${totalDirs} director${totalDirs === 1 ? "y" : "ies"} (concurrency ${getDefaultLlmConcurrency(llmConfig)}).`,
      processed: 0,
      total: totalEntries,
    });
  }

  let currentDirLabel: string | undefined;
  let lastProgressAt = Date.now();
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  if (totalEntries > 0 && onProgress) {
    heartbeatTimer = setInterval(() => {
      if (Date.now() - lastProgressAt < 15000) return;
      onProgress({
        phase: "llm",
        message:
          `Still enriching ${completedEntries}/${totalEntries} entr${totalEntries === 1 ? "y" : "ies"}` +
          (currentDirLabel ? `; waiting on ${currentDirLabel}` : "") +
          ".",
        processed: completedEntries,
        total: totalEntries,
      });
      lastProgressAt = Date.now();
    }, 15000);
  }

  try {
    await concurrentMap(
      dirsNeedingLlm,
      async ({ dirPath, files, currentStashDir, stash: originalStash }) => {
        if (enrichSignal.aborted) return undefined;
        // Only enhance generated entries; user-provided overrides should not
        // be overwritten. Skip entries that are already fully enriched
        // (description + tags + searchHints).
        const entriesToEnhance = originalStash.entries.filter((e) => {
          if (e.quality !== "generated") return false;
          if (isEnrichmentComplete(e)) {
            warnVerbose(`[akm] skipping LLM enrichment for "${e.name}" — entry already complete`);
            return false;
          }
          return true;
        });
        if (entriesToEnhance.length === 0) return undefined;
        currentDirLabel = path.relative(currentStashDir, dirPath) || ".";
        onProgress?.({
          phase: "llm",
          message:
            `Enhancing ${currentDirLabel} ` +
            `(${entriesToEnhance.length} entr${entriesToEnhance.length === 1 ? "y" : "ies"}).`,
          processed: completedEntries,
          total: totalEntries,
        });
        lastProgressAt = Date.now();
        const targetStash: StashFile = { entries: entriesToEnhance };
        const entryKeys = entriesToEnhance.map((e) => `${currentStashDir}:${e.type}:${e.name}`);
        const enhanced = await enhanceStashWithLlm(
          llmConfig,
          targetStash,
          files,
          summary,
          enrichSignal,
          db,
          entryKeys,
          config,
          (event) => {
            completedEntries++;
            lastProgressAt = Date.now();
            onProgress?.({
              phase: "llm",
              message:
                `Enhanced ${completedEntries}/${totalEntries} entr${totalEntries === 1 ? "y" : "ies"}; ` +
                `${completedDirs}/${totalDirs} director${totalDirs === 1 ? "y" : "ies"} complete` +
                (event.entryName ? `; current ${event.entryName}` : "") +
                (currentDirLabel ? ` in ${currentDirLabel}` : "") +
                (event.outcome === "cache-hit" ? " (cache hit)" : ""),
              processed: completedEntries,
              total: totalEntries,
            });
          },
        );

        // Re-upsert the enhanced entries in a single transaction so a crash
        // cannot leave half the entries updated and the rest stale.
        db.transaction(() => {
          for (const entry of enhanced.entries) {
            const entryPath = entry.filename ? path.join(dirPath, entry.filename) : files[0] || dirPath;
            const entryKey = `${currentStashDir}:${entry.type}:${entry.name}`;
            const searchText = buildSearchText(entry);
            const provenance = indexedProvenanceForFile(db, entryPath);
            upsertEntry(
              db,
              entryKey,
              dirPath,
              entryPath,
              currentStashDir,
              attachFileSize(entry, entryPath),
              searchText,
              provenance,
            );
          }
        })();
        completedDirs++;
        lastProgressAt = Date.now();
        onProgress?.({
          phase: "llm",
          message:
            `Completed ${completedDirs}/${totalDirs} director${totalDirs === 1 ? "y" : "ies"}; ` +
            `${completedEntries}/${totalEntries} entr${totalEntries === 1 ? "y" : "ies"} processed.`,
          processed: completedEntries,
          total: totalEntries,
        });
        return undefined;
      },
      // Defaults: 2 for remote LLM APIs, 1 for local model servers (LM
      // Studio, Ollama run one inference at a time — parallel requests cause
      // "Model reloaded" / 500 errors). No config override reaches this path:
      // `resolveLlmEngineUse` does not forward `engines.<name>.concurrency`.
      getDefaultLlmConcurrency(llmConfig),
    );
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }

  if (deadlineHit) {
    warn(
      "[akm] LLM enrichment budget exceeded. Re-run `akm index` to continue. Increase index.enrichment.timeoutMs for a larger budget.",
    );
  }

  // Gate-closed (`skipped`) entries are not failures — exclude them so a
  // deliberately disabled feature never surfaces as an enrichment error.
  const failed = summary.attempted - summary.succeeded - summary.skipped;
  if (failed > 0 && summary.succeeded === 0) {
    const sample = summary.failureSamples.length ? ` Example: ${summary.failureSamples[0]}` : "";
    warn(
      `LLM enhancement failed for all ${failed} attempted entries — index built without LLM enrichment.` +
        ` Check llm.endpoint and llm.model in your config.${sample}`,
    );
  } else if (failed > 0) {
    const sample = summary.failureSamples.length ? ` Examples: ${summary.failureSamples.join("; ")}` : "";
    warn(`LLM enhancement failed for ${failed}/${summary.attempted} entries — they were left un-enhanced.${sample}`);
  }
}

export function createEnrichmentDeadline(
  timeoutMs: number | null | undefined,
  totalEntries: number,
): AbortSignal | undefined {
  const perEntryTimeoutMs = timeoutMs === undefined ? 10 * 60 * 1000 : timeoutMs;
  return perEntryTimeoutMs === null ? undefined : AbortSignal.timeout(perEntryTimeoutMs * Math.max(totalEntries, 1));
}

async function generateEmbeddingsForDb(
  db: Database,
  config: AkmConfig,
  onProgress: (event: IndexProgressEvent) => void,
  signal?: AbortSignal,
): Promise<EmbeddingGenerationResult> {
  throwIfAborted(signal);

  if (config.semanticSearchMode === "off") {
    onProgress({ phase: "embeddings", message: "Semantic search disabled; skipping embeddings." });
    return { success: false, reason: "index-missing", message: "Semantic search is disabled." };
  }

  // Detect embedding model/provider changes and purge stale embeddings
  // so that incremental reindex regenerates all vectors with the new model.
  const currentFingerprint = deriveSemanticProviderFingerprint(config.embedding);
  const storedFingerprint = getMeta(db, "embeddingFingerprint");
  if (storedFingerprint && storedFingerprint !== currentFingerprint) {
    // Model/provider changed → stored vectors are incompatible. Clear them;
    // re-embedded by this index run.
    //
    // The vec table goes too. "Same dimension, so keep the vec table" only held
    // for a same-width model swap: entries_vec is a vec0 virtual table declared
    // at a FIXED width, so after a dimension-changing model change every insert
    // failed against the old width, and ensureSchema's dim-change rebuild never
    // fired because it only runs for callers that pass an explicit
    // embeddingDim. The stale table survived `--full` — the exact remedy the
    // warning recommended. Clearing the stored dim lets the next ensureSchema
    // materialize it at the new width; until then the fast-path flag reads
    // false (no table) and search uses the complete BLOB table.
    purgeEmbeddings(db, { dropVecTable: true });
    deleteMeta(db, "embeddingDim");
  }

  try {
    const { embedBatch } = await import("../llm/embedder.js");
    const { estimateTokenCount } = await import("../llm/embedders/remote.js");
    throwIfAborted(signal);
    const allEntries = getAllEntriesForEmbedding(db);
    if (allEntries.length === 0) {
      onProgress({ phase: "embeddings", message: "Embeddings already up to date." });
      setMeta(db, "embeddingFingerprint", currentFingerprint);
      return { success: true };
    }
    onProgress({
      phase: "embeddings",
      message: `Generating embeddings for ${allEntries.length} entr${allEntries.length === 1 ? "y" : "ies"}.`,
    });
    const texts = allEntries.map((e) => e.searchText);

    // Verbose: log each document before it is sent to the embedding API so
    // operators can see exactly where embedding fails without waiting for an error.
    if (isVerbose()) {
      const EMBED_BATCH_SIZE = 100; // mirrors REMOTE_BATCH_SIZE in remote.ts
      const totalBatches = Math.ceil(texts.length / EMBED_BATCH_SIZE);
      for (let i = 0; i < texts.length; i++) {
        const batchNum = Math.floor(i / EMBED_BATCH_SIZE) + 1;
        const chars = texts[i]!.length;
        const tokens = estimateTokenCount(texts[i]!);
        const ref = allEntries[i]!.entryKey.split(":").slice(1).join(":"); // strip stashDir prefix
        warnVerbose(`[embed] ${ref} (${chars} chars, est. ${tokens} tokens) → batch ${batchNum}/${totalBatches}`);
      }
    }

    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    try {
      heartbeatTimer = setInterval(() => {
        onProgress({
          phase: "embeddings",
          message: `Still generating embeddings for ${allEntries.length} entr${allEntries.length === 1 ? "y" : "ies"}; waiting on embedding provider.`,
        });
      }, 15000);

      const embeddings = await embedBatch(texts, config.embedding, signal);
      throwIfAborted(signal);
      // Wrap all embedding upserts in a single transaction so partial
      // state is rolled back on failure rather than leaving the table half-filled.
      let storedCount = 0;
      let skippedCount = 0;
      let vecFailedCount = 0;
      let vecUnavailableCount = 0;
      db.transaction(() => {
        for (let i = 0; i < allEntries.length; i++) {
          const res = upsertEmbedding(db, allEntries[i]!.id, embeddings[i]!);
          if (res.stored) {
            storedCount++;
          } else {
            skippedCount++;
          }
          if (res.vec === "failed") vecFailedCount++;
          if (res.vec === "unavailable") vecUnavailableCount++;
        }
      })();
      if (skippedCount > 0) {
        warn(
          `[embed] ${skippedCount} embedding${skippedCount === 1 ? "" : "s"} skipped (entry deleted between queue and write)`,
        );
      }
      // Record the ACTUAL vec-insert outcome so semantic search reflects it
      // instead of inferring readiness from stored-BLOB counts. Any failure
      // marks the fast path degraded, routing search to the JS-cosine fallback
      // over the (complete) BLOB table — honest degradation, not a hard failure.
      //
      // 'unavailable' has to degrade the flag too. It means no vec row was
      // written at all, so marking the fast path ready left a later open (a
      // different runtime, or sqlite-vec installed afterwards) trusting an
      // empty entries_vec and returning zero semantic hits against a fully
      // populated BLOB table.
      setVecFastPathReady(db, vecFailedCount === 0 && vecUnavailableCount === 0);
      if (vecFailedCount > 0) {
        warn(
          `[embed] ${vecFailedCount} sqlite-vec fast-path insert${vecFailedCount === 1 ? "" : "s"} failed — ` +
            "semantic search will use the slower JS-cosine fallback over stored embeddings. " +
            "Rebuild with 'akm index --full' after resolving the vec table (often a vector-dimension mismatch).",
        );
      }
      onProgress({
        phase: "embeddings",
        message: `Stored ${storedCount} embedding${storedCount === 1 ? "" : "s"}.`,
      });
      setMeta(db, "embeddingFingerprint", currentFingerprint);
      return { success: true, vecInsertFailures: vecFailedCount };
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn("Embedding generation failed, continuing without:", message);
    onProgress({
      phase: "embeddings",
      message: `Embedding generation failed: ${message}`,
    });
    return {
      success: false,
      reason: classifySemanticFailure(message),
      message: `Semantic search verification failed: ${message}`,
    };
  }
}

interface EmbeddingGenerationResult {
  success: boolean;
  reason?: import("./search/semantic-status").SemanticSearchReason;
  message?: string;
  /**
   * Count of sqlite-vec fast-path inserts that failed while their BLOB rows
   * still wrote. > 0 means the index is degraded-but-working: semantic search
   * falls back to JS-cosine over the BLOB table. Absent on paths with no vec
   * writes (already up to date, disabled, or the error path).
   */
  vecInsertFailures?: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function attachFileSize(entry: IndexDocument, entryPath: string): IndexDocument {
  try {
    return { ...entry, fileSize: fs.statSync(entryPath).size };
  } catch {
    return entry;
  }
}

function buildIndexSummaryMessage(options: {
  mode: "full" | "incremental";
  sourcesCount: number;
  semanticSearchMode: AkmConfig["semanticSearchMode"];
  embeddingProvider: "local" | "remote";
  llmEnabled: boolean;
  vecAvailable: boolean;
}): string {
  const stashSourceLabel = options.sourcesCount === 1 ? "stash source" : "stash sources";
  const semanticDetail = getSemanticSearchLabel(
    options.semanticSearchMode,
    options.embeddingProvider,
    options.vecAvailable,
  );
  return `Starting ${options.mode} index (${options.sourcesCount} ${stashSourceLabel}, semantic search: ${semanticDetail}, LLM: ${options.llmEnabled ? "enabled" : "disabled"}).`;
}

function getEmbeddingProvider(
  embedding?: import("../core/config/config").EmbeddingConnectionConfig,
): "local" | "remote" {
  return isHttpUrl(embedding?.endpoint) ? "remote" : "local";
}

function getSemanticSearchLabel(
  semanticSearchMode: AkmConfig["semanticSearchMode"],
  embeddingProvider: "local" | "remote",
  vecAvailable: boolean,
): string {
  if (semanticSearchMode === "off") return "disabled";
  return `${embeddingProvider} embeddings, ${vecAvailable ? "sqlite-vec" : "JS fallback"}`;
}

function verifyIndexState(
  db: Database,
  config: AkmConfig,
  embeddableEntries: number,
  embeddingResult: EmbeddingGenerationResult,
): IndexVerification {
  const embeddingCount = getEmbeddingCount(db);
  const vecAvailable = isVecAvailable(db);
  const embeddingProvider = getEmbeddingProvider(config.embedding);

  if (embeddableEntries === 0) {
    return {
      ok: true,
      message: "Index ready. No assets were found yet.",
      semanticSearchEnabled: config.semanticSearchMode === "auto",
      semanticSearchMode: config.semanticSearchMode,
      semanticStatus: config.semanticSearchMode === "off" ? "disabled" : "pending",
      embeddingProvider,
      entryCount: embeddableEntries,
      embeddingCount,
      vecAvailable,
    };
  }

  if (config.semanticSearchMode === "off") {
    return {
      ok: true,
      message: "Keyword index ready. Semantic search is disabled.",
      semanticSearchEnabled: false,
      semanticSearchMode: config.semanticSearchMode,
      semanticStatus: "disabled",
      embeddingProvider,
      entryCount: embeddableEntries,
      embeddingCount,
      vecAvailable,
    };
  }

  if (embeddingCount >= embeddableEntries) {
    // "ready-vec" must reflect the path search will ACTUALLY take: the vec
    // extension being loaded is not enough when the embedding phase recorded
    // fast-path insert failures (searchVec then routes to the JS-cosine
    // fallback via isVecFastPathReady). Reporting vec health from
    // isVecAvailable alone overstated `akm info` after partial vec failures
    // (§24.2 "Semantic" gate — truthful ready-vec).
    const vecActive = vecAvailable && isVecFastPathReady(db);
    return {
      ok: true,
      message: `Semantic search ready (${embeddingCount}/${embeddableEntries} embeddings, ${
        vecActive
          ? "sqlite-vec active"
          : vecAvailable
            ? "JS fallback active — vec fast path degraded, run 'akm index --full' to restore"
            : "JS fallback active"
      }).`,
      semanticSearchEnabled: true,
      semanticSearchMode: config.semanticSearchMode,
      semanticStatus: vecActive ? "ready-vec" : "ready-js",
      embeddingProvider,
      entryCount: embeddableEntries,
      embeddingCount,
      vecAvailable,
    };
  }

  return {
    ok: false,
    message:
      embeddingResult.message ??
      `Semantic search verification failed (${embeddingCount}/${embeddableEntries} embeddings available).`,
    guidance:
      embeddingProvider === "remote"
        ? "Check your embedding endpoint and credentials, then retry `akm index --full --verbose`."
        : "Retry `akm index --full --verbose`. If it still fails, confirm local model downloads are permitted and see docs/reference/configuration.md for local embedding dependency setup.",
    semanticSearchEnabled: true,
    semanticSearchMode: config.semanticSearchMode,
    semanticStatus: "blocked",
    embeddingProvider,
    entryCount: embeddableEntries,
    embeddingCount,
    vecAvailable,
  };
}

function buildIndexedDirCandidate(
  dirPath: string,
  indexableFiles: string[],
  generated: StashFile,
): IndexedDirCandidate {
  const stash = generated.entries.length > 0 ? { entries: generated.entries } : null;
  const staleFiles = stash ? resolveIndexedFiles(dirPath, indexableFiles, stash) : indexableFiles;
  return { stash, staleFiles };
}

function resolveIndexedFiles(dirPath: string, files: string[], stash: StashFile): string[] {
  const resolved = new Set<string>();
  for (const entry of stash.entries) {
    if (entry.filename) resolved.add(path.join(dirPath, entry.filename));
  }
  return resolved.size > 0 ? [...resolved] : files;
}

interface LlmEnhancementSummary {
  attempted: number;
  succeeded: number;
  /**
   * Entries the LLM never enhanced because the `metadata_enhance` gate was
   * closed. Not a failure — excluded from the failed count so a deliberately
   * disabled feature does not surface as an enrichment error.
   */
  skipped: number;
  /** Sample of error messages from failed entries (first 3, deduped). */
  failureSamples: string[];
}

async function enhanceStashWithLlm(
  llmConfig: LlmConnectionConfig,
  stash: StashFile,
  files: string[],
  summary: LlmEnhancementSummary,
  signal?: AbortSignal,
  db?: Database,
  entryKeys?: string[],
  akmConfig?: AkmConfig,
  onEntryDone?: (event: { entryName: string; outcome: "cache-hit" | "llm" | "failed" | "skipped" }) => void,
): Promise<StashFile> {
  const { enhanceMetadata } = await import("../llm/metadata-enhance");
  const { computeBodyHash, getLlmCacheEntry, upsertLlmCacheEntry } = await import(
    "../storage/repositories/index-llm-cache-repository"
  );

  const results = await concurrentMap(
    stash.entries,
    async (entry, idx) => {
      if (signal?.aborted) return entry;
      summary.attempted++;
      try {
        const entryFile = entry.filename
          ? (files.find((f) => path.basename(f) === entry.filename) ?? files[0])
          : files[0];
        let fileContent: string | undefined;
        if (entryFile) {
          try {
            fileContent = fs.readFileSync(entryFile, "utf8");
          } catch {
            warn(`Could not read file for LLM enrichment: ${entry.filename ?? entry.name}`);
          }
        }

        // Incremental cache: skip LLM call when file body is unchanged. The
        // cache key is the entry_key (stashDir:type:name) which is stable
        // across index runs.
        const cacheBody = fileContent ?? `${entry.name}\n${entry.description ?? ""}`;
        const bodyHash = computeBodyHash(cacheBody);
        const cacheKey = entryKeys?.[idx] ?? `${entry.type}:${entry.name}`;

        if (db) {
          const cached = getLlmCacheEntry(db, cacheKey, bodyHash);
          if (cached) {
            try {
              const parsed = JSON.parse(cached.resultJson) as {
                description?: string;
                searchHints?: string[];
                tags?: string[];
              };
              const updated = { ...entry };
              if (parsed.description) updated.description = parsed.description;
              if (parsed.searchHints?.length) updated.searchHints = parsed.searchHints;
              if (parsed.tags?.length) updated.tags = parsed.tags;
              updated.quality = "enriched";
              summary.succeeded++;
              onEntryDone?.({ entryName: entry.name, outcome: "cache-hit" });
              return updated;
            } catch {
              warn(`LLM enrichment cache entry corrupt for ${entry.name}; re-running enrichment`);
            }
          }
        }

        const outcome = await enhanceMetadata(llmConfig, entry, fileContent, signal, akmConfig);

        if (outcome.status !== "enriched") {
          // Not a genuine LLM success: the gate was closed (`skipped`) or the
          // call errored/timed out (`failed`). Do NOT mark the entry enriched
          // and do NOT write the LLM cache — caching here would poison the
          // entry into a permanent enrichment skip even though nothing was
          // enhanced. Surface failures honestly; stay silent on gated-off skips.
          if (outcome.status === "failed") {
            const msg = outcome.error ?? "metadata enrichment failed";
            if (summary.failureSamples.length < 3 && !summary.failureSamples.includes(msg)) {
              summary.failureSamples.push(msg);
            }
            onEntryDone?.({ entryName: entry.name, outcome: "failed" });
          } else {
            summary.skipped++;
            onEntryDone?.({ entryName: entry.name, outcome: "skipped" });
          }
          return entry;
        }

        const improvements = outcome.metadata;
        const updated = { ...entry };
        if (improvements.description) updated.description = improvements.description;
        if (improvements.searchHints?.length) updated.searchHints = improvements.searchHints;
        if (improvements.tags?.length) updated.tags = improvements.tags;
        // Mark as enriched so subsequent index runs skip re-enrichment (P2).
        // An empty-but-successful response is still cached: the LLM was paid
        // for this body_hash and produced no improvements, so re-running would
        // only re-pay for the same no-op. (The cache protects against re-paying
        // for the LLM call when the file body is unchanged.)
        updated.quality = "enriched";

        // Persist to cache so the next run can skip the LLM call when the
        // file body has not changed.
        if (db) {
          upsertLlmCacheEntry(
            db,
            cacheKey,
            bodyHash,
            JSON.stringify({
              description: improvements.description,
              searchHints: improvements.searchHints,
              tags: improvements.tags,
            }),
          );
        }

        summary.succeeded++;
        onEntryDone?.({ entryName: entry.name, outcome: "llm" });
        return updated;
      } catch (err) {
        const msg = toErrorMessage(err);
        // failureSamples is bounded to 3 items, so a linear scan is cheaper
        // than maintaining a parallel Set for membership checks (#177 review).
        if (summary.failureSamples.length < 3 && !summary.failureSamples.includes(msg)) {
          summary.failureSamples.push(msg);
        }
        onEntryDone?.({ entryName: entry.name, outcome: "failed" });
        return entry;
      }
    },
    // Defaults: 2 for remote LLM APIs, 1 for local model servers. No config
    // override reaches this path (see getDefaultLlmConcurrency).
    getDefaultLlmConcurrency(llmConfig),
  );

  // concurrentMap returns Array<T | undefined>; filter out undefined slots
  // (which can only occur if the callback itself returned undefined, which
  // it never does above — but TypeScript needs the filter for type safety).
  const enhanced: IndexDocument[] = results.map((r, i) => r ?? stash.entries[i]!);
  return { entries: enhanced };
}

// ── lookup ─────────────────────────────────────────────────────────────────

import { type BundleRef, makeBundleRef } from "../core/asset/asset-ref";
import { type AssetRef, conceptIdFromTypeName } from "../core/asset/resolve-ref";

export interface IndexEntry {
  /** Absolute path of the indexed file on disk. */
  filePath: string;
  /** Source root (the directory the walker rooted at). */
  stashDir: string;
  /** Raw entry_key from the entries table — `${stashDir}:${type}:${name}`. */
  entryKey: string;
  /** Asset type (skill, command, knowledge, ...). */
  type: string;
  /** Asset name as recorded by the indexer. */
  name: string;
  /** Adapter that owns recognition and progressive behavior for this entry. */
  adapterId: string;
  /** Persisted format-neutral projection for generic presentation. */
  document?: IndexDocument;
  /** Canonical durable identity from `entries.item_ref`. */
  itemRef: string;
  bundleId: string;
  conceptId: string;
}

async function resolveLookupSources(): Promise<SearchSource[]> {
  const { loadConfig } = await import("../core/config/config.js");
  const { resolveSourceEntries } = await import("./search/search-source.js");
  return resolveSourceEntries(undefined, loadConfig());
}

function resolveLookupScope(
  bundle: string | undefined,
  sources: SearchSource[],
): { candidateDirs: string[]; qualified: boolean } {
  if (!bundle) return { candidateDirs: sources.map((source) => source.path), qualified: false };
  return { candidateDirs: resolveSourcesForOrigin(bundle, sources).map((source) => source.path), qualified: true };
}

/** Resolve an adapter-owned `[bundle//]conceptId` without interpreting its path as an AKM type. */
export async function lookupBundleRef(ref: BundleRef): Promise<IndexEntry | null> {
  const sources = await resolveLookupSources();
  if (sources.length === 0) return null;

  const { candidateDirs, qualified } = resolveLookupScope(ref.bundle, sources);
  if (candidateDirs.length === 0) return null;

  const db = openExistingDatabase(getDbPath());
  try {
    const inputRef = makeBundleRef(qualified ? ref.bundle : undefined, ref.conceptId);
    for (const dir of candidateDirs) {
      const id = findEntryIdByRef(db, inputRef, dir);
      if (id === undefined) continue;
      const row = db
        .prepare(
          "SELECT entry_key AS entryKey, file_path AS filePath, stash_dir AS stashDir, entry_type AS type, " +
            "entry_json AS entryJson, item_ref AS itemRef, bundle_id AS bundleId, concept_id AS conceptId, " +
            "adapter_id AS adapterId FROM entries WHERE id = ?",
        )
        .get(id) as
        | {
            entryKey: string;
            filePath: string;
            stashDir: string;
            type: string;
            entryJson: string;
            itemRef: string | null;
            bundleId: string | null;
            conceptId: string | null;
            adapterId: string | null;
          }
        | undefined;
      if (!row) continue;
      let document: IndexDocument | undefined;
      try {
        document = JSON.parse(row.entryJson) as IndexDocument;
      } catch {
        // Corrupt optional projection does not erase the durable path identity.
      }
      if (!row.itemRef || !row.bundleId || !row.conceptId || !row.adapterId) continue;
      return {
        entryKey: row.entryKey,
        filePath: row.filePath,
        stashDir: row.stashDir,
        type: row.type,
        name: document?.name ?? ref.conceptId.split("/").pop() ?? ref.conceptId,
        adapterId: row.adapterId,
        document,
        itemRef: row.itemRef,
        bundleId: row.bundleId,
        conceptId: row.conceptId,
      };
    }
    return null;
  } finally {
    closeDatabase(db);
  }
}

/**
 * Look up a single asset by ref. Spec §6.2 — `akm show` queries this and
 * reads the file from disk. The index is the source of truth for which
 * file corresponds to which ref; the indexer walks `provider.path()` for
 * every configured source, so this query covers all source kinds.
 *
 * Returns `null` when no row matches — callers translate that into a
 * `NotFoundError` with their own messaging.
 */
export async function lookup(ref: AssetRef): Promise<IndexEntry | null> {
  return lookupBundleRef({ bundle: ref.origin, conceptId: conceptIdFromTypeName(ref.type, ref.name) });
}

// ── Utility score recomputation ──────────────────────────────────────────────

/** Retention window for usage events: events older than this are purged. */
const USAGE_EVENT_RETENTION_DAYS = 90;

/**
 * Recompute utility scores for all entries based on usage_events data.
 *
 * For each entry:
 *   - Count search appearances (event_type = 'search')
 *   - Count show events (event_type = 'show')
 *   - Count positive/negative feedback events
 *   - Compute select_rate = showCount / searchCount, clamped to [0, 1]
 *   - Convert feedback counts into a positive-only feedback_rate
 *   - Update utility via EMA from the stronger of select_rate / feedback_rate
 *
 * Also purges usage_events older than 90 days and ensures the M-1
 * usage_events table exists before querying.
 *
 * Called during `akm index` after FTS rebuild.
 */
export function recomputeUtilityScores(db: Database, stateDb: Database): void {
  const EMA_DECAY = 0.7;

  // Purge stale usage events (90-day retention). usage_events lives in state.db
  // (Chunk-8 WI-8.3); its table is created by state migration 020.
  purgeOldUsageEvents(stateDb, USAGE_EVENT_RETENTION_DAYS);

  // Time-proportional decay: apply one round of EMA per elapsed day so
  // indexing frequency doesn't affect how fast scores decay.
  const lastComputedAt = getMeta(db, "last_utility_computed_at");
  let elapsedDays = 1; // default for first run
  if (lastComputedAt) {
    const ms = Date.now() - new Date(lastComputedAt).getTime();
    elapsedDays = Math.max(1, ms / (1000 * 60 * 60 * 24));
  }
  const emaDecay = EMA_DECAY ** elapsedDays;
  const emaNew = 1 - emaDecay; // complement so weights still sum to 1

  // Aggregate explicit user demand per entry_id from state.db's usage_events, then keep only entries
  // that STILL EXIST in index.db's `entries` (the former in-SQL JOIN is now a
  // cross-DB filter). This latter check is critical: usage_events has no FK to
  // entries, so its entry_id can become stale (entry deleted, re-keyed, moved
  // between sources). Without it, writing the derived row to utility_scores
  // (which DOES have an FK) raises "FOREIGN KEY constraint failed" and rolls
  // back the whole finalize transaction — failing every index run.
  const aggregatedRows = stateDb
    .prepare(`
      SELECT u.entry_id,
             SUM(CASE WHEN u.event_type = 'search' THEN 1 ELSE 0 END) AS search_count,
             SUM(CASE WHEN u.event_type = 'show'   THEN 1 ELSE 0 END) AS show_count,
             SUM(CASE WHEN u.event_type = 'feedback' AND u.signal = 'positive' THEN 1 ELSE 0 END) AS positive_feedback_count,
             SUM(CASE WHEN u.event_type = 'feedback' AND u.signal = 'negative' THEN 1 ELSE 0 END) AS negative_feedback_count,
             MAX(
               CASE
                 WHEN u.event_type IN ('search', 'show', 'curate') THEN u.created_at
                 ELSE NULL
               END
             ) AS last_used_at
      FROM usage_events u
      WHERE u.entry_id IS NOT NULL
        AND u.source = 'user'
      GROUP BY u.entry_id
    `)
    .all() as Array<{
    entry_id: number;
    search_count: number;
    show_count: number;
    positive_feedback_count: number;
    negative_feedback_count: number;
    last_used_at: string | null;
  }>;
  const entryExists = db.prepare("SELECT 1 FROM entries WHERE id = ?");
  const usageByEntry = new Map(
    aggregatedRows.filter((row) => entryExists.get(row.entry_id) != null).map((row) => [row.entry_id, row]),
  );

  // Batch-load existing utility scores
  const existingScores = new Map<number, { utility: number; lastUsedAt: string | undefined }>();
  const scoreRows = db.prepare("SELECT entry_id, utility, last_used_at FROM utility_scores").all() as Array<{
    entry_id: number;
    utility: number;
    last_used_at: string | null;
  }>;
  for (const row of scoreRows) {
    existingScores.set(row.entry_id, { utility: row.utility, lastUsedAt: row.last_used_at ?? undefined });
  }

  const entryIds = new Set([...existingScores.keys(), ...usageByEntry.keys()]);
  for (const entryId of entryIds) {
    const row = usageByEntry.get(entryId) ?? {
      entry_id: entryId,
      search_count: 0,
      show_count: 0,
      positive_feedback_count: 0,
      negative_feedback_count: 0,
      last_used_at: null,
    };
    const selectRate = row.search_count > 0 ? Math.min(1, row.show_count / row.search_count) : 0;
    const feedbackTotal = row.positive_feedback_count + row.negative_feedback_count;
    const feedbackRate =
      feedbackTotal > 0 ? Math.max(0, row.positive_feedback_count - row.negative_feedback_count) / feedbackTotal : 0;
    const effectiveRate = Math.max(selectRate, feedbackRate);
    const existing = existingScores.get(row.entry_id);
    const prevUtility = existing?.utility ?? 0;
    const utility = prevUtility * emaDecay + effectiveRate * emaNew;
    // `utility_scores.last_used_at` is consumed by salience as the timestamp of
    // the most-recent retrieval. Preserve that meaning by carrying the event's
    // timestamp through verbatim. The former `effectiveRate > 0.5 ? now : ...`
    // branch stamped every high-select-rate entry with the index run time,
    // making unrelated assets look simultaneously fresh and flattening the
    // recency component of retrieval salience.
    //
    // `usage_events` is the source of truth within its retention window. A
    // missing row therefore clears legacy/index-time stamps on the next index
    // pass; salience already treats an absent timestamp as long ago.
    const lastUsedAt = row.last_used_at ?? undefined;

    upsertUtilityScore(db, row.entry_id, {
      utility,
      showCount: row.show_count,
      searchCount: row.search_count,
      selectRate,
      lastUsedAt,
    });
  }

  setMeta(db, "last_utility_computed_at", new Date().toISOString());
}
