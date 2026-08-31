// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmCurate } from "../../src/commands/read/curate";
import { akmSearch } from "../../src/commands/read/search";
import { akmShowUnified } from "../../src/commands/read/show";
import { resetConfigCache, saveConfig } from "../../src/core/config/config";
import { getDbPath } from "../../src/core/paths";
import { openStateDatabase } from "../../src/core/state-db";
import { replaceStoredGraph } from "../../src/indexer/db/graph-db";
import { loadGraphBoostContext, resetGraphBoostCache } from "../../src/indexer/graph/graph-boost";
import { akmIndex } from "../../src/indexer/indexer";
import { buildLexicalQueryPlan } from "../../src/indexer/search/fts-query";
import { defaultRankingContributors } from "../../src/indexer/search/ranking-contributors";
import { closeDatabase, openExistingDatabase } from "../../src/storage/repositories/index-connection";
import { getEntryById, getEntryByRef } from "../../src/storage/repositories/index-entries-repository";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

interface UsageRow {
  event_type: string;
  query: string | null;
  entry_ref: string | null;
  metadata: string | null;
  source: string;
}

let storage: IsolatedAkmStorage;
let teamDir = "";

beforeEach(async () => {
  storage = withIsolatedAkmStorage();
  teamDir = path.join(storage.root, "team");
  fs.mkdirSync(path.join(teamDir, "memories"), { recursive: true });
  resetConfigCache();
  saveConfig({
    semanticSearchMode: "off",
    bundles: {
      stash: { path: storage.stashDir },
      team: { path: teamDir },
    },
    defaultBundle: "stash",
    registries: [],
  });
  writeIndexFixture();
  await akmIndex({ stashDir: storage.stashDir, full: true });
  installGraphFixture();
  const state = openStateDatabase();
  state.prepare("DELETE FROM usage_events").run();
  state.close();
  resetGraphBoostCache();
});

afterEach(() => {
  resetConfigCache();
  resetGraphBoostCache();
  storage.cleanup();
});

function writeAsset(
  root: string,
  typeDir: "memories" | "knowledge",
  name: string,
  frontmatter: string,
  body: string,
): string {
  const filePath = path.join(root, typeDir, `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\n${frontmatter}\n---\n\n${body}\n`);
  return filePath;
}

function writeIndexFixture(): void {
  writeAsset(storage.stashDir, "memories", "parent", "description: surface-parent-needle", "Primary parent body.");
  writeAsset(
    storage.stashDir,
    "memories",
    "parent.derived",
    "inferred: true\nsource: memories/parent\ndescription: direct-child-needle",
    "Primary derived body.",
  );
  writeAsset(
    storage.stashDir,
    "knowledge",
    "graph-target",
    "description: graphneedle graph-target operational guide\nquality: curated\ntags: [graph-target]\nsearchHints: [graph-target]",
    "Graph target body.",
  );
  writeAsset(
    storage.stashDir,
    "knowledge",
    "plain-target",
    "description: plainneedle operational guide",
    "Plain target body.",
  );
  writeAsset(teamDir, "memories", "parent", "description: team-parent-needle", "Team parent body.");
  writeAsset(
    teamDir,
    "memories",
    "parent.derived",
    "inferred: true\nsource: memories/parent\ndescription: team-parent-derived-needle",
    "Team derived body.",
  );
  writeAsset(teamDir, "memories", "team-only", "description: team-surface-needle", "Team-only parent body.");
  writeAsset(
    teamDir,
    "memories",
    "team-only.derived",
    "inferred: true\nsource: memories/team-only\ndescription: team-direct-child-needle",
    "Team-only derived body.",
  );
}

function installGraphFixture(): void {
  const db = openExistingDatabase(getDbPath());
  try {
    replaceStoredGraph(db, {
      schemaVersion: 2,
      generatedAt: "2026-07-22T00:00:00.000Z",
      stashRoot: storage.stashDir,
      files: [
        {
          path: path.join(storage.stashDir, "knowledge", "graph-target.md"),
          type: "knowledge",
          bodyHash: "graph-body-hash",
          extractionRunId: "graph-run-1",
          entities: ["graphneedle", "graph", "target", "graph-target"],
          relations: [],
        },
      ],
      entities: ["graphneedle", "graph", "target", "graph-target"],
      relations: [],
    });
  } finally {
    closeDatabase(db);
  }
}

function usageRows(): UsageRow[] {
  const db = openStateDatabase();
  try {
    return db
      .prepare("SELECT event_type, query, entry_ref, metadata, source FROM usage_events ORDER BY id")
      .all() as UsageRow[];
  } finally {
    db.close();
  }
}

function metadataFor(query: string, ref: string): Record<string, unknown> | undefined {
  const row = usageRows().find((candidate) => candidate.query === query && candidate.entry_ref === ref);
  return row?.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined;
}

function clearUsageRows(): void {
  const db = openStateDatabase();
  db.prepare("DELETE FROM usage_events").run();
  db.close();
}

