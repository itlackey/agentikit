// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");

function source(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

describe("index LLM leaves use the resolved-execution boundary", () => {
  test("connection selection does not materialize credentials or bypass the common planner", () => {
    const text = source("src/llm/index-passes.ts");

    expect(text).not.toMatch(/\bresolveLlmEngineUse\b/);
    expect(text).not.toMatch(/\bmaterializeLlmConnection\b/);
    expect(text).toMatch(/\bprepareInlineExecution\b/);
    expect(text).toMatch(/\blowerResolvedExecutionRequest\b/);
    expect(text).not.toMatch(/export function resolveIndexPassRunner\b/);
    expect(text).not.toMatch(/export function resolveIndexPassLLM\b/);
  });

  test("graph, memory, and metadata calls use the converted structured-call adapter", () => {
    for (const relativePath of ["src/llm/graph-extract.ts", "src/llm/memory-infer.ts", "src/llm/metadata-enhance.ts"]) {
      const text = source(relativePath);
      expect(text, relativePath).not.toMatch(/\bchatCompletion\s*\(/);
      expect(text, relativePath).toMatch(/\bcallStructured\s*</);
      expect(text, relativePath).toMatch(/\brunner\s*:/);
      expect(text, relativePath).not.toMatch(/\bconfig\s*:\s*llm(?:Config|Connection)\b/);
    }
  });
});
