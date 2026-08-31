// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * itlackey/akm#889: the `stash-dead-residue` health advisory must name every
 * Tier-1 dead pre-0.9.0 `.akm/*` path that still exists on disk, with its
 * size, and never delete anything itself. `removeDeadResidue` is the
 * separate opt-in action (`akm health --clean-dead-residue`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectDeadResidueAdvisory,
  findDeadResidueEntries,
  removeDeadResidue,
} from "../../../src/commands/health/dead-residue";

let stashDir: string;

beforeEach(() => {
  stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-dead-residue-"));
});

afterEach(() => {
  fs.rmSync(stashDir, { recursive: true, force: true });
});

describe("findDeadResidueEntries / collectDeadResidueAdvisory (#889)", () => {
  test("reports nothing when .akm does not exist", () => {
    expect(findDeadResidueEntries(stashDir)).toEqual([]);
    expect(collectDeadResidueAdvisory(stashDir)).toBeUndefined();
  });

  test("reports nothing when .akm exists but has none of the dead paths", () => {
    fs.mkdirSync(path.join(stashDir, ".akm", "memory-cleanup"), { recursive: true });
    expect(findDeadResidueEntries(stashDir)).toEqual([]);
    expect(collectDeadResidueAdvisory(stashDir)).toBeUndefined();
  });

  test("finds each known dead path, including the timestamp-suffixed runs.archived-* directory", () => {
    const akmDir = path.join(stashDir, ".akm");
    fs.mkdirSync(path.join(akmDir, "proposals", "uuid-1"), { recursive: true });
    fs.writeFileSync(path.join(akmDir, "proposals", "uuid-1", "proposal.json"), "{}");
    fs.mkdirSync(path.join(akmDir, "runs.archived-2026-05-24T00-00-00"), { recursive: true });
    fs.writeFileSync(path.join(akmDir, "graph.json"), "{}");
    fs.writeFileSync(path.join(akmDir, "proposals.db"), "");
    // memory-cleanup is a Tier-3 keeper, not a dead-residue path — must never be reported.
    fs.mkdirSync(path.join(akmDir, "memory-cleanup"), { recursive: true });

    const entries = findDeadResidueEntries(stashDir);
    const relPaths = entries.map((e) => e.relativePath).sort();
    expect(relPaths).toEqual(
      [
        path.join(".akm", "proposals"),
        path.join(".akm", "runs.archived-2026-05-24T00-00-00"),
        path.join(".akm", "graph.json"),
        path.join(".akm", "proposals.db"),
      ].sort(),
    );

    const proposalsEntry = entries.find((e) => e.relativePath === path.join(".akm", "proposals"));
    expect(proposalsEntry?.sizeBytes).toBe(2); // "{}"

    const advisory = collectDeadResidueAdvisory(stashDir);
    expect(advisory?.name).toBe("stash-dead-residue");
    expect(advisory?.status).toBe("warn");
    expect((advisory?.evidence?.entries as unknown[])?.length).toBe(4);
  });
});

describe("removeDeadResidue (#889)", () => {
  test("deletes only the dead-residue paths and leaves everything else untouched", () => {
    const akmDir = path.join(stashDir, ".akm");
    fs.mkdirSync(path.join(akmDir, "archive"), { recursive: true });
    fs.writeFileSync(path.join(akmDir, "archive", "old.md"), "stale");
    fs.mkdirSync(path.join(akmDir, "memory-cleanup", "archive"), { recursive: true });
    fs.writeFileSync(path.join(akmDir, "memory-cleanup", "belief-transitions.jsonl"), "keep-me");

    const removals = removeDeadResidue(stashDir);
    expect(removals).toHaveLength(1);
    expect(removals[0]?.relativePath).toBe(path.join(".akm", "archive"));
    expect(removals[0]?.removed).toBe(true);

    expect(fs.existsSync(path.join(akmDir, "archive"))).toBe(false);
    expect(fs.existsSync(path.join(akmDir, "memory-cleanup", "belief-transitions.jsonl"))).toBe(true);
    expect(findDeadResidueEntries(stashDir)).toEqual([]);
  });

  test("is a no-op when nothing dead is present", () => {
    expect(removeDeadResidue(stashDir)).toEqual([]);
  });
});
