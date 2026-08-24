import type { LlmConnectionConfig } from "../../src/core/config/config-types";
import type { ChatCompletionConfig } from "../../src/llm/client";
import type { StructuredLlmRunner } from "../../src/llm/structured-call";

/** Build symbolic runner material for transport-focused tests without adding a runtime adapter. */
export function testLlmRunner(
  config: ChatCompletionConfig,
  engine = config.provider ?? "test-llm",
): StructuredLlmRunner {
  if (config.apiKey !== undefined) throw new TypeError("test runners must not contain materialized credentials");
  const connection = { ...config };
  delete connection.timeoutMs;
  return {
    kind: "llm",
    engine,
    connection: connection as LlmConnectionConfig,
    ...(Object.hasOwn(config, "timeoutMs") ? { timeoutMs: config.timeoutMs ?? null } : {}),
  };
}
