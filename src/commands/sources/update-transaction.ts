// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../../core/common";
import { ConfigError } from "../../core/errors";
import { getDbPath, getSemanticStatusPath, getStateDbPathInDataDir } from "../../core/paths";
import { warn } from "../../core/warn";
import type { Database } from "../../storage/database";
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

interface FileSnapshot {
  readonly target: string;
  readonly bytes: Buffer | null;
  readonly mode: number;
  readonly sqlite: boolean;
}

interface IndexSnapshot {
  readonly files: FileSnapshot[];
}

type SerializableDatabase = Database & { serialize(): Uint8Array };

function captureSqliteSnapshot(dbPath: string): FileSnapshot {
  const db = openReadonlyExistingDatabase(dbPath);
  if (!db) return { target: dbPath, bytes: null, mode: 0o600, sqlite: true };
  try {
    const serializable = db as Partial<SerializableDatabase>;
    if (typeof serializable.serialize !== "function") {
      throw new ConfigError("The active SQLite driver cannot snapshot index.db; refusing a non-atomic update.");
    }
    return {
      target: dbPath,
      bytes: Buffer.from(serializable.serialize.call(db)),
      mode: fs.statSync(dbPath).mode & 0o777,
      sqlite: true,
    };
  } finally {
    closeDatabase(db);
  }
}

function captureOrdinaryFile(filePath: string): FileSnapshot {
  try {
    const stat = fs.statSync(filePath);
    return {
      target: filePath,
      bytes: fs.readFileSync(filePath),
      mode: stat.mode & 0o777,
      sqlite: false,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { target: filePath, bytes: null, mode: 0o600, sqlite: false };
    }
    throw error;
  }
}

export function captureIndexSnapshot(): IndexSnapshot {
  return {
    files: [
      captureSqliteSnapshot(getDbPath()),
      captureSqliteSnapshot(getStateDbPathInDataDir()),
      captureOrdinaryFile(getSemanticStatusPath()),
    ],
  };
}

export function restoreIndexSnapshot(snapshot: IndexSnapshot): void {
  for (const file of snapshot.files) {
    if (file.sqlite) {
      for (const suffix of ["-wal", "-shm", "-journal"]) fs.rmSync(`${file.target}${suffix}`, { force: true });
    }
    if (file.bytes === null) {
      fs.rmSync(file.target, { force: true });
    } else {
      writeFileAtomic(file.target, file.bytes, file.mode);
    }
  }
}
