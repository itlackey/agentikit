// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Test-review remediation (spec docs/plans/specs/p2a-task-source-v4.md §3.1,
 * D2-N4) for the finding recorded against tests/tasks/source-v4.test.ts:130:
 * nothing in this phase's RED-phase suite asserted that the D2-N4 bounded-
 * document EXTRACTION — `src/tasks/source-v3.ts`'s file-private front end and
 * field helpers moving body-intact to `src/tasks/source/bounded-document.ts`
 * — actually renders BOTH source labels ("Invalid task v3 source at …" /
 * "Invalid task source v4 at …") from the SAME shared funnel. This file pins
 * that directly, in two halves:
 *
 *   1. `assertBoundedTaskYamlDocument` ALREADY takes a `sourceLabel` on its
 *      options today (source-v3.ts:799-802, exported since before P2a) — the
 *      D2-N4 seam pre-exists the extraction. The first describe block below
 *      calls it for REAL, right now, with both labels, and cross-checks the
 *      v3-labeled call against real production `parseTaskV3Yaml` output on
 *      the identical hostile YAML byte-for-byte, so the "v3 rendering is
 *      unchanged by the move" half of D2-N4 is proven by equality against
 *      production rather than a hand-copied string that could drift.
 *   2. `sourceError` — the per-field funnel EVERY structural v3/v4 error
 *      renders through — does not exist at its new home
 *      (`src/tasks/source/bounded-document.ts`) yet; §3.1's binding
 *      resolution says it "gains a sourceLabel field on its context" there.
 *      The second describe block pins both labels for it, RED, via the
 *      established one-directive namespace-import convention (see
 *      tests/tasks/source-v4.test.ts's header for the full empirical
 *      rationale: a namespace import is the only shape immune to both the
 *      TS2307-placement pitfall and biome `--write`'s same-specifier import
 *      merge, which would otherwise stack multiple pins and leave all but
 *      the last one "unused").
 *
 * Per D2-N4, `src/tasks/source-v3.ts` re-exports `assertBoundedTaskYamlDocument`
 * (and the `TASK_V3_MAX_*` bounds) at their EXISTING names once the move
 * lands, so the import below stays valid — unpinned — before and after
 * Implement.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { LineCounter, parseDocument } from "yaml";
import { UsageError } from "../../src/core/errors";
// @ts-expect-error P2a red-phase: everything from this not-yet-existing module lands in Implement
import * as BoundedDocumentModule from "../../src/tasks/source/bounded-document";
import { assertBoundedTaskYamlDocument, parseTaskV3Yaml } from "../../src/tasks/source-v3";

const { sourceError } = BoundedDocumentModule;

const ROOT = path.resolve(import.meta.dir, "../..");

/** Reused verbatim from tests/tasks/source-v3.test.ts's hostile-YAML `test.each` list (an aliased akm: mapping). */
const ALIASED_YAML = "version: 3\nuses: commands/a\nakm: &a { schedule: '@daily' }\ncopy: *a\n";
const FILE_PATH = "/bundle/tasks/hostile.yml";

