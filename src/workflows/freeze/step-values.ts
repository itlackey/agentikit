// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Freeze-time shared context, plain-data types, and step-value helpers used by
 * BOTH `resolve-steps.ts`'s routing and every `targets/*.ts` dispatcher (spec
 * docs/plans/specs/p2b-input-bindings.md §3.1, A-N1's circular-import note).
 *
 * This module is a deliberate LEAF: it imports nothing from a sibling
 * `workflows/freeze/**` file, so anything placed here can be depended on by
 * `resolve-steps.ts`, `environment.ts`, and every `targets/*.ts` module
 * without creating a static import cycle
 * (`tests/architecture/import-cycle-ratchet.test.ts`, shrink-only, empty
 * baseline). `resolveStep`/`resolveJudge` (routing) need to call into
 * `targets/*.ts`, and `targets/*.ts` need this module's helpers — sharing a
 * helper-defining file between the two directions would cycle, so the shared
 * surface lives here instead, exactly as A-N1 anticipates.
 *
 * `ResolvedDispatch` is intentionally NOT declared as `extends
 * ResolvedWorkflowUnitV4` (its base at `source-freeze.ts`, matching the
 * original single-file definition byte-for-byte in field shape): the two
 * fields `ResolvedDispatch` used to redeclare (`unit`, `instructions`) were
 * already required on the base with identical types, so this is a
 * zero-behavior-change, purely structural inlining — importing
 * `ResolvedWorkflowUnitV4` here instead would reintroduce the same cycle
 * (`source-freeze.ts` calls `resolveStep`/`resolveJudge`, which return this
 * type).
 */

import type { AkmConfig } from "../../core/config/config-types";
import type { GuardedExecutionSourceCollector } from "../../execution/guarded-source";
import {
  canonicalResolvedExecutionRequest,
  decodeResolvedExecutionRequest,
  type ResolvedExecutionRequestV1,
} from "../../execution/resolved-request";
import type { UnresolvedExecutionDefaults } from "../../execution/source";
import type { RunnerSpec } from "../../integrations/agent/runner";
import { defaultLlmEngineConcurrency } from "../concurrency-policy";
import type { IrExecSpec } from "../ir/schema";
import type { FrozenWorkflowEnvironmentBinding, FrozenWorkflowTarget, WorkflowPlanGraphV4 } from "../ir/schema-v4";
import type { ProgramExec, ProgramUnit } from "../program/schema";
import { DEFAULT_EXEC_TIMEOUT_MS } from "../resource-limits";
import type { WorkflowAsset } from "../runtime/workflow-asset-loader";
import type { WorkflowSourceIrV1, WorkflowSourceStep } from "../source-ir/schema";

export interface OwnedAsset {
  readonly ref: string;
  readonly bundle: string;
  readonly adapter: string;
  readonly root: string;
  readonly file: string;
}

/**
 * Recursive child-workflow composition state, threaded through freeze (spec
 * docs/plans/specs/p3a-plan-v5-child-freeze.md §4.3). Declared HERE — the
 * deliberate leaf — rather than in `targets/child-workflow.ts`: `ir/freeze-v4.ts`
 * (which is NOT downstream of this module) needs this type to build the
 * root `ResolutionContext`'s default, and `targets/child-workflow.ts` IS
 * downstream of `ir/freeze-v4.ts` (via `resolve-steps.ts` <- `source-freeze.ts`,
 * which `ir/freeze-v4.ts` imports directly — P4 deleted the
 * `ir/source-freeze-v4.ts` shim that used to sit on this edge), so an
 * import from `ir/freeze-v4.ts`
 * into `targets/child-workflow.ts` — or into this module, were the type
 * declared there instead — would close a static import cycle
 * (`tests/architecture/import-cycle-ratchet.test.ts`, shrink-only, empty
 * baseline).
 */
export interface ChildCompositionContext {
  /** 0 at the root workflow; +1 per child freeze. */
  readonly depth: number;
  /** Refs from the root to the current workflow, in order. Task refs appear for legibility (row B-22). */
  readonly refPath: readonly string[];
  /** MUTABLE accumulator shared by the ENTIRE freeze tree (A-N6's aggregate embedded-bytes bound). */
  readonly budget: { embeddedBytes: number };
}

/**
 * One recursive child-workflow freeze request (A-N7: the child freezes with
 * its OWN fresh `GuardedExecutionSourceCollector`, then the parent absorbs
 * it). Issued by `targets/child-workflow.ts` through
 * `ResolutionContext.freezeChild` rather than a direct import of
 * `compileResolveFreezeWorkflowV4` (`ir/freeze-v4.ts`), for the same
 * cycle-avoidance reason {@link ChildCompositionContext} documents:
 * `ir/freeze-v4.ts` injects the real implementation as a plain function
 * VALUE when it builds the root context, so no `freeze/targets/**` module
 * ever needs a static import of `ir/freeze-v4.ts`.
 */
export interface ChildFreezeRequest {
  readonly asset: WorkflowAsset;
  readonly sourceCollector: GuardedExecutionSourceCollector;
  readonly composition: ChildCompositionContext;
}

