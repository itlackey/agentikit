// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { decodeWorkflowPlanStructure, type WorkflowPlanStructure, type WorkflowPlanValidationHooks } from "./schema";

/** The sole retained compatibility boundary: plans already persisted as v3. */
export const STORED_WORKFLOW_PLAN_V3_VERSION = 3 as const;
/** Historical wire name retained only inside this storage compatibility module. */
export const WORKFLOW_IR_VERSION = STORED_WORKFLOW_PLAN_V3_VERSION;

export interface StoredWorkflowPlanV3 extends Omit<WorkflowPlanStructure, "irVersion"> {
  readonly irVersion: typeof STORED_WORKFLOW_PLAN_V3_VERSION;
}

/** Historical type name for tests and storage replay code. */
export type WorkflowPlanGraph = StoredWorkflowPlanV3;

export function decodeStoredWorkflowPlanV3(
  input: unknown,
  hooks: WorkflowPlanValidationHooks = {},
): StoredWorkflowPlanV3 {
  return decodeWorkflowPlanStructure(
    input,
    { expectedVersion: STORED_WORKFLOW_PLAN_V3_VERSION },
    hooks,
  ) as StoredWorkflowPlanV3;
}

/** Historical decoder name, scoped to this compatibility module. */
export const decodeWorkflowPlanV3 = decodeStoredWorkflowPlanV3;

export * from "./schema";
