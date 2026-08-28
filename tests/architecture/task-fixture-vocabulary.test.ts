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
  // §6.2(a) — the v3->v4 migrator's own fixtures (spec
  // docs/plans/specs/p4-deletions-closeout.md §3.2.4).
  //
  // The v2->v3 migrator's own tasks/v3-migration/ fixture family this prefix
  // used to name is DELETED (P4 §3.2.7, F-A2.25) along with task source v3
  // acceptance — its only consumers (tests/tasks/parse-v3-adapter.test.ts,
  // and this same file's now-deleted tasks/v3-migration describe block, spec
  // §7.2 F-A2.24) are gone. B-61's terminal allowed set (spec §2.5) names
  // exactly these two prefixes.
  "tests/fixtures/execution-contracts/tasks/v3-to-v4/",
] as const;

const ALLOWED_EXACT_FILES = [
  // §6.2(a) — the v2->v3 migrator's own test files (its fixtures are covered
  // by the v3-migration/ prefix above)
  "tests/migrate/task-v2-to-v3-files.test.ts",
  "tests/tasks/migrate-v2-to-v3.test.ts",

  // §6.2(b) — SUBJECT is v3 parsing, v3 routing, or v3 migration
  //
  // P4 (docs/plans/specs/p4-deletions-closeout.md §3.2.7, F-A2.1/F-A2.2/
  // F-A2.3/F-A2.6/F-A2.7) DELETED tests/tasks/source-v3.test.ts,
  // tests/tasks-runtime-v3.test.ts, tests/tasks/parse-v3-adapter.test.ts,
  // tests/integration/tasks-scheduler-sync-v3.test.ts, and
  // tests/integration/tasks-scheduling-characterization.test.ts along with
  // task source v3 acceptance itself — their entries are trimmed here, not
  // merely left stale, per this ratchet's own stale-entry check.
  //
  // tests/tasks/bounded-document.test.ts (F-A2.11) FLIPped its "task v3
  // source" label to "task source" (row B-17) and its hostile-alias fixture
  // to task source v4 — it no longer carries a "version: 3" occurrence, so
  // its entry is trimmed here too rather than left stale.
  "tests/tasks/source-v4.test.ts",
  // source-v4-adapter.test.ts's ROUTING fixtures are what §6.2(b) names; the
  // sweep operates file-by-file, so the whole file is excluded here.
  "tests/tasks/source-v4-adapter.test.ts",
  "tests/integration/tasks-runtime-v3-runner.test.ts",
  // tests/integration/tasks-schema.test.ts's published-schema drift gate lost
  // its v3 arm entirely (P4 §3.2, schemas/akm-task.json flattens to task
  // source v4 only) — the file no longer carries a "version: 3" occurrence
  // anywhere, so its entry here is trimmed rather than left stale.

  // §6.2(c) — P0 characterization files pinning v3 behavior
  //
  // tests/integration/tasks-provenance-characterization.test.ts (F-A2.10)
  // CONVERTED every fixture to task source v4 (P-05/P-06/R-07 assertions
  // unchanged) — no "version: 3" occurrence remains, so its entry is
  // trimmed here.
  //
  // tests/integration/tasks-legacy-vocabulary-characterization.test.ts
  // (F-A2.9) CONVERTED all five R-08/R-09 fixtures (arm-workflow, arm-command,
  // arm-shell, arm-script, arm-fallback) to task source v4 — every assertion
  // (stored target_kind strings, read-back shapes, the "stash" fallback ref)
  // is byte-identical, since D8's vocabulary re-code and R-09's option-key
  // rename are both orthogonal to the source document's schema version. No
  // "version: 3" occurrence remains, so its entry is trimmed here too.
  // tests/integration/tasks-with-classification-characterization.test.ts
  // (F-A2.8) deleted its P-01/P-02 blocks (unreachable, spec §5.5) and
  // converted its surviving P-03/P-04 fixtures to task source v4 — no
  // "version: 3" occurrence remains, so its entry is trimmed here too.
  "tests/workflows/characterization-classification.test.ts",
  "tests/workflows/characterization-with-drop.test.ts", // also named again by §6.2(d)

  // §6.2(d) — fixtures named by §7's AUTHORIZED-FLIPS table; their v3-ness is
  // load-bearing for what the flip asserts (converting them would silently
  // change the thing being tested)
  "tests/workflows/with-rejection.test.ts",
  "tests/workflows/direct-script-typed.test.ts",
  // tests/workflows/task-source-v4-deferral.test.ts (F-A2.31) DELETED its
  // v3-contrast companion test — the LC-N1 guard it isolated was already
  // superseded, and with task source v3 gone there is no second version left
  // to contrast against. No "version: 3" occurrence remains, so its entry is
  // trimmed here.

  // §6.2(a)/(b) — Lane C's own migrator suite. This generation's reference
  // suite (spec §5.1) combines the translation-table coverage (B-60..B-69)
  // and the filesystem-ladder coverage (B-70..B-74) into one file, exactly
  // as tests/migrate/task-v2-to-v3-files.test.ts and
  // tests/tasks/migrate-v2-to-v3.test.ts are excluded by name above: its
  // SUBJECT is v3 migration, and its v3 task-source fixtures exercise the
  // migrator's INPUT side (the vendored v3 reader, C-N1) deliberately.
  "tests/migrate/task-v3-to-v4.test.ts",

  // §6.2(b) catch-all ("any other test whose SUBJECT is v3 parsing, v3
  // routing, or v3 migration") —
  // tests/integration/cli-errors.test.ts's new B-14/B-15 envelope coverage
  // (P4 docs/plans/specs/p4-deletions-closeout.md §7.2 F-A2.35) is exactly
  // this catch-all: its SUBJECT is proving `akm task run` on a genuine
  // version: 3 (and version: 2) source emits the TASK_SCHEMA_VERSION_UNSUPPORTED
  // envelope with the migrate hint — the fixture's v3-ness IS the point.
  "tests/integration/cli-errors.test.ts",
  //
  // tests/integration/commands/tasks-explain.test.ts's B-57 entry that used
  // to live here is DELETED, not converted: task source v3 acceptance is
  // retired entirely (spec §3.2), so "akm task explain resolves a genuine
  // version: 3 task" is no longer a claim any fixture can demonstrate — the
  // describe block asserting it is deleted outright (mechanically forced by
  // the retirement, not itself a named F-A2 row), so there is no v4 fixture
  // standing in for it either. The file's entry is trimmed here.

  // P1b's own §8 preservation gate named "tests/tasks/source-v3.test.ts,
  // tests/tasks/parse-v3-adapter.test.ts, tests/tasks/prepare-split.test.ts,
  // tests/tasks/run-split.test.ts, tests/tasks/model-contracts.test.ts,
  // tests/tasks/bounded-document.test.ts green and byte-unchanged" — this
  // entry used to keep tests/tasks/prepare-split.test.ts's parseTaskV3Yaml
  // fixture on the allow-list for exactly that reason. P4
  // (docs/plans/specs/p4-deletions-closeout.md §3.2.7, F-A2.15) SUPERSEDES
  // that gate for all six of P1b's named files, exactly as P2a superseded
  // P1b §9's structure criterion (spec §3.2.7's own citation): two are
  // deleted (source-v3.test.ts, parse-v3-adapter.test.ts, F-A2.1/F-A2.3),
  // and prepare-split.test.ts/run-split.test.ts/model-contracts.test.ts
  // (F-A2.15/F-A2.16/F-A2.4) are FLIPped to import the split modules
  // directly rather than through the now-deleted runtime-v3.ts/runner.ts
  // shims their "byte-unchanged" comparisons depended on —
  // prepare-split.test.ts's own fixture converts to task source v4 as part
  // of that flip, so its entry here is trimmed rather than left stale.
  // bounded-document.test.ts (F-A2.11) still carries the shape; see below.

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

  // P4 (docs/plans/specs/p4-deletions-closeout.md §3.2.7, row B-22, F-A2.17/
  // F-A2.18) DELETED run-task.ts's shouldSkipUnactivatedTask (the disabled-
  // dispatch skip the Lane D sweep escape-valve entries here used to
  // protect) ENTIRELY — not merely made it unreachable for a v4 source, as
  // the P2b-era reasoning below assumed.
  // tests/integration/commands/tasks-cli-envelope.test.ts deleted its "skips
  // the disabled task" case with the skip and converted its remaining
  // fixtures to task source v4. tests/integration/tasks-runner.test.ts
  // converted every fixture the same way (including "threads declared
  // maxSteps / maxRetries into the orchestrator", whose
  // `with:`-on-a-workflow-target -> child-run-params path is retired along
  // with task source v3 itself, row B-28/R-R2) — its own helpers build task
  // YAML from object literals via the `yaml` package's `stringify`, so a
  // schedule-free (task source v4's OPTIONAL scheduling, D2-N6) fixture
  // never even spells the literal text "schedule:" in source. Neither file
  // matches the ratchet's two-needle shape at all now, so both entries are
  // trimmed here rather than left stale.

  // tests/integration/tasks-scheduler-sync-v4.test.ts's "v3 alongside v4
  // coexistence" case is FLIPped by P4 (spec §7.2, F-A2.33) to a two-v4-task
  // case, since coexistence is no longer expressible once task source v3 is
  // gone — the file no longer carries a "version: 3" occurrence at all, so
  // its entry here is trimmed rather than left stale. (Its later port of the
  // deleted tests/integration/tasks-scheduler-sync-v3.test.ts, F-A2.6, is
  // v4-only for the same reason.)

  // tests/core/adapter/akm-validate.test.ts (F-A2.21): every other
  // "v3 parsing" case FLIPped to its task source v4 equivalent (the
  // remaining "version: 3"+"schedule:" occurrence sits only in the new "a v3
  // task is flagged with the canonical migration preview hint (row B-14)"
  // case, whose SUBJECT is proving a genuine version: 3 document still fails
  // closed with the migrate hint — matching §6.2(b)'s catch-all, "any other
  // test whose SUBJECT is v3 parsing/routing").
  "tests/core/adapter/akm-validate.test.ts",

  // tests/setup-scheduled-tasks.test.ts (F-A2.20): `akm setup`'s scheduled-
  // task review step (src/setup/steps/tasks.ts's `listSetupTaskDefinitions`
  // and `prepareSetupTaskDefinitions`) is REWIRED to `parseTaskSource` by P4
  // (§3.2.6, row B-23) — the "this subsystem is unrouted" reasoning that used
  // to keep this file's v3 fixtures on the allow-list no longer holds; its
  // fixtures convert to task source v4, so its entry is trimmed here too.

  // P3a Lane B's own "load-bearing v3-ness" note for these two files (rows
  // B-12/B-14/B-22) is SUPERSEDED by P4 (docs/plans/specs/
  // p4-deletions-closeout.md §7.2, F-A2.29): the `with:`-on-a-workflow-target
  // grammar this note worried about losing coverage of is itself retired
  // along with task source v3 acceptance (row B-28, R-R2 resolved by
  // deletion, spec §8) — there is no "DIFFERENT v4 declared-inputs: binding
  // path" to silently fall back to any more, since the `with:` path no
  // longer exists at all. Both files now declare a typed `inputs:` default
  // instead, proving the child's params still arrive as a literal binding —
  // sourced from the default rather than an authored `with:`. Neither file
  // carries a "version: 3" occurrence any more, so both entries are trimmed
  // here.
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
