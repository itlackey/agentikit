// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const REGISTRY_DIR = path.join(ROOT, "src/registry");
const BOUNDARY = path.join(REGISTRY_DIR, "network.ts");

function tsFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) return tsFiles(fullPath);
    return entry.isFile() && entry.name.endsWith(".ts") ? [fullPath] : [];
  });
}

describe("registry outbound request architecture", () => {
  test("registry callers cannot bypass the reusable network boundary", () => {
    const guardedFiles = [
      ...tsFiles(REGISTRY_DIR).filter((file) => file !== BOUNDARY),
      path.join(ROOT, "src/setup/registry-stash-loader.ts"),
      path.join(ROOT, "src/sources/providers/provider-utils.ts"),
    ];
    const bypasses = guardedFiles.flatMap((file) => {
      const source = fs.readFileSync(file, "utf8");
      return /\bfetch(?:WithRetry)?\s*\(/.test(source) ? [path.relative(ROOT, file)] : [];
    });

    expect(bypasses).toEqual([]);
    expect(fs.readFileSync(BOUNDARY, "utf8")).toContain("fetchWithRetry(");
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
  });
});
