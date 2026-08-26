// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests-first STRUCTURAL contract for P1b's `src/tasks/run/**` split (spec
 * docs/plans/specs/p1b-model-extraction.md §5.1, §9 "Structure"). Sibling to
 * `tests/tasks/prepare-split.test.ts` (Lane B's caller-shape parity contract)
 * but for Lane C, and narrower in scope on purpose: Lane C's *behavior* is
 * already pinned exhaustively elsewhere — the flipped P0 characterization
 * files (tasks-provenance-characterization.test.ts,
 * tasks-legacy-vocabulary-characterization.test.ts), the two brand-new P1b
 * files (tasks-provenance-context.test.ts, tasks-result-vocabulary.test.ts),
 * cli-errors.test.ts, and the fail-before-mutation canary
 * (tasks-runtime-v3-runner.test.ts). What NONE of those files pins is
 * whether the runner.ts (1177 lines at head) actually got split into
 * `src/tasks/run/**` at all — an implementation that lands every authorized
 * behavior flip without ever touching runner.ts's structure passes every one
 * of them. This file exists to close exactly that gap (test-review finding):
 *
 *   (a) each spec §5.1 module under src/tasks/run/** loads, and the four
 *       modules whose exported name the compat shim ALREADY commits to at
 *       head (run-task.ts -> runTask, attempt-lifecycle.ts ->
 *       recordTaskAttemptFailure, task-history.ts -> readTaskHistory, plus
 *       task-result.ts -> exitCodeForStatus and task-log.ts -> scrubDbLines,
 *       both also on the spec §5's compat-shim re-export list) are proven to
 *       be the SAME function object runner.ts re-exports — not merely
 *       behaviorally similar, IDENTICAL (===), which is what "only
 *       re-exports remain" (spec §5, §9) actually means. provenance.ts's D5
 *       context factory is new (no current runner.ts export to tie an
 *       identity check to) and is pinned by its own construction rule
 *       instead (see DESIGN DECISION below). The remaining four modules
 *       (load-task.ts, run-native-task.ts, run-workflow-task.ts,
 *       run-command-task.ts) hold helpers that are module-PRIVATE in today's
 *       runner.ts and are not on the compat-shim list — the spec does not
 *       commit them to a specific exported name, so pinning one here would
 *       force an implementation choice the spec never made; they get a
 *       weaker but still real "exists and exports actual runtime logic, not
 *       an empty stub" check instead.
 *   (b) src/tasks/runner.ts contains NO function/class declarations of its
 *       own — an AST scan, not a text grep, so a re-export written across
 *       multiple lines or re-ordered still counts, and a renamed local
 *       wrapper masquerading as a re-export still gets caught (by (a)'s
 *       identity checks, since a wrapper is never `===` the thing it wraps).
 *   (c) no file under src/tasks/run/** imports runner.ts — the one-way rule
 *       (spec §5.1: "no module may import runner.ts") — an AST
 *       import-specifier scan, the same technique as
 *       tests/tasks/parse-v3-adapter.test.ts:396's scanModule and
 *       tests/workflows/direct-script-typed.test.ts's
 *       scanForParseTaskV3YamlUsage, generalized from "does this module
 *       import source-v3" to "does this module import runner".
 *
 * DESIGN DECISION (provenance.ts's context factory name): spec §5.1 names
 * the module's responsibility only as "ExecutionProvenanceContext factory +
 * resolution helpers" (§5.2 is the binding source: D5's Construction and
 * Threading clauses both build the IDENTICAL literal —
 * `{ eventSource: "task", scheduled: options.scheduled === true }` — once at
 * the `akm task run` CLI boundary and once as run-task.ts's own default for
 * an absent `options.provenance`). Since the spec never names this function,
 * this file authors one ahead of implementation, exactly as
 * tests/tasks/model-contracts.test.ts's header does for
 * `createTaskDefinition`: `createExecutionProvenanceContext(scheduled:
 * boolean): ExecutionProvenanceContext`, mirroring D5's construction
 * literal exactly (this file pins the VALUE it must produce, not a
 * hand-typed shape import — see below).
 *
 * Every not-yet-existing module is loaded through a NON-LITERAL dynamic
 * `import(...)` path (`const ..._MODULE: string = "..."`), the established
 * convention this whole phase uses (tests/tasks/prepare-split.test.ts,
 * tests/tasks/parse-v3-adapter.test.ts, tests/tasks/model-contracts.test.ts,
 * tests/workflows/environment-v4-red.test.ts) so this file stays `bunx tsc
 * --noEmit` clean before the split lands, while every test below reports its
 * own missing-implementation failure at `bun test` runtime instead of one
 * opaque module-resolution error. AST scans that read a not-yet-existing
 * file directly (sections (b)... no, (b) reads the REAL runner.ts, which
 * exists today; only (c)'s directory walk targets a not-yet-existing
 * directory) let `fs.readFileSync`/`fs.readdirSync` throw ENOENT naturally —
 * "real ENOENT-then-AST red, not a vacuous self-check" (the same phrase
 * tests/tasks/model-contracts.test.ts's header uses for the identical
 * technique).
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  exitCodeForStatus,
  readTaskHistory,
  recordTaskAttemptFailure,
  runTask,
  scrubDbLines,
} from "../../src/tasks/runner";

const ROOT = path.resolve(import.meta.dir, "../..");
const RUNNER_FILE = path.join(ROOT, "src/tasks/runner.ts");
const RUN_DIR = path.join(ROOT, "src/tasks/run");

// ── (a) each §5.1 module loads and exports its named responsibility ────────

const RUN_TASK_MODULE: string = "../../src/tasks/run/run-task";
const ATTEMPT_LIFECYCLE_MODULE: string = "../../src/tasks/run/attempt-lifecycle";
const TASK_HISTORY_MODULE: string = "../../src/tasks/run/task-history";
const TASK_RESULT_MODULE: string = "../../src/tasks/run/task-result";
const TASK_LOG_MODULE: string = "../../src/tasks/run/task-log";
const PROVENANCE_MODULE: string = "../../src/tasks/run/provenance";

interface RunTaskModule {
  readonly runTask: typeof runTask;
}
interface AttemptLifecycleModule {
  readonly recordTaskAttemptFailure: typeof recordTaskAttemptFailure;
}
interface TaskHistoryModule {
  readonly readTaskHistory: typeof readTaskHistory;
}
interface TaskResultModule {
  readonly exitCodeForStatus: typeof exitCodeForStatus;
}
interface TaskLogModule {
  readonly scrubDbLines: typeof scrubDbLines;
}
interface ProvenanceModule {
  readonly createExecutionProvenanceContext: (scheduled: boolean) => {
    readonly eventSource: "user" | "task";
    readonly scheduled: boolean;
  };
}

describe("src/tasks/run/** — each module loads and IS (not merely resembles) runner.ts's re-exported binding (spec §5.1/§9)", () => {
  test("run/run-task.ts exports runTask, identical to runner.ts's re-export", async () => {
    const moved = (await import(RUN_TASK_MODULE)) as RunTaskModule;
    expect(moved.runTask).toBe(runTask);
  });

  test("run/attempt-lifecycle.ts exports recordTaskAttemptFailure, identical to runner.ts's re-export", async () => {
    const moved = (await import(ATTEMPT_LIFECYCLE_MODULE)) as AttemptLifecycleModule;
    expect(moved.recordTaskAttemptFailure).toBe(recordTaskAttemptFailure);
  });

  test("run/task-history.ts exports readTaskHistory, identical to runner.ts's re-export", async () => {
    const moved = (await import(TASK_HISTORY_MODULE)) as TaskHistoryModule;
    expect(moved.readTaskHistory).toBe(readTaskHistory);
  });

  test("run/task-result.ts exports exitCodeForStatus, identical to runner.ts's re-export", async () => {
    const moved = (await import(TASK_RESULT_MODULE)) as TaskResultModule;
    expect(moved.exitCodeForStatus).toBe(exitCodeForStatus);
  });

  test("run/task-log.ts exports scrubDbLines, identical to runner.ts's re-export", async () => {
    const moved = (await import(TASK_LOG_MODULE)) as TaskLogModule;
    expect(moved.scrubDbLines).toBe(scrubDbLines);
  });

  test('run/provenance.ts exports a context factory matching D5\'s construction ({eventSource: "task", scheduled}, spec §1.2/§5.2)', async () => {
    const moved = (await import(PROVENANCE_MODULE)) as ProvenanceModule;
    expect(moved.createExecutionProvenanceContext(false)).toEqual({ eventSource: "task", scheduled: false });
    expect(moved.createExecutionProvenanceContext(true)).toEqual({ eventSource: "task", scheduled: true });
  });
});

describe("src/tasks/run/** — the remaining §5.1 modules exist and export real runtime logic, not an empty stub (spec §5.1)", () => {
  // load-task.ts / run-native-task.ts / run-workflow-task.ts /
  // run-command-task.ts hold helpers that are module-PRIVATE in today's
  // runner.ts (loadTask-shaped orchestration; shellCommand/
  // resolveLeadingBareAkmCommand/quoteShellArgument; runWorkflowTask/
  // mapWorkflowStatus/renderWorkflowLog; runPreparedCommandTask/
  // renderPromptLog) — none of them is on spec §5's compat re-export list,
  // so the spec never commits them to a specific exported name. Pinning one
  // here would force an implementation choice the spec never made. This
  // checks the weaker, still-real thing the spec DOES commit to: the file
  // exists and exports at least one RUNTIME (non type-only) declaration.
  const MODULE_FILES: ReadonlyArray<readonly [label: string, filePath: string]> = [
    ["run/load-task.ts", path.join(RUN_DIR, "load-task.ts")],
    ["run/run-native-task.ts", path.join(RUN_DIR, "run-native-task.ts")],
    ["run/run-workflow-task.ts", path.join(RUN_DIR, "run-workflow-task.ts")],
    ["run/run-command-task.ts", path.join(RUN_DIR, "run-command-task.ts")],
  ];

  /**
   * True when `filePath` has a top-level `export` on a function, class, or
   * variable declaration — i.e. something that still exists at RUNTIME after
   * TypeScript's types are erased. `export interface`/`export type` alone
   * would make an empty stub file look "covered", which is exactly the
   * vacuous check this file's header rules out.
   */
  function hasRuntimeExport(filePath: string): boolean {
    const source = ts.createSourceFile(filePath, fs.readFileSync(filePath, "utf8"), ts.ScriptTarget.Latest, true);
    let found = false;
    function visit(node: ts.Node): void {
      if (found) return;
      if (
        ts.canHaveModifiers(node) &&
        ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
        (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isVariableStatement(node))
      ) {
        found = true;
        return;
      }
      // `export { x }` / `export { x as y }` (no re-export moduleSpecifier —
      // that case is a re-export, handled by the runner.ts-specific scan
      // below, not expected here) also counts as a runtime export.
      if (ts.isExportDeclaration(node) && !node.moduleSpecifier && node.exportClause) found = true;
      ts.forEachChild(node, visit);
    }
    visit(source);
    return found;
  }

  for (const [label, filePath] of MODULE_FILES) {
    test(`${label} exists and exports at least one runtime declaration`, () => {
      expect(hasRuntimeExport(filePath), label).toBe(true);
    });
  }
});

