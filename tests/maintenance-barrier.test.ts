import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { acquireMaintenanceBarrier, tryAcquireMaintenanceBarrier } from "../src/core/maintenance-barrier";
import { getMaintenanceBarrierPath } from "../src/core/paths";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

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
