// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { UsageError } from "../core/errors";

export interface FrozenExecutableIdentity {
  readonly requested: string;
  readonly absolutePath: string;
  readonly realPath: string;
  readonly device: string;
  readonly inode: string;
  readonly size: number;
  readonly sha256: string;
}

export function freezeExecutableIdentity(
  requested: string,
  options: { readonly cwd?: string; readonly path?: string } = {},
): FrozenExecutableIdentity {
  const absolutePath = resolveExecutable(
    requested,
    options.cwd ?? process.cwd(),
    options.path ?? process.env.PATH ?? "",
  );
  let realPath: string;
  let stat: fs.BigIntStats;
  let bytes: Buffer;
  try {
    fs.accessSync(absolutePath, fs.constants.X_OK);
    realPath = fs.realpathSync(absolutePath);
    stat = fs.lstatSync(realPath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular executable file");
    bytes = fs.readFileSync(realPath);
  } catch {
    throw new UsageError(`Executable ${JSON.stringify(requested)} could not be frozen.`, "INVALID_FLAG_VALUE");
  }
  return Object.freeze({
    requested,
    absolutePath,
    realPath,
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

export function decodeFrozenExecutableIdentity(value: unknown, label = "executable"): FrozenExecutableIdentity {
  if (!isRecord(value)) throw invalid(label);
  const allowed = new Set(["requested", "absolutePath", "realPath", "device", "inode", "size", "sha256"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw invalid(label);
  if (
    typeof value.requested !== "string" ||
    typeof value.absolutePath !== "string" ||
    !path.isAbsolute(value.absolutePath) ||
    typeof value.realPath !== "string" ||
    !path.isAbsolute(value.realPath) ||
    typeof value.device !== "string" ||
    typeof value.inode !== "string" ||
    !Number.isSafeInteger(value.size) ||
    (value.size as number) < 0 ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.sha256)
  ) {
    throw invalid(label);
  }
  const decoded = Object.freeze({
    requested: value.requested,
    absolutePath: value.absolutePath,
    realPath: value.realPath,
    device: value.device,
    inode: value.inode,
    size: value.size as number,
    sha256: value.sha256,
  });
  assertFrozenExecutableIdentity(decoded, label);
  return decoded;
}

export function assertFrozenExecutableIdentity(identity: FrozenExecutableIdentity, label = "executable"): void {
  let actual: FrozenExecutableIdentity;
  try {
    actual = freezeExecutableIdentity(identity.absolutePath, { cwd: path.dirname(identity.absolutePath) });
  } catch {
    throw changed(label);
  }
  for (const key of ["absolutePath", "realPath", "device", "inode", "size", "sha256"] as const) {
    if (actual[key] !== identity[key]) throw changed(label);
  }
}

function resolveExecutable(requested: string, cwd: string, pathValue: string): string {
  if (requested.includes("/") || requested.includes("\\")) return path.resolve(cwd, requested);
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.resolve(directory, `${requested}${extension}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Continue through the frozen search path.
      }
    }
  }
  throw new UsageError(`Executable ${JSON.stringify(requested)} was not found.`, "INVALID_FLAG_VALUE");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(label: string): UsageError {
  return new UsageError(`Frozen ${label} identity is invalid.`, "INVALID_FLAG_VALUE");
}

function changed(label: string): UsageError {
  return new UsageError(`Frozen ${label} changed after publication.`, "RESOURCE_ALREADY_EXISTS");
}
