// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P1a Lane B — the target-ref classifier seam.
 *
 * See docs/plans/specs/p1a-with-rejection-classifier.md §4 for the binding
 * design; row IDs (B-09…B-13) are this spec's §5 behavior table. Written
 * ahead of the Lane B implementation per the phase's test-first cycle:
 * `src/execution/target-ref.ts` (`classifyTargetRef`) does not exist on disk
 * yet, so the first group below is expected to be RED on missing module —
 * exactly like this repo's other pre-implementation `*-red.test.ts` files
 * (e.g. tests/workflows/guarded-execution-source-red.test.ts) resolve their
 * subject module dynamically per test rather than via a static top-level
 * import, so a not-yet-existing module fails EACH test as its own clear
 * rejection instead of one opaque "cannot find module" collection error that
 * would also take down the unrelated groups below.
 *
 * Three groups:
 *
 *   1. `classifyTargetRef` accept/reject matrix (B-09…B-13), including the
 *      frozen-result assertion on every accepted shape.
 *   2. `classifyWorkflowStepUses` exercised through its REAL default
 *      classifier (no injected spy) — the §4.5 parity table reproduced as a
 *      direct unit-level pin that the new seam produces identical observable
 *      results to today, independent of the untouched parity gate
 *      (tests/workflows/source-ir-contract.test.ts, which runs the same
 *      table through the heavier `compileGithubWorkflowSource` YAML
 *      pipeline) and of the two existing spy-based delegation tests in
 *      tests/workflows/characterization-classification.test.ts (the spec's
 *      F-03 row: the injected-classifier parameter itself is untouched by
 *      P1a, so those two tests are correctly left unchanged — "keep
 *      unchanged, rewriting should be avoided").
 *   3. Import boundary: `src/workflows/source-ir/{semantics,uses}.ts` must
 *      import nothing from `src/tasks/source-v3.ts` (§4.2/§4.3, §9 assertion
 *      2). This group is RED today for a real, CURRENT reason, independent
 *      of whether src/execution/target-ref.ts exists: `uses.ts` still
 *      delegates to `classifyTaskV3Uses` imported from that module. This is
 *      the lane's assertion-level red — a genuine failing expectation rather
 *      than a module-resolution crash.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { UsageError } from "../../src/core/errors";
import type { TargetRefKind } from "../../src/execution/target-ref";
import { classifyWorkflowStepUses, WorkflowSourceSemanticError } from "../../src/workflows/source-ir/semantics";

const ROOT = path.resolve(import.meta.dir, "../..");

/** Capture a synchronous throw once, so a message/code pin never re-invokes the function under test. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected function to throw");
}

/**
 * Dynamically import the not-yet-implemented classifier module rather than a
 * static top-level import — see the file docstring. Bun/Node's ESM loader
 * caches the promise per specifier, so calling this once per test costs
 * nothing extra once the module exists.
 */
async function targetRefApi() {
  return import("../../src/execution/target-ref");
}

// ── classifyTargetRef: accept/reject matrix (B-09…B-13) ─────────────────────

describe("classifyTargetRef — canonical asset-ref classification (P1a §4.1, src/execution/target-ref.ts)", () => {
  test("B-09/B-10/B-11: classifies each of commands/scripts/tasks/workflows, bundle-qualified or not, and freezes the result", async () => {
    const { classifyTargetRef } = await targetRefApi();
    const matrix: Array<[string, TargetRefKind]> = [
      ["commands/review", "command"],
      ["team//commands/review", "command"],
      ["scripts/build.sh", "script"],
      ["team//scripts/build.sh", "script"],
      ["tasks/nightly", "task"],
      ["team//tasks/review", "task"],
      ["workflows/release", "workflow"],
      ["team//workflows/release", "workflow"],
    ];
    for (const [value, kind] of matrix) {
      const result = classifyTargetRef(value);
      // Per-property assertions rather than a whole-object toEqual: this is
      // mostly a style choice here, since `kind` is now typed as the real
      // `TargetRefKind` (ClassifiedTargetRef.kind is pinned, spec §4.1 — no
      // widening at the production type), so a strict
      // toEqual<ClassifiedTargetRef> overload would type-check fine too.
      expect(result.kind).toBe(kind);
      expect(result.ref).toBe(value);
      expect(Object.isFrozen(result)).toBe(true);
    }
  });

  // B-12: no `akm/command` special case inside classifyTargetRef itself —
  // it is the bare canonical-ref classifier; callers (classifyWorkflowSourceUses,
  // §4.2) layer builtin detection on top.
  test("B-12: 'akm/command' is rejected — classifyTargetRef has no builtin special case", async () => {
    const { classifyTargetRef } = await targetRefApi();
    const error = thrown(() => classifyTargetRef("akm/command"));
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).code).toBe("TARGET_REF_INVALID");
    expect((error as Error).message).toBe(
      `Target ref ${JSON.stringify("akm/command")} must be a canonical commands/, scripts/, tasks/, or workflows/ asset ref.`,
    );
  });

  // B-13: malformed / fragment / empty / whitespace / github-locator-shaped
  // values all reject with the exact §4.1 message. No GitHub locator
  // grammar lives here (explicit non-goal, §4.1) — "owner/repo@v1" is just
  // an unrecognized family, same as any other non-canonical shape.
  test("B-13: rejects malformed, fragment, empty, whitespace, and github-locator-shaped values with TARGET_REF_INVALID", async () => {
    const { classifyTargetRef } = await targetRefApi();
    const rejected = [
      "commands/review#fragment",
      "akm:commands/review",
      "bad.bundle//commands/review",
      "agents/reviewer",
      "review",
      "",
      " commands/review ",
      "owner/repo@v1",
      "docker://alpine:latest",
      "./x",
    ];
    for (const value of rejected) {
      const error = thrown(() => classifyTargetRef(value));
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).code).toBe("TARGET_REF_INVALID");
      expect((error as Error).message).toBe(
        `Target ref ${JSON.stringify(value)} must be a canonical commands/, scripts/, tasks/, or workflows/ asset ref.`,
      );
    }
  });
});

