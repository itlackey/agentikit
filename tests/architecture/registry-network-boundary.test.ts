// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { nodePinnedRequestHelperSource } from "../../src/registry/pinned-request-helper";

const ROOT = path.resolve(import.meta.dir, "../..");
const REGISTRY_DIR = path.join(ROOT, "src/registry");
const PINNED_TRANSPORT = path.join(REGISTRY_DIR, "pinned-transport.ts");
const NETWORK_BOUNDARY = path.join(REGISTRY_DIR, "network.ts");

const GUARDED_CONSUMERS = [
  path.join(ROOT, "src/setup/registry-stash-loader.ts"),
  path.join(ROOT, "src/sources/providers/npm.ts"),
  path.join(ROOT, "src/sources/providers/provider-utils.ts"),
];

const EXPECTED_BOUNDARY_USERS = [
  "src/registry/network.ts",
  "src/registry/providers/skills-sh.ts",
  "src/registry/providers/static-index.ts",
  "src/registry/resolve.ts",
  "src/setup/registry-stash-loader.ts",
  "src/sources/providers/provider-utils.ts",
];

const RAW_TRANSPORT_MODULES = new Set([
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
]);

function sourceFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(fullPath);
    return entry.isFile() && /\.(?:[cm]?[jt]s)$/.test(entry.name) ? [fullPath] : [];
  });
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

function importedModules(file: string): string[] {
  const modules: string[] = [];
  parse(file).forEachChild((node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      modules.push(node.moduleSpecifier.text);
    }
  });
  return modules.sort();
}

function directNetworkCalls(file: string): string[] {
  const source = parse(file);
  const calls: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && (callee.text === "fetch" || callee.text === "fetchWithRetry")) {
        calls.push(callee.text);
      }
      if (
        ts.isPropertyAccessExpression(callee) &&
        ["fetch", "connect", "createConnection", "request", "udpSocket"].includes(callee.name.text)
      ) {
        calls.push(callee.getText(source));
      }
      if (
        ts.isCallExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        ["require", "import"].includes(callee.expression.text)
      ) {
        calls.push(callee.getText(source));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return calls.sort();
}

function relative(file: string): string {
  return path.relative(ROOT, file);
}

describe("registry outbound request architecture", () => {
  test("registry metadata and artifact consumers use one request boundary", () => {
    const guardedFiles = [...sourceFiles(REGISTRY_DIR), ...GUARDED_CONSUMERS];
    const boundaryUsers = guardedFiles
      .filter((file) => fs.readFileSync(file, "utf8").includes("fetchRegistryResponse"))
      .map(relative)
      .sort();

    expect(boundaryUsers).toEqual(EXPECTED_BOUNDARY_USERS);

    const bypasses = guardedFiles.flatMap((file) => {
      if (file === NETWORK_BOUNDARY || file === PINNED_TRANSPORT) return [];
      return directNetworkCalls(file).map((call) => `${relative(file)}:${call}`);
    });
    expect(bypasses).toEqual([]);
  });

  test("only the pinned transport owns raw HTTP modules", () => {
    const registryFiles = sourceFiles(REGISTRY_DIR);
    const rawImports = registryFiles.flatMap((file) =>
      importedModules(file)
        .filter((moduleName) => RAW_TRANSPORT_MODULES.has(moduleName))
        .map((moduleName) => `${relative(file)}:${moduleName}`),
    );
    expect(rawImports).toEqual([
      "src/registry/pinned-transport.ts:node:http",
      "src/registry/pinned-transport.ts:node:https",
    ]);

    const generatedHelper = nodePinnedRequestHelperSource();
    for (const moduleName of ["node:http", "node:https", "node:net"]) {
      expect(generatedHelper).toContain(`from "${moduleName}"`);
    }
  });

  test("the checked-in inventory covers every request consumer", () => {
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
  });

  test("npm artifacts retain registry provenance through install", () => {
    const npmProvider = fs.readFileSync(path.join(ROOT, "src/sources/providers/npm.ts"), "utf8");
    expect(npmProvider).toContain(
      "downloadArchive(resolved.artifactUrl, archivePath, npmArtifactNetworkPolicy(resolved))",
    );

    const resolver = fs.readFileSync(path.join(REGISTRY_DIR, "resolve.ts"), "utf8");
    expect(resolver).toContain("validateNpmTarballUrl(tarballUrl");
    expect(resolver).toContain("npmPolicy.registryOrigin");

    const staticIndex = fs.readFileSync(path.join(REGISTRY_DIR, "providers/static-index.ts"), "utf8");
    expect(staticIndex.match(/buildInstallRef\(stash\.source, stash\.ref, "registry"\)/g)).toHaveLength(2);
  });
});
