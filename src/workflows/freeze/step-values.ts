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
import type { FrozenWorkflowEnvironmentBinding, FrozenWorkflowTarget } from "../ir/schema-v4";
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

export interface ResolutionContext {
  readonly asset: WorkflowAsset;
  readonly config: AkmConfig;
  readonly collector: GuardedExecutionSourceCollector;
  readonly sourceIr: WorkflowSourceIrV1;
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
