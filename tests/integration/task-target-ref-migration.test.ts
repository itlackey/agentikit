// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { planTaskTargetRefMigration } from "../../scripts/akm-migrate/migrate/legacy/task-target-ref-migration";
import { taskMigrationBackupPath } from "../../scripts/akm-migrate/migrate/task-v2-to-v3-files";
import {
  getMigrationApplyJournalPath,
  getMigrationRestoreJournalPath,
  inspectMigrationState,
  restoreMigrationBackup,
  verifyMigrationBackup,
} from "../../scripts/akm-migrate/migration-backup";
import type { AkmConfig } from "../../src/core/config/config";
import { getConfigPath, getStateDbPathInDataDir } from "../../src/core/paths";
import { STATE_MIGRATIONS } from "../../src/core/state/migrations";
import { parseTaskV3Yaml } from "../../src/tasks/source-v3";
import { openStateDbAtCeiling, PRE_CUTOVER_STATE_CEILING } from "../_fixtures/migration/seed-rows";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withEnvSync, withIsolatedAkmStorage } from "../_helpers/sandbox";

// These refs are frozen 0.8 migration inputs. Do not run the ref-literal codemod
// over this file; successful post-migration assertions deliberately use 0.9 refs.

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => storage.cleanup());

function seedMigration(
  workflowRef: string,
  createWorkflow = true,
  configuredStashDir = storage.stashDir,
): { prepared: string; taskPath: string; taskSource: string } {
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.writeFileSync(
    getConfigPath(),
    `${JSON.stringify({ configVersion: "0.8.0", stashDir: configuredStashDir, sources: [] })}\n`,
    { mode: 0o600 },
  );
  const prepared = path.join(storage.root, "prepared-0.9.json");
  fs.writeFileSync(
    prepared,
    `${JSON.stringify({
      configVersion: "0.9.0",
      stashDir: configuredStashDir,
      sources: [],
      semanticSearchMode: "off",
    })}\n`,
    { mode: 0o600 },
  );
  openStateDbAtCeiling(getStateDbPathInDataDir(), PRE_CUTOVER_STATE_CEILING).close();
  fs.mkdirSync(path.join(storage.stashDir, "tasks"), { recursive: true });
  fs.mkdirSync(path.join(storage.stashDir, "workflows"), { recursive: true });
  if (createWorkflow) fs.writeFileSync(path.join(storage.stashDir, "workflows", "upgrade-noop.md"), "# Noop\n");
  const taskPath = path.join(storage.stashDir, "tasks", "upgrade-workflow.yml");
  const taskSource = `schedule: "@daily"\nworkflow: ${workflowRef}\nparams: '{"source":"published"}'\nenabled: true\n`;
  fs.writeFileSync(taskPath, taskSource, { mode: 0o640 });
  return { prepared, taskPath, taskSource };
}

function trailingJson(stdout: string): unknown {
  const marker = stdout.lastIndexOf("\n{");
  return JSON.parse(stdout.slice(marker < 0 ? 0 : marker + 1));
}

function seedCurrentState(): void {
  const currentMigration = STATE_MIGRATIONS.at(-1);
  if (!currentMigration) throw new Error("expected a current state migration");
  openStateDbAtCeiling(getStateDbPathInDataDir(), currentMigration.id).close();
}

