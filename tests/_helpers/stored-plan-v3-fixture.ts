// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import type { AkmConfig } from "../../src/core/config/config";
import { deepMergeConfig } from "../../src/core/config/deep-merge";
import { ConfigError } from "../../src/core/errors";
import { DEFAULT_AGENT_TIMEOUT_MS, DEFAULT_LLM_TIMEOUT_MS } from "../../src/integrations/agent/config";
import {
  FALLBACK_ANNOUNCEMENT,
  NO_ENGINE_MESSAGE_SUFFIX,
  NO_ENGINE_REMEDY,
  withEngineFallback,
} from "../../src/integrations/agent/engine-fallback";
import {
  type EngineConfig,
  type EngineUseConfig,
  resolveLlmEngineUse,
} from "../../src/integrations/agent/engine-resolution";
import { resolveLlmModel, resolveModel } from "../../src/integrations/agent/model-aliases";
import { getBuiltinAgentProfile } from "../../src/integrations/agent/profiles";
import { HARNESS_BY_ID } from "../../src/integrations/harnesses";
import {
  defaultLlmEngineConcurrency,
  defaultMapConcurrency,
  workflowMaxConcurrency,
} from "../../src/workflows/concurrency-policy";
import { type ProgramUnit, projectExecCore } from "../../src/workflows/program/schema";
import { DEFAULT_EXEC_TIMEOUT_MS } from "../../src/workflows/resource-limits";
import type { WorkflowSourceIrV1 } from "../../src/workflows/source-ir/schema";
import type { WorkflowPlanDraft, WorkflowUnitDraft } from "../../src/workflows/ir/compile";
import type {
  FrozenAgentEngine,
  FrozenEngineSnapshot,
  FrozenLlmEngine,
  IrExecSpec,
  IrGateNode,
  IrInvocation,
  IrStepPlan,
  IrUnitNode,
} from "../../src/workflows/ir/schema";

export interface StoredWorkflowPlanV3Fixture {
  execution: import("../../src/workflows/ir/schema").WorkflowPlanStructure["execution"];
  steps: IrStepPlan[];
  warnings: import("../../src/workflows/schema").WorkflowError[];
  /**
   * Set when the implicit `opencode-sdk` engine fallback supplied the engine
   * (`integrations/agent/engine-fallback.ts`). Surfaced once per run by the
   * caller — a silently-chosen model is exactly the thing that confuses a
   * reader of the resulting bill or artifact.
   */
  engineAnnouncement?: string;
}

/**
 * Resolve dispatch-significant settings for the already-compiled current plan.
 * This function does not create or decode a stored-v3 plan.
 */
