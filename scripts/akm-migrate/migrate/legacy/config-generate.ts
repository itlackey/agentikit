// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Auto-generates a starter 0.9.0 target config from a pre-cutover 0.8 config,
 * for `akm migrate apply`'s no-`--config` path (see `config-migrate.ts`'s
 * `buildMigrationPlan`/`writeGeneratedTargetConfig`).
 *
 * Split into two independent, honest halves:
 *
 * - The MECHANICAL half (`bundles`/`defaultBundle`) is a pure function of the
 *   0.8 `stashDir`/`sources[]`/`installed[]` keys — {@link migrateConfigSourcesToBundles}
 *   (`./config-source-migration.ts`) already computes exactly this, well
 *   tested on its own; this module reuses it rather than reimplementing it.
 * - The AMBIGUOUS half (`profiles.llm`/`profiles.agent`/`profiles.improve`/
 *   `defaults.llm`/`defaults.agent`/`defaults.improve`) is never guessed at.
 *   0.9's `AkmConfigSchema` HARD-REJECTS every one of these keys when present
 *   (`src/core/config/config-schema.ts`'s top-level `superRefine`: `profiles`
 *   is a retired top-level key, and `defaults.llm`/`defaults.agent`/
 *   `defaults.improve` are individually rejected too) — so generation MUST
 *   strip them for the mechanical half to validate at all. This module names,
 *   by exact dotted 0.8 key path, every key it drops, so `migrate status`/
 *   `apply` can tell the operator precisely what still needs a hand-authored
 *   `engines`/`defaults` block instead of silently producing a config with a
 *   quietly-vanished agent or LLM profile.
 */

import { migrateConfigSourcesToBundles } from "./config-source-migration";

function objectAt(raw: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = raw[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Every 0.8 `profiles.*`/`defaults.llm`/`defaults.agent`/`defaults.improve`
 * key present on `raw`, named by its exact dotted 0.8 path (e.g.
 * `"profiles.llm.fast"`, `"defaults.agent"`) — the same names the 0.8→0.9
 * migration guide's key-mapping table uses. Empty when there is nothing
 * ambiguous to translate, in which case generation is complete on its own.
 */
export function detectLegacyEngineKeys(raw: Record<string, unknown>): string[] {
  const dropped: string[] = [];
  const profiles = objectAt(raw, "profiles");
  for (const kind of ["llm", "agent", "improve"] as const) {
    const map = profiles ? objectAt(profiles, kind) : undefined;
    if (map) for (const name of Object.keys(map)) dropped.push(`profiles.${kind}.${name}`);
  }
  const defaults = objectAt(raw, "defaults");
  for (const key of ["llm", "agent", "improve"] as const) {
    if (defaults && defaults[key] !== undefined) dropped.push(`defaults.${key}`);
  }
  return dropped;
}

/**
 * Remove the hard-rejected `profiles` key and `defaults.llm`/`defaults.agent`/
 * `defaults.improve` sub-keys from `raw`. Never mutates `raw`. Returns the
 * stripped object alongside {@link detectLegacyEngineKeys}'s report over the
 * SAME input, so the caller can both write a schema-valid file and tell the
 * operator exactly what it left out.
 */
export function stripLegacyEngineKeys(raw: Record<string, unknown>): {
  config: Record<string, unknown>;
  droppedKeys: string[];
} {
  const droppedKeys = detectLegacyEngineKeys(raw);
  const config: Record<string, unknown> = { ...raw };
  delete config.profiles;
  const defaults = objectAt(raw, "defaults");
  if (defaults) {
    const nextDefaults = { ...defaults };
    delete nextDefaults.llm;
    delete nextDefaults.agent;
    delete nextDefaults.improve;
    if (Object.keys(nextDefaults).length > 0) config.defaults = nextDefaults;
    else delete config.defaults;
  }
  return { config, droppedKeys };
}

/**
 * Derive a complete-for-the-mechanical-part 0.9.0 target config from a
 * pre-cutover 0.8 raw config object: `bundles`/`defaultBundle` via
 * {@link migrateConfigSourcesToBundles}, `configVersion` stamped to
 * `currentConfigVersion` (a pure constant, never ambiguous), and every
 * `profiles`/legacy-`defaults` key stripped and reported via `droppedKeys`.
 * The returned `config` still needs schema validation by the caller — this
 * function only shapes the object, it does not assert it is valid.
 */
export function generateTargetConfig(
  raw: Record<string, unknown>,
  currentConfigVersion: string,
): { config: Record<string, unknown>; droppedKeys: string[] } {
  const bundleShaped = migrateConfigSourcesToBundles(raw);
  const { config: stripped, droppedKeys } = stripLegacyEngineKeys(bundleShaped);
  return { config: { ...stripped, configVersion: currentConfigVersion }, droppedKeys };
}
