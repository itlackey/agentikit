// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Legacy `extraParams` -> first-class-field lift (#852, following #815), as
 * an `akm migrate` concern.
 *
 * This used to run silently, in memory, on every config load
 * (`liftLegacyEngineExtraParams` called from `parseAndValidateConfigText`)
 * and never wrote the result back — so the lift, and its warning, recurred
 * forever. config.json is akm-owned plain JSON; the lift is deterministic
 * and total, so — like the dead-residue cleanup in `./dead-residue.ts` —
 * it belongs in `akm migrate`, run once, persisted. `parseAndValidateConfigText`
 * now fails closed on an unmigrated config instead of lifting it.
 */

import {
  acquireConfigLock,
  backupExistingConfig,
  parseConfigText,
  readConfigText,
  writeConfigAtomic,
} from "../../../src/core/config/config-io";
import { type ExtraParamsLiftConflict, liftLegacyEngineExtraParams } from "../../../src/core/extra-params";

export interface ConfigExtraParamsLiftPlan {
  /** One human-readable line per key that would be lifted (or dropped as redundant). */
  lifted: string[];
  /** Engines where an extraParams key and its first-class field disagree — left untouched either way. */
  conflicts: ExtraParamsLiftConflict[];
}

function readRawConfig(configPath: string): Record<string, unknown> | undefined {
  const text = readConfigText(configPath);
  if (text === undefined) return undefined;
  return parseConfigText(text, configPath);
}

/**
 * Read-only: what `akm migrate apply` would lift (or flag as conflicting) in
 * `config.json`'s `extraParams`. Never touches disk. Returns an empty plan
 * when the config file does not exist.
 */
export function findConfigExtraParamsLift(configPath: string): ConfigExtraParamsLiftPlan {
  const raw = readRawConfig(configPath);
  if (!raw) return { lifted: [], conflicts: [] };
  const { lifted, conflicts } = liftLegacyEngineExtraParams(raw);
  return { lifted, conflicts };
}

export interface ConfigExtraParamsLiftResult extends ConfigExtraParamsLiftPlan {
  applied: boolean;
}

/**
 * Persist the legacy extraParams -> first-class field lift to `config.json`,
 * once. Best-effort like `removeDeadResidue`: a genuine conflict (extraParams
 * and the first-class field set to different values) is left untouched here
 * — `parseAndValidateConfigText` already hard-rejects that config at every
 * load with the exact mismatch, so a second, weaker error here would only be
 * noise — and is reported back via `conflicts` instead.
 */
export function applyConfigExtraParamsLift(configPath: string): ConfigExtraParamsLiftResult {
  const raw = readRawConfig(configPath);
  if (!raw) return { applied: false, lifted: [], conflicts: [] };
  const { config, lifted, conflicts } = liftLegacyEngineExtraParams(raw);
  if (conflicts.length > 0 || lifted.length === 0) {
    return { applied: false, lifted, conflicts };
  }
  const release = acquireConfigLock();
  try {
    backupExistingConfig(configPath);
    writeConfigAtomic(configPath, config);
  } finally {
    release();
  }
  return { applied: true, lifted, conflicts: [] };
}
