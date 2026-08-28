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
 * the child's declared `params:` (A-N8 — see `AuthoredChildInputs` below for
 * the two ways that mapping arrives), and returns the standard
 * `ResolvedDispatch` envelope carrying a `FrozenChildWorkflowTarget`
 * (`ir/schema-v4.ts`).
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
import { freezeTaskInputBindings, rebindTaskInputBindings } from "../task-bindings";

/**
 * The authored mapping bound against the child's declared `params:` (§4.2
 * step 7's routing table, A-N8). Two shapes, matching whether the composing
 * site has a genuinely AUTHORED `with:` record or an already-classified
 * binding set:
 *
 *  - `{kind: "with"}` — the step's own `with:` for a direct composition, or
 *    the v3 task's own `with:` (`PreparedTaskV3Workflow.params`) for a v3
 *    task-wrapped composition. Neither has been normalized against anything
 *    yet, so it goes through the ONE `freezeTaskInputBindings` normalizer
 *    exactly as any other binding surface does.
 *  - `{kind: "bindings"}` — the composing task's EFFECTIVE inputs for a v4
 *    declared-inputs task-wrapped composition: its declared defaults,
 *    overridden by any authored `with:`, already classified once (literal vs
 *    reference) against the task's OWN `inputs:` contract by `taskDispatch`.
 *    Re-bound against the child's contract via `rebindTaskInputBindings`,
 *    which trusts each entry's already-computed `kind` instead of
 *    re-deriving it from the value's shape — round-tripping through the
 *    `with:` grammar here would silently reinterpret a LITERAL value shaped
 *    like `{from: "<ref>"}` (e.g. an object-typed input's declared default)
 *    as a live reference binding (code-review finding, docs/plans/specs/
 *    p3a-plan-v5-child-freeze.md).
 */
export type AuthoredChildInputs =
  | Readonly<{ kind: "with"; value: Readonly<Record<string, unknown>> | undefined }>
  | Readonly<{ kind: "bindings"; value: readonly TaskInputBinding[] }>;

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
  /** See {@link AuthoredChildInputs}. */
  readonly authoredInputs: AuthoredChildInputs;
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

/**
 * Code-review finding (see this file's `environment: []` return field): a
 * step composing a child workflow has no path to honor its own authored
 * `env:` — the child run carries its own frozen environment inside its own
 * plan, so `freezeEnvironment` (the ONE mechanism a step's `env:` reaches a
 * frozen unit through, `../environment.ts`) is never called for this
 * target. Leaving that silent would repeat exactly the defect A-N5 already
 * closed for `with:` on a non-binding surface — an authored construct that
 * cannot be honored on this composing target now rejects instead of
 * vanishing. Checks BOTH shapes a step's `env:` can take (`../environment.ts`'s
 * `freezeEnvironment`): literal `env:` values and `unit: {env: [...]}` refs.
 * An absent/empty `env:` is not authored and stays valid.
 */
function assertNoStepEnvironment(stepId: string, childRef: string, source: WorkflowSourceStep): void {
  const hasLiteralEnv = Object.keys(source.env ?? {}).length > 0;
  const hasEnvRefs = (source.unit?.env ?? []).length > 0;
  if (!hasLiteralEnv && !hasEnvRefs) return;
  throw new UsageError(
    `Workflow step ${stepId} cannot pass env: while composing ${childRef}: a child run carries its own frozen ` +
      `environment inside its own plan, so a parent-level env: on the composing step cannot be honored. Remove ` +
      `env: from this step, or move it into ${childRef}'s own source.`,
    "COMPOSITION_INVALID",
    "Remove the env: (or unit: env:) block from this step, or set those variables inside the child workflow's " +
      "own source — a composing step's environment is never delivered into a child run.",
  );
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
    "Break the cycle: remove or redirect one of the compositions in the path above so no workflow ends up " +
      "composing itself, directly or through intermediates.",
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
    `Flatten the composition chain to ${WORKFLOW_MAX_COMPOSITION_DEPTH} levels or fewer — inline one of the ` +
      "intermediate workflows, or restructure the chain so fewer child compositions are nested.",
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
      "Reduce the number or size of workflows composed into this run — split the work across separate " +
        "top-level runs, or trim the composed children's own plans.",
    );
  }
  budget.embeddedBytes = projected;
}

export async function childWorkflowDispatch(input: ChildWorkflowDispatchInput): Promise<ResolvedDispatch> {
  const { source, baseUnit, childRefInput, context, via, taskRef, authoredInputs } = input;

  // §4.2 step 1: resolve + qualify. Resolution failures propagate unchanged,
  // in code and shape (row B-11) — the same authority every other
  // composition target (command/script/task) already resolves through.
  const owned = await resolveOwnedAsset(childRefInput, "workflow", context);
  const childAsset = await loadWorkflowAsset(owned.ref);
  const childRef = childAsset.ref;

  // Code-review finding: an authored env: on the composing step has no
  // path to reach the child run and must reject, not vanish (see
  // assertNoStepEnvironment's doc comment).
  assertNoStepEnvironment(source.id, childRef, source);

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
  // the child's declared params:. A genuinely authored `with:` goes through
  // the SAME normalizer every other binding surface uses; an
  // already-classified binding set (a v4 task's effective inputs) is
  // RE-bound instead, never round-tripped back through the `with:` grammar
  // (code-review finding — see AuthoredChildInputs above).
  const inputBindings =
    authoredInputs.kind === "bindings"
      ? rebindTaskInputBindings({
          stepId: source.id,
          targetRef: childRef,
          bindings: authoredInputs.value,
          contract: workflowParamContract(frozenPlan),
        })
      : freezeTaskInputBindings({
          stepId: source.id,
          targetRef: childRef,
          with: authoredInputs.value,
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
    // A child run carries its own frozen environment inside its own plan.
    // A composing step's own env: cannot reach it, so assertNoStepEnvironment
    // above rejects one instead of it silently vanishing here (§4.2 step 8).
    environment: [],
    unit: baseUnit,
    instructions:
      source.instructions ??
      (via === "task" && taskRef !== undefined ? `Run task ${taskRef}.` : `Run workflow ${childRef}.`),
  };
}
