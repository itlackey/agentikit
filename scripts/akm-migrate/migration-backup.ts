// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  migrateConfigSourcesToBundles,
  migratedLockEntries,
  oldConfigToSearchSources,
} from "./migrate/legacy/config-source-migration";
import { getLegacyWorkflowDbPath } from "./migrate/legacy/legacy-paths";
import { FROZEN_WORKFLOW_MIGRATIONS } from "./migrate/legacy/workflow-migrations-bodies";
import {
  createTaskMigrationBackup,
  restoreTaskMigrationBackup,
  type TaskMigrationBackupManifest,
  verifyTaskMigrationBackup,
} from "./migrate/task-v2-to-v3-files";
import type { TaskV2ToV3MigrationPlan } from "../../src/tasks/migrate-v2-to-v3";
import { MAX_CONFIG_FILE_BYTES, MAX_LOCAL_METADATA_BYTES, readTextFileWithLimit, writeFileAtomic } from "../../src/core/common";
import { resetConfigCache } from "../../src/core/config/config";
import { parseConfigText, withConfigLock } from "../../src/core/config/config-io";
import { CURRENT_CONFIG_VERSION, validateConfigShape } from "../../src/core/config/config-schema";
import { compareConfigVersion } from "../../src/core/config/config-version";
import { ConfigError } from "../../src/core/errors";
import {
  createLockPayload,
  probeLock,
  reclaimStaleLock,
  releaseLock,
  tryAcquireLockSync,
} from "../../src/core/file-lock";
import { acquireMaintenanceActivitySync, withMaintenanceStartBarrier } from "../../src/core/maintenance-barrier";
import {
  getMigrationApplyJournalPath,
  getMigrationGeneratedConfigPath,
  getMigrationOperationRoot,
  getMigrationRestoreJournalPath,
} from "../../src/core/migration-operation";
import {
  getConfigPath,
  getDataDir,
  getDbPath,
  getIndexWriterLockPath,
  getLockfileLockPath,
  getLockfilePath,
  getStateDbPathInDataDir,
} from "../../src/core/paths";
import { STATE_MIGRATIONS } from "../../src/core/state/migrations";
import { type Database, openDatabaseFinalizing } from "../../src/storage/database";
import {
  inspectMigrationLedger,
  type Migration,
  type MigrationLedgerState,
} from "../../src/storage/engines/sqlite-migrations";

export const MIGRATION_BACKUP_VERSION = "0.9.0" as const;
const MANIFEST_FORMAT_VERSION = 4 as const;
const RESTORE_SENTINEL_FORMAT_VERSION = 1 as const;
const ARTIFACT_NAMES = ["config.json", "state.db", "workflow.db", "index.db"] as const;
type ArtifactName = (typeof ARTIFACT_NAMES)[number];

export type MigrationArtifactStatus = "old" | "current" | "newer" | "inconsistent" | "missing" | "corrupt";

export interface MigrationArtifactState {
  status: MigrationArtifactStatus;
  migrationIds?: string[];
  detail?: string;
}

export interface MigrationState {
  config: MigrationArtifactState;
  state: MigrationArtifactState;
  workflow: MigrationArtifactState;
  index: MigrationArtifactState;
}

export interface MigrationBackupArtifact extends MigrationArtifactState {
  sourcePath: string;
  present: boolean;
  createdAt: string;
}

export interface MigrationBackupManifest {
  formatVersion: typeof MANIFEST_FORMAT_VERSION;
  version: typeof MIGRATION_BACKUP_VERSION;
  targetVersion: typeof MIGRATION_BACKUP_VERSION;
  installationId: string;
  runId: string;
  createdAt: string;
  complete: true;
  artifacts: Record<ArtifactName, MigrationBackupArtifact>;
  /** Optional immutable external-task leg, bound to this apply operation. */
  taskMigration?: TaskMigrationBackupManifest;
}

export interface MigrationBackupResult {
  path: string;
  created: boolean;
  manifest: MigrationBackupManifest;
  rescuePath?: string;
}

export interface MigrationInspectionPaths {
  stateDbPath?: string;
  workflowDbPath?: string;
  indexDbPath?: string;
}

interface RestoreSentinel {
  formatVersion: typeof RESTORE_SENTINEL_FORMAT_VERSION;
  version: typeof MIGRATION_BACKUP_VERSION;
  sourceRunId: string;
  rescueRunId: string;
}

export function getMigrationBackupRoot(): string {
  return getMigrationOperationRoot();
}

export { getMigrationApplyJournalPath, getMigrationGeneratedConfigPath, getMigrationRestoreJournalPath };

