// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #954: per-provider-batch commit, a fixed bounded in-flight window (1 for a
 * loopback endpoint, 2 for a remote one — no config override, per the
 * 2026-09-09 field-review addendum to the brief), and context-size
 * split-and-retry for RemoteEmbedder.embedBatch.
 *
 * All network I/O here is mocked via `withMockedFetch` (no real socket
 * opened), so this stays a pure unit test rather than an integration test —
 * see AGENTS.md's tests/integration/ classification rule. The real-server
 * variants of the concurrency and context-split behavior live in
 * tests/integration/embedder.test.ts.
 */

import { describe, expect, test } from "bun:test";
import type { EmbeddingConnectionConfig } from "../src/core/config/config";
import { EmbeddingConnectionConfigSchema } from "../src/core/config/schema/embedding";
import { _setWarnSinkForTests } from "../src/core/warn";
import {
  DEFAULT_EMBEDDING_TIMEOUT_MS,
  isContextExceededResponse,
  RemoteEmbedder,
  resolveEmbeddingConcurrency,
  resolveEmbeddingTimeoutMs,
} from "../src/llm/embedders/remote";
import type { EmbeddingVector } from "../src/llm/embedders/types";
import { withMockedFetch } from "./_helpers/sandbox";

/** A fetch mock that hangs until its request's abort signal fires, then rejects like real `fetch` does. */
function hungFetch(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
  });
}

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

  test("recognises llama.cpp's physical-batch rejection (#9541 decision 8)", () => {
    // The exact message llama.cpp returns (HTTP 500) when a batch exceeds
    // its configured physical batch size.
    expect(isContextExceededResponse(500, "input is too large to process. increase the physical batch size")).toBe(
      true,
    );
    expect(isContextExceededResponse(500, "ubatch size exceeded")).toBe(true);
    expect(isContextExceededResponse(500, "INPUT IS TOO LARGE TO PROCESS")).toBe(true);
  });
});

describe("RemoteEmbedder.embedBatch: failed-batch visibility (#9541 decision 5)", () => {
  test("a failed provider batch logs at warn (default) level, naming the batch size and reason", async () => {
    const calls: Array<{ level: string; message: string }> = [];
    _setWarnSinkForTests((level, args) => {
      calls.push({ level, message: args.map(String).join(" ") });
    });
    try {
      await withMockedFetch(
        async () => {
          const embedder = new RemoteEmbedder({ endpoint: "http://localhost:9", model: "test" });
          await embedder.embedBatch(["doc one", "doc two"]);
        },
        () => new Response("synthetic upstream failure", { status: 500 }),
      );
      const warnCall = calls.find((c) => c.message.includes("document(s) failed and was skipped"));
      expect(warnCall?.level).toBe("warn");
      expect(warnCall?.message).toContain("batch of 2 document(s) failed and was skipped");
    } finally {
      _setWarnSinkForTests(undefined);
    }
  });
});

describe("resolveEmbeddingTimeoutMs (#9541)", () => {
  test("defaults to 120s when embedding.timeoutMs is unset", () => {
    expect(resolveEmbeddingTimeoutMs({})).toBe(DEFAULT_EMBEDDING_TIMEOUT_MS);
    expect(DEFAULT_EMBEDDING_TIMEOUT_MS).toBe(120_000);
  });

  test("uses the configured value when set", () => {
    expect(resolveEmbeddingTimeoutMs({ timeoutMs: 5_000 })).toBe(5_000);
  });

  test("the configured value reaches fetchWithTimeout for embed()", async () => {
    await withMockedFetch(async () => {
      const embedder = new RemoteEmbedder({ endpoint: "http://localhost:9", model: "test", timeoutMs: 30 });
      await expect(embedder.embed("hello")).rejects.toThrow(/timed out after 30ms/);
    }, hungFetch);
  });

  test("the configured value reaches fetchWithTimeout for embedBatch()/requestBatch()", async () => {
    await withMockedFetch(async () => {
      const embedder = new RemoteEmbedder({ endpoint: "http://localhost:9", model: "test", timeoutMs: 30 });
      const skips: Array<{ message: string }> = [];
      const results = await embedder.embedBatch(["doc one"], undefined, (skip) => skips.push(skip));
      expect(results).toEqual([undefined]);
      expect(skips[0]?.message).toContain("timed out after 30ms");
    }, hungFetch);
  });
});

