// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The whole migration, in order, as one plan: legacy config lift, pending
 * state.db migrations, task v2 -> v3, task v3 -> task source v4, then the
 * stash-scoped residue sweeps. `akm-migrate status` / `apply [--dry-run]`
 * print exactly this; `akm migrate` and `akm upgrade` spawn that executable
 * and re-emit it. Every historical shape lives here or under `./migrate/`,
 * so the CLI proper only ever reads current schemas.
 */

import { resolveStashDir } from "../../src/core/common";
import { resetConfigCache } from "../../src/core/config/config";
import { ConfigError } from "../../src/core/errors";
import { getConfigPath } from "../../src/core/paths";
import { listPendingStateMigrations, upgradeHistoricalStateDatabase } from "../../src/core/state-db";
import {
  applyConfigExtraParamsLift,
  type ConfigExtraParamsLiftPlan,
  type ConfigExtraParamsLiftResult,
  findConfigExtraParamsLift,
} from "./migrate/config-extra-params";
import { type DeadResidueEntry, type DeadResidueRemoval, findDeadResidueEntries, removeDeadResidue } from "./migrate/dead-residue";
import { findStaleTxnEntries, recoverStaleTxns, type StaleTxnEntry } from "./migrate/stale-txn";
import {
  applyTaskV3Migration,
  applyTaskV4Migration,
  inspectMigrationPlan,
  inspectTaskV4MigrationStatus,
  type MigrationPlan,
  type TaskV4MigrationStatus,
} from "./task-migrate";

export type MigrationStatus = "current" | "ready" | "blocked";

export interface CombinedMigrationPlan {
  schemaVersion: 1;
  status: MigrationStatus;
  blockers: string[];
  configExtraParams: ConfigExtraParamsLiftResult | { pending: ConfigExtraParamsLiftPlan };
  stateMigrations: { pending: string[] } | { applied: string[]; safetyCopyPath?: string };
  taskV3Migration?: MigrationPlan["taskV3Migration"];
  taskV4Migration?: TaskV4MigrationStatus["taskV4Migration"];
  backupPath?: string;
  applied?: number;
  taskV4BackupPath?: string;
  taskV4Applied?: number;
  deadResidue?: { pending: DeadResidueEntry[] } | { removed: DeadResidueRemoval[] };
  staleTxns?: { pending: StaleTxnEntry[] } | { recovered: StaleTxnEntry[] };
}

function worstStatus(left: MigrationStatus, right: MigrationStatus): MigrationStatus {
  if (left === "blocked" || right === "blocked") return "blocked";
  if (left === "ready" || right === "ready") return "ready";
  return "current";
}

/** No configured bundle is an empty domain, not an error: migrate works before `akm bundle create`. */
function stashDirIfConfigured(): string | undefined {
  try {
    return resolveStashDir();
  } catch (error) {
    if (error instanceof ConfigError && error.code === "STASH_DIR_NOT_FOUND") return undefined;
    throw error;
  }
}

/**
 * Run every migration step and return the combined plan. `apply: false` is
 * read-only (`status`, `apply --dry-run`); `apply: true` mutates, each step
 * under its own lock and backup.
 */
export async function runMigration(options: { apply: boolean }): Promise<CombinedMigrationPlan> {
  const { apply } = options;
  const configPath = getConfigPath();

  // The config lift runs BEFORE anything that loads config. A config still
  // carrying legacy extraParams keys fails `loadConfig` closed, and that
  // error names `akm migrate apply` as the remedy -- every later step loads
  // config, so applying the lift first is what makes the advice true.
  // Read-only modes cannot rewrite the file, so a pending lift is reported
  // as the blocker instead of letting the operator hit the same error again.
  const configExtraParams = apply
    ? applyConfigExtraParamsLift(configPath)
    : { pending: findConfigExtraParamsLift(configPath) };
  if (apply && (configExtraParams as ConfigExtraParamsLiftResult).applied) resetConfigCache();
  const pendingLift = apply ? undefined : (configExtraParams as { pending: ConfigExtraParamsLiftPlan }).pending;
  if (pendingLift && pendingLift.lifted.length > 0) {
    return {
      schemaVersion: 1,
      status: "blocked",
      blockers: pendingLift.lifted,
      configExtraParams,
      stateMigrations: { pending: listPendingStateMigrations() },
    };
  }

  // State next, and before the task migrators: they open state.db themselves,
  // and an ordinary open refuses a historical-destructive migration by design.
  // This and `akm upgrade` (which runs this) are the only routes that admit
  // one, always with the verified safety copy.
  const stateMigrations = apply ? applyStateMigrations() : { pending: listPendingStateMigrations() };

  const stashDir = stashDirIfConfigured();
  const taskV3 = apply ? applyTaskV3Migration() : inspectMigrationPlan();
  const taskV4 = apply ? applyTaskV4Migration() : inspectTaskV4MigrationStatus();
  const stashSections =
    stashDir === undefined
      ? {}
      : {
          deadResidue: apply ? { removed: removeDeadResidue(stashDir) } : { pending: findDeadResidueEntries(stashDir) },
          staleTxns: apply ? { recovered: await recoverStaleTxns(stashDir) } : { pending: findStaleTxnEntries(stashDir) },
        };

  return {
    schemaVersion: 1,
    status: worstStatus(taskV3.status, taskV4.status),
    blockers: [...taskV3.blockers, ...taskV4.blockers],
    configExtraParams,
    stateMigrations,
    taskV3Migration: taskV3.taskV3Migration,
    taskV4Migration: taskV4.taskV4Migration,
    ...(taskV3.backupPath !== undefined ? { backupPath: taskV3.backupPath } : {}),
    ...(taskV3.applied !== undefined ? { applied: taskV3.applied } : {}),
    ...(taskV4.backupPath !== undefined ? { taskV4BackupPath: taskV4.backupPath } : {}),
    ...(taskV4.applied !== undefined ? { taskV4Applied: taskV4.applied } : {}),
    ...stashSections,
  };
}

function applyStateMigrations(): { applied: string[]; safetyCopyPath?: string } {
  const result = upgradeHistoricalStateDatabase();
  return result.safetyCopyPath
    ? { applied: result.applied, safetyCopyPath: result.safetyCopyPath }
    : { applied: result.applied };
}
