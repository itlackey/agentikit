// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import crypto from "node:crypto";
import path from "node:path";
import { isBundleSlug } from "./asset/asset-ref";

/** Deterministic, filesystem-safe bundle slug from a source path. */
export function slugForPath(sourcePath: string): string {
  const resolved = path.resolve(sourcePath);
  const base = path
    .basename(resolved)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (base.length > 0) return base;
  return `bundle-${shortHash(resolved)}`;
}

/** Derive one batch-unique bundle id. */
export function deriveBundleId(registryId: string | undefined, sourcePath: string, usedIds: Set<string>): string {
  const preferred =
    registryId && registryId.length > 0 && isBundleSlug(registryId) ? registryId : slugForPath(sourcePath);
  const id = ensureUniqueId(preferred, sourcePath, usedIds);
  usedIds.add(id);
  return id;
}

/** Derive an ordered batch while reserving every explicit configured bundle id. */
export function deriveBundleIds(sources: readonly { registryId?: string; path: string }[]): string[] {
  const usedIds = new Set<string>();
  const reservedIds = new Set(
    sources.flatMap((source) => (source.registryId && isBundleSlug(source.registryId) ? [source.registryId] : [])),
  );
  return sources.map((source) => {
    const id =
      source.registryId && isBundleSlug(source.registryId)
        ? deriveBundleId(source.registryId, source.path, usedIds)
        : deriveBundleId(undefined, source.path, new Set([...usedIds, ...reservedIds]));
    usedIds.add(id);
    return id;
  });
}

function ensureUniqueId(preferred: string, sourcePath: string, used: Set<string>): string {
  if (!used.has(preferred)) return preferred;
  const suffixed = `${preferred}-${shortHash(path.resolve(sourcePath))}`;
  if (!used.has(suffixed)) return suffixed;
  let n = 2;
  while (used.has(`${suffixed}-${n}`)) n++;
  return `${suffixed}-${n}`;
}

function shortHash(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 8);
}
