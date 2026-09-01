// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Eligibility / safety predicates for consolidate: "may we touch this memory?"
// One reason to change — the policy for what consolidate is allowed to act on.

import fs from "node:fs";
import { parseFrontmatter } from "../../../core/asset/frontmatter";
import { hasHotCaptureMode } from "../../proposal/validators/proposal-quality-validators";

export function isConsolidationEligibleMemoryName(name: string): boolean {
  return !name.endsWith(".derived");
}

/**
 * Returns true when the memory file has `captureMode: hot` in its frontmatter.
 *
 * Hot memories are USER-EXPLICIT (written via `akm remember` on the hot path).
 * The consolidate LLM is forbidden from deleting or auto-merging them — the
 * user wrote them on purpose and only the user can decide to retire them.
 *
 * Reads the file once per check; consolidate runs against ~10 memories per
 * chunk so the IO cost is trivial. Returns false on any read/parse error
 * (fail-safe: an unreadable or unparseable file is treated as HOT — protected
 * — because a deletion shield must not fail open; a missing file is not-hot).
 *
 * Defends against four observed defect classes (see
 * `memories/akm-improve-critical-review-2026-05-20`):
 *   - LLM marks a memory contradicted then deletes (dangling contradictedBy)
 *   - LLM merges two unrelated memories sharing a topic keyword
 *   - LLM judges a recent durable design memo as "redundant"
 *   - Cascade deletes (LLM uses ref:X as `contradictedBy` for ref:Y then deletes both)
 */
export function isHotCapturedMemory(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const parsed = parseFrontmatter(content);
    return hasHotCaptureMode(parsed.data as Record<string, unknown> | undefined);
  } catch {
    // Fail CLOSED. This predicate is a deletion shield: "hot" memories are
    // protected from consolidate's merge/delete. Returning false on a read or
    // parse failure marked exactly the memories we could not inspect as fair
    // game — the one direction a protection check must never fail. A missing
    // file stays false (nothing to protect); an unreadable one is protected
    // until someone can actually read it.
    return true;
  }
}
