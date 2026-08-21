import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../../src/core/config/config";
import { akmIndex } from "../../../src/indexer/indexer";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import { listWorkflowRuns, startWorkflowRun } from "../../../src/workflows/runtime/runs";
import { loadWorkflowAsset } from "../../../src/workflows/runtime/workflow-asset-loader";
import { WORKFLOW_SCHEMA_VERSION } from "../../../src/workflows/schema";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let workflowPath: string;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  workflowPath = path.join(storage.stashDir, "workflows", "cached.md");
  writeSandboxConfig({
    semanticSearchMode: "off",
    defaultBundle: "local",
    bundles: {
      local: {
        path: storage.stashDir,
        components: { main: { root: ".", adapter: "akm", writable: true } },
      },
    },
  });
  resetConfigCache();
});

afterEach(() => storage.cleanup());

function workflow(description: string): string {
  return `---
type: workflow
description: ${description}
steps:
  - id: run
---

## run

Run ${description}.
`;
}

async function indexWorkflow(description: string): Promise<void> {
  fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
  fs.writeFileSync(workflowPath, workflow(description), "utf8");
  await akmIndex({ stashDir: storage.stashDir, full: true });
}

function yamlWorkflow(): string {
  return `name: YAML loader
on: { workflow_dispatch: null }
jobs:
  main:
    runs-on: [self-hosted]
    steps:
      - id: run
        run: bun run check
        shell: bash
        working-directory: packages/./cli
`;
}

test("reparses disk source when the cached workflow schema is old", async () => {
  await indexWorkflow("Cached version");

  const db = openIndexDatabase();
  try {
    db.prepare("UPDATE workflow_documents SET schema_version = ?").run(WORKFLOW_SCHEMA_VERSION - 1);
  } finally {
    closeDatabase(db);
  }
  fs.writeFileSync(workflowPath, workflow("Current disk version"), "utf8");

  const loaded = await loadWorkflowAsset("workflows/cached");
  expect(loaded.document.description).toBe("Current disk version");
  expect(loaded.steps[0]?.instructions).toContain("Run Current disk version");
});

test("uses the cached workflow document when its schema is current", async () => {
  await indexWorkflow("Cached version");
  fs.writeFileSync(workflowPath, workflow("Current disk version"), "utf8");

  const loaded = await loadWorkflowAsset("workflows/cached");
  expect(loaded.document.description).toBe("Cached version");
  expect(loaded.steps[0]?.instructions).toContain("Run Cached version");
});

test("indexes, caches, and loads a YAML workflow through the runtime ownership path", async () => {
  workflowPath = path.join(storage.stashDir, "workflows", "cached.yml");
  fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
  fs.writeFileSync(workflowPath, yamlWorkflow(), "utf8");
  await akmIndex({ stashDir: storage.stashDir, full: true });

  const loaded = await loadWorkflowAsset("workflows/cached");
  expect(loaded.document.steps).toHaveLength(1);
  expect(loaded.document.steps[0]?.unit?.exec).toEqual({
    command: ["bash", "-c", "bun run check"],
    cwd: "packages/cli",
  });
});

test("loads a YAML workflow directly from disk when no workflow cache exists", async () => {
  workflowPath = path.join(storage.stashDir, "workflows", "uncached.yml");
  fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
  fs.writeFileSync(workflowPath, yamlWorkflow(), "utf8");

  const loaded = await loadWorkflowAsset("workflows/uncached");
  expect(loaded.document.steps[0]?.unit?.exec?.command).toEqual(["bash", "-c", "bun run check"]);
  expect(loaded.document.steps[0]?.unit?.exec?.cwd).toBe("packages/cli");
});

test("starts and executes an indexed YAML run through the real loader and frozen runtime", async () => {
  workflowPath = path.join(storage.stashDir, "workflows", "execute.yml");
  fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
  fs.writeFileSync(
    workflowPath,
    `name: YAML execute
on: { workflow_dispatch: null }
jobs:
  main:
    runs-on: [self-hosted]
    steps:
      - id: run
        run: echo yaml-run-owned
        shell: sh
`,
    "utf8",
  );
  await akmIndex({ stashDir: storage.stashDir, full: true });

  const started = await startWorkflowRun("workflows/execute", {});
  const result = await runWorkflowSteps({ target: started.run.id, summaryJudge: null });
  expect(result.done).toBe(true);
  expect(result.executed).toMatchObject([{ stepId: "run", ok: true, unitCount: 1, failedUnits: 0 }]);
});

test("indexes and displays multi-job YAML but rejects it before run creation or dispatch", async () => {
  workflowPath = path.join(storage.stashDir, "workflows", "multi.yml");
  fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
  fs.writeFileSync(
    workflowPath,
    `name: Multi-job loader
on: { workflow_dispatch: null }
jobs:
  build:
    runs-on: [self-hosted]
    steps: [{ id: build, run: echo build }]
  deploy:
    needs: build
    runs-on: [self-hosted]
    steps: [{ id: deploy, run: echo deploy }]
`,
    "utf8",
  );
  await akmIndex({ stashDir: storage.stashDir, full: true });

  let dispatches = 0;
  await expect(
    runWorkflowSteps({
      target: "workflows/multi",
      summaryJudge: null,
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: "unexpected" };
      },
    }),
  ).rejects.toThrow(/multi\.yml:7.*multi-job.*source-target resolver/is);
  expect(dispatches).toBe(0);
  expect((await listWorkflowRuns()).runs).toHaveLength(0);
});
