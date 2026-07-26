// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// ── Durable improve-state keys ───────────────────────────────────────────────
//
// Every improve ref uses the current grammar (a short conceptId), and the durable
// state key is the resolved index entry's `item_ref` when the planner supplied
// one, else the conceptId `ref` itself (`preparation.ts`
// `salienceWriteKey`/`outcomeWriteKey` = `itemRef ?? ref`).

/**
 * The durable improve-state key for a ref with no resolved `item_ref` — the
 * conceptId `ref` itself.
 */
export function durableImproveRef(ref: string): string {
  return ref;
}

/** Return the conceptId portion of a durable improve-state key. */
export function bareImproveRef(ref: string): string {
  const boundary = ref.indexOf("//");
  return boundary >= 0 ? ref.slice(boundary + 2) : ref;
}

/**
 * The single durable improve-state key used by both readers and writers.
 * Indexed entries use item_ref; direct or provenance-free refs use conceptId.
 */
export function improveStateReadRefs(ref: string, itemRef?: string): string[] {
  return [itemRef ?? ref];
}
