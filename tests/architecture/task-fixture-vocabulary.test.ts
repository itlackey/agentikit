// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Lane D inventory ratchet (docs/plans/specs/p2b-input-bindings.md §6 "Lane D
 * — the v3 fixture sweep", §6.1, §6.2, D-N1).
 *
 * v3's mandatory-scheduling rule (P0 row R-06) forces any test that just
 * needs *a* valid task fixture — and does not care what triggers it — to pad
 * the document with a synthetic `akm:\n  schedule: "@daily"` block purely to
 * make it parse. §1.4's phase decision named 66 such files; D-N1 found the
 * number was never pinned and gave the reproducible derivation instead:
 *
 *   comm -12 <(rg -l --sort path 'version: 3' tests/) <(rg -l --sort path 'schedule:' tests/)
 *
 * This test reimplements that same two-needle intersection in pure `node:fs`
 * (no `rg` dependency at test time — verified byte-for-byte against the `rg`
 * pipeline above while authoring this file) and asserts the LIVE result
 * equals the boundary §6.2 draws explicitly: the v3-subject files, the v2->v3
 * and v3->v4 migrators' own fixtures, and the P0 characterization files whose
 * v3-ness is the thing under test. Nothing else may still carry the shape.
 *
 * INVENTORY ONLY (P2b Lane D, test phase): this file converts nothing. It is
 * RED today — every file the mechanical sweep (§6.3, its own commit, last in
 * the P2b ladder) has not yet converted shows up as a listed offender below —
 * and goes GREEN once that sweep lands, with no edit to this file required
 * for the ordinary case. A file discovered mid-sweep whose v3-ness turns out
 * to be genuinely load-bearing (§6.3: "Any file where the conversion would
 * change what the test asserts is moved into the exclusion list and the
 * reason is recorded in the Review log") is added to ALLOWED_EXACT_FILES
 * below with that same Review-log citation — the boundary stays reviewable
 * either way, because every exclusion is a named line here, not a silent
 * skip.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const TESTS_DIR = path.join(ROOT, "tests");

// This file itself names both needles below (in this comment block, and as
// the literal search strings) — it is not a task fixture and must not scan
// itself.
const SELF_FILE = "tests/architecture/task-fixture-vocabulary.test.ts";

const NEEDLE_VERSION_3 = "version: 3";
const NEEDLE_SCHEDULE = "schedule:";

// ── The ALLOWED boundary — copied from spec §6.2, category by category ─────
//
// A directory PREFIX means "every file under here is out of scope for the
// sweep, whether or not it currently carries the shape" (the spec spells
// each of these with a trailing `/**`). An EXACT file means "this one file,
// named by the spec, stays v3."

const ALLOWED_PREFIXES = [
  // §6.2(a) — tests/fixtures/execution-contracts/tasks/v2/**
  "tests/fixtures/execution-contracts/tasks/v2/",
  // §6.2(a) — the v2->v3 migrator's own fixtures
  "tests/fixtures/execution-contracts/tasks/v3-migration/",
  // §6.2(a) — Lane C's own new v3->v4 migrator fixtures (does not exist until
  // Lane C lands; excluded pre-emptively so its arrival needs no edit here)
  "tests/fixtures/execution-contracts/tasks/v3-to-v4/",
] as const;

const ALLOWED_EXACT_FILES = [
  // §6.2(a) — the v2->v3 migrator's own test files (its fixtures are covered
  // by the v3-migration/ prefix above)
  "tests/migrate/task-v2-to-v3-files.test.ts",
  "tests/tasks/migrate-v2-to-v3.test.ts",

  // §6.2(b) — SUBJECT is v3 parsing, v3 routing, or v3 migration
  "tests/tasks/source-v3.test.ts",
  "tests/tasks-runtime-v3.test.ts",
  "tests/tasks/parse-v3-adapter.test.ts",
  "tests/tasks/bounded-document.test.ts",
  "tests/tasks/source-v4.test.ts",
  // source-v4-adapter.test.ts's ROUTING fixtures are what §6.2(b) names; the
  // sweep operates file-by-file, so the whole file is excluded here.
  "tests/tasks/source-v4-adapter.test.ts",
  "tests/integration/tasks-runtime-v3-runner.test.ts",
  "tests/integration/tasks-scheduler-sync-v3.test.ts",
  "tests/integration/tasks-schema.test.ts",

  // §6.2(c) — P0 characterization files pinning v3 behavior
  "tests/integration/tasks-scheduling-characterization.test.ts", // R-06 must stay true for v3
  "tests/integration/tasks-provenance-characterization.test.ts",
  "tests/integration/tasks-legacy-vocabulary-characterization.test.ts",
  "tests/integration/tasks-with-classification-characterization.test.ts",
  "tests/workflows/characterization-classification.test.ts",
  "tests/workflows/characterization-with-drop.test.ts", // also named again by §6.2(d)

  // §6.2(d) — fixtures named by §7's AUTHORIZED-FLIPS table; their v3-ness is
  // load-bearing for what the flip asserts (converting them would silently
  // change the thing being tested)
  "tests/workflows/with-rejection.test.ts",
  "tests/workflows/direct-script-typed.test.ts",
  "tests/workflows/task-source-v4-deferral.test.ts",
] as const;

function isAllowed(relPath: string): boolean {
  if (ALLOWED_PREFIXES.some((prefix) => relPath.startsWith(prefix))) return true;
  return (ALLOWED_EXACT_FILES as readonly string[]).includes(relPath);
}

/** Recursively collect every file under `dir`, as absolute paths. */
function collectAllFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectAllFiles(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

/** repo-relative, forward-slash-normalized regardless of host path separator. */
function toRepoRelative(absPath: string): string {
  return path.relative(ROOT, absPath).split(path.sep).join("/");
}

/**
 * Every file under tests/ carrying the synthetic v3 task shape — the same
 * intersection D-N1's `comm -12` pipeline computes, reimplemented so the
 * ratchet needs no `rg` binary at test time.
 */
function measureSyntheticShapeFiles(): string[] {
  const matches: string[] = [];
  for (const absPath of collectAllFiles(TESTS_DIR)) {
    const relPath = toRepoRelative(absPath);
    if (relPath === SELF_FILE) continue;
    let content: string;
    try {
      content = fs.readFileSync(absPath, "utf8");
    } catch {
      continue; // unreadable (e.g. a broken symlink) — not a fixture
    }
    if (content.includes(NEEDLE_VERSION_3) && content.includes(NEEDLE_SCHEDULE)) {
      matches.push(relPath);
    }
  }
  return matches.sort();
}

describe("v3 task-fixture vocabulary ratchet (p2b-input-bindings.md §6, Lane D)", () => {
  test("only the spec-named v3-subject, migrator, and P0-characterization files author the synthetic version: 3 + schedule: shape", () => {
    const matched = measureSyntheticShapeFiles();
    const offenders = matched.filter((f) => !isAllowed(f));
    const staleAllowlistEntries = ALLOWED_EXACT_FILES.filter((f) => !matched.includes(f));

    if (offenders.length > 0 || staleAllowlistEntries.length > 0) {
      const lines: string[] = [];
      if (offenders.length > 0) {
        lines.push(
          `${offenders.length} file(s) still author the synthetic v3 "${NEEDLE_VERSION_3}" + "${NEEDLE_SCHEDULE}" ` +
            "shape but are not on the spec §6.2 exclusion list. Convert each to schedule-free task source v4 " +
            "(the Lane D sweep, its own commit), or — if its v3-ness is genuinely load-bearing for what it " +
            "asserts — add it to ALLOWED_EXACT_FILES above with a dated Review-log note explaining why (spec §6.3):",
        );
        lines.push(...offenders.map((f) => `  + ${f}`));
      }
      if (staleAllowlistEntries.length > 0) {
        lines.push(
          `${staleAllowlistEntries.length} entr${staleAllowlistEntries.length === 1 ? "y" : "ies"} in ` +
            "ALLOWED_EXACT_FILES no longer author the synthetic shape (file missing, or it no longer carries " +
            "both needles) — trim the stale entry so the boundary stays accurate:",
        );
        lines.push(...staleAllowlistEntries.map((f) => `  - ${f}`));
      }
      throw new Error(lines.join("\n"));
    }

    expect(offenders).toEqual([]);
    expect(staleAllowlistEntries).toEqual([]);
  });
});
