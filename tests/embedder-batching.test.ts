// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #954: per-provider-batch commit, bounded in-flight concurrency, and
 * context-size split-and-retry for RemoteEmbedder.embedBatch.
 *
 * All network I/O here is mocked via `withMockedFetch` (no real socket
 * opened), so this stays a pure unit test rather than an integration test —
 * see AGENTS.md's tests/integration/ classification rule. The real-server
 * variants of the concurrency and context-split behavior live in
 * tests/integration/embedder.test.ts.
 */

import { describe, expect, test } from "bun:test";
import type { EmbeddingConnectionConfig } from "../src/core/config/config";
import { isContextExceededResponse, RemoteEmbedder, resolveEmbeddingConcurrency } from "../src/llm/embedders/remote";
import type { EmbeddingVector } from "../src/llm/embedders/types";
import { withMockedFetch } from "./_helpers/sandbox";

describe("isContextExceededResponse", () => {
  test("HTTP 413 is always a context-size rejection, regardless of body", () => {
    expect(isContextExceededResponse(413, "")).toBe(true);
    expect(isContextExceededResponse(413, "some unrelated body")).toBe(true);
  });

  test("recognises named context-size error bodies on other status codes", () => {
    expect(isContextExceededResponse(400, '{"error":"exceed_context_size_error"}')).toBe(true);
    expect(isContextExceededResponse(400, "Request exceeds the model's context size")).toBe(true);
    expect(isContextExceededResponse(400, "context length exceeded")).toBe(true);
    expect(isContextExceededResponse(500, "too many tokens in request")).toBe(true);
    expect(isContextExceededResponse(400, "EXCEED_CONTEXT_SIZE_ERROR")).toBe(true);
  });

  test("a generic failure is not a context-size rejection", () => {
    expect(isContextExceededResponse(500, "synthetic upstream failure")).toBe(false);
    expect(isContextExceededResponse(503, "service unavailable")).toBe(false);
    expect(isContextExceededResponse(400, "")).toBe(false);
  });
});

