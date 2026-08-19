// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import type { AkmConfig } from "../../src/core/config/config";
import { ConfigError } from "../../src/core/errors";
import { canonicalResolvedExecutionRequest } from "../../src/execution/resolved-request";
import type { UnresolvedExecutionDefaults } from "../../src/execution/source";
import { composeConversationFallbackPrompt } from "../../src/integrations/agent/conversation-fallback";
import {
  dispatchLoweredExecutionRequest,
  lowerResolvedExecutionRequest,
  lowerResolvedExecutionRequestWithRunner,
} from "../../src/integrations/agent/execution-lowering";
import {
  prepareInlineExecution,
  prepareInlineExecutionWithRunner,
} from "../../src/integrations/agent/inline-execution";
import { prepareFrozenWorkflowExecution, type UnitDispatchRequest } from "../../src/workflows/exec/unit-dispatch";
import { canonicalPlanJson, computePlanHash } from "../../src/workflows/ir/plan-hash";
import type { FrozenAgentEngine, FrozenLlmEngine, IrUnitNode } from "../../src/workflows/ir/schema";
import { decodeWorkflowPlanV3 } from "../../src/workflows/ir/schema";
import { freezeWorkflow, WORKFLOW_TEST_CONFIG, workflowDoc } from "../_helpers/workflow";

const PRIMARY = "FROZEN_CRED_PRIMARY";
const FALLBACK = "FROZEN_CRED_FALLBACK";

