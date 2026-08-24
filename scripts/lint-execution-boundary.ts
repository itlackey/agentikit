// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Symbol-origin ratchet for the resolved execution boundary (#809).
 *
 * User/model work must cross ResolvedExecutionRequestV1 -> lowerer -> runner.
 * This guard follows TypeScript symbols to their declaring module, so renaming
 * an import, reaching it through a namespace/barrel, or hiding it behind
 * parentheses/call/apply/bind/default injection cannot evade the inventory.
 */

import path from "node:path";
import ts from "typescript";

export interface ExecutionBoundaryTarget {
  readonly operation: string;
  readonly file: string;
  readonly exportName: string;
}

export interface ExecutionBoundaryReference {
  readonly operation: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly enclosing: string;
  readonly text: string;
}

export interface ExecutionBoundaryAllowRule {
  readonly operation: string;
  readonly file: string;
  readonly enclosing?: string;
  readonly maxReferences: number;
  readonly rationale: string;
  /** Authorities/exemptions are deliberately exact; migration debt is shrink-only. */
  readonly exact?: boolean;
}

export interface AnalyzeExecutionBoundaryOptions {
  readonly rootDir: string;
  readonly fileNames: readonly string[];
  readonly compilerOptions: ts.CompilerOptions;
  readonly targets?: readonly ExecutionBoundaryTarget[];
}

export interface ExecutionBoundaryPolicyResult {
  readonly unauthorized: readonly ExecutionBoundaryReference[];
  readonly countErrors: readonly string[];
}

const posix = (value: string): string => value.replaceAll(path.sep, "/");

export const EXECUTION_BOUNDARY_TARGETS: readonly ExecutionBoundaryTarget[] = Object.freeze([
  {
    operation: "runner.execute",
    file: "src/integrations/agent/runner-dispatch.ts",
    exportName: "executeRunner",
  },
  { operation: "runner.agent", file: "src/integrations/agent/spawn.ts", exportName: "runAgent" },
  {
    operation: "runner.sdk",
    file: "src/integrations/harnesses/opencode-sdk/sdk-runner.ts",
    exportName: "runOpencodeSdk",
  },
  { operation: "runner.builder", file: "src/integrations/agent/builders.ts", exportName: "getCommandBuilder" },
  { operation: "llm.chat", file: "src/llm/client.ts", exportName: "chatCompletion" },
  {
    operation: "engine.resolve",
    file: "src/integrations/agent/engine-resolution.ts",
    exportName: "resolveEngine",
  },
  {
    operation: "engine.resolve-llm",
    file: "src/integrations/agent/engine-resolution.ts",
    exportName: "resolveLlmEngineUse",
  },
  {
    operation: "engine.resolve-transport",
    file: "src/integrations/agent/engine-resolution.ts",
    exportName: "resolveEngineTransportMaterial",
  },
  {
    operation: "engine.require-llm",
    file: "src/integrations/agent/engine-resolution.ts",
    exportName: "requireLlmConfig",
  },
  {
    operation: "engine.default-llm-config",
    file: "src/integrations/agent/engine-resolution.ts",
    exportName: "getDefaultLlmConfig",
  },
  {
    operation: "engine.materialize-llm",
    file: "src/integrations/agent/engine-resolution.ts",
    exportName: "materializeLlmConnection",
  },
  {
    operation: "engine.materialize-credential",
    file: "src/integrations/agent/engine-resolution.ts",
    exportName: "resolveCredentialFromEnv",
  },
  {
    operation: "engine.lookup-credential",
    file: "src/integrations/agent/engine-resolution.ts",
    exportName: "lookupCredentialFromEnv",
  },
  {
    operation: "engine.materialize-runner",
    file: "src/integrations/agent/runner.ts",
    exportName: "materializeLlmRunnerConnection",
  },
  {
    operation: "engine.resolve-default-runner",
    file: "src/integrations/agent/runner.ts",
    exportName: "resolveDefaultLlmRunner",
  },
  {
    operation: "engine.resolve-triage",
    file: "src/integrations/agent/runner.ts",
    exportName: "resolveTriageJudgmentRunner",
  },
  {
    operation: "engine.resolve-improve-llm",
    file: "src/integrations/agent/runner.ts",
    exportName: "resolveImproveProcessLlmUse",
  },
  {
    operation: "engine.resolve-improve-runner",
    file: "src/integrations/agent/runner.ts",
    exportName: "resolveImproveProcessRunner",
  },
]);

