// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Output shape registration for `akm log list` and `akm log tail` (#204).
// Both share the same envelope; the renderer in text.ts uses distinct command
// names so it can format streaming differently.
//
// R-060: renamed from `events-list`/`events-tail` (the command group used to
// be `akm events`) to `log-list`/`log-tail`, matching the current `akm log`
// command name (src/commands/observability-cli.ts). These strings are
// internal registry keys only — `shapeEventsOutput` builds its own envelope
// and never stamps a `shape` field on the wire, so this rename does not
// require a schemaVersion bump. The `[events-tail]` stderr trailer text is a
// SEPARATE, still-documented (docs/reference/cli.md:1421) surface and is left
// as-is — see observability-cli.ts.

import { shapeEventsOutput } from "./helpers";
import type { OutputShapeEntry } from "./registry";

const handler = (result: unknown, detail: Parameters<typeof shapeEventsOutput>[1]) =>
  shapeEventsOutput(result as Record<string, unknown>, detail);

export const eventsShapes: OutputShapeEntry[] = [
  { command: "log-list", handler },
  { command: "log-tail", handler },
];
