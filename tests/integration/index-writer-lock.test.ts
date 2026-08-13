import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { isProcessAlive } from "../../src/core/common";
import { getIndexWriterLockPath } from "../../src/core/paths";
import {
  acquireIndexWriterLease,
  probeIndexWriterLease,
  withIndexWriterLease,
} from "../../src/indexer/index-writer-lock";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

/**
 * Mirrors `INDEX_WRITER_LOCK_STALE_AFTER_MS` in `src/indexer/index-writer-lock.ts`.
 * The production constant is module-private, so it is duplicated here on purpose:
 * the age-reclaim tests below straddle this exact boundary, and changing the
 * production threshold should trip them rather than silently widen the window in
 * which a *live, still-working* writer can have its lease taken away.
 */
const INDEX_WRITER_LOCK_STALE_AFTER_MS = 12 * 60 * 60 * 1000;

/**
 * Plant an index-writer sentinel owned by a real, foreign, genuinely LIVE pid
 * (our parent process — always alive for the duration of this run and never
 * equal to `process.pid`; same trick as the timeout test below), with its mtime
 * backdated by `ageMs`. Because `probeLock` checks liveness BEFORE age
 * (`src/core/file-lock.ts:205-210`), the only branch that can ever classify this
 * sentinel stale is the age branch — never `pid_dead`.
 */
function plantLiveHolderLock(ageMs: number): string {
  const lockPath = getIndexWriterLockPath();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, String(process.ppid), "utf8");
  const backdated = new Date(Date.now() - ageMs);
  fs.utimesSync(lockPath, backdated, backdated);
  return lockPath;
}

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

