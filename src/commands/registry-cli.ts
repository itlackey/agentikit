// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { defineGroupCommand, defineJsonCommand, output } from "../cli/shared";
import type { RegistryConfigEntry } from "../core/config/config";
import { getEffectiveRegistries, loadUserConfig, mutateConfig } from "../core/config/config";
import { UsageError } from "../core/errors";
import { warn } from "../core/warn";

export const registryCommand = defineGroupCommand({
  meta: { name: "registry", description: "Manage bundle registries" },
  subCommands: {
    list: defineJsonCommand({
      meta: { name: "list", description: "List configured registries" },
      async run() {
        const config = loadUserConfig();
        // R-066 #5: mirror the shared config↔default-fallback helper instead
        // of re-deriving it inline.
        output("registry-list", { registries: getEffectiveRegistries(config) });
      },
    }),
    add: defineJsonCommand({
      meta: { name: "add", description: "Add a registry by URL" },
      args: {
        url: { type: "positional", description: "Registry index URL", required: true },
        name: { type: "string", description: "Human-friendly name for the registry" },
        provider: { type: "string", description: "Provider type (e.g. static-index, skills-sh)" },
        options: { type: "string", description: 'Provider options as JSON (e.g. \'{"apiKey":"key"}\').' },
        "allow-insecure": {
          type: "boolean",
          description: "Allow a plain HTTP registry URL (otherwise rejected)",
          default: false,
        },
      },
      async run({ args }) {
        if (!args.url.startsWith("http")) {
          throw new UsageError("Registry URL must start with http:// or https://");
        }
        if (args.url.startsWith("http://")) {
          const allowInsecure = args["allow-insecure"];
          if (!allowInsecure) {
            throw new UsageError(
              "Registry URL uses plain HTTP (not HTTPS). An on-path attacker could substitute a malicious index. " +
                "Use https:// or pass --allow-insecure if you have explicitly accepted the risk.",
            );
          }
          warn(
            "Warning: registry URL uses plain HTTP (not HTTPS). --allow-insecure was set; an on-path attacker could substitute a malicious index.",
          );
        }
        const entry: RegistryConfigEntry = { url: args.url };
        if (args.name) entry.name = args.name;
        if (args.provider) entry.provider = args.provider;
        if (args.options) {
          try {
            entry.options = JSON.parse(args.options);
          } catch {
            throw new UsageError("--options must be valid JSON");
          }
        }
        let added = false;
        const updated = mutateConfig((config) => {
          const registries = [...(config.registries ?? [])];
          if (registries.some((registry) => registry.url === args.url)) return config;
          registries.push(entry);
          added = true;
          return { ...config, registries };
        }).config;
        output("registry-add", {
          registries: updated.registries ?? [],
          added,
          ...(!added ? { message: "Registry URL already configured" } : {}),
        });
      },
    }),
    remove: defineJsonCommand({
      meta: { name: "remove", description: "Remove a registry by URL or name" },
      args: {
        target: { type: "positional", description: "Registry URL or name to remove", required: true },
        yes: { type: "boolean", alias: "y", description: "Skip confirmation prompt", default: false },
      },
      async run({ args }) {
        const config = loadUserConfig();
        const registries = [...(config.registries ?? [])];
        const idx = registries.findIndex((r) => r.url === args.target || r.name === args.target);
        if (idx === -1) {
          output("registry-remove", { registries, removed: false, message: "No matching registry found" });
          return;
        }
        const { confirmDestructive } = await import("../cli/confirm.js");
        const confirmed = await confirmDestructive(`Remove registry "${args.target}"? This cannot be undone.`, {
          yes: args.yes === true,
        });
        if (!confirmed) {
          process.stderr.write("Aborted.\n");
          return;
        }
        let removed: RegistryConfigEntry | undefined;
        const updated = mutateConfig((latest) => {
          const current = [...(latest.registries ?? [])];
          const currentIndex = current.findIndex(
            (registry) => registry.url === args.target || registry.name === args.target,
          );
          if (currentIndex < 0) return latest;
          removed = current.splice(currentIndex, 1)[0];
          return { ...latest, registries: current };
        }).config;
        output("registry-remove", {
          registries: updated.registries ?? [],
          removed: removed !== undefined,
          ...(removed ? { entry: removed } : { message: "No matching registry found" }),
        });
      },
    }),
  },
});
