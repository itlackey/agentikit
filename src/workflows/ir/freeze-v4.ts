// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import path from "node:path";
import { parseBundleRef } from "../../core/asset/asset-ref";
import type { AkmConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { type GuardedExecutionSource, GuardedExecutionSourceCollector } from "../../execution/guarded-source";
import { defaultMapConcurrency, workflowMaxConcurrency } from "../concurrency-policy";
import { assertChildOutputReferences } from "../freeze/child-output-references";
import { resolveWorkflowSourceV4 } from "../freeze/source-freeze";
import type { ChildCompositionContext, ChildFreezeFn } from "../freeze/step-values";
import type { WorkflowAsset } from "../runtime/workflow-asset-loader";
import type { WorkflowUnitDraft } from "./compile";
import { compileWorkflowPlan } from "./compile";
import { canonicalJson } from "./plan-hash";
import {
  decodeWorkflowPlanV4,
  type IrExecNodeV4,
  type IrStepPlanV4,
  type IrUnitNodeV4,
  WORKFLOW_IR_V5_VERSION,
  type WorkflowPlanGraphV4,
} from "./schema-v4";

export interface FrozenWorkflowV4 {
  readonly plan: WorkflowPlanGraphV4;
  readonly warnings: import("../schema").WorkflowError[];
  readonly engineAnnouncement?: string;
  /** Retained in-memory read set used for the final pre-publication CAS. */
  readonly sourceCollector: GuardedExecutionSourceCollector;
}

export interface FreezeWorkflowV4Options {
  readonly sourceCollector?: GuardedExecutionSourceCollector;
  /**
   * Recursive child-workflow composition state (spec docs/plans/specs/
   * p3a-plan-v5-child-freeze.md §4.1/§4.3). Omitted at every PRODUCTION call
   * site (`runtime/runs.ts`, `tasks/scheduler-sync.ts`) — those always freeze
   * a ROOT plan, so the default below applies. Only
   * `targets/child-workflow.ts`'s recursive call (via the injected
   * {@link ChildFreezeFn}, never a direct import — see
   * `freeze/step-values.ts`'s `ChildCompositionContext` doc for why) passes
   * one explicitly.
   */
  readonly composition?: ChildCompositionContext;
}

/** Compile, resolve, and freeze one executable plan without publishing any state. */
export async function compileResolveFreezeWorkflowV4(
  asset: WorkflowAsset,
  config: AkmConfig,
  options: FreezeWorkflowV4Options = {},
): Promise<FrozenWorkflowV4> {
  const sourceCollector = options.sourceCollector ?? new GuardedExecutionSourceCollector();
  const composition: ChildCompositionContext = options.composition ?? {
    depth: 0,
    refPath: [asset.ref],
    budget: { embeddedBytes: 0 },
  };
  // Injected rather than imported (A-N7/step-values.ts's `ChildCompositionContext`
  // doc): `targets/child-workflow.ts` is downstream of this module (via
  // `resolve-steps.ts` <- `source-freeze.ts`, imported directly above — the
  // `source-freeze-v4.ts` shim P4 deleted used to sit on this edge), so it
  // cannot import `compileResolveFreezeWorkflowV4` directly without closing
  // a static import cycle
  // (tests/architecture/import-cycle-ratchet.test.ts, shrink-only, empty
  // baseline). This closure is this function's own recursive call, passed
  // down as a plain value through `ResolutionContext.freezeChild`.
  const freezeChild: ChildFreezeFn = async (request) => {
    const child = await compileResolveFreezeWorkflowV4(request.asset, config, {
      sourceCollector: request.sourceCollector,
      composition: request.composition,
    });
    return { plan: child.plan, sourceCollector: child.sourceCollector };
  };
  const workflowSource = captureWorkflowSource(asset, sourceCollector);
  const resolved = await resolveWorkflowSourceV4(
    asset,
    workflowSource,
    config,
    sourceCollector,
    composition,
    freezeChild,
  );
  const compiled = compileWorkflowPlan(resolved.sourceIr, asset.title, resolved.units);
  if (!compiled.ok) {
    throw new UsageError(
      compiled.errors.map((error) => `${asset.path}:${error.line}: ${error.message}`).join("\n"),
      "INVALID_FLAG_VALUE",
    );
  }
  const steps = compiled.plan.steps.map((step): IrStepPlanV4 => {
    const frozenJudge = step.gate.criteria.length === 0 ? null : resolved.judges.get(step.stepId);
    if (step.gate.criteria.length > 0 && !frozenJudge) {
      throw new Error(`resolved workflow judge missing for step ${step.stepId}`);
    }
    const gate = Object.freeze({ ...step.gate, maxLoops: step.gate.maxLoops ?? 1, frozenJudge: frozenJudge ?? null });
    if (!step.root) {
      const { root: _root, ...withoutRoot } = step;
      return Object.freeze({ ...withoutRoot, gate });
    }
    const frozen = resolved.units.get(step.stepId);
    if (!frozen) throw new Error(`resolved workflow target missing for step ${step.stepId}`);
    const root: IrExecNodeV4 =
      step.root.kind === "map"
        ? {
            ...step.root,
            concurrency: step.root.concurrency ?? defaultMapConcurrency(config.workflow?.defaultMapConcurrency),
            template: freezeResolvedUnit(step.root.template, frozen),
          }
        : freezeResolvedUnit(step.root, frozen);
    return Object.freeze({ ...step, root, gate });
  });
  // P3b, spec §4.4: after every step's target is resolved (so every embedded
  // child plan is available) and before the plan object is assembled.
  assertChildOutputReferences(steps);
  const sourceReadSet = sourceCollector
    .snapshot()
    .sources.filter(
      (source): source is GuardedExecutionSource & { identity: NonNullable<GuardedExecutionSource["identity"]> } =>
        Boolean(source.identity),
    )
    .map((source) => sourceSnapshot(source));
  const plan = decodeWorkflowPlanV4({
    irVersion: WORKFLOW_IR_V5_VERSION,
    title: compiled.plan.title,
    ...(compiled.plan.params ? { params: compiled.plan.params } : {}),
    ...(compiled.plan.paramSchemas ? { paramSchemas: compiled.plan.paramSchemas } : {}),
    ...(compiled.plan.budget ? { budget: compiled.plan.budget } : {}),
    execution: { maxConcurrency: workflowMaxConcurrency(config.workflow?.maxConcurrency) },
    sourceReadSet,
    steps,
    ...(compiled.plan.outputs ? { outputs: compiled.plan.outputs } : {}),
  });
  return Object.freeze({
    plan,
    warnings: compiled.warnings,
    ...(resolved.engineAnnouncement ? { engineAnnouncement: resolved.engineAnnouncement } : {}),
    sourceCollector,
  });
}

function freezeResolvedUnit(
  unit: WorkflowUnitDraft,
  resolved: Readonly<{ target: IrUnitNodeV4["frozenTarget"]; environment: IrUnitNodeV4["environment"] }>,
): IrUnitNodeV4 {
  const frozenTarget =
    resolved.target.kind === "shell"
      ? Object.freeze({
          ...resolved.target,
          contentHash: createHash("sha256")
            .update("akm.workflow.shell.v1\0")
            .update(
              canonicalJson({
                exec: resolved.target.exec,
                environment: resolved.environment,
                cwdIdentity: resolved.target.cwdIdentity,
              }),
            )
            .digest("hex"),
        })
      : resolved.target;
  const { exec: _exec, ...common } = unit;
  return Object.freeze({
    ...common,
    isolation: common.isolation ?? "none",
    frozenTarget,
    environment: Object.freeze([...resolved.environment]),
  });
}

function captureWorkflowSource(
  asset: WorkflowAsset,
  collector: GuardedExecutionSourceCollector,
): GuardedExecutionSource {
  const root = path.resolve(asset.sourcePath);
  const file = path.resolve(asset.path);
  collector.trackDirectory(root, root);
  const parent = path.dirname(file);
  const relativeParent = path.relative(root, parent);
  if (relativeParent.startsWith("..") || path.isAbsolute(relativeParent)) {
    throw new UsageError(`${file} resolves outside its workflow source root.`, "PATH_ESCAPE_VIOLATION");
  }
  let current = root;
  for (const segment of relativeParent === "" ? [] : relativeParent.split(path.sep)) {
    current = path.join(current, segment);
    collector.trackDirectory(current, root);
  }
  const captured = collector.capture(file, root, { authored: true });
  const parsed = parseBundleRef(asset.ref);
  if (!parsed.bundle || !asset.adapterId) {
    throw new UsageError(
      `Workflow ${asset.ref} has no fully-qualified bundle/adapter owner for durable publication.`,
      "INVALID_FLAG_VALUE",
    );
  }
  return collector.bindIdentity(file, root, {
    ref: asset.ref,
    bundle: parsed.bundle,
    adapter: asset.adapterId,
    file: captured.relativePath,
    hash: captured.sha256,
  });
}

function sourceSnapshot(
  source: GuardedExecutionSource & { identity: NonNullable<GuardedExecutionSource["identity"]> },
): WorkflowPlanGraphV4["sourceReadSet"][number] {
  return Object.freeze({
    identity: source.identity,
    containmentPhysicalIdentity: source.containmentPhysicalIdentity,
    physicalIdentity: source.physicalIdentity,
    size: source.size,
  });
}