const PERMANENT_EXECUTION_BOUNDARY_ALLOWLIST: readonly ExecutionBoundaryAllowRule[] = Object.freeze([
  {
    operation: "engine.resolve",
    file: "src/commands/agent/agent-dispatch.ts",
    enclosing: "akmAgentDispatch",
    maxReferences: 1,
    exact: true,
    rationale: "prompt-free interactive agent launch has no user/model work to lower",
  },
  {
    operation: "runner.execute",
    file: "src/commands/agent/agent-dispatch.ts",
    enclosing: "akmAgentDispatch",
    maxReferences: 1,
    exact: true,
    rationale: "prompt-free interactive agent launch has no dispatch payload",
  },
  {
    operation: "engine.resolve",
    file: "src/commands/health/checks.ts",
    enclosing: "runConfiguredEngineProbe",
    maxReferences: 2,
    exact: true,
    rationale: "read-only engine health validation does not execute user work",
  },
  {
    operation: "engine.resolve-transport",
    file: "src/integrations/agent/execution-lowering.ts",
    enclosing: "lowerResolvedExecutionRequest",
    maxReferences: 1,
    exact: true,
    rationale: "live lowering authority resolves symbolic transport material once",
  },
  {
    operation: "runner.execute",
    file: "src/integrations/agent/execution-lowering.ts",
    enclosing: "dispatchLoweredExecutionRequest",
    maxReferences: 1,
    exact: true,
    rationale: "registry-produced lowering dispatch authority",
  },
  {
    operation: "llm.chat",
    file: "src/integrations/agent/execution-lowering.ts",
    maxReferences: 1,
    exact: true,
    rationale: "direct-LLM lowerer transport authority",
  },
  {
    operation: "engine.materialize-credential",
    file: "src/integrations/agent/runner-dispatch.ts",
    enclosing: "acquireRunnerDispatchLease",
    maxReferences: 2,
    exact: true,
    rationale: "operation-scoped runner dispatch lease snapshots primary and SDK fallback credentials once",
  },
  {
    operation: "engine.materialize-runner",
    file: "src/integrations/agent/runner-dispatch.ts",
    enclosing: "executeRunner",
    maxReferences: 1,
    exact: true,
    rationale: "credential materialization occurs only at runner dispatch",
  },
  {
    operation: "engine.lookup-credential",
    file: "src/integrations/agent/runner-dispatch.ts",
    enclosing: "collectDispatchSensitiveValues",
    maxReferences: 2,
    exact: true,
    rationale: "dispatch-time redaction inventory reads primary and SDK fallback credential descriptors",
  },
  {
    operation: "engine.materialize-llm",
    file: "src/integrations/agent/runner-dispatch.ts",
    enclosing: "executeRunner",
    maxReferences: 1,
    exact: true,
    rationale: "SDK fallback credential materialization occurs only at dispatch",
  },
  {
    operation: "runner.agent",
    file: "src/integrations/agent/runner-dispatch.ts",
    enclosing: "executeRunner",
    maxReferences: 1,
    exact: true,
    rationale: "single low-level agent runner authority",
  },
  {
    operation: "runner.sdk",
    file: "src/integrations/agent/runner-dispatch.ts",
    enclosing: "executeRunner",
    maxReferences: 1,
    exact: true,
    rationale: "single low-level SDK runner authority",
  },
  {
    operation: "engine.materialize-llm",
    file: "src/integrations/agent/runner.ts",
    enclosing: "materializeLlmRunnerConnection",
    maxReferences: 1,
    exact: true,
    rationale: "runner-dispatch credential adapter implementation",
  },
  {
    operation: "engine.resolve-llm",
    file: "src/integrations/agent/runner.ts",
    enclosing: "resolveDefaultLlmRunner",
    maxReferences: 1,
    exact: true,
    rationale: "legacy symbolic runner adapter implementation; consumers are separately guarded",
  },
  {
    operation: "engine.resolve",
    file: "src/integrations/agent/runner.ts",
    enclosing: "resolveTriageJudgmentRunner",
    maxReferences: 1,
    exact: true,
    rationale: "legacy symbolic runner adapter implementation; consumers are separately guarded",
  },
  {
    operation: "engine.resolve-llm",
    file: "src/integrations/agent/runner.ts",
    enclosing: "resolveTriageJudgmentRunner",
    maxReferences: 1,
    exact: true,
    rationale: "legacy symbolic runner adapter implementation; consumers are separately guarded",
  },
  {
    operation: "engine.resolve-llm",
    file: "src/integrations/agent/runner.ts",
    enclosing: "resolveImproveProcessLlmUse",
    maxReferences: 2,
    exact: true,
    rationale: "legacy symbolic runner adapter implementation; consumers are separately guarded",
  },
  {
    operation: "runner.builder",
    file: "src/integrations/agent/spawn.ts",
    enclosing: "runAgent",
    maxReferences: 1,
    exact: true,
    rationale: "final harness argv/stdin/env construction authority",
  },
]);

/**
 * The one remaining exact compatibility seam after WP5 runtime convergence.
 * WP7 replaces the legacy workflow source-to-engine freeze resolver with the
 * durable common-request compiler. This is not an architectural exemption:
 * the single reference is exact-counted and must disappear with that cutover.
 */
export const PENDING_EXECUTION_BOUNDARY_COUNTS = Object.freeze({
  "src/workflows/ir/freeze.ts": { "engine.resolve-llm": 1 },
} as const);

const pendingRules: ExecutionBoundaryAllowRule[] = Object.entries(PENDING_EXECUTION_BOUNDARY_COUNTS).flatMap(
  ([file, operations]) =>
    Object.entries(operations).map(([operation, maxReferences]) => ({
      operation,
      file,
      maxReferences,
      exact: true,
      rationale: "temporary WP7 workflow-freeze compatibility seam; remove with durable common-request compilation",
    })),
);

export const EXECUTION_BOUNDARY_ALLOWLIST: readonly ExecutionBoundaryAllowRule[] = Object.freeze([
  ...PERMANENT_EXECUTION_BOUNDARY_ALLOWLIST,
  ...pendingRules,
]);

function canonicalSymbol(checker: ts.TypeChecker, input: ts.Symbol | undefined): ts.Symbol | undefined {
  let symbol = input;
  const seen = new Set<ts.Symbol>();
  while (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(symbol)) {
    seen.add(symbol);
    symbol = checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

function isTypeOnlyReference(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isImportDeclaration(current) || ts.isImportEqualsDeclaration(current)) return true;
    if (ts.isTypeQueryNode(current) || ts.isImportTypeNode(current)) return true;
    if (ts.isImportSpecifier(current)) return true;
    if (ts.isImportClause(current)) return current.isTypeOnly;
    if (ts.isTypeNode(current) || ts.isJSDoc(current)) return true;
    if (ts.isStatement(current) || ts.isSourceFile(current)) return false;
  }
  return false;
}

function isExportSyntax(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isExportDeclaration(current)) return true;
    if (ts.isStatement(current) || ts.isSourceFile(current)) return false;
  }
  return false;
}

function isDeclarationName(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    (ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent)) &&
    parent.name === node
  );
}

function isNonValuePropertyName(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) &&
      parent.name === node) ||
    (ts.isBindingElement(parent) && parent.propertyName === node)
  );
}

function enclosingName(node: ts.Node): string {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    if (current.name) return current.name.getText(current.getSourceFile());
    const parent = current.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    if (ts.isPropertyAssignment(parent)) return parent.name.getText(parent.getSourceFile());
    return "<anonymous>";
  }
  return "<module>";
}

function targetSymbols(
  program: ts.Program,
  checker: ts.TypeChecker,
  rootDir: string,
  targets: readonly ExecutionBoundaryTarget[],
): ReadonlyMap<ts.Symbol, ExecutionBoundaryTarget> {
  const byFile = new Map(
    program.getSourceFiles().map((source) => [posix(path.relative(rootDir, source.fileName)), source]),
  );
  const out = new Map<ts.Symbol, ExecutionBoundaryTarget>();
  for (const target of targets) {
    const source = byFile.get(target.file);
    if (!source) throw new Error(`execution-boundary target file is missing: ${target.file}`);
    const moduleSymbol = checker.getSymbolAtLocation(source);
    if (!moduleSymbol) throw new Error(`execution-boundary target is not a module: ${target.file}`);
    const exported = checker.getExportsOfModule(moduleSymbol).find((candidate) => candidate.name === target.exportName);
    const symbol = canonicalSymbol(checker, exported);
    if (!symbol) throw new Error(`execution-boundary export is missing: ${target.file}#${target.exportName}`);
    out.set(symbol, target);
  }
  return out;
}