test("migrate apply previews, backs up, restores, and emits strict v3 for persisted v1 and v2 tasks", async () => {
  const { prepared, taskPath, taskSource } = seedMigration("workflow:upgrade-noop");
  const currentTaskPath = path.join(storage.stashDir, "tasks", "manual-current.yml");
  const currentTask = 'version: 2\nschedule: "@daily"\nworkflow: workflows/upgrade-noop\nenabled: true\n';
  fs.writeFileSync(currentTaskPath, currentTask, { mode: 0o660 });

  const preview = await runCliCapture(["migrate", "apply", "--dry-run", "--config", prepared]);
  expect(preview.code, preview.stderr).toBe(0);
  const previewPlan = JSON.parse(preview.stdout) as {
    taskV3Migration: { generation: string; changed: number; blocked: number; files: Array<{ status: string }> };
  };
  expect(previewPlan.taskV3Migration).toMatchObject({ changed: 2, blocked: 0 });
  expect(previewPlan.taskV3Migration.files.map((file) => file.status)).toEqual(["changed", "changed"]);
  expect(fs.readFileSync(taskPath, "utf8")).not.toContain("version:");
  expect(fs.readFileSync(currentTaskPath, "utf8")).toBe(currentTask);

  const applied = await runCliCapture(["migrate", "apply", "--config", prepared]);
  expect(applied.code, applied.stderr).toBe(0);
  const appliedPlan = trailingJson(applied.stdout) as {
    backupPath: string;
    taskV3Migration: { generation: string; changed: number; blocked: number };
  };
  expect(appliedPlan.taskV3Migration).toMatchObject({
    generation: previewPlan.taskV3Migration.generation,
    changed: 2,
    blocked: 0,
  });
  const migratedV1 = parseTaskV3Yaml({ yaml: fs.readFileSync(taskPath, "utf8"), filePath: taskPath });
  const migratedV2 = parseTaskV3Yaml({ yaml: fs.readFileSync(currentTaskPath, "utf8"), filePath: currentTaskPath });
  expect(migratedV1.target).toMatchObject({ kind: "uses", uses: { kind: "workflow", ref: "workflows/upgrade-noop" } });
  expect(migratedV1.target.kind === "uses" ? migratedV1.target.with : undefined).toEqual({ source: "published" });
  expect(migratedV2.target).toMatchObject({ kind: "uses", uses: { kind: "workflow", ref: "workflows/upgrade-noop" } });
  // The one immutable plan is actual-source -> final-v3. A v1 file's declared
  // recoverable backup must therefore be the exact v1 bytes, never the
  // intermediate v2 projection that exists only in memory.
  expect(fs.readFileSync(taskMigrationBackupPath(appliedPlan.backupPath, taskPath), "utf8")).toBe(taskSource);
  expect(fs.readFileSync(taskMigrationBackupPath(appliedPlan.backupPath, currentTaskPath), "utf8")).toBe(currentTask);

  const manifest = verifyMigrationBackup(appliedPlan.backupPath) as ReturnType<typeof verifyMigrationBackup> & {
    taskMigration?: {
      schemaVersion: number;
      generation: string;
      operationId: string;
      files: Array<{
        sourcePath: string;
        backupPath: string;
        finalPath: string;
        mode: number;
        beforeHash: string;
        finalHash: string;
        sourceIdentity: { realPath: string; device: string; inode: string };
      }>;
    };
  };
  if (!manifest.taskMigration) throw new Error("expected task migration backup provenance");
  const recoveryPath = manifest.taskMigration?.recoveryPath;
  const taskOperationId = manifest.taskMigration?.operationId;
  expect(manifest.taskMigration).toMatchObject({
    schemaVersion: 1,
    generation: previewPlan.taskV3Migration.generation,
    operationId: expect.any(String),
    recoveryPath: "tasks/recovery.json",
    files: [
      {
        sourcePath: currentTaskPath,
        backupPath: expect.stringMatching(/^tasks\/[a-f0-9]{64}\.before$/),
        finalPath: expect.stringMatching(/^tasks\/[a-f0-9]{64}\.after$/),
        mode: 0o660,
        beforeHash: expect.any(String),
        finalHash: expect.any(String),
        sourceIdentity: {
          realPath: fs.realpathSync(currentTaskPath),
          device: expect.any(String),
          inode: expect.any(String),
        },
      },
      {
        sourcePath: taskPath,
        backupPath: expect.stringMatching(/^tasks\/[a-f0-9]{64}\.before$/),
        finalPath: expect.stringMatching(/^tasks\/[a-f0-9]{64}\.after$/),
        mode: 0o640,
        beforeHash: expect.any(String),
        finalHash: expect.any(String),
        sourceIdentity: {
          realPath: fs.realpathSync(taskPath),
          device: expect.any(String),
          inode: expect.any(String),
        },
      },
    ],
  });
  const recovery = JSON.parse(fs.readFileSync(path.join(appliedPlan.backupPath, recoveryPath ?? ""), "utf8")) as {
    operationId: string;
    generation: string;
    files: Array<{ sourcePath: string; state: string }>;
  };
  expect(recovery.operationId).toBe(taskOperationId);
  expect(recovery.generation).toBe(previewPlan.taskV3Migration.generation);
  expect(recovery.files).toEqual([
    { sourcePath: currentTaskPath, state: "published" },
    { sourcePath: taskPath, state: "published" },
  ]);

  const tasksBackupDir = path.join(appliedPlan.backupPath, "tasks");
  const rogue = path.join(tasksBackupDir, "rogue.before");
  fs.writeFileSync(rogue, "undeclared", { mode: 0o600 });
  expect(() => verifyMigrationBackup(appliedPlan.backupPath)).toThrow(/unexpected|undeclared|canonical/i);
  fs.unlinkSync(rogue);
  expect(() => verifyMigrationBackup(appliedPlan.backupPath)).not.toThrow();

  restoreMigrationBackup(true, path.basename(appliedPlan.backupPath));
  expect(fs.readFileSync(taskPath, "utf8")).toBe(taskSource);
  expect(fs.statSync(taskPath).mode & 0o777).toBe(0o640);
  expect(fs.readFileSync(currentTaskPath, "utf8")).toBe(currentTask);
  expect(fs.statSync(currentTaskPath).mode & 0o777).toBe(0o660);
});