export function getMigrationBackupDir(runId?: string): string {
  if (!runId) return getMigrationBackupRoot();
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new ConfigError(`Invalid migration backup run ID ${JSON.stringify(runId)}.`, "INVALID_CONFIG_FILE");
  }
  return path.join(getMigrationBackupRoot(), runId);
}

function expectedSourcePaths(): Record<ArtifactName, string> {
  return {
    "config.json": getConfigPath(),
    "state.db": getStateDbPathInDataDir(),
    "workflow.db": getLegacyWorkflowDbPath(),
    "index.db": getDbPath(),
  };
}

function fsyncFile(filePath: string): void {
  const fd = fs.openSync(filePath, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  try {
    const fd = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR" && code !== "EPERM") throw error;
  }
}

function copyFileDurable(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, 0o600);
  fsyncFile(destination);
}

function ownerOnlyMode(filePath: string, directory: boolean): boolean {
  if (process.platform === "win32") return true;
  return (fs.statSync(filePath).mode & 0o777) === (directory ? 0o700 : 0o600);
}

function mapLedgerState(state: MigrationLedgerState): MigrationArtifactState {
  return {
    status: state.status,
    migrationIds: state.migrationIds,
    ...(state.detail ? { detail: state.detail } : {}),
  };
}

function isPreCutoverSourceShape(raw: Record<string, unknown>): boolean {
  if (raw.bundles !== undefined) return false;
  return (
    (typeof raw.stashDir === "string" && raw.stashDir.length > 0) ||
    Array.isArray(raw.sources) ||
    Array.isArray(raw.installed)
  );
}

function inspectConfig(configPath: string): MigrationArtifactState {
  if (!fs.existsSync(configPath)) return { status: "missing" };
  try {
    const raw = parseConfigText(readTextFileWithLimit(configPath, MAX_CONFIG_FILE_BYTES, "Config file"), configPath);
    const comparison = compareConfigVersion(raw.configVersion as string | number | undefined, CURRENT_CONFIG_VERSION);
    if (comparison === undefined) {
      // 0.8.x only stamps `configVersion` when a 0.7-era migration actually did
      // something (`if (changed)`); a config freshly written by 0.8 itself
      // (`akm setup`/`akm init`, no legacy keys to carry forward) has no
      // legacy-migration work to trigger that stamp and so ships with NO
      // `configVersion` key at all — not an invalid one, an absent one. Read
      // that specific case as pre-cutover `old`, the same status a config
      // explicitly versioned "0.8.0" would get below, rather than the
      // unconditional-blocker `inconsistent` status: every fresh-0.8 install
      // would otherwise be permanently unable to run `migrate apply`.
      // Gate tightly on the shape actually being pre-cutover 0.8 (no
      // `bundles`, plus a legacy source key) so this cannot silently swallow
      // a config whose `configVersion` is merely garbage/unparseable — that
      // must stay `inconsistent`.
      if (raw.configVersion === undefined && isPreCutoverSourceShape(raw)) return { status: "old" };
      return { status: "inconsistent", detail: "configVersion is missing or invalid" };
    }
    if (comparison < 0) return { status: "old" };
    if (comparison > 0) return { status: "newer" };
    if (isPreCutoverSourceShape(raw)) {
      const migrated = validateConfigShape(migrateConfigSourcesToBundles(raw));
      return migrated.ok
        ? { status: "old" }
        : {
            status: "corrupt",
            detail: migrated.errors.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
          };
    }
    const validated = validateConfigShape(raw);
    return validated.ok
      ? { status: "current" }
      : {
          status: "corrupt",
          detail: validated.errors.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
        };
  } catch (error) {
    return { status: "corrupt", detail: error instanceof Error ? error.message : String(error) };
  }
}

function quickCheck(db: Database, filePath: string): void {
  const rows = db.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
  if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== "ok") {
    throw new ConfigError(`SQLite quick_check failed for ${filePath}.`, "INVALID_CONFIG_FILE");
  }
}

