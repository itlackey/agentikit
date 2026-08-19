// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { nodePinnedRequestHelperSource } from "../../src/registry/pinned-request-helper";

const ROOT = path.resolve(import.meta.dir, "../..");
const SRC_DIR = path.join(ROOT, "src");
const REGISTRY_DIR = path.join(ROOT, "src/registry");
const PINNED_TRANSPORT = path.join(REGISTRY_DIR, "pinned-transport.ts");

function sourceFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(fullPath);
    return entry.isFile() && /\.(?:[cm]?[jt]s)$/.test(entry.name) ? [fullPath] : [];
  });
}

function networkCapabilities(source: string, fileName = "probe.ts"): string[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const taintedNames = new Set(["fetch"]);
  const retryNamespaces = new Set<string>();
  const findings = new Set<string>();

  function isGlobalFetch(node: ts.Node): boolean {
    return (
      ((ts.isPropertyAccessExpression(node) && node.name.text === "fetch") ||
        (ts.isElementAccessExpression(node) &&
          ts.isStringLiteral(node.argumentExpression) &&
          node.argumentExpression.text === "fetch")) &&
      ts.isIdentifier(node.expression) &&
      ["globalThis", "window", "Bun"].includes(node.expression.text)
    );
  }

  function discoverAliases(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleName = node.moduleSpecifier.text;
      if (moduleName.endsWith("/core/common") || moduleName.endsWith("/core/common.ts")) {
        if (node.importClause?.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings)) {
          retryNamespaces.add(node.importClause.namedBindings.name.text);
        }
        for (const element of node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
          ? node.importClause.namedBindings.elements
          : []) {
          if (element.propertyName?.text === "fetchWithRetry" || element.name.text === "fetchWithRetry") {
            taintedNames.add(element.name.text);
            findings.add(`import:${moduleName}:${element.name.text}`);
          }
        }
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (
        (ts.isIdentifier(node.initializer) && taintedNames.has(node.initializer.text)) ||
        isGlobalFetch(node.initializer) ||
        (ts.isPropertyAccessExpression(node.initializer) &&
          ts.isIdentifier(node.initializer.expression) &&
          retryNamespaces.has(node.initializer.expression.text) &&
          node.initializer.name.text === "fetchWithRetry")
      ) {
        taintedNames.add(node.name.text);
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      ["globalThis", "window", "Bun"].includes(node.initializer.text)
    ) {
      for (const element of node.name.elements) {
        const importedName = element.propertyName?.getText(sourceFile) ?? element.name.getText(sourceFile);
        if (importedName === "fetch" && ts.isIdentifier(element.name)) taintedNames.add(element.name.text);
      }
    }
    ts.forEachChild(node, discoverAliases);
  }

  discoverAliases(sourceFile);
  function inspectCalls(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && taintedNames.has(node.expression.text)) {
        findings.add(`call:${node.expression.text}`);
      } else if (isGlobalFetch(node.expression)) {
        findings.add(`call:${node.expression.getText(sourceFile)}`);
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        retryNamespaces.has(node.expression.expression.text) &&
        node.expression.name.text === "fetchWithRetry"
      ) {
        findings.add(`call:${node.expression.getText(sourceFile)}`);
      }
    }
    ts.forEachChild(node, inspectCalls);
  }
  inspectCalls(sourceFile);
  return [...findings].sort();
}

