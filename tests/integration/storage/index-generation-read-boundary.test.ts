// This integration suite opens real index.db files to pin the read-generation boundary (#934).

import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { ConfigError } from "../../../src/core/errors";
import {
  closeDatabase,
  openExistingDatabase,
  openIndexDatabase,
  openReadonlyExistingDatabase,
} from "../../../src/storage/repositories/index-connection";
import { CANONICAL_INDEX_DB_VERSION } from "../../../src/storage/repositories/index-entry-schema";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

function stampGeneration(dbPath: string, version: string): void {
  const db = openIndexDatabase(dbPath);
  try {
    db.prepare("UPDATE index_meta SET value = ? WHERE key = 'version'").run(version);
  } finally {
    closeDatabase(db);
  }
}

function expectIncompatibleOpen(open: () => unknown, expectedAction: RegExp): void {
  let raised: unknown;
  try {
    open();
  } catch (error) {
    raised = error;
  }
  expect(raised).toBeInstanceOf(ConfigError);
  expect((raised as ConfigError).code).toBe("INDEX_SCHEMA_INCOMPATIBLE");
  expect((raised as Error).message).toMatch(expectedAction);
  // This must be the single actionable boundary diagnostic, not a later
  // SQLite failure leaked by a caller that received an incompatible handle.
  expect((raised as Error).message).not.toMatch(/no such table|SQLITE/i);
}

describe("incompatible index readers (#934)", () => {
  let storage: IsolatedAkmStorage;
  afterEach(() => storage?.cleanup());

  test("preserves the absent-index result for the read-only opener", () => {
    storage = withIsolatedAkmStorage();
    expect(openReadonlyExistingDatabase(path.join(storage.root, "absent.db"))).toBeUndefined();
  });

  test("rejects an older generation before either reader returns a queryable handle", () => {
    storage = withIsolatedAkmStorage();
    const dbPath = path.join(storage.root, "index.db");
    stampGeneration(dbPath, String(CANONICAL_INDEX_DB_VERSION - 1));

    expectIncompatibleOpen(() => openExistingDatabase(dbPath), /Run 'akm index'/);
    expectIncompatibleOpen(() => openReadonlyExistingDatabase(dbPath), /Run 'akm index'/);
  });

  test("rejects a newer generation with an upgrade action, never an older-binary rebuild action", () => {
    storage = withIsolatedAkmStorage();
    const dbPath = path.join(storage.root, "index.db");
    stampGeneration(dbPath, String(CANONICAL_INDEX_DB_VERSION + 1));

    expectIncompatibleOpen(() => openExistingDatabase(dbPath), /upgrade akm/i);
    expectIncompatibleOpen(() => openReadonlyExistingDatabase(dbPath), /upgrade akm/i);
    expectIncompatibleOpen(() => openIndexDatabase(dbPath), /upgrade akm/i);
    try {
      openExistingDatabase(dbPath);
    } catch (error) {
      expect((error as Error).message).not.toMatch(/Run 'akm index'/);
    }
  });

  test("classifies a missing generation marker with the older/unknown rebuild action", () => {
    storage = withIsolatedAkmStorage();
    const dbPath = path.join(storage.root, "index.db");
    const db = openIndexDatabase(dbPath);
    try {
      db.exec("DELETE FROM index_meta WHERE key = 'version'");
    } finally {
      closeDatabase(db);
    }

    expectIncompatibleOpen(() => openExistingDatabase(dbPath), /Run 'akm index'/);
  });
});