describe("resolveEmbeddingConcurrency", () => {
  test("an explicit config.concurrency always wins", () => {
    expect(resolveEmbeddingConcurrency({ endpoint: "http://localhost:1234", concurrency: 7 })).toBe(7);
    expect(resolveEmbeddingConcurrency({ endpoint: "https://api.example.com", concurrency: 1 })).toBe(1);
  });

  test("defaults to 1 for a loopback endpoint", () => {
    expect(resolveEmbeddingConcurrency({ endpoint: "http://localhost:8080" })).toBe(1);
    expect(resolveEmbeddingConcurrency({ endpoint: "http://127.0.0.1:8080" })).toBe(1);
  });

  test("defaults to 1 when no endpoint is configured (fails safe as local)", () => {
    expect(resolveEmbeddingConcurrency({})).toBe(1);
  });

  test("defaults to 2 for a remote endpoint", () => {
    expect(resolveEmbeddingConcurrency({ endpoint: "https://api.example.com/v1" })).toBe(2);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("RemoteEmbedder.embedBatch: context-size split-and-retry", () => {
  test("a batch rejected as context-exceeded is split in half and retried until it fits", async () => {
    const requestSizes: number[] = [];
    await withMockedFetch(
      async () => {
        const embedder = new RemoteEmbedder({ endpoint: "http://localhost:1/v1", model: "test-model" });
        const committed: Array<{ indices: number[]; embeddings: (EmbeddingVector | undefined)[] }> = [];
        const results = await embedder.embedBatch(
          ["a", "bb", "ccc", "dddd"],
          undefined,
          undefined,
          (indices, embeddings) => committed.push({ indices, embeddings }),
        );

        // Every text ends up embedded; none skipped.
        expect(results).toHaveLength(4);
        expect(results.every((r) => r !== undefined)).toBe(true);
        // Split all the way down to singles: 4 onBatch commits, one per text.
        expect(committed).toHaveLength(4);
        expect(committed.flatMap((c) => c.indices).sort()).toEqual([0, 1, 2, 3]);
        // Requests: size 4 (413) -> left half [0,1] size 2 (413) -> [0] then
        // [1] (200 each) -> right half [2,3] size 2 (413) -> [2] then [3]
        // (200 each). The left branch fully resolves before the right starts.
        expect(requestSizes).toEqual([4, 2, 1, 1, 2, 1, 1]);
      },
      async (_url, init) => {
        const body = JSON.parse(init?.body as string) as { input: string[] };
        requestSizes.push(body.input.length);
        if (body.input.length > 1) {
          return jsonResponse({ error: { message: "exceed_context_size_error: request too large" } }, 413);
        }
        return jsonResponse({ data: [{ embedding: [1, 0], index: 0 }] });
      },
    );
  });

  test("a size-1 batch that still fails as context-exceeded is skipped with the context-window-exceeded reason", async () => {
    await withMockedFetch(
      async () => {
        const embedder = new RemoteEmbedder({ endpoint: "http://localhost:1/v1", model: "test-model" });
        const skips: Array<{ index: number; reason: string }> = [];
        const results = await embedder.embedBatch(["a", "b"], undefined, (skip) => skips.push(skip));
        expect(results).toEqual([undefined, undefined]);
        expect(skips).toHaveLength(2);
        for (const skip of skips) expect(skip.reason).toBe("context-window-exceeded");
      },
      async () => jsonResponse({ error: { message: "context length exceeded" } }, 413),
    );
  });

  test("a non-context-size failure keeps skipping the whole batch, not splitting it (#874 behavior preserved)", async () => {
    let requestCount = 0;
    await withMockedFetch(
      async () => {
        const embedder = new RemoteEmbedder({ endpoint: "http://localhost:1/v1", model: "test-model" });
        const skips: Array<{ index: number; reason: string }> = [];
        const results = await embedder.embedBatch(["a", "b", "c"], undefined, (skip) => skips.push(skip));
        expect(results).toEqual([undefined, undefined, undefined]);
        expect(skips).toHaveLength(3);
        for (const skip of skips) expect(skip.reason).toBe("batch-request-failed");
      },
      async () => {
        requestCount++;
        return new Response("synthetic upstream failure", { status: 500 });
      },
    );
    // A single request for the whole batch — no splitting on a generic 500.
    expect(requestCount).toBe(1);
  });
});

describe("RemoteEmbedder.embedBatch: bounded concurrency", () => {
  test("dispatches at most `concurrency` requests at once and preserves result-to-index placement", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    // Each text gets a distinct, already-unit-length raw vector (a point on
    // the unit circle) so l2Normalize is a no-op and the returned vector
    // stays a reliable fingerprint of WHICH text the server answered for,
    // independent of completion order under concurrency.
    const texts = ["a", "bb", "ccc", "dddd", "eeeee", "ffffff"];
    const results = await withMockedFetch(
      async () => {
        const embedder = new RemoteEmbedder({
          endpoint: "http://localhost:1/v1",
          model: "test-model",
          batchSize: 1,
          concurrency: 3,
        });
        return embedder.embedBatch(texts);
      },
      async (_url, init) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const body = JSON.parse(init?.body as string) as { input: string[] };
        await new Promise((resolve) => setTimeout(resolve, 15));
        inFlight--;
        const data = body.input.map((text) => {
          const i = texts.indexOf(text);
          return { embedding: [Math.cos(i), Math.sin(i)], index: 0 };
        });
        return jsonResponse({ data });
      },
    );

    results.forEach((vec, i) => {
      expect(vec).toBeDefined();
      expect((vec as EmbeddingVector)[0]).toBeCloseTo(Math.cos(i), 5);
      expect((vec as EmbeddingVector)[1]).toBeCloseTo(Math.sin(i), 5);
    });
    expect(maxInFlight).toBeGreaterThan(1); // genuine overlap happened
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  test("caller abort propagates as a rejection even through the pool", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop embedding"));
    await withMockedFetch(
      async () => {
        const embedder = new RemoteEmbedder({ endpoint: "http://localhost:1/v1", model: "test-model" });
        await expect(embedder.embedBatch(["a", "b", "c"], controller.signal)).rejects.toThrow(/stop embedding/);
      },
      async () => jsonResponse({ data: [{ embedding: [1, 0], index: 0 }] }),
    );
  });
});

describe("RemoteEmbedder.embedBatch: onBatch commit callback", () => {
  test("fires once per provider batch (including an oversized pre-flight skip), not once for the whole call", async () => {
    await withMockedFetch(
      async () => {
        const embedder = new RemoteEmbedder({ endpoint: "http://localhost:1/v1", model: "test-model", maxTokens: 10 });
        const committed: Array<{ indices: number[]; embeddings: (EmbeddingVector | undefined)[] }> = [];
        const results = await embedder.embedBatch(
          ["small", "x".repeat(200) /* oversized */],
          undefined,
          undefined,
          (indices, embeddings) => committed.push({ indices, embeddings }),
        );
        expect(results[0]).toBeDefined();
        expect(results[1]).toBeUndefined();
        // One commit for the small doc's real request, one for the oversized skip.
        expect(committed).toHaveLength(2);
        const oversizedCommit = committed.find((c) => c.indices[0] === 1);
        expect(oversizedCommit?.embeddings).toEqual([undefined]);
      },
      async () => jsonResponse({ data: [{ embedding: [1, 0], index: 0 }] }),
    );
  });

  test("an explicit EmbeddingConnectionConfig with no concurrency override still commits every batch", async () => {
    const config: EmbeddingConnectionConfig = {
      endpoint: "http://localhost:1/v1",
      model: "test-model",
      batchSize: 2,
    };
    await withMockedFetch(
      async () => {
        const embedder = new RemoteEmbedder(config);
        const committed: number[][] = [];
        await embedder.embedBatch(["a", "b", "c", "d"], undefined, undefined, (indices) => committed.push(indices));
        expect(committed.flatMap((i) => i).sort()).toEqual([0, 1, 2, 3]);
        expect(committed.length).toBe(2); // batchSize 2 → two provider batches
      },
      async (_url, init) => {
        const body = JSON.parse(init?.body as string) as { input: string[] };
        const data = body.input.map((_t, i) => ({ embedding: [1, 0], index: i }));
        return jsonResponse({ data });
      },
    );
  });
});
