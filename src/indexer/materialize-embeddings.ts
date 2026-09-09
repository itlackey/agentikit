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
  type EmbeddingBatchCommit,
  type EmbeddingBatchSkip,
  estimateTokenCount,
  hasRemoteEndpoint,
} from "../llm/embedders/remote";
import { cosineSimilarity, type EmbeddingVector } from "../llm/embedders/types";
import type { Database } from "../storage/database";
import { getEmbeddableEntryCount } from "../storage/repositories/index-entries-repository";
import { deleteMeta, getMeta, setMeta } from "../storage/repositories/index-meta-repository";
import {
  type EmbeddingCanarySample,
  getAllEntriesForEmbedding,
  getEmbeddingCount,
  isVecFastPathComplete,
  isVecFastPathReady,
  purgeEmbeddings,
  sampleEmbeddedEntriesForCanary,
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

export interface GenerateEmbeddingsOptions {
  /**
   * Force a full purge + re-embed (`akm index --reembed`), bypassing the
   * fingerprint-rename canary entirely — an explicit operator override for
   * when the canary's own verdict should not be trusted (#955).
   */
  forceReembed?: boolean;
}

/** How often (in stored entries) to emit a progress line during a large embedding run (#954). */
const PROGRESS_INTERVAL = 500;

/**
 * Number of already-embedded entries sampled for the fingerprint-rename
 * canary (#955) — small and cheap even against a slow local server; a
 * handful of chunks is a strong compatibility signal (a different model
 * cannot plausibly land near-identical vectors by chance).
 */
const CANARY_SAMPLE_SIZE = 8;

/**
 * Minimum median cosine similarity between stored and freshly re-embedded
 * canary vectors for a fingerprint-string change to be treated as a
 * same-model rename rather than a real model change (#955).
 */
const CANARY_SIMILARITY_THRESHOLD = 0.999;

/** One (stored vector, freshly re-embedded vector) pair for the canary decision. */
export interface EmbeddingCanaryPair {
  stored: EmbeddingVector;
  /** Undefined when the canary re-embed failed or skipped this specific sample. */
  fresh: EmbeddingVector | undefined;
}

/** The single similarity computation behind the canary verdict (#955/#956). */
export interface EmbeddingCompatibilityDecision {
  outcome: "keep" | "rebuild" | "unverifiable";
  /** Median cosine similarity across the VERIFIED samples. Undefined when none could be computed. */
  medianSimilarity: number | undefined;
  /** Count of samples whose re-embed actually succeeded (`fresh !== undefined`). */
  verifiedSamples: number;
}

/**
 * Pure decision: do stored vectors remain valid against freshly re-embedded
 * canary samples? The ONE place that computes the canary's similarity
 * numbers — callers must use this result rather than recomputing it (#956).
 *
 * An empty sample means nothing is stored to lose or verify against, so
 * there is nothing to decide — keep.
 *
 * A sample whose re-embed FAILED (`fresh === undefined`, e.g. a provider
 * sub-batch that was skipped) is EXCLUDED from the similarity computation
 * entirely, not scored as zero: a partial provider failure is not evidence
 * of a different model (#956). A dimension mismatch on a successful
 * re-embed still counts as zero similarity via {@link cosineSimilarity}'s
 * own dimension-mismatch guard — that IS evidence. When half or fewer of
 * the sampled entries re-embedded successfully, the sample is too thin to
 * trust either verdict — the outcome is `unverifiable`, the same outcome a
 * total canary failure already produces.
 *
 * Otherwise the MEDIAN pairwise cosine similarity of the verified samples
 * must clear {@link CANARY_SIMILARITY_THRESHOLD}; the median (not the
 * minimum or mean) tolerates one stale or lightly-edited sample without
 * either discarding a real match or being fooled by it.
 */
export function decideEmbeddingCompatibility(pairs: readonly EmbeddingCanaryPair[]): EmbeddingCompatibilityDecision {
  if (pairs.length === 0) return { outcome: "keep", medianSimilarity: undefined, verifiedSamples: 0 };

  const verified = pairs.filter(
    (pair): pair is { stored: EmbeddingVector; fresh: EmbeddingVector } => pair.fresh !== undefined,
  );
  if (verified.length * 2 <= pairs.length) {
    return { outcome: "unverifiable", medianSimilarity: undefined, verifiedSamples: verified.length };
  }

  const similarities = verified.map((pair) => cosineSimilarity(pair.stored, pair.fresh));
  const medianSimilarity = medianOf(similarities);
  return {
    outcome: medianSimilarity >= CANARY_SIMILARITY_THRESHOLD ? "keep" : "rebuild",
    medianSimilarity,
    verifiedSamples: verified.length,
  };
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
}

/**
 * Identity of the embedding vectors actually observed on a run — as opposed
 * to {@link deriveSemanticProviderFingerprint}'s CONFIG-derived string. Keys
 * on what the server (or local model) actually reported plus the observed
 * vector width, so a gateway/transport change that keeps returning the same
 * underlying model can be told apart from a genuine model change without
 * relying on the operator's config string (#955 field-review addendum).
 * Returns undefined when nothing was actually observed this call (no vector
 * to measure yet).
 */
function deriveObservedEmbeddingIdentity(
  embedding: EmbeddingConnectionConfig | undefined,
  observedModel: string | undefined,
  observedVectorLen: number | undefined,
): string | undefined {
  if (isDeterministicEmbedEnabled()) {
    return `deterministic:${DETERMINISTIC_EMBED_MODEL_ID}`;
  }
  if (observedVectorLen === undefined) return undefined;
  if (embedding?.endpoint) {
    return `remote:${observedModel ?? embedding.model ?? "unknown"}|${observedVectorLen}`;
  }
  return `local:${embedding?.localModel ?? DEFAULT_LOCAL_MODEL}|${observedVectorLen}`;
}

type CanaryDecision =
  | {
      outcome: "keep";
      /** False for the empty-sample case: nothing was actually verified. */
      verified: boolean;
      identity?: string;
      viaIdentityMatch: boolean;
      medianSimilarity?: number;
    }
  | { outcome: "rebuild"; identity?: string; reason: string }
  | { outcome: "unverifiable"; message: string };

/**
 * Run the fingerprint-rename canary: re-embed a small sample of already-
 * stored entries with the CURRENT config and decide whether the stored
 * index survives. Goes through the standard {@link embedBatch} facade (not a
 * direct `RemoteEmbedder`) so every embedder branch — remote, local,
 * deterministic, and test overrides via `_setEmbedderForTests` — is
 * exercised identically to the main embedding pass.
 */
async function runEmbeddingCanary(
  db: Database,
  config: AkmConfig,
  signal: AbortSignal | undefined,
): Promise<CanaryDecision> {
  const samples: EmbeddingCanarySample[] = sampleEmbeddedEntriesForCanary(db, CANARY_SAMPLE_SIZE);
  if (samples.length === 0) {
    return { outcome: "keep", verified: false, viaIdentityMatch: false };
  }

  let observedModel: string | undefined;
  const skips: EmbeddingBatchSkip[] = [];
  let canaryVectors: (EmbeddingVector | undefined)[];
  try {
    canaryVectors = await embedBatch(
      samples.map((sample) => sample.searchText),
      config.embedding,
      signal,
      (skip) => skips.push(skip),
      (_indices, _embeddings, model) => {
        if (model) observedModel = model;
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      outcome: "unverifiable",
      message: `could not verify embedding compatibility (${message}); keeping existing vectors — rerun akm index when the endpoint is reachable`,
    };
  }

  const observedVectorLen = canaryVectors.find((vector): vector is EmbeddingVector => vector !== undefined)?.length;
  const observedIdentity = deriveObservedEmbeddingIdentity(config.embedding, observedModel, observedVectorLen);
  const storedIdentity = getMeta(db, "embeddingIdentity");

  if (storedIdentity && observedIdentity && storedIdentity === observedIdentity) {
    // The server reports the same model identity as last time — no need to
    // even look at the cosines; the config string alone was misleading.
    return { outcome: "keep", verified: true, identity: observedIdentity, viaIdentityMatch: true };
  }

  const pairs: EmbeddingCanaryPair[] = samples.map((sample, i) => ({ stored: sample.vector, fresh: canaryVectors[i] }));
  const decision = decideEmbeddingCompatibility(pairs);

  if (decision.outcome === "unverifiable") {
    // Covers both a total provider failure (RemoteEmbedder skips a failing
    // request rather than throwing, #874, so an unreachable endpoint
    // surfaces here as an all-`undefined` canary result, not a caught
    // exception) and a partial one thin enough that neither verdict can be
    // trusted (#956) — same message path either way.
    const message = skips[0]?.message ?? "embedding provider returned no vectors for the canary sample";
    return {
      outcome: "unverifiable",
      message: `could not verify embedding compatibility (${message}); keeping existing vectors — rerun akm index when the endpoint is reachable`,
    };
  }

  if (decision.outcome === "keep") {
    return {
      outcome: "keep",
      verified: true,
      identity: observedIdentity,
      viaIdentityMatch: false,
      medianSimilarity: decision.medianSimilarity,
    };
  }
  return {
    outcome: "rebuild",
    identity: observedIdentity,
    reason: `vectors differ (median similarity ${decision.medianSimilarity?.toFixed(3)})`,
  };
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
  opts?: GenerateEmbeddingsOptions,
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
  /** Set only on an actual rebuild, so the up-front "Re-embedding N entries" line names why. */
  let rebuildReason: string | undefined;

  if (opts?.forceReembed) {
    // `akm index --reembed`: an explicit operator override, skips the canary
    // entirely. The new fingerprint (and identity, now stale/unknown until
    // the next successful pass observes it) is written in the SAME
    // transaction as the purge, before any embedding request — a restart
    // then sees a matching fingerprint and only heals what is still missing
    // instead of purging again from zero (#955/#956).
    db.transaction(() => {
      purgeEmbeddings(db, { dropVecTable: true });
      deleteMeta(db, "embeddingDim");
      setMeta(db, "embeddingFingerprint", currentFingerprint);
      deleteMeta(db, "embeddingIdentity");
    })();
    targetEntryIds = undefined;
    rebuildReason = "forced by --reembed";
  } else if (storedFingerprint && storedFingerprint !== currentFingerprint) {
    const decision = await runEmbeddingCanary(db, config, signal);

    if (decision.outcome === "unverifiable") {
      // Destroying a good index because the server happens to be down right
      // now is worse than leaving a rename unverified until the next run —
      // keep the vectors AND the old fingerprint so the next `akm index`
      // retries the canary instead of silently treating this as resolved.
      warn(`[embed] ${decision.message}`);
      onProgress({ phase: "embeddings", message: decision.message });
      return { success: false, message: decision.message };
    }

    if (decision.outcome === "rebuild") {
      db.transaction(() => {
        purgeEmbeddings(db, { dropVecTable: true });
        deleteMeta(db, "embeddingDim");
        setMeta(db, "embeddingFingerprint", currentFingerprint);
        if (decision.identity) setMeta(db, "embeddingIdentity", decision.identity);
        else deleteMeta(db, "embeddingIdentity");
      })();
      targetEntryIds = undefined;
      rebuildReason = decision.reason;
    } else {
      // Keep: adopt the new fingerprint (and identity, when observed)
      // immediately rather than deferring to end-of-run — nothing was
      // purged, so there is nothing an interruption could lose, and an
      // immediate write means a crash right after this decision does not
      // re-run the canary needlessly on the next attempt.
      setMeta(db, "embeddingFingerprint", currentFingerprint);
      if (decision.identity) setMeta(db, "embeddingIdentity", decision.identity);
      if (decision.verified) {
        const keptCount = getEmbeddingCount(db);
        const detail = decision.viaIdentityMatch
          ? "server-reported model unchanged"
          : `stored vectors are compatible (median similarity ${decision.medianSimilarity?.toFixed(3)})`;
        const message = `[embed] embedding model renamed (${storedFingerprint} → ${currentFingerprint}); ${detail}, keeping ${keptCount} embedding${keptCount === 1 ? "" : "s"}.`;
        warn(message);
        onProgress({ phase: "embeddings", message });
      }
      // Empty-sample case (decision.verified === false): nothing stored to
      // lose or verify against — adopt the label silently, no purge line.
    }
  }

  try {
    throwIfAborted(signal);
    const allEntries = getAllEntriesForEmbedding(db, targetEntryIds);
    if (allEntries.length === 0) {
      onProgress({ phase: "embeddings", message: "Embeddings already up to date." });
      setMeta(db, "embeddingFingerprint", currentFingerprint);
      return { success: true };
    }
    if (rebuildReason) {
      const message = `[embed] Re-embedding ${allEntries.length} entr${allEntries.length === 1 ? "y" : "ies"} because ${rebuildReason}`;
      warn(message);
      onProgress({ phase: "embeddings", message });
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
    let storedCount = 0;
    let skippedCount = 0;
    let embedFailedCount = 0;
    let vecFailedCount = 0;
    let vecUnavailableCount = 0;
    let storedTokens = 0;
    let lastProgressBucket = 0;
    try {
      heartbeatTimer = setInterval(() => {
        onProgress({
          phase: "embeddings",
          message: `Still generating embeddings: ${storedCount}/${allEntries.length} stored; waiting on embedding provider.`,
        });
      }, 15000);

      // A failing sub-batch or an oversized document is SKIPPED by embedBatch,
      // not thrown (#874) — collect what couldn't be embedded and why, so a
      // few bad documents don't discard every other entry's embedding.
      const skips: EmbeddingBatchSkip[] = [];
      const embedStart = Date.now();
      // Commit each provider batch in its own short transaction as it lands,
      // rather than buffering the whole run in memory for one transaction at
      // the very end (#954) — a competing-process lock error or any other
      // interruption partway through now keeps whatever already committed
      // instead of losing the entire pass.
      // Tracks what this run actually observed, so a successful pass can
      // record `embeddingIdentity` from real data rather than the config
      // string alone (#955) — only the first non-empty batch's vector width
      // is kept; every batch from one run shares the same provider/model.
      let observedModel: string | undefined;
      let observedVectorLen: number | undefined;
      const onBatch: EmbeddingBatchCommit = (indices, batchEmbeddings, model) => {
        if (model) observedModel = model;
        db.transaction(() => {
          for (let k = 0; k < indices.length; k++) {
            const entry = allEntries[indices[k] as number];
            if (!entry) continue;
            const embedding = batchEmbeddings[k];
            if (!embedding) {
              embedFailedCount++;
              continue;
            }
            if (observedVectorLen === undefined) observedVectorLen = embedding.length;
            const result = upsertEmbedding(db, entry.id, embedding);
            if (result.stored) {
              storedCount++;
              storedTokens += estimateTokenCount(entry.searchText);
            } else {
              skippedCount++;
            }
            if (result.vec === "failed") vecFailedCount++;
            if (result.vec === "unavailable") vecUnavailableCount++;
          }
        })();
        const bucket = Math.floor(storedCount / PROGRESS_INTERVAL);
        if (bucket > lastProgressBucket) {
          lastProgressBucket = bucket;
          onProgress({
            phase: "embeddings",
            message: `Embedded ${storedCount}/${allEntries.length} entries.`,
          });
        }
      };
      await embedBatch(texts, config.embedding, signal, (skip) => skips.push(skip), onBatch);
      throwIfAborted(signal);
      const elapsedSeconds = Math.max((Date.now() - embedStart) / 1000, 0.001);
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
      const entriesPerSec = storedCount / elapsedSeconds;
      const tokensPerSec = storedTokens / elapsedSeconds;
      onProgress({
        phase: "embeddings",
        message: `Stored ${storedCount} embedding${storedCount === 1 ? "" : "s"} in ${elapsedSeconds.toFixed(1)}s (${entriesPerSec.toFixed(1)} entries/s, ~${Math.round(tokensPerSec)} tokens/s).`,
      });
      setMeta(db, "embeddingFingerprint", currentFingerprint);
      const observedIdentity = deriveObservedEmbeddingIdentity(config.embedding, observedModel, observedVectorLen);
      if (observedIdentity) setMeta(db, "embeddingIdentity", observedIdentity);
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
