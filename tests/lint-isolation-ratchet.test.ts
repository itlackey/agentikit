// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Meta-test for the shrink-only allowlist ratchet in
 * `scripts/lint-tests-isolation.ts`.
 *
 * The grandfather allowlist (Rule-1 `ALLOWED_FILES` + Rule-2
 * `ENV_ASSIGN_ALLOWED` + Rule-5 `SPAWN_ALLOWED`) may only ever get SMALLER as
 * files migrate onto the
 * `withIsolatedAkmStorage` composite. This test fails if the live combined size
 * grows past the recorded baseline — forcing the baseline to be lowered (never
 * raised) in any change that touches the lists. It also asserts the linter
 * itself is clean, so the ratchet and the rules are exercised together.
 *
 * ISOLATION-07: the size check alone is blind to entries that point at files
 * no longer in the tree — a stale path still counts toward the (correct)
 * total, so nothing here caught `tests/integration/ripgrep.test.ts` and
 * `tests/integration/tasks-legacy-md-warning.test.ts` sitting in
 * `ALLOWED_FILES` for an unknown period after both files were deleted. A
 * future accidental re-creation at either path would have silently inherited
 * the stale exemption. The path-existence test below closes that gap by
 * resolving every allowlisted entry against the repo root and asserting it
 * exists — this is the check that would have failed the moment those two
 * files were removed.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
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

const repoRoot = path.resolve(__dirname, "..");

