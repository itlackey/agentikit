// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm health` used to let the managed
 * `openStateDatabase` call throw when state.db held a pending
 * historical-destructive migration (018-drop-dead-lane-schema) — the whole
 * command crashed with a config-error exit (78) instead of reporting the
 * ordinary `fail` status its callers already know how to parse. Bundlers
 * (OpenPalm) grepped the refusal's error text to detect this case; that grep
 * is the coupling this test pins the replacement for.
 *
 * `akmHealth()` must instead report a `state-db-migrations` hard check and
 * exit through the same `fail` path as any other hard-check failure — never
 * throw, never exit 78.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runMigration } from "../../../scripts/akm-migrate/run-migrate";
import { EXIT_CODES } from "../../../src/cli/shared";
import { akmHealth } from "../../../src/commands/health";
import { resetConfigCache } from "../../../src/core/config/config";
import { STATE_MIGRATIONS } from "../../../src/core/state/migrations";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import { openDatabase } from "../../../src/storage/database";
import { runMigrations } from "../../../src/storage/engines/sqlite-migrations";
import { runCliCapture } from "../../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const BEFORE_018 = STATE_MIGRATIONS.slice(
  0,
  STATE_MIGRATIONS.findIndex((migration) => migration.id === "018-drop-dead-lane-schema"),
);

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  resetConfigCache();
});

afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

/** A state.db whose ledger stops exactly before 018 (mirrors migrate-state-migrations.test.ts). */
function seedBefore018(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const seeded = openDatabase(file);
  runMigrations(seeded, BEFORE_018);
  seeded.close();
}

function findHardCheck(result: Awaited<ReturnType<typeof akmHealth>>, name: string) {
  const found = result.hardChecks.find((check) => check.name === name);
  if (!found) throw new Error(`expected a hard check named ${name}`);
  return found;
}

test("a pending historical-destructive migration reports as a fail check, not a crash", async () => {
  const file = getStateDbPath();
  seedBefore018(file);

  // RED on the old code: `akmHealth()` let the managed `openStateDatabase`
  // call throw "Refusing to apply historical destructive state migration
  // 018-drop-dead-lane-schema during an ordinary managed open. Run `akm
  // upgrade`..." straight out of this call — no envelope was ever produced.
  const result = await akmHealth();

  const check = findHardCheck(result, "state-db-migrations");
  expect(check.status).toBe("fail");
  expect((check.evidence?.pending as string[])[0]).toBe("018-drop-dead-lane-schema");
  expect(result!.status).toBe("fail");
  expect(result!.ok).toBe(false);
});

test("the CLI exits health's normal fail code (not 78) when a migration is pending", async () => {
  const file = getStateDbPath();
  seedBefore018(file);

  // RED on the old code: this exited EXIT_CODES.CONFIG (78) via the thrown
  // ConfigError wrapping the migration-refusal message, and the stdout JSON
  // envelope was an `{ok:false, error, code}` error shape, not a health
  // result carrying `hardChecks`.
  const { code, stdout } = await runCliCapture(["health", "--format", "json"]);
  expect(code).toBe(EXIT_CODES.GENERAL);
  expect(code).not.toBe(EXIT_CODES.CONFIG);

  const parsed = JSON.parse(stdout) as { hardChecks?: Array<{ name: string; status: string }> };
  const check = parsed.hardChecks?.find((c) => c.name === "state-db-migrations");
  expect(check?.status).toBe("fail");
});

test("applying the pending migration flips the check back to pass", async () => {
  const file = getStateDbPath();
  seedBefore018(file);

  await runMigration({ apply: true });

  const result = await akmHealth();
  const check = findHardCheck(result, "state-db-migrations");
  expect(check.status).toBe("pass");
  expect(check.evidence?.pending).toEqual([]);
});

test("a current, freshly-created state.db reports pass with no pending migrations", async () => {
  openStateDatabase(getStateDbPath()).close();

  const result = await akmHealth();
  const check = findHardCheck(result, "state-db-migrations");
  expect(check.status).toBe("pass");
  expect(check.evidence?.pending).toEqual([]);
});
