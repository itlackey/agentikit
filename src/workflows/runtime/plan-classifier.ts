// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { UsageError } from "../../core/errors";
import type { WorkflowRunRow, WorkflowRunStepRow } from "../../storage/repositories/workflow-runs-repository";
import { decodeCanonicalPlan } from "../ir/plan-hash";
import type { IrRouteSpec } from "../ir/schema";
import { type ExecutableWorkflowPlan, WORKFLOW_IR_V4_VERSION } from "../ir/schema-v4";
import { WORKFLOW_IR_VERSION } from "../ir/stored-plan-v3";

export type WorkflowExecutionSupport = "supported" | "unsupported-version" | "missing-plan" | "corrupt-plan";

export type ClassifiedWorkflowPlan =
  | {
      support: "supported";
      plan: ExecutableWorkflowPlan;
      irVersion: typeof WORKFLOW_IR_VERSION | typeof WORKFLOW_IR_V4_VERSION;
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
    row.plan_ir_version !== WORKFLOW_IR_VERSION &&
    row.plan_ir_version !== WORKFLOW_IR_V4_VERSION
  ) {
    return {
      support: "unsupported-version",
      irVersion: row.plan_ir_version,
      error: `Workflow run ${runId} uses unsupported workflow IR version ${row.plan_ir_version}; this runtime supports versions ${WORKFLOW_IR_VERSION} and ${WORKFLOW_IR_V4_VERSION}.`,
    };
  }
  if (row.plan_ir_version !== WORKFLOW_IR_VERSION && row.plan_ir_version !== WORKFLOW_IR_V4_VERSION) {
    return {
      support: "corrupt-plan",
      irVersion: null,
      error: `Workflow run ${runId} does not declare a supported workflow IR version.`,
    };
  }
  try {
    return {
      support: "supported",
      irVersion: row.plan_ir_version,
      plan: decodeCanonicalPlan(runId, row.plan_json, row.plan_hash, row.plan_ir_version),
    };
  } catch (cause) {
    return {
      support: "corrupt-plan",
      irVersion: row.plan_ir_version,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/** Reject any operation that requires a valid current frozen plan. */
export function requireExecutableWorkflowPlan(
  row: Parameters<typeof classifyWorkflowRunPlan>[0],
): ExecutableWorkflowPlan {
  const classified = classifyWorkflowRunPlan(row);
  if (classified.support === "supported") return classified.plan;
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
export function frozenStepRows(plan: ExecutableWorkflowPlan): FrozenStepRowDefinition[] {
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

/** Verify the durable spine still agrees with the decoded/hash-verified plan before any mutation. */
export function assertWorkflowSpineMatchesPlan(
  plan: ExecutableWorkflowPlan,
  run: WorkflowRunRow,
  rows: WorkflowRunStepRow[],
): void {
  const expected = frozenStepRows(plan);
  if (rows.length !== expected.length) corruptSpine(run.id, "step count differs from the frozen plan");
  for (let index = 0; index < expected.length; index++) {
    const actual = rows[index];
    const planned = expected[index];
    // The length check above (corruptSpine returns `never`) guarantees both are
    // present; the guard narrows them and preserves the "missing row" message.
    if (!actual || !planned) {
      corruptSpine(run.id, `step row ${index} differs from the frozen plan (missing row)`);
    }
    if (
      actual.step_id !== planned.stepId ||
      actual.step_title !== planned.stepTitle ||
      actual.instructions !== planned.instructions ||
      actual.completion_json !== planned.completionJson ||
      actual.sequence_index !== planned.sequenceIndex
    ) {
      const fields = [
        actual.step_id !== planned.stepId ? "step_id" : "",
        actual.step_title !== planned.stepTitle ? "step_title" : "",
        actual.instructions !== planned.instructions ? "instructions" : "",
        actual.completion_json !== planned.completionJson ? "completion_json" : "",
        actual.sequence_index !== planned.sequenceIndex ? "sequence_index" : "",
      ].filter(Boolean);
      corruptSpine(run.id, `step row ${index} differs from the frozen plan (${fields.join(", ")})`);
    }
  }
  if (run.current_step_id !== null && !expected.some((step) => step.stepId === run.current_step_id))
    corruptSpine(run.id, `current step ${run.current_step_id} is not in the frozen plan`);

  const current = run.current_step_id ? rows.find((row) => row.step_id === run.current_step_id) : undefined;
  if (run.status === "active") {
    const firstPending = rows.find((row) => row.status === "pending");
    if (!current || current.status !== "pending" || firstPending?.step_id !== current.step_id)
      corruptSpine(run.id, "active status/current step does not match the first pending plan step");
  } else if (run.status === "blocked") {
    if (!current || current.status !== "blocked")
      corruptSpine(run.id, `${run.status} status does not match the current plan step`);
  } else if (run.status === "failed") {
    // `workflow abandon` marks the run failed while intentionally leaving its
    // current step pending so `resume` can reopen the same work.
    if (!current || (current.status !== "failed" && current.status !== "pending"))
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