/** Catch a synchronous throw once and return it (never a `.toThrow()` substring match — every pin below is byte-exact). */
function caught(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("assertBoundedTaskYamlDocument — the sourceLabel seam pre-exists the D2-N4 extraction, both labels, TODAY", () => {
  test("the v3-labeled call is byte-identical to real production parseTaskV3Yaml on the identical hostile YAML", () => {
    const productionError = caught(() => parseTaskV3Yaml({ yaml: ALIASED_YAML, filePath: FILE_PATH }));
    expect(productionError).toBeInstanceOf(UsageError);

    const lineCounter = new LineCounter();
    const document = parseDocument(ALIASED_YAML, { lineCounter, uniqueKeys: true });
    const directError = caught(() =>
      assertBoundedTaskYamlDocument(document, { filePath: FILE_PATH, sourceLabel: "task v3 source", lineCounter }),
    );
    expect(directError).toBeInstanceOf(UsageError);

    expect((directError as UsageError).message).toBe((productionError as UsageError).message);
    expect((directError as UsageError).message).toStartWith("Invalid task v3 source at");
  });

  test("the SAME hostile YAML, run through the SAME assertion with sourceLabel: 'task source v4', renders only the label swapped — byte-exact otherwise", () => {
    const v3LineCounter = new LineCounter();
    const v3Document = parseDocument(ALIASED_YAML, { lineCounter: v3LineCounter, uniqueKeys: true });
    const v3Error = caught(() =>
      assertBoundedTaskYamlDocument(v3Document, {
        filePath: FILE_PATH,
        sourceLabel: "task v3 source",
        lineCounter: v3LineCounter,
      }),
    ) as UsageError;

    // A FRESH parse + LineCounter: assertBoundedTaskYamlDocument mutates
    // nothing about the yaml package's own document/counter, but a second
    // traversal of the SAME document instance is not part of its contract —
    // parse again so this call is unambiguously independent of the first.
    const v4LineCounter = new LineCounter();
    const v4Document = parseDocument(ALIASED_YAML, { lineCounter: v4LineCounter, uniqueKeys: true });
    const v4Error = caught(() =>
      assertBoundedTaskYamlDocument(v4Document, {
        filePath: FILE_PATH,
        sourceLabel: "task source v4",
        lineCounter: v4LineCounter,
      }),
    ) as UsageError;

    expect(v4Error.message).toStartWith("Invalid task source v4 at");
    expect(v4Error.message).not.toBe(v3Error.message);
    // The ONLY difference between the two renderings is the label text
    // itself — proves sourceLabel is a pure substitution, not a hint that
    // also happens to change wording, ordering, or the file/line suffix.
    expect(v4Error.message).toBe(v3Error.message.replace("Invalid task v3 source", "Invalid task source v4"));
    expect(v4Error.code).toBe(v3Error.code);
  });
});

describe("sourceError — the per-field funnel renders both source labels via its sourceLabel context field (D2-N4, RED until the move lands)", () => {
  test("sourceLabel: 'task v3 source' renders the 'Invalid task v3 source at …' shape", () => {
    const error = caught(() => sourceError({ filePath: "/x.yml", sourceLabel: "task v3 source" }, ["foo"], "bar."));
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).code).toBe("TASK_SOURCE_INVALID");
    expect((error as UsageError).message).toBe("Invalid task v3 source at /x.yml: foo bar.");
  });

  test("sourceLabel: 'task source v4' renders the 'Invalid task source v4 at …' shape — same field path, same detail, only the label differs", () => {
    const error = caught(() => sourceError({ filePath: "/x.yml", sourceLabel: "task source v4" }, ["foo"], "bar."));
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).code).toBe("TASK_SOURCE_INVALID");
    expect((error as UsageError).message).toBe("Invalid task source v4 at /x.yml: foo bar.");
  });

  test("a line number, when the context supplies lineAt, is rendered identically regardless of label", () => {
    const lineAt = () => 3;
    const v3Error = caught(() =>
      sourceError({ filePath: "/x.yml", sourceLabel: "task v3 source", lineAt }, ["foo"], "bar."),
    ) as UsageError;
    const v4Error = caught(() =>
      sourceError({ filePath: "/x.yml", sourceLabel: "task source v4", lineAt }, ["foo"], "bar."),
    ) as UsageError;
    expect(v3Error.message).toBe("Invalid task v3 source at /x.yml:3: foo bar.");
    expect(v4Error.message).toBe("Invalid task source v4 at /x.yml:3: foo bar.");
  });

  test("an empty field path renders the '$' root selector for both labels (B-16's shape)", () => {
    const error = caught(() =>
      sourceError({ filePath: "/x.yml", sourceLabel: "task source v4" }, [], "top-level detail."),
    );
    expect((error as UsageError).message).toBe("Invalid task source v4 at /x.yml: $ top-level detail.");
  });
});

