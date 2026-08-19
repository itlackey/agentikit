// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test } from "bun:test";
import type { LoweringNotice } from "../../src/execution/resolved-request";
import {
  _setChatCompletionForTests,
  type ChatCompletionConfig,
  type ChatMessage,
  LlmCallError,
  type LlmCallErrorCode,
} from "../../src/llm/client";
import {
  defaultUnitDispatcher,
  type UnitDispatchRequest,
  type UnitDispatchResult,
} from "../../src/workflows/exec/native-executor";
import type { FrozenLlmEngine } from "../../src/workflows/ir/schema";
import { withEnv } from "../_helpers/sandbox";

afterEach(() => _setChatCompletionForTests(undefined));

const ENGINE: FrozenLlmEngine = {
  name: "frozen-llm",
  kind: "llm",
  provider: "openai-compatible",
  endpoint: "https://frozen.invalid/v1/chat/completions",
  model: "base/model",
  temperature: 0.7,
  maxTokens: 512,
  supportsJsonSchema: false,
  extraParams: { seed: 7, nested: { base: true } },
  contextLength: 16_384,
  enableThinking: false,
  concurrency: 1,
};

function llmRequest(): UnitDispatchRequest {
  return {
    runId: "11111111-1111-4111-8111-111111111111",
    stepId: "review",
    unitId: "review:solo",
    nodeId: "review",
    prompt: "Review the frozen artifact.",
    systemPrompt: "Judge only the supplied evidence.",
    engine: ENGINE,
    invocation: {
      engine: ENGINE.name,
      model: "provider/exact-model",
      timeoutMs: 0,
      llm: { temperature: 0, extraParams: { nested: { invocation: true } } },
    },
    timeoutMs: 0,
    schema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] },
  };
}

describe("workflow frozen execution lowers through the resolved boundary", () => {
  test("preserves timeout, abort, rate-limit, parse, and provider retry reasons through the failed-result envelope", async () => {
    const cases: readonly [LlmCallErrorCode, string][] = [
      ["aborted", "aborted"],
      ["timeout", "timeout"],
      ["rate_limited", "llm_rate_limit"],
      ["parse_error", "parse_error"],
      ["provider_html_error", "parse_error"],
      ["network_error", "spawn_failed"],
      ["provider_error", "spawn_failed"],
    ];
    for (const [code, expected] of cases) {
      _setChatCompletionForTests(async () => {
        throw new LlmCallError(`safe ${code}`, code);
      });
      const result = await defaultUnitDispatcher(llmRequest());
      expect(result).toMatchObject({ ok: false, failureReason: expected, error: `safe ${code}` });
    }
  });

  test("threads the workflow abort signal through the lowered direct-LLM dispatch", async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    _setChatCompletionForTests(async (_config, _messages, options) => {
      seenSignal = options?.signal;
      return "done";
    });

    const result = await defaultUnitDispatcher({ ...llmRequest(), signal: controller.signal });
    expect(result.ok).toBe(true);
    expect(seenSignal).toBe(controller.signal);
  });

  test("redacts the dispatch-time credential out of a direct-LLM provider failure", async () => {
    const name = "WORKFLOW_LOWERING_TEST_KEY";
    const secret = "sk-provider-body-must-not-leak";
    const engine: FrozenLlmEngine = {
      ...ENGINE,
      credential: { names: [name], required: true },
    };
    const request = {
      ...llmRequest(),
      engine,
      invocation: {
        engine: engine.name,
        model: "provider/exact-model",
        timeoutMs: 0,
        llm: { temperature: 0, extraParams: { nested: { invocation: true } } },
      },
    };

    await withEnv({ [name]: secret }, async () => {
      _setChatCompletionForTests(async () => {
        throw new LlmCallError(`provider echoed ${secret}`, "provider_error");
      });
      const result = await defaultUnitDispatcher(request);
      expect(result).toMatchObject({ ok: false, failureReason: "spawn_failed" });
      expect(result.error).toContain("[REDACTED]");
      expect(result.error).not.toContain(secret);
    });
  });

  test("direct LLM dispatch preserves frozen material and reports unsupported schema without prechecking it", async () => {
    let capture:
      | { config: ChatCompletionConfig; messages: ChatMessage[]; options: Record<string, unknown> }
      | undefined;
    _setChatCompletionForTests(async (config, messages, options) => {
      capture = { config, messages, options: (options ?? {}) as Record<string, unknown> };
      return '{"verdict":"pass"}';
    });

    const result = (await defaultUnitDispatcher(llmRequest())) as UnitDispatchResult & {
      notices?: readonly Readonly<LoweringNotice>[];
    };

    expect(result.ok).toBe(true);
    expect(capture).toEqual({
      config: {
        provider: "openai-compatible",
        endpoint: "https://frozen.invalid/v1/chat/completions",
        model: "provider/exact-model",
        temperature: 0,
        maxTokens: 512,
        supportsJsonSchema: false,
        extraParams: { seed: 7, nested: { base: true, invocation: true } },
        contextLength: 16_384,
        enableThinking: false,
        timeoutMs: 0,
      },
      messages: [
        { role: "system", content: "Judge only the supplied evidence." },
        { role: "user", content: "Review the frozen artifact." },
      ],
      options: { timeoutMs: 0 },
    });
    expect(result.notices?.map(({ code, adapter, field }) => ({ code, adapter, field }))).toEqual([
      { code: "untranslated-field", adapter: "llm", field: "outputSchema" },
    ]);
  });
});