describe("resolveEmbeddingConcurrency", () => {
  test("defaults to 1 for a loopback endpoint when embedding.concurrency is unset (#9541)", () => {
    expect(resolveEmbeddingConcurrency({ endpoint: "http://localhost:8080" })).toBe(1);
    expect(resolveEmbeddingConcurrency({ endpoint: "http://127.0.0.1:8080" })).toBe(1);
  });

  test("defaults to 1 when no endpoint is configured (fails safe as local)", () => {
    expect(resolveEmbeddingConcurrency({})).toBe(1);
  });

  test("defaults to 2 for a remote endpoint", () => {
    expect(resolveEmbeddingConcurrency({ endpoint: "https://api.example.com/v1" })).toBe(2);
  });

  test("embedding.concurrency overrides the default in either direction (#9541 decision 4)", () => {
    expect(resolveEmbeddingConcurrency({ endpoint: "http://localhost:8080", concurrency: 8 })).toBe(8);
    expect(resolveEmbeddingConcurrency({ endpoint: "https://api.example.com/v1", concurrency: 1 })).toBe(1);
  });
});

describe("EmbeddingConnectionConfigSchema: embedding.concurrency bounds (#9541 decision 4)", () => {
  test("accepts 1 and 16", () => {
    expect(EmbeddingConnectionConfigSchema.safeParse({ concurrency: 1 }).success).toBe(true);
    expect(EmbeddingConnectionConfigSchema.safeParse({ concurrency: 16 }).success).toBe(true);
  });

  test("rejects 0 and 17", () => {
    expect(EmbeddingConnectionConfigSchema.safeParse({ concurrency: 0 }).success).toBe(false);
    expect(EmbeddingConnectionConfigSchema.safeParse({ concurrency: 17 }).success).toBe(false);
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

describe("RemoteEmbedder.embedBatch: bounded concurrency (fixed 1 loopback / 2 remote, no config override)", () => {
  test("a remote endpoint dispatches at most 2 requests at once and preserves result-to-index placement", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    // Each text gets a distinct, already-unit-length raw vector (a point on
    // the unit circle) so l2Normalize is a no-op and the returned vector
    // stays a reliable fingerprint of WHICH text the server answered for,
    // independent of completion order under concurrency. Fetch is fully
    // mocked, so this non-loopback hostname never actually resolves — it
    // only needs to classify as "remote" for resolveEmbeddingConcurrency.
    const texts = ["a", "bb", "ccc", "dddd", "eeeee", "ffffff"];
    const results = await withMockedFetch(
      async () => {
        const embedder = new RemoteEmbedder({
          endpoint: "https://embed.example.com/v1",
          model: "test-model",
          batchSize: 1,
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
    expect(maxInFlight).toBe(2); // fixed remote width — genuine overlap happened, never more than 2
  });

  test("a loopback endpoint never overlaps requests (fixed width 1)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await withMockedFetch(
      async () => {
        const embedder = new RemoteEmbedder({
          endpoint: "http://localhost:1/v1",
          model: "test-model",
          batchSize: 1,
        });
        return embedder.embedBatch(["a", "b", "c", "d"]);
      },
      async (_url, init) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const body = JSON.parse(init?.body as string) as { input: string[] };
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight--;
        const data = body.input.map(() => ({ embedding: [1, 0], index: 0 }));
        return jsonResponse({ data });
      },
    );
    expect(maxInFlight).toBe(1);
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

  test("a throw from onBatch propagates out of embedBatch, not swallowed or misreported as a provider failure", async () => {
    // Regression for a round-1 review finding: onBatch used to be invoked
    // from inside the same try/catch that classifies requestBatch's own
    // provider/network failures, so a persistence failure inside the
    // caller's onBatch (e.g. materialize-embeddings.ts's db.transaction()
    // throwing on a real competing-process SQLITE_BUSY lock) was
    // misclassified as a fabricated "batch-request-failed" skip and then
    // silently absorbed by concurrentMap's per-item catch — no error ever
    // reached the caller.
    await withMockedFetch(
      async () => {
        const embedder = new RemoteEmbedder({ endpoint: "http://localhost:1/v1", model: "test-model" });
        const skips: Array<{ reason: string }> = [];
        const persistError = new Error("simulated SQLITE_BUSY from a competing process");
        await expect(
          embedder.embedBatch(
            ["solo"],
            undefined,
            (skip) => skips.push(skip),
            () => {
              throw persistError;
            },
          ),
        ).rejects.toThrow(/simulated SQLITE_BUSY/);
        // The embedding request itself succeeded — onBatch's own failure
        // must never be reported as if the batch request had failed.
        expect(skips).toHaveLength(0);
      },
      async () => jsonResponse({ data: [{ embedding: [1, 0], index: 0 }] }),
    );
  });

  test("every provider batch commits, not just the last one", async () => {
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

describe("RemoteEmbedder.embedBatch: stops dispatching after the first onBatch failure (#954 gap fix)", () => {
  test("no further provider request is made once onBatch throws, with several batches queued", async () => {
    let requestCount = 0;
    let onBatchCalls = 0;
    const persistError = new Error("simulated persistence failure");
    await withMockedFetch(
      async () => {
        // Loopback => fixed concurrency 1, so only ONE provider batch is ever
        // in flight — a completely deterministic way to prove the pool never
        // claims a next batch once dispatch has stopped, with no reliance on
        // fetch resolution order under concurrency 2.
        const embedder = new RemoteEmbedder({
          endpoint: "http://localhost:1/v1",
          model: "test-model",
          batchSize: 1,
        });
        await expect(
          embedder.embedBatch(["a", "b", "c", "d"], undefined, undefined, () => {
            onBatchCalls++;
            throw persistError;
          }),
        ).rejects.toThrow(/simulated persistence failure/);
      },
      async () => {
        requestCount++;
        return jsonResponse({ data: [{ embedding: [1, 0], index: 0 }] });
      },
    );
    // 4 texts, batchSize 1 => 4 possible provider batches queued. Only the
    // very first is ever requested; the pool must not claim (and therefore
    // never dispatches HTTP requests for) batches 2-4 once onBatch fails.
    expect(requestCount).toBe(1);
    expect(onBatchCalls).toBe(1);
  });
});

describe("RemoteEmbedder.embedBatch: surfaces the response model id (#955)", () => {
  test("passes the response body's `model` field to onBatch as its 3rd argument", async () => {
    await withMockedFetch(
      async () => {
        const embedder = new RemoteEmbedder({ endpoint: "http://localhost:1/v1", model: "configured-name" });
        const models: (string | undefined)[] = [];
        await embedder.embedBatch(["a", "b"], undefined, undefined, (_indices, _embeddings, model) =>
          models.push(model),
        );
        // A gateway can answer with a different id than the configured
        // string (e.g. a bare model id behind a provider/model prefix) —
        // the embedding-fingerprint canary (#955) relies on seeing that
        // reported id, not the request's own `model` field echoed back.
        expect(models).toEqual(["server-reported-id"]);
      },
      async () =>
        jsonResponse({
          model: "server-reported-id",
          data: [
            { embedding: [1, 0], index: 0 },
            { embedding: [0, 1], index: 1 },
          ],
        }),
    );
  });

  test("passes undefined to onBatch when the provider's response omits `model`", async () => {
    await withMockedFetch(
      async () => {
        const embedder = new RemoteEmbedder({ endpoint: "http://localhost:1/v1", model: "configured-name" });
        const models: (string | undefined)[] = [];
        await embedder.embedBatch(["a"], undefined, undefined, (_indices, _embeddings, model) => models.push(model));
        expect(models).toEqual([undefined]);
      },
      async () => jsonResponse({ data: [{ embedding: [1, 0], index: 0 }] }),
    );
  });

  test("an oversized pre-flight skip commits with no model (no request was ever made)", async () => {
    await withMockedFetch(
      async () => {
        const embedder = new RemoteEmbedder({ endpoint: "http://localhost:1/v1", model: "test-model", maxTokens: 1 });
        const models: (string | undefined)[] = [];
        await embedder.embedBatch(["x".repeat(200)], undefined, undefined, (_indices, _embeddings, model) =>
          models.push(model),
        );
        expect(models).toEqual([undefined]);
      },
      async () => jsonResponse({ model: "should-not-be-called", data: [] }),
    );
  });
});
