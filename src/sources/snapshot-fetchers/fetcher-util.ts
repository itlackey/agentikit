// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Small shared helpers for the snapshot fetchers.
 *
 * These live in a leaf module (no fetcher or `website-ingest` imports) so the
 * individual fetchers can share them without cycling through the fetcher
 * registry — the same reason the SSRF guards were pulled into `host-guard.ts`.
 */

/**
 * Neutralize markdown structure in attacker-controlled prose. Without this a
 * post/tweet body containing a line starting with `##` forges a section
 * boundary in the snapshot, letting it impersonate content the fetcher
 * vouched for.
 */
export function escapeMarkdownStructure(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^(\s*)([#>\-*+=~_`]|\d+[.)])/, "$1\\$2"))
    .join("\n");
}

/** Coerce an unknown JSON value to a string, defaulting to "". */
export function coerceString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * `index` and `log` are OKF reserved structural basenames at every depth — an
 * adapter never indexes them, so an asset written there imports but can never
 * be found by search or show. Remap the trailing segment (`x/index` ->
 * `x/index-content`). Idempotent: a `-content`-suffixed name is left alone.
 */
export function avoidReservedBasename(relPath: string): string {
  const segments = relPath.split("/");
  const last = segments[segments.length - 1] ?? "";
  if (last === "index" || last === "log") {
    segments[segments.length - 1] = `${last}-content`;
  }
  return segments.join("/");
}
