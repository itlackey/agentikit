/**
 * ORG-07 naming-boundary note: this is the only `.bench.` file in the tree.
 * Despite the suffix, it is NOT a timing-sensitive performance benchmark —
 * it has no timing assertions, does no I/O, and is fully deterministic
 * (~0.2s wall clock, almost entirely process/module-load overhead; see
 * `time bun test` on this file solo). It is a correctness/regression check
 * that happens to re-run the grid search over a benchmark corpus, so it is
 * intentionally left running in the normal unit target rather than gated
 * behind a slow-test flag.
 *
 * Deliberately NOT renamed/relocated: `src/commands/improve/
 * distill-promotion-policy.ts` carries a comment (near its
 * `DEFAULT_PROMOTION_POLICY_SELECTION` freeze) that names this file by its
 * current path, and it sits alongside its sibling correctness suite
 * (`distill-promotion-policy.test.ts`) and its fixture corpus
 * (`./promotion-policy-corpus.ts`) in this directory. Moving or renaming it
 * would silently orphan that cross-file comment and split it from its
 * fixture, for no behavioral gain.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PROMOTION_POLICY_SELECTION,
  selectPromotionPolicy,
} from "../../../src/commands/improve/distill-promotion-policy";
import { CANDIDATE_MODELS, DEFAULT_PROMOTION_POLICY_CORPUS } from "./promotion-policy-corpus";

describe("distill promotion policy benchmark", () => {
  // The production selection is a frozen constant (no grid search runs at
  // module import). Re-run the grid search over the benchmark corpus here and
  // assert it still selects the frozen winner (model + threshold), so the
  // freeze cannot drift silently from what the corpus would actually select.
  // The rest of the grid-search payload (per-case results, baselines) is
  // recomputed live by the unit suite rather than frozen.
  test("frozen DEFAULT_PROMOTION_POLICY_SELECTION matches a live grid search over the corpus", () => {
    const recomputed = selectPromotionPolicy(DEFAULT_PROMOTION_POLICY_CORPUS, CANDIDATE_MODELS);
    expect({
      name: recomputed.selectedModel.name,
      threshold: recomputed.selectedModel.threshold,
    }).toEqual({
      name: DEFAULT_PROMOTION_POLICY_SELECTION.selectedModel.name,
      threshold: DEFAULT_PROMOTION_POLICY_SELECTION.threshold,
    });
  });
});
