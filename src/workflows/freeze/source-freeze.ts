// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `workflows/freeze/**` lane's only public entry (spec
 * docs/plans/specs/p2b-input-bindings.md §3.1, A-N1): resolves every
 * authored workflow step through the shared command/task authorities and
 * publishes the frozen v4 unit/source shapes `src/workflows/ir/freeze-v4.ts`
 * builds a plan from. `ir/freeze-v4.ts` imports this module directly — the
 * `src/workflows/ir/source-freeze-v4.ts` re-export shim that used to sit
 * between them is deleted (P4 §3.2.7, row B-27).
 */

import type { AkmConfig } from "../../core/config/config-types";
import { UsageError } from "../../core/errors";
import type { GuardedExecutionSource, GuardedExecutionSourceCollector } from "../../execution/guarded-source";
import type {
  FrozenWorkflowCommandTarget,
  FrozenWorkflowEnvironmentBinding,
  FrozenWorkflowTarget,
} from "../ir/schema-v4";
import type { ProgramUnit } from "../program/schema";
import type { WorkflowAsset } from "../runtime/workflow-asset-loader";
import { compileWorkflowSource } from "../source-ir/compile";
import type { WorkflowSourceIrV1 } from "../source-ir/schema";
import { resolveJudge, resolveStep } from "./resolve-steps";
import type { ChildCompositionContext, ChildFreezeFn, ResolutionContext } from "./step-values";

export interface ResolvedWorkflowUnitV4 {
  readonly target: FrozenWorkflowTarget;
  readonly environment: readonly FrozenWorkflowEnvironmentBinding[];
  readonly unit: ProgramUnit;
  readonly instructions: string;
  readonly engineAnnouncement?: string;
}

export interface ResolvedWorkflowSourceV4 {
  readonly sourceIr: WorkflowSourceIrV1;
  readonly units: ReadonlyMap<string, ResolvedWorkflowUnitV4>;
  readonly judges: ReadonlyMap<string, FrozenWorkflowCommandTarget>;
  readonly engineAnnouncement?: string;
}

/**
 * Resolve every authored target through the shared command/task authorities
 * before v4 publication.
 *
 * `composition` and `freezeChild` (spec docs/plans/specs/
 * p3a-plan-v5-child-freeze.md §4.1/§4.3) thread the recursive
 * child-workflow-freeze state down into every step's `ResolutionContext`;
 * `ir/freeze-v4.ts`'s `compileResolveFreezeWorkflowV4` is this function's
 * ONLY caller (directly — P4 deleted the `ir/source-freeze-v4.ts` shim that
 * used to sit on this edge) and supplies both — the root default
 * composition, or the composition
 * `targets/child-workflow.ts` built for a recursive child freeze.
 */
export async function resolveWorkflowSourceV4(
  asset: WorkflowAsset,
  workflowSource: GuardedExecutionSource,
  config: AkmConfig,
  collector: GuardedExecutionSourceCollector,
  composition: ChildCompositionContext,
  freezeChild: ChildFreezeFn,
): Promise<ResolvedWorkflowSourceV4> {
  const compiled = compileWorkflowSource(workflowSource.content, { path: asset.path, workspaceRoot: asset.sourcePath });
  if (!compiled.ok) {
    throw new UsageError(
      `Workflow source cannot be frozen: ${compiled.errors.map((error) => error.message).join("; ")}`,
      "INVALID_FLAG_VALUE",
    );
  }
  if (compiled.ir.jobs.length !== 1) {
    throw new UsageError(
      "Multi-job workflow cannot execute until job boundaries and needs have a durable runtime representation.",
      "INVALID_FLAG_VALUE",
    );
  }
  const context: ResolutionContext = { asset, config, collector, sourceIr: compiled.ir, composition, freezeChild };
  const units = new Map<string, ResolvedWorkflowUnitV4>();
  const judges = new Map<string, FrozenWorkflowCommandTarget>();
  let engineAnnouncement: string | undefined;
  const sourceSteps = compiled.ir.jobs[0]?.steps ?? [];
  for (const sourceStep of sourceSteps) {
    if (!sourceStep.route) {
      const resolved = await resolveStep(sourceStep, context);
      units.set(sourceStep.id, Object.freeze(resolved));
      engineAnnouncement ??= resolved.engineAnnouncement;
    }
    if (sourceStep.gate?.rubric?.trim()) {
      const judge = resolveJudge(sourceStep, context);
      if (judge.target.kind !== "command")
        throw new Error(`workflow judge ${sourceStep.id} did not resolve to a command target`);
      judges.set(sourceStep.id, judge.target);
      engineAnnouncement ??= judge.engineAnnouncement;
    }
  }
  return Object.freeze({
    sourceIr: compiled.ir,
    units,
    judges,
    ...(engineAnnouncement ? { engineAnnouncement } : {}),
  });
}
