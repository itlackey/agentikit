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

/** Structured metadata plus bounded body text supplied to embedding providers. */
export const SEARCH_TEXT_MAX_CHARS = 8_192;

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
 */
export function buildSearchText(entry: IndexDocument): string {
  const fields = buildSearchFields(entry);
  const structured = [fields.name, fields.description, fields.tags, fields.hints]
    .filter((field) => field.length > 0)
    .join(" ");
  if (structured.length >= SEARCH_TEXT_MAX_CHARS) return truncateUnicodeSafe(structured, SEARCH_TEXT_MAX_CHARS);
  if (!fields.content) return structured;
  const separator = structured ? " " : "";
  const remaining = SEARCH_TEXT_MAX_CHARS - structured.length - separator.length;
  return `${structured}${separator}${truncateUnicodeSafe(fields.content, remaining)}`;
}

function truncateUnicodeSafe(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let cut = text.slice(0, maxChars);
  const lastCode = cut.charCodeAt(cut.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) cut = cut.slice(0, -1);
  return cut.trimEnd();
}