function unwrapExpression(input: ts.Expression): ts.Expression {
  let expression = input;
  for (;;) {
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isAwaitExpression(expression)
    ) {
      expression = expression.expression;
      continue;
    }
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      expression = expression.right;
      continue;
    }
    return expression;
  }
}

function isConstVariable(declaration: ts.VariableDeclaration): boolean {
  return (
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) === ts.NodeFlags.Const
  );
}

/** Resolve only immutable, local string aliases; arbitrary expressions stay opaque. */
function staticStringValue(
  input: ts.Expression,
  checker: ts.TypeChecker,
  seen: ReadonlySet<ts.Symbol> = new Set(),
): string | undefined {
  const expression = unwrapExpression(input);
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = canonicalSymbol(checker, checker.getSymbolAtLocation(expression));
  if (!symbol || seen.has(symbol)) return undefined;
  const nextSeen = new Set(seen);
  nextSeen.add(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (!ts.isVariableDeclaration(declaration) || !isConstVariable(declaration) || !declaration.initializer) continue;
    const value = staticStringValue(declaration.initializer, checker, nextSeen);
    if (value !== undefined) return value;
  }
  return undefined;
}

type PassThroughFunction = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

function returnedExpression(node: PassThroughFunction): ts.Expression | undefined {
  const body = node.body;
  if (!body) return undefined;
  if (ts.isBlock(body)) {
    if (body.statements.length !== 1) return undefined;
    const statement = body.statements[0];
    if (!statement || !ts.isReturnStatement(statement) || !statement.expression) return undefined;
    return statement.expression;
  }
  return body;
}

function passThroughCandidates(input: ts.Expression, checker: ts.TypeChecker): readonly PassThroughFunction[] {
  const expression = unwrapExpression(input);
  const candidates: PassThroughFunction[] = [];
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return [expression];
  const symbol = canonicalSymbol(checker, checker.getSymbolAtLocation(expression));
  for (const declaration of symbol?.declarations ?? []) {
    if (ts.isFunctionDeclaration(declaration)) candidates.push(declaration);
    if (ts.isVariableDeclaration(declaration) && isConstVariable(declaration) && declaration.initializer) {
      const initializer = unwrapExpression(declaration.initializer);
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) candidates.push(initializer);
    }
  }
  return candidates;
}

function parameterIndexForExpression(
  input: ts.Expression,
  owner: PassThroughFunction,
  checker: ts.TypeChecker,
): number | undefined {
  const expression = unwrapExpression(input);
  if (!ts.isIdentifier(expression)) return undefined;
  const returnedSymbol = checker.getSymbolAtLocation(expression);
  return owner.parameters.findIndex(
    (parameter) => ts.isIdentifier(parameter.name) && checker.getSymbolAtLocation(parameter.name) === returnedSymbol,
  );
}

/**
 * Recognize deliberately boring identity/pass-through functions. Only a
 * single-expression return of one unchanged parameter qualifies; wrappers
 * that transform, branch, or perform block work remain opaque.
 */
function passThroughParameterIndex(
  input: ts.Expression,
  checker: ts.TypeChecker,
  seen: ReadonlySet<PassThroughFunction> = new Set(),
): number | undefined {
  for (const candidate of passThroughCandidates(input, checker)) {
    if (seen.has(candidate)) continue;
    const returned = returnedExpression(candidate);
    if (!returned) continue;
    const nextSeen = new Set(seen);
    nextSeen.add(candidate);
    let index = parameterIndexForExpression(returned, candidate, checker);
    const expression = unwrapExpression(returned);
    if (index === undefined && ts.isCallExpression(expression)) {
      const passed = passThroughArgument(expression, checker, nextSeen);
      if (passed) index = parameterIndexForExpression(passed, candidate, checker);
    }
    if (index !== undefined && index >= 0) return index;
  }
  return undefined;
}

function arrayArgument(input: ts.Expression | undefined, index: number): ts.Expression | undefined {
  const expression = input ? unwrapExpression(input) : undefined;
  if (!expression || !ts.isArrayLiteralExpression(expression)) return undefined;
  const element = expression.elements[index];
  if (!element || ts.isSpreadElement(element) || ts.isOmittedExpression(element)) return undefined;
  return element;
}

function passThroughArgument(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  seen: ReadonlySet<PassThroughFunction> = new Set(),
): ts.Expression | undefined {
  const callee = unwrapExpression(call.expression);
  const directIndex = passThroughParameterIndex(callee, checker, seen);
  if (directIndex !== undefined) return call.arguments[directIndex];
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return undefined;
  const member = ts.isPropertyAccessExpression(callee)
    ? callee.name.text
    : ts.isStringLiteralLike(callee.argumentExpression)
      ? callee.argumentExpression.text
      : undefined;
  const index = passThroughParameterIndex(callee.expression, checker, seen);
  if (index === undefined) return undefined;
  if (member === "call") return call.arguments[index + 1];
  if (member !== "apply") return undefined;
  return arrayArgument(call.arguments[1], index);
}

function symbolIsOnlyAmbient(symbol: ts.Symbol | undefined): boolean {
  return (
    symbol === undefined ||
    (symbol.declarations?.every((declaration) => declaration.getSourceFile().isDeclarationFile) ?? true)
  );
}

function importModuleSpecifier(node: ts.Node): string | undefined {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isImportDeclaration(current) && ts.isStringLiteralLike(current.moduleSpecifier)) {
      return current.moduleSpecifier.text;
    }
    if (
      ts.isImportEqualsDeclaration(current) &&
      ts.isExternalModuleReference(current.moduleReference) &&
      current.moduleReference.expression &&
      ts.isStringLiteralLike(current.moduleReference.expression)
    ) {
      return current.moduleReference.expression.text;
    }
    if (ts.isStatement(current) || ts.isSourceFile(current)) return undefined;
  }
  return undefined;
}

