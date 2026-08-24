import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmShowUnified } from "../../../src/commands/read/show";
import { parseBundleRef } from "../../../src/core/asset/asset-ref";
import { resetConfigCache } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { indexWrittenAssets } from "../../../src/indexer/index-written-assets";
import { akmIndex, lookupBundleRef } from "../../../src/indexer/indexer";
import { resolveAdapterConceptOwner } from "../../../src/indexer/lookup/adapter-concept-owner";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import { listWorkflowRuns, startWorkflowRun } from "../../../src/workflows/runtime/runs";
import { loadWorkflowAsset } from "../../../src/workflows/runtime/workflow-asset-loader";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

type BundleKind = "ordinary" | "standalone";

interface CollisionFixture {
  kind: BundleKind;
  root: string;
  ownedDir: string;
  canonicalRef: string;
  aliases: string[];
}

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => storage.cleanup());

function configure(kind: BundleKind): CollisionFixture {
  const root = kind === "ordinary" ? storage.stashDir : path.join(storage.root, "standalone-workflows");
  const ownedDir = kind === "ordinary" ? path.join(root, "workflows") : root;
  fs.mkdirSync(ownedDir, { recursive: true });
  const bundle = `${kind}-bundle`;
  const conceptId = kind === "ordinary" ? "workflows/collision" : "collision";
  writeSandboxConfig({
    semanticSearchMode: "off",
    defaultBundle: bundle,
    bundles: {
      [bundle]: {
        path: root,
        components: {
          main: {
            root: ".",
            adapter: kind === "ordinary" ? "akm" : "akm-workflow",
            writable: true,
          },
        },
      },
    },
  });
  resetConfigCache();
  return {
    kind,
    root,
    ownedDir,
    canonicalRef: `${bundle}//${conceptId}`,
    aliases: [
      `${bundle}//${conceptId}`,
      `${bundle}//${conceptId}.md`,
      `${bundle}//${conceptId}.yml`,
      `${bundle}//${conceptId}.MD`,
      `${bundle}//${conceptId}.YML`,
    ],
  };
}

function markdownWorkflow(label = "markdown"): string {
  return `---
type: workflow
description: ${label}
steps:
  - id: execute
    unit:
      exec:
        command: ["sh", "-c", "printf ${label}"]
---

## execute

Execute ${label}.
`;
}

function yamlWorkflow(label = "yaml"): string {
  return `name: ${label}
on: { workflow_dispatch: null }
jobs:
  main:
    runs-on: [self-hosted]
    steps:
      - id: execute
        run: printf ${label}
        shell: sh
`;
}

function writeCollision(fixture: CollisionFixture, extensions: [string, string] = [".md", ".yml"]): void {
  fs.writeFileSync(path.join(fixture.ownedDir, `collision${extensions[0]}`), markdownWorkflow());
  fs.writeFileSync(path.join(fixture.ownedDir, `collision${extensions[1]}`), yamlWorkflow());
}

function indexSnapshot(): {
  entries: number;
  documents: number;
  documentRows: Array<Record<string, unknown>>;
} {
  if (!fs.existsSync(getDbPath())) return { entries: 0, documents: 0, documentRows: [] };
  const db = openIndexDatabase();
  try {
    const entries = (db.prepare("SELECT COUNT(*) AS count FROM entries").get() as { count: number }).count;
    const documents = (db.prepare("SELECT COUNT(*) AS count FROM workflow_documents").get() as { count: number }).count;
    const documentRows = db
      .prepare(
        `SELECT entry_id AS entryId, schema_version AS schemaVersion, document_json AS documentJson,
                source_path AS sourcePath, source_hash AS sourceHash
           FROM workflow_documents
          ORDER BY entry_id`,
      )
      .all() as Array<Record<string, unknown>>;
    return { entries, documents, documentRows };
  } finally {
    closeDatabase(db);
  }
}

const kinds: BundleKind[] = ["ordinary", "standalone"];
const soleSourceCases = [
  [".md", markdownWorkflow],
  [".yml", yamlWorkflow],
  [".MD", markdownWorkflow],
  [".YML", yamlWorkflow],
] as const;

