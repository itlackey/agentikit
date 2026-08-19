// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AkmConfig, EngineConfig } from "../../core/config/config-types";
import { ConfigError } from "../../core/errors";
import { cloneExecutionJsonObject } from "../../execution/json";
import {
  createInlineResolvedCommand,
  createResolvedCommand,
  createResolvedPersona,
  type LoweringNotice,
  type ResolvedCommandContent,
  type ResolvedExecutionRequestV1,
} from "../../execution/resolved-request";
import {
  type AdapterRenderedCommandSource,
  type AdapterRenderedExecutionSource,
  type AdapterRenderedPersonaSource,
  isPortableExecutionAgentSelector,
  type UnresolvedExecutionDefaults,
} from "../../execution/source";
import type { AgentDispatchRequest } from "../../integrations/agent/builder-shared";
import {
  fallbackAnnouncement,
  NO_ENGINE_MESSAGE_SUFFIX,
  NO_ENGINE_REMEDY,
  withEngineFallback,
} from "../../integrations/agent/engine-fallback";
import { resolveEngine } from "../../integrations/agent/engine-resolution";
import {
  type ExecutionEngineDefinition,
  planExecutionCascade,
  type ResolvedExecutionPlanV1,
  requireAuthorizedExecutionPlan,
  type ToolAuthorizer,
} from "../../integrations/agent/execution-cascade";
import { loadModelMap, type ResolvedModelMapV1 } from "../../integrations/agent/model-map";
import { composePersonaFallbackPrompt } from "../../integrations/agent/persona-fallback";
import type { RunnerSpec } from "../../integrations/agent/runner";
import { executeRunner } from "../../integrations/agent/runner-dispatch";
import type { AgentRunResult, RunAgentOptions } from "../../integrations/agent/spawn";
import { chatCompletion } from "../../llm/client";
import { parseBuiltinCommandAction } from "./builtin-action";
import { type LoadAdapterExecutionSourceOptions, loadAdapterExecutionSource } from "./execution-source-loader";
import { applyPortableCommandArguments } from "./portable-template";

export type CommandExecutionSourceLoader = (
  ref: string,
  kind: "command" | "persona",
  options?: LoadAdapterExecutionSourceOptions,
) => Promise<AdapterRenderedExecutionSource>;

export interface PrepareCommandInvocationOptions {
  readonly action: unknown;
  readonly config: AkmConfig;
  readonly modelMap?: ResolvedModelMapV1;
  readonly sourceLoader?: CommandExecutionSourceLoader;
  readonly invocationDefaults?: UnresolvedExecutionDefaults;
  readonly current?: UnresolvedExecutionDefaults;
  readonly authorizeTools?: ToolAuthorizer;
}

export interface PreparedCommandInvocation {
  readonly plan: ResolvedExecutionPlanV1;
  readonly request: ResolvedExecutionRequestV1;
  readonly config: AkmConfig;
  readonly fallbackEngineName?: string;
}

export interface CommandDispatchResult {
  readonly schemaVersion: 2;
  readonly ok: boolean;
  readonly shape: "agent-result";
  readonly engine: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly error?: string;
  readonly reason?: string;
  readonly warnings?: readonly string[];
  readonly notices?: readonly Readonly<LoweringNotice>[];
}

export interface DispatchPreparedCommandOptions {
  readonly executeRunner?: typeof executeRunner;
  readonly chat?: typeof chatCompletion;
}

function own(value: object, key: PropertyKey): boolean {
  return Object.hasOwn(value, key);
}

function ownValue<T extends object, K extends keyof T>(value: T, key: K): T[K] | undefined {
  return own(value, key) ? value[key] : undefined;
}

