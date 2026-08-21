// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { showLocal } from "../../../src/commands/read/show";
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

type AdapterId = "agent-skills" | "akm" | "akm-task" | "akm-workflow" | "claude" | "dotenv" | "opencode";

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
