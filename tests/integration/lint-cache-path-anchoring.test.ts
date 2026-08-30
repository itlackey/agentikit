// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Regression coverage for the unanchored `/.cache/` / `/registry/` substring
 * check that used to gate lint's file-skip logic (`isCachedLintPath` in
 * `src/commands/lint/index.ts` and its two duplicates in
 * `src/core/adapter/adapters/akm-lint.ts`).
 *
 * That check tested whether the path STRING contained the literal text
 * `/.cache/` or `/registry/` anywhere at all — not whether the file actually
 * lived inside akm's own resolved registry-cache directories. Any bundle or
 * workspace that merely happened to sit under a directory named `.cache` (a
 * normal XDG `~/.cache/...` layout, many CI sandboxes) got zero workflow-lint
 * findings, silently.
 *
 * The fix (`isAkmRegistryCachePath` in `src/core/common.ts`) anchors the
 * exclusion to `getRegistryCacheDir()`/`getRegistryIndexCacheDir()` via
 * `isWithin` (realpath + containment), not a string search. These tests
 * pin both halves: a user path that merely CONTAINS `.cache`/`registry`
 * must lint normally, and a file genuinely inside the resolved registry
 * cache must still be skipped.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmLint } from "../../src/commands/lint/index";
import { workflowFrontendDiagnostics } from "../../src/core/adapter/adapters/akm-lint";
import { makeSandboxDir, sandboxEnvDir } from "../_helpers/sandbox";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const BROKEN_WORKFLOW = ["---", "type: workflow", "description: Broken", "---", ""].join("\n");

function writeWorkflowFile(stashDir: string, name: string, content: string): string {
  const workflowsDir = path.join(stashDir, "workflows");
  fs.mkdirSync(workflowsDir, { recursive: true });
  const filePath = path.join(workflowsDir, name);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

describe("lint cache-path anchoring (issue: unanchored /.cache/ /registry/ substring)", () => {
  test("a stash rooted under a path merely CONTAINING '.cache' still gets workflow-lint findings", async () => {
    const { dir: base, cleanup } = makeSandboxDir("akm-lint-cachepath");
    cleanups.push(cleanup);
    // Nest the real stash root under a directory literally named `.cache`,
    // regardless of where the process TMPDIR points — this reproduces the
    // "XDG_CACHE_HOME-style path" shape the audit flagged, independent of
    // the test runner's own TMPDIR.
    const stashDir = path.join(base, "nested", ".cache", "my-project");
    fs.mkdirSync(stashDir, { recursive: true });

    writeWorkflowFile(stashDir, "broken.md", BROKEN_WORKFLOW);

    const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });

    const structural = result.flagged.filter((i) => i.issue === "invalid-workflow-structure");
    expect(structural).toHaveLength(1);
    expect(structural[0]?.file).toContain("broken.md");
  });

  test("a stash rooted under a path merely CONTAINING 'registry' still gets workflow-lint findings", async () => {
    const { dir: base, cleanup } = makeSandboxDir("akm-lint-registrypath");
    cleanups.push(cleanup);
    const stashDir = path.join(base, "registry", "my-project");
    fs.mkdirSync(stashDir, { recursive: true });

    writeWorkflowFile(stashDir, "broken.md", BROKEN_WORKFLOW);

    const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });

    const structural = result.flagged.filter((i) => i.issue === "invalid-workflow-structure");
    expect(structural).toHaveLength(1);
    expect(structural[0]?.file).toContain("broken.md");
  });

  test("a file genuinely inside the resolved registry cache dir is still skipped by workflowFrontendDiagnostics", () => {
    const { dir: cacheDir, cleanup } = sandboxEnvDir("akm-real-cache-", "AKM_CACHE_DIR");
    cleanups.push(cleanup);

    const registryFile = path.join(cacheDir, "registry", "git-some-source", "workflows", "broken.md");
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    fs.writeFileSync(registryFile, BROKEN_WORKFLOW, "utf8");

    const result = workflowFrontendDiagnostics("workflows/broken.md", BROKEN_WORKFLOW, registryFile);

    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("a file genuinely inside the resolved registry-index cache dir is still skipped", () => {
    const { dir: cacheDir, cleanup } = sandboxEnvDir("akm-real-cache-idx-", "AKM_CACHE_DIR");
    cleanups.push(cleanup);

    const registryIndexFile = path.join(cacheDir, "registry-index", "git-abc123", "workflows", "broken.md");
    fs.mkdirSync(path.dirname(registryIndexFile), { recursive: true });
    fs.writeFileSync(registryIndexFile, BROKEN_WORKFLOW, "utf8");

    const result = workflowFrontendDiagnostics("workflows/broken.md", BROKEN_WORKFLOW, registryIndexFile);

    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("a real path under the OS temp dir's own '.cache'-shaped TMPDIR still lints (sanity, mirrors os.tmpdir())", async () => {
    // Belt-and-suspenders: exercise the actual os.tmpdir()-derived sandbox
    // helper too, not just a hand-built path, so this fails the same way the
    // full `bun test ... TMPDIR=.../.cache/...` repro from the audit does.
    const tmpBase = os.tmpdir();
    if (!tmpBase.includes(".cache")) return; // only meaningful when run under a .cache-shaped TMPDIR
    const { dir: stashDir, cleanup } = makeSandboxDir("akm-lint-realtmp");
    cleanups.push(cleanup);
    writeWorkflowFile(stashDir, "broken.md", BROKEN_WORKFLOW);

    const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });

    const structural = result.flagged.filter((i) => i.issue === "invalid-workflow-structure");
    expect(structural).toHaveLength(1);
  });
});
