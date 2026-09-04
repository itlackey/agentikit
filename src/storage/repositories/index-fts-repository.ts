// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `index.db` FTS5 search + materialization repository.
 *
 * Owns the `entries_fts` full-text query path, per-entry projections, and the
 * explicit full recovery rebuild.
 */

import { warn } from "../../core/warn";
import type { IndexDocument } from "../../indexer/passes/metadata";
import { buildLexicalQueryPlan, type LexicalQueryExecution } from "../../indexer/search/fts-query";
import { buildSearchFields } from "../../indexer/search/search-fields";
import type { Database, SqlValue } from "../database";
import type { DbSearchResult } from "./index-entry-types";
import { SQLITE_CHUNK_SIZE } from "./index-sql";

const INSERT_FTS_SQL =
  "INSERT INTO entries_fts (entry_id, name, description, tags, hints, content) VALUES (?, ?, ?, ?, ?, ?)";

interface FtsMutationStatements {
  deleteOne: ReturnType<Database["prepare"]>;
  insert: ReturnType<Database["prepare"]>;
}

const ftsMutationStatementsByDb = new WeakMap<Database, FtsMutationStatements>();

function getFtsMutationStatements(db: Database): FtsMutationStatements {
  const existing = ftsMutationStatementsByDb.get(db);
  if (existing) return existing;
  const statements = {
    deleteOne: db.prepare("DELETE FROM entries_fts WHERE entry_id = ?"),
    insert: db.prepare(INSERT_FTS_SQL),
  };
  ftsMutationStatementsByDb.set(db, statements);
  return statements;
}

/** Replace one entry's derived FTS projection inside the caller's transaction. */
export function replaceFtsEntry(db: Database, entryId: number, entry: IndexDocument): void {
  const fields = buildSearchFields(entry);
  const statements = getFtsMutationStatements(db);
  statements.deleteOne.run(entryId);
  statements.insert.run(entryId, fields.name, fields.description, fields.tags, fields.hints, fields.content);
}

/** Delete derived FTS projections for canonical entries that are being removed. */
export function deleteFtsEntries(db: Database, entryIds: readonly number[]): void {
  for (let i = 0; i < entryIds.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = entryIds.slice(i, i + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    db.prepare(`DELETE FROM entries_fts WHERE entry_id IN (${placeholders})`).run(...chunk);
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
  // Preserve the repository's ordinary limit contract for direct callers.
  // The boundary-expansion rule applies only to a positive candidate pool.
  if (limit <= 0) return [];

  // #627 — exclude-type clause. Only applies on the untyped ('any') path; an
  // explicit include filter (entryType) already narrows to a single type, so
  // exclusion is redundant there. An empty list skips the clause entirely
  // (never emit `NOT IN ()`, which is a SQL error / always-false).
  const excludes = excludeTypes && excludeTypes.length > 0 ? excludeTypes : [];
  const candidateBoundaryOffset = Math.max(0, limit - 1);

  // The typed and untyped paths differ only by one `type` WHERE clause
  // equality vs. an optional NOT IN exclusion) and their parameter order.
  // Join on integer entry_id directly (no CAST; we store integer). bm25()
  // per-column weights:
  // entry_id(0), name(10), description(5), tags(3), hints(2), content(1).
  let filterClause: string;
  let params: unknown[];
  if (entryType && entryType !== "any") {
    filterClause = "AND e.type = ?";
    params = [ftsQuery, entryType, candidateBoundaryOffset];
  } else {
    filterClause = excludes.length > 0 ? `AND e.type NOT IN (${excludes.map(() => "?").join(", ")})` : "";
    // Param order: MATCH, then the NOT IN values, then the zero-based
    // candidate-boundary offset.
    params = [ftsQuery, ...excludes, candidateBoundaryOffset];
  }

  const sql = `
    -- Do not make a SQL-only relevance decision inside a tied BM25 boundary:
    -- the TypeScript ranker adds exact-name, type, and other contributors
    -- afterwards.  Materialize BM25 once, locate the Nth score, and admit
    -- every row tied with it.  This deliberately makes the result set
    -- data-bound for a pathological all-tied query; that is the only way to
    -- avoid silently dropping a legitimate later ranking winner.
    WITH scored AS MATERIALIZED (
      -- Keep this materialized set deliberately narrow. document_json can be
      -- large, and only rows admitted through the BM25 boundary need it.
      SELECT e.id, bm25(entries_fts, 0, 10.0, 5.0, 3.0, 2.0, 1.0) AS bm25Score
    FROM entries_fts f
    JOIN entries e ON e.id = f.entry_id
    WHERE entries_fts MATCH ?
      ${filterClause}
    ), boundary AS (
      SELECT bm25Score
      FROM scored
      ORDER BY bm25Score
      LIMIT 1 OFFSET ?
    )
    SELECT e.id, e.file_path AS filePath, e.document_json AS documentJson, e.search_text AS searchText,
           e.item_ref AS itemRef, e.bundle_id AS bundleId, e.concept_id AS conceptId, e.adapter_id AS adapterId,
           scored.bm25Score
    FROM scored
    JOIN entries e ON e.id = scored.id
    WHERE NOT EXISTS (SELECT 1 FROM boundary)
       OR scored.bm25Score <= (SELECT bm25Score FROM boundary)
    ORDER BY scored.bm25Score, e.id ASC
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

  // Guard against corrupt JSON — skip the row rather than crashing
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
    const rows = db.prepare("SELECT id, document_json FROM entries").all() as Array<{
      id: number;
      document_json: string;
    }>;
    const insertStmt = db.prepare(INSERT_FTS_SQL);

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
    }

    if (skipped > 0) {
      warn(`[db] rebuildFts: skipped ${skipped} entr${skipped === 1 ? "y" : "ies"} with invalid document_json`);
    }
  })();
}