export function buildStoredWorkflowPlanV3Fixture(
  sourceIr: WorkflowSourceIrV1,
  preliminary: WorkflowPlanDraft,
  warnings: import("../../src/workflows/schema").WorkflowError[],
  resolvedUnits: ReadonlyMap<string, { unit: ProgramUnit }>,
  inputConfig: AkmConfig,
): StoredWorkflowPlanV3Fixture {
  // Applied ONCE, before any resolution: every engine lookup below (selection,
  // snapshots, the gate judge) then sees one config and needs no fallback
  // awareness of its own.
  const { config, fallbackEngineName } = withEngineFallback(inputConfig);
  // Announce only if the fallback candidate is what a unit actually froze to:
  // `defaults.engine` is the lowest-precedence selector, so a document- or
  // unit-level `engine:` still wins and must not be reported as opencode's.
  let usedFallbackEngine = false;
  const engines: Record<string, FrozenEngineSnapshot> = {};
  const maxConcurrency = frozenConcurrency(config);
  const mapDefaultConcurrency = frozenMapDefaultConcurrency(config);
  const documentDefaults = sourceIr.defaults;
  const freezeInvocation = (unit: ProgramUnit | undefined, stepId: string): IrInvocation => {
    const layers: EngineUseConfig[] = [...(documentDefaults ? [documentDefaults] : []), ...(unit ? [unit] : [])];
    const name = selectedEngine(config, layers);
    if (!name)
      throw new ConfigError(
        // Reached only when the implicit opencode-sdk fallback did not apply
        // either, so the remedy names both routes.
        `This workflow ${NO_ENGINE_MESSAGE_SUFFIX} Set defaults.engine or workflow defaults.engine.`,
        "INVALID_CONFIG_FILE",
        NO_ENGINE_REMEDY,
      );
    if (name === fallbackEngineName) usedFallbackEngine = true;
    const engine = engineDefinition(config, name);
    addSnapshot(config, name, engines);
    const model = exactModel(config, name, engine, layers);
    const timeoutMs = effectiveTimeout(config, engine, layers);
    // Merge llm overrides regardless of engine kind so an ordinary agent
    // cannot silently drop them. An SDK is the intentional exception: its
    // persisted invocation projects these fields onto fallback transport.
    const llm = mergedLlmOverrides(layers);
    if (engine.kind === "agent" && engine.platform !== "opencode-sdk" && llm !== undefined) {
      throw new ConfigError(
        `Workflow step "${stepId}" uses engine "${name}", which is a non-SDK agent engine and cannot receive llm: ` +
          `overrides — llm: tuning (from the step's unit or defaults.llm) requires an LLM or SDK engine. ` +
          `Remove the llm: block or select an LLM/SDK engine for this step.`,
        "INVALID_CONFIG_FILE",
      );
    }
    return {
      engine: name,
      model,
      modelPresent: layers.some((layer) => Object.hasOwn(layer, "model")),
      timeoutMs,
      ...(llm ? { llm } : {}),
    };
  };

  /**
   * Resolve an exec unit's wall-clock budget at the single freeze boundary:
   * unit `timeout:` → document `defaults.timeout` → {@link DEFAULT_EXEC_TIMEOUT_MS}.
   * There is no engine layer to consult — an exec unit names no engine — and
   * `null` (the author's `timeout: none`) is honored as genuinely unbounded,
   * exactly like `effectiveTimeout`'s null.
   */
  const freezeExec = (exec: NonNullable<WorkflowUnitDraft["exec"]>, unit: ProgramUnit | undefined): IrExecSpec => {
    const layers: EngineUseConfig[] = [...(documentDefaults ? [documentDefaults] : []), ...(unit ? [unit] : [])];
    const declared = layeredTimeout(layers);
    const timeoutMs = declared === undefined ? DEFAULT_EXEC_TIMEOUT_MS : declared;
    // The shared structural projection, plus the one thing freezing adds: the
    // RESOLVED timeout. The default allowlist stays the ABSENCE of both env
    // keys — one encoding per state, which is what keeps the canonical hash
    // preimage stable. `command` is non-empty by parser construction.
    const core = projectExecCore(exec);
    return {
      ...core,
      command: core.command as [string, ...string[]],
      timeoutMs,
    };
  };

  const freezeUnit = (node: WorkflowUnitDraft, stepId: string, unit?: ProgramUnit): IrUnitNode => ({
    kind: "unit",
    id: node.id,
    instructions: node.instructions,
    templating: node.templating ?? "verbatim",
    ...(node.inputs && node.inputs.length > 0 ? { inputs: node.inputs } : {}),
    // An exec unit dispatches a child process, so it freezes an exec spec and
    // NO invocation — engine selection is skipped entirely, which is why an
    // exec-only workflow runs on an install with no engines configured at all.
    ...(node.exec ? { exec: freezeExec(node.exec, unit) } : { invocation: freezeInvocation(unit, stepId) }),
    ...(node.schema ? { schema: node.schema } : {}),
    ...(node.retry ? { retry: node.retry } : {}),
    onError: node.onError,
    ...(node.env ? { env: node.env } : {}),
    isolation: node.isolation ?? "none",
    ...(node.source ? { source: node.source } : {}),
  });

  const steps: IrStepPlan[] = preliminary.steps.map((step) => {
    const sourceUnit = resolvedUnits.get(step.stepId)?.unit;
    const root = step.root
      ? step.root.kind === "map"
        ? {
            kind: "map" as const,
            id: step.root.id,
            over: step.root.over,
            template: freezeUnit(step.root.template, step.stepId, sourceUnit),
            // `?? ` — not `||` — keeps an authored `concurrency: 1` (explicit
            // opt-out, serial) distinguishable from an unset one (the default).
            concurrency: step.root.concurrency ?? mapDefaultConcurrency,
            reducer: step.root.reducer,
            ...(step.root.source ? { source: step.root.source } : {}),
          }
        : freezeUnit(step.root, step.stepId, sourceUnit)
      : undefined;
    const criteria = step.gate.criteria;
    const judge = criteria.length === 0 ? null : freezeGateJudge(config, engines);
    const gate: IrGateNode = {
      kind: "gate",
      id: `${step.stepId}.gate`,
      stepId: step.stepId,
      criteria,
      maxLoops: step.gate.maxLoops ?? 1,
      judge,
    };
    return {
      stepId: step.stepId,
      title: step.title,
      sequenceIndex: step.sequenceIndex,
      ...(root ? { root } : {}),
      ...(step.route ? { route: step.route } : {}),
      ...(step.outputSchema ? { outputSchema: step.outputSchema } : {}),
      gate,
    };
  });

  // `usedFallbackEngine` IS the candidate-won predicate, so use the constant
  // directly rather than re-asking a helper to compare a name with itself.
  const engineAnnouncement = usedFallbackEngine ? FALLBACK_ANNOUNCEMENT : undefined;
  return {
    execution: { maxConcurrency, engines },
    steps,
    warnings,
    ...(engineAnnouncement ? { engineAnnouncement } : {}),
  };
}

