import type { AkmConfig } from "../../src/core/config/config";
import { compileResolveFreezeWorkflow } from "../../src/workflows/ir/freeze";
import { canonicalPlanJson, computePlanHash } from "../../src/workflows/ir/plan-hash";
import type { WorkflowPlanGraph } from "../../src/workflows/ir/schema";
import { parseWorkflow } from "../../src/workflows/parser";
import { frozenStepRows } from "../../src/workflows/runtime/plan-classifier";

export const WORKFLOW_TEST_CONFIG = {
  configVersion: "0.9.0",
  semanticSearchMode: "off",
  engines: {
    "test-agent": { kind: "agent", platform: "opencode-sdk" },
    "test-llm": {
      kind: "llm",
      endpoint: "http://localhost:1/v1/chat/completions",
      model: "test-model",
    },
  },
  defaults: { engine: "test-agent", llmEngine: "test-llm" },
  workflow: { judgeEngine: "test-llm" },
} as const satisfies AkmConfig;

/**
 * Parse + compile + freeze a unified workflow markdown document (workflow-
 * format-unification). Replaces the pre-unification `freezeWorkflowProgram`
 * (YAML program) / `freezeMarkdownWorkflow` (classic linear markdown) split —
 * one frontend now.
 */
export function freezeWorkflow(markdown: string, sourcePath = "workflows/demo.md"): WorkflowPlanGraph {
  const parsed = parseWorkflow(markdown, { path: sourcePath });
  if (!parsed.ok) {
    throw new Error(parsed.errors.map((error) => `${error.line}: ${error.message}`).join(" | "));
  }
  const title = sourcePath.split("/").pop()?.replace(/\.md$/i, "") || "demo";
  return compileResolveFreezeWorkflow(
    {
      ref: `workflows/${title}`,
      path: sourcePath,
      sourcePath: "/tmp",
      title,
      steps: [],
      document: parsed.document,
    },
    WORKFLOW_TEST_CONFIG,
  ).plan;
}

export function storeFrozenWorkflowPlan(
  db: { prepare(sql: string): { run(...params: unknown[]): unknown } },
  runId: string,
  plan: WorkflowPlanGraph,
): void {
  for (const step of frozenStepRows(plan)) {
    db.prepare(
      `UPDATE workflow_run_steps
         SET step_title = ?, instructions = ?, completion_json = ?, sequence_index = ?
         WHERE run_id = ? AND step_id = ?`,
    ).run(step.stepTitle, step.instructions, step.completionJson, step.sequenceIndex, runId, step.stepId);
  }
  db.prepare("UPDATE workflow_runs SET plan_json = ?, plan_hash = ?, plan_ir_version = 3 WHERE id = ?").run(
    canonicalPlanJson(plan),
    computePlanHash(plan),
    runId,
  );
}
