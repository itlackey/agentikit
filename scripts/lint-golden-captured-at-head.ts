// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `capturedAtHead` integrity guard (#730 review follow-up).
 *
 * Every golden fixture under `tests/fixtures/goldens/**` and
 * `tests/fixtures/format-family-goldens/**` that records a `capturedAtHead`
 * commit SHA carries it as free-form audit-trail text — never machine
 * checked before this script. Post-hoc review of #730 found all four new
 * `tests/fixtures/format-family-goldens/okf/*.json` files pointed at
 * `250f91bcd76635c10227fea8ef33b75830f11143`: a commit object that still
 * existed locally but was unreachable from any ref, almost certainly a
 * pre-amend duplicate of the real "D2 GREEN" commit left behind by an
 * interrupted git operation. Left alone, that pin would 404 on GitHub and
 * vanish under a local `git gc`. Nothing caught it because `capturedAtHead`
 * was never validated — a human fixed it by hand
 * (`fix(okf): repoint stale capturedAtHead in the OKF format-family goldens
 * (#730)`). This is the guard against that recurring silently.
 *
 * For every non-null `capturedAtHead` found on any golden JSON file:
 *   1. it must look like a SHA (7-40 hex chars) — catches outright typos;
 *   2. `git cat-file -t <sha>` must resolve it to a real, existing `commit`
 *      object — catches a fabricated or already-gc'd hash (cheap: one local
 *      object-database lookup, no network);
 *   3. it must be reachable from AT LEAST ONE ref this clone knows about
 *      (`git branch -a --contains <sha>` — every local AND remote-tracking
 *      branch; still cheap and local-only). This is deliberately NOT
 *      "must be an ancestor of the current branch" — this repo rebases
 *      feature branches onto `main` routinely (see this very PR), which
 *      rewrites commit hashes and makes a perfectly legitimate historical
 *      pin a non-ancestor of the new tip. Reachable-from-ANY-ref instead
 *      accepts "still exists somewhere in history this clone can see"
 *      (typically the now-merged branch that originally captured the
 *      golden) while still catching a pin that was NEVER reachable from
 *      anywhere — exactly the bug class above.
 *
 * A commit that fails check 2 or 3 is real: repoint it to the current-history
 * commit with the same log message/diff (see the #730 fix above for the
 * precedent), or re-capture the golden if its content is also changing in
 * the same commit.
 *
 * KNOWN_STALE below grandfathers pre-existing violations this script's
 * introduction found OUTSIDE the #730 surface, so a new, stricter gate
 * does not block unrelated work landing through this PR. Each entry is a
 * real bug for its own surface owner to fix (repoint or re-capture) — this
 * list must only ever shrink, never grow.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const GOLDEN_ROOTS = ["tests/fixtures/goldens", "tests/fixtures/format-family-goldens"];
const SHA_RE = /^[0-9a-f]{7,40}$/i;

/**
 * Pre-existing `capturedAtHead` violations found outside the #730 surface
 * when this guard was introduced. Grandfathered (printed as a warning, not a
 * failure) so this new gate doesn't block work unrelated to the golden it
 * names. Remove an entry once its surface owner repoints or re-captures it —
 * never add a NEW one; a fresh violation should fail lint like any other.
 */
const KNOWN_STALE: Record<string, string> = {
  // Empty, and worth keeping that way. The last entry
  // (tests/fixtures/goldens/lint/all-types.json) was retired in 0.9.1 (#795) by
  // repointing the pin to 2d0e39c5, the commit that produced the golden's
  // current bytes. Its grandfather note had itself gone stale: it claimed the
  // recorded commit "does not exist in this clone's object database at all",
  // but cd94d26c resolves fine — it was simply a July-21 docs commit that never
  // touched the golden, which the two reachability checks below cannot see.
};

function git(args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim() };
}

/**
 * True when this clone lacks full history, which makes a MISSING commit object
 * inconclusive rather than a finding.
 *
 * CI runs `actions/checkout` with the default `fetch-depth: 1`, so nearly every
 * historical pin is absent there — and a shallow clone genuinely cannot tell
 * "garbage-collected / orphaned" (the bug class this guards) apart from "simply
 * never fetched" (normal and fine). Treating absence as a failure there fails
 * ~every golden in the repo, including ones the change never touched, which is
 * exactly what happened when this guard first ran in CI.
 *
 * Note this is NOT a wholesale skip: the second, sharper check — object
 * EXISTS but is unreachable from every branch — is conclusive regardless of
 * shallowness (a present object is a present object), and that is precisely
 * the #730 bug class. It stays blocking everywhere. Only the inconclusive
 * "object absent" case softens to a warning.
 */
