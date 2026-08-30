import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyTaskToV3MigrationPlan,
  inspectTaskToV3Files,
  taskMigrationBackupPath,
} from "../../scripts/akm-migrate/migrate/task-files-to-v3";
import { planTaskToV3Migration } from "../../src/tasks/source/task-to-v3";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; task: string; backup: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-migrate-"));
  roots.push(root);
  const task = path.join(root, "tasks", "demo.yml");
  fs.mkdirSync(path.dirname(task), { recursive: true });
  fs.writeFileSync(task, "version: 2\nschedule: '@daily'\ncommand: /bin/echo ok\n", { mode: 0o640 });
  return { root, task, backup: path.join(root, "backup") };
}

function plan(root: string) {
  return planTaskToV3Migration(
    inspectTaskToV3Files([{ bundleId: "fixture", root, bundleRoot: root, writable: true, layout: "akm-stash" }]),
  );
}

describe("task v2 to v3 filesystem boundary", () => {
  test("preview is read-only and apply writes v3 plus an exact backup", () => {
    const { root, task, backup } = fixture();
    const before = fs.readFileSync(task);
    const preview = plan(root);
    expect(preview.files.map((file) => file.status)).toEqual(["changed"]);
    expect(fs.readFileSync(task)).toEqual(before);

    const applied = applyTaskToV3MigrationPlan(preview, { backupRoot: backup });
    expect(applied.changed).toEqual([task]);
    expect(fs.readFileSync(task, "utf8")).toContain("version: 3");
    expect(fs.readFileSync(taskMigrationBackupPath(backup, task))).toEqual(before);
    expect(fs.statSync(task).mode & 0o777).toBe(0o640);
    expect(plan(root).files.map((file) => file.status)).toEqual(["skipped"]);
  });

  test("one blocked file is skipped, not fatal: the rest of the batch still migrates", () => {
    const { root, task, backup } = fixture();
    const bad = path.join(root, "tasks", "bad.yml");
    fs.writeFileSync(bad, "version: 2\nschedule: '@daily'\ncommand: [echo, unsafe]\n");
    const preview = plan(root);
    expect(preview.files.some((file) => file.status === "blocked")).toBe(true);
    expect(preview.files.some((file) => file.filePath === task && file.status === "changed")).toBe(true);

    const applied = applyTaskToV3MigrationPlan(preview, { backupRoot: backup });

    // The good file was migrated and backed up...
    expect(applied.changed).toEqual([task]);
    expect(fs.readFileSync(task, "utf8")).toContain("version: 3");
    expect(fs.readFileSync(taskMigrationBackupPath(backup, task))).toBeInstanceOf(Buffer);
    // ...while the blocked file was left untouched.
    expect(fs.readFileSync(bad, "utf8")).toContain("command: [echo, unsafe]");
  });

  test("source drift after preview aborts before creating backups", () => {
    const { root, task, backup } = fixture();
    const preview = plan(root);
    fs.writeFileSync(task, "version: 2\nschedule: '@daily'\ncommand: /bin/echo changed\n");
    expect(() => applyTaskToV3MigrationPlan(preview, { backupRoot: backup })).toThrow(/changed after preview/);
    expect(fs.existsSync(backup)).toBe(false);
  });

  test("symlinks and hard-linked task sources are rejected", () => {
    const { root, task } = fixture();
    const linked = path.join(root, "tasks", "linked.yml");
    fs.linkSync(task, linked);
    expect(() => plan(root)).toThrow(/must not be hard-linked/);
    fs.unlinkSync(linked);
    fs.symlinkSync(task, linked);
    expect(() => plan(root)).toThrow(/does not follow symbolic link/);
  });

  test("standalone akm-task roots inspect top-level yml files", () => {
    const { root } = fixture();
    const standalone = path.join(root, "standalone");
    fs.mkdirSync(standalone);
    fs.writeFileSync(path.join(standalone, "flat.yml"), "version: 3\nname: flat\nrun: echo ok\nakm: {}\n");
    const inputs = inspectTaskToV3Files([
      { bundleId: "flat", root: standalone, bundleRoot: standalone, writable: true, layout: "akm-task" },
    ]);
    expect(inputs.map((input) => path.basename(input.filePath))).toEqual(["flat.yml"]);
  });
});