function selectedEngine(config: AkmConfig, layers: readonly EngineUseConfig[]): string | undefined {
  for (let index = layers.length - 1; index >= 0; index--)
    if (layers[index]?.engine !== undefined) return layers[index]?.engine;
  return config.defaults?.engine;
}

function engineDefinition(config: AkmConfig, name: string): EngineConfig {
  const engine = config.engines?.[name] as EngineConfig | undefined;
  if (!engine) throw new ConfigError(`Engine "${name}" is not configured.`, "INVALID_CONFIG_FILE");
  return engine;
}

function exactModel(
  config: AkmConfig,
  name: string,
  engine: EngineConfig,
  layers: readonly EngineUseConfig[],
): string | null {
  let selected: string | undefined;
  for (const layer of layers) if (layer.model !== undefined) selected = layer.model;
  selected ??= engine.model;
  if (!selected) {
    if (engine.kind === "llm") throw new ConfigError(`LLM engine "${name}" has no model.`, "INVALID_CONFIG_FILE");
    if (engine.platform === "opencode-sdk") {
      const fallbackName = engine.llmEngine ?? config.defaults?.llmEngine;
      if (fallbackName) {
        const fallback = engineDefinition(config, fallbackName);
        if (fallback.kind !== "llm") {
          throw new ConfigError(
            `SDK engine "${name}" fallback "${fallbackName}" is not an LLM engine.`,
            "INVALID_CONFIG_FILE",
          );
        }
        return exactModel(config, fallbackName, fallback, []);
      }
    }
    return null;
  }
  if (engine.kind === "llm") return resolveLlmModel(selected, name, config.modelAliases);
  return resolveModel(selected, engine.platform, engine.modelAliases, config.modelAliases);
}

/**
 * Newest-layer-first scan for a declared `timeoutMs` across authoring layers
 * (document `defaults`, then the unit). Returns `undefined` when no layer
 * declares one; an explicit `timeoutMs: null` ("unbounded") wins over deeper
 * layers — hence `hasOwn`, not a value test. The ONE definition of authoring
 * timeout precedence, shared by engine and exec freezing.
 */
function layeredTimeout(layers: readonly EngineUseConfig[]): number | null | undefined {
  for (let index = layers.length - 1; index >= 0; index--) {
    if (Object.hasOwn(layers[index] ?? {}, "timeoutMs")) return layers[index]?.timeoutMs ?? null;
  }
  return undefined;
}

function effectiveTimeout(config: AkmConfig, engine: EngineConfig, layers: readonly EngineUseConfig[]): number | null {
  const declared = layeredTimeout(layers);
  if (declared !== undefined) return declared;
  if (Object.hasOwn(engine, "timeoutMs")) return engine.timeoutMs ?? null;
  if (engine.kind === "llm") return DEFAULT_LLM_TIMEOUT_MS;
  if (engine.platform === "opencode-sdk") {
    const fallbackName = engine.llmEngine ?? config.defaults?.llmEngine;
    if (fallbackName) {
      const fallback = engineDefinition(config, fallbackName);
      if (fallback.kind === "llm") {
        return Object.hasOwn(fallback, "timeoutMs") ? (fallback.timeoutMs ?? null) : DEFAULT_LLM_TIMEOUT_MS;
      }
    }
  }
  return DEFAULT_AGENT_TIMEOUT_MS;
}

