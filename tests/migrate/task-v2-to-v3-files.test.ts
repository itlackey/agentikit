// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyTaskV2ToV3MigrationPlan,
  inspectTaskV2ToV3Files,
  taskMigrationBackupPath,
} from "../../scripts/akm-migrate/migrate/task-v2-to-v3-files";
import { planTaskV2ToV3Migration } from "../../src/tasks/migrate-v2-to-v3";

const SAFE = "version: 2\nschedule: '@daily'\nenabled: false\ncommand: akm index --full\n";
const BLOCKED = "version: 2\nschedule: '@daily'\ncommand: [printf, '%s', value]\n";

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-v3-migration-"));
  fs.mkdirSync(path.join(root, "tasks"), { recursive: true });
  return root;
}

describe("durable task v2 to v3 migration application", () => {
  test("preview inspects the entire root without writes and apply uses the identical generation", () => {
    const root = tempRoot();
    const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-v3-backup-"));
    const task = path.join(root, "tasks", "safe.yml");
    fs.writeFileSync(task, SAFE, { mode: 0o640 });
    try {
      const beforeRoot = snapshot(root);
      const inputs = inspectTaskV2ToV3Files([{ bundleId: "stash", root, writable: true }]);
      const preview = planTaskV2ToV3Migration(inputs);
      expect(snapshot(root)).toEqual(beforeRoot);
      const applied = applyTaskV2ToV3MigrationPlan(preview, { backupRoot });
      expect(applied.generation).toBe(preview.generation);
      expect(applied.changed).toEqual([task]);
      expect(fs.readFileSync(task, "utf8")).toContain("version: 3");
      expect(fs.statSync(task).mode & 0o777).toBe(0o640);
      const backup = taskMigrationBackupPath(backupRoot, task);
      expect(fs.readFileSync(backup, "utf8")).toBe(SAFE);
      expect(fs.statSync(backup).isFile()).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(backupRoot, { recursive: true, force: true });
    }
  });

  test("one blocked file makes apply fail closed before any backup or source write", () => {
    const root = tempRoot();
    const backupRoot = path.join(root, "backups");
    const safe = path.join(root, "tasks", "a-safe.yml");
    const blocked = path.join(root, "tasks", "b-blocked.yml");
    fs.writeFileSync(safe, SAFE);
    fs.writeFileSync(blocked, BLOCKED);
    try {
      const before = snapshot(root);
      const plan = planTaskV2ToV3Migration(inspectTaskV2ToV3Files([{ bundleId: "stash", root, writable: true }]));
      expect(() => applyTaskV2ToV3MigrationPlan(plan, { backupRoot })).toThrow(/blocked|argv/i);
      expect(snapshot(root)).toEqual(before);
      expect(fs.existsSync(backupRoot)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("detects source drift before backup and leaves the drifted source untouched", () => {
    const root = tempRoot();
    const backupRoot = path.join(root, "backups");
    const task = path.join(root, "tasks", "safe.yml");
    fs.writeFileSync(task, SAFE);
    const plan = planTaskV2ToV3Migration(inspectTaskV2ToV3Files([{ bundleId: "stash", root, writable: true }]));
    const drift = `${SAFE}# drift\n`;
    fs.writeFileSync(task, drift);
    try {
      expect(() => applyTaskV2ToV3MigrationPlan(plan, { backupRoot })).toThrow(/drift|changed after/i);
      expect(fs.readFileSync(task, "utf8")).toBe(drift);
      expect(fs.existsSync(backupRoot)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("detects mode and file-kind drift before creating a backup", () => {
    const root = tempRoot();
    const backupRoot = path.join(root, "backups");
    const task = path.join(root, "tasks", "safe.yml");
    fs.writeFileSync(task, SAFE, { mode: 0o640 });
    const plan = planTaskV2ToV3Migration(inspectTaskV2ToV3Files([{ bundleId: "stash", root, writable: true }]));
    try {
      fs.chmodSync(task, 0o600);
      expect(() => applyTaskV2ToV3MigrationPlan(plan, { backupRoot })).toThrow(/mode|drift/i);
      expect(fs.readFileSync(task, "utf8")).toBe(SAFE);
      expect(fs.existsSync(backupRoot)).toBe(false);

      if (process.platform !== "win32") {
        fs.chmodSync(task, 0o640);
        const real = path.join(root, "real.yml");
        fs.renameSync(task, real);
        fs.symlinkSync(real, task);
        expect(() => applyTaskV2ToV3MigrationPlan(plan, { backupRoot })).toThrow(/symbolic|regular file|drift/i);
        expect(fs.readFileSync(real, "utf8")).toBe(SAFE);
        expect(fs.existsSync(backupRoot)).toBe(false);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("compensates earlier replacements if a later per-file backup fails", () => {
    const root = tempRoot();
    const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-v3-backup-"));
    const first = path.join(root, "tasks", "a.yml");
    const second = path.join(root, "tasks", "b.yml");
    fs.writeFileSync(first, SAFE);
    fs.writeFileSync(second, SAFE.replace("@daily", "@hourly"));
    const plan = planTaskV2ToV3Migration(inspectTaskV2ToV3Files([{ bundleId: "stash", root, writable: true }]));
    const secondBackup = taskMigrationBackupPath(backupRoot, second);
    fs.mkdirSync(path.dirname(secondBackup), { recursive: true });
    fs.writeFileSync(secondBackup, "wrong pre-existing backup");
    try {
      expect(() => applyTaskV2ToV3MigrationPlan(plan, { backupRoot })).toThrow(/backup/i);
      expect(fs.readFileSync(first, "utf8")).toBe(SAFE);
      expect(fs.readFileSync(second, "utf8")).toBe(SAFE.replace("@daily", "@hourly"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(backupRoot, { recursive: true, force: true });
    }
  });

  test("resumes an interrupted backup pair by creating and verifying missing metadata", () => {
    const root = tempRoot();
    const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-v3-backup-"));
    const task = path.join(root, "tasks", "safe.yml");
    fs.writeFileSync(task, SAFE, { mode: 0o640 });
    const plan = planTaskV2ToV3Migration(inspectTaskV2ToV3Files([{ bundleId: "stash", root, writable: true }]));
    const change = plan.files[0];
    if (change?.status !== "changed") throw new Error("expected changed task");
    const backup = taskMigrationBackupPath(backupRoot, task);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.writeFileSync(backup, change.before, { mode: 0o600 });
    try {
      const applied = applyTaskV2ToV3MigrationPlan(plan, { backupRoot });
      expect(applied.changed).toEqual([task]);
      const metadata = JSON.parse(fs.readFileSync(`${backup}.json`, "utf8"));
      expect(metadata).toEqual({ schemaVersion: 1, source: task, mode: 0o640, beforeHash: change.beforeHash });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(backupRoot, { recursive: true, force: true });
    }
  });

  test("rejects symlinked backup artifacts without replacing the source", () => {
    if (process.platform === "win32") return;
    const root = tempRoot();
    const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-v3-backup-"));
    const task = path.join(root, "tasks", "safe.yml");
    fs.writeFileSync(task, SAFE, { mode: 0o640 });
    const plan = planTaskV2ToV3Migration(inspectTaskV2ToV3Files([{ bundleId: "stash", root, writable: true }]));
    const backup = taskMigrationBackupPath(backupRoot, task);
    const target = path.join(backupRoot, "attacker-controlled");
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.writeFileSync(target, SAFE);
    fs.symlinkSync(target, backup);
    try {
      expect(() => applyTaskV2ToV3MigrationPlan(plan, { backupRoot })).toThrow(/backup|symbolic/i);
      expect(fs.readFileSync(task, "utf8")).toBe(SAFE);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(backupRoot, { recursive: true, force: true });
    }
  });

  test("refuses symlinked task trees and classifies read-only v2 files as blocked", () => {
    if (process.platform === "win32") return;
    const root = tempRoot();
    const outside = tempRoot();
    fs.rmSync(path.join(root, "tasks"), { recursive: true, force: true });
    fs.symlinkSync(path.join(outside, "tasks"), path.join(root, "tasks"), "dir");
    fs.writeFileSync(path.join(outside, "tasks", "x.yml"), SAFE);
    try {
      expect(() => inspectTaskV2ToV3Files([{ bundleId: "stash", root, writable: true }])).toThrow(/symbolic|symlink/i);
      const readOnly = inspectTaskV2ToV3Files([{ bundleId: "vendor", root: outside, writable: false }]);
      const plan = planTaskV2ToV3Migration(readOnly);
      expect(plan.files).toHaveLength(1);
      expect(plan.files[0]).toMatchObject({ status: "blocked", reason: "read-only-source" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("inspects standalone akm-task component roots without inventing a tasks subdirectory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-v3-flat-"));
    const task = path.join(root, "nightly.yml");
    fs.writeFileSync(task, SAFE);
    fs.writeFileSync(path.join(root, "README.md"), "# ignored\n");
    try {
      const inputs = inspectTaskV2ToV3Files([{ bundleId: "standalone", root, writable: true, layout: "akm-task" }]);
      expect(inputs.map((input) => input.filePath)).toEqual([task]);
      expect(planTaskV2ToV3Migration(inputs).files).toMatchObject([
        { filePath: task, status: "changed", reason: "v2-task-converted" },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) out[relative] = fs.readFileSync(absolute).toString("hex");
      else out[relative] = entry.isSymbolicLink() ? `symlink:${fs.readlinkSync(absolute)}` : "special";
    }
  };
  walk(root);
  return out;
}
