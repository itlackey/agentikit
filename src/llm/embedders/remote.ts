// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenAI-compatible remote embedder.
 *
 * Calls the configured `/embeddings` endpoint and L2-normalizes the returned
 * vectors so the scoring pipeline's L2-to-cosine conversion is correct.
 */

import { fetchWithTimeout, isHttpUrl, readBodyWithByteCap } from "../../core/common";
import { concurrentMap } from "../../core/concurrent";
import { type EmbeddingConnectionConfig, resolveSecret } from "../../core/config/config";
import { isLoopbackEndpoint } from "../../core/loopback";
import { redactErrorBody, redactSensitiveText } from "../../core/redaction";
import { warnVerbose } from "../../core/warn";
import { resolveSecretFromStore } from "../../sources/snapshot-fetchers/secret-seam";
import type { Embedder, EmbeddingVector } from "./types";

/**
 * Upper bound on the number of documents in one HTTP request, independent of
 * the token budget below. Overridable via `config.batchSize`. Purely a
 * safety cap (very many tiny documents could otherwise pack one request) —
 * the token budget is what actually keeps a request inside the endpoint's
 * context window and inside the timeout (#874).
 */
export const DEFAULT_REMOTE_BATCH_SIZE = 100;

/**
 * Conservative default token budget per HTTP request when the config gives
 * no better number (`maxTokens` or `contextLength`). #874's measurements:
 * a batch of 100 small docs (~400 KB, ~100K tokens) took 14.8s against a
 * healthy local endpoint — half the 30s request timeout — and a single
 * 128 KB (~24K token) document alone was rejected by the endpoint as
 * exceeding its context size. 8000 tokens keeps a batch's estimated size
 * comfortably under both the timeout and common local-model context windows.
 */
export const DEFAULT_TOKEN_BUDGET = 8000;

/** Cheap token estimator: 4 chars ≈ 1 token. Used in verbose logging and error messages. */
export function estimateTokenCount(text: string): number {
  return Math.round(text.length / 4);
}

/** Why a document was skipped rather than embedded. */
export type EmbeddingSkipReason = "context-window-exceeded" | "batch-request-failed";

export interface EmbeddingBatchSkip {
  /** Index into the `texts` array passed to `embedBatch`. */
  index: number;
  reason: EmbeddingSkipReason;
  message: string;
}

/**
 * Fired once per provider request (success OR skip-with-undefined-slots),
 * before the next request starts (#954). `indices` are positions into the
 * `texts` array passed to `embedBatch`; `embeddings` is the same length,
 * `undefined` at any index that failed or was skipped. Lets the caller
 * commit each batch to durable storage as it lands rather than buffering the
 * whole run in memory for one final write — completion order is irrelevant
 * to a caller that commits per call, so this fires under concurrency too.
 *
 * `model`, when the provider's response body carried one, is the server-
 * reported model id for that request (#955) — undefined for a skipped
 * batch, a local/deterministic run, or a provider that omits the field.
 * The embedding-fingerprint canary uses it to tell a same-model config
 * rename (e.g. a gateway prefixing `provider/model`) apart from a genuine
 * model change without guessing from the config string alone.
 */
export type EmbeddingBatchCommit = (
  indices: number[],
  embeddings: (EmbeddingVector | undefined)[],
  model?: string,
) => void;

/**
 * Distinguishes a batch rejected because it exceeded the endpoint's context
 * window from every other failure mode (network error, 5xx, malformed
 * response). Only this error class triggers the split-in-half retry in
 * {@link RemoteEmbedder.embedBatch} (#954) — anything else keeps the
 * original skip-the-whole-batch behavior pinned by
 * tests/integration/embedding-batch-partial-failure.test.ts.
 */
export class ContextExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextExceededError";
  }
}

/** Patterns providers use to report a request too large for the model's context window. */
const CONTEXT_EXCEEDED_PATTERN = /exceed_context_size_error|context size|context length|too many tokens/i;

/**
 * True when an HTTP failure means "this request's input is too large for the
 * endpoint's context window" rather than some other failure. HTTP 413
 * (Payload Too Large) is always treated this way regardless of body; other
 * status codes are checked against known provider error-body phrasing.
 */
export function isContextExceededResponse(status: number, body: string): boolean {
  if (status === 413) return true;
  return CONTEXT_EXCEEDED_PATTERN.test(body);
}

