// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Filesystem boundary for the pure legacy-task to task-v3 planner. */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MAX_LOCAL_METADATA_BYTES, readTextFileWithLimit } from "../../../src/core/common";
import { ConfigError } from "../../../src/core/errors";
import { fsyncDirectoryPortable } from "./durable-fs";
import {
  type TaskToV3Changed,
  type TaskToV3FileInput,
  type TaskToV3FilesystemIdentity,
  type TaskToV3MigrationPlan,
} from "./task-to-v3";
import { parseTaskV3Yaml } from "../../../src/tasks/source-v3";

export interface TaskToV3Root {
  readonly bundleId: string;
  readonly root: string;
  /** Physical owner whose identity and containment fence nested components. */
  readonly bundleRoot?: string;
  readonly writable: boolean;
  /** `akm-task` owns `.yml` files at its component root; `akm` owns `tasks/`. */
  readonly layout?: "akm-stash" | "akm-task";
}

export interface ApplyTaskToV3Options {
  readonly backupRoot: string;
  /** Verified main-backup declaration used by the production apply/resume path. */
  readonly backupManifest?: TaskMigrationBackupManifest;
  /** TEST-ONLY interleaving seam for deterministic crash/concurrency coverage. */
  readonly testHooks?: Readonly<{
    beforePublish?: (filePath: string) => void;
    afterPublish?: (filePath: string) => void;
  }>;
}

export interface TaskMigrationBackupEntry {
  readonly sourcePath: string;
  readonly backupPath: string;
  readonly finalPath: string;
  readonly mode: number;
  readonly beforeHash: string;
  readonly finalHash: string;
  readonly sourceIdentity: TaskToV3FilesystemIdentity;
  readonly componentRootIdentity: TaskToV3FilesystemIdentity;
  readonly bundleRootIdentity: TaskToV3FilesystemIdentity;
}

export interface TaskMigrationBackupManifest {
  readonly schemaVersion: 2;
  readonly operationId: string;
  readonly generation: string;
  readonly recoveryPath: "tasks/recovery.json";
  readonly files: readonly TaskMigrationBackupEntry[];
}

export interface AppliedTaskToV3Plan {
  readonly generation: string;
  readonly changed: readonly string[];
  readonly alreadyApplied: readonly string[];
}

type TaskMigrationRecoveryState = "not-started" | "backed-up" | "published" | "restored";

interface TaskMigrationRecoveryEntry {
  readonly sourcePath: string;
  readonly state: TaskMigrationRecoveryState;
}

interface TaskMigrationRecoveryJournal {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly generation: string;
  readonly files: readonly TaskMigrationRecoveryEntry[];
}

function migrationError(detail: string): ConfigError {
  return new ConfigError(`Task migration to v3 failed: ${detail}`, "INVALID_CONFIG_FILE");
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function lstatIfPresent(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw migrationError(`cannot inspect ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}.`);
  }
}

function physicalIdentity(filePath: string, expectedKind: "file" | "directory"): TaskToV3FilesystemIdentity {
  const stat = fs.lstatSync(filePath, { bigint: true });
  if (stat.isSymbolicLink() || (expectedKind === "file" ? !stat.isFile() : !stat.isDirectory())) {
    throw migrationError(`${filePath} must remain a real ${expectedKind}.`);
  }
  return Object.freeze({
    realPath: fs.realpathSync(filePath),
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    linkCount: stat.nlink.toString(),
    changeTimeNs: stat.ctimeNs.toString(),
  });
}

function inspectRegularFile(filePath: string): {
  readonly bytes: Buffer;
  readonly identity: TaskToV3FilesystemIdentity;
  readonly mode: number;
} {
  const identity = physicalIdentity(filePath, "file");
  const stat = fs.lstatSync(filePath);
  const mode = stat.mode & 0o777;
  const bytes = fs.readFileSync(filePath);
  const afterStat = fs.lstatSync(filePath);
  const afterIdentity = physicalIdentity(filePath, "file");
  if ((afterStat.mode & 0o777) !== mode || !sameFileIdentity(identity, afterIdentity)) {
    throw migrationError(`${filePath} identity or mode drifted while migration preflight read it.`);
  }
  return Object.freeze({ bytes, identity: afterIdentity, mode });
}

function sameIdentity(left: TaskToV3FilesystemIdentity, right: TaskToV3FilesystemIdentity): boolean {
  return (
    left.realPath === right.realPath &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.linkCount === right.linkCount
  );
}

function sameFileIdentity(left: TaskToV3FilesystemIdentity, right: TaskToV3FilesystemIdentity): boolean {
  return sameIdentity(left, right) && left.changeTimeNs === right.changeTimeNs;
}

function physicalTaskIdentityKey(identity: TaskToV3FilesystemIdentity): string {
  return `${identity.device}:${identity.inode}`;
}

function sourceIdentityKey(file: TaskToV3MigrationPlan["files"][number]): string {
  const sourcePath = file.inspectionIdentity?.file.realPath;
  if (!sourcePath) throw migrationError(`${file.filePath} has no canonical physical source identity.`);
  return sourcePath;
}

function modeIsWritable(mode: number): boolean {
  return (mode & 0o222) !== 0;
}

