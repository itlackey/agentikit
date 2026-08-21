// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmShowUnified, showByRef, showLocal } from "../../../src/commands/read/show";
import { parseBundleRef } from "../../../src/core/asset/asset-ref";
import { resetConfigCache } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { getStateDbPath } from "../../../src/core/state-db";
import { akmIndex, lookupBundleRef } from "../../../src/indexer/indexer";
import { closeDatabase, openExistingDatabase } from "../../../src/storage/repositories/index-connection";
import { getWorkflowTemplate } from "../../../src/workflows/authoring/authoring";
import { startWorkflowRun } from "../../../src/workflows/runtime/runs";
import { loadWorkflowAsset } from "../../../src/workflows/runtime/workflow-asset-loader";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

interface BundleFixture {
  root: string;
  adapter: "akm" | "akm-workflow" | "okf";
}

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => storage.cleanup());

function write(root: string, relativePath: string, content: string): string {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

function genericDocument(marker: string): string {
  return `---\ntype: knowledge\ntitle: ${marker}\n---\n\n# ${marker}\n\n${marker}\n`;
}

function configure(early: BundleFixture, later: BundleFixture): void {
  writeSandboxConfig({
    semanticSearchMode: "off",
    defaultBundle: "early",
    bundles: {
      early: {
        path: early.root,
        components: { main: { root: ".", adapter: early.adapter, writable: true } },
      },
      later: {
        path: later.root,
        components: { main: { root: ".", adapter: later.adapter, writable: true } },
      },
    },
  });
  resetConfigCache();
}

function fixture(name: string, adapter: BundleFixture["adapter"]): BundleFixture {
  const root = path.join(storage.root, name);
  fs.mkdirSync(root, { recursive: true });
  return { root, adapter };
}

function deleteIndexEntry(itemRef: string): void {
  const db = openExistingDatabase(getDbPath());
  try {
    db.prepare("DELETE FROM entries WHERE item_ref = ?").run(itemRef);
  } finally {
    closeDatabase(db);
  }
}

describe("generic lookup/show installation-priority ownership", () => {
  test("an unqualified generic read keeps the first OKF owner while runtime rejects it and qualified native remains valid", async () => {
    const early = fixture("early-okf", "okf");
    const later = fixture("later-native", "akm");
    const earlyPath = write(early.root, "workflows/same.md", genericDocument("EARLY_OKF_OWNER"));
    const laterPath = write(later.root, "workflows/same.md", getWorkflowTemplate());
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });

    const indexed = await lookupBundleRef(parseBundleRef("workflows/same"));
    expect(indexed).toMatchObject({ filePath: earlyPath, adapterId: "okf", itemRef: "early//workflows/same" });

    const shown = await akmShowUnified({ ref: "workflows/same", skipLogging: true });
    expect(shown).toMatchObject({ path: earlyPath, ref: "workflows/same" });
    expect(shown.content).toContain("EARLY_OKF_OWNER");
    expect(await showByRef("workflows/same")).toMatchObject({ filePath: earlyPath });

    deleteIndexEntry("early//workflows/same");
    expect(await lookupBundleRef(parseBundleRef("workflows/same"))).toBeNull();
    expect(await showLocal({ ref: "workflows/same" })).toMatchObject({
      path: earlyPath,
      type: "knowledge",
      name: "EARLY_OKF_OWNER",
      ref: "workflows/same",
    });

    const stateBeforeRuntimeRejection = fs.readFileSync(getStateDbPath());
    await expect(loadWorkflowAsset("workflows/same")).rejects.toThrow(
      /adapter "okf".*does not support native workflow execution/i,
    );
    await expect(startWorkflowRun("workflows/same")).rejects.toThrow(
      /adapter "okf".*does not support native workflow execution/i,
    );
    expect(fs.readFileSync(getStateDbPath())).toEqual(stateBeforeRuntimeRejection);

    expect(await lookupBundleRef(parseBundleRef("later//workflows/same"))).toMatchObject({
      filePath: laterPath,
      adapterId: "akm",
    });
    expect((await akmShowUnified({ ref: "later//workflows/same", skipLogging: true })).path).toBe(laterPath);
    expect((await loadWorkflowAsset("later//workflows/same")).path).toBe(laterPath);
  });

  test("an established earlier OKF owner is insulated from a lower invalid native collision domain", async () => {
    const early = fixture("early-okf-collision", "okf");
    const later = fixture("later-native-collision", "akm");
    const earlyPath = write(early.root, "workflows/same.md", genericDocument("EARLY_INSULATED_OWNER"));
    write(later.root, "workflows/same.md", getWorkflowTemplate());
    write(
      later.root,
      "workflows/same.yml",
      "name: lower-collision\non: { workflow_dispatch: null }\njobs: { main: { runs-on: [self-hosted], steps: [] } }\n",
    );
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });

    expect(await lookupBundleRef(parseBundleRef("workflows/same"))).toMatchObject({
      filePath: earlyPath,
      adapterId: "okf",
    });
    expect((await showLocal({ ref: "workflows/same" })).content).toContain("EARLY_INSULATED_OWNER");
    deleteIndexEntry("early//workflows/same");
    expect(await lookupBundleRef(parseBundleRef("workflows/same"))).toBeNull();
    expect(await showLocal({ ref: "workflows/same" })).toMatchObject({
      path: earlyPath,
      type: "knowledge",
      name: "EARLY_INSULATED_OWNER",
      ref: "workflows/same",
      content: expect.stringContaining("EARLY_INSULATED_OWNER"),
    });
    const stateBeforeRuntimeRejection = fs.readFileSync(getStateDbPath());
    await expect(loadWorkflowAsset("workflows/same")).rejects.toThrow(/adapter "okf"/i);
    expect(fs.readFileSync(getStateDbPath())).toEqual(stateBeforeRuntimeRejection);

    await expect(lookupBundleRef(parseBundleRef("later//workflows/same"))).rejects.toMatchObject({
      code: "RESOURCE_ALREADY_EXISTS",
    });
    await expect(showLocal({ ref: "later//workflows/same" })).rejects.toMatchObject({
      code: "RESOURCE_ALREADY_EXISTS",
    });
  });

  test("an absent or reserved earlier OKF concept allows fallback to the later native owner", async () => {
    const early = fixture("early-okf-fallback", "okf");
    const later = fixture("later-standalone-fallback", "akm-workflow");
    write(early.root, "index.md", "# Reserved structural index\n");
    const absentPath = write(later.root, "absent.md", getWorkflowTemplate());
    const indexPath = write(later.root, "index.md", getWorkflowTemplate());
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });

    expect(await lookupBundleRef(parseBundleRef("absent"))).toMatchObject({
      filePath: absentPath,
      adapterId: "akm-workflow",
    });
    expect((await showLocal({ ref: "absent" })).path).toBe(absentPath);
    expect((await loadWorkflowAsset("absent")).path).toBe(absentPath);

    expect(await lookupBundleRef(parseBundleRef("index"))).toMatchObject({
      filePath: indexPath,
      adapterId: "akm-workflow",
    });
    expect((await showLocal({ ref: "index" })).path).toBe(indexPath);
    expect((await loadWorkflowAsset("index")).path).toBe(indexPath);
  });

  test("a missing first-native index row cannot retarget lookup to a lower indexed owner and disk show keeps the physical owner", async () => {
    const early = fixture("early-native-stale-index", "akm");
    const later = fixture("later-native-stale-index", "akm");
    const earlyPath = write(early.root, "workflows/stale.md", getWorkflowTemplate());
    write(later.root, "workflows/stale.md", getWorkflowTemplate());
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });

    deleteIndexEntry("early//workflows/stale");

    expect(await lookupBundleRef(parseBundleRef("workflows/stale"))).toBeNull();
    await expect(showByRef("workflows/stale")).rejects.toThrow(/not found/i);
    expect((await showLocal({ ref: "workflows/stale" })).path).toBe(earlyPath);
  });
});
