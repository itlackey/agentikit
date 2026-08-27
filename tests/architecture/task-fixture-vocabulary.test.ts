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

  // §6.2(a)/(b) — Lane C's own migrator suite. This generation's reference
  // suite (spec §5.1) combines the translation-table coverage (B-60..B-69)
  // and the filesystem-ladder coverage (B-70..B-74) into one file, exactly
  // as tests/migrate/task-v2-to-v3-files.test.ts and
  // tests/tasks/migrate-v2-to-v3.test.ts are excluded by name above: its
  // SUBJECT is v3 migration, and its v3 task-source fixtures exercise the
  // migrator's INPUT side (the vendored v3 reader, C-N1) deliberately.
  "tests/migrate/task-v3-to-v4.test.ts",

  // §6.2(b) catch-all ("any other test whose SUBJECT is v3 parsing, v3
  // routing, or v3 migration") — spec row B-57 requires `akm task explain
  // <ref>` to be proven against a genuine version: 3 task (declarations
  // list resolves empty; target kind/ref and execution settings still
  // resolve). Converting that fixture would remove the only v3 case this
  // acceptance row covers.
  "tests/integration/commands/tasks-explain.test.ts",

  // §8 preservation gate (binding, reviewer-run): "tests/tasks/source-v3.test.ts,
  // tests/tasks/parse-v3-adapter.test.ts, tests/tasks/prepare-split.test.ts,
  // tests/tasks/run-split.test.ts, tests/tasks/model-contracts.test.ts,
  // tests/tasks/bounded-document.test.ts green and byte-unchanged." — its
  // parseTaskV3Yaml fixture must stay v3 byte-for-byte.
  "tests/tasks/prepare-split.test.ts",

  // P2b test-review finding #4 (tests/workflows/task-input-bindings.test.ts:1):
  // the missing identity suite (B-01, B-43, B-44). Its B-01 case's
  // no-declared-inputs target is deliberately version: 3, mirroring
  // with-rejection.test.ts's own reasoning immediately above: a v3 task can
  // never declare `inputs:` at all (P2a §1.2 D2), so "declares no inputs"
  // holds independent of any binding logic, AND — unlike a version: 4
  // fixture — is unaffected by A-N6's still-active LC-N1 deferral, which
  // blocks EVERY version: 4 task composed from a workflow step today. B-01
  // is itself a PRESERVATION claim ("byte-identical to today"), and before
  // P2b v3 was the only reachable task-composition target, so this is the
  // more faithful fixture for that exact claim, not merely a workaround.
  "tests/workflows/task-binding-identity.test.ts",

  // Lane D sweep, discovered load-bearing v3-ness (spec §6.3's own escape
  // valve — "Any file where the conversion would change what the test
  // asserts is moved into the exclusion list and the reason is recorded in
  // the Review log"), 2026-08-27. Every entry below was verified by running
  // its suite both before and after attempting conversion; converting broke
  // the named assertion for an architectural reason unrelated to fixture
  // authoring style.
  //
  // task source v4's per-schedule-binding `enabled` is deliberately NOT
  // projected into the document-level flag runTask's own disabled-dispatch
  // skip reads (src/tasks/source/project-v4.ts's own header: "carried
  // separately to the scheduler seam, not this function"; the derivation is
  // src/tasks/prepare/prepare-support.ts:120's
  // `enabled: document.akm?.enabled !== false`, which is always `true` for a
  // v4-projected document since `projectAkm` never sets `akm.enabled`). Every
  // fixture below feeds a scheduled/`--scheduled` `runTask` dispatch whose
  // assertion depends on the SKIP actually firing, which is unreachable for
  // a v4 source under the current runtime — a v3->v4 rewrite would silently
  // stop testing the skip at all (the dispatch would just run).
  "tests/integration/commands/tasks-cli-envelope.test.ts",
  "tests/integration/tasks-runner.test.ts",

  // tests/integration/commands/tasks-lifecycle.test.ts's own
  // `setEnabledInYaml` case ("setup-style enable edits stay inside the v3
  // akm mapping") exercises that exact-named function byte-for-byte —
  // `setEnabledInYaml` is a v3-YAML-text splice (the same family as
  // src/setup/steps/tasks.ts's `setTaskV3EnabledInYaml`, both used only by
  // codepaths `akm task add` keeps on v3, per this spec's §0 "P2b is not...
  // an `akm task add` phase") and would not even produce valid task source
  // v4 syntax if pointed at one. Every OTHER fixture in this file converted
  // cleanly.
  "tests/integration/commands/tasks-lifecycle.test.ts",

  // tests/integration/tasks-scheduler-sync-v4.test.ts:105's own test name —
  // "a manual-only version: 4 task alongside a normally-scheduled version: 3
  // task: the v3 task still installs, the v4 task contributes nothing" — is
  // a coexistence proof; its v3 half is the PRESERVE half of the claim by
  // construction, and spec §7 F-B2's own disposition table already names
  // this exact line "UNCHANGED, must stay green" alongside the file's other
  // v4-only cases.
  "tests/integration/tasks-scheduler-sync-v4.test.ts",

  // tests/core/adapter/akm-validate.test.ts: every "version: 3"+"schedule:"
  // occurrence sits in a test whose NAME says its subject is v3 parsing
  // itself — "task missing the v3 version", "a valid v3 task omitting
  // optional akm.enabled", "a task with a non-boolean akm.enabled", "a task
  // omitting version" (falls through to v3's own preserved wording per
  // src/tasks/source/parse-task-source.ts's routing table) — each asserts on
  // v3-only field paths (`akm.enabled`) or v3's own error wording ("version
  // ... required ... 3"), matching §6.2(b)'s catch-all ("any other test
  // whose SUBJECT is v3 parsing").
  "tests/core/adapter/akm-validate.test.ts",

  // tests/setup-scheduled-tasks.test.ts: `akm setup`'s scheduled-task review
  // step (src/setup/steps/tasks.ts's `listSetupTaskDefinitions` and
  // `prepareSetupTaskDefinitions`) calls `parseTaskV3Yaml` and
  // `setTaskV3EnabledInYaml` DIRECTLY — no `parseTaskSource` version routing
  // exists on this path at all. A version: 4 fixture would not silently
  // change behavior here; it would throw "version ... must be exactly 3"
  // where the test expects a value. This subsystem is unrouted, not merely
  // v3-preferring — out of P2b's scope entirely.
  "tests/setup-scheduled-tasks.test.ts",

  // P3a Lane B (docs/plans/specs/p3a-plan-v5-child-freeze.md §4, rows
  // B-12/B-14/B-22), discovered load-bearing v3-ness (spec §6.3's escape
  // valve, same as the "Lane D sweep" block above), 2026-08-27. Both files
  // author a `version: 3` task whose OWN `uses:` targets a workflow,
  // specifically to prove the task-wrapped child-workflow composition path
  // works from a v3 task (B-12/B-14's "a v3 task whose own uses: targets a
  // workflow freezes to a child-workflow target ... the task's own with:
  // becomes the child's params", and B-22's task-mediated composition-cycle
  // fixture) — the SAME `PreparedTaskV3Workflow.params` code path P2b's own
  // "tests/workflows/task-binding-identity.test.ts" entry above documents as
  // "unaffected by [the v4 deferral]" and "the more faithful fixture" for a
  // v3-specific claim. Converting either to task source v4 would test the
  // DIFFERENT v4 declared-`inputs:` binding path instead (already covered by
  // this same spec's F-B4 flip in tests/workflows/task-input-bindings.test.ts),
  // silently dropping v3-task-wrapped-workflow coverage entirely. The
  // `schedule:` block is the same v3-mandatory-scheduling padding every other
  // entry here carries (P0 row R-06) — not itself under test.
  "tests/workflows/child-workflow-freeze.test.ts",
  "tests/integration/workflows/child-freeze-read-set.test.ts",
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
