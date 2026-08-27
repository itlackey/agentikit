// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P3a Lane A TESTS — plan `irVersion` 5's DECODE half: the `child-workflow`
 * member of the frozen-target union and its corruption-boundary integrity
 * chain (spec docs/plans/specs/p3a-plan-v5-child-freeze.md §3.1/§3.5/§3.6;
 * behavior rows A-01, A-02, A-20…A-24). This file owns DECODE ONLY —
 * `src/workflows/ir/schema-v4.ts` + `src/workflows/ir/plan-hash.ts` — never
 * the freeze-time producer (`src/workflows/freeze/targets/child-workflow.ts`,
 * Lane B, landing in a later commit per the spec's §0.2 commit ladder). Every
 * fixture below therefore constructs its OWN parent+child plan bytes by hand
 * (via {@link freezeWorkflow} for a realistic, independently-valid base plan
 * plus plain JSON splicing — never through the real freeze pipeline, which
 * cannot produce a `child-workflow` target yet).
 *
 * RED today, for the two reasons the spec's decoder table (§3.6) implies:
 *   1. `decodeWorkflowPlanV4` requires `raw.irVersion === WORKFLOW_IR_V4_VERSION`
 *      (4) today; every fixture here declares `irVersion: 5`.
 *   2. `decodeFrozenTarget`'s closed-kind check (schema-v4.ts) accepts only
 *      `command | shell | script`; `child-workflow` is unrecognized.
 * Once Implement lands `WORKFLOW_IR_V5_VERSION` + `decodeChildWorkflowTarget`,
 * every "does not throw" assertion below starts passing and every negative
 * (tamper) assertion keeps passing, now for the RIGHT reason.
 *
 * No `@ts-expect-error` directive is needed anywhere in this file:
 * `decodeWorkflowPlanV4(input: unknown, hooks?)` already accepts `unknown`
 * (schema-v4.ts), so every fixture below is built and spliced as plain JSON
 * (`JSON.parse`/`JSON.stringify` round-trips, which TypeScript types `any`)
 * rather than through the not-yet-existing `FrozenChildWorkflowTarget` TS
 * interface — there is nothing to reference that fails to type-check.
 * `computePlanHash`/`canonicalPlanJson` (ir/plan-hash.ts) are likewise typed
 * `WorkflowPlanGraphV4 | unknown`, so they accept these hand-built objects
 * directly. Reading a field back off a DECODED plan's `frozenTarget` (still
 * typed as the `command | shell | script` union today) goes through a single
 * `as unknown as DecodedChildTargetView` cast — always type-legal, so nothing
 * to suppress — instead of importing the not-yet-existing
 * `FrozenChildWorkflowTarget` interface. Comparisons against a not-yet-
 * literal-5 `.irVersion` or a not-yet-`"child-workflow"` `.kind` use Bun's
 * own documented `.toBe<T>(...)` generic-override idiom (bun-types
 * test.d.ts, `toBe<X = T>(expected: NoInfer<X>): void`) instead of a
 * directive — it type-checks both before AND after Implement, so nothing
 * needs deleting later.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { UsageError } from "../../src/core/errors";
import { canonicalJson, canonicalPlanJson, computePlanHash } from "../../src/workflows/ir/plan-hash";
import { decodeWorkflowPlanV4 } from "../../src/workflows/ir/schema-v4";
import { freezeWorkflow } from "../_helpers/workflow";

const ONE_STEP_MD = [
  "---",
  "type: workflow",
  "steps:",
  "  - id: work",
  "---",
  "",
  "## work",
  "",
  "Do the work.",
  "",
].join("\n");

/**
 * A fresh, independently-valid one-unit plan, forced to declare irVersion 5.
 * No explicit return type: `JSON.parse` is already `any` (lib.d.ts), and
 * spreading it keeps the object `any` — every caller below treats this as
 * plain untyped JSON on the way into `decodeWorkflowPlanV4(input: unknown)`.
 */
function freshUnitPlan(sourcePath: string) {
  return { ...JSON.parse(canonicalPlanJson(freezeWorkflow(ONE_STEP_MD, sourcePath))), irVersion: 5 };
}

/** §3.5's exact `contentHash` formula. */
function childContentHash(fields: {
  ref: string;
  planHash: string;
  via: "direct" | "task";
  taskRef?: string;
  inputBindings?: unknown;
}): string {
  return createHash("sha256")
    .update("akm.workflow.child-workflow\0v1\0")
    .update(
      canonicalJson({
        ref: fields.ref,
        planHash: fields.planHash,
        via: fields.via,
        taskRef: fields.taskRef ?? null,
        inputBindings: fields.inputBindings ?? null,
      }),
    )
    .digest("hex");
}

