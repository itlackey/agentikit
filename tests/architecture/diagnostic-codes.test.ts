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
 *  1. The `INVALID_FLAG_VALUE` code TERMINAL baseline (P4,
 *     docs/plans/specs/p4-deletions-closeout.md §5.2, row B-59): counts
 *     literal occurrences of that string (line-based, mirroring
 *     `grep -rn ... | wc -l`) across `src/tasks/**` + `src/workflows/**` and
 *     asserts the count never exceeds a hardcoded baseline. P4's §5.2
 *     re-coding sweep drove every site outside the classification rule's two
 *     KEEP categories — (a) a scalar value a user typed as a CLI flag or
 *     positional argument, or an argv-projected scheduler binding value; (b)
 *     a membership entry in a code allowlist — onto a phase-specific
 *     `UsageErrorCode`. The baseline below is that TERMINAL count: the
 *     survivors are enumerated in the comment on INVALID_FLAG_VALUE_BASELINE,
 *     and any INCREASE is a defect, not a number to re-measure and accept —
 *     P4 was the last phase authorized to lower it by re-coding, and none
 *     remains to re-code.
 *
 *  2. The classification import seam: `src/workflows/source-ir/semantics.ts`,
 *     `src/workflows/source-ir/uses.ts`, and `src/workflows/source-ir/compile.ts`
 *     must import NOTHING from `src/tasks/source-v3.ts` (P4
 *     docs/plans/specs/p4-deletions-closeout.md §3.2.3, row B-60:
 *     `compile.ts`'s former one exception, `classifyTaskV3Triggers`, is
 *     re-homed to `src/workflows/source-ir/triggers.ts` as
 *     `classifyWorkflowYamlTriggers` — after the re-home, `src/workflows/**`
 *     imports nothing at all from `src/tasks/**` source modules). This is
 *     what keeps spec §4.2/§4.4 (the Lane B classifier seam) from silently
 *     regressing back onto the task-v3 grammar. P4 §5.2/row B-60 WIDENS the
 *     scan beyond named/default static imports to also catch namespace
 *     imports (`import * as ns from "..."`), `export ... from` re-exports,
 *     `import(...)` type queries (`type T = import("...").Foo`), and dynamic
 *     `import()` calls — anywhere in the file, not only at the top level —
 *     so the seam holds against every import-evasion shape P1a's close-out
 *     flagged, not merely the one shape the original assertion checked.
 *
 * STATUS: this file was authored under Lane C (tests) ahead of the Lane
 * 0/Lane B implementation landing, so both assertions were originally
 * written red-first. Both are measured true as of this commit:
 *   - Assertion 1's baseline is P4 Lane C's TERMINAL measurement — see the
 *     comment on INVALID_FLAG_VALUE_BASELINE below for the exact grep, the
 *     per-file breakdown, and the three individually-recorded deviations from
 *     spec §5.2's own predicted count. It is not a forward guess.
 *   - Assertion 2 passes now that Lane B rewired `uses.ts`/`semantics.ts`/
 *     `compile.ts` per spec §4.2-§4.4, P4 (§3.2.3, row B-60) re-homed
 *     `compile.ts`'s former exception out of `tasks/source-v3` entirely, and
 *     this same P4 Lane C commit widened the scan itself (above): none of the
 *     three files reference `tasks/source-v3` through any import shape.
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

// ── Assertion 1: the INVALID_FLAG_VALUE code TERMINAL baseline (spec §5.2) ─