/**
 * Resolve the effective in-flight request window for `RemoteEmbedder.embedBatch`.
 * FIXED — no config override (owner ruling 2026-09-09): 1 for a loopback
 * endpoint (a local model server serves one inference at a time; concurrent
 * requests thrash it), 2 for a remote one, mirroring
 * `getDefaultLlmConcurrency`'s (src/indexer/indexer.ts) lowest-common-
 * denominator rule without importing from src/indexer, which already depends
 * on this module transitively through materialize-embeddings.ts. The actual
 * throughput knob is request SIZE, not request count: `embedding.batchSize`
 * (document cap) and `embedding.maxTokens`/`contextLength` (token budget)
 * reach a larger batch per request, which is where most of the win is — a
 * 32-input batch takes about the same wall time as one input against a
 * healthy endpoint.
 */
export function resolveEmbeddingConcurrency(config: EmbeddingConnectionConfig): number {
  return isLoopbackEndpoint(config.endpoint) ? 1 : 2;
}

interface TextBatch {
  /** Indices into the original `texts` array. */
  indices: number[];
  /** True when this "batch" is a single document too large to ever fit the token budget. */
  oversized: boolean;
}

/**
 * Group `texts` into request-sized batches bounded by BOTH an estimated
 * token budget and a document-count cap, so one large document does not
 * silently blow the batch past the endpoint's context window (#874).
 *
 * A single document whose own estimate exceeds `tokenBudget` can never fit
 * any batch — it is reported as its own oversized "batch" so the caller can
 * skip it without ever making an HTTP request for it.
 */
export function buildTokenBoundedBatches(texts: readonly string[], tokenBudget: number, maxCount: number): TextBatch[] {
  const batches: TextBatch[] = [];
  let current: number[] = [];
  let currentTokens = 0;

  const flush = (): void => {
    if (current.length > 0) {
      batches.push({ indices: current, oversized: false });
      current = [];
      currentTokens = 0;
    }
  };

  for (let i = 0; i < texts.length; i++) {
    const tokens = estimateTokenCount(texts[i] as string);
    if (tokens > tokenBudget) {
      flush();
      batches.push({ indices: [i], oversized: true });
      continue;
    }
    if (current.length > 0 && (currentTokens + tokens > tokenBudget || current.length >= maxCount)) {
      flush();
    }
    current.push(i);
    currentTokens += tokens;
  }
  flush();
  return batches;
}

export class RemoteEmbedder implements Embedder {
  private readonly endpoint: string;
  private readonly model: string;

  constructor(private readonly config: EmbeddingConnectionConfig) {
    if (!config.endpoint || !config.model) {
      throw new Error("RemoteEmbedder requires both endpoint and model on the embedding config.");
    }
    this.endpoint = config.endpoint;
    this.model = config.model;
  }

  async embed(text: string, signal?: AbortSignal): Promise<EmbeddingVector> {
    const headers = this.buildHeaders();
    const body: { input: string; model: string; dimensions?: number; options?: { num_ctx?: number } } = {
      input: text,
      model: this.model,
    };
    if (this.config.dimension) {
      body.dimensions = this.config.dimension;
    }
    const ollamaOpts = resolveOllamaOptions(this.config);
    if (ollamaOpts) {
      body.options = ollamaOpts;
    }

    // `signal` MUST go through fetchWithTimeout's dedicated 4th parameter, not
    // the RequestInit: fetchWithTimeout replaces `opts.signal` with its own
    // controller (`{ ...opts, signal: controller.signal }`), so a signal passed
    // inside `opts` is silently dropped and caller cancellation never fires.
    const response = await fetchWithTimeout(
      normalizeEmbeddingEndpoint(this.endpoint),
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
      30_000,
      signal,
    );

    if (!response.ok) {
      const errBody = await readBodyWithByteCap(response, undefined, { bodyTimeoutMs: 30_000, signal }).catch((err) => {
        if (signal?.aborted) throw err;
        return "";
      });
      throw new Error(`Embedding request failed (${response.status}): ${this.safeErrorBody(errBody)}`);
    }

    const json = JSON.parse(await readBodyWithByteCap(response, undefined, { bodyTimeoutMs: 30_000, signal })) as {
      data: Array<{ embedding: number[] }>;
    };

    if (!json.data?.[0]?.embedding) {
      throw new Error(
        `Unexpected embedding response format: missing data[0].embedding.${embeddingEndpointPathHint(this.endpoint)}`,
      );
    }

    return l2Normalize(json.data[0].embedding);
  }

