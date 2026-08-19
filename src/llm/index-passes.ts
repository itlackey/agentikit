// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AkmConfig, IndexPassConfig } from "../core/config/config";
import { ConfigError } from "../core/errors";
import { cloneExecutionJsonObject } from "../execution/json";
import type { UnresolvedExecutionDefaults } from "../execution/source";
import { lowerResolvedExecutionRequest } from "../integrations/agent/execution-lowering";
import { prepareInlineExecution } from "../integrations/agent/inline-execution";
import type { StructuredLlmRunner } from "./structured-call";

function own(value: object | undefined, key: PropertyKey): boolean {
  return value !== undefined && Object.hasOwn(value, key);
}

/** Adapt one index invocation layer into the shared execution vocabulary. */
function indexExecutionDefaults(layer: IndexPassConfig | undefined): UnresolvedExecutionDefaults {
  if (!layer) return {};
  return {
    ...(own(layer, "engine") ? { engine: layer.engine } : {}),
    ...(own(layer, "model") ? { model: layer.model } : {}),
    ...(own(layer, "timeoutMs") ? { timeout: layer.timeoutMs } : {}),
    ...(own(layer, "llm") && layer.llm !== undefined
      ? { inference: cloneExecutionJsonObject(layer.llm, "index pass LLM inference") }
      : {}),
  };
}

/**
 * Resolve standalone index passes from the index section only. Improve
 * strategies own improve-triggered calls and are intentionally not consulted.
 */
export function resolveIndexPassRunner(passName: string, config: AkmConfig): StructuredLlmRunner | undefined {
  const pass = config.index?.[passName] as IndexPassConfig | undefined;
  if (pass?.enabled === false) return undefined;
  const defaults = config.index?.defaults as IndexPassConfig | undefined;
  const fallbackLlmEngine = config.defaults?.llmEngine;
  const selectedEngine = pass?.engine ?? defaults?.engine ?? fallbackLlmEngine;
  if (!selectedEngine) return undefined;

  const invocationDefaults = {
    ...indexExecutionDefaults(defaults),
    ...(!own(defaults, "engine") && fallbackLlmEngine ? { engine: fallbackLlmEngine } : {}),
  } satisfies UnresolvedExecutionDefaults;
  const prepared = prepareInlineExecution({
    content: "",
    config,
    invocationKind: "direct",
    invocationDefaults,
    current: indexExecutionDefaults(pass),
  });
  const lowered = lowerResolvedExecutionRequest(prepared.request, prepared.config);
  if (lowered.runner.kind !== "llm") {
    throw new ConfigError(
      `Index pass ${JSON.stringify(passName)} requires an LLM engine; ${JSON.stringify(selectedEngine)} is not one.`,
      "INVALID_CONFIG_FILE",
    );
  }
  return lowered.runner;
}
