// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "../../core/errors";
import { getDbPath, getSemanticStatusPath } from "../../core/paths";
import { warn } from "../../core/warn";
import { runGit } from "../../sources/providers/git";
import { assertNoIgnoredPathOverwrite } from "../../sources/providers/git-install";
import { closeDatabase, openReadonlyExistingDatabase } from "../../storage/repositories/index-connection";

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
  const status = gitOutput(repoDir, ["status", "--porcelain"], `Cannot inspect writable Git checkout at ${repoDir}`);
  if (status) {
    throw new ConfigError(
      `Writable Git checkout at ${repoDir} changed after the update was audited (${phase}: working tree is no longer clean); refusing to overwrite live files.`,
    );
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
      gitOutput(
        opts.liveRepo,
        ["fetch", "--no-tags", opts.stagedRepo, opts.auditedTargetHead],
        `Cannot import audited Git target ${opts.auditedTargetHead} into ${opts.liveRepo}`,
      );
      // A non-cooperating local Git command may have committed while fetch ran.
      assertGitCheckoutGeneration(opts.liveRepo, opts.expectedOldHead, "post-fetch fence");
      assertNoIgnoredPathOverwrite(opts.liveRepo, opts.auditedTargetHead);
      gitOutput(
        opts.liveRepo,
        ["merge", "--ff-only", "--no-overwrite-ignore", opts.auditedTargetHead],
        `Cannot fast-forward writable Git checkout ${opts.liveRepo}`,
      );
      const publishedHead = gitOutput(
        opts.liveRepo,
        ["rev-parse", "HEAD"],
        `Cannot verify writable Git checkout ${opts.liveRepo}`,
      );
      if (publishedHead !== opts.auditedTargetHead) {
        throw new ConfigError(
          `Writable Git checkout ${opts.liveRepo} reached ${publishedHead}, not audited target ${opts.auditedTargetHead}.`,
        );
      }
      published = true;
    },
    rollback() {
      if (!published) return;
      assertGitCheckoutGeneration(opts.liveRepo, opts.auditedTargetHead, "rollback fence");
      gitOutput(
        opts.liveRepo,
        ["reset", "--hard", opts.expectedOldHead],
        `Cannot restore writable Git checkout ${opts.liveRepo} to ${opts.expectedOldHead}`,
      );
      published = false;
    },
    commit() {
      published = false;
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

interface DiskFileSnapshot {
  readonly target: string;
  readonly snapshotPath: string | null;
  readonly mode: number;
  readonly sqlite: boolean;
}

export interface IndexSnapshot {
  readonly directory: string;
  readonly files: DiskFileSnapshot[];
}

function sqliteStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function captureSqliteSnapshot(dbPath: string, snapshotPath: string): DiskFileSnapshot {
  const db = openReadonlyExistingDatabase(dbPath);
  if (!db) return { target: dbPath, snapshotPath: null, mode: 0o600, sqlite: true };
  try {
    // SQLite's online VACUUM INTO path produces a transactionally consistent,
    // bounded-memory file even when the source database currently has WAL
    // pages. The update already owns the exclusive index-writer lease.
    db.exec(`VACUUM INTO ${sqliteStringLiteral(snapshotPath)}`);
    return {
      target: dbPath,
      snapshotPath,
      mode: fs.statSync(dbPath).mode & 0o777,
      sqlite: true,
    };
  } finally {
    closeDatabase(db);
  }
}

function captureOrdinaryFile(filePath: string, snapshotPath: string): DiskFileSnapshot {
  try {
    const stat = fs.statSync(filePath);
    fs.copyFileSync(filePath, snapshotPath);
    return {
      target: filePath,
      snapshotPath,
      mode: stat.mode & 0o777,
      sqlite: false,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { target: filePath, snapshotPath: null, mode: 0o600, sqlite: false };
    }
    throw error;
  }
}

export function captureIndexSnapshot(): IndexSnapshot {
  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const directory = fs.mkdtempSync(path.join(path.dirname(dbPath), ".akm-update-index-snapshot-"));
  try {
    return {
      directory,
      files: [
        captureSqliteSnapshot(dbPath, path.join(directory, "index.db")),
        captureOrdinaryFile(getSemanticStatusPath(), path.join(directory, "semantic-status.json")),
      ],
    };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function restoreDiskFile(file: DiskFileSnapshot): void {
  const displaced = `${file.target}.akm-update-failed-${randomBytes(6).toString("hex")}`;
  const stage = `${file.target}.akm-update-restore-${randomBytes(6).toString("hex")}`;
  fs.mkdirSync(path.dirname(file.target), { recursive: true, mode: 0o700 });
  if (file.sqlite) {
    for (const suffix of ["-wal", "-shm", "-journal"]) fs.rmSync(`${file.target}${suffix}`, { force: true });
  }
  const hadCurrent = fs.existsSync(file.target);
  if (hadCurrent) fs.renameSync(file.target, displaced);
  try {
    if (file.snapshotPath !== null) {
      fs.copyFileSync(file.snapshotPath, stage);
      fs.chmodSync(stage, file.mode);
      fs.renameSync(stage, file.target);
    }
  } catch (error) {
    fs.rmSync(stage, { force: true });
    if (hadCurrent && fs.existsSync(displaced) && !fs.existsSync(file.target)) {
      fs.renameSync(displaced, file.target);
    }
    throw error;
  }
  fs.rmSync(displaced, { recursive: true, force: true });
}

export function restoreIndexSnapshot(snapshot: IndexSnapshot): void {
  for (const file of snapshot.files) restoreDiskFile(file);
}

export function discardIndexSnapshot(snapshot: IndexSnapshot): void {
  cleanupStagingParent(snapshot.directory);
}
