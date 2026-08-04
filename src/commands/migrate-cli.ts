// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { defineGroupCommand, defineJsonCommand } from "../cli/shared";
import { runMigrationTool } from "./migration-tool";

const configArg = {
  type: "string" as const,
  description: "Complete operator-prepared current config; optional when the active config is current",
};

export const migrateCommand = defineGroupCommand({
  // S11 originally hid this from `--help`/completions as an internal,
  // self-update-only surface. That made it undiscoverable even though the
  // 0.9.0 upgrade instructions tell users to run it first (`akm migrate
  // status`, `akm migrate apply`) — the one command those instructions
  // depend on was invisible. Listed in the SYSTEM section of HELP_SECTIONS
  // (src/cli.ts) and in shell completions now; `akm migrate status`/`apply`
  // always executed regardless of `hidden`.
  meta: { name: "migrate", description: "Inspect or apply config and durable database migrations" },
  subCommands: {
    status: defineJsonCommand({
      meta: { name: "status", description: "Read-only cross-artifact migration eligibility check" },
      args: { config: configArg },
      run({ args }) {
        return runMigrationTool(["status", ...(args.config ? ["--config", args.config] : [])]);
      },
    }),
    apply: defineJsonCommand({
      meta: { name: "apply", description: "Create a verified backup and atomically apply pending migrations" },
      args: {
        config: configArg,
        // R-062: canonical spelling is kebab-case, matching every other
        // multi-word flag in the CLI. `--dryRun` (the pre-rename spelling)
        // is kept as an explicit, documented alias — citty registers BOTH
        // the camelCase and kebab-case spelling of any declared flag name
        // automatically, so this is a rename, not a breaking change: both
        // spellings already worked, and both keep working.
        "dry-run": {
          type: "boolean",
          alias: "dryRun",
          default: false,
          description: "Run the same eligibility checks without mutation. Alias: --dryRun.",
        },
      },
      run({ args }) {
        return runMigrationTool([
          "apply",
          ...(args.config ? ["--config", args.config] : []),
          ...(args.dryRun ? ["--dry-run"] : []),
        ]);
      },
    }),
  },
  // No `defaultRun`: bare `akm migrate` is a usage error (exit 2). This group
  // already threw its own hand-rolled UsageError; it now shares the canonical
  // one from `defineGroupCommand` so the message and hint match every other
  // group — owner ruling 12.
});
