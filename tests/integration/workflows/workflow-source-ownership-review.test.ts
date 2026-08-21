// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmShowUnified } from "../../../src/commands/read/show";
import { parseBundleRef } from "../../../src/core/asset/asset-ref";
import { resetConfigCache } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { indexWrittenAssets } from "../../../src/indexer/index-written-assets";
import { akmIndex, lookupBundleRef } from "../../../src/indexer/indexer";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import { listWorkflowRuns, startWorkflowRun } from "../../../src/workflows/runtime/runs";
import { loadWorkflowAsset } from "../../../src/workflows/runtime/workflow-asset-loader";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

type BundleKind = "ordinary" | "standalone";

interface Fixture {
  kind: BundleKind;
  root: string;
  ownedDir: string;
  bundle: string;
  ref(name: string): string;
}

interface WorkflowRow {
  id: number;
  itemRef: string;
  conceptId: string;
  filePath: string;
  entryKey: string;
  documentSourcePath: string | null;
  documentJson: string | null;
}

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => storage.cleanup());

function configure(kind: BundleKind): Fixture {
  const root = path.join(storage.root, `${kind}-review`);
  const ownedDir = kind === "ordinary" ? path.join(root, "workflows") : root;
  const bundle = `${kind}-review`;
  fs.mkdirSync(ownedDir, { recursive: true });
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
    bundle,
    ref: (name) => `${bundle}//${kind === "ordinary" ? "workflows/" : ""}${name}`,
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

function workflowRows(ref?: string): WorkflowRow[] {
  if (!fs.existsSync(getDbPath())) return [];
  const db = openIndexDatabase();
  try {
    return db
      .prepare(
        `SELECT e.id AS id, e.item_ref AS itemRef, e.concept_id AS conceptId,
                e.file_path AS filePath, e.entry_key AS entryKey,
                wd.source_path AS documentSourcePath, wd.document_json AS documentJson
           FROM entries e
           LEFT JOIN workflow_documents wd ON wd.entry_id = e.id
          WHERE e.entry_type = 'workflow'${ref ? " AND e.item_ref = ?" : ""}
          ORDER BY e.item_ref, e.file_path`,
      )
      .all(...(ref ? [ref] : [])) as WorkflowRow[];
  } finally {
    closeDatabase(db);
  }
}

function moveIndexedWorkflowIdentity(rowId: number, stalePath: string): void {
  const db = openIndexDatabase();
  try {
    db.prepare("UPDATE entries SET dir_path = ?, file_path = ? WHERE id = ?").run(
      path.dirname(stalePath),
      stalePath,
      rowId,
    );
    db.prepare("UPDATE workflow_documents SET source_path = ? WHERE entry_id = ?").run(stalePath, rowId);
  } finally {
    closeDatabase(db);
  }
}

function cloneWorkflowRowIntoBundle(
  rowId: number,
  bundle: string,
  filePath: string,
  conceptId = "workflows/canonical",
): string {
  const itemRef = `${bundle}//${conceptId}`;
  const db = openIndexDatabase();
  try {
    db.transaction(() => {
      const inserted = db
        .prepare(
          `INSERT INTO entries (
             entry_key, dir_path, file_path, stash_dir, entry_json, search_text, entry_type, derived_from,
             item_ref, bundle_id, component_id, concept_id, adapter_id, type, content_hash, document_json
           )
           SELECT ?, ?, ?, stash_dir, entry_json, search_text, entry_type, derived_from,
                  ?, ?, ?, concept_id, adapter_id, type, content_hash, document_json
             FROM entries
            WHERE id = ?`,
        )
        .run(
          [bundle, "workflow", conceptId].join(":"),
          path.dirname(filePath),
          filePath,
          itemRef,
          bundle,
          bundle,
          rowId,
        );
      const clonedId = Number(inserted.lastInsertRowid);
      db.prepare(
        `INSERT INTO workflow_documents (entry_id, schema_version, document_json, source_path, source_hash, updated_at)
         SELECT ?, schema_version, document_json, ?, source_hash, updated_at
           FROM workflow_documents
          WHERE entry_id = ?`,
      ).run(clonedId, filePath, rowId);
    })();
  } finally {
    closeDatabase(db);
  }
  return itemRef;
}

function authoredSourcePaths(fixture: Fixture, filenames: string[]): string[] {
  return filenames
    .map((filename) => path.relative(fixture.root, path.join(fixture.ownedDir, filename)).replaceAll("\\", "/"))
    .sort();
}

async function expectNoExecutionMutation(ref: string): Promise<void> {
  let dispatches = 0;
  await expect(startWorkflowRun(ref)).rejects.toBeDefined();
  await expect(
    runWorkflowSteps({
      target: ref,
      summaryJudge: null,
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: "unexpected" };
      },
    }),
  ).rejects.toBeDefined();
  expect(dispatches).toBe(0);
  expect((await listWorkflowRuns()).runs).toHaveLength(0);
}

