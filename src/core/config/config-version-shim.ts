// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `configVersion` read shim (#863).
 *
 * `configVersion` used to be a hard `z.literal(CURRENT_CONFIG_VERSION)` gate:
 * every value other than the exact current string threw
 * `UNSUPPORTED_CONFIG_VERSION` for every command, since every akm invocation
 * loads config first. That is the same shape of break #858/#859 (proposal
 * rows), the `task_history` `metadataVersion` gate, and the task-source v2/v3
 * gate each caused in 0.9.x — a version gate with no read shim — except
 * `configVersion`'s blast radius is the whole CLI rather than one subsystem.
 *
 * This module mirrors the in-tree template for that fix,
 * `src/tasks/source/parse-task-source.ts`'s v2/v3 -> v4 shim: a known-old
 * version routes through a pure, in-memory upgrade function to the current
 * shape, with a one-line stderr deprecation warning; the result is never
 * written back to disk (the on-disk rewrite already happens for free — every
 * `saveConfig`/`mutateConfig` write forces `configVersion` to
 * {@link CURRENT_CONFIG_VERSION}, so the very next `akm config set` or any
 * other mutating command silences the warning permanently). A version that is
 * neither current nor a known old version — including anything NEWER than
 * current — still fails closed with `UNSUPPORTED_CONFIG_VERSION`:
 * forward-incompatibility is a real hazard (an older binary must not guess at
 * a newer, unknown shape) and this shim does not soften that.
 *
 * IMPORTANT — as of this writing, `"0.9.0"` is the only `configVersion` akm
 * has ever shipped; there is no real prior release to shim. `"0.0.1"` below
 * is a SYNTHETIC placeholder entry that exists solely to stand up and
 * exercise this mechanism — the known-versions list, the dispatch table, the
 * warn-once-and-upgrade behavior, the fail-closed behavior for anything
 * else — before a real bump ever needs it (see
 * `tests/integration/config-version-shim.test.ts` and the
 * `previous-release-corpus.test.ts` fixture). When the first genuine
 * `configVersion` bump ships, add its real old shape as its own entry the
 * same way and delete the synthetic `"0.0.1"` entry (and this paragraph) in
 * the same change.
 */

import { ConfigError } from "../errors";
import { warn } from "../warn";
import { CURRENT_CONFIG_VERSION } from "./schema/primitives";

/**
 * Every `configVersion` this binary can still READ, other than
 * {@link CURRENT_CONFIG_VERSION} itself — each with an in-memory upgrade
 * function in {@link CONFIG_VERSION_UPGRADES}. Anything not in this list (and
 * not equal to current) fails closed.
 */
export const KNOWN_OLD_CONFIG_VERSIONS = ["0.0.1"] as const;

type KnownOldConfigVersion = (typeof KNOWN_OLD_CONFIG_VERSIONS)[number];

function isKnownOldConfigVersion(value: unknown): value is KnownOldConfigVersion {
  return typeof value === "string" && (KNOWN_OLD_CONFIG_VERSIONS as readonly string[]).includes(value);
}

/**
 * SYNTHETIC 0.0.1 -> 0.9.0 upgrade (placeholder — see module doc). Per this
 * placeholder, 0.0.1 kept the default LLM engine name at the config root as
 * `defaultEngine`; 0.9.0 moved it under `defaults.llmEngine`. Pure function:
 * takes the raw parsed JSON object, returns a new raw object with the 0.9.0
 * shape. Never touches disk.
 */
function upgradeFrom080(raw: Record<string, unknown>): Record<string, unknown> {
  const { defaultEngine, defaults, ...rest } = raw;
  if (typeof defaultEngine !== "string" || defaultEngine.length === 0) {
    return { ...rest, ...(defaults !== undefined ? { defaults } : {}), configVersion: CURRENT_CONFIG_VERSION };
  }
  const existingDefaults =
    defaults !== null && typeof defaults === "object" ? (defaults as Record<string, unknown>) : {};
  return {
    ...rest,
    configVersion: CURRENT_CONFIG_VERSION,
    // An explicit `defaults.llmEngine` already present in the raw 0.0.1
    // document (should never happen for a real 0.0.1 file, but a malformed
    // one is possible) wins over the root-level field being migrated in.
    defaults: { llmEngine: defaultEngine, ...existingDefaults },
  };
}

const CONFIG_VERSION_UPGRADES: Record<
  KnownOldConfigVersion,
  (raw: Record<string, unknown>) => Record<string, unknown>
> = {
  "0.0.1": upgradeFrom080,
};

function unsupportedConfigVersionError(rawVersion: unknown, sourcePath?: string): ConfigError {
  const where = sourcePath ? ` at ${sourcePath}` : "";
  const supported = [CURRENT_CONFIG_VERSION, ...KNOWN_OLD_CONFIG_VERSIONS].map((v) => `"${v}"`).join(", ");
  return new ConfigError(
    `Unsupported configVersion${where}: got ${JSON.stringify(rawVersion)}, expected one of ${supported}.`,
    "UNSUPPORTED_CONFIG_VERSION",
    "Recreate engines and improve.strategies manually for AKM 0.9.0; profile-based configuration is not translated automatically.",
  );
}

/**
 * Route a raw parsed config object through the version shim before schema
 * validation. Returns a raw object whose `configVersion` is
 * {@link CURRENT_CONFIG_VERSION} — either unchanged (already current),
 * in-memory-upgraded (a known old version, with a one-line stderr warning),
 * or this throws `UNSUPPORTED_CONFIG_VERSION` (unknown, newer, missing, or
 * malformed).
 */
export function upgradeConfigVersion(raw: Record<string, unknown>, sourcePath?: string): Record<string, unknown> {
  const version = raw.configVersion;
  if (version === CURRENT_CONFIG_VERSION) return raw;
  if (isKnownOldConfigVersion(version)) {
    const upgraded = CONFIG_VERSION_UPGRADES[version](raw);
    warn(
      `Config${sourcePath ? ` at ${sourcePath}` : ""} uses configVersion "${version}" — auto-upgraded to ${CURRENT_CONFIG_VERSION} in memory; the next config write (e.g. \`akm config set\`) persists this and silences the warning.`,
    );
    return upgraded;
  }
  throw unsupportedConfigVersionError(version, sourcePath);
}
