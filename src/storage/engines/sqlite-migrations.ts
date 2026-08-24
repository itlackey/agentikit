// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared SQLite migration engine.
 *
 * SQLite schemas evolve through this transaction-per-migration runner backed
 * by a `schema_migrations` ledger.
 *
 * This module factors that runner out once. Each caller supplies only its own
 * `MIGRATIONS` array.
 *
 * Ledger/transaction contract:
 *   - `id` is permanent and must never be reused.
 *   - Applied IDs must be an exact ordered prefix of the registry.
 *   - Each `up` body and its ledger insert commit in the same transaction.
 *   - The caller owns semantic safety classification and any policy gate;
 *     this generic engine intentionally does not infer risk from SQL text.
 */

import type { Database } from "../database";

/**
 * A single, append-only schema migration.
 *
 * @see The migration-safety contract in this module's header.
 */
export interface Migration {
  id: string;
  up: string;
}

/**
 * Options for {@link runMigrations}.
 */
export interface RunMigrationsOptions {
  /** Called before creating a missing ledger table while the initialization writer lock is held. */
  beforeLedgerInitializationLocked?: (db: Database) => void;
  /** Called immediately before each pending migration and before its transaction. */
  beforeMigration?: (migration: Migration) => void;
  /** Called after the pending-ID recheck while the migration's writer lock is held. */
  beforeMigrationLocked?: (migration: Migration, db: Database) => void;
}

export type MigrationLedgerStatus = "old" | "current" | "newer" | "inconsistent";

export interface MigrationLedgerState {
  status: MigrationLedgerStatus;
  migrationIds: string[];
  detail?: string;
}

export function assertMigrationRegistry(migrations: readonly Migration[]): void {
  const seen = new Set<string>();
  for (const migration of migrations) {
    if (seen.has(migration.id)) throw new Error(`Migration registry contains duplicate ID ${migration.id}.`);
    seen.add(migration.id);
  }
}

export function migrationLedgerExists(db: Database): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
}

/** Inspect the database's applied IDs against the exact ordered registry prefix. */
function inspectLedgerAgainst(db: Database, registryIds: readonly string[]): MigrationLedgerState {
  if (!migrationLedgerExists(db)) return { status: registryIds.length === 0 ? "current" : "old", migrationIds: [] };

  const rows = db.prepare("SELECT id FROM schema_migrations ORDER BY rowid").all() as Array<{ id: string }>;
  const migrationIds = rows.map((row) => row.id);

  for (const [index, row] of rows.entries()) {
    const expectedId = registryIds[index];
    if (!expectedId) {
      return { status: "newer", migrationIds, detail: `unknown migration ID ${row.id}` };
    }
    if (row.id !== expectedId) {
      const knownLater = registryIds.includes(row.id);
      return {
        status: knownLater ? "inconsistent" : "newer",
        migrationIds,
        detail: knownLater
          ? `migration ledger is not an exact ordered prefix at position ${index + 1}`
          : `unknown migration ID ${row.id}`,
      };
    }
  }

  return {
    status: rows.length === registryIds.length ? "current" : "old",
    migrationIds,
  };
}

export function inspectMigrationLedger(db: Database, migrations: readonly Migration[]): MigrationLedgerState {
  assertMigrationRegistry(migrations);
  return inspectLedgerAgainst(
    db,
    migrations.map((migration) => migration.id),
  );
}

export function assertMigrationLedger(db: Database, migrations: readonly Migration[]): MigrationLedgerState {
  const state = inspectMigrationLedger(db, migrations);
  if (state.status === "newer") {
    throw new Error(`Refusing to open a database with a newer migration ledger: ${state.detail}.`);
  }
  if (state.status === "inconsistent") {
    throw new Error(`Refusing a database whose migrations are not an exact ordered prefix: ${state.detail}.`);
  }
  return state;
}

/**
 * Create the migrations ledger table if it does not exist. Must be called
 * unconditionally on every open so a fresh database bootstraps correctly.
 */
export function ensureMigrationsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT    PRIMARY KEY,
      applied_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/**
 * Apply every pending migration, one transaction per migration.
 *
 * Each migration is applied in its own transaction so a failure in migration N
 * does not roll back already-applied migrations 1..N-1. The migration row is
 * inserted after the DDL succeeds in the same transaction, so a crash rolls
 * back both that migration's SQL and its ledger row.
 *
 * @param db          The open SQLite database.
 * @param migrations  The module's ordered, append-only migration list.
 * @param opts        Migration execution options.
 */
export function runMigrations(db: Database, migrations: readonly Migration[], opts?: RunMigrationsOptions): void {
  assertMigrationRegistry(migrations);
  if (migrationLedgerExists(db)) {
    assertMigrationLedger(db, migrations);
  } else {
    withImmediateWriteLock(db, () => {
      if (migrationLedgerExists(db)) return;
      opts?.beforeLedgerInitializationLocked?.(db);
      ensureMigrationsTable(db);
    });
    assertMigrationLedger(db, migrations);
  }

  const appliedRows = db.prepare("SELECT id FROM schema_migrations ORDER BY rowid").all() as Array<{ id: string }>;
  const applied = new Set(appliedRows.map((r) => r.id));

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;

    opts?.beforeMigration?.(migration);

    withImmediateWriteLock(db, () => {
      // Re-check under the write lock. `applied` is a snapshot taken before the
      // loop, so two processes bootstrapping the same fresh DB concurrently
      // (both see existed=false) could each decide
      // to apply migration N. The first commits; the second must not re-run the
      // DDL and must not hit a UNIQUE violation on the ledger insert.
      const already = db.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get(migration.id);
      if (already) return;
      opts?.beforeMigrationLocked?.(migration, db);
      db.exec(migration.up);
      db.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(migration.id);
    });
    applied.add(migration.id);
  }
}

/** Attempts to acquire the write lock before giving up to the caller. */
const IMMEDIATE_LOCK_MAX_ATTEMPTS = 5;

/**
 * Run `fn` inside a `BEGIN IMMEDIATE` transaction.
 *
 * The write lock is taken up front rather than upgraded from a read lock, so a
 * second process bootstrapping the same database WAITS for the first to commit
 * instead of racing it. `db.transaction()` opens a DEFERRED transaction, which
 * only takes the write lock on first write — leaving the read-then-write gap
 * this guards.
 *
 * Deliberately local rather than reusing `withImmediateTransaction` from
 * core/state-db: that module imports this one, so the dependency cannot be
 * pointed the other way.
 */
function withImmediateWriteLock(db: Database, fn: () => void): void {
  if (db.inTransaction) {
    fn();
    return;
  }
  let lastBeginErr: unknown;
  for (let attempt = 1; attempt <= IMMEDIATE_LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (err) {
      // Busy despite busy_timeout (another writer holding it across the whole
      // window). Retry a bounded number of times before surfacing.
      lastBeginErr = err;
      continue;
    }
    try {
      fn();
      db.exec("COMMIT");
      return;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Already rolled back by SQLite (e.g. the statement aborted the txn).
      }
      throw err;
    }
  }
  throw lastBeginErr instanceof Error
    ? lastBeginErr
    : new Error(`could not acquire the migration write lock after ${IMMEDIATE_LOCK_MAX_ATTEMPTS} attempts`);
}
