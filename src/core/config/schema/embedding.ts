// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Embedding connection config (`embedding`). Extracted verbatim from the former
 * `config-schema.ts` monolith — no behavior change.
 */
import { z } from "zod";
import { positiveInt, symbolicOrWarnApiKey } from "./primitives";

const EmbeddingOllamaOptionsSchema = z
  .object({
    num_ctx: positiveInt.optional(),
  })
  .passthrough();

/**
 * Embedding connection config. Both `endpoint` and `model` are optional:
 *   - Remote: provide `endpoint` (http/https URL) + `model`.
 *   - Local-only: omit `endpoint`/`model`; set `localModel` (or fall back to
 *     {@link DEFAULT_LOCAL_MODEL}).
 *
 * Consumers route via `hasRemoteEndpoint()` which checks for an http(s)
 * endpoint — absent fields take the local path naturally, no sentinels needed.
 */
export const EmbeddingConnectionConfigSchema = z
  .object({
    provider: z.string().optional(),
    endpoint: z.string().optional(),
    model: z.string().optional(),
    apiKey: symbolicOrWarnApiKey("embedding.apiKey").optional(),
    // Bounded to the index schema's own vec-table guard (1–4096,
    // storage/repositories/index-schema.ts) so an out-of-range dimension
    // fails at config validation with a clear message instead of crashing
    // `akm index` when ensureSchema rejects it (§24.2 "Semantic" gate).
    dimension: positiveInt.max(4096).optional(),
    localModel: z.string().min(1).optional(),
    maxTokens: positiveInt.optional(),
    batchSize: positiveInt.optional(),
    chunkSize: positiveInt.optional(),
    contextLength: positiveInt.optional(),
    ollamaOptions: EmbeddingOllamaOptionsSchema.optional(),
    /**
     * Per-request timeout in milliseconds for a remote embedding request
     * (default 120_000, `DEFAULT_EMBEDDING_TIMEOUT_MS` in
     * `src/llm/embedders/remote.ts`). The prior fixed 30s cut off a slow
     * local model server on a large token-bounded batch mid-response, with
     * no retry — every batch that hit it was silently dropped (#9541).
     */
    timeoutMs: positiveInt.optional(),
  })
  .passthrough();
