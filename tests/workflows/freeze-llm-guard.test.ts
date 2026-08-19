// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Bug 7 regression — the freeze-time llm-override guard used to be dead code:
 * `mergedLlmOverrides` was only computed for `kind: "llm"` engines, so the
 * "non-llm engine with llm overrides" branch could never fire. Ordinary
 * process agents still reject them; SDK engines now preserve them as frozen
 * fallback inference instead of dropping them.
 */

import { describe, expect, test } from "bun:test";
import { ConfigError } from "../../src/core/errors";
import type { IrUnitNode } from "../../src/workflows/ir/schema";
import { freezeWorkflow, WORKFLOW_TEST_CONFIG, workflowDoc } from "../_helpers/workflow";

// WORKFLOW_TEST_CONFIG's default engine is `test-agent` (opencode-sdk, an
// agent engine with the `test-llm` fallback) — exactly the shape whose llm
// overrides used to vanish.

describe("bug 7 — llm overrides retain an explicit SDK/agent boundary", () => {
  test("unit-level llm overrides freeze onto the SDK fallback invocation", () => {
    // Spelled out rather than built from `workflowDoc`: this is the one case
    // that asserts the step NAME, and the shared scaffold hard-codes it.
    const markdown = [
      "---",
      "type: workflow",
      "steps:",
      "  - id: review",
      "    unit: { llm: { temperature: 0 } }",
      "---",
      "",
      "## review",
      "",
      "Review.",
      "",
    ].join("\n");
    const plan = freezeWorkflow(markdown);
    const root = plan.steps[0]!.root as IrUnitNode;
    expect(root.invocation).toMatchObject({
      engine: "test-agent",
      model: "test-model",
      llm: { temperature: 0 },
    });
    expect(plan.execution.engines["test-agent"]).toMatchObject({
      sdkFallbackModelFromRequest: true,
    });
  });

  test("document defaults.llm on an ordinary agent still throws", () => {
    const markdown = workflowDoc([], undefined, ["defaults: { llm: { temperature: 0.2 } }"]);
    const config = {
      ...WORKFLOW_TEST_CONFIG,
      engines: {
        ...WORKFLOW_TEST_CONFIG.engines,
        "plain-agent": { kind: "agent" as const, platform: "codex" },
      },
      defaults: { engine: "plain-agent", llmEngine: "test-llm" },
    };
    expect(() => freezeWorkflow(markdown, "workflows/plain-agent.md", config)).toThrow(ConfigError);
    expect(() => freezeWorkflow(markdown, "workflows/plain-agent.md", config)).toThrow(
      /non-SDK agent engine and cannot receive llm/,
    );
  });

  test("llm overrides on an actual LLM engine freeze into the invocation (no false positive)", () => {
    const plan = freezeWorkflow(workflowDoc(["    unit: { engine: test-llm, llm: { temperature: 0 } }"]));
    const root = plan.steps[0]!.root as IrUnitNode;
    expect(root.invocation!.engine).toBe("test-llm");
    expect(root.invocation!.llm).toEqual({ temperature: 0 });
  });

  test("the SDK fallback path is unaffected: an agent engine WITHOUT llm overrides still freezes", () => {
    // `test-agent` is opencode-sdk with the `test-llm` LLM fallback — the
    // fallback resolves a model through a separate mechanism (`llmEngine`),
    // never through the invocation-override layers, so the live guard must
    // not fire on it.
    const plan = freezeWorkflow(workflowDoc([]));
    const root = plan.steps[0]!.root as IrUnitNode;
    expect(root.invocation!.engine).toBe("test-agent");
    expect(root.invocation!.llm).toBeUndefined();
    expect(root.invocation!.model).toBe("test-model"); // resolved via the test-llm fallback
    expect(plan.execution.engines["test-agent"]).toMatchObject({ kind: "agent", fallbackLlmEngine: "test-llm" });
    expect(plan.execution.engines["test-llm"]).toMatchObject({ timeoutMs: 600_000 });
  });
});
