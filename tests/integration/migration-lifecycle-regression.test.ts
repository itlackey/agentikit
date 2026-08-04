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

/**
 * R-089: a config.json written by 0.8.x's own `akm setup`/`akm init` can carry
 * the pre-cutover source shape (`stashDir`/`sources`) with NO `configVersion`
 * key at all — 0.8 only stamps `configVersion` when a 0.7-era migration did
 * substantive work (`if (changed)`), so a config with nothing to carry forward
 * (a fresh 0.8 install) is never stamped. Model this exactly like
 * {@link seedPreCutover} but drop `configVersion` from the ACTIVE config only —
 * the prepared 0.9 config an operator hands to `--config` still declares
 * `configVersion: "0.9.0"` (required by `parseAndValidateConfigText`).
 */
function seedPreCutoverUnversioned(): string {
  fs.writeFileSync(getConfigPath(), `${JSON.stringify({ stashDir: storage.stashDir, sources: [] })}\n`, {
    mode: 0o600,
  });
  openStateDbAtCeiling(getStateDbPathInDataDir(), PRE_CUTOVER_STATE_CEILING).close();
  openLegacyWorkflowDb(getLegacyWorkflowDbPath()).close();
  const prepared = path.join(storage.root, "prepared-unversioned.json");
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

test("a fresh-0.8 config with no configVersion key is classified old (not inconsistent) and migrates cleanly", async () => {
  const prepared = seedPreCutoverUnversioned();

  // Before the fix this artifact was `inconsistent`, an unconditional
  // blocker, so `status` was permanently "blocked" no matter what the
  // operator passed via `--config`.
  const status = await runCliCapture(["migrate", "status", "--config", prepared]);
  expect(status.code, status.stderr).toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({
    status: "ready",
    artifacts: { config: { status: "old" }, state: { status: "old" }, workflow: { status: "current" } },
  });

  const applied = await runCliCapture(["migrate", "apply", "--config", prepared]);
  expect(applied.code, applied.stderr).toBe(0);
  const result = JSON.parse(applied.stdout) as { status: string };
  expect(result.status).toBe("current");
  expect(JSON.parse(fs.readFileSync(getConfigPath(), "utf8"))).toMatchObject(currentConfig());
  expect(inspectMigrationState()).toMatchObject({
    config: { status: "current" },
    state: { status: "current" },
    workflow: { status: "missing" },
  });

  // Idempotent re-run: the (now current) active config.json is a valid
  // target on its own, no `--config` needed.
  const rerun = await runCliCapture(["migrate", "apply"]);
  expect(rerun.code, rerun.stderr).toBe(0);
  expect(JSON.parse(rerun.stdout)).toMatchObject({ status: "current" });
});

test("a machine with no akm state at all reports not-applicable, not blocked", async () => {
  expect(fs.existsSync(getConfigPath())).toBe(false);
  expect(fs.existsSync(getStateDbPathInDataDir())).toBe(false);
  expect(fs.existsSync(getLegacyWorkflowDbPath())).toBe(false);

  const plan = inspectMigrationPlan();
  expect(plan).toMatchObject({
    status: "not-applicable",
    blockers: [],
    message: "No akm installation found; nothing to migrate.",
    artifacts: {
      config: { status: "missing" },
      state: { status: "missing" },
      workflow: { status: "missing" },
      index: { status: "missing" },
    },
  });

  const status = await runCliCapture(["migrate", "status"]);
  expect(status.code, status.stderr).toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({ status: "not-applicable" });

  const applied = await runCliCapture(["migrate", "apply"]);
  expect(applied.code, applied.stderr).toBe(0);
  expect(JSON.parse(applied.stdout)).toMatchObject({ status: "not-applicable" });
  expect(fs.existsSync(getConfigPath())).toBe(false);
  expect(backupRuns()).toEqual([]);
});

test("a config.json with a present-but-garbage configVersion stays inconsistent/blocked", async () => {
  fs.writeFileSync(
    getConfigPath(),
    `${JSON.stringify({ configVersion: "garbage", stashDir: storage.stashDir, sources: [] })}\n`,
    { mode: 0o600 },
  );
  const before = fs.readFileSync(getConfigPath());

  expect(inspectMigrationState().config).toMatchObject({
    status: "inconsistent",
    detail: "configVersion is missing or invalid",
  });

  const status = await runCliCapture(["migrate", "status"]);
  expect(status.code).not.toBe(0);
  const plan = JSON.parse(status.stdout) as { status: string; blockers: string[] };
  expect(plan.status).toBe("blocked");
  expect(plan.blockers.some((blocker) => blocker.includes("config.json is inconsistent"))).toBe(true);

  const applied = await runCliCapture(["migrate", "apply"]);
  expect(applied.code).not.toBe(0);
  expect(fs.readFileSync(getConfigPath())).toEqual(before);
  expect(backupRuns()).toEqual([]);
});

/**
 * R-091: 0.8's own `akm workflow create` produced heading-based workflow
 * definitions with no frontmatter `steps:` list. 0.9 requires `steps:` and
 * does NOT auto-translate the old format (documented, intentionally not
 * built here) — so after a migration this asset fails 0.9 structural
 * validation and is invisible to `akm search --type workflow`, yet its
 * `active` run row survives the cutover (only the run-key spelling is
 * rewritten, `workflow:<n>` → `workflows/<n>`). Migrate apply must still
 * SUCCEED, and must name the run and the fix in a non-fatal warning.
 */
test("migrate apply warns (non-fatally) about an active run whose workflow asset fails 0.9 structural validation", async () => {
  const prepared = seedPreCutover();
  fs.mkdirSync(path.join(storage.stashDir, "workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(storage.stashDir, "workflows", "ship.md"),
    `---
name: ship
type: workflow
description: Ship it
---

## Step 1

Do the thing.
`,
  );
  const legacyWorkflowDb = openLegacyWorkflowDb(getLegacyWorkflowDbPath());
  legacyWorkflowDb
    .prepare(
      `INSERT INTO workflow_runs (id, workflow_ref, workflow_title, status, params_json, created_at, updated_at)
       VALUES ('run-orphan', 'workflow:ship', 'Ship it', 'active', '{}', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')`,
    )
    .run();
  legacyWorkflowDb.close();

  const applied = await runCliCapture(["migrate", "apply", "--config", prepared]);
  expect(applied.code, applied.stderr).toBe(0);
  expect(JSON.parse(applied.stdout)).toMatchObject({ status: "current" });

  // The migrator must not silently delete or abandon the run — that decision
  // belongs to the operator.
  const migratedState = new Database(getStateDbPathInDataDir(), { readonly: true });
  try {
    expect(migratedState.query("SELECT status, workflow_ref FROM workflow_runs WHERE id = 'run-orphan'").get()).toEqual(
      { status: "active", workflow_ref: "workflows/ship" },
    );
  } finally {
    migratedState.close();
  }

  // The non-fatal warning names the run, the asset, and both remedies —
  // forwarded from the akm-migrate subprocess's stderr through to the CLI's.
  expect(applied.stderr).toContain("run-orphan");
  expect(applied.stderr).toContain("workflows/ship");
  expect(applied.stderr).toContain("akm workflow abandon run-orphan");
});
