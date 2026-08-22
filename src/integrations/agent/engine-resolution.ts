// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
// LlmConnectionConfig / AkmConfig come from the dependency-free config-types.ts
// leaf, NOT `../../core/config/config` (WI-9.8 KILL 3, D.3 edge A): config.ts
// used to import `materializeLlmConnection`/`resolveLlmEngineUse` from this
// file for its `requireLlmConfig`/`getDefaultLlmConfig` wrappers, while this
// file imported `LlmConnectionConfig` back from config.ts — a direct 2-file
// cycle that also dragged config.ts into the harness/agent-runtime SCC.
// `requireLlmConfig`/`getDefaultLlmConfig` moved here (see bottom of file) so
// config.ts no longer needs to import this module at all.
import type { AkmConfig, LlmConnectionConfig } from "../../core/config/config-types";
import { deepMergeConfig } from "../../core/config/deep-merge";
import { ConfigError } from "../../core/errors";
import { formatExtraParamsIssue, validateExtraParams } from "../../core/extra-params";
import { collectSensitiveValues } from "../../core/redaction";
import { getHarness } from "../harnesses";
import { DEFAULT_AGENT_TIMEOUT_MS, DEFAULT_LLM_TIMEOUT_MS } from "./config";
import { resolveLlmModel, resolveModel } from "./model-aliases";
import { type AgentProfile, getBuiltinAgentProfile } from "./profiles";

// RunnerSpec referenced via an inline `import("./runner")` TYPE QUERY (WI-9.8
// KILL 3) rather than a top-level `import type`: `./runner.ts` imports real
// VALUES from this module (resolveEngine, resolveLlmEngineUse,
// materializeLlmConnection), so a top-level type import here would close a
// 2-file cycle (this file needs RunnerSpec only as a return-type annotation,
// never a value). Same pattern as `builder-shared.ts`'s `AgentRunResult`
// query — erased at compile time, invisible to the static import graph.
type RunnerSpec = import("./runner").RunnerSpec;

export interface LlmInvocationOverrides {
  temperature?: number;
  maxTokens?: number;
  supportsJsonSchema?: boolean;
  extraParams?: Record<string, unknown>;
  contextLength?: number;
  enableThinking?: boolean;
  reasoningEffort?: string;
}

export interface EngineUseConfig {
  engine?: string;
  model?: string;
  timeoutMs?: number | null;
  llm?: LlmInvocationOverrides;
}

export interface LlmEngineConfig {
  kind: "llm";
  provider?: string;
  endpoint: string;
  model: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number | null;
  concurrency?: number;
  supportsJsonSchema?: boolean;
  extraParams?: Record<string, unknown>;
  contextLength?: number;
  enableThinking?: boolean;
  reasoningEffort?: string;
}

export interface AgentEngineConfig {
  kind: "agent";
  platform: string;
  bin?: string;
  args?: string[];
  workspace?: string;
  model?: string;
  timeoutMs?: number | null;
  modelAliases?: Record<string, string>;
  llmEngine?: string;
}

export type EngineConfig = LlmEngineConfig | AgentEngineConfig;

export interface EngineResolutionConfig {
  engines?: Record<string, EngineConfig>;
  defaults?: { engine?: string; llmEngine?: string };
  modelAliases?: Record<string, Record<string, string>>;
}

export interface CredentialDescriptor {
  names: [string, ...string[]];
  required: boolean;
}

export interface ResolvedLlmUse {
  engine: string;
  /** Frozen connection fields only; resolution never places apiKey or timeoutMs here. */
  connection: LlmConnectionConfig;
  credential?: CredentialDescriptor;
  timeoutMs: number | null;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.hasOwn(value, key);
}

function ownValue<T extends object, K extends keyof T>(value: T, key: K): T[K] | undefined {
  return hasOwn(value, key) ? value[key] : undefined;
}

function sterileRecord<T extends object>(value: T): T {
  return Object.assign(Object.create(null), value) as T;
}

function envName(reference: string): string | undefined {
  const match = /^\$(?:\{)?([A-Za-z_][A-Za-z0-9_]*)(?:\})?$/.exec(reference);
  return match?.[1];
}

function selectedEngineName(
  config: EngineResolutionConfig,
  layers: readonly EngineUseConfig[],
  llmOnly: boolean,
): string | undefined {
  for (let index = layers.length - 1; index >= 0; index--) {
    const layer = layers[index];
    if (!layer) continue;
    const engine = ownValue(layer, "engine");
    if (engine !== undefined) return engine;
  }
  const defaults = ownValue(config, "defaults");
  return defaults ? ownValue(defaults, llmOnly ? "llmEngine" : "engine") : undefined;
}

