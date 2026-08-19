// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Filesystem boundary for the pure task-v2 to task-v3 planner. */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "../../../src/core/errors";
import {
  planTaskV2ToV3File,
  type TaskV2ToV3Changed,
  type TaskV2ToV3FileInput,
  type TaskV2ToV3FilesystemIdentity,
  type TaskV2ToV3MigrationPlan,
} from "../../../src/tasks/migrate-v2-to-v3";
import { parseTaskV3Yaml } from "../../../src/tasks/source-v3";

export interface TaskV2ToV3Root {
  readonly bundleId: string;
  readonly root: string;
  readonly writable: boolean;
  /** `akm-task` owns `.yml` files at its component root; `akm` owns `tasks/`. */
  readonly layout?: "akm-stash" | "akm-task";
}

export interface ApplyTaskV2ToV3Options {
  readonly backupRoot: string;
  /** TEST-ONLY interleaving seam for deterministic crash/concurrency coverage. */
  readonly testHooks?: Readonly<{
    afterPublish?: (filePath: string) => void;
  }>;
}

export interface AppliedTaskV2ToV3Plan {
  readonly generation: string;
  readonly changed: readonly string[];
  readonly alreadyApplied: readonly string[];
}

function migrationError(detail: string): ConfigError {
  return new ConfigError(`Task-v2 to task-v3 migration failed: ${detail}`, "INVALID_CONFIG_FILE");
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

function physicalIdentity(filePath: string, expectedKind: "file" | "directory"): TaskV2ToV3FilesystemIdentity {
  const stat = fs.lstatSync(filePath, { bigint: true });
  if (stat.isSymbolicLink() || (expectedKind === "file" ? !stat.isFile() : !stat.isDirectory())) {
    throw migrationError(`${filePath} must remain a real ${expectedKind}.`);
  }
  return Object.freeze({
    realPath: fs.realpathSync(filePath),
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
  });
}

function inspectRegularFile(filePath: string): {
  readonly bytes: Buffer;
  readonly identity: TaskV2ToV3FilesystemIdentity;
  readonly mode: number;
} {
  const identity = physicalIdentity(filePath, "file");
  const stat = fs.lstatSync(filePath);
  const mode = stat.mode & 0o777;
  const bytes = fs.readFileSync(filePath);
  const afterStat = fs.lstatSync(filePath);
  const afterIdentity = physicalIdentity(filePath, "file");
  if ((afterStat.mode & 0o777) !== mode || !sameIdentity(identity, afterIdentity)) {
    throw migrationError(`${filePath} identity or mode drifted while migration preflight read it.`);
  }
  return Object.freeze({ bytes, identity: afterIdentity, mode });
}

function sameIdentity(left: TaskV2ToV3FilesystemIdentity, right: TaskV2ToV3FilesystemIdentity): boolean {
  return left.realPath === right.realPath && left.device === right.device && left.inode === right.inode;
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
  root: TaskV2ToV3Root,
  rootIdentity: TaskV2ToV3FilesystemIdentity,
  tasksDir: string,
  out: TaskV2ToV3FileInput[],
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
        }),
      });
    }
  };
  visit(tasksDir);
}

/** Read the complete `.yml` task set under each bundle without writing. */
export function inspectTaskV2ToV3Files(roots: readonly TaskV2ToV3Root[]): TaskV2ToV3FileInput[] {
  const inputs: TaskV2ToV3FileInput[] = [];
  const identities = new Map<string, string>();
  for (const root of [...roots].sort((left, right) => compareStrings(left.bundleId, right.bundleId))) {
    const rootStat = lstatIfPresent(root.root);
    if (!rootStat) continue;
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw migrationError(`bundle ${root.bundleId} root ${root.root} must be a real directory.`);
    }
    const rootIdentity = physicalIdentity(root.root, "directory");
    const prior = identities.get(rootIdentity.realPath);
    if (prior)
      throw migrationError(`bundles ${prior} and ${root.bundleId} resolve to the same root ${rootIdentity.realPath}.`);
    identities.set(rootIdentity.realPath, root.bundleId);
    const tasksDir = root.layout === "akm-task" ? root.root : path.join(root.root, "tasks");
    const taskStat = lstatIfPresent(tasksDir);
    if (!taskStat) continue;
    if (taskStat.isSymbolicLink()) throw migrationError(`tasks directory ${tasksDir} is a symbolic link.`);
    if (!taskStat.isDirectory()) throw migrationError(`tasks path ${tasksDir} is not a directory.`);
    walkTaskFiles(root, rootIdentity, tasksDir, inputs);
    if (!sameIdentity(physicalIdentity(root.root, "directory"), rootIdentity)) {
      throw migrationError(`bundle ${root.bundleId} root identity drifted while migration preflight inspected it.`);
    }
  }
  return inputs.sort((left, right) => compareStrings(left.filePath, right.filePath));
}