function accessibleForWrite(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function walkTaskFiles(
  root: TaskToV3Root,
  rootIdentity: TaskToV3FilesystemIdentity,
  bundleRootIdentity: TaskToV3FilesystemIdentity,
  tasksDir: string,
  out: TaskToV3FileInput[],
): void {
  const realRoot = rootIdentity.realPath;
  const realTasks = fs.realpathSync(tasksDir);
  if (!contained(realRoot, realTasks)) throw migrationError(`${tasksDir} resolves outside bundle ${root.bundleId}.`);
  const visit = (directory: string): void => {
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      compareStrings(left.name, right.name),
    );
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw migrationError(`task migration does not follow symbolic link ${candidate}.`);
      if (entry.isDirectory()) {
        const realCandidate = fs.realpathSync(candidate);
        if (!contained(realRoot, realCandidate)) throw migrationError(`${candidate} resolves outside bundle ${root.bundleId}.`);
        visit(candidate);
        continue;
      }
      if (!entry.isFile()) throw migrationError(`task migration does not inspect special file ${candidate}.`);
      if (!entry.name.endsWith(".yml")) continue;
      const inspected = inspectRegularFile(candidate);
      if (!contained(realRoot, inspected.identity.realPath)) {
        throw migrationError(`${candidate} resolves outside bundle ${root.bundleId}.`);
      }
      const parentMode = fs.lstatSync(path.dirname(candidate)).mode & 0o777;
      out.push({
        filePath: candidate,
        bytes: inspected.bytes,
        mode: inspected.mode,
        writable: root.writable,
        onDiskWritable:
          modeIsWritable(inspected.mode) &&
          modeIsWritable(parentMode) &&
          accessibleForWrite(candidate) &&
          accessibleForWrite(path.dirname(candidate)),
        containmentRoot: realRoot,
        inspectionIdentity: Object.freeze({
          root: rootIdentity,
          file: inspected.identity,
          bundleRoot: bundleRootIdentity,
        }),
      });
    }
  };
  visit(tasksDir);
}

/** Read the complete `.yml` task set under each bundle without writing. */
export function inspectTaskToV3Files(roots: readonly TaskToV3Root[]): TaskToV3FileInput[] {
  const inputs: TaskToV3FileInput[] = [];
  const identities = new Map<string, string>();
  for (const root of [...roots].sort((left, right) => compareStrings(left.bundleId, right.bundleId))) {
    const bundleRootPath = root.bundleRoot ?? root.root;
    const bundleRootStat = lstatIfPresent(bundleRootPath);
    if (!bundleRootStat) continue;
    if (bundleRootStat.isSymbolicLink() || !bundleRootStat.isDirectory()) {
      throw migrationError(`bundle ${root.bundleId} owner root ${bundleRootPath} must be a real directory.`);
    }
    const bundleRootIdentity = physicalIdentity(bundleRootPath, "directory");
    const rootStat = lstatIfPresent(root.root);
    if (!rootStat) continue;
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw migrationError(`bundle ${root.bundleId} root ${root.root} must be a real directory.`);
    }
    const rootIdentity = physicalIdentity(root.root, "directory");
    if (!contained(bundleRootIdentity.realPath, rootIdentity.realPath)) {
      throw migrationError(
        `component root ${root.root} resolves physically outside stable bundle ${root.bundleId} root ${bundleRootPath}.`,
      );
    }
    const prior = identities.get(rootIdentity.realPath);
    if (prior)
      throw migrationError(`bundles ${prior} and ${root.bundleId} resolve to the same root ${rootIdentity.realPath}.`);
    identities.set(rootIdentity.realPath, root.bundleId);
    const tasksDir = root.layout === "akm-task" ? root.root : path.join(root.root, "tasks");
    const taskStat = lstatIfPresent(tasksDir);
    if (!taskStat) continue;
    if (taskStat.isSymbolicLink()) throw migrationError(`tasks directory ${tasksDir} is a symbolic link.`);
    if (!taskStat.isDirectory()) throw migrationError(`tasks path ${tasksDir} is not a directory.`);
    walkTaskFiles(root, rootIdentity, bundleRootIdentity, tasksDir, inputs);
    if (!sameIdentity(physicalIdentity(root.root, "directory"), rootIdentity)) {
      throw migrationError(`bundle ${root.bundleId} root identity drifted while migration preflight inspected it.`);
    }
    if (!sameIdentity(physicalIdentity(bundleRootPath, "directory"), bundleRootIdentity)) {
      throw migrationError(`bundle ${root.bundleId} owner-root identity drifted while migration preflight inspected it.`);
    }
  }
  const inspected = inputs.sort((left, right) => compareStrings(left.filePath, right.filePath));
  const physicalTasks = new Map<string, string>();
  for (const input of inspected) {
    const identity = input.inspectionIdentity?.file;
    if (!identity) throw migrationError(`${input.filePath} has no physical identity after whole-plan inspection.`);
    const identityKey = physicalTaskIdentityKey(identity);
    const prior = physicalTasks.get(identityKey);
    if (prior) {
      throw migrationError(
        `duplicate physical task identity ${identityKey} is referenced by ${prior} and ${input.filePath}.`,
      );
    }
    physicalTasks.set(identityKey, input.filePath);
  }
  for (const input of inspected) {
    const identity = input.inspectionIdentity?.file;
    if (!identity) throw migrationError(`${input.filePath} has no physical identity after whole-plan inspection.`);
    const currentIdentity = physicalIdentity(input.filePath, "file");
    if (currentIdentity.linkCount !== "1") {
      throw migrationError(
        `task ${input.filePath} has hard-link count ${currentIdentity.linkCount}; task sources must have exactly one physical link.`,
      );
    }
    if (!sameFileIdentity(identity, currentIdentity)) {
      throw migrationError(`${input.filePath} file identity drifted during whole-plan inspection.`);
    }
  }
  return inspected;
}

