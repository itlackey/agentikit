// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const workflowConsumers = [
  "src/workflows/exec/unit-dispatch.ts",
  "src/workflows/exec/native-executor.ts",
  "src/workflows/exec/frozen-judge.ts",
] as const;

function executableSource(relativePath: string): string {
  return fs
    .readFileSync(path.join(repoRoot, relativePath), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

function rawExecutionBypassesIn(source: string): string[] {
  const patterns = [
    ["chatCompletion transport", /(?:llm\/client(?:\.js)?|\bchatCompletion\s*\()/],
    ["executeRunner transport", /(?:agent\/runner-dispatch(?:\.js)?|\bexecuteRunner\s*\()/],
    ["live engine resolution", /\bresolveEngine\s*\(/],
    ["pre-lowering credential materialization", /\b(?:resolveCredentialFromEnv|materializeFrozenLlm)\s*\(/],
  ] as const;
  return patterns.filter(([, pattern]) => pattern.test(source)).map(([label]) => label);
}

function rawExecutionBypasses(relativePath: string): string[] {
  return rawExecutionBypassesIn(executableSource(relativePath));
}

describe("workflow engine execution boundary", () => {
  test("unit, native, and judge consumers contain no raw transport or credential bypass", () => {
    const violations = workflowConsumers.flatMap((relativePath) =>
      rawExecutionBypasses(relativePath).map((bypass) => `${relativePath}: ${bypass}`),
    );

    expect(violations).toEqual([]);
  });

  test("the guard catches static, dynamic, direct, and aliased-looking bypass spellings", () => {
    const fixtures = [
      `import { chatCompletion as send } from "../../llm/client";`,
      `const { executeRunner: send } = await import("../../integrations/agent/runner-dispatch.js");`,
      `resolveEngine(name, config);`,
      `materializeFrozenLlm(snapshot, invocation);`,
    ];

    for (const source of fixtures) expect(rawExecutionBypassesIn(source)).not.toEqual([]);
  });
});