function withEnv<T>(vars: Record<string, string | undefined>, body: () => T): T {
  const original = Object.keys(vars).map((key): [string, string | undefined] => [key, process.env[key]]);
  const apply = (entries: Iterable<[string, string | undefined]>): void => {
    for (const [key, value] of entries) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(Object.entries(vars));
  try {
    return body();
  } finally {
    apply(original);
  }
}

async function withEnvAsync<T>(vars: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
  const original = Object.keys(vars).map((key): [string, string | undefined] => [key, process.env[key]]);
  const apply = (entries: Iterable<[string, string | undefined]>): void => {
    for (const [key, value] of entries) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(Object.entries(vars));
  try {
    return await body();
  } finally {
    apply(original);
  }
}

function llmSnapshot(credential?: { names: [string, ...string[]]; required: boolean }): FrozenLlmEngine {
  return {
    name: "fast",
    kind: "llm",
    provider: "openai-compatible",
    endpoint: "https://example.test/v1/chat/completions",
    model: "base/model",
    timeoutMs: 600_000,
    concurrency: 1,
    temperature: 0.7,
    maxTokens: 512,
    supportsJsonSchema: false,
    extraParams: { seed: 3, nested: { base: true } },
    contextLength: 8_192,
    enableThinking: false,
    ...(credential ? { credential } : {}),
  };
}

const SCHEMA = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };

function llmRequest(engine = llmSnapshot()): UnitDispatchRequest & { engine: FrozenLlmEngine } {
  return {
    runId: "11111111-1111-4111-8111-111111111111",
    stepId: "review",
    unitId: "review:solo",
    nodeId: "review",
    prompt: "Review the frozen artifact.",
    systemPrompt: "Use only frozen evidence.",
    engine,
    invocation: {
      engine: engine.name,
      model: "provider/exact-model",
      timeoutMs: 0,
      llm: { temperature: 0, extraParams: { nested: { invocation: true } } },
    },
    timeoutMs: 0,
    schema: SCHEMA,
  };
}

describe("frozen workflow execution preparation", () => {
  test.each([
    ["fallback-derived", false, true, true],
    ["engine-primary", true, true, false],
    ["no-fallback", false, false, false],
  ] as const)("keeps real direct/task and frozen-workflow SDK runners byte-exact for %s ownership", (_label, ownsPrimaryModel, hasFallback, fallbackOwnsRequestModel) => {
    const config = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: {
        sdk: {
          kind: "agent",
          platform: "opencode-sdk",
          ...(hasFallback ? { llmEngine: "fallback" } : {}),
          ...(ownsPrimaryModel ? { model: "provider/configured-primary" } : {}),
        },
        ...(hasFallback
          ? {
              fallback: {
                kind: "llm" as const,
                provider: "openai-compatible",
                endpoint: "https://fallback.invalid/v1/chat/completions",
                model: "provider/configured-fallback",
                temperature: 0.25,
                maxTokens: 512,
                supportsJsonSchema: false,
                extraParams: { seed: 3, nested: { base: true } },
                contextLength: 8_192,
                enableThinking: false,
                timeoutMs: 12_345,
              },
            }
          : {}),
      },
      defaults: { engine: "sdk", ...(hasFallback ? { llmEngine: "fallback" } : {}) },
    } as unknown as AkmConfig;
    const plan = freezeWorkflow(workflowDoc([]), "workflows/sdk-parity.md", config);
    const root = plan.steps[0]?.root as IrUnitNode | undefined;
    const engine = plan.execution.engines.sdk;
    const fallbackEngine = plan.execution.engines.fallback;
    if (
      !root?.invocation ||
      engine?.kind !== "agent" ||
      (hasFallback && fallbackEngine?.kind !== "llm") ||
      (!hasFallback && fallbackEngine !== undefined)
    ) {
      throw new Error("fixture must freeze the expected SDK invocation ownership");
    }
    expect(engine.sdkFallbackModelFromRequest).toBe(fallbackOwnsRequestModel);
    expect(root.invocation.modelPresent).toBe(false);
    if (fallbackEngine?.kind === "llm") expect(fallbackEngine.timeoutMs).toBe(12_345);

    const modelCases = [
      ["omitted", undefined],
      ["string", "provider/operator-model"],
      ["null", null],
    ] as const;
    const inferenceCases = [
      ["omitted", undefined],
      ["object", { temperature: 0, extraParams: { nested: { invocation: true } } }],
    ] as const;
    const timeoutCases = [
      ["omitted", undefined],
      ["zero", 0],
      ["null", null],
      ["value", 7_777],
    ] as const;

    for (const [modelName, model] of modelCases) {
      for (const [inferenceName, inference] of inferenceCases) {
        for (const [timeoutName, timeout] of timeoutCases) {
          const current: Record<string, unknown> = {};
          if (modelName !== "omitted") current.model = model;
          if (inferenceName !== "omitted") current.inference = inference;
          if (timeoutName !== "omitted") current.timeout = timeout;
          const frozenModel = modelName === "omitted" ? root.invocation.model : model;
          const frozenTimeout = timeoutName === "omitted" ? root.invocation.timeoutMs : timeout;
          const invocation = {
            ...root.invocation,
            model: frozenModel,
            modelPresent: modelName !== "omitted",
            timeoutMs: frozenTimeout,
            ...(inferenceName !== "omitted" ? { llm: inference } : {}),
          };
          const content = `${_label}:${modelName}:${inferenceName}:${timeoutName}`;
          const frozen = prepareFrozenWorkflowExecution({
            runId: "11111111-1111-4111-8111-111111111111",
            stepId: "work",
            unitId: "work:solo",
            nodeId: "work",
            prompt: content,
            engine,
            ...(fallbackEngine?.kind === "llm" ? { fallbackEngine } : {}),
            invocation,
            timeoutMs: frozenTimeout,
          });

          for (const invocationKind of ["direct", "task"] as const) {
            const livePrepared = prepareInlineExecution({
              content,
              config,
              invocationKind,
              current: current as UnresolvedExecutionDefaults,
            });
            const live = lowerResolvedExecutionRequest(livePrepared.request, livePrepared.config);
            expect(canonicalResolvedExecutionRequest(frozen.request)).toBe(
              canonicalResolvedExecutionRequest(live.request),
            );
            expect(frozen.notices).toEqual(live.notices);
            expect(frozen.runner).toEqual(live.runner);
          }
        }
      }
    }
  });

  test("decodes legacy v3 ownership bytes unchanged and preserves their marker-false dispatch", () => {
    const config = {
      ...WORKFLOW_TEST_CONFIG,
      engines: {
        sdk: { kind: "agent" as const, platform: "opencode-sdk", llmEngine: "fallback" },
        fallback: {
          kind: "llm" as const,
          endpoint: "https://fallback.invalid/v1/chat/completions",
          model: "provider/configured-fallback",
          timeoutMs: 12_345,
        },
      },
      defaults: { engine: "sdk", llmEngine: "fallback" },
    };
    const legacy = structuredClone(freezeWorkflow(workflowDoc([]), "workflows/legacy-sdk.md", config));
    const legacySdk = legacy.execution.engines.sdk;
    const legacyFallback = legacy.execution.engines.fallback;
    if (legacySdk?.kind !== "agent" || legacyFallback?.kind !== "llm") throw new Error("fixture must be SDK");
    delete legacySdk.sdkFallbackModelFromRequest;
    delete legacyFallback.timeoutMs;
    const legacyRoot = legacy.steps[0]?.root as IrUnitNode | undefined;
    if (!legacyRoot?.invocation) throw new Error("fixture must have an invocation");
    delete legacyRoot.invocation.modelPresent;
    const bytes = canonicalPlanJson(legacy);
    const hash = computePlanHash(legacy);

    const decoded = decodeWorkflowPlanV3(JSON.parse(bytes));
    expect(canonicalPlanJson(decoded)).toBe(bytes);
    expect(computePlanHash(decoded)).toBe(hash);
    const root = decoded.steps[0]?.root as IrUnitNode | undefined;
    const engine = decoded.execution.engines.sdk;
    const fallbackEngine = decoded.execution.engines.fallback;
    if (!root?.invocation || engine?.kind !== "agent" || fallbackEngine?.kind !== "llm") {
      throw new Error("decoded legacy fixture must remain dispatchable");
    }
    const lowered = prepareFrozenWorkflowExecution({
      runId: "11111111-1111-4111-8111-111111111111",
      stepId: "work",
      unitId: "work:solo",
      nodeId: "work",
      prompt: "Legacy dispatch.",
      engine,
      fallbackEngine,
      invocation: { ...root.invocation, model: "provider/operator-primary" },
      timeoutMs: root.invocation.timeoutMs,
    });
    expect(lowered.runner).toMatchObject({
      kind: "sdk",
      profile: { model: "provider/operator-primary" },
      fallbackConnection: { model: "provider/configured-fallback" },
      fallbackTimeoutMs: null,
    });
  });

  test("preserves exact LLM model, inference, schema, runtime, system turn, and command without config", () => {
    const lowered = prepareFrozenWorkflowExecution(llmRequest());

    expect(lowered.adapter).toBe("llm");
    expect(lowered.request.command.content).toBe("Review the frozen artifact.");
    expect(lowered.request.conversation).toEqual([{ role: "system", content: "Use only frozen evidence." }]);
    expect(lowered.request.model).toEqual({
      input: "provider/exact-model",
      interpretation: "exact",
      resolved: "provider/exact-model",
    });
    expect(lowered.request.inference).toEqual({
      temperature: 0,
      maxTokens: 512,
      supportsJsonSchema: false,
      extraParams: { seed: 3, nested: { base: true, invocation: true } },
      contextLength: 8_192,
      enableThinking: false,
    });
    expect(lowered.request.outputSchema).toEqual(SCHEMA);
    expect(lowered.request.runtime).toEqual({ timeoutMs: 0 });
    expect(lowered.request.authorization).toEqual({ status: "not-required" });
    expect("messages" in lowered ? lowered.messages : undefined).toEqual([
      { role: "system", content: "Use only frozen evidence." },
      { role: "user", content: "Review the frozen artifact." },
    ]);
    expect(lowered.notices.map(({ code, adapter, field }) => ({ code, adapter, field }))).toEqual([
      { code: "untranslated-field", adapter: "llm", field: "outputSchema" },
    ]);
  });

  test("agent lowering preserves exact model/runtime/env/schema and composes the system turn once", () => {
    const engine: FrozenAgentEngine = {
      name: "reviewer",
      kind: "agent",
      runnerKind: "agent",
      platform: "codex",
      bin: "codex",
      args: ["exec"],
      workspace: "/frozen/workspace",
      envPassthrough: ["PATH"],
      commandBuilder: "codex",
      fallbackLlmEngine: null,
      sdkFallbackModelFromRequest: false,
    };
    const request: UnitDispatchRequest = {
      runId: "11111111-1111-4111-8111-111111111111",
      stepId: "review",
      unitId: "review:solo",
      nodeId: "review",
      prompt: "Review once.",
      systemPrompt: "System once.",
      engine,
      invocation: { engine: engine.name, model: "fast", timeoutMs: null },
      timeoutMs: null,
      schema: SCHEMA,
      cwd: "/unit/worktree",
      env: { UNIT_TOKEN: "secret-value" },
    };

    const lowered = prepareFrozenWorkflowExecution(request);
    expect(lowered.runner).toMatchObject({
      kind: "agent",
      engine: "reviewer",
      profile: { model: "fast", modelIsExact: true, workspace: "/unit/worktree" },
      timeoutMs: null,
    });
    expect(lowered.request.runtime).toEqual({
      timeoutMs: null,
      workspace: "/unit/worktree",
      environment: { UNIT_TOKEN: "secret-value" },
    });
    expect(lowered.request.outputSchema).toEqual(SCHEMA);
    expect(lowered.prompt).toBe(
      composeConversationFallbackPrompt([{ role: "system", content: "System once." }], "Review once."),
    );
    expect(lowered.prompt.match(/System once\./g)).toHaveLength(1);
    expect(lowered.prompt.match(/Review once\./g)).toHaveLength(1);
    expect(lowered.notices.map((notice) => notice.code)).toEqual(["conversation-prompt-composed"]);
  });

  test("SDK fallback stays symbolic and exact until dispatch", () => {
    const engine: FrozenAgentEngine = {
      name: "sdk",
      kind: "agent",
      runnerKind: "sdk",
      platform: "opencode-sdk",
      bin: "opencode",
      args: [],
      workspace: null,
      envPassthrough: [],
      commandBuilder: "opencode-sdk",
      fallbackLlmEngine: "fast",
      sdkFallbackModelFromRequest: false,
    };
    const request: UnitDispatchRequest = {
      runId: "11111111-1111-4111-8111-111111111111",
      stepId: "review",
      unitId: "review:solo",
      nodeId: "review",
      prompt: "Review.",
      engine,
      fallbackEngine: llmSnapshot({ names: [PRIMARY, FALLBACK], required: true }),
      invocation: { engine: engine.name, model: "provider/sdk-exact", timeoutMs: 1_234 },
      timeoutMs: 1_234,
    };

    const lowered = withEnv({ [PRIMARY]: undefined, [FALLBACK]: undefined }, () =>
      prepareFrozenWorkflowExecution(request),
    );
    expect(lowered.runner).toMatchObject({
      kind: "sdk",
      engine: "sdk",
      profile: { model: "provider/sdk-exact", modelIsExact: true },
      fallbackConnection: {
        endpoint: "https://example.test/v1/chat/completions",
        model: "base/model",
        contextLength: 8_192,
      },
      fallbackCredential: { names: [PRIMARY, FALLBACK], required: true },
      timeoutMs: 1_234,
    });
    expect("apiKey" in (lowered.runner.kind === "sdk" ? (lowered.runner.fallbackConnection ?? {}) : {})).toBe(false);
  });

  test("required credentials are untouched by authorization/lowering and materialized only at dispatch", async () => {
    const lowered = withEnv({ [PRIMARY]: undefined, [FALLBACK]: undefined }, () =>
      prepareFrozenWorkflowExecution(llmRequest(llmSnapshot({ names: [PRIMARY, FALLBACK], required: true }))),
    );
    expect(lowered.runner.kind).toBe("llm");
    expect("apiKey" in (lowered.runner.kind === "llm" ? lowered.runner.connection : {})).toBe(false);

    await withEnvAsync({ [PRIMARY]: undefined, [FALLBACK]: undefined }, async () => {
      await expect(
        dispatchLoweredExecutionRequest(lowered, { chat: async () => "must not dispatch" }),
      ).rejects.toMatchObject({
        name: ConfigError.name,
        code: "INVALID_CONFIG_FILE",
      });
    });

    await withEnvAsync({ [PRIMARY]: "   ", [FALLBACK]: " dispatch-secret " }, async () => {
      let apiKey: string | undefined;
      const result = await dispatchLoweredExecutionRequest(lowered, {
        chat: async (connection) => {
          apiKey = connection.apiKey;
          return "done";
        },
      });
      expect(apiKey).toBe("dispatch-secret");
      expect(result.ok).toBe(true);
    });
  });

  test("the same frozen material produces byte-identical requests for direct, task, and workflow entry points", () => {
    const workflow = prepareFrozenWorkflowExecution(llmRequest());
    const common = {
      content: workflow.request.command.content,
      runner: workflow.runner,
      conversation: workflow.request.conversation,
      current: { outputSchema: SCHEMA, timeout: 0 },
    } as const;
    const requests = (["direct", "task"] as const).map((invocationKind) => {
      const prepared = prepareInlineExecutionWithRunner({ ...common, invocationKind });
      return lowerResolvedExecutionRequestWithRunner(prepared.request, prepared.runner).request;
    });
    requests.push(workflow.request);

    const canonical = requests.map(canonicalResolvedExecutionRequest);
    expect(new Set(canonical).size).toBe(1);
  });
});
