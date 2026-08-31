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

import type { AkmConfig, EmbeddingConnectionConfig } from "../core/config/config";
import { isVerbose, warn, warnVerbose } from "../core/warn";
import { embedBatch } from "../llm/embedder";
import { DETERMINISTIC_EMBED_MODEL_ID, isDeterministicEmbedEnabled } from "../llm/embedders/deterministic";
import { DEFAULT_LOCAL_MODEL } from "../llm/embedders/local";
import {
  buildTokenBoundedBatches,
  DEFAULT_REMOTE_BATCH_SIZE,
  DEFAULT_TOKEN_BUDGET,
  type EmbeddingBatchSkip,
  estimateTokenCount,
  hasRemoteEndpoint,
} from "../llm/embedders/remote";
import type { Database } from "../storage/database";
import { getEmbeddableEntryCount } from "../storage/repositories/index-entries-repository";
import { deleteMeta, getMeta, setMeta } from "../storage/repositories/index-meta-repository";
import {
  getAllEntriesForEmbedding,
  getEmbeddingCount,
  isVecFastPathComplete,
  isVecFastPathReady,
  purgeEmbeddings,
  setVecFastPathReady,
  upsertEmbedding,
} from "../storage/repositories/index-vec-repository";

/** Identifies the embedding provider+model+dimension a stored vector was generated with. */
export function deriveSemanticProviderFingerprint(embedding?: EmbeddingConnectionConfig): string {
  if (isDeterministicEmbedEnabled()) {
    return `deterministic:${DETERMINISTIC_EMBED_MODEL_ID}`;
  }
  if (embedding?.endpoint) {
    // Fingerprint keys on vector identity only (model + dimension). The endpoint
    // is transport/routing and has no bearing on vector compatibility, so moving
    // the same model+dimension to a different host must not force a full re-embed.
    return `remote:${embedding.model}|${embedding.dimension ?? "default"}`;
  }
  return `local:${embedding?.localModel ?? DEFAULT_LOCAL_MODEL}`;
}

export interface EmbeddingProgressEvent {
  phase: "embeddings";
  message: string;
}

export interface EmbeddingGenerationResult {
  success: boolean;
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
    return { success: false, message: "Semantic search is disabled." };
  }

  // A targeted call starts from an already-published generation. Preserve its
  // trust decision in O(1): successful writes for the changed IDs keep a
  // healthy fast path healthy, but can never promote a generation already
  // marked degraded. Global runs can afford to verify the entire derived set.
  const vecFastPathWasReady = isVecFastPathReady(db);
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
      // Mirror RemoteEmbedder's actual token-bounded batching (#874) so this
      // log reflects the real request grouping rather than a fixed count of
      // 100 that no longer matches what gets sent over the wire. Local runs
      // don't batch by size at all (LocalEmbedder chunks by a fixed count
      // for inference throughput only, never fails/skips), so there's
      // nothing meaningful to report per-batch for them.
      if (hasRemoteEndpoint(config.embedding ?? {})) {
        const tokenBudget = config.embedding?.maxTokens ?? config.embedding?.contextLength ?? DEFAULT_TOKEN_BUDGET;
        const maxCount = config.embedding?.batchSize ?? DEFAULT_REMOTE_BATCH_SIZE;
        const batches = buildTokenBoundedBatches(texts, tokenBudget, maxCount);
        const batchNumberByIndex = new Map<number, number>();
        batches.forEach((batch, batchIdx) => {
          for (const i of batch.indices) batchNumberByIndex.set(i, batchIdx + 1);
        });
        for (const [i, entry] of allEntries.entries()) {
          const chars = entry.searchText.length;
          const tokens = estimateTokenCount(entry.searchText);
          const batch = batches[batchNumberByIndex.get(i)! - 1];
          const label = batch?.oversized
            ? "oversized (skipped)"
            : `batch ${batchNumberByIndex.get(i)}/${batches.length}`;
          warnVerbose(`[embed] ${entry.itemRef} (${chars} chars, est. ${tokens} tokens) → ${label}`);
        }
      } else {
        for (const entry of allEntries) {
          warnVerbose(
            `[embed] ${entry.itemRef} (${entry.searchText.length} chars, est. ${estimateTokenCount(entry.searchText)} tokens)`,
          );
        }
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

      // A failing sub-batch or an oversized document is SKIPPED by embedBatch,
      // not thrown (#874) — collect what couldn't be embedded and why, so a
      // few bad documents don't discard every other entry's embedding.
      const skips: EmbeddingBatchSkip[] = [];
      const embeddings = await embedBatch(texts, config.embedding, signal, (skip) => skips.push(skip));
      throwIfAborted(signal);
      let storedCount = 0;
      let skippedCount = 0;
      let embedFailedCount = 0;
      let vecFailedCount = 0;
      let vecUnavailableCount = 0;
      db.transaction(() => {
        for (const [i, entry] of allEntries.entries()) {
          const embedding = embeddings[i];
          if (!embedding) {
            embedFailedCount++;
            continue;
          }
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
      if (embedFailedCount > 0) {
        const detail = skips
          .slice(0, 20)
          .map((skip) => `  - ${allEntries[skip.index]?.itemRef ?? skip.index} (${skip.reason}): ${skip.message}`)
          .join("\n");
        const more = skips.length > 20 ? `\n  ...and ${skips.length - 20} more` : "";
        warn(
          `[embed] ${embedFailedCount} embedding${embedFailedCount === 1 ? "" : "s"} could not be generated and ${embedFailedCount === 1 ? "was" : "were"} skipped:\n${detail}${more}`,
        );
      }
      const vecGenerationComplete = targetEntryIds === undefined ? isVecFastPathComplete(db) : vecFastPathWasReady;
      setVecFastPathReady(db, vecFailedCount === 0 && vecUnavailableCount === 0 && vecGenerationComplete);
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
      // Only a total failure (nothing at all embedded, despite having entries
      // to embed) turns into a phase failure. Any partial success — the vast
      // majority of a large bundle embedding fine around a handful of skips —
      // must not discard what DID get stored (#874).
      if (storedCount === 0 && embedFailedCount > 0) {
        const firstMessage = skips[0]?.message ?? "All embeddings failed.";
        // #873 removed the persisted semantic verdict, so there is no failure
        // class to record — just report what happened on this run.
        return {
          success: false,
          message: `All ${embedFailedCount} embedding batch(es) failed: ${firstMessage}`,
        };
      }
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
      message: `Semantic search verification failed: ${message}`,
    };
  }
}

/**
 * Update the `hasEmbeddings` DB fact after a targeted mutation, from the
 * index's actual current embedding coverage — read fresh, not cached.
 */
export function publishTargetedEmbeddingMeta(db: Database, config: AkmConfig): void {
  if (config.semanticSearchMode === "off") {
    setMeta(db, "hasEmbeddings", "0");
    return;
  }

  const entryCount = getEmbeddableEntryCount(db);
  const embeddingCount = getEmbeddingCount(db);
  const ready = entryCount > 0 && embeddingCount >= entryCount;
  setMeta(db, "hasEmbeddings", ready ? "1" : "0");
}
