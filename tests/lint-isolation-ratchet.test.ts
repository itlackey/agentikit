// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Shrink-only allowlist and conservative real-home operation boundary contract. */

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

const source = (...lines: string[]): string => lines.join("\n");
const imports = (fsImport: string, osImport: string, ...body: string[]): string =>
  source(fsImport, osImport, 'import path from "node:path";', ...body);
const defaultImports = (...body: string[]): string =>
  imports('import fs from "node:fs";', 'import os from "node:os";', ...body);
const danger = (name: string, line: number, fixture: string) => ({ expectedLines: [line], name, source: fixture });
const safe = (name: string, fixture: string) => ({ expectedLines: [], name, source: fixture });

const REAL_HOME_OPERATION_LEDGER = [
  danger(
    "default-os-and-fs-rmSync-danger",
    4,
    defaultImports('fs.rmSync(path.join(os.homedir(), ".config", "tool"), { recursive: true });'),
  ),
  danger(
    "namespace-os-alias-danger",
    4,
    imports(
      'import fs from "node:fs";',
      'import * as platform from "node:os";',
      'fs.rmSync(path.join(platform.homedir(), ".config", "tool"), { recursive: true });',
    ),
  ),
  danger(
    "named-homedir-alias-danger",
    4,
    imports(
      'import { rmSync } from "node:fs";',
      'import { homedir as realHome } from "node:os";',
      'rmSync(path.join(realHome(), ".config", "tool"), { recursive: true });',
    ),
  ),
  danger(
    "fs-promises-member-rm-danger",
    4,
    defaultImports('await fs.promises.rm(path.join(os.homedir(), ".config", "tool"), { recursive: true });'),
  ),
  danger(
    "renamed-fs-rmSync-danger",
    4,
    imports(
      'import { rmSync as erase } from "node:fs";',
      'import os from "node:os";',
      'erase(path.join(os.homedir(), ".config", "tool"), { recursive: true });',
    ),
  ),
  danger(
    "destructured-fs-rmSync-danger",
    5,
    defaultImports("const { rmSync: erase } = fs;", 'erase(path.join(os.homedir(), ".config", "tool"));'),
  ),
  danger(
    "renamed-fs-rmdirSync-danger",
    4,
    imports(
      'import { rmdirSync as eraseDirectory } from "node:fs";',
      'import os from "node:os";',
      'eraseDirectory(path.join(os.homedir(), ".config", "tool"));',
    ),
  ),
  danger(
    "renamed-fs-rm-callback-danger",
    4,
    imports(
      'import { rm as eraseAsync } from "node:fs";',
      'import os from "node:os";',
      'eraseAsync(path.join(os.homedir(), ".config", "tool"), { recursive: true }, () => {});',
    ),
  ),
  danger(
    "renamed-fs-rmdir-callback-danger",
    4,
    imports(
      'import { rmdir as eraseDirectoryAsync } from "node:fs";',
      'import os from "node:os";',
      'eraseDirectoryAsync(path.join(os.homedir(), ".config", "tool"), () => {});',
    ),
  ),
  danger(
    "renamed-fs-promises-rm-danger",
    4,
    imports(
      'import { rm as eraseAsync } from "node:fs/promises";',
      'import os from "node:os";',
      'await eraseAsync(path.join(os.homedir(), ".config", "tool"), { recursive: true });',
    ),
  ),
  danger(
    "destructured-fs-promises-rmdir-danger",
    5,
    defaultImports("const { rmdir: eraseDirectoryAsync } = fs.promises;", "await eraseDirectoryAsync(os.homedir());"),
  ),
  danger(
    "formatter-normal-multiline-danger",
    4,
    defaultImports("fs.rmSync(", "  os.homedir(),", "  { recursive: true, force: true },", ");"),
  ),
  danger(
    "home-read-plus-unrelated-node-delete-danger",
    6,
    defaultImports(
      "const inspectedHome = os.homedir();",
      'const owned = path.join(os.tmpdir(), "owned");',
      "fs.rmSync(owned);",
    ),
  ),
  danger(
    "named-home-mkdtemp-still-danger",
    5,
    imports(
      'import { mkdtempSync as makeOwned, rmSync } from "node:fs";',
      'import os from "node:os";',
      'const owned = makeOwned(path.join(os.homedir(), "owned-"));',
      "rmSync(owned);",
    ),
  ),
  danger(
    "element-home-mkdtemp-still-danger",
    5,
    defaultImports('const owned = fs["mkdtempSync"](os.homedir());', "fs.rmSync(owned);"),
  ),
  danger(
    "fake-mkdtemp-boundary-danger",
    5,
    defaultImports("const owned = { mkdtempSync: (p: string) => p }.mkdtempSync(os.homedir());", "fs.rmSync(owned);"),
  ),
  danger("fs-unlinkSync-danger", 4, defaultImports("fs.unlinkSync(os.homedir());")),
  danger("fs-unlink-callback-danger", 4, defaultImports("fs.unlink(os.homedir(), () => {});")),
  danger(
    "fs-promises-unlink-danger",
    4,
    imports('import { unlink } from "node:fs/promises";', 'import os from "node:os";', "await unlink(os.homedir());"),
  ),
  danger(
    "default-import-one-hop-aliases-danger",
    6,
    defaultImports("const erase = fs.rmSync;", "const getHome = os.homedir;", "erase(getHome());"),
  ),
  danger(
    "named-import-one-hop-aliases-danger",
    6,
    imports(
      'import { rmSync } from "node:fs";',
      'import { homedir } from "node:os";',
      "const erase = rmSync;",
      "const getHome = homedir;",
      "erase(getHome());",
    ),
  ),
  safe(
    "shadowed-os-safe",
    defaultImports(
      "function cleanup(os: { homedir(): string }) {",
      '  fs.rmSync(path.join(os.homedir(), "owned"), { recursive: true });',
      "}",
    ),
  ),
  safe(
    "unrelated-delete-method-safe",
    imports(
      'import type {} from "node:fs";',
      'import os from "node:os";',
      "const recorder = { rmSync(_path: string) {} };",
      "recorder.rmSync(os.homedir());",
    ),
  ),
  safe(
    "two-hop-aliases-safe",
    defaultImports(
      "const eraseOnce = fs.rmSync;",
      "const eraseTwice = eraseOnce;",
      "const homeOnce = os.homedir;",
      "const homeTwice = homeOnce;",
      "eraseTwice(homeTwice());",
    ),
  ),
  safe(
    "property-owner-alias-budget-safe",
    defaultImports("const files = fs;", "const erase = files.rmSync;", "erase(os.homedir());"),
  ),
  safe(
    "binding-alias-budget-safe",
    defaultImports("const { rmSync: once } = fs;", "const twice = once;", "twice(os.homedir());"),
  ),
  safe(
    "binding-owner-alias-budget-safe",
    defaultImports("const files = fs;", "const { rmSync: erase } = files;", "erase(os.homedir());"),
  ),
] as const;

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