const suffixCases: Array<[BundleKind, string]> = [
  ["ordinary", "dual.md.yml"],
  ["ordinary", "dual.YML.md"],
  ["standalone", "dual.MD.YML"],
  ["standalone", "dual.yml.MD"],
];

describe("workflow source ownership review blockers", () => {
  test.each(suffixCases)("%s rejects the suffix-smuggling owner %s before every consumer", async (kind, filename) => {
    const fixture = configure(kind);
    const sourcePath = path.join(fixture.ownedDir, filename);
    fs.writeFileSync(sourcePath, filename.toLowerCase().endsWith(".md") ? markdownWorkflow() : yamlWorkflow());
    const ref = fixture.ref(filename);

    await expect(loadWorkflowAsset(ref)).rejects.toMatchObject({
      code: "INVALID_FLAG_VALUE",
      message: expect.stringMatching(/filename.*dual.*recognized workflow suffix/is),
    });
    await expectNoExecutionMutation(ref);
    expect(fs.existsSync(getDbPath())).toBe(false);

    const indexed = await akmIndex({ stashDir: fixture.root, full: true });
    expect(indexed.warnings).toEqual([expect.stringMatching(/dual.*recognized workflow suffix/is)]);
    expect(workflowRows()).toHaveLength(0);
    await expect(lookupBundleRef(parseBundleRef(ref))).rejects.toMatchObject({ code: "INVALID_FLAG_VALUE" });
    await expect(akmShowUnified({ ref, skipLogging: true })).rejects.toMatchObject({ code: "INVALID_FLAG_VALUE" });
    expect(workflowRows()).toHaveLength(0);
  });

  test("targeted indexing atomically evicts a stale suffix-smuggling workflow row and document", async () => {
    const fixture = configure("ordinary");
    const seedPath = path.join(fixture.ownedDir, "seed.md");
    const invalidPath = path.join(fixture.ownedDir, "dual.md.yml");
    const staleRef = fixture.ref("dual.md");
    fs.writeFileSync(seedPath, markdownWorkflow("stale"));
    await akmIndex({ stashDir: fixture.root, full: true });
    expect(workflowRows()).toHaveLength(1);

    fs.unlinkSync(seedPath);
    fs.writeFileSync(invalidPath, yamlWorkflow("invalid-suffix"));
    const row = workflowRows()[0];
    if (!row?.documentJson) throw new Error("expected seeded workflow cache row");
    const db = openIndexDatabase();
    try {
      const document = JSON.parse(row.documentJson) as { source: { path: string } };
      document.source.path = invalidPath;
      db.prepare(
        `UPDATE entries
            SET entry_key = ?, dir_path = ?, file_path = ?, item_ref = ?, concept_id = ?
          WHERE id = ?`,
      ).run(`${fixture.root}:workflow:dual.md`, fixture.ownedDir, invalidPath, staleRef, "workflows/dual.md", row.id);
      db.prepare("UPDATE workflow_documents SET source_path = ?, document_json = ? WHERE entry_id = ?").run(
        invalidPath,
        JSON.stringify(document),
        row.id,
      );
    } finally {
      closeDatabase(db);
    }
    expect(workflowRows(staleRef)).toHaveLength(1);

    expect(await indexWrittenAssets(fixture.root, [invalidPath], { bundleId: fixture.bundle })).toBe(true);
    expect(workflowRows(staleRef)).toHaveLength(0);
    await expect(loadWorkflowAsset(fixture.ref("dual.md.yml"))).rejects.toMatchObject({ code: "INVALID_FLAG_VALUE" });
    await expect(akmShowUnified({ ref: fixture.ref("dual.md.yml"), skipLogging: true })).rejects.toMatchObject({
      code: "INVALID_FLAG_VALUE",
    });
  });

  test("targeted collision reconciliation evicts a bundle-scoped canonical stale row beyond candidate paths", async () => {
    const fixture = configure("ordinary");
    const ownerPath = path.join(fixture.ownedDir, "canonical.md");
    const peerPath = path.join(fixture.ownedDir, "canonical.yml");
    const stalePath = path.join(fixture.ownedDir, "deleted-former-owner.md");
    fs.writeFileSync(ownerPath, markdownWorkflow("canonical"));
    await akmIndex({ stashDir: fixture.root, full: true });
    const row = workflowRows(fixture.ref("canonical"))[0];
    if (!row?.documentJson) throw new Error("expected seeded workflow cache row");

    const otherRef = cloneWorkflowRowIntoBundle(
      row.id,
      "other-bundle",
      path.join(storage.root, "other-bundle", "workflows", "canonical.md"),
    );
    moveIndexedWorkflowIdentity(row.id, stalePath);
    fs.writeFileSync(peerPath, yamlWorkflow("collision"));

    expect(await indexWrittenAssets(fixture.root, [peerPath], { bundleId: fixture.bundle })).toBe(true);
    expect(workflowRows(fixture.ref("canonical"))).toHaveLength(0);
    expect(workflowRows(otherRef)).toEqual([expect.objectContaining({ documentJson: expect.any(String) })]);
  });

  test("full collision reconciliation evicts a canonical stale row and document beyond candidate paths", async () => {
    const fixture = configure("ordinary");
    const ownerPath = path.join(fixture.ownedDir, "canonical.md");
    const peerPath = path.join(fixture.ownedDir, "canonical.yml");
    const stalePath = path.join(fixture.ownedDir, "deleted-former-owner.md");
    fs.writeFileSync(ownerPath, markdownWorkflow("canonical"));
    await akmIndex({ stashDir: fixture.root, full: true });
    const row = workflowRows(fixture.ref("canonical"))[0];
    if (!row?.documentJson) throw new Error("expected seeded workflow cache row");
    moveIndexedWorkflowIdentity(row.id, stalePath);
    fs.writeFileSync(peerPath, yamlWorkflow("collision"));

    const result = await akmIndex({ stashDir: fixture.root, full: true });
    expect(result.warnings).toEqual([expect.stringMatching(/multiple workflow source files/is)]);
    expect(workflowRows(fixture.ref("canonical"))).toHaveLength(0);
  });

  test.skipIf(process.platform === "win32").each(["ordinary", "standalone"] as BundleKind[])(
    "%s full indexing follows one contained same-format workflow symlink under its authored identity",
    async (kind) => {
      const fixture = configure(kind);
      const supportDir = path.join(fixture.root, "support");
      const targetPath = path.join(supportDir, "target.md");
      const authoredPath = path.join(fixture.ownedDir, "linked.md");
      fs.mkdirSync(supportDir, { recursive: true });
      fs.writeFileSync(targetPath, markdownWorkflow("linked"));
      fs.symlinkSync(path.relative(fixture.ownedDir, targetPath), authoredPath);

      await akmIndex({ stashDir: fixture.root, full: true });
      expect(workflowRows(fixture.ref("linked"))).toEqual([
        expect.objectContaining({
          filePath: authoredPath,
          documentSourcePath: path.relative(fixture.root, authoredPath).replaceAll("\\", "/"),
        }),
      ]);
      await expect(loadWorkflowAsset(fixture.ref("linked"))).resolves.toMatchObject({
        path: authoredPath,
        document: { source: { path: path.relative(fixture.root, authoredPath).replaceAll("\\", "/") } },
      });
      await expect(akmShowUnified({ ref: fixture.ref("linked"), skipLogging: true })).resolves.toMatchObject({
        path: authoredPath,
      });
    },
  );

  test.skipIf(process.platform === "win32")(
    "targeted indexing accepts one contained authored symlink, evicts its same-inode collision, and restores it",
    async () => {
      const fixture = configure("ordinary");
      const targetPath = path.join(fixture.root, "support", "target.md");
      const authoredPath = path.join(fixture.ownedDir, "targeted.md");
      const aliasPath = path.join(fixture.ownedDir, "targeted.MD");
      const ref = fixture.ref("targeted");
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, markdownWorkflow("targeted"));
      fs.writeFileSync(path.join(fixture.ownedDir, "baseline.md"), markdownWorkflow("baseline"));
      await akmIndex({ stashDir: fixture.root, full: true });

      fs.symlinkSync(path.relative(fixture.ownedDir, targetPath), authoredPath);
      expect(await indexWrittenAssets(fixture.root, [authoredPath], { bundleId: fixture.bundle })).toBe(true);
      expect(workflowRows(ref)).toEqual([expect.objectContaining({ filePath: authoredPath })]);

      fs.symlinkSync(path.relative(fixture.ownedDir, targetPath), aliasPath);
      expect(await indexWrittenAssets(fixture.root, [aliasPath], { bundleId: fixture.bundle })).toBe(true);
      expect(workflowRows(ref)).toHaveLength(0);
      await expect(loadWorkflowAsset(ref)).rejects.toMatchObject({ code: "RESOURCE_ALREADY_EXISTS" });

      fs.unlinkSync(aliasPath);
      expect(await indexWrittenAssets(fixture.root, [authoredPath], { bundleId: fixture.bundle })).toBe(true);
      expect(workflowRows(ref)).toEqual([expect.objectContaining({ filePath: authoredPath })]);
    },
  );

  test.skipIf(process.platform === "win32").each(["ordinary", "standalone"] as BundleKind[])(
    "%s full indexing rejects a dangling authored symlink and evicts its stale row and document",
    async (kind) => {
      const fixture = configure(kind);
      const authoredPath = path.join(fixture.ownedDir, "dangling.md");
      const ref = fixture.ref("dangling");
      fs.writeFileSync(authoredPath, markdownWorkflow("stale-dangling"));
      await akmIndex({ stashDir: fixture.root, full: true });
      expect(workflowRows(ref)).toHaveLength(1);

      fs.unlinkSync(authoredPath);
      fs.symlinkSync("missing.md", authoredPath);
      await expect(loadWorkflowAsset(ref)).rejects.toMatchObject({
        code: "INVALID_FLAG_VALUE",
        message: expect.stringMatching(/dangling\.md.*cannot be resolved/is),
      });
      await expect(akmShowUnified({ ref, skipLogging: true })).rejects.toMatchObject({
        code: "INVALID_FLAG_VALUE",
      });
      await expectNoExecutionMutation(ref);

      const rejected = await akmIndex({ stashDir: fixture.root, full: true });
      expect(rejected.warnings).toEqual([expect.stringMatching(/dangling\.md.*cannot be resolved/is)]);
      expect(workflowRows(ref)).toHaveLength(0);
    },
  );

  test.skipIf(process.platform === "win32")(
    "targeted indexing rejects a dangling authored symlink and atomically evicts only its stale identity",
    async () => {
      const fixture = configure("ordinary");
      const authoredPath = path.join(fixture.ownedDir, "dangling.md");
      const baselinePath = path.join(fixture.ownedDir, "baseline.md");
      const ref = fixture.ref("dangling");
      fs.writeFileSync(authoredPath, markdownWorkflow("stale-dangling"));
      fs.writeFileSync(baselinePath, markdownWorkflow("baseline"));
      await akmIndex({ stashDir: fixture.root, full: true });
      const row = workflowRows(ref)[0];
      if (!row?.documentJson) throw new Error("expected seeded workflow cache row");
      moveIndexedWorkflowIdentity(row.id, path.join(fixture.ownedDir, "deleted-former-dangling.md"));

      fs.unlinkSync(authoredPath);
      fs.symlinkSync("missing.md", authoredPath);
      expect(await indexWrittenAssets(fixture.root, [authoredPath], { bundleId: fixture.bundle })).toBe(true);
      expect(workflowRows(ref)).toHaveLength(0);
      expect(workflowRows(fixture.ref("baseline"))).toEqual([expect.objectContaining({ filePath: baselinePath })]);
      await expect(loadWorkflowAsset(ref)).rejects.toMatchObject({ code: "INVALID_FLAG_VALUE" });
    },
  );

  test.skipIf(process.platform === "win32")(
    "targeted indexing rejects format-changing and escaping symlinks and preserves unrelated rows",
    async () => {
      const fixture = configure("ordinary");
      const formatPath = path.join(fixture.ownedDir, "format.md");
      const escapePath = path.join(fixture.ownedDir, "escape.md");
      const baselinePath = path.join(fixture.ownedDir, "baseline.md");
      const innerTarget = path.join(fixture.root, "support", "target.yml");
      const outsideTarget = path.join(storage.root, "outside.md");
      fs.writeFileSync(formatPath, markdownWorkflow("format-seed"));
      fs.writeFileSync(escapePath, markdownWorkflow("escape-seed"));
      fs.writeFileSync(baselinePath, markdownWorkflow("baseline"));
      await akmIndex({ stashDir: fixture.root, full: true });

      fs.mkdirSync(path.dirname(innerTarget), { recursive: true });
      fs.writeFileSync(innerTarget, yamlWorkflow("target"));
      fs.writeFileSync(outsideTarget, markdownWorkflow("outside"));
      fs.unlinkSync(formatPath);
      fs.unlinkSync(escapePath);
      fs.symlinkSync(path.relative(fixture.ownedDir, innerTarget), formatPath);
      fs.symlinkSync(outsideTarget, escapePath);

      expect(await indexWrittenAssets(fixture.root, [formatPath, escapePath], { bundleId: fixture.bundle })).toBe(true);
      expect(workflowRows(fixture.ref("format"))).toHaveLength(0);
      expect(workflowRows(fixture.ref("escape"))).toHaveLength(0);
      expect(workflowRows(fixture.ref("baseline"))).toEqual([expect.objectContaining({ filePath: baselinePath })]);
      await expect(loadWorkflowAsset(fixture.ref("format"))).rejects.toMatchObject({ code: "INVALID_FLAG_VALUE" });
      await expect(loadWorkflowAsset(fixture.ref("escape"))).rejects.toMatchObject({
        code: "PATH_ESCAPE_VIOLATION",
      });
    },
  );

  test.skipIf(process.platform === "win32").each(["ordinary", "standalone"] as BundleKind[])(
    "%s incremental indexing evicts a stale same-inode collision and restores its sole owner",
    async (kind) => {
      const fixture = configure(kind);
      const ownerPath = path.join(fixture.ownedDir, "collision.md");
      const aliasPath = path.join(fixture.ownedDir, "collision.MD");
      const ref = fixture.ref("collision");
      fs.writeFileSync(ownerPath, markdownWorkflow("sole"));
      await akmIndex({ stashDir: fixture.root, full: true });
      expect(workflowRows(ref)).toHaveLength(1);

      fs.symlinkSync(path.basename(ownerPath), aliasPath);
      const rejected = await akmIndex({ stashDir: fixture.root });
      expect(rejected.warnings).toEqual([
        expect.stringMatching(/multiple workflow source files.*collision\.MD.*collision\.md/is),
      ]);
      expect(workflowRows(ref)).toHaveLength(0);
      await expect(loadWorkflowAsset(ref)).rejects.toMatchObject({ code: "RESOURCE_ALREADY_EXISTS" });
      await expect(akmShowUnified({ ref, skipLogging: true })).rejects.toMatchObject({
        code: "RESOURCE_ALREADY_EXISTS",
      });
      await expectNoExecutionMutation(ref);

      fs.unlinkSync(aliasPath);
      const restored = await akmIndex({ stashDir: fixture.root });
      expect(restored.warnings ?? []).toEqual([]);
      expect(workflowRows(ref)).toEqual([expect.objectContaining({ filePath: ownerPath })]);
      await expect(loadWorkflowAsset(ref)).resolves.toMatchObject({ path: ownerPath });
    },
  );

  test.skipIf(process.platform === "win32").each(["ordinary", "standalone"] as BundleKind[])(
    "%s incremental indexing evicts stale format-changing and escaping symlink identities",
    async (kind) => {
      const fixture = configure(kind);
      const formatPath = path.join(fixture.ownedDir, "format.md");
      const escapePath = path.join(fixture.ownedDir, "escape.md");
      const innerTarget = path.join(fixture.root, "support", "target.yml");
      const outsideTarget = path.join(storage.root, "outside.md");
      fs.writeFileSync(formatPath, markdownWorkflow("format-seed"));
      fs.writeFileSync(escapePath, markdownWorkflow("escape-seed"));
      await akmIndex({ stashDir: fixture.root, full: true });
      expect(workflowRows(fixture.ref("format"))).toHaveLength(1);
      expect(workflowRows(fixture.ref("escape"))).toHaveLength(1);

      fs.mkdirSync(path.dirname(innerTarget), { recursive: true });
      fs.writeFileSync(innerTarget, yamlWorkflow("target"));
      fs.writeFileSync(outsideTarget, markdownWorkflow("outside"));
      fs.unlinkSync(formatPath);
      fs.unlinkSync(escapePath);
      fs.symlinkSync(path.relative(fixture.ownedDir, innerTarget), formatPath);
      fs.symlinkSync(outsideTarget, escapePath);

      const rejected = await akmIndex({ stashDir: fixture.root });
      expect(rejected.warnings).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/escape\.md.*outside.*bundle root/is),
          expect.stringMatching(/format\.md.*target\.yml.*different source format/is),
        ]),
      );
      expect(workflowRows(fixture.ref("format"))).toHaveLength(0);
      expect(workflowRows(fixture.ref("escape"))).toHaveLength(0);
      await expect(loadWorkflowAsset(fixture.ref("format"))).rejects.toMatchObject({ code: "INVALID_FLAG_VALUE" });
      await expect(loadWorkflowAsset(fixture.ref("escape"))).rejects.toMatchObject({
        code: "PATH_ESCAPE_VIOLATION",
      });
      await expect(akmShowUnified({ ref: fixture.ref("format"), skipLogging: true })).rejects.toBeDefined();
      await expect(akmShowUnified({ ref: fixture.ref("escape"), skipLogging: true })).rejects.toBeDefined();
      await expectNoExecutionMutation(fixture.ref("format"));
    },
  );

  test.each([
    "ordinary",
    "standalone",
  ] as BundleKind[])("%s rejects every owner in a canonical domain containing multiple nested-suffix sources", async (kind) => {
    const fixture = configure(kind);
    const markdownFilename = "dual.md.md";
    const yamlFilename = "dual.md.yml";
    const filenames = [markdownFilename, yamlFilename];
    fs.writeFileSync(path.join(fixture.ownedDir, markdownFilename), markdownWorkflow("nested-markdown"));
    fs.writeFileSync(path.join(fixture.ownedDir, yamlFilename), yamlWorkflow("nested-yaml"));
    const ref = fixture.ref("dual.md.md");
    const sourcePaths = authoredSourcePaths(fixture, filenames);

    await expect(loadWorkflowAsset(ref)).rejects.toMatchObject({
      code: "INVALID_FLAG_VALUE",
      sourcePaths,
      message: expect.stringMatching(/dual\.md\.md.*dual\.md\.yml/is),
    });
    await expectNoExecutionMutation(ref);
    expect(fs.existsSync(getDbPath())).toBe(false);

    const indexed = await akmIndex({ stashDir: fixture.root, full: true });
    expect(indexed.warnings).toEqual([expect.stringMatching(/dual\.md\.md.*dual\.md\.yml/is)]);
    expect(workflowRows()).toHaveLength(0);
  });

  test.skipIf(process.platform === "win32").each(["ordinary", "standalone"] as BundleKind[])(
    "%s rejects a valid extension-case alias together with its escaping invalid peer and restores the valid owner",
    async (kind) => {
      const fixture = configure(kind);
      const validPath = path.join(fixture.ownedDir, "peer.MD");
      const invalidPath = path.join(fixture.ownedDir, "peer.md");
      const outsidePath = path.join(storage.root, `${kind}-peer-outside.md`);
      const ref = fixture.ref("peer");
      fs.writeFileSync(validPath, markdownWorkflow("valid-peer"));
      await akmIndex({ stashDir: fixture.root, full: true });
      expect(workflowRows(ref)).toEqual([expect.objectContaining({ filePath: validPath })]);

      fs.writeFileSync(outsidePath, markdownWorkflow("outside-peer"));
      fs.symlinkSync(outsidePath, invalidPath);
      const sourcePaths = authoredSourcePaths(fixture, ["peer.MD", "peer.md"]);
      await expect(loadWorkflowAsset(ref)).rejects.toMatchObject({ code: "PATH_ESCAPE_VIOLATION", sourcePaths });
      await expectNoExecutionMutation(ref);
      expect(workflowRows(ref)).toEqual([expect.objectContaining({ filePath: validPath })]);

      await expect(akmShowUnified({ ref, skipLogging: true })).rejects.toMatchObject({
        code: "PATH_ESCAPE_VIOLATION",
        sourcePaths,
      });
      expect(workflowRows(ref)).toHaveLength(0);

      const rejected = await akmIndex({ stashDir: fixture.root });
      expect(rejected.warnings).toEqual([expect.stringMatching(/peer\.MD.*peer\.md.*outside/is)]);
      expect(workflowRows(ref)).toHaveLength(0);

      fs.unlinkSync(invalidPath);
      const restored = await akmIndex({ stashDir: fixture.root });
      expect(restored.warnings ?? []).toEqual([]);
      expect(workflowRows(ref)).toEqual([expect.objectContaining({ filePath: validPath })]);
    },
  );

  test.skipIf(process.platform === "win32").each(["ordinary", "standalone"] as BundleKind[])(
    "%s collects dangling and escaping link failures without reading outside content or retaining a peer",
    async (kind) => {
      const fixture = configure(kind);
      const escapingPath = path.join(fixture.ownedDir, "mixed.md");
      const danglingPath = path.join(fixture.ownedDir, "mixed.yml");
      const outsidePath = path.join(storage.root, `${kind}-mixed-outside.md`);
      const ref = fixture.ref("mixed");
      fs.writeFileSync(escapingPath, markdownWorkflow("stale-mixed"));
      await akmIndex({ stashDir: fixture.root, full: true });
      expect(workflowRows(ref)).toHaveLength(1);

      fs.unlinkSync(escapingPath);
      fs.symlinkSync("missing.yml", danglingPath);
      fs.writeFileSync(outsidePath, markdownWorkflow("outside-secret-marker"));
      fs.symlinkSync(outsidePath, escapingPath);
      const sourcePaths = authoredSourcePaths(fixture, ["mixed.md", "mixed.yml"]);
      const originalRead = fs.readFileSync;
      let outsideReads = 0;
      const readSpy = spyOn(fs, "readFileSync").mockImplementation(((
        file: fs.PathOrFileDescriptor,
        ...args: unknown[]
      ) => {
        if (path.resolve(String(file)) === path.resolve(outsidePath)) outsideReads++;
        return originalRead(file, ...(args as [BufferEncoding?]));
      }) as typeof fs.readFileSync);
      try {
        await expect(loadWorkflowAsset(ref)).rejects.toMatchObject({
          code: "PATH_ESCAPE_VIOLATION",
          sourcePaths,
          message: expect.stringMatching(/mixed\.md.*outside.*mixed\.yml.*cannot be resolved/is),
        });
        await expect(akmShowUnified({ ref, skipLogging: true })).rejects.toMatchObject({ sourcePaths });
        await expectNoExecutionMutation(ref);

        const rejected = await akmIndex({ stashDir: fixture.root });
        expect(rejected.warnings).toEqual([
          expect.stringMatching(/mixed\.md.*outside.*mixed\.yml.*cannot be resolved/is),
        ]);
        expect(workflowRows(ref)).toHaveLength(0);
        expect(outsideReads).toBe(0);
      } finally {
        readSpy.mockRestore();
      }

      fs.unlinkSync(escapingPath);
      fs.unlinkSync(danglingPath);
      fs.writeFileSync(escapingPath, markdownWorkflow("restored-mixed"));
      const restored = await akmIndex({ stashDir: fixture.root });
      expect(restored.warnings ?? []).toEqual([]);
      expect(workflowRows(ref)).toEqual([expect.objectContaining({ filePath: escapingPath })]);
    },
  );

  test.each([
    "ordinary",
    "standalone",
  ] as BundleKind[])("%s rejects a valid workflow and malformed peer by pre-parse ownership without indexing either", async (kind) => {
    const fixture = configure(kind);
    const validPath = path.join(fixture.ownedDir, "malformed.md");
    const malformedPath = path.join(fixture.ownedDir, "malformed.yml");
    const ref = fixture.ref("malformed");
    fs.writeFileSync(validPath, markdownWorkflow("valid"));
    fs.writeFileSync(malformedPath, "jobs: [unterminated\n");
    const sourcePaths = authoredSourcePaths(fixture, ["malformed.md", "malformed.yml"]);

    await expect(loadWorkflowAsset(ref)).rejects.toMatchObject({
      code: "RESOURCE_ALREADY_EXISTS",
      sourcePaths,
    });
    await expectNoExecutionMutation(ref);
    const rejected = await akmIndex({ stashDir: fixture.root, full: true });
    expect(rejected.warnings).toEqual([expect.stringMatching(/malformed\.md.*malformed\.yml/is)]);
    expect(workflowRows(ref)).toHaveLength(0);
  });

  test.skipIf(process.platform === "win32")(
    "targeted indexing cannot delete a stale domain and then re-upsert its valid peer",
    async () => {
      const fixture = configure("ordinary");
      const validPath = path.join(fixture.ownedDir, "targeted.MD");
      const invalidPath = path.join(fixture.ownedDir, "targeted.md");
      const outsidePath = path.join(storage.root, "targeted-outside.md");
      const baselinePath = path.join(fixture.ownedDir, "baseline.md");
      const ref = fixture.ref("targeted");
      fs.writeFileSync(validPath, markdownWorkflow("targeted-valid"));
      fs.writeFileSync(baselinePath, markdownWorkflow("baseline"));
      await akmIndex({ stashDir: fixture.root, full: true });
      const row = workflowRows(ref)[0];
      if (!row?.documentJson) throw new Error("expected seeded targeted workflow cache row");
      const otherRef = cloneWorkflowRowIntoBundle(row.id, "other-domain", validPath, "workflows/targeted");

      fs.writeFileSync(outsidePath, markdownWorkflow("targeted-outside"));
      fs.symlinkSync(outsidePath, invalidPath);
      expect(await indexWrittenAssets(fixture.root, [validPath, invalidPath], { bundleId: fixture.bundle })).toBe(true);
      expect(workflowRows(ref)).toHaveLength(0);
      expect(workflowRows(fixture.ref("baseline"))).toEqual([expect.objectContaining({ filePath: baselinePath })]);
      expect(workflowRows(otherRef)).toEqual([expect.objectContaining({ documentJson: expect.any(String) })]);
      await expect(loadWorkflowAsset(ref)).rejects.toMatchObject({
        sourcePaths: authoredSourcePaths(fixture, ["targeted.MD", "targeted.md"]),
      });

      fs.unlinkSync(invalidPath);
      expect(await indexWrittenAssets(fixture.root, [validPath], { bundleId: fixture.bundle })).toBe(true);
      expect(workflowRows(ref)).toEqual([expect.objectContaining({ filePath: validPath })]);
    },
  );
});