// ── Structure: src/tasks/source-v3.ts imports the D2-N4 helpers, MOVE not ───
// ── COPY (§0, §3.1, §9). Test-review remediation (finding recorded against ──
// ── tests/tasks/bounded-document.test.ts:115): the two describe blocks ──────
// ── above prove `src/tasks/source/bounded-document.ts` exists and renders ───
// ── both source labels — they do NOT prove source-v3.ts actually delegates
// to it. Spec §0 names the exact failure mode this phase exists to avoid
// ("Every helper extracted from src/tasks/source-v3.ts keeps its body
// byte-equivalent. A rewrite disguised as a move is the failure mode this
// phase exists to avoid") and §9 pins it structurally ("src/tasks/source-v3.ts
// imports them and contains no copy of any of them"). A copy-instead-of-move
// implementation — one that adds bounded-document.ts alongside source-v3.ts's
// own still-private originals — passes every OTHER test in this file and in
// tests/tasks/source-v3.test.ts, because both files call the functions they
// already had in scope either way. This block is the one that would fail it:
// an AST scan (source, not a runtime import — a copy compiles and runs
// identically to a move) asserting source-v3.ts both imports the D2-N4
// helper set from ./source/bounded-document AND no longer declares any of
// them itself.
//
// NOT a red-phase group in the tsc sense — source-v3.ts already exists and
// compiles today. It is genuinely RED right now for the ordinary reason that
// the extraction has not happened yet: source-v3.ts imports nothing from
// ./source/bounded-document, and every one of these helpers is still declared
// as a file-private `function` in source-v3.ts today (verified at the head of
// this branch: source-v3.ts:210,228,315,325,345,381,403,423,677,795,805).

const SOURCE_V3_PATH = path.join(ROOT, "src/tasks/source-v3.ts");
const BOUNDED_DOCUMENT_MODULE = path.join(ROOT, "src/tasks/source/bounded-document");

/** The D2-N4 helper set this finding names explicitly (spec §0/§3.1/§9). */
const D2_N4_MOVED_HELPERS = [
  "sourceError",
  "cloneBoundedJson",
  "asRecord",
  "checkKeys",
  "stringField",
  "parseTimeout",
  "parseStringArray",
  "parseTools",
  "validateWorkingDirectory",
  "yamlProblem",
  "yamlAstError",
] as const;

/** Top-level `import ... from "..."` module specifiers, keyed to the named bindings each one imports. */
function importedBindingsByModule(filePath: string): Map<string, string[]> {
  const sourceText = fs.readFileSync(filePath, "utf8");
  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const byModule = new Map<string, string[]>();
  source.forEachChild((node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
    const names: string[] = [];
    const namedBindings = node.importClause?.namedBindings;
    if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) names.push(element.name.text);
    }
    byModule.set(node.moduleSpecifier.text, names);
  });
  return byModule;
}

/** Every name a TypeScript source file declares at its TOP LEVEL via `function`, `const`/`let`/`var`, or `class`. */
function topLevelDeclaredNames(filePath: string): Set<string> {
  const sourceText = fs.readFileSync(filePath, "utf8");
  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  source.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      names.add(node.name.text);
    } else if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
    } else if (ts.isClassDeclaration(node) && node.name) {
      names.add(node.name.text);
    }
  });
  return names;
}

describe("D2-N4 extraction — src/tasks/source-v3.ts imports the moved helpers and declares none of them itself", () => {
  test("imports the D2-N4 helper set from ./source/bounded-document", () => {
    const byModule = importedBindingsByModule(SOURCE_V3_PATH);
    const specifier = [...byModule.keys()].find(
      (spec) => spec.startsWith(".") && path.resolve(path.dirname(SOURCE_V3_PATH), spec) === BOUNDED_DOCUMENT_MODULE,
    );
    if (!specifier) {
      throw new Error(
        `src/tasks/source-v3.ts does not import from ./source/bounded-document (found specifiers: ${
          [...byModule.keys()].join(", ") || "<none>"
        })`,
      );
    }
    const imported = new Set(byModule.get(specifier));
    for (const helper of D2_N4_MOVED_HELPERS) {
      expect({ helper, imported: imported.has(helper) }).toEqual({ helper, imported: true });
    }
  });

  test("declares none of the D2-N4 moved helpers itself — a copy-instead-of-move implementation fails this", () => {
    const declared = topLevelDeclaredNames(SOURCE_V3_PATH);
    for (const helper of D2_N4_MOVED_HELPERS) {
      expect({ helper, stillDeclaredLocally: declared.has(helper) }).toEqual({ helper, stillDeclaredLocally: false });
    }
  });
});