const HISTORY_INCOMPLETE = git(["rev-parse", "--is-shallow-repository"]).stdout === "true";

async function findGoldenFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const root of GOLDEN_ROOTS) {
    const absRoot = path.join(REPO_ROOT, root);
    if (!fs.existsSync(absRoot)) continue;
    const glob = new Bun.Glob("**/*.json");
    for await (const rel of glob.scan({ cwd: absRoot })) {
      files.push(`${root}/${rel.split(path.sep).join("/")}`);
    }
  }
  return files.sort();
}

const failures: string[] = [];
const warnings: string[] = [];
let checked = 0;
let inconclusive = 0;

for (const rel of await findGoldenFiles()) {
  const abs = path.join(REPO_ROOT, rel);
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch {
    continue; // malformed JSON is another lint's concern, not this one's
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) continue;
  const sha = (data as Record<string, unknown>).capturedAtHead;
  if (sha === undefined || sha === null) continue; // no pin recorded (e.g. an unimplemented adapter family) — fine
  if (typeof sha !== "string" || sha.length === 0) {
    failures.push(`${rel}: capturedAtHead is not a non-empty string (${JSON.stringify(sha)})`);
    continue;
  }
  checked++;

  let problem: string | undefined;
  if (!SHA_RE.test(sha)) {
    problem = `capturedAtHead "${sha}" is not a plausible commit SHA`;
  } else {
    const cat = git(["cat-file", "-t", sha]);
    if (!cat.ok || cat.stdout !== "commit") {
      // Absence is only a finding when this clone HAS the history to judge it.
      if (HISTORY_INCOMPLETE) {
        inconclusive++;
        continue;
      }
      problem = `capturedAtHead ${sha} does not resolve to an existing commit object in this clone`;
    } else {
      const contains = git(["branch", "-a", "--contains", sha]);
      if (!contains.ok || contains.stdout.length === 0) {
        problem =
          `capturedAtHead ${sha} exists locally but is unreachable from every branch this clone knows ` +
          "about — it would 404 on GitHub and can vanish under a local `git gc` (the exact #730 bug class)";
      }
    }
  }

  if (problem === undefined) continue;
  const known = KNOWN_STALE[rel];
  if (known) {
    warnings.push(`${rel}: ${problem}\n    KNOWN, grandfathered: ${known}`);
  } else {
    failures.push(`${rel}: ${problem}`);
  }
}

if (warnings.length > 0) {
  console.warn(`lint-golden-captured-at-head: ${warnings.length} known, grandfathered warning(s) (not blocking):`);
  for (const w of warnings) console.warn(`  ${w}`);
}

if (failures.length > 0) {
  console.error(`lint-golden-captured-at-head: ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    "A golden's capturedAtHead is an audit-trail pin to the commit it was captured against. Repoint it to the " +
      "current-history commit sharing the same log message/diff (see `fix(okf): repoint stale capturedAtHead " +
      "in the OKF format-family goldens (#730)` for the precedent), or re-capture the golden if its content is " +
      "also changing in this same change.",
  );
  process.exit(1);
}

// Report what was NOT judged, so a shallow run never reads as full coverage.
if (inconclusive > 0) {
  console.warn(
    `lint-golden-captured-at-head: ${inconclusive} pin(s) not judged — their commit object is absent and this clone ` +
      "is shallow, so absence cannot be distinguished from never-fetched. Run in a full clone " +
      "(`git fetch --unshallow`) to check them.",
  );
}

console.log(
  `lint-golden-captured-at-head: OK — ${checked - inconclusive} of ${checked} capturedAtHead pin(s) checked across ` +
    `${GOLDEN_ROOTS.length} golden root(s), all judged pins resolve to a real, reachable commit` +
    `${warnings.length > 0 ? ` (${warnings.length} pre-existing warning(s) above)` : ""}` +
    `${inconclusive > 0 ? `; ${inconclusive} unjudged (shallow clone)` : ""}.`,
);
