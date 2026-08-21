import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmShowUnified } from "../../../src/commands/read/show";
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

test("invalidates a current-schema cached workflow document when the executable source bytes changed", async () => {
  await indexWorkflow("Cached version");
  fs.writeFileSync(workflowPath, workflow("Current disk version"), "utf8");

  const loaded = await loadWorkflowAsset("workflows/cached");
  expect(loaded.document.description).toBe("Current disk version");
  expect(loaded.steps[0]?.instructions).toContain("Run Current disk version");
});

test("refuses a cached workflow document whose indexed file and document-source identities drift", async () => {
  workflowPath = path.join(storage.stashDir, "workflows", "identity.yml");
  fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
  fs.writeFileSync(workflowPath, yamlWorkflow().replace("bun run check", "printf trusted"), "utf8");
  await akmIndex({ stashDir: storage.stashDir, full: true });

  let entryId = 0;
  let forgedDocument = "";
  const db = openIndexDatabase();
  try {
    const row = db.prepare("SELECT entry_id, document_json FROM workflow_documents").get() as {
      entry_id: number;
      document_json: string;
    };
    const forged = JSON.parse(row.document_json) as {
      source: { path: string };
      steps: Array<{ unit?: { exec?: { command?: string[] } } }>;
    };
    const command = forged.steps[0]?.unit?.exec?.command;
    if (command) command.splice(0, command.length, "sh", "-c", "printf forged");
    entryId = row.entry_id;
    forgedDocument = JSON.stringify(forged);
    db.prepare("UPDATE workflow_documents SET document_json = ? WHERE entry_id = ?").run(forgedDocument, entryId);
  } finally {
    closeDatabase(db);
  }

  await expect(loadWorkflowAsset("workflows/identity")).resolves.toMatchObject({
    path: workflowPath,
    document: {
      source: { path: workflowPath },
      steps: [{ unit: { exec: { command: ["bash", "-c", "printf trusted"] } } }],
    },
  });

  const driftedDb = openIndexDatabase();
  try {
    driftedDb
      .prepare("UPDATE entries SET file_path = ? WHERE entry_type = 'workflow'")
      .run(path.join(storage.stashDir, "workflows", "forged.md"));
    const forged = JSON.parse(forgedDocument) as { source: { path: string } };
    forged.source.path = "workflows/forged.md";
    driftedDb
      .prepare("UPDATE workflow_documents SET source_path = ?, document_json = ? WHERE entry_id = ?")
      .run("workflows/forged.md", JSON.stringify(forged), entryId);
  } finally {
    closeDatabase(driftedDb);
  }
  await expect(akmShowUnified({ ref: "workflows/identity", skipLogging: true })).rejects.toThrow(
    /indexed workflow source identity.*forged\.md.*identity\.yml/is,
  );
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

test("rejects an invalid portable YAML template before run creation, journal writes, or dispatch", async () => {
  workflowPath = path.join(storage.stashDir, "workflows", "invalid-template.yml");
  fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
  fs.writeFileSync(
    workflowPath,
    `name: Invalid template
on: { workflow_dispatch: null }
jobs:
  main:
    runs-on: [self-hosted]
    steps:
      - id: run
        uses: akm/command
        with:
          content: echo $HOME
`,
    "utf8",
  );

  let dispatches = 0;
  await expect(
    runWorkflowSteps({
      target: "workflows/invalid-template",
      summaryJudge: null,
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: "unexpected" };
      },
    }),
  ).rejects.toThrow(/invalid-template\.yml:10.*unsupported portable template construct/is);
  expect(dispatches).toBe(0);
  expect((await listWorkflowRuns()).runs).toHaveLength(0);
});
