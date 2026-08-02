// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS6 characterization test for the `akm search` / `akm curate` / `akm show`
 * command family. Pins the full JSON envelope (stdout payload shape + the
 * {ok:false,code} error envelope on stderr / exit code) for representative
 * invocations, proving the extraction of the cluster from cli.ts into
 * src/commands/search-cli.ts and the migration of the leaf handlers onto
 * `defineJsonCommand` is byte-identical. The three commands share the private
 * `resolveEventSource` helper and the `parseScopeFilterFlags`/`parseSearchSource`
 * parsers, which moved with the cluster. The CLI reads an isolated, freshly
 * indexed stash through AKM_BUNDLE_DIR via the in-process harness.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { resetConfigCache, saveConfig } from "../../../src/core/config/config";
import { akmIndex } from "../../../src/indexer/indexer";
import { runCliCapture } from "../../_helpers/cli";
import {
  type Cleanup,
  makeStashDir,
  type SandboxedDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
  withEnv,
} from "../../_helpers/sandbox";

const disposers: SandboxedDir[] = [];

async function runCli(args: string[], stashDir: string): Promise<{ stdout: string; stderr: string; status: number }> {
  return withEnv({ AKM_BUNDLE_DIR: stashDir }, async () => {
    resetConfigCache();
    const res = await runCliCapture(args);
    return { stdout: res.stdout, stderr: res.stderr, status: res.code };
  });
}

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const dataResult = sandboxXdgDataHome(cfgResult.cleanup);
  envCleanup = dataResult.cleanup;
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
  for (const d of disposers.splice(0)) d.cleanup();
});

async function makeIndexedStash(): Promise<string> {
  const sandbox = makeStashDir();
  disposers.push(sandbox);
  const stash = sandbox.dir;
  fs.mkdirSync(path.join(stash, "skills", "deploy-widgets"), { recursive: true });
  fs.writeFileSync(
    path.join(stash, "skills", "deploy-widgets", "SKILL.md"),
    "---\ndescription: deploy widgets uniformly\ntags:\n  - deploy\nquality: curated\n---\n# Deploy widgets\n",
  );
  await withEnv({ AKM_BUNDLE_DIR: stash }, async () => {
    resetConfigCache();
    saveConfig({ semanticSearchMode: "off" });
    await akmIndex({ stashDir: stash, full: true });
  });
  return stash;
}

