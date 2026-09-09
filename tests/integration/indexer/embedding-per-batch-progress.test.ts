// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #954, field-report follow-up — the output shape "implemented fully":
 *
 *  - one default-level line per provider batch, from the materializer's
 *    onBatch (not the embedder): `[embed] batch N/Total: D docs, T tokens →
 *    D stored (E s)` / `→ failed: <reason>` / `→ retrying after E s`;
 *  - the final line reports every outcome: the throughput sentence plus
 *    "N oversized skipped, M timed out, K failed."; the oversized list
 *    follows it, capped at 20 by default, all of them under --verbose.
 *
 * Drives `generateEmbeddingsForDb` against a real index.db (hence
 * tests/integration/, ORG-03..06) — most cases through a REAL
 * `RemoteEmbedder` (HTTP mocked via a real `Bun.serve` server) so the wiring
 * between remote.ts's outcome events and the materializer's rendering is
 * genuinely exercised end to end, not just at the fake-embedder seam.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AkmConfig } from "../../../src/core/config/config";
import { resetVerbose, setVerbose } from "../../../src/core/warn";
import { deriveEntryProvenance, deriveInstallations } from "../../../src/indexer/installations";
import { generateEmbeddingsForDb } from "../../../src/indexer/materialize-embeddings";
import { buildSearchText } from "../../../src/indexer/search/search-fields";
import type { Database } from "../../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

