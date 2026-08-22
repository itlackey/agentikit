// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { LlmConnectionConfig } from "../../core/config/config";
import { deepMergeConfig } from "../../core/config/deep-merge";
import { ConfigError } from "../../core/errors";
import type { LoweringNotice } from "../../execution/resolved-request";
import {
  dispatchLoweredExecutionRequest,
  type LoweredExecutionRequest,
  lowerResolvedExecutionRequestWithRunner,
} from "../../integrations/agent/execution-lowering";
import { prepareInlineExecutionWithRunner } from "../../integrations/agent/inline-execution";
import type { RunnerSpec } from "../../integrations/agent/runner";
import type { AgentTokenUsage } from "../../integrations/agent/spawn";
import { getHarness } from "../../integrations/harnesses";
import type { FrozenEngineSnapshot, IrExecSpec, IrInvocation } from "../ir/schema";

/** Everything the dispatcher needs to run one frozen workflow unit. */
export interface UnitDispatchRequest {
  runId: string;
  stepId: string;
  unitId: string;
  nodeId: string;
  /** Fully assembled user prompt. */
  prompt: string;
  /** Optional system prompt, used by frozen workflow gate judges. */
  systemPrompt?: string;
  /**
   * Frozen v3 engine snapshot. Dispatch never consults live config. Absent on
   * `exec` units, which name no engine — see {@link UnitDispatchRequest.exec}.
   */
  engine?: FrozenEngineSnapshot;
  fallbackEngine?: Extract<FrozenEngineSnapshot, { kind: "llm" }>;
  /** Engine dispatch settings. Present on exactly the units that reach an engine. */
  invocation?: IrInvocation;
  /**
   * Frozen shell command for an `exec` unit — argv, relative cwd, resolved
   * timeout. Present on EXACTLY the units that carry no `engine`/`invocation`;
   * the frozen-plan decoder enforces that exclusive-or, so a dispatcher can
   * branch on this field alone.
   */
  exec?: IrExecSpec;
  /**
   * `AKM_*` context environment for an exec unit's child — run/step/unit ids,
   * the run params, a map unit's item + index, and the step's declared
   * `inputs:` artifacts, all as canonical JSON. Applied ON TOP of {@link env}
   * so an engine-authored context variable cannot be shadowed by a binding.
   * Kept separate from `env` on purpose: `env` values are the resolved SECRETS
   * that must be redacted out of the journal, and these plainly are not.
   */
  execContext?: Record<string, string>;
  timeoutMs: number | null;
  schema?: Record<string, unknown>;
  /** Resolved env bindings to merge into the child environment. */
  env?: Record<string, string>;
  /** Exact values that must be removed before output reaches the journal. */
  sensitiveValues?: readonly string[];
  /** Working directory for the unit's child process or SDK session. */
  cwd?: string;
  signal?: AbortSignal;
}

export interface UnitDispatchResult {
  ok: boolean;
  /** Normalized final text, or raw text when the harness has no extractor. */
  text: string;
  /** Harness-native session id, when available. */
  sessionId?: string;
  /** Structured failure vocabulary used by workflow retry policies. */
  failureReason?: string;
  error?: string;
  usage?: AgentTokenUsage;
  /** Safe, structured diagnostics emitted by the common execution lowerer. */
  notices?: readonly Readonly<LoweringNotice>[];
}

/** The one dispatch seam. `feedback` carries a structured-output retry prompt. */
export type UnitDispatcher = (request: UnitDispatchRequest, feedback?: string) => Promise<UnitDispatchResult>;

