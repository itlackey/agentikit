// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { releaseLock } from "../../src/core/file-lock";
import { tryAcquireRunLock } from "../../src/core/run-lock";
import { type Cleanup, makeSandboxDir } from "../_helpers/sandbox";

let cleanup: Cleanup = () => {};
let lockPath = "";

beforeEach(() => {
  const dir = makeSandboxDir("akm-run-lock-");
  cleanup = dir.cleanup;
  lockPath = path.join(dir.dir, "some.lock");
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
  lockPath = "";
});

describe("tryAcquireRunLock — shared PID-liveness mechanics (#956)", () => {
  test("acquires a free lock", () => {
    const result = tryAcquireRunLock(lockPath, { label: "test" });
    expect(result.state).toBe("acquired");
    if (result.state !== "acquired") throw new Error("expected acquired");
    expect(fs.existsSync(lockPath)).toBe(true);
    releaseLock(result.ownership);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("reports the live holder's pid/startedAt when already held", () => {
    const startedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt }), "utf8");

    const result = tryAcquireRunLock(lockPath, { label: "test" });
    expect(result.state).toBe("held");
    if (result.state !== "held") throw new Error("expected held");
    expect(result.holder.pid).toBe(process.pid);
    expect(result.holder.startedAt).toBe(startedAt);
  });

  test("silently reclaims a lock whose holder is verifiably dead, regardless of age", () => {
    const deadPid = 999_999;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, startedAt: new Date(0).toISOString() }), "utf8");

    let reclaimed: { holderPid: number | null; reason: string } | undefined;
    const result = tryAcquireRunLock(lockPath, {
      label: "test",
      onReclaimed: (info) => {
        reclaimed = info;
      },
    });
    expect(result.state).toBe("acquired");
    expect(reclaimed?.holderPid).toBe(deadPid);
    expect(reclaimed?.reason).toBe("pid_not_alive");
    if (result.state === "acquired") releaseLock(result.ownership);
  });

  test("never reclaims a live holder purely on age (#872: no stale-age window)", () => {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    // A real, foreign, live pid — our parent process — with an ancient mtime.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, startedAt: new Date(0).toISOString() }), "utf8");
    const ancient = new Date(Date.now() - 24 * 60 * 60 * 1000);
    fs.utimesSync(lockPath, ancient, ancient);

    const result = tryAcquireRunLock(lockPath, { label: "test" });
    expect(result.state).toBe("held");
    if (result.state !== "held") throw new Error("expected held");
    expect(result.holder.pid).toBe(process.ppid);
  });
});
