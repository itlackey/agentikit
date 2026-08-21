// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyTaskV2ToV3MigrationPlan,
  createTaskMigrationBackup,
  inspectTaskV2ToV3Files,
  restoreTaskMigrationBackup,
  taskMigrationBackupPath,
  verifyTaskMigrationBackup,
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
      const identity = inputs[0]?.inspectionIdentity;
      expect(identity?.root.realPath).toBe(fs.realpathSync(root));
      expect(identity?.file.realPath).toBe(fs.realpathSync(task));
      expect(typeof identity?.root.device).toBe("string");
      expect(typeof identity?.root.inode).toBe("string");
      expect(typeof identity?.file.device).toBe("string");
      expect(typeof identity?.file.inode).toBe("string");
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

  test("uses one physical source key through an internal ancestor symlink for verify, crash retry, and restore", () => {
    if (process.platform === "win32") return;
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-v3-inside-symlink-"));
    const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-v3-main-backup-"));
    const physicalParent = path.join(bundleRoot, "physical");
    const physicalComponent = path.join(physicalParent, "component");
    fs.mkdirSync(path.join(physicalComponent, "tasks"), { recursive: true });
    const aliasParent = path.join(bundleRoot, "alias");
    fs.symlinkSync(physicalParent, aliasParent, "dir");
    const lexicalComponent = path.join(aliasParent, "component");
    const lexicalTask = path.join(lexicalComponent, "tasks", "safe.yml");
    fs.writeFileSync(lexicalTask, SAFE, { mode: 0o640 });
    const physicalTask = fs.realpathSync(lexicalTask);
    try {
      const plan = planTaskV2ToV3Migration(
        inspectTaskV2ToV3Files([{ bundleId: "inside-alias", root: lexicalComponent, bundleRoot, writable: true }]),
      );
      const manifest = createTaskMigrationBackup(backupRoot, plan, "inside-alias-operation");
      if (!manifest) throw new Error("expected a task backup manifest");
      expect(manifest.files.map((entry) => entry.sourcePath)).toEqual([physicalTask]);

      expect(() =>
        applyTaskV2ToV3MigrationPlan(plan, {
          backupRoot,
          backupManifest: manifest,
          testHooks: {
            beforePublish(filePath) {
              expect(filePath).toBe(lexicalTask);
              throw new Error("injected inside-alias pre-rename crash");
            },
          },
        }),
      ).toThrow(/injected|restored/i);
      expect(() => verifyTaskMigrationBackup(backupRoot, manifest)).not.toThrow();
      expect(plan.files.map((file) => file.inspectionIdentity?.file.realPath)).toEqual([physicalTask]);
      expect(JSON.parse(fs.readFileSync(path.join(backupRoot, manifest.recoveryPath), "utf8"))).toMatchObject({
        files: [{ sourcePath: physicalTask, state: "backed-up" }],
      });

      expect(applyTaskV2ToV3MigrationPlan(plan, { backupRoot, backupManifest: manifest }).changed).toEqual([
        lexicalTask,
      ]);
      expect(() => verifyTaskMigrationBackup(backupRoot, manifest)).not.toThrow();
      expect(JSON.parse(fs.readFileSync(path.join(backupRoot, manifest.recoveryPath), "utf8"))).toMatchObject({
        files: [{ sourcePath: physicalTask, state: "published" }],
      });
      expect(fs.readFileSync(lexicalTask, "utf8")).toContain("version: 3");

      expect(() => restoreTaskMigrationBackup(backupRoot, manifest)).not.toThrow();
      expect(fs.readFileSync(lexicalTask, "utf8")).toBe(SAFE);
      expect(fs.statSync(lexicalTask).mode & 0o777).toBe(0o640);
      expect(() => verifyTaskMigrationBackup(backupRoot, manifest)).not.toThrow();
    } finally {
      fs.rmSync(bundleRoot, { recursive: true, force: true });
      fs.rmSync(backupRoot, { recursive: true, force: true });
    }
  });

  test("rejects duplicate hard-linked task identities during inspection without writing", () => {
    const root = tempRoot();
    const backupRoot = path.join(root, "backups");
    const first = path.join(root, "tasks", "a.yml");
    const second = path.join(root, "tasks", "b.yml");
    fs.writeFileSync(first, SAFE, { mode: 0o640 });
    fs.linkSync(first, second);
    const before = snapshot(root);
    const identity = fs.lstatSync(first, { bigint: true });
    const detail = `duplicate physical task identity ${identity.dev}:${identity.ino} is referenced by ${first} and ${second}`;
    try {
      expect(() => inspectTaskV2ToV3Files([{ bundleId: "stash", root, writable: true }])).toThrow(detail);
      expect(snapshot(root)).toEqual(before);
      expect(fs.existsSync(backupRoot)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a task with an undiscovered outside hard link during inspection with zero writes", () => {
    const root = tempRoot();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-v3-outside-hardlink-"));
    const backupRoot = path.join(root, "backups");
    const task = path.join(root, "tasks", "safe.yml");
    const outsideAlias = path.join(outside, "safe-alias.yml");
    fs.writeFileSync(task, SAFE, { mode: 0o640 });
    fs.linkSync(task, outsideAlias);
    const beforeRoot = snapshot(root);
    const beforeOutside = snapshot(outside);
    try {
      expect(() => inspectTaskV2ToV3Files([{ bundleId: "stash", root, writable: true }])).toThrow(
        /hard link|link count|exactly one/i,
      );
      expect(snapshot(root)).toEqual(beforeRoot);
      expect(snapshot(outside)).toEqual(beforeOutside);
      expect(fs.existsSync(backupRoot)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a hard link introduced after planning is detected before any backup artifact or source mutation", () => {
    const root = tempRoot();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-v3-late-hardlink-"));
    const backupRoot = path.join(root, "backups");
    const task = path.join(root, "tasks", "safe.yml");
    const outsideAlias = path.join(outside, "safe-alias.yml");
    fs.writeFileSync(task, SAFE, { mode: 0o640 });
    try {
      const plan = planTaskV2ToV3Migration(inspectTaskV2ToV3Files([{ bundleId: "stash", root, writable: true }]));
      expect(
        (plan.files[0]?.inspectionIdentity?.file as unknown as { linkCount?: string } | undefined)?.linkCount,
      ).toBe("1");
      fs.linkSync(task, outsideAlias);
      const beforeRoot = snapshot(root);
      const beforeOutside = snapshot(outside);

      expect(() => createTaskMigrationBackup(backupRoot, plan, "late-hardlink-operation")).toThrow(
        /hard link|link count|identity|drift/i,
      );
      expect(snapshot(root)).toEqual(beforeRoot);
      expect(snapshot(outside)).toEqual(beforeOutside);
      expect(fs.existsSync(backupRoot)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a transient hard link after planning is detected before backup even after link count returns to one", () => {
    const root = tempRoot();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-v3-transient-plan-hardlink-"));
    const backupRoot = path.join(root, "backups");
    const task = path.join(root, "tasks", "safe.yml");
    const outsideAlias = path.join(outside, "safe-alias.yml");
    fs.writeFileSync(task, SAFE, { mode: 0o640 });
    try {
      const plan = planTaskV2ToV3Migration(inspectTaskV2ToV3Files([{ bundleId: "stash", root, writable: true }]));
      const plannedIdentity = plan.files[0]?.inspectionIdentity?.file;
      if (!plannedIdentity) throw new Error("expected a planned task identity");
      fs.linkSync(task, outsideAlias);
      fs.unlinkSync(outsideAlias);
      expect(fs.lstatSync(task).nlink).toBe(1);
      expect(fs.lstatSync(task, { bigint: true }).ctimeNs.toString()).not.toBe(plannedIdentity.changeTimeNs);
      const beforeRoot = snapshot(root);
      const beforeOutside = snapshot(outside);

      expect(() => createTaskMigrationBackup(backupRoot, plan, "transient-plan-hardlink-operation")).toThrow(
        /identity|drift|change/i,
      );
      expect(snapshot(root)).toEqual(beforeRoot);
      expect(snapshot(outside)).toEqual(beforeOutside);
      expect(fs.existsSync(backupRoot)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a hard link introduced after backup is detected before source publication", () => {
    const root = tempRoot();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-v3-publish-hardlink-"));
    const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-v3-main-backup-"));
    const task = path.join(root, "tasks", "safe.yml");
    const outsideAlias = path.join(outside, "safe-alias.yml");
    fs.writeFileSync(task, SAFE, { mode: 0o640 });
    try {
      const plan = planTaskV2ToV3Migration(inspectTaskV2ToV3Files([{ bundleId: "stash", root, writable: true }]));
      const manifest = createTaskMigrationBackup(backupRoot, plan, "publish-hardlink-operation");
      if (!manifest) throw new Error("expected a task backup manifest");
      fs.linkSync(task, outsideAlias);
      const beforeRoot = snapshot(root);
      const beforeOutside = snapshot(outside);
      const beforeBackup = snapshot(backupRoot);

      expect(() => applyTaskV2ToV3MigrationPlan(plan, { backupRoot, backupManifest: manifest })).toThrow(
        /hard link|link count|identity|drift/i,
      );
      expect(() => restoreTaskMigrationBackup(backupRoot, manifest)).toThrow(/hard link|link count|identity|drift/i);
      expect(snapshot(root)).toEqual(beforeRoot);
      expect(snapshot(outside)).toEqual(beforeOutside);
      expect(snapshot(backupRoot)).toEqual(beforeBackup);
      expect(fs.readFileSync(task, "utf8")).toBe(SAFE);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(backupRoot, { recursive: true, force: true });
    }
  });

  test("a transient hard link after backup blocks publication while satisfied restore stays a no-op", () => {
    const root = tempRoot();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-v3-transient-publish-hardlink-"));
    const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-v3-main-backup-"));
    const task = path.join(root, "tasks", "safe.yml");
    const outsideAlias = path.join(outside, "safe-alias.yml");
    fs.writeFileSync(task, SAFE, { mode: 0o640 });
    try {
      const plan = planTaskV2ToV3Migration(inspectTaskV2ToV3Files([{ bundleId: "stash", root, writable: true }]));
      const manifest = createTaskMigrationBackup(backupRoot, plan, "transient-publish-hardlink-operation");
      if (!manifest) throw new Error("expected a task backup manifest");
      const declaredIdentity = manifest.files[0]?.sourceIdentity;
      if (!declaredIdentity) throw new Error("expected a declared task identity");
      fs.linkSync(task, outsideAlias);
      fs.unlinkSync(outsideAlias);
      expect(fs.lstatSync(task).nlink).toBe(1);
      expect(fs.lstatSync(task, { bigint: true }).ctimeNs.toString()).not.toBe(declaredIdentity.changeTimeNs);
      const beforeRoot = snapshot(root);
      const beforeOutside = snapshot(outside);
      const beforeBackup = snapshot(backupRoot);

      expect(() => applyTaskV2ToV3MigrationPlan(plan, { backupRoot, backupManifest: manifest })).toThrow(
        /identity|drift|change/i,
      );
      // Explicit restore is already satisfied by the original bytes, so it is
      // a verified no-op rather than a publication path.
      expect(() => restoreTaskMigrationBackup(backupRoot, manifest)).not.toThrow();
      expect(snapshot(root)).toEqual(beforeRoot);
      expect(snapshot(outside)).toEqual(beforeOutside);
      expect(snapshot(backupRoot)).toEqual(beforeBackup);
      expect(fs.readFileSync(task, "utf8")).toBe(SAFE);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(backupRoot, { recursive: true, force: true });
    }
  });

  for (const transient of [false, true] as const) {
    test(`the final prepublication hook cannot race in a ${transient ? "transient " : ""}hard link`, () => {
      const root = tempRoot();
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-v3-hook-hardlink-"));
      const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-v3-main-backup-"));
      const task = path.join(root, "tasks", "safe.yml");
      const outsideAlias = path.join(outside, "safe-alias.yml");
      fs.writeFileSync(task, SAFE, { mode: 0o640 });
      try {
        const plan = planTaskV2ToV3Migration(inspectTaskV2ToV3Files([{ bundleId: "stash", root, writable: true }]));
        const manifest = createTaskMigrationBackup(backupRoot, plan, `hook-hardlink-${transient}`);
        if (!manifest) throw new Error("expected a task backup manifest");
        const entry = manifest.files[0];
        if (!entry) throw new Error("expected a task backup declaration");
        const beforeInode = fs.lstatSync(task).ino;
        const beforeBackup = fs.readFileSync(path.join(backupRoot, entry.backupPath));
        const beforeFinal = fs.readFileSync(path.join(backupRoot, entry.finalPath));

        expect(() =>
          applyTaskV2ToV3MigrationPlan(plan, {
            backupRoot,
            backupManifest: manifest,
            testHooks: {
              beforePublish(filePath) {
                expect(filePath).toBe(task);
                fs.linkSync(task, outsideAlias);
                if (transient) fs.unlinkSync(outsideAlias);
              },
            },
          }),
        ).toThrow(/hard link|link count|identity|drift|change/i);

        expect(fs.readFileSync(task, "utf8")).toBe(SAFE);
        expect(fs.lstatSync(task).ino).toBe(beforeInode);
        expect(fs.lstatSync(task).nlink).toBe(transient ? 1 : 2);
        expect(fs.readFileSync(path.join(backupRoot, entry.backupPath))).toEqual(beforeBackup);
        expect(fs.readFileSync(path.join(backupRoot, entry.finalPath))).toEqual(beforeFinal);
        expect(() => verifyTaskMigrationBackup(backupRoot, manifest)).not.toThrow();
        expect(JSON.parse(fs.readFileSync(path.join(backupRoot, manifest.recoveryPath), "utf8"))).toMatchObject({
          files: [{ sourcePath: entry.sourcePath, state: "backed-up" }],
        });
        expect(fs.readdirSync(path.dirname(task)).some((name) => name.includes(".tmp-task-v3-"))).toBe(false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
        fs.rmSync(backupRoot, { recursive: true, force: true });
      }
    });
  }

  test("rejects duplicate lexical aliases of one physical task with deterministic diagnostics and zero writes", () => {
    if (process.platform === "win32") return;
    const root = tempRoot();
    const backupRoot = path.join(root, "backups");
    const physicalTask = path.join(root, "tasks", "safe.yml");
    fs.writeFileSync(physicalTask, SAFE, { mode: 0o640 });
    const alias = path.join(root, "alias");
    fs.symlinkSync(root, alias, "dir");
    const lexicalTask = path.join(alias, "tasks", "safe.yml");
    const before = snapshot(root);
    const identity = fs.lstatSync(physicalTask, { bigint: true });
    const [first, second] = [lexicalTask, physicalTask].sort();
    const detail = `duplicate physical task identity ${identity.dev}:${identity.ino} is referenced by ${first} and ${second}`;
    try {
      expect(() =>
        inspectTaskV2ToV3Files([
          { bundleId: "a-stash", root, bundleRoot: root, writable: true },
          {
            bundleId: "z-alias-component",
            root: path.join(alias, "tasks"),
            bundleRoot: root,
            writable: true,
            layout: "akm-task",
          },
        ]),
      ).toThrow(detail);
      expect(snapshot(root)).toEqual(before);
      expect(fs.existsSync(backupRoot)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("public verification rejects a manifest that declares duplicate physical task identities", () => {
    const root = tempRoot();
    const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-v3-main-backup-"));
    const firstPath = path.join(root, "tasks", "a.yml");
    const secondPath = path.join(root, "tasks", "b.yml");
    fs.writeFileSync(firstPath, SAFE, { mode: 0o640 });
    fs.writeFileSync(secondPath, SAFE.replace("@daily", "@hourly"), { mode: 0o640 });
    try {
      const plan = planTaskV2ToV3Migration(inspectTaskV2ToV3Files([{ bundleId: "stash", root, writable: true }]));
      const manifest = createTaskMigrationBackup(backupRoot, plan, "duplicate-manifest-operation");
      if (!manifest) throw new Error("expected a task backup manifest");
      const [first, second] = manifest.files;
      if (!first || !second) throw new Error("expected two task backup declarations");
      const forged = {
        ...manifest,
        files: [
          first,
          {
            ...second,
            sourceIdentity: {
              ...second.sourceIdentity,
              device: first.sourceIdentity.device,
              inode: first.sourceIdentity.inode,
            },
          },
        ],
      };
      expect(() => verifyTaskMigrationBackup(backupRoot, forged)).toThrow(/duplicate physical task identity/i);
      expect(fs.readFileSync(firstPath, "utf8")).toBe(SAFE);
      expect(fs.readFileSync(secondPath, "utf8")).toBe(SAFE.replace("@daily", "@hourly"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(backupRoot, { recursive: true, force: true });
    }
  });

  test("public verification rejects hard-linked and tampered task identity provenance", () => {
    const root = tempRoot();
    const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-v3-main-backup-"));
    const task = path.join(root, "tasks", "safe.yml");
    fs.writeFileSync(task, SAFE, { mode: 0o640 });
    try {
      const plan = planTaskV2ToV3Migration(inspectTaskV2ToV3Files([{ bundleId: "stash", root, writable: true }]));
      const manifest = createTaskMigrationBackup(backupRoot, plan, "identity-provenance-operation");
      if (!manifest) throw new Error("expected a task backup manifest");
      const entry = manifest.files[0];
      if (!entry) throw new Error("expected a task backup declaration");
      const hardLinked = {
        ...manifest,
        files: [{ ...entry, sourceIdentity: { ...entry.sourceIdentity, linkCount: "2" } }],
      };
      expect(() => verifyTaskMigrationBackup(backupRoot, hardLinked)).toThrow(/hard-linked source/i);

      const malformed = {
        ...manifest,
        files: [{ ...entry, sourceIdentity: { ...entry.sourceIdentity, changeTimeNs: "not-a-time" } }],
      };
      expect(() => verifyTaskMigrationBackup(backupRoot, malformed)).toThrow(/invalid filesystem provenance/i);

      const drifted = {
        ...manifest,
        files: [
          {
            ...entry,
            sourceIdentity: {
              ...entry.sourceIdentity,
              changeTimeNs: (BigInt(entry.sourceIdentity.changeTimeNs) + 1n).toString(),
            },
          },
        ],
      };
      const beforeRoot = snapshot(root);
      const beforeBackup = snapshot(backupRoot);
      expect(() => applyTaskV2ToV3MigrationPlan(plan, { backupRoot, backupManifest: drifted })).toThrow(
        /provenance|authorized plan/i,
      );
      expect(snapshot(root)).toEqual(beforeRoot);
      expect(snapshot(backupRoot)).toEqual(beforeBackup);
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

  test("rejects a same-byte same-mode replacement inode before any write", () => {
    const root = tempRoot();
    const backupRoot = path.join(root, "backups");
    const task = path.join(root, "tasks", "safe.yml");
    const displaced = path.join(root, "tasks", "displaced.yml");
    fs.writeFileSync(task, SAFE, { mode: 0o640 });
    const plan = planTaskV2ToV3Migration(inspectTaskV2ToV3Files([{ bundleId: "stash", root, writable: true }]));
    fs.renameSync(task, displaced);
    fs.writeFileSync(task, SAFE, { mode: 0o640 });
    try {
      expect(fs.lstatSync(task).ino).not.toBe(fs.lstatSync(displaced).ino);
      expect(() => applyTaskV2ToV3MigrationPlan(plan, { backupRoot })).toThrow(/identity|inode|drift/i);
      expect(fs.readFileSync(task, "utf8")).toBe(SAFE);
      expect(fs.existsSync(backupRoot)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("the main-backup recovery ledger rejects same-byte inode drift before publication starts", () => {
    const root = tempRoot();
    const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-v3-main-backup-"));
    const task = path.join(root, "tasks", "safe.yml");
    const displaced = path.join(root, "tasks", "displaced.yml");
    fs.writeFileSync(task, SAFE, { mode: 0o640 });
    const plan = planTaskV2ToV3Migration(inspectTaskV2ToV3Files([{ bundleId: "stash", root, writable: true }]));
    const manifest = createTaskMigrationBackup(backupRoot, plan, "not-started-identity-operation");
    if (!manifest) throw new Error("expected a task backup manifest");
    fs.renameSync(task, displaced);
    fs.writeFileSync(task, SAFE, { mode: 0o640 });
    try {
      expect(() => applyTaskV2ToV3MigrationPlan(plan, { backupRoot, backupManifest: manifest })).toThrow(
        /identity|inode|drift/i,
      );
      expect(fs.readFileSync(task, "utf8")).toBe(SAFE);
      expect(() => verifyTaskMigrationBackup(backupRoot, manifest)).not.toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(backupRoot, { recursive: true, force: true });
    }
  });

  test("rejects replacement of the inspected component root even when file bytes and mode match", () => {
    const root = tempRoot();
    const displacedRoot = `${root}-displaced`;
    const backupRoot = `${root}-backups`;
    const task = path.join(root, "tasks", "safe.yml");
    fs.writeFileSync(task, SAFE, { mode: 0o640 });
    const plan = planTaskV2ToV3Migration(inspectTaskV2ToV3Files([{ bundleId: "stash", root, writable: true }]));
    fs.renameSync(root, displacedRoot);
    fs.mkdirSync(path.join(root, "tasks"), { recursive: true });
    fs.writeFileSync(task, SAFE, { mode: 0o640 });
    try {
      expect(() => applyTaskV2ToV3MigrationPlan(plan, { backupRoot })).toThrow(/root.*identity|identity.*root|drift/i);
      expect(fs.readFileSync(task, "utf8")).toBe(SAFE);
      expect(fs.existsSync(backupRoot)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(displacedRoot, { recursive: true, force: true });
      fs.rmSync(backupRoot, { recursive: true, force: true });
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
      expect(fs.readFileSync(taskMigrationBackupPath(backupRoot, first), "utf8")).toBe(SAFE);

      fs.unlinkSync(secondBackup);
      const retry = planTaskV2ToV3Migration(inspectTaskV2ToV3Files([{ bundleId: "stash", root, writable: true }]));
      expect(applyTaskV2ToV3MigrationPlan(retry, { backupRoot }).changed).toEqual([first, second]);
      expect(fs.readFileSync(first, "utf8")).toContain("version: 3");
      expect(fs.readFileSync(second, "utf8")).toContain("version: 3");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(backupRoot, { recursive: true, force: true });
    }
  });

  test("never overwrites a concurrent edit while compensating a failed publication", () => {
    const root = tempRoot();
    const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-v3-backup-"));
    const task = path.join(root, "tasks", "safe.yml");
    const concurrent = "# concurrent owner edit\n";
    fs.writeFileSync(task, SAFE, { mode: 0o640 });
    const plan = planTaskV2ToV3Migration(inspectTaskV2ToV3Files([{ bundleId: "stash", root, writable: true }]));
    const options = {
      backupRoot,
      testHooks: {
        afterPublish(filePath: string) {
          expect(filePath).toBe(task);
          fs.writeFileSync(filePath, concurrent, { mode: 0o640 });
        },
      },
    } as Parameters<typeof applyTaskV2ToV3MigrationPlan>[1] & {
      testHooks: { afterPublish(filePath: string): void };
    };
    try {
      expect(() => applyTaskV2ToV3MigrationPlan(plan, options)).toThrow(/compensation|concurrent|recover|backup/i);
      expect(fs.readFileSync(task, "utf8")).toBe(concurrent);
      expect(fs.readFileSync(taskMigrationBackupPath(backupRoot, task), "utf8")).toBe(SAFE);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(backupRoot, { recursive: true, force: true });
    }
  });

  test("compensates every published file in reverse order after an injected publication failure", () => {
    const root = tempRoot();
    const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-v3-backup-"));
    const tasks = ["a.yml", "b.yml", "c.yml"].map((name, index) => {
      const filePath = path.join(root, "tasks", name);
      fs.writeFileSync(filePath, SAFE.replace("@daily", `0 ${index} * * *`), { mode: 0o640 });
      return filePath;
    });
    const before = new Map(tasks.map((filePath) => [filePath, fs.readFileSync(filePath)]));
    const plan = planTaskV2ToV3Migration(inspectTaskV2ToV3Files([{ bundleId: "stash", root, writable: true }]));
    const publishedAndRestored: string[] = [];
    const realRenameSync = fs.renameSync;
    const rename = spyOn(fs, "renameSync").mockImplementation((oldPath, newPath) => {
      if (typeof newPath === "string" && tasks.includes(newPath)) publishedAndRestored.push(newPath);
      return realRenameSync(oldPath, newPath);
    });
    try {
      expect(() =>
        applyTaskV2ToV3MigrationPlan(plan, {
          backupRoot,
          testHooks: {
            afterPublish(filePath) {
              if (filePath === tasks[2]) throw new Error("injected post-publication failure");
            },
          },
        }),
      ).toThrow(/injected|restored/i);
      expect(publishedAndRestored).toEqual([...tasks, ...[...tasks].reverse()]);
      for (const filePath of tasks) {
        const expected = before.get(filePath);
        if (!expected) throw new Error(`missing before snapshot for ${filePath}`);
        expect(fs.readFileSync(filePath).toString("hex")).toBe(expected.toString("hex"));
        expect(fs.readFileSync(taskMigrationBackupPath(backupRoot, filePath)).toString("hex")).toBe(
          expected.toString("hex"),
        );
      }
    } finally {
      rename.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(backupRoot, { recursive: true, force: true });
    }
  });

  for (const position of [0, 1, 2] as const) {
    for (const timing of ["before", "after"] as const) {
      test(`retries the immutable main-backup plan after a ${timing}-rename fault on task ${position + 1}`, () => {
        const root = tempRoot();
        const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-v3-main-backup-"));
        const tasks = ["a.yml", "b.yml", "c.yml"].map((name, index) => {
          const filePath = path.join(root, "tasks", name);
          fs.writeFileSync(filePath, SAFE.replace("@daily", `0 ${index} * * *`), { mode: 0o640 });
          return filePath;
        });
        const before = new Map(tasks.map((filePath) => [filePath, fs.readFileSync(filePath)]));
        const plan = planTaskV2ToV3Migration(inspectTaskV2ToV3Files([{ bundleId: "stash", root, writable: true }]));
        const manifest = createTaskMigrationBackup(backupRoot, plan, "fault-matrix-operation");
        if (!manifest) throw new Error("expected a task backup manifest");
        const target = tasks[position];
        try {
          expect(() =>
            applyTaskV2ToV3MigrationPlan(plan, {
              backupRoot,
              backupManifest: manifest,
              testHooks: {
                ...(timing === "before"
                  ? {
                      beforePublish(filePath: string) {
                        if (filePath === target) throw new Error(`injected before-rename fault at ${target}`);
                      },
                    }
                  : {
                      afterPublish(filePath: string) {
                        if (filePath === target) throw new Error(`injected after-rename fault at ${target}`);
                      },
                    }),
              },
            }),
          ).toThrow(/injected|restored/i);
          for (const filePath of tasks) {
            expect(fs.readFileSync(filePath).equals(before.get(filePath) ?? Buffer.alloc(0))).toBe(true);
          }

          const retry = applyTaskV2ToV3MigrationPlan(plan, {
            backupRoot,
            backupManifest: manifest,
          });
          expect(retry.changed).toEqual(tasks);
          for (const filePath of tasks) expect(fs.readFileSync(filePath, "utf8")).toContain("version: 3");
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
          fs.rmSync(backupRoot, { recursive: true, force: true });
        }
      });
    }
  }

  test("propagates a source-directory fsync failure, compensates, and retries from the declared backup", () => {
    const root = tempRoot();
    const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-v3-main-backup-"));
    const task = path.join(root, "tasks", "safe.yml");
    fs.writeFileSync(task, SAFE, { mode: 0o640 });
    const plan = planTaskV2ToV3Migration(inspectTaskV2ToV3Files([{ bundleId: "stash", root, writable: true }]));
    const manifest = createTaskMigrationBackup(backupRoot, plan, "directory-fsync-operation");
    if (!manifest) throw new Error("expected a task backup manifest");
    const realOpenSync = fs.openSync;
    let injected = false;
    const open = spyOn(fs, "openSync").mockImplementation((filePath, flags, mode) => {
      if (!injected && flags === "r" && path.resolve(String(filePath)) === path.dirname(task)) {
        injected = true;
        throw Object.assign(new Error("injected task directory fsync failure"), { code: "EIO" });
      }
      return realOpenSync(filePath, flags, mode);
    });
    try {
      expect(() => applyTaskV2ToV3MigrationPlan(plan, { backupRoot, backupManifest: manifest })).toThrow(
        /directory fsync|restored/i,
      );
      expect(fs.readFileSync(task, "utf8")).toBe(SAFE);
      open.mockRestore();
      expect(applyTaskV2ToV3MigrationPlan(plan, { backupRoot, backupManifest: manifest }).changed).toEqual([task]);
      expect(fs.readFileSync(task, "utf8")).toContain("version: 3");
    } finally {
      open.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(backupRoot, { recursive: true, force: true });
    }
  });

  test("propagates a staged-source fsync failure before rename and retries without source mutation", () => {
    const root = tempRoot();
    const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-v3-main-backup-"));
    const task = path.join(root, "tasks", "safe.yml");
    fs.writeFileSync(task, SAFE, { mode: 0o640 });
    const plan = planTaskV2ToV3Migration(inspectTaskV2ToV3Files([{ bundleId: "stash", root, writable: true }]));
    const manifest = createTaskMigrationBackup(backupRoot, plan, "source-fsync-operation");
    if (!manifest) throw new Error("expected a task backup manifest");
    const tempDescriptors = new Set<number>();
    const realOpenSync = fs.openSync;
    const realFsyncSync = fs.fsyncSync;
    const open = spyOn(fs, "openSync").mockImplementation((filePath, flags, mode) => {
      const descriptor = realOpenSync(filePath, flags, mode);
      if (String(filePath).startsWith(`${task}.tmp-task-v3-`)) tempDescriptors.add(descriptor);
      return descriptor;
    });
    let injected = false;
    const fsync = spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
      if (!injected && tempDescriptors.has(descriptor)) {
        injected = true;
        throw Object.assign(new Error("injected staged source fsync failure"), { code: "EIO" });
      }
      return realFsyncSync(descriptor);
    });
    try {
      expect(() => applyTaskV2ToV3MigrationPlan(plan, { backupRoot, backupManifest: manifest })).toThrow(
        /source fsync|restored/i,
      );
      expect(fs.readFileSync(task, "utf8")).toBe(SAFE);
      open.mockRestore();
      fsync.mockRestore();
      expect(applyTaskV2ToV3MigrationPlan(plan, { backupRoot, backupManifest: manifest }).changed).toEqual([task]);
    } finally {
      open.mockRestore();
      fsync.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(backupRoot, { recursive: true, force: true });
    }
  });

  test("fails closed on corrupted task-backup bytes or noncanonical task-backup metadata", () => {
    const root = tempRoot();
    const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-v3-main-backup-"));
    const task = path.join(root, "tasks", "safe.yml");
    fs.writeFileSync(task, SAFE, { mode: 0o640 });
    const plan = planTaskV2ToV3Migration(inspectTaskV2ToV3Files([{ bundleId: "stash", root, writable: true }]));
    const manifest = createTaskMigrationBackup(backupRoot, plan, "corruption-operation");
    if (!manifest) throw new Error("expected a task backup manifest");
    const entry = manifest.files[0];
    if (!entry) throw new Error("expected a task backup entry");
    try {
      fs.writeFileSync(path.join(backupRoot, entry.backupPath), "corrupted original bytes", { mode: 0o600 });
      expect(() => verifyTaskMigrationBackup(backupRoot, manifest)).toThrow(/hash verification/i);
      fs.writeFileSync(path.join(backupRoot, entry.backupPath), SAFE, { mode: 0o600 });
      const recoveryPath = path.join(backupRoot, manifest.recoveryPath);
      const originalRecovery = fs.readFileSync(recoveryPath, "utf8");
      const invalidRecovery = JSON.parse(originalRecovery) as { operationId: string };
      invalidRecovery.operationId = "different-operation";
      fs.writeFileSync(recoveryPath, `${JSON.stringify(invalidRecovery, null, 2)}\n`, { mode: 0o600 });
      expect(() => verifyTaskMigrationBackup(backupRoot, manifest)).toThrow(/journal.*operation|does not match/i);
      fs.writeFileSync(recoveryPath, originalRecovery, { mode: 0o600 });
      const invalidManifest = {
        ...manifest,
        files: [{ ...entry, backupPath: "tasks/not-the-source-digest.before" }],
      };
      expect(() => verifyTaskMigrationBackup(backupRoot, invalidManifest)).toThrow(/canonical/i);
      expect(fs.readFileSync(task, "utf8")).toBe(SAFE);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(backupRoot, { recursive: true, force: true });
    }
  });

  test("tolerates unsupported directory fsync while retaining file fsync and atomic publication", () => {
    const root = tempRoot();
    const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-v3-backup-"));
    const task = path.join(root, "tasks", "safe.yml");
    fs.writeFileSync(task, SAFE, { mode: 0o640 });
    const plan = planTaskV2ToV3Migration(inspectTaskV2ToV3Files([{ bundleId: "stash", root, writable: true }]));
    const realOpenSync = fs.openSync;
    const open = spyOn(fs, "openSync").mockImplementation((filePath, flags, mode) => {
      if (flags === "r" && fs.statSync(filePath).isDirectory()) {
        throw Object.assign(new Error("simulated unsupported directory fsync"), { code: "EINVAL" });
      }
      return realOpenSync(filePath, flags, mode);
    });
    try {
      expect(() => applyTaskV2ToV3MigrationPlan(plan, { backupRoot })).not.toThrow();
      expect(fs.readFileSync(task, "utf8")).toContain("version: 3");
    } finally {
      open.mockRestore();
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
      expect(metadata).toEqual({
        schemaVersion: 1,
        source: task,
        mode: 0o640,
        beforeHash: change.beforeHash,
      });
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

  test("refuses dangling root and task-directory symlinks instead of treating them as absent", () => {
    if (process.platform === "win32") return;
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-v3-dangling-"));
    const danglingRoot = path.join(parent, "bundle-link");
    const root = tempRoot();
    fs.symlinkSync(path.join(parent, "missing-bundle"), danglingRoot, "dir");
    fs.rmSync(path.join(root, "tasks"), { recursive: true, force: true });
    fs.symlinkSync(path.join(parent, "missing-tasks"), path.join(root, "tasks"), "dir");
    try {
      expect(() => inspectTaskV2ToV3Files([{ bundleId: "dangling-root", root: danglingRoot, writable: true }])).toThrow(
        /symbolic|real directory|symlink/i,
      );
      expect(() => inspectTaskV2ToV3Files([{ bundleId: "dangling-tasks", root, writable: true }])).toThrow(
        /symbolic|task.*directory|symlink/i,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  test("classifies an on-disk read-only task as blocked even when its source config is writable", () => {
    const root = tempRoot();
    const task = path.join(root, "tasks", "disk-read-only.yml");
    fs.writeFileSync(task, SAFE, { mode: 0o444 });
    try {
      const plan = planTaskV2ToV3Migration(
        inspectTaskV2ToV3Files([{ bundleId: "writable-config", root, writable: true }]),
      );
      expect(plan.files).toMatchObject([{ filePath: task, status: "blocked", reason: "read-only-source" }]);
    } finally {
      fs.chmodSync(task, 0o640);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("classifies a task in an on-disk read-only publication directory as blocked", () => {
    if (process.platform === "win32") return;
    const root = tempRoot();
    const tasksDir = path.join(root, "tasks");
    const task = path.join(tasksDir, "directory-read-only.yml");
    fs.writeFileSync(task, SAFE, { mode: 0o640 });
    fs.chmodSync(tasksDir, 0o555);
    try {
      const plan = planTaskV2ToV3Migration(
        inspectTaskV2ToV3Files([{ bundleId: "writable-config", root, writable: true }]),
      );
      expect(plan.files).toMatchObject([{ filePath: task, status: "blocked", reason: "read-only-source" }]);
    } finally {
      fs.chmodSync(tasksDir, 0o755);
      fs.rmSync(root, { recursive: true, force: true });
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