test("a stale persisted workflow target is rewritten without blocking core migration", async () => {
  const { prepared, taskPath } = seedMigration("workflow:missing", false);

  const applied = await runCliCapture(["migrate", "apply", "--config", prepared]);
  expect(applied.code, applied.stderr).toBe(0);
  expect(parseTaskV3Yaml({ yaml: fs.readFileSync(taskPath, "utf8"), filePath: taskPath }).target).toMatchObject({
    kind: "uses",
    uses: { kind: "workflow", ref: "workflows/missing" },
  });
  expect(inspectMigrationState().state.status).toBe("current");
  expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(false);
});

test("the main migration backup verifier and restore accept only its declared v2 task artifacts", async () => {
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.writeFileSync(
    getConfigPath(),
    `${JSON.stringify({
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      bundles: { stash: { path: storage.stashDir, writable: true } },
      defaultBundle: "stash",
    })}\n`,
    { mode: 0o600 },
  );
  seedCurrentState();
  const taskPath = path.join(storage.stashDir, "tasks", "recoverable-v2.yml");
  const before = "version: 2\nschedule: '@daily'\ncommand: akm index\n";
  fs.mkdirSync(path.dirname(taskPath), { recursive: true });
  fs.writeFileSync(taskPath, before, { mode: 0o664 });

  const applied = await runCliCapture(["migrate", "apply"]);
  expect(applied.code, applied.stderr).toBe(0);
  const result = trailingJson(applied.stdout) as { backupPath: string; backupRunId: string };
  expect(() => verifyMigrationBackup(result.backupPath)).not.toThrow();
  expect(fs.existsSync(`${getStateDbPathInDataDir()}-wal`)).toBe(false);
  expect(fs.existsSync(`${getStateDbPathInDataDir()}-shm`)).toBe(false);
  const state = new Database(getStateDbPathInDataDir(), { readonly: true });
  expect(state.query("SELECT backup_run_id AS backupRunId FROM akm_migration_completion").get()).toEqual({
    backupRunId: result.backupRunId,
  });
  state.close();
  restoreMigrationBackup(true, result.backupRunId);
  expect(fs.readFileSync(taskPath, "utf8")).toBe(before);
  expect(fs.statSync(taskPath).mode & 0o777).toBe(0o664);
});

