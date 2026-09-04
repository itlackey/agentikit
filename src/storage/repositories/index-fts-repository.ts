// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `index.db` FTS5 search + materialization repository.
 *
 * Owns the `entries_fts` full-text query path, per-entry projections, and the
 * explicit full recovery rebuild.
 */

import { splitMarkdownFragments } from "../../core/asset/markdown-fragments";
import { stableFtsScore } from "../../core/lexical-score";
import { warn } from "../../core/warn";
import type { IndexDocument } from "../../indexer/passes/metadata";
import { buildLexicalQueryPlan, type LexicalQueryExecution } from "../../indexer/search/fts-query";
import { buildSearchFields } from "../../indexer/search/search-fields";
import type { Database, SqlValue } from "../database";
import type { DbSearchResult } from "./index-entry-types";
import { SQLITE_CHUNK_SIZE } from "./index-sql";

const INSERT_FTS_SQL =
  "INSERT INTO entries_fts (entry_id, name, description, tags, hints, content) VALUES (?, ?, ?, ?, ?, ?)";
const INSERT_FRAGMENT_SQL =
  "INSERT INTO entry_fragments_fts (entry_id, fragment_id, fragment_ordinal, content) VALUES (?, ?, ?, ?)";

interface FtsMutationStatements {
  deleteOne: ReturnType<Database["prepare"]>;
  insert: ReturnType<Database["prepare"]>;
  deleteFragments: ReturnType<Database["prepare"]>;
  upsertFragmentSource: ReturnType<Database["prepare"]>;
  deleteFragmentSource: ReturnType<Database["prepare"]>;
  insertFragment: ReturnType<Database["prepare"]>;
}

const ftsMutationStatementsByDb = new WeakMap<Database, FtsMutationStatements>();

function getFtsMutationStatements(db: Database): FtsMutationStatements {
  const existing = ftsMutationStatementsByDb.get(db);
  if (existing) return existing;
  const statements = {
    deleteOne: db.prepare("DELETE FROM entries_fts WHERE entry_id = ?"),
    insert: db.prepare(INSERT_FTS_SQL),
    deleteFragments: db.prepare("DELETE FROM entry_fragments_fts WHERE entry_id = ?"),
    upsertFragmentSource: db.prepare(
      "INSERT INTO entry_fragments (entry_id, safe_markdown) VALUES (?, ?) ON CONFLICT(entry_id) DO UPDATE SET safe_markdown = excluded.safe_markdown",
    ),
    deleteFragmentSource: db.prepare("DELETE FROM entry_fragments WHERE entry_id = ?"),
    insertFragment: db.prepare(INSERT_FRAGMENT_SQL),
  };
  ftsMutationStatementsByDb.set(db, statements);
  return statements;
}

/** Replace one entry's derived FTS projection inside the caller's transaction. */
export function replaceFtsEntry(
  db: Database,
  entryId: number,
  entry: IndexDocument,
  fragmentContent?: string | null,
): void {
  const fields = buildSearchFields(entry);
  const statements = getFtsMutationStatements(db);
  statements.deleteOne.run(entryId);
  statements.insert.run(entryId, fields.name, fields.description, fields.tags, fields.hints, fields.content);
  if (fragmentContent === undefined) {
    // Metadata-only re-upserts and re-keys deserialize the public document
    // without the internal substrate. Leave the persisted source untouched.
    // A scan that did read Markdown always supplies a value below.
    return;
  }
  statements.deleteFragments.run(entryId);
  statements.deleteFragmentSource.run(entryId);
  if (!fragmentContent) return;
  statements.upsertFragmentSource.run(entryId, fragmentContent);
  for (const fragment of splitMarkdownFragments(fragmentContent)) {
    statements.insertFragment.run(entryId, fragment.fragmentId, fragment.ordinal, fragment.text.toLowerCase());
  }
}