function rankingContributorLedger(query: string, ref: string): Array<{ name: string; contribution: number }> {
  const db = openExistingDatabase(getDbPath());
  try {
    const entryId = getEntryByRef(db, ref)?.id;
    if (entryId === undefined) throw new Error(`Missing indexed fixture: ${ref}`);
    const indexed = getEntryById(db, entryId);
    if (!indexed) throw new Error(`Missing indexed entry ${entryId}: ${ref}`);

    const queryTokens = buildLexicalQueryPlan(query).tokens.map((token) => token.toLowerCase());
    const ctx = {
      db,
      query,
      queryLower: query.toLowerCase().trim(),
      queryTokens,
      graphContext: loadGraphBoostContext([storage.stashDir, teamDir], query, undefined, db),
      projectContext: null,
    };
    const item = {
      id: entryId,
      entry: indexed.entry,
      filePath: indexed.filePath,
      score: 1,
      rankingMode: "fts" as const,
      itemRef: indexed.itemRef,
      bundleId: indexed.bundleId,
      conceptId: indexed.conceptId,
    };

    return defaultRankingContributors
      .filter((contributor) => contributor.appliesTo(item, ctx))
      .map((contributor) => ({ name: contributor.name, contribution: contributor.adjust(item, ctx) }))
      .filter(({ contribution }) => contribution !== 0);
  } finally {
    closeDatabase(db);
  }
}

