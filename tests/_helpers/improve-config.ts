import type { AkmConfig } from "../../src/core/config/config";

const TEST_LLM_ENGINE = "test-improve-llm";

/**
 * Add a non-networked LLM selection for improve orchestration tests that inject
 * their model calls.
 *
 * Also opts into `experimental.improveAutonomy` (D8). A test reaching for this
 * helper is by definition exercising improve's model-backed lanes — consolidate,
 * memory inference, contradiction detection, memory cleanup — which is exactly
 * the set the autonomy gate suppresses by default. Without the opt-in those
 * suites would assert against lanes that never ran, which is a gate working
 * rather than a feature broken.
 *
 * Tests of the GATE itself must not use this helper: they need the shipped
 * review-first default. See `tests/improve-autonomy-gate.test.ts` and
 * `tests/improve-plan-autonomy-wiring.test.ts`, which build their configs
 * directly. A caller can still opt back out by passing
 * `experimental: { improveAutonomy: false }`, which wins over this default.
 */
export function withTestImproveLlm(config: AkmConfig): AkmConfig {
  return {
    ...config,
    engines: {
      [TEST_LLM_ENGINE]: {
        kind: "llm",
        endpoint: "http://127.0.0.1:1/v1/chat/completions",
        model: "test-model",
      },
      ...config.engines,
    },
    defaults: {
      llmEngine: TEST_LLM_ENGINE,
      ...config.defaults,
    },
    experimental: {
      improveAutonomy: true,
      ...config.experimental,
    },
  };
}