describe("workflow source canonical-ref collisions", () => {
  test.each(
    kinds.flatMap((kind) => soleSourceCases.map(([extension, source]) => [kind, extension, source] as const)),
  )("%s canonicalizes every explicit alias onto one %s workflow owner", async (kind, extension, source) => {
    const fixture = configure(kind);
    const sourcePath = path.join(fixture.ownedDir, `collision${extension}`);
    fs.writeFileSync(sourcePath, source(`sole-${kind}-${extension.slice(1).toLowerCase()}`));
    const adapterId = kind === "ordinary" ? "akm" : "akm-workflow";
    const canonicalConceptId = kind === "ordinary" ? "workflows/collision" : "collision";

    for (const ref of fixture.aliases) {
      const owner = resolveAdapterConceptOwner(fixture.root, adapterId, parseBundleRef(ref).conceptId);
      expect(owner, ref).toMatchObject({
        path: sourcePath,
        conceptId: canonicalConceptId,
        workflowSource: { path: sourcePath, canonicalName: "collision" },
      });
      await expect(loadWorkflowAsset(ref), ref).resolves.toMatchObject({
        ref: fixture.canonicalRef,
        path: sourcePath,
        sourceIr: { source: { path: sourcePath } },
      });
    }
    expect(fs.existsSync(getDbPath())).toBe(false);
  });

  test.each(kinds)("%s rejects a repeated-suffix alias instead of stripping twice", async (kind) => {
    const fixture = configure(kind);
    fs.writeFileSync(path.join(fixture.ownedDir, "collision.md.yml"), yamlWorkflow("nested-suffix"));

    await expect(loadWorkflowAsset(`${fixture.canonicalRef}.md.yml`)).rejects.toMatchObject({
      code: "INVALID_FLAG_VALUE",
      message: expect.stringMatching(/extensionless stem ending in recognized workflow suffix.*\.md/is),
    });
    expect(fs.existsSync(getDbPath())).toBe(false);
  });

  test("ordinary load rejects a canonical workflow source colliding with a loose smart-Markdown peer", async () => {
    const fixture = configure("ordinary");
    const canonicalPath = path.join(fixture.ownedDir, "collision.md");
    const loosePath = path.join(fixture.root, "collision.md");
    fs.writeFileSync(canonicalPath, markdownWorkflow("canonical"));
    fs.writeFileSync(loosePath, markdownWorkflow("loose"));

    await expect(loadWorkflowAsset(`${fixture.canonicalRef}.MD`)).rejects.toMatchObject({
      code: "RESOURCE_ALREADY_EXISTS",
      message: expect.stringMatching(/multiple physical owners.*collision\.md.*workflows\/collision\.md/is),
    });
    expect(fs.existsSync(getDbPath())).toBe(false);
  });

  test.each(kinds)("%s rejects every explicit alias before uncached load", async (kind) => {
    const fixture = configure(kind);
    writeCollision(fixture);

    for (const ref of fixture.aliases) {
      await expect(loadWorkflowAsset(ref)).rejects.toMatchObject({
        code: "RESOURCE_ALREADY_EXISTS",
        message: expect.stringMatching(/multiple workflow source files.*collision\.md.*collision\.yml/is),
      });
    }
    let dispatches = 0;
    await expect(startWorkflowRun(fixture.canonicalRef)).rejects.toMatchObject({
      code: "RESOURCE_ALREADY_EXISTS",
    });
    await expect(
      runWorkflowSteps({
        target: fixture.canonicalRef,
        summaryJudge: null,
        dispatcher: async () => {
          dispatches++;
          return { ok: true, text: "unexpected" };
        },
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_ALREADY_EXISTS" });
    expect(dispatches).toBe(0);
    expect((await listWorkflowRuns()).runs).toHaveLength(0);
    expect(fs.existsSync(getDbPath())).toBe(false);
  });

  test.each(kinds)("%s treats extension-case variants as the same canonical ref", async (kind) => {
    const fixture = configure(kind);
    writeCollision(fixture, [".MD", ".YmL"]);

    await expect(loadWorkflowAsset(fixture.canonicalRef)).rejects.toMatchObject({
      code: "RESOURCE_ALREADY_EXISTS",
      message: expect.stringMatching(/collision\.MD.*collision\.YmL/is),
    });
    expect(fs.existsSync(getDbPath())).toBe(false);
  });

  test.each(kinds)("%s cannot hide a malformed owned peer behind a valid source", async (kind) => {
    const fixture = configure(kind);
    fs.writeFileSync(path.join(fixture.ownedDir, "collision.md"), "---\ntype: [unterminated\n---\n");
    fs.writeFileSync(path.join(fixture.ownedDir, "collision.yml"), yamlWorkflow("valid"));

    await expect(loadWorkflowAsset(fixture.canonicalRef)).rejects.toMatchObject({
      code: "RESOURCE_ALREADY_EXISTS",
      message: expect.stringMatching(/collision\.md.*collision\.yml/is),
    });
    await expect(startWorkflowRun(fixture.canonicalRef)).rejects.toMatchObject({
      code: "RESOURCE_ALREADY_EXISTS",
    });
    expect((await listWorkflowRuns()).runs).toHaveLength(0);
    expect(fs.existsSync(getDbPath())).toBe(false);

    const indexed = await akmIndex({ stashDir: fixture.root, full: true });
    expect(indexed.warnings).toEqual([
      expect.stringMatching(/multiple workflow source files.*collision\.md.*collision\.yml/is),
    ]);
    expect(indexSnapshot()).toMatchObject({ entries: 0, documents: 0 });
  });

  test("preserves an authored symlink path and rejects a symlink that changes source format", async () => {
    const fixture = configure("ordinary");
    const markdownTarget = path.join(fixture.ownedDir, "target.md");
    const yamlTarget = path.join(fixture.ownedDir, "target.yml");
    const authoredPath = path.join(fixture.ownedDir, "collision.md");
    fs.writeFileSync(markdownTarget, markdownWorkflow("linked-markdown"));
    fs.writeFileSync(yamlTarget, yamlWorkflow("linked-yaml"));
    fs.symlinkSync(path.basename(markdownTarget), authoredPath);

    await expect(loadWorkflowAsset(fixture.canonicalRef)).resolves.toMatchObject({
      path: authoredPath,
      sourceIr: { source: { path: authoredPath } },
    });

    fs.unlinkSync(authoredPath);
    fs.symlinkSync(path.basename(yamlTarget), authoredPath);
    await expect(loadWorkflowAsset(fixture.canonicalRef)).rejects.toMatchObject({
      code: "INVALID_FLAG_VALUE",
      message: expect.stringMatching(/collision\.md.*target\.yml.*different source format/is),
    });
    expect(fs.existsSync(getDbPath())).toBe(false);
    await expect(akmShowUnified({ ref: fixture.canonicalRef, skipLogging: true })).rejects.toMatchObject({
      code: "INVALID_FLAG_VALUE",
      message: expect.stringMatching(/collision\.md.*target\.yml.*different source format/is),
    });
    expect(indexSnapshot()).toMatchObject({ entries: 0, documents: 0 });
    expect((await listWorkflowRuns()).runs).toHaveLength(0);
  });

  test.each(kinds)("%s rejects the pair during indexing, indexed lookup, and show", async (kind) => {
    const fixture = configure(kind);
    writeCollision(fixture);

    const indexed = await akmIndex({ stashDir: fixture.root, full: true });
    expect(indexed.warnings).toEqual([
      expect.stringMatching(/multiple workflow source files.*collision\.md.*collision\.yml/is),
    ]);
    expect(indexSnapshot()).toMatchObject({ entries: 0, documents: 0 });

    await expect(lookupBundleRef(parseBundleRef(fixture.canonicalRef))).rejects.toMatchObject({
      code: "RESOURCE_ALREADY_EXISTS",
    });
    await expect(akmShowUnified({ ref: fixture.canonicalRef, skipLogging: true })).rejects.toMatchObject({
      code: "RESOURCE_ALREADY_EXISTS",
    });
    expect(indexSnapshot()).toMatchObject({ entries: 0, documents: 0 });
  });

  test.each(
    kinds,
  )("%s refuses a collision added after cache fill without run, journal, dispatch, or cache mutation", async (kind) => {
    const fixture = configure(kind);
    const markdownPath = path.join(fixture.ownedDir, "collision.md");
    fs.writeFileSync(markdownPath, markdownWorkflow("cached-markdown"));
    await akmIndex({ stashDir: fixture.root, full: true });
    const before = indexSnapshot();
    expect(before).toMatchObject({ entries: 1, documents: 1 });

    fs.writeFileSync(path.join(fixture.ownedDir, "collision.yml"), yamlWorkflow("late-yaml"));
    let dispatches = 0;

    await expect(loadWorkflowAsset(fixture.canonicalRef)).rejects.toMatchObject({
      code: "RESOURCE_ALREADY_EXISTS",
    });
    await expect(startWorkflowRun(fixture.canonicalRef)).rejects.toMatchObject({
      code: "RESOURCE_ALREADY_EXISTS",
    });
    await expect(
      runWorkflowSteps({
        target: fixture.canonicalRef,
        summaryJudge: null,
        dispatcher: async () => {
          dispatches++;
          return { ok: true, text: "unexpected" };
        },
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_ALREADY_EXISTS" });

    expect(dispatches).toBe(0);
    expect((await listWorkflowRuns()).runs).toHaveLength(0);
    expect(indexSnapshot()).toEqual(before);
  });

  test("ordinary targeted indexing evicts the previously indexed sibling instead of preserving a preferred format", async () => {
    const fixture = configure("ordinary");
    const markdownPath = path.join(fixture.ownedDir, "collision.md");
    const yamlPath = path.join(fixture.ownedDir, "collision.yml");
    fs.writeFileSync(markdownPath, markdownWorkflow("first"));
    await akmIndex({ stashDir: fixture.root, full: true });
    expect(indexSnapshot()).toMatchObject({ entries: 1, documents: 1 });

    fs.writeFileSync(yamlPath, yamlWorkflow("second"));
    expect(await indexWrittenAssets(fixture.root, [yamlPath], { bundleId: "ordinary-bundle" })).toBe(true);

    expect(indexSnapshot()).toMatchObject({ entries: 0, documents: 0 });
    await expect(lookupBundleRef(parseBundleRef(fixture.canonicalRef))).rejects.toMatchObject({
      code: "RESOURCE_ALREADY_EXISTS",
    });
  });

  test("a lower-priority bundle collision cannot poison an unqualified ref already owned by the primary bundle", async () => {
    const secondaryRoot = path.join(storage.root, "secondary");
    const secondaryWorkflows = path.join(secondaryRoot, "workflows");
    fs.mkdirSync(secondaryWorkflows, { recursive: true });
    fs.mkdirSync(path.join(storage.stashDir, "workflows"), { recursive: true });
    fs.writeFileSync(path.join(storage.stashDir, "workflows", "collision.md"), markdownWorkflow("primary"));
    fs.writeFileSync(path.join(secondaryWorkflows, "collision.md"), markdownWorkflow("secondary-markdown"));
    fs.writeFileSync(path.join(secondaryWorkflows, "collision.yml"), yamlWorkflow("secondary-yaml"));
    writeSandboxConfig({
      semanticSearchMode: "off",
      defaultBundle: "primary",
      bundles: {
        primary: {
          path: storage.stashDir,
          components: { main: { root: ".", adapter: "akm", writable: true } },
        },
        secondary: {
          path: secondaryRoot,
          components: { main: { root: ".", adapter: "akm", writable: true } },
        },
      },
    });
    resetConfigCache();

    const indexed = await akmIndex({ stashDir: storage.stashDir, full: true });
    expect(indexed.warnings).toEqual([
      expect.stringMatching(/multiple workflow source files.*collision\.md.*collision\.yml/is),
    ]);

    await expect(loadWorkflowAsset("workflows/collision")).resolves.toMatchObject({
      ref: "primary//workflows/collision",
      path: path.join(storage.stashDir, "workflows", "collision.md"),
      sourceIr: { description: "primary" },
    });
    await expect(lookupBundleRef(parseBundleRef("workflows/collision"))).resolves.toMatchObject({
      itemRef: "primary//workflows/collision",
      filePath: path.join(storage.stashDir, "workflows", "collision.md"),
    });
    await expect(akmShowUnified({ ref: "workflows/collision", skipLogging: true })).resolves.toMatchObject({
      ref: "workflows/collision",
      path: path.join(storage.stashDir, "workflows", "collision.md"),
    });
    await expect(loadWorkflowAsset("secondary//workflows/collision")).rejects.toMatchObject({
      code: "RESOURCE_ALREADY_EXISTS",
    });
  });
});