/** Delete derived FTS projections for canonical entries that are being removed. */
export function deleteFtsEntries(db: Database, entryIds: readonly number[]): void {
  for (let i = 0; i < entryIds.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = entryIds.slice(i, i + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    db.prepare(`DELETE FROM entries_fts WHERE entry_id IN (${placeholders})`).run(...chunk);
    db.prepare(`DELETE FROM entry_fragments_fts WHERE entry_id IN (${placeholders})`).run(...chunk);
    db.prepare(`DELETE FROM entry_fragments WHERE entry_id IN (${placeholders})`).run(...chunk);
  }
}

export function searchFts(
  db: Database,
  query: string,
  limit: number,
  entryType?: string,
  excludeTypes?: string[],
): DbSearchResult[] {
  const plan = buildLexicalQueryPlan(query);
  if (!plan.exact) return [];

  // Try the exact AND query first
  const exactResults = runFtsQuery(db, plan.exact, "exact", limit, entryType, excludeTypes);
  if (exactResults.length > 0) return exactResults;

  if (plan.exactPrefix) {
    const prefixResults = runFtsQuery(db, plan.exactPrefix, "prefix", limit, entryType, excludeTypes);
    if (prefixResults.length > 0) return prefixResults;
  }

  // One measured relaxation only after both conjunctive forms miss. This is
  // still the same FTS table, BM25 weights, candidate collection, and
  // downstream ranker — merely an OR candidate query for sentence-shaped
  // input whose filler terms prevented a strict hit.
  return plan.relaxed ? runFtsQuery(db, plan.relaxed, "relaxed", limit, entryType, excludeTypes) : [];
}

function runFtsQuery(
  db: Database,
  ftsQuery: string,
  lexicalMatch: LexicalQueryExecution,
  limit: number,
  entryType?: string,
  excludeTypes?: string[],
): DbSearchResult[] {
  // #627 — exclude-type clause. Only applies on the untyped ('any') path; an
  // explicit include filter (entryType) already narrows to a single type, so
  // exclusion is redundant there. An empty list skips the clause entirely
  // (never emit `NOT IN ()`, which is a SQL error / always-false).
  const excludes = excludeTypes && excludeTypes.length > 0 ? excludeTypes : [];

  // The typed and untyped paths differ only by one `type` WHERE clause
  // equality vs. an optional NOT IN exclusion) and their param order — the
  // SELECT/JOIN/ORDER/LIMIT is shared, so build it once. Join on integer
  // entry_id directly (no CAST; we store integer). bm25() per-column weights:
  // entry_id(0), name(10), description(5), tags(3), hints(2), content(1).
  let filterClause: string;
  let params: unknown[];
  if (entryType && entryType !== "any") {
    filterClause = "AND e.type = ?";
    params = [ftsQuery, entryType, limit];
  } else {
    filterClause = excludes.length > 0 ? `AND e.type NOT IN (${excludes.map(() => "?").join(", ")})` : "";
    // Param order: MATCH, then the NOT IN values, then LIMIT.
    params = [ftsQuery, ...excludes, limit];
  }

  const sql = `
    SELECT e.id, e.file_path AS filePath, e.document_json AS documentJson, e.search_text AS searchText,
           e.item_ref AS itemRef, e.bundle_id AS bundleId, e.concept_id AS conceptId, e.adapter_id AS adapterId,
           bm25(entries_fts, 0, 10.0, 5.0, 3.0, 2.0, 1.0) AS bm25Score
    FROM entries_fts f
    JOIN entries e ON e.id = f.entry_id
    WHERE entries_fts MATCH ?
      ${filterClause}
    ORDER BY bm25Score, e.id ASC
    LIMIT ?
  `;

  const rows = db.prepare(sql).all(...(params as SqlValue[])) as Array<{
    id: number;
    filePath: string;
    documentJson: string;
    searchText: string;
    itemRef: string;
    bundleId: string;
    conceptId: string;
    adapterId: string;
    bm25Score: number;
  }>;

  const results = materializeRows(rows, lexicalMatch);
  // Fragments are a separate, intentionally calibrated evidence population:
  // parent FTS remains the sole implementation of metadata/body conjunction.
  // A selector is emitted only for one fragment that independently satisfies
  // this query. Raw BM25 values are never claimed comparable across tables;
  // each is passed through #933's stable mapping before merge.
  const fragmentResults = hasFragmentFts(db)
    ? runFragmentQuery(db, ftsQuery, lexicalMatch, limit, entryType, excludes)
    : [];
  return mergeParentAndFragmentResults(results, fragmentResults, limit);
}

function hasFragmentFts(db: Database): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entry_fragments_fts'").get());
}

function materializeRows(
  rows: Array<{
    id: number;
    filePath: string;
    documentJson: string;
    searchText: string;
    itemRef: string;
    bundleId: string;
    conceptId: string;
    adapterId: string;
    bm25Score: number;
  }>,
  lexicalMatch: LexicalQueryExecution,
): DbSearchResult[] {
  const results: DbSearchResult[] = [];
  for (const row of rows) {
    let entry: IndexDocument;
    try {
      entry = JSON.parse(row.documentJson) as IndexDocument;
    } catch {
      warn(`[db] searchFts: skipping entry id=${row.id} — corrupt document_json`);
      continue;
    }
    results.push({
      id: row.id,
      filePath: row.filePath,
      entry,
      searchText: row.searchText,
      bm25Score: row.bm25Score,
      itemRef: row.itemRef,
      bundleId: row.bundleId,
      conceptId: row.conceptId,
      adapterId: row.adapterId,
      lexicalMatch,
    });
  }
  return results;
}

