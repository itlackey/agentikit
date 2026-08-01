// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared SQLite migration engine.
 *
 * state.db (`src/core/state-db.ts`) evolves its schema through this idempotent,
 * transaction-per-migration runner backed by a `schema_migrations` ledger. The
 * migrator's frozen pre-cutover workflow-schema roll
 * (`scripts/akm-migrate/migrate/legacy/workflow-migrations-bodies.ts`, driven by
 * `scripts/akm-migrate/config-migrate.ts`) reuses the SAME runner.
 *
 * This module factors that runner out once. Each caller supplies only its own
 * `MIGRATIONS` array.
 *
 * Migration-safety contract:
 *   - `id` is permanent and must never be reused.
 *   - `up` must be idempotent (use IF NOT EXISTS, INSERT OR IGNORE, etc.).
 *   - `up` must not DROP any table that holds durable (non-regenerable) data.
 *   - `up` must not RENAME or change the type of an existing column.
 *   - To add a column: use `ALTER TABLE … ADD COLUMN … DEFAULT …`.
 *   - Applied IDs must be an exact ordered prefix of the registry.
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
  /** Called immediately before each pending migration and before its transaction. */
  beforeMigration?: (migration: Migration) => void;
  /** Validate the ledger but leave known pending migrations unapplied. */
  applyPending?: boolean;
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

function migrationsTableExists(db: Database): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
}

/** Inspect the database's applied IDs against the exact ordered registry prefix. */
function inspectLedgerAgainst(db: Database, registryIds: readonly string[]): MigrationLedgerState {
  if (!migrationsTableExists(db)) return { status: registryIds.length === 0 ? "current" : "old", migrationIds: [] };

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

export function assertCurrentMigrationLedger(db: Database, migrations: readonly Migration[]): MigrationLedgerState {
  const state = assertMigrationLedger(db, migrations);
  if (state.status !== "current") {
    throw new Error(
      `Refusing to open an obsolete writable schema; run \`akm migrate apply\`: ${state.detail ?? "pending migrations"}.`,
    );
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
 * inserted AFTER the DDL succeeds, so a crash mid-migration leaves no row and
 * the migration is retried on next open (all DDL in `up` uses IF NOT EXISTS so
 * the retry is safe).
 *
 * @param db          The open SQLite database.
 * @param migrations  The module's ordered, append-only migration list.
 * @param opts        Migration execution options.
 */
export function runMigrations(db: Database, migrations: readonly Migration[], opts?: RunMigrationsOptions): void {
  assertMigrationRegistry(migrations);
  if (opts?.applyPending === false) {
    assertMigrationLedger(db, migrations);
    return;
  }
  if (migrationsTableExists(db)) assertMigrationLedger(db, migrations);

  ensureMigrationsTable(db);

  const appliedRows = db.prepare("SELECT id FROM schema_migrations ORDER BY rowid").all() as Array<{ id: string }>;
  const applied = new Set(appliedRows.map((r) => r.id));

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;

    opts?.beforeMigration?.(migration);

    db.transaction(() => {
      db.exec(migration.up);
      db.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(migration.id);
    })();
  }
}
