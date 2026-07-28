// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Output text formatters for `akm log list` / `akm log tail` (#204).
// Both share a renderer; `log tail` is also called per-event by the streaming
// code path via `formatEventLine`.
//
// R-060: renamed from `events-list`/`events-tail` to `log-list`/`log-tail` —
// see src/output/shapes/events.ts for the full rationale.

import { formatEventsPlain } from "./helpers";
import type { TextFormatterEntry } from "./registry";

export const eventsFormatters: TextFormatterEntry[] = [
  { command: "log-list", handler: (r) => formatEventsPlain(r) },
  { command: "log-tail", handler: (r) => formatEventsPlain(r) },
];