/** Find raw socket/request call sites even when imports and callables are aliased. */
function rawHttpCapabilities(source: string, fileName = "probe.ts"): string[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const compilerOptions: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  };
  const compilerHost = ts.createCompilerHost(compilerOptions);
  compilerHost.fileExists = (candidate) => candidate === fileName;
  compilerHost.getSourceFile = (candidate) => (candidate === fileName ? sourceFile : undefined);
  compilerHost.readFile = (candidate) => (candidate === fileName ? source : undefined);
  const checker = ts
    .createProgram({ rootNames: [fileName], options: compilerOptions, host: compilerHost })
    .getTypeChecker();
  const moduleMethods = new Map<string, ReadonlySet<string>>([
    ["http", new Set(["get", "request"])],
    ["node:http", new Set(["get", "request"])],
    ["https", new Set(["get", "request"])],
    ["node:https", new Set(["get", "request"])],
    ["http2", new Set(["connect"])],
    ["node:http2", new Set(["connect"])],
    ["net", new Set(["connect", "createConnection"])],
    ["node:net", new Set(["connect", "createConnection"])],
    ["tls", new Set(["connect"])],
    ["node:tls", new Set(["connect"])],
    ["node:undici", new Set(["connect", "fetch", "pipeline", "request", "stream"])],
    ["undici", new Set(["connect", "fetch", "pipeline", "request", "stream"])],
    ["bun", new Set(["connect", "udpSocket"])],
  ]);
  const namespaces = new Map<ts.Symbol, string>();
  const callables = new Set<ts.Symbol>();
  const findings = new Set<string>();
  const declarations: ts.VariableDeclaration[] = [];
  const directInvocations: Array<{
    target: ts.ArrowFunction | ts.FunctionExpression;
    args: ts.NodeArray<ts.Expression>;
  }> = [];

  const unwrapExpression = (expression: ts.Expression): ts.Expression => {
    let value = expression;
    while (true) {
      if (
        ts.isAwaitExpression(value) ||
        ts.isAsExpression(value) ||
        ts.isTypeAssertionExpression(value) ||
        ts.isParenthesizedExpression(value) ||
        ts.isNonNullExpression(value) ||
        ts.isSatisfiesExpression(value)
      ) {
        value = value.expression;
        continue;
      }
      if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        value = value.right;
        continue;
      }
      if (ts.isCommaListExpression(value) && value.elements.length > 0) {
        value = value.elements[value.elements.length - 1] as ts.Expression;
        continue;
      }
      return value;
    }
  };

  const importedModule = (initializer: ts.Expression | undefined): string | undefined => {
    if (!initializer) return undefined;
    const value = unwrapExpression(initializer);
    if (!ts.isCallExpression(value) || value.arguments.length !== 1) return undefined;
    const argument = value.arguments[0];
    if (!argument || !ts.isStringLiteral(argument)) return undefined;
    if (value.expression.kind === ts.SyntaxKind.ImportKeyword) return argument.text;
    if (
      ts.isIdentifier(value.expression) &&
      value.expression.text === "require" &&
      checker.getSymbolAtLocation(value.expression) === undefined
    ) {
      return argument.text;
    }
    if (
      ts.isPropertyAccessExpression(value.expression) &&
      ts.isIdentifier(value.expression.expression) &&
      value.expression.expression.text === "process" &&
      checker.getSymbolAtLocation(value.expression.expression) === undefined &&
      value.expression.name.text === "getBuiltinModule"
    ) {
      return argument.text;
    }
    return undefined;
  };

  sourceFile.forEachChild(function discover(node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleName = node.moduleSpecifier.text;
      const methods = moduleMethods.get(moduleName);
      if (methods) {
        const importClause = node.importClause;
        if (importClause?.name) {
          const symbol = checker.getSymbolAtLocation(importClause.name);
          if (symbol) namespaces.set(symbol, moduleName);
        }
        if (importClause?.namedBindings && ts.isNamespaceImport(importClause.namedBindings)) {
          const symbol = checker.getSymbolAtLocation(importClause.namedBindings.name);
          if (symbol) namespaces.set(symbol, moduleName);
        }
        if (importClause?.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
          for (const element of importClause.namedBindings.elements) {
            const imported = element.propertyName?.text ?? element.name.text;
            const symbol = checker.getSymbolAtLocation(element.name);
            if (methods.has(imported) && symbol) callables.add(symbol);
          }
        }
      }
    }
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    if (ts.isCallExpression(node)) {
      const target = unwrapExpression(node.expression);
      if (ts.isArrowFunction(target) || ts.isFunctionExpression(target)) {
        directInvocations.push({ target, args: node.arguments });
      }
    }
    ts.forEachChild(node, discover);
  });

  const namespaceModule = (expression: ts.Expression | undefined): string | undefined => {
    if (!expression) return undefined;
    const value = unwrapExpression(expression);
    if (ts.isIdentifier(value)) {
      if (value.text === "Bun" && checker.getSymbolAtLocation(value) === undefined) return "bun";
      const symbol = checker.getSymbolAtLocation(value);
      return symbol ? namespaces.get(symbol) : undefined;
    }
    return importedModule(value);
  };

  const propertyCapability = (expression: ts.Expression): string | undefined => {
    const value = unwrapExpression(expression);
    let owner: ts.Expression;
    let method: string | undefined;
    if (ts.isPropertyAccessExpression(value)) {
      owner = value.expression;
      method = value.name.text;
    } else if (
      ts.isElementAccessExpression(value) &&
      value.argumentExpression &&
      ts.isStringLiteral(value.argumentExpression)
    ) {
      owner = value.expression;
      method = value.argumentExpression.text;
    } else {
      return undefined;
    }
    if (!method) return undefined;
    owner = unwrapExpression(owner);
    const moduleName = namespaceModule(owner);
    return moduleName && moduleMethods.get(moduleName)?.has(method) ? expression.getText(sourceFile) : undefined;
  };

  const expressionIsCallable = (expression: ts.Expression | undefined): boolean => {
    if (!expression) return false;
    const value = unwrapExpression(expression);
    if (ts.isIdentifier(value)) {
      const symbol = checker.getSymbolAtLocation(value);
      return symbol ? callables.has(symbol) : false;
    }
    if (propertyCapability(value)) return true;
    if (ts.isConditionalExpression(value)) {
      return expressionIsCallable(value.whenTrue) || expressionIsCallable(value.whenFalse);
    }
    return false;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const { target, args } of directInvocations) {
      for (const [index, parameter] of target.parameters.entries()) {
        const argument = args[index];
        const moduleName = namespaceModule(argument);
        const symbol = ts.isIdentifier(parameter.name) ? checker.getSymbolAtLocation(parameter.name) : undefined;
        if (moduleName && symbol && !namespaces.has(symbol)) {
          namespaces.set(symbol, moduleName);
          changed = true;
        } else if (argument && symbol && expressionIsCallable(argument) && !callables.has(symbol)) {
          callables.add(symbol);
          changed = true;
        }
      }
    }
    for (const declaration of declarations) {
      if (!declaration.initializer) continue;
      const moduleName = namespaceModule(declaration.initializer);
      if (ts.isIdentifier(declaration.name)) {
        const symbol = checker.getSymbolAtLocation(declaration.name);
        if (!symbol) continue;
        if (moduleName && moduleMethods.has(moduleName)) {
          if (!namespaces.has(symbol)) {
            namespaces.set(symbol, moduleName);
            changed = true;
          }
        } else if (expressionIsCallable(declaration.initializer) && !callables.has(symbol)) {
          callables.add(symbol);
          changed = true;
        }
        continue;
      }
      if (moduleName && ts.isObjectBindingPattern(declaration.name)) {
        const methods = moduleMethods.get(moduleName);
        for (const element of declaration.name.elements) {
          const imported = element.propertyName?.getText(sourceFile) ?? element.name.getText(sourceFile);
          const symbol = ts.isIdentifier(element.name) ? checker.getSymbolAtLocation(element.name) : undefined;
          if (methods?.has(imported) && symbol && !callables.has(symbol)) {
            callables.add(symbol);
            changed = true;
          }
        }
      }
    }
  }

  function inspect(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const symbol = ts.isIdentifier(node.expression) ? checker.getSymbolAtLocation(node.expression) : undefined;
      if (symbol && callables.has(symbol)) {
        findings.add(`call:${node.expression.getText(sourceFile)}`);
      } else {
        const capability = propertyCapability(node.expression);
        if (capability) findings.add(`call:${capability}`);
        else if (expressionIsCallable(node.expression)) findings.add(`call:${node.expression.getText(sourceFile)}`);
      }
    }
    ts.forEachChild(node, inspect);
  }
  inspect(sourceFile);
  return [...findings].sort();
}

