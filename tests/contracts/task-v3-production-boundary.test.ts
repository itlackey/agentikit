// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dir, "../..");
const SRC = path.join(ROOT, "src");
const TASK_V2_MIGRATOR = "scripts/akm-migrate/migrate/task-to-v3.ts";

function sourceFiles(directory = SRC): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(absolute);
  }
  return out.sort();
}

function relative(file: string): string {
  return path.relative(ROOT, file).replaceAll(path.sep, "/");
}

function legacyRuntimeImports(fileName: string): string[] {
  const rel = relative(fileName);
  if (rel === TASK_V2_MIGRATOR) return [];
  const source = fs.readFileSync(fileName, "utf8");
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: string[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const moduleName = statement.moduleSpecifier.text;
    const imported = statement.importClause?.namedBindings;
    const names =
      imported && ts.isNamedImports(imported)
        ? imported.elements.map((element) => element.propertyName?.text ?? element.name.text)
        : [];
    if (/(?:^|\/)tasks\/parser$/.test(moduleName)) violations.push(`${rel}: legacy task parser import`);
    if (names.includes("TaskDocument")) violations.push(`${rel}: legacy TaskDocument import`);
    if (rel.startsWith("src/tasks/") && /(?:^|\/)integrations\/agent\/(?:inline-execution|spawn)$/.test(moduleName)) {
      violations.push(`${rel}: raw task execution import ${moduleName}`);
    }
  }
  return violations;
}

describe("task-v3 production boundary", () => {
  test("task v2 has one migration-only reader and no parallel parser/schema modules", () => {
    expect(fs.existsSync(path.join(SRC, "tasks", "parser.ts"))).toBe(false);
    expect(fs.existsSync(path.join(SRC, "tasks", "schema.ts"))).toBe(false);
    expect(fs.existsSync(path.join(SRC, "tasks", "migrate-v2-to-v3.ts"))).toBe(false);
    expect(sourceFiles().flatMap(legacyRuntimeImports)).toEqual([]);
    const migrator = fs.readFileSync(path.join(ROOT, TASK_V2_MIGRATOR), "utf8");
    expect(migrator).not.toMatch(/from\s+["']\.\/(?:parser|schema)["']/);
  });

  test("the runner prepares v3 before reserving durable history", () => {
    const source = fs.readFileSync(path.join(SRC, "tasks", "runner.ts"), "utf8");
    expect(source.indexOf("parseTaskV3Yaml(")).toBeLessThan(source.indexOf("reserveTaskAttempt("));
    expect(source.indexOf("prepareTaskV3Execution(")).toBeLessThan(source.indexOf("reserveTaskAttempt("));
    expect(source).toContain("dispatchPreparedCommandInvocation(");
    expect(source).not.toContain("parseTaskDocument(");
    expect(source).not.toContain("prepareInlineExecution(");
  });
});