/**
 * The recursive freeze's result — exactly what `targets/child-workflow.ts`
 * needs (the embedded plan and the child's own collector to absorb). A
 * structural SUBSET of `FrozenWorkflowV4` (`ir/freeze-v4.ts`), which is not
 * imported here for the cycle-avoidance reason {@link ChildCompositionContext}
 * documents — `ir/freeze-v4.ts`'s own `FrozenWorkflowV4` satisfies this shape
 * without a cast.
 */
export interface ChildFreezeResult {
  readonly plan: WorkflowPlanGraphV4;
  readonly sourceCollector: GuardedExecutionSourceCollector;
}

export type ChildFreezeFn = (request: ChildFreezeRequest) => Promise<ChildFreezeResult>;

export interface ResolutionContext {
  readonly asset: WorkflowAsset;
  readonly config: AkmConfig;
  readonly collector: GuardedExecutionSourceCollector;
  readonly sourceIr: WorkflowSourceIrV1;
  readonly composition: ChildCompositionContext;
  readonly freezeChild: ChildFreezeFn;
}

export interface ResolvedDispatch {
  readonly target: FrozenWorkflowTarget;
  readonly environment: readonly FrozenWorkflowEnvironmentBinding[];
  readonly unit: ProgramUnit;
  readonly instructions: string;
  readonly engineAnnouncement?: string;
}

export function freezeExecSpec(source: WorkflowSourceStep, exec: ProgramExec, context: ResolutionContext): IrExecSpec {
  const declared = Object.hasOwn(source.unit ?? {}, "timeoutMs")
    ? source.unit?.timeoutMs
    : context.sourceIr.defaults && Object.hasOwn(context.sourceIr.defaults, "timeoutMs")
      ? context.sourceIr.defaults.timeoutMs
      : undefined;
  return {
    ...exec,
    command: exec.command as [string, ...string[]],
    timeoutMs: declared === undefined ? DEFAULT_EXEC_TIMEOUT_MS : declared,
  };
}

export function targetConcurrency(runner: RunnerSpec, config: AkmConfig): number | undefined {
  if (runner.kind === "llm") {
    const configured = typeof runner.engine === "string" ? config.engines?.[runner.engine] : undefined;
    return defaultLlmEngineConcurrency(
      runner.connection.endpoint,
      configured?.kind === "llm" ? configured.concurrency : undefined,
    );
  }
  if (runner.kind !== "sdk" || !runner.fallbackConnection) return undefined;
  const selected = typeof runner.engine === "string" ? config.engines?.[runner.engine] : undefined;
  const fallbackName = selected?.kind === "agent" ? (selected.llmEngine ?? config.defaults?.llmEngine) : undefined;
  const fallback = fallbackName ? config.engines?.[fallbackName] : undefined;
  return defaultLlmEngineConcurrency(
    runner.fallbackConnection.endpoint,
    fallback?.kind === "llm" ? fallback.concurrency : undefined,
  );
}

export function durableRequest(request: ResolvedExecutionRequestV1): ResolvedExecutionRequestV1 {
  const wire = JSON.parse(canonicalResolvedExecutionRequest(request)) as Record<string, unknown>;
  const runtime = { ...(wire.runtime as Record<string, unknown>) };
  delete runtime.environment;
  wire.runtime = runtime;
  return decodeResolvedExecutionRequest(wire);
}

export function executionValues(source: WorkflowSourceStep, workspace: string): UnresolvedExecutionDefaults {
  return executionUnitValues(source.unit, workspace);
}

export function executionUnitValues(
  unit: WorkflowSourceStep["unit"] | WorkflowSourceIrV1["defaults"],
  workspace: string,
): UnresolvedExecutionDefaults {
  return Object.freeze({
    ...(unit && Object.hasOwn(unit, "engine") ? { engine: unit.engine } : {}),
    ...(unit && Object.hasOwn(unit, "model") ? { model: unit.model } : {}),
    ...(unit && Object.hasOwn(unit, "llm") ? { inference: unit.llm } : {}),
    ...(unit && Object.hasOwn(unit, "timeoutMs") ? { timeout: unit.timeoutMs } : {}),
    ...(unit && "output" in unit && Object.hasOwn(unit, "output") ? { outputSchema: unit.output } : {}),
    workspace,
  }) as UnresolvedExecutionDefaults;
}

/**
 * Step ids that appear BEFORE `stepId` in the frozen step order (A-N4) — the
 * SAME ordering map.over/inputs[] rely on. Shared by `targets/task.ts` (a
 * step's own `with:` against its composed task's declared `inputs:`) and
 * `targets/child-workflow.ts` (the SAME step's effective inputs, re-bound
 * against a composed child workflow's declared `params:`, spec A-N8) — moved
 * here rather than duplicated so both can import it without either importing
 * the other.
 */
export function earlierStepIds(sourceIr: WorkflowSourceIrV1, stepId: string): ReadonlySet<string> {
  const steps = sourceIr.jobs[0]?.steps ?? [];
  const index = steps.findIndex((step) => step.id === stepId);
  return new Set(index < 0 ? [] : steps.slice(0, index).map((step) => step.id));
}

/** THIS workflow's own declared param names (A-N4) — never an outer composing task's. See {@link earlierStepIds}. */
export function declaredParamNames(sourceIr: WorkflowSourceIrV1): ReadonlySet<string> {
  return new Set(sourceIr.params ? Object.keys(sourceIr.params) : []);
}
