// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getStateMigrationSafety,
  STATE_MIGRATION_SAFETY_BY_ID,
  STATE_MIGRATIONS,
} from "../../src/core/state/migrations";
import { openStateDatabase, upgradeHistoricalStateDatabase } from "../../src/core/state-db";
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

function seedBefore018(file: string, marker = "seeded-before-018"): void {
  const before018 = STATE_MIGRATIONS.slice(0, migrationIndex("018-drop-dead-lane-schema"));
  const seeded = openDatabase(file);
  runMigrations(seeded, before018);
  seeded
    .prepare("INSERT INTO consolidation_judged (entry_key, content_hash, judged_at, outcome) VALUES (?, ?, ?, ?)")
    .run("memories/hostile", marker, "2026-08-24T03:00:00.000Z", "actioned");
  seeded.close();
}

function waitForFile(file: string, timeoutMs = 2_000): void {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  if (!fs.existsSync(file)) throw new Error(`Timed out waiting for ${file}`);
}

afterEach(() => {
  mock.restore();
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

  test("a pre-018 database appearing at the fresh-open boundary is never treated as fresh", () => {
    const file = statePath();
    const resolvedFile = path.resolve(file);
    const originalExists = fs.existsSync.bind(fs);
    const originalOpen = fs.openSync.bind(fs);
    let injected = false;

    const inject = () => {
      if (injected) return;
      injected = true;
      seedBefore018(file, "appeared-during-open");
    };
    const exists = spyOn(fs, "existsSync").mockImplementation(((candidate: fs.PathLike) => {
      if (!injected && path.resolve(String(candidate)) === resolvedFile) {
        inject();
        return false;
      }
      return originalExists(candidate);
    }) as typeof fs.existsSync);
    const open = spyOn(fs, "openSync").mockImplementation(((
      candidate: fs.PathLike,
      flags: string | number,
      mode?: fs.Mode,
    ) => {
      if (!injected && path.resolve(String(candidate)) === resolvedFile) inject();
      return originalOpen(candidate, flags, mode);
    }) as typeof fs.openSync);

    let opened: ReturnType<typeof openStateDatabase> | undefined;
    let error: unknown;
    try {
      opened = openStateDatabase(file);
    } catch (caught) {
      error = caught;
    } finally {
      opened?.close();
      open.mockRestore();
      exists.mockRestore();
    }

    expect(injected).toBe(true);
    expect(error instanceof Error ? error.message : "").toMatch(/018-drop-dead-lane-schema.*akm upgrade --force/i);
    const inspected = openDatabase(file, { readonly: true });
    expect(inspected.prepare("SELECT content_hash FROM consolidation_judged").get()).toEqual({
      content_hash: "appeared-during-open",
    });
    inspected.close();
  });

  test("fresh-file ownership rejects an inode replacement before SQLite open", () => {
    const file = statePath();
    const resolvedFile = path.resolve(file);
    const originalOpen = fs.openSync.bind(fs);
    let swapped = false;
    const open = spyOn(fs, "openSync").mockImplementation(((
      candidate: fs.PathLike,
      flags: string | number,
      mode?: fs.Mode,
    ) => {
      const fd = originalOpen(candidate, flags, mode);
      const isExclusive =
        (typeof flags === "number" && (flags & fs.constants.O_EXCL) !== 0) ||
        (typeof flags === "string" && flags.includes("x"));
      if (!swapped && isExclusive && path.resolve(String(candidate)) === resolvedFile) {
        swapped = true;
        fs.unlinkSync(file);
        seedBefore018(file, "inode-replacement");
      }
      return fd;
    }) as typeof fs.openSync);

    let opened: ReturnType<typeof openStateDatabase> | undefined;
    let error: unknown;
    try {
      opened = openStateDatabase(file);
    } catch (caught) {
      error = caught;
    } finally {
      opened?.close();
      open.mockRestore();
    }

    expect(swapped).toBe(true);
    expect(error instanceof Error ? error.message : "").toMatch(/fresh state\.db.*ownership|inode|replaced/i);
    const inspected = openDatabase(file, { readonly: true });
    expect(inspected.prepare("SELECT content_hash FROM consolidation_judged").get()).toEqual({
      content_hash: "inode-replacement",
    });
    inspected.close();
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
    seeded.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
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
    seeded.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
    runMigrations(seeded, before018);
    seeded
      .prepare("INSERT INTO consolidation_judged (entry_key, content_hash, judged_at, outcome) VALUES (?, ?, ?, ?)")
      .run("memories/recoverable", "recover-me", "2026-08-24T01:00:00.000Z", "actioned");
    expect(fs.existsSync(`${file}-wal`)).toBe(true);

    const result = upgradeHistoricalStateDatabase(file);
    seeded.close();

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

  test("snapshot and migration 018 share one writer-exclusion window", async () => {
    const file = statePath();
    const startedFile = path.join(path.dirname(file), "writer-started");
    const before018 = STATE_MIGRATIONS.slice(0, migrationIndex("018-drop-dead-lane-schema"));
    const seeded = openDatabase(file);
    seeded.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
    runMigrations(seeded, before018);
    seeded.exec(`
      CREATE TABLE migration_race_probe (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL
      );
      INSERT INTO migration_race_probe(kind) VALUES ('seed');
      CREATE TRIGGER mark_migration_018
        AFTER INSERT ON schema_migrations
        WHEN NEW.id = '018-drop-dead-lane-schema'
      BEGIN
        INSERT INTO migration_race_probe(kind) VALUES ('migration-018');
      END;
    `);
    seeded.close();

    const writerProgram = `
      import { Database } from "bun:sqlite";
      import { writeFileSync } from "node:fs";
      const db = new Database(process.argv[1]);
      db.exec("PRAGMA busy_timeout = 5000");
      writeFileSync(process.argv[2], "started");
      db.query("INSERT INTO migration_race_probe(kind) VALUES ('concurrent-writer')").run();
      db.close();
    `;
    const originalFsync = fs.fsyncSync.bind(fs);
    let writer: ChildProcess | undefined;
    let writerExit: Promise<{ code: number | null; stderr: string }> | undefined;
    const fsync = spyOn(fs, "fsyncSync").mockImplementation(((fd: number) => {
      if (!writer) {
        writer = spawn(process.execPath, ["-e", writerProgram, file, startedFile], {
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        writer.stderr?.on("data", (chunk) => {
          stderr += String(chunk);
        });
        writerExit = new Promise((resolve) => {
          writer?.once("exit", (code) => resolve({ code, stderr }));
        });
        waitForFile(startedFile);
        // Without a writer lock spanning snapshot -> migration, this writer
        // commits during this deterministic post-snapshot pause.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
      }
      return originalFsync(fd);
    }) as typeof fs.fsyncSync);

    let result: ReturnType<typeof upgradeHistoricalStateDatabase>;
    try {
      result = upgradeHistoricalStateDatabase(file);
    } finally {
      fsync.mockRestore();
    }
    const writerResult = await Promise.race([
      writerExit ?? Promise.reject(new Error("Concurrent writer was not started.")),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Concurrent writer timed out.")), 7_000)),
    ]);
    expect(writerResult).toEqual({ code: 0, stderr: "" });

    const safetyCopy = openDatabase(result.safetyCopyPath as string, { readonly: true });
    const backupMax = safetyCopy.prepare("SELECT MAX(id) AS id FROM migration_race_probe").get() as { id: number };
    safetyCopy.close();

    const current = openDatabase(file, { readonly: true });
    const rows = current.prepare("SELECT id, kind FROM migration_race_probe ORDER BY id").all() as Array<{
      id: number;
      kind: string;
    }>;
    current.close();
    const migrationMarker = rows.find((row) => row.kind === "migration-018");
    const concurrentWriter = rows.find((row) => row.kind === "concurrent-writer");
    expect(migrationMarker?.id).toBe(backupMax.id + 1);
    expect(concurrentWriter?.id).toBeGreaterThan(migrationMarker?.id ?? Number.POSITIVE_INFINITY);
  });

  test("a failed 018 transaction retains its verified safety copy and reports the recovery path", () => {
    const file = statePath();
    const before018 = STATE_MIGRATIONS.slice(0, migrationIndex("018-drop-dead-lane-schema"));
    const seeded = openDatabase(file);
    runMigrations(seeded, before018);
    seeded
      .prepare("INSERT INTO consolidation_judged (entry_key, content_hash, judged_at, outcome) VALUES (?, ?, ?, ?)")
      .run("memories/recoverable", "recover-after-failure", "2026-08-24T02:00:00.000Z", "actioned");
    // Exact ledger, deliberately divergent physical schema: 018 will fail at
    // its final DROP COLUMN after the verified copy has been created.
    seeded.exec(`
      DROP INDEX idx_asset_outcome_review_pressure;
      ALTER TABLE asset_outcome DROP COLUMN review_pressure;
    `);
    seeded.close();

    let message = "";
    try {
      upgradeHistoricalStateDatabase(file);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/Verified safety copy: .*pre-018-drop-dead-lane-schema.*\.bak/i);
    const safetyCopyPath = message.match(/Verified safety copy: ([^\s]+\.bak)/)?.[1];
    expect(safetyCopyPath).toBeDefined();
    expect(fs.existsSync(safetyCopyPath as string)).toBe(true);

    const current = openDatabase(file, { readonly: true });
    expect((current.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count).toBe(
      before018.length,
    );
    expect(current.prepare("SELECT content_hash FROM consolidation_judged").get() as { content_hash: string }).toEqual({
      content_hash: "recover-after-failure",
    });
    current.close();

    const safetyCopy = openDatabase(safetyCopyPath as string, { readonly: true });
    expect(safetyCopy.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    expect(
      safetyCopy.prepare("SELECT content_hash FROM consolidation_judged").get() as { content_hash: string },
    ).toEqual({ content_hash: "recover-after-failure" });
    safetyCopy.close();
  });

  test.skipIf(process.platform === "win32")(
    "backup reservation is randomized, O_EXCL, symlink-safe, and no broader than the source mode",
    () => {
      const file = statePath();
      seedBefore018(file, "exclusive-reservation");
      fs.chmodSync(file, 0o640);
      const sentinel = path.join(path.dirname(file), "attacker-target");
      fs.writeFileSync(sentinel, "untouched");
      const originalOpen = fs.openSync.bind(fs);
      let collisionPath: string | undefined;
      let observedFlags: string | number | undefined;
      let observedMode: fs.Mode | undefined;

      const open = spyOn(fs, "openSync").mockImplementation(((
        candidate: fs.PathLike,
        flags: string | number,
        mode?: fs.Mode,
      ) => {
        const candidatePath = String(candidate);
        const isSafetyCopy = candidatePath.includes(".pre-018-drop-dead-lane-schema.");
        const isExclusive =
          (typeof flags === "number" && (flags & fs.constants.O_EXCL) !== 0) ||
          (typeof flags === "string" && flags.includes("x"));
        if (isSafetyCopy && !collisionPath) {
          collisionPath = candidatePath;
          observedFlags = flags;
          observedMode = mode;
          if (isExclusive) fs.symlinkSync(sentinel, candidatePath);
        }
        return originalOpen(candidate, flags, mode);
      }) as typeof fs.openSync);

      let result: ReturnType<typeof upgradeHistoricalStateDatabase>;
      try {
        result = upgradeHistoricalStateDatabase(file);
      } finally {
        open.mockRestore();
      }

      expect(typeof observedFlags).toBe("number");
      expect(((observedFlags as number) & fs.constants.O_EXCL) !== 0).toBe(true);
      expect(((observedFlags as number) & fs.constants.O_CREAT) !== 0).toBe(true);
      expect(observedMode).toBe(0o600);
      expect(collisionPath).toBeDefined();
      expect(fs.lstatSync(collisionPath as string).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(sentinel, "utf8")).toBe("untouched");
      expect(result.safetyCopyPath).not.toBe(collisionPath);
      expect(path.basename(result.safetyCopyPath as string)).toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.bak$/i,
      );
      const backupStat = fs.lstatSync(result.safetyCopyPath as string);
      expect(backupStat.isFile()).toBe(true);
      expect(backupStat.isSymbolicLink()).toBe(false);
      expect(backupStat.mode & 0o777).toBe(0o600);
      if (typeof process.geteuid === "function") expect(backupStat.uid).toBe(process.geteuid());
    },
  );

  test.skipIf(process.platform === "win32")(
    "an inode/symlink swap after reservation is rejected without unlinking the replacement",
    () => {
      const file = statePath();
      seedBefore018(file, "inode-swap-backup");
      const sentinel = path.join(path.dirname(file), "replacement-target");
      fs.writeFileSync(sentinel, "attacker-owned");
      const originalOpen = fs.openSync.bind(fs);
      const originalFsync = fs.fsyncSync.bind(fs);
      let safetyCopyPath: string | undefined;
      let swapped = false;

      const open = spyOn(fs, "openSync").mockImplementation(((
        candidate: fs.PathLike,
        flags: string | number,
        mode?: fs.Mode,
      ) => {
        if (!safetyCopyPath && String(candidate).includes(".pre-018-drop-dead-lane-schema.")) {
          safetyCopyPath = String(candidate);
        }
        return originalOpen(candidate, flags, mode);
      }) as typeof fs.openSync);
      const fsync = spyOn(fs, "fsyncSync").mockImplementation(((fd: number) => {
        if (!swapped && safetyCopyPath) {
          swapped = true;
          fs.unlinkSync(safetyCopyPath);
          fs.symlinkSync(sentinel, safetyCopyPath);
        }
        return originalFsync(fd);
      }) as typeof fs.fsyncSync);

      let error: unknown;
      try {
        upgradeHistoricalStateDatabase(file);
      } catch (caught) {
        error = caught;
      } finally {
        fsync.mockRestore();
        open.mockRestore();
      }

      expect(swapped).toBe(true);
      expect(error instanceof Error ? error.message : "").toMatch(/inode|ownership|symlink|replaced/i);
      expect(safetyCopyPath).toBeDefined();
      expect(fs.lstatSync(safetyCopyPath as string).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(sentinel, "utf8")).toBe("attacker-owned");
      const current = openDatabase(file, { readonly: true });
      expect(current.prepare("SELECT content_hash FROM consolidation_judged").get()).toEqual({
        content_hash: "inode-swap-backup",
      });
      current.close();
    },
  );

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
