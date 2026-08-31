// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #750: the `orphan-assets` health advisory must flag `knowledge`/wiki-page
 * entries with zero inbound references, while leaving out-of-scope types
 * (memory, command, etc.) untouched even when nothing links to them. Never a
 * hard failure — always `status: "warn"`.
 */

import { describe, expect, test } from "bun:test";
import {
  buildOrphanAdvisory,
  collectOrphanAssets,
  type OrphanCheckEntry,
} from "../../../src/commands/health/orphan-check";

/** Trivial resolver: refs are entry ids as strings, e.g. "1" resolves to id 1. */
function resolveById(entries: OrphanCheckEntry[]): (ref: string) => number | undefined {
  const byRef = new Map(entries.map((e) => [e.itemRef, e.id]));
  return (ref) => byRef.get(ref);
}

describe("collectOrphanAssets (#750)", () => {
  test("reports nothing when every in-scope entry has an inbound reference", () => {
    const entries: OrphanCheckEntry[] = [
      {
        id: 1,
        filePath: "/stash/knowledge/a.md",
        itemRef: "core//knowledge/a",
        type: "knowledge",
        content: "See core//knowledge/b for details.",
      },
      {
        id: 2,
        filePath: "/stash/knowledge/b.md",
        itemRef: "core//knowledge/b",
        type: "knowledge",
        content: "See core//knowledge/a for details.",
      },
    ];
    expect(collectOrphanAssets(entries, resolveById(entries))).toEqual([]);
  });

  test("flags a knowledge asset nothing references", () => {
    const entries: OrphanCheckEntry[] = [
      { id: 1, filePath: "/stash/knowledge/a.md", itemRef: "core//knowledge/a", type: "knowledge" },
      { id: 2, filePath: "/stash/knowledge/b.md", itemRef: "core//knowledge/b", type: "knowledge" },
    ];
    const orphans = collectOrphanAssets(entries, resolveById(entries));
    expect(orphans.map((o) => o.itemRef)).toEqual(["core//knowledge/a", "core//knowledge/b"]);
  });

  test("counts frontmatter xrefs as inbound references", () => {
    const entries: OrphanCheckEntry[] = [
      { id: 1, filePath: "/stash/knowledge/a.md", itemRef: "core//knowledge/a", type: "knowledge" },
      {
        id: 2,
        filePath: "/stash/knowledge/b.md",
        itemRef: "core//knowledge/b",
        type: "knowledge",
        xrefs: ["core//knowledge/a"],
      },
    ];
    const orphans = collectOrphanAssets(entries, resolveById(entries));
    expect(orphans.map((o) => o.itemRef)).toEqual(["core//knowledge/b"]);
  });

  test("counts resolved wiki `links` as inbound references", () => {
    const entries: OrphanCheckEntry[] = [
      { id: 1, filePath: "/stash/wiki/pages/a.md", itemRef: "core//wiki/pages/a", type: "concept", wikiRole: "page" },
      {
        id: 2,
        filePath: "/stash/wiki/pages/b.md",
        itemRef: "core//wiki/pages/b",
        type: "concept",
        wikiRole: "page",
        links: ["core//wiki/pages/a"],
      },
    ];
    const orphans = collectOrphanAssets(entries, resolveById(entries));
    expect(orphans.map((o) => o.itemRef)).toEqual(["core//wiki/pages/b"]);
  });

  test("a self-reference does not count as an inbound reference", () => {
    const entries: OrphanCheckEntry[] = [
      {
        id: 1,
        filePath: "/stash/knowledge/a.md",
        itemRef: "core//knowledge/a",
        type: "knowledge",
        content: "See core//knowledge/a below.",
      },
    ];
    const orphans = collectOrphanAssets(entries, resolveById(entries));
    expect(orphans.map((o) => o.itemRef)).toEqual(["core//knowledge/a"]);
  });

  test("out-of-scope types (memory, command, ...) are never flagged", () => {
    const entries: OrphanCheckEntry[] = [
      { id: 1, filePath: "/stash/memories/note.md", itemRef: "core//memories/note", type: "memory" },
      { id: 2, filePath: "/stash/commands/deploy.md", itemRef: "core//commands/deploy", type: "command" },
      { id: 3, filePath: "/stash/skills/my-skill/SKILL.md", itemRef: "core//skills/my-skill", type: "skill" },
    ];
    expect(collectOrphanAssets(entries, resolveById(entries))).toEqual([]);
  });

  test("a ref that fails to resolve is skipped, not treated as an inbound reference", () => {
    const entries: OrphanCheckEntry[] = [
      {
        id: 1,
        filePath: "/stash/knowledge/a.md",
        itemRef: "core//knowledge/a",
        type: "knowledge",
        content: "See core//knowledge/missing.",
      },
    ];
    const resolveThrows = (): number | undefined => {
      throw new Error("bad ref");
    };
    expect(collectOrphanAssets(entries, resolveThrows).map((o) => o.itemRef)).toEqual(["core//knowledge/a"]);
  });
});

describe("buildOrphanAdvisory (#750)", () => {
  test("returns undefined when nothing is orphaned", () => {
    const entries: OrphanCheckEntry[] = [
      {
        id: 1,
        filePath: "/stash/knowledge/a.md",
        itemRef: "core//knowledge/a",
        type: "knowledge",
        content: "core//knowledge/b",
      },
      {
        id: 2,
        filePath: "/stash/knowledge/b.md",
        itemRef: "core//knowledge/b",
        type: "knowledge",
        content: "core//knowledge/a",
      },
    ];
    expect(buildOrphanAdvisory(entries, resolveById(entries))).toBeUndefined();
  });

  test("warns (never fails) and names each orphan by ref", () => {
    const entries: OrphanCheckEntry[] = [
      { id: 1, filePath: "/stash/knowledge/a.md", itemRef: "core//knowledge/a", type: "knowledge" },
    ];
    const result = buildOrphanAdvisory(entries, resolveById(entries));
    expect(result?.status).toBe("warn");
    expect(result?.name).toBe("orphan-assets");
    expect(result?.message).toContain("core//knowledge/a");
  });
});
