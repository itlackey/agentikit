// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Output shape registration for `akm log` (#204).
//
// R-060: renamed from `events-list` (the command group used to be `akm
// events`) to `log-list`, matching the current `akm log` command name
// (src/commands/observability-cli.ts). This string is an internal registry
// key only — `shapeEventsOutput` builds its own envelope and never stamps a
// `shape` field on the wire, so the rename does not require a schemaVersion
// bump.
//
// 0.9.0 CLI overhaul (S3): `log tail` (and its `log-tail` shape entry) was
// dropped along with the command.

import { shapeEventsOutput } from "./helpers";
import type { OutputShapeEntry } from "./registry";

const handler = (result: unknown, detail: Parameters<typeof shapeEventsOutput>[1]) =>
  shapeEventsOutput(result as Record<string, unknown>, detail);

export const eventsShapes: OutputShapeEntry[] = [{ command: "log-list", handler }];
