// Opens a real index.db to verify atomic parent + fragment FTS publication.
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fragmentForSelector, splitMarkdownFragments } from "../../../src/core/asset/markdown-fragments";
import { stableFtsScore } from "../../../src/core/lexical-score";
import { deriveEntryProvenance } from "../../../src/indexer/installations";
import {
  type IndexDocument,
  projectMarkdownFragmentContent,
  setMarkdownFragmentContent,
} from "../../../src/indexer/passes/metadata";
import { buildSearchText } from "../../../src/indexer/search/search-fields";
import type { Database } from "../../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import { searchFts } from "../../../src/storage/repositories/index-fts-repository";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function open(): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-fragment-"));
  dirs.push(dir);
  return openIndexDatabase(path.join(dir, "index.db"));
}

function put(db: Database, name: string, body: string, description = "ordinary metadata"): void {
  const entry: IndexDocument = { name, type: "knowledge", description, content: body.replace(/[#\n]/g, " ") };
  setMarkdownFragmentContent(entry, projectMarkdownFragmentContent(body));
  upsertEntry(
    db,
    `/fixture/knowledge/${name}.md`,
    entry,
    buildSearchText(entry),
    deriveEntryProvenance({ bundleId: "fixture", componentId: "fixture", adapterId: "akm" }, "knowledge", name),
  );
}

describe("isolated lexical Markdown fragments (#937)", () => {
  test("returns a selector only for an independently matching fragment and round-trips it", () => {
    const db = open();
    try {
      const body = [
        "# Intro",
        "",
        Array.from({ length: 500 }, () => "ordinary background prose").join(" "),
        "",
        "# Evidence",
        "",
        "rarefragmenttoken carries proof",
      ].join("\n");
      put(db, "note", body);
      const hit = searchFts(db, "rarefragmenttoken", 5)[0];
      expect(hit?.fragmentId).toMatch(/^akm-fragment-/);
      const safe = projectMarkdownFragmentContent(body)!;
      expect(fragmentForSelector(safe, hit!.fragmentId!)?.text).toContain("rarefragmenttoken");
    } finally {
      closeDatabase(db);
    }
  });

  test("calibrates separate parent and fragment BM25 populations before merging", () => {
    const db = open();
    try {
      put(
        db,
        "buried",
        `${Array.from({ length: 1200 }, () => "background prose").join(" ")}\n\nrarecalibrationtoken proof`,
      );
      const parent = db
        .prepare("SELECT bm25(entries_fts, 0, 10, 5, 3, 2, 1) AS score FROM entries_fts WHERE entries_fts MATCH ?")
        .get("rarecalibrationtoken") as { score: number };
      const fragment = db
        .prepare("SELECT bm25(entry_fragments_fts) AS score FROM entry_fragments_fts WHERE entry_fragments_fts MATCH ?")
        .get("rarecalibrationtoken") as { score: number };
      // These are two FTS corpora, so raw magnitudes are evidence only, not a
      // shared ordering. The fixed population-aware mapping is what the merge
      // consumes; a short decisive fragment beats its length-penalized parent.
      expect(parent.score).toBeLessThan(0);
      expect(fragment.score).toBeLessThan(0);
      expect(stableFtsScore(fragment.score, "fragment")).toBeGreaterThan(stableFtsScore(parent.score, "parent"));
      expect(searchFts(db, "rarecalibrationtoken", 5)[0]?.fragmentId).toMatch(/^akm-fragment-/);
    } finally {
      closeDatabase(db);
    }
  });

  test("keeps metadata + later-body conjunction on the parent and metadata-only hits selector-free", () => {
    const db = open();
    try {
      const body = ["# First", "alpha only", "", "# Later", "bodyonlymarker later"].join("\n");
      put(db, "note", body, "metadatamarker description");
      expect(searchFts(db, "metadatamarker", 5)[0]?.fragmentId).toBeUndefined();
      // No one fragment holds both terms, so the established parent FTS row is
      // responsible for the conjunction and no misleading selector is emitted.
      expect(searchFts(db, "metadatamarker bodyonlymarker", 5)[0]?.fragmentId).toBeUndefined();
    } finally {
      closeDatabase(db);
    }
  });

  test("scans past many matching fragments from one parent to fill distinct parents", () => {
    const db = open();
    try {
      put(db, "monopoly", Array.from({ length: 80 }, (_, i) => `needle monopoly paragraph ${i}\n\n`).join(""));
      put(db, "other-a", "needle other alpha");
      put(db, "other-b", "needle other beta");
      const names = searchFts(db, "needle", 3).map((hit) => hit.entry.name);
      expect(new Set(names).size).toBe(3);
      expect(names).toContain("other-a");
      expect(names).toContain("other-b");
    } finally {
      closeDatabase(db);
    }
  });

  test("replaces parent and fragment rows atomically on incremental update", () => {
    const db = open();
    try {
      put(db, "replace", "oldfragmentmarker");
      put(db, "replace", "newfragmentmarker");
      expect(searchFts(db, "oldfragmentmarker", 5)).toHaveLength(0);
      expect(searchFts(db, "newfragmentmarker", 5)[0]?.entry.name).toBe("replace");
    } finally {
      closeDatabase(db);
    }
  });
});

describe("Markdown fragment substrate", () => {
  test("preserves preamble/duplicate headings and real source lines while removing unsafe bytes", () => {
    const raw = [
      "---",
      "description: fixture",
      "---",
      "preamble evidence",
      "",
      "# Same",
      "first heading evidence",
      "",
      "# Same",
      "second heading evidence",
      "",
      "```text",
      "FENCED_SECRET",
      "```",
      "[private]: https://secret.invalid/token",
    ].join("\n");
    const safe = projectMarkdownFragmentContent(raw)!;
    const fragments = splitMarkdownFragments(safe);
    expect(fragments.map((fragment) => fragment.startLine)).toContain(4);
    expect(fragments.find((fragment) => fragment.text.includes("first heading"))?.headingSlug).toBe("same");
    expect(fragments.find((fragment) => fragment.text.includes("second heading"))?.headingSlug).toBe("same-1");
    expect(safe).not.toContain("FENCED_SECRET");
    expect(safe).not.toContain("secret.invalid");
  });

  test("uses paragraph then word windows for headingless oversized transcripts", () => {
    const raw = Array.from({ length: 300 }, (_, index) => `Transcript ${index} carries ordinary evidence.`).join(
      "\n\n",
    );
    const fragments = splitMarkdownFragments(projectMarkdownFragmentContent(raw)!);
    expect(fragments.length).toBeGreaterThan(2);
    expect(fragments.every((fragment) => fragment.fragmentId.startsWith("akm-fragment-"))).toBe(true);
    expect(fragments.some((fragment) => fragment.text.includes("Transcript 150"))).toBe(true);
  });

  test("caps single-line word windows while retaining their source-line range", () => {
    const fragments = splitMarkdownFragments(`line ${"word ".repeat(1000)}`, 100);
    expect(fragments.length).toBeGreaterThan(2);
    expect(fragments.every((fragment) => fragment.text.length <= 100)).toBe(true);
    expect(fragments.every((fragment) => fragment.startLine === 1 && fragment.endLine === 1)).toBe(true);
  });
});
