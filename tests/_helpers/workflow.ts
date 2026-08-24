import type { AkmConfig } from "../../src/core/config/config";
import { compileWorkflowPlan } from "../../src/workflows/ir/compile";
import { canonicalPlanJson, computePlanHash } from "../../src/workflows/ir/plan-hash";
import { decodeStoredWorkflowPlanV3, type WorkflowPlanGraph } from "../../src/workflows/ir/stored-plan-v3";
import { parseWorkflow } from "../../src/workflows/parser";
import { frozenStepRows } from "../../src/workflows/runtime/plan-classifier";
import type { WorkflowError } from "../../src/workflows/schema";
import { compileWorkflowSource } from "../../src/workflows/source-ir/compile";
import { sourceStepInstructions, sourceStepProgramUnit } from "../../src/workflows/source-ir/program";
import { buildStoredWorkflowPlanV3Fixture } from "./stored-plan-v3-fixture";

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
 * Compile source bytes into the shared executor-core fixture used by unit
 * tests. Production starts use the durable-v4 freezer; this helper deliberately
 * does not publish a stored plan or recreate the retired new-start-v3 path.
 *
 * `config` defaults to {@link WORKFLOW_TEST_CONFIG}; suites with their own
 * engine catalog pass it explicitly.
 */
export function freezeWorkflow(
  markdown: string,
  sourcePath = "workflows/demo.md",
  config: AkmConfig = WORKFLOW_TEST_CONFIG,
): WorkflowPlanGraph {
  const compiledSource = compileWorkflowSource(markdown, { path: sourcePath, workspaceRoot: "/tmp" });
  if (!compiledSource.ok) {
    throw new Error(compiledSource.errors.map((error) => `${error.line}: ${error.message}`).join(" | "));
  }
  const title =
    sourcePath
      .split("/")
      .pop()
      ?.replace(/\.(?:md|yml)$/i, "") || "demo";
  const sourceSteps = compiledSource.ir.jobs[0]?.steps ?? [];
  const resolvedUnits = new Map(
    sourceSteps
      .filter((step) => step.route === undefined)
      .map(
        (step) => [step.id, { unit: sourceStepProgramUnit(step), instructions: sourceStepInstructions(step) }] as const,
      ),
  );
  const compiled = compileWorkflowPlan(compiledSource.ir, title, resolvedUnits);
  if (!compiled.ok) {
    throw new Error(compiled.errors.map((error) => `${error.line}: ${error.message}`).join(" | "));
  }
  const frozen = buildStoredWorkflowPlanV3Fixture(
    compiledSource.ir,
    compiled.plan,
    compiled.warnings,
    resolvedUnits,
    config,
  );
  return decodeStoredWorkflowPlanV3({
    irVersion: 3,
    title,
    ...(compiled.plan.params ? { params: compiled.plan.params } : {}),
    ...(compiled.plan.paramSchemas ? { paramSchemas: compiled.plan.paramSchemas } : {}),
    ...(compiled.plan.budget ? { budget: compiled.plan.budget } : {}),
    execution: frozen.execution,
    steps: frozen.steps,
  });
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