function resolveEngineConfig(name: string, config: EngineResolutionConfig): EngineConfig {
  const engines = ownValue(config, "engines");
  const engine = engines && hasOwn(engines, name) ? engines[name] : undefined;
  if (!engine) {
    throw new ConfigError(`Engine "${name}" is not configured.`, "INVALID_CONFIG_FILE");
  }
  return engine;
}

function resolveCredential(
  name: string,
  engine: LlmEngineConfig,
  config: EngineResolutionConfig,
): CredentialDescriptor | undefined {
  const apiKey = ownValue(engine, "apiKey");
  if (apiKey !== undefined) {
    const explicit = envName(apiKey);
    if (!explicit)
      throw new ConfigError(`Engine "${name}" has an invalid symbolic apiKey reference.`, "INVALID_CONFIG_FILE");
    return { names: [explicit], required: true };
  }
  const specific = `AKM_ENGINE_${name.toUpperCase().replaceAll("-", "_")}_API_KEY`;
  const defaults = ownValue(config, "defaults");
  return (defaults ? ownValue(defaults, "llmEngine") : undefined) === name
    ? { names: [specific, "AKM_LLM_API_KEY"], required: false }
    : { names: [specific], required: false };
}

/**
 * Lookup-only credential projection used by redaction inventories. Returns the
 * first non-empty trimmed value without enforcing a required descriptor.
 */
export function lookupCredentialFromEnv(
  credential: CredentialDescriptor | undefined,
  envSource: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const name of credential?.names ?? []) {
    const candidate = envSource[name]?.trim();
    if (candidate) return candidate;
  }
  return undefined;
}

/**
 * The enforcing env-credential seam. Live and frozen dispatch use the same
 * ordered lookup; a missing required descriptor names its primary variable.
 */
export function resolveCredentialFromEnv(
  credential: CredentialDescriptor | undefined,
  envSource: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = lookupCredentialFromEnv(credential, envSource);
  if (value) return value;
  if (credential?.required) {
    throw new ConfigError(`Required engine credential ${credential.names[0]} is not set.`, "INVALID_CONFIG_FILE");
  }
  return undefined;
}

/** Collect materialized engine credentials for output and persistence redaction. */
export function collectEngineCredentialValues(
  config: EngineResolutionConfig,
  envSource: NodeJS.ProcessEnv = process.env,
): string[] {
  const values = new Set<string>();
  for (const [name, engine] of Object.entries(ownValue(config, "engines") ?? {})) {
    if (engine.kind !== "llm") continue;
    for (const envVar of resolveCredential(name, engine, config)?.names ?? []) {
      const value = envSource[envVar]?.trim();
      if (value) values.add(value);
    }
  }
  return collectSensitiveValues(values);
}

function effectiveTimeout(
  engine: { timeoutMs?: number | null },
  layers: readonly EngineUseConfig[],
  fallback: number,
): number | null {
  for (let index = layers.length - 1; index >= 0; index--) {
    if (hasOwn(layers[index] ?? {}, "timeoutMs")) return layers[index]?.timeoutMs ?? null;
  }
  return hasOwn(engine, "timeoutMs") ? (engine.timeoutMs ?? null) : fallback;
}

function rawLlmConnection(engine: LlmEngineConfig): Record<string, unknown> {
  const connection: Record<string, unknown> = {
    provider: ownValue(engine, "provider"),
    endpoint: ownValue(engine, "endpoint"),
    model: ownValue(engine, "model"),
    temperature: ownValue(engine, "temperature"),
    maxTokens: ownValue(engine, "maxTokens"),
    supportsJsonSchema: ownValue(engine, "supportsJsonSchema"),
    extraParams: ownValue(engine, "extraParams"),
    contextLength: ownValue(engine, "contextLength"),
    enableThinking: ownValue(engine, "enableThinking"),
    reasoningEffort: ownValue(engine, "reasoningEffort"),
  };
  for (const key of Object.keys(connection)) {
    if (connection[key] === undefined) delete connection[key];
  }
  return connection;
}

function resolveLlmTransportMaterial(name: string, config: EngineResolutionConfig): ResolvedLlmUse {
  const engine = resolveEngineConfig(name, config);
  if (engine.kind !== "llm") {
    throw new ConfigError(`Engine "${name}" is not an LLM engine.`, "INVALID_CONFIG_FILE");
  }
  return {
    engine: name,
    connection: sterileRecord(rawLlmConnection(engine)) as LlmConnectionConfig,
    credential: resolveCredential(name, engine, config),
    timeoutMs: effectiveTimeout(engine, [], DEFAULT_LLM_TIMEOUT_MS),
  };
}