/** A structurally-correct `FrozenChildWorkflowTarget` (§3.5), as plain JSON. */
function buildChildTarget(options: {
  ref?: string;
  planHash: string;
  frozenPlan: unknown;
  via?: "direct" | "task";
  taskRef?: string;
  inputBindings?: unknown;
}): unknown {
  const ref = options.ref ?? "workflows/child";
  const via = options.via ?? "direct";
  return {
    kind: "child-workflow",
    ref,
    planHash: options.planHash,
    frozenPlan: options.frozenPlan,
    contentHash: childContentHash({
      ref,
      planHash: options.planHash,
      via,
      taskRef: options.taskRef,
      inputBindings: options.inputBindings,
    }),
    via,
    ...(options.taskRef ? { taskRef: options.taskRef } : {}),
    ...(options.inputBindings ? { inputBindings: options.inputBindings } : {}),
  };
}

/** Splice `childTarget` into `parentPlan`'s (sole) unit's `frozenTarget`. No explicit return type: see {@link freshUnitPlan}. */
function embedChildTarget(parentPlan: unknown, childTarget: unknown) {
  const cloned = JSON.parse(JSON.stringify(parentPlan));
  cloned.steps[0].root.frozenTarget = childTarget;
  return cloned;
}

/** A loose view onto a decoded plan's child-workflow frozenTarget (see file header). */
interface DecodedChildTargetView {
  readonly kind: "child-workflow";
  readonly ref: string;
  readonly planHash: string;
  readonly via: "direct" | "task";
  readonly taskRef?: string;
}

function asChildTargetView(frozenTarget: unknown): DecodedChildTargetView {
  return frozenTarget as unknown as DecodedChildTargetView;
}

describe("plan irVersion 5 — a child-workflow frozen target decodes (A-01, A-02)", () => {
  test("a parent plan whose unit targets a child workflow decodes: irVersion 5, frozenTarget.kind child-workflow", () => {
    const childPlan = freshUnitPlan("workflows/child.md");
    const planHash = computePlanHash(childPlan);
    const childTarget = buildChildTarget({ ref: "workflows/child", planHash, frozenPlan: childPlan, via: "direct" });
    const parentPlanJson = embedChildTarget(freshUnitPlan("workflows/parent.md"), childTarget);

    // RED today: decodeWorkflowPlanV4 rejects irVersion 5 and the
    // child-workflow target kind (see file header).
    expect(() => decodeWorkflowPlanV4(parentPlanJson)).not.toThrow();

    const decoded = decodeWorkflowPlanV4(parentPlanJson);
    expect(decoded.irVersion).toBe<number>(5);
    expect(decoded.steps).toHaveLength(1); // A-02: structurally sound, like any other decoded plan
    expect(decoded.sourceReadSet.length).toBeGreaterThan(0);
    const root = decoded.steps[0]?.root;
    if (!root || root.kind === "map") throw new Error("expected a solo unit root");
    expect(root.frozenTarget.kind).toBe<string>("child-workflow");
    const target = asChildTargetView(root.frozenTarget);
    expect(target.ref).toBe("workflows/child");
    expect(target.planHash).toBe(planHash);
    expect(target.via).toBe("direct");
  });

  test("the same fixture, task-wrapped (via: task, taskRef present), also decodes", () => {
    const childPlan = freshUnitPlan("workflows/child-via-task.md");
    const planHash = computePlanHash(childPlan);
    const childTarget = buildChildTarget({
      ref: "workflows/child-via-task",
      planHash,
      frozenPlan: childPlan,
      via: "task",
      taskRef: "tasks/nested",
    });
    const parentPlanJson = embedChildTarget(freshUnitPlan("workflows/parent-via-task.md"), childTarget);

    expect(() => decodeWorkflowPlanV4(parentPlanJson)).not.toThrow();
    const decoded = decodeWorkflowPlanV4(parentPlanJson);
    const root = decoded.steps[0]?.root;
    if (!root || root.kind === "map") throw new Error("expected a solo unit root");
    expect(root.frozenTarget.kind).toBe<string>("child-workflow");
    const target = asChildTargetView(root.frozenTarget);
    expect(target.via).toBe("task");
    expect(target.taskRef).toBe("tasks/nested");
  });
});

