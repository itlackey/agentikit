// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Regression for #908 — a bundle that carries BOTH a tool-dir-shaped layout
 * (here: `agent-skills`' own root-level `<name>/SKILL.md` packages) AND
 * ordinary akm content (`knowledge/`, `content/`, `workflows/`, `scripts/`,
 * `workspace/`) used to auto-detect as the narrow adapter and silently drop
 * everything outside its own recognized slice — no warning, no count,
 * nothing in `akm bundle list` to say a choice was even made.
 *
 * `detectAdapterId` now detects such a mixed root as `akm` (the superset,
 * which still recognizes the skill package correctly) while a PURE
 * agent-skills tree (no extra content) is unaffected.
 *
 * `tests/fixtures/bundles/agent-skills-mixed/` mirrors the layout the issue
 * describes: a root-level `formatting/SKILL.md` package alongside
 * `knowledge/`, `content/`, `workflows/`, `scripts/`, `workspace/` — none of
 * which the `agent-skills` adapter's own `recognize()` sees at all.
 *
 * This test lives alongside `conformance.test.ts` (not `tests/integration/`),
 * matching its existing precedent of calling `walkStashFlat`-adjacent
 * fixture-root probes directly (`detectAdapterId`/`looksLikeRoot` here do
 * only shallow `readdirSync` calls — no db, no network, no spawned process).
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";
import { agentSkillsAdapter } from "../../../src/core/adapter/adapters";
import { detectAdapterId } from "../../../src/core/adapter/detect-adapter";

const BUNDLES = path.resolve(__dirname, "../../fixtures/bundles");
const AGENT_SKILLS_ROOT = path.join(BUNDLES, "agent-skills");
const AGENT_SKILLS_MIXED_ROOT = path.join(BUNDLES, "agent-skills-mixed");

describe("detectAdapterId — mixed-layout superset detection (#908)", () => {
  test("a pure agent-skills tree still detects as agent-skills (unchanged)", () => {
    // RED on old code: this passed before the fix too (nothing here changes
    // for a layout with no extra akm content) — pinned as the baseline so a
    // regression in the OTHER direction (over-eager override) is caught.
    expect(agentSkillsAdapter.looksLikeRoot?.(AGENT_SKILLS_ROOT)).toBe(true);
    expect(detectAdapterId(AGENT_SKILLS_ROOT)).toBe("agent-skills");
  });

  test("a mixed agent-skills + ordinary akm content tree detects as akm, not agent-skills", () => {
    // Sanity: the root-level SKILL.md package alone is still enough for the
    // raw agent-skills probe to claim the root — the override happens in
    // detectAdapterId, not in the adapter's own looksLikeRoot.
    expect(agentSkillsAdapter.looksLikeRoot?.(AGENT_SKILLS_MIXED_ROOT)).toBe(true);
    // RED on old code: detectAdapterId returned "agent-skills" here (the first
    // ordered probe to fire), silently dropping knowledge/, content/,
    // workflows/, scripts/, workspace/ from the index (#908's 73-document
    // loss). GREEN on the fix: the superset wins.
    expect(detectAdapterId(AGENT_SKILLS_MIXED_ROOT)).toBe("akm");
  });
});
