import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmLint } from "../../src/commands/lint";
import { akmProposalAccept } from "../../src/commands/proposal/proposal";
import { createProposal, isProposalSkipped } from "../../src/commands/proposal/repository";
import { writeMarkdownAsset } from "../../src/commands/read/knowledge";
import { akmSearch } from "../../src/commands/read/search";
import { showLocal } from "../../src/commands/read/show";
import { loadConfig, resetConfigCache } from "../../src/core/config/config";
import { getDbPath } from "../../src/core/paths";
import { akmIndex } from "../../src/indexer/indexer";
import { resolveSourceEntries } from "../../src/indexer/search/search-source";
import { closeDatabase, openExistingDatabase } from "../../src/storage/repositories/index-connection";
import { type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

function write(root: string, rel: string, content: string): void {
  const destination = path.join(root, rel);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content, "utf8");
}

function concept(type: string, title: string, body: string): string {
  return `---\ntype: ${type}\ntitle: ${title}\n---\n\n${body}\n`;
}

describe("OKF first-class conformance", () => {
  let storage: IsolatedAkmStorage;
  let okfRoot: string;
  let noIndexRoot: string;

  function configure(adversarialAdapter: "akm" | "okf"): void {
    writeSandboxConfig({
      semanticSearchMode: "off",
      defaultBundle: "local",
      bundles: {
        local: {
          path: storage.stashDir,
          writable: true,
          components: { main: { root: ".", adapter: "akm", writable: true } },
        },
        adversarial: {
          path: okfRoot,
          writable: true,
          components: { main: { root: ".", adapter: adversarialAdapter, writable: true } },
        },
        noindex: { path: noIndexRoot, writable: false },
      },
    });
  }

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    okfRoot = path.join(storage.root, "okf-adversarial");
    noIndexRoot = path.join(storage.root, "okf-no-index");

    write(okfRoot, "index.md", "---\nokf_version: 9.9\n---\n\n# Adversarial bundle\n");
    write(okfRoot, "log.md", "# Update Log\n");
    write(okfRoot, "sub/index.md", "# Subdirectory\n");
    write(okfRoot, "duplicate-a.md", concept("Vendor Duplicate", "Same Title", "First concept."));
    write(okfRoot, "sub/duplicate-b.md", concept("Vendor Duplicate", "Same Title", "Second concept."));
    write(okfRoot, ".hidden/hidden.md", concept("Hidden Concept", "Hidden Concept", "Hidden body."));
    write(okfRoot, "bin/bin-doc.md", concept("Bin Concept", "Bin Concept", "Bin body."));
    write(
      okfRoot,
      "unknown.md",
      `${concept(
        "Some Vendor Thing",
        "Vendor Item",
        "# Overview\n\nOverview body.\n\n## Details and Usage\n\nFragment body.\n\n[Root](/target.md)\n[Relative](./relative.md)\n[Dangling](/missing.md)\n[Reference style][vendor-reference]",
      ).replace(
        "title: Vendor Item\n",
        "title: Vendor Item\naliases: [opaque-alias]\nsearchHints: [opaque-hint]\nusage: [opaque-usage]\n",
      )}\n[vendor-reference]: /ref-target.md\n`,
    );
    write(okfRoot, "target.md", concept("Known", "Root Target", "Target body."));
    write(okfRoot, "relative.md", concept("Known", "Relative Target", "Relative body."));
    write(okfRoot, "ref-target.md", concept("Known", "Reference Target", "Reference target body."));

    write(noIndexRoot, "vendor.md", concept("Some Vendor Thing", "No Index Vendor", "No-index marker."));

    configure("okf");
  });

  afterEach(() => storage.cleanup());

  test("preserves every path identity, open type, normalized field, and generic show behavior", async () => {
    const sources = resolveSourceEntries();
    expect(sources.find((source) => source.registryId === "adversarial")?.adapterId).toBe("okf");
    expect(sources.find((source) => source.registryId === "noindex")?.adapterId).toBeUndefined();

    await akmIndex({ stashDir: storage.stashDir, full: true });

    expect(resolveSourceEntries().find((source) => source.registryId === "noindex")?.adapterId).toBe("okf");
    expect(loadConfig().bundles?.noindex?.components?.main?.adapter).toBe("okf");

    const db = openExistingDatabase(getDbPath());
    try {
      const rows = db
        .prepare(
          "SELECT item_ref AS itemRef, entry_type AS type, adapter_id AS adapterId, entry_json AS entryJson " +
            "FROM entries WHERE bundle_id = 'adversarial' ORDER BY item_ref",
        )
        .all() as Array<{ itemRef: string; type: string; adapterId: string; entryJson: string }>;
      expect(rows.map((row) => row.itemRef)).toEqual([
        "adversarial//.hidden/hidden",
        "adversarial//bin/bin-doc",
        "adversarial//duplicate-a",
        "adversarial//ref-target",
        "adversarial//relative",
        "adversarial//sub/duplicate-b",
        "adversarial//target",
        "adversarial//unknown",
      ]);
      expect(rows.every((row) => row.adapterId === "okf")).toBe(true);
      expect(rows.filter((row) => row.type === "Vendor Duplicate")).toHaveLength(2);
      expect(rows.find((row) => row.itemRef.endsWith("//unknown"))?.type).toBe("Some Vendor Thing");

      const unknown = JSON.parse(rows.find((row) => row.itemRef.endsWith("//unknown"))!.entryJson) as {
        content?: string;
        links?: string[];
        aliases?: string[];
        searchHints?: string[];
        usage?: string[];
        documentJson?: Record<string, unknown>;
      };
      expect(unknown.content).toContain("Fragment body.");
      expect(unknown.links).toEqual(["target", "relative", "missing", "ref-target"]);
      expect(unknown.aliases).toBeUndefined();
      expect(unknown.searchHints).toBeUndefined();
      expect(unknown.usage).toBeUndefined();
      expect(unknown.documentJson).toMatchObject({
        aliases: ["opaque-alias"],
        searchHints: ["opaque-hint"],
        usage: ["opaque-usage"],
      });

      const noIndex = db
        .prepare(
          "SELECT item_ref AS itemRef, entry_type AS type, adapter_id AS adapterId FROM entries WHERE bundle_id = ?",
        )
        .get("noindex") as { itemRef: string; type: string; adapterId: string };
      expect(noIndex).toEqual({
        itemRef: "noindex//vendor",
        type: "Some Vendor Thing",
        adapterId: "okf",
      });
    } finally {
      closeDatabase(db);
    }

    const shown = await showLocal({ ref: "adversarial//unknown" });
    expect(shown).toMatchObject({
      ref: "adversarial//unknown",
      type: "Some Vendor Thing",
      name: "Vendor Item",
    });
    expect(shown.content).toContain("Overview body.");
    expect(shown.content).not.toContain("type: Some Vendor Thing");

    const search = await akmSearch({ query: "Fragment body", skipLogging: true });
    const hit = search.hits.find(
      (candidate) => "path" in candidate && candidate.path === path.join(okfRoot, "unknown.md"),
    );
    expect(hit && "ref" in hit ? hit.ref : undefined).toBe("adversarial//unknown");

    const fragment = await showLocal({ ref: "adversarial//unknown#details-and-usage" });
    expect(fragment.content).toContain("## Details and Usage");
    expect(fragment.content).toContain("Fragment body.");
    expect(fragment.content).not.toContain("Overview body.");
    expect(fragment.ref).toBe("adversarial//unknown");

    const lint = akmLint({ dir: okfRoot });
    expect(lint.ok).toBe(true);
    expect(lint.flagged).toEqual([]);

    await expect(
      writeMarkdownAsset({
        type: "memory",
        content: "A correction.",
        name: "correction",
        fallbackPrefix: "memory",
        target: "adversarial",
      }),
    ).rejects.toThrow(/adapter "okf".*does not support AKM asset writes/i);
    expect(fs.existsSync(path.join(okfRoot, "memories", "correction.md"))).toBe(false);

    const proposal = createProposal(storage.stashDir, {
      ref: "lessons/blocked-proposal",
      target: { source: "adversarial", root: okfRoot },
      source: "propose",
      force: true,
      payload: {
        content:
          "---\ndescription: Proposal content must not publish\nwhen_to_use: Testing consumer-only OKF writes\n---\n\nBlocked.\n",
      },
    });
    if (isProposalSkipped(proposal)) throw new Error("unexpected proposal skip");
    await expect(
      akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, target: "adversarial" }),
    ).rejects.toThrow(/adapter "okf".*does not support AKM asset writes/i);
    expect(fs.existsSync(path.join(okfRoot, "lessons", "blocked-proposal.md"))).toBe(false);

    const native = await writeMarkdownAsset({
      type: "memory",
      content: "# Native memory\n\nNative body.",
      name: "native-memory",
      fallbackPrefix: "memory",
      target: "local",
    });
    expect(parseType(native.path)).toBe("memory");

    await expect(
      writeMarkdownAsset({
        type: "memory",
        content: "Reserved.",
        name: "index",
        fallbackPrefix: "memory",
        target: "local",
      }),
    ).rejects.toThrow(/reserved concept name/i);
    expect(fs.existsSync(path.join(storage.stashDir, "memories", "index.md"))).toBe(false);
  });

  test("an adapter change invalidates incremental freshness and rekeys the durable row", async () => {
    write(okfRoot, "knowledge/switch.md", concept("knowledge", "Switch", "Adapter switch body."));
    configure("akm");
    resetConfigCache();

    await akmIndex({ stashDir: storage.stashDir, full: true });

    const readSwitchRow = () => {
      const db = openExistingDatabase(getDbPath());
      try {
        return db
          .prepare(
            "SELECT entry_key AS entryKey, adapter_id AS adapterId FROM entries " +
              "WHERE item_ref = 'adversarial//knowledge/switch' ORDER BY id",
          )
          .all() as Array<{ entryKey: string; adapterId: string }>;
      } finally {
        closeDatabase(db);
      }
    };

    expect(readSwitchRow()).toEqual([{ entryKey: `${okfRoot}:knowledge:switch`, adapterId: "akm" }]);

    configure("okf");
    resetConfigCache();
    const result = await akmIndex({ stashDir: storage.stashDir });

    expect(result.mode).toBe("incremental");
    expect(readSwitchRow()).toEqual([{ entryKey: `${okfRoot}:concept:knowledge/switch`, adapterId: "okf" }]);
  });

  test("OKF lint uses its own diagnostic and keeps findings non-fatal by default", () => {
    write(okfRoot, "missing-type.md", "---\ntitle: Missing Type\n---\n\nBody.\n");

    const result = akmLint({ dir: okfRoot });

    expect(result.ok).toBe(true);
    expect(result.flagged).toContainEqual({
      file: "missing-type.md",
      issue: "missing-type",
      detail: "OKF concepts require parseable mapping frontmatter with a non-empty type.",
      fixed: false,
    });
    expect(result.flagged.some((issue) => issue.issue === "missing-name-or-type")).toBe(false);
  });

  test("configured adapter ownership wins over filesystem probing during lint", () => {
    write(okfRoot, "knowledge/native.md", concept("knowledge", "Native", "Native body."));
    configure("akm");
    resetConfigCache();

    const result = akmLint({ dir: okfRoot });

    expect(result.flagged.some((issue) => issue.issue === "missing-updated")).toBe(true);
    expect(result.flagged.some((issue) => issue.issue === "missing-type")).toBe(false);
  });

  test("a nested default component root owns writes, indexing, show, and lint", async () => {
    const packageRoot = path.join(storage.root, "nested-package");
    const componentRoot = path.join(packageRoot, "catalog");
    fs.mkdirSync(componentRoot, { recursive: true });
    writeSandboxConfig({
      defaultBundle: "nested",
      bundles: {
        nested: {
          path: packageRoot,
          writable: true,
          components: { main: { root: "catalog", adapter: "akm", writable: true } },
        },
      },
    });

    await withEnv({ AKM_STASH_DIR: undefined }, async () => {
      resetConfigCache();
      const written = await writeMarkdownAsset({
        type: "memory",
        content: "---\nupdated: 2026-07-25\n---\n\nNested component body.",
        name: "nested-root",
        fallbackPrefix: "memory",
      });

      expect(written.path).toBe(path.join(componentRoot, "memories", "nested-root.md"));
      expect(written.stashDir).toBe(componentRoot);
      expect(fs.existsSync(path.join(packageRoot, "memories", "nested-root.md"))).toBe(false);
      expect(resolveSourceEntries()).toEqual([
        expect.objectContaining({ path: componentRoot, registryId: "nested", adapterId: "akm" }),
      ]);

      await akmIndex({ stashDir: componentRoot, full: true });
      const shown = await showLocal({ ref: "nested//memories/nested-root" });
      expect(shown.content).toContain("Nested component body.");
      expect(akmLint().flagged).toEqual([]);
    });
  });
});

function parseType(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, "utf8");
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  return match?.[1]?.match(/^type:\s*(.+)$/m)?.[1];
}
