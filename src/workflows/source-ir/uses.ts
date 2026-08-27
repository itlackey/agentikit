// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The workflow `uses:` classification seam (P1a Lane B,
 * docs/plans/specs/p1a-with-rejection-classifier.md §4.2).
 *
 * `classifyWorkflowSourceUses` is the canonical non-task `uses:` classifier
 * used by direct source-IR decoding (and, via `compile.ts`, by the GitHub-YAML
 * entrypoint): it recognizes the `akm/command` builtin special case and
 * otherwise delegates to `classifyTargetRef` (src/execution/target-ref.ts),
 * the canonical classifier for `commands/`, `scripts/`, `tasks/`, and
 * `workflows/` asset refs — including `tasks/...` targets, for which
 * `classifyTargetRef`'s own `tasks/` arm is the one authority (brief §8.1;
 * P4 deleted `classifyWorkflowStepUses`'s `canonicalTaskTarget` pre-check in
 * semantics.ts, which used to match them first).
 *
 * This module imports NOTHING from `src/tasks/source-v3.ts`: workflow `uses:`
 * classification no longer delegates to the task-v3 grammar, and (P4) native
 * target classification recognizes no GitHub Action variant at all —
 * `WorkflowSourceUsesTarget` below has no `github-action` member, typed or
 * otherwise.
 */

import { classifyTargetRef } from "../../execution/target-ref";

export type WorkflowSourceUsesTarget =
  | { readonly kind: "command" | "script" | "task" | "workflow"; readonly ref: string }
  | { readonly kind: "builtin-command"; readonly ref: "akm/command" };
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

/**
 * Canonical non-task classifier used by direct source-IR decoding (and the
 * GitHub-YAML entrypoint's default, wired via compile.ts). Layers the
 * `akm/command` builtin special case over `classifyTargetRef`, which throws
 * `UsageError` `TARGET_REF_INVALID` for anything else.
 */
export function classifyWorkflowSourceUses(value: string): WorkflowSourceUsesTarget {
  if (value === "akm/command") {
    return Object.freeze({ kind: "builtin-command" as const, ref: "akm/command" as const });
  }
  // classifyTargetRef's return type is structurally identical to this
  // module's `{ kind: "command" | "script" | "task" | "workflow"; ref:
  // string }` union arm, so it is assignable to WorkflowSourceUsesTarget
  // without a cast.
  return classifyTargetRef(value);
}
