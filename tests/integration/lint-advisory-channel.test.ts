// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The lint advisory channel and the workflow frontend pass behind it.
 *
 * Two properties, both about routing a NON-FATAL finding correctly:
 *   • `ADVISORY_LINT_ISSUES` is the single home for "never `flagged`", so the
 *     adapter path and the sweep cannot disagree about a code and let a
 *     non-fatal hint fail `--fail-on-flagged` (exit 1) on one path only.
 *   • `workflowStructureDiagnostics` / `workflowCompileWarnings` are two views
 *     of ONE parse+compile, so asking for both must not re-run the frontend —
 *     and must never serve an answer computed for different bytes.
 */

import { describe, expect, test } from "bun:test";
import { ADVISORY_LINT_ISSUES, isAdvisoryLintIssue } from "../../src/commands/lint/types";
import { workflowCompileWarnings, workflowStructureDiagnostics } from "../../src/core/adapter/adapters/akm-lint";
import { workflowDoc } from "../_helpers/workflow";

const REL = "workflows/advisory.md";
const PARSE_PATH = "/stash/workflows/advisory.md";

/** Compiles cleanly, but the step declares no `output:` schema — one advisory. */
const WARNS = workflowDoc([]);
/** Fails the schema-definition check — errors, and therefore no advisories. */
const ERRORS = workflowDoc(["    output:", "      type: strig"]);

describe("advisory issue classification", () => {
  test("workflow-warning is advisory and ordinary findings are not", () => {
    expect(isAdvisoryLintIssue({ issue: "workflow-warning" })).toBe(true);
    for (const issue of ["invalid-workflow-structure", "placeholder-stub", "adapter-diagnostic", "broken-xref"]) {
      expect(isAdvisoryLintIssue({ issue })).toBe(false);
    }
  });

  test("every advisory code the frontend emits is registered", () => {
    const emitted = workflowCompileWarnings(REL, WARNS, PARSE_PATH);
    expect(emitted.length).toBeGreaterThan(0);
    for (const diagnostic of emitted) {
      expect(ADVISORY_LINT_ISSUES.has(diagnostic.issue)).toBe(true);
    }
  });
});

describe("workflow frontend pass", () => {
  test("both views agree, and a compile warning never rides the error channel", () => {
    expect(workflowStructureDiagnostics(REL, WARNS, PARSE_PATH)).toEqual([]);
    expect(workflowCompileWarnings(REL, WARNS, PARSE_PATH).map((d) => d.issue)).toEqual(["workflow-warning"]);
  });

  test("a document that fails to compile reports errors and no advisories", () => {
    expect(workflowStructureDiagnostics(REL, ERRORS, PARSE_PATH).length).toBeGreaterThan(0);
    expect(workflowCompileWarnings(REL, ERRORS, PARSE_PATH)).toEqual([]);
  });

  test("changed bytes are never served a previous file's answer", () => {
    // Same relPath and parsePath, different content, interleaved — the shape a
    // `--fix` rewrite produces. Each answer must describe the bytes passed in.
    expect(workflowCompileWarnings(REL, WARNS, PARSE_PATH).length).toBe(1);
    expect(workflowCompileWarnings(REL, ERRORS, PARSE_PATH).length).toBe(0);
    expect(workflowStructureDiagnostics(REL, ERRORS, PARSE_PATH).length).toBeGreaterThan(0);
    expect(workflowStructureDiagnostics(REL, WARNS, PARSE_PATH)).toEqual([]);
    expect(workflowCompileWarnings(REL, WARNS, PARSE_PATH).length).toBe(1);
  });
});
