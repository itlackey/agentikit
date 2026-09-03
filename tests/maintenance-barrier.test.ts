// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { acquireMaintenanceBarrier, tryAcquireMaintenanceBarrier } from "../src/core/maintenance-barrier";
import { getMaintenanceBarrierPath } from "../src/core/paths";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

/**
 * Plant a maintenance-barrier sentinel owned by a real, foreign, genuinely
 * LIVE pid (our parent process), with its mtime backdated by `ageMs`.
 */
function plantLiveHolderBarrier(ageMs: number): string {
  const lockPath = getMaintenanceBarrierPath();
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

describe("maintenance barrier staleness (#9)", () => {
  test("does not reclaim a live, recently-acquired barrier", () => {
    plantLiveHolderBarrier(1_000);

    const release = tryAcquireMaintenanceBarrier();
    expect(release).toBeUndefined();
    expect(fs.existsSync(getMaintenanceBarrierPath())).toBe(true);
  });

  // The barrier only ever protects a short critical section (registering one
  // lock/lease/activity). A live holder that still has it past
  // MAINTENANCE_BARRIER_STALE_AFTER_MS is wedged — crashed mid-section,
  // deadlocked, or killed without releasing — not doing legitimate long-
  // running work. Without an age bound, every other akm invocation was
  // locked out of ANY maintenance registration forever, with no recovery but
  // killing the holder by hand.
  test("self-reclaims a wedged barrier whose live holder has exceeded the stale-age window", () => {
    const lockPath = plantLiveHolderBarrier(10 * 60 * 1000); // 10 minutes, well past the window

    const release = tryAcquireMaintenanceBarrier();
    expect(release).toBeDefined();
    expect(fs.readFileSync(lockPath, "utf8")).toContain(String(process.pid));
    release?.();
  });

  test("acquireMaintenanceBarrier names the reclaim path when it must abort", () => {
    plantLiveHolderBarrier(1_000);

    expect(() => acquireMaintenanceBarrier()).toThrow(/reclaimed automatically/);
  });
});
