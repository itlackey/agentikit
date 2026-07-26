#!/usr/bin/env bun

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { runWithJsonErrors } from "../src/cli/shared";
import { UsageError } from "../src/core/errors";
import { runMigrationApply, runMigrationStatus } from "./akm-migrate/config-migrate";
import helpText from "./akm-migrate/help.txt" with { type: "text" };
import {
  createMigrationBackup,
  MIGRATION_BACKUP_VERSION,
  restoreMigrationBackup,
} from "./akm-migrate/migration-backup";

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new UsageError(`${flag} requires a value.`, "MISSING_REQUIRED_ARGUMENT");
  return value;
}

function requireBackupVersion(args: readonly string[]): void {
  const version = valueAfter(args, "--for") ?? MIGRATION_BACKUP_VERSION;
  if (version !== MIGRATION_BACKUP_VERSION) {
    throw new UsageError(
      `Unsupported migration backup target ${JSON.stringify(version)}; expected ${MIGRATION_BACKUP_VERSION}.`,
      "INVALID_FLAG_VALUE",
    );
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = args;
  switch (command) {
    case "--help":
    case "-h":
    case "help":
      console.log(helpText.trimEnd());
      return;
    case "status":
      await runMigrationStatus({ preparedConfigPath: valueAfter(rest, "--config") });
      return;
    case "apply":
      await runMigrationApply({
        preparedConfigPath: valueAfter(rest, "--config"),
        dryRun: rest.includes("--dry-run"),
      });
      return;
    case "backup": {
      requireBackupVersion(rest);
      const result = createMigrationBackup();
      console.log(
        JSON.stringify({
          action: "create",
          for: MIGRATION_BACKUP_VERSION,
          path: result.path,
          created: result.created,
          manifest: result.manifest,
        }),
      );
      return;
    }
    case "restore": {
      requireBackupVersion(rest);
      const result = restoreMigrationBackup(rest.includes("--confirm"), valueAfter(rest, "--run"));
      console.log(
        JSON.stringify({
          action: "restore",
          for: MIGRATION_BACKUP_VERSION,
          path: result.path,
          restored: true,
          rescuePath: result.rescuePath,
          manifest: result.manifest,
        }),
      );
      return;
    }
    case "storage": {
      const { main: runStorageMigration } = await import("./migrate-storage");
      await runStorageMigration(rest);
      return;
    }
    default:
      throw new UsageError("Choose `status`, `apply`, `backup`, `restore`, or `storage`.", "MISSING_REQUIRED_ARGUMENT");
  }
}

if (import.meta.main) await runWithJsonErrors(() => main());
