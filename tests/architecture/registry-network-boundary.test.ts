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

type CapabilityOrigin =
  | { kind: "namespace"; moduleName: string }
  | { kind: "callable"; moduleName: string; method: string };

interface CapabilityAnalysisSpec {
  moduleMethods: (moduleName: string) => ReadonlySet<string> | undefined;
  unboundCallables?: ReadonlyMap<string, { moduleName: string; method: string }>;
  unboundNamespaces?: ReadonlyMap<string, string>;
  importFinding?: (moduleName: string, importedName: string, localName: string) => string | undefined;
}

/**
 * Resolve capability origins through symbols rather than identifier spellings.
 * The analysis is intentionally flow-insensitive: once a binding can name a
 * network capability, every call through that binding remains in the ratchet.
 */
function analyzeCapabilityCalls(source: string, fileName: string, spec: CapabilityAnalysisSpec): string[] {
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
  const symbolOrigins = new Map<ts.Symbol, Map<string, CapabilityOrigin>>();
  const findings = new Set<string>();
  const propagations: Array<() => boolean> = [];

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

  const originKey = (origin: CapabilityOrigin): string =>
    origin.kind === "namespace" ? `namespace:${origin.moduleName}` : `callable:${origin.moduleName}:${origin.method}`;

  const addOrigins = (identifier: ts.Identifier, origins: readonly CapabilityOrigin[]): boolean => {
    const symbol = checker.getSymbolAtLocation(identifier);
    if (!symbol || origins.length === 0) return false;
    let current = symbolOrigins.get(symbol);
    if (!current) {
      current = new Map();
      symbolOrigins.set(symbol, current);
    }
    let changed = false;
    for (const origin of origins) {
      const key = originKey(origin);
      if (current.has(key)) continue;
      current.set(key, origin);
      changed = true;
    }
    return changed;
  };

  const isUnboundGlobal = (identifier: ts.Identifier): boolean => {
    const symbol = checker.getSymbolAtLocation(identifier);
    return !symbol || (symbol.declarations?.length ?? 0) === 0;
  };

  const staticPropertyName = (name: ts.PropertyName): string | undefined => {
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
    if (!ts.isComputedPropertyName(name)) return undefined;
    const expression = unwrapExpression(name.expression);
    return ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression) ? expression.text : undefined;
  };

  const elementPropertyName = (expression: ts.Expression | undefined): string | undefined => {
    if (!expression) return undefined;
    const value = unwrapExpression(expression);
    return ts.isStringLiteralLike(value) || ts.isNumericLiteral(value) ? value.text : undefined;
  };

  const memberName = (expression: ts.Expression): string | undefined => {
    const value = unwrapExpression(expression);
    if (ts.isPropertyAccessExpression(value)) return value.name.text;
    return ts.isElementAccessExpression(value) ? elementPropertyName(value.argumentExpression) : undefined;
  };

  const memberOwner = (expression: ts.Expression): ts.Expression | undefined => {
    const value = unwrapExpression(expression);
    return ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value) ? value.expression : undefined;
  };

  const loadedModule = (initializer: ts.Expression | undefined): string | undefined => {
    if (!initializer) return undefined;
    const value = unwrapExpression(initializer);
    if (!ts.isCallExpression(value) || value.arguments.length !== 1) return undefined;
    const argument = value.arguments[0];
    if (!argument || !ts.isStringLiteral(argument)) return undefined;
    const callee = unwrapExpression(value.expression);
    if (callee.kind === ts.SyntaxKind.ImportKeyword) return argument.text;
    if (ts.isIdentifier(callee) && callee.text === "require" && isUnboundGlobal(callee)) {
      return argument.text;
    }
    const owner = memberOwner(callee);
    const unwrappedOwner = owner ? unwrapExpression(owner) : undefined;
    if (
      memberName(callee) === "getBuiltinModule" &&
      unwrappedOwner &&
      ts.isIdentifier(unwrappedOwner) &&
      unwrappedOwner.text === "process" &&
      isUnboundGlobal(unwrappedOwner)
    ) {
      return argument.text;
    }
    return undefined;
  };

  const projectMember = (origins: readonly CapabilityOrigin[], property: string): CapabilityOrigin[] =>
    origins.flatMap((origin): CapabilityOrigin[] => {
      if (origin.kind !== "namespace" || !spec.moduleMethods(origin.moduleName)?.has(property)) return [];
      return [{ kind: "callable", moduleName: origin.moduleName, method: property }];
    });

  const resolveExpression = (expression: ts.Expression | undefined): CapabilityOrigin[] => {
    if (!expression) return [];
    const value = unwrapExpression(expression);
    if (ts.isIdentifier(value)) {
      const symbol = checker.getSymbolAtLocation(value);
      const knownOrigins = symbol ? [...(symbolOrigins.get(symbol)?.values() ?? [])] : [];
      if (knownOrigins.length > 0) return knownOrigins;
      if (!isUnboundGlobal(value)) return [];
      const callable = spec.unboundCallables?.get(value.text);
      if (callable) return [{ kind: "callable", ...callable }];
      const moduleName = spec.unboundNamespaces?.get(value.text);
      return moduleName ? [{ kind: "namespace", moduleName }] : [];
    }
    const moduleName = loadedModule(value);
    if (moduleName && spec.moduleMethods(moduleName)) return [{ kind: "namespace", moduleName }];
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      const property = memberName(value);
      return property ? projectMember(resolveExpression(value.expression), property) : [];
    }
    if (ts.isConditionalExpression(value)) {
      return [...resolveExpression(value.whenTrue), ...resolveExpression(value.whenFalse)];
    }
    return [];
  };

  const bindPattern = (name: ts.BindingName, origins: readonly CapabilityOrigin[]): boolean => {
    if (ts.isIdentifier(name)) return addOrigins(name, origins);
    if (!ts.isObjectBindingPattern(name)) return false;
    let changed = false;
    for (const element of name.elements) {
      if (element.dotDotDotToken) continue;
      const property = element.propertyName
        ? staticPropertyName(element.propertyName)
        : ts.isIdentifier(element.name)
          ? element.name.text
          : undefined;
      if (property && bindPattern(element.name, projectMember(origins, property))) changed = true;
    }
    return changed;
  };

  const bindAssignmentTarget = (target: ts.Expression, origins: readonly CapabilityOrigin[]): boolean => {
    const value = unwrapExpression(target);
    if (ts.isIdentifier(value)) return addOrigins(value, origins);
    if (!ts.isObjectLiteralExpression(value)) return false;
    let changed = false;
    for (const property of value.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        if (addOrigins(property.name, projectMember(origins, property.name.text))) changed = true;
      } else if (ts.isPropertyAssignment(property)) {
        const propertyName = staticPropertyName(property.name);
        if (propertyName && bindAssignmentTarget(property.initializer, projectMember(origins, propertyName))) {
          changed = true;
        }
      }
    }
    return changed;
  };

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const moduleName = statement.moduleSpecifier.text;
    const methods = spec.moduleMethods(moduleName);
    if (!methods) continue;
    const importClause = statement.importClause;
    if (importClause?.name) addOrigins(importClause.name, [{ kind: "namespace", moduleName }]);
    if (importClause?.namedBindings && ts.isNamespaceImport(importClause.namedBindings)) {
      addOrigins(importClause.namedBindings.name, [{ kind: "namespace", moduleName }]);
    }
    if (importClause?.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
      for (const element of importClause.namedBindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        if (!methods.has(importedName)) continue;
        addOrigins(element.name, [{ kind: "callable", moduleName, method: importedName }]);
        const finding = spec.importFinding?.(moduleName, importedName, element.name.text);
        if (finding) findings.add(finding);
      }
    }
  }

  sourceFile.forEachChild(function discover(node): void {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      propagations.push(() => bindPattern(node.name, resolveExpression(node.initializer)));
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      propagations.push(() => bindAssignmentTarget(node.left, resolveExpression(node.right)));
    }
    if (ts.isCallExpression(node)) {
      const target = unwrapExpression(node.expression);
      if (ts.isArrowFunction(target) || ts.isFunctionExpression(target)) {
        propagations.push(() => {
          let changed = false;
          for (const [index, parameter] of target.parameters.entries()) {
            const argument = node.arguments[index];
            if (argument && bindPattern(parameter.name, resolveExpression(argument))) changed = true;
          }
          return changed;
        });
      }
    }
    ts.forEachChild(node, discover);
  });

  let changed = true;
  while (changed) {
    changed = false;
    for (const propagate of propagations) if (propagate()) changed = true;
  }

  function inspect(node: ts.Node): void {
    if (ts.isCallExpression(node) && resolveExpression(node.expression).some((origin) => origin.kind === "callable")) {
      findings.add(`call:${node.expression.getText(sourceFile)}`);
    }
    ts.forEachChild(node, inspect);
  }
  inspect(sourceFile);
  return [...findings].sort();
}

