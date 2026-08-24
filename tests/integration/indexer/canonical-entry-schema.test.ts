// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { DB_VERSION } from "../../../src/storage/repositories/index-schema";

const CURRENT_ENTRY_COLUMNS = [
  "id",
  "item_ref",
  "bundle_id",
  "component_id",
  "concept_id",
  "adapter_id",
  "type",
  "file_path",
  "content_hash",
  "document_json",
  "search_text",
  "derived_from",
] as const;

function withTempIndex(run: (dbPath: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-current-index-schema-"));
  try {
    run(path.join(root, "index.db"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function entryColumns(dbPath: string): string[] {
  const db = openDatabase(dbPath, { readonly: true, create: false });
  try {
    return (db.prepare("PRAGMA table_info(entries)").all() as Array<{ name: string }>).map((row) => row.name);
  } finally {
    db.close();
  }
}

describe("canonical derived-index entry schema", () => {
  test("a fresh index has one current entries shape and no transitional columns", () => {
    withTempIndex((dbPath) => {
      const db = openIndexDatabase(dbPath);
      closeDatabase(db);

      expect(entryColumns(dbPath)).toEqual(CURRENT_ENTRY_COLUMNS);
    });
  });

  test("opening a pre-current index rebuilds its derived entry generation", () => {
    withTempIndex((dbPath) => {
      const legacy = openDatabase(dbPath);
      legacy.exec(`
        CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO index_meta (key, value) VALUES ('version', '${DB_VERSION - 1}');
        CREATE TABLE entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          entry_key TEXT NOT NULL UNIQUE,
          dir_path TEXT NOT NULL,
          file_path TEXT NOT NULL,
          stash_dir TEXT NOT NULL,
          entry_json TEXT NOT NULL,
          search_text TEXT NOT NULL,
          entry_type TEXT NOT NULL
        );
        INSERT INTO entries
          (entry_key, dir_path, file_path, stash_dir, entry_json, search_text, entry_type)
        VALUES
          ('/old:memory:stale', '/old/memories', '/old/memories/stale.md', '/old',
           '{"type":"memory","name":"stale"}', 'stale', 'memory');
      `);
      legacy.close();

      const current = openIndexDatabase(dbPath);
      try {
        const count = current.prepare("SELECT COUNT(*) AS count FROM entries").get() as { count: number };
        expect(count.count).toBe(0);
        expect(
          current.prepare("SELECT value FROM index_meta WHERE key = 'version'").get() as { value: string },
        ).toEqual({ value: String(DB_VERSION) });
      } finally {
        closeDatabase(current);
      }

      expect(entryColumns(dbPath)).toEqual(CURRENT_ENTRY_COLUMNS);
    });
  });
});