// TERMINAL baseline: 38 — MEASURED at P4 Lane C's commit
// (`grep -rn "INVALID_FLAG_VALUE" src/tasks/ src/workflows/ | wc -l` == 38),
// after §5.2's re-coding sweep. Per-file breakdown (KEEP, rule a/b):
//   src/tasks/schedule.ts (12), src/tasks/scheduler-binding.ts (10),
//   src/tasks/task-id.ts (7), src/workflows/ir/params.ts (2),
//   src/workflows/runtime/runs.ts (2) — all rule (a): a scalar value a user
//   typed as a CLI flag/positional argument or an argv-projected scheduler
//   binding value. src/tasks/run/attempt-lifecycle.ts (2: the
//   SAFE_TASK_ATTEMPT_ERROR_CODES membership entry, rule (b), plus one
//   explanatory doc-comment line naming the code by string) = 35.
//
// Three individually-recorded deviations from §5.2's own predicted terminal
// count of 34, each a genuine preservation-gate conflict, not an oversight:
//   +1 src/tasks/prepare/prepare.ts — the workflow-target `env:` guard's code
//      is PRESERVED, not re-coded to COMPOSITION_INVALID as §5.2's table
//      predicted, because tests/integration/tasks-with-classification-characterization.test.ts's
//      P-04 block (F-A2.8: CONVERT, assertions unchanged) pins this exact
//      code — P0's own "stays pinned" disposition (spec §5.5) wins over the
//      generic table entry.
//   +1 src/workflows/freeze/environment.ts — `resolveOwnedAsset`'s
//      "Workflow source target ... was not found" throw is PRESERVED, not
//      re-coded to WORKFLOW_SOURCE_INVALID, because
//      tests/workflows/child-workflow-freeze.test.ts's B-11 case ("fails the
//      existing asset-resolution failure, unchanged in code and shape") pins
//      it by title.
//   +1 src/tasks/source/bounded-document.ts — one explanatory doc-comment
//      line (on the six front-end throws §5.2/row R-R8 recoded to
//      TASK_SOURCE_INVALID) names the retired code by string to explain why
//      it changed; the six throw sites themselves all carry
//      TASK_SOURCE_INVALID now.
// 35 + 3 = 38.
//
// This baseline is now TERMINAL: P4 was the phase authorized to lower it by
// re-coding (spec §5.2's classification rule), and every site outside the
// two KEEP categories above has been re-coded. Nothing may raise it — an
// increase means a new `INVALID_FLAG_VALUE` throw (or a new mention of the
// string) was added to task/workflow code, which is always a defect: either
// recode the new throw to the D7 code naming its failure family, or (for a
// genuine rule-(a)/(b) survivor) extend the per-file breakdown above in the
// same commit that raises this number, with the same individually-recorded
// justification standard the three deviations above set.
//
// +4 src/tasks/source/task-source-v3-frozen.ts — the FROZEN, vendored v3
//    reader (four `INVALID_FLAG_VALUE` throws inside `classifyTaskV3Uses`,
//    unmodified). It previously lived in
//    `scripts/akm-migrate/migrate/task-source-v3-frozen.ts`, outside this
//    assertion's `src/tasks/**`+`src/workflows/**` scan scope; the
//    task-version read shim (upgrade-smoothness fix) moved it — body-intact,
//    mechanically — into `src/tasks/source/` alongside the pure v2->v3/v3->v4
//    migration planners so `parse-task-source.ts` could call them without
//    crossing the src->scripts import boundary (`tests/architecture/src-scripts-import-boundary.test.ts`).
//    Same already-frozen code, four throw sites newly IN SCOPE, not four new
//    mints. 38 + 4 = 42.
const INVALID_FLAG_VALUE_BASELINE = 42; // TERMINAL (spec §5.2, row B-59), +4 for the frozen v3 reader's src/ relocation — see the breakdown above. An increase beyond 42 is a defect, not a number to re-measure and accept.

// ── Assertion 2: the classification import seam (spec §9 / §4.2 / §4.4 / §5.2 row B-60) ────

/**
 * Every reference this file makes to a module whose specifier includes
 * `moduleSubstring`, through ANY import shape — named/default/namespace
 * static imports, `export ... from` re-exports, `import(...)` type queries,
 * and dynamic `import()` calls — found anywhere in the file (not only at the
 * top level, since a type query or a dynamic import can appear nested inside
 * an expression or type position). Returns a label per reference (sorted);
 * an empty array is the only passing shape for this ratchet's two
 * assertions. Widened per P4 spec §5.2/row B-60: the pre-P4 version checked
 * only named + default static imports at the top level, which a namespace
 * import, a re-export, an `import("...").T` type query, or a dynamic
 * `import()` call could each evade silently.
 */
