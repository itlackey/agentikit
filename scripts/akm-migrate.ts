#!/usr/bin/env bun

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { pathToFileURL } from "node:url";
import { runWithJsonErrors } from "../src/cli/shared";
import { main } from "./akm-migrate/main";

export { main };

const isMain =
  (import.meta as ImportMeta & { main?: boolean }).main === true ||
  (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url);
if (isMain) await runWithJsonErrors(() => main());
