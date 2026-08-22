// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import path from "node:path";
import { parseBundleRef } from "../../core/asset/asset-ref";
import type { AkmConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { type GuardedExecutionSource, GuardedExecutionSourceCollector } from "../../execution/guarded-source";
import type { WorkflowAsset } from "../runtime/workflow-asset-loader";
import { compileResolveFreezeWorkflow, type FrozenWorkflow } from "./freeze";
import { canonicalJson } from "./plan-hash";
import type { IrUnitNode } from "./schema";
import {
  decodeWorkflowPlanV4,
  type IrExecNodeV4,
  type IrStepPlanV4,
  type IrUnitNodeV4,
  WORKFLOW_IR_V4_VERSION,
  type WorkflowPlanGraphV4,
} from "./schema-v4";
import { resolveWorkflowSourceV4 } from "./source-freeze-v4";

export interface FrozenWorkflowV4 extends Omit<FrozenWorkflow, "plan"> {
  readonly plan: WorkflowPlanGraphV4;
  /** Retained in-memory read set used for the final pre-publication CAS. */
  readonly sourceCollector: GuardedExecutionSourceCollector;
}

export interface FreezeWorkflowV4Options {
  readonly sourceCollector?: GuardedExecutionSourceCollector;
}

/** Compile, resolve, and freeze one executable plan without publishing any state. */
export async function compileResolveFreezeWorkflowV4(
  asset: WorkflowAsset,
  config: AkmConfig,
  options: FreezeWorkflowV4Options = {},
): Promise<FrozenWorkflowV4> {
  const sourceCollector = options.sourceCollector ?? new GuardedExecutionSourceCollector();
  const workflowSource = captureWorkflowSource(asset, sourceCollector);
  const resolved = await resolveWorkflowSourceV4(asset, workflowSource, config, sourceCollector);
  const v3 = compileResolveFreezeWorkflow(resolved.asset, config);
  const steps = v3.plan.steps.map((step): IrStepPlanV4 => {
    if (!step.root) {
      const { root: _root, ...withoutRoot } = step;
      return withoutRoot;
    }
    const frozen = resolved.units.get(step.stepId);
    if (!frozen) throw new Error(`resolved workflow target missing for step ${step.stepId}`);
    const root: IrExecNodeV4 =
      step.root.kind === "map"
        ? { ...step.root, template: freezeResolvedUnit(step.root.template, frozen) }
        : freezeResolvedUnit(step.root, frozen);
    return { ...step, root };
  });
  const sourceReadSet = sourceCollector
    .snapshot()
    .sources.filter(
      (source): source is GuardedExecutionSource & { identity: NonNullable<GuardedExecutionSource["identity"]> } =>
        Boolean(source.identity),
    )
    .map((source) => sourceSnapshot(source));
  const plan = decodeWorkflowPlanV4({
    ...v3.plan,
    irVersion: WORKFLOW_IR_V4_VERSION,
    sourceReadSet,
    steps,
  });
  return Object.freeze({ ...v3, plan, sourceCollector });
}

function freezeResolvedUnit(
  unit: IrUnitNode,
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
                exec: unit.exec,
                environment: resolved.environment,
                cwdIdentity: resolved.target.cwdIdentity,
              }),
            )
            .digest("hex"),
        })
      : resolved.target;
  return Object.freeze({ ...unit, frozenTarget, environment: Object.freeze([...resolved.environment]) });
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
