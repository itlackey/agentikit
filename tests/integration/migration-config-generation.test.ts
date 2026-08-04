// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm migrate` auto-generating the 0.9 target config when no `--config` is
 * given (see `scripts/akm-migrate/config-migrate.ts`'s `describeGeneratedConfig`
 * / `writeGeneratedTargetConfig`, and `scripts/akm-migrate/migrate/legacy/
 * config-generate.ts`).
 *
 * Covers: the mechanical part (bundles/defaultBundle) is derived without
 * asking; the ambiguous part (profiles/defaults.llm/agent/improve) is dropped
 * and named, never guessed; the live 0.8 config.json is never touched until
 * `publishConfigLast`'s normal atomic install; `status`/`apply --dry-run`
 * never write anything; an explicit `--config` always wins and is never
 * second-guessed against an auto-generated file.
 */

import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getLegacyWorkflowDbPath } from "../../scripts/akm-migrate/migrate/legacy/legacy-paths";
import { getMigrationBackupRoot, getMigrationGeneratedConfigPath } from "../../scripts/akm-migrate/migration-backup";
import { getConfigPath, getStateDbPathInDataDir } from "../../src/core/paths";
import { openStateDbAtCeiling, PRE_CUTOVER_STATE_CEILING } from "../_fixtures/migration/seed-rows";
import { runCliCapture } from "../_helpers/cli";
import { openLegacyWorkflowDb } from "../_helpers/legacy-workflow-db";
import { withIsolatedAkmStorage } from "../_helpers/sandbox";

function seedLegacyInstall(storage: ReturnType<typeof withIsolatedAkmStorage>, extra: Record<string, unknown> = {}) {
  fs.writeFileSync(getConfigPath(), `${JSON.stringify({ stashDir: storage.stashDir, sources: [], ...extra })}\n`, {
    mode: 0o600,
  });
  openStateDbAtCeiling(getStateDbPathInDataDir(), PRE_CUTOVER_STATE_CEILING).close();
  openLegacyWorkflowDb(getLegacyWorkflowDbPath()).close();
}

test("migrate status previews generation without writing anything", async () => {
  const storage = withIsolatedAkmStorage();
  try {
    seedLegacyInstall(storage);
    const configBefore = fs.readFileSync(getConfigPath());
    const generatedPath = getMigrationGeneratedConfigPath();

    const status = await runCliCapture(["migrate", "status"]);
    expect(status.code).not.toBe(0); // still blocked — nothing generated yet
    const plan = JSON.parse(status.stdout) as {
      status: string;
      blockers: string[];
      generatedConfig?: { path: string; status: string; droppedKeys: string[] };
    };
    expect(plan.status).toBe("blocked");
    expect(plan.generatedConfig).toEqual({ path: generatedPath, status: "pending", droppedKeys: [] });
    expect(plan.blockers.some((b) => b.includes("akm migrate apply"))).toBe(true);

    expect(fs.existsSync(generatedPath)).toBe(false);
    expect(fs.readFileSync(getConfigPath())).toEqual(configBefore);

    // `apply --dry-run` performs the identical read-only checks.
    const dryRun = await runCliCapture(["migrate", "apply", "--dry-run"]);
    expect(dryRun.code).not.toBe(0);
    expect(JSON.parse(dryRun.stdout)).toEqual(plan);
    expect(fs.existsSync(generatedPath)).toBe(false);
  } finally {
    storage.cleanup();
  }
});