function moduleReferencesFrom(file: string, moduleSubstring: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const references: string[] = [];

  function specifierText(node: ts.Node | undefined): string | undefined {
    return node && ts.isStringLiteral(node) ? node.text : undefined;
  }
  function matches(text: string | undefined): boolean {
    return text !== undefined && text.includes(moduleSubstring);
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && matches(specifierText(node.moduleSpecifier))) {
      const clause = node.importClause;
      if (!clause) {
        references.push("(side-effect import)");
      } else {
        if (clause.name) references.push(clause.name.text);
        if (clause.namedBindings) {
          if (ts.isNamedImports(clause.namedBindings)) {
            for (const element of clause.namedBindings.elements) references.push(element.name.text);
          } else if (ts.isNamespaceImport(clause.namedBindings)) {
            references.push(`* as ${clause.namedBindings.name.text}`);
          }
        }
      }
    }

    if (ts.isExportDeclaration(node) && matches(specifierText(node.moduleSpecifier))) {
      const exportClause = node.exportClause;
      if (!exportClause) {
        references.push("export *");
      } else if (ts.isNamespaceExport(exportClause)) {
        references.push(`export * as ${exportClause.name.text}`);
      } else {
        for (const element of exportClause.elements) references.push(`export ${element.name.text}`);
      }
    }

    // `type T = import("module").Member` — an ImportTypeNode's `argument` is
    // a TypeNode, a LiteralTypeNode wrapping the string literal for the
    // single-argument `import("module")` form.
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      matches(specifierText(node.argument.literal))
    ) {
      references.push("import type(...)");
    }

    // Dynamic `import("module")` as a call expression (SyntaxKind.ImportKeyword
    // callee) — distinct from ImportTypeNode, which is a type-position query.
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      matches(specifierText(node.arguments[0]))
    ) {
      references.push("dynamic import()");
    }

    ts.forEachChild(node, visit);
  }
  visit(source);
  return references.sort();
}

describe("D7 diagnostics ratchet (spec p1a-with-rejection-classifier.md §9, terminal per p4-deletions-closeout.md §5.2)", () => {
  test("INVALID_FLAG_VALUE occurrences in src/tasks/** + src/workflows/** never exceed the terminal baseline", () => {
    const files = [...collectTsFiles(TASKS_DIR), ...collectTsFiles(WORKFLOWS_DIR)];
    const count = countLinesContaining(files, "INVALID_FLAG_VALUE");
    if (count > INVALID_FLAG_VALUE_BASELINE) {
      throw new Error(
        `INVALID_FLAG_VALUE ratchet violated: found ${count} matching line(s) across src/tasks/** + ` +
          `src/workflows/**, TERMINAL baseline is ${INVALID_FLAG_VALUE_BASELINE} (spec ` +
          "docs/plans/specs/p4-deletions-closeout.md §5.2, row B-59). This baseline does not get re-measured " +
          "and raised to match a bigger number — P4 was the phase authorized to lower it by re-coding, and " +
          "every site outside the two KEEP categories (a CLI flag/positional/scheduler-binding scalar value, " +
          "or a code-allowlist membership entry) has been re-coded to the D7 code naming its failure family. " +
          "Recode the new throw, or — if it is a genuine rule-(a)/(b) survivor — extend the per-file " +
          "breakdown in the comment above this constant with the same individually-recorded justification " +
          "its three existing deviations carry, in the same commit that raises this number.",
      );
    }
    expect(count).toBeLessThanOrEqual(INVALID_FLAG_VALUE_BASELINE);
  });

  // P4 (docs/plans/specs/p4-deletions-closeout.md §3.2.3, row B-60) re-homes
  // classifyTaskV3Triggers to src/workflows/source-ir/triggers.ts
  // (classifyWorkflowYamlTriggers) — compile.ts now imports it from there,
  // not from tasks/source-v3, so its import list from tasks/source-v3 is
  // empty too. B-60's own WIDENED scan (namespace imports, re-exports,
  // import-type queries, dynamic import()) is implemented in
  // moduleReferencesFrom above.
  test("semantics.ts, uses.ts, and compile.ts reference nothing from tasks/source-v3 (named, namespace, re-export, import-type, or dynamic import)", () => {
    expect(moduleReferencesFrom(SEMANTICS_FILE, "tasks/source-v3")).toEqual([]);
    expect(moduleReferencesFrom(USES_FILE, "tasks/source-v3")).toEqual([]);
    expect(moduleReferencesFrom(COMPILE_FILE, "tasks/source-v3")).toEqual([]);
  });
});
