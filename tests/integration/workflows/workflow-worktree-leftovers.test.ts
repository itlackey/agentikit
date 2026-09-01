// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Worktree lifecycle safety (peer-review regression, R2):
 * `createUnitWorktree` used to `rmSync` ANY leftover directory at the attempt
 * path — destroying a previously RETAINED dirty worktree (or a crashed
 * attempt's partial work) on resume, in violation of the pinned
 * "never delete a dirty tree" invariant. Now:
 *
 *   - a CLEAN leftover is removed and re-created (old behaviour);
 *   - a DIRTY leftover is moved aside to `<dest>.retained-<ts>` with its
 *     contents intact, and reported via `preservedLeftover`;
 *   - an UNVERIFIABLE leftover (the `git status` probe fails — e.g. a
 *     half-created directory that is not a valid worktree) is moved aside
 *     too, never deleted.
 *
 * Uses a temp git repo fixture; skips gracefully when git is unavailable.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  cleanupUnitWorktree,
  createUnitWorktree,
  isGitAvailable,
  runWorktreeRoot,
} from "../../../src/workflows/exec/worktree";
import { git, makeGitRepo as makeTempGitRepo } from "../../_helpers/git";

const GIT = isGitAvailable();

const RUN_ID = "88888888-8888-4888-8888-888888888888";

let scratch: string[] = [];

beforeEach(() => {
  scratch = [runWorktreeRoot(RUN_ID)];
});

afterEach(() => {
  for (const dir of scratch) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/** Init a temp git repo with one committed file (`README.md`), removed in afterEach. */
function makeGitRepo(): string {
  return makeTempGitRepo({ prefix: "akm-wt-unit-repo-", register: (dir) => scratch.push(dir) });
}

/** Init a temp git repo whose committed `.gitignore` ignores `build/` and `*.log`. */
function makeGitRepoWithGitignore(): string {
  const dir = makeGitRepo();
  fs.writeFileSync(path.join(dir, ".gitignore"), "build/\n*.log\n");
  git(dir, ["add", ".gitignore"]);
  git(dir, ["commit", "-q", "-m", "gitignore"]);
  return dir;
}

async function mustCreate(repo: string, attemptId: string): Promise<{ path: string; preservedLeftover?: string }> {
  const result = await createUnitWorktree(repo, RUN_ID, attemptId);
  if (!result.ok) throw new Error(`createUnitWorktree failed: ${result.error}`);
  return result;
}

describe.skipIf(!GIT)("createUnitWorktree — leftover handling (never destroy dirty work)", () => {
  test("a DIRTY leftover at the attempt path is moved aside intact, not deleted", async () => {
    const repo = makeGitRepo();

    // First invocation mints the worktree; the unit leaves uncollected work
    // and the tree is RETAINED (e.g. the engine crashed before the step
    // completed). Re-running the same content-derived attempt id must not
    // destroy it.
    const first = await mustCreate(repo, "work:solo");
    fs.writeFileSync(path.join(first.path, "uncollected-work.txt"), "important\n");

    const second = await mustCreate(repo, "work:solo");
    expect(second.path).toBe(first.path);
    // Fresh checkout — the dirty file is not in the new worktree…
    expect(fs.existsSync(path.join(second.path, "uncollected-work.txt"))).toBe(false);
    expect(fs.existsSync(path.join(second.path, "README.md"))).toBe(true);
    // …because the leftover was moved aside with its contents intact.
    expect(second.preservedLeftover).toBeDefined();
    const preserved = second.preservedLeftover as string;
    expect(preserved.startsWith(`${first.path}.retained-`)).toBe(true);
    expect(fs.readFileSync(path.join(preserved, "uncollected-work.txt"), "utf8")).toBe("important\n");
  });

  test("a CLEAN leftover is removed and re-created (no retained copies pile up)", async () => {
    const repo = makeGitRepo();

    const first = await mustCreate(repo, "work:solo");
    const second = await mustCreate(repo, "work:solo");

    expect(second.path).toBe(first.path);
    expect(second.preservedLeftover).toBeUndefined();
    // Nothing was moved aside.
    const siblings = fs.readdirSync(path.dirname(second.path));
    expect(siblings.filter((name) => name.includes(".retained-"))).toEqual([]);
  });

  test("an UNVERIFIABLE leftover (status probe fails) is moved aside, never deleted", async () => {
    const repo = makeGitRepo();

    // A half-created directory that is NOT a valid worktree — `git status`
    // fails in it, so its state cannot be verified.
    const dest = path.join(runWorktreeRoot(RUN_ID), "work2-solo");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "partial.txt"), "maybe important\n");

    const created = await mustCreate(repo, "work2:solo");
    expect(created.path).toBe(dest);
    expect(created.preservedLeftover).toBeDefined();
    const preserved = created.preservedLeftover as string;
    expect(fs.readFileSync(path.join(preserved, "partial.txt"), "utf8")).toBe("maybe important\n");
    // The new worktree is a real checkout.
    expect(fs.existsSync(path.join(created.path, "README.md"))).toBe(true);
  });

  test("a preserved leftover is reported even when the re-creation then FAILS", async () => {
    const repo = makeGitRepo();

    const first = await mustCreate(repo, "work:solo");
    fs.writeFileSync(path.join(first.path, "uncollected-work.txt"), "important\n");

    // The base repo is gone by the time the attempt is retried: the leftover
    // can no longer be verified (so it is moved aside) and the `git worktree
    // add` that follows fails. The moved-aside copy is now the ONLY one of the
    // previous attempt's work, so the failure result must still carry it —
    // otherwise the operator is told worktree_failed and nothing else.
    fs.rmSync(path.join(repo, ".git"), { recursive: true, force: true });

    const failed = await createUnitWorktree(repo, RUN_ID, "work:solo");
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error).toContain("could not create isolation worktree");
    const preserved = failed.preservedLeftover as string;
    expect(preserved).toBeDefined();
    expect(preserved.startsWith(`${first.path}.retained-`)).toBe(true);
    expect(fs.readFileSync(path.join(preserved, "uncollected-work.txt"), "utf8")).toBe("important\n");
  });

  test("successive dirty leftovers get DISTINCT retained paths (no overwrite)", async () => {
    const repo = makeGitRepo();

    const first = await mustCreate(repo, "work:solo");
    fs.writeFileSync(path.join(first.path, "gen-1.txt"), "one\n");
    const second = await mustCreate(repo, "work:solo");
    fs.writeFileSync(path.join(second.path, "gen-2.txt"), "two\n");
    const third = await mustCreate(repo, "work:solo");

    const preservedFirst = second.preservedLeftover as string;
    const preservedSecond = third.preservedLeftover as string;
    expect(preservedFirst).toBeDefined();
    expect(preservedSecond).toBeDefined();
    expect(preservedSecond).not.toBe(preservedFirst);
    // Both generations of uncollected work survive.
    expect(fs.readFileSync(path.join(preservedFirst, "gen-1.txt"), "utf8")).toBe("one\n");
    expect(fs.readFileSync(path.join(preservedSecond, "gen-2.txt"), "utf8")).toBe("two\n");
  });
});

