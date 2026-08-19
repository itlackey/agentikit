// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `index.db` connection lifecycle for the storage layer.
 *
 * Opens/closes the index database, arming the sqlite-vec extension and (for the
 * managed open path) running `ensureSchema`. This module lives BELOW the
 * indexer, so the storage loan helpers (`index-db.ts`, `registry-cache.ts`)
 * import their opener from a sibling here instead of reaching up into the
 * indexer — inverting the old storage→indexer arrow.
 */

import { createRequire } from "node:module";
import { ConfigError } from "../../core/errors";
import { classifyPathAccess, describeInaccessiblePath } from "../../core/path-access";
import { getDbPath } from "../../core/paths";
import type { Database } from "../database";
import { openDatabase } from "../database";
import { openManagedDatabase } from "../managed-db";
import { SQLITE_BUSY_TIMEOUT_MS } from "../sqlite-pragmas";
import { ensureSchema } from "./index-schema";
import { loadVecExtension, warnIfVecMissing } from "./index-vec-repository";

export function openIndexDatabase(
  dbPath?: string,
  options?: { embeddingDim?: number; beforeSchema?: (db: Database) => void },
): Database {
  return openManagedDatabase({
    path: dbPath ?? getDbPath(),
    init: (db) => {
      // Try to load sqlite-vec extension
      loadVecExtension(db);

      // Source update uses this narrow lifecycle seam to ATTACH state.db and
      // open its coordinator-owned outer transaction before ensureSchema or
      // any indexer write can mutate the live generation.
      options?.beforeSchema?.(db);

      // Dim resolution: explicit option wins; otherwise consult the on-disk
      // config so unparameterised opens (registry providers, graph helpers,
      // ad-hoc CLI subcommands) honour the operator-declared dimension. Only if
      // both are absent do we fall through to the no-clobber path, which keeps
      // ensureSchema from touching `index_meta.embeddingDim` at all.
      const resolvedDim = options?.embeddingDim ?? resolveConfiguredEmbeddingDim();
      ensureSchema(db, resolvedDim);

      // Warn once at init if using JS fallback with many entries
      warnIfVecMissing(db, { once: true });
    },
  });
}

/**
 * Read the operator-configured embedding dimension from the on-disk config.
 * Returns `undefined` when no config file is present, when the config has
 * no `embedding.dimension` set, or when reading the config throws (e.g.
 * inside isolated test fixtures with no XDG home). Failure is silent on
 * purpose — every openDatabase() call would otherwise have to handle a
 * config-not-found error path, and the fallback (no-clobber semantics) is
 * already correct.
 */
function resolveConfiguredEmbeddingDim(): number | undefined {
  try {
    const esmRequire = createRequire(import.meta.url);
    const { loadConfig } = esmRequire("../../core/config/config") as typeof import("../../core/config/config");
    const dim = loadConfig().embedding?.dimension;
    if (typeof dim === "number" && Number.isInteger(dim) && dim > 0 && dim <= 4096) {
      return dim;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function openExistingDatabase(dbPath?: string): Database {
  // Existing-DB callers must not mutate schema or embedding metadata on open,
  // but some paths still need write access to usage_events and other tables —
  // so init only loads the vec extension, it does not run ensureSchema.
  //
  // "Existing" is load-bearing: a missing file throws instead of being
  // created. Create-on-open used to leave a schema-less index.db behind (a
  // fire-and-forget telemetry read was enough), which every later opener then
  // saw as an existing-but-broken index ("no such table: entries") — the
  // curate→proposal file-order failure pinned by
  // tests/storage/open-existing-database-no-create.test.ts. `create: false`
  // below is the race-free backstop for this pre-check.
  const resolvedPath = dbPath ?? getDbPath();
  assertIndexPathReadable(resolvedPath);
  if (classifyPathAccess(resolvedPath).access === "absent") {
    throw new Error(`Index database not found at ${resolvedPath}. Run 'akm index' to build it.`);
  }
  return openManagedDatabase({ path: resolvedPath, init: loadVecExtension, create: false });
}

/**
 * Refuse to treat an UNREADABLE index as a missing one (#791).
 *
 * `fs.existsSync()` — which every one of these gates used to call — returns
 * `false` for `EACCES` exactly as for `ENOENT`, so an index this process cannot
 * read looked identical to one that had never been built. Callers then took
 * their "no index yet" branch: `search`/`curate` returned no hits at exit 0 and
 * told the user to run `akm index`, which would not have helped and which they
 * may not have permission to do either.
 *
 * A `ConfigError` here exits 78 through the standard `{ok:false, error, code}`
 * envelope, so both a human and a machine caller can tell "nothing indexed"
 * from "I cannot see the index".
 */
export function assertIndexPathReadable(resolvedPath: string): void {
  const { access, code } = classifyPathAccess(resolvedPath);
  if (access !== "inaccessible") return;
  throw new ConfigError(
    `Index database exists but is not readable: ${describeInaccessiblePath(resolvedPath, code)}.`,
    "DATA_DIR_UNREADABLE",
  );
}

/**
 * Open an existing index for queries without creating directories, a database
 * file, journals, or running write-capable pragmas/schema initialization.
 */
export function openReadonlyExistingDatabase(dbPath?: string): Database | undefined {
  const resolvedPath = dbPath ?? getDbPath();
  // `undefined` means "no index" — reserve it for a genuinely absent one, and
  // let an unreadable index raise instead of masquerading as absent (#791).
  assertIndexPathReadable(resolvedPath);
  if (classifyPathAccess(resolvedPath).access === "absent") return undefined;
  const db = openDatabase(resolvedPath, { readonly: true, create: false });
  // This opener bypasses openManagedDatabase/applyStandardPragmas by design (no
  // journal or schema work on a read-only handle), but that also left
  // busy_timeout at SQLite's default of 0. In WAL that is harmless — readers
  // never block — but in the DELETE/TRUNCATE modes the network-FS fallback and
  // AKM_SQLITE_JOURNAL_MODE can select, a concurrent writer makes every read
  // fail instantly with SQLITE_BUSY. busy_timeout is legal on a read-only
  // connection, so apply just that one.
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  return db;
}

export function closeDatabase(db: Database): void {
  db.close();
}
