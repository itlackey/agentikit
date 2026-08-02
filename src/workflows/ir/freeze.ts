// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import type { AkmConfig } from "../../core/config/config";
import { deepMergeConfig } from "../../core/config/deep-merge";
import { ConfigError, UsageError } from "../../core/errors";
import { DEFAULT_AGENT_TIMEOUT_MS, DEFAULT_LLM_TIMEOUT_MS } from "../../integrations/agent/config";
import { NO_ENGINE_REMEDY, withEngineFallback } from "../../integrations/agent/engine-fallback";
import {
  type EngineConfig,
  type EngineUseConfig,
  resolveLlmEngineUse,
} from "../../integrations/agent/engine-resolution";
import { resolveLlmModel, resolveModel } from "../../integrations/agent/model-aliases";
import { getBuiltinAgentProfile } from "../../integrations/agent/profiles";
import { HARNESS_BY_ID } from "../../integrations/harnesses";
import { workflowMaxConcurrency } from "../concurrency-policy";
import type { ProgramUnit } from "../program/schema";
import type { WorkflowAsset } from "../runtime/workflow-asset-loader";
import { compileWorkflowPlan, type WorkflowPlanDraft, type WorkflowUnitDraft } from "./compile";
import type {
  FrozenAgentEngine,
  FrozenEngineSnapshot,
  FrozenLlmEngine,
  IrGateNode,
  IrInvocation,
  IrStepPlan,
  IrUnitNode,
  WorkflowPlanGraph,
} from "./schema";
import { decodeWorkflowPlanV3, WORKFLOW_IR_VERSION } from "./schema";

export interface FrozenWorkflow {
  plan: WorkflowPlanGraph;
  warnings: import("../schema").WorkflowError[];
  /**
   * Set when the implicit `opencode-sdk` engine fallback supplied the engine
   * (`integrations/agent/engine-fallback.ts`). Surfaced once per run by the
   * caller — a silently-chosen model is exactly the thing that confuses a
   * reader of the resulting bill or artifact.
   */
  engineAnnouncement?: string;
}

/**
 * The only source-to-runtime boundary. Source compilation remains pure; engine
 * selection and every dispatch-significant setting are resolved here once.
 */