/** Stable, recoverable per-file backup location within one migration operation. */
export function taskMigrationBackupPath(backupRoot: string, filePath: string): string {
  const digest = crypto.createHash("sha256").update(path.resolve(filePath)).digest("hex");
  return path.join(backupRoot, "tasks", `${digest}.before`);
}

export function taskMigrationFinalPath(backupRoot: string, filePath: string): string {
  const digest = crypto.createHash("sha256").update(path.resolve(filePath)).digest("hex");
  return path.join(backupRoot, "tasks", `${digest}.after`);
}

function durableCreate(filePath: string, bytes: Buffer, mode: number): void {
  const parent = path.dirname(filePath);
  const parentStat = fs.lstatSync(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error(`durable-write parent ${parent} must be a real directory`);
  }
  const fd = fs.openSync(filePath, "wx", mode);
  try {
    fs.fchmodSync(fd, mode);
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error(`could not make progress writing ${filePath}`);
      offset += written;
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDirectoryPortable(parent);
}

interface AtomicReplaceOptions {
  readonly beforeRename?: () => void;
  readonly onPublished?: () => void;
}

function atomicReplace(filePath: string, bytes: Buffer, mode: number, options: AtomicReplaceOptions = {}): void {
  const temp = `${filePath}.tmp-task-v3-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  let renamed = false;
  try {
    durableCreate(temp, bytes, mode);
    options.beforeRename?.();
    fs.renameSync(temp, filePath);
    renamed = true;
    options.onPublished?.();
    fsyncDirectoryPortable(path.dirname(filePath));
  } finally {
    if (!renamed && fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function prepareBackupDirectory(backupRoot: string): string {
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const rootStat = fs.lstatSync(backupRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw migrationError(`backup root ${backupRoot} must be a real directory.`);
  }
  const realRoot = fs.realpathSync(backupRoot);
  const directory = path.join(backupRoot, "tasks");
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw migrationError(`backup directory ${directory} must be a real directory.`);
  }
  const realDirectory = fs.realpathSync(directory);
  if (!contained(realRoot, realDirectory)) {
    throw migrationError(`backup directory ${directory} resolves outside backup root ${backupRoot}.`);
  }
  return directory;
}

function expectedBackupMetadata(change: TaskToV3Changed): Buffer {
  return Buffer.from(
    `${JSON.stringify({ schemaVersion: 1, source: change.filePath, mode: change.mode, beforeHash: change.beforeHash }, null, 2)}\n`,
  );
}

function verifyRegularFile(filePath: string, expected: Buffer, label: string): void {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw migrationError(`${label} ${filePath} must be a real regular file.`);
  if (!fs.readFileSync(filePath).equals(expected)) throw migrationError(`${label} ${filePath} failed byte verification.`);
}

function ensureBackup(backupRoot: string, change: TaskToV3Changed): string {
  prepareBackupDirectory(backupRoot);
  const backupPath = taskMigrationBackupPath(backupRoot, change.filePath);
  if (fs.existsSync(backupPath)) {
    verifyRegularFile(backupPath, change.before, "recoverable backup");
  } else {
    durableCreate(backupPath, change.before, 0o600);
  }
  const metadataPath = `${backupPath}.json`;
  const metadata = expectedBackupMetadata(change);
  if (fs.existsSync(metadataPath)) {
    verifyRegularFile(metadataPath, metadata, "recoverable backup metadata");
  } else {
    durableCreate(metadataPath, metadata, 0o600);
  }
  verifyRegularFile(backupPath, change.before, "recoverable backup");
  verifyRegularFile(metadataPath, metadata, "recoverable backup metadata");
  return backupPath;
}

interface SourceSnapshot {
  readonly bytes: Buffer;
  readonly identity: TaskToV3FilesystemIdentity;
}

function readPlannedSource(
  file: TaskToV3MigrationPlan["files"][number],
  expectedFileIdentity?: TaskToV3FilesystemIdentity,
): SourceSnapshot {
  sourceIdentityKey(file);
  const plannedIdentity = file.inspectionIdentity;
  if (!plannedIdentity || !file.containmentRoot) {
    throw migrationError(`${file.filePath} has no filesystem identity recorded by migration preflight.`);
  }
  const currentRootIdentity = physicalIdentity(file.containmentRoot, "directory");
  if (!sameIdentity(currentRootIdentity, plannedIdentity.root)) {
    throw migrationError(`${file.filePath} component-root identity drifted after migration preflight.`);
  }
  const currentBundleRootIdentity = plannedIdentity.bundleRoot
    ? physicalIdentity(plannedIdentity.bundleRoot.realPath, "directory")
    : currentRootIdentity;
  if (plannedIdentity.bundleRoot && !sameIdentity(currentBundleRootIdentity, plannedIdentity.bundleRoot)) {
    throw migrationError(`${file.filePath} bundle-root identity drifted after migration preflight.`);
  }
  if (!contained(currentBundleRootIdentity.realPath, currentRootIdentity.realPath)) {
    throw migrationError(`${file.filePath} component root is no longer physically contained by its owning bundle.`);
  }
  const stat = fs.lstatSync(file.filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw migrationError(`${file.filePath} is no longer a real regular file (generation drift).`);
  }
  const mode = stat.mode & 0o777;
  if (mode !== file.mode) {
    throw migrationError(
      `${file.filePath} mode drifted after migration preflight (${file.mode.toString(8)} -> ${mode.toString(8)}).`,
    );
  }
  const realRoot = currentRootIdentity.realPath;
  const identity = physicalIdentity(file.filePath, "file");
  if (identity.linkCount !== "1") {
    throw migrationError(
      `task ${file.filePath} has hard-link count ${identity.linkCount}; task sources must have exactly one physical link.`,
    );
  }
  if (!contained(realRoot, identity.realPath)) {
    throw migrationError(`${file.filePath} resolves outside its planned bundle/component root.`);
  }
  if (expectedFileIdentity && !sameFileIdentity(identity, expectedFileIdentity)) {
    throw migrationError(`${file.filePath} file identity drifted after migration preflight.`);
  }
  const bytes = fs.readFileSync(file.filePath);
  const afterStat = fs.lstatSync(file.filePath);
  const afterIdentity = physicalIdentity(file.filePath, "file");
  const afterRootIdentity = physicalIdentity(file.containmentRoot, "directory");
  const afterBundleRootIdentity = plannedIdentity.bundleRoot
    ? physicalIdentity(plannedIdentity.bundleRoot.realPath, "directory")
    : afterRootIdentity;
  if (
    !afterStat.isFile() ||
    (afterStat.mode & 0o777) !== mode ||
    !sameFileIdentity(identity, afterIdentity) ||
    !sameIdentity(currentRootIdentity, afterRootIdentity) ||
    !sameIdentity(currentBundleRootIdentity, afterBundleRootIdentity)
  ) {
    throw migrationError(`${file.filePath} identity or mode drifted while it was being revalidated.`);
  }
  return Object.freeze({ bytes, identity: afterIdentity });
}

function validatePlannedV3(file: TaskToV3Changed, bytes: Buffer): void {
  parseTaskV3Yaml({
    yaml: bytes.toString("utf8"),
    filePath: file.filePath,
    ...(file.containmentRoot ? { workspaceRoot: file.containmentRoot } : {}),
  });
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function relativeBackupPath(backupRoot: string, absolute: string): string {
  return path.relative(backupRoot, absolute).replaceAll("\\", "/");
}

function entryForChange(backupRoot: string, change: TaskToV3Changed): TaskMigrationBackupEntry {
  const identities = change.inspectionIdentity;
  if (!identities || !change.containmentRoot) {
    throw migrationError(`${change.filePath} has no stable filesystem provenance for backup.`);
  }
  const sourcePath = sourceIdentityKey(change);
  return Object.freeze({
    sourcePath,
    backupPath: relativeBackupPath(backupRoot, taskMigrationBackupPath(backupRoot, sourcePath)),
    finalPath: relativeBackupPath(backupRoot, taskMigrationFinalPath(backupRoot, sourcePath)),
    mode: change.mode,
    beforeHash: change.beforeHash,
    finalHash: change.afterHash,
    sourceIdentity: identities.file,
    componentRootIdentity: identities.root,
    bundleRootIdentity: identities.bundleRoot ?? identities.root,
  });
}

function manifestEntryForFile(
  manifest: TaskMigrationBackupManifest,
  file: TaskToV3Changed,
): TaskMigrationBackupEntry {
  const sourcePath = sourceIdentityKey(file);
  const entry = manifest.files.find((candidate) => candidate.sourcePath === sourcePath);
  if (!entry) throw migrationError(`${file.filePath} has no declared artifact in the main migration backup.`);
  return entry;
}

function sameFilesystemIdentity(
  left: TaskToV3FilesystemIdentity,
  right: TaskToV3FilesystemIdentity,
): boolean {
  return (
    left.realPath === right.realPath &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.linkCount === right.linkCount
  );
}

function assertPlanMatchesBackupManifest(
  plan: TaskToV3MigrationPlan,
  manifest: TaskMigrationBackupManifest,
): void {
  const changes = plan.files.filter((file): file is TaskToV3Changed => file.status === "changed");
  if (changes.length !== manifest.files.length) {
    throw migrationError("main-backup task declarations do not match the authorized plan file set.");
  }
  for (const change of changes) {
    const entry = manifestEntryForFile(manifest, change);
    const identities = change.inspectionIdentity;
    if (
      !identities ||
      entry.mode !== change.mode ||
      entry.beforeHash !== change.beforeHash ||
      entry.finalHash !== change.afterHash ||
      !sameFileIdentity(entry.sourceIdentity, identities.file) ||
      !sameFilesystemIdentity(entry.componentRootIdentity, identities.root) ||
      !sameFilesystemIdentity(entry.bundleRootIdentity, identities.bundleRoot ?? identities.root)
    ) {
      throw migrationError(`main-backup provenance for ${change.filePath} does not match the authorized plan.`);
    }
  }
}

function readRecoveryJournal(
  journalPath: string,
  manifest: TaskMigrationBackupManifest,
): Map<string, TaskMigrationRecoveryState> {
  if (!fs.existsSync(journalPath)) throw migrationError(`recovery journal ${journalPath} is missing.`);
  let value: Partial<TaskMigrationRecoveryJournal>;
  try {
    value = JSON.parse(
      readTextFileWithLimit(journalPath, MAX_LOCAL_METADATA_BYTES, "Task migration recovery journal"),
    ) as Partial<TaskMigrationRecoveryJournal>;
  } catch (cause) {
    throw migrationError(
      `recovery journal ${journalPath} is unreadable: ${cause instanceof Error ? cause.message : String(cause)}.`,
    );
  }
  if (
    value.schemaVersion !== 1 ||
    value.operationId !== manifest.operationId ||
    value.generation !== manifest.generation ||
    !Array.isArray(value.files)
  ) {
    throw migrationError(`recovery journal ${journalPath} does not match this backup operation and generation.`);
  }
  const declared = new Set(manifest.files.map((entry) => entry.sourcePath));
  const states = new Map<string, TaskMigrationRecoveryState>();
  let previous = "";
  for (const entry of value.files) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.sourcePath !== "string" ||
      !declared.has(entry.sourcePath) ||
      !["not-started", "backed-up", "published", "restored"].includes(entry.state ?? "") ||
      (previous !== "" && entry.sourcePath <= previous)
    ) {
      throw migrationError(`recovery journal ${journalPath} contains an invalid or undeclared task state.`);
    }
    previous = entry.sourcePath;
    states.set(entry.sourcePath, entry.state as TaskMigrationRecoveryState);
  }
  return states;
}

function serializeRecoveryJournal(
  manifest: TaskMigrationBackupManifest,
  states: Map<string, TaskMigrationRecoveryState>,
): string {
  const journal: TaskMigrationRecoveryJournal = {
    schemaVersion: 1,
    operationId: manifest.operationId,
    generation: manifest.generation,
    files: [...states]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([entrySourcePath, entryState]) => ({ sourcePath: entrySourcePath, state: entryState })),
  };
  return `${JSON.stringify(journal, null, 2)}\n`;
}

function writeRecoveryState(
  journalPath: string,
  manifest: TaskMigrationBackupManifest,
  states: Map<string, TaskMigrationRecoveryState>,
  sourcePath: string,
  state: TaskMigrationRecoveryState,
): void {
  states.set(sourcePath, state);
  atomicReplace(journalPath, Buffer.from(serializeRecoveryJournal(manifest, states)), 0o600);
}

function assertTaskBackupEntryShape(entry: TaskMigrationBackupEntry): void {
  const digest = crypto.createHash("sha256").update(entry.sourcePath).digest("hex");
  if (
    !path.isAbsolute(entry.sourcePath) ||
    entry.sourcePath !== entry.sourceIdentity.realPath ||
    entry.backupPath !== `tasks/${digest}.before` ||
    entry.finalPath !== `tasks/${digest}.after` ||
    !Number.isInteger(entry.mode) ||
    entry.mode < 0 ||
    entry.mode > 0o777 ||
    !/^[a-f0-9]{64}$/.test(entry.beforeHash) ||
    !/^[a-f0-9]{64}$/.test(entry.finalHash) ||
    !contained(entry.bundleRootIdentity.realPath, entry.componentRootIdentity.realPath) ||
    !contained(entry.componentRootIdentity.realPath, entry.sourceIdentity.realPath)
  ) {
    throw migrationError(`task backup declaration for ${entry.sourcePath} is not canonical.`);
  }
  for (const identity of [entry.sourceIdentity, entry.componentRootIdentity, entry.bundleRootIdentity]) {
    if (
      !identity ||
      !path.isAbsolute(identity.realPath) ||
      typeof identity.device !== "string" ||
      identity.device.length === 0 ||
      typeof identity.inode !== "string" ||
      identity.inode.length === 0 ||
      typeof identity.linkCount !== "string" ||
      !/^[1-9][0-9]*$/.test(identity.linkCount) ||
      typeof identity.changeTimeNs !== "string" ||
      !/^[0-9]+$/.test(identity.changeTimeNs)
    ) {
      throw migrationError(`task backup declaration for ${entry.sourcePath} has invalid filesystem provenance.`);
    }
  }
  if (entry.sourceIdentity.linkCount !== "1") {
    throw migrationError(`task backup declaration for ${entry.sourcePath} declares a hard-linked source.`);
  }
}

/**
 * Add the immutable task leg to the still-private main-backup staging tree.
 * No source is written; every original is revalidated both before and after
 * the complete declared before/final artifact set is durably created.
 */
export function createTaskMigrationBackup(
  backupRoot: string,
  plan: TaskToV3MigrationPlan,
  operationId: string,
): TaskMigrationBackupManifest | undefined {
  if (!/^[A-Za-z0-9._-]+$/.test(operationId)) throw migrationError("backup operation id is invalid.");
  const blocked = plan.files.filter((file) => file.status === "blocked");
  if (blocked.length > 0) throw migrationError(`cannot back up blocked plan ${plan.generation}.`);
  const changes = plan.files.filter((file): file is TaskToV3Changed => file.status === "changed");
  if (changes.length === 0) return undefined;

  // Whole-plan source fence precedes the first task-backup artifact.
  for (const change of changes) {
    const expected = change.inspectionIdentity?.file;
    if (!expected) throw migrationError(`${change.filePath} has no source identity.`);
    const current = readPlannedSource(change, expected);
    if (!current.bytes.equals(change.before)) {
      throw migrationError(`${change.filePath} drifted before its main-backup artifacts were created.`);
    }
  }

  prepareBackupDirectory(backupRoot);
  const files = changes.map((change) => {
    const entry = entryForChange(backupRoot, change);
    durableCreate(path.join(backupRoot, entry.backupPath), change.before, 0o600);
    durableCreate(path.join(backupRoot, entry.finalPath), change.after, 0o600);
    return entry;
  });
  const manifest: TaskMigrationBackupManifest = Object.freeze({
    schemaVersion: 2 as const,
    operationId,
    generation: plan.generation,
    recoveryPath: "tasks/recovery.json" as const,
    files: Object.freeze(files),
  });
  const initialRecoveryStates = new Map<string, TaskMigrationRecoveryState>(
    files.map((entry) => [entry.sourcePath, "not-started"]),
  );
  durableCreate(
    path.join(backupRoot, manifest.recoveryPath),
    Buffer.from(serializeRecoveryJournal(manifest, initialRecoveryStates)),
    0o600,
  );
  verifyTaskMigrationBackup(backupRoot, manifest);

  for (const change of changes) {
    const expected = change.inspectionIdentity?.file;
    if (!expected) throw migrationError(`${change.filePath} has no source identity.`);
    const current = readPlannedSource(change, expected);
    if (!current.bytes.equals(change.before)) {
      throw migrationError(`${change.filePath} drifted while its main-backup artifacts were created.`);
    }
  }
  return manifest;
}

/** Strict recursive verification; the task directory may contain no extras. */
export function verifyTaskMigrationBackup(backupRoot: string, manifest: TaskMigrationBackupManifest): void {
  if (
    manifest.schemaVersion !== 2 ||
    !/^[A-Za-z0-9._-]+$/.test(manifest.operationId) ||
    !/^[a-f0-9]{64}$/.test(manifest.generation) ||
    manifest.recoveryPath !== "tasks/recovery.json" ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0
  ) {
    throw migrationError("task backup manifest is invalid.");
  }
  const tasksRoot = path.join(backupRoot, "tasks");
  const tasksStat = fs.lstatSync(tasksRoot);
  if (tasksStat.isSymbolicLink() || !tasksStat.isDirectory()) {
    throw migrationError(`task backup directory ${tasksRoot} must be a real directory.`);
  }
  if (process.platform !== "win32" && (tasksStat.mode & 0o777) !== 0o700) {
    throw migrationError(`task backup directory ${tasksRoot} must have mode 0700.`);
  }
  const expected = new Set<string>([path.basename(manifest.recoveryPath)]);
  const physicalTasks = new Map<string, string>();
  let previous = "";
  for (const entry of manifest.files) {
    assertTaskBackupEntryShape(entry);
    if (previous && entry.sourcePath <= previous) {
      throw migrationError("task backup declarations must be uniquely sorted by source path.");
    }
    previous = entry.sourcePath;
    const identityKey = physicalTaskIdentityKey(entry.sourceIdentity);
    const prior = physicalTasks.get(identityKey);
    if (prior) {
      throw migrationError(
        `task backup declares duplicate physical task identity ${identityKey} for ${prior} and ${entry.sourcePath}.`,
      );
    }
    physicalTasks.set(identityKey, entry.sourcePath);
    for (const [relative, expectedHash] of [
      [entry.backupPath, entry.beforeHash],
      [entry.finalPath, entry.finalHash],
    ] as const) {
      expected.add(path.basename(relative));
      const absolute = path.join(backupRoot, relative);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink() || !stat.isFile()) throw migrationError(`declared task artifact ${absolute} is not a file.`);
      if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) {
        throw migrationError(`declared task artifact ${absolute} must have mode 0600.`);
      }
      if (sha256(fs.readFileSync(absolute)) !== expectedHash) {
        throw migrationError(`declared task artifact ${absolute} failed hash verification.`);
      }
    }
  }
  const extras = fs.readdirSync(tasksRoot).filter((name) => !expected.has(name));
  if (extras.length > 0) throw migrationError(`task backup contains unexpected undeclared artifact(s): ${extras.join(", ")}.`);
  const recoveryPath = path.join(backupRoot, manifest.recoveryPath);
  const recoveryStat = fs.lstatSync(recoveryPath);
  if (recoveryStat.isSymbolicLink() || !recoveryStat.isFile()) {
    throw migrationError(`task recovery journal ${recoveryPath} must be a real regular file.`);
  }
  if (process.platform !== "win32" && (recoveryStat.mode & 0o777) !== 0o600) {
    throw migrationError(`task recovery journal ${recoveryPath} must have mode 0600.`);
  }
  const recoveryStates = readRecoveryJournal(recoveryPath, manifest);
  if (
    recoveryStates.size !== manifest.files.length ||
    manifest.files.some((entry) => !recoveryStates.has(entry.sourcePath))
  ) {
    throw migrationError("task recovery journal does not declare exactly the manifest task set.");
  }
}

/** Reconstruct the only authorized plan from a verified main backup. */
export function taskMigrationPlanFromBackup(
  backupRoot: string,
  manifest: TaskMigrationBackupManifest,
): TaskToV3MigrationPlan {
  verifyTaskMigrationBackup(backupRoot, manifest);
  const outcomes = manifest.files.map((entry): TaskToV3Changed => {
    const before = fs.readFileSync(path.join(backupRoot, entry.backupPath));
    const after = fs.readFileSync(path.join(backupRoot, entry.finalPath));
    return Object.freeze({
      status: "changed" as const,
      reason: "task-converted" as const,
      filePath: entry.sourcePath,
      before,
      beforeHash: entry.beforeHash,
      after,
      afterHash: entry.finalHash,
      mode: entry.mode,
      writable: true,
      onDiskWritable: true,
      containmentRoot: entry.componentRootIdentity.realPath,
      inspectionIdentity: Object.freeze({
        file: entry.sourceIdentity,
        root: entry.componentRootIdentity,
        bundleRoot: entry.bundleRootIdentity,
      }),
    });
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    generation: manifest.generation,
    files: Object.freeze(outcomes),
  });
}

/** Crash-resumable, conditional task restoration from a verified main backup. */
export function restoreTaskMigrationBackup(
  backupRoot: string,
  manifest: TaskMigrationBackupManifest,
  testHooks: Readonly<{ afterPublish?: (filePath: string) => void }> = {},
): void {
  const plan = taskMigrationPlanFromBackup(backupRoot, manifest);
  const pending: Array<{ change: TaskToV3Changed; identity: TaskToV3FilesystemIdentity }> = [];
  for (const file of plan.files) {
    if (file.status !== "changed") continue;
    const current = readPlannedSource(file);
    if (current.bytes.equals(file.before)) continue;
    if (!current.bytes.equals(file.after)) {
      throw migrationError(`${file.filePath} has a concurrent edit; explicit restore left it untouched.`);
    }
    pending.push({ change: file, identity: current.identity });
  }
  for (const { change, identity } of pending) {
    atomicReplace(change.filePath, change.before, change.mode, {
      beforeRename: () => {
        const current = readPlannedSource(change, identity);
        if (!current.bytes.equals(change.after)) {
          throw migrationError(`${change.filePath} changed immediately before restore publication.`);
        }
      },
      onPublished: () => testHooks.afterPublish?.(change.filePath),
    });
  }
  for (const file of plan.files) {
    if (file.status !== "changed") continue;
    const current = readPlannedSource(file);
    if (!current.bytes.equals(file.before)) throw migrationError(`${file.filePath} failed exact restore verification.`);
  }
}

/**
 * Apply one immutable plan. Every source is byte/generation-revalidated before
 * the first write; each source is then backed up immediately before its atomic
 * replacement. A later failure compensates replacements made in this call.
 */
export function applyTaskToV3MigrationPlan(
  plan: TaskToV3MigrationPlan,
  options: ApplyTaskToV3Options,
): AppliedTaskToV3Plan {
  const blocked = plan.files.filter((file) => file.status === "blocked");
  if (blocked.length > 0) {
    throw migrationError(
      `plan ${plan.generation} is blocked: ${blocked.map((file) => `${file.filePath} (${file.reason})`).join(", ")}. No files were written.`,
    );
  }
  if (options.backupManifest) {
    verifyTaskMigrationBackup(options.backupRoot, options.backupManifest);
    if (options.backupManifest.generation !== plan.generation) {
      throw migrationError(
        `plan generation ${plan.generation} does not match main-backup generation ${options.backupManifest.generation}.`,
      );
    }
    assertPlanMatchesBackupManifest(plan, options.backupManifest);
  }
  const recoveryJournalPath = options.backupManifest
    ? path.join(options.backupRoot, options.backupManifest.recoveryPath)
    : undefined;
  const recoveryStates =
    recoveryJournalPath && options.backupManifest
      ? readRecoveryJournal(recoveryJournalPath, options.backupManifest)
      : undefined;

  const alreadyApplied = new Set<string>();
  // Whole-plan drift fence before creating the backup directory or mutating a source.
  for (const file of plan.files) {
    const sourcePath = sourceIdentityKey(file);
    let current: SourceSnapshot;
    try {
      current = readPlannedSource(file);
    } catch (cause) {
      throw migrationError(`cannot revalidate ${file.filePath}: ${cause instanceof Error ? cause.message : String(cause)}.`);
    }
    if (file.status === "changed" && current.bytes.equals(file.after)) {
      const state = recoveryStates?.get(sourcePath);
      if (recoveryStates && state !== "backed-up" && state !== "published") {
        throw migrationError(`${file.filePath} has final bytes without an authorized publication state.`);
      }
      validatePlannedV3(file, current.bytes);
      alreadyApplied.add(sourcePath);
      continue;
    }
    const state = recoveryStates?.get(sourcePath);
    if (
      !file.inspectionIdentity ||
      (!sameFileIdentity(current.identity, file.inspectionIdentity.file) &&
        (!recoveryStates || (state !== "published" && state !== "restored")))
    ) {
      throw migrationError(`${file.filePath} file identity drifted after migration preflight; it was left untouched.`);
    }
    if (!current.bytes.equals(file.before)) {
      throw migrationError(`${file.filePath} changed after migration preflight (generation drift); it was left untouched.`);
    }
  }

  const replaced: Array<{
    change: TaskToV3Changed;
    backupPath: string;
    publishedIdentity?: TaskToV3FilesystemIdentity;
  }> = [];
  try {
    for (const file of plan.files) {
      const sourcePath = sourceIdentityKey(file);
      if (file.status !== "changed" || alreadyApplied.has(sourcePath)) continue;
      // Complete generated-document validation is repeated immediately before publication.
      validatePlannedV3(file, file.after);
      const declared = options.backupManifest ? manifestEntryForFile(options.backupManifest, file) : undefined;
      const backupPath = declared
        ? path.join(options.backupRoot, declared.backupPath)
        : ensureBackup(options.backupRoot, file);
      verifyRegularFile(backupPath, file.before, "recoverable backup");
      if (declared) {
        verifyRegularFile(path.join(options.backupRoot, declared.finalPath), file.after, "authorized final artifact");
      }
      if (!file.inspectionIdentity) throw migrationError(`${file.filePath} has no planned file identity.`);
      const recoveryState = recoveryStates?.get(sourcePath);
      const expectedIdentity =
        recoveryState === "published" || recoveryState === "restored"
          ? undefined
          : file.inspectionIdentity.file;
      const current = readPlannedSource(file, expectedIdentity);
      if (!current.bytes.equals(file.before)) {
        throw migrationError(`${file.filePath} drifted between backup and replacement; it was left untouched.`);
      }
      if (recoveryJournalPath && options.backupManifest && recoveryStates) {
        writeRecoveryState(
          recoveryJournalPath,
          options.backupManifest,
          recoveryStates,
          sourcePath,
          "backed-up",
        );
      }
      // Record immediately after rename, before the directory fsync that can
      // still fail after the new inode has become visible.
      atomicReplace(file.filePath, file.after, file.mode, {
        beforeRename: () => {
          // Test hooks model the last possible external race. Run them before
          // the final fence so no hook-side link/metadata drift can slip into
          // the rename window after identity was already accepted.
          options.testHooks?.beforePublish?.(file.filePath);
          const immediate = readPlannedSource(file, current.identity);
          if (!immediate.bytes.equals(file.before)) {
            throw migrationError(`${file.filePath} drifted immediately before atomic replacement; it was left untouched.`);
          }
        },
        onPublished: () => {
          let publishedIdentity: TaskToV3FilesystemIdentity | undefined;
          try {
            publishedIdentity = physicalIdentity(file.filePath, "file");
          } finally {
            replaced.push({ change: file, backupPath, ...(publishedIdentity ? { publishedIdentity } : {}) });
          }
          if (recoveryJournalPath && options.backupManifest && recoveryStates) {
            writeRecoveryState(
              recoveryJournalPath,
              options.backupManifest,
              recoveryStates,
              sourcePath,
              "published",
            );
          }
          options.testHooks?.afterPublish?.(file.filePath);
        },
      });
      const publishedIdentity = replaced.at(-1)?.publishedIdentity;
      if (!publishedIdentity) throw migrationError(`${file.filePath} publication identity could not be recorded.`);
      const published = readPlannedSource(file, publishedIdentity);
      if (!published.bytes.equals(file.after))
        throw migrationError(`${file.filePath} failed post-replacement byte verification.`);
      validatePlannedV3(file, published.bytes);
    }
  } catch (cause) {
    const compensationFailures: string[] = [];
    for (const { change, backupPath, publishedIdentity } of [...replaced].reverse()) {
      try {
        const sourcePath = sourceIdentityKey(change);
        verifyRegularFile(backupPath, change.before, "recoverable backup");
        if (!publishedIdentity) throw new Error("published file identity was not captured; current source was left untouched");
        const current = readPlannedSource(change);
        if (!sameFileIdentity(current.identity, publishedIdentity) || !current.bytes.equals(change.after)) {
          throw new Error("concurrent source drift detected; current source was left untouched");
        }
        const backup = fs.readFileSync(backupPath);
        atomicReplace(change.filePath, backup, change.mode, {
          beforeRename: () => {
            const immediate = readPlannedSource(change, publishedIdentity);
            if (!immediate.bytes.equals(change.after)) {
              throw new Error("concurrent source drift detected immediately before compensation; source was left untouched");
            }
          },
        });
        const restored = readPlannedSource(change);
        if (!restored.bytes.equals(change.before)) throw new Error("restored source bytes do not match the plan");
        if (recoveryJournalPath && options.backupManifest && recoveryStates) {
          writeRecoveryState(
            recoveryJournalPath,
            options.backupManifest,
            recoveryStates,
            sourcePath,
            "restored",
          );
        }
      } catch (restoreCause) {
        compensationFailures.push(`${change.filePath}: ${restoreCause instanceof Error ? restoreCause.message : String(restoreCause)}`);
      }
    }
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw migrationError(
      compensationFailures.length > 0
        ? `${detail} Compensation also failed for ${compensationFailures.join("; ")}. Recover from ${options.backupRoot}.`
        : `${detail} Earlier replacements were restored from ${options.backupRoot}.`,
    );
  }

  return Object.freeze({
    generation: plan.generation,
    changed: Object.freeze(replaced.map(({ change }) => change.filePath)),
    alreadyApplied: Object.freeze([...alreadyApplied].sort(compareStrings)),
  });
}