function isNamedNodeModuleImport(node: ts.Identifier, checker: ts.TypeChecker, importedName: string): boolean {
  const symbol = checker.getSymbolAtLocation(node);
  return (symbol?.declarations ?? []).some((declaration) => {
    const specifier = importModuleSpecifier(declaration);
    if (specifier !== "node:module" && specifier !== "module") return false;
    return (
      ts.isImportSpecifier(declaration) && (declaration.propertyName?.text ?? declaration.name.text) === importedName
    );
  });
}

function isNodeModuleNamespace(node: ts.Identifier, checker: ts.TypeChecker): boolean {
  const symbol = checker.getSymbolAtLocation(node);
  return (symbol?.declarations ?? []).some((declaration) => {
    const specifier = importModuleSpecifier(declaration);
    if (specifier !== "node:module" && specifier !== "module") return false;
    return (
      ts.isNamespaceImport(declaration) || ts.isImportClause(declaration) || ts.isImportEqualsDeclaration(declaration)
    );
  });
}

function isCreateRequireCallee(input: ts.Expression, checker: ts.TypeChecker): boolean {
  const expression = unwrapExpression(input);
  if (ts.isIdentifier(expression)) {
    return isNamedNodeModuleImport(expression, checker, "createRequire");
  }
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    const member = ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : ts.isStringLiteralLike(expression.argumentExpression)
        ? expression.argumentExpression.text
        : undefined;
    const base = unwrapExpression(expression.expression);
    return member === "createRequire" && ts.isIdentifier(base) && isNodeModuleNamespace(base, checker);
  }
  return false;
}

function isUnshadowedCommonJsGlobal(node: ts.Identifier, checker: ts.TypeChecker, name: "module" | "require"): boolean {
  return node.text === name && symbolIsOnlyAmbient(checker.getSymbolAtLocation(node));
}

function isRuntimeLoaderExpression(
  input: ts.Expression,
  checker: ts.TypeChecker,
  dynamicLoaders: ReadonlySet<ts.Symbol>,
  dynamicLoaderArrays: ReadonlyMap<ts.Symbol, ReadonlySet<number>> = new Map(),
): boolean {
  const expression = unwrapExpression(input);
  if (ts.isIdentifier(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    return (
      (symbol !== undefined && dynamicLoaders.has(symbol)) || isUnshadowedCommonJsGlobal(expression, checker, "require")
    );
  }
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    if (ts.isElementAccessExpression(expression)) {
      const array = unwrapExpression(expression.expression);
      const symbol = ts.isIdentifier(array) ? checker.getSymbolAtLocation(array) : undefined;
      const loaderIndices = symbol ? dynamicLoaderArrays.get(symbol) : undefined;
      if (loaderIndices) {
        const argument = expression.argumentExpression;
        const index = ts.isNumericLiteral(argument)
          ? Number(argument.text)
          : ts.isStringLiteralLike(argument) && /^\d+$/.test(argument.text)
            ? Number(argument.text)
            : undefined;
        if (index === undefined ? loaderIndices.size > 0 : loaderIndices.has(index)) return true;
      }
    }
    const member = ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : ts.isStringLiteralLike(expression.argumentExpression)
        ? expression.argumentExpression.text
        : undefined;
    const base = unwrapExpression(expression.expression);
    return member === "require" && ts.isIdentifier(base) && isUnshadowedCommonJsGlobal(base, checker, "module");
  }
  if (ts.isCallExpression(expression)) {
    const passed = passThroughArgument(expression, checker);
    if (passed && isRuntimeLoaderExpression(passed, checker, dynamicLoaders, dynamicLoaderArrays)) return true;
    if (isCreateRequireCallee(expression.expression, checker)) return true;
    const callee = unwrapExpression(expression.expression);
    if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
      const member = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isStringLiteralLike(callee.argumentExpression)
          ? callee.argumentExpression.text
          : undefined;
      return (
        member === "bind" && isRuntimeLoaderExpression(callee.expression, checker, dynamicLoaders, dynamicLoaderArrays)
      );
    }
  }
  return false;
}

interface DynamicModuleLoad {
  readonly call: ts.CallExpression;
  readonly specifier: ts.Expression;
}

type DynamicNamespaceEntry = ExecutionBoundaryTarget | DynamicNamespace;
type DynamicNamespace = ReadonlyMap<string, DynamicNamespaceEntry>;

function isBoundaryTarget(input: DynamicNamespaceEntry): input is ExecutionBoundaryTarget {
  return "operation" in input;
}

function typeOnlyExportDeclaration(declaration: ts.Declaration): boolean {
  if (ts.isExportSpecifier(declaration)) {
    return (
      declaration.isTypeOnly ||
      (ts.isExportDeclaration(declaration.parent.parent) && declaration.parent.parent.isTypeOnly)
    );
  }
  if (ts.isNamespaceExport(declaration)) {
    return ts.isExportDeclaration(declaration.parent) && declaration.parent.isTypeOnly;
  }
  return ts.isExportDeclaration(declaration) && declaration.isTypeOnly;
}

function hasRuntimeExport(symbol: ts.Symbol): boolean {
  const exportDeclarations = (symbol.declarations ?? []).filter(
    (declaration) =>
      ts.isExportSpecifier(declaration) || ts.isNamespaceExport(declaration) || ts.isExportDeclaration(declaration),
  );
  return (
    exportDeclarations.length === 0 || exportDeclarations.some((declaration) => !typeOnlyExportDeclaration(declaration))
  );
}