function inspectSqlite(filePath: string, migrations: readonly Migration[]): MigrationArtifactState {
  if (!fs.existsSync(filePath)) return { status: "missing" };
  let db: ReturnType<typeof openDatabaseFinalizing> | undefined;
  try {
    db = openDatabaseFinalizing(filePath, { readonly: true, create: false });
    quickCheck(db, filePath);
    return mapLedgerState(inspectMigrationLedger(db, migrations));
  } catch (error) {
    return { status: "corrupt", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    db?.close();
  }
}

function inspectIndex(filePath: string): MigrationArtifactState {
  if (!fs.existsSync(filePath)) return { status: "missing" };
  let db: ReturnType<typeof openDatabaseFinalizing> | undefined;
  try {
    db = openDatabaseFinalizing(filePath, { readonly: true, create: false });
    quickCheck(db, filePath);
    return { status: "current" };
  } catch (error) {
    return { status: "corrupt", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    db?.close();
  }
}

function inspectArtifact(name: ArtifactName, filePath: string): MigrationArtifactState {
  if (name === "config.json") return inspectConfig(filePath);
  if (name === "state.db") return inspectSqlite(filePath, STATE_MIGRATIONS);
  if (name === "workflow.db") return inspectSqlite(filePath, FROZEN_WORKFLOW_MIGRATIONS);
  return inspectIndex(filePath);
}

export function inspectMigrationState(paths: MigrationInspectionPaths = {}): MigrationState {
  return {
    config: inspectConfig(getConfigPath()),
    state: inspectSqlite(paths.stateDbPath ?? getStateDbPathInDataDir(), STATE_MIGRATIONS),
    workflow: inspectSqlite(paths.workflowDbPath ?? getLegacyWorkflowDbPath(), FROZEN_WORKFLOW_MIGRATIONS),
    index: inspectIndex(paths.indexDbPath ?? getDbPath()),
  };
}

function stateForName(state: MigrationState, name: ArtifactName): MigrationArtifactState {
  if (name === "config.json") return state.config;
  if (name === "state.db") return state.state;
  if (name === "workflow.db") return state.workflow;
  return state.index;
}

function sameState(actual: MigrationArtifactState, expected: MigrationArtifactState): boolean {
  return (
    actual.status === expected.status &&
    JSON.stringify(actual.migrationIds ?? []) === JSON.stringify(expected.migrationIds ?? [])
  );
}

function assertBackupEligible(state: MigrationState, allowCorruptIndex = false): void {
  const unsafe = (Object.entries(state) as Array<[keyof MigrationState, MigrationArtifactState]>).filter(
    ([name, artifact]) =>
      ["newer", "inconsistent", "corrupt"].includes(artifact.status) &&
      !(allowCorruptIndex && name === "index" && artifact.status === "corrupt"),
  );
  if (unsafe.length > 0) {
    throw new ConfigError(
      `Refusing migration backup because artifact state is unsafe: ${unsafe
        .map(([name, artifact]) => `${name === "config" ? "config.json" : `${name}.db`}=${artifact.status}`)
        .join(", ")}.`,
      "INVALID_CONFIG_FILE",
    );
  }
}

function sqliteQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function backupSqlite(source: string, destination: string): void {
  const resolved = path.resolve(source);
  const releaseActivity =
    resolved === path.resolve(getStateDbPathInDataDir())
      ? acquireMaintenanceActivitySync("state-db")
      : resolved === path.resolve(getLegacyWorkflowDbPath())
        ? acquireMaintenanceActivitySync("workflow-db")
        : undefined;
  let db: ReturnType<typeof openDatabaseFinalizing> | undefined;
  try {
    db = openDatabaseFinalizing(source);
    db.exec("PRAGMA busy_timeout = 10000");
    db.exec(`VACUUM INTO ${sqliteQuote(destination)}`);
  } finally {
    try {
      db?.close();
    } finally {
      releaseActivity?.();
    }
  }
  fs.chmodSync(destination, 0o600);
  fsyncFile(destination);
}

function acquireBackupLock(): () => void {
  const lockPath = path.join(getMigrationBackupRoot(), ".lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const ownership = tryAcquireLockSync(lockPath, createLockPayload());
    if (ownership) return () => releaseLock(ownership);
    const probe = probeLock(lockPath);
    if (probe.state === "stale" && reclaimStaleLock(lockPath, probe)) continue;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  throw new ConfigError(`Timed out waiting for migration backup lock at ${lockPath}.`, "INVALID_CONFIG_FILE");
}

function withBackupLock<T>(run: () => T): T {
  const release = acquireBackupLock();
  try {
    return run();
  } finally {
    release();
  }
}

function newRunId(): string {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${process.pid}-${randomUUID()}`;
}

export interface CreateMigrationBackupOptions {
  allowCorruptIndex?: boolean;
  operationId?: string;
  taskPlan?: TaskV2ToV3MigrationPlan;
}

function createMigrationBackupUnlocked(options: CreateMigrationBackupOptions = {}): MigrationBackupResult {
  const state = inspectMigrationState();
  assertBackupEligible(state, options.allowCorruptIndex);
  const root = getMigrationBackupRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  const runId = newRunId();
  const bundlePath = path.join(root, runId);
  const temporary = path.join(root, `.${runId}.tmp`);
  fs.mkdirSync(temporary, { mode: 0o700 });
  const createdAt = new Date().toISOString();
  const sources = expectedSourcePaths();
  const artifacts = {} as Record<ArtifactName, MigrationBackupArtifact>;

  try {
    for (const name of ARTIFACT_NAMES) {
      const sourcePath = sources[name];
      const sourceState = stateForName(state, name);
      const present = sourceState.status !== "missing";
      const destination = path.join(temporary, name);
      if (present) {
        if (name === "config.json" || (name === "index.db" && sourceState.status === "corrupt")) {
          copyFileDurable(sourcePath, destination);
        } else {
          backupSqlite(sourcePath, destination);
        }
      }
      const copied = present ? inspectArtifact(name, destination) : { status: "missing" as const };
      if (!sameState(copied, sourceState)) {
        throw new ConfigError(`Backup ${name} does not match its source state.`, "INVALID_CONFIG_FILE");
      }
      artifacts[name] = { ...sourceState, sourcePath, present, createdAt };
    }

    const taskMigration = options.taskPlan
      ? createTaskMigrationBackup(temporary, options.taskPlan, options.operationId ?? "")
      : undefined;
    const manifest: MigrationBackupManifest = {
      formatVersion: MANIFEST_FORMAT_VERSION,
      version: MIGRATION_BACKUP_VERSION,
      targetVersion: MIGRATION_BACKUP_VERSION,
      installationId: path.basename(getMigrationOperationRoot()),
      runId,
      createdAt,
      complete: true,
      artifacts,
      ...(taskMigration ? { taskMigration } : {}),
    };
    writeFileAtomic(path.join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
    fsyncDirectory(temporary);
    fs.renameSync(temporary, bundlePath);
    fsyncDirectory(root);
    return { path: bundlePath, created: true, manifest: verifyMigrationBackup(bundlePath) };
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function parseManifest(bundlePath: string): MigrationBackupManifest {
  const manifestPath = path.join(bundlePath, "manifest.json");
  let value: unknown;
  try {
    value = JSON.parse(readTextFileWithLimit(manifestPath, MAX_LOCAL_METADATA_BYTES, "Migration manifest"));
  } catch (error) {
    throw new ConfigError(
      `Migration backup at ${bundlePath} is incomplete or unreadable: ${error instanceof Error ? error.message : String(error)}.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const manifest = value as Partial<MigrationBackupManifest>;
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.formatVersion !== MANIFEST_FORMAT_VERSION ||
    manifest.version !== MIGRATION_BACKUP_VERSION ||
    manifest.targetVersion !== MIGRATION_BACKUP_VERSION ||
    manifest.installationId !== path.basename(getMigrationOperationRoot()) ||
    typeof manifest.runId !== "string" ||
    path.basename(bundlePath) !== manifest.runId ||
    typeof manifest.createdAt !== "string" ||
    manifest.complete !== true
  ) {
    throw new ConfigError(`Migration backup manifest at ${manifestPath} is invalid.`, "INVALID_CONFIG_FILE");
  }
  const sources = expectedSourcePaths();
  for (const name of ARTIFACT_NAMES) {
    const artifact = manifest.artifacts?.[name];
    const allowed = name === "index.db" ? ["current", "missing", "corrupt"] : ["old", "current", "missing"];
    if (
      !artifact ||
      artifact.sourcePath !== sources[name] ||
      typeof artifact.present !== "boolean" ||
      typeof artifact.createdAt !== "string" ||
      !allowed.includes(artifact.status) ||
      (artifact.present === (artifact.status === "missing")) ||
      (artifact.migrationIds !== undefined &&
        (!Array.isArray(artifact.migrationIds) || !artifact.migrationIds.every((id) => typeof id === "string")))
    ) {
      throw new ConfigError(`Migration backup manifest has an invalid ${name} entry.`, "INVALID_CONFIG_FILE");
    }
  }
  if (manifest.taskMigration !== undefined) {
    const taskMigration = manifest.taskMigration as Partial<TaskMigrationBackupManifest>;
    if (
      !taskMigration ||
      typeof taskMigration !== "object" ||
      Array.isArray(taskMigration) ||
      taskMigration.schemaVersion !== 1 ||
      typeof taskMigration.operationId !== "string" ||
      typeof taskMigration.generation !== "string" ||
      taskMigration.recoveryPath !== "tasks/recovery.json" ||
      !Array.isArray(taskMigration.files)
    ) {
      throw new ConfigError("Migration backup manifest has an invalid taskMigration declaration.", "INVALID_CONFIG_FILE");
    }
  }
  return manifest as MigrationBackupManifest;
}

export function verifyMigrationBackup(bundlePath = resolveBackupRun()): MigrationBackupManifest {
  if (!fs.existsSync(bundlePath) || !fs.statSync(bundlePath).isDirectory()) {
    throw new ConfigError(`Migration backup does not exist at ${bundlePath}.`, "INVALID_CONFIG_FILE");
  }
  if (!ownerOnlyMode(bundlePath, true)) {
    throw new ConfigError(`Migration backup directory ${bundlePath} must have mode 0700.`, "INVALID_CONFIG_FILE");
  }
  const manifest = parseManifest(bundlePath);
  const expectedFiles = new Set(["manifest.json"]);
  for (const name of ARTIFACT_NAMES) {
    const artifact = manifest.artifacts[name];
    const artifactPath = path.join(bundlePath, name);
    if (!artifact.present) {
      if (fs.existsSync(artifactPath)) {
        throw new ConfigError(`Migration backup contains unexpected ${name}.`, "INVALID_CONFIG_FILE");
      }
      continue;
    }
    expectedFiles.add(name);
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile() || !ownerOnlyMode(artifactPath, false)) {
      throw new ConfigError(`Migration backup artifact ${artifactPath} is missing or unreadable.`, "INVALID_CONFIG_FILE");
    }
    const inspected = inspectArtifact(name, artifactPath);
    if (!sameState(inspected, artifact)) {
      throw new ConfigError(
        `Migration backup artifact ${name} failed semantic verification: expected ${artifact.status}, got ${inspected.status}.`,
        "INVALID_CONFIG_FILE",
      );
    }
  }
  if (!ownerOnlyMode(path.join(bundlePath, "manifest.json"), false)) {
    throw new ConfigError("Migration backup manifest must have mode 0600.", "INVALID_CONFIG_FILE");
  }
  if (manifest.taskMigration) {
    expectedFiles.add("tasks");
    verifyTaskMigrationBackup(bundlePath, manifest.taskMigration);
  }
  const extras = fs.readdirSync(bundlePath).filter((name) => !expectedFiles.has(name));
  if (extras.length > 0) {
    throw new ConfigError(`Migration backup contains unexpected files: ${extras.join(", ")}.`, "INVALID_CONFIG_FILE");
  }
  return manifest;
}

export function createMigrationBackup(): MigrationBackupResult {
  return withConfigLock(() => withBackupLock(() => withMaintenanceStartBarrier(createMigrationBackupUnlocked)));
}

export function ensureMigrationBackupWithConfigLockHeld(options: CreateMigrationBackupOptions = {}): MigrationBackupResult {
  return withBackupLock(() => withMaintenanceStartBarrier(() => createMigrationBackupUnlocked(options)));
}

export function ensureMigrationBackup(): MigrationBackupResult {
  return createMigrationBackup();
}

const LOCK_FILE_SAMPLE_LIMIT = 100;
const MAX_BLOCKER_MESSAGE_BYTES = 16 * 1024;
const STATIC_OPERATION_LOCKS = ["improve.lock", "consolidate.lock", "reflect-distill.lock", "triage.lock"];

function expandTilde(value: string): string {
  if (value === "~") return process.env.HOME ?? value;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(process.env.HOME ?? "~", value.slice(2));
  }
  return value;
}

