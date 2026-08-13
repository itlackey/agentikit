// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Issue #759 (2/3) — `akm sync`'s compare-and-swap.
 *
 * `akm sync` commits through `saveGitStash` → `createExactPathCommit`
 * (src/sources/providers/git-stash.ts), which is a SEPARATE publication path
 * from the `ensureGitTransactionCommit` CAS in src/core/write-source.ts that
 * tests/integration/git-source-safety.test.ts already races
 * ("durable publication rejects a predecessor commit created after preflight").
 * This file ports that pattern onto the `akm sync` path.
 *
 * Two guards exist on this path, and they are NOT interchangeable:
 *
 *  1. The `options.expectedBaseHead` PREFLIGHT check (git-stash.ts) — used by
 *     the durable-transaction callers, which bind a base commit before they
 *     mutate the worktree.
 *  2. The `git update-ref <branch> <new> <old>` CAS inside
 *     `createExactPathCommit` — the real atomic swap, and the ONLY guard on
 *     the `akm sync` path, because `runSyncBody`
 *     (src/commands/sources/sources-cli.ts) calls
 *     `saveGitStash(name, message, writable, { push })` with no
 *     `expectedBaseHead`. `saveGitStash` reads HEAD itself, so a commit that
 *     lands BEFORE the call is simply adopted as the new base; only a commit
 *     that lands DURING the publication has to be rejected.
 *
 * Guard 2's window is a few microseconds wide between two synchronous `git`
 * invocations, so the racing commit is injected deterministically through the
 * `_setGitExactCommitHookForTests` seam rather than by wall-clock luck. The
 * racer is a REAL `git commit` in a REAL repository — nothing about the CAS
 * itself is faked.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  _setGitExactCommitHookForTests,
  type GitExactCommitPoint,
  saveGitStash,
} from "../../src/sources/providers/git";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
} from "../_helpers/sandbox";
import { overrideSeam } from "../_helpers/seams";

function git(repoDir: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const args of [
    ["init", "--initial-branch=main"],
    ["config", "user.email", "test@akm.local"],
    ["config", "user.name", "akm-test"],
    ["config", "commit.gpgsign", "false"],
  ]) {
    git(dir, args);
  }
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

/** Seed a repo with one commit and return its repo dir + that commit's oid. */
function seedRepo(): { repoDir: string; seedHead: string } {
  const repoDir = process.env.AKM_BUNDLE_DIR as string;
  initRepo(repoDir);
  writeFile(path.join(repoDir, "README.md"), "seed\n");
  git(repoDir, ["add", "."]);
  git(repoDir, ["commit", "-m", "seed"]);
  return { repoDir, seedHead: git(repoDir, ["rev-parse", "HEAD"]) };
}

/** Land an unrelated commit, exactly as a second process would. */
function landPredecessorCommit(repoDir: string, name: string): string {
  writeFile(path.join(repoDir, name), `${name}\n`);
  git(repoDir, ["add", "--", name]);
  git(repoDir, ["commit", "-m", `concurrent ${name}`]);
  return git(repoDir, ["rev-parse", "HEAD"]);
}

/** Every commit subject reachable from HEAD, newest first. */
function historySubjects(repoDir: string): string[] {
  const out = git(repoDir, ["log", "--format=%s"]);
  return out ? out.split("\n") : [];
}

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const dataResult = sandboxXdgDataHome(cacheResult.cleanup);
  const cfgResult = sandboxXdgConfigHome(dataResult.cleanup);
  const stashResult = sandboxStashDir(cfgResult.cleanup);
  envCleanup = stashResult.cleanup;
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
});

