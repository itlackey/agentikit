// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { openReadonlyExistingDatabase } from "../../../src/storage/repositories/index-connection";
import { openSqliteReadSnapshot, SqliteReadSnapshotUnavailableError } from "../../../src/storage/sqlite-read-snapshot";
import { makeSandboxDir } from "../../_helpers/sandbox";

describe("SQLite read snapshot lifecycle", () => {
  test("normal close is idempotent and removes its process-exit cleanup listener", () => {
    const fixture = makeSandboxDir("akm-sqlite-read-lifecycle");
    const sourcePath = path.join(fixture.dir, "source.db");
    const source = new Database(sourcePath);
    source.exec("CREATE TABLE held(value TEXT); INSERT INTO held VALUES ('preserve')");
    source.close();

    const listenersBefore = process.listenerCount("exit");
    const snapshot = openSqliteReadSnapshot(sourcePath);
    try {
      expect(snapshot).toBeDefined();
      expect(process.listenerCount("exit")).toBe(listenersBefore + 1);
      snapshot?.close();
      expect(process.listenerCount("exit")).toBe(listenersBefore);
      expect(() => snapshot?.close()).not.toThrow();
    } finally {
      snapshot?.close();
      fixture.cleanup();
    }
  });

  test("a permanently held rollback journal retries with backoff before failing closed", () => {
    const fixture = makeSandboxDir("akm-sqlite-read-held-journal");
    const sourcePath = path.join(fixture.dir, "source.db");
    const holder = new Database(sourcePath);
    try {
      holder.exec("CREATE TABLE held(value TEXT)");
      holder.exec("BEGIN IMMEDIATE");
      holder.exec("INSERT INTO held VALUES ('uncommitted')");
      expect(fs.existsSync(`${sourcePath}-journal`)).toBe(true);

      const startedAt = performance.now();
      let caught: unknown;
      try {
        openSqliteReadSnapshot(sourcePath);
      } catch (error) {
        caught = error;
      }
      const elapsedMs = performance.now() - startedAt;

      expect(caught).toBeInstanceOf(SqliteReadSnapshotUnavailableError);
      // Previously this failed instantly on the first observation (3
      // no-backoff attempts). The retry budget now spends real wall-clock
      // time backing off before giving up — this is the regression guard for
      // that budget, not a promise on its exact duration.
      expect(elapsedMs).toBeGreaterThanOrEqual(300);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
      fixture.cleanup();
    }
  });

  test("openReadonlyExistingDatabase falls back to a plain read-only open when the snapshot is unavailable", () => {
    const fixture = makeSandboxDir("akm-sqlite-read-fallback");
    const sourcePath = path.join(fixture.dir, "source.db");
    const holder = new Database(sourcePath);
    try {
      holder.exec("CREATE TABLE held(value TEXT)");
      holder.exec("BEGIN IMMEDIATE");
      holder.exec("INSERT INTO held VALUES ('uncommitted')");
      expect(fs.existsSync(`${sourcePath}-journal`)).toBe(true);

      // A hot journal makes the isolated snapshot unavailable. The opener
      // must not propagate that as a hard failure — it degrades to the plain
      // read-only path (index-connection.ts) instead of aborting the read.
      const db = openReadonlyExistingDatabase(sourcePath, { isolatedSnapshot: true });
      expect(db).toBeDefined();
      db?.close();
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
      fixture.cleanup();
    }
  });
});
