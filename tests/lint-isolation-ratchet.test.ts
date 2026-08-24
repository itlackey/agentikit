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
});