test("migrate apply with no --config writes a starter config and stops without mutating the live install", async () => {
  const storage = withIsolatedAkmStorage();
  try {
    seedLegacyInstall(storage);
    const configBefore = fs.readFileSync(getConfigPath());
    const stateBefore = fs.readFileSync(getStateDbPathInDataDir());
    const generatedPath = getMigrationGeneratedConfigPath();

    const applied = await runCliCapture(["migrate", "apply"]);
    expect(applied.code, applied.stderr).toBe(0);
    const plan = JSON.parse(applied.stdout) as {
      status: string;
      message?: string;
      generatedConfig?: { path: string; status: string; droppedKeys: string[] };
      backupPath?: string;
    };
    expect(plan.status).toBe("ready");
    expect(plan.generatedConfig).toEqual({ path: generatedPath, status: "written", droppedKeys: [] });
    expect(plan.message).toContain(generatedPath);
    expect(plan.message).toContain("re-run");
    expect(plan.backupPath).toBeUndefined();

    // The live 0.8 config.json and databases are byte-for-byte untouched.
    expect(fs.readFileSync(getConfigPath())).toEqual(configBefore);
    expect(fs.readFileSync(getStateDbPathInDataDir())).toEqual(stateBefore);

    // The generated file is a schema-shaped 0.9 config deriving bundles from
    // the 0.8 stashDir.
    expect(fs.existsSync(generatedPath)).toBe(true);
    const generated = JSON.parse(fs.readFileSync(generatedPath, "utf8")) as Record<string, unknown>;
    expect(generated.configVersion).toBe("0.9.0");
    expect(generated.stashDir).toBeUndefined();
    expect(generated.sources).toBeUndefined();
    const bundles = generated.bundles as Record<string, { path: string; writable?: boolean }>;
    expect(Object.keys(bundles)).toHaveLength(1);
    const [bundleId, bundle] = Object.entries(bundles)[0] as [string, { path: string; writable?: boolean }];
    expect(path.resolve(bundle.path)).toBe(path.resolve(storage.stashDir));
    expect(generated.defaultBundle).toBe(bundleId);

    // No backup run was created — nothing actually mutated yet. (The
    // migration-operation directory itself now exists — it holds the
    // generated config file — but no backup RUN subdirectory does.)
    const backupRuns = fs.existsSync(getMigrationBackupRoot())
      ? fs
          .readdirSync(getMigrationBackupRoot(), { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      : [];
    expect(backupRuns).toHaveLength(0);
  } finally {
    storage.cleanup();
  }
});

test("a second no-config apply picks up the generated file and completes the migration", async () => {
  const storage = withIsolatedAkmStorage();
  try {
    seedLegacyInstall(storage);

    const first = await runCliCapture(["migrate", "apply"]);
    expect(first.code, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ status: "ready" });

    const second = await runCliCapture(["migrate", "apply"]);
    expect(second.code, second.stderr).toBe(0);
    const result = JSON.parse(second.stdout) as { status: string; backupPath?: string };
    expect(result.status).toBe("current");
    expect(result.backupPath).toBeDefined();

    const config = JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as Record<string, unknown>;
    expect(config.configVersion).toBe("0.9.0");
    expect(config.bundles).toBeDefined();
    expect(config.stashDir).toBeUndefined();

    const status = await runCliCapture(["migrate", "status"]);
    expect(status.code, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ status: "current" });
  } finally {
    storage.cleanup();
  }
});

test("ambiguous profiles/defaults keys are dropped and named, never guessed, and apply still completes", async () => {
  const storage = withIsolatedAkmStorage();
  try {
    seedLegacyInstall(storage, {
      profiles: { agent: { fast: { platform: "opencode" } }, llm: { primary: { model: "x" } } },
      defaults: { agent: "fast", llm: "primary" },
    });

    const status = await runCliCapture(["migrate", "status"]);
    const plan = JSON.parse(status.stdout) as { generatedConfig?: { droppedKeys: string[] } };
    expect(new Set(plan.generatedConfig?.droppedKeys)).toEqual(
      new Set(["profiles.agent.fast", "profiles.llm.primary", "defaults.agent", "defaults.llm"]),
    );

    const first = await runCliCapture(["migrate", "apply"]);
    expect(first.code, first.stderr).toBe(0);
    const firstPlan = JSON.parse(first.stdout) as {
      generatedConfig?: { droppedKeys: string[] };
      message?: string;
    };
    expect(new Set(firstPlan.generatedConfig?.droppedKeys)).toEqual(
      new Set(["profiles.agent.fast", "profiles.llm.primary", "defaults.agent", "defaults.llm"]),
    );
    expect(firstPlan.message).toContain("profiles.agent.fast");
    expect(firstPlan.message).toContain("defaults.llm");

    const generated = JSON.parse(fs.readFileSync(getMigrationGeneratedConfigPath(), "utf8")) as Record<string, unknown>;
    expect(generated.profiles).toBeUndefined();
    expect(generated.defaults).toBeUndefined();

    // The engine-less generated config is still enough to complete the cutover.
    const second = await runCliCapture(["migrate", "apply"]);
    expect(second.code, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({ status: "current" });
  } finally {
    storage.cleanup();
  }
});

test("an explicit --config always wins and is never second-guessed against a generated file", async () => {
  const storage = withIsolatedAkmStorage();
  try {
    seedLegacyInstall(storage);
    const prepared = path.join(storage.root, "prepared.json");
    fs.writeFileSync(
      prepared,
      `${JSON.stringify({ configVersion: "0.9.0", stashDir: storage.stashDir, sources: [] })}\n`,
      { mode: 0o600 },
    );
    const generatedPath = getMigrationGeneratedConfigPath();

    const status = await runCliCapture(["migrate", "status", "--config", prepared]);
    expect(status.code, status.stderr).toBe(0);
    const plan = JSON.parse(status.stdout) as { targetConfig: { source: string }; generatedConfig?: unknown };
    expect(plan.targetConfig.source).toBe("prepared");
    expect(plan.generatedConfig).toBeUndefined();
    expect(fs.existsSync(generatedPath)).toBe(false);

    const applied = await runCliCapture(["migrate", "apply", "--config", prepared]);
    expect(applied.code, applied.stderr).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({ status: "current" });
    // Generation never fired — --config drove the whole cutover on its own.
    expect(fs.existsSync(generatedPath)).toBe(false);
  } finally {
    storage.cleanup();
  }
});
