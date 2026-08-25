// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { defineGroupCommand, defineJsonCommand, output } from "../cli/shared";
import { runMigrationTool } from "./migration-tool";

/**
 * Run the task-only migrator and render its one JSON plan through the normal
 * output pipeline.
 */
async function runMigrateSubcommand(command: "migrate-status" | "migrate-apply", args: string[]): Promise<void> {
  const result = await runMigrationTool(args);
  if (result.stderr) process.stderr.write(result.stderr);

  const resultLine = result.stdout.trim();
  if (resultLine) {
    try {
      output(command, JSON.parse(resultLine));
    } catch {
      console.log(resultLine);
    }
  }

  // R-067: `process.exitCode = …; return;` (not `process.exit()`) so the
  // command's normal cleanup (`disposeDispatchResources()` in `runCommand`,
  // src/cli.ts) still runs before the process exits with the child's status.
  if (result.status !== 0) {
    process.exitCode = result.status;
    return;
  }
}

export const migrateCommand = defineGroupCommand({
  meta: { name: "migrate", description: "Inspect or apply task-v2 to task-v3 migrations" },
  subCommands: {
    status: defineJsonCommand({
      meta: { name: "status", description: "Read-only task-v2 migration check" },
      run() {
        return runMigrateSubcommand("migrate-status", ["status"]);
      },
    }),
    apply: defineJsonCommand({
      meta: { name: "apply", description: "Back up and atomically convert task-v2 files to task v3" },
      args: {
        "dry-run": {
          type: "boolean",
          default: false,
          description: "Run the same eligibility checks without mutation.",
        },
      },
      run({ args }) {
        return runMigrateSubcommand("migrate-apply", ["apply", ...(args.dryRun ? ["--dry-run"] : [])]);
      },
    }),
  },
  // No `defaultRun`: bare `akm migrate` is a usage error (exit 2). This group
  // already threw its own hand-rolled UsageError; it now shares the canonical
  // one from `defineGroupCommand` so the message and hint match every other
  // group — owner ruling 12.
});
