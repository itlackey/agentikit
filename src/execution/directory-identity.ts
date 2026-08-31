// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { UsageError } from "../core/errors";

export interface FrozenDirectoryIdentity {
  readonly requestedRoot: string;
  readonly realRoot: string;
  readonly rootDevice: string;
  readonly rootInode: string;
  readonly requestedCwd: string;
  readonly realCwd: string;
  readonly cwdDevice: string;
  readonly cwdInode: string;
}

export function captureFrozenDirectoryIdentity(rootInput: string, relativeCwd?: string): FrozenDirectoryIdentity {
  const requestedRoot = path.resolve(rootInput);
  const requestedCwd = path.resolve(requestedRoot, relativeCwd ?? ".");
  requireContained(requestedRoot, requestedCwd);
  const realRoot = fs.realpathSync(requestedRoot);
  const realCwd = fs.realpathSync(requestedCwd);
  requireContained(realRoot, realCwd);
  const rootStat = fs.statSync(realRoot, { bigint: true });
  const cwdStat = fs.statSync(realCwd, { bigint: true });
  if (!rootStat.isDirectory() || !cwdStat.isDirectory()) {
    throw new UsageError("Execution root and cwd must both be directories.", "INVALID_FLAG_VALUE");
  }
  return Object.freeze({
    requestedRoot,
    realRoot,
    rootDevice: rootStat.dev.toString(),
    rootInode: rootStat.ino.toString(),
    requestedCwd,
    realCwd,
    cwdDevice: cwdStat.dev.toString(),
    cwdInode: cwdStat.ino.toString(),
  });
}

/**
 * Re-verify, immediately before spawn, that a frozen cwd still resolves
 * inside its execution root — path containment and resolved-path identity,
 * NOT device/inode identity. Unlike the removed assertFrozenDirectoryIdentity,
 * this does not compare device/inode numbers against the frozen snapshot: a
 * remount, an rsync, or a container rebuild that leaves the same real
 * content at the same real PATH must not abort a dispatch. What still
 * throws is anything that changes the resolved real PATH itself — a
 * symlink swap, an ancestor swap, a file replacing the directory, or the
 * root itself being replaced by a symlink elsewhere (root-vs-cwd
 * containment alone can't catch that last one, since both resolve together
 * under the new root; comparing the root's own resolved path to its frozen
 * value catches it).
 */
export function assertFrozenDirectoryContained(identity: FrozenDirectoryIdentity): void {
  let realRoot: string;
  let realCwd: string;
  try {
    realRoot = fs.realpathSync(identity.requestedRoot);
    realCwd = fs.realpathSync(identity.requestedCwd);
  } catch {
    throw changed(identity.requestedCwd);
  }
  if (realRoot !== identity.realRoot) throw changed(identity.requestedCwd);
  const relative = path.relative(realRoot, realCwd);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw changed(identity.requestedCwd);
  }
  let cwdStat: fs.BigIntStats;
  try {
    cwdStat = fs.statSync(realCwd, { bigint: true });
  } catch {
    throw changed(identity.requestedCwd);
  }
  if (!cwdStat.isDirectory()) throw changed(identity.requestedCwd);
}

function changed(cwd: string): UsageError {
  return new UsageError(
    `Frozen execution cwd ${cwd} changed and no longer resolves inside its root.`,
    "PATH_ESCAPE_VIOLATION",
  );
}

function requireContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new UsageError(`${candidate} escapes its execution root.`, "PATH_ESCAPE_VIOLATION");
  }
}
