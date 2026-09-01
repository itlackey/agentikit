// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache, saveConfig } from "../src/core/config/config";
import { isFormatExemptCommand } from "../src/output/format-exempt";
import { parseTaskSourceV4 } from "../src/tasks/source/task-source-v4";
import { runCliCapture } from "./_helpers/cli";
import { withIsolatedAkmStorage } from "./_helpers/sandbox";

function configureTaskBundle(stashDir: string): void {
  saveConfig({
    semanticSearchMode: "off",
    defaultBundle: "local",
    bundles: {
      local: {
        path: stashDir,
        writable: true,
        components: { main: { root: ".", adapter: "akm", writable: true } },
      },
    },
  });
  resetConfigCache();
}

function writeV2Task(stashDir: string): string {
  const taskPath = path.join(stashDir, "tasks", "legacy.yml");
  fs.mkdirSync(path.dirname(taskPath), { recursive: true });
  fs.writeFileSync(taskPath, 'version: 2\nschedule: "@daily"\nprompt: Say hello\n', "utf8");
  return taskPath;
}

test("migrate status/apply use the normal format pipeline", () => {
  expect(isFormatExemptCommand(["migrate", "status"])).toBe(false);
  expect(isFormatExemptCommand(["migrate", "apply"])).toBe(false);
});

test("status and apply --dry-run report the same combined two-generation plan without mutation", async () => {
  const storage = withIsolatedAkmStorage();
  try {
    configureTaskBundle(storage.stashDir);
    const taskPath = writeV2Task(storage.stashDir);
    const before = fs.readFileSync(taskPath);

    const status = await runCliCapture(["migrate", "status"]);
    const dryRun = await runCliCapture(["migrate", "apply", "--dry-run"]);
    expect(status.code, status.stderr).toBe(0);
    expect(dryRun.code, dryRun.stderr).toBe(0);
    expect(JSON.parse(dryRun.stdout)).toEqual(JSON.parse(status.stdout));
    expect(JSON.parse(status.stdout)).toMatchObject({
      schemaVersion: 1,
      status: "ready",
      blockers: [],
      // Generation 1 (v2 -> v3) sees the v2 file as ready to convert.
      taskV3Migration: { changed: 1, skipped: 0, blocked: 0 },
      // Generation 2 (v3 -> task source v4) sees the SAME still-v2 file as
      // skipped ("pending-v2-to-v3-migration"), not blocked — it becomes
      // reachable by this generation only once generation 1 runs (spec
      // docs/plans/specs/p4-deletions-closeout.md §3.2.5: "a blocked file
      // in generation 1 does not stop generation 2").
      taskV4Migration: { changed: 0, skipped: 1, blocked: 0 },
    });
    expect(fs.readFileSync(taskPath)).toEqual(before);
  } finally {
    storage.cleanup();
  }
});

test("apply runs v2->v3 to convergence, then v3->v4 against the resulting tree, keeping both backups", async () => {
  const storage = withIsolatedAkmStorage();
  try {
    configureTaskBundle(storage.stashDir);
    const taskPath = writeV2Task(storage.stashDir);

    const applied = await runCliCapture(["migrate", "apply"]);
    expect(applied.code, applied.stderr).toBe(0);
    const result = JSON.parse(applied.stdout) as {
      status: string;
      applied: number;
      backupPath: string;
      taskV4Applied: number;
      taskV4BackupPath: string;
      taskV3Migration: { changed: number; skipped: number; blocked: number };
      taskV4Migration: { changed: number; skipped: number; blocked: number };
    };
    expect(result).toMatchObject({
      status: "current",
      applied: 1,
      taskV3Migration: { changed: 0, skipped: 1, blocked: 0 },
      taskV4Applied: 1,
      taskV4Migration: { changed: 0, skipped: 1, blocked: 0 },
    });
    expect(fs.existsSync(result.backupPath)).toBe(true);
    expect(fs.existsSync(result.taskV4BackupPath)).toBe(true);
    // Both generations ran: the file lands on task source v4, not v3 —
    // generation 2 converted the file generation 1 just produced.
    expect(parseTaskSourceV4({ yaml: fs.readFileSync(taskPath, "utf8"), filePath: taskPath }).version).toBe(4);
  } finally {
    storage.cleanup();
  }
});

test("text output summarizes both generations of the task migration boundary", async () => {
  const storage = withIsolatedAkmStorage();
  try {
    configureTaskBundle(storage.stashDir);
    writeV2Task(storage.stashDir);
    const result = await runCliCapture(["migrate", "status", "--format", "text"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("ready");
    expect(result.stdout).toContain("task-v2->v3: 1 change, 0 current, 0 blocked");
    expect(result.stdout).toContain("task-v3->v4: 0 change, 1 current, 0 blocked");
    expect(result.stdout).not.toContain("config.json");
    expect(result.stdout).not.toContain("state.db");
  } finally {
    storage.cleanup();
  }
});
