// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { inspectMigrationPlan } from "../../scripts/akm-migrate/config-migrate";
import { getLegacyWorkflowDbPath } from "../../scripts/akm-migrate/migrate/legacy/legacy-paths";
import { cutoverMergeCommitted } from "../../scripts/akm-migrate/migrate/legacy/three-db-cutover";
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
type MigrationSeedDatabase = ReturnType<typeof openStateDbAtCeiling>;

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

test("a ledger-current WAL database without a cutover marker remains unresolved until residual refs are cut over", async () => {
  fs.writeFileSync(getConfigPath(), `${JSON.stringify(currentConfig())}\n`, { mode: 0o600 });
  const assetPath = path.join(storage.stashDir, "memories", "wal-note.md");
  fs.mkdirSync(path.dirname(assetPath), { recursive: true });
  fs.writeFileSync(assetPath, "# WAL note\n");

  const statePath = getStateDbPathInDataDir();
  const seeded = openStateDbAtCeiling(getStateDbPathInDataDir(), STATE_MIGRATIONS.at(-1)!.id);
  const insert = seeded.prepare(
    "INSERT INTO proposals(id, stash_dir, ref, status, source, created_at, updated_at, content, frontmatter_json, metadata_json) VALUES (?, ?, ?, 'pending', 'legacy', 'c', 'u', 'body', NULL, '{}')",
  );
  insert.run("wal-residual", storage.stashDir, "memory:wal-note");
  seeded.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  seeded.close();

  const wal = new Database(statePath);
  expect((wal.query("PRAGMA journal_mode=WAL").get() as { journal_mode: string }).journal_mode).toBe("wal");
  wal.close();

  expect(cutoverMergeCommitted(statePath)).toBe(false);
  expect(inspectMigrationPlan()).toMatchObject({ status: "ready", artifacts: { state: { status: "current" } } });

  const applied = await runCliCapture(["migrate", "apply"]);
  expect(applied.code, applied.stderr).toBe(0);
  expect(cutoverMergeCommitted(statePath)).toBe(true);
  expect(fs.existsSync(`${statePath}-wal`)).toBe(false);
  expect(fs.existsSync(`${statePath}-shm`)).toBe(false);
  expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(false);

  const current = new Database(statePath, { readonly: true });
  expect((current.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("delete");
  expect(current.query("SELECT ref FROM proposals WHERE id='wal-residual'").get()).toEqual({
    ref: "stash//memories/wal-note",
  });
  expect(current.query("SELECT operation_id FROM akm_cutover_ledger WHERE singleton=1").get()).toMatchObject({
    operation_id: expect.any(String),
  });
  expect(current.query("SELECT backup_run_id, task_generation FROM akm_migration_completion").get()).toMatchObject({
    backup_run_id: expect.any(String),
    task_generation: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  current.close();
});

const MATRIX_MEMORY_LEGACY_REF = ["memory", "table-matrix"].join(":");
const MATRIX_MEMORY_REF = "stash//memories/table-matrix";

test.each([
  {
    label: "asset salience",
    legacyRef: MATRIX_MEMORY_LEGACY_REF,
    expectedRef: MATRIX_MEMORY_REF,
    insert: (db: MigrationSeedDatabase, ref: string) =>
      db.prepare("INSERT INTO asset_salience(asset_ref, updated_at) VALUES (?, 1)").run(ref),
    select: (db: Database) => (db.query("SELECT asset_ref AS ref FROM asset_salience").get() as { ref: string }).ref,
  },
  {
    label: "asset outcome",
    legacyRef: MATRIX_MEMORY_LEGACY_REF,
    expectedRef: MATRIX_MEMORY_REF,
    insert: (db: MigrationSeedDatabase, ref: string) =>
      db.prepare("INSERT INTO asset_outcome(asset_ref, updated_at) VALUES (?, 1)").run(ref),
    select: (db: Database) => (db.query("SELECT asset_ref AS ref FROM asset_outcome").get() as { ref: string }).ref,
  },
  {
    label: "event history",
    legacyRef: MATRIX_MEMORY_LEGACY_REF,
    expectedRef: MATRIX_MEMORY_REF,
    insert: (db: MigrationSeedDatabase, ref: string) =>
      db.prepare("INSERT INTO events(event_type, ts, ref, metadata_json) VALUES ('probe', 'now', ?, '{}')").run(ref),
    select: (db: Database) => (db.query("SELECT ref FROM events").get() as { ref: string }).ref,
  },
  {
    label: "task history",
    legacyRef: MATRIX_MEMORY_LEGACY_REF,
    expectedRef: MATRIX_MEMORY_REF,
    insert: (db: MigrationSeedDatabase, ref: string) =>
      db
        .prepare(
          "INSERT INTO task_history(task_id, status, started_at, target_ref, metadata_json) VALUES ('task', 'done', 'now', ?, '{}')",
        )
        .run(ref),
    select: (db: Database) => (db.query("SELECT target_ref AS ref FROM task_history").get() as { ref: string }).ref,
  },
  {
    label: "proposal fingerprint",
    legacyRef: MATRIX_MEMORY_LEGACY_REF,
    expectedRef: MATRIX_MEMORY_REF,
    insert: (db: MigrationSeedDatabase, ref: string) =>
      db
        .prepare(
          "INSERT INTO proposal_fingerprints(stash_dir, fingerprint, ref, source, created_at) VALUES ('stash', 'fingerprint', ?, 'probe', 'now')",
        )
        .run(ref),
    select: (db: Database) => (db.query("SELECT ref FROM proposal_fingerprints").get() as { ref: string }).ref,
  },
  {
    label: "canary query",
    legacyRef: MATRIX_MEMORY_LEGACY_REF,
    expectedRef: MATRIX_MEMORY_REF,
    insert: (db: MigrationSeedDatabase, ref: string) =>
      db
        .prepare(
          "INSERT INTO canary_queries(canary_set_id, anchor_ref, query, created_at) VALUES ('set', ?, 'query', 'now')",
        )
        .run(ref),
    select: (db: Database) => (db.query("SELECT anchor_ref AS ref FROM canary_queries").get() as { ref: string }).ref,
  },
  {
    label: "usage history",
    legacyRef: MATRIX_MEMORY_LEGACY_REF,
    expectedRef: MATRIX_MEMORY_REF,
    insert: (db: MigrationSeedDatabase, ref: string) =>
      db.prepare("INSERT INTO usage_events(event_type, entry_ref, source) VALUES ('probe', ?, 'user')").run(ref),
    select: (db: Database) => (db.query("SELECT entry_ref AS ref FROM usage_events").get() as { ref: string }).ref,
  },
  {
    label: "workflow runs",
    legacyRef: ["workflow", "table-matrix"].join(":"),
    expectedRef: "stash//workflows/table-matrix",
    insert: (db: MigrationSeedDatabase, ref: string) =>
      db
        .prepare(
          "INSERT INTO workflow_runs(id, workflow_ref, workflow_title, status, params_json, created_at, updated_at) VALUES ('run', ?, 'probe', 'completed', '{}', 'now', 'now')",
        )
        .run(ref),
    select: (db: Database) => (db.query("SELECT workflow_ref AS ref FROM workflow_runs").get() as { ref: string }).ref,
  },
])("a markerless current ledger repairs a mapped residual in $label under DELETE mode", async ({
  insert,
  select,
  legacyRef,
  expectedRef,
}) => {
  fs.writeFileSync(getConfigPath(), `${JSON.stringify(currentConfig())}\n`, { mode: 0o600 });
  const assetPath = path.join(
    storage.stashDir,
    legacyRef.startsWith("workflow:") ? "workflows" : "memories",
    "table-matrix.md",
  );
  fs.mkdirSync(path.dirname(assetPath), { recursive: true });
  fs.writeFileSync(assetPath, "# Table matrix\n");
  const statePath = getStateDbPathInDataDir();
  const seeded = openStateDbAtCeiling(statePath, STATE_MIGRATIONS.at(-1)!.id);
  insert(seeded, legacyRef);
  seeded.close();

  expect(cutoverMergeCommitted(statePath)).toBe(false);
  expect(inspectMigrationPlan()).toMatchObject({ status: "ready", artifacts: { state: { status: "current" } } });
  const applied = await runCliCapture(["migrate", "apply"]);
  expect(applied.code, applied.stderr).toBe(0);
  expect(cutoverMergeCommitted(statePath)).toBe(true);
  const current = new Database(statePath, { readonly: true });
  expect(select(current)).toBe(expectedRef);
  expect(current.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
  current.close();
  expect(fs.existsSync(`${statePath}-wal`)).toBe(false);
  expect(fs.existsSync(`${statePath}-shm`)).toBe(false);
  const provenance = new Database(statePath, { readonly: true });
  expect(provenance.query("SELECT backup_run_id, task_generation FROM akm_migration_completion").get()).toMatchObject({
    backup_run_id: expect.any(String),
    task_generation: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  provenance.close();
});

test("an unmappable asset-salience ref in a markerless current WAL ledger blocks without mutation", async () => {
  fs.writeFileSync(getConfigPath(), `${JSON.stringify(currentConfig())}\n`, { mode: 0o600 });
  const statePath = getStateDbPathInDataDir();
  openStateDbAtCeiling(statePath, STATE_MIGRATIONS.at(-1)!.id).close();
  const writer = new Database(statePath);
  try {
    expect(writer.query("PRAGMA journal_mode=WAL").get()).toEqual({ journal_mode: "wal" });
    writer.exec("PRAGMA wal_autocheckpoint=0");
    writer.prepare("INSERT INTO asset_salience(asset_ref, updated_at) VALUES ('memory:invalid-unrekeyed', 1)").run();
    const durablePaths = [statePath, `${statePath}-wal`];
    const shmPath = `${statePath}-shm`;
    expect([...durablePaths, shmPath].every((filePath) => fs.existsSync(filePath))).toBe(true);
    const shmMode = fs.statSync(shmPath).mode & 0o777;
    const before = durablePaths.map((filePath) => ({
      filePath,
      bytes: fs.readFileSync(filePath),
      mode: fs.statSync(filePath).mode & 0o777,
    }));

    const status = await runCliCapture(["migrate", "status"]);
    expect(status.code).not.toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ status: "blocked" });
    expect(status.stdout).toMatch(/asset_salience\.asset_ref.*unmappable.*memory:invalid-unrekeyed/i);
    const applied = await runCliCapture(["migrate", "apply"]);
    expect(applied.code).not.toBe(0);
    expect(
      durablePaths.map((filePath) => ({
        filePath,
        bytes: fs.readFileSync(filePath),
        mode: fs.statSync(filePath).mode & 0o777,
      })),
    ).toEqual(before);
    // SQLite readers legitimately update lock/read-mark bytes in the shared-
    // memory coordination file; durable database and WAL bytes stay exact.
    expect(fs.existsSync(shmPath)).toBe(true);
    expect(fs.statSync(shmPath).mode & 0o777).toBe(shmMode);
    expect(cutoverMergeCommitted(statePath)).toBe(false);
    expect(backupRuns()).toEqual([]);
    expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(false);
  } finally {
    writer.close();
  }
});

test("an unmapped workflow run in a markerless current ledger blocks before backup with exact bytes", async () => {
  fs.writeFileSync(getConfigPath(), `${JSON.stringify(currentConfig())}\n`, { mode: 0o600 });
  const statePath = getStateDbPathInDataDir();
  const seeded = openStateDbAtCeiling(statePath, STATE_MIGRATIONS.at(-1)!.id);
  const legacyRef = ["workflow", "missing"].join(":");
  seeded
    .prepare(
      "INSERT INTO workflow_runs(id, workflow_ref, workflow_title, status, params_json, created_at, updated_at) VALUES ('unmapped-run', ?, 'Missing', 'completed', '{}', 'c', 'u')",
    )
    .run(legacyRef);
  seeded.close();
  const beforeConfig = fs.readFileSync(getConfigPath());
  const beforeState = fs.readFileSync(statePath);
  const beforeMode = fs.statSync(statePath).mode & 0o777;

  const status = await runCliCapture(["migrate", "status"]);
  expect(status.code).not.toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({ status: "blocked" });
  expect(status.stdout).toMatch(/workflow_runs\.workflow_ref.*unmapped/i);
  expect(status.stdout).toContain(legacyRef);
  const applied = await runCliCapture(["migrate", "apply"]);
  expect(applied.code).not.toBe(0);
  expect(fs.readFileSync(getConfigPath())).toEqual(beforeConfig);
  expect(fs.readFileSync(statePath)).toEqual(beforeState);
  expect(fs.statSync(statePath).mode & 0o777).toBe(beforeMode);
  expect(cutoverMergeCommitted(statePath)).toBe(false);
  expect(backupRuns()).toEqual([]);
  expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(false);
});

test("a mismatched npm workflow map target blocks read-only under a committed marker", async () => {
  fs.writeFileSync(getConfigPath(), `${JSON.stringify(currentConfig())}\n`, { mode: 0o600 });
  const statePath = getStateDbPathInDataDir();
  const seeded = openStateDbAtCeiling(statePath, STATE_MIGRATIONS.at(-1)!.id);
  seeded.exec(`
    CREATE TABLE akm_cutover_ledger (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      operation_id TEXT NOT NULL,
      merged_at TEXT NOT NULL
    );
    INSERT INTO akm_cutover_ledger VALUES (1, 'original-cutover', datetime('now'));
  `);
  const legacyRef = `${["npm", "@scope/pkg"].join(":")}//${["workflow", "ship"].join(":")}`;
  seeded
    .prepare(
      "INSERT INTO workflow_runs(id, workflow_ref, workflow_title, status, params_json, created_at, updated_at) VALUES ('npm-run', ?, 'Ship', 'completed', '{}', 'c', 'u')",
    )
    .run(legacyRef);
  seeded.close();
  const mapPath = path.join(path.dirname(getMigrationApplyJournalPath()), "completed-cutover-refmap.json");
  fs.mkdirSync(path.dirname(mapPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    mapPath,
    `${JSON.stringify({ formatVersion: 1, entries: { [legacyRef]: "pkg//workflows/other" } }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const before = [getConfigPath(), statePath, mapPath].map((filePath) => ({
    filePath,
    bytes: fs.readFileSync(filePath),
    mode: fs.statSync(filePath).mode & 0o777,
  }));

  const status = await runCliCapture(["migrate", "status"]);
  expect(status.code).not.toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({ status: "blocked" });
  expect(status.stdout).toMatch(/workflow_runs\.workflow_ref.*npm:@scope\/pkg.*invalid mapped target/i);
  const applied = await runCliCapture(["migrate", "apply"]);
  expect(applied.code).not.toBe(0);
  expect(
    before.map(({ filePath }) => ({
      filePath,
      bytes: fs.readFileSync(filePath),
      mode: fs.statSync(filePath).mode & 0o777,
    })),
  ).toEqual(before);
  expect(cutoverMergeCommitted(statePath)).toBe(true);
  expect(backupRuns()).toEqual([]);
  expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(false);
});

test("a committed marker uses its persisted map to repair a later durable ref and converge WAL to one file", async () => {
  fs.writeFileSync(getConfigPath(), `${JSON.stringify(currentConfig())}\n`, { mode: 0o600 });
  const statePath = getStateDbPathInDataDir();
  const seeded = openStateDbAtCeiling(statePath, STATE_MIGRATIONS.at(-1)!.id);
  seeded.exec(`
    CREATE TABLE akm_cutover_ledger (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      operation_id TEXT NOT NULL,
      merged_at TEXT NOT NULL
    );
    INSERT INTO akm_cutover_ledger VALUES (1, 'original-cutover', datetime('now'));
  `);
  const legacyRef = ["memory", "late-ref"].join(":");
  const legacyWorkflowRef = ["workflow", "late-workflow"].join(":");
  seeded.prepare("INSERT INTO asset_salience(asset_ref, updated_at) VALUES (?, 1)").run(legacyRef);
  seeded
    .prepare(
      "INSERT INTO workflow_runs(id, workflow_ref, workflow_title, status, params_json, created_at, updated_at) VALUES ('late-run', ?, 'Late', 'completed', '{}', 'c', 'u')",
    )
    .run(legacyWorkflowRef);
  seeded.close();
  const mapPath = path.join(path.dirname(getMigrationApplyJournalPath()), "completed-cutover-refmap.json");
  fs.mkdirSync(path.dirname(mapPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    mapPath,
    `${JSON.stringify(
      {
        formatVersion: 1,
        entries: {
          [legacyRef]: "stash//memories/late-ref",
          [legacyWorkflowRef]: "stash//workflows/late-workflow",
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const wal = new Database(statePath);
  expect(wal.query("PRAGMA journal_mode=WAL").get()).toEqual({ journal_mode: "wal" });
  wal.close();

  expect(inspectMigrationPlan()).toMatchObject({ status: "ready" });
  const applied = await runCliCapture(["migrate", "apply"]);
  expect(applied.code, applied.stderr).toBe(0);
  const current = new Database(statePath, { readonly: true });
  expect(current.query("SELECT asset_ref FROM asset_salience").get()).toEqual({
    asset_ref: "stash//memories/late-ref",
  });
  expect(current.query("SELECT workflow_ref FROM workflow_runs WHERE id='late-run'").get()).toEqual({
    workflow_ref: "stash//workflows/late-workflow",
  });
  expect(current.query("SELECT operation_id FROM akm_cutover_ledger WHERE singleton=1").get()).toEqual({
    operation_id: "original-cutover",
  });
  expect(current.query("SELECT backup_run_id, task_generation FROM akm_migration_completion").get()).toMatchObject({
    backup_run_id: expect.any(String),
    task_generation: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(current.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
  current.close();
  expect(fs.existsSync(`${statePath}-wal`)).toBe(false);
  expect(fs.existsSync(`${statePath}-shm`)).toBe(false);
  expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(false);
});

test("a non-proposal markerless WAL repair commits provenance last and resumes after cutover", async () => {
  fs.writeFileSync(getConfigPath(), `${JSON.stringify(currentConfig())}\n`, { mode: 0o600 });
  const assetPath = path.join(storage.stashDir, "memories", "retry-ref.md");
  fs.mkdirSync(path.dirname(assetPath), { recursive: true });
  fs.writeFileSync(assetPath, "# Retry ref\n");
  const statePath = getStateDbPathInDataDir();
  const seeded = openStateDbAtCeiling(statePath, STATE_MIGRATIONS.at(-1)!.id);
  seeded
    .prepare("INSERT INTO asset_salience(asset_ref, updated_at) VALUES (?, 1)")
    .run(["memory", "retry-ref"].join(":"));
  seeded.close();
  const wal = new Database(statePath);
  expect(wal.query("PRAGMA journal_mode=WAL").get()).toEqual({ journal_mode: "wal" });
  wal.close();

  const child = Bun.spawn(["bun", "src/cli.ts", "migrate", "apply"], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: { ...process.env, AKM_TEST_MIGRATION_FAIL_PHASE: "after-cutover" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(exitCode, stderr).not.toBe(0);
  expect(stderr).toContain("injected migration interruption at after-cutover");
  expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(true);
  const interrupted = new Database(statePath, { readonly: true });
  expect(interrupted.query("SELECT asset_ref FROM asset_salience").get()).toEqual({
    asset_ref: "stash//memories/retry-ref",
  });
  expect(
    (
      interrupted
        .query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='akm_migration_completion'")
        .get() as { n: number }
    ).n,
  ).toBe(0);
  expect(interrupted.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
  interrupted.close();
  expect(fs.existsSync(`${statePath}-wal`)).toBe(false);
  expect(fs.existsSync(`${statePath}-shm`)).toBe(false);

  const resumed = await runCliCapture(["migrate", "apply"]);
  expect(resumed.code, resumed.stderr).toBe(0);
  expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(false);
  const current = new Database(statePath, { readonly: true });
  expect(current.query("SELECT backup_run_id, task_generation FROM akm_migration_completion").get()).toMatchObject({
    backup_run_id: expect.any(String),
    task_generation: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  current.close();
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
 * rewritten through the cutover map to `bundle//workflows/<n>`). Migrate apply must still
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
      { status: "active", workflow_ref: "stash//workflows/ship" },
    );
  } finally {
    migratedState.close();
  }

  // The non-fatal warning names the run, the asset, and both remedies —
  // forwarded from the akm-migrate subprocess's stderr through to the CLI's.
  expect(applied.stderr).toContain("run-orphan");
  expect(applied.stderr).toContain("stash//workflows/ship");
  expect(applied.stderr).toContain("akm workflow abandon run-orphan");
});
