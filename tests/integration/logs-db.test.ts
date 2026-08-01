/**
 * Tests for logs.db (#579) — the dedicated task/run log database.
 *
 * Validates:
 *   1. Migration 001 creates task_logs + indices on a fresh DB; re-open is a no-op.
 *   2. insertTaskLogLines round-trip: rows queryable by task_id, run_id, stream,
 *      and time window, in emission order.
 *   3. getLoggedRunIds bulk membership check.
 *   4. purgeOldTaskLogs deletes only rows older than retentionDays and is
 *      disabled for non-positive values.
 *
 * Each test runs inside an isolated storage root so `openLogsDatabase()` never
 * touches the developer's real databases.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  buildTaskRunId,
  getLoggedRunIds,
  getLogsDbPath,
  insertTaskLogLines,
  openLogsDatabase,
  purgeOldTaskLogs,
  queryTaskLogs,
} from "../../src/core/logs-db";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

function isoMinusDays(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

describe("openLogsDatabase", () => {
  test("creates logs.db in the data dir with the task_logs schema", () => {
    const db = openLogsDatabase();
    try {
      expect(fs.existsSync(getLogsDbPath())).toBe(true);
      expect(getLogsDbPath().startsWith(storage.dataDir)).toBe(true);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_logs'")
        .all() as Array<{ name: string }>;
      expect(tables).toHaveLength(1);
      const indices = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'task_logs' ORDER BY name")
        .all() as Array<{ name: string }>;
      const names = indices.map((row) => row.name);
      expect(names).toContain("idx_task_logs_ts");
      expect(names).toContain("idx_task_logs_task_id");
      expect(names).toContain("idx_task_logs_run_id");
    } finally {
      db.close();
    }
  });

  test("re-opening an already-migrated database is a no-op and keeps rows", () => {
    const ts = new Date().toISOString();
    const first = openLogsDatabase();
    try {
      insertTaskLogLines(first, { taskId: "t", runId: buildTaskRunId("t", ts), ts, lines: [{ line: "hello" }] });
    } finally {
      first.close();
    }
    const second = openLogsDatabase();
    try {
      expect(queryTaskLogs(second, { taskId: "t" })).toHaveLength(1);
    } finally {
      second.close();
    }
  });

  test("opens the ID-only logs ledger published by 0.8.14 and keeps its rows", () => {
    const dbPath = getLogsDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE task_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        stream TEXT NOT NULL DEFAULT 'stdout',
        level TEXT NOT NULL DEFAULT 'info',
        line TEXT NOT NULL
      );
      CREATE INDEX idx_task_logs_ts ON task_logs(ts);
      CREATE INDEX idx_task_logs_task_id ON task_logs(task_id);
      CREATE INDEX idx_task_logs_run_id ON task_logs(run_id);
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schema_migrations(id) VALUES ('001-task-logs');
      INSERT INTO task_logs(ts, task_id, run_id, line)
      VALUES ('2026-01-01T00:00:00.000Z', 'legacy', 'legacy@1', 'published row');
    `);
    legacy.close();

    const migrated = openLogsDatabase();
    try {
      expect(queryTaskLogs(migrated, { taskId: "legacy" }).map((row) => row.line)).toEqual(["published row"]);
      expect(migrated.prepare("SELECT id FROM schema_migrations WHERE id='001-task-logs'").get()).toEqual({
        id: "001-task-logs",
      });
    } finally {
      migrated.close();
    }
  });
});

describe("insertTaskLogLines / queryTaskLogs", () => {
  test("round-trip: rows queryable by task_id, run_id, and time window in emission order", () => {
    const startedAt = new Date().toISOString();
    const runId = buildTaskRunId("nightly", startedAt);
    const db = openLogsDatabase();
    try {
      const inserted = insertTaskLogLines(db, {
        taskId: "nightly",
        runId,
        ts: startedAt,
        lines: [
          { line: "[akm task] task=nightly kind=command cmd=echo hi" },
          { stream: "stdout", level: "info", line: "hi" },
          { stream: "stderr", level: "error", line: "boom" },
        ],
      });
      expect(inserted).toBe(3);
      // Another task's run must not leak into the filters below.
      insertTaskLogLines(db, {
        taskId: "other",
        runId: buildTaskRunId("other", startedAt),
        ts: startedAt,
        lines: [{ line: "unrelated" }],
      });

      const byTask = queryTaskLogs(db, { taskId: "nightly" });
      expect(byTask.map((row) => row.line)).toEqual(["[akm task] task=nightly kind=command cmd=echo hi", "hi", "boom"]);
      expect(byTask[0]!.run_id).toBe(runId);
      expect(byTask[1]!.stream).toBe("stdout");
      expect(byTask[2]!.stream).toBe("stderr");
      expect(byTask[2]!.level).toBe("error");

      expect(queryTaskLogs(db, { runId })).toHaveLength(3);
      expect(queryTaskLogs(db, { runId, stream: "stderr" }).map((row) => row.line)).toEqual(["boom"]);
      expect(queryTaskLogs(db, { runId, limit: 1 }).map((row) => row.line)).toEqual([
        "[akm task] task=nightly kind=command cmd=echo hi",
      ]);

      // Time window: since is inclusive, until exclusive.
      expect(queryTaskLogs(db, { taskId: "nightly", since: startedAt })).toHaveLength(3);
      expect(queryTaskLogs(db, { taskId: "nightly", until: startedAt })).toHaveLength(0);
      expect(queryTaskLogs(db, { taskId: "nightly", since: isoMinusDays(1), until: isoMinusDays(0.5) })).toHaveLength(
        0,
      );
    } finally {
      db.close();
    }
  });

  test("empty line batch inserts nothing", () => {
    const db = openLogsDatabase();
    try {
      expect(insertTaskLogLines(db, { taskId: "t", runId: "t@x", ts: new Date().toISOString(), lines: [] })).toBe(0);
      expect(queryTaskLogs(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

describe("getLoggedRunIds", () => {
  test("returns only the run ids that have at least one log row", () => {
    const ts = new Date().toISOString();
    const db = openLogsDatabase();
    try {
      insertTaskLogLines(db, { taskId: "a", runId: "a@1", ts, lines: [{ line: "x" }] });
      insertTaskLogLines(db, { taskId: "b", runId: "b@1", ts, lines: [{ line: "y" }, { line: "z" }] });
      const logged = getLoggedRunIds(db, ["a@1", "b@1", "c@1"]);
      expect(logged).toEqual(new Set(["a@1", "b@1"]));
      expect(getLoggedRunIds(db, []).size).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("purgeOldTaskLogs", () => {
  test("deletes only rows older than retentionDays", () => {
    const db = openLogsDatabase();
    try {
      insertTaskLogLines(db, { taskId: "old", runId: "old@1", ts: isoMinusDays(120), lines: [{ line: "ancient" }] });
      insertTaskLogLines(db, { taskId: "new", runId: "new@1", ts: isoMinusDays(1), lines: [{ line: "fresh" }] });

      expect(purgeOldTaskLogs(db, 90)).toBe(1);
      const remaining = queryTaskLogs(db);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.line).toBe("fresh");
      // Second pass is a no-op.
      expect(purgeOldTaskLogs(db, 90)).toBe(0);
    } finally {
      db.close();
    }
  });

  test("non-positive or non-finite retention disables the purge", () => {
    const db = openLogsDatabase();
    try {
      insertTaskLogLines(db, { taskId: "old", runId: "old@1", ts: isoMinusDays(500), lines: [{ line: "keep" }] });
      expect(purgeOldTaskLogs(db, 0)).toBe(0);
      expect(purgeOldTaskLogs(db, -5)).toBe(0);
      expect(purgeOldTaskLogs(db, Number.NaN)).toBe(0);
      expect(queryTaskLogs(db)).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
