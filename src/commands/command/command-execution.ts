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
}

export interface DispatchPreparedCommandOptions {
  readonly executeRunner?: typeof executeRunner;
  readonly chat?: typeof chatCompletion;
}

function own(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
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
      temperature: engine.temperature,
      maxTokens: engine.maxTokens,
      supportsJsonSchema: engine.supportsJsonSchema,
      extraParams: engine.extraParams,
      contextLength: engine.contextLength,
      enableThinking: engine.enableThinking,
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
  for (const [name, engine] of Object.entries(config.engines ?? {})) {
    const platform = engine.kind === "agent" ? engine.platform : (engine.provider ?? name);
    const settings =
      engine.kind === "agent"
        ? withoutUndefined({ bin: engine.bin, args: engine.args, workspace: engine.workspace })
        : withoutUndefined({ endpoint: engine.endpoint, provider: engine.provider });
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
        ...(engine.kind === "agent" && engine.modelAliases ? { engineAliases: engine.modelAliases } : {}),
        ...(config.modelAliases ? { globalAliases: config.modelAliases } : {}),
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

export async function prepareCommandInvocation(
  options: PrepareCommandInvocationOptions,
): Promise<PreparedCommandInvocation> {
  const action = parseBuiltinCommandAction(options.action);
  const sourceLoader = options.sourceLoader ?? defaultSourceLoader;
  let renderedCommand: AdapterRenderedCommandSource | undefined;
  let commandDefaults: UnresolvedExecutionDefaults = Object.freeze({});
  let command: ResolvedCommandContent;
  if (action.kind === "stored") {
    const rendered = await sourceLoader(action.ref, "command", { config: options.config });
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
    const rendered = await sourceLoader(lookupRef, "persona", { config: options.config });
    if (rendered.kind !== "persona") throw new TypeError("persona source loader returned a non-persona source");
    renderedPersona = rendered;
  }
  const persona = renderedPersona ? createResolvedPersona(renderedPersona) : selectedAgent.present ? null : undefined;

  const fallback = withEngineFallback(options.config);
  const installationValues: Record<string, unknown> = {};
  if (fallback.config.defaults?.engine) installationValues.engine = fallback.config.defaults.engine;
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
    engines: executionEngineDefinitionsFromConfig(fallback.config),
    modelMap: options.modelMap ?? loadModelMap().map,
    invocationKind: "direct",
    ...(options.authorizeTools ? { authorizeTools: options.authorizeTools } : {}),
  });
  return Object.freeze({
    plan,
    request: plan.request,
    config: fallback.config,
    ...(fallback.fallbackEngineName ? { fallbackEngineName: fallback.fallbackEngineName } : {}),
  });
}

function lowerRunner(request: ResolvedExecutionRequestV1, config: AkmConfig): RunnerSpec {
  const runner = resolveEngine(request.engine.name, config);
  const timeoutMs = own(request.runtime, "timeoutMs") ? request.runtime.timeoutMs : runner.timeoutMs;
  if (runner.kind === "llm") {
    const connection: Record<string, unknown> = { ...runner.connection };
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
    if (request.inference) {
      for (const key of [
        "temperature",
        "maxTokens",
        "supportsJsonSchema",
        "extraParams",
        "contextLength",
        "enableThinking",
      ] as const) {
        if (own(request.inference, key)) connection[key] = request.inference[key];
      }
    }
    // Model selection and transport identity are separate from inference.
    // Applying the resolved model last also prevents arbitrary inference data
    // from redirecting a request or changing its selected model.
    if (request.model) connection.model = request.model.resolved;
    return { ...runner, connection, ...(timeoutMs !== undefined ? { timeoutMs } : {}) } as RunnerSpec;
  }
  const profile = { ...runner.profile };
  delete profile.model;
  delete profile.modelIsExact;
  delete profile.workspace;
  if (request.model) Object.assign(profile, { model: request.model.resolved, modelIsExact: true });
  if (typeof request.runtime.workspace === "string") profile.workspace = request.runtime.workspace;
  return { ...runner, profile, ...(timeoutMs !== undefined ? { timeoutMs } : {}) } as RunnerSpec;
}

function dispatchRequest(request: ResolvedExecutionRequestV1): AgentDispatchRequest {
  const effort =
    request.inference && typeof request.inference.effort === "string" ? request.inference.effort : undefined;
  return {
    prompt: request.command.content,
    ...(request.persona ? { systemPrompt: request.persona.content } : {}),
    ...(request.model ? { model: request.model.resolved, modelIsExact: true } : {}),
    ...(own(request, "tools") ? { tools: request.tools as AgentDispatchRequest["tools"] } : {}),
    ...(effort ? { effort } : {}),
    ...(request.outputSchema ? { schema: request.outputSchema as Record<string, unknown> } : {}),
  };
}

function resultEnvelope(result: AgentRunResult, engine: string, warnings: readonly string[]): CommandDispatchResult {
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
  };
}

export async function dispatchPreparedCommandInvocation(
  prepared: PreparedCommandInvocation,
  options: DispatchPreparedCommandOptions = {},
): Promise<CommandDispatchResult> {
  const request = requireAuthorizedExecutionPlan(prepared.plan);
  const runner = lowerRunner(request, prepared.config);
  const selectedEngine = request.engine.name;
  if (!selectedEngine) {
    throw new ConfigError(`command ${NO_ENGINE_MESSAGE_SUFFIX} ${NO_ENGINE_REMEDY}`, "INVALID_CONFIG_FILE");
  }
  const runnerOptions: RunAgentOptions = {
    stdio: "captured",
    parseOutput: "text",
    ...(own(request.runtime, "timeoutMs") ? { timeoutMs: request.runtime.timeoutMs } : {}),
    ...(typeof request.runtime.workspace === "string" ? { cwd: request.runtime.workspace } : {}),
    dispatch: dispatchRequest(request),
  };
  const run = options.executeRunner ?? executeRunner;
  const result = await run(runner, request.command.content, runnerOptions, {
    llm: async (spec, prompt, runOptions) => {
      const started = Date.now();
      try {
        const stdout = await (options.chat ?? chatCompletion)(
          spec.connection,
          [
            ...(request.persona ? [{ role: "system" as const, content: request.persona.content }] : []),
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
  return resultEnvelope(result, selectedEngine, announcement ? [announcement] : []);
}

export async function executeCommandInvocation(
  options: PrepareCommandInvocationOptions,
  dispatchOptions: DispatchPreparedCommandOptions = {},
): Promise<CommandDispatchResult> {
  return dispatchPreparedCommandInvocation(await prepareCommandInvocation(options), dispatchOptions);
}
