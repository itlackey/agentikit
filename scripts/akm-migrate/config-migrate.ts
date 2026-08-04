// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXIT_CODES } from "../../src/cli/shared";
import { workflowStructureDiagnostics } from "../../src/core/adapter/adapters/akm-lint";
import { assetPathForName, stashDirFor } from "../../src/core/asset/asset-placement";
import { parseBundleRef } from "../../src/core/asset/asset-ref";
import { typeNameFromConceptId } from "../../src/core/asset/resolve-ref";
import { MAX_CONFIG_FILE_BYTES, MAX_LOCAL_METADATA_BYTES, readTextFileWithLimit, writeFileAtomic } from "../../src/core/common";
import {
  type AkmConfig,
  parseAndValidateConfigText,
  resetConfigCache,
  sanitizeConfigForWrite,
} from "../../src/core/config/config";
import { parseConfigText, withConfigLock } from "../../src/core/config/config-io";
import { ConfigError } from "../../src/core/errors";
import { withMaintenanceStartBarrier } from "../../src/core/maintenance-barrier";
import { getConfigPath, getDbPath, getStateDbPathInDataDir } from "../../src/core/paths";
import { runMigrations as runStateMigrations } from "../../src/core/state/migrations";
import { warn } from "../../src/core/warn";
import {
  assertMigrationLockfileReadable,
  isValidLockfileEntry,
  type LockfileEntry,
  mergeLockEntriesSync,
} from "../../src/integrations/lockfile";
import { type Database, openDatabaseFinalizing } from "../../src/storage/database";
import { runMigrations as runSqliteMigrations } from "../../src/storage/engines/sqlite-migrations";
import { deriveLegacyBundleIds, inferLegacyBundleIds } from "./migrate/legacy/bundle-id";
import {
  migrateConfigSourcesToBundles,
  migratedLockEntries,
  oldConfigToSearchSources,
} from "./migrate/legacy/config-source-migration";
import { type ContentMigrationReport, runContentMigration } from "./migrate/legacy/content-migration";
import { getLegacyWorkflowDbPath } from "./migrate/legacy/legacy-paths";
import { importLegacyProposalsIntoState } from "./migrate/legacy/proposal-fs-import";
import {
  applyTaskTargetRefMigration,
  planTaskTargetRefMigration,
} from "./migrate/legacy/task-target-ref-migration";
import {
  assertLegacyProposalRefsRepairable,
  buildCutoverRefMap,
  completeCutoverRefMap,
  countLegacyProposalRefs,
  type CutoverStashRoot,
  cutoverMergeCommitted,
  deleteWorkflowDb,
  loadCompletedCutoverRefMap,
  loadCutoverRefMap,
  migratePilotTreatmentFiles,
  quarantineIndexDb,
  rekeyStateDb,
  repairAlreadyCurrentProposalRefs,
  runThreeDbCutover,
} from "./migrate/legacy/three-db-cutover";
import { FROZEN_WORKFLOW_MIGRATIONS } from "./migrate/legacy/workflow-migrations-bodies";
import {
  assertNoArtifactReplacementBlockers,
  ensureMigrationBackupWithConfigLockHeld,
  getMigrationApplyJournalPath,
  getMigrationBackupDir,
  getMigrationBackupRoot,
  getMigrationRestoreJournalPath,
  inspectMigrationState,
  MIGRATION_BACKUP_VERSION,
  type MigrationArtifactState,
  type MigrationBackupManifest,
  type MigrationState,
  recoverInterruptedRestoreWithLocksHeld,
  verifyMigrationBackup,
} from "./migration-backup";

const MANUAL_GUIDANCE =
  "Provide a complete operator-prepared 0.9 config with --config. AKM does not guess profile-to-engine mappings.";
const APPLY_SENTINEL_FORMAT = 1 as const;

export interface MigrationCommandOptions {
  preparedConfigPath?: string;
  dryRun?: boolean;
}

export interface MigrationTargetState {
  status: "current" | "missing" | "corrupt";
  source: "active" | "prepared" | "none";
  path?: string;
  detail?: string;
}

export interface MigrationPlan {
  // R-090: `not-applicable` is a DISTINCT, non-error outcome from `blocked` —
  // it means "there is nothing on this machine to migrate", not "migration
  // cannot proceed". Consumers that gate on `status !== "blocked"` (e.g. the
  // self-update preflight, which only inspects the CLI's exit code) keep
  // working unchanged; only a consumer that narrowly matched `=== "ready"` to
  // mean "proceed" would need to widen to also treat `not-applicable` as
  // proceed-safe — grepped for that pattern across the tree and found none.
  status: "current" | "ready" | "blocked" | "not-applicable";
  artifacts: MigrationState;
  targetConfig: MigrationTargetState;
  blockers: string[];
  /** Human-readable context for a non-error `status` that isn't self-explanatory (currently only `not-applicable`). */
  message?: string;
  activeOperation?: { kind: "apply" | "restore"; sentinelPath: string };
}

interface ApplySentinel {
  formatVersion: typeof APPLY_SENTINEL_FORMAT;
  version: typeof MIGRATION_BACKUP_VERSION;
  operationId: string;
  installationId: string;
  backupRunId: string;
  backupPath: string;
  targetConfig: Record<string, unknown>;
  migrationLockEntries: LockfileEntry[];
  pathResolutionBase: string;
}

