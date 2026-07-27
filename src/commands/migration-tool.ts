// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { NotFoundError } from "../core/errors";

function migrationEntryPoint(): string {
  const candidates = [
    fileURLToPath(new URL("../../scripts/akm-migrate.ts", import.meta.url)),
    fileURLToPath(new URL("../scripts/akm-migrate.js", import.meta.url)),
  ];
  const entry = candidates.find((candidate) => fs.existsSync(candidate));
  if (!entry) throw new NotFoundError("The standalone akm-migrate tool is not installed.", "FILE_NOT_FOUND");
  return entry;
}

export function runMigrationTool(args: readonly string[]): void {
  const runtime = process.versions.bun ? process.execPath : "bun";
  const result = spawnSync(runtime, [migrationEntryPoint(), ...args], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw new NotFoundError(
      `Cannot start the standalone akm-migrate tool: ${result.error.message}`,
      "FILE_NOT_FOUND",
      "Install Bun, then run akm-migrate directly.",
    );
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  // R-067: was `process.exit(result.status ?? 1)` on the failure branch,
  // which terminates the process synchronously and skips the `finally {
  // await disposeDispatchResources(); }` cleanup in src/cli.ts's
  // `runCommand`. The success path (status === 0) was already fine — it
  // just returns and the process exits 0 naturally. Setting
  // `process.exitCode` and returning still propagates the child's exact
  // non-zero status once the event loop drains, but lets cleanup run first —
  // same pattern `emitJsonError` (src/cli/shared.ts) already established.
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return;
  }
}
