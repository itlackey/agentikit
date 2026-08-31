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
import { type EmbeddingConnectionConfig, resolveSecret } from "../../core/config/config";
import { redactErrorBody, redactSensitiveText } from "../../core/redaction";
import { warnVerbose } from "../../core/warn";
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
   */
  async embedBatch(
    texts: string[],
    signal?: AbortSignal,
    onSkip?: (skip: EmbeddingBatchSkip) => void,
  ): Promise<(EmbeddingVector | undefined)[]> {
    if (texts.length === 0) return [];
    const results: (EmbeddingVector | undefined)[] = new Array(texts.length).fill(undefined);
    const headers = this.buildHeaders();
    const ollamaOpts = resolveOllamaOptions(this.config);

    const tokenBudget = this.config.maxTokens ?? this.config.contextLength ?? DEFAULT_TOKEN_BUDGET;
    const maxCount = this.config.batchSize ?? DEFAULT_REMOTE_BATCH_SIZE;
    const batches = buildTokenBoundedBatches(texts, tokenBudget, maxCount);

    for (const textBatch of batches) {
      if (textBatch.oversized) {
        const idx = textBatch.indices[0] as number;
        const estTokens = estimateTokenCount(texts[idx] as string);
        onSkip?.({
          index: idx,
          reason: "context-window-exceeded",
          message: `Document estimated at ${estTokens} tokens exceeds the ${tokenBudget}-token embedding budget; skipped.`,
        });
        continue;
      }

      const batch = textBatch.indices.map((i) => texts[i] as string);
      try {
        const embeddings = await this.requestBatch(batch, headers, ollamaOpts, signal);
        for (let k = 0; k < textBatch.indices.length; k++) {
          results[textBatch.indices[k] as number] = embeddings[k];
        }
      } catch (err) {
        // A caller abort must still propagate — it is not a "this batch
        // failed" condition, it means stop entirely.
        if (signal?.aborted) throw err;
        const message = err instanceof Error ? err.message : String(err);
        warnVerbose(`[embed] batch of ${batch.length} document(s) failed and was skipped: ${message}`);
        for (const idx of textBatch.indices) {
          onSkip?.({ index: idx, reason: "batch-request-failed", message });
        }
      }
    }

    return results;
  }

  /** Send one batch request and return its embeddings in input order. Throws on any failure. */
  private async requestBatch(
    batch: string[],
    headers: Record<string, string>,
    ollamaOpts: { num_ctx?: number } | undefined,
    signal?: AbortSignal,
  ): Promise<EmbeddingVector[]> {
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
      throw new Error(`Embedding batch request failed (${response.status}): ${this.safeErrorBody(respBody)}`);
    }

    const json = JSON.parse(await readBodyWithByteCap(response, undefined, { bodyTimeoutMs: 30_000, signal })) as {
      data: Array<{ embedding: number[]; index: number }>;
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
    return results;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const resolvedKey = resolveSecret(this.config.apiKey);
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
   * These messages are durable — generateEmbeddingsForDb surfaces them as
   * `embeddingResult.message`, which is written to semantic-status.json and
   * replayed by `akm info` (including `--json`) until the next successful
   * index, and printed on every vector-search attempt. Raw bodies reached that
   * far unredacted and uncapped, at readBodyWithByteCap's 10 MB default.
   */
  private safeErrorBody(body: string): string {
    const resolvedKey = resolveSecret(this.config.apiKey);
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
