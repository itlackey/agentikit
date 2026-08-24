// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Plan hashing for the frozen-plan contract (redesign addendum, R1).
 *
 * `workflow run` persists `plan_json` + `plan_hash` on the run row
 * (migration 006); every later invocation executes that snapshot. The hash is
 * the sha256 (hex) of the plan's CANONICAL JSON — object keys recursively
 * sorted — so two structurally-equal plans hash identically regardless of key
 * insertion order, and the same program always freezes to the same hash.
 *
 * Pure module: no IO beyond node:crypto, no engine imports.
 */

import { createHash } from "node:crypto";
import { utf8Bytes, WORKFLOW_MAX_JSON_DEPTH, WORKFLOW_MAX_PLAN_BYTES } from "../resource-limits";
import { decodeWorkflowPlanV4, WORKFLOW_IR_V4_VERSION, type WorkflowPlanGraphV4 } from "./schema-v4";

/** sha256 hex of the canonical (recursively sorted-keys) JSON of the plan. */
export function computePlanHash(plan: WorkflowPlanGraphV4 | unknown): string {
  return createHash("sha256").update(canonicalPlanJson(plan)).digest("hex");
}

/** The canonical JSON string the hash is computed over (also what to persist). */
export function canonicalPlanJson(plan: WorkflowPlanGraphV4 | unknown): string {
  return canonicalJson(plan);
}

/** Canonical JSON used by every plan and input hash. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** Decode, require stored canonical bytes, then verify the stored SHA-256. */
export function decodeCanonicalPlan(
  runId: string,
  planJson: string,
  planHash: string | null,
  expectedVersion?: number | null,
): WorkflowPlanGraphV4 {
  if (utf8Bytes(planJson) > WORKFLOW_MAX_PLAN_BYTES)
    throw new Error(`Workflow run ${runId} frozen plan exceeds the 2 MiB resource limit.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(planJson);
  } catch {
    throw new Error(`Workflow run ${runId} has corrupt frozen plan JSON.`);
  }
  const canonicalWire = canonicalJson(parsed);
  if (planJson !== canonicalWire) throw new Error(`Workflow run ${runId} has noncanonical frozen plan JSON.`);
  const actual = createHash("sha256").update(planJson).digest("hex");
  if (!planHash || !/^[0-9a-f]{64}$/.test(planHash) || actual !== planHash)
    throw new Error(`Workflow run ${runId} frozen plan integrity check failed.`);
  if (expectedVersion !== undefined && expectedVersion !== null && expectedVersion !== WORKFLOW_IR_V4_VERSION) {
    throw new Error(
      `Workflow run ${runId} uses unsupported workflow IR version ${expectedVersion}; this runtime supports only workflow IR version 4.`,
    );
  }
  const plan = decodeWorkflowPlanV4(parsed);
  const canonical = canonicalPlanJson(plan);
  if (planJson !== canonical) throw new Error(`Workflow run ${runId} has noncanonical frozen plan JSON.`);
  return plan;
}

function sortKeys(value: unknown, depth = 0): unknown {
  if (depth > WORKFLOW_MAX_JSON_DEPTH) throw new TypeError("JSON value exceeds maximum depth");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JSON values must be finite");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => sortKeys(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v, depth + 1)]),
    );
  }
  throw new TypeError("JSON value contains a non-JSON value");
}
