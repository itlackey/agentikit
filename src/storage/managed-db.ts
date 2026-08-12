// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Managed-database seam — the single home for the SQLite open/lifecycle recipe.
 *
 * Before this module, two idioms were copy-pasted across state.db / logs.db /
 * workflow.db / index.db and their consumers:
 *
 *   1. The open recipe: `mkdir(dir) → openDatabase(path) → applyStandardPragmas
 *      → migrate`.
 *   2. The borrow-or-own lifecycle: `const db = ctx?.db ?? open(); const owns =
 *      !ctx?.db; try { … } finally { if (owns) db.close(); }`.
 *
 * {@link openManagedDatabase} owns (1); {@link withManagedDb} owns (2). Each DB
 * module supplies only a path + initializer and gets a `withXDb` loan helper
 * (see `withIndexDb`, `withStateDb`, etc.) so callers never hand-roll the
 * ownership flag or the finally/close again. This is also the one place to add
 * busy-timeout tuning, integrity checks, or test-isolation injection.
 */

import fs from "node:fs";
import path from "node:path";
import { type Database, openDatabase } from "./database";
import { applyStandardPragmas } from "./sqlite-pragmas";

export interface ManagedDbSpec {
  /** Absolute path to the database file. */
  path: string;
  /** Standard-pragma options. Defaults to `{ dataDir: dirname(path) }`. */
  pragmas?: Parameters<typeof applyStandardPragmas>[1];
  /** One-time schema setup (migrations / base DDL), run after pragmas on every open. */
  init?: (db: Database) => void;
  /**
   * When `false`, the database file must already exist: the parent dir is not
   * created and the driver opens with create-off (`fileMustExist`), throwing
   * instead of leaving a schema-less file behind. Default: create-on-open.
   */
  create?: boolean;
}

/** Owner-only file mode for the databases and owner-only mode for their directory. */
const DB_FILE_MODE = 0o600;
const DB_DIR_MODE = 0o700;

/**
 * The WAL sidecars SQLite creates next to a database in `journal_mode=WAL`.
 * They carry the same page content as the database itself, so leaving them at
 * the umask default would defeat tightening only the main file.
 */
const WAL_SIDECAR_SUFFIXES = ["-wal", "-shm"] as const;

/**
 * Tighten a managed database and its directory to owner-only (issue #756).
 *
 * `state.db` / `index.db` / `logs.db` hold task history, captured command
 * output, and indexed content, but were created at whatever the process umask
 * left them at (typically `0644`), unlike every env/secret file akm writes —
 * those pin `0600` through {@link import("../core/common").writeFileAtomic}'s
 * default mode. On a shared host any local user could read them straight off
 * disk without going through akm.
 *
 * Best-effort by design: POSIX modes are meaningless on Windows, and a chmod
 * can legitimately fail on a mounted/foreign filesystem or a file owned by
 * another user. Neither is a reason to fail an otherwise healthy open — and
 * `akm health`'s `secret-file-perms` advisory now scans these same paths, so a
 * chmod that could not be applied is surfaced rather than lost.
 */
function tightenDatabasePermissions(dbPath: string, dir: string): void {
  if (process.platform === "win32") return;
  const chmod = (target: string, mode: number): void => {
    try {
      fs.chmodSync(target, mode);
    } catch {
      // Not our file / not a POSIX-mode filesystem — `akm health` reports it.
    }
  };
  chmod(dir, DB_DIR_MODE);
  chmod(dbPath, DB_FILE_MODE);
  for (const suffix of WAL_SIDECAR_SUFFIXES) chmod(`${dbPath}${suffix}`, DB_FILE_MODE);
}

/**
 * Open a managed SQLite database: ensure the parent dir exists, open the handle,
 * apply standard pragmas, then run the schema initializer. The single home for
 * the open→pragmas→migrate recipe — and therefore the single home for the
 * owner-only permission enforcement every one of these databases needs
 * ({@link tightenDatabasePermissions}).
 */
export function openManagedDatabase(spec: ManagedDbSpec): Database {
  const dir = path.dirname(spec.path);
  if (spec.create !== false && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: DB_DIR_MODE });
  }
  const db = spec.create === false ? openDatabase(spec.path, { create: false }) : openDatabase(spec.path);
  applyStandardPragmas(db, spec.pragmas ?? { dataDir: dir });
  spec.init?.(db);
  // AFTER pragmas + init: `journal_mode=WAL` and the first DDL write are what
  // materialize the `-wal`/`-shm` sidecars, so chmodding earlier would miss them.
  tightenDatabasePermissions(spec.path, dir);
  return db;
}

/**
 * Run `fn` against a managed database, owning its lifecycle.
 *
 * When `opts.borrowed` is supplied the caller already owns an open handle: it is
 * passed straight through and NOT closed (borrow). Otherwise a fresh handle is
 * opened via `open` and closed in a `finally` (own). This replaces the
 * hand-rolled `ctx?.db ?? open()` + `ownsDb` flag + `finally`/close idiom — the
 * ownership decision and the close live here, once.
 *
 * Synchronous by design: the DB consumers (telemetry writers, planners) finish
 * all work within the tick, matching the inline blocks this replaces.
 */
export function withManagedDb<T>(open: () => Database, fn: (db: Database) => T, opts?: { borrowed?: Database }): T {
  if (opts?.borrowed) {
    return fn(opts.borrowed);
  }
  const db = open();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Async sibling of {@link withManagedDb}. Use this — NOT `withManagedDb` — when
 * `fn` holds the handle across an `await`: the sync version closes in its
 * `finally` before the awaited work resolves (use-after-close). Here the handle
 * is closed only after `fn`'s promise settles. Borrowed handles pass straight
 * through and are not closed, as in the sync version.
 */
export async function withManagedDbAsync<T>(
  open: () => Database,
  fn: (db: Database) => Promise<T>,
  opts?: { borrowed?: Database },
): Promise<T> {
  if (opts?.borrowed) {
    return fn(opts.borrowed);
  }
  const db = open();
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}
