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
 * fixtures below. The former compile-stage reference case is restored against
 * the unified markdown format. One case from the original file has no home
 * under the new format and is intentionally NOT re-created:
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
  "updated: 2026-07-30",
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
  test("a well-formed unified workflow produces no findings", async () => {
    const stashDir = makeTempStash();
    writeWorkflowFile(stashDir, "clean.md", CLEAN_WORKFLOW);

    const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });

    expect(result.flagged).toHaveLength(0);
  });

  test("README documentation in the workflows directory is not treated as a workflow asset", async () => {
    const stashDir = makeTempStash();
    writeWorkflowFile(stashDir, "README.md", "# Workflow documentation\n");

    const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });

    expect(result.flagged).toHaveLength(0);
  });

  test("a workflow missing the required `steps` list is a parse-stage finding", async () => {
    const stashDir = makeTempStash();
    writeWorkflowFile(
      stashDir,
      "no-steps.md",
      ["---", "type: workflow", "description: No steps", "---", ""].join("\n"),
    );

    const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });

    const structural = result.flagged.filter((i) => i.issue === "invalid-workflow-structure");
    expect(structural).toHaveLength(1);
    expect(structural[0]!.file).toContain("no-steps.md");
    expect(structural[0]!.detail).toContain('"steps" is required');
  });

  test("a reference to a missing step is a compile-stage finding", async () => {
    const stashDir = makeTempStash();
    writeWorkflowFile(
      stashDir,
      "missing-step.md",
      [
        "---",
        "type: workflow",
        "updated: 2026-07-30",
        "steps:",
        "  - id: consume",
        "    inputs: [steps.ghost.output]",
        "---",
        "",
        "## consume",
        "",
        "Use it.",
        "",
      ].join("\n"),
    );

    const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });

    const structural = result.flagged.filter((i) => i.issue === "invalid-workflow-structure");
    expect(structural).toHaveLength(1);
    expect(structural[0]?.detail).toContain('"ghost" is not a step in this workflow');
  });

  test("a reference to a later step is a compile-stage finding", async () => {
    const stashDir = makeTempStash();
    writeWorkflowFile(
      stashDir,
      "later-step.md",
      [
        "---",
        "type: workflow",
        "updated: 2026-07-30",
        "steps:",
        "  - id: first",
        "    inputs: [steps.second.output]",
        "  - id: second",
        "---",
        "",
        "## first",
        "",
        "Use it.",
        "",
        "## second",
        "",
        "Produce it.",
        "",
      ].join("\n"),
    );

    const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });

    const structural = result.flagged.filter((i) => i.issue === "invalid-workflow-structure");
    expect(structural).toHaveLength(1);
    expect(structural[0]?.detail).toContain("does not come before this step");
  });

  test("a param declared as a step input is a compile-stage finding", async () => {
    const stashDir = makeTempStash();
    writeWorkflowFile(
      stashDir,
      "param-input.md",
      [
        "---",
        "type: workflow",
        "updated: 2026-07-30",
        "steps:",
        "  - id: consume",
        "    inputs: [params.payload]",
        "---",
        "",
        "## consume",
        "",
        "Use it.",
        "",
      ].join("\n"),
    );

    const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });

    const structural = result.flagged.filter((i) => i.issue === "invalid-workflow-structure");
    expect(structural).toHaveLength(1);
    expect(structural[0]?.detail).toContain("names a param, not a step output");
  });

  test("a clean workflow alongside a structurally-broken one: each is checked independently", async () => {
    const stashDir = makeTempStash();
    writeWorkflowFile(stashDir, "release.md", CLEAN_WORKFLOW);
    writeWorkflowFile(stashDir, "broken.md", ["---", "type: workflow", "description: Broken", "---", ""].join("\n"));

    const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });

    const structural = result.flagged.filter((i) => i.issue === "invalid-workflow-structure");
    expect(structural).toHaveLength(1);
    expect(structural[0]!.file).toContain("broken.md");
  });
});
