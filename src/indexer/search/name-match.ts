// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { buildLexicalQueryPlan } from "./fts-query";

/**
 * Tokenize a display name through the same Unicode-aware lexical planner as a
 * query.  Ranking must not invent a second, punctuation-dependent name grammar.
 */
export function lexicalNameTokens(name: string): string[] {
  return buildLexicalQueryPlan(name).tokens.map((token) => token.toLowerCase());
}

/**
 * Structural name-token evidence. Exact tokens are always meaningful; fuzzy
 * prefix evidence requires three code points on both sides so a question's
 * short words or digits cannot match an opaque generated storage name.
 */
export function structuralNameTokenMatch(left: string, right: string): boolean {
  return (
    left === right ||
    (Math.min([...left].length, [...right].length) >= 3 && (left.startsWith(right) || right.startsWith(left)))
  );
}

/**
 * Match a query phrase only across complete, contiguous name tokens. This is
 * deliberately not raw substring matching: `000` must not become name
 * evidence merely because an opaque token happens to be `z9xq000`.
 */
export function structuralNamePhraseMatch(nameTokens: readonly string[], queryTokens: readonly string[]): boolean {
  if (queryTokens.length === 0 || queryTokens.length > nameTokens.length) return false;
  for (let start = 0; start <= nameTokens.length - queryTokens.length; start += 1) {
    if (queryTokens.every((queryToken, index) => structuralNameTokenMatch(nameTokens[start + index]!, queryToken))) {
      return true;
    }
  }
  return false;
}
