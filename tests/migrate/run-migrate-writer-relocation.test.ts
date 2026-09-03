// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * itlackey/akm#890, MAJOR review fix: the writer-relocation migration step
 * must cover every LOCAL bundle configured, not only the default stash —
 * and must never reach out to the network to decide which bundles those are.
 *
 * Drives the real `runMigration` orchestrator (not `writer-relocation.ts`
 * directly) so the coverage is what `akm migrate status`/`apply` actually
 * do against a multi-bundle config.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runMigration } from "../../scripts/akm-migrate/run-migrate";
import { resetConfigCache } from "../../src/core/config/config";
import { getEvalCasesDir } from "../../src/core/paths";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let secondaryDir: string;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  resetConfigCache();
  secondaryDir = path.join(storage.root, "secondary-bundle");
  fs.mkdirSync(secondaryDir, { recursive: true });
});

afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

/** Seed one old-location eval-case file so the bundle has relocation work pending. */
function seedOldEvalCase(bundleDir: string, name: string): void {
  const dir = path.join(bundleDir, ".akm", "eval-cases");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), "# Eval Case\n");
}

test("covers the default stash and every other local bundle, each exactly once", async () => {
  seedOldEvalCase(storage.stashDir, "primary-rejected.md");
  seedOldEvalCase(secondaryDir, "secondary-rejected.md");
  writeSandboxConfig({
    defaultBundle: "primary",
    bundles: {
      primary: { path: storage.stashDir },
      secondary: { path: secondaryDir },
    },
  });

  const plan = await runMigration({ apply: true });

  expect(plan.writerRelocation && "relocated" in plan.writerRelocation).toBe(true);
  const relocated = (plan.writerRelocation as { relocated: Record<string, unknown> }).relocated;
  expect(Object.keys(relocated).sort()).toEqual(["primary", "secondary"]);

  // Both bundles' old-location files actually moved to their OWN
  // stash-scoped $STATE directory, not a shared or mixed-up one.
  expect(fs.readdirSync(getEvalCasesDir(storage.stashDir))).toEqual(["primary-rejected.md"]);
  expect(fs.readdirSync(getEvalCasesDir(secondaryDir))).toEqual(["secondary-rejected.md"]);
  expect(fs.existsSync(path.join(storage.stashDir, ".akm", "eval-cases"))).toBe(false);
  expect(fs.existsSync(path.join(secondaryDir, ".akm", "eval-cases"))).toBe(false);
});

test("a git-sourced bundle is skipped, with no network access and no entry in the plan", async () => {
  seedOldEvalCase(storage.stashDir, "primary-rejected.md");
  writeSandboxConfig({
    defaultBundle: "primary",
    bundles: {
      primary: { path: storage.stashDir },
      // `.invalid` is reserved by RFC 2606 — guaranteed to never resolve.
      // If anything here tried a real network call it would hang or throw;
      // this test's own default timeout is the proof it never did.
      remote: { git: "https://example.invalid/some/repo.git" },
    },
  });

  const plan = await runMigration({ apply: true });

  const relocated = (plan.writerRelocation as { relocated: Record<string, unknown> }).relocated;
  expect(Object.keys(relocated)).toEqual(["primary"]);
  expect(relocated.remote).toBeUndefined();
});

test("status / apply --dry-run reports both local bundles' pending work without moving anything", async () => {
  seedOldEvalCase(storage.stashDir, "primary-rejected.md");
  seedOldEvalCase(secondaryDir, "secondary-rejected.md");
  writeSandboxConfig({
    defaultBundle: "primary",
    bundles: {
      primary: { path: storage.stashDir },
      secondary: { path: secondaryDir },
    },
  });

  const plan = await runMigration({ apply: false });

  expect(plan.writerRelocation && "pending" in plan.writerRelocation).toBe(true);
  const pending = (plan.writerRelocation as { pending: Record<string, { directories: unknown[] }> }).pending;
  expect(Object.keys(pending).sort()).toEqual(["primary", "secondary"]);
  expect(pending.primary?.directories.length).toBeGreaterThan(0);
  expect(pending.secondary?.directories.length).toBeGreaterThan(0);

  // Nothing moved — the old files are still exactly where they were.
  expect(fs.existsSync(path.join(storage.stashDir, ".akm", "eval-cases", "primary-rejected.md"))).toBe(true);
  expect(fs.existsSync(path.join(secondaryDir, ".akm", "eval-cases", "secondary-rejected.md"))).toBe(true);
});
