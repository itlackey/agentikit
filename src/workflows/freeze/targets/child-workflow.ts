// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The ONE recursive child-workflow resolver (spec docs/plans/specs/
 * p3a-plan-v5-child-freeze.md §4). BOTH composition forms lower here:
 *
 *  - a direct step `uses: workflows/<ref>` (`resolve-steps.ts`'s
 *    `resolveStep`, `via: "direct"`);
 *  - a task-wrapped workflow target — a `uses: tasks/<ref>` step whose task's
 *    OWN target is a workflow (`targets/task.ts`'s `taskDispatch`,
 *    `via: "task"`).
 *
 * `childWorkflowDispatch` resolves and qualifies the child ref, enforces the
 * three composition bounds (depth, cycle, aggregate embedded bytes — all
 * FREEZE-time, before publication, `COMPOSITION_INVALID`), recursively
 * freezes the child COMPLETELY through the injected `ResolutionContext.freezeChild`
 * (never a direct import of `compileResolveFreezeWorkflowV4` —
 * `freeze/step-values.ts`'s `ChildCompositionContext` doc explains why: this
 * module is downstream of `ir/freeze-v4.ts`, so importing back from it would
 * close a static cycle), absorbs the child's own fresh source collector into
 * the parent's (A-N7), binds the composing step's effective inputs against
 * the child's declared `params:` (A-N8, reusing the ONE `freezeTaskInputBindings`
 * normalizer), and returns the standard `ResolvedDispatch` envelope carrying
 * a `FrozenChildWorkflowTarget` (`ir/schema-v4.ts`).
 */

import { createHash } from "node:crypto";
import { parseBundleRef } from "../../../core/asset/asset-ref";
import { UsageError } from "../../../core/errors";
import { GuardedExecutionSourceCollector } from "../../../execution/guarded-source";
import type { TaskInputBinding } from "../../../execution/input-contract";
import { workflowParamContract } from "../../ir/params";
import { canonicalJson, canonicalPlanJson } from "../../ir/plan-hash";
import type { FrozenChildWorkflowTarget, WorkflowPlanGraphV4 } from "../../ir/schema-v4";
import type { ProgramUnit } from "../../program/schema";
import {
  utf8Bytes,
  WORKFLOW_MAX_COMPOSITION_DEPTH,
  WORKFLOW_MAX_EMBEDDED_CHILD_PLAN_BYTES,
} from "../../resource-limits";
import { loadWorkflowAsset } from "../../runtime/workflow-asset-loader";
import type { WorkflowSourceStep } from "../../source-ir/schema";
import { resolveOwnedAsset } from "../environment";
import { declaredParamNames, earlierStepIds, type ResolutionContext, type ResolvedDispatch } from "../step-values";
import { freezeTaskInputBindings } from "../task-bindings";

export interface ChildWorkflowDispatchInput {
  readonly source: WorkflowSourceStep;
  readonly baseUnit: ProgramUnit;
  /**
   * The RAW child workflow ref as the composing site names it: the direct
   * step's own `uses:` value, or the composing task's own resolved workflow-
   * target ref (`PreparedTaskV3Workflow.ref`) for the task-wrapped form.
   * Re-resolved and canonicalized here regardless of form (§4.2 step 1).
   */
  readonly childRefInput: string;
  readonly context: ResolutionContext;
  readonly via: "direct" | "task";
  /** Present only when via === "task": the composing task's OWN qualified ref. */
  readonly taskRef?: string;
  /**
   * The with:-shaped authored source bound against the child's declared
   * `params:` (§4.2 step 7's routing table, A-N8): the step's own `with:`
   * for a direct composition; the v3 task's own `with:` (`PreparedTaskV3Workflow.params`)
   * for a v3 task-wrapped composition; the composing task's EFFECTIVE inputs
   * (its declared defaults, overridden by any authored `with:`, already
   * normalized against the task's own `inputs:` contract) for a v4
   * declared-inputs task-wrapped composition.
   */
  readonly authoredWith: Readonly<Record<string, unknown>> | undefined;
}