describe("index writer lease", () => {
  test("supports nested same-context reentrancy and releases on the outermost close", async () => {
    await withIndexWriterLease({ purpose: "outer" }, async () => {
      await withIndexWriterLease({ purpose: "inner" }, async () => {
        const held = probeIndexWriterLease();
        expect(held.state).toBe("held");
        if (held.state === "held") expect(held.holderPid).toBe(process.pid);
      });
      expect(fs.existsSync(getIndexWriterLockPath())).toBe(true);
    });
    expect(fs.existsSync(getIndexWriterLockPath())).toBe(false);
  });

  test("wait mode acquires after another holder releases", async () => {
    const held = await acquireIndexWriterLease({ purpose: "held" });
    expect(held).toBeDefined();

    const waiter = acquireIndexWriterLease({ purpose: "waiter" });
    setTimeout(() => held?.release(), 50);

    const acquired = await waiter;
    expect(acquired).toBeDefined();
    const probe = probeIndexWriterLease();
    expect(probe.state).toBe("held");
    if (probe.state === "held") expect(probe.holderPid).toBe(process.pid);
    acquired?.release();
  });

  test("wait mode times out when another live holder does not release", async () => {
    const lockPath = getIndexWriterLockPath();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    // Hold the lock with a real but foreign live PID — our parent process,
    // which is always alive for the duration of this run and never equal to
    // process.pid. probeLock() then classifies it "held" (not "stale"), so the
    // waiter keeps waiting until it times out. No subprocess spawn (banned in
    // unit scope) and portable across platforms.
    fs.writeFileSync(lockPath, String(process.ppid), "utf8");

    await expect(acquireIndexWriterLease({ purpose: "waiter", maxWaitMs: 20 })).rejects.toThrow(
      "timed out waiting for index writer lease",
    );
  });

  test("reclaims a lease whose live holder has exceeded the stale window", async () => {
    // Regression (#757): a genuinely alive holder — a slow `akm index --full`
    // that is still working — loses its nominally-exclusive lease purely on
    // age. This pins that behavior at the production threshold so the
    // double-grant window cannot widen unnoticed.
    const lockPath = plantLiveHolderLock(INDEX_WRITER_LOCK_STALE_AFTER_MS + 60_000);
    expect(isProcessAlive(process.ppid)).toBe(true);

    const before = probeIndexWriterLease();
    expect(before.state).toBe("stale");
    if (before.state === "stale") {
      // Not "pid_dead": the holder is alive, so age is what makes it stale.
      expect(before.reason).toBe("age_exceeded");
      expect(before.holderPid).toBe(process.ppid);
    }

    // "try" mode never waits and never retries, so the only way it can return a
    // lease is by reclaiming the planted sentinel.
    const lease = await acquireIndexWriterLease({ purpose: "age-reclaim", mode: "try" });
    expect(lease).toBeDefined();

    const after = probeIndexWriterLease();
    expect(after.state).toBe("held");
    if (after.state === "held") expect(after.holderPid).toBe(process.pid);

    lease?.release();
    expect(fs.existsSync(lockPath)).toBe(false);
    // The reclaimed sentinel is removed, not left behind as a quarantine file.
    const leftovers = fs.readdirSync(path.dirname(lockPath)).filter((name) => name.includes(".stale-"));
    expect(leftovers).toEqual([]);
  });

  test("does not reclaim a live holder's lease from inside the stale window", async () => {
    // Negative control for the test above: same live foreign holder, same
    // reclaim path, only the age differs. Without this, an implementation that
    // reclaimed *every* contended lock would still pass the reclaim test.
    const lockPath = plantLiveHolderLock(INDEX_WRITER_LOCK_STALE_AFTER_MS - 60_000);

    const before = probeIndexWriterLease();
    expect(before.state).toBe("held");
    if (before.state === "held") expect(before.holderPid).toBe(process.ppid);

    const lease = await acquireIndexWriterLease({ purpose: "no-reclaim", mode: "try" });
    expect(lease).toBeUndefined();

    const after = probeIndexWriterLease();
    expect(after.state).toBe("held");
    if (after.state === "held") expect(after.holderPid).toBe(process.ppid);
    expect(fs.readFileSync(lockPath, "utf8")).toBe(String(process.ppid));
  });

  test("wait mode with maxWaitMs:0 still acquires an immediately-free lock", async () => {
    // Regression: the timeout must be checked *after* a real acquisition
    // attempt, not before — otherwise maxWaitMs:0 throws without ever trying,
    // even when the lock is free.
    const lease = await acquireIndexWriterLease({ purpose: "instant", maxWaitMs: 0 });
    expect(lease).toBeDefined();
    const probe = probeIndexWriterLease();
    expect(probe.state).toBe("held");
    if (probe.state === "held") expect(probe.holderPid).toBe(process.pid);
    lease?.release();
  });

  test("withIndexWriterLease holds the lock for the callback", async () => {
    await withIndexWriterLease({ purpose: "callback" }, async () => {
      const probe = probeIndexWriterLease();
      expect(probe.state).toBe("held");
      if (probe.state === "held") expect(probe.holderPid).toBe(process.pid);
    });
    expect(fs.existsSync(getIndexWriterLockPath())).toBe(false);
  });

  test("reentrancy is scoped to the owning async context, not the whole process", async () => {
    let releaseOuter!: () => void;
    let outerEntered!: () => void;
    const outerReady = new Promise<void>((resolve) => {
      outerEntered = resolve;
    });
    const outerGate = new Promise<void>((resolve) => {
      releaseOuter = resolve;
    });
    const outer = withIndexWriterLease({ purpose: "outer-context" }, async () => {
      outerEntered();
      await outerGate;
      await withIndexWriterLease({ purpose: "nested-context" }, async () => {});
    });
    await outerReady;

    let contenderEntered = false;
    const contender = withIndexWriterLease({ purpose: "independent-context" }, async () => {
      contenderEntered = true;
    });
    await Bun.sleep(30);
    expect(contenderEntered).toBe(false);

    releaseOuter();
    await Promise.all([outer, contender]);
    expect(contenderEntered).toBe(true);
  });
});
