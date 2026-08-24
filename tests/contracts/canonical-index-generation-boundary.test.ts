// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const SRC_ROOT = path.resolve(import.meta.dir, "../../src");
const FORBIDDEN_GRAPH_COMPATIBILITY_TOKENS = [
  "migrateGraphFilesSchema",
  "migrateGraphDataFromLegacy",
  "graph_files_legacy",
  "graph_file_entities_legacy",
  "graph_file_relations_legacy",
] as const;

function productionTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(absolute);
    }
  }
  return files.sort();
}

describe("canonical derived-index generation production boundary", () => {
  test("legacy graph rename/copy architecture has zero production hits", () => {
    const hits: string[] = [];
    for (const file of productionTypeScriptFiles(SRC_ROOT)) {
      const source = fs.readFileSync(file, "utf8");
      for (const token of FORBIDDEN_GRAPH_COMPATIBILITY_TOKENS) {
        if (source.includes(token)) hits.push(`${path.relative(SRC_ROOT, file)}: ${token}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