interface ApplySentinelRead {
  sentinel?: ApplySentinel;
  config?: AkmConfig;
  manifest?: MigrationBackupManifest;
  error?: string;
}

function isMigrationLockEntries(value: unknown): value is LockfileEntry[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) => isValidLockfileEntry(entry) && typeof entry.localRoot === "string" && entry.localRoot.length > 0,
    )
  );
}

function readApplySentinel(): ApplySentinelRead {
  const sentinelPath = getMigrationApplyJournalPath();
  if (!fs.existsSync(sentinelPath)) return {};

  let sentinel: ApplySentinel;
  try {
    const value = JSON.parse(
      readTextFileWithLimit(sentinelPath, MAX_LOCAL_METADATA_BYTES, "Migration apply sentinel"),
    ) as Partial<ApplySentinel>;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.formatVersion !== APPLY_SENTINEL_FORMAT ||
      value.version !== MIGRATION_BACKUP_VERSION ||
      typeof value.operationId !== "string" ||
      !/^[A-Za-z0-9._-]+$/.test(value.operationId) ||
      value.installationId !== path.basename(getMigrationBackupRoot()) ||
      typeof value.backupRunId !== "string" ||
      !/^[A-Za-z0-9._-]+$/.test(value.backupRunId) ||
      value.backupPath !== getMigrationBackupDir(value.backupRunId) ||
      !value.targetConfig ||
      typeof value.targetConfig !== "object" ||
      Array.isArray(value.targetConfig) ||
      !isMigrationLockEntries(value.migrationLockEntries) ||
      typeof value.pathResolutionBase !== "string" ||
      !path.isAbsolute(value.pathResolutionBase)
    ) {
      return { error: `Invalid migration apply sentinel at ${sentinelPath}.` };
    }
    sentinel = value as ApplySentinel;
  } catch (error) {
    return {
      error: `Unreadable migration apply sentinel at ${sentinelPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  try {
    const backupStat = fs.lstatSync(sentinel.backupPath);
    if (
      backupStat.isSymbolicLink() ||
      !backupStat.isDirectory() ||
      fs.realpathSync(path.dirname(sentinel.backupPath)) !== fs.realpathSync(getMigrationBackupRoot())
    ) {
      throw new ConfigError("Migration apply backup is not a canonical installation run directory.", "INVALID_CONFIG_FILE");
    }
    const config = parseMigrationTargetConfig(JSON.stringify(sentinel.targetConfig), sentinelPath);
    const manifest = verifyMigrationBackup(sentinel.backupPath);
    if (manifest.runId !== sentinel.backupRunId || manifest.installationId !== sentinel.installationId) {
      throw new ConfigError("Migration apply backup provenance does not match its manifest.", "INVALID_CONFIG_FILE");
    }
    return { sentinel, config, manifest };
  } catch (error) {
    return {
      sentinel,
      error: `Unreadable migration apply sentinel at ${sentinelPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function writeApplySentinel(sentinel: ApplySentinel): void {
  const sentinelPath = getMigrationApplyJournalPath();
  fs.mkdirSync(path.dirname(sentinelPath), { recursive: true, mode: 0o700 });
  const serialized = `${JSON.stringify(sentinel, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_LOCAL_METADATA_BYTES) {
    throw new ConfigError(
      `Migration apply sentinel would exceed the ${MAX_LOCAL_METADATA_BYTES}-byte metadata limit.`,
      "INVALID_CONFIG_FILE",
    );
  }
  writeFileAtomic(sentinelPath, serialized, 0o600);
}

function clearApplySentinel(): void {
  fs.rmSync(getMigrationApplyJournalPath(), { force: true });
}

function parseMigrationTargetConfig(text: string, sourcePath?: string): AkmConfig {
  const migrated = migrateConfigSourcesToBundles(parseConfigText(text, sourcePath));
  return parseAndValidateConfigText(JSON.stringify(migrated), sourcePath);
}

function loadTargetConfig(
  preparedConfigPath: string | undefined,
  artifacts: MigrationState,
): {
  state: MigrationTargetState;
  config?: AkmConfig;
  migrationLockEntries?: LockfileEntry[];
} {
  const targetPath = preparedConfigPath ?? (artifacts.config.status === "current" ? getConfigPath() : undefined);
  if (!targetPath) return { state: { status: "missing", source: "none", detail: MANUAL_GUIDANCE } };

  let text: string;
  try {
    text = readTextFileWithLimit(targetPath, MAX_CONFIG_FILE_BYTES, "Prepared migration config");
  } catch (error) {
    return {
      state: {
        status: "corrupt",
        source: preparedConfigPath ? "prepared" : "active",
        path: targetPath,
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }

  try {
    return {
      state: {
        status: "current",
        source: preparedConfigPath ? "prepared" : "active",
        path: targetPath,
      },
      config: parseMigrationTargetConfig(text, targetPath),
      migrationLockEntries: migratedLockEntries(parseConfigText(text, targetPath)),
    };
  } catch (error) {
    return {
      state: {
        status: "corrupt",
        source: preparedConfigPath ? "prepared" : "active",
        path: targetPath,
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function unsafeArtifact(name: string, state: MigrationArtifactState): string | undefined {
  if (!["newer", "inconsistent", "corrupt"].includes(state.status)) return undefined;
  return `${name} is ${state.status}${state.detail ? `: ${state.detail}` : ""}`;
}

function completedCutoverRefMapPath(): string {
  return path.join(path.dirname(getMigrationApplyJournalPath()), "completed-cutover-refmap.json");
}

function loadCompletedProposalRefMap(): Map<string, string> {
  const mapPath = completedCutoverRefMapPath();
  if (!fs.existsSync(mapPath)) return new Map();
  return loadCompletedCutoverRefMap(mapPath).map;
}

function inspectCurrentProposalRepair(artifacts: MigrationState): { count: number; blocker?: string } {
  const postCutover =
    artifacts.config.status === "current" &&
    artifacts.workflow.status === "missing" &&
    (artifacts.state.status === "current" ||
      artifacts.state.migrationIds?.includes("020-three-db-cutover") === true);
  if (!postCutover) return { count: 0 };

  const count = countLegacyProposalRefs(getStateDbPathInDataDir());
  if (count === 0) return { count };
  try {
    assertLegacyProposalRefsRepairable(getStateDbPathInDataDir(), loadCompletedProposalRefMap());
    return { count };
  } catch (error) {
    return { count, blocker: error instanceof Error ? error.message : String(error) };
  }
}

function buildMigrationPlan(
  preparedConfigPath: string | undefined,
  active: ApplySentinelRead = readApplySentinel(),
): MigrationPlan {
  const artifacts = inspectMigrationState();
  const restorePending = fs.existsSync(getMigrationRestoreJournalPath());

  // R-090: a genuinely fresh machine — no config.json, no state/workflow/index
  // databases, and no in-flight apply/restore operation — has nothing to
  // migrate. Report that as a distinct, non-error outcome instead of routing
  // it through the "provide an operator-prepared config" blocker below: that
  // message is correct advice for an existing pre-cutover install but reads
  // as a failure ("blocked", exit 1) for a user who has nothing to upgrade.
  const nothingToMigrate =
    !active.sentinel &&
    !restorePending &&
    artifacts.config.status === "missing" &&
    artifacts.state.status === "missing" &&
    artifacts.workflow.status === "missing" &&
    artifacts.index.status === "missing";
  if (nothingToMigrate) {
    return {
      status: "not-applicable",
      artifacts,
      targetConfig: { status: "missing", source: "none" },
      blockers: [],
      message: "No akm installation found; nothing to migrate.",
    };
  }

  const target = active.sentinel
    ? {
        state: {
          status: active.config ? ("current" as const) : ("corrupt" as const),
          source: "prepared" as const,
          path: getMigrationApplyJournalPath(),
          ...(!active.config && active.error ? { detail: active.error } : {}),
        },
        config: active.config,
        migrationLockEntries: active.sentinel.migrationLockEntries,
      }
    : loadTargetConfig(preparedConfigPath, artifacts);

  const blockers = [
    unsafeArtifact("config.json", artifacts.config),
    unsafeArtifact("state.db", artifacts.state),
    unsafeArtifact("workflow.db", artifacts.workflow),
    unsafeArtifact("index.db", artifacts.index),
  ].filter((blocker): blocker is string => blocker !== undefined);
  if (target.state.status !== "current") blockers.push(target.state.detail ?? "A current target config is required.");
  if (active.error) blockers.push(active.error);
  if (restorePending) blockers.push(`Restore recovery is pending at ${getMigrationRestoreJournalPath()}.`);

  let taskRewrites = 0;
  if (blockers.length === 0 && target.config) {
    try {
      taskRewrites = planTaskTargetRefMigration(
        target.config,
        active.sentinel?.pathResolutionBase ?? process.cwd(),
        target.migrationLockEntries ?? [],
      ).rewrites.length;
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }
  }

  const proposalRepair = inspectCurrentProposalRepair(artifacts);
  if (blockers.length === 0 && proposalRepair.blocker) blockers.push(proposalRepair.blocker);
  const needsApply =
    !!active.sentinel ||
    artifacts.config.status !== "current" ||
    artifacts.state.status === "old" ||
    artifacts.workflow.status === "old" ||
    artifacts.workflow.status === "current" ||
    taskRewrites > 0 ||
    proposalRepair.count > 0;

  return {
    status: blockers.length > 0 ? "blocked" : needsApply ? "ready" : "current",
    artifacts,
    targetConfig: target.state,
    blockers,
    ...(restorePending
      ? {
          activeOperation: {
            kind: "restore" as const,
            sentinelPath: getMigrationRestoreJournalPath(),
          },
        }
      : active.sentinel
        ? {
            activeOperation: {
              kind: "apply" as const,
              sentinelPath: getMigrationApplyJournalPath(),
            },
          }
        : {}),
  };
}

export function inspectMigrationPlan(preparedConfigPath?: string): MigrationPlan {
  return buildMigrationPlan(preparedConfigPath);
}

function printPlan(plan: MigrationPlan): void {
  console.log(JSON.stringify(plan));
  if (plan.status === "blocked") process.exitCode = EXIT_CODES.GENERAL;
}

export async function runMigrationStatus(options: MigrationCommandOptions = {}): Promise<void> {
  printPlan(inspectMigrationPlan(options.preparedConfigPath));
}

function expandTilde(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function migrationLockMatchesBundle(lock: LockfileEntry, bundle: Record<string, unknown>): boolean {
  if (typeof bundle.npm === "string") return lock.source === "npm" && lock.ref === bundle.npm;
  if (typeof bundle.git !== "string") return false;

  let resolvedRef = lock.ref;
  if (resolvedRef.startsWith("git+")) resolvedRef = resolvedRef.slice(4);
  const githubLocator = resolvedRef.startsWith("github:");
  if (githubLocator) resolvedRef = resolvedRef.slice("github:".length);
  if ((lock.source === "github" || githubLocator) && /^[^/:#]+\/[^/#]+(?:#.+)?$/.test(resolvedRef)) {
    const [repository, requestedRef] = resolvedRef.split("#", 2);
    resolvedRef = `https://github.com/${repository?.replace(/\.git$/i, "")}${requestedRef ? `/tree/${requestedRef}` : ""}`;
  }
  return (lock.source === "git" || lock.source === "github") && resolvedRef === bundle.git;
}

export function cutoverStashRootsFromConfig(
  config: AkmConfig,
  migrationLockEntries: readonly LockfileEntry[] = [],
  legacySources: readonly { path: string; registryId?: string }[] = [],
  pathResolutionBase = process.cwd(),
): CutoverStashRoot[] {
  const candidates: Array<{
    path: string;
    bundleId: string;
    registryId: string;
    primary: boolean;
    identityIndex: number;
  }> = [];
  const identitySources: Array<{ id: string; path: string; registryId?: string }> = [];
  const bundles = config.bundles;
  if (bundles && typeof bundles === "object") {
    const locksById = new Map(migrationLockEntries.map((entry) => [entry.id, entry]));
    const seenRoots = new Set<string>();
    for (const [id, entry] of Object.entries(bundles)) {
      const bundle = entry as Record<string, unknown>;
      const bundlePath = bundle.path;
      const lock = locksById.get(id);
      const lockRoot = lock && migrationLockMatchesBundle(lock, bundle) ? lock.localRoot : undefined;
      const materializedRoot =
        typeof bundlePath === "string" && bundlePath.length > 0
          ? path.resolve(pathResolutionBase, expandTilde(bundlePath))
          : lockRoot
            ? path.resolve(pathResolutionBase, expandTilde(lockRoot))
            : undefined;
      const registryId = typeof bundle.registryId === "string" ? bundle.registryId : undefined;
      const identityIndex = identitySources.length;
      identitySources.push({
        id,
        path: materializedRoot ?? path.resolve(pathResolutionBase, ".akm", "unresolved-sources", id),
        ...(registryId ? { registryId } : materializedRoot === undefined ? { registryId: id } : {}),
      });
      if (!materializedRoot || seenRoots.has(materializedRoot)) continue;
      seenRoots.add(materializedRoot);
      candidates.push({
        path: materializedRoot,
        bundleId: id,
        registryId: registryId ?? id,
        primary: config.defaultBundle === id,
        identityIndex,
      });
    }
    for (const lock of migrationLockEntries) {
      const configured = bundles[lock.id] as Record<string, unknown> | undefined;
      if (!configured || !migrationLockMatchesBundle(lock, configured) || !lock.localRoot) continue;
      const materializedRoot = path.resolve(pathResolutionBase, expandTilde(lock.localRoot));
      if (seenRoots.has(materializedRoot)) continue;
      seenRoots.add(materializedRoot);
      const registryId = typeof configured.registryId === "string" ? configured.registryId : undefined;
      const identityIndex = identitySources.length;
      identitySources.push({ id: lock.id, path: materializedRoot, registryId: registryId ?? lock.id });
      candidates.push({
        path: materializedRoot,
        bundleId: lock.id,
        registryId: registryId ?? lock.id,
        primary: config.defaultBundle === lock.id,
        identityIndex,
      });
    }
  }

  const inferredLegacyBundleIds = inferLegacyBundleIds(identitySources);
  const legacyIdsByRoot = new Map<string, string>();
  const ambiguousLegacyRoots = new Set<string>();
  if (legacySources.length > 0) {
    const exactLegacyIds = deriveLegacyBundleIds(legacySources);
    legacySources.forEach((source, index) => {
      const root = path.resolve(pathResolutionBase, source.path);
      const legacyId = exactLegacyIds[index];
      const existing = legacyIdsByRoot.get(root);
      if (!legacyId || (existing !== undefined && existing !== legacyId)) {
        ambiguousLegacyRoots.add(root);
        legacyIdsByRoot.delete(root);
      } else if (!ambiguousLegacyRoots.has(root)) {
        legacyIdsByRoot.set(root, legacyId);
      }
    });
  }

  return candidates.map((candidate) => ({
    path: candidate.path,
    bundleId: candidate.bundleId,
    legacyBundleId:
      legacyIdsByRoot.get(path.resolve(candidate.path)) ?? inferredLegacyBundleIds[candidate.identityIndex],
    registryId: candidate.registryId,
    primary: candidate.primary,
  }));
}

function legacyCutoverSources(sentinel: ApplySentinel): Array<{ path: string; registryId?: string }> {
  const backupConfigPath = path.join(sentinel.backupPath, "config.json");
  if (!fs.existsSync(backupConfigPath)) return [];
  const text = readTextFileWithLimit(backupConfigPath, MAX_CONFIG_FILE_BYTES, "Migration backup config");
  return oldConfigToSearchSources(parseConfigText(text, backupConfigPath), sentinel.pathResolutionBase);
}

function cutoverRefMapPath(sentinel: ApplySentinel): string {
  return path.join(path.dirname(getMigrationApplyJournalPath()), `cutover-refmap-${sentinel.operationId}.json`);
}

function contentMigrationReportPath(): string {
  return path.join(path.dirname(getMigrationApplyJournalPath()), "content-migration-report.json");
}

function persistContentMigrationReport(report: ContentMigrationReport): void {
  fs.mkdirSync(path.dirname(contentMigrationReportPath()), { recursive: true, mode: 0o700 });
  writeFileAtomic(contentMigrationReportPath(), `${JSON.stringify(report, null, 2)}\n`, 0o600);
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function priorReservedRenames(roots: readonly CutoverStashRoot[]): Array<{ from: string; to: string }> {
  const reportPath = contentMigrationReportPath();
  if (!fs.existsSync(reportPath)) return [];

  let value: unknown;
  try {
    value = JSON.parse(readTextFileWithLimit(reportPath, MAX_LOCAL_METADATA_BYTES, "Content migration report"));
  } catch (error) {
    throw new ConfigError(
      `Cannot reuse reserved-file rename history at ${reportPath}: ${error instanceof Error ? error.message : String(error)}.`,
      "INVALID_CONFIG_FILE",
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`Invalid content migration report at ${reportPath}.`, "INVALID_CONFIG_FILE");
  }
  const entries = (value as Partial<ContentMigrationReport>).reservedRenames;
  if (!Array.isArray(entries)) {
    throw new ConfigError(`Invalid reserved-file rename history at ${reportPath}.`, "INVALID_CONFIG_FILE");
  }

  const reusable: Array<{ from: string; to: string }> = [];
  for (const entry of entries) {
    if (!entry || typeof entry.from !== "string" || typeof entry.to !== "string") {
      throw new ConfigError(`Invalid reserved-file rename history at ${reportPath}.`, "INVALID_CONFIG_FILE");
    }
    const from = path.resolve(entry.from);
    const to = path.resolve(entry.to);
    const owner = roots.find((root) => isPathWithin(root.path, from) && isPathWithin(root.path, to));
    if (!owner) continue;
    const fromName = path.basename(from).toLowerCase();
    const stem = fromName.endsWith(".md") ? fromName.slice(0, -3) : "";
    const targetPattern = new RegExp(`^${stem}-content(?:-(?:[2-9]|[1-9][0-9]+))?\\.md$`, "i");
    if (
      path.dirname(from) !== path.dirname(to) ||
      (fromName !== "index.md" && fromName !== "log.md") ||
      !targetPattern.test(path.basename(to))
    ) {
      throw new ConfigError(`Invalid reserved-file rename history at ${reportPath}.`, "INVALID_CONFIG_FILE");
    }
    if (fs.existsSync(from) || !fs.existsSync(to)) continue;
    const target = fs.lstatSync(to);
    if (!target.isFile() || target.isSymbolicLink()) continue;
    reusable.push({ from, to });
  }
  return reusable;
}

function mergePriorReservedRenames(
  report: ContentMigrationReport,
  roots: readonly CutoverStashRoot[],
): ContentMigrationReport {
  const bySource = new Map(report.reservedRenames.map((entry) => [path.resolve(entry.from), entry]));
  for (const entry of priorReservedRenames(roots)) {
    if (!bySource.has(entry.from)) bySource.set(entry.from, entry);
  }
  report.reservedRenames = [...bySource.values()];
  return report;
}

function reservedRenameRefMap(
  renames: ReadonlyArray<{ from: string; to: string }>,
  roots: readonly CutoverStashRoot[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const rename of renames) {
    const owner = roots.find((root) => rename.from.startsWith(`${path.resolve(root.path)}${path.sep}`));
    if (!owner) continue;
    const conceptId = (absolute: string): string | undefined => {
      const relative = path.relative(path.resolve(owner.path), absolute).split(path.sep).join("/");
      return relative.endsWith(".md") ? relative.slice(0, -3) : undefined;
    };
    const oldId = conceptId(rename.from);
    const newId = conceptId(rename.to);
    if (!oldId || !newId) continue;
    map.set(oldId, newId);
    if (owner.bundleId) map.set(`${owner.bundleId}//${oldId}`, `${owner.bundleId}//${newId}`);
  }
  return map;
}

function runContentMigrationStep(sentinel: ApplySentinel, roots: readonly CutoverStashRoot[]): void {
  const report = mergePriorReservedRenames(
    runContentMigration(
      roots.map((root) => root.path),
      {
        operationId: sentinel.operationId,
        renameBatchPath: path.join(
          path.dirname(getMigrationApplyJournalPath()),
          `reserved-renames-${sentinel.operationId}.json`,
        ),
      },
    ),
    roots,
  );
  const renameMap = reservedRenameRefMap(report.reservedRenames, roots);
  const proposalRoots = roots.flatMap((root) =>
    root.bundleId
      ? [
          {
            path: root.path,
            bundleId: root.bundleId,
            ...(root.legacyBundleId ? { legacyBundleId: root.legacyBundleId } : {}),
            ...(root.registryId ? { registryId: root.registryId } : {}),
          },
        ]
      : [],
  );
  persistContentMigrationReport(report);
  if (renameMap.size > 0) rekeyStateDb(getStateDbPathInDataDir(), renameMap);
  report.legacyProposalsImported = importLegacyProposalsIntoState(
    getStateDbPathInDataDir(),
    proposalRoots,
    renameMap,
  );
  persistContentMigrationReport(report);
  if (report.sidecarsFolded > 0 || report.reservedRenames.length > 0 || report.legacyProposalsImported > 0) {
    console.log(JSON.stringify({ event: "content-migration", operationId: sentinel.operationId, ...report }));
  }
}

function applyStateSchema(): void {
  const db = openDatabaseFinalizing(getStateDbPathInDataDir());
  try {
    runStateMigrations(db);
    db.exec("DROP TABLE IF EXISTS akm_migration_generation");
  } finally {
    db.close();
  }
}

function applyWorkflowSchema(): void {
  const workflowPath = getLegacyWorkflowDbPath();
  if (!fs.existsSync(workflowPath)) return;
  const db = openDatabaseFinalizing(workflowPath);
  try {
    const hasRuns = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_runs'").get();
    const hasLedger = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
    if (hasRuns && !hasLedger) {
      throw new ConfigError(
        `Refusing to migrate a pre-versioning workflow.db at ${workflowPath} (no schema_migrations ledger). ` +
          "Upgrade through a 0.8.x release first.",
        "INVALID_CONFIG_FILE",
      );
    }
    runSqliteMigrations(db, FROZEN_WORKFLOW_MIGRATIONS);
    db.exec("DROP TABLE IF EXISTS akm_migration_generation");
  } finally {
    db.close();
  }
}

function loadOrCreateCutoverRefMap(
  sentinel: ApplySentinel,
  roots: readonly CutoverStashRoot[],
): Map<string, string> {
  const activePath = cutoverRefMapPath(sentinel);
  if (fs.existsSync(activePath)) return loadCutoverRefMap(activePath);
  if (cutoverMergeCommitted(getStateDbPathInDataDir(), sentinel.operationId)) {
    if (fs.existsSync(completedCutoverRefMapPath())) {
      return loadCompletedCutoverRefMap(completedCutoverRefMapPath()).map;
    }
    throw new ConfigError("The committed migration is missing its persisted ref map.", "INVALID_CONFIG_FILE");
  }
  return buildCutoverRefMap({ oldIndexDbPath: getDbPath(), stashRoots: roots, mapOutputPath: activePath });
}

function repairCurrentData(config: AkmConfig, sentinel: ApplySentinel): void {
  if (countLegacyProposalRefs(getStateDbPathInDataDir()) > 0) {
    const report = repairAlreadyCurrentProposalRefs(getStateDbPathInDataDir(), loadCompletedProposalRefMap());
    if (report.rekeyed > 0 || report.quarantined > 0) {
      console.log(JSON.stringify({ event: "proposal-ref-repair", ...report }));
    }
  }
  const taskPlan = planTaskTargetRefMigration(
    config,
    sentinel.pathResolutionBase,
    sentinel.migrationLockEntries,
  );
  applyTaskTargetRefMigration(taskPlan);
}

function runFullMigration(config: AkmConfig, sentinel: ApplySentinel): void {
  const roots = cutoverStashRootsFromConfig(
    config,
    sentinel.migrationLockEntries,
    legacyCutoverSources(sentinel),
    sentinel.pathResolutionBase,
  );
  let refMap: Map<string, string>;
  if (!cutoverMergeCommitted(getStateDbPathInDataDir(), sentinel.operationId)) {
    applyStateSchema();
    applyWorkflowSchema();
    refMap = loadOrCreateCutoverRefMap(sentinel, roots);
    runThreeDbCutover({
      refMap,
      operationId: sentinel.operationId,
      statePath: getStateDbPathInDataDir(),
      workflowPath: getLegacyWorkflowDbPath(),
      oldIndexPath: getDbPath(),
    });
  } else {
    refMap = loadOrCreateCutoverRefMap(sentinel, roots);
  }

  runContentMigrationStep(sentinel, roots);
  repairCurrentData(config, sentinel);
  migratePilotTreatmentFiles(roots, refMap);
  quarantineIndexDb(sentinel.operationId, getDbPath());
  deleteWorkflowDb(getLegacyWorkflowDbPath());
  completeCutoverRefMap(cutoverRefMapPath(sentinel), completedCutoverRefMapPath());
}

function isTaskOnlyRepair(manifest: MigrationBackupManifest): boolean {
  return (
    manifest.artifacts["config.json"].status === "current" &&
    ["current", "missing"].includes(manifest.artifacts["state.db"].status) &&
    manifest.artifacts["workflow.db"].status === "missing"
  );
}

function isPostCutoverStateMigration(manifest: MigrationBackupManifest): boolean {
  return (
    manifest.artifacts["config.json"].status === "current" &&
    manifest.artifacts["state.db"].status === "old" &&
    manifest.artifacts["state.db"].migrationIds?.includes("020-three-db-cutover") === true &&
    manifest.artifacts["workflow.db"].status === "missing" &&
    cutoverMergeCommitted(getStateDbPathInDataDir())
  );
}

function publishConfigLast(config: AkmConfig, sentinel: ApplySentinel, manifest: MigrationBackupManifest): void {
  mergeLockEntriesSync(sentinel.migrationLockEntries);
  if (manifest.artifacts["config.json"].status === "current") return;
  const desired = `${JSON.stringify(sanitizeConfigForWrite(config), null, 2)}\n`;
  const current = fs.existsSync(getConfigPath())
    ? readTextFileWithLimit(getConfigPath(), MAX_CONFIG_FILE_BYTES, "Config file")
    : undefined;
  if (current !== desired) writeFileAtomic(getConfigPath(), desired, 0o600);
  resetConfigCache();
}

function requireSemanticCompletion(config: AkmConfig, sentinel: ApplySentinel, fullMigration: boolean): MigrationPlan {
  const artifacts = inspectMigrationState();
  const blockers: string[] = [];
  if (artifacts.config.status !== "current") blockers.push(`config.json is ${artifacts.config.status}`);
  if (artifacts.state.status !== "current" && artifacts.state.status !== "missing") {
    blockers.push(`state.db is ${artifacts.state.status}`);
  }
  if (artifacts.workflow.status !== "missing") blockers.push(`workflow.db is ${artifacts.workflow.status}`);
  if (fullMigration && !cutoverMergeCommitted(getStateDbPathInDataDir(), sentinel.operationId)) {
    blockers.push("the three-database data cutover is not committed");
  }
  if (fullMigration && !fs.existsSync(completedCutoverRefMapPath())) {
    blockers.push("the completed cutover ref map is missing");
  }
  try {
    const remainingTasks = planTaskTargetRefMigration(
      config,
      sentinel.pathResolutionBase,
      sentinel.migrationLockEntries,
    ).rewrites.length;
    if (remainingTasks > 0) blockers.push(`${remainingTasks} persisted task file(s) still need migration`);
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : String(error));
  }
  const legacyProposalRefs = countLegacyProposalRefs(getStateDbPathInDataDir());
  if (legacyProposalRefs > 0) blockers.push(`${legacyProposalRefs} proposal ref(s) still use legacy grammar`);
  if (blockers.length > 0) {
    throw new ConfigError(`Migration verification failed: ${blockers.join("; ")}.`, "INVALID_CONFIG_FILE");
  }
  return {
    status: "current",
    artifacts,
    targetConfig: { status: "current", source: "active", path: getConfigPath() },
    blockers: [],
  };
}

/**
 * R-091: an active/resumable (`status IN ('active','blocked')`) workflow run
 * can target a workflow asset that fails 0.9's structural validation — most
 * commonly a heading-based 0.8 workflow definition, since 0.9 requires
 * frontmatter `steps:` and does NOT auto-translate the old format (the docs
 * say so explicitly; building a converter here would be dishonest scope
 * creep). Such an asset silently drops out of the 0.9 index (`akm search
 * --type workflow` finds nothing for it) while its run row stays `active`, so
 * `akm show` on UNRELATED assets keeps prefixing a "WORKFLOW ACTIVE" banner
 * that names a run the operator can no longer advance. The minimal honest fix
 * is detection + a clear pointer, not a fix: tell the operator to update the
 * asset or abandon the stale run. Reuses `workflowStructureDiagnostics` — the
 * exact same check `akm lint`'s `invalid-workflow-structure` uses — so this
 * can never disagree with what `akm lint`/`akm search` report.
 *
 * Purely diagnostic: reads state.db read-only and writes to stderr via
 * `warn()`, never to the migration's stdout JSON result. Every failure mode
 * (missing table, unreadable file, resolution miss) is swallowed — this must
 * never turn a completed migration into a failure.
 */
function warnOrphanedActiveWorkflowRuns(
  statePath: string,
  roots: readonly CutoverStashRoot[],
  defaultBundle: string | undefined,
): void {
  try {
    if (!fs.existsSync(statePath)) return;
    let rows: Array<{ id: string; workflow_ref: string }>;
    const db = openDatabaseFinalizing(statePath, { readonly: true, create: false });
    try {
      const hasRuns = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_runs'").get();
      if (!hasRuns) return;
      rows = db
        .prepare("SELECT id, workflow_ref FROM workflow_runs WHERE status IN ('active', 'blocked')")
        .all() as Array<{ id: string; workflow_ref: string }>;
    } finally {
      db.close();
    }
    if (rows.length === 0) return;

    const rootById = new Map(roots.map((root) => [root.bundleId, root]));
    for (const row of rows) {
      const parsed = parseBundleRef(row.workflow_ref);
      const parts = typeNameFromConceptId(parsed.conceptId);
      if (!parts || parts.type !== "workflow") continue;
      const root = rootById.get(parsed.bundle ?? defaultBundle ?? "");
      if (!root) continue;
      // `assetPathForName`'s `typeRoot` is the TYPE's stash subdir, not the
      // bundle root — mirrors how every real caller (indexer install
      // resolution) builds it: `<bundleRoot>/<stashDirFor(type)>`.
      const typeRoot = path.join(root.path, stashDirFor("workflow") ?? "workflows");
      const filePath = assetPathForName("workflow", typeRoot, parts.name);
      if (!fs.existsSync(filePath)) continue;
      let raw: string;
      try {
        raw = readTextFileWithLimit(filePath, MAX_CONFIG_FILE_BYTES, "Workflow asset");
      } catch {
        continue;
      }
      const diagnostics = workflowStructureDiagnostics(path.relative(root.path, filePath) || filePath, raw, filePath);
      if (diagnostics.length === 0) continue;
      warn(
        `WORKFLOW ACTIVE run ${row.id} targets "${row.workflow_ref}" (${filePath}), which fails 0.9 workflow ` +
          `structural validation and can no longer be run: ${diagnostics.map((d) => d.detail).join("; ")}. ` +
          "AKM does not auto-translate workflow definitions between formats — update the asset to declare " +
          `frontmatter \`steps:\`, or run \`akm workflow abandon ${row.id}\` to clear the stale run.`,
      );
    }
  } catch {
    // Purely diagnostic — never let this block or fail a completed migration.
  }
}

function requireEligiblePlan(
  preparedConfigPath: string | undefined,
  active: ApplySentinelRead,
): { plan: MigrationPlan; target: AkmConfig; migrationLockEntries: LockfileEntry[] } {
  const plan = buildMigrationPlan(preparedConfigPath, active);
  const loaded = active.sentinel
    ? { config: active.config, migrationLockEntries: active.sentinel.migrationLockEntries }
    : loadTargetConfig(preparedConfigPath, plan.artifacts);
  if (plan.status === "blocked" || !loaded.config) {
    throw new ConfigError(`Migration is blocked: ${plan.blockers.join("; ")}`, "INVALID_CONFIG_FILE");
  }
  return { plan, target: loaded.config, migrationLockEntries: loaded.migrationLockEntries ?? [] };
}

export async function runMigrationApply(options: MigrationCommandOptions = {}): Promise<void> {
  if (options.dryRun) {
    printPlan(inspectMigrationPlan(options.preparedConfigPath));
    return;
  }

  const result = withConfigLock(() =>
    withMaintenanceStartBarrier(() => {
      recoverInterruptedRestoreWithLocksHeld();
      const existing = readApplySentinel();
      if (existing.error) throw new ConfigError(existing.error, "INVALID_CONFIG_FILE");
      // R-090: `not-applicable` (nothing on this machine to migrate) has no
      // target config to load by design — short-circuit before
      // `requireEligiblePlan`, which would otherwise read that absent target
      // as `blocked` and throw.
      const preflightPlan = buildMigrationPlan(options.preparedConfigPath, existing);
      if (preflightPlan.status === "not-applicable") return { plan: preflightPlan };
      const { plan, target, migrationLockEntries } = requireEligiblePlan(options.preparedConfigPath, existing);
      if (plan.status === "current" && !existing.sentinel) return { plan };
      const pathResolutionBase = existing.sentinel?.pathResolutionBase ?? path.resolve(process.cwd());
      const stashRoots = cutoverStashRootsFromConfig(target, migrationLockEntries, [], pathResolutionBase);
      assertNoArtifactReplacementBlockers(undefined, { stashRoots: stashRoots.map((root) => root.path) });
      assertMigrationLockfileReadable();

      const backup = existing.sentinel
        ? { path: existing.sentinel.backupPath, manifest: existing.manifest as MigrationBackupManifest }
        : ensureMigrationBackupWithConfigLockHeld();
      const sentinel: ApplySentinel = existing.sentinel ?? {
        formatVersion: APPLY_SENTINEL_FORMAT,
        version: MIGRATION_BACKUP_VERSION,
        operationId: `${process.pid}-${randomUUID()}`,
        installationId: backup.manifest.installationId,
        backupRunId: backup.manifest.runId,
        backupPath: backup.path,
        targetConfig: sanitizeConfigForWrite(target),
        migrationLockEntries,
        pathResolutionBase: path.resolve(process.cwd()),
      };
      if (!existing.sentinel) writeApplySentinel(sentinel);

      try {
        const taskOnly = isTaskOnlyRepair(backup.manifest);
        const postCutoverState = isPostCutoverStateMigration(backup.manifest);
        if (taskOnly) {
          repairCurrentData(target, sentinel);
        } else if (postCutoverState) {
          applyStateSchema();
          repairCurrentData(target, sentinel);
        } else {
          runFullMigration(target, sentinel);
        }
        publishConfigLast(target, sentinel, backup.manifest);
        const completed = requireSemanticCompletion(target, sentinel, !taskOnly && !postCutoverState);
        warnOrphanedActiveWorkflowRuns(getStateDbPathInDataDir(), stashRoots, target.defaultBundle);
        clearApplySentinel();
        return { plan: completed, backup };
      } catch (error) {
        throw new ConfigError(
          `Migration remains incomplete at ${getMigrationApplyJournalPath()}. Re-run \`akm-migrate apply\` to retry from the original backup ${backup.path}: ${error instanceof Error ? error.message : String(error)}`,
          "INVALID_CONFIG_FILE",
        );
      }
    }),
  );

  console.log(
    JSON.stringify({
      ...result.plan,
      ...(result.backup ? { backupPath: result.backup.path, backupRunId: result.backup.manifest.runId } : {}),
    }),
  );
}

export async function runConfigMigrate(options: MigrationCommandOptions = {}): Promise<void> {
  if (options.dryRun || !options.preparedConfigPath) return runMigrationStatus(options);
  return runMigrationApply(options);
}
