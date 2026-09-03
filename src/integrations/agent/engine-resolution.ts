// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LlmConnectionConfig } from "../../core/config/config-types";
import { deepMergeConfig } from "../../core/config/deep-merge";
import { ConfigError } from "../../core/errors";
import { formatExtraParamsIssue, validateExtraParams } from "../../core/extra-params";
import { collectSensitiveValues } from "../../core/redaction";
import { warn } from "../../core/warn";
import { getHarness } from "../harnesses";
import { DEFAULT_AGENT_TIMEOUT_MS, DEFAULT_LLM_TIMEOUT_MS } from "./config";
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
  apiKeyFile?: string;
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
  llmEngine?: string;
}

export type EngineConfig = LlmEngineConfig | AgentEngineConfig;

export interface EngineResolutionConfig {
  engines?: Record<string, EngineConfig>;
  defaults?: { engine?: string; llmEngine?: string };
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
  /**
   * Home-expanded, but NOT YET READ, path to a file-backed credential (#905).
   * Mutually exclusive with `credential` at the schema level — read lazily by
   * {@link resolveLlmCredentialValue} only when no env credential value is
   * supplied, so the frozen resolution/plan objects never carry the secret
   * itself.
   */
  apiKeyFile?: string;
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

/** Expand a leading `~` the same way `loadSetupConfigFromFile` does for `--from <file>`. */
function expandHomePath(filePath: string): string {
  return filePath.startsWith("~") ? path.join(os.homedir(), filePath.slice(1)) : filePath;
}

/** Trim exactly one trailing newline (`\n` or `\r\n`) — never interior whitespace. */
function trimTrailingNewline(raw: string): string {
  return raw.replace(/\r?\n$/, "");
}

/**
 * Read a file-backed credential (#905) at the dispatch boundary. Never
 * includes the file's content in a thrown message — only the engine name and
 * path, so a misconfigured `apiKeyFile` cannot leak its (partial) contents
 * into a log or error report.
 */
function readApiKeyFile(engineName: string, filePath: string): string {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
    const reason = code === "ENOENT" ? "does not exist" : "could not be read";
    throw new ConfigError(`Engine "${engineName}" apiKeyFile ${reason}: ${filePath}`, "INVALID_CONFIG_FILE");
  }
  const value = trimTrailingNewline(raw);
  if (value.length === 0) {
    throw new ConfigError(`Engine "${engineName}" apiKeyFile is empty: ${filePath}`, "INVALID_CONFIG_FILE");
  }
  return value;
}

/**
 * Best-effort, non-throwing read of a file-backed credential's current value
 * (#905), for redaction inventories and health probes that must never fail
 * just because a value collector ran ahead of the real dispatch — a missing
 * or empty file is reported by {@link readApiKeyFile} at the actual call.
 */
