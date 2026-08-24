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

const CURRENT_ENTRY_COLUMNS: string[] = [
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
];

const CURRENT_ENTRY_COLUMN_CONTRACT = [
  { name: "id", type: "INTEGER", notnull: 0, pk: 1 },
  { name: "item_ref", type: "TEXT", notnull: 1, pk: 0 },
  { name: "bundle_id", type: "TEXT", notnull: 1, pk: 0 },
  { name: "component_id", type: "TEXT", notnull: 1, pk: 0 },
  { name: "concept_id", type: "TEXT", notnull: 1, pk: 0 },
  { name: "adapter_id", type: "TEXT", notnull: 1, pk: 0 },
  { name: "type", type: "TEXT", notnull: 1, pk: 0 },
  { name: "file_path", type: "TEXT", notnull: 1, pk: 0 },
  { name: "content_hash", type: "TEXT", notnull: 0, pk: 0 },
  { name: "document_json", type: "TEXT", notnull: 1, pk: 0 },
  { name: "search_text", type: "TEXT", notnull: 1, pk: 0 },
  { name: "derived_from", type: "TEXT", notnull: 0, pk: 0 },
];

const CANONICAL_ENTRIES_DDL = `
  CREATE TABLE entries (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    item_ref      TEXT NOT NULL UNIQUE,
    bundle_id     TEXT NOT NULL,
    component_id  TEXT NOT NULL,
    concept_id    TEXT NOT NULL,
    adapter_id    TEXT NOT NULL,
    type          TEXT NOT NULL,
    file_path     TEXT NOT NULL,
    content_hash  TEXT,
    document_json TEXT NOT NULL,
    search_text   TEXT NOT NULL,
    derived_from  TEXT
  );
`;

const CANONICAL_ENTRY_INDEXES_DDL = `
  CREATE INDEX idx_entries_bundle ON entries(bundle_id);
  CREATE INDEX idx_entries_type ON entries(type);
  CREATE INDEX idx_entries_file_path ON entries(file_path);
  CREATE INDEX idx_entries_derived_from ON entries(derived_from);
`;

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

function seedStampedEntriesSchema(dbPath: string, entriesDdl: string, indexesDdl = ""): void {
  const db = openDatabase(dbPath);
  try {
    db.exec(`
      CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO index_meta (key, value) VALUES ('version', '${DB_VERSION}');
      ${entriesDdl}
      ${indexesDdl}
    `);
    db.prepare(
      `INSERT INTO entries
         (id, item_ref, bundle_id, component_id, concept_id, adapter_id, type,
          file_path, content_hash, document_json, search_text, derived_from)
       VALUES (1, 'stash//memories/hostile', 'stash', 'stash', 'memories/hostile',
               'akm', 'memory', '/tmp/hostile.md', NULL,
               '{"name":"hostile","type":"memory"}', 'hostile', NULL)`,
    ).run();
  } finally {
    db.close();
  }
}

