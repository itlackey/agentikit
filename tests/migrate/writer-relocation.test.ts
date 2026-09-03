// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * itlackey/akm#890: the migration step that relocates the five live `.akm/`
 * writers named in docs/architecture/internals/storage-locations.md's
 * "Formerly-misplaced live writers" section into `$STATE`/`$CACHE`.
 * `findWriterRelocationEntries` is read-only (status / apply --dry-run);
 * `applyWriterRelocation` is the mutating action `akm migrate apply` invokes.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  applyWriterRelocation,
  findWriterRelocationEntries,
} from "../../scripts/akm-migrate/migrate/writer-relocation";
import {
  getDistillRejectedDir,
  getEvalCasesDir,
  getMeasurementVerdictsDir,
  getStashLocksDir,
} from "../../src/core/paths";
import { makeStashDir, type SandboxedDir, sandboxXdgCacheHome, sandboxXdgStateHome } from "../_helpers/sandbox";

const disposers: Array<{ cleanup: () => void }> = [];

afterEach(() => {
  for (const d of disposers.splice(0)) d.cleanup();
});

function freshStash(): string {
  const stateSb = sandboxXdgStateHome();
  disposers.push(stateSb);
  const cacheSb = sandboxXdgCacheHome();
  disposers.push(cacheSb);
  const stash: SandboxedDir = makeStashDir();
  disposers.push(stash);
  return stash.dir;
}

// A pid that cannot be alive on any real system — `probeLock` classifies its
// holder as dead (reason "pid_dead") regardless of the lock's mtime. Same
// convention `improve-lock-invariants.test.ts` uses for the improve lock
// itself.
const DEAD_PID = 2_147_483_646;

function seedOldWriterFixture(stashDir: string, lockPid: number = DEAD_PID): void {
  const akmDir = path.join(stashDir, ".akm");
  fs.mkdirSync(path.join(akmDir, "distill-rejected"), { recursive: true });
  fs.writeFileSync(
    path.join(akmDir, "distill-rejected", "2026-01-01T00-00-00-000Z-lesson.md"),
    "---\nscore: 0.2\nreason: too vague\n---\n\nRejected.\n",
  );

  fs.mkdirSync(path.join(akmDir, "eval-cases"), { recursive: true });
  fs.writeFileSync(path.join(akmDir, "eval-cases", "human-rejected.md"), "# Eval Case\n");

  fs.mkdirSync(path.join(akmDir, "measurement", "verdicts"), { recursive: true });
  fs.writeFileSync(path.join(akmDir, "measurement", "verdicts", "verdict-2026-01-01.json"), "{}\n");
  fs.writeFileSync(path.join(akmDir, "measurement", "verdicts", "verdict-2026-01-01.md"), "# Verdict\n");
  // Manually-authored measurement input, sibling to verdicts/ — must never move.
  fs.writeFileSync(path.join(akmDir, "measurement", "treatment-pilot-2026-06-14.txt"), "personal//lessons/a\n");

  fs.writeFileSync(path.join(akmDir, "improve.lock"), JSON.stringify({ pid: lockPid, startedAt: "t" }));
  fs.writeFileSync(path.join(akmDir, ".improve.lock.operations.sensitive"), "");
  // Historical residue from a pre-consolidation-lock layout (itlackey/akm#890
  // names all four names defensively; only `improve.lock` is written by
  // current code, but a stale file from an older install may still exist).
  fs.writeFileSync(path.join(akmDir, "consolidate.lock"), JSON.stringify({ pid: lockPid, startedAt: "t" }));
  fs.writeFileSync(path.join(akmDir, ".consolidate.lock.operations.sensitive"), "");
}

describe("writer relocation detection (#890)", () => {
  test("reports nothing when .akm does not exist", () => {
    const stashDir = freshStash();
    expect(fs.existsSync(path.join(stashDir, ".akm"))).toBe(false);
    const plan = findWriterRelocationEntries(stashDir);
    expect(plan.directories).toEqual([]);
    expect(plan.lockArtifacts).toEqual([]);
    expect(plan.skippedLocks).toEqual([]);
  });

  test("finds every pending writer directory and stale lock artifact, and nothing else", () => {
    const stashDir = freshStash();
    seedOldWriterFixture(stashDir);
    // memory-cleanup is a Tier-3 keeper — must never be reported or touched.
    fs.mkdirSync(path.join(stashDir, ".akm", "memory-cleanup", "archive"), { recursive: true });

    const plan = findWriterRelocationEntries(stashDir);
    expect(plan.directories.map((d) => d.key).sort()).toEqual(["distillRejected", "evalCases", "measurementVerdicts"]);
    const evalCases = plan.directories.find((d) => d.key === "evalCases");
    expect(evalCases?.fileCount).toBe(1);
    expect(evalCases?.newPath).toBe(getEvalCasesDir(stashDir));
    const verdicts = plan.directories.find((d) => d.key === "measurementVerdicts");
    expect(verdicts?.fileCount).toBe(2);
    expect(verdicts?.newPath).toBe(getMeasurementVerdictsDir(stashDir));

    // Both fixture locks carry a dead pid, so both are classified stale —
    // pending removal, not skipped.
    const lockNames = plan.lockArtifacts.map((entry) => path.basename(entry.path)).sort();
    expect(lockNames).toEqual([
      ".consolidate.lock.operations.sensitive",
      ".improve.lock.operations.sensitive",
      "consolidate.lock",
      "improve.lock",
    ]);
    expect(plan.skippedLocks).toEqual([]);
  });
});

