// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { defineGroupCommand, defineJsonCommand } from "../cli/shared";
import { UsageError } from "../core/errors";
import { runMigrationTool } from "./migration-tool";

function requireVersion(value: string): void {
  if (value !== "0.9.0") {
    throw new UsageError(
      `Unsupported migration backup target ${JSON.stringify(value)}; expected 0.9.0.`,
      "INVALID_FLAG_VALUE",
    );
  }
}

export const backupCommand = defineGroupCommand({
  meta: { name: "backup", description: "Create or restore a verified migration recovery run" },
  subCommands: {
    create: defineJsonCommand({
      meta: { name: "create", description: "Create a unique installation-scoped migration recovery run" },
      args: {
        for: { type: "string", required: true, description: "Migration target version (0.9.0)" },
      },
      run({ args }) {
        requireVersion(args.for);
        runMigrationTool(["backup", "--for", args.for]);
      },
    }),
    restore: defineJsonCommand({
      meta: { name: "restore", description: "Restore a recovery run after preserving a rescue snapshot" },
      args: {
        for: { type: "string", required: true, description: "Migration target version (0.9.0)" },
        run: { type: "string", description: "Backup run ID (defaults to the newest applicable run)" },
        confirm: { type: "boolean", default: false, description: "Confirm destructive restoration" },
      },
      run({ args }) {
        requireVersion(args.for);
        runMigrationTool([
          "restore",
          "--for",
          args.for,
          ...(args.run ? ["--run", args.run] : []),
          ...(args.confirm ? ["--confirm"] : []),
        ]);
      },
    }),
  },
  defaultRun() {
    throw new UsageError("Choose `backup create` or `backup restore`.", "MISSING_REQUIRED_ARGUMENT");
  },
});
