// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The single canonical contract for the derived `entries` generation.
 *
 * `index.db` is regenerable, so callers compare one normalized PRAGMA
 * fingerprint and discard any generation that differs. This module owns both
 * the DDL and its expected fingerprint so schema creation, writable opens,
 * serving preflights, and read-only evaluator tooling cannot drift into
 * separate definitions of "current".
 */

export const CANONICAL_INDEX_DB_VERSION = 21;

export const CANONICAL_ENTRY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS entries (
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

  CREATE INDEX IF NOT EXISTS idx_entries_bundle ON entries(bundle_id);
  CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(type);
  CREATE INDEX IF NOT EXISTS idx_entries_file_path ON entries(file_path);
  CREATE INDEX IF NOT EXISTS idx_entries_derived_from ON entries(derived_from);
`;

interface ColumnFingerprint {
  cid: number;
  name: string;
  type: string;
  notNull: number;
  defaultValue: string | null;
  primaryKeyPosition: number;
  hidden: number;
}

interface IndexColumnFingerprint {
  sequence: number;
  cid: number;
  name: string | null;
  descending: number;
  collation: string | null;
  key: number;
}

interface IndexFingerprint {
  name: string;
  unique: number;
  origin: string;
  partial: number;
  columns: IndexColumnFingerprint[];
}

interface EntrySchemaFingerprint {
  columns: ColumnFingerprint[];
  indexes: IndexFingerprint[];
}

/** Minimal read-only statement surface shared by bun:sqlite and AKM's runtime-neutral handle. */
export interface EntrySchemaInspectionDatabase {
  prepare(sql: string): {
    all(): unknown[];
    get(): unknown;
  };
}

const CANONICAL_ENTRY_SCHEMA_FINGERPRINT: EntrySchemaFingerprint = {
  columns: [
    { cid: 0, name: "id", type: "INTEGER", notNull: 0, defaultValue: null, primaryKeyPosition: 1, hidden: 0 },
    {
      cid: 1,
      name: "item_ref",
      type: "TEXT",
      notNull: 1,
      defaultValue: null,
      primaryKeyPosition: 0,
      hidden: 0,
    },
    {
      cid: 2,
      name: "bundle_id",
      type: "TEXT",
      notNull: 1,
      defaultValue: null,
      primaryKeyPosition: 0,
      hidden: 0,
    },
    {
      cid: 3,
      name: "component_id",
      type: "TEXT",
      notNull: 1,
      defaultValue: null,
      primaryKeyPosition: 0,
      hidden: 0,
    },
    {
      cid: 4,
      name: "concept_id",
      type: "TEXT",
      notNull: 1,
      defaultValue: null,
      primaryKeyPosition: 0,
      hidden: 0,
    },
    {
      cid: 5,
      name: "adapter_id",
      type: "TEXT",
      notNull: 1,
      defaultValue: null,
      primaryKeyPosition: 0,
      hidden: 0,
    },
    { cid: 6, name: "type", type: "TEXT", notNull: 1, defaultValue: null, primaryKeyPosition: 0, hidden: 0 },
    {
      cid: 7,
      name: "file_path",
      type: "TEXT",
      notNull: 1,
      defaultValue: null,
      primaryKeyPosition: 0,
      hidden: 0,
    },
    {
      cid: 8,
      name: "content_hash",
      type: "TEXT",
      notNull: 0,
      defaultValue: null,
      primaryKeyPosition: 0,
      hidden: 0,
    },
    {
      cid: 9,
      name: "document_json",
      type: "TEXT",
      notNull: 1,
      defaultValue: null,
      primaryKeyPosition: 0,
      hidden: 0,
    },
    {
      cid: 10,
      name: "search_text",
      type: "TEXT",
      notNull: 1,
      defaultValue: null,
      primaryKeyPosition: 0,
      hidden: 0,
    },
    {
      cid: 11,
      name: "derived_from",
      type: "TEXT",
      notNull: 0,
      defaultValue: null,
      primaryKeyPosition: 0,
      hidden: 0,
    },
  ],
  indexes: [
    {
      name: "idx_entries_bundle",
      unique: 0,
      origin: "c",
      partial: 0,
      columns: [
        { sequence: 0, cid: 2, name: "bundle_id", descending: 0, collation: "BINARY", key: 1 },
        { sequence: 1, cid: -1, name: null, descending: 0, collation: "BINARY", key: 0 },
      ],
    },
    {
      name: "idx_entries_derived_from",
      unique: 0,
      origin: "c",
      partial: 0,
      columns: [
        { sequence: 0, cid: 11, name: "derived_from", descending: 0, collation: "BINARY", key: 1 },
        { sequence: 1, cid: -1, name: null, descending: 0, collation: "BINARY", key: 0 },
      ],
    },
    {
      name: "idx_entries_file_path",
      unique: 0,
      origin: "c",
      partial: 0,
      columns: [
        { sequence: 0, cid: 7, name: "file_path", descending: 0, collation: "BINARY", key: 1 },
        { sequence: 1, cid: -1, name: null, descending: 0, collation: "BINARY", key: 0 },
      ],
    },
    {
      name: "idx_entries_type",
      unique: 0,
      origin: "c",
      partial: 0,
      columns: [
        { sequence: 0, cid: 6, name: "type", descending: 0, collation: "BINARY", key: 1 },
        { sequence: 1, cid: -1, name: null, descending: 0, collation: "BINARY", key: 0 },
      ],
    },
    {
      name: "sqlite_autoindex_entries_1",
      unique: 1,
      origin: "u",
      partial: 0,
      columns: [
        { sequence: 0, cid: 1, name: "item_ref", descending: 0, collation: "BINARY", key: 1 },
        { sequence: 1, cid: -1, name: null, descending: 0, collation: "BINARY", key: 0 },
      ],
    },
  ],
};

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function readEntrySchemaFingerprint(db: EntrySchemaInspectionDatabase): EntrySchemaFingerprint {
  const columns = (
    db.prepare("PRAGMA table_xinfo(entries)").all() as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
      hidden: number;
    }>
  ).map((column) => ({
    cid: Number(column.cid),
    name: column.name,
    type: column.type.trim().toUpperCase(),
    notNull: Number(column.notnull),
    defaultValue: column.dflt_value === null ? null : String(column.dflt_value),
    primaryKeyPosition: Number(column.pk),
    hidden: Number(column.hidden),
  }));

  const indexes = (
    db.prepare("PRAGMA index_list(entries)").all() as Array<{
      name: string;
      unique: number;
      origin: string;
      partial: number;
    }>
  )
    .map((index) => ({
      name: index.name,
      unique: Number(index.unique),
      origin: index.origin,
      partial: Number(index.partial),
      columns: (
        db.prepare(`PRAGMA index_xinfo(${sqlString(index.name)})`).all() as Array<{
          seqno: number;
          cid: number;
          name: string | null;
          desc: number;
          coll: string | null;
          key: number;
        }>
      )
        .sort((left, right) => Number(left.seqno) - Number(right.seqno))
        .map((column) => ({
          sequence: Number(column.seqno),
          cid: Number(column.cid),
          name: column.name,
          descending: Number(column.desc),
          collation: column.coll,
          key: Number(column.key),
        })),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return { columns, indexes };
}

export function hasCanonicalEntrySchema(db: EntrySchemaInspectionDatabase): boolean {
  try {
    return JSON.stringify(readEntrySchemaFingerprint(db)) === JSON.stringify(CANONICAL_ENTRY_SCHEMA_FINGERPRINT);
  } catch {
    return false;
  }
}

export function isCanonicalIndexGeneration(db: EntrySchemaInspectionDatabase): boolean {
  try {
    const row = db.prepare("SELECT value FROM index_meta WHERE key = 'version'").get() as { value: string } | undefined;
    return row?.value === String(CANONICAL_INDEX_DB_VERSION) && hasCanonicalEntrySchema(db);
  } catch {
    return false;
  }
}
