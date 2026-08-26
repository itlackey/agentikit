// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P1a diagnostics (D7) meta-tests — mirrors the shrink-only-ratchet style of
 * `tests/architecture/src-fn-size-ratchet.test.ts` and the AST-based boundary
 * checks in `tests/architecture/registry-network-boundary.test.ts`.
 *
 * See docs/plans/specs/p1a-with-rejection-classifier.md §9. Two independent
 * assertions:
 *
 *  1. The `INVALID_FLAG_VALUE` code ratchet: counts literal occurrences of
 *     that string across `src/tasks/**` + `src/workflows/**` and asserts the
 *     count never grows past a hardcoded baseline. The baseline only ever
 *     DECLINES — a later phase that re-codes more sites lowers it; nothing
 *     may raise it, because a raised count means a new `INVALID_FLAG_VALUE`
 *     throw was added to task/workflow code, exactly what this ratchet
 *     exists to prevent.
 *
 *  2. The classification import seam: `src/workflows/source-ir/semantics.ts`
 *     and `src/workflows/source-ir/uses.ts` must import NOTHING from
 *     `src/tasks/source-v3.ts`, and `src/workflows/source-ir/compile.ts`
 *     must import ONLY `classifyTaskV3Triggers` from it. This is what keeps
 *     spec §4.2/§4.4 (the Lane B classifier seam) from silently regressing
 *     back onto the task-v3 grammar.
 *
 * TEST-FIRST NOTE: this file is authored under Lane C (tests) before the
 * Lane 0/Lane B implementation lands. Both assertions below are EXPECTED TO
 * FAIL at the point this file is committed:
 *   - Assertion 1's baseline is a placeholder (see the TODO on
 *     INVALID_FLAG_VALUE_BASELINE) — it fails until the implementer re-codes
 *     the `sourceError` funnel (spec §2.2) and hardcodes the measured count.
 *   - Assertion 2 fails until Lane B rewires `uses.ts`/`semantics.ts`/
 *     `compile.ts` per spec §4.2-§4.4 — today `uses.ts` still imports
 *     `classifyTaskV3Uses` directly and `compile.ts` still imports it
 *     alongside `classifyTaskV3Triggers`.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dir, "../..");
const TASKS_DIR = path.join(ROOT, "src/tasks");
const WORKFLOWS_DIR = path.join(ROOT, "src/workflows");
const SEMANTICS_FILE = path.join(WORKFLOWS_DIR, "source-ir/semantics.ts");
const USES_FILE = path.join(WORKFLOWS_DIR, "source-ir/uses.ts");
const COMPILE_FILE = path.join(WORKFLOWS_DIR, "source-ir/compile.ts");

/** Recursively collect `.ts` files under `dir` (mirrors scripts/lint-license-headers.ts's collectTs). */
function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      results.push(full);
    }
  }
  return results;
}

/** Count files-scanned LINES containing `needle` (mirrors `grep -rn needle ... | wc -l`: one count per matching line, not per occurrence). */
function countLinesContaining(files: readonly string[], needle: string): number {
  let count = 0;
  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    for (const line of content.split("\n")) {
      if (line.includes(needle)) count += 1;
    }
  }
  return count;
}

// ── Assertion 1: the INVALID_FLAG_VALUE code ratchet (spec §9) ─────────────

// Pre-P1a measurement (this branch, verified by Lane C the same day the spec
// records it): `grep -rn "INVALID_FLAG_VALUE" src/tasks/ src/workflows/ | wc -l`
// = 83.
//
// TODO(implementer): spec §9 expects **82** post-P1a — the `sourceError`
// funnel's single throw site (src/tasks/source-v3.ts:225) re-codes to
// `TASK_SOURCE_INVALID`; Lane A's new rejection throws `COMPOSITION_INVALID`,
// not `INVALID_FLAG_VALUE`, so it does not add to this count. Re-measure with
// the grep command above AFTER landing the source-v3.ts re-code (spec §2.2)
// and REPLACE the placeholder 0 below with the measured number — do not copy
// 82 on faith, and do not raise this value for any other reason.
//
// The baseline only ever DECLINES. A later phase that re-codes more
// `INVALID_FLAG_VALUE` sites lowers it further; nothing may raise it.
const INVALID_FLAG_VALUE_BASELINE = 0; // PLACEHOLDER — see TODO above. Currently fails (live count is 83).

// ── Assertion 2: the classification import seam (spec §9 / §4.2 / §4.4) ────

/** Named + default bindings a file imports from a module whose specifier includes `moduleSubstring`, sorted. */
function importBindingsFrom(file: string, moduleSubstring: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const bindings: string[] = [];
  source.forEachChild((node) => {
    if (!ts.isImportDeclaration(node)) return;
    if (!ts.isStringLiteral(node.moduleSpecifier)) return;
    if (!node.moduleSpecifier.text.includes(moduleSubstring)) return;
    const clause = node.importClause;
    if (!clause) return;
    if (clause.name) bindings.push(clause.name.text);
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) bindings.push(element.name.text);
    }
  });
  return bindings.sort();
}

describe("D7 diagnostics ratchet (spec p1a-with-rejection-classifier.md §9)", () => {
  test("INVALID_FLAG_VALUE occurrences in src/tasks/** + src/workflows/** never exceed the post-P1a baseline", () => {
    const files = [...collectTsFiles(TASKS_DIR), ...collectTsFiles(WORKFLOWS_DIR)];
    const count = countLinesContaining(files, "INVALID_FLAG_VALUE");
    if (count > INVALID_FLAG_VALUE_BASELINE) {
      throw new Error(
        `INVALID_FLAG_VALUE ratchet violated: found ${count} matching line(s) across src/tasks/** + ` +
          `src/workflows/**, baseline is ${INVALID_FLAG_VALUE_BASELINE}.\n` +
          "The baseline in this file only ever DECLINES. If this is the P1a implementer landing the " +
          "source-v3.ts sourceError re-code (spec §2.2), re-measure with " +
          '`grep -rn "INVALID_FLAG_VALUE" src/tasks/ src/workflows/ | wc -l` and hardcode the real ' +
          "measured count on INVALID_FLAG_VALUE_BASELINE (spec expects 82). If this is any other change, " +
          "it added a new INVALID_FLAG_VALUE throw to task/workflow code — recode it to a more specific " +
          "UsageError code instead of lowering the ratchet's bar.",
      );
    }
    expect(count).toBeLessThanOrEqual(INVALID_FLAG_VALUE_BASELINE);
  });

  test("semantics.ts and uses.ts import nothing from tasks/source-v3; compile.ts imports only classifyTaskV3Triggers from it", () => {
    expect(importBindingsFrom(SEMANTICS_FILE, "tasks/source-v3")).toEqual([]);
    expect(importBindingsFrom(USES_FILE, "tasks/source-v3")).toEqual([]);
    expect(importBindingsFrom(COMPILE_FILE, "tasks/source-v3")).toEqual(["classifyTaskV3Triggers"]);
  });
});
