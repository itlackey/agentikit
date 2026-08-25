// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared plain-text rendering for "list of status-bearing records" shapes.
 *
 * `akm health`'s `hardChecks`/`advisories` and `akm
 * lint`'s `fixed`/`flagged` issues are all, structurally, an array of small
 * uniform records where one field names a severity and a human scanning the
 * output needs the bad ones first, not buried below a wall of passing rows.
 * `renderGenericText`'s flat `path=value` fallback (`../generic-render.ts`)
 * JSON-dumps such an array as ONE line — accurate but unreadable for exactly
 * this shape, which is why commands with this shape get a bespoke text
 * formatter instead of falling through to it. This module is the one place
 * the "worst-first, glyph-prefixed, optionally-detailed" rendering lives, so
 * a third command with the same shape reuses it instead of reinventing it.
 */

/** One row rendered by {@link renderStatusEntries}. */
export interface StatusEntry {
  /** Ascending = more urgent. Entries are stably sorted by this field. */
  severityRank: number;
  /** Single-glyph status prefix, e.g. "✗" / "⚠" / "?" / "✓". */
  glyph: string;
  /** The summary line — no leading glyph or indentation; this function adds both. */
  headline: string;
  /** Extra lines rendered indented under the headline. Omit/empty to show none. */
  detailLines?: string[];
}

/**
 * Render entries worst-first (by `severityRank`, ties keep original order),
 * each as a glyph-prefixed headline with its optional indented detail lines.
 */
export function renderStatusEntries(entries: readonly StatusEntry[]): string[] {
  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.severityRank - b.entry.severityRank || a.index - b.index)
    .map(({ entry }) => entry);
  const lines: string[] = [];
  for (const entry of ordered) {
    lines.push(`${entry.glyph} ${entry.headline}`);
    for (const detail of entry.detailLines ?? []) {
      lines.push(`    ${detail}`);
    }
  }
  return lines;
}

/**
 * Render a status→count map as `"2 fail, 1 warn, 5 pass"`, in `order` (worst
 * first) with zero counts omitted. Shared by any section header that wants a
 * one-line "what's in here" summary before the per-row detail.
 */
export function summarizeCounts(counts: Record<string, number>, order: readonly string[]): string {
  return order
    .filter((status) => (counts[status] ?? 0) > 0)
    .map((status) => `${counts[status]} ${status}`)
    .join(", ");
}
