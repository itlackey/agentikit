// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Setup-derived recommendations (`setup`). Extracted verbatim from the former
 * `config-schema.ts` monolith — no behavior change.
 */
import { z } from "zod";

// ── Setup-derived recommendations ──────────────────────────────────────────
//
// R-063 #11: this object previously carried a `taskSchedules` sub-key (cron
// hints nominally derived by `akm setup --reset-recommended`), but nothing in
// the tasks subsystem or setup flow ever read or wrote it — confirmed dead at
// HEAD (deriveRecommendedConfig's return type never included it either; see
// tests/integration/setup/detect-environment.test.ts's regression guard).
// Removed. The `setup` namespace itself is kept (passthrough) for future
// setup-derived config.
export const SetupConfigSchema = z.object({}).passthrough();