  /**
   * Embed every text, batched by an estimated token budget (not a fixed
   * document count) and bounded by `config.batchSize` as a document-count
   * safety cap. Batching by count alone let a batch of ordinary-sized
   * documents balloon past the endpoint's context window and the 30s
   * request timeout (#874).
   *
   * A failing sub-batch or an oversized single document is SKIPPED, not
   * thrown — the rest of `texts` still gets embedded. Skips are reported via
   * `onSkip` (index into `texts` + a named reason) rather than silently
   * dropped; the returned array holds `undefined` at every skipped index.
   * A caller abort (`signal.aborted`) still propagates as a rejection.
   *
   * Provider batches are dispatched through a bounded pool sized by
   * `resolveEmbeddingConcurrency` (#954) instead of strictly sequentially, so
   * request latency overlaps. `onBatch`, when given, fires once per provider
   * batch (success or skip) as it completes, only after that batch's own
   * outcome has already been classified — pass it to commit each batch's
   * rows durably as they land rather than buffering the whole call.
   * Completion order does not matter to `results` placement, which is always
   * written by index regardless of dispatch order. A throw from `onBatch`
   * itself (e.g. the caller's own commit failing) is never mistaken for a
   * provider/network failure; it is captured and rethrown once every batch
   * has been dispatched, alongside the `signal.aborted` check.
   *
   * A batch rejected specifically for exceeding the endpoint's context window
   * (HTTP 413, or a recognised context-size error body — see
   * {@link isContextExceededResponse}) is split in half and retried
   * recursively rather than skipped outright, down to individual documents; a
   * single document that still fails this way becomes a genuine
   * `context-window-exceeded` skip. Every other failure (network error, 5xx,
   * malformed response) keeps the original skip-the-whole-batch behavior.
   */
  async embedBatch(
    texts: string[],
    signal?: AbortSignal,
    onSkip?: (skip: EmbeddingBatchSkip) => void,
    onBatch?: EmbeddingBatchCommit,
  ): Promise<(EmbeddingVector | undefined)[]> {
    if (texts.length === 0) return [];
    const results: (EmbeddingVector | undefined)[] = new Array(texts.length).fill(undefined);
    const headers = this.buildHeaders();
    const ollamaOpts = resolveOllamaOptions(this.config);

    const tokenBudget = this.config.maxTokens ?? this.config.contextLength ?? DEFAULT_TOKEN_BUDGET;
    const maxCount = this.config.batchSize ?? DEFAULT_REMOTE_BATCH_SIZE;
    const textBatches = buildTokenBoundedBatches(texts, tokenBudget, maxCount);

    // First error thrown BY the caller's onBatch callback (e.g. a real
    // competing-process SQLITE_BUSY from the materializer's db.transaction())
    // rather than by requestBatch itself. Captured here instead of being left
    // to reach requestAndCommit's try/catch below, which exists solely to
    // classify requestBatch's own provider/network failures — a persistence
    // failure must never be caught by that block and misreported as a
    // fabricated "batch-request-failed" skip (#954). Checked (and rethrown)
    // once the pool drains, the same way `signal?.aborted` is today.
    let firstOnBatchError: unknown;
    const commitBatch = (indices: number[], embeddings: (EmbeddingVector | undefined)[], model?: string): void => {
      if (!onBatch) return;
      try {
        onBatch(indices, embeddings, model);
      } catch (err) {
        if (firstOnBatchError === undefined) firstOnBatchError = err;
      }
    };

    // Requests a single provider batch (by index list), recursing on a
    // context-size rejection. Never throws except to propagate a genuine
    // caller abort — every other outcome (success or a non-abort failure)
    // resolves normally after reporting via onSkip/onBatch. `onBatch` fires
    // only once this try/catch has already settled success vs. failure, so a
    // throw from it is never caught and reclassified by this block.
    const requestAndCommit = async (indices: number[]): Promise<void> => {
      const batch = indices.map((i) => texts[i] as string);
      let batchEmbeddings: (EmbeddingVector | undefined)[];
      let responseModel: string | undefined;
      try {
        const { vectors, model } = await this.requestBatch(batch, headers, ollamaOpts, signal);
        for (let k = 0; k < indices.length; k++) {
          results[indices[k] as number] = vectors[k];
        }
        batchEmbeddings = indices.map((i) => results[i]);
        responseModel = model;
      } catch (err) {
        // A caller abort must still propagate — it is not a "this batch
        // failed" condition, it means stop entirely.
        if (signal?.aborted) throw err;
        if (err instanceof ContextExceededError && indices.length > 1) {
          const mid = Math.ceil(indices.length / 2);
          await requestAndCommit(indices.slice(0, mid));
          await requestAndCommit(indices.slice(mid));
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        const reason: EmbeddingSkipReason =
          err instanceof ContextExceededError ? "context-window-exceeded" : "batch-request-failed";
        warnVerbose(`[embed] batch of ${batch.length} document(s) failed and was skipped: ${message}`);
        for (const idx of indices) {
          onSkip?.({ index: idx, reason, message });
        }
        batchEmbeddings = indices.map(() => undefined);
      }
      commitBatch(indices, batchEmbeddings, responseModel);
    };

    const runProviderBatch = async (textBatch: TextBatch): Promise<void> => {
      if (textBatch.oversized) {
        const idx = textBatch.indices[0] as number;
        const estTokens = estimateTokenCount(texts[idx] as string);
        onSkip?.({
          index: idx,
          reason: "context-window-exceeded",
          message: `Document estimated at ${estTokens} tokens exceeds the ${tokenBudget}-token embedding budget; skipped.`,
        });
        commitBatch([idx], [undefined]);
        return;
      }
      await requestAndCommit(textBatch.indices);
    };

    const concurrency = resolveEmbeddingConcurrency(this.config);
    // concurrentMap swallows a thrown fn (per-item, results discarded here —
    // requestAndCommit only throws to signal a caller abort), so abort must
    // be re-checked once the pool has drained rather than relying on the
    // throw itself to escape.
    await concurrentMap(textBatches, runProviderBatch, concurrency, { signal });
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("embedding interrupted");
    }
    if (firstOnBatchError !== undefined) {
      throw firstOnBatchError instanceof Error ? firstOnBatchError : new Error(String(firstOnBatchError));
    }

    return results;
  }

