// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import crypto from "node:crypto";
import path from "node:path";
import { ConfigError } from "./errors";
import { classifyPathAccess, describeInaccessiblePath } from "./path-access";
import { getConfigPath, getDataDir } from "./paths";

let afterPendingCheckHook: (() => void) | undefined;

/** TEST-ONLY: run once after a clear pending-operation check. */
export function _setAfterPendingOperationCheckHookForTests(hook?: () => void): void {
  afterPendingCheckHook = hook;
}

function installationId(): string {
  return crypto
    .createHash("sha256")
    .update(path.resolve(path.dirname(getConfigPath())))
    .update("\0")
    .update(path.resolve(getDataDir()))
    .digest("hex")
    .slice(0, 24);
}

export function getMigrationOperationRoot(): string {
  return path.join(getDataDir(), "backups", "migrations", installationId());
}

export function getMigrationRestoreJournalPath(): string {
  return path.join(getMigrationOperationRoot(), "restore-active.json");
}

export function getMigrationApplyJournalPath(): string {
  return path.join(getMigrationOperationRoot(), "apply-active.json");
}

/**
 * Predictable path for the config `akm migrate apply` auto-generates when no
 * `--config` is given and the active config still carries the pre-cutover
 * `stashDir`/`sources[]`/`installed[]` shape (see `config-migrate.ts`'s
 * `buildMigrationPlan`/`writeGeneratedTargetConfig`). Deliberately NOT the
 * live `config.json` — the live 0.8 file must stay byte-for-byte untouched
 * until `publishConfigLast` performs its normal atomic install, so the
 * generated draft lives here instead, next to the apply/restore sentinels.
 * Stable across invocations (keyed only by installation id, not a run id) so
 * a second `migrate apply`/`migrate status` with still no `--config` finds
 * the same file an operator may have hand-edited (e.g. to add `engines`)
 * after the first run generated it.
 */
export function getMigrationGeneratedConfigPath(): string {
  return path.join(getMigrationOperationRoot(), "generated-config.json");
}

/**
 * Refuse canonical config/database access while a migration or restore is
 * mid-flight.
 *
 * This is a SAFETY gate, so "I could not tell" must fail the same way "yes"
 * does. `fs.existsSync` answered `false` for an unreadable journal exactly as
 * for an absent one (#791), which meant a permission fault on the journal
 * silently CLEARED the gate and let akm open the canonical databases on top of
 * a half-applied migration. Absence is the only answer that may open the door.
 */
export function assertNoPendingMigrationOperation(): void {
  for (const [kind, journalPath] of [
    ["restore", getMigrationRestoreJournalPath()],
    ["migration apply", getMigrationApplyJournalPath()],
  ] as const) {
    const { access, code } = classifyPathAccess(journalPath);
    if (access === "inaccessible") {
      throw new ConfigError(
        `Cannot determine whether an AKM ${kind} recovery is pending: ${describeInaccessiblePath(journalPath, code)}. ` +
          "Refusing canonical config/database access — proceeding could write on top of a half-applied migration.",
        "DATA_DIR_UNREADABLE",
      );
    }
    if (access === "present") {
      throw new ConfigError(
        `AKM ${kind} recovery is pending at ${journalPath}; refusing canonical config/database access until recovery completes.`,
        "INVALID_CONFIG_FILE",
      );
    }
  }
  const hook = afterPendingCheckHook;
  afterPendingCheckHook = undefined;
  hook?.();
}
