// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm migrate status` / `akm migrate apply` output shape.
 *
 * The result is the standalone `akm-migrate` tool's `MigrationPlan` JSON,
 * parsed straight through from its child-process stdout
 * (`src/commands/migrate-cli.ts`). Identity — no field trimming and,
 * deliberately, no `shape`/`schemaVersion` stamp the way
 * `./passthrough.ts` adds for other identity commands: `migrate status` and
 * `migrate apply --dry-run` report byte-identical plans for the same
 * install, and integration tests assert that equality directly on the
 * parsed JSON — stamping only one of the two command names would break it.
 */
import type { OutputShapeEntry } from "./registry";

const identity: OutputShapeEntry["handler"] = (result) => result;

export const migrateShapes: OutputShapeEntry[] = [
  { command: "migrate-status", handler: identity },
  { command: "migrate-apply", handler: identity },
];
