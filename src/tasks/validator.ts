// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Task-v3 runnability validation.
 *
 * Parsing owns the source grammar. This module deliberately delegates runtime
 * validation to the same pure projector used by `task run`, so add/sync and
 * unattended execution cannot drift onto different resolution, authorization,
 * or lowering paths. The returned projection is an immutable snapshot and the
 * caller must finish validating its whole desired set before mutating source,
 * descriptors, or scheduler state.
 */

import { type PreparedTaskV3Execution, type PrepareTaskV3ExecutionContext, prepareTaskV3Execution } from "./runtime-v3";
import { parseSchedule, type ScheduleBackend } from "./schedule";
import type { TaskV3SourceDocument } from "./source-v3";

export interface ValidateTaskV3Options extends PrepareTaskV3ExecutionContext {
  /** Which backend every authored schedule must translate to. */
  readonly backend: ScheduleBackend;
}

/** Validate and freeze one task-v3 document without durable mutation. */
export async function validateTaskV3Document(
  task: TaskV3SourceDocument,
  options: ValidateTaskV3Options,
): Promise<PreparedTaskV3Execution> {
  for (const schedule of task.triggers.schedules) parseSchedule(schedule.cron, options.backend);
  return prepareTaskV3Execution(task, options);
}
