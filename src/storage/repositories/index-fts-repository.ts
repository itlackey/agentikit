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

  // The tiers TOP UP a shared pool; they are not alternatives (#929).
  //
  // This used to return from whichever tier first produced a hit. A query
  // whose strict conjunctive form matched exactly one document therefore
  // yielded exactly that one document, and the looser tiers — which would
  // very often have supplied the rest — never ran. The caller could not tell:
  // results came back, they were relevant, and nothing indicated that better
  // candidates were never considered. Measured on LongMemEval, 23 of 200
  // queries returned a short result set that was NOT limit-bound, 22 of them
  // on questions needing more than one document.
  const exactResults = runFtsQuery(db, plan.exact, "exact", limit, entryType, excludeTypes);

  // Fast path, byte-identical to the old behaviour: a full exact tier needs no
  // top-up, so the looser queries never run and nothing is re-ordered.
  if (exactResults.length >= limit) return exactResults;

  const pool: DbSearchResult[] = [];
  const seenEntryIds = new Set<number>();
  const addTier = (tierResults: DbSearchResult[]): void => {
    for (const result of tierResults) {
      if (seenEntryIds.has(result.id)) continue;
      seenEntryIds.add(result.id);
      pool.push(result);
    }
  };

  addTier(exactResults);

  if (plan.exactPrefix) {
    addTier(runFtsQuery(db, plan.exactPrefix, "prefix", limit, entryType, excludeTypes));
  }

  // The relaxed OR pass plays two different roles, and conflating them is a
  // precision bug.
  //
  //  - As a FALLBACK (nothing matched conjunctively), any single-term hit
  //    beats returning nothing. Unfiltered, exactly as before.
  //  - As a TOP-UP (a thin conjunctive match left room), an unfiltered OR
  //    appends documents matching just one term of a deliberately precise
  //    query. Searching "deploy kube" would surface a doc about "deploy
  //    docker" purely on the shared word "deploy" — noise the caller did not
  //    ask for, promoted into a result set that was already correct.
  //
  // So a top-up requires a document to carry at least two of the query's
  // terms. For a two-term query that collapses to the conjunctive result and
  // adds nothing, which is right for precise input; for a sentence-shaped
  // question it still admits genuinely related documents while rejecting
  // single-common-word coincidences.
  if (plan.relaxed) {
    const relaxedResults = runFtsQuery(db, plan.relaxed, "relaxed", limit, entryType, excludeTypes);
    const isTopUp = pool.length > 0;
    addTier(isTopUp ? relaxedResults.filter((r) => countMatchedTokens(r, plan.tokens) >= 2) : relaxedResults);
  }

  // Re-sort the merged pool by bm25 before truncating. This is REQUIRED, not
  // cosmetic: `normalizeFtsScores` (indexer/search/ranking.ts) reads
  // `results[0]` as the best score and `results[last]` as the worst to build
  // its min-max range, so handing it a tier-concatenated array silently
  // corrupts every normalized score. bm25 is the same function over the same
  // table and weights in all three tiers, and rewards matching more of the
  // query, so the merged ordering is meaningful. Each result keeps its own
  // `lexicalMatch` label, which is what the ranker's relaxed-tier score
  // ceiling keys off — a promoted relaxed row does not escape that ceiling by
  // sorting well here.
  pool.sort((a, b) => a.bm25Score - b.bm25Score || a.id - b.id);
  return pool.slice(0, limit);
}

/**
 * How many of the query's tokens this result's indexed text actually carries.
 *
 * Approximate by design: FTS5 applies Porter stemming, so this substring check
 * is a floor rather than an exact reproduction of the matcher. It only ever
 * gates whether an already-matched relaxed row is worth appending as a top-up,
 * so under-counting costs at most one extra candidate and never removes a row
 * the conjunctive tiers found.
 */
function countMatchedTokens(result: DbSearchResult, tokens: readonly string[]): number {
  const haystack = `${result.searchText} ${result.entry.name}`.toLowerCase();
  let matched = 0;
  for (const token of tokens) {
    if (haystack.includes(token.toLowerCase())) matched++;
  }
  return matched;
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