function resolveStashRoot(value: string, pathResolutionBase = process.cwd()): string {
  return path.resolve(pathResolutionBase, expandTilde(value));
}

function configStashRoots(configPath: string, pathResolutionBase = process.cwd()): string[] {
  try {
    const raw = parseConfigText(
      readTextFileWithLimit(configPath, MAX_CONFIG_FILE_BYTES, "Migration config"),
      configPath,
    );
    const roots = new Set(
      oldConfigToSearchSources(raw, pathResolutionBase).map((source) => path.resolve(source.path)),
    );
    const migrated = migrateConfigSourcesToBundles(raw);
    const bundles = migrated.bundles;
    if (bundles && typeof bundles === "object" && !Array.isArray(bundles)) {
      for (const bundle of Object.values(bundles)) {
        if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) continue;
        const bundlePath = (bundle as Record<string, unknown>).path;
        if (typeof bundlePath === "string" && bundlePath.trim()) {
          roots.add(resolveStashRoot(bundlePath, pathResolutionBase));
        }
      }
    }
    for (const entry of migratedLockEntries(raw)) {
      if (entry.localRoot) roots.add(resolveStashRoot(entry.localRoot, pathResolutionBase));
    }
    return [...roots];
  } catch {
    return [];
  }
}

function currentStashRoots(): string[] {
  const roots = new Set(configStashRoots(getConfigPath()));
  const envRoot = process.env.AKM_BUNDLE_DIR?.trim();
  if (envRoot) roots.add(resolveStashRoot(envRoot));
  try {
    const lockEntries = JSON.parse(
      readTextFileWithLimit(getLockfilePath(), MAX_LOCAL_METADATA_BYTES, "AKM lockfile"),
    ) as unknown;
    if (Array.isArray(lockEntries)) {
      for (const entry of lockEntries) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const localRoot = (entry as Record<string, unknown>).localRoot;
        if (typeof localRoot === "string" && localRoot.trim()) roots.add(resolveStashRoot(localRoot));
      }
    }
  } catch {
    // Config and lockfile validation report malformed inputs separately.
  }
  return [...roots];
}

