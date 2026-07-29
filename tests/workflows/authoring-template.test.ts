// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pins that the shipped YAML workflow-program template
 * (`src/workflows/authoring/workflow-program-template.yaml`, printed by
 * `akm workflow create <name>.yaml --print`) actually parses AND compiles.
 *
 * This used to be asserted only by
 * `tests/integration/node-compat.test.ts` ("workflow create --print --yaml
 * round-trips through lint on Node"), which is gated behind
 * `AKM_NODE_COMPAT_TESTS=1` and does not run in `bun run check` or default CI
 * — so nothing actually pinned the template in the normal test run. This
 * in-process test runs unconditionally and is cheap (no subprocess, no
 * `dist/` build) so a broken template fails fast.
 */

import { describe, expect, test } from "bun:test";
import { getWorkflowProgramTemplate } from "../../src/workflows/authoring/authoring";
import { compileWorkflowProgram } from "../../src/workflows/ir/compile";
import { parseWorkflowProgram } from "../../src/workflows/program/parser";

describe("shipped workflow program template", () => {
  test("parses and compiles cleanly", () => {
    const yamlText = getWorkflowProgramTemplate();

    const parsed = parseWorkflowProgram(yamlText, { path: "workflows/template.yaml" });
    if (!parsed.ok) {
      throw new Error(`template parse failed: ${parsed.errors.map((e) => `${e.line}: ${e.message}`).join(" | ")}`);
    }

    const compiled = compileWorkflowProgram(parsed.program);
    if (!compiled.ok) {
      throw new Error(`template compile failed: ${compiled.errors.map((e) => `${e.line}: ${e.message}`).join(" | ")}`);
    }

    expect(parsed.ok).toBe(true);
    expect(compiled.ok).toBe(true);
  });
});
