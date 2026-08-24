// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

describe("one workflow source and runtime architecture", () => {
  test("runtime assets carry source IR rather than the retired workflow document", () => {
    const loader = read("src/workflows/runtime/workflow-asset-loader.ts");
    expect(loader).toContain("sourceIr: WorkflowSourceIrV1");
    expect(loader).not.toContain("document: WorkflowDocument");
    expect(loader).not.toContain("readWorkflowDocumentFromIndex");
  });

  test("new starts compile source IR directly into the current durable plan", () => {
    const freeze = read("src/workflows/ir/freeze-v4.ts");
    const compiler = read("src/workflows/ir/compile.ts");
    const resolver = read("src/workflows/ir/source-freeze-v4.ts");

    expect(fs.existsSync(path.join(ROOT, "src/workflows/ir/freeze.ts"))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, "src/workflows/ir/freeze-current.ts"))).toBe(false);
    expect(freeze).not.toContain("compileResolveFreezeWorkflow(");
    expect(freeze).not.toContain("freezeCurrentWorkflowPlan");
    expect(freeze).not.toContain("execution: current.execution");
    expect(freeze).not.toMatch(/from\s+["']\.\/freeze["']/);
    expect(compiler).toContain("WorkflowSourceIrV1");
    expect(compiler).not.toContain("WorkflowDocument");
    expect(resolver).not.toContain("workflowSourceIrToDocument");
    expect(resolver).not.toContain("WorkflowDocument");
    expect(resolver).not.toMatch(/\bWorkflowStep\b/);
  });

  test("pre-current stored plans are rejected instead of replayed", () => {
    const current = read("src/workflows/ir/schema-v4.ts");
    const boundary = read("src/workflows/runtime/plan-classifier.ts");

    expect(fs.existsSync(path.join(ROOT, "src/workflows/ir/stored-plan-v3.ts"))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, "tests/_helpers/stored-plan-v3-fixture.ts"))).toBe(false);
    expect(current).not.toContain("StoredWorkflowPlanV3");
    expect(current).not.toContain("decodeStoredWorkflowPlanV3");
    expect(current).not.toContain("ExecutableWorkflowPlan");
    expect(current).toContain("validateWorkflowPlanStructure");
    expect(current).not.toMatch(/execution:\s*\{[^}]*engines/s);
    expect(boundary).toContain("supports only workflow IR version 4");
    expect(boundary).not.toContain("normalizeStoredWorkflowPlan");
    expect(boundary).not.toContain("WORKFLOW_IR_VERSION");
  });

  test("the workflow engine receives only the current plan", () => {
    const boundary = read("src/workflows/runtime/plan-classifier.ts");
    const executor = [
      "src/workflows/exec/run-workflow.ts",
      "src/workflows/exec/native-executor.ts",
      "src/workflows/exec/step-work.ts",
      "src/workflows/exec/frozen-judge.ts",
      "src/workflows/exec/unit-dispatch.ts",
    ]
      .map(read)
      .join("\n");

    expect(boundary).toContain("WorkflowPlanGraphV4");
    expect(executor).not.toMatch(/\bStoredWorkflowPlanV3\b/);
    expect(executor).not.toMatch(/\bIrInvocation\b/);
    expect(executor).not.toMatch(/\bFrozenEngineSnapshot\b/);
    expect(executor).not.toMatch(/plan\.irVersion\s*===\s*3/);
    expect(executor).not.toMatch(/execution\.engines/);
    expect(executor).not.toMatch(/prepareFrozenWorkflowExecution/);
  });

  test("whole-process environment compatibility is absent from every authoring surface", () => {
    const markdown = read("src/workflows/parser.ts");
    const program = read("src/workflows/program/schema.ts");
    const sourceIr = read("src/workflows/source-ir/schema.ts");
    const jsonSchema = read("schemas/akm-workflow.json");

    expect(markdown).not.toContain("inherit_env");
    expect(program).not.toContain("inheritEnv");
    expect(sourceIr).not.toContain("inheritEnv");
    expect(jsonSchema).not.toContain("inherit_env");
  });

  test("source IR feeds display and indexing without a second persisted workflow model", () => {
    const renderer = read("src/workflows/renderer.ts");
    const metadata = read("src/core/adapter/adapters/akm-metadata.ts");
    const schema = read("src/storage/repositories/index-schema.ts");

    expect(fs.existsSync(path.join(ROOT, "src/workflows/source-ir/document.ts"))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, "src/workflows/runtime/document-cache.ts"))).toBe(false);
    expect(renderer).toContain("WorkflowSourceIrV1");
    expect(metadata).toContain("sourceStepInstructions");
    expect(schema).toContain('DROP TABLE IF EXISTS workflow_documents');
    expect(schema).not.toContain("CREATE TABLE IF NOT EXISTS workflow_documents");
  });
});