function runFragmentQuery(
  db: Database,
  ftsQuery: string,
  lexicalMatch: LexicalQueryExecution,
  limit: number,
  entryType: string | undefined,
  excludes: string[],
): DbSearchResult[] {
  const filter =
    entryType && entryType !== "any"
      ? "AND e.type = ?"
      : excludes.length
        ? `AND e.type NOT IN (${excludes.map(() => "?").join(",")})`
        : "";
  const filterParams = entryType && entryType !== "any" ? [entryType] : excludes;
  const batchSize = Math.max(32, limit * 4);
  const winners = new Map<number, DbSearchResult>();
  // This is deliberately an adaptive scan, not `LIMIT limit` fragment rows.
  // It stops only once K parents are found or FTS has no further rows, so a
  // long document cannot permanently monopolize a parent result page.
  for (let offset = 0; ; offset += batchSize) {
    const sql = `
      SELECT e.id, e.file_path AS filePath, e.document_json AS documentJson, e.search_text AS searchText,
             e.item_ref AS itemRef, e.bundle_id AS bundleId, e.concept_id AS conceptId, e.adapter_id AS adapterId,
             f.fragment_id AS fragmentId, bm25(entry_fragments_fts) AS bm25Score
      FROM entry_fragments_fts f JOIN entries e ON e.id = f.entry_id
      WHERE entry_fragments_fts MATCH ? ${filter}
      ORDER BY bm25Score ASC, e.id ASC, f.fragment_ordinal ASC
      LIMIT ? OFFSET ?`;
    const rows = db.prepare(sql).all(ftsQuery, ...filterParams, batchSize, offset) as Array<{
      id: number;
      filePath: string;
      documentJson: string;
      searchText: string;
      itemRef: string;
      bundleId: string;
      conceptId: string;
      adapterId: string;
      fragmentId: string;
      bm25Score: number;
    }>;
    for (const row of rows) {
      if (winners.has(row.id)) continue;
      const [result] = materializeRows([row], lexicalMatch);
      if (result)
        winners.set(row.id, {
          ...result,
          fragmentId: row.fragmentId,
          lexicalScore: stableFtsScore(row.bm25Score, "fragment"),
        });
      if (winners.size >= limit) break;
    }
    if (winners.size >= limit || rows.length < batchSize) break;
  }
  return [...winners.values()];
}

function mergeParentAndFragmentResults(
  parents: DbSearchResult[],
  fragments: DbSearchResult[],
  limit: number,
): DbSearchResult[] {
  const winners = new Map<number, DbSearchResult>();
  for (const parent of parents) winners.set(parent.id, { ...parent, lexicalScore: stableFtsScore(parent.bm25Score) });
  for (const fragment of fragments) {
    const existing = winners.get(fragment.id);
    if (!existing || (fragment.lexicalScore ?? 0) > (existing.lexicalScore ?? 0)) winners.set(fragment.id, fragment);
  }
  return [...winners.values()]
    .sort((left, right) => (right.lexicalScore ?? 0) - (left.lexicalScore ?? 0) || left.id - right.id)
    .slice(0, limit);
}

/**
 * Explicitly rebuild the complete FTS5 projection from canonical entries.
 * Ordinary entry mutations do not call this: `upsertEntry` and the delete
 * operations publish their FTS state in the same transaction as `entries`.
 * This remains a recovery/schema-verification primitive for regenerable
 * `index.db` state.
 *
 * Skipped corrupt-JSON rows are aggregated into one warning instead of
 * spamming stderr per-entry.
 */
export function rebuildFts(db: Database): void {
  db.transaction(() => {
    db.exec("DELETE FROM entries_fts");
    db.exec("DELETE FROM entry_fragments_fts");
    const rows = db
      .prepare(
        "SELECT e.id, e.document_json, f.safe_markdown FROM entries e LEFT JOIN entry_fragments f ON f.entry_id = e.id",
      )
      .all() as Array<{
      id: number;
      document_json: string;
      safe_markdown: string | null;
    }>;
    const insertStmt = db.prepare(INSERT_FTS_SQL);
    const fragmentStmt = db.prepare(INSERT_FRAGMENT_SQL);

    let skipped = 0;
    for (const row of rows) {
      let entry: IndexDocument;
      let fields: ReturnType<typeof buildSearchFields>;
      try {
        entry = JSON.parse(row.document_json) as IndexDocument;
        fields = buildSearchFields(entry);
      } catch {
        skipped++;
        continue;
      }
      insertStmt.run(row.id, fields.name, fields.description, fields.tags, fields.hints, fields.content);
      if (row.safe_markdown) {
        for (const fragment of splitMarkdownFragments(row.safe_markdown)) {
          fragmentStmt.run(row.id, fragment.fragmentId, fragment.ordinal, fragment.text.toLowerCase());
        }
      }
    }

    if (skipped > 0) {
      warn(`[db] rebuildFts: skipped ${skipped} entr${skipped === 1 ? "y" : "ies"} with invalid document_json`);
    }
  })();
}
