// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { adapterForId } from "../../core/adapter/registry";
import { isWithin } from "../../core/common";
import { buildFileContext } from "../walk/file-context";

/**
 * Probe one adapter/component for an exact physical concept owner.
 *
 * This is intentionally scoped to one source. Callers decide installation
 * priority and must stop at the first owning source rather than searching
 * later components for a preferred adapter.
 */
export function adapterOwnsConceptOnDisk(sourcePath: string, adapterId: string, conceptId: string): boolean {
  const adapter = adapterForId(adapterId);
  if (!adapter) return false;
  const normalized = conceptId.replaceAll("\\", "/");
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.normalize(normalized) !== normalized
  ) {
    return false;
  }

  const extensions = [...adapter.extensions].sort((left, right) => right.length - left.length);
  const extension = extensions.find((candidate) => normalized.toLowerCase().endsWith(candidate.toLowerCase()));
  const extensionless = extension ? normalized.slice(0, -extension.length) : normalized;
  const parent = path.join(sourcePath, path.posix.dirname(extensionless));
  let realRoot: string;
  let realParent: string;
  try {
    realRoot = fs.realpathSync(sourcePath);
    realParent = fs.realpathSync(parent);
  } catch {
    return false;
  }
  if (!isWithin(realParent, realRoot)) return false;

  const basename = path.posix.basename(extensionless);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(realParent, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const recognizedExtension = extensions.find(
      (candidate) =>
        entry.name.toLowerCase().endsWith(candidate.toLowerCase()) &&
        entry.name.slice(0, -candidate.length) === basename,
    );
    if (!recognizedExtension) continue;
    const candidatePath = path.join(realParent, entry.name);
    const document = adapter.recognize(
      { id: adapterId, adapter: adapterId, root: realRoot, writable: false },
      buildFileContext(realRoot, candidatePath),
    );
    if (document) return true;
  }
  return false;
}