// ── (b) runner.ts contains no logic of its own — only re-exports remain ────

interface RunnerLogicScan {
  readonly functionDeclarationNames: readonly string[];
  readonly classDeclarationNames: readonly string[];
  readonly hasReExport: boolean;
}

/** AST-scan runner.ts for its own function/class declarations, and confirm it still re-exports something (an empty file would trivially, wrongly, "pass" a bare declaration-count check). */
function scanRunnerForLogic(filePath: string): RunnerLogicScan {
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

describe("src/tasks/runner.ts contains no logic of its own — only re-exports remain (spec §5.1/§9, P4-deletion compat shim)", () => {
  test("no function or class declarations anywhere in runner.ts, and it still re-exports something", () => {
    const scan = scanRunnerForLogic(RUNNER_FILE);
    expect(scan.functionDeclarationNames, "function declarations found in runner.ts").toEqual([]);
    expect(scan.classDeclarationNames, "class declarations found in runner.ts").toEqual([]);
    expect(scan.hasReExport, 'runner.ts has no `export ... from "..."` re-export left at all').toBe(true);
  });
});

// ── (c) the one-way import rule: runner.ts -> run/**, never run/** -> runner.ts ──

/** Recursive .ts file walk. Deliberately NOT defensive about a missing `dir` — see file header: ENOENT is the correct, legible red today, before src/tasks/run/ exists. */
function walkTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) results.push(full);
  }
  return results;
}

/** True when `filePath` has any static import/re-export specifier, or dynamic `import(...)` argument, whose final path segment (extension stripped) is exactly "runner". */
function importsRunner(filePath: string): boolean {
  const source = ts.createSourceFile(filePath, fs.readFileSync(filePath, "utf8"), ts.ScriptTarget.Latest, true);
  let found = false;
  function targetsRunner(specifier: string): boolean {
    const lastSegment = specifier
      .replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "")
      .split("/")
      .pop();
    return lastSegment === "runner";
  }
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      targetsRunner(node.moduleSpecifier.text)
    ) {
      found = true;
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments;
      if (arg && ts.isStringLiteral(arg) && targetsRunner(arg.text)) found = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

describe("no file under src/tasks/run/** imports runner.ts (one-way rule, spec §5.1: 'no module may import runner.ts')", () => {
  test("src/tasks/run/ exists, has real .ts files, and none of them import runner", () => {
    const files = walkTsFiles(RUN_DIR);
    expect(files.length, "src/tasks/run/ contains no .ts files yet").toBeGreaterThan(0);
    const offenders = files.filter(importsRunner).map((file) => path.relative(ROOT, file));
    expect(offenders).toEqual([]);
  });
});
