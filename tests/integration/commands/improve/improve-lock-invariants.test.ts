// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Whole-run improve lock lifecycle invariants.
 *
 * Invariants pinned:
 *   1. No orphan lock files remain on disk after a completed run (acquire→release).
 *   2. The process.on("exit") backstop is removed after each run — listener count
 *      returns to baseline (no accumulation across runs).
 *   3. A stale lock (dead holder pid) is recovered: the run proceeds and an
 *      `improve_lock_recovered` event is emitted.
 *   4. A stale lock whose holder pid is still ALIVE but whose mtime has aged
 *      past the run's derived `lockStaleAfterMs` is recovered too, with
 *      `reason: "age_exceeded"` — and, as the negative control, a fresh lock
 *      with the same live holder is NOT recovered.
 *
 * Driven entirely in-process through akmImprove.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmImprove } from "../../../../src/commands/improve/improve";
import { MIN_IMPROVE_LOCK_STALE_MS } from "../../../../src/commands/improve/locks";
import { isProcessAlive } from "../../../../src/core/common";
import type { AkmConfig } from "../../../../src/core/config/config";
import { saveConfig } from "../../../../src/core/config/config";
import { readEvents } from "../../../../src/core/events";
import { type Cleanup, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

const TIMEOUT_MS = 20_000;

/**
 * How far to backdate the planted lock for the age-reclaim test.
 *
 * The threshold under test is NOT passed in by the test — `akmImprove` derives
 * it itself at `src/commands/improve/improve.ts:529` as
 * `max(MIN_IMPROVE_LOCK_STALE_MS, budgetMs + 10min)`, and these runs use the
 * default budget, so the 4h floor binds. Three times the real floor constant
 * clears that comfortably while staying expressed in production terms.
 */
const AGE_EXCEEDED_LOCK_AGE_MS = MIN_IMPROVE_LOCK_STALE_MS * 3;

/**
 * Plant an improve lock owned by a real, foreign, genuinely LIVE pid (our parent
 * process — alive for the whole run and never equal to `process.pid`), aged by
 * `ageMs`. `probeLock` checks liveness before age
 * (`src/core/file-lock.ts:205-210`), so this sentinel can only ever be
 * classified stale through the age branch, never `pid_dead`.
 */
function plantLiveHolderImproveLock(lockDir: string, ageMs: number): { lockPath: string; holderPid: number } {
  const lockPath = path.join(lockDir, ".akm", "improve.lock");
  const holderPid = process.ppid;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const lockedAt = new Date(Date.now() - ageMs);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: holderPid, startedAt: lockedAt.toISOString() }), "utf8");
  fs.utimesSync(lockPath, lockedAt, lockedAt);
  return { lockPath, holderPid };
}

let cleanup: Cleanup = () => {};
let stashDir = "";

function quietConfig(): AkmConfig {
  return {
    semanticSearchMode: "off",
    defaults: { improveStrategy: "quiet-test" },
    improve: {
      strategies: {
        "quiet-test": {
          processes: {
            reflect: { enabled: false },
            distill: { enabled: false },
            consolidate: { enabled: false },
            memoryInference: { enabled: false },
            graphExtraction: { enabled: false },
            extract: { enabled: false },
            validation: { enabled: false },
            triage: { enabled: true },
            proactiveMaintenance: { enabled: false },
            recombine: { enabled: false },
            procedural: { enabled: false },
          },
        },
      },
    },
  } as unknown as AkmConfig;
}

function lockFilesOnDisk(): string[] {
  const dir = path.join(stashDir, ".akm");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".lock"));
}

beforeEach(() => {
  const storage = withIsolatedAkmStorage();
  stashDir = storage.stashDir;
  cleanup = storage.cleanup;
  saveConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
  stashDir = "";
});

describe("akm improve — whole-run lock invariants", () => {
  test(
    "a completed run leaves no orphan lock files on disk",
    async () => {
      const result = await akmImprove({ scope: "memory", stashDir, config: quietConfig() });
      expect(result.ok).toBe(true);
      expect(lockFilesOnDisk()).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test(
    "the process exit backstop is removed after each run (no listener accumulation)",
    async () => {
      const baseline = process.listenerCount("exit");
      await akmImprove({ scope: "memory", stashDir, config: quietConfig() });
      await akmImprove({ scope: "memory", stashDir, config: quietConfig() });
      expect(process.listenerCount("exit")).toBe(baseline);
    },
    TIMEOUT_MS,
  );

  test(
    "a stale improve lock is recovered and emits improve_lock_recovered",
    async () => {
      // Plant a lock owned by a pid that cannot be alive → probeLock reports
      // state "stale" (reason pid_dead) regardless of mtime.
      const deadPid = 2_147_483_646;
      const lockPath = path.join(stashDir, ".akm", "improve.lock");
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, startedAt: new Date().toISOString() }), "utf8");

      const result = await akmImprove({ scope: "memory", stashDir, config: quietConfig() });
      expect(result.ok).toBe(true);

      const recovered = readEvents().events.filter((e) => e.eventType === "improve_lock_recovered");
      expect(recovered.length).toBeGreaterThanOrEqual(1);
      expect(recovered.at(-1)?.metadata?.lockName).toBe("improve");
      expect(lockFilesOnDisk()).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test(
    "an age-expired lock whose holder is still alive is recovered as age_exceeded",
    async () => {
      // Regression (#757): the companion to the pid_dead test above. Here the
      // holder is genuinely alive — an improve run that overran its own budget
      // — and only the lock's age makes it reclaimable. No staleAfterMs is
      // supplied by the test: akmImprove derives the real budget-based
      // threshold internally (improve.ts:529).
      const { lockPath, holderPid } = plantLiveHolderImproveLock(stashDir, AGE_EXCEEDED_LOCK_AGE_MS);
      expect(isProcessAlive(holderPid)).toBe(true);
      expect(holderPid).not.toBe(process.pid);

      const result = await akmImprove({ scope: "memory", stashDir, config: quietConfig() });
      expect(result.ok).toBe(true);

      const recovered = readEvents().events.filter((e) => e.eventType === "improve_lock_recovered");
      expect(recovered.length).toBe(1);
      const metadata = recovered[0]?.metadata ?? {};
      expect(metadata.lockName).toBe("improve");
      expect(metadata.reason).toBe("age_exceeded");
      expect(metadata.stalePid).toBe(holderPid);
      // The dispossessed holder was still running when its lock was taken —
      // exactly the live-writer double-grant this regression pins.
      expect(isProcessAlive(metadata.stalePid as number)).toBe(true);
      expect(metadata.lockAgeMs as number).toBeGreaterThanOrEqual(MIN_IMPROVE_LOCK_STALE_MS);

      // The planted sentinel was replaced, then released by the run that took it.
      expect(fs.existsSync(lockPath)).toBe(false);
      expect(lockFilesOnDisk()).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test(
    "a fresh lock whose holder is still alive is not recovered",
    async () => {
      // Negative control for the test above: identical live foreign holder,
      // identical code path, only the age differs. Without this, an
      // implementation that reclaimed every contended lock would still pass.
      const { lockPath, holderPid } = plantLiveHolderImproveLock(stashDir, 0);

      await expect(akmImprove({ scope: "memory", stashDir, config: quietConfig() })).rejects.toThrow(
        /akm improve is already running/,
      );

      expect(readEvents().events.filter((e) => e.eventType === "improve_lock_recovered")).toEqual([]);
      // The live holder's sentinel survives untouched.
      expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid).toBe(holderPid);
    },
    TIMEOUT_MS,
  );
});