describe.skipIf(!GIT)(
  "cleanupUnitWorktree — the honest 'uncollected work' contract (ignored files are disposable)",
  () => {
    test("a worktree whose ONLY residue is .gitignore-matched files probes clean and IS removed", async () => {
      const repo = makeGitRepoWithGitignore();
      const wt = (await mustCreate(repo, "build:solo")).path;

      // The unit produced ONLY files the repo's own .gitignore declares
      // disposable (a build dir + a log). `git status --porcelain` (no
      // --ignored) reports these as clean, matching the documented contract:
      // ignored files are throwaway, so the worktree is removed, not retained.
      fs.mkdirSync(path.join(wt, "build"), { recursive: true });
      fs.writeFileSync(path.join(wt, "build", "out.o"), "artifact\n");
      fs.writeFileSync(path.join(wt, "debug.log"), "noise\n");

      const cleanup = await cleanupUnitWorktree(repo, wt);
      expect(cleanup.removed).toBe(true);
      expect(cleanup.dirty).toBe(false);
      expect(cleanup.error).toBeUndefined();
      expect(fs.existsSync(wt)).toBe(false);
    });

    test("an untracked UNIGNORED file is real uncollected work → dirty, retained (the contract boundary)", async () => {
      const repo = makeGitRepoWithGitignore();
      const wt = (await mustCreate(repo, "build:solo")).path;

      // A file the .gitignore does NOT match is genuine uncollected work.
      fs.writeFileSync(path.join(wt, "result.txt"), "keep me\n");

      const cleanup = await cleanupUnitWorktree(repo, wt);
      expect(cleanup.dirty).toBe(true);
      expect(cleanup.removed).toBe(false);
      // Retained intact — the caller logs the path.
      expect(fs.readFileSync(path.join(wt, "result.txt"), "utf8")).toBe("keep me\n");
    });
  },
);
