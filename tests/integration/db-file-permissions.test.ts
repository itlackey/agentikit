// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Owner-only permissions on the managed databases and per-run task logs
 * (issue #756).
 *
 * `state.db`, `index.db`, `logs.db`, and `<cache>/tasks/logs/<id>/<ts>.log`
 * were created at whatever the process umask left them at (typically `0644`),
 * unlike every env/secret file akm writes — those pin `0600` through
 * `writeFileAtomic`'s default mode. On a shared host any local user could read
 * task history, captured command output, and indexed content straight off disk.
 *
 * The umask is deliberately widened to `0o022` inside these tests: pinning the
 * mode only under a restrictive ambient umask would prove nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { openLogsDatabase } from "../../src/core/logs-db";
import { openStateDatabase } from "../../src/core/state-db";
import { openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { runTask } from "../../src/tasks/runner";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

/** POSIX modes are not enforced on Windows — the production code skips there too. */
const isPosix = process.platform !== "win32";

function modeOf(target: string): number {
  return fs.statSync(target).mode & 0o777;
}

describe("managed databases are created 0600 in a 0700 dir (issue #756)", () => {
  let storage: IsolatedAkmStorage;
  let previousUmask: number | undefined;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    // The permissive default: without the fix these files land at 0644.
    previousUmask = process.umask(0o022);
  });
  afterEach(() => {
    if (previousUmask !== undefined) process.umask(previousUmask);
    storage?.cleanup();
  });

  test.skipIf(!isPosix)("state.db, index.db and logs.db are owner-only", () => {
    const dataDir = path.join(storage.dataDir, "akm");

    for (const open of [openStateDatabase, openIndexDatabase, openLogsDatabase]) {
      const db = open();
      db.close();
    }

    for (const name of ["state.db", "index.db", "logs.db"]) {
      const dbPath = path.join(dataDir, name);
      expect(fs.existsSync(dbPath), `${name} should exist`).toBe(true);
      expect(modeOf(dbPath), `${name} mode`).toBe(0o600);
      // The WAL sidecars carry the same page content, so they get the same mode.
      for (const suffix of ["-wal", "-shm"]) {
        const sidecar = `${dbPath}${suffix}`;
        if (fs.existsSync(sidecar)) expect(modeOf(sidecar), `${name}${suffix} mode`).toBe(0o600);
      }
    }

    expect(modeOf(dataDir), "data dir mode").toBe(0o700);
  });
});

describe("per-run task logs are written 0600 in a 0700 dir (issue #756)", () => {
  let storage: IsolatedAkmStorage;
  let previousUmask: number | undefined;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    previousUmask = process.umask(0o022);
  });
  afterEach(() => {
    if (previousUmask !== undefined) process.umask(previousUmask);
    storage?.cleanup();
  });

  test.skipIf(!isPosix)("a command task's log file and its directory are owner-only", async () => {
    const logDir = path.join(storage.cacheDir, "tasks", "logs");
    const taskPath = path.join(storage.stashDir, "tasks", "echoer.yml");
    fs.mkdirSync(path.dirname(taskPath), { recursive: true });
    fs.writeFileSync(
      taskPath,
      [
        "version: 2",
        'schedule: "@daily"',
        `command: ${JSON.stringify([process.execPath, "-e", "console.log('hello from the task')"])}`,
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runTask("echoer", { stashDir: storage.stashDir, logDir });

    expect(result.status).toBe("completed");
    expect(fs.readFileSync(result.log, "utf8")).toContain("hello from the task");
    expect(modeOf(result.log), "task log mode").toBe(0o600);
    expect(modeOf(path.dirname(result.log)), "task log dir mode").toBe(0o700);
  });
});
