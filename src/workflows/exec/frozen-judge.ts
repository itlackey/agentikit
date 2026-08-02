// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { LlmConnectionConfig } from "../../core/config/config";
import { deepMergeConfig } from "../../core/config/deep-merge";
import { ConfigError } from "../../core/errors";
import type { FrozenLlmEngine, IrInvocation, WorkflowPlanGraph } from "../ir/schema";
import type { SummaryJudge } from "../validate-summary";
import type { UnitDispatcher } from "./unit-dispatch";

/** Build a gate judge from a v3 catalog entry without consulting live config. */
export function frozenSummaryJudge(
  plan: WorkflowPlanGraph,
  invocation: IrInvocation | null | undefined,
  signal?: AbortSignal,
  dispatcher?: UnitDispatcher,
): SummaryJudge | null {
  if (!invocation) return null;
  const engine = plan.execution?.engines[invocation.engine];
  if (!engine)
    throw new ConfigError(`Frozen gate engine "${invocation.engine}" is unavailable.`, "INVALID_CONFIG_FILE");
  if (engine.kind === "agent") {
    if (!dispatcher) {
      throw new ConfigError(
        `Frozen agent gate engine "${invocation.engine}" has no unit dispatcher.`,
        "INVALID_CONFIG_FILE",
      );
    }
    return async ({ system, user }) => {
      const fallbackEngine = engine.fallbackLlmEngine ? plan.execution.engines[engine.fallbackLlmEngine] : undefined;
      const result = await dispatcher({
        runId: "gate",
        stepId: "gate",
        unitId: "gate",
        nodeId: "gate",
        prompt: user,
        systemPrompt: system,
        engine,
        ...(fallbackEngine?.kind === "llm" ? { fallbackEngine } : {}),
        invocation,
        timeoutMs: invocation.timeoutMs,
        ...(signal ? { signal } : {}),
      });
      if (!result.ok) {
        throw new Error(result.error || `Verification engine "${invocation.engine}" failed.`);
      }
      return result.text;
    };
  }
  return async ({ system, user }) => {
    const { chatCompletion } = await import("../../llm/client");
    return chatCompletion(
      materialize(engine, invocation),
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      {
        timeoutMs: invocation.timeoutMs,
        ...(signal ? { signal } : {}),
      },
    );
  };
}

function materialize(engine: FrozenLlmEngine, invocation: IrInvocation): LlmConnectionConfig {
  let apiKey: string | undefined;
  for (const name of engine.credential?.names ?? []) {
    const value = process.env[name]?.trim();
    if (value) {
      apiKey = value;
      break;
    }
  }
  if (engine.credential?.required && !apiKey)
    throw new ConfigError(
      `Required engine credential ${engine.credential.names[0]} is not set.`,
      "INVALID_CONFIG_FILE",
    );
  const base = {
    provider: engine.provider,
    endpoint: engine.endpoint,
    model: invocation.model ?? engine.model,
    ...(engine.temperature !== undefined ? { temperature: engine.temperature } : {}),
    ...(engine.maxTokens !== undefined ? { maxTokens: engine.maxTokens } : {}),
    ...(engine.supportsJsonSchema !== undefined ? { supportsJsonSchema: engine.supportsJsonSchema } : {}),
    ...(engine.extraParams ? { extraParams: engine.extraParams } : {}),
    ...(engine.contextLength !== undefined ? { contextLength: engine.contextLength } : {}),
    ...(engine.enableThinking !== undefined ? { enableThinking: engine.enableThinking } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
  return (
    invocation.llm ? deepMergeConfig(base, invocation.llm as Record<string, unknown>) : base
  ) as LlmConnectionConfig;
}