function lockFiles(directory: string): { paths: string[]; overflow: boolean } {
  try {
    const paths = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".lock"))
      .map((entry) => path.join(directory, entry.name));
    return { paths: paths.slice(0, LOCK_FILE_SAMPLE_LIMIT), overflow: paths.length > LOCK_FILE_SAMPLE_LIMIT };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { paths: [], overflow: false };
    throw error;
  }
}

function activeLockPaths(stashRoots: readonly string[] = []): string[] {
  const dataDir = getDataDir();
  const configLock = path.join(path.dirname(getConfigPath()), "config.json.lck");
  const roots = new Set([...currentStashRoots(), ...stashRoots.map((root) => path.resolve(root))]);
  const lockBases = [dataDir, ...[...roots].map((root) => path.join(root, ".akm"))];
  const lockDirectories = lockBases.flatMap((base) => [
    path.join(base, "extract-locks"),
    path.join(base, "maintenance-activities"),
  ]);
  const samples = lockDirectories.map((directory) => ({ directory, ...lockFiles(directory) }));
  const candidates = new Set([
    configLock,
    getLockfileLockPath(),
    getIndexWriterLockPath(),
    ...lockBases.flatMap((base) => STATIC_OPERATION_LOCKS.map((name) => path.join(base, name))),
    ...samples.flatMap((sample) => sample.paths),
  ]);
  const blockers = [...candidates].filter((lockPath) => {
    const probe = probeLock(lockPath);
    return probe.state === "held" && (lockPath !== configLock || probe.holderPid !== process.pid);
  });
  blockers.push(
    ...samples
      .filter((sample) => sample.overflow)
      .map(
        (sample) =>
          `${sample.directory} contains more than ${LOCK_FILE_SAMPLE_LIMIT} lock files; unsampled locks cannot be proven stale`,
      ),
  );
  return blockers;
}

