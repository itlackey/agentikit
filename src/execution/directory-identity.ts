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

function requireContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new UsageError(`${candidate} escapes its execution root.`, "PATH_ESCAPE_VIOLATION");
  }
}