function sterileRecord<T extends object>(value: T): T {
  return Object.assign(Object.create(null), value) as T;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function engineDefaults(engine: EngineConfig): UnresolvedExecutionDefaults {
  const defaults: Record<string, unknown> = {};
  if (own(engine, "model")) defaults.model = engine.model;
  if (own(engine, "timeoutMs")) defaults.timeout = engine.timeoutMs;
  if (engine.kind === "agent" && own(engine, "workspace")) defaults.workspace = engine.workspace;
  if (engine.kind === "llm") {
    const inference = withoutUndefined({
      temperature: ownValue(engine, "temperature"),
      maxTokens: ownValue(engine, "maxTokens"),
      supportsJsonSchema: ownValue(engine, "supportsJsonSchema"),
      extraParams: ownValue(engine, "extraParams"),
      contextLength: ownValue(engine, "contextLength"),
      enableThinking: ownValue(engine, "enableThinking"),
    });
    if (Object.keys(inference).length > 0) defaults.inference = inference;
  }
  return Object.freeze(defaults) as UnresolvedExecutionDefaults;
}

/** Project validated config engines into the pure cascade's engine registry. */
export function executionEngineDefinitionsFromConfig(
  config: AkmConfig,
): Readonly<Record<string, ExecutionEngineDefinition>> {
  const definitions: Record<string, ExecutionEngineDefinition> = Object.create(null);
  for (const [name, engine] of Object.entries(ownValue(config, "engines") ?? {})) {
    const platform = engine.kind === "agent" ? engine.platform : (ownValue(engine, "provider") ?? name);
    const settings =
      engine.kind === "agent"
        ? withoutUndefined({
            bin: ownValue(engine, "bin"),
            args: ownValue(engine, "args"),
            workspace: ownValue(engine, "workspace"),
          })
        : withoutUndefined({ endpoint: engine.endpoint, provider: ownValue(engine, "provider") });
    const engineModelAliases = engine.kind === "agent" ? ownValue(engine, "modelAliases") : undefined;
    const globalModelAliases = ownValue(config, "modelAliases");
    definitions[name] = Object.freeze({
      selection: Object.freeze({
        name,
        kind: engine.kind === "llm" ? "llm" : engine.platform === "opencode-sdk" ? "sdk" : "agent",
        platform,
        ...(Object.keys(settings).length > 0
          ? { settings: cloneExecutionJsonObject(settings, `engines.${name}.settings`) }
          : {}),
      }),
      defaults: engineDefaults(engine),
      modelMapKey: engine.kind === "agent" ? engine.platform : name,
      modelCompatibility: Object.freeze({
        ...(engineModelAliases ? { engineAliases: engineModelAliases } : {}),
        ...(globalModelAliases ? { globalAliases: globalModelAliases } : {}),
        fallbackEngines: engine.kind === "llm" ? [platform, "llm"] : [],
      }),
    });
  }
  return Object.freeze(definitions);
}

function selectAgent(
  command: UnresolvedExecutionDefaults,
  invocationDefaults: UnresolvedExecutionDefaults | undefined,
  current: UnresolvedExecutionDefaults | undefined,
): { present: boolean; value?: string | null; source: "command" | "invocation" | "current" } {
  let selected: { present: boolean; value?: string | null; source: "command" | "invocation" | "current" } = {
    present: false,
    source: "command",
  };
  for (const [source, values] of [
    ["command", command],
    ["invocation", invocationDefaults],
    ["current", current],
  ] as const) {
    if (values && own(values, "agent")) selected = { present: true, value: values.agent, source };
  }
  return selected;
}

function defaultSourceLoader(
  ref: string,
  kind: "command" | "persona",
  options?: LoadAdapterExecutionSourceOptions,
): Promise<AdapterRenderedExecutionSource> {
  return kind === "command"
    ? loadAdapterExecutionSource(ref, "command", options)
    : loadAdapterExecutionSource(ref, "persona", options);
}

function qualifyCommandSelectedPersona(selector: string, command: AdapterRenderedCommandSource | undefined): string {
  if (!command || selector.includes("//")) return selector;
  return `${command.identity.bundle}//${selector}`;
}

function snapshotCommandConfig(config: AkmConfig, path = "command config"): AkmConfig {
  return cloneExecutionJsonObject(config, path) as unknown as AkmConfig;
}

export async function prepareCommandInvocation(
  options: PrepareCommandInvocationOptions,
): Promise<PreparedCommandInvocation> {
  const inputConfig = snapshotCommandConfig(options.config, "command input config");
  const action = parseBuiltinCommandAction(options.action);
  const sourceLoader = options.sourceLoader ?? defaultSourceLoader;
  let renderedCommand: AdapterRenderedCommandSource | undefined;
  let commandDefaults: UnresolvedExecutionDefaults = Object.freeze({});
  let command: ResolvedCommandContent;
  if (action.kind === "stored") {
    const rendered = await sourceLoader(action.ref, "command", { config: inputConfig });
    if (rendered.kind !== "command") throw new TypeError("command source loader returned a non-command source");
    renderedCommand = rendered;
    commandDefaults = rendered.defaults;
    const applied = applyPortableCommandArguments(rendered.content, action.arguments, rendered.identity.ref);
    command = createResolvedCommand({
      source: rendered,
      ...(own(applied, "argumentInput") ? { argumentInput: applied.argumentInput } : {}),
      content: applied.content,
    });
  } else {
    const applied = applyPortableCommandArguments(action.content, action.arguments, "inline command");
    command = createInlineResolvedCommand({
      template: applied.template,
      ...(own(applied, "argumentInput") ? { argumentInput: applied.argumentInput } : {}),
      content: applied.content,
    });
  }

  const selectedAgent = selectAgent(commandDefaults, options.invocationDefaults, options.current);
  let renderedPersona: AdapterRenderedPersonaSource | undefined;
  if (
    selectedAgent.present &&
    typeof selectedAgent.value === "string" &&
    isPortableExecutionAgentSelector(selectedAgent.value)
  ) {
    const lookupRef =
      selectedAgent.source === "command"
        ? qualifyCommandSelectedPersona(selectedAgent.value, renderedCommand)
        : selectedAgent.value;
    const rendered = await sourceLoader(lookupRef, "persona", { config: inputConfig });
    if (rendered.kind !== "persona") throw new TypeError("persona source loader returned a non-persona source");
    renderedPersona = rendered;
  }
  const persona = renderedPersona ? createResolvedPersona(renderedPersona) : selectedAgent.present ? null : undefined;

  const fallback = withEngineFallback(inputConfig);
  const resolvedConfig = snapshotCommandConfig(fallback.config, "resolved command config");
  const installationValues: Record<string, unknown> = {};
  const resolvedDefaults = ownValue(resolvedConfig, "defaults");
  const defaultEngine = resolvedDefaults ? ownValue(resolvedDefaults, "engine") : undefined;
  if (defaultEngine) installationValues.engine = defaultEngine;
  const plan = planExecutionCascade({
    command,
    ...(persona !== undefined ? { persona } : {}),
    layers: {
      installation: { id: "installation-defaults", values: installationValues },
      ...(renderedPersona ? { agent: { id: renderedPersona.identity.ref, values: renderedPersona.defaults } } : {}),
      command: {
        id: renderedCommand?.identity.ref ?? "inline-command",
        values: commandDefaults,
      },
      ...(options.invocationDefaults
        ? { invocationDefaults: { id: "invocation-defaults", values: options.invocationDefaults } }
        : {}),
      ...(options.current ? { current: { id: "current-invocation", values: options.current } } : {}),
    },
    engines: executionEngineDefinitionsFromConfig(resolvedConfig),
    modelMap: options.modelMap ?? loadModelMap().map,
    invocationKind: "direct",
    ...(options.authorizeTools ? { authorizeTools: options.authorizeTools } : {}),
  });
  return Object.freeze({
    plan,
    request: plan.request,
    config: resolvedConfig,
    ...(fallback.fallbackEngineName ? { fallbackEngineName: fallback.fallbackEngineName } : {}),
  });
}

function lowerRunner(request: ResolvedExecutionRequestV1, config: AkmConfig): RunnerSpec {
  const runner = resolveEngine(request.engine.name, config);
  const timeoutMs = own(request.runtime, "timeoutMs") ? request.runtime.timeoutMs : runner.timeoutMs;
  const model = ownValue(request, "model");
  const workspace = ownValue(request.runtime, "workspace");
  if (runner.kind === "llm") {
    const connection = sterileRecord<Record<string, unknown>>({ ...runner.connection });
    // These fields participated in the common cascade. Remove the raw engine
    // copy first so explicit null really clears it instead of allowing
    // resolveEngine() to reintroduce a farther configured default.
    for (const key of [
      "model",
      "temperature",
      "maxTokens",
      "supportsJsonSchema",
      "extraParams",
      "contextLength",
      "enableThinking",
    ]) {
      delete connection[key];
    }
    const inference = ownValue(request, "inference");
    if (inference) {
      for (const key of [
        "temperature",
        "maxTokens",
        "supportsJsonSchema",
        "extraParams",
        "contextLength",
        "enableThinking",
      ] as const) {
        if (own(inference, key)) connection[key] = inference[key];
      }
    }
    // Model selection and transport identity are separate from inference.
    // Applying the resolved model last also prevents arbitrary inference data
    // from redirecting a request or changing its selected model.
    if (model) connection.model = model.resolved;
    return { ...runner, connection, ...(timeoutMs !== undefined ? { timeoutMs } : {}) } as RunnerSpec;
  }
  const profile = sterileRecord({ ...runner.profile });
  delete profile.model;
  delete profile.modelIsExact;
  delete profile.workspace;
  if (model) Object.assign(profile, { model: model.resolved, modelIsExact: true });
  if (typeof workspace === "string") profile.workspace = workspace;
  return { ...runner, profile, ...(timeoutMs !== undefined ? { timeoutMs } : {}) } as RunnerSpec;
}

function dispatchRequest(
  request: ResolvedExecutionRequestV1,
  prompt: string,
  systemPrompt: string | undefined,
): AgentDispatchRequest {
  const inference = ownValue(request, "inference");
  const model = ownValue(request, "model");
  const outputSchema = ownValue(request, "outputSchema");
  const effort = inference && typeof inference.effort === "string" ? inference.effort : undefined;
  return sterileRecord({
    prompt,
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(model ? { model: model.resolved, modelIsExact: true } : {}),
    ...(own(request, "tools") ? { tools: request.tools as AgentDispatchRequest["tools"] } : {}),
    ...(effort ? { effort } : {}),
    ...(outputSchema ? { schema: outputSchema as Record<string, unknown> } : {}),
  });
}

interface LoweredCommandDispatch {
  readonly prompt: string;
  readonly request: AgentDispatchRequest;
  readonly notices: readonly Readonly<LoweringNotice>[];
}

function lowerCommandDispatch(request: ResolvedExecutionRequestV1, runner: RunnerSpec): LoweredCommandDispatch {
  const selectedPersona = ownValue(request, "persona");
  const persona = selectedPersona?.content;
  if (persona !== undefined && runner.kind !== "llm" && runner.profile.personaChannel !== "native") {
    const adapter = runner.profile.platform ?? runner.profile.name;
    const composed = composePersonaFallbackPrompt(persona, request.command.content, adapter);
    return Object.freeze({
      prompt: composed.prompt,
      request: Object.freeze(dispatchRequest(request, composed.prompt, undefined)),
      notices: composed.notices,
    });
  }
  return Object.freeze({
    prompt: request.command.content,
    request: Object.freeze(dispatchRequest(request, request.command.content, persona)),
    notices: Object.freeze([]),
  });
}

function resultEnvelope(
  result: AgentRunResult,
  engine: string,
  warnings: readonly string[],
  notices: readonly Readonly<LoweringNotice>[],
): CommandDispatchResult {
  return {
    schemaVersion: 2,
    ok: result.ok,
    shape: "agent-result",
    engine,
    exitCode: result.exitCode,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    durationMs: result.durationMs,
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(notices.length > 0 ? { notices } : {}),
  };
}

export async function dispatchPreparedCommandInvocation(
  prepared: PreparedCommandInvocation,
  options: DispatchPreparedCommandOptions = {},
): Promise<CommandDispatchResult> {
  const request = requireAuthorizedExecutionPlan(prepared.plan);
  const runner = lowerRunner(request, prepared.config);
  const lowered = lowerCommandDispatch(request, runner);
  const selectedEngine = request.engine.name;
  if (!selectedEngine) {
    throw new ConfigError(`command ${NO_ENGINE_MESSAGE_SUFFIX} ${NO_ENGINE_REMEDY}`, "INVALID_CONFIG_FILE");
  }
  const workspace = ownValue(request.runtime, "workspace");
  const persona = ownValue(request, "persona");
  const runnerOptions = sterileRecord<RunAgentOptions>({
    stdio: "captured",
    parseOutput: "text",
    ...(own(request.runtime, "timeoutMs") ? { timeoutMs: request.runtime.timeoutMs } : {}),
    ...(typeof workspace === "string" ? { cwd: workspace } : {}),
    dispatch: lowered.request,
  });
  const run = options.executeRunner ?? executeRunner;
  const result = await run(runner, lowered.prompt, runnerOptions, {
    llm: async (spec, prompt, runOptions) => {
      const started = Date.now();
      try {
        const stdout = await (options.chat ?? chatCompletion)(
          spec.connection,
          [
            ...(persona ? [{ role: "system" as const, content: persona.content }] : []),
            { role: "user" as const, content: prompt },
          ],
          ...(own(runOptions, "timeoutMs") ? [{ timeoutMs: runOptions.timeoutMs }] : []),
        );
        return { ok: true, exitCode: 0, stdout, stderr: "", durationMs: Date.now() - started };
      } catch (error) {
        return {
          ok: false,
          exitCode: null,
          stdout: "",
          stderr: "",
          durationMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
          reason: "spawn_failed" as const,
        };
      }
    },
  });
  const announcement = fallbackAnnouncement(prepared.fallbackEngineName, selectedEngine);
  return resultEnvelope(result, selectedEngine, announcement ? [announcement] : [], lowered.notices);
}

export async function executeCommandInvocation(
  options: PrepareCommandInvocationOptions,
  dispatchOptions: DispatchPreparedCommandOptions = {},
): Promise<CommandDispatchResult> {
  return dispatchPreparedCommandInvocation(await prepareCommandInvocation(options), dispatchOptions);
}
