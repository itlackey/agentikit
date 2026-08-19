// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WP5 / #809 consumer ratchet for improve-owned model work.
 *
 * These callers may retain TYPE-ONLY chat signatures for injectable tests,
 * but production dispatch must cross the resolved request -> lowering seam.
 * The origin-level repository ratchet covers renamed/forwarded imports across
 * all execution consumers; this bounded list also makes the improve ownership
 * boundary explicit and catches its historical local aliases (`chatFn`,
 * `ctx.chat`, and dynamic client imports).
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dir, "../..");

const GUARDED = [
  "src/commands/improve/consolidate.ts",
  "src/commands/improve/distill.ts",
  "src/commands/improve/distill/promote-memory.ts",
  "src/commands/improve/distill/quality-gate.ts",
  "src/commands/improve/extract.ts",
  "src/commands/improve/improve-strategies.ts",
  "src/commands/improve/improve.ts",
  "src/commands/improve/loop-stages.ts",
  "src/commands/improve/memory/memory-contradiction-detect.ts",
  "src/commands/improve/preparation.ts",
  "src/commands/improve/reflect.ts",
  "src/commands/improve/run-context.ts",
  "src/commands/proposal/proposal-cli.ts",
  "src/commands/read/remember-cli.ts",
  "src/commands/remember.ts",
  "src/commands/sources/schema-repair.ts",
  "src/llm/graph-extract.ts",
  "src/llm/memory-infer.ts",
  "src/llm/metadata-enhance.ts",
  "src/llm/structured-call.ts",
] as const;

const RAW_IMPORTS = new Map<string, ReadonlySet<string>>([
  ["../../llm/client", new Set(["chatCompletion"])],
  ["../../../llm/client", new Set(["chatCompletion"])],
  ["./client", new Set(["chatCompletion"])],
  ["../../integrations/agent/engine-resolution", new Set(["resolveEngine", "resolveLlmEngineUse"])],
  ["../../integrations/agent/runner-dispatch", new Set(["executeRunner"])],
  ["../../../integrations/agent/engine-resolution", new Set(["getDefaultLlmConfig"])],
  [
    "../../integrations/agent/runner",
    new Set([
      "materializeLlmRunnerConnection",
      "resolveDefaultLlmRunner",
      "resolveImproveProcessRunner",
      "resolveTriageJudgmentRunner",
    ]),
  ],
  [
    "../../../integrations/agent/runner",
    new Set([
      "materializeLlmRunnerConnection",
      "resolveDefaultLlmRunner",
      "resolveImproveProcessRunner",
      "resolveTriageJudgmentRunner",
    ]),
  ],
]);

const RAW_LOCAL_CALLS = new Set([
  "chatFn",
  "executeRunner",
  "materializeLlmRunnerConnection",
  "resolveDefaultLlmRunner",
  "resolveEngine",
  "resolveImproveProcessRunner",
  "resolveLlmEngineUse",
  "resolveTriageJudgmentRunner",
]);

function findings(relativePath: string): string[] {
  const absolutePath = path.join(ROOT, relativePath);
  const source = fs.readFileSync(absolutePath, "utf8");
  const file = ts.createSourceFile(absolutePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = new Set<string>();

  const line = (node: ts.Node): number => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const add = (node: ts.Node, message: string): void => {
    out.add(`${relativePath}:${line(node)}:${message}`);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const blocked = RAW_IMPORTS.get(node.moduleSpecifier.text);
      const clause = node.importClause;
      if (blocked && clause && !clause.isTypeOnly && clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const specifier of clause.namedBindings.elements) {
          const imported = specifier.propertyName?.text ?? specifier.name.text;
          if (!specifier.isTypeOnly && blocked.has(imported)) add(specifier, `raw import ${imported}`);
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (ts.isIdentifier(expression) && RAW_LOCAL_CALLS.has(expression.text)) {
        add(expression, `raw call ${expression.text}`);
      }
      if (
        ts.isPropertyAccessExpression(expression) &&
        expression.name.text === "chat" &&
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === "ctx"
      ) {
        add(expression, "raw call ctx.chat");
      }
      if (
        expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text.endsWith("/llm/client")
      ) {
        add(node, "dynamic import llm/client");
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(file);
  return [...out].sort();
}

function caughtStructuredDispatchesWithoutConfigRethrow(relativePath: string): string[] {
  const absolutePath = path.join(ROOT, relativePath);
  const source = fs.readFileSync(absolutePath, "utf8");
  const file = ts.createSourceFile(absolutePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const failures: string[] = [];
  const containsStructuredDispatch = (node: ts.Node): boolean => {
    let found = false;
    const visit = (child: ts.Node): void => {
      if (
        ts.isCallExpression(child) &&
        ts.isIdentifier(child.expression) &&
        child.expression.text === "callStructured"
      ) {
        found = true;
        return;
      }
      if (!found) ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isTryStatement(node) && node.catchClause && containsStructuredDispatch(node.tryBlock)) {
      const catchText = node.catchClause.block.getText(file);
      if (!catchText.includes("instanceof ConfigError") || !catchText.includes("throw")) {
        const line = file.getLineAndCharacterOfPosition(node.catchClause.getStart(file)).line + 1;
        failures.push(`${relativePath}:${line}:catch around callStructured does not preserve ConfigError`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return failures;
}

describe("WP5 improve execution consumer boundary", () => {
  test("user/model work has no raw resolver, runner, or chat dispatch", () => {
    expect(GUARDED.flatMap(findings)).toEqual([]);
  });

  test("index selection is canonical and only origin-local client probes stay low-level", () => {
    const indexSelection = fs.readFileSync(path.join(ROOT, "src/llm/index-passes.ts"), "utf8");
    expect(indexSelection).toContain("prepareInlineExecution");
    expect(indexSelection).not.toContain("resolveLlmEngineUse");
    expect(indexSelection).not.toContain("chatCompletion(");

    const client = fs.readFileSync(path.join(ROOT, "src/llm/client.ts"), "utf8");
    expect(client).toContain("export async function isLlmAvailable");
    expect(client).toContain("export async function probeLlmCapabilities");
  });

  test("fail-soft transport wrappers preserve hard symbolic-credential config failures", () => {
    expect(GUARDED.flatMap(caughtStructuredDispatchesWithoutConfigRethrow)).toEqual([]);

    // These wrappers delegate to a local helper before their catch, so the AST
    // check above cannot see the dispatch call lexically. Keep their two
    // explicit propagation sites pinned as part of the consumer inventory.
    const reflect = fs.readFileSync(path.join(ROOT, "src/commands/improve/reflect.ts"), "utf8");
    expect(reflect).toContain("if (err instanceof ConfigError) throw err;");
    const extract = fs.readFileSync(path.join(ROOT, "src/commands/improve/extract.ts"), "utf8");
    expect(extract.match(/if \(err instanceof ConfigError\) throw err;/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