/** §3.5's exact `contentHash` formula — mirrors `ir/schema-v4.ts`'s private decode-side `childWorkflowContentHash` byte-for-byte (the decoder re-verifies what this produces); duplicated rather than imported so this freeze-side module needs no edit to Lane A's already-landed decoder file. */
function childWorkflowContentHash(fields: {
  readonly ref: string;
  readonly planHash: string;
  readonly via: "direct" | "task";
  readonly taskRef: string | undefined;
  readonly inputBindings: readonly TaskInputBinding[];
}): string {
  return createHash("sha256")
    .update("akm.workflow.child-workflow\0v1\0")
    .update(
      canonicalJson({
        ref: fields.ref,
        planHash: fields.planHash,
        via: fields.via,
        taskRef: fields.taskRef ?? null,
        inputBindings: fields.inputBindings.length > 0 ? fields.inputBindings : null,
      }),
    )
    .digest("hex");
}

/** A workflow entry of a composition `refPath` — the only entries a cycle can close through (§4.5: a task target can never itself be a task, so no task->task chain exists to close one). */
function isWorkflowRef(ref: string): boolean {
  try {
    return parseBundleRef(ref).conceptId.startsWith("workflows/");
  } catch {
    return false;
  }
}

function compositionPath(refPath: readonly string[], childRef: string): string {
  return [...refPath, childRef].join(" -> ");
}

function assertNoCompositionCycle(stepId: string, childRef: string, refPath: readonly string[]): void {
  if (!refPath.filter(isWorkflowRef).includes(childRef)) return;
  throw new UsageError(
    `Workflow step ${stepId} cannot compose ${childRef}: that would create a composition cycle. ` +
      `Path: ${compositionPath(refPath, childRef)}.`,
    "COMPOSITION_INVALID",
  );
}

function assertCompositionDepthAllowed(
  stepId: string,
  childRef: string,
  childDepth: number,
  refPath: readonly string[],
): void {
  if (childDepth <= WORKFLOW_MAX_COMPOSITION_DEPTH) return;
  throw new UsageError(
    `Workflow step ${stepId} cannot compose ${childRef}: workflow composition is limited to ` +
      `${WORKFLOW_MAX_COMPOSITION_DEPTH} levels. Path: ${compositionPath(refPath, childRef)}.`,
    "COMPOSITION_INVALID",
  );
}

/**
 * Add the child's embedded plan bytes to the shared, tree-wide budget
 * (A-N6) and fail before publication if the AGGREGATE crosses the cap.
 * Mutates `budget` only on success — a rejected step leaves the running
 * total exactly as it was, matching every other freeze-time failure's
 * no-partial-effect shape.
 */
function chargeEmbeddedBudget(
  stepId: string,
  childRef: string,
  childPlanBytes: number,
  budget: { embeddedBytes: number },
): void {
  const projected = budget.embeddedBytes + childPlanBytes;
  if (projected > WORKFLOW_MAX_EMBEDDED_CHILD_PLAN_BYTES) {
    throw new UsageError(
      `Workflow step ${stepId} cannot compose ${childRef}: the embedded child plans would total ${projected} ` +
        `bytes, over the ${WORKFLOW_MAX_EMBEDDED_CHILD_PLAN_BYTES}-byte limit for one workflow run.`,
      "COMPOSITION_INVALID",
    );
  }
  budget.embeddedBytes = projected;
}

