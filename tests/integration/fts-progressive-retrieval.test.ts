import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveEntryProvenance } from "../../src/indexer/installations";
import type { IndexDocument } from "../../src/indexer/passes/metadata";
import { MARKDOWN_CONTENT_MAX_CHARS, projectMarkdownContent } from "../../src/indexer/passes/metadata";
import { recognizeStashEntries } from "../../src/indexer/scan/drain-dir";
import { buildLexicalQueryPlan } from "../../src/indexer/search/fts-query";
import { buildSearchText } from "../../src/indexer/search/search-fields";
import type { Database as AkmDatabase } from "../../src/storage/database";
import { upsertEntry } from "../../src/storage/repositories/index-entries-repository";
import { rebuildFts, searchFts } from "../../src/storage/repositories/index-fts-repository";

const createdDirs: string[] = [];

afterAll(() => {
  for (const dir of createdDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeDb(): AkmDatabase {
  const db = new Database(":memory:") as unknown as AkmDatabase;
  db.exec(`
    CREATE TABLE entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      item_ref TEXT NOT NULL UNIQUE,
      bundle_id TEXT NOT NULL,
      component_id TEXT NOT NULL,
      concept_id TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      document_json TEXT NOT NULL,
      search_text TEXT NOT NULL,
      content_hash TEXT,
      derived_from TEXT
    );
    CREATE VIRTUAL TABLE entries_fts USING fts5(
      entry_id UNINDEXED,
      name,
      description,
      tags,
      hints,
      content,
      tokenize='porter unicode61'
    );
    CREATE TABLE entries_fts_dirty (entry_id INTEGER PRIMARY KEY);
    CREATE TABLE vec_entries (entry_id INTEGER PRIMARY KEY, embedding BLOB);
  `);
  return db;
}

function insert(db: AkmDatabase, name: string, entry: IndexDocument): void {
  const conceptId = `knowledge/${name}`;
  upsertEntry(
    db,
    `/fixture/${conceptId}.md`,
    entry,
    buildSearchText(entry),
    deriveEntryProvenance({ bundleId: "fixture", componentId: "fixture", adapterId: "akm" }, entry.type, conceptId),
  );
}

describe("progressive lexical query planning (#819)", () => {
  test("normalizes Unicode tokens, deduplicates them, quotes operators, and caps work", () => {
    const repeated = Array.from({ length: 40 }, (_, index) => `token${index}`).join(" ");
    const plan = buildLexicalQueryPlan(`CAFÉ café NEAR or ${repeated}`);

    expect(plan.tokens.slice(0, 4)).toEqual(["CAFÉ", "NEAR", "or", "token0"]);
    expect(plan.tokens).toHaveLength(16);
    expect(plan.exact).toStartWith('"CAFÉ" "NEAR" "or" "token0"');
    expect(plan.relaxed).toContain('"NEAR"*');
  });

  test("uses one strict → prefix → relaxed pipeline without changing strict top-1", () => {
    const db = makeDb();
    try {
      insert(db, "identifier", {
        type: "knowledge",
        name: "cache-pruner",
        description: "Removes expired build artifacts",
      });
      insert(db, "prefix", {
        type: "knowledge",
        name: "kubernetes-configurator",
        description: "Cluster deployment reference",
      });
      insert(db, "unicode", {
        type: "knowledge",
        name: "café-déploiement",
        description: "Orchestration naïve à Montréal",
      });
      insert(db, "structured", {
        type: "knowledge",
        name: "spectral-quokka-rotation",
        description: "Exact operator procedure",
      });
      insert(db, "body", {
        type: "knowledge",
        name: "field-notes",
        description: "Assorted operational observations",
        content: "The spectral quokka calibration nonce rotates every Thursday.",
      });
      rebuildFts(db);

      const cases = [
        { query: "cache-pruner", expected: "cache-pruner", execution: "exact" },
        { query: "kubernet configur", expected: "kubernetes-configurator", execution: "prefix" },
        { query: "CAFÉ déploiement", expected: "café-déploiement", execution: "exact" },
        {
          query: "how do I find the spectral quokka calibration nonce safely",
          expected: "field-notes",
          execution: "relaxed",
        },
      ] as const;

      for (const row of cases) {
        const results = searchFts(db, row.query, 10);
        expect(
          results.some((result) => result.entry.name === row.expected),
          row.query,
        ).toBe(true);
        expect(results[0]?.lexicalMatch, row.query).toBe(row.execution);
      }

      expect(searchFts(db, "spectral quokka rotation", 10)[0]?.entry.name).toBe("spectral-quokka-rotation");
      expect(() => searchFts(db, 'NEAR OR and " ( ) *** the the', 3)).not.toThrow();
      expect(searchFts(db, 'NEAR OR and " ( ) *** the the', 3).length).toBeLessThanOrEqual(3);
    } finally {
      db.close();
    }
  });
});

describe("native Markdown content projection (#819)", () => {
  test("keeps prose and inline identifiers but drops markup, URLs, comments, and fenced code", () => {
    const projection = projectMarkdownContent(`
# Rotation guide
<!-- internal crawler note -->
Read the [operator guide](https://example.test/private?q=token) before calling \`rotateKey()\`.

\`\`\`sh
export PRIVATE_TOKEN=never-index-this
\`\`\`

The spectral quokka calibration nonce rotates every Thursday.
`);

    expect(projection).toContain("Rotation guide");
    expect(projection).toContain("operator guide");
    expect(projection).toContain("rotateKey()");
    expect(projection).toContain("spectral quokka calibration nonce");
    expect(projection).not.toContain("example.test");
    expect(projection).not.toContain("PRIVATE_TOKEN");
    expect(projection).not.toContain("crawler note");
  });

  test("has one stable Unicode-safe size bound", () => {
    const projection = projectMarkdownContent(`${"word ".repeat(MARKDOWN_CONTENT_MAX_CHARS)}😀tail`);
    expect(projection).toBeDefined();
    if (projection === undefined) throw new Error("expected a body projection");
    expect(projection.length).toBeLessThanOrEqual(MARKDOWN_CONTENT_MAX_CHARS);
    expect(new TextDecoder().decode(new TextEncoder().encode(projection))).toBe(projection);
  });

  test("native Markdown uses content for safe assets and excludes secret/session material", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-fts-body-"));
    createdDirs.push(root);
    const knowledge = path.join(root, "knowledge", "rotation.md");
    const session = path.join(root, "sessions", "raw.md");
    const checkpoint = path.join(root, "memories", "checkpoint.md");
    fs.mkdirSync(path.dirname(knowledge), { recursive: true });
    fs.mkdirSync(path.dirname(session), { recursive: true });
    fs.mkdirSync(path.dirname(checkpoint), { recursive: true });
    fs.writeFileSync(
      knowledge,
      "---\ndescription: Operator notes\n---\n\nFirst paragraph.\n\nThe spectral quokka calibration nonce is VioletCrane47.\n",
    );
    fs.writeFileSync(session, "A raw transcript contains SESSION_PRIVATE_SENTINEL.\n");
    fs.writeFileSync(
      checkpoint,
      "---\ndescription: Session checkpoint\nakm_memory_kind: session_checkpoint\n---\n\nMEMORY_PRIVATE_SENTINEL\n",
    );

    const recognized = recognizeStashEntries(root, [knowledge, session, checkpoint]).entries;
    const knowledgeEntry = recognized.find((entry) => entry.type === "knowledge");
    const sessionEntry = recognized.find((entry) => entry.type === "session");
    const checkpointEntry = recognized.find((entry) => entry.name === "checkpoint");

    if (!knowledgeEntry || !sessionEntry || !checkpointEntry) throw new Error("expected all fixture entries");
    expect(knowledgeEntry?.content).toContain("spectral quokka calibration nonce");
    expect(buildSearchText(knowledgeEntry)).toContain("violetcrane47");
    expect(sessionEntry?.content).toBeUndefined();
    expect(buildSearchText(sessionEntry)).not.toContain("session_private_sentinel");
    expect(checkpointEntry?.content).toBeUndefined();
    expect(buildSearchText(checkpointEntry)).not.toContain("memory_private_sentinel");
  });
});
