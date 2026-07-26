// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { deriveBundleId, slugForPath } from "../../../../src/core/bundle-id";

/** Frozen pre-reservation derivation used to re-key persisted migration state. */
export function deriveLegacyBundleIds(sources: readonly { registryId?: string; path: string }[]): string[] {
  const usedIds = new Set<string>();
  return sources.map((source) => deriveBundleId(source.registryId, source.path, usedIds));
}

/** Recover pre-reservation ids from a migrated, reserved-id source list. */
export function inferLegacyBundleIds(sources: readonly { id: string; registryId?: string; path: string }[]): string[] {
  const configuredIds = new Set(sources.map((source) => source.id));
  return deriveLegacyBundleIds(
    sources.map((source) => {
      if (source.registryId) return { path: source.path, registryId: source.registryId };
      const pathSlug = slugForPath(source.path);
      const collidingPathId = deriveBundleId(undefined, source.path, new Set([pathSlug]));
      const collisionSuffix = source.id.slice(collidingPathId.length);
      const pathDerived =
        source.id === pathSlug ||
        (configuredIds.has(pathSlug) &&
          (source.id === collidingPathId ||
            (source.id.startsWith(collidingPathId) && /^-(?:[2-9]|[1-9]\d+)$/.test(collisionSuffix))));
      return pathDerived ? { path: source.path } : { path: source.path, registryId: source.id };
    }),
  );
}
