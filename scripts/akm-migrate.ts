#!/usr/bin/env bun

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { pathToFileURL } from "node:url";
import { EXIT_CODES, runWithJsonErrors } from "../src/cli/shared";
import { UsageError } from "../src/core/errors";
import helpText from "./akm-migrate/help.txt" with { type: "text" };
import { type CombinedMigrationPlan, runMigration } from "./akm-migrate/run-migrate";

function printPlan(plan: CombinedMigrationPlan): void {
  console.log(JSON.stringify(plan));
  if (plan.status === "blocked") process.exitCode = EXIT_CODES.GENERAL;
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
      if (rest.length > 0) throw new UsageError("`status` accepts no options.", "INVALID_FLAG_VALUE");
      printPlan(await runMigration({ apply: false }));
      return;
    case "apply": {
      const unknown = rest.find((arg) => arg !== "--dry-run");
      if (unknown !== undefined) throw new UsageError(`\`apply\` does not accept ${unknown}.`, "INVALID_FLAG_VALUE");
      printPlan(await runMigration({ apply: !rest.includes("--dry-run") }));
      return;
    }
    default:
      throw new UsageError("Choose `status` or `apply [--dry-run]`.", "MISSING_REQUIRED_ARGUMENT");
  }
}

const isMain =
  (import.meta as ImportMeta & { main?: boolean }).main === true ||
  (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url);
if (isMain) await runWithJsonErrors(() => main());
