// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { showLocal } from "../../../src/commands/read/show";
import { opencodeAdapter } from "../../../src/core/adapter/adapters";
import { parseBundleRef } from "../../../src/core/asset/asset-ref";
import { resetConfigCache } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { getStateDbPath } from "../../../src/core/state-db";
import { akmIndex, lookupBundleRef } from "../../../src/indexer/indexer";
import { closeDatabase, openExistingDatabase } from "../../../src/storage/repositories/index-connection";
import { getWorkflowTemplate } from "../../../src/workflows/authoring/authoring";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import { listWorkflowRuns, startWorkflowRun } from "../../../src/workflows/runtime/runs";
import { loadWorkflowAsset } from "../../../src/workflows/runtime/workflow-asset-loader";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

type AdapterId =
  | "agent-skills"
  | "akm"
  | "akm-task"
  | "akm-workflow"
  | "claude"
  | "dotenv"
  | "generic-files"
  | "opencode";

interface Fixture {
  root: string;
  adapter: AdapterId;
}

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => storage.cleanup());

function fixture(name: string, adapter: AdapterId): Fixture {
  const root = path.join(storage.root, name);
  fs.mkdirSync(root, { recursive: true });
  return { root, adapter };
}

function write(root: string, relativePath: string, content: string): string {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

function skill(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} owner\n---\n\n# ${name}\n`;
}

function configure(early: Fixture, later: Fixture): void {
  writeSandboxConfig({
    semanticSearchMode: "off",
    defaultBundle: "early",
    bundles: {
      early: { path: early.root, components: { main: { root: ".", adapter: early.adapter, writable: true } } },
      later: { path: later.root, components: { main: { root: ".", adapter: later.adapter, writable: true } } },
    },
  });
  resetConfigCache();
}

function mutateEntry(itemRef: string, state: "complete" | "missing" | "incomplete" | "stale", stalePath: string): void {
  if (state === "complete") return;
  const db = openExistingDatabase(getDbPath());
  try {
    if (state === "missing") db.prepare("DELETE FROM entries WHERE item_ref = ?").run(itemRef);
    if (state === "incomplete") db.prepare("UPDATE entries SET concept_id = NULL WHERE item_ref = ?").run(itemRef);
    if (state === "stale") db.prepare("UPDATE entries SET file_path = ? WHERE item_ref = ?").run(stalePath, itemRef);
  } finally {
    closeDatabase(db);
  }
}

function denyAssetRead(assetPath: string): ReturnType<typeof spyOn> {
  const original = fs.readFileSync;
  return spyOn(fs, "readFileSync").mockImplementation(((candidate, options) => {
    if (path.resolve(String(candidate)) === path.resolve(assetPath)) {
      throw new Error(`ownership arbitration must not read ${assetPath}`);
    }
    return original(candidate, options as never);
  }) as typeof fs.readFileSync);
}

function workflowDocumentSnapshot(): Array<Record<string, unknown>> {
  const db = openExistingDatabase(getDbPath());
  try {
    return db
      .prepare(
        `SELECT entry_id AS entryId, schema_version AS schemaVersion, document_json AS documentJson,
                source_path AS sourcePath, source_hash AS sourceHash
           FROM workflow_documents
          ORDER BY entry_id`,
      )
      .all() as Array<Record<string, unknown>>;
  } finally {
    closeDatabase(db);
  }
}

const toolDirShapes = [
  ["claude", "commands/deploy", "commands/deploy.md", "# deploy"],
  ["claude", "agents/reviewer", "agents/reviewer.md", "# reviewer"],
  ["claude", "skills/audit", "skills/audit/SKILL.md", skill("audit")],
  ["claude", "CLAUDE", "CLAUDE.md", "# instructions"],
  ["opencode", "commands/deploy", "commands/deploy.md", "# deploy"],
  ["opencode", "command/legacy", "command/legacy.md", "# legacy"],
  ["opencode", "agents/reviewer", "agents/reviewer.md", "# reviewer"],
  ["opencode", "agent/legacy", "agent/legacy.md", "# legacy"],
  ["opencode", "skills/audit", "skills/audit/SKILL.md", skill("audit")],
  ["opencode", "skill/legacy", "skill/legacy/SKILL.md", skill("legacy")],
  ["opencode", "AGENTS", "AGENTS.md", "# instructions"],
] as const;

const nonExtensionHintShapes = [
  ["akm", "skills/native-skill", "skills/native-skill/SKILL.md", skill("native-skill")],
  ["akm", "secrets/signing.key", "secrets/signing.key", "opaque-secret"],
  ["akm", "secrets/token", "secrets/token", "opaque-secret"],
  ["akm", "env/default", "env/.env", "TOKEN=hidden\n"],
  ["agent-skills", "portable-skill", "portable-skill/SKILL.md", skill("portable-skill")],
] as const;