function frozenLlmConnection(
  snapshot: Extract<FrozenEngineSnapshot, { kind: "llm" }>,
  invocation: IrInvocation,
): LlmConnectionConfig {
  const base: LlmConnectionConfig = {
    ...(snapshot.provider !== undefined ? { provider: snapshot.provider } : {}),
    endpoint: snapshot.endpoint,
    model: invocation.model ?? snapshot.model,
    ...(snapshot.temperature !== undefined ? { temperature: snapshot.temperature } : {}),
    ...(snapshot.maxTokens !== undefined ? { maxTokens: snapshot.maxTokens } : {}),
    ...(snapshot.supportsJsonSchema !== undefined ? { supportsJsonSchema: snapshot.supportsJsonSchema } : {}),
    ...(snapshot.extraParams ? { extraParams: snapshot.extraParams } : {}),
    ...(snapshot.contextLength !== undefined ? { contextLength: snapshot.contextLength } : {}),
    ...(snapshot.enableThinking !== undefined ? { enableThinking: snapshot.enableThinking } : {}),
  };
  return invocation.llm
    ? (deepMergeConfig(base, invocation.llm as Record<string, unknown>) as LlmConnectionConfig)
    : base;
}

export function frozenWorkflowRunner(request: {
  readonly engine: FrozenEngineSnapshot;
  readonly invocation: IrInvocation;
  readonly fallbackEngine?: Extract<FrozenEngineSnapshot, { kind: "llm" }>;
}): RunnerSpec {
  const { engine, invocation } = request;
  if (invocation.engine !== engine.name) {
    throw new ConfigError(
      `Frozen workflow invocation selected engine ${JSON.stringify(invocation.engine)}, but its snapshot is ${JSON.stringify(engine.name)}.`,
      "INVALID_CONFIG_FILE",
    );
  }
  if (engine.kind === "llm") {
    return {
      kind: "llm",
      engine: engine.name,
      connection: frozenLlmConnection(engine, invocation),
      ...(engine.credential ? { credential: engine.credential } : {}),
      timeoutMs: invocation.timeoutMs,
    };
  }

  const profile = {
    name: engine.name,
    platform: engine.platform,
    bin: engine.bin,
    args: engine.args,
    stdio: "captured" as const,
    envPassthrough: engine.envPassthrough,
    parseOutput: "text" as const,
    ...(engine.runnerKind === "sdk" ? { personaChannel: "native" as const } : {}),
    ...(engine.workspace !== null ? { workspace: engine.workspace } : {}),
    ...(invocation.model !== null && (engine.runnerKind === "agent" || engine.sdkFallbackModelFromRequest !== true)
      ? { model: invocation.model, modelIsExact: true }
      : {}),
  };
  if (engine.runnerKind === "agent") {
    return { kind: "agent", engine: engine.name, profile, timeoutMs: invocation.timeoutMs };
  }

  const fallback = request.fallbackEngine;
  return {
    kind: "sdk",
    engine: engine.name,
    profile,
    ...(fallback
      ? {
          fallbackConnection: frozenLlmConnection(fallback, {
            engine: fallback.name,
            model: fallback.model,
            timeoutMs: null,
          }),
          ...(fallback.credential ? { fallbackCredential: fallback.credential } : {}),
          fallbackTimeoutMs: fallback.timeoutMs ?? null,
        }
      : {}),
    timeoutMs: invocation.timeoutMs,
  };
}

/**
 * Prepare and lower one frozen workflow invocation without consulting live
 * config, model aliases, environment variables, credentials, or transports.
 */
