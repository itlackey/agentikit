// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests-first contract for P1b's `prepare/` split (spec
 * docs/plans/specs/p1b-model-extraction.md §4, Lane B / D4 module map).
 *
 * `prepareTaskV3Execution` (src/tasks/runtime-v3.ts:346-458) moves
 * body-intact to `src/tasks/prepare/prepare.ts`, "keep[ing] the exported
 * name/signature ... via a thin re-export from runtime-v3.ts so the THREE
 * production callers keep compiling" (spec §1.1, D4). Those three callers,
 * each constructing a differently-shaped `PrepareTaskV3ExecutionContext`:
 *
 *   - src/tasks/runner.ts:174-194            (bundleName/bundleRoot/config +
 *     a `resolveAsset({bundle,type,name})` callback, `schedulerContext` only
 *     when `options.scheduled`)
 *   - src/tasks/scheduler-sync.ts:485-502     (+ `readFile` and
 *     `commandSourceLoader`, no `resolveAsset` in the common case)
 *   - src/workflows/ir/source-freeze-v4.ts's taskDispatch (§4.2: caller
 *     line drifted from :223 to :237 since D4 was written; verified here at
 *     head) (+ `commandSourceLoader`, `resolveAsset({ref,type})`, and a
 *     `readFile` whose second parameter defaults to `owned.root`)
 *
 * This file pins that each caller's EXACT context shape — as literally
 * constructed at its call site today — still produces the identical
 * `PreparedTaskV3Execution` once routed through the moved `prepare/prepare`
 * entry point. The context objects are typed against
 * `PrepareTaskV3ExecutionContext` imported from the CURRENT runtime-v3.ts (a
 * real, tsc-checked type — not a hand-rolled guess), and the moved function
 * is typed as `typeof prepareTaskV3Execution` from that same live import —
 * so a caller-shaped context literal that does not structurally satisfy the
 * real parameter type fails `tsc`, not merely a runtime assertion. This is
 * the "type-level usage" proof: if the moved entry's signature drifts from
 * today's, every test below stops compiling before it ever runs.
 *
 * `src/tasks/prepare/prepare.ts` does not exist yet, so it is loaded through
 * a non-literal dynamic-import path — this file stays type-checkable
 * (`bunx tsc --noEmit` clean) while every test below reports its own
 * missing-implementation failure at runtime instead. Mirrors the established
 * convention in tests/workflows/environment-v4-red.test.ts.
 *
 * Every fixture below is a bare `run:` (shell) task-v3 document: it needs no
 * `config.engines`, no stored command/workflow/script asset, and — critically
 * — never invokes `resolveAsset`/`readFile`/`commandSourceLoader` (those
 * branches belong to the command/workflow/script arms). That isolates this
 * file's one concern — did the MOVE preserve each caller's context shape and
 * behavior — from prepareTaskV3Execution's per-kind behavior, which is
 * already characterized elsewhere (tests/tasks-runtime-v3.test.ts, the P0/P1a
 * suites, and this phase's Lane A/C tests). Each stub below throws if
 * invoked, so an accidental call is itself a loud test failure.
 *
 * STRUCTURAL RATCHET (test-review finding — added after the tests above):
 * the three caller-shape tests pin BEHAVIOR only — each calls
 * `prepareTaskV3Execution` through BOTH runtime-v3.ts's CURRENT export and
 * the moved `prepare/prepare` module and asserts the two RESULTS are equal.
 * They say nothing about whether the two calls reach the same CODE. An
 * inverted "split" — `prepare/prepare.ts` merely re-exporting
 * `prepareTaskV3Execution` FROM `runtime-v3.ts` (the body never actually
 * moves), `runtime-v3.ts` left unchanged, and none of the three production
 * callers (runner.ts:174, scheduler-sync.ts:485, source-freeze-v4.ts's
 * taskDispatch) rewired — makes both imports above resolve to the literal
 * SAME function object, so every `expect(after).toEqual(before)` above is
 * tautological: it cannot fail no matter which module actually holds the
 * logic. The checks below close that gap: the Lane-B analogue of
 * tests/tasks/run-split.test.ts's sections (b) and (c), which Lane C already
 * has and Lane B did not.
 *
 *   1. src/tasks/runtime-v3.ts declares no function/class of its own — an
 *      AST scan, not a text grep — and still carries at least one
 *      `export ... from "..."` re-export (spec §9: "runtime-v3.ts contains
 *      no logic — only re-exports").
 *   2. no file under src/tasks/prepare/** has an import/re-export/
 *      dynamic-import specifier whose last path segment is "runtime-v3"
 *      (spec §4.1's one-way rule: "prepare/** must not import from
 *      runtime-v3.ts"). tests/architecture/import-cycle-ratchet.test.ts's
 *      shrink-only cycle baseline cannot catch this: an inverted re-export
 *      (prepare/prepare.ts importing FROM runtime-v3.ts, with nothing
 *      importing back the other way) creates no cycle at all.
 *   3. src/tasks/prepare/prepared-execution.ts exists and exports every
 *      member of the PreparedTaskV3* type family spec §4.1 names — proof the
 *      TYPES moved too, not only the function.
 *   4. no file under src/, other than runtime-v3.ts itself, imports from
 *      "runtime-v3" (spec §4.2/§7: "no caller may be left importing the
 *      shim"). Check 2 only covers prepare/**; this covers the three named
 *      production callers and everything else under src/.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { makeBundleRef } from "../../src/core/asset/asset-ref";
import type { AkmConfig } from "../../src/core/config/config-types";
import { type PrepareTaskV3ExecutionContext, prepareTaskV3Execution } from "../../src/tasks/runtime-v3";
import { parseTaskV3Yaml } from "../../src/tasks/source-v3";
import { makeSandboxDir, type SandboxedDir } from "../_helpers/sandbox";

const ROOT = path.resolve(import.meta.dir, "../..");
const RUNTIME_V3_FILE = path.join(ROOT, "src/tasks/runtime-v3.ts");
const PREPARE_DIR = path.join(ROOT, "src/tasks/prepare");
const PREPARED_EXECUTION_FILE = path.join(PREPARE_DIR, "prepared-execution.ts");
const SRC_ROOT = path.join(ROOT, "src");

/** Non-literal on purpose (see file header) — keeps this file tsc-clean before the module exists. */
const PREPARE_MODULE: string = "../../src/tasks/prepare/prepare";

/**
 * Tied to the CURRENT export via `typeof`, not hand-typed: once
 * `prepare/prepare.ts` exists with the spec-required unchanged signature,
 * this type is exactly right; if the signature drifts, every caller-shaped
 * context literal below stops satisfying `PrepareTaskV3ExecutionContext` and
 * `tsc` — not just a runtime assertion — reports it.
 */
type PrepareModule = { readonly prepareTaskV3Execution: typeof prepareTaskV3Execution };

async function movedPrepare(): Promise<PrepareModule> {
  return (await import(PREPARE_MODULE)) as PrepareModule;
}

/** No `config.engines`/`defaults` needed — the shell/`run:` arm never reads them. */
const config: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "off" };

const sandboxes: SandboxedDir[] = [];
afterEach(() => {
  for (const sandbox of sandboxes.splice(0).reverse()) sandbox.cleanup();
});

/** A real, empty directory — `bundleRoot` must physically exist for directory-identity capture. */
function sandboxRoot(): string {
  const made = makeSandboxDir("akm-prepare-split");
  sandboxes.push(made);
  return made.dir;
}

/** The minimal valid task-v3 shell document every shape mirror below shares (mirrors tests/tasks-runtime-v3.test.ts's fixture style). */
function shellDocument(root: string) {
  return parseTaskV3Yaml({
    yaml: 'version: 3\nrun: printf ok\nakm:\n  schedule: "@daily"\n',
    filePath: `${root}/tasks/nightly.yml`,
    workspaceRoot: root,
  });
}

describe("the moved prepare/prepare.ts entry — three-caller shape parity (P1b spec §4.1/§4.2, D4)", () => {
  test("runner.ts:174's context shape — bundleName/bundleRoot/config + resolveAsset({bundle,type,name})", async () => {
    const root = sandboxRoot();
    const document = shellDocument(root);
    const bundleName = "bundle";
    const context: PrepareTaskV3ExecutionContext = {
      taskId: "nightly",
      taskRef: makeBundleRef(bundleName, "tasks/nightly"),
      bundleName,
      bundleRoot: root,
      config,
      // runner.ts:183-193's resolveAsset destructures {bundle, type, name}.
      // Never invoked for a run: task — a call here is itself a failure.
      resolveAsset: async ({ bundle, type, name }) => {
        throw new Error(`unexpected resolveAsset(${bundle}, ${type}, ${name}) while preparing a run: task`);
      },
    };

    const before = await prepareTaskV3Execution(document, context);
    expect(before).toMatchObject({ kind: "shell", command: "printf ok" });

    const { prepareTaskV3Execution: moved } = await movedPrepare();
    const after = await moved(document, context);
    expect(after).toEqual(before);
  });

  test("scheduler-sync.ts:485's context shape — readFile + commandSourceLoader, no resolveAsset", async () => {
    const root = sandboxRoot();
    const document = shellDocument(root);
    const bundleName = "bundle";
    const context: PrepareTaskV3ExecutionContext = {
      taskId: "nightly",
      taskRef: makeBundleRef(bundleName, "tasks/nightly"),
      bundleName,
      bundleRoot: root,
      config,
      // scheduler-sync.ts:492-501's readFile/commandSourceLoader. Neither is
      // invoked for a run: task — a call here is itself a failure.
      readFile: (file, bundleRootArg) => {
        throw new Error(`unexpected readFile(${file}, ${bundleRootArg}) while preparing a run: task`);
      },
      commandSourceLoader: (ref, kind) => {
        throw new Error(`unexpected commandSourceLoader(${ref}, ${kind}) while preparing a run: task`);
      },
    };

    const before = await prepareTaskV3Execution(document, context);
    expect(before).toMatchObject({ kind: "shell", command: "printf ok" });

    const { prepareTaskV3Execution: moved } = await movedPrepare();
    const after = await moved(document, context);
    expect(after).toEqual(before);
  });

  test("source-freeze-v4.ts taskDispatch's context shape — commandSourceLoader + resolveAsset({ref,type}) + a defaulted readFile", async () => {
    const root = sandboxRoot();
    const document = shellDocument(root);
    const bundleName = "bundle";
    const context: PrepareTaskV3ExecutionContext = {
      taskId: "nightly",
      taskRef: makeBundleRef(bundleName, "tasks/nightly"),
      bundleName,
      bundleRoot: root,
      config,
      commandSourceLoader: (ref, kind) => {
        throw new Error(`unexpected commandSourceLoader(${ref}, ${kind}) while preparing a run: task`);
      },
      // taskDispatch (source-freeze-v4.ts:244-248) destructures {ref, type}
      // (ignoring bundle/name) and always returns the {file, bundleRoot}
      // object form, never the bare-string form of the union return type.
      resolveAsset: async ({ ref, type }) => {
        throw new Error(`unexpected resolveAsset(${ref}, ${type}) while preparing a run: task`);
      },
      // taskDispatch's readFile (source-freeze-v4.ts:249) defaults its
      // second parameter to owned.root via a default parameter, not `??`.
      readFile: (file, bundleRootArg = root) => {
        throw new Error(`unexpected readFile(${file}, ${bundleRootArg}) while preparing a run: task`);
      },
    };

    const before = await prepareTaskV3Execution(document, context);
    expect(before).toMatchObject({ kind: "shell", command: "printf ok" });

    const { prepareTaskV3Execution: moved } = await movedPrepare();
    const after = await moved(document, context);
    expect(after).toEqual(before);
  });
});

// ── structural ratchet: an inverted "split" must fail (see file header) ────

/** AST-scan a file for its own function/class declarations, and confirm it still re-exports something (an empty file would trivially, wrongly, "pass" a bare declaration-count check). Mirrors tests/tasks/run-split.test.ts's scanRunnerForLogic, applied to runtime-v3.ts instead of runner.ts. */
function scanForOwnLogic(filePath: string): {
  readonly functionDeclarationNames: readonly string[];
  readonly classDeclarationNames: readonly string[];
  readonly hasReExport: boolean;
} {
  const source = ts.createSourceFile(filePath, fs.readFileSync(filePath, "utf8"), ts.ScriptTarget.Latest, true);
  const functionDeclarationNames: string[] = [];
  const classDeclarationNames: string[] = [];
  let hasReExport = false;
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node)) functionDeclarationNames.push(node.name?.text ?? "<anonymous>");
    if (ts.isClassDeclaration(node)) classDeclarationNames.push(node.name?.text ?? "<anonymous>");
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      hasReExport = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { functionDeclarationNames, classDeclarationNames, hasReExport };
}

