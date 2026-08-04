// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { formatHealthPlain } from "./helpers";
import type { TextFormatterEntry } from "./registry";

export const healthFormatters: TextFormatterEntry[] = [
  { command: "health", handler: (r, detail) => formatHealthPlain(r, detail) },
];
