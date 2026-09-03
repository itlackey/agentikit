// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Issue 4 — an inline `uses: akm/command` step's `with: {content}` used to be
 * scanned for native-tool-only template constructs (`@file`, bare `$NAME`,
 * `${...}`, …) whenever it contained `$ARGUMENTS` or declared `arguments:`.
 * `content: "Review $ARGUMENTS against @docs/style-guide.md"` failed to
 * compile, though the identical prose written as a markdown step's body
 * (always `commandMode: "literal"`, `source-ir/compile.ts`) was fine. The
 * scan is removed at every point it reached inline workflow content — source
 * compile (`source-ir/semantics.ts`), asset loading's display instructions
 * (`source-ir/program.ts`), and freeze's actual dispatch preparation
 * (`freeze/targets/command.ts`, which now substitutes `$ARGUMENTS` itself and
 * hands the shared executor already-resolved literal text) — while a STORED
 * `uses: commands/<ref>` keeps the real scan: that content is a genuinely
 * portable, reusable command file.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, resetConfigCache } from "../../../src/core/config/config";
import { akmIndex } from "../../../src/indexer/indexer";
import { compileResolveFreezeWorkflowV4 } from "../../../src/workflows/ir/freeze-v4";
import { loadWorkflowAsset } from "../../../src/workflows/runtime/workflow-asset-loader";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
  resetConfigCache();
});

afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

function write(relative: string, content: string): void {
  const file = path.join(storage.stashDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function yamlWorkflow(stepYaml: string): string {
  return [
    "name: Gated",
    "on: { workflow_dispatch: null }",
    "jobs:",
    "  main:",
    "    runs-on: [self-hosted]",
    "    steps:",
    stepYaml,
    "",
  ].join("\n");
}

describe("inline akm/command content is never scanned for native-tool constructs (issue 4)", () => {
  test("compiles, loads, and freezes end to end — @file mention alongside $ARGUMENTS is plain prose", async () => {
    write(
      "workflows/gated.yml",
      yamlWorkflow(
        [
          "      - id: review",
          "        uses: akm/command",
          "        with:",
          "          content: Review $ARGUMENTS against @docs/style-guide.md",
          "          arguments: the diff",
        ].join("\n"),
      ),
    );

    const asset = await loadWorkflowAsset("workflows/gated");
    // Display instructions (workflow-asset-loader.ts / akm show) never
    // scanned, and $ARGUMENTS is substituted the same way dispatch will.
    expect(asset.steps[0]?.instructions).toBe("Review the diff against @docs/style-guide.md");

    const frozen = await compileResolveFreezeWorkflowV4(asset, loadConfig());
    const target = frozen.plan.steps[0]?.root;
    if (!target || target.kind !== "unit" || target.frozenTarget.kind !== "command") {
      throw new Error("expected a frozen command unit");
    }
    expect(target.frozenTarget.request.command.content).toBe("Review the diff against @docs/style-guide.md");
  });

  test("a STORED commands/<ref> action keeps the real scan — a genuinely portable file is still protected", async () => {
    write("commands/review.md", "Review $ARGUMENTS against @native/tool-construct\n");
    write(
      "workflows/stored.yml",
      yamlWorkflow(
        [
          "      - id: review",
          "        uses: akm/command",
          "        with:",
          "          ref: commands/review",
          "          arguments: the diff",
        ].join("\n"),
      ),
    );

    await akmIndex({ stashDir: storage.stashDir, full: true });
    const asset = await loadWorkflowAsset("workflows/stored");
    await expect(compileResolveFreezeWorkflowV4(asset, loadConfig())).rejects.toThrow(
      /unsupported portable template construct/i,
    );
  });
});