export async function childWorkflowDispatch(input: ChildWorkflowDispatchInput): Promise<ResolvedDispatch> {
  const { source, baseUnit, childRefInput, context, via, taskRef, authoredWith } = input;

  // §4.2 step 1: resolve + qualify. Resolution failures propagate unchanged,
  // in code and shape (row B-11) — the same authority every other
  // composition target (command/script/task) already resolves through.
  const owned = await resolveOwnedAsset(childRefInput, "workflow", context);
  const childAsset = await loadWorkflowAsset(owned.ref);
  const childRef = childAsset.ref;

  // §4.2 steps 2-3: the composition bounds, before any child compilation.
  assertNoCompositionCycle(source.id, childRef, context.composition.refPath);
  const childDepth = context.composition.depth + 1;
  assertCompositionDepthAllowed(source.id, childRef, childDepth, context.composition.refPath);

  // §4.2 step 4: freeze the child COMPLETELY (compile -> validate -> freeze),
  // with its OWN fresh collector (A-N7) so its plan is a pure function of its
  // own source, and the SAME mutable budget object so the aggregate bound
  // sees every descendant across the whole tree.
  const childRefPath =
    via === "task" && taskRef !== undefined
      ? [...context.composition.refPath, taskRef, childRef]
      : [...context.composition.refPath, childRef];
  const child = await context.freezeChild({
    asset: childAsset,
    sourceCollector: new GuardedExecutionSourceCollector(),
    composition: { depth: childDepth, refPath: childRefPath, budget: context.composition.budget },
  });

  // The embedded `frozenPlan` must be a PLAIN, symbol-free JSON structure —
  // exactly the shape `decodeWorkflowPlanV4` will (recursively) re-verify it
  // as, both right now (the PARENT's own top-level `decodeWorkflowPlanV4`
  // call in `ir/freeze-v4.ts` walks straight into this target) and later,
  // read back from a stored run's `plan_json`. `child.plan` — the in-memory
  // result of the child's OWN already-decoded freeze — carries internal
  // resolved-request construction brands (`execution/resolved-request.ts`)
  // that `decodeResolvedExecutionRequest` deliberately rejects on ANY
  // "fresh rehydrate" input; round-tripping through canonical JSON strips
  // them, the same way persisting and re-reading `plan_json` naturally would.
  const embeddedPlanJson = canonicalPlanJson(child.plan);
  const frozenPlan = JSON.parse(embeddedPlanJson) as WorkflowPlanGraphV4;

  // §4.2 step 5.
  chargeEmbeddedBudget(source.id, childRef, utf8Bytes(embeddedPlanJson), context.composition.budget);

  // §4.2 step 6 (A-N7): absorb the child's captured sources so the parent's
  // final pre-publication CAS (`revalidate()`) covers every child file too.
  context.collector.absorb(child.sourceCollector);

  // §4.2 step 7 (A-N8): bind the composing step's effective inputs against
  // the child's declared params: — the SAME normalizer every other binding
  // surface uses, fed the child's own contract instead of a task's.
  const inputBindings = freezeTaskInputBindings({
    stepId: source.id,
    targetRef: childRef,
    with: authoredWith,
    contract: workflowParamContract(frozenPlan),
    earlierStepIds: earlierStepIds(context.sourceIr, source.id),
    declaredParamNames: declaredParamNames(context.sourceIr),
  });

  // §4.2 step 8: build the frozen target.
  const planHash = createHash("sha256").update(embeddedPlanJson).digest("hex");
  const contentHash = childWorkflowContentHash({ ref: childRef, planHash, via, taskRef, inputBindings });
  const target: FrozenChildWorkflowTarget = Object.freeze({
    kind: "child-workflow",
    ref: childRef,
    planHash,
    frozenPlan,
    contentHash,
    via,
    ...(taskRef !== undefined ? { taskRef } : {}),
    ...(inputBindings.length > 0 ? { inputBindings } : {}),
  });

  return {
    target,
    // A child run carries its own frozen environment inside its own plan;
    // the parent unit's environment stays whatever the step itself declares
    // elsewhere (§4.2 step 8).
    environment: [],
    unit: baseUnit,
    instructions:
      source.instructions ??
      (via === "task" && taskRef !== undefined ? `Run task ${taskRef}.` : `Run workflow ${childRef}.`),
  };
}