describe("akm sync — createExactPathCommit compare-and-swap", () => {
  test("rejects a commit whose base moved underneath it during publication", () => {
    const { repoDir } = seedRepo();
    writeFile(path.join(repoDir, "memories", "owned.md"), "AKM snapshot\n");
    const baseHead = git(repoDir, ["rev-parse", "HEAD"]);

    // The racer lands INSIDE the commit sequence: after the temporary index has
    // been written, the commit object built, and every pre-check passed, but
    // before the ref swap. This is the only moment at which the update-ref CAS
    // is the thing that saves us.
    const firedPoints: GitExactCommitPoint[] = [];
    let racerHead = "";
    let headAtRaceWindow = "";
    overrideSeam(_setGitExactCommitHookForTests, (point: GitExactCommitPoint) => {
      firedPoints.push(point);
      headAtRaceWindow = git(repoDir, ["rev-parse", "HEAD"]);
      racerHead = landPredecessorCommit(repoDir, "user.txt");
    });

    expect(() =>
      // Exactly what `akm sync` calls: no expectedBaseHead, so guard 1 is inert
      // and only the update-ref CAS can reject this.
      saveGitStash(undefined, "sync race", undefined, { push: false, paths: ["memories/owned.md"] }),
    ).toThrow(/advanced before its exact commit/);

    // The race really interleaved: the hook fired once, and at that instant
    // HEAD was still the base the commit had been built on — i.e. the racing
    // commit landed strictly INSIDE the CAS window, not before it.
    expect(firedPoints).toEqual(["before-update-ref"]);
    expect(headAtRaceWindow).toBe(baseHead);
    expect(racerHead).not.toBe(baseHead);

    // HEAD is unchanged by the failed attempt: it is the racer's commit, and
    // akm's commit was never attached to the branch.
    expect(git(repoDir, ["rev-parse", "HEAD"])).toBe(racerHead);
    expect(historySubjects(repoDir)).toEqual(["concurrent user.txt", "seed"]);
    expect(git(repoDir, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n")).not.toContain("memories/owned.md");
  });

  test("the same publication succeeds when nothing races it", () => {
    const { repoDir } = seedRepo();
    writeFile(path.join(repoDir, "memories", "owned.md"), "AKM snapshot\n");
    const baseHead = git(repoDir, ["rev-parse", "HEAD"]);

    const result = saveGitStash(undefined, "sync clean", undefined, {
      push: false,
      paths: ["memories/owned.md"],
    });

    expect(result.committed).toBe(true);
    expect(git(repoDir, ["rev-parse", "HEAD"])).not.toBe(baseHead);
    expect(git(repoDir, ["rev-parse", "HEAD^"])).toBe(baseHead);
    expect(git(repoDir, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n")).toContain("memories/owned.md");
  });

  test("a commit that lands BEFORE the call is adopted as the new base, not rejected", () => {
    // Documents why the update-ref CAS is load-bearing for `akm sync`: without
    // an `expectedBaseHead`, a predecessor that lands before `saveGitStash`
    // starts is indistinguishable from an ordinary prior commit.
    const { repoDir } = seedRepo();
    writeFile(path.join(repoDir, "memories", "owned.md"), "AKM snapshot\n");
    const predecessor = landPredecessorCommit(repoDir, "user.txt");

    const result = saveGitStash(undefined, "sync after predecessor", undefined, {
      push: false,
      paths: ["memories/owned.md"],
    });

    expect(result.committed).toBe(true);
    expect(git(repoDir, ["rev-parse", "HEAD^"])).toBe(predecessor);
  });
});

describe("saveGitStash — expectedBaseHead preflight (durable-transaction callers)", () => {
  test("rejects a predecessor commit created after preflight", () => {
    const { repoDir } = seedRepo();
    writeFile(path.join(repoDir, "memories", "owned.md"), "AKM snapshot\n");
    // Preflight: the caller binds its transaction to this base …
    const baseHead = git(repoDir, ["rev-parse", "HEAD"]);
    // … and a concurrent process commits underneath it before publication.
    const predecessor = landPredecessorCommit(repoDir, "user.txt");
    expect(predecessor).not.toBe(baseHead);

    expect(() =>
      saveGitStash(undefined, "predecessor race", undefined, {
        push: false,
        paths: ["memories/owned.md"],
        expectedBaseHead: baseHead,
      }),
    ).toThrow(/advanced before its exact-path commit/);

    // HEAD is unchanged by the failed attempt.
    expect(git(repoDir, ["rev-parse", "HEAD"])).toBe(predecessor);
    expect(historySubjects(repoDir)).toEqual(["concurrent user.txt", "seed"]);
    expect(git(repoDir, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n")).not.toContain("memories/owned.md");
  });
});
