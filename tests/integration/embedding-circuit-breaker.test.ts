// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #9541 decision 7: a slow or dead embedding provider used to grind through
 * every remaining batch, one (now-configurable, previously fixed 30s)
 * timeout at a time, for however many batches the run had — hours, on the
 * reporting install's 24,041-entry stash. After 3 consecutive
 * `batch-request-failed` batches (never a `context-window-exceeded` one —
 * that proves the provider IS reachable), the embedding phase stops
 * dispatching further requests instead.
 *
 * A real Bun.serve server whose fetch handler never resolves removes any
 * timing race between the client's timeout and a server that merely
 * responds late — the client's own `embedding.timeoutMs` is the only way the
 * request ever settles (see tests/integration/reflect-propose-http-timeout.test.ts
 * for the same pattern). This opens a real index.db via `akmIndex`, so it is
 * an integration test per the ORG-03..06 classification rule.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../src/core/config/config";
import { akmIndex } from "../../src/indexer/indexer";
import { clearEmbeddingCache } from "../../src/llm/embedders/cache";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  clearEmbeddingCache();
});
afterEach(() => {
  server?.stop(true);
  server = undefined;
  storage.cleanup();
  resetConfigCache();
});

function writeMemory(name: string): void {
  fs.writeFileSync(
    path.join(storage.stashDir, "memories", name),
    `---\ndescription: ${name}\n---\n\nContent for ${name}.\n`,
    "utf8",
  );
}

test("stops after exactly 3 consecutive transport failures against a dead endpoint and reports it, with endpoint guidance", async () => {
  let requestCount = 0;
  server = Bun.serve({
    port: 0,
    fetch() {
      requestCount++;
      // Never resolves: the client's own embedding.timeoutMs is the only
      // way each request can ever settle (see module docstring).
      return new Promise<Response>(() => {});
    },
  });

  for (let i = 0; i < 5; i++) writeMemory(`entry-${i}.md`);

  writeSandboxConfig({
    semanticSearchMode: "auto",
    bundles: { stash: { path: storage.stashDir, writable: true } },
    defaultBundle: "stash",
    embedding: {
      endpoint: `http://localhost:${server.port}`,
      model: "test-model",
      dimension: 4,
      batchSize: 1,
      timeoutMs: 500,
    },
  });
  resetConfigCache();

  const result = await akmIndex({ stashDir: storage.stashDir, full: true });

  // Circuit breaker trips after exactly 3 requests — the other 2 documents'
  // batches are never dispatched at all.
  expect(requestCount).toBe(3);
  expect(result.verification.ok).toBe(false);
  expect(result.verification.semanticStatus).toBe("blocked");
  expect(result.verification.message).toContain("embedding provider failed 3 consecutive batches");
  expect(result.verification.message).toContain("stopped after 0 embeddings were stored");
  // verifyIndexState's guidance for a remote provider names the endpoint as
  // the thing to check.
  expect(result.verification.guidance).toContain("embedding endpoint");
});
