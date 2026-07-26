import { describe, expect, test } from "bun:test";
import { _setWarnSinkForTests } from "../src/core/warn";
import { type EntryRow, rowToIndexedEntry } from "../src/storage/repositories/index-entry-mapper";

function row(overrides: Partial<EntryRow> = {}): EntryRow {
  return {
    id: 1,
    entry_key: "/stash:knowledge:guide",
    dir_path: "/stash/knowledge",
    file_path: "/stash/knowledge/guide.md",
    stash_dir: "/stash",
    entry_json: JSON.stringify({ type: "knowledge", name: "guide" }),
    search_text: "guide",
    item_ref: "team//knowledge/guide",
    bundle_id: "team",
    concept_id: "knowledge/guide",
    adapter_id: "akm",
    ...overrides,
  };
}

describe("rowToIndexedEntry provenance", () => {
  test("maps canonical durable provenance from the entries row", () => {
    expect(rowToIndexedEntry(row(), "test")).toMatchObject({
      itemRef: "team//knowledge/guide",
      bundleId: "team",
      conceptId: "knowledge/guide",
      adapterId: "akm",
    });
  });

  test("rejects rows without canonical provenance", () => {
    const warnings: string[] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    try {
      expect(
        rowToIndexedEntry(row({ item_ref: null, bundle_id: null, concept_id: null, adapter_id: null }), "test"),
      ).toBeNull();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("missing indexed provenance");
    } finally {
      _setWarnSinkForTests(undefined);
    }
  });
});
