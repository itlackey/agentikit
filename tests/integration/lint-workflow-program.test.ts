// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm lint --type workflows` structural coverage for YAML workflow *programs*
 * (`.yaml`/`.yml`), closing the gap left by dropping `workflow validate`
 * (0.9.0 CLI overhaul, S5): lint used to scan only markdown workflow
 * documents (`collectMarkdownFiles` filters `.md`), so a YAML program's
 * parse/compile errors were invisible to `akm lint` — the only surface that
 * caught them was the now-removed `workflow validate <path|ref>` command.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmLint } from "../../src/commands/lint/index";

const tempDirs: string[] = [];

function makeTempStash(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-lint-workflow-program-"));
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

describe("akm lint --type workflows — YAML workflow programs", () => {
  test("a well-formed program produces no invalid-workflow-structure findings", () => {
    const stashDir = makeTempStash();
    writeWorkflowFile(
      stashDir,
      "clean.yaml",
      ["version: 2", "name: clean", "steps:", "  - id: only", "    unit:", "      instructions: Do it."].join("\n"),
    );

    const result = akmLint({ dir: stashDir, typeFilter: "workflows" });

    const structural = result.flagged.filter((i) => i.issue === "invalid-workflow-structure");
    expect(structural).toHaveLength(0);
  });

  test("a program missing the required `steps` list is a parse-stage finding", () => {
    const stashDir = makeTempStash();
    writeWorkflowFile(stashDir, "no-steps.yaml", "version: 2\nname: no-steps\n");

    const result = akmLint({ dir: stashDir, typeFilter: "workflows" });

    const structural = result.flagged.filter((i) => i.issue === "invalid-workflow-structure");
    expect(structural).toHaveLength(1);
    expect(structural[0]!.file).toContain("no-steps.yaml");
    expect(structural[0]!.detail).toContain('"steps" is required');
  });

  test("a program referencing a nonexistent step output is a compile-stage finding", () => {
    const stashDir = makeTempStash();
    writeWorkflowFile(
      stashDir,
      "bad-ref.yaml",
      [
        "version: 2",
        "name: bad-ref",
        "steps:",
        "  - id: only",
        "    unit:",
        "      instructions: Review ${{ steps.nope.output.files }}.",
      ].join("\n"),
    );

    const result = akmLint({ dir: stashDir, typeFilter: "workflows" });

    const structural = result.flagged.filter((i) => i.issue === "invalid-workflow-structure");
    expect(structural).toHaveLength(1);
    expect(structural[0]!.detail).toContain("cannot be resolved");
  });

  test("a markdown workflow alongside a broken program: each is checked independently", () => {
    const stashDir = makeTempStash();
    writeWorkflowFile(
      stashDir,
      "release.md",
      [
        "---",
        "description: Release workflow",
        "---",
        "",
        "# Workflow: Release",
        "",
        "## Step: Only Step",
        "Step ID: only-step",
        "",
        "### Instructions",
        "Ship it.",
        "",
      ].join("\n"),
    );
    writeWorkflowFile(stashDir, "broken.yaml", "version: 2\nname: broken\n");

    const result = akmLint({ dir: stashDir, typeFilter: "workflows" });

    const structural = result.flagged.filter((i) => i.issue === "invalid-workflow-structure");
    expect(structural).toHaveLength(1);
    expect(structural[0]!.file).toContain("broken.yaml");
  });
});