describe("downstream value attribution", () => {
  test("persists MI direct and parent-surface exposure without adding attribution to search result payloads", async () => {
    const direct = await akmSearch({ query: "direct-child-needle", limit: 10 });
    const surface = await akmSearch({ query: "surface-parent-needle", limit: 10 });

    expect(metadataFor("direct-child-needle", "stash//memories/parent.derived")).toEqual({
      downstreamAttribution: {
        version: 1,
        control: false,
        memoryInference: { exposure: "direct", childRef: "stash//memories/parent.derived" },
      },
    });
    expect(metadataFor("surface-parent-needle", "stash//memories/parent")).toEqual({
      downstreamAttribution: {
        version: 1,
        control: false,
        memoryInference: { exposure: "surface", childRef: "stash//memories/parent.derived" },
      },
    });
    expect(JSON.stringify({ direct, surface })).not.toContain("downstreamAttribution");
  });

  test("persists graph metadata only for a positive graph contribution", async () => {
    const graph = await akmSearch({ query: "graphneedle", limit: 10 });
    await akmSearch({ query: "plainneedle", limit: 10 });

    const graphMetadata = metadataFor("graphneedle", "stash//knowledge/graph-target") as {
      downstreamAttribution?: {
        graphExtraction?: { boost?: number; bodyHash?: string; extractionRunId?: string };
      };
    };
    expect(graphMetadata.downstreamAttribution?.graphExtraction?.boost).toBeGreaterThan(0);
    expect(graphMetadata.downstreamAttribution?.graphExtraction).toMatchObject({
      bodyHash: "graph-body-hash",
      extractionRunId: "graph-run-1",
    });
    expect(metadataFor("plainneedle", "stash//knowledge/plain-target")).toEqual({
      downstreamAttribution: { version: 1, control: true },
    });
    expect(JSON.stringify(graph)).not.toContain("graph-body-hash");
    expect(JSON.stringify(graph)).not.toContain("graph-run-1");
  });

  test("records only the graph contributor's applied capped contribution", async () => {
    await akmSearch({ query: "graph-target", limit: 10, disableProjectContext: true });

    const graph = metadataFor("graph-target", "stash//knowledge/graph-target") as {
      downstreamAttribution?: { graphExtraction?: { boost?: number } };
    };
    const ledger = rankingContributorLedger("graph-target", "stash//knowledge/graph-target");
    expect(ledger).toEqual([
      { name: "exact-name-ranking", contribution: 2 },
      { name: "type-ranking", contribution: 0.22 },
      { name: "search-hint-ranking", contribution: 0.12 },
      { name: "alias-ranking", contribution: 0.3 },
      { name: "description-ranking", contribution: 0.25 },
      { name: "metadata-ranking", contribution: 0.095 },
      { name: "graph-ranking", contribution: 0.75 },
    ]);

    const graphIndex = ledger.findIndex(({ name }) => name === "graph-ranking");
    const preGraphBoost = ledger.slice(0, graphIndex).reduce((sum, contributor) => sum + contributor.contribution, 0);
    const rawGraphBoost = ledger[graphIndex]?.contribution ?? 0;
    const boostCap = 3;
    const expectedAppliedGraphBoost =
      Math.min(boostCap, preGraphBoost + rawGraphBoost) - Math.min(boostCap, preGraphBoost);

    // The central lexical planner tokenizes `graph-target` as `graph` +
    // `target`, so alias and multi-token description evidence now consumes
    // 2.985 of the common 3.0 cap before graph ranking runs. Attribution must
    // record only the 0.015 share scoring actually admits, not its raw 0.75.
    expect(preGraphBoost).toBeCloseTo(2.985, 6);
    expect(expectedAppliedGraphBoost).toBeCloseTo(0.015, 6);
    expect(graph.downstreamAttribution?.graphExtraction?.boost).toBeCloseTo(expectedAppliedGraphBoost, 6);
  });

  test("brief search output does not attribute stripped derived surface content", async () => {
    clearUsageRows();
    const result = await runCliCapture(["search", "surface-parent-needle", "--detail", "brief", "--format", "json"]);
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as { hits: Array<Record<string, unknown>> };
    expect(output.hits.find((hit) => hit.name === "parent")?.description).toBeUndefined();
    expect(metadataFor("surface-parent-needle", "stash//memories/parent")).toEqual({
      downstreamAttribution: { version: 1, control: true },
    });
  });

  test("remember --show-similar does not attribute MI surface content omitted from its ref/title projection", async () => {
    clearUsageRows();
    const result = await runCliCapture([
      "remember",
      "surface-parent-needle",
      "--name",
      "remember-projection",
      "--show-similar",
      "--format",
      "json",
    ]);
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as { similar?: Array<Record<string, unknown>> };
    const parent = output.similar?.find((item) => item.title === "parent");
    expect(parent).toEqual({ ref: "memories/parent", title: "parent" });
    expect(metadataFor("surface-parent-needle", "stash//memories/parent")).toEqual({
      downstreamAttribution: { version: 1, control: true },
    });
  });

  test("source-qualifies indexed children and preserves duplicate concepts in each bundle", async () => {
    const index = openExistingDatabase(getDbPath());
    const indexedRefs = (
      index.prepare("SELECT item_ref FROM entries WHERE item_ref IS NOT NULL ORDER BY item_ref").all() as Array<{
        item_ref: string;
      }>
    ).map((row) => row.item_ref);
    index.close();
    expect(indexedRefs).toContain("stash//memories/parent");
    expect(indexedRefs).toContain("team//memories/parent");
    expect(indexedRefs).toContain("team//memories/parent.derived");
    expect(indexedRefs).toContain("team//memories/team-only");
    expect(indexedRefs).toContain("team//memories/team-only.derived");
    const result = await akmSearch({ query: "team surface needle", source: "team", limit: 10 });
    const teamHit = result.hits.find((hit) => hit.type !== "registry" && hit.name === "team-only" && "ref" in hit);
    expect(teamHit && "ref" in teamHit ? teamHit.ref : undefined).toBe("team//memories/team-only");
    expect(
      usageRows()
        .filter((row) => row.query === "team surface needle")
        .map((row) => row.entry_ref),
    ).toContain("team//memories/team-only");

    expect(metadataFor("team surface needle", "team//memories/team-only")).toEqual({
      downstreamAttribution: {
        version: 1,
        control: false,
        memoryInference: { exposure: "surface", childRef: "team//memories/team-only.derived" },
      },
    });
    const shown = await akmShowUnified({ ref: "team//memories/team-only.derived", skipLogging: true });
    expect(shown.origin).toBe("team");
    expect(shown.path).toBe(path.join(teamDir, "memories", "team-only.derived.md"));
  });

  test("direct show attributes an inferred child", async () => {
    await akmShowUnified({ ref: "stash//memories/parent.derived" });
    const row = usageRows().find(
      (candidate) => candidate.event_type === "show" && candidate.entry_ref === "stash//memories/parent.derived",
    );

    expect(row?.metadata ? JSON.parse(row.metadata) : undefined).toEqual({
      downstreamAttribution: {
        version: 1,
        control: false,
        memoryInference: { exposure: "direct", childRef: "stash//memories/parent.derived" },
      },
    });
  });

  test("final curate selection retains attribution and audit source without a nested show row", async () => {
    const searchResponse = await akmSearch({
      query: "graphneedle",
      limit: 10,
      skipLogging: true,
      eventSource: "audit",
    });
    await akmCurate({ query: "graphneedle", limit: 1, searchResponse, eventSource: "audit" });

    const rows = usageRows();
    const selected = rows.filter((row) => row.event_type === "curate" && row.entry_ref !== null);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.source).toBe("audit");
    expect(selected[0]?.metadata ? JSON.parse(selected[0].metadata) : undefined).toMatchObject({
      downstreamAttribution: {
        graphExtraction: { bodyHash: "graph-body-hash", extractionRunId: "graph-run-1" },
      },
    });
    expect(rows.filter((row) => row.event_type === "show")).toHaveLength(0);
    expect(rows.filter((row) => row.source === "user")).toHaveLength(0);
  });

  test("curate drops MI surface attribution when an internal path replaces the derived description", async () => {
    const searchResponse = await akmSearch({ query: "surface-parent-needle", limit: 10, skipLogging: true });
    const parentHit = searchResponse.hits.find((hit) => hit.type === "memory" && hit.name === "parent");
    expect(parentHit?.description).toBe("direct-child-needle");
    if (parentHit) parentHit.description = "internal replacement";

    const curated = await akmCurate({ query: "surface-parent-needle", limit: 1, searchResponse });
    expect(curated.items[0]?.description).toBe("internal replacement");
    const row = usageRows().find((candidate) => candidate.event_type === "curate" && candidate.entry_ref !== null);
    expect(row?.metadata ? JSON.parse(row.metadata) : undefined).toEqual({
      downstreamAttribution: { version: 1, control: true },
    });
  });
});
