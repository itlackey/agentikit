// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STATE_MIGRATIONS } from "../../src/core/state/migrations";
import { openStateDatabase } from "../../src/core/state-db";
import { openDatabase } from "../../src/storage/database";
import { runMigrations } from "../../src/storage/engines/sqlite-migrations";

const roots: string[] = [];

function statePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-state-migrations-"));
  roots.push(root);
  return path.join(root, "state.db");
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("state.db automatic migration boundary", () => {
  test("a managed open advances an exact older prefix and preserves unrelated durable rows", () => {
    const file = statePath();
    const prior = STATE_MIGRATIONS.slice(0, -1);
    const seeded = openDatabase(file);
    runMigrations(seeded, prior);
    seeded.exec("CREATE TABLE operator_probe (value TEXT NOT NULL); INSERT INTO operator_probe VALUES ('kept')");
    seeded.close();

    const upgraded = openStateDatabase(file);
    expect((upgraded.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count).toBe(
      STATE_MIGRATIONS.length,
    );
    expect((upgraded.prepare("SELECT value FROM operator_probe").get() as { value: string }).value).toBe("kept");
    upgraded.close();
  });

  test("a fresh managed open installs the complete current ledger", () => {
    const db = openStateDatabase(statePath());
    const ids = db.prepare("SELECT id FROM schema_migrations ORDER BY rowid").all() as Array<{ id: string }>;
    expect(ids.map((row) => row.id)).toEqual(STATE_MIGRATIONS.map((migration) => migration.id));
    db.close();
  });

  test("an unknown ledger is rejected before current schema writes", () => {
    const file = statePath();
    const seeded = openDatabase(file);
    seeded.exec(`
      CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES ('unknown-runtime', datetime('now'));
      CREATE TABLE operator_probe (value TEXT NOT NULL);
      INSERT INTO operator_probe VALUES ('unchanged');
    `);
    seeded.close();

    expect(() => openStateDatabase(file)).toThrow(/newer migration ledger|unknown migration ID/i);

    const inspected = openDatabase(file, { readonly: true });
    expect((inspected.prepare("SELECT value FROM operator_probe").get() as { value: string }).value).toBe("unchanged");
    expect(
      (inspected.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'").get() as { count: number })
        .count,
    ).toBe(2);
    inspected.close();
  });
});
