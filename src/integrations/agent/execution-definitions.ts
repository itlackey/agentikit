// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AkmConfig, EngineConfig } from "../../core/config/config-types";
import { cloneExecutionJsonObject } from "../../execution/json";
import type { UnresolvedExecutionDefaults } from "../../execution/source";
import type { ExecutionEngineDefinition } from "./execution-cascade";
import type { RunnerSpec } from "./runner";

function own(value: object, key: PropertyKey): boolean {
  return Object.hasOwn(value, key);
}

function ownValue<T extends object, K extends keyof T>(value: T, key: K): T[K] | undefined {
  return own(value, key) ? value[key] : undefined;
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

/** Project validated named-engine config into the pure common cascade registry. */
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

export interface RunnerExecutionEngineDefinition {
  readonly engineName: string;
  readonly runner: RunnerSpec;
  readonly definition: ExecutionEngineDefinition;
}

/**
 * Project already-resolved, symbolic runner material into the common cascade
 * without consulting config, aliases, environment variables, or credentials.
 */
export function executionEngineDefinitionFromRunner(input: RunnerSpec): RunnerExecutionEngineDefinition {
  const snapshot = cloneExecutionJsonObject(input, "frozen execution runner") as unknown as RunnerSpec;
  const engineName = snapshot.engine ?? (snapshot.kind === "llm" ? "llm" : snapshot.profile.name);
  if (!engineName) throw new TypeError("frozen execution runner requires a stable engine name");
  // This sanctioned preparation seam normalizes legacy runner material that
  // omitted `engine`; the lowerer itself rejects unbound runner/request pairs.
  const runner =
    typeof snapshot.engine === "string"
      ? snapshot
      : (cloneExecutionJsonObject(
          { ...snapshot, engine: engineName },
          "bound frozen execution runner",
        ) as unknown as RunnerSpec);
  if (runner.kind === "llm") {
    const inference = withoutUndefined({
      temperature: ownValue(runner.connection, "temperature"),
      maxTokens: ownValue(runner.connection, "maxTokens"),
      supportsJsonSchema: ownValue(runner.connection, "supportsJsonSchema"),
      extraParams: ownValue(runner.connection, "extraParams"),
      contextLength: ownValue(runner.connection, "contextLength"),
      enableThinking: ownValue(runner.connection, "enableThinking"),
    });
    return Object.freeze({
      engineName,
      runner,
      definition: Object.freeze({
        selection: Object.freeze({
          name: engineName,
          kind: "llm" as const,
          platform: runner.connection.provider ?? engineName,
          settings: cloneExecutionJsonObject(
            withoutUndefined({
              endpoint: runner.connection.endpoint,
              provider: runner.connection.provider,
            }),
            "frozen execution runner settings",
          ),
        }),
        defaults: Object.freeze({
          model: runner.connection.model,
          ...(Object.keys(inference).length > 0
            ? { inference: cloneExecutionJsonObject(inference, "frozen execution runner inference") }
            : {}),
          ...(own(runner, "timeoutMs") ? { timeout: runner.timeoutMs } : {}),
        }),
        modelMapKey: engineName,
      }),
    });
  }

  const platform = runner.profile.platform ?? runner.profile.name;
  if (!platform) throw new TypeError("frozen agent runner requires a stable platform");
  return Object.freeze({
    engineName,
    runner,
    definition: Object.freeze({
      selection: Object.freeze({
        name: engineName,
        kind: runner.kind,
        platform,
        settings: cloneExecutionJsonObject(
          { bin: runner.profile.bin, args: runner.profile.args },
          "frozen execution runner settings",
        ),
      }),
      defaults: Object.freeze({
        ...(own(runner.profile, "model") ? { model: runner.profile.model } : {}),
        ...(own(runner, "timeoutMs") ? { timeout: runner.timeoutMs } : {}),
        ...(own(runner.profile, "workspace") ? { workspace: runner.profile.workspace } : {}),
      }),
      modelMapKey: platform,
    }),
  });
}