test("explicit restore resumes after the middle task and recovers exact first/middle/last bytes and modes", async () => {
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.writeFileSync(
    getConfigPath(),
    `${JSON.stringify({
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      bundles: { stash: { path: storage.stashDir, writable: true } },
      defaultBundle: "stash",
    })}\n`,
    { mode: 0o600 },
  );
  seedCurrentState();
  const tasksDir = path.join(storage.stashDir, "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  const originals = [
    { name: "01-first.yml", mode: 0o640, source: "version: 2\nschedule: '@daily'\ncommand: akm index\n" },
    { name: "02-middle.yml", mode: 0o650, source: "version: 2\nschedule: '@hourly'\ncommand: akm health\n" },
    { name: "03-last.yml", mode: 0o660, source: "version: 2\nschedule: '0 3 * * *'\ncommand: akm sync\n" },
  ].map((item) => ({ ...item, filePath: path.join(tasksDir, item.name) }));
  const first = originals[0];
  const middle = originals[1];
  const last = originals[2];
  if (!first || !middle || !last) throw new Error("expected first, middle, and last restore tasks");
  for (const item of originals) fs.writeFileSync(item.filePath, item.source, { mode: item.mode });

  const applied = await runCliCapture(["migrate", "apply"]);
  expect(applied.code, applied.stderr).toBe(0);
  const result = trailingJson(applied.stdout) as { backupRunId: string };
  for (const item of originals) expect(fs.readFileSync(item.filePath, "utf8")).toContain("version: 3");

  expect(() =>
    withEnvSync({ AKM_TEST_MIGRATION_FAIL_RESTORE_TASK_AFTER: middle.name }, () =>
      restoreMigrationBackup(true, result.backupRunId),
    ),
  ).toThrow(/injected task restore interruption.*02-middle/i);
  expect(fs.existsSync(getMigrationRestoreJournalPath())).toBe(true);
  expect(fs.readFileSync(first.filePath, "utf8")).toBe(first.source);
  expect(fs.readFileSync(middle.filePath, "utf8")).toBe(middle.source);
  expect(fs.readFileSync(last.filePath, "utf8")).toContain("version: 3");

  restoreMigrationBackup(true);
  expect(fs.existsSync(getMigrationRestoreJournalPath())).toBe(false);
  for (const item of originals) {
    expect(fs.readFileSync(item.filePath, "utf8")).toBe(item.source);
    expect(fs.statSync(item.filePath).mode & 0o777).toBe(item.mode);
  }
});

test("task planning uses the migration sentinel's managed-bundle root", () => {
  const managedRoot = path.join(storage.root, "sentinel-managed-root");
  fs.mkdirSync(path.join(managedRoot, "tasks"), { recursive: true });
  fs.mkdirSync(path.join(managedRoot, "workflows"), { recursive: true });
  fs.writeFileSync(path.join(managedRoot, "workflows", "managed.md"), "# Managed\n");
  const taskPath = path.join(managedRoot, "tasks", "managed.yml");
  fs.writeFileSync(taskPath, `schedule: "@daily"\nworkflow: ${["workflow", "managed"].join(":")}\n`);
  const config = {
    semanticSearchMode: "off",
    bundles: { managed: { git: "https://example.test/managed.git", writable: true } },
    defaultBundle: "managed",
    defaultWriteTarget: "managed",
  } as AkmConfig;

  const plan = planTaskTargetRefMigration(config, storage.root, [
    { id: "managed", source: "git", ref: "https://example.test/managed.git", localRoot: managedRoot },
  ]);

  expect(plan.rewrites).toHaveLength(1);
  expect(plan.rewrites[0]?.filePath).toBe(taskPath);
  expect(plan.rewrites[0]?.to).toBe("workflows/managed");
});

test("migrate status and apply repair a legacy task after core artifacts are already current", async () => {
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.writeFileSync(
    getConfigPath(),
    `${JSON.stringify({
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      bundles: { stash: { path: storage.stashDir, writable: true } },
      defaultBundle: "stash",
    })}\n`,
    { mode: 0o600 },
  );
  seedCurrentState();
  fs.mkdirSync(path.join(storage.stashDir, "tasks"), { recursive: true });
  fs.mkdirSync(path.join(storage.stashDir, "workflows"), { recursive: true });
  fs.writeFileSync(path.join(storage.stashDir, "workflows", "upgrade-noop.md"), "# Noop\n");
  const taskPath = path.join(storage.stashDir, "tasks", "upgrade-workflow.yml");
  fs.writeFileSync(taskPath, 'schedule: "@daily"\nworkflow: workflow:upgrade-noop\nenabled: true\n');

  const status = await runCliCapture(["migrate", "status"]);
  expect(status.code, status.stderr).toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({
    status: "ready",
    taskV3Migration: { changed: 1, skipped: 0, blocked: 0 },
  });
  expect(fs.readFileSync(taskPath, "utf8")).toContain("workflow: workflow:upgrade-noop");

  const applied = await runCliCapture(["migrate", "apply"]);
  expect(applied.code, applied.stderr).toBe(0);
  expect(parseTaskV3Yaml({ yaml: fs.readFileSync(taskPath, "utf8"), filePath: taskPath }).target).toMatchObject({
    kind: "uses",
    uses: { kind: "workflow", ref: "workflows/upgrade-noop" },
  });
  expect(inspectMigrationState()).toMatchObject({
    config: { status: "current" },
    state: { status: "current" },
    workflow: { status: "missing" },
  });
});

