// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * R-011: `doSyncGit` resolved a git revision via a SEPARATE `git ls-remote`
 * round-trip (`resolveGitArtifact` / `resolveGithubArtifact` in
 * `registry/resolve.ts`) before cloning, then reported that PRE-clone
 * revision as `resolvedRevision` in the returned lock data without ever
 * comparing it to what actually got cloned. `verifyClonedRevision` closes
 * that gap: it re-derives the actual cloned HEAD and fails loudly on a
 * mismatch instead of silently trusting the earlier resolution.
 *
 * These tests exercise `verifyClonedRevision` directly against real local
 * git repos (no network) — the full `doSyncGit`/`syncGitRef` pipeline
 * additionally requires a `https/http/ssh/git` URL scheme (`validateGitUrl`
 * deliberately rejects bare local paths and `file:`), which would require
 * standing up a real git-over-the-wire server to exercise end-to-end; the
 * unit boundary tested here is where the R-011 fix actually lives.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyClonedRevision } from "../../src/sources/providers/git-install";

const createdTmpDirs: string[] = [];

function makeTempDir(prefix = "akm-clone-verify-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** A real bare repo + a real shallow clone of it, exactly like `doSyncGit` produces. */
function makeClonedFixture(): { remote: string; cloneDir: string; headSha: string } {
  const root = makeTempDir();
  const remote = path.join(root, "remote.git");
  const author = path.join(root, "author");
  const cloneDir = path.join(root, "clone");
  spawnSync("git", ["init", "--quiet", "--bare", remote]);
  spawnSync("git", ["init", "--quiet", "-b", "main", author]);
  git(author, ["config", "user.name", "AKM Test"]);
  git(author, ["config", "user.email", "akm@example.test"]);
  fs.writeFileSync(path.join(author, "a.txt"), "hello\n");
  git(author, ["add", "."]);
  git(author, ["commit", "--quiet", "-m", "seed"]);
  git(author, ["remote", "add", "origin", remote]);
  git(author, ["push", "--quiet", "-u", "origin", "main"]);
  git(root, ["clone", "--quiet", "--depth", "1", "--branch", "main", remote, cloneDir]);
  const headSha = git(cloneDir, ["rev-parse", "HEAD"]);
  return { remote, cloneDir, headSha };
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("verifyClonedRevision", () => {
  test("does not throw when the cloned HEAD matches the resolved revision", () => {
    const { cloneDir, headSha } = makeClonedFixture();
    expect(() => verifyClonedRevision(cloneDir, "https://example.test/repo.git", headSha)).not.toThrow();
  });

  test("is a no-op when no revision was resolved (undefined)", () => {
    const { cloneDir } = makeClonedFixture();
    expect(() => verifyClonedRevision(cloneDir, "https://example.test/repo.git", undefined)).not.toThrow();
  });

  test("throws when the cloned HEAD does NOT match the resolved revision", () => {
    const { cloneDir } = makeClonedFixture();
    const bogusRevision = "0123456789abcdef0123456789abcdef01234567";
    expect(() => verifyClonedRevision(cloneDir, "https://example.test/repo.git", bogusRevision)).toThrow(
      /does not match the revision resolved from/,
    );
  });

  test("peels an annotated-tag OBJECT id to its underlying commit before comparing", () => {
    // git ls-remote on an annotated tag reports the TAG OBJECT sha, not the
    // commit it points to — resolveGitRevisionFromRemote (registry/resolve.ts)
    // returns that object id verbatim. A naive string-equality check against
    // `git rev-parse HEAD` (which always reports a commit) would treat every
    // annotated-tag install as a false-positive mismatch.
    const root = makeTempDir();
    const remote = path.join(root, "remote.git");
    const author = path.join(root, "author");
    const cloneDir = path.join(root, "clone");
    spawnSync("git", ["init", "--quiet", "--bare", remote]);
    spawnSync("git", ["init", "--quiet", "-b", "main", author]);
    git(author, ["config", "user.name", "AKM Test"]);
    git(author, ["config", "user.email", "akm@example.test"]);
    fs.writeFileSync(path.join(author, "a.txt"), "hello\n");
    git(author, ["add", "."]);
    git(author, ["commit", "--quiet", "-m", "seed"]);
    git(author, ["tag", "-a", "v1", "-m", "annotated tag"]);
    git(author, ["remote", "add", "origin", remote]);
    git(author, ["push", "--quiet", "-u", "origin", "main"]);
    git(author, ["push", "--quiet", "origin", "v1"]);
    git(root, ["clone", "--quiet", "--depth", "1", "--branch", "v1", remote, cloneDir]);

    const tagObjectSha = git(author, ["rev-parse", "v1"]);
    const commitSha = git(cloneDir, ["rev-parse", "HEAD"]);
    expect(tagObjectSha).not.toBe(commitSha); // sanity: really is an annotated tag

    expect(() => verifyClonedRevision(cloneDir, remote, tagObjectSha)).not.toThrow();
  });

  test("error message names the clone dir, the url, and both revisions", () => {
    const { cloneDir, headSha } = makeClonedFixture();
    const bogusRevision = "f".repeat(40);
    let message = "";
    try {
      verifyClonedRevision(cloneDir, "https://example.test/mismatch.git", bogusRevision);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(cloneDir);
    expect(message).toContain("https://example.test/mismatch.git");
    expect(message).toContain(bogusRevision);
    expect(message).toContain(headSha);
  });
});
