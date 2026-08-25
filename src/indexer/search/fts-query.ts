// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure FTS5 query-string helpers, extracted from indexer/db/db.ts.
 *
 * These transform a raw user query into an FTS5-safe MATCH expression. They
 * touch no database state, so they are unit-testable with zero DB setup.
 * `parseRefPrefixQuery` is the one non-FTS helper: it decides whether a raw
 * query should bypass FTS entirely (SPEC-4 ref-prefix enumeration).
 */

/** Maximum number of distinct lexical terms one query may execute. */
export const MAX_LEXICAL_QUERY_TOKENS = 16;

export type LexicalQueryExecution = "exact" | "prefix" | "relaxed";

export interface LexicalQueryPlan {
  tokens: string[];
  /** Quoted implicit-AND query. */
  exact: string;
  /** Quoted prefix-AND query, omitted when no token is eligible. */
  exactPrefix?: string;
  /** One bounded prefix-OR recovery query, present only for multi-term input. */
  relaxed?: string;
}

const UNICODE_TOKEN = /[\p{L}\p{N}]+/gu;

function quoteToken(token: string): string {
  return `"${token}"`;
}

function prefixToken(token: string): string {
  return [...token].length >= 3 ? `${quoteToken(token)}*` : quoteToken(token);
}

/**
 * Build the sole lexical retrieval plan from raw user input.
 *
 * Tokenization follows the useful portion of SQLite FTS5's `unicode61`
 * tokenizer (Unicode letters and numbers). Quoting every term makes FTS
 * operators ordinary searchable words. Tokens are normalized, deduplicated
 * case-insensitively, and capped before any SQL executes.
 */
export function buildLexicalQueryPlan(query: string): LexicalQueryPlan {
  const tokens: string[] = [];
  const seen = new Set<string>();
  const normalized = query.normalize("NFKC");
  for (const match of normalized.matchAll(UNICODE_TOKEN)) {
    const token = match[0];
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push(token);
    if (tokens.length === MAX_LEXICAL_QUERY_TOKENS) break;
  }

  const exact = tokens.map(quoteToken).join(" ");
  const prefixTokens = tokens.map(prefixToken);
  const exactPrefix = prefixTokens.some((token) => token.endsWith("*")) ? prefixTokens.join(" ") : undefined;
  const relaxed = tokens.length > 1 ? prefixTokens.join(" OR ") : undefined;

  return { tokens, exact, exactPrefix, relaxed };
}

/**
 * Sanitize a raw user query into an FTS5-safe implicit-AND expression.
 *
 * Allows only characters safe in FTS5 queries: letters, digits, underscores,
 * and whitespace. Everything else (hyphens, dots, quotes, parens, asterisks,
 * colons, carets, @, !, etc.) is replaced with a space so that compound
 * identifiers like "code-review" or "k8s.setup" become AND-joined tokens
 * ("code review", "k8s setup") rather than triggering FTS5 syntax errors.
 */
export function sanitizeFtsQuery(query: string): string {
  let sanitized = query.replace(/[^a-zA-Z0-9_\s]/g, " ");

  // Neutralize the NEAR operator (FTS5 proximity syntax)
  sanitized = sanitized.replace(/\bNEAR\b/g, " ");

  const tokens = sanitized.split(/\s+/).filter((t) => t.length >= 1);

  if (tokens.length === 0) return "";

  // Use implicit AND (space-separated tokens) for precision. FTS5 treats
  // space-separated tokens as an implicit AND, matching only rows that
  // contain ALL terms.
  return tokens.join(" ");
}

/**
 * Build a prefix query from an FTS5 query string by appending `*` to each
 * token that is 3+ characters long. Tokens shorter than 3 characters are
 * kept as-is (no prefix expansion) to avoid overly broad matches.
 *
 * Returns null if no tokens qualify for prefix expansion.
 */
export function buildPrefixQuery(ftsQuery: string): string | null {
  const tokens = ftsQuery.split(/\s+/).filter(Boolean);
  let hasPrefix = false;

  const prefixTokens = tokens.map((t) => {
    if (t.length >= 3) {
      hasPrefix = true;
      return `${t}*`;
    }
    return t;
  });

  if (!hasPrefix) return null;

  return prefixTokens.join(" ");
}

/**
 * D4 — parse a conceptId-prefix browse query.
 *
 * Decides whether a raw query is a subtree-enumeration request rather than an
 * ordinary keyword search. Matching is deliberately conservative: the trimmed
 * query must be EXACTLY
 *
 *   - `<conceptId prefix>/`           → that subtree in any bundle,
 *   - `<bundle>//`                    → one bundle entirely,
 *   - `<bundle>//<conceptId prefix>/` → that subtree of that bundle.
 *
 * The trailing slash is REQUIRED — and is RETAINED in `conceptIdPrefix` — so a
 * plain `conceptId.startsWith(conceptIdPrefix)` check gives exact `/`-boundary
 * subtree semantics (`"projecta/"` cannot match a sibling `projectalpha/…`
 * scope). Bare refs like `memories/a/b` therefore stay ordinary searches
 * (resolving one ref is `akm show` territory), and any interior whitespace
 * disqualifies (prose mentioning a ref is still prose).
 *
 * The prefix matches the conceptId — the same string every emitted `ref`
 * carries — so a ref copied out of search output round-trips back in as a
 * prefix. Nothing here consults a type list: enumeration covers every
 * adapter's items uniformly, which the retired `<type>:` grammar could not do.
 *
 * Returns `null` when the query is not a browse request.
 */
export function parseRefPrefixQuery(query: string): { bundle?: string; conceptIdPrefix: string } | null {
  const trimmed = query.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) return null;

  const separator = trimmed.indexOf("//");
  if (separator < 0) {
    return trimmed.endsWith("/") ? { conceptIdPrefix: trimmed } : null;
  }

  const bundle = trimmed.slice(0, separator);
  if (bundle.length === 0) return null;

  const rest = trimmed.slice(separator + 2);
  if (rest === "") return { bundle, conceptIdPrefix: "" };
  if (rest.endsWith("/") && !rest.includes("//")) return { bundle, conceptIdPrefix: rest };
  return null;
}

/**
 * Recognize the retired `<type>:` / `<type>:<prefix>/` browse grammar so the
 * caller can name the replacement spelling rather than letting the query
 * degrade silently into a keyword search — the exact silent failure D4 removes.
 * Shape recognition only; mapping the type to its conceptId root belongs to the
 * caller, which keeps this module dependency-free.
 */
export function parseRetiredTypePrefixQuery(query: string): { type: string; rest: string } | null {
  const trimmed = query.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed) || trimmed.includes("//")) return null;

  const colon = trimmed.indexOf(":");
  if (colon <= 0) return null;

  const rest = trimmed.slice(colon + 1);
  if (rest !== "" && !rest.endsWith("/")) return null;
  return { type: trimmed.slice(0, colon), rest };
}