// ── classifyWorkflowStepUses through the REAL default classifier — the ─────
// ── §4.5 parity table, exercised without a spy (the "new seam") ────────────

describe("classifyWorkflowStepUses — identical observable results through the new seam (P1a §4.3/§4.5 parity)", () => {
  test("accepts every §4.5 accepted kind through the real default classifier", () => {
    const accepted: Array<[string, "command" | "script" | "task" | "builtin-command"]> = [
      ["commands/review", "command"],
      ["team//commands/review", "command"],
      ["scripts/build.sh", "script"],
      ["tasks/review", "task"],
      ["team//tasks/review", "task"],
      ["akm/command", "builtin-command"],
    ];
    for (const [value, kind] of accepted) {
      const result = classifyWorkflowStepUses(value);
      // Per-property assertions rather than a whole-object toEqual: `kind`
      // here is a plain `string` (widened across this heterogeneous table's
      // rows, an ordinary TS loop-variable limitation), which a strict
      // toEqual<WorkflowSourceUsesTarget> overload would reject as not
      // narrow enough — string-to-string equality has no such constraint.
      expect(result.kind).toBe(kind);
      expect(result.ref).toBe(value);
    }
  });

  // Message text is authorized to drift for the classifyTargetRef-derived
  // rows (spec §4.5: "message drift here is authorized; code drift is not")
  // — only `code` is pinned here, matching the untouched parity gate
  // (source-ir-contract.test.ts), which asserts `code` only for this table.
  test("rejects every §4.5 non-accepted kind with its listed WorkflowSourceSemanticError code", () => {
    const rejected: Array<[string, string]> = [
      ["actions/checkout@v4", "remote-action-acquisition-out-of-scope"],
      ["./actions/review", "local-action-path-unsupported"],
      ["docker://alpine:latest", "docker-action-unsupported"],
      ["agents/reviewer", "non-executable-asset-ref"],
      ["workflows/child", "nested-workflow-unsupported"],
      ["akm:commands/review", "unsupported-uses-target"],
      ["bad.bundle//commands/review", "unsupported-uses-target"],
      ["commands/review#fragment", "unsupported-uses-target"],
      // The one locator near-miss (§4.3 Accepted deviation A-1's control
      // case): revision contains ":", so it is excluded by the charset rule
      // in isGithubLocatorShape and keeps unsupported-uses-target rather than
      // becoming remote-action-acquisition-out-of-scope.
      ["actions/checkout@bad:ref", "unsupported-uses-target"],
      ["review", "unsupported-uses-target"],
    ];
    for (const [value, code] of rejected) {
      const error = thrown(() => classifyWorkflowStepUses(value));
      expect(error).toBeInstanceOf(WorkflowSourceSemanticError);
      expect((error as WorkflowSourceSemanticError).code).toBe(code);
    }
  });

  // The behavior this test is named for: a github-locator-SHAPED value must
  // still throw remote-action-acquisition-out-of-scope through the new seam.
  // §4.3 step 8's ordering is what keeps this true once classifyTargetRef
  // (which has NO locator grammar, §4.1) replaces classifyTaskV3Uses as the
  // delegate — semantics.ts's own local isGithubLocatorShape takes over
  // recognizing the shape.
  test("a github-locator-shaped step uses still throws remote-action-acquisition-out-of-scope", () => {
    const error = thrown(() => classifyWorkflowStepUses("actions/checkout@v4"));
    expect(error).toBeInstanceOf(WorkflowSourceSemanticError);
    expect((error as WorkflowSourceSemanticError).code).toBe("remote-action-acquisition-out-of-scope");
    expect((error as Error).message).toBe('Remote action acquisition is out of scope for "actions/checkout@v4".');
  });
});

// ── Import boundary: the workflow uses-classification seam owns zero ───────
// ── import from src/tasks/source-v3.ts (§4.2/§4.3, §9 assertion 2) ─────────

/** Top-level `import ... from "..."` module specifiers in a TypeScript source file. */
function importedModuleSpecifiers(filePath: string): string[] {
  const source = ts.createSourceFile(filePath, fs.readFileSync(filePath, "utf8"), ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  source.forEachChild((node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
  });
  return specifiers;
}

/** True when a module specifier resolves to src/tasks/source-v3(.ts), in any relative spelling. */
function isSourceV3Specifier(specifier: string): boolean {
  return /(?:^|\/)tasks\/source-v3(?:\.ts)?$/.test(specifier);
}

describe("import boundary — the workflow uses-classification seam imports nothing from tasks/source-v3 (P1a §4.2/§4.3)", () => {
  // RED today for a real, current reason (independent of whether
  // src/execution/target-ref.ts exists): uses.ts:12 still imports
  // classifyTaskV3Uses from "../../tasks/source-v3". This is the lane's
  // assertion-level red — see the file docstring.
  test("src/workflows/source-ir/uses.ts imports nothing from tasks/source-v3", () => {
    const specifiers = importedModuleSpecifiers(path.join(ROOT, "src/workflows/source-ir/uses.ts"));
    expect(specifiers.filter(isSourceV3Specifier)).toEqual([]);
  });

  test("src/workflows/source-ir/semantics.ts imports nothing from tasks/source-v3", () => {
    const specifiers = importedModuleSpecifiers(path.join(ROOT, "src/workflows/source-ir/semantics.ts"));
    expect(specifiers.filter(isSourceV3Specifier)).toEqual([]);
  });
});
