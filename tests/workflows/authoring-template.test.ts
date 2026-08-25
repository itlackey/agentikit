// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pins that the shipped workflow template
 * (`src/assets/workflows/workflow-template.md`, printed by `akm workflow
 * create <name> --print`) actually parses AND compiles under the unified
 * workflow format (workflow-format-unification). One template now — the
 * pre-unification YAML-program template test is gone along with the format.
 *
 * NOTE: `src/assets/workflows/workflow-template.md` is owned by a parallel
 * agent updating it to the unified format; until that lands this test is
 * expected to fail (the file still uses the pre-unification grammar).
 */

import { describe, expect, test } from "bun:test";
import { getWorkflowTemplate } from "../../src/workflows/authoring/authoring";
import { compileWorkflowPlan } from "../../src/workflows/ir/compile";
import { compileWorkflowSource } from "../../src/workflows/source-ir/compile";

describe("shipped workflow template", () => {
  test("parses and compiles cleanly", () => {
    const markdown = getWorkflowTemplate();

    const source = compileWorkflowSource(markdown, { path: "workflows/template.md" });
    if (!source.ok) {
      throw new Error(`template compile failed: ${source.errors.map((e) => `${e.line}: ${e.message}`).join(" | ")}`);
    }

    const compiled = compileWorkflowPlan(source.ir, "template");
    if (!compiled.ok) {
      throw new Error(`template compile failed: ${compiled.errors.map((e) => `${e.line}: ${e.message}`).join(" | ")}`);
    }

    expect(source.ok).toBe(true);
    expect(compiled.ok).toBe(true);
  });
});
