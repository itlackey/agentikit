// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #897: `backups/task-v3/` and `backups/task-v4/` accumulate one timestamped
 * snapshot dir per migration apply run and were never pruned — eight ~5.7 GB
 * state.db copies from repeated July migration runs added up to 49 GB.
 * `pruneTaskMigrationBackups` caps each generation's snapshot dir at the 5
 * most-recently-modified entries, mirroring `pruneOldBackups`/
 * `MAX_CONFIG_BACKUPS` for config backups (#459).
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pruneTaskMigrationBackups } from "../../scripts/akm-migrate/task-migrate";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeBackupDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-migration-backups-"));
  roots.push(dir);
  return dir;
}

/** Create `<backupDir>/<name>/files/dummy` with a distinct mtime. */
function writeSnapshot(backupDir: string, name: string, mtime: Date): void {
  const snapshotDir = path.join(backupDir, name);
  fs.mkdirSync(path.join(snapshotDir, "files"), { recursive: true });
  fs.writeFileSync(path.join(snapshotDir, "files", "task.yml"), "version: 3\n");
  fs.utimesSync(snapshotDir, mtime, mtime);
}

describe("pruneTaskMigrationBackups (#897)", () => {
  test("keeps the 5 newest snapshot dirs and deletes the rest", () => {
    const backupDir = makeBackupDir();
    const base = Date.now();
    // 7 snapshots, oldest to newest, each 1 minute apart.
    const names = Array.from({ length: 7 }, (_, i) => `snap-${i}`);
    for (const [i, name] of names.entries()) writeSnapshot(backupDir, name, new Date(base + i * 60_000));

    pruneTaskMigrationBackups(backupDir);

    const remaining = fs.readdirSync(backupDir).sort();
    expect(remaining).toEqual(["snap-2", "snap-3", "snap-4", "snap-5", "snap-6"]);
    // The pruned dirs are gone entirely (recursive delete), not just emptied.
    expect(fs.existsSync(path.join(backupDir, "snap-0"))).toBe(false);
    expect(fs.existsSync(path.join(backupDir, "snap-1"))).toBe(false);
  });

  test("is a no-op when there are 5 or fewer snapshots", () => {
    const backupDir = makeBackupDir();
    const base = Date.now();
    for (let i = 0; i < 3; i++) writeSnapshot(backupDir, `snap-${i}`, new Date(base + i * 60_000));

    pruneTaskMigrationBackups(backupDir);

    expect(fs.readdirSync(backupDir).sort()).toEqual(["snap-0", "snap-1", "snap-2"]);
  });

  test("is a no-op (does not throw) when the backup dir does not exist yet", () => {
    const missing = path.join(os.tmpdir(), "akm-task-migration-backups-does-not-exist");
    expect(() => pruneTaskMigrationBackups(missing)).not.toThrow();
  });
});
