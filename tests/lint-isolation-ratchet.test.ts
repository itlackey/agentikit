// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Meta-test for the shrink-only allowlist ratchet in
 * `scripts/lint-tests-isolation.ts`.
 *
 * The grandfather allowlist (Rule-1 `ALLOWED_FILES` + Rule-2
 * `ENV_ASSIGN_ALLOWED` + Rule-5 `SPAWN_ALLOWED`) may only ever get SMALLER as
 * files migrate onto the `withIsolatedAkmStorage` composite. The exact-size
 * check prevents growth, while the path check prevents a deleted test from
 * leaving behind a stale exemption that a later file could inherit.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import {
  ALLOWED_FILES,
  ALLOWLIST_RATCHET_BASELINE,
  combinedAllowlistSize,
  ENV_ASSIGN_ALLOWED,
  lintAllTestFiles,
  lintFile,
  SPAWN_ALLOWED,
} from "../scripts/lint-tests-isolation";
import { makeSandboxDir } from "./_helpers/sandbox";

const repoRoot = path.resolve(__dirname, "..");

function defaultImports(...body: string[]): string {
  return ['import fs from "node:fs";', 'import os from "node:os";', 'import path from "node:path";', ...body].join(
    "\n",
  );
}

interface RealHomeCase {
  expectedLines: number[];
  name: string;
  source: string;
}

const REAL_HOME_OPERATION_LEDGER: readonly RealHomeCase[] = [
  {
    name: "default-os-and-fs-rmSync-danger",
    expectedLines: [4],
    source: defaultImports('fs.rmSync(path.join(os.homedir(), ".config", "tool"), { recursive: true });'),
  },
  {
    name: "namespace-os-alias-danger",
    expectedLines: [4],
    source: [
      'import fs from "node:fs";',
      'import * as platform from "node:os";',
      'import path from "node:path";',
      'fs.rmSync(path.join(platform.homedir(), ".config", "tool"), { recursive: true });',
    ].join("\n"),
  },
  {
    name: "named-homedir-alias-danger",
    expectedLines: [4],
    source: [
      'import { rmSync } from "node:fs";',
      'import { homedir as realHome } from "node:os";',
      'import path from "node:path";',
      'rmSync(path.join(realHome(), ".config", "tool"), { recursive: true });',
    ].join("\n"),
  },
  {
    name: "fs-promises-member-rm-danger",
    expectedLines: [4],
    source: defaultImports('await fs.promises.rm(path.join(os.homedir(), ".config", "tool"), { recursive: true });'),
  },
  {
    name: "renamed-fs-rmSync-danger",
    expectedLines: [4],
    source: [
      'import { rmSync as erase } from "node:fs";',
      'import os from "node:os";',
      'import path from "node:path";',
      'erase(path.join(os.homedir(), ".config", "tool"), { recursive: true });',
    ].join("\n"),
  },
  {
    name: "destructured-fs-rmSync-danger",
    expectedLines: [5],
    source: defaultImports(
      "const { rmSync: erase } = fs;",
      'erase(path.join(os.homedir(), ".config", "tool"), { recursive: true });',
    ),
  },
  {
    name: "renamed-fs-rmdirSync-danger",
    expectedLines: [4],
    source: [
      'import { rmdirSync as eraseDirectory } from "node:fs";',
      'import os from "node:os";',
      'import path from "node:path";',
      'eraseDirectory(path.join(os.homedir(), ".config", "tool"));',
    ].join("\n"),
  },
  {
    name: "renamed-fs-rm-callback-danger",
    expectedLines: [4],
    source: [
      'import { rm as eraseAsync } from "node:fs";',
      'import os from "node:os";',
      'import path from "node:path";',
      'eraseAsync(path.join(os.homedir(), ".config", "tool"), { recursive: true }, () => {});',
    ].join("\n"),
  },
  {
    name: "renamed-fs-rmdir-callback-danger",
    expectedLines: [4],
    source: [
      'import { rmdir as eraseDirectoryAsync } from "node:fs";',
      'import os from "node:os";',
      'import path from "node:path";',
      'eraseDirectoryAsync(path.join(os.homedir(), ".config", "tool"), () => {});',
    ].join("\n"),
  },
  {
    name: "renamed-fs-promises-rm-danger",
    expectedLines: [4],
    source: [
      'import { rm as eraseAsync } from "node:fs/promises";',
      'import os from "node:os";',
      'import path from "node:path";',
      'await eraseAsync(path.join(os.homedir(), ".config", "tool"), { recursive: true });',
    ].join("\n"),
  },
  {
    name: "destructured-fs-promises-rmdir-danger",
    expectedLines: [5],
    source: defaultImports(
      "const { rmdir: eraseDirectoryAsync } = fs.promises;",
      'await eraseDirectoryAsync(path.join(os.homedir(), ".config", "tool"));',
    ),
  },
  {
    name: "formatter-normal-multiline-danger",
    expectedLines: [4],
    source: defaultImports(
      "fs.rmSync(",
      '  path.join(os.homedir(), ".config", "tool"),',
      "  { recursive: true, force: true },",
      ");",
    ),
  },
  {
    name: "home-read-plus-unrelated-node-delete-danger",
    expectedLines: [6],
    source: defaultImports(
      "const inspectedHome = os.homedir();",
      'const owned = path.join(os.tmpdir(), "owned-fixture");',
      "fs.rmSync(owned, { recursive: true, force: true });",
    ),
  },
  {
    name: "named-home-mkdtemp-still-danger",
    expectedLines: [5],
    source: [
      'import { mkdtempSync as makeOwned, rmSync } from "node:fs";',
      'import os from "node:os";',
      'import path from "node:path";',
      'const owned = makeOwned(path.join(os.homedir(), "tool-owned-"));',
      "rmSync(owned, { recursive: true });",
    ].join("\n"),
  },
  {
    name: "element-home-mkdtemp-still-danger",
    expectedLines: [5],
    source: defaultImports(
      'const owned = fs["mkdtempSync"](path.join(os.homedir(), "tool-owned-"));',
      "fs.rmSync(owned, { recursive: true });",
    ),
  },
  {
    name: "fake-mkdtemp-boundary-danger",
    expectedLines: [5],
    source: defaultImports(
      'const target = { mkdtempSync: (p: string) => p }.mkdtempSync(path.join(os.homedir(), ".config", "tool"));',
      "fs.rmSync(target, { recursive: true });",
    ),
  },
  {
    name: "shadowed-os-safe",
    expectedLines: [],
    source: defaultImports(
      "function cleanup(os: { homedir(): string }) {",
      '  fs.rmSync(path.join(os.homedir(), "owned"), { recursive: true });',
      "}",
    ),
  },
  {
    name: "unrelated-delete-method-safe",
    expectedLines: [],
    source: [
      'import os from "node:os";',
      'import path from "node:path";',
      "const recorder = { rmSync(_path: string) {} };",
      'recorder.rmSync(path.join(os.homedir(), ".config", "tool"));',
    ].join("\n"),
  },
];