/** Resolve one selected LLM engine and overlays without materializing credentials. */
export function resolveLlmEngineUse(
  config: EngineResolutionConfig,
  layers: readonly EngineUseConfig[],
  options: { optional: true },
): ResolvedLlmUse | undefined;
export function resolveLlmEngineUse(
  config: EngineResolutionConfig,
  layers: readonly EngineUseConfig[],
  options?: { optional?: false },
): ResolvedLlmUse;
export function resolveLlmEngineUse(
  config: EngineResolutionConfig,
  layers: readonly EngineUseConfig[],
  options: { optional?: boolean } = {},
): ResolvedLlmUse | undefined {
  const name = selectedEngineName(config, layers, true);
  if (!name) {
    if (options.optional) return undefined;
    throw new ConfigError("No LLM engine is selected. Set defaults.llmEngine or specify engine.", "LLM_NOT_CONFIGURED");
  }
  const engine = resolveEngineConfig(name, config);
  if (engine.kind !== "llm") {
    throw new ConfigError(`Engine "${name}" is not an LLM engine.`, "INVALID_CONFIG_FILE");
  }

  let connection = rawLlmConnection(engine);
  for (const layer of layers) {
    const llm = ownValue(layer, "llm");
    const model = ownValue(layer, "model");
    if (llm) connection = deepMergeConfig(connection, llm as Record<string, unknown>);
    if (model !== undefined) connection.model = model;
  }
  for (const key of Object.keys(connection)) {
    if (connection[key] === undefined) delete connection[key];
  }
  connection.model = resolveLlmModel(connection.model as string, name, ownValue(config, "modelAliases"));
  return {
    engine: name,
    connection: sterileRecord(connection) as LlmConnectionConfig,
    credential: resolveCredential(name, engine, config),
    timeoutMs: effectiveTimeout(engine, layers, DEFAULT_LLM_TIMEOUT_MS),
  };
}

/** Read a resolved symbolic credential only at the runtime dispatch boundary. */
export function materializeLlmConnectionWithCredential(
  resolved: ResolvedLlmUse,
  credentialValue: string | undefined,
): LlmConnectionConfig {
  const extraParams = ownValue(resolved.connection, "extraParams");
  if (extraParams !== undefined) {
    const issue = validateExtraParams(extraParams)[0];
    if (issue) {
      throw new ConfigError(
        formatExtraParamsIssue(`Engine "${resolved.engine}" extraParams`, issue),
        "INVALID_CONFIG_FILE",
      );
    }
  }
  return sterileRecord({
    ...resolved.connection,
    ...(credentialValue ? { apiKey: credentialValue } : {}),
    timeoutMs: resolved.timeoutMs,
  }) as LlmConnectionConfig;
}

/** Read and inject one resolved symbolic credential at the runtime boundary. */
export function materializeLlmConnection(
  resolved: ResolvedLlmUse,
  envSource: NodeJS.ProcessEnv = process.env,
): LlmConnectionConfig {
  return materializeLlmConnectionWithCredential(resolved, resolveCredentialFromEnv(resolved.credential, envSource));
}

