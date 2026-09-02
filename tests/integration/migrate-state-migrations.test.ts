// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm migrate` owns the pending state.db migration step alongside its task
 * and config migrations: `status` names what is pending, `apply` applies it --
 * historical-destructive migrations included, with the verified safety copy --
 * and does so BEFORE the task migrators, which open state.db themselves. An
 * ordinary managed open refuses migration 018 by design, so this and
 * `akm upgrade` are the only two routes that admit it (#895).
 *
 * Integration: seeds and opens a real state.db under an isolated data dir.
 * The task migrators are the same stand-in `tests/migrate-orchestration.test.ts`
 * uses; what is under test here is the state step and its ordering.
 */

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { EXIT_CODES } from "../../src/cli/shared";
import { type RunMigrationTool, runMigrateSubcommand } from "../../src/commands/migrate-cli";
import { resetConfigCache } from "../../src/core/config/config";
import { STATE_MIGRATIONS } from "../../src/core/state/migrations";
import { getStateDbPath, openStateDatabase } from "../../src/core/state-db";
import { initOutputMode, resetOutputMode } from "../../src/output/context";
import { openDatabase } from "../../src/storage/database";
import { runMigrations } from "../../src/storage/engines/sqlite-migrations";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

const BEFORE_018 = STATE_MIGRATIONS.slice(
  0,
  STATE_MIGRATIONS.findIndex((migration) => migration.id === "018-drop-dead-lane-schema"),
);
const FROM_018 = STATE_MIGRATIONS.slice(BEFORE_018.length).map((migration) => migration.id);

let storage: IsolatedAkmStorage;
const priorExitCode = process.exitCode;
beforeEach(() => {
  storage = withIsolatedAkmStorage();
  resetConfigCache();
});
afterEach(() => {
  process.exitCode = priorExitCode;
  resetOutputMode();
  resetConfigCache();
  storage.cleanup();
});

/** A state.db whose ledger stops exactly before 018, holding a dead-lane row 018 drops. */
function seedBefore018(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const seeded = openDatabase(file);
  runMigrations(seeded, BEFORE_018);
  seeded
    .prepare("INSERT INTO consolidation_judged (entry_key, content_hash, judged_at, outcome) VALUES (?, ?, ?, ?)")
    .run("memories/hostile", "seeded-before-018", "2026-08-24T03:00:00.000Z", "actioned");
  seeded.close();
}

function ledgerLength(file: string): number {
  const db = openDatabase(file, { readonly: true });
  try {
    return (db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count;
  } finally {
    db.close();
  }
}

function stateDbOpens(file: string): boolean {
  try {
    openStateDatabase(file).close();
    return true;
  } catch {
    return false;
  }
}

/** A stand-in task migrator: always "current", with a hook that runs at each call. */
function fakeRunner(onCall: () => void = () => {}): { runTool: RunMigrationTool; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runTool: async (args: readonly string[]) => {
      calls.push([...args]);
      onCall();
      return { status: EXIT_CODES.SUCCESS, stdout: JSON.stringify({ status: "current" }), stderr: "" };
    },
  };
}

function capturePrintedPlan(): { read: () => Record<string, unknown>; restore: () => void } {
  initOutputMode(["--format", "json"]);
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    lines.push(parts.join(" "));
  });
  return {
    read: () => JSON.parse(lines.join("\n")) as Record<string, unknown>,
    restore: () => spy.mockRestore(),
  };
}

async function runAndRead(
  command: "migrate-status" | "migrate-apply",
  genOne: string[],
  genTwo: string[],
  runTool: RunMigrationTool,
): Promise<Record<string, unknown>> {
  const printed = capturePrintedPlan();
  try {
    await runMigrateSubcommand(command, genOne, genTwo, runTool);
    return printed.read();
  } finally {
    printed.restore();
  }
}

test("migrate status names the pending state migrations without applying them", async () => {
  const file = getStateDbPath();
  seedBefore018(file);

  const plan = await runAndRead("migrate-status", ["status"], ["task-v4-status"], fakeRunner().runTool);

  expect(plan.stateMigrations).toEqual({ pending: FROM_018 });
  // Pending is "ready", not "blocked": the combined status and exit code are untouched.
  expect(plan.status).toBe("current");
  expect(process.exitCode).toBe(priorExitCode);
  expect(ledgerLength(file)).toBe(BEFORE_018.length);
  // The ordinary open still refuses, and now points at this command.
  expect(() => openStateDatabase(file).close()).toThrow(/018-drop-dead-lane-schema.*akm migrate apply/i);
});

test("migrate apply applies the pending state migrations, with the safety copy, before the task migrators run", async () => {
  const file = getStateDbPath();
  seedBefore018(file);
  // Each task migrator opens state.db itself; record whether it could have.
  const openableAtToolCall: boolean[] = [];
  const { runTool, calls } = fakeRunner(() => openableAtToolCall.push(stateDbOpens(file)));

  const plan = await runAndRead("migrate-apply", ["apply"], ["task-v4-apply"], runTool);

  const state = plan.stateMigrations as { applied: string[]; safetyCopyPath?: string };
  expect(state.applied).toEqual(FROM_018);
  expect(state.safetyCopyPath).toMatch(/state\.db\.pre-018-drop-dead-lane-schema\./);
  expect(fs.existsSync(state.safetyCopyPath as string)).toBe(true);
  expect(ledgerLength(file)).toBe(STATE_MIGRATIONS.length);
  expect(calls.map((call) => call[0])).toEqual(["apply", "task-v4-apply"]);
  expect(openableAtToolCall).toEqual([true, true]);
  // The row 018 dropped survives in the verified safety copy.
  const copy = openDatabase(state.safetyCopyPath as string, { readonly: true });
  try {
    expect((copy.prepare("SELECT COUNT(*) AS count FROM consolidation_judged").get() as { count: number }).count).toBe(
      1,
    );
  } finally {
    copy.close();
  }
});

test("migrate apply --dry-run reports the pending state migrations and applies nothing", async () => {
  const file = getStateDbPath();
  seedBefore018(file);

  const plan = await runAndRead(
    "migrate-apply",
    ["apply", "--dry-run"],
    ["task-v4-apply", "--dry-run"],
    fakeRunner().runTool,
  );

  expect(plan.stateMigrations).toEqual({ pending: FROM_018 });
  expect(ledgerLength(file)).toBe(BEFORE_018.length);
  expect(stateDbOpens(file)).toBe(false);
});

test("a current state.db reports nothing pending and applies nothing", async () => {
  const file = getStateDbPath();
  openStateDatabase(file).close();

  const status = await runAndRead("migrate-status", ["status"], ["task-v4-status"], fakeRunner().runTool);
  expect(status.stateMigrations).toEqual({ pending: [] });

  const apply = await runAndRead("migrate-apply", ["apply"], ["task-v4-apply"], fakeRunner().runTool);
  expect(apply.stateMigrations).toEqual({ applied: [] });
  expect(fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".bak"))).toEqual([]);
});
