// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getStateMigrationSafety,
  STATE_MIGRATION_SAFETY_BY_ID,
  STATE_MIGRATIONS,
} from "../../src/core/state/migrations";
import * as stateDbModule from "../../src/core/state-db";
import { openStateDatabase } from "../../src/core/state-db";
import { openDatabase } from "../../src/storage/database";
import { runMigrations } from "../../src/storage/engines/sqlite-migrations";

const roots: string[] = [];

function statePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-state-migrations-"));
  roots.push(root);
  return path.join(root, "state.db");
}

function migrationIndex(id: string): number {
  const index = STATE_MIGRATIONS.findIndex((migration) => migration.id === id);
  if (index < 0) throw new Error(`Missing state migration fixture ${id}`);
  return index;
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

  test("a prefix before 002 automatically runs the verified data-preserving rebuild, then stops before 018", () => {
    const file = statePath();
    const before002 = STATE_MIGRATIONS.slice(0, migrationIndex("002-task-history-per-run"));
    const before018 = STATE_MIGRATIONS.slice(0, migrationIndex("018-drop-dead-lane-schema"));
    const seeded = openDatabase(file);
    runMigrations(seeded, before002);
    seeded
      .prepare(
        `INSERT INTO task_history
          (task_id, status, started_at, metadata_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run("daily", "completed", "2026-08-24T00:00:00.000Z", '{"marker":"kept"}');
    seeded.close();

    expect(() => openStateDatabase(file)).toThrow(/018-drop-dead-lane-schema.*akm upgrade --force/i);

    const inspected = openDatabase(file, { readonly: true });
    const ids = inspected.prepare("SELECT id FROM schema_migrations ORDER BY rowid").all() as Array<{ id: string }>;
    expect(ids.map((row) => row.id)).toEqual(before018.map((migration) => migration.id));
    expect(
      inspected.prepare("SELECT id, task_id, metadata_json FROM task_history").get() as {
        id: number;
        task_id: string;
        metadata_json: string;
      },
    ).toEqual({ id: 1, task_id: "daily", metadata_json: '{"marker":"kept"}' });
    inspected.close();
  });

  test("a prefix before 018 is rejected before the historical destructive DDL changes durable state", () => {
    const file = statePath();
    const before018 = STATE_MIGRATIONS.slice(0, migrationIndex("018-drop-dead-lane-schema"));
    const seeded = openDatabase(file);
    runMigrations(seeded, before018);
    seeded
      .prepare("INSERT INTO consolidation_judged (entry_key, content_hash, judged_at, outcome) VALUES (?, ?, ?, ?)")
      .run("memories/keep", "keep-me", "2026-08-24T00:00:00.000Z", "no_action");
    seeded.close();

    expect(() => openStateDatabase(file)).toThrow(/018-drop-dead-lane-schema.*akm upgrade --force/i);

    const inspected = openDatabase(file, { readonly: true });
    expect(
      (inspected.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count,
    ).toBe(before018.length);
    expect(
      inspected.prepare("SELECT entry_key, content_hash, judged_at, outcome FROM consolidation_judged").get() as {
        entry_key: string;
        content_hash: string;
        judged_at: string;
        outcome: string;
      },
    ).toEqual({
      entry_key: "memories/keep",
      content_hash: "keep-me",
      judged_at: "2026-08-24T00:00:00.000Z",
      outcome: "no_action",
    });
    inspected.close();
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.includes("pre-018"))).toEqual([]);
  });

  test("the explicit state upgrade creates and verifies a sibling pre-018 safety copy before applying 018", () => {
    const file = statePath();
    const before018 = STATE_MIGRATIONS.slice(0, migrationIndex("018-drop-dead-lane-schema"));
    const seeded = openDatabase(file);
    runMigrations(seeded, before018);
    seeded
      .prepare("INSERT INTO consolidation_judged (entry_key, content_hash, judged_at, outcome) VALUES (?, ?, ?, ?)")
      .run("memories/recoverable", "recover-me", "2026-08-24T01:00:00.000Z", "actioned");
    seeded.close();

    const upgradeHistoricalStateDatabase = (
      stateDbModule as typeof stateDbModule & {
        upgradeHistoricalStateDatabase: (dbPath: string) => {
          upgraded: boolean;
          safetyCopyPath?: string;
        };
      }
    ).upgradeHistoricalStateDatabase;
    expect(upgradeHistoricalStateDatabase).toBeFunction();
    const result = upgradeHistoricalStateDatabase(file);

    expect(result.upgraded).toBe(true);
    expect(result.safetyCopyPath).toStartWith(`${file}.pre-018-drop-dead-lane-schema.`);
    expect(result.safetyCopyPath).toEndWith(".bak");

    const current = openDatabase(file, { readonly: true });
    expect((current.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count).toBe(
      STATE_MIGRATIONS.length,
    );
    expect(
      (
        current
          .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'consolidation_judged'")
          .get() as { count: number }
      ).count,
    ).toBe(0);
    current.close();

    const safetyCopy = openDatabase(result.safetyCopyPath as string, { readonly: true });
    expect(safetyCopy.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    expect(
      safetyCopy.prepare("SELECT entry_key, content_hash FROM consolidation_judged").get() as {
        entry_key: string;
        content_hash: string;
      },
    ).toEqual({ entry_key: "memories/recoverable", content_hash: "recover-me" });
    expect(
      (safetyCopy.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count,
    ).toBe(before018.length);
    safetyCopy.close();

    expect(upgradeHistoricalStateDatabase(file)).toEqual({ upgraded: false });
  });

  test("released 002 and 018 migration SQL remains byte-for-byte immutable", () => {
    const expected = new Map([
      ["002-task-history-per-run", "58aa34d3cd8726180de7b8691f14d40ee6729bf1541a9b81305c3ab66346cecc"],
      ["018-drop-dead-lane-schema", "e7123d4efe86f66768fd15d905aefa95a7011961de9de8e806702e1fe70cc7c5"],
    ]);

    for (const [id, sha256] of expected) {
      const migration = STATE_MIGRATIONS.find((candidate) => candidate.id === id);
      expect(migration).toBeDefined();
      expect(
        createHash("sha256")
          .update(migration?.up ?? "")
          .digest("hex"),
      ).toBe(sha256);
    }
  });

  test("every ordered migration ID has an explicit safety classification", () => {
    expect(Object.keys(STATE_MIGRATION_SAFETY_BY_ID)).toEqual(STATE_MIGRATIONS.map((migration) => migration.id));
    expect(getStateMigrationSafety("002-task-history-per-run")).toBe("data-preserving-rebuild");
    expect(getStateMigrationSafety("018-drop-dead-lane-schema")).toBe("historical-destructive");

    for (const migration of STATE_MIGRATIONS) {
      const executableSql = migration.up.replaceAll(/--.*$/gm, "");
      if (/\bDROP\b|\bRENAME\s+TO\b/i.test(executableSql)) {
        expect(getStateMigrationSafety(migration.id)).not.toBe("additive");
      }
    }
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