describe("shared adapter physical-owner authority", () => {
  test.each([
    "complete",
    "missing",
    "incomplete",
    "stale",
  ] as const)("loose AKM smart-Markdown remains the first owner with a %s row", async (state) => {
    const early = fixture(`early-loose-command-${state}`, "akm");
    const later = fixture(`later-loose-command-${state}`, "akm-workflow");
    const earlyPath = write(early.root, "same.md", "Use $ARGUMENTS exactly.\n");
    const laterPath = write(later.root, "commands/same.md", getWorkflowTemplate());
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });
    mutateEntry("early//commands/same", state, path.join(early.root, "stale", "same.md"));

    const found = await lookupBundleRef(parseBundleRef("commands/same"));
    if (state === "complete") expect(found).toMatchObject({ filePath: earlyPath, conceptId: "commands/same" });
    else expect(found).toBeNull();
    expect((await showLocal({ ref: "commands/same" })).path).toBe(earlyPath);
    expect(await lookupBundleRef(parseBundleRef("later//commands/same"))).toMatchObject({ filePath: laterPath });
  });

  test("show reuses lookup's physical-owner resolution instead of probing the source twice", async () => {
    const early = fixture("early-single-owner-pass", "opencode");
    const later = fixture("later-single-owner-pass", "akm-workflow");
    const earlyPath = write(early.root, "skill/once/SKILL.md", skill("once"));
    write(later.root, "skill/once.md", getWorkflowTemplate());
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });
    mutateEntry("early//skill/once", "missing", "");

    const candidateSpy = spyOn(opencodeAdapter, "readCandidates");
    try {
      expect((await showLocal({ ref: "skill/once" })).path).toBe(earlyPath);
      expect(candidateSpy).toHaveBeenCalledTimes(1);
    } finally {
      candidateSpy.mockRestore();
    }
  });

  test.each([
    ["load", "complete"],
    ["start", "missing"],
    ["run", "incomplete"],
    ["load", "stale"],
  ] as const)("%s rejects a loose AKM command owner with a %s row before mutation", async (surface, state) => {
    const early = fixture(`early-loose-runtime-${surface}-${state}`, "akm");
    const later = fixture(`later-loose-runtime-${surface}-${state}`, "akm-workflow");
    const earlyPath = write(early.root, "same.md", "Use $ARGUMENTS exactly.\n");
    const laterPath = write(later.root, "commands/same.md", getWorkflowTemplate());
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });
    mutateEntry("early//commands/same", state, path.join(early.root, "stale", "same.md"));
    await listWorkflowRuns();
    const stateBefore = fs.readFileSync(getStateDbPath());
    const cacheBefore = workflowDocumentSnapshot();
    let dispatches = 0;

    const readSpy = denyAssetRead(earlyPath);
    try {
      const operation =
        surface === "load"
          ? loadWorkflowAsset("commands/same")
          : surface === "start"
            ? startWorkflowRun("commands/same")
            : runWorkflowSteps({
                target: "commands/same",
                summaryJudge: null,
                dispatcher: async () => {
                  dispatches++;
                  return { ok: true as const, text: "unexpected" };
                },
              });
      await expect(operation).rejects.toThrow(/adapter "akm".*does not support native workflow execution/i);
    } finally {
      readSpy.mockRestore();
    }
    expect(dispatches).toBe(0);
    expect(fs.readFileSync(getStateDbPath())).toEqual(stateBefore);
    expect(workflowDocumentSnapshot()).toEqual(cacheBefore);
    expect((await listWorkflowRuns()).runs).toHaveLength(0);
    expect((await loadWorkflowAsset("later//commands/same")).path).toBe(laterPath);
  });

  test.each([
    ".md",
    ".markdown",
    ".txt",
    ".text",
    ".MD",
    ".MARKDOWN",
    ".TXT",
    ".TEXT",
  ])("generic-files canonical document owner covers %s with a missing row", async (extension) => {
    const early = fixture(`early-generic-${extension.slice(1)}`, "generic-files");
    const later = fixture(`later-generic-${extension.slice(1)}`, "akm-workflow");
    const earlyPath = write(early.root, `docs/format${extension}`, "# generic document\n");
    const laterPath = write(later.root, "docs/format.md", getWorkflowTemplate());
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });
    mutateEntry("early//docs/format", "missing", "");

    expect(await lookupBundleRef(parseBundleRef("docs/format"))).toBeNull();
    expect((await showLocal({ ref: "docs/format" })).path).toBe(earlyPath);
    expect(await lookupBundleRef(parseBundleRef("later//docs/format"))).toMatchObject({ filePath: laterPath });
  });

  test.each([
    "complete",
    "missing",
    "incomplete",
    "stale",
  ] as const)("dotenv env/.env is canonically env/default with a %s row", async (state) => {
    const early = fixture(`early-dotenv-default-${state}`, "dotenv");
    const later = fixture(`later-dotenv-default-${state}`, "akm-workflow");
    const earlyPath = write(early.root, "env/.env", "TOKEN=hidden\n");
    write(later.root, "env/default.md", getWorkflowTemplate());
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });
    mutateEntry("early//env/default", state, path.join(early.root, "stale", ".env"));

    const found = await lookupBundleRef(parseBundleRef("env/default"));
    if (state === "complete") expect(found).toMatchObject({ filePath: earlyPath, conceptId: "env/default" });
    else expect(found).toBeNull();
    expect((await showLocal({ ref: "env/default" })).path).toBe(earlyPath);
  });

  test("a nested tool skill manifest cannot claim a deeper queried concept", async () => {
    const early = fixture("early-nested-tool-skill", "opencode");
    const later = fixture("later-nested-tool-skill", "akm-workflow");
    write(early.root, "skills/pkg/nested/SKILL.md", skill("nested"));
    const laterPath = write(later.root, "skills/pkg/nested.md", getWorkflowTemplate());
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });

    expect(await lookupBundleRef(parseBundleRef("skills/pkg/nested"))).toMatchObject({ filePath: laterPath });
    expect((await showLocal({ ref: "skills/pkg/nested" })).path).toBe(laterPath);
    expect((await loadWorkflowAsset("skills/pkg/nested")).path).toBe(laterPath);
  });

  test("generic document collisions reject runtime without reads, state, runs, or dispatch", async () => {
    const early = fixture("early-generic-collision", "generic-files");
    const later = fixture("later-generic-collision", "akm-workflow");
    const markdown = write(early.root, "collision.md", "# markdown owner\n");
    const text = write(early.root, "collision.txt", "text owner\n");
    const laterPath = write(later.root, "collision.md", getWorkflowTemplate());
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });
    expect((await loadWorkflowAsset("later//collision")).path).toBe(laterPath);
    await listWorkflowRuns();
    const stateBefore = fs.readFileSync(getStateDbPath());
    const cacheBefore = workflowDocumentSnapshot();
    let dispatches = 0;

    const markdownSpy = denyAssetRead(markdown);
    const textSpy = denyAssetRead(text);
    try {
      await expect(loadWorkflowAsset("collision")).rejects.toThrow(/multiple physical owners/i);
      await expect(startWorkflowRun("collision")).rejects.toThrow(/multiple physical owners/i);
      await expect(
        runWorkflowSteps({
          target: "collision",
          summaryJudge: null,
          dispatcher: async () => {
            dispatches++;
            return { ok: true as const, text: "unexpected" };
          },
        }),
      ).rejects.toThrow(/multiple physical owners/i);
    } finally {
      markdownSpy.mockRestore();
      textSpy.mockRestore();
    }
    expect(dispatches).toBe(0);
    expect(fs.readFileSync(getStateDbPath())).toEqual(stateBefore);
    expect(workflowDocumentSnapshot()).toEqual(cacheBefore);
    expect((await listWorkflowRuns()).runs).toHaveLength(0);
  });

  test.each(
    toolDirShapes,
  )("disk lookup/show honors %s read placement %s without bytes", async (adapter, conceptId, relativePath, content) => {
    const early = fixture(`early-${adapter}-${conceptId.replaceAll("/", "-")}`, adapter);
    const later = fixture(`later-${adapter}-${conceptId.replaceAll("/", "-")}`, adapter);
    const earlyPath = write(early.root, relativePath, content);
    const laterPath = write(later.root, relativePath, content.replaceAll("legacy", "later"));
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });
    mutateEntry(`early//${conceptId}`, "missing", "");

    const readSpy = denyAssetRead(earlyPath);
    try {
      expect(await lookupBundleRef(parseBundleRef(conceptId))).toBeNull();
    } finally {
      readSpy.mockRestore();
    }
    expect((await showLocal({ ref: conceptId })).path).toBe(earlyPath);
    expect(await lookupBundleRef(parseBundleRef(`later//${conceptId}`))).toMatchObject({ filePath: laterPath });
  });

  test.each(
    nonExtensionHintShapes,
  )("disk lookup/show honors %s authoritative placement %s without bytes", async (adapter, conceptId, relativePath, content) => {
    const early = fixture(`early-${adapter}-${conceptId.replaceAll("/", "-")}`, adapter);
    const later = fixture(`later-${adapter}-${conceptId.replaceAll("/", "-")}`, "akm-workflow");
    const earlyPath = write(early.root, relativePath, content);
    const laterPath = write(later.root, `${conceptId}.md`, getWorkflowTemplate());
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });
    mutateEntry(`early//${conceptId}`, "missing", "");

    const readSpy = denyAssetRead(earlyPath);
    try {
      expect(await lookupBundleRef(parseBundleRef(conceptId))).toBeNull();
    } finally {
      readSpy.mockRestore();
    }
    expect((await showLocal({ ref: conceptId })).path).toBe(earlyPath);
    expect(await lookupBundleRef(parseBundleRef(`later//${conceptId}`))).toMatchObject({ filePath: laterPath });
  });

  test.each([
    "complete",
    "missing",
    "incomplete",
    "stale",
  ] as const)("complete/missing/incomplete/stale first rows preserve the singular read owner: %s", async (state) => {
    const early = fixture(`early-row-${state}`, "opencode");
    const later = fixture(`later-row-${state}`, "opencode");
    const earlyPath = write(early.root, "skill/row-owner/SKILL.md", skill("row-owner"));
    write(later.root, "skill/row-owner/SKILL.md", skill("row-owner"));
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });
    mutateEntry("early//skill/row-owner", state, path.join(early.root, "stale", "SKILL.md"));

    const found = await lookupBundleRef(parseBundleRef("skill/row-owner"));
    if (state === "complete") expect(found).toMatchObject({ filePath: earlyPath });
    else expect(found).toBeNull();
    expect((await showLocal({ ref: "skill/row-owner" })).path).toBe(earlyPath);
  });

  test.each([
    ["akm-task", "near", "near.yaml", "schedule: '* * * * *'\nprompt: nope\n"],
    ["dotenv", "env/prod", "env/prod.env", "TOKEN=hidden\n"],
  ] as const)("path-level abstention in %s falls through consistently", async (adapter, conceptId, relativePath, content) => {
    const early = fixture(`early-abstain-${adapter}`, adapter);
    const later = fixture(`later-abstain-${adapter}`, "akm-workflow");
    write(early.root, relativePath, content);
    if (adapter === "dotenv") write(early.root, "env/prod.sensitive", "");
    const laterPath = write(later.root, `${conceptId}.md`, getWorkflowTemplate());
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });

    expect(await lookupBundleRef(parseBundleRef(conceptId))).toMatchObject({ filePath: laterPath });
    expect((await showLocal({ ref: conceptId })).path).toBe(laterPath);
    expect((await loadWorkflowAsset(conceptId)).path).toBe(laterPath);
  });

  test.each([
    ["load", "complete"],
    ["load", "stale"],
    ["start", "missing"],
    ["run", "incomplete"],
  ] as const)("%s rejects the first non-native singular owner with a %s row before mutation", async (surface, state) => {
    const early = fixture(`early-runtime-${surface}-${state}`, "opencode");
    const later = fixture(`later-runtime-${surface}-${state}`, "akm-workflow");
    const earlyPath = write(early.root, "skill/runtime-owner/SKILL.md", skill("runtime-owner"));
    const laterPath = write(later.root, "skill/runtime-owner.md", getWorkflowTemplate());
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });
    mutateEntry("early//skill/runtime-owner", state, path.join(early.root, "stale", "SKILL.md"));
    await listWorkflowRuns();
    const stateBefore = fs.readFileSync(getStateDbPath());
    let dispatches = 0;

    const readSpy = denyAssetRead(earlyPath);
    try {
      const operation =
        surface === "load"
          ? loadWorkflowAsset("skill/runtime-owner")
          : surface === "start"
            ? startWorkflowRun("skill/runtime-owner")
            : runWorkflowSteps({
                target: "skill/runtime-owner",
                summaryJudge: null,
                dispatcher: async () => {
                  dispatches++;
                  return { ok: true as const, text: "unexpected" };
                },
              });
      await expect(operation).rejects.toThrow(/adapter "opencode".*does not support native workflow execution/i);
    } finally {
      readSpy.mockRestore();
    }
    expect(dispatches).toBe(0);
    expect(fs.readFileSync(getStateDbPath())).toEqual(stateBefore);
    expect((await listWorkflowRuns()).runs).toHaveLength(0);
    expect((await loadWorkflowAsset("later//skill/runtime-owner")).path).toBe(laterPath);
  });
});
