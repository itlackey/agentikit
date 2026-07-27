// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { defineGroupCommand, defineJsonCommand } from "../cli/shared";
import { UsageError } from "../core/errors";
import { runMigrationTool } from "./migration-tool";

const configArg = {
  type: "string" as const,
  description: "Complete operator-prepared current config; optional when the active config is current",
};

export const migrateCommand = defineGroupCommand({
  meta: { name: "migrate", description: "Inspect or apply config and durable database migrations" },
  subCommands: {
    status: defineJsonCommand({
      meta: { name: "status", description: "Read-only cross-artifact migration eligibility check" },
      args: { config: configArg },
      run({ args }) {
        runMigrationTool(["status", ...(args.config ? ["--config", args.config] : [])]);
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
        runMigrationTool([
          "apply",
          ...(args.config ? ["--config", args.config] : []),
          ...(args.dryRun ? ["--dry-run"] : []),
        ]);
      },
    }),
  },
  defaultRun() {
    throw new UsageError("Choose `migrate status` or `migrate apply`.", "MISSING_REQUIRED_ARGUMENT");
  },
});
