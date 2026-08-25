// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Canonical schema boundary: a pre-existing index.db that carries an older
 * generation marker is discarded on the next open. index.db is regenerable;
 * live readers and writers never carry compatibility SQL for stale shapes.
 *
 * (Chunk-8 WI-8.3: usage_events — the original non-regenerable payload this
 * test also protected — moved to state.db, so index.db no longer carries it.)
 */

import { Database as BunDatabase } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveEntryProvenance } from "../../../src/indexer/installations";
import { ensureUsageEventsSchema } from "../../../src/indexer/usage/usage-events";
import type { Database } from "../../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import {
  getEntryCount,
  relinkUsageEvents,
  upsertEntry,
} from "../../../src/storage/repositories/index-entries-repository";
import { getMeta, setMeta } from "../../../src/storage/repositories/index-meta-repository";
import { DB_VERSION } from "../../../src/storage/repositories/index-schema";

describe("index.db canonical generation boundary", () => {
  test("an older DB_VERSION marker discards derived entries on reopen", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-noupgrade-"));
    const dbPath = path.join(tmpDir, "index.db");
    try {
      let db = openIndexDatabase(dbPath, { embeddingDim: 384 });
      upsertEntry(
        db,
        "/s/memories/a.md",
        { name: "a", type: "memory" },
        "a",
        deriveEntryProvenance({ bundleId: "s", componentId: "s", adapterId: "akm" }, "memory", "a"),
      );
      // Stamp an older generation than the running binary.
      setMeta(db, "version", "1");
      expect(getEntryCount(db)).toBe(1);
      closeDatabase(db);

      // Reopen: discard the incompatible derived generation and install the
      // current empty schema; the next index run repopulates it from sources.
      db = openIndexDatabase(dbPath, { embeddingDim: 384 });
      expect(getEntryCount(db)).toBe(0);
      expect(getMeta(db, "version")).toBe(String(DB_VERSION));
      closeDatabase(db);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("v20 rebuild relinks a durable event when reversed insertion reuses its old numeric id", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-relink-upgrade-"));
    const dbPath = path.join(tmpDir, "index.db");
    const stateDb = new BunDatabase(":memory:") as unknown as Database;
    let db: ReturnType<typeof openIndexDatabase> | undefined;
    try {
      ensureUsageEventsSchema(stateDb);
      db = openIndexDatabase(dbPath);
      const oldAId = upsertEntry(
        db,
        "/s/memories/a.md",
        { name: "a", type: "memory" },
        "a",
        deriveEntryProvenance({ bundleId: "s", componentId: "s", adapterId: "akm" }, "memory", "a"),
      );
      stateDb
        .prepare(
          "INSERT INTO usage_events (event_type, entry_id, entry_ref, source) VALUES ('show', ?, 's//memories/a', 'user')",
        )
        .run(oldAId);
      setMeta(db, "version", String(DB_VERSION - 1));
      closeDatabase(db);
      db = undefined;

      db = openIndexDatabase(dbPath);
      const newBId = upsertEntry(
        db,
        "/s/memories/b.md",
        { name: "b", type: "memory" },
        "b",
        deriveEntryProvenance({ bundleId: "s", componentId: "s", adapterId: "akm" }, "memory", "b"),
      );
      const newAId = upsertEntry(
        db,
        "/s/memories/a.md",
        { name: "a", type: "memory" },
        "a",
        deriveEntryProvenance({ bundleId: "s", componentId: "s", adapterId: "akm" }, "memory", "a"),
      );
      relinkUsageEvents(db, stateDb);
      const linked = stateDb.prepare("SELECT entry_id AS entryId FROM usage_events").get() as { entryId: number };

      expect({ oldAId, newBId, newAId, linkedEntryId: linked.entryId }).toEqual({
        oldAId: 1,
        newBId: 1,
        newAId: 2,
        linkedEntryId: 2,
      });
    } finally {
      if (db) closeDatabase(db);
      stateDb.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
