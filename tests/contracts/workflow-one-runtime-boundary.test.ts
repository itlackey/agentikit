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

  test("stored v3 is one decode-only boundary and never constructs current plans", () => {
    const storedV3 = read("src/workflows/ir/stored-plan-v3.ts");
    const current = read("src/workflows/ir/schema-v4.ts");

    expect(storedV3).toContain("decodeStoredWorkflowPlanV3");
    expect(storedV3).not.toMatch(/\b(?:compile|freeze)Workflow/);
    expect(current).toContain("validateWorkflowPlanStructure");
    expect(current).not.toContain("sharedV3Shadow");
    expect(current).not.toContain("decodeWorkflowPlanV3(");
    expect(current).not.toMatch(/extends\s+IrUnitNode\b/);
    expect(current).not.toMatch(/execution:\s*\{[^}]*engines/s);
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

  test("the old document is display-only and cannot feed execution or scheduling", () => {
    const projection = read("src/workflows/source-ir/document.ts");
    expect(projection).toContain('type WorkflowSourceProjectionMode = "display"');
    expect(projection).not.toContain('"runtime"');
    expect(projection).not.toContain('"scheduler"');
  });
});