describe("lint-tests-isolation allowlist ratchet", () => {
  test("the recorded baseline tracks the live size exactly (shrink-only, no stale slack)", () => {
    // Equality subsumes the old "never grows past" check: when entries are
    // removed the baseline is lowered in the same change, and any growth
    // fails immediately.
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
      const summary = violations.map((v) => `${v.file}:${v.line} [${v.rule}]`).join("\n");
      throw new Error(`lint-tests-isolation found violations:\n${summary}`);
    }
    expect(violations.length).toBe(0);
  });

  test("rejects recursive cleanup rooted in the real home directory", () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-isolation-lint-real-home-"));
    const fixturePath = path.join(fixtureDir, "dangerous.test.ts");
    try {
      fs.writeFileSync(
        fixturePath,
        [
          'import fs from "node:fs";',
          'import os from "node:os";',
          'import path from "node:path";',
          "const realStore = path.join(os." + 'homedir(), ".local", "share", "tool");',
          "fs." + "rmSync(realStore, { recursive: true, force: true });",
        ].join("\n"),
      );

      expect(lintFile(fixturePath)).toEqual([
        expect.objectContaining({
          rule: "real-home-delete",
          line: 5,
        }),
      ]);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test("rejects async and inline destructive real-home cleanup", () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-isolation-lint-real-home-variants-"));
    try {
      const asyncFixture = path.join(fixtureDir, "async-dangerous.test.ts");
      fs.writeFileSync(
        asyncFixture,
        [
          'import fs from "node:fs";',
          'import os from "node:os";',
          'import path from "node:path";',
          "const realStore = path.join(os." + 'homedir(), ".local", "share", "tool");',
          "await fs.promises." + "rm(realStore, { recursive: true, force: true });",
        ].join("\n"),
      );
      const inlineFixture = path.join(fixtureDir, "inline-dangerous.test.ts");
      fs.writeFileSync(
        inlineFixture,
        [
          'import fs from "node:fs";',
          'import os from "node:os";',
          'import path from "node:path";',
          "fs." + "rmSync(path.join(os." + 'homedir(), ".config", "tool"), { recursive: true, force: true });',
        ].join("\n"),
      );

      expect(lintFile(asyncFixture)).toEqual([expect.objectContaining({ rule: "real-home-delete", line: 5 })]);
      expect(lintFile(inlineFixture)).toEqual([expect.objectContaining({ rule: "real-home-delete", line: 4 })]);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test("rejects formatter-normal multiline destructive real-home cleanup", () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-isolation-lint-real-home-multiline-"));
    try {
      const inlineFixture = path.join(fixtureDir, "multiline-inline-dangerous.test.ts");
      fs.writeFileSync(
        inlineFixture,
        [
          'import fs from "node:fs";',
          'import os from "node:os";',
          'import path from "node:path";',
          "fs." + "rmSync(",
          "  path.join(",
          "    os." + "homedir(),",
          '    ".config",',
          '    "tool",',
          "  ),",
          "  { recursive: true, force: true },",
          ");",
        ].join("\n"),
      );

      const promisesFixture = path.join(fixtureDir, "multiline-promises-dangerous.test.ts");
      fs.writeFileSync(
        promisesFixture,
        [
          'import fs from "node:fs";',
          'import os from "node:os";',
          'import path from "node:path";',
          "const realStore = path.join(",
          "  os." + "homedir(),",
          '  ".local",',
          '  "share",',
          '  "tool",',
          ");",
          "await fs.promises." + "rm(",
          "  realStore,",
          "  { recursive: true, force: true },",
          ");",
        ].join("\n"),
      );

      const namedFixture = path.join(fixtureDir, "multiline-named-dangerous.test.ts");
      fs.writeFileSync(
        namedFixture,
        [
          'import { rmSync } from "node:fs";',
          'import os from "node:os";',
          'import path from "node:path";',
          "rm" + "Sync(",
          "  path.join(os." + 'homedir(), ".cache", "tool"),',
          "  { recursive: true, force: true },",
          ");",
        ].join("\n"),
      );

      expect(lintFile(inlineFixture)).toEqual([expect.objectContaining({ rule: "real-home-delete", line: 4 })]);
      expect(lintFile(promisesFixture)).toEqual([expect.objectContaining({ rule: "real-home-delete", line: 10 })]);
      expect(lintFile(namedFixture)).toEqual([expect.objectContaining({ rule: "real-home-delete", line: 4 })]);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test("allows multiline read-only and uniquely owned home-derived fixtures", () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-isolation-lint-real-home-safe-"));
    const safeFixture = path.join(fixtureDir, "multiline-safe.test.ts");
    try {
      fs.writeFileSync(
        safeFixture,
        [
          'import fs from "node:fs";',
          'import os from "node:os";',
          'import path from "node:path";',
          "const realHome = os." + "homedir();",
          "const ownedFixture = fs.mkdtempSync(",
          '  path.join(realHome, "tool-owned-"),',
          ");",
          "fs." + "rmSync(",
          "  ownedFixture,",
          "  { recursive: true, force: true },",
          ");",
          'const sandboxed = path.join(os.tmpdir(), "tool-sandbox");',
          "fs." + "rmSync(sandboxed, { recursive: true, force: true });",
        ].join("\n"),
      );

      expect(lintFile(safeFixture).filter((violation) => violation.rule === "real-home-delete")).toEqual([]);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test("keeps same-named path bindings isolated across function scopes", () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-isolation-lint-real-home-scopes-"));
    const fixturePath = path.join(fixtureDir, "scope-safe.test.ts");
    try {
      fs.writeFileSync(
        fixturePath,
        [
          'import fs from "node:fs";',
          'import os from "node:os";',
          'import path from "node:path";',
          "function inspectRealHome() {",
          "  const root = path.join(",
          "    os." + "homedir(),",
          '    ".config",',
          '    "tool",',
          "  );",
          "  fs." + "rmSync(",
          "    root,",
          "    { recursive: true, force: true },",
          "  );",
          "}",
          "function cleanOwnedFixture() {",
          "  const root = fs.mkdtempSync(",
          '    path.join(os.tmpdir(), "tool-owned-"),',
          "  );",
          "  fs." + "rmSync(",
          "    root,",
          "    { recursive: true, force: true },",
          "  );",
          "}",
        ].join("\n"),
      );

      expect(lintFile(fixturePath).filter((violation) => violation.rule === "real-home-delete")).toEqual([
        expect.objectContaining({ line: 10 }),
      ]);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test("tracks object properties precisely instead of tainting their aggregate", () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-isolation-lint-real-home-properties-"));
    const fixturePath = path.join(fixtureDir, "property-safe.test.ts");
    try {
      fs.writeFileSync(
        fixturePath,
        [
          'import fs from "node:fs";',
          'import os from "node:os";',
          'import path from "node:path";',
          "const paths = {",
          "  inspected: path.join(",
          "    os." + "homedir(),",
          '    ".config",',
          '    "tool",',
          "  ),",
          "  owned: fs.mkdtempSync(",
          '    path.join(os.tmpdir(), "tool-owned-"),',
          "  ),",
          "};",
          "fs." + "rmSync(",
          "  paths.owned,",
          "  { recursive: true, force: true },",
          ");",
          "fs." + "rmSync(",
          "  paths.inspected,",
          "  { recursive: true, force: true },",
          ");",
        ].join("\n"),
      );

      expect(lintFile(fixturePath).filter((violation) => violation.rule === "real-home-delete")).toEqual([
        expect.objectContaining({ line: 18 }),
      ]);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test("classifies real-home operations and target flow by imported binding identity", () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-isolation-lint-real-home-ledger-"));
    const cases: Array<{ expectedLines: number[]; lines: string[]; name: string }> = [
      {
        name: "default-os-alias-danger",
        expectedLines: [4],
        lines: [
          'import fs from "node:fs";',
          'import platform from "node:os";',
          'import path from "node:path";',
          'fs.rmSync(path.join(platform.homedir(), ".config", "tool"), { recursive: true });',
        ],
      },
      {
        name: "namespace-os-alias-danger",
        expectedLines: [4],
        lines: [
          'import fs from "node:fs";',
          'import * as platform from "node:os";',
          'import path from "node:path";',
          'fs.rmSync(path.join(platform.homedir(), ".config", "tool"), { recursive: true });',
        ],
      },
      {
        name: "named-homedir-alias-danger",
        expectedLines: [4],
        lines: [
          'import { rmSync } from "node:fs";',
          'import { homedir as realHome } from "node:os";',
          'import path from "node:path";',
          'rmSync(path.join(realHome(), ".config", "tool"), { recursive: true });',
        ],
      },
      {
        name: "shadowed-os-safe",
        expectedLines: [],
        lines: [
          'import fs from "node:fs";',
          'import os from "node:os";',
          'import path from "node:path";',
          "function cleanup(os: { homedir(): string }) {",
          '  fs.rmSync(path.join(os.homedir(), "owned"), { recursive: true });',
          "}",
        ],
      },
      {
        name: "unrelated-delete-method-safe",
        expectedLines: [],
        lines: [
          'import os from "node:os";',
          'import path from "node:path";',
          "const recorder = { rmSync(_path: string) {} };",
          'recorder.rmSync(path.join(os.homedir(), ".config", "tool"));',
        ],
      },
      {
        name: "renamed-fs-delete-danger",
        expectedLines: [4],
        lines: [
          'import { rmSync as erase } from "node:fs";',
          'import os from "node:os";',
          'import path from "node:path";',
          'erase(path.join(os.homedir(), ".config", "tool"), { recursive: true });',
        ],
      },
      {
        name: "destructured-fs-delete-danger",
        expectedLines: [5],
        lines: [
          'import fs from "node:fs";',
          'import os from "node:os";',
          'import path from "node:path";',
          "const { rmSync: erase } = fs;",
          'erase(path.join(os.homedir(), ".config", "tool"), { recursive: true });',
        ],
      },
      {
        name: "renamed-fs-rmdir-sync-danger",
        expectedLines: [4],
        lines: [
          'import { rmdirSync as eraseDirectory } from "node:fs";',
          'import os from "node:os";',
          'import path from "node:path";',
          'eraseDirectory(path.join(os.homedir(), ".config", "tool"));',
        ],
      },
      {
        name: "renamed-fs-rm-async-danger",
        expectedLines: [4],
        lines: [
          'import { rm as eraseAsync } from "node:fs";',
          'import os from "node:os";',
          'import path from "node:path";',
          'eraseAsync(path.join(os.homedir(), ".config", "tool"), { recursive: true }, () => {});',
        ],
      },
      {
        name: "renamed-fs-rmdir-async-danger",
        expectedLines: [4],
        lines: [
          'import { rmdir as eraseDirectoryAsync } from "node:fs";',
          'import os from "node:os";',
          'import path from "node:path";',
          'eraseDirectoryAsync(path.join(os.homedir(), ".config", "tool"), () => {});',
        ],
      },
      {
        name: "renamed-fs-promises-rm-danger",
        expectedLines: [4],
        lines: [
          'import { rm as eraseAsync } from "node:fs/promises";',
          'import os from "node:os";',
          'import path from "node:path";',
          'await eraseAsync(path.join(os.homedir(), ".config", "tool"), { recursive: true });',
        ],
      },
      {
        name: "destructured-fs-promises-rmdir-danger",
        expectedLines: [5],
        lines: [
          'import fs from "node:fs";',
          'import os from "node:os";',
          'import path from "node:path";',
          "const { rmdir: eraseDirectoryAsync } = fs.promises;",
          'await eraseDirectoryAsync(path.join(os.homedir(), ".config", "tool"));',
        ],
      },
      {
        name: "target-destructure-danger",
        expectedLines: [6],
        lines: [
          'import fs from "node:fs";',
          'import os from "node:os";',
          'import path from "node:path";',
          'const paths = { dangerous: path.join(os.homedir(), ".config", "tool") };',
          "const { dangerous } = paths;",
          "fs.rmSync(dangerous, { recursive: true });",
        ],
      },
      {
        name: "target-destructure-rename-danger",
        expectedLines: [6],
        lines: [
          'import fs from "node:fs";',
          'import os from "node:os";',
          'import path from "node:path";',
          'const paths = { dangerous: path.join(os.homedir(), ".config", "tool") };',
          "const { dangerous: target } = paths;",
          "fs.rmSync(target, { recursive: true });",
        ],
      },
      {
        name: "late-variable-assignment-danger",
        expectedLines: [6],
        lines: [
          'import fs from "node:fs";',
          'import os from "node:os";',
          'import path from "node:path";',
          "let target: string;",
          'target = path.join(os.homedir(), ".config", "tool");',
          "fs.rmSync(target, { recursive: true });",
        ],
      },
      {
        name: "late-property-assignment-danger",
        expectedLines: [6],
        lines: [
          'import fs from "node:fs";',
          'import os from "node:os";',
          'import path from "node:path";',
          "const paths: { dangerous?: string } = {};",
          'paths.dangerous = path.join(os.homedir(), ".config", "tool");',
          "fs.rmSync(paths.dangerous!, { recursive: true });",
        ],
      },
      {
        name: "function-return-danger",
        expectedLines: [8],
        lines: [
          'import fs from "node:fs";',
          'import os from "node:os";',
          'import path from "node:path";',
          "function realStore() {",
          '  return path.join(os.homedir(), ".config", "tool");',
          "}",
          "",
          "fs.rmSync(realStore(), { recursive: true });",
        ],
      },
      {
        name: "named-mkdtemp-alias-safe",
        expectedLines: [],
        lines: [
          'import { mkdtempSync as makeOwned, rmSync } from "node:fs";',
          'import os from "node:os";',
          'import path from "node:path";',
          'const owned = makeOwned(path.join(os.homedir(), "tool-owned-"));',
          "rmSync(owned, { recursive: true });",
        ],
      },
      {
        name: "element-mkdtemp-safe",
        expectedLines: [],
        lines: [
          'import fs from "node:fs";',
          'import os from "node:os";',
          'import path from "node:path";',
          'const owned = fs["mkdtempSync"](path.join(os.homedir(), "tool-owned-"));',
          "fs.rmSync(owned, { recursive: true });",
        ],
      },
      {
        name: "fake-mkdtemp-boundary-danger",
        expectedLines: [5],
        lines: [
          'import fs from "node:fs";',
          'import os from "node:os";',
          'import path from "node:path";',
          'const target = { mkdtempSync: (p: string) => p }.mkdtempSync(path.join(os.homedir(), ".config", "tool"));',
          "fs.rmSync(target, { recursive: true });",
        ],
      },
    ];

    try {
      for (const fixture of cases) {
        const fixturePath = path.join(fixtureDir, `${fixture.name}.test.ts`);
        fs.writeFileSync(fixturePath, fixture.lines.join("\n"));
        const actualLines = lintFile(fixturePath)
          .filter((violation) => violation.rule === "real-home-delete")
          .map((violation) => violation.line);
        expect(actualLines, fixture.name).toEqual(fixture.expectedLines);
      }
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