/**
 * Recursive .ts file walk. Mirrors tests/tasks/run-split.test.ts's
 * walkTsFiles / tests/workflows/direct-script-typed.test.ts's — deliberately
 * NOT defensive about a missing `dir`: ENOENT is the correct, legible red
 * today, before src/tasks/prepare/ exists.
 */
function walkTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) results.push(full);
  }
  return results;
}

/**
 * True when `filePath` has any static import/re-export specifier, or dynamic
 * `import(...)` argument, whose final path segment (extension stripped)
 * equals `moduleName`. Mirrors tests/tasks/run-split.test.ts's
 * importsRunner, generalized to a parameterized target module so it can
 * check for "runtime-v3" from two different scan roots below.
 */
function importsModuleNamed(filePath: string, moduleName: string): boolean {
  const source = ts.createSourceFile(filePath, fs.readFileSync(filePath, "utf8"), ts.ScriptTarget.Latest, true);
  let found = false;
  function targets(specifier: string): boolean {
    const lastSegment = specifier
      .replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "")
      .split("/")
      .pop();
    return lastSegment === moduleName;
  }
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      targets(node.moduleSpecifier.text)
    ) {
      found = true;
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments;
      if (arg && ts.isStringLiteral(arg) && targets(arg.text)) found = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

/**
 * Exported interface/type-alias names declared directly in `filePath`, plus
 * anything named in an `export { ... }` clause (covers both a local
 * declaration and a re-export naming the same identifier). Good enough to
 * confirm "this module exports type X" without standing up a full
 * type-checked ts.Program, matching this phase's established
 * AST-scan-over-full-tsc convention (e.g. run-split.test.ts's
 * hasRuntimeExport, direct-script-typed.test.ts's
 * scanForParseTaskV3YamlUsage). A re-export sourced FROM runtime-v3.ts would
 * satisfy this check on its own, but check 2 below independently forbids
 * exactly that specifier, so the two together still close the loophole.
 */
function exportedTypeNames(filePath: string): ReadonlySet<string> {
  const source = ts.createSourceFile(filePath, fs.readFileSync(filePath, "utf8"), ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  function isExported(node: ts.Node): boolean {
    return (
      ts.canHaveModifiers(node) &&
      (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false)
    );
  }
  function visit(node: ts.Node): void {
    if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && isExported(node)) {
      names.add(node.name.text);
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) names.add(element.name.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return names;
}

describe("src/tasks/runtime-v3.ts contains no logic of its own — only re-exports remain (spec §9, P4-deletion compat shim)", () => {
  test("no function or class declarations anywhere in runtime-v3.ts, and it still re-exports something", () => {
    const scan = scanForOwnLogic(RUNTIME_V3_FILE);
    expect(scan.functionDeclarationNames, "function declarations found in runtime-v3.ts").toEqual([]);
    expect(scan.classDeclarationNames, "class declarations found in runtime-v3.ts").toEqual([]);
    expect(scan.hasReExport, 'runtime-v3.ts has no `export ... from "..."` re-export left at all').toBe(true);
  });
});

describe("no file under src/tasks/prepare/** imports runtime-v3.ts (one-way rule, spec §4.1: 'prepare/** must not import from runtime-v3.ts')", () => {
  test("src/tasks/prepare/ exists, has real .ts files, and none of them import runtime-v3", () => {
    const files = walkTsFiles(PREPARE_DIR);
    expect(files.length, "src/tasks/prepare/ contains no .ts files yet").toBeGreaterThan(0);
    const offenders = files
      .filter((file) => importsModuleNamed(file, "runtime-v3"))
      .map((file) => path.relative(ROOT, file));
    expect(offenders).toEqual([]);
  });
});

describe("src/tasks/prepare/prepared-execution.ts exists and exports the PreparedTaskV3* type family (spec §4.1)", () => {
  const REQUIRED_TYPE_NAMES = [
    "TaskV3PreparedBase",
    "PreparedTaskV3Command",
    "PreparedTaskV3Workflow",
    "PreparedTaskV3Shell",
    "PreparedTaskV3Script",
    "PreparedTaskV3Execution",
    "PreparedTaskV3DirectoryIdentity",
    "PrepareTaskV3ExecutionContext",
    "TaskV3ScriptInterpreter",
  ] as const;

  test("the file exists and exports every type spec §4.1 names (the types moved too, not only the function)", () => {
    if (!fs.existsSync(PREPARED_EXECUTION_FILE)) {
      throw new Error(
        "src/tasks/prepare/prepared-execution.ts does not exist yet — spec §4.1 requires it to hold the " +
          "PreparedTaskV3* type family; this test cannot pass until the module is implemented.",
      );
    }
    const exported = exportedTypeNames(PREPARED_EXECUTION_FILE);
    const missing = REQUIRED_TYPE_NAMES.filter((name) => !exported.has(name));
    expect(missing, `missing exported types in prepared-execution.ts: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("no file under src/, other than runtime-v3.ts itself, imports from runtime-v3 (spec §4.2/§7: 'no caller may be left importing the shim')", () => {
  test("every file under src/ has been rewired off the shim", () => {
    const files = walkTsFiles(SRC_ROOT).filter((file) => file !== RUNTIME_V3_FILE);
    const offenders = files
      .filter((file) => importsModuleNamed(file, "runtime-v3"))
      .map((file) => path.relative(ROOT, file));
    expect(offenders, `caller(s) still importing the runtime-v3 shim: ${offenders.join(", ")}`).toEqual([]);
  });
});
