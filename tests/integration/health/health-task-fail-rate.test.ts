import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { akmHealth } from "../../../src/commands/health";
import type { HealthCheckResult } from "../../../src/commands/health/types";
import { openStateDatabase } from "../../../src/core/state-db";
import { upsertTaskHistory } from "../../../src/storage/repositories/task-history-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

// C2 (13-bus-factor): a live 15–16% cron task-failure rate was invisible —
// taskFailRate was computed + rendered in the HTML report but never surfaced as
// a health advisory. This pins the new `task-fail-rate` advisory: it fires
// (warn) at/above the 5% threshold the html-report already uses and stays
// `pass` below it.

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

function findCheck(checks: HealthCheckResult[], name: string): HealthCheckResult {
  const found = checks.find((c) => c.name === name);
  if (!found) throw new Error(`expected an advisory named ${name}`);
  return found;
}

/** Seed `failed` failed + `completed` completed task_history rows in the window. */
function seedTasks(failed: number, completed: number): void {
  const db = openStateDatabase();
  try {
    for (let i = 0; i < failed; i++) {
      upsertTaskHistory(db, {
        task_id: `failed-${i}`,
        status: "failed",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        failed_at: new Date().toISOString(),
        log_path: null,
        target_kind: "improve",
        target_ref: null,
        metadata_json: JSON.stringify({ durationMs: 10 }),
      });
    }
    for (let i = 0; i < completed; i++) {
      upsertTaskHistory(db, {
        task_id: `ok-${i}`,
        status: "completed",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        failed_at: null,
        log_path: null,
        target_kind: "improve",
        target_ref: null,
        metadata_json: JSON.stringify({ durationMs: 10 }),
      });
    }
  } finally {
    db.close();
  }
}

describe("task-fail-rate advisory (C2)", () => {
  test("fires warn at exactly the 5% threshold", () => {
    // 1 failed / 20 total = 0.05 → at threshold.
    seedTasks(1, 19);
    const result = akmHealth({ since: "7d" });
    const advisory = findCheck(result.advisories, "task-fail-rate");
    expect(advisory.status).toBe("warn");
    expect(advisory.kind).toBe("deterministic");
    expect(advisory.message).toContain("5.0%");
    expect(advisory.message).toContain("20");
  });

  test("fires warn above the 5% threshold", () => {
    // 3 failed / 20 total = 0.15 → above threshold.
    seedTasks(3, 17);
    const result = akmHealth({ since: "7d" });
    const advisory = findCheck(result.advisories, "task-fail-rate");
    expect(advisory.status).toBe("warn");
    expect(advisory.message).toContain("15.0%");
  });

  test("stays pass below the 5% threshold", () => {
    // 1 failed / 21 total ≈ 0.0476 → below threshold.
    seedTasks(1, 20);
    const result = akmHealth({ since: "7d" });
    const advisory = findCheck(result.advisories, "task-fail-rate");
    expect(advisory.status).toBe("pass");
  });

  test("stays pass when no cron tasks ran in the window", () => {
    const result = akmHealth({ since: "7d" });
    const advisory = findCheck(result.advisories, "task-fail-rate");
    expect(advisory.status).toBe("pass");
  });
});

/** Seed `count` completed/failed task_history rows, one per row, all sharing `taskId`. */
function seedTaskRows(taskId: string, failed: number, completed: number): void {
  const db = openStateDatabase();
  try {
    const now = Date.now();
    let offsetMs = 0;
    for (let i = 0; i < failed; i++) {
      offsetMs += 1;
      const ts = new Date(now + offsetMs).toISOString();
      upsertTaskHistory(db, {
        task_id: taskId,
        status: "failed",
        started_at: ts,
        completed_at: ts,
        failed_at: ts,
        log_path: null,
        target_kind: "improve",
        target_ref: null,
        metadata_json: JSON.stringify({ durationMs: 10 }),
      });
    }
    for (let i = 0; i < completed; i++) {
      offsetMs += 1;
      const ts = new Date(now + offsetMs).toISOString();
      upsertTaskHistory(db, {
        task_id: taskId,
        status: "completed",
        started_at: ts,
        completed_at: ts,
        failed_at: null,
        log_path: null,
        target_kind: "improve",
        target_ref: null,
        metadata_json: JSON.stringify({ durationMs: 10 }),
      });
    }
  } finally {
    db.close();
  }
}

// Item 6: a single consistently-failing task can hide behind a healthy
// aggregate when the overall population is large. `task-fail-rate` now also
// warns off the worst single task_id (min row-count floor applies).
describe("task-fail-rate worst-single-task signal (item 6)", () => {
  test("warns off the worst task when the aggregate stays below threshold", () => {
    // 96 distinct single-row healthy tasks (0 failed) + one "flaky-task" with
    // 5 rows (1 failed, 4 completed). Aggregate = 1/101 ≈ 1% (well below 5%).
    // flaky-task alone: 1/5 = 20% (>= 5% threshold, and >= the 5-row floor).
    for (let i = 0; i < 96; i++) seedTaskRows(`healthy-${i}`, 0, 1);
    seedTaskRows("flaky-task", 1, 4);

    const result = akmHealth({ since: "7d" });
    const advisory = findCheck(result.advisories, "task-fail-rate");
    expect(advisory.status).toBe("warn");
    expect(advisory.message).toContain('task "flaky-task" fails 20.0%');
    expect(advisory.evidence?.worstTaskFailRate).toEqual({ taskId: "flaky-task", rate: 0.2, rows: 5 });
    // The aggregate itself must stay below the threshold in this scenario.
    expect(advisory.evidence?.taskFailRate).toBeLessThan(0.05);
  });

  test("ignores a below-min-rows task even at a 100% local fail rate", () => {
    // 96 distinct single-row healthy tasks (0 failed) + one task with only 4
    // failed rows (below the 5-row floor). Aggregate = 4/100 = 4% (< 5%).
    for (let i = 0; i < 96; i++) seedTaskRows(`healthy2-${i}`, 0, 1);
    seedTaskRows("flaky-below-min", 4, 0);

    const result = akmHealth({ since: "7d" });
    const advisory = findCheck(result.advisories, "task-fail-rate");
    expect(advisory.evidence?.taskFailRate).toBeCloseTo(0.04, 5);
    expect(advisory.evidence?.worstTaskFailRate).toBeNull();
    expect(advisory.status).toBe("pass");
  });
});
