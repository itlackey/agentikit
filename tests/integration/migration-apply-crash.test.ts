// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getLegacyWorkflowDbPath } from "../../scripts/akm-migrate/migrate/legacy/legacy-paths";
import { getMigrationApplyJournalPath, inspectMigrationState } from "../../scripts/akm-migrate/migration-backup";
import { getConfigPath, getStateDbPathInDataDir } from "../../src/core/paths";
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

function seedMigration(): string {
  fs.writeFileSync(
    getConfigPath(),
    `${JSON.stringify({ configVersion: "0.8.0", stashDir: storage.stashDir, sources: [] })}\n`,
    { mode: 0o600 },
  );
  openStateDbAtCeiling(getStateDbPathInDataDir(), PRE_CUTOVER_STATE_CEILING).close();
  const workflow = openLegacyWorkflowDb(getLegacyWorkflowDbPath());
  workflow
    .prepare(
      "INSERT INTO workflow_runs(id, workflow_ref, workflow_title, status, params_json, created_at, updated_at) VALUES (?, ?, ?, 'active', '{}', ?, ?)",
    )
    .run("run-live", "workflows/example", "Example", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  workflow.close();

  const prepared = path.join(storage.root, "prepared-0.9.json");
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

test("a failed apply keeps one phase-free sentinel and reruns to semantic completion", async () => {
  const prepared = seedMigration();
  const child = Bun.spawn(["bun", "src/cli.ts", "migrate", "apply", "--config", prepared], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: { ...process.env, AKM_TEST_MIGRATION_FAIL_INDEX_QUARANTINE: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, , stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, stderr).not.toBe(0);

  const sentinelPath = getMigrationApplyJournalPath();
  const sentinel = JSON.parse(fs.readFileSync(sentinelPath, "utf8")) as Record<string, unknown>;
  expect(sentinel).toMatchObject({ formatVersion: 1, version: "0.9.0" });
  expect(sentinel.phase).toBeUndefined();
  expect(sentinel.generation).toBeUndefined();
  expect(fs.existsSync(String(sentinel.backupPath))).toBe(true);
  expect(() => openStateDatabase()).toThrow(/recovery is pending/i);

  const status = await runCliCapture(["migrate", "status"]);
  expect(status.code, status.stderr).toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({
    status: "ready",
    activeOperation: { kind: "apply", sentinelPath },
  });

  const now = Date.now();
  const workflow = new Database(getLegacyWorkflowDbPath());
  workflow
    .prepare("UPDATE workflow_runs SET engine_lease_holder = ?, engine_lease_until = ? WHERE id = ?")
    .run("older-worker", new Date(now + 60_000).toISOString(), "run-live");
  workflow.close();

  const blocked = await runCliCapture(["migrate", "apply"]);
  expect(blocked.code).not.toBe(0);
  expect(blocked.stderr).toMatch(/run=run-live,holder=older-worker/);
  expect(fs.existsSync(sentinelPath)).toBe(true);
  expect(fs.existsSync(getLegacyWorkflowDbPath())).toBe(true);

  const expired = new Database(getLegacyWorkflowDbPath());
  expired
    .prepare("UPDATE workflow_runs SET engine_lease_until = ? WHERE id = ?")
    .run(new Date(now - 60_000).toISOString(), "run-live");
  expired.close();

  const resumed = await runCliCapture(["migrate", "apply"]);
  expect(resumed.code, resumed.stderr).toBe(0);
  expect(fs.existsSync(sentinelPath)).toBe(false);
  expect(inspectMigrationState()).toMatchObject({
    config: { status: "current" },
    state: { status: "current" },
    workflow: { status: "missing" },
  });
});

test("a successful apply leaves no incomplete sentinel", async () => {
  const prepared = seedMigration();
  const applied = await runCliCapture(["migrate", "apply", "--config", prepared]);
  expect(applied.code, applied.stderr).toBe(0);
  expect(JSON.parse(applied.stdout)).toMatchObject({ status: "current" });
  expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(false);
});
