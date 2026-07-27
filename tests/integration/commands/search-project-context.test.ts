// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * F1/A1 end-to-end regression: `akm search --no-project-context` must
 * actually suppress the project-context ranking boost.
 *
 * Root cause (verified against the installed parser,
 * node_modules/citty/dist/index.mjs): citty strips a leading `--no-` from
 * ANY token and treats the remainder as negation BEFORE consulting the
 * declared-args table. A flag DECLARED as `no-project-context` can therefore
 * never be negated by `--no-project-context` — citty parses that as "negate
 * `project-context`", a name nothing declared, leaving the real key at its
 * default `false` forever. The fix declares the flag as the POSITIVE name
 * `project-context` with `default: true` (the same pattern `sync
 * --push/--no-push` already uses), so citty's native negation does the work.
 *
 * This spawns a REAL subprocess (not the in-process harness) because the
 * boost is derived from `resolveProjectContext(process.cwd())` — a genuine
 * process-cwd-dependent behavior that requires a real working directory,
 * the same reason `tests/integration/cli-errors.test.ts`'s "registry remove"
 * test stays a subprocess (in-process `process.chdir()` breaks Bun's
 * bare-specifier resolution for the CLI's lazy dynamic imports).
 *
 * Each invocation gets its own fully isolated stash + XDG dirs so the two
 * runs (boost vs suppressed) can never share state (e.g. the F2 usage-score
 * bump) and are compared on identical inputs.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");

// A distinctive, single-token project name so resolveProjectContext's
// Attempt 2 (package.json `name`) derives exactly this token — no `.git`
// directory exists in the fixture project dir, so Attempt 1 is skipped, and
// the token is unique enough to never collide with any other ranking signal.
const PROJECT_TOKEN = "zzqf1projecttoken";

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function spawnCli(
  args: string[],
  cwd: string,
  env: Record<string, string>,
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("bun", [path.join(repoRoot, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    timeout: 20_000,
    cwd,
    env: { ...process.env, AKM_STASH_DIR: undefined, ...env },
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
}

/**
 * Build a fresh, fully isolated project dir + stash + XDG dir set, seeded
 * with two assets:
 *   - `widget-master`: a strong keyword match for "widget" (repeats the
 *     term), establishing a bm25 range so FTS-score normalization is not the
 *     degenerate single-hit "worst==best -> 1.0" case.
 *   - `widget-tool`: the TARGET, a weaker keyword match tagged with
 *     `PROJECT_TOKEN` — this is the hit whose score the project-context
 *     boost can move, and it stays below the [0,1] display clamp
 *     (db-search.ts's `Math.min(1, …)`) both with and without the boost, so
 *     a real difference is observable either way.
 * Returns the isolated `cwd` (project dir) and `env` to pass to `spawnCli`.
 */
function seedIsolatedRun(): { cwd: string; env: Record<string, string> } {
  const projectDir = makeTempDir("akm-f1-project-");
  const stashDir = makeTempDir("akm-f1-stash-");
  const home = makeTempDir("akm-f1-home-");
  const xdgConfig = makeTempDir("akm-f1-config-");
  const xdgCache = makeTempDir("akm-f1-cache-");
  const xdgData = makeTempDir("akm-f1-data-");

  fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: PROJECT_TOKEN }));

  fs.mkdirSync(path.join(stashDir, "commands"), { recursive: true });
  fs.writeFileSync(
    path.join(stashDir, "commands", "widget-master.md"),
    [
      "---",
      "description: Widget widget widget master control tool for managing every widget",
      "---",
      "Manage widget widget widget fleets from one place.",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(stashDir, "commands", "widget-tool.md"),
    ["---", "description: Widget tool", "tags:", `  - ${PROJECT_TOKEN}`, "---", "Run the widget tool."].join("\n"),
  );

  return {
    cwd: projectDir,
    env: {
      HOME: home,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_CACHE_HOME: xdgCache,
      XDG_DATA_HOME: xdgData,
      AKM_STASH_DIR: stashDir,
    },
  };
}

function targetScore(stdout: string): number {
  const json = JSON.parse(stdout) as { hits: Array<{ ref: string; score?: number }> };
  const hit = json.hits.find((h) => h.ref.includes("widget-tool"));
  expect(hit).toBeDefined();
  expect(typeof hit?.score).toBe("number");
  return hit?.score as number;
}

describe("akm search --no-project-context (F1/A1)", () => {
  test("suppresses the project-context ranking boost end-to-end", () => {
    const boosted = seedIsolatedRun();
    const withBoost = spawnCli(["search", "widget", "--format=json", "--detail=full"], boosted.cwd, boosted.env);
    expect(withBoost.status).toBe(0);
    const boostedScore = targetScore(withBoost.stdout);

    const suppressed = seedIsolatedRun();
    const withoutBoost = spawnCli(
      ["search", "widget", "--no-project-context", "--format=json", "--detail=full"],
      suppressed.cwd,
      suppressed.env,
    );
    expect(withoutBoost.status).toBe(0);
    const suppressedScore = targetScore(withoutBoost.stdout);

    // Before the fix this assertion failed the other way: both runs produced
    // the IDENTICAL score because `--no-project-context` was a silent no-op
    // (citty's `--no-` prefix strip negated a name nothing declared).
    expect(boostedScore).toBeGreaterThan(suppressedScore);
  }, 30_000);

  test("--project-context (positive spelling) is still accepted and keeps the boost on", () => {
    const run = seedIsolatedRun();
    const result = spawnCli(
      ["search", "widget", "--project-context", "--format=json", "--detail=full"],
      run.cwd,
      run.env,
    );
    expect(result.status).toBe(0);
    expect(() => targetScore(result.stdout)).not.toThrow();
  }, 30_000);
});
