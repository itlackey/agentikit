// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * TaskScheduleBinding — one resolved schedule entry on a `TaskDefinition`
 * (spec docs/plans/specs/p1b-model-extraction.md §1.1 D4, §3.3).
 *
 * This is a NEW, additive type distinct from `TaskV3ScheduleBinding`
 * (`src/tasks/source-v3.ts`), which carries v3's own `{cron, source,
 * ordinal}` provenance shape for the *authoring* grammar. This model type is
 * the resolved `{cron, enabled}` pair the task-model layer works with —
 * `enabled` broadcasts the v3 document's single `akm.enabled` flag onto every
 * schedule entry (v3 has no per-entry enabled concept); `source`/`ordinal`
 * are dropped. Do not merge the two types and do not rename the v3 one here
 * (spec §3.3).
 *
 * Pure type module: no runtime export, no fs/db/subprocess imports (spec
 * §3.2 purity ratchet).
 */

export interface TaskScheduleBinding {
  readonly cron: string;
  readonly enabled: boolean;
}
