// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A child workflow run's idempotency key (spec
 * docs/plans/specs/p3a-plan-v5-child-freeze.md §3.4, rows A-17…A-19). Pure:
 * no IO, no config, no clock, no randomness — imports exactly node:crypto
 * and canonicalJson.
 *
 * P3a has no production caller: P3b's child executor derives this key from
 * the parent unit's `hashVersion` 6 input hash and passes it to
 * `publishChildWorkflowRun` (src/storage/repositories/workflow-runs-repository.ts,
 * Lane C) as the `(parent_run_id, invocation_key)` idempotency pair.
 */

import { createHash } from "node:crypto";
import { canonicalJson } from "../ir/plan-hash";

export interface ChildInvocationKeyInput {
  readonly parentRunId: string;
  /**
   * The parent run's unit that spawns the child. Stored as
   * `workflow_runs.parent_unit_id`; the TS repository API deliberately
   * spells this `spawnedByUnitId` instead (A-N12) so it cannot be confused
   * with `workflow_run_units.parent_unit_id` (map fan-out template
   * parentage, migration 004) — this field name matches the hash preimage,
   * a wire format, not that API.
   */
  readonly parentUnitId: string;
  /** The `hashVersion` 6 unit input hash of the parent unit that spawns the child. */
  readonly unitInputHash: string;
}

/**
 * `sha256hex("akm.workflow.child-invocation\0v1\0" + canonicalJson({parentRunId, parentUnitId, unitInputHash}))`.
 *
 * The `\0v1\0` here is this helper's OWN vocabulary version, deliberately
 * independent of `hashVersion`: `unitInputHash` enters this preimage as an
 * opaque value, so this key's preimage does not change when the unit-hash
 * vocabulary itself bumps.
 */
export function computeChildInvocationKey(input: ChildInvocationKeyInput): string {
  return createHash("sha256")
    .update("akm.workflow.child-invocation\0v1\0")
    .update(
      canonicalJson({
        parentRunId: input.parentRunId,
        parentUnitId: input.parentUnitId,
        unitInputHash: input.unitInputHash,
      }),
    )
    .digest("hex");
}
