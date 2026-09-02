// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #896: the `data-dir-usage` health advisory must name the data dir's total
 * size and its largest top-level subdirectory (with size + percentage) when
 * the data dir dwarfs the live databases or one subdirectory dominates, and
 * stay silent on a small, balanced data dir. Also guards the cost: a data
 * dir with tens of thousands of small files must not make the walk slow.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectDataDirUsageAdvisory } from "../../../src/commands/health/data-dir-usage";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Write a file of exactly `bytes` size at `filePath`, creating parent dirs. */
function writeFileOfSize(filePath: string, bytes: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.alloc(bytes, 1));
}

describe("collectDataDirUsageAdvisory (#896)", () => {
  test("returns undefined when the data dir does not exist", () => {
    expect(collectDataDirUsageAdvisory(path.join(os.tmpdir(), "akm-data-dir-usage-does-not-exist"))).toBeUndefined();
  });

  test("returns undefined for a small, balanced data dir", () => {
    const dataDir = makeTempDir("akm-ddu-balanced-");
    writeFileOfSize(path.join(dataDir, "state.db"), 1_000_000);
    writeFileOfSize(path.join(dataDir, "index.db"), 500_000);
    writeFileOfSize(path.join(dataDir, "logs.db"), 200_000);
    // A modest backups/ dir, comparable in size to the live databases —
    // neither the bloat ratio nor the dominant-subdirectory threshold trips.
    writeFileOfSize(path.join(dataDir, "backups", "task-v3", "snap-1", "files", "a"), 300_000);

    expect(collectDataDirUsageAdvisory(dataDir)).toBeUndefined();
  });

  test("warns and names the dominating subdirectory with size and percentage", () => {
    const dataDir = makeTempDir("akm-ddu-dominated-");
    writeFileOfSize(path.join(dataDir, "state.db"), 1_000_000);
    writeFileOfSize(path.join(dataDir, "index.db"), 500_000);
    writeFileOfSize(path.join(dataDir, "logs.db"), 300_000);
    // backups/ dwarfs the live databases and dominates the total.
    for (let i = 0; i < 5; i++) {
      writeFileOfSize(path.join(dataDir, "backups", "migrations", `snap-${i}`, "state.db"), 4_000_000);
    }

    const advisory = collectDataDirUsageAdvisory(dataDir);
    expect(advisory).toBeDefined();
    expect(advisory?.name).toBe("data-dir-usage");
    expect(advisory?.status).toBe("warn");
    expect(advisory?.message).toContain("backups/ is");
    expect(advisory?.message).toMatch(/backups\/ is [\d.]+M \(9\d% of data dir\)/);
    const largest = advisory?.evidence?.largestSubdir as { name: string; bytes: number; percent: number };
    expect(largest.name).toBe("backups");
    expect(largest.bytes).toBe(20_000_000);
    expect(Math.round(largest.percent)).toBeGreaterThan(90);
  });

  test("walks ~50k small files under a second or two", () => {
    const dataDir = makeTempDir("akm-ddu-manyfiles-");
    writeFileOfSize(path.join(dataDir, "state.db"), 1_000_000);
    const logsDir = path.join(dataDir, "task-logs");
    fs.mkdirSync(logsDir, { recursive: true });
    for (let i = 0; i < 50_000; i++) {
      fs.writeFileSync(path.join(logsDir, `run-${i}.log`), "x");
    }

    const start = performance.now();
    collectDataDirUsageAdvisory(dataDir);
    const elapsedMs = performance.now() - start;

    console.log(`[data-dir-usage] 50k-file walk took ${elapsedMs.toFixed(0)}ms`);
    expect(elapsedMs).toBeLessThan(2000);
  }, 10_000);
});
