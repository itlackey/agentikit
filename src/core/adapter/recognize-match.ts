// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The synchronous `recognizeMatch` arbitration — akm 0.9.0 Chunk 5, milestone
 * M-b, relocated here from `adapters/akm-adapter.ts` so it is a cycle-free LEAF
 * that BOTH the `akm` adapter AND the indexer metadata pass can import without
 * either importing the other.
 *
 * Before this move `indexer/passes/metadata.ts` imported `recognizeMatch` FROM
 * `akm-adapter.ts`; that indexer→adapter edge is what prevented the adapter from
 * ever reusing the metadata assembly (`buildEntryFromFile`) — it would have
 * closed a metadata ↔ adapter cycle. Hoisting the pure arbitration into this
 * leaf (imported by both, importing neither) severs that edge, so the adapter's
 * `recognize` can share the one metadata pipeline (parity by construction).
 *
 * The logic is unchanged: a synchronous reproduction of
 * `file-context.ts#runMatchers` (`:242-265`) minus its
 * `ensureBuiltinsRegistered()` dynamic import. It runs every builtin matcher in
 * registration order, collects the non-null `MatchResult`s, and returns the
 * highest-specificity one (ties broken by the later-registered matcher — higher
 * index — winning). Returns null when no matcher claims the file.
 */

import type { AssetMatcher, FileContext, MatchResult } from "../../indexer/walk/file-context";
import {
  directoryMatcher,
  extensionMatcher,
  parentDirHintMatcher,
  smartMdMatcher,
  smartMdPathCandidates,
} from "../../indexer/walk/matchers";
import type { AdapterPathContext } from "./bundle-adapter";

/**
 * The four builtin matchers, in registration order. The array index IS the
 * registration index `runMatchers` uses for tie-breaking. (The `wiki` matcher
 * was removed in chunk 4 — the wiki asset-type is retired; LLM Wiki content is
 * served by the first-class `llm-wiki` adapter, not the akm adapter. The old
 * YAML workflow-program matcher is also gone: peer Markdown and GitHub-shaped
 * `.yml` workflow sources are both path-owned by residence under `workflows/`
 * (with Markdown frontmatter as an additional signal), while source IR owns
 * their distinct parse/compile semantics.)
 */
const AKM_MATCHERS: readonly AssetMatcher[] = [
  extensionMatcher,
  directoryMatcher,
  parentDirHintMatcher,
  smartMdMatcher,
];

function winningMatch(hits: Array<{ result: MatchResult; index: number }>): MatchResult | null {
  if (hits.length === 0) return null;
  hits.sort((a, b) => {
    const specDiff = b.result.specificity - a.result.specificity;
    if (specDiff !== 0) return specDiff;
    return b.index - a.index;
  });
  return hits[0]!.result;
}

/**
 * Synchronous reproduction of `file-context.ts#runMatchers`'s arbitration
 * (`:242-265`), minus its `ensureBuiltinsRegistered()` dynamic import. Runs
 * every builtin matcher in registration order, collects the non-null
 * `MatchResult`s, and returns the highest-specificity one (ties broken by the
 * later-registered matcher — higher index — winning). Returns null when no
 * matcher claims the file.
 */
export function recognizeMatch(file: FileContext): MatchResult | null {
  const hits: Array<{ result: MatchResult; index: number }> = [];
  for (let i = 0; i < AKM_MATCHERS.length; i++) {
    const result = AKM_MATCHERS[i]!(file);
    if (result !== null) hits.push({ result, index: i });
  }
  return winningMatch(hits);
}

/**
 * Every AKM matcher winner possible from path fields alone. The three
 * path-only matchers run exactly as production does; each possible result of
 * the shared smart-Markdown fact table is then arbitrated at its real index.
 */
export function recognizePathCandidateMatches(file: AdapterPathContext): MatchResult[] {
  const fileContext = file as FileContext;
  const pathHits = [extensionMatcher, directoryMatcher, parentDirHintMatcher].flatMap((matcher, index) => {
    const result = matcher(fileContext);
    return result ? [{ result, index }] : [];
  });
  const smartCandidates = smartMdPathCandidates(file);
  const variants = smartCandidates.length > 0 ? smartCandidates : [undefined];
  const winners = variants.flatMap((smart) => {
    const winner = winningMatch(smart ? [...pathHits, { result: smart, index: 3 }] : [...pathHits]);
    return winner ? [winner] : [];
  });
  return [...new Map(winners.map((winner) => [`${winner.type}\0${winner.renderer}`, winner])).values()];
}
