// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "./errors";
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

export function assertNoPendingMigrationOperation(): void {
  for (const [kind, journalPath] of [
    ["restore", getMigrationRestoreJournalPath()],
    ["migration apply", getMigrationApplyJournalPath()],
  ] as const) {
    if (fs.existsSync(journalPath)) {
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