describe("lint-tests-isolation allowlist ratchet", () => {
  test("the recorded baseline tracks the live size exactly (shrink-only, no stale slack)", () => {
    expect(ALLOWLIST_RATCHET_BASELINE).toBe(combinedAllowlistSize());
  });

  test("every allowlisted path resolves to a file that actually exists (ISOLATION-07)", () => {
    const allPaths = [...ALLOWED_FILES, ...ENV_ASSIGN_ALLOWED, ...SPAWN_ALLOWED];
    const missing = allPaths.filter((rel) => !fs.existsSync(path.join(repoRoot, rel)));
    expect(missing, `stale allowlist entries pointing at files no longer in the tree:\n${missing.join("\n")}`).toEqual(
      [],
    );
  });

  test("the test suite currently has zero isolation/determinism violations", () => {
    const violations = lintAllTestFiles();
    if (violations.length > 0) {
      const summary = violations
        .map((violation) => `${violation.file}:${violation.line} [${violation.rule}]`)
        .join("\n");
      throw new Error(`lint-tests-isolation found violations:\n${summary}`);
    }
    expect(violations.length).toBe(0);
  });

  test("classifies the conservative real-home operation-identity ledger", () => {
    const fixture = makeSandboxDir("akm-home-operation-ledger");
    const fixturePath = path.join(fixture.dir, "fixture.test.ts");
    try {
      for (const entry of REAL_HOME_OPERATION_LEDGER) {
        fs.writeFileSync(fixturePath, entry.source);
        const actualLines = lintFile(fixturePath)
          .filter((violation) => violation.rule === "real-home-delete")
          .map((violation) => violation.line);
        expect(actualLines, entry.name).toEqual(entry.expectedLines);
      }
    } finally {
      fixture.cleanup();
    }
  });
});