export function compileResolveFreezeWorkflow(asset: WorkflowAsset, inputConfig: AkmConfig): FrozenWorkflow {
  // Applied ONCE, before any resolution: every engine lookup below (selection,
  // snapshots, the gate judge) then sees one config and needs no fallback
  // awareness of its own.
  const { config, announcement: engineAnnouncement } = withEngineFallback(inputConfig);
  const preliminary = compilePlan(asset);
  const engines: Record<string, FrozenEngineSnapshot> = {};
  const maxConcurrency = frozenConcurrency(config);
  const documentDefaults = asset.document.defaults;

  const freezeInvocation = (unit: ProgramUnit | undefined): IrInvocation => {
    const layers: EngineUseConfig[] = [...(documentDefaults ? [documentDefaults] : []), ...(unit ? [unit] : [])];
    const name = selectedEngine(config, layers);
    if (!name)
      throw new ConfigError(
        // Reached only when the implicit opencode-sdk fallback did not apply
        // either — i.e. `opencode` is not on PATH — so the remedy names both
        // routes.
        "No workflow engine is selected and `opencode` is not on PATH. Set defaults.engine or workflow defaults.engine.",
        "INVALID_CONFIG_FILE",
        NO_ENGINE_REMEDY,
      );
    const engine = engineDefinition(config, name);
    addSnapshot(config, name, engines);
    const model = exactModel(config, name, engine, layers);
    const timeoutMs = effectiveTimeout(config, engine, layers);
    const llm = engine.kind === "llm" ? mergedLlmOverrides(layers) : undefined;
    if (engine.kind !== "llm" && llm !== undefined) {
      throw new ConfigError(
        `Workflow engine "${name}" is an agent engine and cannot receive llm overrides.`,
        "INVALID_CONFIG_FILE",
      );
    }
    return { engine: name, model, timeoutMs, ...(llm ? { llm } : {}) };
  };

  const freezeUnit = (node: WorkflowUnitDraft, unit?: ProgramUnit): IrUnitNode => ({
    kind: "unit",
    id: node.id,
    instructions: node.instructions,
    templating: node.templating ?? "verbatim",
    ...(node.inputs && node.inputs.length > 0 ? { inputs: node.inputs } : {}),
    invocation: freezeInvocation(unit),
    ...(node.schema ? { schema: node.schema } : {}),
    ...(node.retry ? { retry: node.retry } : {}),
    onError: node.onError,
    ...(node.env ? { env: node.env } : {}),
    isolation: node.isolation ?? "none",
    ...(node.source ? { source: node.source } : {}),
  });

  const steps: IrStepPlan[] = preliminary.steps.map((step, index) => {
    const sourceStep = asset.document.steps[index];
    const sourceUnit = sourceStep?.map ? sourceStep.map.unit : sourceStep?.unit;
    const root = step.root
      ? step.root.kind === "map"
        ? {
            kind: "map" as const,
            id: step.root.id,
            over: step.root.over,
            template: freezeUnit(step.root.template, sourceUnit),
            concurrency: step.root.concurrency ?? 1,
            reducer: step.root.reducer,
            ...(step.root.source ? { source: step.root.source } : {}),
          }
        : freezeUnit(step.root, sourceUnit)
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

  const plan = decodeWorkflowPlanV3({
    irVersion: WORKFLOW_IR_VERSION,
    title: preliminary.title,
    ...(preliminary.params ? { params: preliminary.params } : {}),
    ...(preliminary.paramSchemas ? { paramSchemas: preliminary.paramSchemas } : {}),
    ...(preliminary.budget ? { budget: preliminary.budget } : {}),
    execution: { maxConcurrency, engines },
    steps,
  });
  return {
    warnings: preliminary.warnings,
    ...(engineAnnouncement ? { engineAnnouncement } : {}),
    plan,
  };
}

function compilePlan(asset: WorkflowAsset): WorkflowPlanDraft & { warnings: import("../schema").WorkflowError[] } {
  const compiled = compileWorkflowPlan(asset.document, asset.title);
  if (!compiled.ok)
    throw new UsageError(compiled.errors.map((error) => `${asset.path}:${error.line}: ${error.message}`).join("\n"));
  return { ...compiled.plan, warnings: compiled.warnings };
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

function effectiveTimeout(config: AkmConfig, engine: EngineConfig, layers: readonly EngineUseConfig[]): number | null {
  for (let index = layers.length - 1; index >= 0; index--) {
    if (Object.hasOwn(layers[index] ?? {}, "timeoutMs")) return layers[index]?.timeoutMs ?? null;
  }
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
      concurrency: engine.concurrency ?? 1,
      ...(engine.provider ? { provider: engine.provider } : {}),
      ...(resolved.credential ? { credential: resolved.credential } : {}),
      ...(engine.temperature !== undefined ? { temperature: engine.temperature } : {}),
      ...(engine.maxTokens !== undefined ? { maxTokens: engine.maxTokens } : {}),
      ...(engine.supportsJsonSchema !== undefined ? { supportsJsonSchema: engine.supportsJsonSchema } : {}),
      ...(engine.extraParams ? { extraParams: engine.extraParams } : {}),
      ...(engine.contextLength !== undefined ? { contextLength: engine.contextLength } : {}),
      ...(engine.enableThinking !== undefined ? { enableThinking: engine.enableThinking } : {}),
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
    timeoutMs: effectiveTimeout(config, engine, []),
  };
}

function frozenConcurrency(config: AkmConfig): number {
  const configured = config.workflow?.maxConcurrency;
  return workflowMaxConcurrency(typeof configured === "number" && Number.isFinite(configured) ? configured : undefined);
}
