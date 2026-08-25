// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { STANDALONE_FROZEN_SCRIPT_ARG } from "../../src/tasks/standalone-script-entry";
import { makeSandboxDir } from "../_helpers/sandbox";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const STANDALONE_ENTRY = path.join(REPO_ROOT, "scripts", "akm-standalone.ts");

async function runFrozenScript(file: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, STANDALONE_ENTRY, STANDALONE_FROZEN_SCRIPT_ARG, file], {
    cwd: REPO_ROOT,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("standalone frozen script entry", () => {
  test.each([
    ["js", 'const marker = "js-main";'],
    ["ts", 'const marker: string = "ts-main";'],
  ] as const)("runs a frozen .%s script with import.meta.main", async (extension, declaration) => {
    const sandbox = makeSandboxDir("akm-standalone-import-meta-main");
    const script = path.join(sandbox.dir, `snapshot.${extension}`);
    const marker = path.join(sandbox.dir, "marker");
    fs.writeFileSync(
      script,
      [
        'import fs from "node:fs";',
        declaration,
        `if (import.meta.main) fs.writeFileSync(${JSON.stringify(marker)}, marker);`,
        "",
      ].join("\n"),
      { mode: 0o700 },
    );

    try {
      const result = await runFrozenScript(script);
      expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
      expect(fs.readFileSync(marker, "utf8")).toBe(extension === "js" ? "js-main" : "ts-main");
    } finally {
      sandbox.cleanup();
    }
  });
});
