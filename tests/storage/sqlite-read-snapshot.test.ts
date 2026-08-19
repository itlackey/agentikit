// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { openSqliteReadSnapshot } from "../../src/storage/sqlite-read-snapshot";
import { makeSandboxDir } from "../_helpers/sandbox";

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
});
