// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Config CLI commands — `akm config get/set/unset/list`.
 *
 * Thin wrappers around the schema walker in `core/config-walker.ts`. Adding a
 * new config field is one line of Zod schema in `core/config-schema.ts` and
 * zero lines here — the walker handles get/set/unset/coercion uniformly.
 *
 * `configVersion` is controlled by the config lifecycle. All execution
 * settings use their canonical engine/strategy paths; retired aliases are not
 * rewritten at this boundary.
 */
import { defineGroupCommand, defineJsonCommand, output } from "../cli/shared";
import { resolveStashDir } from "../core/common";
import { type AkmConfig, DEFAULT_CONFIG, loadConfig, mutateConfig } from "../core/config/config";
import { configGet, configSet, configUnset, unknownKeyHint } from "../core/config/config-walker";
import { getCacheDir, getConfigPath, getDbPath, getDefaultStashDir } from "../core/paths";

// ── Public API ──────────────────────────────────────────────────────────────

export function getConfigValue(config: AkmConfig, key: string): unknown {
  return redactConfigValue(configGet(config as unknown as Record<string, unknown>, key));
}

export function setConfigValue(config: AkmConfig, key: string, rawValue: string): AkmConfig {
  return configSet(config as unknown as Record<string, unknown>, key, rawValue) as unknown as AkmConfig;
}

export function unsetConfigValue(config: AkmConfig, key: string): AkmConfig {
  return configUnset(config as unknown as Record<string, unknown>, key) as unknown as AkmConfig;
}

export function listConfig(config: AkmConfig): Record<string, unknown> {
  // 0.9.0 (spec §10.1): sources live in `bundles` (spread from config); the
  // retired top-level `sources[]` array is no longer surfaced.
  return redactConfigValue({ ...DEFAULT_CONFIG, ...config }) as Record<string, unknown>;
}

function redactConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfigValue);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      key !== "apiKey" ||
      (typeof child === "string" && /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(child))
    ) {
      result[key] = redactConfigValue(child);
    }
  }
  return result;
}

export { unknownKeyHint };

// ── `akm config` command surface ────────────────────────────────────────────
// Extracted verbatim from src/cli.ts (WS6). The `main.subCommands.config` key
// and every config subcommand's args/output shape are byte-identical. Leaf
// handlers whose body is a plain `runWithJsonErrors(() => { … })` are
// migrated to `defineJsonCommand`, which emits the same JSON envelope
// (stdout/stderr/exit-code) as the inline form.
//
// `akm config enable|disable` (a hardcoded alias for toggling the skills.sh
// registry) was removed in 0.9.0 (C4). Use `akm registry add|remove`, the
// general mechanism, instead.

export const configCommand = defineGroupCommand({
  meta: { name: "config", description: "Show and manage configuration" },
  subCommands: {
    path: defineJsonCommand({
      meta: { name: "path", description: "Show paths to config, stash, cache, and index" },
      args: {
        all: { type: "boolean", description: "Show all paths (config, stash, cache, index)", default: false },
      },
      run({ args }) {
        const configPath = getConfigPath();
        if (args.all) {
          let stashDir: string;
          try {
            stashDir = resolveStashDir();
          } catch {
            stashDir = `${getDefaultStashDir()} (not initialized)`;
          }
          const cacheDir = getCacheDir();
          const result = {
            config: configPath,
            stash: stashDir,
            cache: cacheDir,
            index: getDbPath(),
          };
          output("config", result);
        } else {
          console.log(configPath);
        }
      },
    }),
    list: defineJsonCommand({
      meta: { name: "list", description: "List current configuration" },
      run() {
        output("config", listConfig(loadConfig()));
      },
    }),
    get: defineJsonCommand({
      meta: { name: "get", description: "Get a configuration value by key" },
      args: {
        key: { type: "positional", required: true, description: "Config key (for example: embedding, defaultBundle)" },
      },
      run({ args }) {
        output("config", getConfigValue(loadConfig(), args.key));
      },
    }),
    set: defineJsonCommand({
      meta: { name: "set", description: "Set a configuration value by key" },
      args: {
        key: {
          type: "positional",
          required: true,
          description: "Config key (for example: embedding, engines.default)",
        },
        value: { type: "positional", required: true, description: "Config value" },
        // #463: stable machine-friendly entry point for plugins / hooks.
        // `--silent` suppresses the config dump on stdout so hook-driven
        // writes don't pollute their host's output stream.
        silent: {
          type: "boolean",
          description:
            "Suppress the post-write config dump on stdout. Use from hooks and CI scripts; the write still happens and errors still print.",
          default: false,
        },
      },
      run({ args }) {
        const updated = mutateConfig((current) => setConfigValue(current, args.key, args.value)).config;
        if (!args.silent) {
          output("config", listConfig(updated));
        }
      },
    }),
    unset: defineJsonCommand({
      meta: { name: "unset", description: "Unset an optional configuration key or whole embedding/engine section" },
      args: {
        key: { type: "positional", required: true, description: "Config key to unset" },
        silent: {
          type: "boolean",
          description: "Suppress the post-write config dump on stdout.",
          default: false,
        },
      },
      run({ args }) {
        const result = mutateConfig((current) => unsetConfigValue(current, args.key), { absentNoop: true });
        const updated = result.config;
        if (!args.silent) {
          output("config", listConfig(updated));
        }
      },
    }),
  },
  // The bare `akm config` invocation (and `akm config --list`) dumps the
  // current config. defineGroupCommand short-circuits this body when a
  // registered subcommand ran, so the routing set stays derived from the
  // subCommands map and can never desync.
  // No `defaultRun`: bare `akm config` is a usage error (exit 2), the canonical
  // bare-group behavior — owner ruling 12. Run `akm config list` for what the
  // bare form used to print.
});
