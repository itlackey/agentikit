import type { AkmConfig } from "../../src/core/config/config";
import { compileResolveFreezeWorkflow, type FreezeOptions } from "../../src/workflows/ir/freeze";
import { canonicalPlanJson, computePlanHash } from "../../src/workflows/ir/plan-hash";
import type { WorkflowPlanGraph } from "../../src/workflows/ir/schema";
import { parseWorkflow } from "../../src/workflows/parser";
import { frozenStepRows } from "../../src/workflows/runtime/plan-classifier";
import type { WorkflowError } from "../../src/workflows/schema";

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
 *
 * `config` defaults to {@link WORKFLOW_TEST_CONFIG}; suites with their own
 * engine catalog pass it explicitly. `options` are threaded straight through
 * to {@link compileResolveFreezeWorkflow} (e.g. the `compile` test seam).
 */
export function freezeWorkflow(
  markdown: string,
  sourcePath = "workflows/demo.md",
  config: AkmConfig = WORKFLOW_TEST_CONFIG,
  options: FreezeOptions = {},
): WorkflowPlanGraph {
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
    config,
    options,
  ).plan;
}

/** Parse a workflow document and return its parser errors (`[]` when it parses cleanly). */
export function parseErrors(markdown: string, sourcePath = "workflows/test.md"): WorkflowError[] {
  const result = parseWorkflow(markdown, { path: sourcePath });
  return result.ok ? [] : result.errors;
}

/**
 * Build a minimal one-step workflow document around a `work` step.
 *
 * `stepLines` are extra frontmatter lines under `  - id: work` (already
 * indented by the caller), `body` is the markdown after the frontmatter, and
 * `extra` lines land between `type: workflow` and `steps:` (e.g. `defaults:`
 * or `params:` blocks).
 */
export function workflowDoc(stepLines: string[], body = "## work\n\nDo it.\n", extra: string[] = []): string {
  return ["---", "type: workflow", ...extra, "steps:", "  - id: work", ...stepLines, "---", "", body].join("\n");
}

export interface SeedWorkflowRunStep {
  stepId: string;
  /** Defaults to `stepId`. */
  stepTitle?: string;
  /** Defaults to `"instructions"`. */
  instructions?: string;
  /** Defaults to `null`. */
  completionJson?: string | null;
}

/**
 * Seed the `workflow_runs` + `workflow_run_steps` rows an executable run
 * starts from — the INSERT boilerplate every integration suite otherwise
 * hand-rolls. Steps are inserted `pending` with contiguous sequence indexes;
 * a bare string step is shorthand for `{ stepId }`.
 */
export function seedWorkflowRun(
  db: { prepare(sql: string): { run(...params: unknown[]): unknown } },
  options: {
    runId: string;
    steps: Array<string | SeedWorkflowRunStep>;
    /** Defaults to `"workflows/demo"`. */
    workflowRef?: string;
    /** Defaults to `dir:v1:<workflowRef basename>`. */
    scopeKey?: string;
    /** Defaults to `"Demo"`. */
    workflowTitle?: string;
    /** Defaults to `{}`. */
    params?: Record<string, unknown>;
    /** Defaults to the first step's id. */
    currentStepId?: string;
    /** Defaults to `null` (check-in not armed). */
    checkinArmedAt?: string | null;
  },
): void {
  const now = new Date().toISOString();
  const workflowRef = options.workflowRef ?? "workflows/demo";
  const scopeKey = options.scopeKey ?? `dir:v1:${workflowRef.split("/").pop()}`;
  const steps = options.steps.map((step) => (typeof step === "string" ? { stepId: step } : step));
  db.prepare(
    `INSERT INTO workflow_runs
       (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
        params_json, current_step_id, created_at, updated_at, checkin_armed_at)
     VALUES (?, ?, ?, NULL, ?, 'active', ?, ?, ?, ?, ?)`,
  ).run(
    options.runId,
    workflowRef,
    scopeKey,
    options.workflowTitle ?? "Demo",
    JSON.stringify(options.params ?? {}),
    options.currentStepId ?? steps[0]!.stepId,
    now,
    now,
    options.checkinArmedAt ?? null,
  );
  steps.forEach((step, index) => {
    db.prepare(
      `INSERT INTO workflow_run_steps
         (run_id, step_id, step_title, instructions, completion_json, sequence_index, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    ).run(
      options.runId,
      step.stepId,
      step.stepTitle ?? step.stepId,
      step.instructions ?? "instructions",
      step.completionJson ?? null,
      index,
    );
  });
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
