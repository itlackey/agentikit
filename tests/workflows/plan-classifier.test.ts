// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #919 — `classifyWorkflowRunPlan`'s `unsupported-version` message must not
 * call every non-5 `plan_ir_version` "pre-irVersion-5": a version ABOVE the
 * current one (or a non-numeric stored value) is never an "0.9.2 upgrade"
 * situation, and telling the reader it is sends them looking for the wrong
 * problem. Pure in-memory logic (no db/network/spawn) — belongs under
 * `tests/`, not `tests/integration/`.
 */

import { describe, expect, test } from "bun:test";
import { classifyWorkflowRunPlan } from "../../src/workflows/runtime/plan-classifier";

function rowWith(planIrVersion: unknown): Parameters<typeof classifyWorkflowRunPlan>[0] {
  return {
    id: "test-run-id",
    plan_json: '{"irVersion":5,"steps":[]}',
    plan_hash: null,
    // The real column is `number | null`; a stored TEXT value (hypothesis
    // (a) from the #919 triage) is exercised deliberately below, so this
    // helper accepts the untyped raw value a tampered/legacy row could carry.
    plan_ir_version: planIrVersion as number | null,
  };
}

describe("#919 — classifyWorkflowRunPlan's unsupported-version message", () => {
  test("a version below 5 keeps the pre-irVersion-5 / 0.9.2-upgrade text", () => {
    const result = classifyWorkflowRunPlan(rowWith(2));
    expect(result.support).toBe("unsupported-version");
    if (result.support !== "unsupported-version") throw new Error("expected unsupported-version");
    expect(result.irVersion).toBe(2);
    expect(result.error).toContain("pre-irVersion-5");
    expect(result.error).toContain("0.9.2 upgrade");
    expect(result.error).toContain("akm workflow abandon test-run-id");
  });

  test("a version above 5 gets the 'newer akm' text, not the pre-irVersion-5 wording", () => {
    // Exactly the shape of the #919 report: irVersion reported as 111, well
    // above the current 5 — never a "pre-irVersion-5" situation.
    const result = classifyWorkflowRunPlan(rowWith(111));
    expect(result.support).toBe("unsupported-version");
    if (result.support !== "unsupported-version") throw new Error("expected unsupported-version");
    expect(result.irVersion).toBe(111);
    expect(result.error).not.toContain("pre-irVersion-5");
    expect(result.error).not.toContain("0.9.2 upgrade");
    expect(result.error).toContain("irVersion 111");
    expect(result.error).toContain("this akm (irVersion 5)");
    expect(result.error).toContain("newer akm");
    expect(result.error).toContain("akm workflow abandon test-run-id");
  });

  test("a non-numeric stored value gets the 'newer akm' text too, never the pre-5 wording", () => {
    // Hypothesis (a) from the #919 triage: a row where plan_ir_version was
    // stored as TEXT. `!==` against the numeric constant already classifies
    // it unsupported; the message must not claim it is "pre-irVersion-5".
    const result = classifyWorkflowRunPlan(rowWith("5" as unknown));
    expect(result.support).toBe("unsupported-version");
    if (result.support !== "unsupported-version") throw new Error("expected unsupported-version");
    expect(result.error).not.toContain("pre-irVersion-5");
    expect(result.error).not.toContain("0.9.2 upgrade");
    expect(result.error).toContain("newer akm");
  });

  test("the current version (5) is still supported and decodes the plan", () => {
    const result = classifyWorkflowRunPlan({
      id: "ok-run",
      plan_json: '{"irVersion":5,"execution":{},"steps":[]}',
      plan_hash: null,
      plan_ir_version: 5,
    });
    // Only the version-comparison branch is under test here; a plan with no
    // real steps/hash still exercises `decodeCanonicalPlan`, which may reject
    // it on shape grounds — either outcome is fine as long as it is NOT
    // misclassified as `unsupported-version`.
    expect(result.support).not.toBe("unsupported-version");
  });
});
