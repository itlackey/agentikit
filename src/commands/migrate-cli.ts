// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { defineGroupCommand, defineJsonCommand, output } from "../cli/shared";
import { runMigrationTool } from "./migration-tool";

/**
 * Split the standalone `akm-migrate` tool's captured stdout into its
 * progress-event lines (if any — `apply` prints one JSON line per completed
 * sub-step, e.g. content migration / proposal-ref repair) and its final
 * result line. `status` and `apply --dry-run` never print progress, so
 * `progress` is empty for them; `apply` may print zero or more.
 *
 * Each `console.log` call in the child produces exactly one `\n`-terminated
 * line, so splitting on `\n` and dropping the trailing empty entry from the
 * final newline recovers exactly the lines it printed, in order.
 */
function splitToolStdout(stdout: string): { progress: string[]; resultLine?: string } {
  const lines = stdout.split("\n");
  if (lines.length > 0 && lines.at(-1) === "") lines.pop();
  if (lines.length === 0) return { progress: [] };
  return { progress: lines.slice(0, -1), resultLine: lines.at(-1) };
}

/**
 * Runs the standalone `akm-migrate` tool and renders its result through the
 * normal `--format` pipeline (D7) instead of a fixed JSON passthrough.
 *
 * The child's progress-event lines (if any) are not part of the result
 * envelope — they print as-is, in order, regardless of `--format`, the same
 * way `apply` always printed them before this change. Only the final result
 * line — always a well-formed `MigrationPlan` JSON object — is parsed and
 * handed to `output()`, so `text`/`md`/`html`/`yaml` render a real
 * (registered or generic) rendering of it instead of silently staying JSON.
 * `--format json` (the default) is therefore the only format whose BYTES can
 * change here (pretty-printed via `output()` instead of the child's compact
 * `JSON.stringify`) — every value stays identical, which is what the
 * migration-lifecycle integration tests assert via `JSON.parse`.
 */
async function runMigrateSubcommand(command: "migrate-status" | "migrate-apply", args: string[]): Promise<void> {
  const result = await runMigrationTool(args);
  if (result.stderr) process.stderr.write(result.stderr);

  const { progress, resultLine } = splitToolStdout(result.stdout);
  for (const line of progress) console.log(line);
  if (resultLine !== undefined) {
    try {
      output(command, JSON.parse(resultLine));
    } catch {
      // The child is expected to always print one well-formed JSON result
      // line; if it somehow didn't, don't lose the line, just don't reshape it.
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