describe("generateEmbeddingsForDb: per-batch progress and final outcome line (#954)", () => {
  let storage: IsolatedAkmStorage;
  let server: ReturnType<typeof Bun.serve> | undefined;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });
  afterEach(() => {
    server?.stop(true);
    server = undefined;
    storage.cleanup();
    resetVerbose();
  });

  function seedEntries(db: Database, count: number): void {
    const installation = deriveInstallations([{ path: storage.stashDir, writable: true }])[0];
    const component = installation?.components[0];
    if (!installation || !component) throw new Error("failed to derive a test bundle installation");
    for (let i = 0; i < count; i++) {
      const name = `entry-${i}`;
      const entry = { name, type: "memories", filename: `${name}.md` };
      const provenance = deriveEntryProvenance(
        { bundleId: installation.id, componentId: component.id, adapterId: component.adapter },
        "memories",
        name,
      );
      upsertEntry(db, `${storage.stashDir}/memories/${name}.md`, entry, buildSearchText(entry), provenance);
    }
  }

  test("prints one line per provider batch naming its ordinal, doc/token counts, and 'stored' outcome", async () => {
    const db = openIndexDatabase();
    try {
      seedEntries(db, 6);
      server = Bun.serve({
        port: 0,
        async fetch(request) {
          const body = (await request.json()) as { input: string[] };
          const data = body.input.map((_t, i) => ({ embedding: [1, 0, 0], index: i }));
          return new Response(JSON.stringify({ data, model: "mock" }), {
            headers: { "Content-Type": "application/json" },
          });
        },
      });
      const config: AkmConfig = {
        semanticSearchMode: "auto",
        embedding: { endpoint: `http://localhost:${server.port}`, model: "mock", dimension: 3, batchSize: 2 },
      } as AkmConfig;

      const messages: string[] = [];
      const result = await generateEmbeddingsForDb(db, config, (e) => messages.push(e.message));
      expect(result.success).toBe(true);

      // 6 entries, batchSize 2 => 3 provider batches.
      const perBatchLines = messages.filter((m) => m.startsWith("[embed] batch "));
      expect(perBatchLines).toHaveLength(3);
      for (const [i, line] of perBatchLines.entries()) {
        expect(line).toMatch(
          new RegExp(`^\\[embed\\] batch ${i + 1}/3: 2 docs, [\\d,]+ tokens → 2 stored \\(\\d+\\.\\d+ s\\)$`),
        );
      }
    } finally {
      closeDatabase(db);
    }
  });

  test("a failed batch's line names the reason, without a stored count", async () => {
    const db = openIndexDatabase();
    try {
      seedEntries(db, 2);
      server = Bun.serve({
        port: 0,
        async fetch() {
          return new Response("boom", { status: 500 });
        },
      });
      const config: AkmConfig = {
        semanticSearchMode: "auto",
        embedding: { endpoint: `http://localhost:${server.port}`, model: "mock", dimension: 3, batchSize: 2 },
      } as AkmConfig;

      const messages: string[] = [];
      // A single failing batch of 2 documents never reaches the circuit
      // breaker (it counts consecutive SINGLE-document or network-error
      // failures; one 2-document network-error batch is exactly 1 of the 3
      // needed), so this stays a plain, reported failure.
      await generateEmbeddingsForDb(db, config, (e) => messages.push(e.message));

      const perBatchLine = messages.find((m) => m.startsWith("[embed] batch "));
      expect(perBatchLine).toBeDefined();
      expect(perBatchLine).toMatch(/^\[embed\] batch 1\/1: 2 docs, [\d,]+ tokens → failed: /);
      expect(perBatchLine).toContain("Embedding batch request failed (500)");
    } finally {
      closeDatabase(db);
    }
  });

  test("a timeout back-off prints a 'retrying' line before the retry, then the settled outcome", async () => {
    const db = openIndexDatabase();
    try {
      seedEntries(db, 1);
      let requestCount = 0;
      server = Bun.serve({
        port: 0,
        async fetch(request) {
          requestCount++;
          const body = (await request.json()) as { input: string[] };
          if (requestCount === 1) {
            // Outlives the client's timeout — the client gives up and moves
            // on well before this responds.
            await new Promise((resolve) => setTimeout(resolve, 900));
          }
          const data = body.input.map((_t, i) => ({ embedding: [1, 0, 0], index: i }));
          return new Response(JSON.stringify({ data, model: "mock" }), {
            headers: { "Content-Type": "application/json" },
          });
        },
      });
      const config: AkmConfig = {
        semanticSearchMode: "auto",
        embedding: { endpoint: `http://localhost:${server.port}`, model: "mock", dimension: 3, timeoutMs: 300 },
      } as AkmConfig;

      const messages: string[] = [];
      const result = await generateEmbeddingsForDb(db, config, (e) => messages.push(e.message));
      expect(result.success).toBe(true);

      const retryLine = messages.find((m) => m.startsWith("[embed] batch ") && m.includes("retrying"));
      expect(retryLine).toBeDefined();
      expect(retryLine).toMatch(/^\[embed\] batch 1\/1: 1 docs, [\d,]+ tokens → retrying after \d+\.\d+ s$/);

      const settledLine = messages.find((m) => m.startsWith("[embed] batch ") && m.includes("stored"));
      expect(settledLine).toBeDefined();

      // The retry notice comes BEFORE the eventual settled outcome.
      expect(messages.indexOf(retryLine as string)).toBeLessThan(messages.indexOf(settledLine as string));
    } finally {
      closeDatabase(db);
    }
  }, 15_000);

  test("the final line reports oversized/timed-out/failed counts, and lists the first 20 oversized documents by default", async () => {
    const db = openIndexDatabase();
    try {
      const count = 25;
      seedEntries(db, count);
      // Every document becomes "oversized" at the REQUEST level: maxTokens
      // (the per-request budget) is set far below maxInputTokens (the
      // per-document truncation cap), so capping never shrinks a document
      // enough to fit any request — no HTTP request is ever made, and this
      // stays a fast, network-free test for the pagination behavior.
      const config: AkmConfig = {
        semanticSearchMode: "auto",
        embedding: { endpoint: "http://localhost:1", model: "mock", dimension: 3, maxTokens: 1 },
      } as AkmConfig;

      const messages: string[] = [];
      const result = await generateEmbeddingsForDb(db, config, (e) => messages.push(e.message));
      // Every entry is oversized and nothing at all is stored — a total
      // failure, per the existing "storedCount === 0" rule; the outcome
      // lines were still emitted before that verdict.
      expect(result.success).toBe(false);

      const finalLine = messages.find((m) => m.startsWith("Stored "));
      expect(finalLine).toBeDefined();
      expect(finalLine).toContain(`${count} oversized skipped, 0 timed out, 0 failed.`);

      const oversizedList = messages.find((m) => m.startsWith("[embed] oversized documents skipped:"));
      expect(oversizedList).toBeDefined();
      const lines = (oversizedList as string).split("\n").filter((l) => l.startsWith("  - "));
      expect(lines).toHaveLength(20);
      expect(oversizedList).toContain(`...and ${count - 20} more`);
    } finally {
      closeDatabase(db);
    }
  });

  test("--verbose lists every oversized document, not just the first 20", async () => {
    const db = openIndexDatabase();
    try {
      const count = 25;
      seedEntries(db, count);
      setVerbose(true);
      const config: AkmConfig = {
        semanticSearchMode: "auto",
        embedding: { endpoint: "http://localhost:1", model: "mock", dimension: 3, maxTokens: 1 },
      } as AkmConfig;

      const messages: string[] = [];
      await generateEmbeddingsForDb(db, config, (e) => messages.push(e.message));

      const oversizedList = messages.find((m) => m.startsWith("[embed] oversized documents skipped:"));
      expect(oversizedList).toBeDefined();
      const lines = (oversizedList as string).split("\n").filter((l) => l.startsWith("  - "));
      expect(lines).toHaveLength(count);
      expect(oversizedList).not.toContain("more");
    } finally {
      closeDatabase(db);
    }
  });
});
