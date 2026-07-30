// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Regression suite for the auto-sync staging behaviour (#476 + the auto-sync
// incident where stray non-akm files in the stash root refused EVERY commit
// for ~1.5 days). `saveGitStash` no longer refuses when unrelated non-akm
// files are dirty; instead it SCOPES what it stages:
//   1. explicit `options.paths` → exactly those
//   2. fallback → akm-managed pathspecs (TYPE_DIRS + `.akm`) that exist
//   3. no managed pathspec → no commit (never broad-stage unrelated files)
// The non-akm files must be left untouched/uncommitted.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseAssetRef } from "../../scripts/akm-migrate/migrate/legacy-ref-grammar";
import {
  captureGitPathSnapshot,
  captureGitPublication,
  commitWriteTargetBoundary,
  ensureGitTransactionCommit,
  prepareWriteTargetForMutation,
  publishGitTransactionCommit,
  writeAssetToSource,
} from "../../src/core/write-source";
import { mergeLockEntriesSync } from "../../src/integrations/lockfile";
import { saveGitStash } from "../../src/sources/providers/git";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
  writeSandboxConfig,
} from "../_helpers/sandbox";

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const args of [
    ["init", "--initial-branch=main"],
    ["config", "user.email", "test@akm.local"],
    ["config", "user.name", "akm-test"],
    ["config", "commit.gpgsign", "false"],
  ] as string[][]) {
    const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function git(repoDir: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** Files (relative paths) touched by the most recent commit on HEAD. */
function committedFiles(repoDir: string): string[] {
  const out = spawnSync("git", ["-C", repoDir, "show", "--name-only", "--format=", "HEAD"], { encoding: "utf8" });
  return out.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Porcelain status lines (still-dirty working-tree paths). */
function status(repoDir: string): string {
  return spawnSync("git", ["-C", repoDir, "status", "--porcelain"], { encoding: "utf8" }).stdout;
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

describe("saveGitStash — scoped staging (auto-sync incident regression)", () => {
  test("named sync commits the lock-backed managed checkout instead of a URL-derived mirror", () => {
    const repoDir = process.env.AKM_BUNDLE_DIR as string;
    const contentDir = path.join(repoDir, "content");
    initRepo(repoDir);
    writeFile(path.join(contentDir, "memories", "seed.md"), "seed\n");
    spawnSync("git", ["-C", repoDir, "add", "."]);
    spawnSync("git", ["-C", repoDir, "commit", "-m", "seed"]);
    writeSandboxConfig({
      bundles: {
        team: {
          git: "https://example.com/team/stash.git",
          writable: true,
          components: { main: { root: ".", adapter: "akm", writable: true } },
        },
      },
    });
    mergeLockEntriesSync([
      {
        id: "team",
        source: "git",
        ref: "git+https://example.com/team/stash.git",
        localRoot: contentDir,
        installedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    writeFile(path.join(contentDir, "memories", "managed.md"), "managed\n");

    const result = saveGitStash("team", "managed sync", true, { push: false });

    expect(result.committed).toBe(true);
    expect(committedFiles(repoDir)).toEqual(["content/memories/managed.md"]);
  });

  test("content-layout boundary commits only content and leaves repository-root WIP dirty", () => {
    const repoDir = process.env.AKM_BUNDLE_DIR as string;
    const contentDir = path.join(repoDir, "content");
    initRepo(repoDir);
    writeFile(path.join(contentDir, "memories", "asset.md"), "asset\n");
    writeFile(path.join(repoDir, "src", "work-in-progress.ts"), "unrelated WIP\n");

    commitWriteTargetBoundary(
      {
        source: { kind: "git", name: "team", path: contentDir, repoPath: repoDir },
        config: { type: "git", name: "team", url: "https://example.com/team/stash.git", writable: true },
      },
      "content only",
      { push: false, paths: ["content/memories/asset.md"] },
    );

    expect(committedFiles(repoDir)).toEqual(["content/memories/asset.md"]);
    expect(status(repoDir)).toContain("src/");
  });

  test("content-layout boundary does not commit unrelated pre-staged WIP", () => {
    const repoDir = process.env.AKM_BUNDLE_DIR as string;
    const contentDir = path.join(repoDir, "content");
    initRepo(repoDir);
    writeFile(path.join(repoDir, "src", "staged-wip.ts"), "pre-staged WIP\n");
    const stageWip = spawnSync("git", ["-C", repoDir, "add", "--", "src/staged-wip.ts"], { encoding: "utf8" });
    expect(stageWip.status).toBe(0);
    writeFile(path.join(contentDir, "memories", "asset.md"), "asset\n");

    commitWriteTargetBoundary(
      {
        source: { kind: "git", name: "team", path: contentDir, repoPath: repoDir },
        config: { type: "git", name: "team", url: "https://example.com/team/stash.git", writable: true },
      },
      "content only",
      { push: false, paths: ["content/memories/asset.md"] },
    );

    expect(committedFiles(repoDir)).toEqual(["content/memories/asset.md"]);
    expect(status(repoDir)).toContain("A  src/staged-wip.ts");
  });

  test("write boundary excludes pre-staged WIP inside the same content asset directory", async () => {
    const repoDir = process.env.AKM_BUNDLE_DIR as string;
    const contentDir = path.join(repoDir, "content");
    initRepo(repoDir);
    writeFile(path.join(contentDir, "memories", "staged-wip.md"), "pre-staged content WIP\n");
    expect(
      spawnSync("git", ["-C", repoDir, "add", "--", "content/memories/staged-wip.md"], { encoding: "utf8" }).status,
    ).toBe(0);
    const target = {
      source: { kind: "git", name: "team", path: contentDir, repoPath: repoDir },
      config: { type: "git" as const, name: "team", url: "https://example.com/team/stash.git", writable: true },
    };

    await writeAssetToSource(
      target.source,
      target.config,
      parseAssetRef("memory:operation-owned"),
      "---\ndescription: Operation-owned memory\n---\n\nAsset body.\n",
    );
    commitWriteTargetBoundary(target, "exact operation paths", { push: false });

    expect(committedFiles(repoDir)).toEqual(["content/memories/operation-owned.md"]);
    expect(status(repoDir)).toContain("A  content/memories/staged-wip.md");
  });

  test("canonical writes reject same-path WIP before overwriting it", async () => {
    const repoDir = process.env.AKM_BUNDLE_DIR as string;
    const contentDir = path.join(repoDir, "content");
    const ownedPath = path.join(contentDir, "memories", "owned.md");
    initRepo(repoDir);
    writeFile(ownedPath, "committed content\n");
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "seed"]);
    writeFile(ownedPath, "user work in progress\n");
    const source = { kind: "git", name: "team", path: contentDir, repoPath: repoDir, adapterId: "akm" };
    const config = { type: "git" as const, name: "team", path: contentDir, writable: true };

    await expect(
      writeAssetToSource(
        source,
        config,
        { type: "memory", name: "owned" },
        "---\ndescription: Replacement\n---\n\nAKM replacement.\n",
      ),
    ).rejects.toThrow(/staged or unstaged work/);

    expect(fs.readFileSync(ownedPath, "utf8")).toBe("user work in progress\n");
    expect(git(repoDir, ["rev-list", "--count", "HEAD"])).toBe("1");
  });

  test("canonical writes reject ignored destinations before creating them", async () => {
    const repoDir = process.env.AKM_BUNDLE_DIR as string;
    const contentDir = path.join(repoDir, "content");
    const ignoredPath = path.join(contentDir, "memories", "ignored.md");
    initRepo(repoDir);
    writeFile(path.join(repoDir, ".gitignore"), "content/memories/ignored.md\n");
    git(repoDir, ["add", ".gitignore"]);
    git(repoDir, ["commit", "-m", "seed ignore"]);
    const source = { kind: "git", name: "team", path: contentDir, repoPath: repoDir, adapterId: "akm" };
    const config = { type: "git" as const, name: "team", path: contentDir, writable: true };

    await expect(
      writeAssetToSource(
        source,
        config,
        { type: "memory", name: "ignored" },
        "---\ndescription: Ignored memory\n---\n\nMust not be written.\n",
      ),
    ).rejects.toThrow(/is ignored/);

    expect(fs.existsSync(ignoredPath)).toBe(false);
    expect(git(repoDir, ["status", "--porcelain"])).toBe("");
  });

  test("mutation preparation rejects a detached local target before writing", async () => {
    const repoDir = process.env.AKM_BUNDLE_DIR as string;
    const contentDir = path.join(repoDir, "content");
    initRepo(repoDir);
    writeFile(path.join(repoDir, "README.md"), "seed\n");
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "seed"]);
    fs.mkdirSync(contentDir, { recursive: true });
    git(repoDir, ["checkout", "--detach"]);
    const target = {
      source: { kind: "git", name: "team", path: contentDir, repoPath: repoDir, adapterId: "akm" },
      config: { type: "git" as const, name: "team", path: contentDir, writable: true },
    };

    expect(() => prepareWriteTargetForMutation(target)).toThrow(/detached from a branch/i);
    expect(fs.existsSync(path.join(contentDir, "memories"))).toBe(false);
  });

  test("canonical boundaries reject edits made after the recorded write snapshot", async () => {
    const repoDir = process.env.AKM_BUNDLE_DIR as string;
    const contentDir = path.join(repoDir, "content");
    initRepo(repoDir);
    writeFile(path.join(repoDir, "README.md"), "seed\n");
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "seed"]);
    const target = {
      source: { kind: "git", name: "team", path: contentDir, repoPath: repoDir, adapterId: "akm" },
      config: { type: "git" as const, name: "team", path: contentDir, writable: true },
    };
    const result = await writeAssetToSource(
      target.source,
      target.config,
      { type: "memory", name: "owned" },
      "---\ndescription: Operation-owned memory\n---\n\nAKM content.\n",
    );
    writeFile(result.path, "post-write user edit\n");

    expect(() => commitWriteTargetBoundary(target, "snapshot-bound write", { push: false })).toThrow(
      /changed while committing/,
    );
    expect(git(repoDir, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(fs.readFileSync(result.path, "utf8")).toBe("post-write user edit\n");
  });

  test("durable publication rejects operation-path edits made after its snapshot", () => {
    const repoDir = process.env.AKM_BUNDLE_DIR as string;
    initRepo(repoDir);
    writeFile(path.join(repoDir, "README.md"), "seed\n");
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "seed"]);
    const target = prepareWriteTargetForMutation({
      source: { kind: "git", name: "team", path: repoDir, repoPath: repoDir, adapterId: "akm" },
      config: { type: "git", name: "team", path: repoDir, writable: true },
    });
    const publication = captureGitPublication(target);
    if (!publication) throw new Error("expected Git publication");
    const ownedPath = path.join(repoDir, "memories", "owned.md");
    writeFile(ownedPath, "AKM snapshot\n");
    const snapshot = captureGitPathSnapshot(target, ownedPath);
    writeFile(ownedPath, "post-crash user edit\n");

    expect(() =>
      ensureGitTransactionCommit(target, publication, {
        transactionId: "snapshot-divergence",
        message: "snapshot divergence",
        paths: [snapshot.path],
        snapshots: { [snapshot.path]: snapshot.state },
      }),
    ).toThrow(/diverged after mutation/);
    expect(git(repoDir, ["rev-list", "--count", "HEAD"])).toBe("1");
  });

  test("durable publication cannot treat a newly ignored operation path as a no-op", () => {
    const repoDir = process.env.AKM_BUNDLE_DIR as string;
    initRepo(repoDir);
    writeFile(path.join(repoDir, ".gitignore"), "memories/\n");
    git(repoDir, ["add", ".gitignore"]);
    git(repoDir, ["commit", "-m", "seed ignore"]);
    const target = prepareWriteTargetForMutation({
      source: { kind: "git", name: "team", path: repoDir, repoPath: repoDir, adapterId: "akm" },
      config: { type: "git", name: "team", path: repoDir, writable: true },
    });
    const publication = captureGitPublication(target);
    if (!publication) throw new Error("expected Git publication");
    const ownedPath = path.join(repoDir, "memories", "ignored.md");
    writeFile(ownedPath, "must not disappear from publication\n");
    const snapshot = captureGitPathSnapshot(target, ownedPath);

    expect(() =>
      ensureGitTransactionCommit(target, publication, {
        transactionId: "ignored-operation-path",
        message: "ignored path",
        paths: [snapshot.path],
        snapshots: { [snapshot.path]: snapshot.state },
      }),
    ).toThrow(/is ignored/);
    expect(git(repoDir, ["rev-list", "--count", "HEAD"])).toBe("1");
  });

  test("an ignored path aborts a mixed exact-path commit without staging its siblings", () => {
    const repoDir = process.env.AKM_BUNDLE_DIR as string;
    initRepo(repoDir);
    writeFile(path.join(repoDir, ".gitignore"), "memories/ignored.md\n");
    git(repoDir, ["add", ".gitignore"]);
    git(repoDir, ["commit", "-m", "seed ignore"]);
    writeFile(path.join(repoDir, "memories", "allowed.md"), "allowed\n");
    writeFile(path.join(repoDir, "memories", "ignored.md"), "ignored\n");

    expect(() =>
      saveGitStash(undefined, "mixed paths", undefined, {
        push: false,
        paths: ["memories/allowed.md", "memories/ignored.md"],
      }),
    ).toThrow(/is ignored/);

    expect(git(repoDir, ["diff", "--cached", "--name-only"])).toBe("");
    expect(git(repoDir, ["rev-list", "--count", "HEAD"])).toBe("1");
  });

  test("durable publication rejects a predecessor commit created after preflight", () => {
    const repoDir = process.env.AKM_BUNDLE_DIR as string;
    initRepo(repoDir);
    writeFile(path.join(repoDir, "README.md"), "seed\n");
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "seed"]);
    const target = prepareWriteTargetForMutation({
      source: { kind: "git", name: "team", path: repoDir, repoPath: repoDir, adapterId: "akm" },
      config: { type: "git", name: "team", path: repoDir, writable: true },
    });
    const publication = captureGitPublication(target);
    if (!publication) throw new Error("expected Git publication");
    const ownedPath = path.join(repoDir, "memories", "owned.md");
    writeFile(ownedPath, "AKM snapshot\n");
    const snapshot = captureGitPathSnapshot(target, ownedPath);
    writeFile(path.join(repoDir, "user.txt"), "user commit\n");
    git(repoDir, ["add", "--", "user.txt"]);
    git(repoDir, ["commit", "-m", "user predecessor"]);

    expect(() =>
      ensureGitTransactionCommit(target, publication, {
        transactionId: "predecessor-race",
        message: "predecessor race",
        paths: [snapshot.path],
        snapshots: { [snapshot.path]: snapshot.state },
      }),
    ).toThrow(/advanced before its commit/);
    expect(git(repoDir, ["rev-list", "--count", "HEAD"])).toBe("2");
  });

  test("durable publication rejects a changed effective push URL", () => {
    const repoDir = process.env.AKM_BUNDLE_DIR as string;
    const remoteDir = path.join(process.env.XDG_CACHE_HOME as string, "remote.git");
    const alternateRemote = path.join(process.env.XDG_CACHE_HOME as string, "alternate.git");
    fs.mkdirSync(remoteDir, { recursive: true });
    fs.mkdirSync(alternateRemote, { recursive: true });
    git(remoteDir, ["init", "--bare"]);
    git(alternateRemote, ["init", "--bare"]);
    initRepo(repoDir);
    writeFile(path.join(repoDir, "README.md"), "seed\n");
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "seed"]);
    git(repoDir, ["remote", "add", "origin", remoteDir]);
    git(repoDir, ["push", "-u", "origin", "main"]);
    const target = prepareWriteTargetForMutation({
      source: { kind: "git", name: "team", path: repoDir, repoPath: repoDir, adapterId: "akm" },
      config: { type: "git", name: "team", path: repoDir, writable: true },
    });
    const publication = captureGitPublication(target);
    if (!publication) throw new Error("expected Git publication");
    const ownedPath = path.join(repoDir, "memories", "owned.md");
    writeFile(ownedPath, "AKM snapshot\n");
    const snapshot = captureGitPathSnapshot(target, ownedPath);
    git(repoDir, ["config", "remote.origin.pushurl", alternateRemote]);

    expect(() =>
      ensureGitTransactionCommit(target, publication, {
        transactionId: "push-url-change",
        message: "push URL change",
        paths: [snapshot.path],
        snapshots: { [snapshot.path]: snapshot.state },
      }),
    ).toThrow(/identity changed at pushUrls/);
    expect(git(repoDir, ["rev-list", "--count", "HEAD"])).toBe("1");
  });

  test("durable publication validates Unicode paths without quoted-path drift", () => {
    const repoDir = process.env.AKM_BUNDLE_DIR as string;
    initRepo(repoDir);
    writeFile(path.join(repoDir, "README.md"), "seed\n");
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "seed"]);
    git(repoDir, ["config", "core.quotePath", "true"]);
    const target = {
      source: { kind: "git", name: "team", path: repoDir, repoPath: repoDir, adapterId: "akm" },
      config: { type: "git" as const, name: "team", path: repoDir, writable: true },
    };
    const publication = captureGitPublication(target);
    if (!publication) throw new Error("expected Git publication");
    const ownedPath = path.join(repoDir, "memories", "café.md");
    writeFile(ownedPath, "Unicode path content\n");
    const snapshot = captureGitPathSnapshot(target, ownedPath);
    const options = {
      transactionId: "unicode-path",
      message: "Unicode path",
      paths: [snapshot.path],
      snapshots: { [snapshot.path]: snapshot.state },
    };

    const commit = ensureGitTransactionCommit(target, publication, options);
    expect(commit).toBeTruthy();
    publication.commit = commit;
    expect(ensureGitTransactionCommit(target, publication, options)).toBe(commit);
    expect(git(repoDir, ["show", `HEAD:${snapshot.path}`])).toBe("Unicode path content");
  });

  test("durable publication refuses to recreate an upstream branch deleted after preflight", () => {
    const repoDir = process.env.AKM_BUNDLE_DIR as string;
    const remoteDir = path.join(process.env.XDG_CACHE_HOME as string, "deleted-upstream.git");
    fs.mkdirSync(remoteDir, { recursive: true });
    git(remoteDir, ["init", "--bare"]);
    initRepo(repoDir);
    writeFile(path.join(repoDir, "README.md"), "seed\n");
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "seed"]);
    git(repoDir, ["remote", "add", "origin", remoteDir]);
    git(repoDir, ["push", "-u", "origin", "main"]);
    const target = {
      source: { kind: "git", name: "team", path: repoDir, repoPath: repoDir, adapterId: "akm" },
      config: { type: "git" as const, name: "team", path: repoDir, writable: true },
    };
    const publication = captureGitPublication(target);
    if (!publication) throw new Error("expected Git publication");
    const ownedPath = path.join(repoDir, "memories", "leased.md");
    writeFile(ownedPath, "leased publication\n");
    const snapshot = captureGitPathSnapshot(target, ownedPath);
    const snapshots = { [snapshot.path]: snapshot.state };
    publication.commit = ensureGitTransactionCommit(target, publication, {
      transactionId: "deleted-upstream",
      message: "Lease remote deletion",
      paths: [snapshot.path],
      snapshots,
    });
    git(remoteDir, ["update-ref", "-d", "refs/heads/main"]);

    expect(() =>
      publishGitTransactionCommit(target, publication, "deleted-upstream", [snapshot.path], snapshots),
    ).toThrow(/git push failed/);
    const remoteBranch = spawnSync("git", ["-C", remoteDir, "rev-parse", "--verify", "refs/heads/main"], {
      encoding: "utf8",
    });
    expect(remoteBranch.status).not.toBe(0);
  });

  test("commits akm-managed files and leaves unrelated non-akm files dirty/untouched", () => {
    const stashDir = process.env.AKM_BUNDLE_DIR as string;
    initRepo(stashDir);

    // akm-managed dirty files.
    writeFile(path.join(stashDir, "memories", "x.md"), "memory x\n");
    writeFile(path.join(stashDir, "knowledge", "y.md"), "knowledge y\n");
    // Unrelated non-akm files (the exact shapes that caused the incident).
    writeFile(path.join(stashDir, "data.js"), "window.data = {};\n");
    writeFile(path.join(stashDir, "akm-health-report.html"), "<html></html>\n");
    writeFile(path.join(stashDir, "reports", "summary.txt"), "report\n");
    writeFile(path.join(stashDir, "tasks.bak-123", "z"), "backup\n");

    const result = saveGitStash(undefined, "scoped commit");
    expect(result.committed).toBe(true);
    expect(result.skipped).toBe(false);

    // The commit contains ONLY managed paths.
    const files = committedFiles(stashDir);
    expect(files).toContain("memories/x.md");
    expect(files).toContain("knowledge/y.md");
    expect(files.some((f) => f.startsWith("data.js"))).toBe(false);
    expect(files.some((f) => f.startsWith("akm-health-report.html"))).toBe(false);
    expect(files.some((f) => f.startsWith("reports/"))).toBe(false);
    expect(files.some((f) => f.startsWith("tasks.bak-123/"))).toBe(false);

    // The non-akm files are STILL dirty afterward (untouched). Untracked
    // directories are collapsed to "<dir>/" by git porcelain.
    const after = status(stashDir);
    expect(after).toContain("data.js");
    expect(after).toContain("akm-health-report.html");
    expect(after).toContain("reports/");
    expect(after).toContain("tasks.bak-123/");
  });

  test("does NOT throw the old 'refusing to push' error when non-akm files are present", () => {
    const stashDir = process.env.AKM_BUNDLE_DIR as string;
    initRepo(stashDir);
    writeFile(path.join(stashDir, "facts", "a.md"), "fact a\n");
    writeFile(path.join(stashDir, "scratch.tmp"), "stray\n");

    let threw: unknown;
    try {
      saveGitStash(undefined, "no refuse");
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeUndefined();
  });

  test("explicit options.paths stages only the listed subset", () => {
    const stashDir = process.env.AKM_BUNDLE_DIR as string;
    initRepo(stashDir);
    writeFile(path.join(stashDir, "memories", "keep.md"), "keep\n");
    writeFile(path.join(stashDir, "memories", "skip.md"), "skip\n");
    writeFile(path.join(stashDir, "lessons", "also-skip.md"), "skip\n");

    const result = saveGitStash(undefined, "subset", undefined, { paths: ["memories/keep.md"] });
    expect(result.committed).toBe(true);

    const files = committedFiles(stashDir);
    expect(files).toEqual(["memories/keep.md"]);

    const after = status(stashDir);
    expect(after).toContain("memories/skip.md");
    // lessons/ is entirely untracked → porcelain collapses it to "lessons/".
    expect(after).toContain("lessons/");
  });

  test("commit-tree bypasses user commit hooks", () => {
    const stashDir = process.env.AKM_BUNDLE_DIR as string;
    initRepo(stashDir);
    writeFile(path.join(stashDir, "knowledge", "seed.md"), "seed\n");
    git(stashDir, ["add", "."]);
    git(stashDir, ["commit", "-m", "seed"]);
    const hook = path.join(stashDir, ".git", "hooks", "pre-commit");
    fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", "utf8");
    fs.chmodSync(hook, 0o755);
    writeFile(path.join(stashDir, "memories", "hook-safe.md"), "hook-safe\n");

    const result = saveGitStash(undefined, "hook-safe commit", undefined, {
      push: false,
      paths: ["memories/hook-safe.md"],
    });

    expect(result.committed).toBe(true);
    expect(committedFiles(stashDir)).toEqual(["memories/hook-safe.md"]);
  });

  test("only non-akm files dirty → nothing committed, no commit created, no throw", () => {
    const stashDir = process.env.AKM_BUNDLE_DIR as string;
    initRepo(stashDir);
    // Seed an initial commit so HEAD exists, then add only non-akm dirt.
    writeFile(path.join(stashDir, "knowledge", "seed.md"), "seed\n");
    saveGitStash(undefined, "seed");
    const headBefore = spawnSync("git", ["-C", stashDir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

    writeFile(path.join(stashDir, "data.js"), "only non-akm\n");
    writeFile(path.join(stashDir, "tasks.bak-9", "z"), "backup\n");

    const result = saveGitStash(undefined, "should not commit");
    expect(result.committed).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.output).toBe("nothing to commit");

    // No new commit was created.
    const headAfter = spawnSync("git", ["-C", stashDir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    expect(headAfter).toBe(headBefore);

    // Non-akm files still dirty.
    const after = status(stashDir);
    expect(after).toContain("data.js");
    // tasks.bak-9/ is entirely untracked → porcelain collapses it.
    expect(after).toContain("tasks.bak-9/");
  });

  test("clean tree → nothing to commit, working tree clean", () => {
    const stashDir = process.env.AKM_BUNDLE_DIR as string;
    initRepo(stashDir);
    writeFile(path.join(stashDir, "facts", "seed.md"), "seed\n");
    saveGitStash(undefined, "seed");

    const result = saveGitStash(undefined, "nothing left");
    expect(result.committed).toBe(false);
    expect(result.output).toBe("nothing to commit, working tree clean");
  });

  test("committed change pushes when a remote is configured and stash is writable", () => {
    const stashDir = process.env.AKM_BUNDLE_DIR as string;
    // Bare remote to push into.
    const remoteDir = `${stashDir}-remote.git`;
    spawnSync("git", ["init", "--bare", "--initial-branch=main", remoteDir], { encoding: "utf8" });

    initRepo(stashDir);
    spawnSync("git", ["-C", stashDir, "remote", "add", "origin", remoteDir], { encoding: "utf8" });
    // Seed an initial commit and set the branch upstream so `git push` (no args)
    // resolves a target — mirrors a cloned writable stash's tracking config.
    writeFile(path.join(stashDir, "knowledge", "seed.md"), "seed\n");
    spawnSync("git", ["-C", stashDir, "add", "-A"], { encoding: "utf8" });
    spawnSync("git", ["-C", stashDir, "-c", "user.name=akm", "-c", "user.email=akm@local", "commit", "-m", "seed"], {
      encoding: "utf8",
    });
    spawnSync("git", ["-C", stashDir, "push", "-u", "origin", "main"], { encoding: "utf8" });

    writeFile(path.join(stashDir, "memories", "pushed.md"), "pushed\n");
    // Stray non-akm file must NOT block the push.
    writeFile(path.join(stashDir, "data.js"), "stray\n");

    const result = saveGitStash(undefined, "push it", /* writableOverride */ true);
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);

    // The remote received exactly the managed file.
    const remoteFiles = spawnSync("git", ["-C", remoteDir, "show", "--name-only", "--format=", "HEAD"], {
      encoding: "utf8",
    }).stdout;
    expect(remoteFiles).toContain("memories/pushed.md");
    expect(remoteFiles).not.toContain("data.js");

    fs.rmSync(remoteDir, { recursive: true, force: true });
  });

  test("pushes the exact AKM commit when a pre-push hook creates a local descendant", () => {
    const stashDir = process.env.AKM_BUNDLE_DIR as string;
    const remoteDir = path.join(process.env.XDG_CACHE_HOME as string, "exact-push-remote.git");
    fs.mkdirSync(remoteDir, { recursive: true });
    git(remoteDir, ["init", "--bare"]);
    initRepo(stashDir);
    writeFile(path.join(stashDir, "knowledge", "seed.md"), "seed\n");
    git(stashDir, ["add", "."]);
    git(stashDir, ["commit", "-m", "seed"]);
    git(stashDir, ["remote", "add", "origin", remoteDir]);
    git(stashDir, ["push", "-u", "origin", "main"]);
    writeFile(path.join(stashDir, "user-descendant.txt"), "user descendant\n");
    git(stashDir, ["add", "--", "user-descendant.txt"]);
    writeFile(path.join(stashDir, "memories", "exact.md"), "exact AKM commit\n");
    const hook = path.join(stashDir, ".git", "hooks", "pre-push");
    fs.writeFileSync(hook, '#!/bin/sh\ngit commit -m "user descendant" >/dev/null 2>&1\n', "utf8");
    fs.chmodSync(hook, 0o755);

    const result = saveGitStash(undefined, "exact push", true, { paths: ["memories/exact.md"] });
    if (!result.commit) throw new Error("expected exact commit");

    expect(git(remoteDir, ["rev-parse", "main"])).toBe(result.commit);
    expect(git(stashDir, ["rev-parse", "HEAD"])).not.toBe(result.commit);
    expect(git(remoteDir, ["ls-tree", "--name-only", "main", "user-descendant.txt"])).toBe("");
    expect(git(stashDir, ["rev-list", "--count", `${result.commit}..HEAD`])).toBe("1");
  });
});