function moduleNamespace(
  moduleSymbol: ts.Symbol,
  checker: ts.TypeChecker,
  symbols: ReadonlyMap<ts.Symbol, ExecutionBoundaryTarget>,
  seen: ReadonlySet<ts.Symbol> = new Set(),
): DynamicNamespace {
  const canonicalModule = canonicalSymbol(checker, moduleSymbol) ?? moduleSymbol;
  if (seen.has(canonicalModule)) return new Map();
  const nextSeen = new Set(seen);
  nextSeen.add(canonicalModule);
  const entries = new Map<string, DynamicNamespaceEntry>();
  const moduleSources = new Set((canonicalModule.declarations ?? []).map((declaration) => declaration.getSourceFile()));
  const runtimeStarSymbols = new Set<ts.Symbol>();
  for (const source of moduleSources) {
    for (const statement of source.statements) {
      if (
        !ts.isExportDeclaration(statement) ||
        statement.isTypeOnly ||
        statement.exportClause ||
        !statement.moduleSpecifier
      ) {
        continue;
      }
      const targetModule = canonicalSymbol(checker, checker.getSymbolAtLocation(statement.moduleSpecifier));
      if (!targetModule) continue;
      for (const starExport of checker.getExportsOfModule(targetModule)) {
        const canonicalStarExport = canonicalSymbol(checker, starExport);
        if (canonicalStarExport) runtimeStarSymbols.add(canonicalStarExport);
      }
    }
  }
  for (const exported of checker.getExportsOfModule(canonicalModule)) {
    if (!hasRuntimeExport(exported)) continue;
    const canonical = canonicalSymbol(checker, exported);
    if (!canonical) continue;
    const declaredHere = (exported.declarations ?? []).some((declaration) =>
      moduleSources.has(declaration.getSourceFile()),
    );
    if (!declaredHere && !runtimeStarSymbols.has(canonical)) continue;
    const target = symbols.get(canonical);
    if (target) {
      entries.set(exported.name, target);
      continue;
    }
    if ((canonical.flags & ts.SymbolFlags.Module) === 0) continue;
    const nested = moduleNamespace(canonical, checker, symbols, nextSeen);
    if (nested.size > 0) entries.set(exported.name, nested);
  }
  return entries;
}

function flattenedTargets(namespace: DynamicNamespace): readonly ExecutionBoundaryTarget[] {
  const targets = new Map<string, ExecutionBoundaryTarget>();
  const visit = (current: DynamicNamespace): void => {
    for (const entry of current.values()) {
      if (isBoundaryTarget(entry)) targets.set(`${entry.operation}:${entry.file}:${entry.exportName}`, entry);
      else visit(entry);
    }
  };
  visit(namespace);
  return [...targets.values()];
}

function dynamicModuleLoad(
  input: ts.Expression,
  checker: ts.TypeChecker,
  dynamicLoaders: ReadonlySet<ts.Symbol>,
  dynamicLoaderArrays: ReadonlyMap<ts.Symbol, ReadonlySet<number>> = new Map(),
  seenWrappers: ReadonlySet<PassThroughFunction> = new Set(),
): DynamicModuleLoad | undefined {
  const expression = unwrapExpression(input);
  if (!ts.isCallExpression(expression)) return undefined;
  const first = expression.arguments[0];
  if (expression.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return first ? { call: expression, specifier: first } : undefined;
  }
  const callee = unwrapExpression(expression.expression);
  if (isRuntimeLoaderExpression(callee, checker, dynamicLoaders, dynamicLoaderArrays)) {
    return first ? { call: expression, specifier: first } : undefined;
  }
  for (const candidate of passThroughCandidates(callee, checker)) {
    if (seenWrappers.has(candidate)) continue;
    const returned = returnedExpression(candidate);
    if (!returned) continue;
    const nextSeen = new Set(seenWrappers);
    nextSeen.add(candidate);
    const nested = dynamicModuleLoad(returned, checker, dynamicLoaders, dynamicLoaderArrays, nextSeen);
    if (!nested) continue;
    const index = parameterIndexForExpression(nested.specifier, candidate, checker);
    const specifier =
      index === undefined || index < 0
        ? undefined
        : (expression.arguments[index] ?? candidate.parameters[index]?.initializer);
    if (specifier) return { call: expression, specifier };
  }
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return undefined;
  const member = ts.isPropertyAccessExpression(callee)
    ? callee.name.text
    : ts.isStringLiteralLike(callee.argumentExpression)
      ? callee.argumentExpression.text
      : undefined;
  if (!isRuntimeLoaderExpression(callee.expression, checker, dynamicLoaders, dynamicLoaderArrays)) return undefined;
  if (member === "call") {
    const specifier = expression.arguments[1];
    return specifier ? { call: expression, specifier } : undefined;
  }
  if (member === "apply") {
    const specifier = arrayArgument(expression.arguments[1], 0);
    return specifier ? { call: expression, specifier } : undefined;
  }
  return undefined;
}

function resolveModuleTargetExports(
  moduleName: string,
  source: ts.SourceFile,
  program: ts.Program,
  checker: ts.TypeChecker,
  compilerOptions: ts.CompilerOptions,
  symbols: ReadonlyMap<ts.Symbol, ExecutionBoundaryTarget>,
): DynamicNamespace | undefined {
  const resolved = ts.resolveModuleName(moduleName, source.fileName, compilerOptions, ts.sys).resolvedModule;
  if (!resolved) return undefined;
  const resolvedPath = posix(path.resolve(resolved.resolvedFileName));
  const moduleSource = program
    .getSourceFiles()
    .find((candidate) => posix(path.resolve(candidate.fileName)) === resolvedPath);
  if (!moduleSource) return undefined;
  const moduleSymbol = checker.getSymbolAtLocation(moduleSource);
  if (!moduleSymbol) return undefined;
  const namespace = moduleNamespace(moduleSymbol, checker, symbols);
  return namespace.size > 0 ? namespace : undefined;
}

function resolveDynamicTargetExports(
  load: DynamicModuleLoad,
  program: ts.Program,
  checker: ts.TypeChecker,
  compilerOptions: ts.CompilerOptions,
  symbols: ReadonlyMap<ts.Symbol, ExecutionBoundaryTarget>,
): DynamicNamespace | undefined {
  const moduleName = staticStringValue(load.specifier, checker);
  return moduleName === undefined
    ? undefined
    : resolveModuleTargetExports(moduleName, load.call.getSourceFile(), program, checker, compilerOptions, symbols);
}

function addReference(
  out: Map<string, ExecutionBoundaryReference>,
  rootDir: string,
  source: ts.SourceFile,
  node: ts.Node,
  target: ExecutionBoundaryTarget,
): void {
  const file = posix(path.relative(rootDir, source.fileName));
  if (file === target.file) return;
  const start = node.getStart(source);
  const location = source.getLineAndCharacterOfPosition(start);
  const reference: ExecutionBoundaryReference = {
    operation: target.operation,
    file,
    line: location.line + 1,
    column: location.character + 1,
    enclosing: enclosingName(node),
    text: node.getText(source).slice(0, 160),
  };
  out.set(`${reference.operation}:${reference.file}:${start}`, reference);
}

