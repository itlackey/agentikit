// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { inspectMigrationPlan } from "../../scripts/akm-migrate/config-migrate";
import { getLegacyWorkflowDbPath } from "../../scripts/akm-migrate/migrate/legacy/legacy-paths";
import {
  getMigrationApplyJournalPath,
  getMigrationBackupRoot,
  inspectMigrationState,
} from "../../scripts/akm-migrate/migration-backup";
import { getConfigPath, getStateDbPathInDataDir } from "../../src/core/paths";
import { STATE_MIGRATIONS } from "../../src/core/state/migrations";
import { openStateDatabase } from "../../src/core/state-db";
import { openStateDbAtCeiling, PRE_CUTOVER_STATE_CEILING } from "../_fixtures/migration/seed-rows";
import { runCliCapture } from "../_helpers/cli";
import { openLegacyWorkflowDb } from "../_helpers/legacy-workflow-db";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => storage.cleanup());

function currentConfig(): Record<string, unknown> {
  return {
    configVersion: "0.9.0",
    semanticSearchMode: "off",
    bundles: { stash: { path: storage.stashDir, writable: true } },
    defaultBundle: "stash",
  };
}

function seedPreCutover(): string {
  fs.writeFileSync(
    getConfigPath(),
    `${JSON.stringify({ configVersion: "0.8.0", stashDir: storage.stashDir, sources: [] })}\n`,
    { mode: 0o600 },
  );
  openStateDbAtCeiling(getStateDbPathInDataDir(), PRE_CUTOVER_STATE_CEILING).close();
  openLegacyWorkflowDb(getLegacyWorkflowDbPath()).close();
  const prepared = path.join(storage.root, "prepared.json");
  fs.writeFileSync(
    prepared,
    `${JSON.stringify({
      configVersion: "0.9.0",
      stashDir: storage.stashDir,
      sources: [],
      semanticSearchMode: "off",
    })}\n`,
    { mode: 0o600 },
  );
  return prepared;
}

function backupRuns(): string[] {
  if (!fs.existsSync(getMigrationBackupRoot())) return [];
  return fs
    .readdirSync(getMigrationBackupRoot(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

test("status and dry-run classify work without writing config, databases, backups, or a sentinel", async () => {
  const prepared = seedPreCutover();
  const configBefore = fs.readFileSync(getConfigPath());
  const stateBefore = fs.readFileSync(getStateDbPathInDataDir());
  const workflowBefore = fs.readFileSync(getLegacyWorkflowDbPath());

  const status = await runCliCapture(["migrate", "status", "--config", prepared]);
  expect(status.code, status.stderr).toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({
    status: "ready",
    artifacts: { config: { status: "old" }, state: { status: "old" }, workflow: { status: "current" } },
    targetConfig: { status: "current", source: "prepared", path: prepared },
  });

  const dryRun = await runCliCapture(["migrate", "apply", "--config", prepared, "--dry-run"]);
  expect(dryRun.code, dryRun.stderr).toBe(0);
  expect(JSON.parse(dryRun.stdout)).toEqual(JSON.parse(status.stdout));
  expect(fs.readFileSync(getConfigPath())).toEqual(configBefore);
  expect(fs.readFileSync(getStateDbPathInDataDir())).toEqual(stateBefore);
  expect(fs.readFileSync(getLegacyWorkflowDbPath())).toEqual(workflowBefore);
  expect(backupRuns()).toEqual([]);
  expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(false);
});

test("apply uses one backup, reaches semantic outcomes, and is a no-op when rerun", async () => {
  const prepared = seedPreCutover();
  const first = await runCliCapture(["migrate", "apply", "--config", prepared]);
  expect(first.code, first.stderr).toBe(0);
  const firstResult = JSON.parse(first.stdout) as { status: string; backupPath: string; backupRunId: string };
  expect(firstResult.status).toBe("current");
  expect(path.basename(firstResult.backupPath)).toBe(firstResult.backupRunId);
  expect(backupRuns()).toEqual([firstResult.backupRunId]);
  expect(JSON.parse(fs.readFileSync(getConfigPath(), "utf8"))).toMatchObject(currentConfig());
  expect(inspectMigrationState()).toMatchObject({
    config: { status: "current" },
    state: { status: "current" },
    workflow: { status: "missing" },
    index: { status: "missing" },
  });

  const second = await runCliCapture(["migrate", "apply"]);
  expect(second.code, second.stderr).toBe(0);
  expect(JSON.parse(second.stdout)).toMatchObject({ status: "current" });
  expect(backupRuns()).toEqual([firstResult.backupRunId]);
});

test("a completed cutover can receive a later additive state schema migration without replaying data cutover", async () => {
  fs.writeFileSync(getConfigPath(), `${JSON.stringify(currentConfig())}\n`, { mode: 0o600 });
  const db = openStateDbAtCeiling(getStateDbPathInDataDir(), "020-three-db-cutover");
  db.exec(`
    CREATE TABLE akm_cutover_ledger (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      operation_id TEXT NOT NULL,
      merged_at TEXT NOT NULL
    );
    INSERT INTO akm_cutover_ledger VALUES (1, 'original-cutover', datetime('now'));
  `);
  db.close();

  expect(inspectMigrationPlan()).toMatchObject({ status: "ready", artifacts: { state: { status: "old" } } });
  const applied = await runCliCapture(["migrate", "apply"]);
  expect(applied.code, applied.stderr).toBe(0);
  expect(inspectMigrationState()).toMatchObject({ state: { status: "current" }, workflow: { status: "missing" } });

  const migrated = new Database(getStateDbPathInDataDir(), { readonly: true });
  expect(migrated.query("SELECT operation_id FROM akm_cutover_ledger WHERE singleton=1").get()).toEqual({
    operation_id: "original-cutover",
  });
  expect(migrated.query("SELECT id FROM schema_migrations ORDER BY rowid DESC LIMIT 1").get()).toEqual({
    id: STATE_MIGRATIONS.at(-1)?.id,
  });
  migrated.close();
});

test("future and holey ledgers are blocked without mutation", async () => {
  fs.writeFileSync(getConfigPath(), `${JSON.stringify(currentConfig())}\n`, { mode: 0o600 });
  const db = openStateDbAtCeiling(getStateDbPathInDataDir(), "001-initial-schema");
  db.exec("INSERT INTO schema_migrations(id) VALUES ('999-future')");
  db.close();
  const before = fs.readFileSync(getStateDbPathInDataDir());

  const status = await runCliCapture(["migrate", "status"]);
  expect(status.code).not.toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({ status: "blocked", artifacts: { state: { status: "newer" } } });
  const applied = await runCliCapture(["migrate", "apply"]);
  expect(applied.code).not.toBe(0);
  expect(fs.readFileSync(getStateDbPathInDataDir())).toEqual(before);
  expect(backupRuns()).toEqual([]);
});

test("canonical writable state opens reject an old ledger without applying it", () => {
  fs.writeFileSync(getConfigPath(), `${JSON.stringify(currentConfig())}\n`, { mode: 0o600 });
  openStateDbAtCeiling(getStateDbPathInDataDir(), PRE_CUTOVER_STATE_CEILING).close();
  expect(() => openStateDatabase()).toThrow(/obsolete writable schema|migrate apply/i);
  expect(inspectMigrationState().state.status).toBe("old");
});
