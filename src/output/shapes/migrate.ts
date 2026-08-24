// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm migrate status` / `akm migrate apply` output shape.
 *
 * The result is the task-only migrator's `MigrationPlan` JSON, parsed from the
 * packaging child by `src/commands/migrate-cli.ts`. Identity is deliberate:
 * status and dry-run report byte-identical plans for the same inputs.
 */
import type { OutputShapeEntry } from "./registry";

const identity: OutputShapeEntry["handler"] = (result) => result;

export const migrateShapes: OutputShapeEntry[] = [
  { command: "migrate-status", handler: identity },
  { command: "migrate-apply", handler: identity },
];
