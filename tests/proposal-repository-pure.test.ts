// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { formatUnifiedDiff } from "../src/commands/proposal/diff-format";
// Import directly from the relocated module (the proposals repository split
// out of `validators/proposals.ts`).
import {
  isAutomatedProposalSource,
  isValidProposalSource,
  PROPOSAL_SOURCES,
} from "../src/commands/proposal/repository";
import { proposalRowToProposal, proposalToRowValues } from "../src/storage/repositories/proposals-repository";

const historicalRow = {
  id: "historical",
  stash_dir: "/tmp/stash",
  ref: "team//lessons/history",
  status: "pending",
  source: "reflect",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  content: "historical body",
  frontmatter_json: null,
  metadata_json: "{}",
};

describe("proposal repository — pure helpers (post-split)", () => {
  test("isValidProposalSource accepts known sources and rejects typos", () => {
    for (const s of PROPOSAL_SOURCES) {
      expect(isValidProposalSource(s)).toBe(true);
    }
    expect(isValidProposalSource("reflct")).toBe(false);
    expect(isValidProposalSource("")).toBe(false);
  });

  test("isAutomatedProposalSource distinguishes automated from human sources", () => {
    expect(isAutomatedProposalSource("reflect")).toBe(true);
    expect(isAutomatedProposalSource("distill")).toBe(true);
    // Human-initiated sources are not automated.
    expect(isAutomatedProposalSource("propose")).toBe(false);
    expect(isAutomatedProposalSource("remember")).toBe(false);
    expect(isAutomatedProposalSource("import")).toBe(false);
  });

  test("formatUnifiedDiff returns empty string when sides are identical", () => {
    expect(formatUnifiedDiff("a\nb\n", "a\nb\n", "skills/x")).toBe("");
  });

  test("formatUnifiedDiff renders a familiar header + line markers", () => {
    const out = formatUnifiedDiff("one\ntwo", "one\nTWO", "skills/x");
    const lines = out.split("\n");
    expect(lines[0]).toBe("--- skills/x (existing)");
    expect(lines[1]).toBe("+++ skills/x (proposed)");
    expect(lines[2]).toBe("@@ 1,2 1,2 @@");
    // Unchanged line kept with a leading space; changed line shows -/+ pair.
    expect(out).toContain(" one");
    expect(out).toContain("-two");
    expect(out).toContain("+TWO");
  });

  test("rejects rows without the current proposal envelope", () => {
    expect(() => proposalRowToProposal(historicalRow)).toThrow(/missing changes/i);
  });

  test("rejects malformed JSON and malformed present envelope fields", () => {
    expect(() => proposalRowToProposal({ ...historicalRow, metadata_json: "{" })).toThrow(/metadata_json/i);
    expect(() => proposalRowToProposal({ ...historicalRow, frontmatter_json: "[]" })).toThrow(/frontmatter_json/i);
    expect(() =>
      proposalRowToProposal({
        ...historicalRow,
        metadata_json: JSON.stringify({ changes: [{ path: 1, op: "create" }] }),
      }),
    ).toThrow(/changes/i);
    expect(() =>
      proposalRowToProposal({
        ...historicalRow,
        metadata_json: JSON.stringify({
          changes: [{ path: "lessons/history.md", op: "update" }],
          proposedTarget: { source: "team" },
        }),
      }),
    ).toThrow(/proposedTarget/i);
  });

  test("current proposal envelopes round-trip", () => {
    const proposal = proposalRowToProposal({
      ...historicalRow,
      metadata_json: JSON.stringify({
        changes: [{ path: "lessons/history.md", op: "update" }],
        proposedTarget: { source: "team", root: "/tmp/stash" },
      }),
    });
    expect(proposalToRowValues(proposal, historicalRow.stash_dir).metadata_json).toContain("proposedTarget");
  });
});
