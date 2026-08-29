// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Filesystem boundary for the explicit task-v2 to task-v3 converter. */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "../../../src/core/errors";
import { fsyncDirectoryPortable } from "./durable-fs";
import { parseTaskV3Yaml } from "./task-source-v3-frozen";
import {
  type TaskToV3Changed,
  type TaskToV3FileInput,
  type TaskToV3FilesystemIdentity,
  type TaskToV3MigrationPlan,
} from "./task-to-v3";

export interface TaskToV3Root {
  readonly bundleId: string;
  readonly root: string;
  readonly bundleRoot?: string;
  readonly writable: boolean;
  readonly layout?: "akm-stash" | "akm-task";
}

export interface ApplyTaskToV3Options {
  readonly backupRoot: string;
}

export interface AppliedTaskToV3Plan {
  readonly generation: string;
  readonly changed: readonly string[];
}

interface Snapshot {
  readonly bytes: Buffer;
  readonly mode: number;
  readonly identity: TaskToV3FilesystemIdentity;
}

function migrationError(detail: string): ConfigError {
  return new ConfigError(`Task migration to v3 failed: ${detail}`, "INVALID_CONFIG_FILE");
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function identity(filePath: string, kind: "file" | "directory"): TaskToV3FilesystemIdentity {
  const stat = fs.lstatSync(filePath, { bigint: true });
  const valid = kind === "file" ? stat.isFile() : stat.isDirectory();
  if (stat.isSymbolicLink() || !valid) throw migrationError(`${filePath} must be a real ${kind}.`);
  if (kind === "file" && stat.nlink !== 1n) throw migrationError(`${filePath} must not be hard-linked.`);
  return Object.freeze({
    realPath: fs.realpathSync(filePath),
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    linkCount: stat.nlink.toString(),
    changeTimeNs: stat.ctimeNs.toString(),
  });
}

function sameIdentity(left: TaskToV3FilesystemIdentity, right: TaskToV3FilesystemIdentity): boolean {
  return (
    left.realPath === right.realPath &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.linkCount === right.linkCount &&
    left.changeTimeNs === right.changeTimeNs
  );
}

function snapshot(filePath: string): Snapshot {
  const before = identity(filePath, "file");
  const stat = fs.lstatSync(filePath);
  const bytes = fs.readFileSync(filePath);
  const after = identity(filePath, "file");
  if (!sameIdentity(before, after)) throw migrationError(`${filePath} changed while it was read.`);
  return Object.freeze({ bytes, mode: stat.mode & 0o777, identity: after });
}

function writable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function walkTasks(root: TaskToV3Root, tasksDir: string, out: TaskToV3FileInput[]): void {
  const rootIdentity = identity(root.root, "directory");
  const bundleIdentity = identity(root.bundleRoot ?? root.root, "directory");
  const physicalRoot = rootIdentity.realPath;
  if (!contained(bundleIdentity.realPath, physicalRoot)) {
    throw migrationError(`${root.root} resolves outside bundle ${root.bundleId}.`);
  }

  const visit = (directory: string): void => {
    const physicalDirectory = fs.realpathSync(directory);
    if (!contained(physicalRoot, physicalDirectory)) {
      throw migrationError(`${directory} resolves outside bundle ${root.bundleId}.`);
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw migrationError(`task migration does not follow symbolic link ${candidate}.`);
      if (entry.isDirectory()) {
        visit(candidate);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".yml")) continue;
      const current = snapshot(candidate);
      const parent = path.dirname(candidate);
      out.push({
        filePath: candidate,
        bytes: current.bytes,
        mode: current.mode,
        writable: root.writable,
        onDiskWritable: writable(candidate) && writable(parent) && (current.mode & 0o222) !== 0,
        containmentRoot: physicalRoot,
        inspectionIdentity: Object.freeze({
          file: current.identity,
          root: rootIdentity,
          bundleRoot: bundleIdentity,
        }),
      });
    }
  };
  visit(tasksDir);
}