test("task-v3 migration honors the configured nested component root and component writability", async () => {
  const bundleRoot = path.join(storage.root, "component-bundle");
  const componentRoot = path.join(bundleRoot, "catalog");
  const nestedTask = path.join(componentRoot, "tasks", "nested.yml");
  const outsideTask = path.join(bundleRoot, "tasks", "outside-component.yml");
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.writeFileSync(
    getConfigPath(),
    `${JSON.stringify({
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      bundles: {
        stash: {
          path: bundleRoot,
          writable: false,
          components: { main: { root: "catalog", adapter: "akm", writable: true } },
        },
      },
      defaultBundle: "stash",
    })}\n`,
    { mode: 0o600 },
  );
  seedCurrentState();
  fs.mkdirSync(path.dirname(nestedTask), { recursive: true });
  fs.mkdirSync(path.dirname(outsideTask), { recursive: true });
  const v2 = "version: 2\nschedule: '@daily'\ncommand: akm index\n";
  fs.writeFileSync(nestedTask, v2);
  fs.writeFileSync(outsideTask, v2);

  const status = await runCliCapture(["migrate", "status"]);
  expect(status.code, status.stderr).toBe(0);
  const statusPlan = JSON.parse(status.stdout) as {
    taskV3Migration: { changed: number; blocked: number; files: Array<{ filePath: string }> };
  };
  expect(statusPlan.taskV3Migration).toMatchObject({ changed: 1, blocked: 0 });
  expect(statusPlan.taskV3Migration.files.map((file) => file.filePath)).toEqual([nestedTask]);

  const applied = await runCliCapture(["migrate", "apply"]);
  expect(applied.code, applied.stderr).toBe(0);
  expect(parseTaskV3Yaml({ yaml: fs.readFileSync(nestedTask, "utf8"), filePath: nestedTask }).version).toBe(3);
  expect(fs.readFileSync(outsideTask, "utf8")).toBe(v2);
});

test.skipIf(process.platform === "win32")(
  "task-v3 migration rejects a component that is lexically inside but physically outside its stable bundle root",
  async () => {
    const bundleRoot = path.join(storage.root, "physical-bundle");
    const outsideRoot = path.join(storage.root, "outside-component");
    const externalTask = path.join(outsideRoot, "catalog", "tasks", "outside.yml");
    fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
    fs.mkdirSync(path.dirname(externalTask), { recursive: true });
    fs.mkdirSync(bundleRoot, { recursive: true });
    fs.symlinkSync(outsideRoot, path.join(bundleRoot, "linked"), "dir");
    const before = "version: 2\nschedule: '@daily'\ncommand: akm index\n";
    fs.writeFileSync(externalTask, before);
    fs.writeFileSync(
      getConfigPath(),
      `${JSON.stringify({
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        bundles: {
          escaped: {
            path: bundleRoot,
            writable: true,
            components: { main: { root: "linked/catalog", adapter: "akm", writable: true } },
          },
        },
        defaultBundle: "escaped",
      })}\n`,
      { mode: 0o600 },
    );
    seedCurrentState();

    const status = await runCliCapture(["migrate", "status"]);
    expect(status.code).not.toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ status: "blocked" });
    expect(status.stdout).toMatch(/physically|resolves outside|component.*bundle/i);
    expect(fs.readFileSync(externalTask, "utf8")).toBe(before);
  },
);