describe("embedded-plan integrity at decode (A-20…A-23, §2.7)", () => {
  test("a tampered embedded child plan (planHash no longer matches) fails decode, while the untampered plan decodes", () => {
    const childPlan = freshUnitPlan("workflows/child-tamper-plan.md");
    const planHash = computePlanHash(childPlan);
    const childTarget = buildChildTarget({ ref: "workflows/child", planHash, frozenPlan: childPlan, via: "direct" });
    const valid = embedChildTarget(freshUnitPlan("workflows/parent-tamper-plan.md"), childTarget);

    // Corrupt the embedded PLAN BYTES only — planHash and contentHash stay
    // the (now stale) values computed against the untampered plan, exactly
    // the corruption row A-20 describes.
    const tampered = JSON.parse(JSON.stringify(valid));
    tampered.steps[0].root.frozenTarget.frozenPlan.title = `${tampered.steps[0].root.frozenTarget.frozenPlan.title}-tampered`;

    expect(() => decodeWorkflowPlanV4(valid)).not.toThrow(); // RED today (see file header)
    expect(() => decodeWorkflowPlanV4(tampered)).toThrow(UsageError);
    try {
      decodeWorkflowPlanV4(tampered);
      throw new Error("expected decode to reject the tampered embedded plan");
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      // A-N2: the corrupt-plan family keeps INVALID_JSON_ARGUMENT — every
      // sibling decoder in schema-v4.ts's fail() throws this same code.
      expect((error as UsageError).code).toBe("INVALID_JSON_ARGUMENT");
    }
  });

  test("a tampered contentHash fails decode, while the untampered plan decodes", () => {
    const childPlan = freshUnitPlan("workflows/child-tamper-content.md");
    const planHash = computePlanHash(childPlan);
    const childTarget = buildChildTarget({ ref: "workflows/child", planHash, frozenPlan: childPlan, via: "direct" });
    const valid = embedChildTarget(freshUnitPlan("workflows/parent-tamper-content.md"), childTarget);

    const tampered = JSON.parse(JSON.stringify(valid));
    const original = tampered.steps[0].root.frozenTarget.contentHash as string;
    tampered.steps[0].root.frozenTarget.contentHash = original.startsWith("0")
      ? `1${original.slice(1)}`
      : `0${original.slice(1)}`;

    expect(() => decodeWorkflowPlanV4(valid)).not.toThrow(); // RED today
    expect(() => decodeWorkflowPlanV4(tampered)).toThrow(UsageError);
    try {
      decodeWorkflowPlanV4(tampered);
      throw new Error("expected decode to reject the tampered contentHash");
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).code).toBe("INVALID_JSON_ARGUMENT");
    }
  });

  test("an embedded child declaring an irVersion other than 5 fails decode", () => {
    // Build the child plan with the WRONG version, then hash/sign it
    // self-consistently (so the failure is isolated to the version check,
    // not a hash mismatch — A-20 covers that separately).
    const wrongVersionChild = { ...freshUnitPlan("workflows/child-wrong-version.md"), irVersion: 4 };
    const planHash = computePlanHash(wrongVersionChild);
    const childTarget = buildChildTarget({
      ref: "workflows/child",
      planHash,
      frozenPlan: wrongVersionChild,
      via: "direct",
    });
    const parentPlanJson = embedChildTarget(freshUnitPlan("workflows/parent-wrong-version.md"), childTarget);

    expect(() => decodeWorkflowPlanV4(parentPlanJson)).toThrow(UsageError);
    try {
      decodeWorkflowPlanV4(parentPlanJson);
      throw new Error("expected decode to reject a non-5 embedded irVersion");
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).code).toBe("INVALID_JSON_ARGUMENT");
    }
  });

  test("a chain nested to exactly the composition depth bound (8 descendant levels) decodes; one level deeper (9) fails decode", () => {
    // WORKFLOW_MAX_COMPOSITION_DEPTH is 8 (spec §4.5) — the constant itself
    // lives in src/workflows/resource-limits.ts, added by Lane B in a later
    // commit; this file owns decode only, so the value is reproduced here
    // (matching §4.5) rather than imported across the lane boundary.
    function buildNestedRootPlan(descendantLevels: number): unknown {
      let plan: unknown = freshUnitPlan("workflows/nest-leaf.md");
      for (let level = 0; level < descendantLevels; level++) {
        const base = freshUnitPlan(`workflows/nest-${level}.md`);
        const planHash = computePlanHash(plan);
        const target = buildChildTarget({
          ref: `workflows/nested-child-${level}`,
          planHash,
          frozenPlan: plan,
          via: "direct",
        });
        plan = embedChildTarget(base, target);
      }
      return plan;
    }

    const atLimit = buildNestedRootPlan(8);
    const overLimit = buildNestedRootPlan(9);

    expect(() => decodeWorkflowPlanV4(atLimit)).not.toThrow(); // RED today
    expect(() => decodeWorkflowPlanV4(overLimit)).toThrow(UsageError);
  });

  test("an unknown frozenTarget.kind still fails with the existing closed-kind message shape (A-24, PRESERVE)", () => {
    const parentPlanJson = embedChildTarget(freshUnitPlan("workflows/parent-unknown-kind.md"), {
      kind: "not-a-real-target-kind",
    });
    expect(() => decodeWorkflowPlanV4(parentPlanJson)).toThrow(/unsupported kind/);
  });
});
