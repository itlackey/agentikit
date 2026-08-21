// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-8.2 — end-to-end coverage of the three-DB cutover, driven through the real
 * `migrate apply` flow (never the cutover module in isolation). Five scenarios:
 *   (a) rc-train FROM-state round-trip — workflow.db merged, usage_events
 *       rescued, live refs re-keyed to their item_refs, workflow.db gone,
 *       index.db quarantined, ledger at 020;
 *   (b) orphan-bearing state completes WITH quarantine (never aborts);
 *   (c) fresh install — no workflow.db/index.db, records complete, no ATTACH
 *       ever CREATEs a stray file;
 *   (d) idempotency — a second migrate apply is a no-op;
 *   (e) fail-closed — an injected unparseable ref restores the pre-state.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { cutoverStashRootsFromConfig } from "../../scripts/akm-migrate/config-migrate";
import { deriveLegacyBundleIds } from "../../scripts/akm-migrate/migrate/legacy/bundle-id";
import {
  type ContentMigrationReport,
  runContentMigration,
} from "../../scripts/akm-migrate/migrate/legacy/content-migration";
import { getLegacyWorkflowDbPath } from "../../scripts/akm-migrate/migrate/legacy/legacy-paths";
import { writeLegacyStashFile } from "../../scripts/akm-migrate/migrate/legacy/legacy-stash-json";
import { importLegacyProposalsIntoState } from "../../scripts/akm-migrate/migrate/legacy/proposal-fs-import";
import {
  buildCutoverRefMap,
  deleteWorkflowDb,
  migratePilotTreatmentFiles,
  quarantineIndexDb,
  repairAlreadyCurrentProposalRefs,
} from "../../scripts/akm-migrate/migrate/legacy/three-db-cutover";
import { getMigrationApplyJournalPath, restoreMigrationBackup } from "../../scripts/akm-migrate/migration-backup";
import { createProposal } from "../../src/commands/proposal/repository";
import { parseFrontmatter } from "../../src/core/asset/frontmatter";
import { deriveBundleIds } from "../../src/core/bundle-id";
import type { AkmConfig } from "../../src/core/config/config";
import { getMigrationOperationRoot } from "../../src/core/migration-operation";
import { getConfigPath, getDataDir, getDbPath, getLockfilePath, getStateDbPathInDataDir } from "../../src/core/paths";
import { STATE_MIGRATIONS } from "../../src/core/state/migrations";
import { openStateDatabase } from "../../src/core/state-db";
import { deriveEntryProvenance, deriveInstallations, slugForPath } from "../../src/indexer/installations";
import type { StashFile } from "../../src/indexer/passes/metadata";
import { openDatabaseFinalizing } from "../../src/storage/database";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { parseTaskV3Yaml } from "../../src/tasks/source-v3";
import {
  buildOrphanBearingStateDb,
  LIVE_CONTRAST_REFS,
  ORPHAN_REFS,
  USAGE_EVENT_ORPHAN_REF,
} from "../_fixtures/migration/orphan-state";
import {
  buildRcTrainFromState,
  RC_TRAIN_LIVE_REFS,
  rcTrainFromStatePaths,
} from "../_fixtures/migration/rc-train-state";
import {
  insertAssetSalienceRow,
  openStateDbAtCeiling,
  PRE_CUTOVER_STATE_CEILING,
} from "../_fixtures/migration/seed-rows";
import { runCliCapture } from "../_helpers/cli";
import {
  type Cleanup,
  sandboxHome,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
} from "../_helpers/sandbox";

let cleanup: Cleanup | undefined;

beforeEach(() => {
  const home = sandboxHome();
  const config = sandboxXdgConfigHome(home.cleanup);
  const cache = sandboxXdgCacheHome(config.cleanup);
  cleanup = sandboxXdgDataHome(cache.cleanup).cleanup;
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

const PRIMARY_BUNDLE = "primary";
/** item_ref a live entry is re-keyed onto (the durable `bundle//conceptId` form). */
const SKILL_ITEM_REF = `${PRIMARY_BUNDLE}//skills/all-types-skill`;
const MEMORY_ITEM_REF = `${PRIMARY_BUNDLE}//memories/all-types-memory`;

function retiredRef(type: string, name: string): string {
  return [type, name].join(":");
}

function writeConfigs(): string {
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.writeFileSync(getConfigPath(), `${JSON.stringify({ configVersion: "0.8.0" })}\n`, { mode: 0o600 });
  const prepared = path.join(path.dirname(getConfigPath()), "prepared-0.9.json");
  // WI-8.4: the prepared 0.9 config still carries the pre-cutover source shape
  // (stashDir primary + a named source + an installed entry). The config-applied
  // phase auto-translates it to `bundles`/`defaultBundle` and removes the old
  // keys (asserted in scenario (a)).
  fs.writeFileSync(
    prepared,
    `${JSON.stringify({
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      stashDir: path.join(getDataDir(), "stash"),
      sources: [{ type: "filesystem", path: path.join(getDataDir(), "team"), name: "team", writable: true }],
      installed: [{ id: "reg-kit", source: "npm", ref: "@scope/kit", stashRoot: path.join(getDataDir(), "kit") }],
    })}\n`,
  );
  return prepared;
}

/**
 * Seed a last-good index.db with `entries` (mapping each live legacy ref to its
 * item_ref) and durable `usage_events` (a legacy row that must re-key + a
 * bundle-grammar row carried as-is). The cutover reads it read-only via ATTACH.
 */
function seedOldIndexDb(): void {
  const stashRoot = path.join(getDataDir(), "stash");
  const idx = new Database(getDbPath());
  idx.exec(
    `CREATE TABLE entries (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       entry_key TEXT NOT NULL,
       item_ref  TEXT,
       entry_type TEXT NOT NULL,
       stash_dir TEXT NOT NULL
     );
     CREATE TABLE usage_events (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       event_type TEXT NOT NULL,
       query TEXT,
       entry_id INTEGER,
       entry_ref TEXT,
       signal TEXT,
       metadata TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     );`,
  );
  const insEntry = idx.prepare("INSERT INTO entries (entry_key, item_ref, entry_type, stash_dir) VALUES (?, ?, ?, ?)");
  insEntry.run(RC_TRAIN_LIVE_REFS.skill, SKILL_ITEM_REF, "skill", stashRoot);
  insEntry.run(RC_TRAIN_LIVE_REFS.memory, MEMORY_ITEM_REF, "memory", stashRoot);
  // Pre-provenance schema: these rows must migrate as unattributed, never user.
  const insUsage = idx.prepare("INSERT INTO usage_events (event_type, entry_ref) VALUES (?, ?)");
  insUsage.run("show", RC_TRAIN_LIVE_REFS.skill); // legacy → re-keyed to SKILL_ITEM_REF
  insUsage.run("show", SKILL_ITEM_REF); // already bundle grammar → carried as-is
  insUsage.run("feedback", USAGE_EVENT_ORPHAN_REF); // orphan legacy → kept + audited
  idx.close();
}

/** Seed a workflow_run + step + unit into workflow.db so the merge has real rows to carry. */
function seedWorkflowRun(): void {
  const wf = new Database(getLegacyWorkflowDbPath());
  wf.prepare(
    `INSERT INTO workflow_runs (id, workflow_ref, workflow_title, status, params_json, created_at, updated_at)
     VALUES ('run-1', 'workflows/ship', 'Ship it', 'active', '{}', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')`,
  ).run();
  wf.prepare(
    `INSERT INTO workflow_run_steps (run_id, step_id, step_title, instructions, sequence_index, status)
     VALUES ('run-1', 'step-1', 'First', 'do it', 0, 'pending')`,
  ).run();
  wf.prepare(
    `INSERT INTO workflow_run_units (run_id, unit_id, node_id, status) VALUES ('run-1', 'unit-1', 'node-a', 'pending')`,
  ).run();
  wf.close();
}

function readState(): Database {
  return new Database(getStateDbPathInDataDir(), { readonly: true });
}

function refsIn(db: Database, table: string, keyColumn: string): string[] {
  return (db.query(`SELECT ${keyColumn} AS k FROM ${table} ORDER BY ${keyColumn}`).all() as Array<{ k: string }>).map(
    (r) => r.k,
  );
}

function ledgerIds(db: Database): string[] {
  return (db.query("SELECT id FROM schema_migrations ORDER BY rowid").all() as Array<{ id: string }>).map((r) => r.id);
}

/**
 * `akm migrate apply`'s final result line is now rendered through the normal
 * `--format` pipeline (pretty-printed JSON by default, D7), so it can span
 * multiple lines — unlike the raw child's single compact line before that
 * change. Any earlier progress-event lines (content migration, proposal-ref
 * repair) stay single-line JSON and print ahead of it, so the result is
 * always the trailing block starting at the last line beginning with `{`.
 */
function backupRunIdFromApply(stdout: string): string {
  const lines = stdout.trim().split("\n");
  let resultStart = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i]?.startsWith("{")) {
      resultStart = i;
      break;
    }
  }
  const runId =
    resultStart >= 0
      ? (JSON.parse(lines.slice(resultStart).join("\n")) as { backupRunId?: unknown }).backupRunId
      : undefined;
  if (typeof runId !== "string") throw new Error("Migration apply did not report its backup run ID.");
  return runId;
}

