// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm lint --type workflows` structural coverage.
 *
 * Ported for workflow-format-unification: the YAML workflow *program*
 * (`.yaml`/`.yml`) this file originally covered is deleted as a distinct
 * on-disk format (spec §3). `akm commands/lint/index.ts` now collects only
 * `.md` files for the `workflows` subdir ("workflows, one markdown format
 * now, is .md") — a stray `.yaml`/`.yml` file under `workflows/` is not
 * scanned at all, so there is no lint-time equivalent of "a YAML program is
 * malformed" left to pin. Surviving coverage (clean workflow → no findings;
 * a structurally-broken workflow → a parse-stage finding; independence
 * across files in the same stash) is folded into unified-format markdown
 * fixtures below. Two cases from the original file have no home under the
 * new format and are intentionally NOT re-created (see comments at each
 * former test's slot):
 *
 *   - "a program referencing a nonexistent step output is a compile-stage
 *     finding" — reference resolution (`inputs:`/`map.over`/`route.input`
 *     pointing at a step that doesn't exist) is a `compileWorkflowPlan`
 *     (ir/compile.ts) error, not a `parseWorkflow` one. `akm lint`'s workflow
 *     check (`workflowStructureDiagnostics` in
 *     src/core/adapter/adapters/akm-lint.ts) calls only `parseWorkflow` —
 *     it never runs the compile stage. So a dangling reference in a
 *     workflow's frontmatter is INVISIBLE to `akm lint --type workflows`
 *     under the unified format; this is a real coverage gap, reported as src
 *     feedback rather than papered over with an assertion that cannot pass.
 *   - "a markdown workflow alongside a broken program: each is checked
 *     independently" — folded below as two markdown files (one clean, one
 *     broken) instead of markdown-vs-YAML, since YAML is no longer part of
 *     the surface at all.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmLint } from "../../src/commands/lint/index";

const tempDirs: string[] = [];

function makeTempStash(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-lint-workflow-"));
  tempDirs.push(dir);
  return dir;
}

function writeWorkflowFile(stashDir: string, name: string, content: string): string {
  const workflowsDir = path.join(stashDir, "workflows");
  fs.mkdirSync(workflowsDir, { recursive: true });
  const filePath = path.join(workflowsDir, name);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const CLEAN_WORKFLOW = [
  "---",
  "type: workflow",
  "description: Clean workflow",
  "steps:",
  "  - id: only",
  "---",
  "",
  "## only",
  "",
  "Do it.",
  "",
].join("\n");

describe("akm lint --type workflows", () => {
  test("a well-formed unified workflow produces no invalid-workflow-structure findings", () => {
    const stashDir = makeTempStash();
    writeWorkflowFile(stashDir, "clean.md", CLEAN_WORKFLOW);

    const result = akmLint({ dir: stashDir, typeFilter: "workflows" });

    const structural = result.flagged.filter((i) => i.issue === "invalid-workflow-structure");
    expect(structural).toHaveLength(0);
  });

  test("a workflow missing the required `steps` list is a parse-stage finding", () => {
    const stashDir = makeTempStash();
    writeWorkflowFile(
      stashDir,
      "no-steps.md",
      ["---", "type: workflow", "description: No steps", "---", ""].join("\n"),
    );

    const result = akmLint({ dir: stashDir, typeFilter: "workflows" });

    const structural = result.flagged.filter((i) => i.issue === "invalid-workflow-structure");
    expect(structural).toHaveLength(1);
    expect(structural[0]!.file).toContain("no-steps.md");
    expect(structural[0]!.detail).toContain('"steps" is required');
  });

  test("a clean workflow alongside a structurally-broken one: each is checked independently", () => {
    const stashDir = makeTempStash();
    writeWorkflowFile(stashDir, "release.md", CLEAN_WORKFLOW);
    writeWorkflowFile(stashDir, "broken.md", ["---", "type: workflow", "description: Broken", "---", ""].join("\n"));

    const result = akmLint({ dir: stashDir, typeFilter: "workflows" });

    const structural = result.flagged.filter((i) => i.issue === "invalid-workflow-structure");
    expect(structural).toHaveLength(1);
    expect(structural[0]!.file).toContain("broken.md");
  });
});
