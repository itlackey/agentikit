// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Side-effect-free SQLite snapshots for planning and preview paths.
 *
 * A normal SQLite read-only connection can still write lock bytes into an
 * existing `-shm` file when the source database is in WAL mode. Dry planning
 * must not do that. This helper copies a stable main/WAL pair and opens that
 * private copy, so SQLite never attaches to the operator's original
 * main/WAL/SHM files.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Database } from "./database";
import { openDatabaseFinalizing } from "./database";

export class SqliteReadSnapshotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqliteReadSnapshotUnavailableError";
  }
}

function pathExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

interface FileFingerprint {
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface DatabaseFingerprint {
  main: FileFingerprint;
  wal?: FileFingerprint;
}

function fileFingerprint(filePath: string): FileFingerprint | undefined {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    return { size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function databaseFingerprint(dbPath: string): DatabaseFingerprint {
  const main = fileFingerprint(dbPath);
  if (!main) {
    throw new SqliteReadSnapshotUnavailableError("SQLite snapshot source disappeared while it was being inspected");
  }
  const wal = fileFingerprint(`${dbPath}-wal`);
  return { main, ...(wal ? { wal } : {}) };
}

function fingerprintsEqual(left: DatabaseFingerprint, right: DatabaseFingerprint): boolean {
  const sameFile = (a: FileFingerprint | undefined, b: FileFingerprint | undefined): boolean =>
    a?.size === b?.size && a?.mtimeNs === b?.mtimeNs && a?.ctimeNs === b?.ctimeNs;
  return sameFile(left.main, right.main) && sameFile(left.wal, right.wal);
}

/**
 * Open an isolated copy of an existing SQLite database.
 *
 * Returns `undefined` only when the source is absent. Committed WAL frames are
 * copied beside the private main file; the source SHM is intentionally not
 * copied because SQLite can safely create one inside the disposable directory.
 * A live rollback-journal database fails closed because a file-level copy
 * cannot distinguish its committed and uncommitted pages without attaching to
 * the source.
 */
export function openSqliteReadSnapshot(dbPath: string): Database | undefined {
  if (!pathExists(dbPath)) return undefined;
  if (pathExists(`${dbPath}-journal`)) {
    throw new SqliteReadSnapshotUnavailableError(
      "an active SQLite rollback journal is present; a non-mutating point-in-time snapshot is unavailable",
    );
  }

  const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-sqlite-read-"));
  const snapshotPath = path.join(snapshotDir, "snapshot.db");
  let db: Database | undefined;
  try {
    let copied = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (pathExists(`${dbPath}-journal`)) {
          throw new SqliteReadSnapshotUnavailableError(
            "an active SQLite rollback journal appeared while taking the non-mutating snapshot",
          );
        }
        const before = databaseFingerprint(dbPath);
        fs.copyFileSync(dbPath, snapshotPath);
        if (before.wal) fs.copyFileSync(`${dbPath}-wal`, `${snapshotPath}-wal`);
        else fs.rmSync(`${snapshotPath}-wal`, { force: true });
        const after = databaseFingerprint(dbPath);
        if (fingerprintsEqual(before, after)) {
          copied = true;
          break;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    if (!copied) {
      throw new SqliteReadSnapshotUnavailableError(
        "SQLite main/WAL files kept changing while taking the non-mutating snapshot",
      );
    }
    db = openDatabaseFinalizing(snapshotPath, { readonly: true, create: false });
    const closeSnapshot = db.close.bind(db);
    let closed = false;
    db.close = () => {
      if (closed) return;
      closed = true;
      try {
        closeSnapshot();
      } finally {
        fs.rmSync(snapshotDir, { recursive: true, force: true });
      }
    };
    return db;
  } catch (error) {
    try {
      db?.close();
    } finally {
      fs.rmSync(snapshotDir, { recursive: true, force: true });
    }
    throw error;
  }
}