function mergedLlmOverrides(layers: readonly EngineUseConfig[]): Record<string, unknown> | undefined {
  let merged: Record<string, unknown> | undefined;
  for (const layer of layers)
    if (layer.llm) merged = deepMergeConfig(merged ?? {}, layer.llm as Record<string, unknown>);
  return merged;
}

function addSnapshot(config: AkmConfig, name: string, target: Record<string, FrozenEngineSnapshot>): void {
  if (target[name]) return;
  const engine = engineDefinition(config, name);
  if (engine.kind === "llm") {
    const resolved = resolveLlmEngineUse(config, [{ engine: name }]);
    const snapshot: FrozenLlmEngine = {
      name,
      kind: "llm",
      endpoint: engine.endpoint,
      model: exactModel(config, name, engine, []) as string,
      timeoutMs: resolved.timeoutMs,
      concurrency: defaultLlmEngineConcurrency(engine.endpoint, engine.concurrency),
      ...(engine.provider ? { provider: engine.provider } : {}),
      ...(resolved.credential ? { credential: resolved.credential } : {}),
      ...(engine.temperature !== undefined ? { temperature: engine.temperature } : {}),
      ...(engine.maxTokens !== undefined ? { maxTokens: engine.maxTokens } : {}),
      ...(engine.supportsJsonSchema !== undefined ? { supportsJsonSchema: engine.supportsJsonSchema } : {}),
      ...(engine.extraParams ? { extraParams: engine.extraParams } : {}),
      ...(engine.contextLength !== undefined ? { contextLength: engine.contextLength } : {}),
      ...(engine.enableThinking !== undefined ? { enableThinking: engine.enableThinking } : {}),
      ...(engine.reasoningEffort !== undefined ? { reasoningEffort: engine.reasoningEffort } : {}),
    };
    target[name] = snapshot;
    return;
  }
  const harness = HARNESS_BY_ID.get(engine.platform);
  if (!harness?.capabilities.agentDispatch)
    throw new ConfigError(`Engine "${name}" cannot dispatch platform ${engine.platform}.`, "INVALID_CONFIG_FILE");
  const sdk = engine.platform === "opencode-sdk";
  const builtin = getBuiltinAgentProfile(engine.platform);
  const fallback = sdk ? (engine.llmEngine ?? config.defaults?.llmEngine ?? null) : null;
  if (fallback) addSnapshot(config, fallback, target);
  const snapshot: FrozenAgentEngine = {
    name,
    kind: "agent",
    runnerKind: sdk ? "sdk" : "agent",
    platform: engine.platform,
    bin: engine.bin ?? builtin?.bin ?? (sdk ? "opencode" : engine.platform),
    args: [...(engine.args ?? builtin?.args ?? [])],
    workspace: engine.workspace ? path.resolve(engine.workspace) : null,
    envPassthrough: [...(builtin?.envPassthrough ?? [])],
    commandBuilder: engine.platform,
    fallbackLlmEngine: fallback,
    sdkFallbackModelFromRequest: sdk && !Object.hasOwn(engine, "model") && fallback !== null,
  };
  target[name] = snapshot;
}

function freezeGateJudge(config: AkmConfig, engines: Record<string, FrozenEngineSnapshot>): IrInvocation {
  const name = config.workflow?.judgeEngine;
  if (!name) {
    throw new ConfigError(
      "This workflow declares completion criteria but no verification engine is configured. Set workflow.judgeEngine to a named LLM or agent engine.",
      "INVALID_CONFIG_FILE",
    );
  }
  const engine = engineDefinition(config, name);
  addSnapshot(config, name, engines);
  return {
    engine: name,
    model: exactModel(config, name, engine, []),
    modelPresent: false,
    timeoutMs: effectiveTimeout(config, engine, []),
  };
}

function frozenConcurrency(config: AkmConfig): number {
  const configured = config.workflow?.maxConcurrency;
  return workflowMaxConcurrency(typeof configured === "number" && Number.isFinite(configured) ? configured : undefined);
}

/**
 * Width to freeze into a `map` node that declared no `concurrency:`. Resolved
 * HERE, at the single freeze boundary, so the number lands in `plan_json` and
 * an in-flight run keeps the width it started with even if this default (or
 * the config key) changes underneath it.
 */
function frozenMapDefaultConcurrency(config: AkmConfig): number {
  const configured = config.workflow?.defaultMapConcurrency;
  return defaultMapConcurrency(typeof configured === "number" ? configured : undefined);
}