function expectCanonicalGenerationRebuilt(dbPath: string): void {
  const db = openIndexDatabase(dbPath);
  try {
    expect((db.prepare("SELECT COUNT(*) AS count FROM entries").get() as { count: number }).count).toBe(0);
    const columns = db.prepare("PRAGMA table_info(entries)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    expect(columns.map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }))).toEqual(
      CURRENT_ENTRY_COLUMN_CONTRACT,
    );

    const indexes = db.prepare("PRAGMA index_list(entries)").all() as Array<{
      name: string;
      unique: number;
    }>;
    const indexColumns = new Map(
      indexes.map((index) => [
        index.name,
        (db.prepare(`PRAGMA index_info('${index.name}')`).all() as Array<{ name: string }>).map((row) => row.name),
      ]),
    );
    expect(indexes.some((index) => index.unique === 1 && indexColumns.get(index.name)?.join(",") === "item_ref")).toBe(
      true,
    );
    expect(indexColumns.get("idx_entries_bundle")).toEqual(["bundle_id"]);
    expect(indexColumns.get("idx_entries_type")).toEqual(["type"]);
    expect(indexColumns.get("idx_entries_file_path")).toEqual(["file_path"]);
    expect(indexColumns.get("idx_entries_derived_from")).toEqual(["derived_from"]);
  } finally {
    closeDatabase(db);
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

  test("a stale partial generation is rebuilt even when entries is missing", () => {
    withTempIndex((dbPath) => {
      const stale = openDatabase(dbPath);
      stale.exec(`
        CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO index_meta (key, value) VALUES ('version', '${DB_VERSION - 1}');
        CREATE TABLE llm_enrichment_cache (legacy_payload TEXT NOT NULL);
      `);
      stale.close();

      const current = openIndexDatabase(dbPath);
      try {
        const columns = (
          current.prepare("PRAGMA table_info(llm_enrichment_cache)").all() as Array<{ name: string }>
        ).map((row) => row.name);
        expect(columns).toEqual(["asset_ref", "cache_variant", "body_hash", "result_json", "updated_at"]);
      } finally {
        closeDatabase(current);
      }

      expect(entryColumns(dbPath)).toEqual(CURRENT_ENTRY_COLUMNS);
    });
  });

  test("exact column names cannot disguise missing types, NOT NULL constraints, or the primary key", () => {
    withTempIndex((dbPath) => {
      seedStampedEntriesSchema(
        dbPath,
        `CREATE TABLE entries (
          id, item_ref, bundle_id, component_id, concept_id, adapter_id,
          type, file_path, content_hash, document_json, search_text, derived_from
        );`,
        CANONICAL_ENTRY_INDEXES_DDL,
      );
      expectCanonicalGenerationRebuilt(dbPath);
    });
  });

  test("a stamped exact-name schema without UNIQUE(item_ref) is rebuilt", () => {
    withTempIndex((dbPath) => {
      seedStampedEntriesSchema(
        dbPath,
        CANONICAL_ENTRIES_DDL.replace("item_ref      TEXT NOT NULL UNIQUE", "item_ref      TEXT NOT NULL"),
        CANONICAL_ENTRY_INDEXES_DDL,
      );
      expectCanonicalGenerationRebuilt(dbPath);
    });
  });

  test("a stamped exact-name schema missing required lookup indexes is rebuilt instead of repaired in place", () => {
    withTempIndex((dbPath) => {
      seedStampedEntriesSchema(dbPath, CANONICAL_ENTRIES_DDL);
      expectCanonicalGenerationRebuilt(dbPath);
    });
  });

  test("required index names on the wrong columns cannot pass the generation fingerprint", () => {
    withTempIndex((dbPath) => {
      seedStampedEntriesSchema(
        dbPath,
        CANONICAL_ENTRIES_DDL,
        `CREATE INDEX idx_entries_bundle ON entries(type);
         CREATE INDEX idx_entries_type ON entries(bundle_id);
         CREATE INDEX idx_entries_file_path ON entries(concept_id);
         CREATE INDEX idx_entries_derived_from ON entries(search_text);`,
      );
      expectCanonicalGenerationRebuilt(dbPath);
    });
  });

  test("a stamped schema with a hidden generated legacy column is rebuilt", () => {
    withTempIndex((dbPath) => {
      seedStampedEntriesSchema(
        dbPath,
        CANONICAL_ENTRIES_DDL.replace(
          "derived_from  TEXT\n  );",
          "derived_from  TEXT,\n    entry_key    TEXT GENERATED ALWAYS AS (item_ref) VIRTUAL\n  );",
        ),
        CANONICAL_ENTRY_INDEXES_DDL,
      );

      expectCanonicalGenerationRebuilt(dbPath);

      const db = openDatabase(dbPath, { readonly: true, create: false });
      try {
        const columns = db.prepare("PRAGMA table_xinfo(entries)").all() as Array<{ name: string }>;
        expect(columns.map((column) => column.name)).toEqual(CURRENT_ENTRY_COLUMNS);
      } finally {
        db.close();
      }
    });
  });

  test("a NOCASE item_ref uniqueness constraint is rejected and rebuilt with case-sensitive identity", () => {
    withTempIndex((dbPath) => {
      seedStampedEntriesSchema(
        dbPath,
        CANONICAL_ENTRIES_DDL.replace(
          "item_ref      TEXT NOT NULL UNIQUE",
          "item_ref      TEXT COLLATE NOCASE NOT NULL UNIQUE",
        ),
        CANONICAL_ENTRY_INDEXES_DDL,
      );

      const db = openIndexDatabase(dbPath);
      try {
        expect((db.prepare("SELECT COUNT(*) AS count FROM entries").get() as { count: number }).count).toBe(0);
        const insert = db.prepare(
          `INSERT INTO entries
             (item_ref, bundle_id, component_id, concept_id, adapter_id, type,
              file_path, content_hash, document_json, search_text, derived_from)
           VALUES (?, 'stash', 'stash', ?, 'akm', 'knowledge', ?, NULL, ?, '', NULL)`,
        );
        for (const conceptId of ["knowledge/Guide", "knowledge/guide"]) {
          insert.run(
            `stash//${conceptId}`,
            conceptId,
            `/tmp/${conceptId.replace("/", "-")}.md`,
            JSON.stringify({ name: conceptId, type: "knowledge" }),
          );
        }

        expect(
          (db.prepare("SELECT item_ref FROM entries ORDER BY id").all() as Array<{ item_ref: string }>).map(
            (row) => row.item_ref,
          ),
        ).toEqual(["stash//knowledge/Guide", "stash//knowledge/guide"]);
        const uniqueIndex = (
          db.prepare("PRAGMA index_list(entries)").all() as Array<{ name: string; unique: number; origin: string }>
        ).find((index) => index.unique === 1 && index.origin === "u");
        expect(uniqueIndex).toBeDefined();
        const keyColumns = db.prepare(`PRAGMA index_xinfo('${uniqueIndex?.name ?? ""}')`).all() as Array<{
          name: string | null;
          desc: number;
          coll: string;
          key: number;
        }>;
        expect(
          keyColumns
            .filter((column) => column.key === 1)
            .map(({ name, desc, coll, key }) => ({ name, desc, coll, key })),
        ).toEqual([{ name: "item_ref", desc: 0, coll: "BINARY", key: 1 }]);
      } finally {
        closeDatabase(db);
      }
    });
  });
});