function tableColumns(db: Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
}

function workflowBlockersAt(dbPath: string): string[] {
  if (!fs.existsSync(dbPath)) return [];
  const db = openDatabaseFinalizing(dbPath, { readonly: true, create: false });
  try {
    const blockers: string[] = [];
    const hasRuns = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_runs'").get();
    if (hasRuns) {
      const columns = tableColumns(db, "workflow_runs");
      if (columns.has("engine_lease_holder") && columns.has("engine_lease_until")) {
        const rows = db
          .prepare(
            "SELECT id, engine_lease_holder AS holder, engine_lease_until AS expires FROM workflow_runs WHERE engine_lease_holder IS NOT NULL AND engine_lease_until >= ? LIMIT 21",
          )
          .all(new Date().toISOString()) as Array<{ id: string; holder: string; expires: string }>;
        blockers.push(...rows.slice(0, 20).map((row) => `${dbPath}#run=${row.id},holder=${row.holder},expires=${row.expires}`));
        if (rows.length > 20) blockers.push(`${dbPath}#additional-active-workflow-blockers`);
      }
    }
    const hasUnits = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_run_units'").get();
    if (hasUnits) {
      const columns = tableColumns(db, "workflow_run_units");
      if (columns.has("claim_holder") && columns.has("claim_expires_at")) {
        const rows = db
          .prepare(
            "SELECT run_id AS runId, unit_id AS unitId, claim_holder AS holder, claim_expires_at AS expires FROM workflow_run_units WHERE status='running' AND claim_holder IS NOT NULL AND claim_expires_at >= ? LIMIT 21",
          )
          .all(new Date().toISOString()) as Array<{
          runId: string;
          unitId: string;
          holder: string;
          expires: string;
        }>;
        blockers.push(
          ...rows
            .slice(0, 20)
            .map((row) => `${dbPath}#run=${row.runId},unit=${row.unitId},holder=${row.holder},expires=${row.expires}`),
        );
        if (rows.length > 20) blockers.push(`${dbPath}#additional-active-workflow-blockers`);
      }
    }
    return blockers;
  } finally {
    db.close();
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function safeBlocker(value: string): string {
  return truncateUtf8(value.replace(/[\u0000-\u001f\u007f]/g, "?"), 500);
}

function blockerMessage(blockers: readonly string[]): string {
  const prefix = "Refusing artifact replacement while AKM locks, activities, or workflow leases are active: ";
  const omittedSuffix = ", additional blockers omitted.";
  let body = "";
  let included = 0;
  for (const blocker of blockers) {
    const next = `${body ? ", " : ""}${safeBlocker(blocker)}`;
    if (Buffer.byteLength(prefix + body + next + omittedSuffix) > MAX_BLOCKER_MESSAGE_BYTES) break;
    body += next;
    included++;
  }
  return `${prefix}${body}${included < blockers.length ? omittedSuffix : "."}`;
}

export function assertNoArtifactReplacementBlockers(
  _bundlePath?: string,
  options?: { skipWorkflowClaims?: boolean; stashRoots?: readonly string[] },
): void {
  const blockers = activeLockPaths(options?.stashRoots);
  if (!options?.skipWorkflowClaims) {
    blockers.push(...workflowBlockersAt(getStateDbPathInDataDir()), ...workflowBlockersAt(getLegacyWorkflowDbPath()));
  }
  if (blockers.length > 0) {
    throw new ConfigError(blockerMessage(blockers), "INVALID_CONFIG_FILE");
  }
}

function resolveBackupRun(runId?: string): string {
  if (runId) return getMigrationBackupDir(runId);
  const root = getMigrationBackupRoot();
  const runs = fs.existsSync(root)
    ? fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => ({ name: entry.name, mtime: fs.statSync(path.join(root, entry.name)).mtimeMs }))
        .sort((left, right) => left.mtime - right.mtime || left.name.localeCompare(right.name))
    : [];
  const latest = runs.at(-1)?.name;
  if (!latest) throw new ConfigError(`No migration backup runs exist under ${root}.`, "INVALID_CONFIG_FILE");
  return getMigrationBackupDir(latest);
}

function restoreSentinelPath(): string {
  return getMigrationRestoreJournalPath();
}

function readRestoreSentinel(): RestoreSentinel | undefined {
  if (!fs.existsSync(restoreSentinelPath())) return undefined;
  let value: Partial<RestoreSentinel>;
  try {
    value = JSON.parse(
      readTextFileWithLimit(restoreSentinelPath(), MAX_LOCAL_METADATA_BYTES, "Restore sentinel"),
    ) as Partial<RestoreSentinel>;
  } catch (error) {
    throw new ConfigError(
      `Unreadable restore sentinel at ${restoreSentinelPath()}: ${error instanceof Error ? error.message : String(error)}.`,
      "INVALID_CONFIG_FILE",
    );
  }
  if (
    value.formatVersion !== RESTORE_SENTINEL_FORMAT_VERSION ||
    value.version !== MIGRATION_BACKUP_VERSION ||
    typeof value.sourceRunId !== "string" ||
    !/^[A-Za-z0-9._-]+$/.test(value.sourceRunId) ||
    typeof value.rescueRunId !== "string" ||
    !/^[A-Za-z0-9._-]+$/.test(value.rescueRunId)
  ) {
    throw new ConfigError(`Invalid restore sentinel at ${restoreSentinelPath()}.`, "INVALID_CONFIG_FILE");
  }
  return value as RestoreSentinel;
}

function writeRestoreSentinel(sentinel: RestoreSentinel): void {
  fs.mkdirSync(path.dirname(restoreSentinelPath()), { recursive: true, mode: 0o700 });
  writeFileAtomic(restoreSentinelPath(), `${JSON.stringify(sentinel, null, 2)}\n`, 0o600);
}

function clearRestoreSentinel(): void {
  fs.rmSync(restoreSentinelPath(), { force: true });
  fsyncDirectory(path.dirname(restoreSentinelPath()));
}

function failRestoreAfterForTests(name: ArtifactName): void {
  if (process.env.AKM_TEST_MIGRATION_FAIL_RESTORE_AFTER === name) {
    throw new Error(`injected restore interruption after ${name}`);
  }
}

function publishBackup(bundlePath: string, manifest: MigrationBackupManifest): void {
  if (manifest.taskMigration) {
    restoreTaskMigrationBackup(bundlePath, manifest.taskMigration, {
      afterPublish(filePath) {
        if (process.env.AKM_TEST_MIGRATION_FAIL_RESTORE_TASK_AFTER === path.basename(filePath)) {
          throw new Error(`injected task restore interruption after ${filePath}`);
        }
      },
    });
  }
  const order: ArtifactName[] = ["state.db", "workflow.db", "index.db", "config.json"];
  for (const name of order) {
    const artifact = manifest.artifacts[name];
    const destination = artifact.sourcePath;
    const sidecars = name === "config.json" ? [] : [`${destination}-wal`, `${destination}-shm`];
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    for (const sidecar of sidecars) fs.rmSync(sidecar, { force: true });

    if (!artifact.present) {
      fs.rmSync(destination, { force: true });
      fsyncDirectory(path.dirname(destination));
      failRestoreAfterForTests(name);
      continue;
    }

    const stage = `${destination}.restore-stage`;
    fs.rmSync(stage, { force: true });
    copyFileDurable(path.join(bundlePath, name), stage);
    const staged = inspectArtifact(name, stage);
    if (!sameState(staged, artifact)) {
      throw new ConfigError(`Staged restore artifact ${name} failed semantic verification.`, "INVALID_CONFIG_FILE");
    }
    fs.rmSync(destination, { force: true });
    fs.renameSync(stage, destination);
    fs.chmodSync(destination, 0o600);
    fsyncDirectory(path.dirname(destination));
    failRestoreAfterForTests(name);
  }

  for (const name of ARTIFACT_NAMES) {
    const artifact = manifest.artifacts[name];
    const actual = artifact.present ? inspectArtifact(name, artifact.sourcePath) : { status: "missing" as const };
    if (!sameState(actual, artifact)) {
      throw new ConfigError(`Restored ${name} failed semantic verification.`, "INVALID_CONFIG_FILE");
    }
  }
  resetConfigCache();
}

function recoverInterruptedRestore(): RestoreSentinel | undefined {
  const sentinel = readRestoreSentinel();
  if (!sentinel) return undefined;
  const sourcePath = getMigrationBackupDir(sentinel.sourceRunId);
  const manifest = verifyMigrationBackup(sourcePath);
  publishBackup(sourcePath, manifest);
  clearRestoreSentinel();
  return sentinel;
}

export function recoverInterruptedRestoreWithLocksHeld(): void {
  const pending = readRestoreSentinel();
  if (!pending) return;
  assertNoArtifactReplacementBlockers(undefined, {
    stashRoots: configStashRoots(path.join(getMigrationBackupDir(pending.sourceRunId), "config.json")),
  });
  recoverInterruptedRestore();
}

export function restoreMigrationBackup(confirm: boolean, runId?: string): MigrationBackupResult {
  if (!confirm) throw new ConfigError("Migration backup restore requires --confirm.", "INVALID_CONFIG_FILE");
  return withConfigLock(() =>
    withBackupLock(() =>
      withMaintenanceStartBarrier(() => {
        if (fs.existsSync(getMigrationApplyJournalPath())) {
          throw new ConfigError(
            `Migration apply recovery is pending at ${getMigrationApplyJournalPath()}; run \`akm-migrate apply\` before restore.`,
            "INVALID_CONFIG_FILE",
          );
        }
        assertNoArtifactReplacementBlockers();
        const pending = readRestoreSentinel();
        if (pending) {
          assertNoArtifactReplacementBlockers(undefined, {
            stashRoots: configStashRoots(path.join(getMigrationBackupDir(pending.sourceRunId), "config.json")),
          });
          recoverInterruptedRestore();
          const backupPath = getMigrationBackupDir(pending.sourceRunId);
          return {
            path: backupPath,
            created: false,
            manifest: verifyMigrationBackup(backupPath),
            rescuePath: getMigrationBackupDir(pending.rescueRunId),
          };
        }

        const bundlePath = resolveBackupRun(runId);
        const manifest = verifyMigrationBackup(bundlePath);
        assertNoArtifactReplacementBlockers(undefined, {
          stashRoots: configStashRoots(path.join(bundlePath, "config.json")),
        });
        const rescue = createMigrationBackupUnlocked({ allowCorruptIndex: true });
        writeRestoreSentinel({
          formatVersion: RESTORE_SENTINEL_FORMAT_VERSION,
          version: MIGRATION_BACKUP_VERSION,
          sourceRunId: manifest.runId,
          rescueRunId: rescue.manifest.runId,
        });
        publishBackup(bundlePath, manifest);
        clearRestoreSentinel();
        return { path: bundlePath, created: false, manifest, rescuePath: rescue.path };
      }),
    ),
  );
}
