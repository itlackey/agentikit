// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const PROPOSAL_CONSUMERS = ["src/commands/proposal/propose.ts", "src/commands/proposal/drain.ts"] as const;

const RAW_MODULES = {
  "engine-resolution": /\/integrations\/agent\/engine-resolution(?:\.js)?$/,
  "runner-dispatch": /\/integrations\/agent\/runner-dispatch(?:\.js)?$/,
  "llm-client": /\/llm\/client(?:\.js)?$/,
} as const;

const RAW_SYMBOLS = new Set(["resolveEngine", "resolveEngineTransportMaterial", "executeRunner", "chatCompletion"]);

function rawModule(moduleName: string): keyof typeof RAW_MODULES | undefined {
  return (Object.entries(RAW_MODULES).find(([, pattern]) => pattern.test(moduleName))?.[0] ?? undefined) as
    | keyof typeof RAW_MODULES
    | undefined;
}

/**
 * AST-owned rather than spelling-owned: aliased imports, namespace imports,
 * `require`, and dynamic import wrappers cannot make a proposal consumer's raw
 * transport dependency disappear from the ratchet. The one permitted legacy
 * module import is the non-dispatch `collectDispatchSensitiveValues` helper,
 * retained for redacting file-written drafts.
 */
function bypassesInSource(source: string, relativePath = "fixture.ts"): string[] {
  const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const module = rawModule(node.moduleSpecifier.text);
      const clause = node.importClause;
      if (module === "engine-resolution" || module === "llm-client") violations.add(module);
      if (module === "runner-dispatch" && clause) {
        if (clause.name || (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))) {
          violations.add(module);
        }
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) {
            if (RAW_SYMBOLS.has(element.propertyName?.text ?? element.name.text)) violations.add(module);
          }
        }
      }
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          if (RAW_SYMBOLS.has(element.propertyName?.text ?? element.name.text)) violations.add("raw-symbol");
        }
      }
    }
    const moduleArgument = ts.isCallExpression(node) ? node.arguments[0] : undefined;
    if (ts.isCallExpression(node) && moduleArgument && ts.isStringLiteral(moduleArgument)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if ((isDynamicImport || isRequire) && rawModule(moduleArgument.text)) {
        violations.add(isDynamicImport ? "dynamic-raw-module" : "required-raw-module");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...violations].sort();
}

function bypassesIn(relativePath: string): string[] {
  const source = fs.readFileSync(path.resolve(import.meta.dir, "../..", relativePath), "utf8");
  return bypassesInSource(source, relativePath);
}

describe("proposal execution consumers use the resolved lowering boundary", () => {
  for (const relativePath of PROPOSAL_CONSUMERS) {
    test(`${relativePath} cannot import a legacy resolver or raw transport`, () => {
      expect(bypassesIn(relativePath)).toEqual([]);
    });
  }

  test("ratchet catches aliased, namespace, and dynamic bypass wrappers", () => {
    const fixture = [
      'import { executeRunner as invoke } from "../../src/integrations/agent/runner-dispatch";',
      'import * as llm from "../../src/llm/client";',
      'const transport = await import("../../src/integrations/agent/engine-resolution.js");',
    ].join("\n");
    expect(bypassesInSource(fixture)).toEqual(["dynamic-raw-module", "llm-client", "raw-symbol", "runner-dispatch"]);
  });
});