function callSites(source: string, callee: string, fileName: string): Array<{ args: number; text: string }> {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const sites: Array<{ args: number; text: string }> = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === callee) {
      sites.push({ args: node.arguments.length, text: node.getText(sourceFile) });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return sites;
}

function importedModules(source: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const modules: string[] = [];
  sourceFile.forEachChild((node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      modules.push(node.moduleSpecifier.text);
    }
  });
  return modules.sort();
}

describe("registry outbound request architecture", () => {
  test("AST capability analysis catches aliases, global fetch, and wrappers", () => {
    expect(
      networkCapabilities(`
        import { fetchWithRetry as retry } from "../core/common";
        import * as common from "../core/common";
        const indirect = globalThis.fetch;
        const bracket = globalThis["fetch"];
        const { fetch: destructured } = globalThis;
        async function wrapper() { await retry("https://one.test"); }
        async function second() { await indirect("https://two.test"); }
        async function third() { await Bun.fetch("https://three.test"); }
        async function fourth() { await bracket("https://four.test"); }
        async function fifth() { await destructured("https://five.test"); }
        async function sixth() { await common.fetchWithRetry("https://six.test"); }
      `),
    ).toEqual([
      "call:Bun.fetch",
      "call:bracket",
      "call:common.fetchWithRetry",
      "call:destructured",
      "call:indirect",
      "call:retry",
      "import:../core/common:retry",
    ]);

    expect(
      rawHttpCapabilities(`
        import * as secure from "node:https";
        const bracket = secure["request"];
        const alias = bracket;
        const dynamic = await import("node:http");
        const http2 = await import("node:http2");
        const { request: destructuredRequest } = await import("node:https");
        const builtin = process.getBuiltinModule("node:https") as typeof import("node:https");
        import bareHttps from "https";
        const { request: bareRequest } = require("http");
        const bareTls = process.getBuiltinModule("tls");
        require("node:https").request({});
        (0, require("node:https").request)({});
        (await import("node:https")).request({});
        process.getBuiltinModule("node:net").connect({});
        Bun.connect({ hostname: "example.test", port: 443, socket: {} });
        Bun.udpSocket({ socket: {} });
        alias({});
        dynamic.request({});
        http2.connect("https://example.test");
        destructuredRequest({});
        builtin.request({});
        bareHttps.request({});
        bareRequest({});
        bareTls.connect({});
      `),
    ).toEqual([
      'call:(0, require("node:https").request)',
      'call:(await import("node:https")).request',
      "call:Bun.connect",
      "call:Bun.udpSocket",
      "call:alias",
      "call:bareHttps.request",
      "call:bareRequest",
      "call:bareTls.connect",
      "call:builtin.request",
      "call:destructuredRequest",
      "call:dynamic.request",
      "call:http2.connect",
      'call:process.getBuiltinModule("node:net").connect',
      'call:require("node:https").request',
    ]);

    const javascriptFixtures = sourceFiles(path.join(ROOT, "tests/fixtures/registry-network"));
    const directExpressionFixture = javascriptFixtures.find((file) => file.endsWith("raw-direct-expression.mjs"));
    expect(directExpressionFixture).toBeDefined();
    expect(
      rawHttpCapabilities(fs.readFileSync(directExpressionFixture as string, "utf8"), directExpressionFixture),
    ).toEqual([
      'call:(0, require("node:https").request)',
      'call:(await import("node:https")).request',
      "call:Bun.connect",
      "call:Bun.udpSocket",
      'call:process.getBuiltinModule("node:net").connect',
      'call:require("node:https").request',
    ]);
  });

  test("raw transport analysis follows wrapped namespaces", () => {
    expect(
      rawHttpCapabilities(`
        import * as importedHttps from "node:https";
        const wrappedBun = (Bun);
        const commaBun = (0, Bun);
        const wrappedHttps = (importedHttps);
        const wrappedRequire = (require("node:http"));
        const wrappedBuiltin = (process.getBuiltinModule("node:net"));
        const { udpSocket: wrappedUdp } = (Bun);
        wrappedBun.connect({});
        commaBun.udpSocket({});
        wrappedHttps.request({});
        wrappedRequire.get({});
        wrappedBuiltin.createConnection({});
        wrappedUdp({});
      `),
    ).toEqual([
      "call:commaBun.udpSocket",
      "call:wrappedBuiltin.createConnection",
      "call:wrappedBun.connect",
      "call:wrappedHttps.request",
      "call:wrappedRequire.get",
      "call:wrappedUdp",
    ]);
  });

  test("raw transport analysis ignores lexically shadowed globals", () => {
    expect(
      rawHttpCapabilities(`
        function localOnly(
          Bun: { connect: (options: object) => void; udpSocket: (options: object) => void },
          require: (name: string) => { request: (options: object) => void },
          process: { getBuiltinModule: (name: string) => { connect: (options: object) => void } },
        ) {
          Bun.connect({});
          Bun.udpSocket({});
          require("node:https").request({});
          process.getBuiltinModule("node:net").connect({});
        }
      `),
    ).toEqual([]);
  });

  test("registry callers cannot bypass the reusable network boundary", () => {
    const guardedFiles = [
      ...sourceFiles(REGISTRY_DIR),
      path.join(ROOT, "src/setup/registry-stash-loader.ts"),
      path.join(ROOT, "src/sources/providers/npm.ts"),
      path.join(ROOT, "src/sources/providers/provider-utils.ts"),
    ];
    const bypasses = guardedFiles.flatMap((file) => {
      const source = fs.readFileSync(file, "utf8");
      return networkCapabilities(source, file).map((finding) => `${path.relative(ROOT, file)}:${finding}`);
    });

    expect(bypasses).toEqual([]);

    const rawCapabilities = guardedFiles.flatMap((file) =>
      rawHttpCapabilities(fs.readFileSync(file, "utf8"), file).map(
        (finding) => `${path.relative(ROOT, file)}:${finding}`,
      ),
    );
    expect(rawCapabilities.every((finding) => finding.startsWith("src/registry/pinned-transport.ts:"))).toBe(true);
    expect(rawCapabilities.some((finding) => finding.startsWith("src/registry/pinned-transport.ts:"))).toBe(true);

    const generatedHelper = nodePinnedRequestHelperSource();
    expect(rawHttpCapabilities(generatedHelper, "generated-registry-helper.mjs")).not.toEqual([]);

    const transportImports = importedModules(fs.readFileSync(PINNED_TRANSPORT, "utf8"), PINNED_TRANSPORT);
    expect(transportImports).toContain("node:child_process");
    expect(transportImports).toContain("node:http");
    expect(transportImports).toContain("node:https");

    for (const moduleName of ["node:http", "node:https", "node:net"]) {
      expect(generatedHelper).toContain(`from "${moduleName}"`);
    }

    const unexpectedCoreTransports = sourceFiles(REGISTRY_DIR).flatMap((file) => {
      if (file === PINNED_TRANSPORT) return [];
      const modules = importedModules(fs.readFileSync(file, "utf8"), file);
      return modules
        .filter((moduleName) =>
          [
            "http",
            "node:http",
            "https",
            "node:https",
            "http2",
            "node:http2",
            "tls",
            "node:tls",
            "node:undici",
            "undici",
          ].includes(moduleName),
        )
        .map((moduleName) => `${path.relative(ROOT, file)}:${moduleName}`);
    });
    expect(unexpectedCoreTransports).toEqual([]);
  });

  test("the checked-in inventory covers metadata, setup, and artifact consumers", () => {
    const inventory = fs.readFileSync(
      path.join(ROOT, "docs/architecture/internals/registry-network-boundary.md"),
      "utf8",
    );
    for (const caller of [
      "providers/static-index.ts",
      "providers/skills-sh.ts",
      "setup/registry-stash-loader.ts",
      "registry/resolve.ts",
      "providers/provider-utils.ts",
    ]) {
      expect(inventory).toContain(caller);
    }

    const providerUtils = fs.readFileSync(path.join(ROOT, "src/sources/providers/provider-utils.ts"), "utf8");
    expect(providerUtils).toContain("fetchRegistryResponse");

    const archiveCallSites = sourceFiles(SRC_DIR).flatMap((file) =>
      callSites(fs.readFileSync(file, "utf8"), "downloadArchive", file).map((site) => ({
        file: path.relative(ROOT, file),
        ...site,
      })),
    );
    expect(archiveCallSites).toHaveLength(1);
    expect(archiveCallSites[0]?.file).toBe("src/sources/providers/npm.ts");
    expect(archiveCallSites[0]?.args).toBe(3);
    expect(archiveCallSites[0]?.text).toContain("npmArtifactNetworkPolicy(resolved)");

    const resolveSource = fs.readFileSync(path.join(REGISTRY_DIR, "resolve.ts"), "utf8");
    const tarballValidation = callSites(resolveSource, "validateNpmTarballUrl", "registry/resolve.ts");
    expect(tarballValidation).toHaveLength(1);
    expect(tarballValidation[0]?.args).toBe(3);
    expect(tarballValidation[0]?.text).toContain("npmPolicy.registryOrigin");

    const registryInstallRefs = callSites(
      fs.readFileSync(path.join(REGISTRY_DIR, "providers/static-index.ts"), "utf8"),
      "buildInstallRef",
      "providers/static-index.ts",
    );
    expect(registryInstallRefs).toHaveLength(2);
    expect(registryInstallRefs.every((site) => site.args === 3 && site.text.includes('"registry"'))).toBe(true);
  });
});
