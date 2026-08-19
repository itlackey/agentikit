// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { planTaskTargetRefMigration } from "../../scripts/akm-migrate/migrate/legacy/task-target-ref-migration";
import { taskMigrationBackupPath } from "../../scripts/akm-migrate/migrate/task-v2-to-v3-files";
import { getMigrationApplyJournalPath, inspectMigrationState } from "../../scripts/akm-migrate/migration-backup";
import type { AkmConfig } from "../../src/core/config/config";
import { getConfigPath, getStateDbPathInDataDir } from "../../src/core/paths";
import { openStateDatabase } from "../../src/core/state-db";
import { parseTaskV3Yaml } from "../../src/tasks/source-v3";
import { openStateDbAtCeiling, PRE_CUTOVER_STATE_CEILING } from "../_fixtures/migration/seed-rows";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

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
): { prepared: string; taskPath: string } {
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
  fs.writeFileSync(
    taskPath,
    `schedule: "@daily"\nworkflow: ${workflowRef}\nparams: '{"source":"published"}'\nenabled: true\n`,
  );
  return { prepared, taskPath };
}

function trailingJson(stdout: string): unknown {
  const marker = stdout.lastIndexOf("\n{");
  return JSON.parse(stdout.slice(marker < 0 ? 0 : marker + 1));
}

test("migrate apply previews and emits strict v3 for persisted v1 and v2 tasks", async () => {
  const { prepared, taskPath } = seedMigration("workflow:upgrade-noop");
  const currentTaskPath = path.join(storage.stashDir, "tasks", "manual-current.yml");
  const currentTask = 'version: 2\nschedule: "@daily"\nworkflow: workflows/upgrade-noop\nenabled: true\n';
  fs.writeFileSync(currentTaskPath, currentTask);

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
  expect(fs.readFileSync(taskMigrationBackupPath(appliedPlan.backupPath, currentTaskPath), "utf8")).toBe(currentTask);
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
  openStateDatabase().close();
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
  openStateDatabase().close();
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
  openStateDatabase().close();
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
  openStateDatabase().close();
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
  openStateDatabase().close();
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
  openStateDatabase().close();
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