/** Stable, recoverable per-file backup location within one migration operation. */
export function taskMigrationBackupPath(backupRoot: string, filePath: string): string {
  const digest = crypto.createHash("sha256").update(path.resolve(filePath)).digest("hex");
  const safeName = path.basename(filePath).replace(/[^A-Za-z0-9_.-]/g, "_");
  return path.join(backupRoot, "task-v2-to-v3", `${digest}-${safeName}`);
}

function fsyncDirectory(directory: string): void {
  try {
    if (process.platform === "win32") return;
    const fd = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR" && code !== "EPERM") throw cause;
  }
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
  fsyncDirectory(parent);
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
    fsyncDirectory(path.dirname(filePath));
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
  const directory = path.join(backupRoot, "task-v2-to-v3");
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

function expectedBackupMetadata(change: TaskV2ToV3Changed): Buffer {
  return Buffer.from(
    `${JSON.stringify({ schemaVersion: 1, source: change.filePath, mode: change.mode, beforeHash: change.beforeHash }, null, 2)}\n`,
  );
}

function verifyRegularFile(filePath: string, expected: Buffer, label: string): void {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw migrationError(`${label} ${filePath} must be a real regular file.`);
  if (!fs.readFileSync(filePath).equals(expected)) throw migrationError(`${label} ${filePath} failed byte verification.`);
}

function ensureBackup(backupRoot: string, change: TaskV2ToV3Changed): string {
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
  readonly identity: TaskV2ToV3FilesystemIdentity;
}

function readPlannedSource(
  file: TaskV2ToV3MigrationPlan["files"][number],
  expectedFileIdentity?: TaskV2ToV3FilesystemIdentity,
): SourceSnapshot {
  const plannedIdentity = file.inspectionIdentity;
  if (!plannedIdentity || !file.containmentRoot) {
    throw migrationError(`${file.filePath} has no filesystem identity recorded by migration preflight.`);
  }
  const currentRootIdentity = physicalIdentity(file.containmentRoot, "directory");
  if (!sameIdentity(currentRootIdentity, plannedIdentity.root)) {
    throw migrationError(`${file.filePath} component-root identity drifted after migration preflight.`);
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
  if (!contained(realRoot, identity.realPath)) {
    throw migrationError(`${file.filePath} resolves outside its planned bundle/component root.`);
  }
  if (expectedFileIdentity && !sameIdentity(identity, expectedFileIdentity)) {
    throw migrationError(`${file.filePath} file identity drifted after migration preflight.`);
  }
  const bytes = fs.readFileSync(file.filePath);
  const afterStat = fs.lstatSync(file.filePath);
  const afterIdentity = physicalIdentity(file.filePath, "file");
  const afterRootIdentity = physicalIdentity(file.containmentRoot, "directory");
  if (
    !afterStat.isFile() ||
    (afterStat.mode & 0o777) !== mode ||
    !sameIdentity(identity, afterIdentity) ||
    !sameIdentity(currentRootIdentity, afterRootIdentity)
  ) {
    throw migrationError(`${file.filePath} identity or mode drifted while it was being revalidated.`);
  }
  return Object.freeze({ bytes, identity: afterIdentity });
}

function samePlannedChange(expected: TaskV2ToV3Changed, current: Buffer): boolean {
  const replanned = planTaskV2ToV3File({
    filePath: expected.filePath,
    bytes: current,
    mode: expected.mode,
    writable: expected.writable,
    ...(expected.onDiskWritable !== undefined ? { onDiskWritable: expected.onDiskWritable } : {}),
    ...(expected.containmentRoot ? { containmentRoot: expected.containmentRoot } : {}),
    ...(expected.inspectionIdentity ? { inspectionIdentity: expected.inspectionIdentity } : {}),
  });
  return replanned.status === "changed" && replanned.afterHash === expected.afterHash && replanned.after.equals(expected.after);
}

function validatePlannedV3(file: TaskV2ToV3Changed, bytes: Buffer): void {
  parseTaskV3Yaml({
    yaml: bytes.toString("utf8"),
    filePath: file.filePath,
    ...(file.containmentRoot ? { workspaceRoot: file.containmentRoot } : {}),
  });
}

/**
 * Apply one immutable plan. Every source is byte/generation-revalidated before
 * the first write; each source is then backed up immediately before its atomic
 * replacement. A later failure compensates replacements made in this call.
 */
export function applyTaskV2ToV3MigrationPlan(
  plan: TaskV2ToV3MigrationPlan,
  options: ApplyTaskV2ToV3Options,
): AppliedTaskV2ToV3Plan {
  const blocked = plan.files.filter((file) => file.status === "blocked");
  if (blocked.length > 0) {
    throw migrationError(
      `plan ${plan.generation} is blocked: ${blocked.map((file) => `${file.filePath} (${file.reason})`).join(", ")}. No files were written.`,
    );
  }

  const alreadyApplied = new Set<string>();
  // Whole-plan drift fence before creating the backup directory or mutating a source.
  for (const file of plan.files) {
    let current: SourceSnapshot;
    try {
      current = readPlannedSource(file);
    } catch (cause) {
      throw migrationError(`cannot revalidate ${file.filePath}: ${cause instanceof Error ? cause.message : String(cause)}.`);
    }
    if (file.status === "changed" && current.bytes.equals(file.after)) {
      validatePlannedV3(file, current.bytes);
      alreadyApplied.add(file.filePath);
      continue;
    }
    if (!file.inspectionIdentity || !sameIdentity(current.identity, file.inspectionIdentity.file)) {
      throw migrationError(`${file.filePath} file identity drifted after migration preflight; it was left untouched.`);
    }
    if (!current.bytes.equals(file.before)) {
      throw migrationError(`${file.filePath} changed after migration preflight (generation drift); it was left untouched.`);
    }
    if (file.status === "changed" && !samePlannedChange(file, current.bytes)) {
      throw migrationError(`${file.filePath} no longer produces generation ${plan.generation}; it was left untouched.`);
    }
  }

  const replaced: Array<{
    change: TaskV2ToV3Changed;
    backupPath: string;
    publishedIdentity?: TaskV2ToV3FilesystemIdentity;
  }> = [];
  try {
    for (const file of plan.files) {
      if (file.status !== "changed" || alreadyApplied.has(file.filePath)) continue;
      // Complete generated-document validation is repeated immediately before publication.
      validatePlannedV3(file, file.after);
      const backupPath = ensureBackup(options.backupRoot, file);
      if (!file.inspectionIdentity) throw migrationError(`${file.filePath} has no planned file identity.`);
      const current = readPlannedSource(file, file.inspectionIdentity.file);
      if (!current.bytes.equals(file.before) || !samePlannedChange(file, current.bytes)) {
        throw migrationError(`${file.filePath} drifted between backup and replacement; it was left untouched.`);
      }
      // Record immediately after rename, before the directory fsync that can
      // still fail after the new inode has become visible.
      atomicReplace(file.filePath, file.after, file.mode, {
        beforeRename: () => {
          const immediate = readPlannedSource(file, file.inspectionIdentity?.file);
          if (!immediate.bytes.equals(file.before) || !samePlannedChange(file, immediate.bytes)) {
            throw migrationError(`${file.filePath} drifted immediately before atomic replacement; it was left untouched.`);
          }
        },
        onPublished: () => {
          let publishedIdentity: TaskV2ToV3FilesystemIdentity | undefined;
          try {
            publishedIdentity = physicalIdentity(file.filePath, "file");
          } finally {
            replaced.push({ change: file, backupPath, ...(publishedIdentity ? { publishedIdentity } : {}) });
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
        verifyRegularFile(backupPath, change.before, "recoverable backup");
        if (!publishedIdentity) throw new Error("published file identity was not captured; current source was left untouched");
        const current = readPlannedSource(change);
        if (!sameIdentity(current.identity, publishedIdentity) || !current.bytes.equals(change.after)) {
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