test("task-v3 migration uses ordered adapter detection when a component adapter is omitted", async () => {
  const bundleRoot = path.join(storage.root, "detected-component-bundle");
  const componentRoot = path.join(bundleRoot, "catalog");
  const currentTask = path.join(componentRoot, "current.yml");
  const legacyTask = path.join(componentRoot, "legacy.yml");
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.writeFileSync(
    getConfigPath(),
    `${JSON.stringify({
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      bundles: {
        detected: {
          path: bundleRoot,
          writable: true,
          components: { main: { root: "catalog", writable: true } },
        },
      },
      defaultBundle: "detected",
    })}\n`,
    { mode: 0o600 },
  );
  seedCurrentState();
  fs.mkdirSync(componentRoot, { recursive: true });
  fs.writeFileSync(currentTask, "version: 3\nuses: commands/current\nakm:\n  schedule: '@daily'\n");
  const legacy = "version: 2\nschedule: '@daily'\ncommand: akm index\n";
  fs.writeFileSync(legacyTask, legacy);

  const status = await runCliCapture(["migrate", "status"]);
  expect(status.code, status.stderr).toBe(0);
  const statusPlan = JSON.parse(status.stdout) as {
    taskV3Migration: { changed: number; skipped: number; blocked: number; files: Array<{ filePath: string }> };
  };
  expect(statusPlan.taskV3Migration).toMatchObject({ changed: 1, skipped: 1, blocked: 0 });
  expect(statusPlan.taskV3Migration.files.map((file) => file.filePath)).toEqual([currentTask, legacyTask]);

  const applied = await runCliCapture(["migrate", "apply"]);
  expect(applied.code, applied.stderr).toBe(0);
  expect(parseTaskV3Yaml({ yaml: fs.readFileSync(legacyTask, "utf8"), filePath: legacyTask }).version).toBe(3);
});

test("an ordered non-task adapter owner wins over an incidental top-level v2-shaped YAML file", async () => {
  const componentRoot = path.join(storage.root, "detected-okf-component");
  const incidentalYaml = path.join(componentRoot, "incidental.yml");
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.writeFileSync(
    getConfigPath(),
    `${JSON.stringify({
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      bundles: {
        docs: {
          path: componentRoot,
          writable: true,
          components: { main: { root: ".", writable: true } },
        },
      },
      defaultBundle: "docs",
    })}\n`,
    { mode: 0o600 },
  );
  seedCurrentState();
  fs.mkdirSync(componentRoot, { recursive: true });
  fs.writeFileSync(path.join(componentRoot, "index.md"), "# Portable OKF bundle\n");
  const before = "version: 2\nschedule: '@daily'\ncommand: akm index\n";
  fs.writeFileSync(incidentalYaml, before);

  const status = await runCliCapture(["migrate", "status"]);
  expect(status.code, status.stderr).toBe(0);
  const statusPlan = JSON.parse(status.stdout) as {
    taskV3Migration: {
      schemaVersion: number;
      generation: string;
      changed: number;
      skipped: number;
      blocked: number;
      files: unknown[];
    };
  };
  expect(statusPlan.taskV3Migration).toEqual({
    schemaVersion: 1,
    generation: expect.any(String),
    changed: 0,
    skipped: 0,
    blocked: 0,
    files: [],
  });

  const applied = await runCliCapture(["migrate", "apply"]);
  expect(applied.code, applied.stderr).toBe(0);
  expect(fs.readFileSync(incidentalYaml, "utf8")).toBe(before);
});

test("task-v3 migration fails closed when an omitted adapter leaves a flat v2 task root ambiguous", async () => {
  const componentRoot = path.join(storage.root, "ambiguous-flat-component");
  const legacyTask = path.join(componentRoot, "legacy.yml");
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.writeFileSync(
    getConfigPath(),
    `${JSON.stringify({
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      bundles: {
        ambiguous: {
          path: componentRoot,
          writable: true,
          components: { main: { root: ".", writable: true } },
        },
      },
      defaultBundle: "ambiguous",
    })}\n`,
    { mode: 0o600 },
  );
  seedCurrentState();
  fs.mkdirSync(componentRoot, { recursive: true });
  const before = "version: 2\nschedule: '@daily'\ncommand: akm index\n";
  fs.writeFileSync(legacyTask, before);

  const status = await runCliCapture(["migrate", "status"]);
  expect(status.code).toBe(1);
  const plan = JSON.parse(status.stdout) as { status: string; blockers: string[] };
  expect(plan.status).toBe("blocked");
  expect(plan.blockers.join(" ")).toMatch(/cannot infer|adapter.*akm-task|flat task component/i);
  expect(fs.readFileSync(legacyTask, "utf8")).toBe(before);
});

