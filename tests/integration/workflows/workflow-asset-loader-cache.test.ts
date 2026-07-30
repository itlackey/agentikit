import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../../src/core/config/config";
import { akmIndex } from "../../../src/indexer/indexer";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
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
