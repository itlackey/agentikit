// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AkmConfig } from "../../core/config/config-types";
import { ConfigError, UsageError } from "../../core/errors";
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
import { recordIndexedShowUsage } from "../../indexer/usage/show-usage";
import { resolveUsageEventSource } from "../../indexer/usage/usage-events";
import {
  fallbackAnnouncement,
  NO_ENGINE_MESSAGE_SUFFIX,
  NO_ENGINE_REMEDY,
} from "../../integrations/agent/engine-fallback";
import {
  type ExecutionInvocationKind,
  type ResolvedExecutionPlanV1,
  requireAuthorizedExecutionPlan,
  type ToolAuthorizer,
} from "../../integrations/agent/execution-cascade";
import {
  type DispatchLoweredExecutionOptions,
  dispatchLoweredExecutionRequest,
  lowerResolvedExecutionRequest,
} from "../../integrations/agent/execution-lowering";
import { prepareResolvedExecution } from "../../integrations/agent/execution-preparation";
import type { ResolvedModelMapV1 } from "../../integrations/agent/model-map";
import type { AgentRunResult } from "../../integrations/agent/spawn";
import type { chatCompletion } from "../../llm/client";
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
  /** Provenance selects the common cascade layer; direct remains the public default. */
  readonly invocationKind?: ExecutionInvocationKind;
  /** Authored workflow prose is already classified as literal by source IR and must bypass portable templating. */
  readonly inlineContentMode?: "portable-template" | "literal";
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
  readonly executeRunner?: DispatchLoweredExecutionOptions["executeRunner"];
  /** Compatibility seam for tests; production uses the leased executeRunner path. */
  readonly runAgent?: DispatchLoweredExecutionOptions["runAgent"];
  readonly runOptions?: DispatchLoweredExecutionOptions["runOptions"];
  readonly chat?: typeof chatCompletion;
}

function own(value: object, key: PropertyKey): boolean {
  return Object.hasOwn(value, key);
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
    if (options.inlineContentMode === "literal") {
      if (action.arguments !== undefined) {
        throw new UsageError("Literal inline command content cannot declare portable arguments.", "INVALID_FLAG_VALUE");
      }
      command = createInlineResolvedCommand({ template: action.content, content: action.content });
    } else {
      const applied = applyPortableCommandArguments(action.content, action.arguments, "inline command");
      command = createInlineResolvedCommand({
        template: applied.template,
        ...(own(applied, "argumentInput") ? { argumentInput: applied.argumentInput } : {}),
        content: applied.content,
      });
    }
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

  return prepareResolvedExecution({
    command,
    config: inputConfig,
    invocationKind: options.invocationKind ?? "direct",
    ...(persona !== undefined ? { persona } : {}),
    ...(renderedPersona ? { agentLayer: { id: renderedPersona.identity.ref, values: renderedPersona.defaults } } : {}),
    commandLayer: {
      id: renderedCommand?.identity.ref ?? "inline-command",
      values: commandDefaults,
    },
    ...(options.invocationDefaults ? { invocationDefaults: options.invocationDefaults } : {}),
    ...(options.current ? { current: options.current } : {}),
    ...(options.modelMap ? { modelMap: options.modelMap } : {}),
    ...(options.authorizeTools ? { authorizeTools: options.authorizeTools } : {}),
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
  const lowered = lowerResolvedExecutionRequest(request, prepared.config);
  const selectedEngine = request.engine.name;
  if (!selectedEngine) {
    throw new ConfigError(`command ${NO_ENGINE_MESSAGE_SUFFIX} ${NO_ENGINE_REMEDY}`, "INVALID_CONFIG_FILE");
  }
  const result = await dispatchLoweredExecutionRequest(lowered, options);
  const consumedRefs = new Set<string>();
  if (request.command.source) consumedRefs.add(request.command.source.ref);
  if (request.persona) consumedRefs.add(request.persona.source.ref);
  const eventSource = resolveUsageEventSource();
  for (const ref of consumedRefs) recordIndexedShowUsage(ref, eventSource);
  const announcement = fallbackAnnouncement(prepared.fallbackEngineName, selectedEngine);
  return resultEnvelope(result, selectedEngine, announcement ? [announcement] : [], lowered.notices);
}

export async function executeCommandInvocation(
  options: PrepareCommandInvocationOptions,
  dispatchOptions: DispatchPreparedCommandOptions = {},
): Promise<CommandDispatchResult> {
  return dispatchPreparedCommandInvocation(await prepareCommandInvocation(options), dispatchOptions);
}
