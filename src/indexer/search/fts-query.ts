// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure FTS5 query planning and ref-query helpers.
 *
 * The lexical planner transforms a raw user query into bounded FTS5-safe
 * MATCH expressions. It touches no database state, so it is unit-testable
 * with zero DB setup.
 * `parseRefPrefixQuery` is the one non-FTS helper: it decides whether a raw
 * query should bypass FTS entirely (SPEC-4 ref-prefix enumeration).
 */

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
 * operators ordinary searchable words. Tokens are normalized and deduplicated
 * case-insensitively.
 *
 * There is deliberately NO cap on token count. `MAX_LEXICAL_QUERY_TOKENS = 16`
 * used to truncate here, silently: a query past 16 unique tokens searched only
 * its first 16, dropping the tail — which for natural-language input is
 * usually where the discriminating words are. It was unexplained in both the
 * code and the commit that introduced it, unreachable from any flag, config
 * key, or env var, and the user was never told their query had been altered.
 * A wrong answer delivered silently is worse than a slow one.
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
  }

  const exact = tokens.map(quoteToken).join(" ");
  const prefixTokens = tokens.map(prefixToken);
  const exactPrefix = prefixTokens.some((token) => token.endsWith("*")) ? prefixTokens.join(" ") : undefined;
  // A slash-bearing, whitespace-free input is an identifier/ref lookup, not
  // sentence prose. Keep it conjunctive so a mistyped/bare ref never fans out
  // across every path token through OR recovery.
  const isRefLikeIdentifier = !/\s/u.test(query.trim()) && query.includes("/");
  const relaxed = tokens.length > 1 && !isRefLikeIdentifier ? prefixTokens.join(" OR ") : undefined;

  return { tokens, exact, exactPrefix, relaxed };
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
