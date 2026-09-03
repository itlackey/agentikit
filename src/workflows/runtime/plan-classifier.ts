// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { UsageError } from "../../core/errors";
import { warnOnce } from "../../core/warn";
import type { WorkflowRunRow, WorkflowRunStepRow } from "../../storage/repositories/workflow-runs-repository";
import { decodeCanonicalPlan } from "../ir/plan-hash";
import type { IrRouteSpec } from "../ir/schema";
import { WORKFLOW_IR_V5_VERSION, type WorkflowPlanGraphV4 } from "../ir/schema-v4";

export type ClassifiedWorkflowPlan =
  | {
      support: "supported";
      plan: WorkflowPlanGraphV4;
      irVersion: typeof WORKFLOW_IR_V5_VERSION;
    }
  | { support: "unsupported-version"; irVersion: number; error: string }
  | { support: "missing-plan"; irVersion: number | null; error: string }
  | { support: "corrupt-plan"; irVersion: number | null; error: string };

/** Validate that a live run carries exactly the current frozen-plan format. */
export function classifyWorkflowRunPlan(row: {
  plan_json: string | null;
  plan_hash: string | null;
  plan_ir_version?: number | null;
  id?: string;
}): ClassifiedWorkflowPlan {
  const runId = row.id ?? "(unknown)";
  if (!row.plan_json) {
    return {
      support: "missing-plan",
      irVersion: row.plan_ir_version ?? null,
      error: `Workflow run ${runId} has no frozen workflow plan.`,
    };
  }
  if (
    row.plan_ir_version !== null &&
    row.plan_ir_version !== undefined &&
    row.plan_ir_version !== WORKFLOW_IR_V5_VERSION
  ) {
    return {
      support: "unsupported-version",
      irVersion: row.plan_ir_version,
      // §3.2's exact complete-or-abandon policy string (A-N2): pre-irVersion-5
      // plans keep status/list/abandon working but can no longer execute. A
      // version ABOVE the current one (#919) is a distinct situation — never
      // an "upgrade" problem — so it gets its own text below rather than
      // being folded into the pre-5 wording.
      error:
        row.plan_ir_version < WORKFLOW_IR_V5_VERSION
          ? // Issue 8: leads with the remedy available to a user who has
            `Workflow run ${runId} was frozen as workflow plan irVersion ${row.plan_ir_version}; pre-irVersion-5 ` +
            `plans cannot execute after the 0.9.2 upgrade. Run 'akm workflow abandon ${runId}' and start a new ` +
            `run from the authored workflow to continue. 'akm workflow status' and 'akm workflow list' still ` +
            `work on this run.`
          : `Workflow run ${runId} was frozen with workflow plan irVersion ${row.plan_ir_version}, which this akm ` +
            `(irVersion ${WORKFLOW_IR_V5_VERSION}) does not understand; it was probably written by a newer akm. ` +
            `Complete it with that akm version, or run 'akm workflow abandon ${runId}' and start a new run from ` +
            `the authored workflow. 'akm workflow status' and 'akm workflow list' still work on this run.`,
    };
  }
  try {
    return {
      support: "supported",
      irVersion: WORKFLOW_IR_V5_VERSION,
      plan: decodeCanonicalPlan(runId, row.plan_json, row.plan_hash, row.plan_ir_version),
    };
  } catch (cause) {
    return {
      support: "corrupt-plan",
      irVersion: row.plan_ir_version ?? null,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/**
 * Reject any operation that requires a valid current frozen plan. A
 * non-current stored `plan_ir_version` (`unsupported-version`) fails closed
 * under `WORKFLOW_IR_VERSION_UNSUPPORTED` (A-N2) — distinct from the
 * `missing-plan` / `corrupt-plan` decode-corruption family, which keeps
 * `INVALID_JSON_ARGUMENT`.
 */
export function requireExecutableWorkflowPlan(row: Parameters<typeof classifyWorkflowRunPlan>[0]): WorkflowPlanGraphV4 {
  const classified = classifyWorkflowRunPlan(row);
  if (classified.support === "supported") return classified.plan;
  if (classified.support === "unsupported-version") {
    throw new UsageError(classified.error, "WORKFLOW_IR_VERSION_UNSUPPORTED");
  }
  throw new UsageError(classified.error, "INVALID_JSON_ARGUMENT");
}

export interface FrozenStepRowDefinition {
  stepId: string;
  stepTitle: string;
  instructions: string;
  completionJson: string | null;
  sequenceIndex: number;
}

/** Project persisted spine rows from the decoded plan, never from the mutable source asset. */
export function frozenStepRows(plan: WorkflowPlanGraphV4): FrozenStepRowDefinition[] {
  return plan.steps.map((step) => ({
    stepId: step.stepId,
    stepTitle: step.title,
    instructions: step.root
      ? step.root.kind === "map"
        ? step.root.template.instructions
        : step.root.instructions
      : routeInstructions(step.route as NonNullable<typeof step.route>),
    completionJson: step.gate.criteria.length > 0 ? JSON.stringify(step.gate.criteria) : null,
    sequenceIndex: step.sequenceIndex,
  }));
}

/**
 * Verify the durable spine's STEP IDENTITY still agrees with the
 * decoded/hash-verified plan: the same number of steps, and the same set of
 * step ids. A published plan's own step ids are fixed forever at freeze
 * time, so a mismatch here means the row set itself is wrong — genuine
 * corruption, not something a later akm release could have caused by
 * changing how a field is FORMATTED (that is
 * {@link reconcileWorkflowSpineWithPlan}'s concern, issue 7).
 */
function assertSpineIdentityMatchesPlan(
  runId: string,
  expected: readonly FrozenStepRowDefinition[],
  rows: readonly WorkflowRunStepRow[],
): void {
  if (rows.length !== expected.length) corruptSpine(runId, "step count differs from the frozen plan");
  const expectedIds = new Set(expected.map((step) => step.stepId));
  for (const row of rows) {
    if (!expectedIds.has(row.step_id)) corruptSpine(runId, `step "${row.step_id}" is not in the frozen plan`);
  }
}

/**
 * Reconcile the durable spine's PURE-DERIVATION fields (title, instructions,
 * completion criteria, sequence position) against the plan (issue 7).
 *
 * These are recomputed from the plan by {@link frozenStepRows} on every
 * read; a later akm release changing how one of them is FORMATTED from the
 * SAME plan data used to mark every in-flight run from the previous release
 * "corrupt" the moment anything (`akm workflow status`, `resume`, a step
 * completion) touched it. A mismatch here is warned about, once per run,
 * rather than blocking the caller — never step identity (row count, which
 * step ids exist), which stays a hard failure in
 * {@link assertSpineIdentityMatchesPlan} because the plan cannot have
 * produced a different step id for an already-frozen run.
 *
 * The durable row — not the plan — is what a driving agent actually acts
 * on: `getNextWorkflowStep` reads `instructions` straight off this row
 * (`toWorkflowRunStepState`/`projectNextResult` in `runtime/runs.ts`), and
 * `exec/run-workflow.ts`/`exec/step-work.ts` dispatch from that result. So
 * warning and proceeding with the STORED row (rather than rewriting it to
 * match the plan's current formatting) is the conservative choice: the
 * durable spine is the contract this run has been executing against since
 * freeze, and a newer akm formatting the same plan data differently should
 * not retroactively change an in-flight run's instructions out from under
 * it mid-execution. This module has no write path for that anyway
 * (`workflow_run_steps` is owned by
 * `storage/repositories/workflow-runs-repository.ts`) — and it should not
 * gain one for this purpose; see this change's `crossAreaNeeds`. Step
 * identity (row count, which step ids exist) is the part that would
 * actually desynchronize execution from the plan, which is exactly why
 * {@link assertSpineIdentityMatchesPlan} keeps that a hard failure.
 */
export function reconcileWorkflowSpineWithPlan(
  plan: WorkflowPlanGraphV4,
  run: WorkflowRunRow,
  rows: readonly WorkflowRunStepRow[],
): void {
  const expected = frozenStepRows(plan);
  assertSpineIdentityMatchesPlan(run.id, expected, rows);
  const expectedById = new Map(expected.map((step) => [step.stepId, step]));
  const drifted: string[] = [];
  for (const row of rows) {
    const planned = expectedById.get(row.step_id);
    if (!planned) continue; // unreachable after assertSpineIdentityMatchesPlan; kept defensive.
    if (
      row.step_title !== planned.stepTitle ||
      row.instructions !== planned.instructions ||
      row.completion_json !== planned.completionJson ||
      row.sequence_index !== planned.sequenceIndex
    ) {
      drifted.push(row.step_id);
    }
  }
  if (drifted.length > 0) {
    warnOnce(
      `workflow-spine-drift:${run.id}`,
      `Workflow run ${run.id}: durable step row(s) [${drifted.join(", ")}] no longer match the frozen plan's ` +
        "title/instructions/completion-criteria/sequence derivation (an akm upgrade likely changed how one of " +
        "these is formatted from the same plan data). Continuing with the stored row(s) as-is — this run keeps " +
        "executing against the instructions it was frozen with, rather than having them rewritten mid-flight.",
    );
  }
}

export function assertRunStatusMatchesSpine(run: WorkflowRunRow, rows: readonly WorkflowRunStepRow[]): void {
  const current = run.current_step_id ? rows.find((row) => row.step_id === run.current_step_id) : undefined;
  if (run.current_step_id !== null && !current)
    corruptSpine(run.id, `current step ${run.current_step_id} is not in the frozen plan`);
  if (run.status === "active") {
    const firstPending = rows.find((row) => row.status === "pending");
    if (!current || current.status !== "pending" || firstPending?.step_id !== current.step_id)
      corruptSpine(run.id, "active status/current step does not match the first pending plan step");
  } else if (run.status === "blocked") {
    if (!current || current.status !== "blocked")
      corruptSpine(run.id, `${run.status} status does not match the current plan step`);
  } else if (run.status === "failed") {
    // `workflow abandon` marks the run failed while intentionally leaving its
    // current step unchanged so `resume` can reopen the same work. An active
    // run leaves a pending step; a blocked run leaves a blocked step; and an
    // execution failure already carries a failed step. All three are honest
    // failed-run spines that `resumeWorkflowRun` normalizes back to pending.
    if (!current || (current.status !== "failed" && current.status !== "pending" && current.status !== "blocked"))
      corruptSpine(run.id, `${run.status} status does not match the current plan step`);
  } else if (run.status === "completed") {
    if (
      run.current_step_id !== null ||
      rows.some((row) => row.status === "pending" || row.status === "blocked" || row.status === "failed")
    )
      corruptSpine(run.id, "completed status disagrees with the plan spine");
  }
}

function routeInstructions(route: IrRouteSpec): string {
  const branches = Object.entries(route.when)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([match, stepId]) => `"${match}" -> ${stepId}`);
  if (route.defaultStepId !== undefined) branches.push(`default -> ${route.defaultStepId}`);
  return `Route on ${route.input}: ${branches.join(", ")}.`;
}

function corruptSpine(runId: string, detail: string): never {
  throw new UsageError(
    `Workflow run ${runId} has a corrupt durable step spine: ${detail}. Refusing to mutate state that disagrees with its frozen plan.`,
    "INVALID_JSON_ARGUMENT",
  );
}
