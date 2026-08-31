// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #885 — the contradiction pass must go through the shared edge primitive.
 *
 * `memory-belief.ts#writeContradictEdge` is the hardened `contradictedBy`
 * writer, and it had no production caller: the live pass in
 * `memory-contradiction-detect.ts` used a private near-copy that had drifted
 * on exactly the two behaviors the primitive was hardened for. Its tests
 * therefore guarded dead code while the running path carried the bugs.
 *
 * These tests pin the two divergences directly, so a future re-fork of the
 * writer fails here rather than silently corrupting frontmatter:
 *
 *   1. a SCALAR `contradictedBy` is preserved, not destroyed. The copy read
 *      the key with `Array.isArray` only, so a scalar read as "no edges" and
 *      was overwritten. Scalars are live data — the indexer's
 *      `normalizeNonEmptyStringList` accepts them and lint deliberately never
 *      flags them.
 *   2. `beliefState: archived` is NOT weakened to `contradicted`. The copy
 *      assigned the demotion unconditionally; archived ranks BELOW contradicted
 *      (`BELIEF_STATE_SCORE_CEILINGS`), so contradicting an archived memory
 *      promoted it back up the ranking.
 *
 * The third `contradictedBy` writer, `persistBeliefStateTransition` in
 * `memory-improve.ts`, is deliberately NOT routed through the primitive and is
 * asserted here to keep its distinct behavior: it is a state-TRANSITION writer
 * that replaces the edge list wholesale and can clear it, which an
 * append-only, never-weaken primitive cannot express.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { writeContradictEdge } from "../../../../src/commands/improve/memory/memory-belief";
import { parseFrontmatter } from "../../../../src/core/asset/frontmatter";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

const CONTRADICT_DETECT_SRC = path.join(
  import.meta.dir,
  "../../../../src/commands/improve/memory/memory-contradiction-detect.ts",
);

function writeMemory(stashDir: string, slug: string, frontmatter: string): string {
  const file = path.join(stashDir, "memories", `${slug}.md`);
  fs.writeFileSync(file, `---\n${frontmatter}---\n\nBody.\n`);
  return file;
}

function frontmatterOf(file: string): Record<string, unknown> {
  return parseFrontmatter(fs.readFileSync(file, "utf8")).data;
}

describe("the contradiction pass uses the shared edge primitive (#885)", () => {
  let storage: IsolatedAkmStorage;
  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });
  afterEach(() => storage.cleanup());

  test("the live pass calls writeContradictEdge and holds no private copy", () => {
    const src = fs.readFileSync(CONTRADICT_DETECT_SRC, "utf8");
    expect(src).toContain("writeContradictEdge(");
    // The re-fork guard: the drifted copy was named `writeContradictedByEdge`.
    expect(src).not.toContain("function writeContradictedByEdge");
    // It must not hand-roll a frontmatter mutation for this key either.
    expect(src).not.toContain("mutateFrontmatter");
  });

  test("a SCALAR contradictedBy edge is preserved, not overwritten", () => {
    const file = writeMemory(storage.stashDir, "scalar-holder", "contradictedBy: memories/first-dispute\n");

    writeContradictEdge(file, "memories/second-dispute");

    const data = frontmatterOf(file);
    // The pre-existing scalar is promoted into the list, not dropped.
    expect(data.contradictedBy).toEqual(["memories/first-dispute", "memories/second-dispute"]);
  });

  test("beliefState: archived is not weakened to contradicted", () => {
    const file = writeMemory(
      storage.stashDir,
      "archived-holder",
      "beliefState: archived\ncontradictedBy:\n  - memories/old\n",
    );

    writeContradictEdge(file, "memories/new-dispute");

    const data = frontmatterOf(file);
    expect(data.beliefState).toBe("archived");
    expect(data.contradictedBy).toEqual(["memories/new-dispute", "memories/old"]);
  });

  test("an edge present WITHOUT the demotion is repaired, not skipped", () => {
    // The drifted copy returned early on `existing.includes(ref)`, so a file
    // carrying the edge but no beliefState stayed a permanent no-op while the
    // caller counted the contradiction as applied.
    const file = writeMemory(storage.stashDir, "half-written", "contradictedBy:\n  - memories/disputer\n");

    expect(writeContradictEdge(file, "memories/disputer")).toBe(true);
    expect(frontmatterOf(file).beliefState).toBe("contradicted");
  });

  test("a fully-applied edge is an idempotent no-op, so edge counts stay honest", () => {
    const file = writeMemory(
      storage.stashDir,
      "already-done",
      "beliefState: contradicted\ncontradictedBy:\n  - memories/disputer\n",
    );

    // The call site counts `edgesWritten` from this boolean.
    expect(writeContradictEdge(file, "memories/disputer")).toBe(false);
  });

  test("the SCC transition writer keeps its distinct, non-append behavior", () => {
    // Guards the #885 decision to leave persistBeliefStateTransition alone:
    // it must still be able to CLEAR contradictedBy, which the append-only
    // primitive cannot do.
    const src = fs.readFileSync(
      path.join(import.meta.dir, "../../../../src/commands/improve/memory/memory-improve.ts"),
      "utf8",
    );
    expect(src).toContain("function persistBeliefStateTransition");
    expect(src).toContain("delete nextFrontmatter.contradictedBy");
  });
});