  /**
   * Send one batch request and return its embeddings in input order, plus the
   * server-reported `model` id when the response body carried one (#955) —
   * used by the embedding-fingerprint canary to verify a config-string
   * rename against what the endpoint actually served, not just re-assert the
   * configured string. Throws on any failure.
   */
  private async requestBatch(
    batch: string[],
    headers: Record<string, string>,
    ollamaOpts: { num_ctx?: number } | undefined,
    signal?: AbortSignal,
  ): Promise<{ vectors: EmbeddingVector[]; model?: string }> {
    const body: { input: string[]; model: string; dimensions?: number; options?: { num_ctx?: number } } = {
      input: batch,
      model: this.model,
    };
    if (this.config.dimension) {
      body.dimensions = this.config.dimension;
    }
    if (ollamaOpts) {
      body.options = ollamaOpts;
    }

    // See embed(): `signal` goes through the 4th parameter, not the
    // RequestInit, or fetchWithTimeout drops it.
    const response = await fetchWithTimeout(
      normalizeEmbeddingEndpoint(this.endpoint),
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
      30_000,
      signal,
    );

    if (!response.ok) {
      const respBody = await readBodyWithByteCap(response, undefined, { bodyTimeoutMs: 30_000, signal }).catch(
        (err) => {
          if (signal?.aborted) throw err;
          return "";
        },
      );
      const message = `Embedding batch request failed (${response.status}): ${this.safeErrorBody(respBody)}`;
      if (isContextExceededResponse(response.status, respBody)) {
        throw new ContextExceededError(message);
      }
      throw new Error(message);
    }

    const json = JSON.parse(await readBodyWithByteCap(response, undefined, { bodyTimeoutMs: 30_000, signal })) as {
      data: Array<{ embedding: number[]; index: number }>;
      model?: string;
    };

    if (!json.data || json.data.length !== batch.length) {
      throw new Error(
        `Unexpected embedding batch response: expected ${batch.length} embeddings, got ${json.data?.length ?? 0}.${embeddingEndpointPathHint(this.endpoint)}`,
      );
    }

    // Sort by index to guarantee correct order (OpenAI API doesn't guarantee order)
    const sorted = [...json.data].sort((a, b) => a.index - b.index);

    const results: EmbeddingVector[] = [];
    for (const [idx, d] of sorted.entries()) {
      if (!Array.isArray(d.embedding)) {
        throw new Error(`Unexpected embedding at batch index ${idx}: missing or invalid`);
      }
      results.push(l2Normalize(d.embedding));
    }
    return { vectors: results, model: typeof json.model === "string" && json.model ? json.model : undefined };
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const resolvedKey = resolveSecret(this.config.apiKey, resolveSecretFromStore);
    if (resolvedKey) {
      headers.Authorization = `Bearer ${resolvedKey}`;
    }
    return headers;
  }

