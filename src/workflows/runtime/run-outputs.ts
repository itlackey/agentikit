// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Declared-output resolution and the exported result (P3b, spec
 * docs/plans/specs/p3b-child-executor.md §4.3, §4.4).
 *
 * Pure; no IO. `resolveWorkflowRunOutputs` reads PERSISTED step rows (never
 * live in-memory evidence — `completeWorkflowStep` sees only the current
 * step's; a resumed run has nothing else to rebuild the scope from, B-N12)
 * and fails loudly, by name, when a declared output's source artifact was
 * replaced by a truncation envelope at persistence.
 *
 * This module must stay IMPORT-CYCLE-FREE with `./runs.ts` (which imports
 * it): `WORKFLOW_EVIDENCE_TRUNCATED_MARKER`'s value is therefore reproduced
 * locally rather than imported — the same "reproduce across a boundary
 * rather than import" idiom `ir/schema-v4.ts` already uses for
 * `CHILD_WORKFLOW_DECODE_MAX_DEPTH`.
 */

import { validateJsonSchemaSubset } from "../../core/json-schema";
import type { WorkflowRunRow, WorkflowRunStepRow } from "../../storage/repositories/workflow-runs-repository";
import type { WorkflowPlanGraphV4 } from "../ir/schema-v4";
import { type ExpressionScope, parseReference, resolveReferenceString } from "../program/expressions";

/** Mirrors `runs.ts`'s `WORKFLOW_EVIDENCE_TRUNCATED_MARKER` byte-for-byte — see this file's header for why it is reproduced, not imported. */
const EVIDENCE_TRUNCATED_MARKER = "__akm_evidence_truncated__";

function isTruncatedEvidenceValue(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)[EVIDENCE_TRUNCATED_MARKER] === true
  );
}

export type ResolveRunOutputsResult =
  | { readonly ok: true; readonly outputs: Record<string, unknown> }
  | { readonly ok: false; readonly errors: string[] };

/** Project a step artifact out of its persisted evidence — mirrors `exec/step-work.ts`'s `projectStepOutput`. */
function projectStepOutput(evidence: Record<string, unknown>): unknown {
  return Object.hasOwn(evidence, "output") ? evidence.output : evidence;
}

/**
 * Resolve a plan's declared `outputs:` from a run's PERSISTED step rows, in
 * declaration order (the frozen plan's `outputs` keys are already
 * sorted-unique, `ir/schema-v4.ts`'s `decodeWorkflowOutputs`). Every failure
 * mode is collected (not stopped-at-first) so a completion failure names
 * every offending output at once.
 */
export function resolveWorkflowRunOutputs(
  plan: WorkflowPlanGraphV4,
  steps: readonly WorkflowRunStepRow[],
): ResolveRunOutputsResult {
  const stepOutputs: Record<string, unknown> = {};
  for (const row of steps) {
    if (!row.evidence_json) continue;
    let evidence: Record<string, unknown>;
    try {
      evidence = JSON.parse(row.evidence_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    stepOutputs[row.step_id] = projectStepOutput(evidence);
  }
  const scope: ExpressionScope = { params: {}, stepOutputs };

  const errors: string[] = [];
  const outputs: Record<string, unknown> = {};
  for (const [name, declaration] of Object.entries(plan.outputs ?? {})) {
    const parsed = parseReference(declaration.from);
    if (!parsed.ok || parsed.expr.kind !== "stepOutput") {
      errors.push(`output "${name}": "${declaration.from}" is not a valid step-output reference.`);
      continue;
    }
    const rootValue = Object.hasOwn(stepOutputs, parsed.expr.stepId) ? stepOutputs[parsed.expr.stepId] : undefined;
    if (isTruncatedEvidenceValue(rootValue)) {
      errors.push(
        `output "${name}" reads step "${parsed.expr.stepId}"'s artifact, which was truncated — it exceeded the ` +
          `evidence persistence cap and was not stored.`,
      );
      continue;
    }
    const resolved = resolveReferenceString(declaration.from, scope);
    if (!resolved.ok) {
      errors.push(`output "${name}": ${resolved.error.message}`);
      continue;
    }
    if (isTruncatedEvidenceValue(resolved.value)) {
      errors.push(
        `output "${name}" reads step "${parsed.expr.stepId}"'s artifact, which was truncated — it exceeded the ` +
          `evidence persistence cap and was not stored.`,
      );
      continue;
    }
    if (declaration.schema) {
      const schemaErrors = validateJsonSchemaSubset(resolved.value, declaration.schema);
      if (schemaErrors.length > 0) {
        for (const schemaError of schemaErrors) errors.push(`output "${name}": ${schemaError}`);
        continue;
      }
    }
    outputs[name] = resolved.value;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, outputs };
}

/**
 * What a completed run EXPORTS: the resolved declared outputs, or
 * `{runId, status}` metadata when the plan declared none. The `{runId,
 * status}` form is synthesized on read and never stored (row B-25).
 */
export function workflowRunExportedResult(row: WorkflowRunRow): Record<string, unknown> {
  if (row.outputs_json) {
    return JSON.parse(row.outputs_json) as Record<string, unknown>;
  }
  return { runId: row.id, status: row.status };
}