/** Analyze a real or fixture TypeScript program without applying policy. */
export function analyzeExecutionBoundary(
  options: AnalyzeExecutionBoundaryOptions,
): readonly ExecutionBoundaryReference[] {
  const targets = options.targets ?? EXECUTION_BOUNDARY_TARGETS;
  const program = ts.createProgram({ rootNames: [...options.fileNames], options: options.compilerOptions });
  const checker = program.getTypeChecker();
  const symbols = targetSymbols(program, checker, options.rootDir, targets);
  const references = new Map<string, ExecutionBoundaryReference>();

  for (const source of program.getSourceFiles()) {
    const relative = posix(path.relative(options.rootDir, source.fileName));
    if (!relative.startsWith("src/") || source.isDeclarationFile) continue;
    const dynamicLoaders = new Set<ts.Symbol>();
    const dynamicLoaderArrays = new Map<ts.Symbol, Set<number>>();
    const dynamicNamespaces = new Map<ts.Symbol, DynamicNamespace>();
    const dynamicObjectBindings = new Map<ts.ObjectBindingPattern, DynamicNamespace>();

    const staticMemberName = (node: ts.Node | undefined): string | undefined => {
      if (!node) return undefined;
      if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) {
        if (ts.isStringLiteralLike(node)) return node.text;
        const symbol = checker.getSymbolAtLocation(node);
        for (const declaration of symbol?.declarations ?? []) {
          if (
            ts.isVariableDeclaration(declaration) &&
            declaration.initializer &&
            ts.isStringLiteralLike(unwrapExpression(declaration.initializer))
          ) {
            return (unwrapExpression(declaration.initializer) as ts.StringLiteralLike).text;
          }
        }
        return node.text;
      }
      return undefined;
    };

    const namespaceForExpression = (
      input: ts.Expression,
      seenReturns: ReadonlySet<PassThroughFunction> = new Set(),
    ): DynamicNamespace | undefined => {
      const expression = unwrapExpression(input);
      if (ts.isIdentifier(expression)) {
        const symbol = checker.getSymbolAtLocation(expression);
        return symbol ? dynamicNamespaces.get(symbol) : undefined;
      }
      const load = dynamicModuleLoad(expression, checker, dynamicLoaders, dynamicLoaderArrays);
      if (load) return resolveDynamicTargetExports(load, program, checker, options.compilerOptions, symbols);
      if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
        const namespace = namespaceForExpression(expression.expression, seenReturns);
        const member = ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : staticMemberName(expression.argumentExpression);
        const entry = member ? namespace?.get(member) : undefined;
        return entry && !isBoundaryTarget(entry) ? entry : undefined;
      }
      if (ts.isObjectLiteralExpression(expression)) {
        const entries = new Map<string, DynamicNamespaceEntry>();
        for (const property of expression.properties) {
          if (ts.isSpreadAssignment(property)) {
            const spread = namespaceForExpression(property.expression, seenReturns);
            if (spread) for (const [name, entry] of spread) entries.set(name, entry);
            continue;
          }
          if (!ts.isPropertyAssignment(property)) continue;
          const name = staticMemberName(property.name);
          const nested = namespaceForExpression(property.initializer, seenReturns);
          if (name && nested) entries.set(name, nested);
        }
        return entries.size > 0 ? entries : undefined;
      }
      if (ts.isCallExpression(expression)) {
        const passed = passThroughArgument(expression, checker);
        if (passed) return namespaceForExpression(passed, seenReturns);
        const callee = unwrapExpression(expression.expression);
        if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
          const member = ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : staticMemberName(callee.argumentExpression);
          const base = unwrapExpression(callee.expression);
          if (
            member === "resolve" &&
            ts.isIdentifier(base) &&
            base.text === "Promise" &&
            symbolIsOnlyAmbient(checker.getSymbolAtLocation(base))
          ) {
            const value = expression.arguments[0];
            if (value) return namespaceForExpression(value, seenReturns);
          }
          if (member === "catch" || member === "finally") {
            return namespaceForExpression(callee.expression, seenReturns);
          }
          if (member === "then") {
            const namespace = namespaceForExpression(callee.expression, seenReturns);
            const callback = expression.arguments[0];
            if (namespace && !callback) return namespace;
            if (namespace && callback) {
              if (passThroughParameterIndex(callback, checker) === 0) return namespace;
              for (const candidate of passThroughCandidates(callback, checker)) {
                if (seenReturns.has(candidate)) continue;
                const returned = returnedExpression(candidate);
                if (!returned) continue;
                const nextSeen = new Set(seenReturns);
                nextSeen.add(candidate);
                const projected = namespaceForExpression(returned, nextSeen);
                if (projected) return projected;
              }
            }
          }
        }
        for (const candidate of passThroughCandidates(expression.expression, checker)) {
          if (candidate.parameters.length !== 0 || seenReturns.has(candidate)) continue;
          const returned = returnedExpression(candidate);
          if (!returned) continue;
          const nextSeen = new Set(seenReturns);
          nextSeen.add(candidate);
          const exports = namespaceForExpression(returned, nextSeen);
          if (exports) return exports;
        }
      }
      return undefined;
    };

    // Index CommonJS/ES dynamic loader aliases and namespace flow to a small
    // fixed point. Bindings are followed through declarations, assignments,
    // default/rest parameters, ordinary callback calls, and Promise chains.
    for (let pass = 0; pass < 24; pass += 1) {
      let changed = false;
      const addLoader = (identifier: ts.Identifier, expression: ts.Expression): void => {
        const symbol = checker.getSymbolAtLocation(identifier);
        if (
          symbol &&
          isRuntimeLoaderExpression(expression, checker, dynamicLoaders, dynamicLoaderArrays) &&
          !dynamicLoaders.has(symbol)
        ) {
          dynamicLoaders.add(symbol);
          changed = true;
        }
        const namespace = namespaceForExpression(expression);
        if (symbol && namespace && !dynamicNamespaces.has(symbol)) {
          dynamicNamespaces.set(symbol, namespace);
          changed = true;
        }
      };
      const addLoaderArray = (identifier: ts.Identifier, expressions: readonly ts.Expression[]): void => {
        const symbol = checker.getSymbolAtLocation(identifier);
        if (!symbol) return;
        const current = dynamicLoaderArrays.get(symbol) ?? new Set<number>();
        for (const [index, expression] of expressions.entries()) {
          if (
            isRuntimeLoaderExpression(expression, checker, dynamicLoaders, dynamicLoaderArrays) &&
            !current.has(index)
          ) {
            current.add(index);
            changed = true;
          }
        }
        if (current.size > 0) dynamicLoaderArrays.set(symbol, current);
      };
      const bindPattern = (pattern: ts.BindingName, expression: ts.Expression | undefined): void => {
        if (ts.isIdentifier(pattern)) {
          if (expression) addLoader(pattern, expression);
          return;
        }
        if (ts.isObjectBindingPattern(pattern)) {
          const namespace = expression ? namespaceForExpression(expression) : undefined;
          if (namespace && !dynamicObjectBindings.has(pattern)) {
            dynamicObjectBindings.set(pattern, namespace);
            changed = true;
          }
          for (const element of pattern.elements) {
            const exportedName = staticMemberName(element.propertyName ?? element.name);
            const entry = exportedName ? namespace?.get(exportedName) : undefined;
            if (entry && !isBoundaryTarget(entry) && ts.isIdentifier(element.name)) {
              const symbol = checker.getSymbolAtLocation(element.name);
              if (symbol && !dynamicNamespaces.has(symbol)) {
                dynamicNamespaces.set(symbol, entry);
                changed = true;
              }
            }
            if (element.initializer) bindPattern(element.name, element.initializer);
          }
          return;
        }
        const array = expression ? unwrapExpression(expression) : undefined;
        const values = array && ts.isArrayLiteralExpression(array) ? array.elements : [];
        for (const [index, element] of pattern.elements.entries()) {
          if (!element || ts.isOmittedExpression(element)) continue;
          const value = values[index];
          const valueExpression = value && !ts.isOmittedExpression(value) ? value : undefined;
          if (element.dotDotDotToken && ts.isIdentifier(element.name)) {
            const rest = values
              .slice(index)
              .filter((entry): entry is ts.Expression => !ts.isOmittedExpression(entry) && !ts.isSpreadElement(entry));
            addLoaderArray(element.name, rest);
          } else {
            bindPattern(
              element.name,
              valueExpression && !ts.isSpreadElement(valueExpression) ? valueExpression : undefined,
            );
          }
          if (element.initializer) bindPattern(element.name, element.initializer);
        }
      };
      const bindCall = (call: ts.CallExpression, candidate: PassThroughFunction): void => {
        for (const [index, parameter] of candidate.parameters.entries()) {
          if (parameter.dotDotDotToken) {
            if (ts.isIdentifier(parameter.name)) addLoaderArray(parameter.name, call.arguments.slice(index));
            continue;
          }
          bindPattern(parameter.name, call.arguments[index] ?? parameter.initializer);
        }
      };
      const bindArrayAssignment = (left: ts.ArrayLiteralExpression, right: ts.Expression): void => {
        const values = unwrapExpression(right);
        if (!ts.isArrayLiteralExpression(values)) return;
        for (const [index, target] of left.elements.entries()) {
          if (ts.isOmittedExpression(target)) continue;
          const value = values.elements[index];
          if (!value || ts.isOmittedExpression(value) || ts.isSpreadElement(value)) continue;
          if (ts.isSpreadElement(target) && ts.isIdentifier(target.expression)) {
            const rest = values.elements
              .slice(index)
              .filter((entry): entry is ts.Expression => !ts.isOmittedExpression(entry) && !ts.isSpreadElement(entry));
            addLoaderArray(target.expression, rest);
          } else if (ts.isIdentifier(target)) {
            addLoader(target, value);
          }
        }
      };
      const indexDynamicFlow = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && node.initializer) bindPattern(node.name, node.initializer);
        if (ts.isParameter(node) && node.initializer) bindPattern(node.name, node.initializer);
        if (ts.isBindingElement(node) && node.initializer) bindPattern(node.name, node.initializer);
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const left = unwrapExpression(node.left as ts.Expression);
          if (ts.isIdentifier(left)) addLoader(left, node.right);
          if (ts.isArrayLiteralExpression(left)) bindArrayAssignment(left, node.right);
        }
        if (ts.isCallExpression(node)) {
          for (const candidate of passThroughCandidates(node.expression, checker)) bindCall(node, candidate);
          const callee = unwrapExpression(node.expression);
          if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
            const member = ts.isPropertyAccessExpression(callee)
              ? callee.name.text
              : staticMemberName(callee.argumentExpression);
            const namespace = member === "then" ? namespaceForExpression(callee.expression) : undefined;
            const callback = node.arguments[0];
            if (namespace && callback) {
              for (const candidate of passThroughCandidates(callback, checker)) {
                const parameter = candidate.parameters[0];
                if (parameter) bindPattern(parameter.name, callee.expression);
              }
            }
          }
        }
        ts.forEachChild(node, indexDynamicFlow);
      };
      indexDynamicFlow(source);
      if (!changed) break;
    }

    const recordDynamicBinding = (
      pattern: ts.ObjectBindingPattern | ts.ObjectLiteralExpression,
      exports: DynamicNamespace,
    ): void => {
      if (ts.isObjectBindingPattern(pattern)) {
        for (const element of pattern.elements) {
          const exportedName = staticMemberName(element.propertyName ?? element.name);
          const target = exportedName ? exports.get(exportedName) : undefined;
          if (target && isBoundaryTarget(target)) addReference(references, options.rootDir, source, element, target);
          if (target && !isBoundaryTarget(target) && ts.isObjectBindingPattern(element.name)) {
            recordDynamicBinding(element.name, target);
          }
        }
        return;
      }
      for (const property of pattern.properties) {
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
        const exportedName = staticMemberName(property.name);
        const target = exportedName ? exports.get(exportedName) : undefined;
        if (target && isBoundaryTarget(target)) addReference(references, options.rootDir, source, property, target);
      }
    };

    const visit = (node: ts.Node): void => {
      if (
        (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
        !isTypeOnlyReference(node) &&
        !isExportSyntax(node)
      ) {
        if (!isDeclarationName(node) && !isNonValuePropertyName(node)) {
          const symbol = canonicalSymbol(checker, checker.getSymbolAtLocation(node));
          const target = symbol ? symbols.get(symbol) : undefined;
          if (target) addReference(references, options.rootDir, source, node, target);
        }
      }

      if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
        const namespace =
          node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)
            ? resolveModuleTargetExports(
                node.moduleSpecifier.text,
                source,
                program,
                checker,
                options.compilerOptions,
                symbols,
              )
            : undefined;
        if (!node.exportClause && namespace) {
          for (const target of flattenedTargets(namespace)) {
            addReference(references, options.rootDir, source, node, target);
          }
        } else if (node.exportClause && ts.isNamespaceExport(node.exportClause) && namespace) {
          for (const target of flattenedTargets(namespace)) {
            addReference(references, options.rootDir, source, node.exportClause, target);
          }
        } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const element of node.exportClause.elements) {
            if (element.isTypeOnly) continue;
            const exportedName = element.propertyName?.text ?? element.name.text;
            const entry = namespace?.get(exportedName);
            if (entry) {
              const targets = isBoundaryTarget(entry) ? [entry] : flattenedTargets(entry);
              for (const target of targets) addReference(references, options.rootDir, source, element, target);
              continue;
            }
            const symbol = canonicalSymbol(checker, checker.getSymbolAtLocation(element.name));
            const target = symbol ? symbols.get(symbol) : undefined;
            if (target) addReference(references, options.rootDir, source, element, target);
          }
        }
      }

      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
        const exports = namespaceForExpression(node.initializer);
        if (exports) recordDynamicBinding(node.name, exports);
      }

      if (ts.isObjectBindingPattern(node)) {
        const namespace = dynamicObjectBindings.get(node);
        if (namespace) recordDynamicBinding(node, namespace);
      }

      if (ts.isCallExpression(node)) {
        const callee = unwrapExpression(node.expression);
        if (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) {
          for (const [index, parameter] of callee.parameters.entries()) {
            if (!ts.isObjectBindingPattern(parameter.name)) continue;
            const argument = node.arguments[index];
            const exports = argument ? namespaceForExpression(argument) : undefined;
            if (exports) recordDynamicBinding(parameter.name, exports);
          }
        }
      }

      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isObjectLiteralExpression(unwrapExpression(node.left as ts.Expression))
      ) {
        const exports = namespaceForExpression(node.right);
        if (exports)
          recordDynamicBinding(unwrapExpression(node.left as ts.Expression) as ts.ObjectLiteralExpression, exports);
      }

      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const namespace = namespaceForExpression(node.expression);
        const memberNode = ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression;
        const member = ts.isPropertyAccessExpression(node) ? node.name.text : staticMemberName(node.argumentExpression);
        const target = member ? namespace?.get(member) : undefined;
        const memberSymbol = memberNode ? canonicalSymbol(checker, checker.getSymbolAtLocation(memberNode)) : undefined;
        const symbolTarget = memberSymbol ? symbols.get(memberSymbol) : undefined;
        if (target && isBoundaryTarget(target) && symbolTarget !== target) {
          addReference(references, options.rootDir, source, node, target);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return [...references.values()].sort(
    (left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column,
  );
}

/** Apply a checked-in, count-bounded allowlist to the symbol-origin inventory. */
export function evaluateExecutionBoundaryPolicy(
  references: readonly ExecutionBoundaryReference[],
  rules: readonly ExecutionBoundaryAllowRule[],
): ExecutionBoundaryPolicyResult {
  const matched = new Map<ExecutionBoundaryAllowRule, ExecutionBoundaryReference[]>();
  const unauthorized: ExecutionBoundaryReference[] = [];
  for (const reference of references) {
    const candidates = rules.filter(
      (rule) =>
        rule.operation === reference.operation &&
        rule.file === reference.file &&
        (rule.enclosing === undefined || rule.enclosing === reference.enclosing),
    );
    if (candidates.length !== 1) {
      unauthorized.push(reference);
      continue;
    }
    const rule = candidates[0];
    if (!rule) {
      unauthorized.push(reference);
      continue;
    }
    const entries = matched.get(rule) ?? [];
    entries.push(reference);
    matched.set(rule, entries);
  }
  const countErrors: string[] = [];
  for (const rule of rules) {
    const count = matched.get(rule)?.length ?? 0;
    if (count > rule.maxReferences || (rule.exact && count !== rule.maxReferences)) {
      countErrors.push(
        `${rule.file} [${rule.operation}]${rule.enclosing ? ` ${rule.enclosing}` : ""}: expected ${rule.exact ? "exactly" : "at most"} ${rule.maxReferences}, found ${count} (${rule.rationale})`,
      );
    }
  }
  return { unauthorized, countErrors };
}

function readRepoProgram(rootDir: string): AnalyzeExecutionBoundaryOptions {
  const configPath = ts.findConfigFile(rootDir, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) throw new Error("tsconfig.json not found");
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    },
  );
  if (!parsed) throw new Error("failed to parse tsconfig.json");
  return {
    rootDir,
    fileNames: parsed.fileNames.filter((file) => posix(path.relative(rootDir, file)).startsWith("src/")),
    compilerOptions: parsed.options,
  };
}