test("read-only v2 tasks are classified as blocked in status/dry-run and never written", async () => {
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.writeFileSync(
    getConfigPath(),
    `${JSON.stringify({
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      bundles: { frozen: { path: storage.stashDir, writable: false } },
      defaultBundle: "frozen",
    })}\n`,
    { mode: 0o600 },
  );
  seedCurrentState();
  const taskPath = path.join(storage.stashDir, "tasks", "frozen.yml");
  fs.mkdirSync(path.dirname(taskPath), { recursive: true });
  const before = "version: 2\nschedule: '@daily'\ncommand: akm index\n";
  fs.writeFileSync(taskPath, before);

  const status = await runCliCapture(["migrate", "status"]);
  const preview = await runCliCapture(["migrate", "apply", "--dry-run"]);
  expect(status.code, status.stderr).toBe(1);
  expect(preview.code, preview.stderr).toBe(1);
  const statusPlan = JSON.parse(status.stdout) as {
    status: string;
    taskV3Migration: { generation: string; blocked: number; files: Array<{ status: string; reason: string }> };
  };
  const previewPlan = JSON.parse(preview.stdout) as typeof statusPlan;
  expect(statusPlan).toMatchObject({
    status: "blocked",
    taskV3Migration: { blocked: 1, files: [{ status: "blocked", reason: "read-only-source" }] },
  });
  expect(previewPlan.taskV3Migration.generation).toBe(statusPlan.taskV3Migration.generation);
  expect(fs.readFileSync(taskPath, "utf8")).toBe(before);
  expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(false);
});

test("a v1 task in a READ-ONLY bundle is surfaced in the plan, instead of being silently skipped", () => {
  // The 0.9 runtime removed the v1 task parser, so a skipped v1 task in a
  // writable:false bundle would start failing after an upgrade that reported
  // current. The migration never rewrites a read-only bundle (pinned by
  // "resolves targets from a lock-materialized read-only bundle..." in
  // tests/migrate/legacy/task-target-ref-migration.test.ts), so the preflight
  // surfaces the stranded files per bundle rather than blocking or omitting.
  const readOnlyRoot = path.join(storage.root, "readonly-bundle-root");
  fs.mkdirSync(path.join(readOnlyRoot, "tasks"), { recursive: true });
  const v1Task = path.join(readOnlyRoot, "tasks", "legacy.yml");
  fs.writeFileSync(v1Task, `schedule: "@daily"\nworkflow: ${["workflow", "legacy"].join(":")}\n`);
  const config = {
    semanticSearchMode: "off",
    bundles: {
      stash: { path: storage.stashDir, writable: true },
      frozen: { path: readOnlyRoot, writable: false },
    },
    defaultBundle: "stash",
  } as AkmConfig;

  const plan = planTaskTargetRefMigration(config, storage.root);
  expect(plan.readOnlyLegacyTasks).toEqual([{ bundleId: "frozen", files: ["legacy.yml"] }]);
  // The read-only bundle is still never rewritten.
  expect(plan.rewrites).toEqual([]);
});

test("a read-only bundle with only v2 tasks (or none) does not block planning", () => {
  const readOnlyRoot = path.join(storage.root, "readonly-v2-root");
  fs.mkdirSync(path.join(readOnlyRoot, "tasks"), { recursive: true });
  fs.writeFileSync(
    path.join(readOnlyRoot, "tasks", "current.yml"),
    'version: 2\nschedule: "@daily"\nworkflow: workflows/anything\nenabled: true\n',
  );
  const config = {
    semanticSearchMode: "off",
    bundles: {
      stash: { path: storage.stashDir, writable: true },
      frozen: { path: readOnlyRoot, writable: false },
    },
    defaultBundle: "stash",
  } as AkmConfig;

  const plan = planTaskTargetRefMigration(config, storage.root);
  expect(plan.rewrites).toEqual([]);
  expect(plan.readOnlyLegacyTasks).toEqual([]);
});
