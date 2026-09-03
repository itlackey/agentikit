// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Per-field search text extraction for FTS5 indexing.
 *
 * Extracted from indexer.ts to break the circular dependency:
 *   db.ts -> indexer.ts -> db.ts
 *
 * This module imports only from metadata.ts (for the IndexDocument type),
 * so it can be safely imported by both db.ts and indexer.ts.
 */

import type { IndexDocument } from "../passes/metadata";

/**
 * Return per-field search text for multi-column FTS5 indexing.
 *
 * Fields:
 *  - name: entry name with hyphens/underscores replaced by spaces
 *  - description: entry description
 *  - tags: tags + aliases joined
 *  - hints: searchHints + examples + usage + intent fields
 *  - content: bounded native/adapter body projection + TOC headings + parameters
 *    (lowest-weight catch-all)
 */
// NOTE (R5): the collapse detector's frozen canary queries are built from the
// same surface this function indexes (name tokens / tags / description) and
// scored via FTS against it. Changing what buildSearchFields includes shifts
// the detector's recall baseline for ALL existing canary sets — coordinate
// with src/commands/improve/collapse-detector.ts (buildCanaryQuery) and expect
// operators to re-mint via `bun scripts/refresh-canary-set.ts --refresh` after
// such a change.
export function buildSearchFields(entry: IndexDocument): {
  name: string;
  description: string;
  tags: string;
  hints: string;
  content: string;
} {
  const name = entry.name.replace(/[-_]/g, " ").toLowerCase();

  const description = (entry.description ?? "").toLowerCase();

  const tagParts: string[] = [];
  if (entry.tags) tagParts.push(entry.tags.join(" "));
  if (entry.aliases) tagParts.push(entry.aliases.join(" "));
  const tags = tagParts.join(" ").toLowerCase();

  const hintParts: string[] = [];
  if (entry.hints) hintParts.push(entry.hints.join(" "));
  if (entry.searchHints) hintParts.push(entry.searchHints.join(" "));
  if (entry.examples) hintParts.push(entry.examples.join(" "));
  if (entry.usage) hintParts.push(entry.usage.join(" "));
  if (entry.intent) {
    if (entry.intent.when) hintParts.push(entry.intent.when);
    if (entry.intent.input) hintParts.push(entry.intent.input);
    if (entry.intent.output) hintParts.push(entry.intent.output);
  }
  if (entry.xrefs) hintParts.push(entry.xrefs.join(" "));
  if (entry.pageKind) hintParts.push(entry.pageKind);
  if (entry.whenToUse) hintParts.push(entry.whenToUse);
  const hints = hintParts.join(" ").toLowerCase();

  const contentParts: string[] = [];
  if (entry.toc) {
    contentParts.push(entry.toc.map((h) => h.text).join(" "));
  }
  if (entry.parameters) {
    for (const param of entry.parameters) {
      contentParts.push(param.name);
      if (param.description) contentParts.push(param.description);
    }
  }
  if (entry.content) contentParts.push(entry.content);
  const content = contentParts.join(" ").toLowerCase();

  return { name, description, tags, hints, content };
}

/**
 * Build a single concatenated search text string for an entry.
 * Used for the `search_text` column in the entries table.
 * and for generating embedding text.
 *
 * Deliberately NO cap here. A fixed 8192-char ceiling used to truncate this —
 * both the FTS content column and the exact embedding input — silently: past
 * the cap a long document's body was unfindable by any term past char 8192,
 * and when the structured fields (name/description/tags/hints) alone reached
 * the cap the body was dropped entirely with nothing left to search or embed
 * against. FTS5 has no reason to bound this (see the identical
 * `MAX_LEXICAL_QUERY_TOKENS` deletion in `search/fts-query.ts` for the same
 * reasoning applied to queries); the one real bound — a native Markdown
 * body's own length — lives upstream in `passes/metadata.ts`
 * (`MARKDOWN_CONTENT_MAX_CHARS`), and an embedding provider's own token limit
 * is already handled at the embedding layer (`llm/embedders/remote.ts` skips
 * an oversized document rather than truncating or crashing).
 */
export function buildSearchText(entry: IndexDocument): string {
  const fields = buildSearchFields(entry);
  const structured = [fields.name, fields.description, fields.tags, fields.hints]
    .filter((field) => field.length > 0)
    .join(" ");
  if (!fields.content) return structured;
  const separator = structured ? " " : "";
  return `${structured}${separator}${fields.content}`;
}