const FETCH_METHODS = new Set(["fetch"]);
const FETCH_WITH_RETRY_METHODS = new Set(["fetchWithRetry"]);
const RAW_MODULE_METHODS = new Map<string, ReadonlySet<string>>([
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

function networkCapabilities(source: string, fileName = "probe.ts"): string[] {
  return analyzeCapabilityCalls(source, fileName, {
    moduleMethods: (moduleName) =>
      moduleName === "web"
        ? FETCH_METHODS
        : moduleName.endsWith("/core/common") || moduleName.endsWith("/core/common.ts")
          ? FETCH_WITH_RETRY_METHODS
          : undefined,
    unboundCallables: new Map([["fetch", { moduleName: "web", method: "fetch" }]]),
    unboundNamespaces: new Map([
      ["globalThis", "web"],
      ["window", "web"],
      ["Bun", "web"],
    ]),
    importFinding: (moduleName, importedName, localName) =>
      importedName === "fetchWithRetry" ? `import:${moduleName}:${localName}` : undefined,
  });
}

/** Find raw socket/request call sites even when imports and callables are aliased. */
function rawHttpCapabilities(source: string, fileName = "probe.ts"): string[] {
  return analyzeCapabilityCalls(source, fileName, {
    moduleMethods: (moduleName) => RAW_MODULE_METHODS.get(moduleName),
    unboundNamespaces: new Map([["Bun", "bun"]]),
  });
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

  test.each([
    {
      fileName: "probe.js",
      source: '(({ request }) => request({}))(require("node:https"));',
      expected: ["call:request"],
    },
    {
      fileName: "probe.mjs",
      source: "(({ connect }) => connect({}))(Bun);",
      expected: ["call:connect"],
    },
    {
      fileName: "probe.cjs",
      source: '(({ request: req }) => req({}))(process.getBuiltinModule("node:http"));',
      expected: ["call:req"],
    },
    {
      fileName: "probe.ts",
      source: 'let h; h = require("node:http"); h.request({});',
      expected: ["call:h.request"],
    },
    {
      fileName: "probe.js",
      source: 'let r; ({ request: r } = require("node:https")); r({});',
      expected: ["call:r"],
    },
    {
      fileName: "probe.mjs",
      source: '(0, require)("node:http").request({});',
      expected: ['call:(0, require)("node:http").request'],
    },
    {
      fileName: "probe.cjs",
      source: '(0, process.getBuiltinModule)("node:net").connect({});',
      expected: ['call:(0, process.getBuiltinModule)("node:net").connect'],
    },
    {
      fileName: "probe.ts",
      source: 'const { ["request"]: r } = require("node:https"); r({});',
      expected: ["call:r"],
    },
  ])("raw transport analysis catches $fileName evasion: $source", ({ fileName, source, expected }) => {
    expect(rawHttpCapabilities(source, fileName)).toEqual([...expected]);
  });

  test.each([
    { fileName: "probe.ts", source: "function local(fetch: () => void) { fetch(); }" },
    { fileName: "probe.js", source: "const fetch = () => {}; fetch();" },
    {
      fileName: "probe.mjs",
      source: "function local(globalThis: { fetch: () => void }) { globalThis.fetch(); }",
    },
    { fileName: "probe.cjs", source: "const window = { fetch() {} }; window.fetch();" },
    { fileName: "probe.ts", source: "const Bun = { fetch() {} }; Bun.fetch();" },
  ])("fetch analysis ignores lexically shadowed globals in $fileName: $source", ({ fileName, source }) => {
    expect(networkCapabilities(source, fileName)).toEqual([]);
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
