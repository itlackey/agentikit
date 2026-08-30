// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS-3b Step 8 — Anti-collapse merge guards.
 *
 *   (a) Generation counter: merged.generation = max(sources)+1; merges cite
 *       sources. `over_generation_count` (collapse-detector.ts) tracks assets
 *       above the generation threshold as an advisory metric only — there is
 *       no merge-refusal path wired in.
 *   (b) Lexical-diversity check: low n-gram diversity ⇒ raise merge threshold.
 *   (d) Occasional random non-similar cluster in the pool.
 *
 * @module anti-collapse
 */

/** Default max generation depth before merge is refused. */
export const DEFAULT_MAX_GENERATION = 2;

/** Default fraction of pool to fill with random (non-similar) clusters. */
export const DEFAULT_RANDOM_CLUSTER_FRACTION = 0.05;

export interface AntiCollapseConfig {
  /**
   * DEFAULT ON since R5 (docs/architecture/specs/improve-collapse-churn-detector-design.md
   * §4.1, owner-approved): the lexical-diversity check and random-cluster
   * injection are deterministic, cheap, and advisory. Set `false` to opt out
   * and restore the pre-R5 unguarded behavior.
   */
  enabled?: boolean;
  maxGeneration?: number;
  lexicalDiversityCheck?: boolean;
  randomClusterFraction?: number;
  /**
   * R5 §4.2 — merge-information floor config. Currently unused: no caller
   * measures it (see collapse-detector.ts `merge_floor_violations`, which is
   * populated by its own caller-supplied count, not by this module).
   */
  mergeInformationFloor?: boolean;
  /** Distinct-token retention floor for merges (default 0.6). Currently unused. */
  minSpecificityRetention?: number;
}

/**
 * Read the `generation` field from an asset's frontmatter.
 * Returns 0 when absent (no generation metadata = original asset).
 */
export function readAssetGeneration(frontmatterData: Record<string, unknown>): number {
  const gen = frontmatterData.generation;
  if (typeof gen === "number" && Number.isFinite(gen) && gen >= 0) {
    return Math.floor(gen);
  }
  return 0;
}

/**
 * Compute the new generation for a merged asset.
 * Rule: `merged.generation = max(source generations) + 1`.
 */
export function computeMergedGeneration(sourceGenerations: number[]): number {
  if (sourceGenerations.length === 0) return 1;
  return Math.max(...sourceGenerations) + 1;
}

/**
 * Compute the bigram n-gram diversity of a text string.
 * Returns a value in [0, 1] where 0 = all identical bigrams, 1 = all unique.
 * Used by the lexical-diversity check to detect correlated-extraction artifacts.
 */
export function computeBigramDiversity(text: string): number {
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length < 2) return 1; // too short to have bigrams; treat as diverse

  const total = words.length - 1;
  const unique = new Set<string>();
  for (let i = 0; i < total; i++) {
    unique.add(`${words[i]}\t${words[i + 1]}`);
  }
  return unique.size / total;
}

/**
 * Check whether a cluster of memories exhibits suspiciously low lexical diversity.
 * When true, the cluster is likely a correlated-extraction artifact; the merge
 * threshold should be raised.
 *
 * @param bodies - The stripped body texts of the cluster members.
 * @param config - Anti-collapse config.
 * @returns `{ lowDiversity: true, diversity }` when the cluster diversity is
 *   below the 0.3 threshold; `{ lowDiversity: false }` otherwise.
 */
export function checkLexicalDiversity(
  bodies: string[],
  config: AntiCollapseConfig,
): { lowDiversity: boolean; diversity?: number } {
  // R5: default ON — only an explicit opt-out disables the check.
  if (config.enabled === false || config.lexicalDiversityCheck === false) {
    return { lowDiversity: false };
  }
  if (bodies.length === 0) return { lowDiversity: false };

  // Average bigram diversity across all bodies in the cluster.
  const avg = bodies.reduce((sum, b) => sum + computeBigramDiversity(b), 0) / bodies.length;
  const DIVERSITY_FLOOR = 0.3;
  if (avg < DIVERSITY_FLOOR) {
    return { lowDiversity: true, diversity: avg };
  }
  return { lowDiversity: false };
}