function lowerAgentEngine(
  name: string,
  engine: AgentEngineConfig,
  config: EngineResolutionConfig,
  resolveAliases = true,
): RunnerSpec {
  const harness = getHarness(engine.platform);
  if (!harness?.capabilities.agentDispatch) {
    throw new ConfigError(
      `Engine "${name}" names a platform that cannot dispatch agents: ${engine.platform}.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const platform = harness.id;
  const sdk = platform === "opencode-sdk";
  const builtin = getBuiltinAgentProfile(platform);
  const bin = ownValue(engine, "bin");
  const args = ownValue(engine, "args");
  const workspace = ownValue(engine, "workspace");
  const model = ownValue(engine, "model");
  const engineModelAliases = ownValue(engine, "modelAliases");
  const globalModelAliases = ownValue(config, "modelAliases");
  const profile = sterileRecord<AgentProfile>({
    name,
    platform,
    personaChannel: sdk ? "native" : (harness.agentBuilder?.personaChannel ?? "prompt"),
    bin: bin ?? builtin?.bin ?? (sdk ? "opencode" : platform),
    args: args ?? builtin?.args ?? [],
    stdio: "captured",
    ...(builtin?.env ? { env: builtin.env } : {}),
    envPassthrough: builtin?.envPassthrough ?? [],
    parseOutput: "text",
    ...(workspace ? { workspace: path.resolve(workspace) } : {}),
    ...(model
      ? {
          model: resolveAliases ? resolveModel(model, platform, engineModelAliases, globalModelAliases) : model,
          modelIsExact: true,
        }
      : {}),
    ...(resolveAliases && engineModelAliases ? { modelAliases: engineModelAliases } : {}),
    ...(resolveAliases && globalModelAliases ? { globalModelAliases } : {}),
  });
  if (!sdk) {
    return {
      kind: "agent",
      engine: name,
      profile,
      timeoutMs: hasOwn(engine, "timeoutMs") ? (engine.timeoutMs ?? null) : DEFAULT_AGENT_TIMEOUT_MS,
    };
  }
  const defaults = ownValue(config, "defaults");
  const fallbackName = ownValue(engine, "llmEngine") ?? (defaults ? ownValue(defaults, "llmEngine") : undefined);
  const fallback = fallbackName
    ? resolveAliases
      ? resolveLlmEngineUse(config, [{ engine: fallbackName }], { optional: true })
      : resolveLlmTransportMaterial(fallbackName, config)
    : undefined;
  return {
    kind: "sdk",
    engine: name,
    profile,
    ...(fallback
      ? {
          fallbackConnection: fallback.connection,
          ...(fallback.credential ? { fallbackCredential: fallback.credential } : {}),
          fallbackTimeoutMs: fallback.timeoutMs,
        }
      : {}),
    timeoutMs: hasOwn(engine, "timeoutMs")
      ? (engine.timeoutMs ?? null)
      : (fallback?.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS),
  };
}

/** Lower a named engine through the canonical harness platform. */
export function resolveEngine(name: string, config: EngineResolutionConfig): RunnerSpec {
  const engine = resolveEngineConfig(name, config);
  if (engine.kind === "llm") {
    const resolved = resolveLlmEngineUse(config, [{ engine: name }]);
    if (!resolved) throw new ConfigError(`LLM engine "${name}" could not be resolved.`, "LLM_NOT_CONFIGURED");
    return {
      kind: "llm",
      engine: name,
      connection: resolved.connection,
      ...(resolved.credential ? { credential: resolved.credential } : {}),
      timeoutMs: resolved.timeoutMs,
    };
  }
  return lowerAgentEngine(name, engine, config);
}

/**
 * Resolve only transport/profile/credential material for an already-resolved
 * execution request. Unlike {@link resolveEngine}, this never reinterprets the
 * request-owned primary model; the engine lowerer projects that exact value
 * afterward (or preserves an explicit null/omission). SDK fallback model and
 * inference selection is likewise frozen into the canonical request during
 * preparation; this function returns only its raw symbolic transport material
 * so lowering cannot reinterpret a changed alias/model map.
 */
export function resolveEngineTransportMaterial(name: string, config: EngineResolutionConfig): RunnerSpec {
  const engine = resolveEngineConfig(name, config);
  if (engine.kind === "llm") {
    const resolved = resolveLlmTransportMaterial(name, config);
    return {
      kind: "llm",
      engine: name,
      connection: resolved.connection,
      ...(resolved.credential ? { credential: resolved.credential } : {}),
      timeoutMs: resolved.timeoutMs,
    };
  }
  return lowerAgentEngine(name, engine, config, false);
}

export function resolveDefaultEngine(config: EngineResolutionConfig): RunnerSpec {
  const defaults = ownValue(config, "defaults");
  const name = defaults ? ownValue(defaults, "engine") : undefined;
  if (!name) throw new ConfigError("No default engine is configured.", "INVALID_CONFIG_FILE");
  return resolveEngine(name, config);
}

// ── AkmConfig convenience wrappers (moved from core/config/config.ts, WI-9.8
// KILL 3, D.3 edge A) ────────────────────────────────────────────────────────
//
// Moved verbatim: `config.ts` previously called `materializeLlmConnection` +
// `resolveLlmEngineUse` directly for these two wrappers, which is what made
// config.ts import this module — and this module imported `LlmConnectionConfig`
// back from config.ts, closing a 2-file cycle. config.ts CANNOT re-export
// these (a re-export is still a graph edge to this file), so the small number
// of call sites that used to import them from "core/config/config" now import
// them from here instead (see D.3 edge A "callers compose instead").

/** Resolve and materialize the configured default LLM engine at dispatch time. */
export function requireLlmConfig(config: AkmConfig): LlmConnectionConfig {
  return materializeLlmConnection(resolveLlmEngineUse(config, []));
}

/**
 * Like {@link requireLlmConfig} but returns `undefined` instead of throwing
 * when no LLM is configured. Use in code paths where the LLM is optional.
 */
export function getDefaultLlmConfig(config: AkmConfig): LlmConnectionConfig | undefined {
  const resolved = resolveLlmEngineUse(config, [], { optional: true });
  return resolved ? materializeLlmConnection(resolved) : undefined;
}
