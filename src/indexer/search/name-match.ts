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

/** Short phrase containment is fuzzy name evidence and shares the same floor. */
export function canUseFuzzyNamePhrase(value: string): boolean {
  return [...value].length >= 3;
}
