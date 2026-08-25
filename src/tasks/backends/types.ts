// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Leaf types for the OS-native scheduler backend contract (see
 * `tasks/backends/index.ts`).
 *
 * Split out of `index.ts` so that `cron.ts`/`launchd.ts`/`schtasks.ts` (which
 * `index.ts` imports by value to build the platform-selection barrel) do not
 * need a type-only import back into `index.ts` — that back-edge is a
 * static-graph cycle even though it is type-only (chunk 9 WI-9.8 KILL 7
 * sever). Backend consumers import these shared types directly.
 */

export type {
  InstalledSchedulerBinding,
  RebindSchedulerBinding,
  SchedulerBackend,
  SchedulerInstallOptions,
} from "../scheduler-binding";