export function inspectTaskToV3Files(roots: readonly TaskToV3Root[]): TaskToV3FileInput[] {
  const files: TaskToV3FileInput[] = [];
  for (const root of [...roots].sort((a, b) => a.bundleId.localeCompare(b.bundleId))) {
    const tasksDir = root.layout === "akm-task" ? root.root : path.join(root.root, "tasks");
    try {
      const stat = fs.lstatSync(tasksDir);
      if (stat.isSymbolicLink()) throw migrationError(`task migration does not follow symbolic link ${tasksDir}.`);
      if (!stat.isDirectory()) throw migrationError(`${tasksDir} must be a directory.`);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw cause;
    }
    walkTasks(root, tasksDir, files);
  }
  return files.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

function hashPath(filePath: string): string {
  return crypto.createHash("sha256").update(path.resolve(filePath)).digest("hex").slice(0, 16);
}

export function taskMigrationBackupPath(backupRoot: string, filePath: string): string {
  return path.join(backupRoot, "files", `${hashPath(filePath)}-${path.basename(filePath)}`);
}

function writeDurable(filePath: string, bytes: Buffer, mode: number, exclusive = false): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const flags = exclusive ? "wx" : "w";
  const fd = fs.openSync(filePath, flags, mode);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(filePath, mode);
  fsyncDirectoryPortable(path.dirname(filePath));
}

function replaceAtomically(filePath: string, bytes: Buffer, mode: number): void {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.migrate-${crypto.randomUUID()}`);
  try {
    writeDurable(temporary, bytes, mode, true);
    fs.renameSync(temporary, filePath);
    fsyncDirectoryPortable(path.dirname(filePath));
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }
}

function assertUnchanged(change: TaskToV3Changed): Snapshot {
  const current = snapshot(change.filePath);
  if (!current.bytes.equals(change.before) || current.mode !== change.mode) {
    throw migrationError(`${change.filePath} changed after preview; no task files were replaced.`);
  }
  const planned = change.inspectionIdentity?.file;
  if (planned && !sameIdentity(planned, current.identity)) {
    throw migrationError(`${change.filePath} identity changed after preview; no task files were replaced.`);
  }
  return current;
}

export function applyTaskToV3MigrationPlan(
  plan: TaskToV3MigrationPlan,
  options: ApplyTaskToV3Options,
): AppliedTaskToV3Plan {
  const blocked = plan.files.filter((file) => file.status === "blocked");
  if (blocked.length > 0) {
    throw migrationError(
      `plan is blocked: ${blocked.map((file) => `${file.filePath} (${file.reason})`).join(", ")}. No files were written.`,
    );
  }
  const changes = plan.files.filter((file): file is TaskToV3Changed => file.status === "changed");
  for (const change of changes) {
    assertUnchanged(change);
    parseTaskV3Yaml({
      yaml: change.after.toString("utf8"),
      filePath: change.filePath,
      ...(change.containmentRoot ? { workspaceRoot: change.containmentRoot } : {}),
    });
  }

  for (const change of changes) {
    writeDurable(taskMigrationBackupPath(options.backupRoot, change.filePath), change.before, change.mode, true);
  }

  const replaced: TaskToV3Changed[] = [];
  try {
    for (const change of changes) {
      assertUnchanged(change);
      replaceAtomically(change.filePath, change.after, change.mode);
      replaced.push(change);
    }
  } catch (cause) {
    for (const change of [...replaced].reverse()) {
      const current = snapshot(change.filePath);
      if (!current.bytes.equals(change.after)) continue;
      replaceAtomically(change.filePath, fs.readFileSync(taskMigrationBackupPath(options.backupRoot, change.filePath)), change.mode);
    }
    throw cause;
  }

  return Object.freeze({ generation: plan.generation, changed: Object.freeze(changes.map((file) => file.filePath)) });
}
