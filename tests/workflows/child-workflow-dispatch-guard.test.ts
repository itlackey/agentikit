// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Code-review fix, P3a round 1, finding 1 (docs/plans/specs/p3a-plan-v5-child-freeze.md
 * Review log R8).
 *
 * P3a's freeze side (`src/workflows/freeze/targets/child-workflow.ts`)
 * legitimately produces a `kind: "child-workflow"` frozen target for a step
 * that composes another workflow — that is the whole point of Lane B.
 * `computeStepWorkList` (`src/workflows/exec/step-work.ts`) then builds an
 * ordinary work unit for that step like any other, and the two production
 * dispatch entry points — `defaultUnitDispatcher`
 * (`src/workflows/exec/native-executor.ts`) and the `unit-dispatch.ts`
 * `dispatchWorkflowExecution` it falls through to for every kind other than
 * "script"/"shell" — had no dedicated arm for it. Before this fix, such a
 * unit fell into `dispatchWorkflowExecution`'s generic `kind !== "command"`
 * guard, which threw a `ConfigError` reading "... is not a command target."
 * — false (a `child-workflow` target is a legitimate, freeze-validated
 * target kind) and unhelpful (it does not say child workflow execution
 * simply is not implemented yet, in this specific 0.9.2 increment).
 *
 * This pins the fix: both dispatch entry points fail closed on a
 * `child-workflow` target with a dedicated `UsageError`, code
 * `WORKFLOW_CHILD_EXECUTION_UNSUPPORTED`, naming the child ref and the P3b
 * timeline, instead of the generic ConfigError or an uncaught crash.
 *
 * No live agent/LLM/exec dispatch is needed to exercise this: the guard is a
 * synchronous check on `request.frozenTarget.kind` at the very top of
 * `dispatchWorkflowExecution`, before anything touches
 * `lowerResolvedExecutionRequestWithRunner` / `dispatchLoweredExecutionRequest`
 * — mirrors `tests/workflows/unit-dispatch-event-source.test.ts`'s existing
 * "no injectable runAgent/executeRunner/chat seam, so pin the fix at the
 * exact point the decision is made" approach for this same module.
 */

import { describe, expect, test } from "bun:test";
import { UsageError } from "../../src/core/errors";
import { defaultUnitDispatcher } from "../../src/workflows/exec/native-executor";
import { dispatchWorkflowExecution, type UnitDispatchRequest } from "../../src/workflows/exec/unit-dispatch";

/**
 * A structurally minimal `FrozenChildWorkflowTarget`. Both dispatch entry
 * points under test decide on `.kind` alone before touching any other
 * field, so `frozenPlan` stays an empty object cast through `unknown` rather
 * than a fully valid `WorkflowPlanGraphV4` — mirrors
 * `tests/workflows/hash-v6.test.ts`'s `asFrozenTarget` fixture, which
 * established the identical "cast through unknown for this one field, never
 * a real `@ts-expect-error`" convention for this exact target shape.
 */
function childWorkflowRequest(ref: string): UnitDispatchRequest {
  const frozenTarget = {
    kind: "child-workflow",
    ref,
    planHash: "a".repeat(64),
    frozenPlan: {},
    contentHash: "b".repeat(64),
    via: "direct",
  } as unknown as UnitDispatchRequest["frozenTarget"];
  return {
    runId: "run-1",
    stepId: "compose",
    unitId: "unit-compose-0",
    nodeId: "compose",
    prompt: "",
    frozenTarget,
    timeoutMs: null,
  };
}

async function captureThrow(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected fn() to throw, but it resolved");
}

describe("child-workflow dispatch fails closed (code-review fix, P3a round 1, finding 1)", () => {
  test('dispatchWorkflowExecution rejects a child-workflow target with a dedicated UsageError, not the generic "not a command target" ConfigError', async () => {
    const request = childWorkflowRequest("workflows/child");
    const caught = await captureThrow(() => dispatchWorkflowExecution(request));

    expect(caught).toBeInstanceOf(UsageError);
    const err = caught as UsageError;
    expect(err.code).toBe("WORKFLOW_CHILD_EXECUTION_UNSUPPORTED");
    expect(err.message).toContain("workflows/child");
    expect(err.message).toContain("unit-compose-0");
    expect(err.message).not.toContain("is not a command target");
  });

  test("defaultUnitDispatcher (the production dispatch seam) falls through to the same guard", async () => {
    const request = childWorkflowRequest("workflows/other-child");
    const caught = await captureThrow(() => defaultUnitDispatcher(request));

    expect(caught).toBeInstanceOf(UsageError);
    const err = caught as UsageError;
    expect(err.code).toBe("WORKFLOW_CHILD_EXECUTION_UNSUPPORTED");
    expect(err.message).toContain("workflows/other-child");
  });

  test("the thrown UsageError carries the documented USAGE_HINTS hint", async () => {
    const request = childWorkflowRequest("workflows/child");
    const caught = await captureThrow(() => dispatchWorkflowExecution(request));

    const hint = (caught as UsageError).hint();
    expect(hint).toBeDefined();
    expect(hint).toMatch(/P3b|child workflow/i);
  });

  test("an ordinary command target is unaffected — still reaches the command-only lowering path, not this guard", async () => {
    const request: UnitDispatchRequest = {
      runId: "run-1",
      stepId: "compose",
      unitId: "unit-compose-1",
      nodeId: "compose",
      prompt: "",
      timeoutMs: null,
      frozenTarget: {
        kind: "shell",
        exec: { command: ["true"] },
      } as unknown as UnitDispatchRequest["frozenTarget"],
    };
    // A "shell" target never reaches dispatchWorkflowExecution's guards at
    // all (native-executor.ts's defaultUnitDispatcher handles "script" and
    // "shell" directly) — asserted here as the negative control: the new
    // WORKFLOW_CHILD_EXECUTION_UNSUPPORTED code is specific to
    // "child-workflow" and does not leak onto other target kinds.
    const caught = await captureThrow(() => dispatchWorkflowExecution(request));
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(UsageError);
  });
});