describe("akm search/curate/show — JSON envelope snapshot (WS6)", () => {
  test("search: indexed stash → success envelope with hits array", async () => {
    const stash = await makeIndexedStash();
    const { stdout, status } = await runCli(["search", "deploy"], stash);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(Array.isArray(env.hits)).toBe(true);
    expect((env.hits as Array<{ name: string }>).map((h) => h.name)).toContain("deploy-widgets");
  });

  // F1/A1 — was "search --no-project-context does not mutate process env",
  // which only asserted the flag left two env vars alone (env vars that are
  // dead code — never read anywhere in src/ — so that assertion passed
  // trivially and proved nothing). The actual bug: citty strips a leading
  // `--no-` from ANY token and negates the remainder BEFORE consulting the
  // declared-args table, so a flag DECLARED as `no-project-context` can never
  // be negated by `--no-project-context` — it parsed as "negate
  // `project-context`", a name nothing declared, leaving the real key at its
  // default `false` forever. This test pins REAL suppression instead: it
  // seeds a hit tagged with this repo's own project-context token ("akm",
  // derived from `package.json`'s `name: "akm-cli"` after the `-cli` suffix
  // strip — this in-process harness's `process.cwd()` IS the repo, so no
  // `process.chdir()`/subprocess is needed) and asserts the boosted score
  // (`--detail full` is required for `score` to appear in the payload)
  // strictly decreases when `--no-project-context` is passed. A broader,
  // fully isolated (fake project dir, real subprocess) end-to-end version of
  // this same regression lives in
  // tests/integration/commands/search-project-context.test.ts.
  test("search --no-project-context measurably suppresses the project-context ranking boost", async () => {
    const sandbox = makeStashDir();
    disposers.push(sandbox);
    const stash = sandbox.dir;
    // `widget-master`: a strong keyword match for "widget" (repeats the
    // term), establishing a bm25 range so FTS-score normalization is not the
    // degenerate single-top-hit "worst==best -> 1.0" case.
    fs.mkdirSync(path.join(stash, "skills", "widget-master"), { recursive: true });
    fs.writeFileSync(
      path.join(stash, "skills", "widget-master", "SKILL.md"),
      "---\ndescription: Widget widget widget master control tool for managing every widget\ntags:\n  - widget\nquality: curated\n---\n# Widget master\nManage widget widget widget fleets from one place.\n",
    );
    // `widget-note`: the TARGET, a weaker keyword match tagged with this
    // repo's own project-context token ("akm", derived from `package.json`'s
    // `name: "akm-cli"` after the `-cli` suffix strip — this in-process
    // harness's `process.cwd()` IS the repo, so no `process.chdir()`/
    // subprocess is needed to exercise a real project-context match).
    fs.mkdirSync(path.join(stash, "skills", "widget-note"), { recursive: true });
    fs.writeFileSync(
      path.join(stash, "skills", "widget-note", "SKILL.md"),
      "---\ndescription: widget helper note\ntags:\n  - akm\nquality: curated\n---\n# Widget note\n",
    );
    await withEnv({ AKM_BUNDLE_DIR: stash }, async () => {
      resetConfigCache();
      saveConfig({ semanticSearchMode: "off" });
      await akmIndex({ stashDir: stash, full: true });
    });

    // `--detail full` is required for `score` to appear in the payload at
    // all (the default `brief` detail omits it).
    const withBoost = await runCli(["search", "widget", "--detail=full"], stash);
    expect(withBoost.status).toBe(0);
    const boostedHit = (JSON.parse(withBoost.stdout).hits as Array<{ name: string; score: number }>).find(
      (h) => h.name === "widget-note",
    );
    expect(boostedHit).toBeDefined();

    const suppressed = await runCli(["search", "widget", "--detail=full", "--no-project-context"], stash);
    expect(suppressed.status).toBe(0);
    const suppressedHit = (JSON.parse(suppressed.stdout).hits as Array<{ name: string; score: number }>).find(
      (h) => h.name === "widget-note",
    );
    expect(suppressedHit).toBeDefined();

    // Before the fix this failed the other way: identical scores in both
    // runs, because `--no-project-context` never reached `disableProjectContext`.
    expect(boostedHit?.score).toBeGreaterThan(suppressedHit?.score ?? Number.POSITIVE_INFINITY);
  });

  test("search: missing query → JSON envelope with hits array (F5/R-009: bare query browses, per --help's own contract)", async () => {
    const stash = await makeIndexedStash();
    // R-009 orchestrator ruling: `search --help` documents "QUERY  Search
    // query (omit to list all assets)" — a bare `akm search` must honor that
    // contract and browse (subject to the normal limit), not reject with
    // MISSING_REQUIRED_ARGUMENT. `akmSearch()` itself already tolerated `""`
    // fine; the rejection was a CLI-layer-only guard in search-cli.ts.
    const { stdout, status } = await runCli(["search"], stash);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(Array.isArray(env.hits)).toBe(true);
    expect((env.hits as Array<{ name: string }>).map((h) => h.name)).toContain("deploy-widgets");
  });

  test("curate: indexed stash → success envelope with shape 'curate'", async () => {
    const stash = await makeIndexedStash();
    const { stdout, status } = await runCli(["curate", "deploy widgets"], stash);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.shape).toBe("curate");
  });

  test("curate: missing query → byte-identical {ok:false} usage envelope on stderr", async () => {
    const stash = await makeIndexedStash();
    const { stderr, status } = await runCli(["curate"], stash);
    expect(status).toBe(2);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("MISSING_REQUIRED_ARGUMENT");
  });

  test("show: known ref → success envelope with the asset payload", async () => {
    const stash = await makeIndexedStash();
    const { stdout, status } = await runCli(["show", "skills/deploy-widgets"], stash);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.type).toBe("skill");
    expect(env.name).toBe("deploy-widgets");
    expect(typeof env.content).toBe("string");
  });

  test("show: unknown ref → byte-identical {ok:false} not-found envelope on stderr", async () => {
    const stash = await makeIndexedStash();
    const { stderr, status } = await runCli(["show", "skills/does-not-exist"], stash);
    expect(status).toBe(1);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("ASSET_NOT_FOUND");
  });
});
