// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Workflow source adapters deliberately do not own an executable-ref grammar.
 * `tasks/...` is the one workflow-only target and is recognized by
 * `classifyWorkflowStepUses`; every remaining target delegates here to WP6's
 * canonical task-v3 classifier.
 */

import { classifyTaskV3Uses, type TaskV3UsesTarget } from "../../tasks/source-v3";

export type WorkflowSourceUsesTarget = TaskV3UsesTarget | { kind: "task"; ref: string };
export type WorkflowSourceUsesClassifier = (value: string) => WorkflowSourceUsesTarget;

export interface WorkflowSourceScheduleBinding {
  readonly cron: string;
  readonly source: string;
  readonly ordinal: number;
}

export interface WorkflowSourceTriggerPlan {
  readonly manual: boolean;
  readonly schedules: readonly WorkflowSourceScheduleBinding[];
}

export interface WorkflowSourceTriggerClassifierOptions {
  readonly filePath: string;
  readonly lineAt?: (path: readonly (string | number)[]) => number | undefined;
}

export type WorkflowSourceTriggerClassifier = (
  value: unknown,
  options: WorkflowSourceTriggerClassifierOptions,
) => WorkflowSourceTriggerPlan;

/** Canonical non-task classifier used by direct source-IR decoding. */
export function classifyWorkflowSourceUses(value: string): TaskV3UsesTarget {
  return classifyTaskV3Uses(value);
}
