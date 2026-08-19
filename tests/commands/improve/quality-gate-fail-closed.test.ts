/**
 * 07 P0-2 — the LLM-as-judge quality gate must fail CLOSED.
 *
 * When the judge cannot render a verdict (no LLM configured, parse failure, or
 * timeout/error), minted content must be REJECTED, not passed through. An
 * unverifiable judge waving content into the stash is exactly the injection
 * surface this flip removes.
 */

import { describe, expect, test } from "bun:test";

import { buildReflectJudgePrompt, runLessonQualityJudge } from "../../../src/commands/improve/distill/quality-gate";
import type { AkmConfig } from "../../../src/core/config/config";
import { ConfigError } from "../../../src/core/errors";
import { withEnv } from "../../_helpers/sandbox";

function configWithLlm(): AkmConfig {
  return {
    semanticSearchMode: "auto",
    stashDir: "/tmp/does-not-matter",
    sources: [],
    defaultWriteTarget: "stash",
    engines: {
      default: {
        kind: "llm",
        endpoint: "http://localhost:11434/v1/chat/completions",
        model: "test-model",
      },
    },
    defaults: { llmEngine: "default" },
  } as unknown as AkmConfig;
}

function configWithoutLlm(): AkmConfig {
  return {
    semanticSearchMode: "auto",
    stashDir: "/tmp/does-not-matter",
    sources: [],
    defaultWriteTarget: "stash",
    engines: {},
    defaults: {},
  } as unknown as AkmConfig;
}

describe("runLessonQualityJudge — fail-CLOSED (07 P0-2)", () => {
  test("parse failure → pass:false (score -1)", async () => {
    const result = await runLessonQualityJudge(
      configWithLlm(),
      "some lesson body",
      "some source body",
      // Non-JSON judge response → parse failure.
      async () => "this is not json at all",
    );
    expect(result.pass).toBe(false);
    expect(result.score).toBe(-1);
    expect(result.reviewNeeded).toBeUndefined();
  });

  test("no LLM configured → pass:false (score -1)", async () => {
    const result = await runLessonQualityJudge(configWithoutLlm(), "some lesson body", "some source body", async () => {
      throw new Error("chat must not be called when no LLM is configured");
    });
    expect(result.pass).toBe(false);
    expect(result.score).toBe(-1);
  });

  test("judge throws (timeout/error) → pass:false (score -1)", async () => {
    const result = await runLessonQualityJudge(configWithLlm(), "some lesson body", "some source body", async () => {
      throw new Error("upstream boom");
    });
    expect(result.pass).toBe(false);
    expect(result.score).toBe(-1);
  });

  test("missing required symbolic credential remains a hard config failure", async () => {
    const config = configWithLlm();
    config.engines = {
      default: {
        ...config.engines?.default,
        kind: "llm",
        endpoint: "http://localhost:11434/v1/chat/completions",
        model: "test-model",
        apiKey: "$AKM_QUALITY_REQUIRED_KEY",
      },
    };
    let chatCalls = 0;

    const failure = withEnv({ AKM_QUALITY_REQUIRED_KEY: undefined }, () =>
      runLessonQualityJudge(config, "some lesson body", "some source body", async () => {
        chatCalls += 1;
        return JSON.stringify({ score: 4, reason: "wrong" });
      }),
    );

    await expect(failure).rejects.toBeInstanceOf(ConfigError);
    await expect(failure).rejects.toMatchObject({ code: "INVALID_CONFIG_FILE" });
    expect(chatCalls).toBe(0);
  });

  test("real passing verdict still passes (score >= 3.5)", async () => {
    const result = await runLessonQualityJudge(configWithLlm(), "some lesson body", "some source body", async () =>
      JSON.stringify({ score: 4.5, reason: "adds new info" }),
    );
    expect(result.pass).toBe(true);
    expect(result.score).toBeCloseTo(4.5, 9);
  });

  test("disables thinking for the JSON-only judge call", async () => {
    let enableThinking: boolean | undefined;
    const result = await runLessonQualityJudge(
      configWithLlm(),
      "some lesson body",
      "some source body",
      async (connection, _messages, options) => {
        // Resolved execution canonicalizes inference onto the lowered
        // connection; assert the same effective provider value.
        enableThinking = options?.enableThinking ?? connection.enableThinking;
        return JSON.stringify({ score: 4.5, reason: "adds new info" });
      },
    );

    expect(result.pass).toBe(true);
    expect(enableThinking).toBe(false);
  });

  test.each(["0", "5.1", "1e999"])("rejects an out-of-range or non-finite score: %s", async (score) => {
    const result = await runLessonQualityJudge(
      configWithLlm(),
      "some lesson body",
      "some source body",
      async () => `{"score":${score},"reason":"invalid"}`,
    );
    expect(result.pass).toBe(false);
    expect(result.score).toBe(-1);
  });

  test("forwards the shared signal and remaining timeout", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let receivedTimeout: number | null | undefined;
    const result = await runLessonQualityJudge(
      configWithLlm(),
      "some lesson body",
      "some source body",
      async (_config, _messages, options) => {
        receivedSignal = options?.signal;
        receivedTimeout = options?.timeoutMs;
        return JSON.stringify({ score: 4.5, reason: "bounded" });
      },
      { signal: controller.signal, timeoutMs: 1234 },
    );

    expect(result.pass).toBe(true);
    expect(receivedSignal).toBe(controller.signal);
    expect(receivedTimeout).toBe(1234);
  });
});

describe("buildReflectJudgePrompt", () => {
  test("keeps late changed content in bounded diff context", () => {
    const source = `${"source line\n".repeat(400)}old ending`;
    const candidate = `${"source line\n".repeat(400)}LATE_CHANGED_MARKER`;
    const prompt = buildReflectJudgePrompt(candidate, source, []);

    expect(prompt).toContain("LATE_CHANGED_MARKER");
    expect(prompt).toContain("Changed region:");
    expect(prompt.length).toBeLessThan(25_000);
  });
});
