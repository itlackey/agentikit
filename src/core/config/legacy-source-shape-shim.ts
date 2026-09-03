// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The retired 0.8 source-config shape (`stashDir` / `sources[]` / `installed[]`)
 * read shim.
 *
 * These three keys fully predate the 0.9.0 `bundles` + `defaultBundle` shape
 * (spec §10.1) and no migrator has ever existed for them — `akm migrate apply`
 * does not touch them. `AkmConfigSchema`'s `superRefine` therefore hard-rejects
 * them (see `config-schema.ts`), which means every akm command exits 78 the
 * moment a real 0.8-era config.json is read, with no working command left to
 * recover with.
 *
 * This module is the in-memory read shim, mirroring the established pattern in
 * `config-version-shim.ts` and `src/tasks/source/parse-task-source.ts`: a pure
 * function that takes the raw parsed JSON object and returns a new raw object
 * in the current shape, with a one-line stderr deprecation warning. The result
 * is never written back to disk automatically — `akm migrate apply` is the
 * on-disk rewrite path, and until it runs, this shim re-derives the same
 * bundles on every load.
 *
 * The transform is deliberately simple, not a byte-perfect reconstruction:
 *   - `stashDir: "/p"` becomes `bundles.stash = { path: "/p", writable: true }`
 *     and `defaultBundle` defaults to `"stash"`.
 *   - Each `sources[]` entry becomes its own bundle, keyed by its `name` (when
 *     it is a legal bundle slug) or a positional fallback. An entry whose
 *     shape this shim does not recognize (unknown `type`, or missing the field
 *     that type requires) is dropped rather than guessed at.
 *   - `installed[]` has no 0.9 equivalent (asset installation is tracked by
 *     the index now, not a static list) and is simply dropped.
 *   - Only used only when this call site (`loadConfig`/`loadUserConfig`) is
 *     the read shim; `validateConfigShape`, used to test the schema directly,
 *     intentionally does not route through this shim — see its own tests for
 *     why a `bundles` config that still carries these keys should keep
 *     failing loudly there.
 */
import { isBundleSlug } from "../asset/asset-ref";
import { warnOnce } from "../warn";

// A local, dependency-free record guard (rather than `../common`'s `isRecord`)
// — `common.ts` itself calls into this module from `readStashDirFromConfig`,
// which documents its own reason for avoiding a `../config` import cycle;
// importing `../common` back from here would recreate exactly that cycle.
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const DEFAULT_WRITABLE_BY_TYPE: Record<string, boolean | undefined> = {
  filesystem: true,
  git: false,
  website: false,
  npm: false,
};

/** Convert one legacy `sources[]` entry into a `[bundleKey, bundleEntry]` pair, or `undefined` if unrecognized. */
function bundleFromLegacySource(entry: unknown, index: number): [string, Record<string, unknown>] | undefined {
  if (!isPlainRecord(entry)) return undefined;
  const type = typeof entry.type === "string" ? entry.type : undefined;
  const bundle: Record<string, unknown> = {};
  switch (type) {
    case "filesystem":
      if (typeof entry.path !== "string" || !entry.path) return undefined;
      bundle.path = entry.path;
      break;
    case "git":
      if (typeof entry.url !== "string" || !entry.url) return undefined;
      bundle.git = entry.url;
      break;
    case "website":
      if (typeof entry.url !== "string" || !entry.url) return undefined;
      bundle.website = { url: entry.url };
      break;
    case "npm": {
      const spec = typeof entry.url === "string" && entry.url ? entry.url : entry.path;
      if (typeof spec !== "string" || !spec) return undefined;
      bundle.npm = spec;
      break;
    }
    default:
      return undefined;
  }
  const writable = typeof entry.writable === "boolean" ? entry.writable : DEFAULT_WRITABLE_BY_TYPE[type ?? ""];
  if (writable !== undefined) bundle.writable = writable;
  if (typeof entry.enabled === "boolean") bundle.enabled = entry.enabled;
  const name = typeof entry.name === "string" ? entry.name : undefined;
  const key = name && isBundleSlug(name) ? name : `source-${index + 1}`;
  return [key, bundle];
}

/**
 * Route a raw parsed config object through the retired-source-shape shim.
 * Returns `raw` unchanged when none of `stashDir`/`sources`/`installed` are
 * present; otherwise returns a new object with those keys removed and their
 * content folded into `bundles`/`defaultBundle`, plus a one-line warning.
 */
export function migrateLegacySourceShape(raw: Record<string, unknown>, sourcePath?: string): Record<string, unknown> {
  const hasStashDir = typeof raw.stashDir === "string" && raw.stashDir.trim().length > 0;
  const hasSources = Array.isArray(raw.sources) && raw.sources.length > 0;
  const hasInstalled = "installed" in raw && raw.installed !== undefined;
  if (!hasStashDir && !hasSources && !hasInstalled) return raw;

  const { stashDir: _stashDir, sources: _sources, installed: _installed, ...rest } = raw;
  const bundles: Record<string, unknown> = isPlainRecord(rest.bundles) ? { ...rest.bundles } : {};
  let defaultBundle = typeof rest.defaultBundle === "string" ? rest.defaultBundle : undefined;

  if (hasStashDir) {
    bundles.stash = { path: raw.stashDir, writable: true };
    defaultBundle ??= "stash";
  }
  if (hasSources) {
    (raw.sources as unknown[]).forEach((entry, index) => {
      const converted = bundleFromLegacySource(entry, index);
      if (!converted) return;
      const [key, bundle] = converted;
      bundles[key] = bundle;
      defaultBundle ??= key;
    });
  }

  const droppedKeys = [hasStashDir && "stashDir", hasSources && "sources", hasInstalled && "installed"].filter(Boolean);
  const where = sourcePath ? ` at ${sourcePath}` : "";
  warnOnce(
    `legacy-source-shape${sourcePath ? `:${sourcePath}` : ""}`,
    `Config${where} uses the retired ${droppedKeys.join("/")} shape — auto-migrated in memory to \`bundles\`/\`defaultBundle\`. Run \`akm migrate apply\` to rewrite the config file and silence this warning.`,
  );

  return { ...rest, bundles, ...(defaultBundle !== undefined ? { defaultBundle } : {}) };
}