describe("writer relocation apply (#890)", () => {
  test("moves every writer directory's files, deletes lock artifacts, and cleans up empty old dirs", () => {
    const stashDir = freshStash();
    seedOldWriterFixture(stashDir);

    const result = applyWriterRelocation(stashDir);

    expect(result.directories.every((d) => d.errors.length === 0)).toBe(true);
    const moved = Object.fromEntries(result.directories.map((d) => [d.key, d.moved]));
    expect(moved).toEqual({ distillRejected: 1, evalCases: 1, measurementVerdicts: 2 });
    expect(result.lockArtifacts.every((entry) => entry.removed)).toBe(true);
    expect(result.lockArtifacts).toHaveLength(4);

    // New locations hold the moved content.
    expect(fs.readdirSync(getDistillRejectedDir(stashDir))).toHaveLength(1);
    expect(fs.readdirSync(getEvalCasesDir(stashDir))).toEqual(["human-rejected.md"]);
    expect(fs.readdirSync(getMeasurementVerdictsDir(stashDir)).sort()).toEqual([
      "verdict-2026-01-01.json",
      "verdict-2026-01-01.md",
    ]);

    // Old writer directories are gone (emptied and removed).
    expect(fs.existsSync(path.join(stashDir, ".akm", "distill-rejected"))).toBe(false);
    expect(fs.existsSync(path.join(stashDir, ".akm", "eval-cases"))).toBe(false);
    expect(fs.existsSync(path.join(stashDir, ".akm", "measurement", "verdicts"))).toBe(false);
    // Stale lock files and their mutex siblings are deleted, not moved.
    expect(fs.existsSync(path.join(stashDir, ".akm", "improve.lock"))).toBe(false);
    expect(fs.existsSync(path.join(stashDir, ".akm", ".improve.lock.operations.sensitive"))).toBe(false);
    expect(fs.existsSync(path.join(stashDir, ".akm", "consolidate.lock"))).toBe(false);

    // The pilot treatment file is untouched — `measurement/` itself survives.
    expect(fs.existsSync(path.join(stashDir, ".akm", "measurement", "treatment-pilot-2026-06-14.txt"))).toBe(true);
  });

  test("is idempotent: a second run reports and moves nothing", () => {
    const stashDir = freshStash();
    seedOldWriterFixture(stashDir);

    applyWriterRelocation(stashDir);
    const second = applyWriterRelocation(stashDir);

    expect(second.directories).toEqual([]);
    expect(second.lockArtifacts).toEqual([]);
    expect(second.skippedLocks).toEqual([]);
    expect(findWriterRelocationEntries(stashDir)).toEqual({ directories: [], lockArtifacts: [], skippedLocks: [] });
  });

  test("dry-run (the read-only finder) never mutates disk", () => {
    const stashDir = freshStash();
    seedOldWriterFixture(stashDir);

    const before = findWriterRelocationEntries(stashDir);
    expect(before.directories.length).toBeGreaterThan(0);
    expect(before.lockArtifacts.length).toBeGreaterThan(0);
    // Calling the finder again (what `status`/`apply --dry-run` do) changes nothing.
    expect(findWriterRelocationEntries(stashDir)).toEqual(before);

    expect(fs.existsSync(path.join(stashDir, ".akm", "distill-rejected", "2026-01-01T00-00-00-000Z-lesson.md"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(stashDir, ".akm", "improve.lock"))).toBe(true);
    expect(fs.existsSync(getDistillRejectedDir(stashDir))).toBe(false);
  });

  test("a file already present at the new location is left alone, not overwritten", () => {
    const stashDir = freshStash();
    seedOldWriterFixture(stashDir);
    fs.mkdirSync(getEvalCasesDir(stashDir), { recursive: true });
    fs.writeFileSync(path.join(getEvalCasesDir(stashDir), "human-rejected.md"), "already migrated\n");

    const result = applyWriterRelocation(stashDir);

    const evalResult = result.directories.find((d) => d.key === "evalCases");
    expect(evalResult?.moved).toBe(0);
    expect(evalResult?.errors).toEqual([]);
    expect(fs.readFileSync(path.join(getEvalCasesDir(stashDir), "human-rejected.md"), "utf8")).toBe(
      "already migrated\n",
    );
    // The stale old-location copy is left in place rather than deleted —
    // relocation only moves files that are not already at the destination.
    expect(fs.existsSync(path.join(stashDir, ".akm", "eval-cases", "human-rejected.md"))).toBe(true);
  });

  test("plants a fresh lock at the new location without disturbing relocation (lock placement)", () => {
    const stashDir = freshStash();
    seedOldWriterFixture(stashDir);
    applyWriterRelocation(stashDir);

    // A subsequent `akm improve` run creates its lock only at the new
    // location — never resurrecting `.akm/improve.lock`.
    const newLockDir = getStashLocksDir(stashDir);
    fs.mkdirSync(newLockDir, { recursive: true });
    fs.writeFileSync(path.join(newLockDir, "improve.lock"), JSON.stringify({ pid: 2, startedAt: "later" }));

    expect(fs.existsSync(path.join(stashDir, ".akm", "improve.lock"))).toBe(false);
    expect(fs.existsSync(path.join(newLockDir, "improve.lock"))).toBe(true);
    // Re-running the migration step again is still a no-op — it never reaches
    // into $STATE/locks to delete the live lock it just helped create.
    const rerun = applyWriterRelocation(stashDir);
    expect(rerun.lockArtifacts).toEqual([]);
    expect(fs.existsSync(path.join(newLockDir, "improve.lock"))).toBe(true);
  });
});

describe("writer relocation lock liveness (#890 blocker fix)", () => {
  test("a lock a live run holds is never deleted, and is reported under skippedLocks", () => {
    const stashDir = freshStash();
    const akmDir = path.join(stashDir, ".akm");
    fs.mkdirSync(akmDir, { recursive: true });
    // `process.ppid` is a real, foreign pid guaranteed alive for the whole
    // test run — the same convention improve-lock-invariants.test.ts uses.
    const holderPid = process.ppid;
    const lockPath = path.join(akmDir, "improve.lock");
    const mutexPath = path.join(akmDir, ".improve.lock.operations.sensitive");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: holderPid, startedAt: new Date().toISOString() }));
    fs.writeFileSync(mutexPath, "");

    const plan = findWriterRelocationEntries(stashDir);
    expect(plan.lockArtifacts).toEqual([]);
    expect(plan.skippedLocks).toEqual([{ path: lockPath, reason: "held", holderPid }]);

    const result = applyWriterRelocation(stashDir);
    expect(result.lockArtifacts).toEqual([]);
    expect(result.skippedLocks).toEqual([{ path: lockPath, reason: "held", holderPid }]);
    // Untouched on disk — the live holder still needs both files.
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.existsSync(mutexPath)).toBe(true);
  });

  test("a lock whose holder pid is dead is removed, together with its mutex sibling", () => {
    const stashDir = freshStash();
    const akmDir = path.join(stashDir, ".akm");
    fs.mkdirSync(akmDir, { recursive: true });
    const lockPath = path.join(akmDir, "improve.lock");
    const mutexPath = path.join(akmDir, ".improve.lock.operations.sensitive");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, startedAt: new Date().toISOString() }));
    fs.writeFileSync(mutexPath, "");

    const plan = findWriterRelocationEntries(stashDir);
    expect(plan.skippedLocks).toEqual([]);
    expect(plan.lockArtifacts.map((entry) => entry.path).sort()).toEqual([lockPath, mutexPath].sort());

    const result = applyWriterRelocation(stashDir);
    expect(result.skippedLocks).toEqual([]);
    expect(result.lockArtifacts.every((entry) => entry.removed)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(mutexPath)).toBe(false);
  });

  test("an orphaned mutex sidecar with no lock file is dead residue, removed unconditionally", () => {
    const stashDir = freshStash();
    const akmDir = path.join(stashDir, ".akm");
    fs.mkdirSync(akmDir, { recursive: true });
    const mutexPath = path.join(akmDir, ".improve.lock.operations.sensitive");
    fs.writeFileSync(mutexPath, "");

    const result = applyWriterRelocation(stashDir);
    expect(result.skippedLocks).toEqual([]);
    expect(result.lockArtifacts).toEqual([{ path: mutexPath, removed: true }]);
    expect(fs.existsSync(mutexPath)).toBe(false);
  });
});
