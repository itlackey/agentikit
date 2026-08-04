// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The proposal-promotion pre-commit gate — `BundleAdapter.validate()`'s OTHER
 * stated consumer (`core/adapter/bundle-adapter.ts` doc comment, alongside
 * `lint --fix`), wired in `commands/proposal/repository.ts#runAdapterPreCommitCheck`.
 *
 * Deliberately ADVISORY (see that function's doc comment for the full
 * rationale): it runs the real `akmAdapter.validate()` — with a
 * `createValidateContext` overlay carrying the proposal's about-to-be-written
 * bytes — immediately before the write, and surfaces any finding via `warn()`,
 * but never blocks promotion on it. This suite proves:
 *
 *   1. the wiring genuinely runs against a REAL proposal-accept transaction
 *      (not a mock `ValidateContext`) and finds a real diagnostic the
 *      EXISTING `promotionLintBlockers` gate does not catch;
 *   2. that diagnostic does NOT block acceptance (the disclosed non-blocking
 *      scope decision, proven empirically, not just asserted in a comment);
 *   3. a clean proposal produces no adapter warning at all;
 *   4. a proposal that already fails today's `promotionLintBlockers` gate
 *      still fails exactly the same way (this addition changes nothing about
 *      existing blocking behavior).
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmProposalAccept } from "../../../src/commands/proposal/proposal";
import { createProposal as createProposalImpl, isProposalSkipped } from "../../../src/commands/proposal/repository";
import { _setWarnSinkForTests } from "../../../src/core/warn";
import { makeConfig } from "../../_helpers/factories";
import { overrideSeam } from "../../_helpers/seams";

const tempDirs: string[] = [];

function makeStashDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-proposal-precommit-"));
  tempDirs.push(dir);
  for (const sub of ["lessons", "memories"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  return dir;
}

function createProposal(stashDir: string, input: Parameters<typeof createProposalImpl>[1]) {
  return createProposalImpl(stashDir, {
    ...input,
    target: input.target ?? { source: "stash", root: path.resolve(stashDir) },
  });
}

function captureWarnings(): string[] {
  const calls: string[] = [];
  overrideSeam(_setWarnSinkForTests, (level, args) => {
    if (level !== "warn") return;
    calls.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  });
  return calls;
}

const CLEAN_LESSON =
  "---\ndescription: Use ripgrep before grep\nwhen_to_use: Searching large repos for patterns\n---\n\nPrefer rg over grep when scanning large code repos.\n";

// A body ref (`other//docs/readme`) whose leading segment ("docs") is NOT a
// registered AKM placement type. The EXISTING `promotionLintBlockers` gate
// (legacy `commands/lint/base-linter.ts#checkMissingRefs`) treats an
// unrecognized type prefix as "not locally checkable, skip it" and never
// flags it. The adapter pre-commit check's core `resolveRef` additionally
// tries the ref as a literal on-disk path (the resolution OKF/llm-wiki need
// for their own conceptIds) and DOES report it missing — the exact,
// documented divergence this suite pins.
const FOREIGN_REF_LESSON =
  "---\ndescription: Cross-bundle pointer\nwhen_to_use: Testing the pre-commit adapter check\n---\n\n" +
  "See other//docs/readme for background.\n";

describe("proposal promotion pre-commit adapter check (advisory)", () => {
  test("a diagnostic the legacy promotionLintBlockers gate does not catch is surfaced via warn(), but does not block acceptance", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    const warnings = captureWarnings();

    const created = createProposal(stash, {
      ref: "lessons/foreign-ref",
      source: "distill",
      sourceRun: "run-1",
      force: true,
      payload: { content: FOREIGN_REF_LESSON },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");

    const accepted = await akmProposalAccept({ stashDir: stash, id: created.id, config });
    expect(accepted.ok).toBe(true);
    expect(fs.existsSync(accepted.assetPath)).toBe(true);

    const hit = warnings.find((w) => w.includes("pre-commit adapter check") && w.includes(created.id));
    expect(hit).toBeDefined();
    expect(hit).toContain("missing-ref");
    expect(hit).toContain("non-blocking");
  });

  test("a clean proposal produces no pre-commit adapter warning", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    const warnings = captureWarnings();

    const created = createProposal(stash, {
      ref: "lessons/clean",
      source: "distill",
      sourceRun: "run-2",
      force: true,
      payload: { content: CLEAN_LESSON },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");

    const accepted = await akmProposalAccept({ stashDir: stash, id: created.id, config });
    expect(accepted.ok).toBe(true);

    expect(warnings.some((w) => w.includes("pre-commit adapter check"))).toBe(false);
  });

  test("an existing blocking finding (missing-ref via promotionLintBlockers) still rejects exactly as before", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);

    // A qualified ref whose leading segment IS a real AKM placement type
    // (`memories`) but whose target does not exist — the legacy resolver DOES
    // check this one (typeNameFromConceptId resolves it), so it was already a
    // blocking `missing-ref` before this change.
    const blockedContent =
      "---\ndescription: Points at a real type, missing target\nwhen_to_use: Pinning the still-blocking case\n---\n\n" +
      "See stash//memories/does-not-exist for context.\n";
    const created = createProposal(stash, {
      ref: "lessons/still-blocked",
      source: "distill",
      sourceRun: "run-3",
      force: true,
      payload: { content: blockedContent },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");

    await expect(akmProposalAccept({ stashDir: stash, id: created.id, config })).rejects.toThrow(/failed lint/i);
  });
});
