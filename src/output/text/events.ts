// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Output text formatter for `akm log` (#204).
//
// R-060: renamed from `events-list` to `log-list` — see
// src/output/shapes/events.ts for the full rationale.
//
// 0.9.0 CLI overhaul (S3): `log tail` (and its `log-tail` formatter entry)
// was dropped along with the command.

import { formatEventsPlain } from "./helpers";
import type { TextFormatterEntry } from "./registry";

export const eventsFormatters: TextFormatterEntry[] = [{ command: "log-list", handler: (r) => formatEventsPlain(r) }];
