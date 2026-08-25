// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The single embedding materializer for full index runs and targeted writes.
 *
 * A full run omits `entryIds` and heals every missing vector. A targeted write
 * supplies the canonical entry IDs it just changed, so the command does not
 * return successfully with lexical state newer than semantic state. Provider
 * changes deliberately widen a targeted call to all entries because every
 * stored vector becomes incompatible at that boundary.
 */

import type { AkmConfig } from "../core/config/config";
import { isVerbose, warn, warnVerbose } from "../core/warn";
import type { Database } from "../storage/database";
import { getEmbeddableEntryCount } from "../storage/repositories/index-entries-repository";
import { deleteMeta, getMeta, setMeta } from "../storage/repositories/index-meta-repository";
import {
  getAllEntriesForEmbedding,
  getEmbeddingCount,
  isVecAvailable,
  isVecFastPathComplete,
  isVecFastPathReady,
  purgeEmbeddings,
  setVecFastPathReady,
  upsertEmbedding,
} from "../storage/repositories/index-vec-repository";
import {
  classifySemanticFailure,
  clearSemanticStatus,
  deriveSemanticProviderFingerprint,
  type SemanticSearchRuntimeStatus,
  writeSemanticStatus,
} from "./search/semantic-status";

export interface EmbeddingProgressEvent {
  phase: "embeddings";
  message: string;
}

export interface EmbeddingGenerationResult {
  success: boolean;
  reason?: import("./search/semantic-status").SemanticSearchReason;
  message?: string;
  /** Number of sqlite-vec writes that degraded to the complete BLOB fallback. */
  vecInsertFailures?: number;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("index interrupted");
  }
}

export async function generateEmbeddingsForDb(
  db: Database,
  config: AkmConfig,
  onProgress: (event: EmbeddingProgressEvent) => void,
  signal?: AbortSignal,
  entryIds?: readonly number[],
): Promise<EmbeddingGenerationResult> {
  throwIfAborted(signal);

  if (config.semanticSearchMode === "off") {
    onProgress({ phase: "embeddings", message: "Semantic search disabled; skipping embeddings." });
    return { success: false, reason: "index-missing", message: "Semantic search is disabled." };
  }

  const currentFingerprint = deriveSemanticProviderFingerprint(config.embedding);
  const storedFingerprint = getMeta(db, "embeddingFingerprint");
  let targetEntryIds = entryIds;
  if (storedFingerprint && storedFingerprint !== currentFingerprint) {
    purgeEmbeddings(db, { dropVecTable: true });
    deleteMeta(db, "embeddingDim");
    // A provider/model change invalidates the entire vector generation, even
    // when a targeted write happened to discover it first.
    targetEntryIds = undefined;
  }

  try {
    const { embedBatch } = await import("../llm/embedder.js");
    const { estimateTokenCount } = await import("../llm/embedders/remote.js");
    throwIfAborted(signal);
    const allEntries = getAllEntriesForEmbedding(db, targetEntryIds);
    if (allEntries.length === 0) {
      onProgress({ phase: "embeddings", message: "Embeddings already up to date." });
      setMeta(db, "embeddingFingerprint", currentFingerprint);
      return { success: true };
    }
    onProgress({
      phase: "embeddings",
      message: `Generating embeddings for ${allEntries.length} entr${allEntries.length === 1 ? "y" : "ies"}.`,
    });
    const texts = allEntries.map((entry) => entry.searchText);

    if (isVerbose()) {
      const EMBED_BATCH_SIZE = 100;
      const totalBatches = Math.ceil(texts.length / EMBED_BATCH_SIZE);
      for (const [i, entry] of allEntries.entries()) {
        const batchNum = Math.floor(i / EMBED_BATCH_SIZE) + 1;
        const chars = entry.searchText.length;
        const tokens = estimateTokenCount(entry.searchText);
        const ref = entry.itemRef;
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
      let storedCount = 0;
      let skippedCount = 0;
      let vecFailedCount = 0;
      let vecUnavailableCount = 0;
      db.transaction(() => {
        for (const [i, entry] of allEntries.entries()) {
          const embedding = embeddings[i];
          if (!embedding) throw new Error(`Embedding provider returned no vector for ${entry.itemRef}.`);
          const result = upsertEmbedding(db, entry.id, embedding);
          if (result.stored) storedCount++;
          else skippedCount++;
          if (result.vec === "failed") vecFailedCount++;
          if (result.vec === "unavailable") vecUnavailableCount++;
        }
      })();
      if (skippedCount > 0) {
        warn(
          `[embed] ${skippedCount} embedding${skippedCount === 1 ? "" : "s"} skipped (entry deleted between queue and write)`,
        );
      }
      setVecFastPathReady(db, vecFailedCount === 0 && vecUnavailableCount === 0 && isVecFastPathComplete(db));
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
    onProgress({ phase: "embeddings", message: `Embedding generation failed: ${message}` });
    return {
      success: false,
      reason: classifySemanticFailure(message),
      message: `Semantic search verification failed: ${message}`,
    };
  }
}

/** Publish the canonical semantic health snapshot after a targeted mutation. */
export function publishTargetedSemanticStatus(
  db: Database,
  config: AkmConfig,
  result: EmbeddingGenerationResult,
): void {
  if (config.semanticSearchMode === "off") {
    clearSemanticStatus();
    setMeta(db, "hasEmbeddings", "0");
    return;
  }

  const entryCount = getEmbeddableEntryCount(db);
  const embeddingCount = getEmbeddingCount(db);
  let status: SemanticSearchRuntimeStatus;
  if (entryCount === 0) status = "pending";
  else if (embeddingCount >= entryCount)
    status = isVecAvailable(db) && isVecFastPathReady(db) ? "ready-vec" : "ready-js";
  else status = "blocked";

  setMeta(db, "hasEmbeddings", status === "ready-js" || status === "ready-vec" ? "1" : "0");
  writeSemanticStatus({
    status,
    ...(status === "blocked" ? { reason: result.reason ?? "index-failed" } : {}),
    ...(status === "blocked"
      ? {
          message:
            result.message ??
            `Semantic search verification failed (${embeddingCount}/${entryCount} embeddings available).`,
        }
      : {}),
    providerFingerprint: deriveSemanticProviderFingerprint(config.embedding),
    lastCheckedAt: new Date().toISOString(),
    entryCount,
    embeddingCount,
  });
}
