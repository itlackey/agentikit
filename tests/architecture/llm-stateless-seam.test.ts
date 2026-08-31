/**
 * Architecture seam test — `src/llm/*` is bounded and stateless.
 *
 * Locks v1 spec §9.7 (LLM/agent boundary) and §14.4 (statelessness
 * invariant). Issue #222.
 *
 * The test inspects the **module shape** of each public LLM helper,
 * not the source text. The contract under test is:
 *
 *   1. Each module's runtime exports are functions (or values that
 *      describe pure data, e.g. a model-name constant). They are not
 *      instances of stateful clients.
 *   2. The only module-level singleton across `src/llm/*` is the local
 *      embedder pipeline in `src/llm/embedder.ts`, which is documented
 *      as a stateless model handle and exposes `resetLocalEmbedder()`
 *      so tests can construct a fresh pipeline.
 *   3. The transport-level helpers (`chatCompletion`, `enhanceMetadata`,
 *      `compressMemoryToDerivedMemory`, and `resolveIndexPassExecution`) take the
 *      symbolic runner/config as a parameter — they do not read it from
 *      module state.
 *
 * Together these properties keep every in-tree LLM call to a single
 * bounded request/response cycle. Crossing this seam by adding a
 * conversation cache or a streaming session as a new module *export*
 * (a stateful instance, a Map, any non-function runtime value) will fail
 * this test — every check below inspects `Object.entries()` of each
 * module, i.e. its exports only.
 *
 * What this test can NOT catch: a hidden, non-exported module-level
 * variable. `src/llm/client.ts`'s `chatCompletionOverride` (a
 * module-private `let`, reachable only through the test-only
 * `_setChatCompletionForTests` setter, client.ts:260-275) never appears in
 * `Object.entries(client)` and would not trip any assertion here. Do not
 * read a green run of this suite as proof that no `src/llm/*` module holds
 * private mutable state — it pins the public export shape only.
 */
import { describe, expect, test } from "bun:test";

import { parseJsonResponse } from "../../src/core/parse";
import * as client from "../../src/llm/client";
import * as embedder from "../../src/llm/embedder";
import * as indexPasses from "../../src/llm/index-passes";
import * as memoryInfer from "../../src/llm/memory-infer";
import * as metadataEnhance from "../../src/llm/metadata-enhance";

describe("src/llm/* is bounded and stateless (v1 spec §9.7, §14.4)", () => {
  test("`client` exports are pure functions", () => {
    expect(typeof client.chatCompletion).toBe("function");
    expect(typeof client.isLlmAvailable).toBe("function");
    expect(typeof client.probeLlmReachable).toBe("function");
  });

  test("`client.chatCompletion` accepts the connection config as its first arg", () => {
    // Length-on-function reflects declared (non-rest) parameter count.
    // The contract is: the connection config is a parameter, not module
    // state. Two declared params: (config, messages); options is
    // optional and trailing.
    expect(client.chatCompletion.length).toBeGreaterThanOrEqual(2);
  });

  test("`client` does not export any non-function runtime value (no module-level client instance)", () => {
    for (const [name, value] of Object.entries(client)) {
      if (value === undefined) continue;
      expect(typeof value).toBe("function");
      // Eslint-style sanity: anything callable that exposes mutable
      // state at module scope would surface here as a non-function
      // export (an instance, a Map, etc).
      void name;
    }
  });

  test("`metadata-enhance` exports a single pure helper", () => {
    expect(typeof metadataEnhance.enhanceMetadata).toBe("function");
    expect(metadataEnhance.enhanceMetadata.length).toBeGreaterThanOrEqual(2);
    const runtimeExports = Object.entries(metadataEnhance).filter(([, v]) => v !== undefined);
    expect(runtimeExports.length).toBe(1);
  });

  test("`memory-infer` exports a single pure helper", () => {
    expect(typeof memoryInfer.compressMemoryToDerivedMemory).toBe("function");
    expect(memoryInfer.compressMemoryToDerivedMemory.length).toBeGreaterThanOrEqual(2);
    const runtimeExports = Object.entries(memoryInfer).filter(([, v]) => v !== undefined);
    expect(runtimeExports.length).toBe(1);
  });

  test("`index-passes` exports exactly the current execution resolver", () => {
    expect(typeof indexPasses.resolveIndexPassExecution).toBe("function");
    expect(indexPasses.resolveIndexPassExecution.length).toBeGreaterThanOrEqual(2);
    const runtimeExports = Object.entries(indexPasses).filter(([, v]) => v !== undefined);
    expect(runtimeExports.map(([name]) => name).sort()).toEqual(["resolveIndexPassExecution"]);
    for (const [, value] of runtimeExports) expect(typeof value).toBe("function");
  });

  test("`embedder` only exports functions and pure data constants", () => {
    // The embedder facade has more surface than the chat helpers because
    // it owns the local-pipeline cache. Every export must still be a
    // function or a pure data value (e.g. the default model name).
    const allowedNonFunctionNames = new Set(["DEFAULT_LOCAL_MODEL"]);
    for (const [name, value] of Object.entries(embedder)) {
      if (value === undefined) continue;
      if (allowedNonFunctionNames.has(name)) {
        // Pure-data constant. Must be a primitive (string/number/boolean).
        expect(["string", "number", "boolean"]).toContain(typeof value);
        continue;
      }
      expect(typeof value).toBe("function");
    }
  });

  test("`embedder.resetLocalEmbedder` exists so tests can rebuild the cached pipeline", () => {
    // The local embedder is a documented module-level singleton — it is
    // a stateless model handle, not a session. The reset hook is part
    // of the seam: it lets tests assert pipeline-construction logic
    // without relying on module-load order.
    expect(typeof embedder.resetLocalEmbedder).toBe("function");
    // resetLocalEmbedder is a no-arg function.
    expect(embedder.resetLocalEmbedder.length).toBe(0);
  });

  test("response parsing is referentially transparent", () => {
    // Two calls with the same input produce the same output. These are
    // pure, so this is not a deep test of statelessness — but it does
    // pin the seam: response parsing is not allowed to learn from
    // prior responses.
    const fenced = '```json\n{"a":1}\n```';
    expect(parseJsonResponse<{ a: number }>(fenced)).toEqual({ a: 1 });
    expect(parseJsonResponse<{ a: number }>(fenced)).toEqual({ a: 1 });
  });
});