  /**
   * Make a provider error body safe to embed in a thrown Error, matching the
   * hardening llm/client.ts applies on the identical path: pattern-redact
   * credential shapes, exact-scrub this connection's own key, and clip.
   *
   * These messages surface via generateEmbeddingsForDb's `EmbeddingGenerationResult.message`
   * and are printed on every vector-search attempt. Raw bodies reached that
   * far unredacted and uncapped, at readBodyWithByteCap's 10 MB default.
   */
  private safeErrorBody(body: string): string {
    const resolvedKey = resolveSecret(this.config.apiKey, resolveSecretFromStore);
    return redactSensitiveText(redactErrorBody(body), resolvedKey ? [resolvedKey] : []);
  }
}

/**
 * L2-normalize a vector to unit length.
 * Required for remote embeddings because the scoring pipeline's L2-to-cosine
 * conversion formula (1 - distance^2/2) is only correct for unit vectors.
 * The local embedder already normalizes via `normalize: true`.
 */
function l2Normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

export function normalizeEmbeddingEndpoint(endpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return endpoint;
  }

  const normalizedPath = parsed.pathname.replace(/\/+$/, "");
  if (normalizedPath.endsWith("/embeddings")) {
    return parsed.toString();
  }
  // Ollama's NATIVE embedding route is `/api/embed` (and the older
  // `/api/embeddings`). Appending "/embeddings" to it produced
  // `/api/embed/embeddings`, a 404 — so pointing akm at the native endpoint,
  // which is what its own options like ollamaOptions and contextLength are
  // for, could never work. An explicit path that is already an embedding route
  // is left alone.
  if (normalizedPath.endsWith("/embed")) {
    return parsed.toString();
  }

  parsed.pathname = normalizedPath ? `${normalizedPath}/embeddings` : "/embeddings";
  return parsed.toString();
}

function embeddingEndpointPathHint(endpoint: string): string {
  const normalizedEndpoint = normalizeEmbeddingEndpoint(endpoint);
  if (normalizedEndpoint !== endpoint) {
    return ` Check that your endpoint includes the full embeddings path (for example "${normalizedEndpoint}", not just "${endpoint}").`;
  }
  return "";
}

/**
 * Resolve Ollama-native `options` from the embedding config.
 *
 * Resolution order:
 *   1. `ollamaOptions` — forwarded verbatim (explicit opt-in, takes precedence).
 *   2. `contextLength` — wrapped as `{ num_ctx: contextLength }`.
 *   3. Neither set → returns `undefined` (no `options` field in the request body).
 *
 * These options are only meaningful for Ollama's native `/api/embed` endpoint.
 * OpenAI-compatible endpoints ignore unknown request fields, so passing them to
 * other providers is harmless but has no effect.
 */
function resolveOllamaOptions(config: EmbeddingConnectionConfig): { num_ctx?: number } | undefined {
  if (config.ollamaOptions && Object.keys(config.ollamaOptions).length > 0) {
    return config.ollamaOptions;
  }
  if (config.contextLength) {
    return { num_ctx: config.contextLength };
  }
  return undefined;
}

/** Check whether an EmbeddingConnectionConfig has a valid remote endpoint. */
export function hasRemoteEndpoint(config: EmbeddingConnectionConfig): boolean {
  return isHttpUrl(config.endpoint);
}