function seedSalienceRef(assetRef: string): void {
  const state = openStateDbAtCeiling(getStateDbPathInDataDir(), PRE_CUTOVER_STATE_CEILING);
  state.prepare("INSERT INTO asset_salience (asset_ref) VALUES (?)").run(assetRef);
  state.close();
}

test("cutover ref map tolerates a pre-provenance index without item_ref", () => {
  fs.mkdirSync(path.dirname(getDbPath()), { recursive: true });
  const index = new Database(getDbPath());
  index.exec(`
    CREATE TABLE entries (
      id INTEGER PRIMARY KEY,
      entry_key TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      stash_dir TEXT NOT NULL
    )
  `);
  index.close();

  const mapPath = path.join(getDataDir(), "cutover-ref-map.json");
  const refMap = buildCutoverRefMap({ oldIndexDbPath: getDbPath(), mapOutputPath: mapPath });

  expect(refMap.size).toBe(0);
  expect(fs.existsSync(mapPath)).toBe(true);
});

test("cutover ref map rekeys pre-reservation bundle ids to their configured owners", () => {
  const primaryRoot = path.join(getDataDir(), "stash");
  const secondaryRoot = path.join(getDataDir(), "team");
  fs.mkdirSync(path.join(primaryRoot, "knowledge"), { recursive: true });
  fs.mkdirSync(path.join(secondaryRoot, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(primaryRoot, "knowledge", "primary.md"), "# Primary\n");
  fs.writeFileSync(path.join(secondaryRoot, "knowledge", "secondary.md"), "# Secondary\n");

  const sources = [{ path: primaryRoot }, { path: secondaryRoot, registryId: "stash" }];
  const legacyIds = deriveLegacyBundleIds(sources);
  const configuredIds = deriveBundleIds(sources);
  expect(legacyIds[0]).toBe("stash");
  expect(configuredIds[1]).toBe("stash");

  const oldIndexPath = path.join(getDataDir(), "collision-index.db");
  const index = new Database(oldIndexPath);
  index.exec("CREATE TABLE entries (entry_key TEXT NOT NULL, item_ref TEXT, entry_type TEXT, stash_dir TEXT NOT NULL)");
  const insert = index.prepare("INSERT INTO entries (entry_key, item_ref, entry_type, stash_dir) VALUES (?, ?, ?, ?)");
  const oldPrimaryRef = `${legacyIds[0]}//knowledge/primary`;
  const oldSecondaryRef = `${legacyIds[1]}//knowledge/secondary`;
  const newPrimaryRef = `${configuredIds[0]}//knowledge/primary`;
  const newSecondaryRef = `${configuredIds[1]}//knowledge/secondary`;
  insert.run(["knowledge", "primary"].join(":"), oldPrimaryRef, "knowledge", primaryRoot);
  insert.run(`${legacyIds[1]}//${["knowledge", "secondary"].join(":")}`, oldSecondaryRef, "knowledge", secondaryRoot);
  index.close();

  const roots = [
    {
      path: primaryRoot,
      bundleId: configuredIds[0],
      legacyBundleId: legacyIds[0],
      registryId: configuredIds[0],
      primary: true,
    },
    {
      path: secondaryRoot,
      bundleId: configuredIds[1],
      legacyBundleId: legacyIds[1],
      registryId: configuredIds[1],
    },
  ];
  const indexedMap = buildCutoverRefMap({
    oldIndexDbPath: oldIndexPath,
    stashRoots: roots,
    mapOutputPath: path.join(getDataDir(), "collision-ref-map.json"),
  });
  expect(indexedMap.get(oldPrimaryRef)).toBe(newPrimaryRef);
  expect(indexedMap.get(oldSecondaryRef)).toBe(newSecondaryRef);

  const walkedMap = buildCutoverRefMap({
    oldIndexDbPath: path.join(getDataDir(), "missing-collision-index.db"),
    stashRoots: roots,
    mapOutputPath: path.join(getDataDir(), "collision-walk-ref-map.json"),
  });
  expect(walkedMap.get(oldPrimaryRef)).toBe(newPrimaryRef);
  expect(walkedMap.get(oldSecondaryRef)).toBe(newSecondaryRef);
});

test("rebuilds the cutover ref map after restore when the bundle id changes", async () => {
  const stash = path.join(getDataDir(), "stash");
  const knowledgeDir = path.join(stash, "knowledge");
  const legacyRef = retiredRef("knowledge", "bundle-owner");
  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.writeFileSync(path.join(knowledgeDir, "bundle-owner.md"), "# Bundle owner\n");
  seedSalienceRef(legacyRef);
  const prepared = writeConfigs();

  const first = await runCliCapture(["migrate", "apply", "--config", prepared]);
  expect(first.code, first.stderr).toBe(0);
  const firstState = readState();
  try {
    expect(refsIn(firstState, "asset_salience", "asset_ref")).toEqual(["stash//knowledge/bundle-owner"]);
  } finally {
    firstState.close();
  }

  restoreMigrationBackup(true, backupRunIdFromApply(first.stdout));
  fs.writeFileSync(
    prepared,
    `${JSON.stringify({
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      bundles: { primary: { path: stash, writable: true } },
      defaultBundle: "primary",
    })}\n`,
    { mode: 0o600 },
  );

  const reapplied = await runCliCapture(["migrate", "apply", "--config", prepared]);
  expect(reapplied.code, reapplied.stderr).toBe(0);
  const finalState = readState();
  try {
    expect(refsIn(finalState, "asset_salience", "asset_ref")).toEqual(["primary//knowledge/bundle-owner"]);
  } finally {
    finalState.close();
  }
}, 30_000);

test("cutover legacy-id inference reserves non-materialized configured bundles", () => {
  const primaryRoot = path.join(getDataDir(), "stash");
  const websitePath = path.join(getDataDir(), "website-cache-placeholder");
  fs.mkdirSync(primaryRoot, { recursive: true });
  const legacySources = [{ path: primaryRoot }, { path: websitePath, registryId: "stash" }];
  const [primaryId] = deriveBundleIds(legacySources);
  const config = {
    bundles: {
      [primaryId as string]: { path: primaryRoot, writable: true },
      stash: { website: "https://example.test/non-materialized" },
    },
    defaultBundle: primaryId,
  } as unknown as AkmConfig;

  expect(cutoverStashRootsFromConfig(config, [], legacySources)).toContainEqual(
    expect.objectContaining({ path: primaryRoot, bundleId: primaryId, legacyBundleId: "stash" }),
  );
});

test("cutover uses the old provider path when a non-materialized source consumed an id first", () => {
  const websitePath = path.join(getDataDir(), "provider", "stash");
  const teamRoot = path.join(getDataDir(), "team");
  fs.mkdirSync(teamRoot, { recursive: true });
  const legacySources = [{ path: websitePath }, { path: teamRoot, registryId: "stash" }];
  const currentIds = deriveBundleIds(legacySources);
  const legacyIds = deriveLegacyBundleIds(legacySources);
  const config = {
    bundles: {
      [currentIds[0] as string]: { website: "https://example.test/stash" },
      [currentIds[1] as string]: { path: teamRoot, writable: true },
    },
    defaultBundle: currentIds[1],
  } as unknown as AkmConfig;

  expect(cutoverStashRootsFromConfig(config, [], legacySources)).toContainEqual(
    expect.objectContaining({
      path: teamRoot,
      bundleId: currentIds[1],
      legacyBundleId: legacyIds[1],
    }),
  );
});

test("cutover consumes resolved lock metadata only for the matching desired identity", () => {
  const localRoot = path.join(getDataDir(), "resolved-package");
  const config = {
    bundles: { package: { npm: "@example/package@1" } },
    defaultBundle: "package",
  } as unknown as AkmConfig;
  const matching = { id: "package", source: "npm" as const, ref: "@example/package@1", localRoot };
  const stale = { ...matching, ref: "@example/other@1" };

  expect(cutoverStashRootsFromConfig(config, [matching])).toContainEqual(
    expect.objectContaining({ path: localRoot, bundleId: "package" }),
  );
  expect(cutoverStashRootsFromConfig(config, [stale])).toEqual([]);
});

test("cutover matches persisted github locators to migrated git bundle URLs", () => {
  const localRoot = path.join(getDataDir(), "resolved-github-package");
  const config = {
    bundles: { package: { git: "https://github.com/owner/repo/tree/v1" } },
    defaultBundle: "package",
  } as unknown as AkmConfig;

  for (const source of ["github", "git"] as const) {
    const lock = { id: "package", source, ref: "github:owner/repo#v1", localRoot };
    expect(cutoverStashRootsFromConfig(config, [lock])).toContainEqual(
      expect.objectContaining({ path: localRoot, bundleId: "package" }),
    );
  }
});

function seedInstalledBundleMigration(): { prepared: string; installedRoot: string; oldRef: string; itemRef: string } {
  const installedRoot = path.join(getDataDir(), "installed-owner-repo");
  fs.mkdirSync(path.join(installedRoot, "skills", "deploy"), { recursive: true });
  fs.writeFileSync(path.join(installedRoot, "skills", "deploy", "SKILL.md"), "# Deploy\n");
  const legacySkillRef = ["skill", "deploy"].join(":");
  const oldRef = `github:owner/repo//${legacySkillRef}`;
  const itemRef = "installed-owner-repo//skills/deploy";

  const installed = [
    {
      id: "github:owner/repo",
      source: "github",
      ref: "owner/repo",
      artifactUrl: "https://github.com/owner/repo",
      stashRoot: installedRoot,
      cacheDir: path.dirname(installedRoot),
      installedAt: "2026-01-01T00:00:00.000Z",
    },
  ];
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.writeFileSync(getConfigPath(), `${JSON.stringify({ configVersion: "0.8.0", installed })}\n`, { mode: 0o600 });
  const prepared = path.join(path.dirname(getConfigPath()), "prepared-installed-0.9.json");
  fs.writeFileSync(
    prepared,
    `${JSON.stringify({
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      installed,
    })}\n`,
    { mode: 0o600 },
  );
  return { prepared, installedRoot, oldRef, itemRef };
}

test("a real v17 index preserves installed-bundle durable state", async () => {
  const { prepared, installedRoot, oldRef, itemRef } = seedInstalledBundleMigration();
  const primaryRoot = path.join(getDataDir(), "primary-with-same-ref");
  fs.mkdirSync(path.join(primaryRoot, "skills", "deploy"), { recursive: true });
  fs.writeFileSync(path.join(primaryRoot, "skills", "deploy", "SKILL.md"), "# Primary deploy\n");
  const preparedConfig = JSON.parse(fs.readFileSync(prepared, "utf8"));
  preparedConfig.stashDir = primaryRoot;
  fs.writeFileSync(prepared, `${JSON.stringify(preparedConfig)}\n`, { mode: 0o600 });
  const state = openStateDbAtCeiling(getStateDbPathInDataDir(), PRE_CUTOVER_STATE_CEILING);
  state
    .prepare(
      "INSERT INTO asset_outcome(asset_ref, retrieval_count, outcome_score, updated_at) VALUES (?, 17, 0.75, 42)",
    )
    .run(oldRef);
  state.close();

  const index = new Database(getDbPath());
  index.exec(`
    CREATE TABLE entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_key TEXT NOT NULL UNIQUE,
      file_path TEXT NOT NULL,
      stash_dir TEXT NOT NULL,
      entry_json TEXT NOT NULL,
      search_text TEXT NOT NULL,
      entry_type TEXT NOT NULL
    )
  `);
  index
    .prepare(
      "INSERT INTO entries(entry_key, file_path, stash_dir, entry_json, search_text, entry_type) VALUES (?, ?, ?, '{}', '', 'skill')",
    )
    .run(
      `${installedRoot}:${["skill", "deploy"].join(":")}`,
      path.join(installedRoot, "skills", "deploy", "SKILL.md"),
      installedRoot,
    );
  index.close();

  const applied = await runCliCapture(["migrate", "apply", "--config", prepared]);
  expect(applied.code, applied.stderr).toBe(0);

  const migrated = readState();
  try {
    expect(
      migrated.query("SELECT asset_ref, retrieval_count, outcome_score, updated_at FROM asset_outcome").get(),
    ).toEqual({ asset_ref: itemRef, retrieval_count: 17, outcome_score: 0.75, updated_at: 42 });
    expect(migrated.query("SELECT * FROM legacy_state WHERE old_ref = ?").get(oldRef)).toBeNull();
  } finally {
    migrated.close();
  }
  expect(JSON.parse(fs.readFileSync(getLockfilePath(), "utf8"))).toEqual([
    { id: "installed-owner-repo", source: "github", ref: "owner/repo", localRoot: installedRoot },
  ]);
}, 30_000);

test("a malformed lockfile blocks before mutation", async () => {
  const { prepared, installedRoot } = seedInstalledBundleMigration();
  openStateDbAtCeiling(getStateDbPathInDataDir(), PRE_CUTOVER_STATE_CEILING).close();
  fs.mkdirSync(path.dirname(getLockfilePath()), { recursive: true });
  fs.writeFileSync(getLockfilePath(), "not a lockfile");

  const failed = await runCliCapture(["migrate", "apply", "--config", prepared]);
  expect(failed.code).not.toBe(0);
  expect(failed.stderr).toMatch(/Cannot merge migration lock entries/i);
  expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(false);
  expect(JSON.parse(fs.readFileSync(getConfigPath(), "utf8")).configVersion).toBe("0.8.0");
  expect(fs.readFileSync(getLockfilePath(), "utf8")).toBe("not a lockfile");

  fs.rmSync(getLockfilePath());
  const resumed = await runCliCapture(["migrate", "apply", "--config", prepared]);
  expect(resumed.code, resumed.stderr).toBe(0);
  expect(JSON.parse(fs.readFileSync(getLockfilePath(), "utf8"))).toEqual([
    { id: "installed-owner-repo", source: "github", ref: "owner/repo", localRoot: installedRoot },
  ]);
  expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(false);
}, 30_000);

test("relative pre-cutover roots resolve against the apply cwd", async () => {
  const initialCwd = path.join(getDataDir(), "migration-initial", "working");
  const resumeCwd = path.join(getDataDir(), "migration-resume", "deeper", "working");
  const relativeStash = path.join("..", "relative-stash");
  const stashRoot = path.resolve(initialCwd, relativeStash);
  const memoriesDir = path.join(stashRoot, "memories");
  const tasksDir = path.join(stashRoot, "tasks");
  const workflowsDir = path.join(stashRoot, "workflows");
  fs.mkdirSync(initialCwd, { recursive: true });
  fs.mkdirSync(memoriesDir, { recursive: true });
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(workflowsDir, { recursive: true });
  fs.mkdirSync(resumeCwd, { recursive: true });
  fs.writeFileSync(path.join(memoriesDir, "note.md"), "---\ndescription: Generated\n---\n\nBody.\n");
  writeLegacyStashFile(memoriesDir, {
    entries: [
      {
        name: "note",
        type: "memory",
        filename: "note.md",
        description: "Resolved from the original migration cwd",
      },
    ],
  });
  fs.writeFileSync(path.join(workflowsDir, "relative.md"), "# Relative workflow\n");
  const taskPath = path.join(tasksDir, "relative.yml");
  fs.writeFileSync(taskPath, `schedule: "@daily"\nworkflow: ${["workflow", "relative"].join(":")}\n`);

  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.writeFileSync(getConfigPath(), `${JSON.stringify({ configVersion: "0.8.0", stashDir: relativeStash })}\n`, {
    mode: 0o600,
  });
  const prepared = path.join(path.dirname(getConfigPath()), "prepared-relative-0.9.json");
  fs.writeFileSync(
    prepared,
    `${JSON.stringify({ configVersion: "0.9.0", semanticSearchMode: "off", stashDir: relativeStash })}\n`,
    { mode: 0o600 },
  );
  openStateDbAtCeiling(getStateDbPathInDataDir(), PRE_CUTOVER_STATE_CEILING).close();

  const cliPath = path.resolve(import.meta.dir, "../..", "src", "cli.ts");
  const applied = Bun.spawn([process.execPath, cliPath, "migrate", "apply", "--config", prepared], {
    cwd: initialCwd,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [applyCode, , applyStderr] = await Promise.all([
    applied.exited,
    new Response(applied.stdout).text(),
    new Response(applied.stderr).text(),
  ]);
  expect(applyCode, applyStderr).toBe(0);
  expect(fs.existsSync(path.join(memoriesDir, ".stash.json"))).toBe(false);
  expect(parseFrontmatter(fs.readFileSync(path.join(memoriesDir, "note.md"), "utf8")).data.description).toBe(
    "Resolved from the original migration cwd",
  );
  expect(parseTaskV3Yaml({ yaml: fs.readFileSync(taskPath, "utf8"), filePath: taskPath })).toMatchObject({
    version: 3,
    target: { kind: "uses", uses: { kind: "workflow", ref: "workflows/relative" } },
  });
  expect(fs.existsSync(path.join(resumeCwd, relativeStash))).toBe(false);
}, 30_000);

test("workflow deletion failures propagate so the boundary can be retried", () => {
  const workflowPath = path.join(getDataDir(), "delete-retry.db");
  fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
  fs.writeFileSync(workflowPath, "workflow");
  const originalRm = fs.rmSync;
  const rm = spyOn(fs, "rmSync").mockImplementation(((target: fs.PathLike, options?: fs.RmOptions) => {
    if (target === workflowPath) throw new Error("injected workflow unlink failure");
    return originalRm(target, options);
  }) as typeof fs.rmSync);
  expect(() => deleteWorkflowDb(workflowPath)).toThrow("injected workflow unlink failure");
  expect(fs.existsSync(workflowPath)).toBe(true);
  rm.mockRestore();
  expect(deleteWorkflowDb(workflowPath)).toEqual({ deleted: true });
  expect(fs.existsSync(workflowPath)).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// (a) rc-train FROM-state round-trip
// ─────────────────────────────────────────────────────────────────────────────

describe("WI-8.2 (a) — rc-train FROM-state round-trip", () => {
  test("merges workflow.db, rescues usage_events, re-keys live refs, quarantines index.db", async () => {
    buildRcTrainFromState(getDataDir());
    const { workflowDbPath } = rcTrainFromStatePaths(getDataDir());
    expect(fs.existsSync(workflowDbPath)).toBe(true);
    seedWorkflowRun();
    seedOldIndexDb();
    const treatmentFile = path.join(getDataDir(), "stash", ".akm", "measurement", "treatment-pilot-2026-06-14.txt");
    fs.mkdirSync(path.dirname(treatmentFile), { recursive: true });
    fs.writeFileSync(treatmentFile, `# pilot\n${RC_TRAIN_LIVE_REFS.skill}\n${MEMORY_ITEM_REF}\n`);
    const prepared = writeConfigs();

    const applied = await runCliCapture(["migrate", "apply", "--config", prepared]);
    expect(applied.code, applied.stderr).toBe(0);

    // Three DBs: workflow.db gone, index.db quarantined (rename), state.db is home.
    expect(fs.existsSync(getLegacyWorkflowDbPath())).toBe(false);
    expect(fs.existsSync(getDbPath())).toBe(false);
    const quarantined = fs.readdirSync(getDataDir()).filter((f) => f.startsWith("index.db.pre-cutover-"));
    expect(quarantined.length).toBe(1);

    // WI-8.4: the config emerged in the 0.9.0 bundles shape — old source keys
    // gone, bundles keyed by the derived ids, defaultBundle = the stashDir bundle.
    const appliedConfig = JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as Record<string, unknown>;
    expect(appliedConfig.stashDir).toBeUndefined();
    expect(appliedConfig.sources).toBeUndefined();
    expect(appliedConfig.installed).toBeUndefined();
    const appliedBundles = appliedConfig.bundles as Record<string, Record<string, unknown>>;
    // ids: stashDir slug "stash", the named source "team", the slug-legal
    // installed id "reg-kit" (kept verbatim — it needs no slug fallback).
    expect(Object.keys(appliedBundles)).toEqual(["stash", "team", "reg-kit"]);
    expect(appliedConfig.defaultBundle).toBe("stash");
    expect(appliedBundles.stash).toMatchObject({ path: path.join(getDataDir(), "stash"), writable: true });
    expect(appliedBundles.team).toMatchObject({ path: path.join(getDataDir(), "team"), writable: true });
    // WI-8.5 desired/resolved split (spec §10.2): the installed npm entry emits its
    // DESIRED locator, NOT the resolved cache root (that moves to the lock's localRoot).
    expect(appliedBundles["reg-kit"]).toEqual({ npm: "@scope/kit" });

    const db = readState();
    try {
      // The cutover ran (this suite's actual subject) — asserted independently of
      // ordering so a future migration cannot mask its absence — and the ledger
      // head is the newest shipped migration. The head pin moves with each new
      // migration; #733 added 021-asset-state-missing-since.
      expect(ledgerIds(db)).toContain("020-three-db-cutover");
      expect(ledgerIds(db).at(-1)).toBe("021-asset-state-missing-since");

      // Workflow rows carried bit-exact.
      const run = db.query("SELECT * FROM workflow_runs WHERE id = 'run-1'").get() as Record<string, unknown>;
      expect(run).toMatchObject({
        id: "run-1",
        workflow_ref: "workflows/ship",
        workflow_title: "Ship it",
        status: "active",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
      });
      expect((db.query("SELECT COUNT(*) AS n FROM workflow_run_steps").get() as { n: number }).n).toBe(1);
      expect((db.query("SELECT COUNT(*) AS n FROM workflow_run_units").get() as { n: number }).n).toBe(1);

      // Live refs re-keyed to their item_refs across every ref-keyed table.
      expect(refsIn(db, "asset_salience", "asset_ref")).toEqual([MEMORY_ITEM_REF, SKILL_ITEM_REF]);
      expect(refsIn(db, "asset_outcome", "asset_ref")).toEqual([MEMORY_ITEM_REF, SKILL_ITEM_REF]);
      expect(refsIn(db, "events", "ref")).toEqual([MEMORY_ITEM_REF, SKILL_ITEM_REF]);

      // usage_events rescued into state.db and residual legacy ref re-keyed.
      const usageRefs = refsIn(db, "usage_events", "entry_ref");
      expect(usageRefs.filter((r) => r === SKILL_ITEM_REF).length).toBe(2); // legacy re-keyed + bundle carried
      const usageSources = db.query("SELECT DISTINCT source FROM usage_events").all() as Array<{ source: string }>;
      expect(usageSources).toEqual([{ source: "unknown" }]);
      // The orphan usage_events row is KEPT in place (append-only) and audited.
      expect(usageRefs).toContain(USAGE_EVENT_ORPHAN_REF);
      const usageOrphan = db
        .query("SELECT row_count FROM legacy_state WHERE surface = 'usage_events' AND old_ref = ?")
        .get(USAGE_EVENT_ORPHAN_REF) as { row_count: number } | undefined;
      expect(usageOrphan?.row_count).toBe(1);
      expect(fs.readFileSync(treatmentFile, "utf8")).toBe(`# pilot\n${SKILL_ITEM_REF}\n${MEMORY_ITEM_REF}\n`);
    } finally {
      db.close();
    }

    // WI-8.3: the 4→3 collapse also holds for the RUNTIME. workflow.db is gone,
    // yet a workflow write through the runtime gateway (withWorkflowRunsRepo)
    // lands in state.db's merged workflow_runs — no workflow.db is re-created.
    await withWorkflowRunsRepo((repo) =>
      repo.insertRun({
        id: "runtime-run",
        workflowRef: "workflows/ship",
        scopeKey: null,
        workflowEntryId: null,
        workflowTitle: "Runtime write",
        paramsJson: "{}",
        currentStepId: null,
        createdAt: "2026-02-01T00:00:00Z",
        updatedAt: "2026-02-01T00:00:00Z",
        agentHarness: null,
        agentSessionId: null,
        checkinArmedAt: null,
      }),
    );
    expect(fs.existsSync(getLegacyWorkflowDbPath())).toBe(false); // no workflow.db resurrected
    const after = readState();
    try {
      expect(
        (after.query("SELECT COUNT(*) AS n FROM workflow_runs WHERE id = 'runtime-run'").get() as { n: number }).n,
      ).toBe(1);
    } finally {
      after.close();
    }

    // WI-8.5a: a proposal WRITTEN post-cutover is born already-final — the writer
    // flip mints proposals.ref as the fully-qualified item_ref directly, so a
    // second re-key pass over it is a no-op (no legacy `type:name` row is ever
    // created and then migrated). Contrast with rc-train's pre-cutover rows,
    // which are seeded legacy and re-keyed above.
    const postStash = path.join(getDataDir(), "stash");
    fs.mkdirSync(path.join(postStash, "lessons"), { recursive: true });
    const bornFinal = createProposal(postStash, {
      ref: "lessons/post-cutover-born-final",
      source: "distill",
      sourceRun: "post-cutover-run",
      force: true,
      payload: {
        content:
          "---\ndescription: A proposal born after the database cutover\nwhen_to_use: Verifying post-cutover proposal reference identity\n---\nPost-cutover payload.\n",
      },
    });
    if ("message" in bornFinal) throw new Error(`unexpected skip: ${bornFinal.message}`);
    const bundleId = deriveInstallations([{ path: postStash, writable: true }])[0]?.id ?? slugForPath(postStash);
    const expectedItemRef = deriveEntryProvenance(
      { bundleId, componentId: bundleId, adapterId: "akm" },
      "lesson",
      "post-cutover-born-final",
    ).itemRef;
    expect(bornFinal.ref).toBe(expectedItemRef); // already the item_ref
    expect(bornFinal.ref).toContain("//"); // fully-qualified, never a legacy type:name
    expect(bornFinal.ref).not.toMatch(/(?<![A-Za-z/])lesson:/); // no legacy spelling to re-key
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) orphan fixture completes-with-quarantine
// ─────────────────────────────────────────────────────────────────────────────

describe("WI-8.2 (b) — orphan-bearing state completes with quarantine", () => {
  test("live contrast refs re-key; the 4 orphan shapes land in legacy_state; migration COMPLETES", async () => {
    buildOrphanBearingStateDb(getStateDbPathInDataDir());
    seedOldIndexDb(); // only the live contrast refs have index entries; orphans map to nothing
    const prepared = writeConfigs();

    const applied = await runCliCapture(["migrate", "apply", "--config", prepared]);
    expect(applied.code, applied.stderr).toBe(0); // completes, never aborts

    const db = readState();
    try {
      // Live contrast refs re-keyed; the 4 orphan refs are GONE from the live tables.
      const salience = refsIn(db, "asset_salience", "asset_ref");
      expect(salience).toEqual([MEMORY_ITEM_REF, SKILL_ITEM_REF]);
      for (const orphan of Object.values(ORPHAN_REFS)) expect(salience).not.toContain(orphan);
      for (const live of Object.values(LIVE_CONTRAST_REFS)) expect(salience).not.toContain(live);

      // The 4 orphan shapes are quarantined with counts (1 salience + 1 outcome row each).
      for (const orphan of Object.values(ORPHAN_REFS)) {
        for (const surface of ["asset_salience", "asset_outcome"] as const) {
          const row = db
            .query("SELECT row_count, reason FROM legacy_state WHERE surface = ? AND old_ref = ?")
            .get(surface, orphan) as { row_count: number; reason: string } | undefined;
          expect(row?.row_count).toBe(1);
          expect(row?.reason).toBe("orphan");

          // ...and the COMPLETE row is retained, not just its count. The guide
          // promises unresolvable refs are quarantined, not dropped.
          const retained = db
            .query("SELECT row_json FROM legacy_state_rows WHERE surface = ? AND old_ref = ?")
            .all(surface, orphan) as Array<{ row_json: string }>;
          expect(retained).toHaveLength(1);
          expect(JSON.parse(retained[0]!.row_json)).toMatchObject({ asset_ref: orphan });
        }
      }
    } finally {
      db.close();
    }
  }, 30_000);

  test("historical events for a retired asset type are quarantined as expected orphans", async () => {
    const state = openStateDbAtCeiling(getStateDbPathInDataDir(), PRE_CUTOVER_STATE_CEILING);
    const insert = state.prepare("INSERT INTO events (event_type, ts, ref) VALUES ('show', ?, 'vault:default')");
    insert.run("2026-01-01T00:00:00.000Z");
    insert.run("2026-01-02T00:00:00.000Z");
    state.close();
    seedOldIndexDb();

    const applied = await runCliCapture(["migrate", "apply", "--config", writeConfigs()]);
    expect(applied.code, applied.stderr).toBe(0);

    const migrated = readState();
    try {
      expect(
        (migrated.query("SELECT COUNT(*) AS n FROM events WHERE ref = 'vault:default'").get() as { n: number }).n,
      ).toBe(0);
      expect(
        migrated
          .query("SELECT row_count, reason FROM legacy_state WHERE surface = 'events' AND old_ref = 'vault:default'")
          .get(),
      ).toEqual({ row_count: 2, reason: "orphan" });

      // Both event rows survive in full — timestamps and event_type included —
      // so a quarantined history stays recoverable rather than becoming a count.
      const retained = migrated
        .query("SELECT row_json FROM legacy_state_rows WHERE surface = 'events' AND old_ref = 'vault:default'")
        .all() as Array<{ row_json: string }>;
      expect(retained).toHaveLength(2);
      const parsed = retained.map((r) => JSON.parse(r.row_json) as Record<string, unknown>);
      expect(parsed.map((r) => r.ts).sort()).toEqual(["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"]);
      expect(parsed.every((r) => r.event_type === "show" && r.ref === "vault:default")).toBe(true);
    } finally {
      migrated.close();
    }
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) fresh install — no workflow.db / index.db, no ATTACH-created strays
// ─────────────────────────────────────────────────────────────────────────────

describe("WI-8.2 (c) — fresh install records complete without ATTACH", () => {
  test("no workflow.db/index.db, no legacy rows → apply succeeds, empty tables, no stray files", async () => {
    openStateDbAtCeiling(getStateDbPathInDataDir(), PRE_CUTOVER_STATE_CEILING).close(); // empty state.db @ 019
    const prepared = writeConfigs();

    const applied = await runCliCapture(["migrate", "apply", "--config", prepared]);
    expect(applied.code, applied.stderr).toBe(0);

    // ATTACH is never issued when the file is absent, so no stray file is CREATEd.
    expect(fs.existsSync(getLegacyWorkflowDbPath())).toBe(false);
    expect(fs.existsSync(getDbPath())).toBe(false);
    expect(fs.readdirSync(getDataDir()).some((f) => f.startsWith("index.db.pre-cutover-"))).toBe(false);

    const db = readState();
    try {
      expect(ledgerIds(db)).toContain("020-three-db-cutover");
      expect(ledgerIds(db).at(-1)).toBe("021-asset-state-missing-since");
      for (const table of [
        "workflow_runs",
        "workflow_run_steps",
        "workflow_run_units",
        "usage_events",
        "legacy_state",
      ]) {
        expect((db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
      }
    } finally {
      db.close();
    }
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// (d) idempotency — a second migrate apply is a no-op
// ─────────────────────────────────────────────────────────────────────────────

describe("WI-8.2 (d) — the cutover runs exactly once", () => {
  test("a second migrate apply is a no-op (no re-merge, workflow.db stays gone)", async () => {
    buildRcTrainFromState(getDataDir());
    seedWorkflowRun();
    seedOldIndexDb();
    const prepared = writeConfigs();

    const first = await runCliCapture(["migrate", "apply", "--config", prepared]);
    expect(first.code, first.stderr).toBe(0);
    const afterFirst = fs.readFileSync(getStateDbPathInDataDir());

    const second = await runCliCapture(["migrate", "apply"]);
    expect(second.code, second.stderr).toBe(0);
    // Byte-identical state.db (no re-merge, no duplicated rows) and workflow.db stays gone.
    expect(fs.readFileSync(getStateDbPathInDataDir())).toEqual(afterFirst);
    expect(fs.existsSync(getLegacyWorkflowDbPath())).toBe(false);

    const db = readState();
    try {
      expect((db.query("SELECT COUNT(*) AS n FROM workflow_runs").get() as { n: number }).n).toBe(1); // not doubled
    } finally {
      db.close();
    }
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// (e) fail-closed - an unparseable ref leaves a retryable sentinel
// ─────────────────────────────────────────────────────────────────────────────

describe("WI-8.2 (e) - an integrity failure remains retryable", () => {
  test("an unparseable stored ref aborts the transaction and succeeds after repair", async () => {
    const db = openStateDbAtCeiling(getStateDbPathInDataDir(), PRE_CUTOVER_STATE_CEILING);
    db.prepare(`INSERT INTO asset_salience (asset_ref, encoding_salience, updated_at) VALUES (?, 0.5, 100)`).run(
      RC_TRAIN_LIVE_REFS.skill,
    );
    // Fail late, after the scalar-table pass has physically mutated pages. A
    // logical SQL rollback need not restore byte-identical database pages.
    db.prepare("INSERT INTO events (event_type, ts, ref) VALUES ('show', '2026-01-01T00:00:00.000Z', ':bad')").run();
    db.close();
    seedOldIndexDb();
    const treatmentFile = path.join(getDataDir(), "stash", ".akm", "measurement", "treatment-pilot-2026-06-14.txt");
    fs.mkdirSync(path.dirname(treatmentFile), { recursive: true });
    fs.writeFileSync(treatmentFile, `${RC_TRAIN_LIVE_REFS.skill}\n`);
    const prepared = writeConfigs();

    // Semantic pre-state snapshot (VACUUM-INTO backups are not byte-identical to a
    // fresh fixture, so assert the pre-state rows + ledger survive intact).
    const pre = readState();
    const preSalience = refsIn(pre, "asset_salience", "asset_ref");
    const preEvents = refsIn(pre, "events", "ref");
    pre.close();

    const applied = await runCliCapture(["migrate", "apply", "--config", prepared]);
    expect(applied.code).not.toBe(0);
    expect(applied.stderr).toMatch(/incomplete|unparseable|integrity/i);
    expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(true);
    expect(JSON.parse(fs.readFileSync(getMigrationApplyJournalPath(), "utf8")).phase).toBeUndefined();

    const post = readState();
    try {
      // The cutover transaction rolled back, while additive schema migrations
      // remain safely applied for the retry.
      expect(refsIn(post, "asset_salience", "asset_ref").sort()).toEqual(preSalience.sort());
      expect(refsIn(post, "asset_salience", "asset_ref")).toContain(RC_TRAIN_LIVE_REFS.skill);
      expect(refsIn(post, "events", "ref")).toEqual(preEvents);
      expect(refsIn(post, "events", "ref")).toContain(":bad");
      expect(ledgerIds(post).at(-1)).not.toBe(PRE_CUTOVER_STATE_CEILING);
      expect(fs.readFileSync(treatmentFile, "utf8")).toBe(`${RC_TRAIN_LIVE_REFS.skill}\n`);
    } finally {
      post.close();
    }

    const repaired = new Database(getStateDbPathInDataDir());
    repaired.run("DELETE FROM events WHERE ref=':bad'");
    repaired.close();
    const resumed = await runCliCapture(["migrate", "apply"]);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(false);
  }, 30_000);
});

describe("WI-8.2 pilot treatment recovery", () => {
  for (const collision of ["symlink", "file"] as const) {
    test(`does not follow or overwrite a pre-existing ${collision} at the treatment temp path`, () => {
      const stash = path.join(getDataDir(), `pilot-temp-${collision}`);
      const treatmentFile = path.join(stash, ".akm", "measurement", "treatment-pilot-2026-06-14.txt");
      const victim = path.join(stash, "victim.txt");
      fs.mkdirSync(path.dirname(treatmentFile), { recursive: true });
      fs.writeFileSync(treatmentFile, `${RC_TRAIN_LIVE_REFS.skill}\n`, { mode: 0o600 });
      fs.writeFileSync(victim, "KEEP_ME\n", { mode: 0o600 });

      const originalOpen = fs.openSync;
      let plantedTemp: string | undefined;
      let attemptedFlags: string | undefined;
      spyOn(fs, "openSync").mockImplementation((filePath, flags, mode) => {
        const candidate = String(filePath);
        if (!plantedTemp && candidate.startsWith(`${treatmentFile}.tmp`)) {
          plantedTemp = candidate;
          attemptedFlags = String(flags);
          if (collision === "symlink") fs.symlinkSync(victim, candidate);
          else fs.writeFileSync(candidate, "COLLISION\n", { mode: 0o600 });
        }
        return originalOpen(filePath, flags, mode);
      });

      expect(() =>
        migratePilotTreatmentFiles(
          [{ path: stash, primary: true }],
          new Map([[RC_TRAIN_LIVE_REFS.skill, SKILL_ITEM_REF]]),
        ),
      ).toThrow();
      expect(attemptedFlags).toBe("wx");
      expect(plantedTemp).toBeDefined();
      expect(plantedTemp).toMatch(new RegExp(`\\.tmp-${process.pid}-[a-f0-9]{16}$`));
      expect(fs.readFileSync(victim, "utf8")).toBe("KEEP_ME\n");
      expect(fs.readFileSync(treatmentFile, "utf8")).toBe(`${RC_TRAIN_LIVE_REFS.skill}\n`);
      if (!plantedTemp) throw new Error("temp collision was not planted");
      expect(fs.lstatSync(plantedTemp).isSymbolicLink()).toBe(collision === "symlink");
      if (collision === "file") expect(fs.readFileSync(plantedTemp, "utf8")).toBe("COLLISION\n");
    });
  }

  test("fsyncs the parent directory after atomically replacing a treatment file", () => {
    const stash = path.join(getDataDir(), "pilot-durability");
    const treatmentFile = path.join(stash, ".akm", "measurement", "treatment-pilot-2026-06-14.txt");
    fs.mkdirSync(path.dirname(treatmentFile), { recursive: true });
    fs.writeFileSync(treatmentFile, `${RC_TRAIN_LIVE_REFS.skill}\n`, { mode: 0o600 });
    fs.chmodSync(treatmentFile, 0o660);

    const originalFsync = fs.fsyncSync;
    let fileSyncObserved = false;
    let directorySyncObserved = false;
    spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (fs.fstatSync(fd).isDirectory()) {
        directorySyncObserved = true;
        expect(fs.readFileSync(treatmentFile, "utf8")).toBe(`${SKILL_ITEM_REF}\n`);
      } else {
        fileSyncObserved = true;
      }
      return originalFsync(fd);
    });

    const previousUmask = process.umask(0o077);
    let migrated: number;
    try {
      migrated = migratePilotTreatmentFiles(
        [{ path: stash, primary: true }],
        new Map([[RC_TRAIN_LIVE_REFS.skill, SKILL_ITEM_REF]]),
      );
    } finally {
      process.umask(previousUmask);
    }
    expect(migrated).toBe(1);
    expect(fileSyncObserved).toBe(true);
    expect(directorySyncObserved).toBe(true);
    expect(fs.statSync(treatmentFile).mode & 0o777).toBe(0o660);
  });

  test("retries a failed parent fsync on an idempotent rewrite before reporting success", () => {
    const stash = path.join(getDataDir(), "pilot-directory-retry");
    const treatmentFile = path.join(stash, ".akm", "measurement", "treatment-pilot-2026-06-14.txt");
    fs.mkdirSync(path.dirname(treatmentFile), { recursive: true });
    fs.writeFileSync(treatmentFile, `${RC_TRAIN_LIVE_REFS.skill}\n`, { mode: 0o640 });

    const originalFsync = fs.fsyncSync;
    let directorySyncAttempts = 0;
    spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (fs.fstatSync(fd).isDirectory()) {
        directorySyncAttempts += 1;
        if (directorySyncAttempts === 1) {
          throw Object.assign(new Error("injected parent fsync failure"), { code: "EIO" });
        }
      }
      return originalFsync(fd);
    });

    expect(() =>
      migratePilotTreatmentFiles(
        [{ path: stash, primary: true }],
        new Map([[RC_TRAIN_LIVE_REFS.skill, SKILL_ITEM_REF]]),
      ),
    ).toThrow("injected parent fsync failure");
    expect(fs.readFileSync(treatmentFile, "utf8")).toBe(`${SKILL_ITEM_REF}\n`);

    expect(
      migratePilotTreatmentFiles(
        [{ path: stash, primary: true }],
        new Map([[RC_TRAIN_LIVE_REFS.skill, SKILL_ITEM_REF]]),
      ),
    ).toBe(0);
    expect(directorySyncAttempts).toBe(2);
    expect(fs.statSync(treatmentFile).mode & 0o777).toBe(0o640);
  });

  test("keeps forward recovery pending when the treatment rewrite fails", async () => {
    openStateDbAtCeiling(getStateDbPathInDataDir(), PRE_CUTOVER_STATE_CEILING).close();
    seedOldIndexDb();
    const treatmentFile = path.join(getDataDir(), "stash", ".akm", "measurement", "treatment-pilot-2026-06-14.txt");
    fs.mkdirSync(treatmentFile, { recursive: true });
    const prepared = writeConfigs();

    const failed = await runCliCapture(["migrate", "apply", "--config", prepared]);
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toMatch(/incomplete|directory/i);
    expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(true);
    expect(JSON.parse(fs.readFileSync(getMigrationApplyJournalPath(), "utf8")).phase).toBeUndefined();

    fs.rmSync(treatmentFile, { recursive: true });
    fs.writeFileSync(treatmentFile, `${RC_TRAIN_LIVE_REFS.skill}\n`);
    const resumed = await runCliCapture(["migrate", "apply"]);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(fs.readFileSync(treatmentFile, "utf8")).toBe(`${SKILL_ITEM_REF}\n`);
    expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(false);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// (f) WI-8.5d content migration — `.stash.json` fold + D-R6 reserved-file rename
// ─────────────────────────────────────────────────────────────────────────────

const CONTENT_STASH = (): string => path.join(getDataDir(), "stash");

/**
 * Seed the primary stash with (1) a markdown asset + a `.stash.json` sidecar that
 * OVERRIDES its curated metadata, (2) a `knowledge/index.md` that actually holds
 * asset frontmatter (a concept mis-named as a reserved file — D-R6), and (3) a
 * structural bundle-root `index.md` with no asset frontmatter (must stay put).
 */
function seedContentStash(): void {
  const stash = CONTENT_STASH();
  const memDir = path.join(stash, "memories");
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(
    path.join(memDir, "note.md"),
    "---\ndescription: Original generated description\n---\n\nNote body.\n",
  );
  const sidecar: StashFile = {
    entries: [
      {
        name: "note",
        type: "memory",
        filename: "note.md",
        description: "Curated override for note",
        tags: ["curated-fold"],
        whenToUse: "Use for the WI-8.5d fold assertion",
      },
    ],
  };
  writeLegacyStashFile(memDir, sidecar);

  const knowledgeDir = path.join(stash, "knowledge");
  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.writeFileSync(
    path.join(knowledgeDir, "index.md"),
    "---\ndescription: A knowledge concept accidentally named index\nwhen_to_use: retrieval test\n---\n\n# Real concept\n\nbody\n",
  );

  fs.writeFileSync(path.join(stash, "index.md"), "# Bundle listing\n\n- memories/note\n");

  // Group-C item 2: a derived memory carrying the LAST deliberately-legacy ref
  // channel — a `source: memory:<parent>` backref (the interpolated name keeps
  // this legacy seed out of the ref-literal ratchet's counted scope). The
  // content migration rewrites it forward to `source: memories/<parent>`.
  const derivedParent = "note";
  fs.writeFileSync(
    path.join(memDir, `${derivedParent}.derived.md`),
    `---\ninferred: true\nsource: memory:${derivedParent}\nderivedFrom: ${derivedParent}\n---\n\nDerived note body.\n`,
  );
}

function readContentReport(): ContentMigrationReport {
  const raw = fs.readFileSync(path.join(getMigrationOperationRoot(), "content-migration-report.json"), "utf8");
  return JSON.parse(raw) as ContentMigrationReport;
}

describe("WI-8.5d (f) — content migration folds .stash.json + D-R6 renames mis-named reserved files", () => {
  test("overrides fold into frontmatter, sidecar deleted, index.md renamed + reported, second apply idempotent", async () => {
    const preState = openStateDbAtCeiling(getStateDbPathInDataDir(), PRE_CUTOVER_STATE_CEILING);
    // Durable state keyed to the MIS-NAMED concept: the D-R6 rename changes the
    // asset's identity, so this row must be re-keyed with it, not stranded.
    insertAssetSalienceRow(preState, {
      assetRef: "knowledge/index",
      encodingSalience: 0.5,
      outcomeSalience: 0.5,
      retrievalSalience: 0.5,
      rankScore: 0.5,
      consecutiveNoOps: 0,
      updatedAt: 1_700_000_000,
      homeostaticDemotedAt: null,
      encodingSource: null,
    });
    preState.close();
    seedContentStash();
    const prepared = writeConfigs();

    const applied = await runCliCapture(["migrate", "apply", "--config", prepared]);
    expect(applied.code, applied.stderr).toBe(0);

    const stash = CONTENT_STASH();
    const notePath = path.join(stash, "memories", "note.md");
    const sidecarPath = path.join(stash, "memories", ".stash.json");
    const misnamedIndex = path.join(stash, "knowledge", "index.md");
    const renamedIndex = path.join(stash, "knowledge", "index-content.md");
    const structuralIndex = path.join(stash, "index.md");

    // (1) `.stash.json` overrides folded into the target's frontmatter; sidecar gone.
    expect(fs.existsSync(sidecarPath)).toBe(false);
    const noteFm = parseFrontmatter(fs.readFileSync(notePath, "utf8")).data;
    expect(noteFm.description).toBe("Curated override for note"); // sidecar wins over the generated value
    expect(noteFm.tags).toEqual(["curated-fold"]);
    expect(noteFm.when_to_use).toBe("Use for the WI-8.5d fold assertion"); // whenToUse → when_to_use

    // (2) D-R6: the mis-named concept renamed collision-safe; structural index.md left in place.
    expect(fs.existsSync(misnamedIndex)).toBe(false);
    expect(fs.existsSync(renamedIndex)).toBe(true);
    expect(parseFrontmatter(fs.readFileSync(renamedIndex, "utf8")).data.description).toBe(
      "A knowledge concept accidentally named index",
    );
    expect(fs.existsSync(structuralIndex)).toBe(true);
    expect(fs.readFileSync(structuralIndex, "utf8")).toContain("# Bundle listing");

    // (3) The rename is RECORDED in the persisted step report.
    const report = readContentReport();
    expect(report.sidecarsFolded).toBe(1);
    expect(report.entriesFolded).toBe(1);
    expect(report.reservedRenames).toHaveLength(1);
    expect(report.reservedRenames[0]).toEqual({ from: misnamedIndex, to: renamedIndex });

    // (3a) The rename re-keys durable state to the NEW identity: the salience
    // row seeded against the mis-named concept follows the file instead of
    // dangling on a ref no asset can ever mint again.
    const state = readState();
    try {
      const salRefs = state
        .query(
          "SELECT asset_ref FROM asset_salience WHERE asset_ref LIKE 'knowledge/%' OR asset_ref LIKE '%//knowledge/%'",
        )
        .all() as Array<{ asset_ref: string }>;
      expect(salRefs.map((r) => r.asset_ref)).toEqual(["knowledge/index-content"]);
    } finally {
      state.close();
    }

    // (3b) Group-C item 2: the derived memory's legacy `source: memory:<parent>`
    // backref is rewritten forward to the 0.9.0 conceptId and counted.
    expect(report.sourceBackrefsRewritten).toBe(1);
    const derivedNotePath = path.join(stash, "memories", "note.derived.md");
    expect(parseFrontmatter(fs.readFileSync(derivedNotePath, "utf8")).data.source).toBe("memories/note");

    // (4) A second migrate apply is a no-op — the folded/renamed state is unchanged.
    const noteAfterFirst = fs.readFileSync(notePath, "utf8");
    const second = await runCliCapture(["migrate", "apply"]);
    expect(second.code, second.stderr).toBe(0);
    expect(fs.readFileSync(notePath, "utf8")).toBe(noteAfterFirst);
    expect(fs.existsSync(sidecarPath)).toBe(false);
    expect(fs.existsSync(renamedIndex)).toBe(true);

    // (5) Re-running the step itself directly is idempotent: nothing left to do
    // (the source backref is already `memories/note`, so no re-rewrite).
    const rerun = runContentMigration([stash]);
    expect(rerun).toEqual({
      sidecarsFolded: 0,
      entriesFolded: 0,
      entriesSkipped: 0,
      reservedRenames: [],
      sourceBackrefsRewritten: 0,
      // runContentMigration itself never imports proposals — that sibling step
      // lives in config-migrate.ts and needs the migrated state.db handle.
      legacyProposalsImported: 0,
      sidecarReports: [],
    });
  }, 30_000);

  test("re-applies a double-digit reserved rename after restoring the original migration backup", async () => {
    seedSalienceRef("knowledge/index");
    seedContentStash();
    const knowledgeDir = path.join(CONTENT_STASH(), "knowledge");
    for (const suffix of ["", "-2", "-3", "-4", "-5", "-6", "-7", "-8", "-9"]) {
      fs.writeFileSync(path.join(knowledgeDir, `index-content${suffix}.md`), "occupied\n");
    }
    const prepared = writeConfigs();

    const first = await runCliCapture(["migrate", "apply", "--config", prepared]);
    expect(first.code, first.stderr).toBe(0);
    restoreMigrationBackup(true, backupRunIdFromApply(first.stdout));

    const reapplied = await runCliCapture(["migrate", "apply", "--config", prepared]);
    expect(reapplied.code, reapplied.stderr).toBe(0);
    const state = readState();
    try {
      expect(refsIn(state, "asset_salience", "asset_ref")).toEqual(["knowledge/index-content-10"]);
    } finally {
      state.close();
    }
    expect(fs.existsSync(path.join(knowledgeDir, "index.md"))).toBe(false);
    expect(fs.existsSync(path.join(knowledgeDir, "index-content-10.md"))).toBe(true);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// (g) Pre-0.9 filesystem-proposal import — folded out of the live per-op path
//     (was `withProposalsDb` → `importLegacyProposalFiles`) INTO this one-time
//     migrator step (`scripts/akm-migrate/migrate/legacy/proposal-fs-import.ts`).
// ─────────────────────────────────────────────────────────────────────────────

/** Write one pre-0.9.0 `<stash>/.akm/proposals[/archive]/<id>/proposal.json`. */
function writeLegacyProposal(
  stashDir: string,
  proposal: Record<string, unknown>,
  options: { archive?: boolean; backupBody?: string } = {},
): void {
  const root = options.archive
    ? path.join(stashDir, ".akm", "proposals", "archive")
    : path.join(stashDir, ".akm", "proposals");
  const dir = path.join(root, String(proposal.id));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "proposal.json"), `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
  if (options.backupBody !== undefined) fs.writeFileSync(path.join(dir, "backup.md"), options.backupBody, "utf8");
}

function legacyProposalRecord(id: string, ref: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    ref,
    status,
    source: "reflect",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    payload: { content: "Prefer rg over grep for code search.\n" },
    ...extra,
  };
}

/** Rows for one stash from the migrated state.db (readonly). */
function readProposalRows(stashDir: string): Array<{ id: string; status: string; metadata_json: string }> {
  const db = new Database(getStateDbPathInDataDir(), { readonly: true });
  try {
    return db
      .prepare("SELECT id, status, metadata_json FROM proposals WHERE stash_dir = ? ORDER BY id")
      .all(stashDir) as Array<{ id: string; status: string; metadata_json: string }>;
  } finally {
    db.close();
  }
}

describe("(g) migrate apply imports pre-0.9 filesystem proposals into state.db", () => {
  test("pending + archived proposals land (backup inlined), corrupt skipped, second apply idempotent", async () => {
    openStateDbAtCeiling(getStateDbPathInDataDir(), PRE_CUTOVER_STATE_CEILING).close();

    const stash = CONTENT_STASH();
    fs.mkdirSync(path.join(stash, "lessons"), { recursive: true });
    const pendingId = "11111111-1111-4111-8111-111111111111";
    const acceptedId = "22222222-2222-4222-8222-222222222222";
    const corruptId = "33333333-3333-4333-8333-333333333333";
    writeLegacyProposal(stash, legacyProposalRecord(pendingId, "lessons/legacy-pending", "pending"));
    writeLegacyProposal(
      stash,
      legacyProposalRecord(acceptedId, "lessons/legacy-accepted", "accepted", {
        backup: "backup.md",
        review: { outcome: "accepted", decidedAt: "2026-01-02T00:00:00.000Z" },
      }),
      { archive: true, backupBody: "LEGACY BACKUP BODY\n" },
    );
    // A corrupt legacy entry must be skipped without blocking the rest.
    const corruptDir = path.join(stash, ".akm", "proposals", corruptId);
    fs.mkdirSync(corruptDir, { recursive: true });
    fs.writeFileSync(path.join(corruptDir, "proposal.json"), "{ not json", "utf8");

    const prepared = writeConfigs();
    const applied = await runCliCapture(["migrate", "apply", "--config", prepared]);
    expect(applied.code, applied.stderr).toBe(0);

    // (1) Both well-formed proposals imported; the corrupt one skipped.
    const rows = readProposalRows(stash);
    expect(rows.map((r) => r.id)).toEqual([pendingId, acceptedId]);
    const acceptedRow = rows.find((r) => r.id === acceptedId);
    expect(acceptedRow?.status).toBe("accepted");
    // (2) The legacy `backup.md` was inlined as `backupContent`.
    const acceptedMeta = JSON.parse(acceptedRow?.metadata_json ?? "{}") as { backupContent?: string };
    expect(acceptedMeta.backupContent).toBe("LEGACY BACKUP BODY\n");

    // (3) The import count rides the content-migration report.
    expect(readContentReport().legacyProposalsImported).toBe(2);

    // (4) The legacy files are left in place on disk (inert, operator-removable).
    expect(fs.existsSync(path.join(stash, ".akm", "proposals", pendingId, "proposal.json"))).toBe(true);

    // (5) A second migrate apply is a no-op on an already-current install (it
    // short-circuits before the content step), so the rows stay exactly as
    // imported — no duplication.
    const second = await runCliCapture(["migrate", "apply"]);
    expect(second.code, second.stderr).toBe(0);
    expect(readProposalRows(stash).map((r) => r.id)).toEqual([pendingId, acceptedId]);

    // (6) Re-running the import step itself over the still-on-disk legacy files
    // re-imports nothing (INSERT OR IGNORE on the UUID) — idempotent.
    expect(importLegacyProposalsIntoState(getStateDbPathInDataDir(), [{ path: stash, bundleId: "stash" }])).toBe(0);
    expect(readProposalRows(stash).map((r) => r.id)).toEqual([pendingId, acceptedId]);
  }, 30_000);

  test("rekeys an earlier reserved-ref proposal before idempotent UUID import", async () => {
    openStateDbAtCeiling(getStateDbPathInDataDir(), PRE_CUTOVER_STATE_CEILING).close();
    seedContentStash();
    const stash = CONTENT_STASH();
    const id = "44444444-4444-4444-8444-444444444444";
    const oldRef = "stash//knowledge/index";
    const finalRef = "stash//knowledge/index-content";
    writeLegacyProposal(stash, legacyProposalRecord(id, oldRef, "pending"));
    expect(importLegacyProposalsIntoState(getStateDbPathInDataDir(), [{ path: stash, bundleId: "stash" }])).toBe(1);

    const earlierRc = openDatabaseFinalizing(getStateDbPathInDataDir(), { readonly: true });
    try {
      expect(
        (earlierRc.prepare("SELECT ref FROM proposals ORDER BY ref").all() as Array<{ ref: string }>).map(
          (row) => row.ref,
        ),
      ).toEqual([oldRef]);
    } finally {
      earlierRc.close();
    }

    const applied = await runCliCapture(["migrate", "apply", "--config", writeConfigs()]);
    expect(applied.code, applied.stderr).toBe(0);
    expect(readContentReport().legacyProposalsImported).toBe(0);
    const second = await runCliCapture(["migrate", "apply"]);
    expect(second.code, second.stderr).toBe(0);

    const migrated = readState();
    try {
      expect(refsIn(migrated, "proposals", "ref")).toEqual([finalRef]);
    } finally {
      migrated.close();
    }
  }, 30_000);
});

describe("index quarantine boundary recovery", () => {
  test("finishes moving sidecars after the main file was already quarantined", () => {
    const indexPath = getDbPath();
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    const target = `${indexPath}.pre-cutover-partial`;
    fs.writeFileSync(target, "original-main");
    fs.writeFileSync(`${indexPath}-wal`, "original-wal");
    fs.writeFileSync(`${indexPath}-shm`, "original-shm");

    expect(quarantineIndexDb("partial", indexPath)).toEqual({ quarantined: true, target });
    expect(fs.existsSync(indexPath)).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe("original-main");
    expect(fs.readFileSync(`${target}-wal`, "utf8")).toBe("original-wal");
    expect(fs.readFileSync(`${target}-shm`, "utf8")).toBe("original-shm");
    expect(fs.existsSync(`${indexPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${indexPath}-shm`)).toBe(false);
  });

  test("preserves a recreated canonical generation when the quarantine target exists", () => {
    const indexPath = getDbPath();
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    const target = `${indexPath}.pre-cutover-external`;
    fs.writeFileSync(target, "original-main");
    fs.writeFileSync(indexPath, "external-main");
    fs.writeFileSync(`${indexPath}-wal`, "external-wal");

    expect(quarantineIndexDb("external", indexPath)).toEqual({ quarantined: true, target });
    expect(fs.readFileSync(target, "utf8")).toBe("original-main");
    expect(fs.readFileSync(indexPath, "utf8")).toBe("external-main");
    expect(fs.readFileSync(`${indexPath}-wal`, "utf8")).toBe("external-wal");
    expect(fs.existsSync(`${target}-wal`)).toBe(false);
  });

  test("preserves remaining canonical sidecars when a target sidecar collides", () => {
    const indexPath = getDbPath();
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    const target = `${indexPath}.pre-cutover-collision`;
    fs.writeFileSync(target, "original-main");
    fs.writeFileSync(`${target}-wal`, "target-wal");
    fs.writeFileSync(`${indexPath}-wal`, "canonical-wal");
    fs.writeFileSync(`${indexPath}-shm`, "canonical-shm");

    expect(quarantineIndexDb("collision", indexPath)).toEqual({ quarantined: true, target });
    expect(fs.readFileSync(`${target}-wal`, "utf8")).toBe("target-wal");
    expect(fs.readFileSync(`${indexPath}-wal`, "utf8")).toBe("canonical-wal");
    expect(fs.readFileSync(`${indexPath}-shm`, "utf8")).toBe("canonical-shm");
    expect(fs.existsSync(`${target}-shm`)).toBe(false);
  });
});

describe("already-current proposal ref repair", () => {
  test("status blocks an unmappable pending legacy ref", async () => {
    fs.writeFileSync(getConfigPath(), '{"configVersion":"0.9.0","semanticSearchMode":"off"}\n', { mode: 0o600 });
    const state = openStateDbAtCeiling(getStateDbPathInDataDir(), STATE_MIGRATIONS.at(-1)?.id ?? "");
    state
      .prepare(
        "INSERT INTO proposals(id, stash_dir, ref, status, source, created_at, updated_at, content, frontmatter_json, metadata_json) VALUES (?, '/stash', ?, 'pending', 'legacy', 'c', 'u', 'body', NULL, '{}')",
      )
      .run("90909090-9090-4090-8090-909090909090", retiredRef("lesson", "pending"));
    state.close();

    const status = await runCliCapture(["migrate", "status"]);
    expect(status.code).not.toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ status: "blocked" });
    expect(status.stdout).toMatch(/pending proposal.*unmappable legacy ref/i);
  });

  test("an already-current apply quarantines terminal legacy refs and becomes current", async () => {
    fs.writeFileSync(getConfigPath(), '{"configVersion":"0.9.0","semanticSearchMode":"off"}\n', { mode: 0o600 });
    const state = openStateDbAtCeiling(getStateDbPathInDataDir(), STATE_MIGRATIONS.at(-1)?.id ?? "");
    state
      .prepare(
        "INSERT INTO proposals(id, stash_dir, ref, status, source, created_at, updated_at, content, frontmatter_json, metadata_json) VALUES (?, '/stash', ?, 'rejected', 'legacy', 'c', 'u', 'body', NULL, '{}')",
      )
      .run("abababab-abab-4bab-8bab-abababababab", retiredRef("lesson", "terminal"));
    state.close();

    const status = await runCliCapture(["migrate", "status"]);
    expect(status.code, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ status: "ready" });
    const applied = await runCliCapture(["migrate", "apply"]);
    expect(applied.code, applied.stderr).toBe(0);
    expect(applied.stdout).toContain('"event":"proposal-ref-repair"');

    const repaired = new Database(getStateDbPathInDataDir(), { readonly: true });
    try {
      expect(repaired.query("SELECT COUNT(*) AS count FROM proposals").get()).toEqual({ count: 0 });
      expect(repaired.query("SELECT old_ref, row_count FROM legacy_state").get()).toEqual({
        old_ref: retiredRef("lesson", "terminal"),
        row_count: 1,
      });
    } finally {
      repaired.close();
    }
  });

  test("rekeys mapped rows and quarantines unmappable terminal rows in one transaction", () => {
    const statePath = getStateDbPathInDataDir();
    const state = openStateDbAtCeiling(statePath, PRE_CUTOVER_STATE_CEILING);
    state.exec(`
      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY, stash_dir TEXT, ref TEXT, status TEXT, source TEXT,
        created_at TEXT, updated_at TEXT, content TEXT, frontmatter_json TEXT, metadata_json TEXT
      )
    `);
    const insert = state.prepare(
      "INSERT INTO proposals VALUES (?, '/stash', ?, ?, 'legacy', 'created', 'updated', 'content', NULL, '{\"changes\":[{\"path\":\"\",\"op\":\"update\"}]}')",
    );
    insert.run("11111111-1111-4111-8111-111111111111", retiredRef("lesson", "mapped"), "accepted");
    insert.run("22222222-2222-4222-8222-222222222222", retiredRef("lesson", "orphan"), "rejected");
    state.close();

    expect(
      repairAlreadyCurrentProposalRefs(statePath, new Map([[retiredRef("lesson", "mapped"), "stash//lessons/mapped"]])),
    ).toEqual({
      rekeyed: 1,
      quarantined: 1,
    });
    const repaired = new Database(statePath, { readonly: true });
    try {
      expect(repaired.query("SELECT ref FROM proposals").all()).toEqual([{ ref: "stash//lessons/mapped" }]);
      const retained = repaired.query("SELECT old_ref, row_json FROM legacy_state_rows").get() as {
        old_ref: string;
        row_json: string;
      };
      expect(retained.old_ref).toBe(retiredRef("lesson", "orphan"));
      expect(JSON.parse(retained.row_json)).toMatchObject({
        id: "22222222-2222-4222-8222-222222222222",
        ref: retiredRef("lesson", "orphan"),
        status: "rejected",
        content: "content",
      });
    } finally {
      repaired.close();
    }
  });

  test("fails transactionally for an unmappable pending row", () => {
    const statePath = getStateDbPathInDataDir();
    const state = openStateDbAtCeiling(statePath, PRE_CUTOVER_STATE_CEILING);
    state.exec(`
      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY, stash_dir TEXT, ref TEXT, status TEXT, source TEXT,
        created_at TEXT, updated_at TEXT, content TEXT, frontmatter_json TEXT, metadata_json TEXT
      );
    `);
    state
      .prepare("INSERT INTO proposals VALUES (?, '/stash', ?, 'pending', 'legacy', 'c', 'u', 'body', NULL, '{}')")
      .run("33333333-3333-4333-8333-333333333333", retiredRef("lesson", "pending"));
    state.close();

    expect(() => repairAlreadyCurrentProposalRefs(statePath, new Map())).toThrow(/pending proposal.*unmappable/i);
    const preserved = new Database(statePath, { readonly: true });
    try {
      expect(preserved.query("SELECT ref FROM proposals").get()).toEqual({ ref: retiredRef("lesson", "pending") });
      expect(
        preserved.query("SELECT name FROM sqlite_master WHERE type='table' AND name='legacy_state_rows'").get(),
      ).toBeNull();
    } finally {
      preserved.close();
    }
  });
});
