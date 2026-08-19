// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "../../core/errors";
import { warn } from "../../core/warn";
import { runGit } from "../../sources/providers/git";
import { assertNoIgnoredPathOverwrite } from "../../sources/providers/git-install";

export interface DirectoryPublication {
  publish(): void;
  rollback(): void;
  commit(): void;
}

export function prepareDirectoryPublication(stagedRoot: string, liveRoot: string): DirectoryPublication {
  const backupRoot = `${liveRoot}.akm-update-backup-${randomBytes(6).toString("hex")}`;
  let published = false;
  let hadLiveRoot = false;
  return {
    publish() {
      if (published) throw new ConfigError(`Update content at ${liveRoot} was already published.`);
      hadLiveRoot = fs.existsSync(liveRoot);
      fs.mkdirSync(path.dirname(liveRoot), { recursive: true });
      if (hadLiveRoot) fs.renameSync(liveRoot, backupRoot);
      try {
        fs.renameSync(stagedRoot, liveRoot);
        published = true;
      } catch (error) {
        if (hadLiveRoot && fs.existsSync(backupRoot)) fs.renameSync(backupRoot, liveRoot);
        throw error;
      }
    },
    rollback() {
      if (!published) return;
      const failedRoot = `${liveRoot}.akm-update-failed-${randomBytes(6).toString("hex")}`;
      if (fs.existsSync(liveRoot)) fs.renameSync(liveRoot, failedRoot);
      try {
        if (hadLiveRoot && fs.existsSync(backupRoot)) fs.renameSync(backupRoot, liveRoot);
      } catch (error) {
        // The prior generation could not be restored. Put the published
        // candidate back at the live path so resolution never sees a missing
        // root, then surface the rollback failure loudly.
        try {
          if (!fs.existsSync(liveRoot) && fs.existsSync(failedRoot)) fs.renameSync(failedRoot, liveRoot);
        } catch {
          // Preserve the original restoration failure; both paths remain for
          // manual recovery when even the defensive rename cannot complete.
        }
        published = false;
        throw error;
      }
      try {
        fs.rmSync(failedRoot, { recursive: true, force: true });
      } catch (error) {
        warn(
          `[akm bundle update] restored ${liveRoot}, but could not remove failed candidate ${failedRoot}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      published = false;
    },
    commit() {
      if (hadLiveRoot) {
        try {
          fs.rmSync(backupRoot, { recursive: true, force: true });
        } catch (error) {
          warn(
            `[akm bundle update] update committed, but could not remove backup ${backupRoot}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      published = false;
    },
  };
}

function gitOutput(repoDir: string, args: string[], description: string): string {
  const result = runGit(["-C", repoDir, ...args], { timeout: 120_000 });
  if (result.status !== 0) {
    throw new ConfigError(`${description}: ${result.stderr.trim() || result.stdout.trim() || "git failed"}`);
  }
  return result.stdout.trim();
}

function assertGitCheckoutGeneration(repoDir: string, expectedHead: string, phase: string): void {
  const actualHead = gitOutput(repoDir, ["rev-parse", "HEAD"], `Cannot read writable Git HEAD at ${repoDir}`);
  if (actualHead !== expectedHead) {
    throw new ConfigError(
      `Writable Git checkout at ${repoDir} changed after the update was audited (${phase}: expected ${expectedHead}, found ${actualHead}); refusing to overwrite the live commit.`,
    );
  }
  const status = gitOutput(
    repoDir,
    ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"],
    `Cannot inspect writable Git checkout at ${repoDir}`,
  );
  if (status) {
    throw new ConfigError(
      `Writable Git checkout at ${repoDir} changed after the update was audited (${phase}: working tree is no longer clean); refusing to overwrite live files.`,
    );
  }
}

function assertNoGitlinks(repoDir: string, targetHead: string): void {
  const tree = gitOutput(
    repoDir,
    ["ls-tree", "-r", "-z", targetHead],
    `Cannot inspect audited Git tree ${targetHead} at ${repoDir}`,
  );
  const gitlink = tree.split("\0").find((entry) => entry.startsWith("160000 "));
  if (gitlink) {
    const targetPath = gitlink.slice(gitlink.indexOf("\t") + 1);
    throw new ConfigError(
      `Writable Git target contains unaudited submodule/gitlink ${targetPath}; refusing to materialize it.`,
    );
  }
}

function copyWorktree(source: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    fs.cpSync(path.join(source, entry.name), path.join(destination, entry.name), {
      recursive: true,
      preserveTimestamps: true,
    });
  }
}

function clearWorktree(repoDir: string): void {
  for (const entry of fs.readdirSync(repoDir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    fs.rmSync(path.join(repoDir, entry.name), { recursive: true, force: true });
  }
}

/**
 * Publish the exact audited commit into a writable checkout without replacing
 * the checkout directory. The expected-old-HEAD and clean-tree fence runs
 * under the caller's asset mutation lease immediately before the fast-forward.
 */
export function prepareWritableGitPublication(opts: {
  stagedRepo: string;
  liveRepo: string;
  expectedOldHead: string;
  auditedTargetHead: string;
}): DirectoryPublication {
  let published = false;
  let rollbackParent: string | undefined;
  let rollbackWorktree: string | undefined;

  const discardRollback = (): void => {
    if (!rollbackParent) return;
    cleanupStagingParent(rollbackParent);
    rollbackParent = undefined;
    rollbackWorktree = undefined;
  };

  const restore = (): void => {
    if (!rollbackWorktree) return;
    const actualHead = gitOutput(opts.liveRepo, ["rev-parse", "HEAD"], `Cannot read writable Git rollback HEAD`);
    if (actualHead !== opts.expectedOldHead && actualHead !== opts.auditedTargetHead) {
      throw new ConfigError(
        `Writable Git checkout ${opts.liveRepo} advanced concurrently to ${actualHead}; refusing to overwrite that commit during rollback.`,
      );
    }
    gitOutput(
      opts.liveRepo,
      ["reset", "--hard", opts.expectedOldHead],
      `Cannot restore writable Git checkout ${opts.liveRepo} to ${opts.expectedOldHead}`,
    );
    clearWorktree(opts.liveRepo);
    copyWorktree(rollbackWorktree, opts.liveRepo);
    assertGitCheckoutGeneration(opts.liveRepo, opts.expectedOldHead, "rollback verification");
    published = false;
    discardRollback();
  };

  return {
    publish() {
      if (published) throw new ConfigError(`Writable Git update at ${opts.liveRepo} was already published.`);
      assertGitCheckoutGeneration(opts.liveRepo, opts.expectedOldHead, "pre-publish fence");
      assertGitCheckoutGeneration(opts.stagedRepo, opts.auditedTargetHead, "staged audit fence");
      const ancestor = runGit([
        "-C",
        opts.stagedRepo,
        "merge-base",
        "--is-ancestor",
        opts.expectedOldHead,
        opts.auditedTargetHead,
      ]);
      if (ancestor.status !== 0) {
        throw new ConfigError(
          `Audited Git target ${opts.auditedTargetHead} is not a fast-forward of live HEAD ${opts.expectedOldHead}; refusing writable update.`,
        );
      }
      assertNoGitlinks(opts.stagedRepo, opts.auditedTargetHead);
      gitOutput(
        opts.liveRepo,
        ["fetch", "--no-tags", opts.stagedRepo, opts.auditedTargetHead],
        `Cannot import audited Git target ${opts.auditedTargetHead} into ${opts.liveRepo}`,
      );
      // A non-cooperating local Git command may have committed while fetch ran.
      assertGitCheckoutGeneration(opts.liveRepo, opts.expectedOldHead, "post-fetch fence");
      assertNoIgnoredPathOverwrite(opts.liveRepo, opts.auditedTargetHead);
      rollbackParent = createStagingParent(path.dirname(opts.liveRepo));
      rollbackWorktree = path.join(rollbackParent, "worktree");
      try {
        copyWorktree(opts.liveRepo, rollbackWorktree);
      } catch (error) {
        discardRollback();
        throw error;
      }
      try {
        gitOutput(
          opts.liveRepo,
          ["merge", "--ff-only", "--no-overwrite-ignore", opts.auditedTargetHead],
          `Cannot fast-forward writable Git checkout ${opts.liveRepo}`,
        );
        published = true;
        assertGitCheckoutGeneration(opts.liveRepo, opts.auditedTargetHead, "post-materialization fence");
      } catch (error) {
        try {
          restore();
        } catch (restoreError) {
          throw new ConfigError(
            `Writable Git publication failed and its worktree could not be restored: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
          );
        }
        throw error;
      }
    },
    rollback() {
      if (!published) return;
      restore();
    },
    commit() {
      published = false;
      discardRollback();
    },
  };
}

export function createStagingParent(parent: string): string {
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  return fs.mkdtempSync(path.join(parent, ".akm-update-stage-"));
}

export function cleanupStagingParent(stagingParent: string): void {
  try {
    fs.rmSync(stagingParent, { recursive: true, force: true });
  } catch (error) {
    warn(
      `[akm bundle update] could not remove staging directory ${stagingParent}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