export function lookupApiKeyFileValue(filePath: string): string | undefined {
  try {
    const value = trimTrailingNewline(fs.readFileSync(filePath, "utf8"));
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
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
  // #905: an explicit apiKeyFile is its own credential source — resolved
  // separately onto `ResolvedLlmUse.apiKeyFile` — so it does not also fall
  // through to the implicit AKM_ENGINE_<NAME>_API_KEY convention below.
  if (ownValue(engine, "apiKeyFile") !== undefined) return undefined;
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

/**
 * The enforcing credential seam for one resolved LLM engine or SDK fallback
 * (#905): the symbolic env-var descriptor first (throws if a required one is
 * missing), then the file-backed alternative when no env descriptor applies.
 * Call this once per operation — lease acquisition, or direct materialize —
 * so a whole operation observes one stable credential value instead of
 * re-reading the file on every dispatch within it.
 */
export function resolveLlmCredentialValue(
  engine: string,
  credential: CredentialDescriptor | undefined,
  apiKeyFile: string | undefined,
  envSource: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const envValue = resolveCredentialFromEnv(credential, envSource);
  if (envValue !== undefined) return envValue;
  return apiKeyFile !== undefined ? readApiKeyFile(engine, apiKeyFile) : undefined;
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
    // #905: file-backed credential — best-effort, so a broken apiKeyFile on
    // one engine never stops redaction from collecting every other engine's
    // credential too.
    const apiKeyFile = ownValue(engine, "apiKeyFile");
    if (apiKeyFile !== undefined) {
      const value = lookupApiKeyFileValue(expandHomePath(apiKeyFile));
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
    // A caller here wants a chat-completions endpoint, not an interactive
    // agent — but the agent engine may already declare exactly that as its
    // own fallback (`llmEngine`, also consumed by `lowerAgentEngine`'s SDK
    // fallback), or the install may have a default one. Falling back is
    // strictly LESS capable than the agent engine (never hands the caller a
    // tool-capable runner), so it is safe to prefer over refusing outright.
    const defaults = ownValue(config, "defaults");
    const fallbackName = ownValue(engine, "llmEngine") ?? (defaults ? ownValue(defaults, "llmEngine") : undefined);
    const fallbackEngine = fallbackName ? resolveEngineConfig(fallbackName, config) : undefined;
    if (!fallbackEngine || fallbackEngine.kind !== "llm") {
      if (options.optional) return undefined;
      throw new ConfigError(
        fallbackName
          ? `Engine "${name}" is not an LLM engine, and its llmEngine fallback "${fallbackName}" is not one either.`
          : `Engine "${name}" is not an LLM engine, and has no llmEngine fallback configured.`,
        "INVALID_CONFIG_FILE",
      );
    }
    warn(
      `[akm] Engine "${name}" is an agent engine, not an LLM engine; using its llmEngine "${fallbackName}" instead.`,
    );
    // `fallbackEngine.kind === "llm"` was just verified above, so this
    // recursive call always lands in the `engine.kind === "llm"` branch —
    // no risk of looping back through this fallback again.
    return options.optional
      ? resolveLlmEngineUse(config, [{ engine: fallbackName }], { optional: true })
      : resolveLlmEngineUse(config, [{ engine: fallbackName }]);
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
  const apiKeyFile = ownValue(engine, "apiKeyFile");
  return {
    engine: name,
    connection: sterileRecord(connection) as LlmConnectionConfig,
    credential: resolveCredential(name, engine, config),
    ...(apiKeyFile !== undefined ? { apiKeyFile: expandHomePath(apiKeyFile) } : {}),
    timeoutMs: effectiveTimeout(engine, layers, DEFAULT_LLM_TIMEOUT_MS),
  };
}

/**
 * Inject an already-resolved credential value into a connection. Callers
 * resolve the value themselves via {@link resolveLlmCredentialValue} (or its
 * lease-cached equivalent) — this function never reads env or disk itself, so
 * a frozen `ResolvedLlmUse`/`RunnerSpec` plan object can be materialized
 * repeatedly without re-triggering I/O per call.
 */
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

/**
 * Read and inject one resolved credential at the runtime boundary: the
 * symbolic `$VAR` reference, or the file-backed alternative (#905) when the
 * engine has no env descriptor.
 */
export function materializeLlmConnection(
  resolved: ResolvedLlmUse,
  envSource: NodeJS.ProcessEnv = process.env,
): LlmConnectionConfig {
  return materializeLlmConnectionWithCredential(
    resolved,
    resolveLlmCredentialValue(resolved.engine, resolved.credential, resolved.apiKeyFile, envSource),
  );
}

function lowerAgentEngine(name: string, engine: AgentEngineConfig, config: EngineResolutionConfig): RunnerSpec {
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
    ...(model ? { model } : {}),
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
    ? resolveLlmEngineUse(config, [{ engine: fallbackName }], { optional: true })
    : undefined;
  return {
    kind: "sdk",
    engine: name,
    profile,
    ...(fallback
      ? {
          fallbackConnection: fallback.connection,
          ...(fallback.credential ? { fallbackCredential: fallback.credential } : {}),
          ...(fallback.apiKeyFile ? { fallbackApiKeyFile: fallback.apiKeyFile } : {}),
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
      ...(resolved.apiKeyFile ? { apiKeyFile: resolved.apiKeyFile } : {}),
      timeoutMs: resolved.timeoutMs,
    };
  }
  return lowerAgentEngine(name, engine, config);
}