export function prepareFrozenWorkflowExecution(
  request: UnitDispatchRequest,
  prompt = request.prompt,
): LoweredExecutionRequest {
  if (!request.engine || !request.invocation) {
    throw new ConfigError(
      `unit ${JSON.stringify(request.unitId)} has no frozen engine invocation to prepare.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const engineRequest = request as UnitDispatchRequest & {
    engine: FrozenEngineSnapshot;
    invocation: IrInvocation;
  };
  const runner = frozenWorkflowRunner(engineRequest);
  // New v3 plans persist source presence. Legacy v3 encoded absence as null
  // and a selected model as a string, so keep that exact compatibility rule.
  const projectsInvocationModel = Object.hasOwn(engineRequest.invocation, "modelPresent")
    ? engineRequest.invocation.modelPresent === true
    : engineRequest.invocation.model !== null;
  const current: import("../../execution/source").UnresolvedExecutionDefaults = {
    ...(request.schema !== undefined
      ? { outputSchema: request.schema as import("../../execution/json").ExecutionJsonObject }
      : {}),
    timeout: request.timeoutMs,
    ...(projectsInvocationModel ? { model: engineRequest.invocation.model } : {}),
    ...(Object.hasOwn(engineRequest.invocation, "llm")
      ? {
          inference: engineRequest.invocation.llm as unknown as import("../../execution/json").ExecutionJsonObject,
        }
      : {}),
    ...(request.cwd !== undefined ? { workspace: request.cwd } : {}),
    ...(request.env !== undefined ? { environment: request.env } : {}),
  };
  const prepared = prepareInlineExecutionWithRunner({
    content: prompt,
    runner,
    invocationKind: "workflow",
    ...(request.systemPrompt !== undefined
      ? { conversation: [{ role: "system" as const, content: request.systemPrompt }] }
      : {}),
    current,
    ...(engineRequest.engine.kind === "agent"
      ? { sdkFallbackModelFromRequest: engineRequest.engine.sdkFallbackModelFromRequest === true }
      : {}),
  });
  return lowerResolvedExecutionRequestWithRunner(prepared.request, prepared.runner);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Dispatch one frozen workflow engine call through the common prepared/lowered
 * seam. Credential materialization happens inside the final dispatch only.
 */
export async function dispatchFrozenWorkflowExecution(
  request: UnitDispatchRequest,
  feedback?: string,
): Promise<UnitDispatchResult> {
  const prompt = feedback ? `${request.prompt}\n\n${feedback}` : request.prompt;
  const lowered = prepareFrozenWorkflowExecution(request, prompt);
  const notices = lowered.notices.length > 0 ? lowered.notices : undefined;

  if (request.env && Object.keys(request.env).length > 0 && lowered.runner.kind === "llm") {
    return {
      ok: false,
      text: "",
      failureReason: "env_unsupported",
      error:
        `unit ${JSON.stringify(request.unitId)} declares env bindings, which require a child process ` +
        `(agent or sdk runner) — the "llm" runner cannot inject a per-unit child environment.`,
      ...(notices ? { notices } : {}),
    };
  }
  if (request.cwd && lowered.runner.kind === "llm") {
    return {
      ok: false,
      text: "",
      failureReason: "isolation_unsupported",
      error:
        `unit ${JSON.stringify(request.unitId)} declares isolation: worktree but resolved to the "llm" runner, ` +
        `which has no working directory to isolate. Use the agent or sdk runner for isolated units.`,
      ...(notices ? { notices } : {}),
    };
  }

  let result: Awaited<ReturnType<typeof dispatchLoweredExecutionRequest>>;
  try {
    result = await dispatchLoweredExecutionRequest(lowered, {
      runOptions: {
        stdio: "captured",
        parseOutput: "text",
        ...(request.signal ? { signal: request.signal } : {}),
      },
    });
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    return {
      ok: false,
      text: "",
      failureReason: "dispatch_error",
      error: message(err),
      ...(notices ? { notices } : {}),
    };
  }

  let text = result.stdout;
  let sessionId = result.sessionId;
  if (lowered.runner.kind === "agent" && result.ok) {
    const harness = getHarness(lowered.runner.profile.platform ?? lowered.runner.profile.name);
    if (harness?.resultExtractor) {
      const extraction = harness.resultExtractor(result);
      text = extraction.text;
      if (extraction.sessionId !== undefined) sessionId = extraction.sessionId;
    }
  }

  return {
    ok: result.ok,
    text,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(result.reason ? { failureReason: result.reason } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
    ...(notices ? { notices } : {}),
  };
}