/** Analyze the checked-in production tree. Policy is applied by the architecture test. */
export function collectProductionExecutionBoundaryReferences(
  rootDir = path.resolve(import.meta.dir, ".."),
): readonly ExecutionBoundaryReference[] {
  return analyzeExecutionBoundary(readRepoProgram(rootDir));
}

if (import.meta.main) {
  const references = collectProductionExecutionBoundaryReferences();
  const policy = evaluateExecutionBoundaryPolicy(references, EXECUTION_BOUNDARY_ALLOWLIST);
  if (policy.unauthorized.length === 0 && policy.countErrors.length === 0) {
    const pendingCount = Object.values(PENDING_EXECUTION_BOUNDARY_COUNTS).reduce(
      (total, operations) => total + Object.values(operations).reduce<number>((sum, count) => sum + count, 0),
      0,
    );
    console.log(
      `lint-execution-boundary: OK — symbol-origin inventory matches exact authorities/exemptions (${pendingCount} temporary WP7 compatibility reference(s) pinned)`,
    );
    process.exit(0);
  }
  console.error(
    `lint-execution-boundary: ${policy.unauthorized.length} unauthorized reference(s), ${policy.countErrors.length} allowlist count error(s)`,
  );
  for (const reference of policy.unauthorized) {
    console.error(
      `  ${reference.file}:${reference.line}:${reference.column} [${reference.operation}] ${reference.enclosing} > ${reference.text}`,
    );
  }
  for (const error of policy.countErrors) console.error(`  ${error}`);
  process.exit(1);
}
