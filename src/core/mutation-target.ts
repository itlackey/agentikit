// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import { deriveInstallations } from "../indexer/installations";
import { resolveSourceEntries, type SearchSource } from "../indexer/search/search-source";
import { type AssetRef, displayRef } from "./asset/resolve-ref";
import { resolveStashDir } from "./common";
import type { AkmConfig } from "./config/config";
import { UsageError } from "./errors";
import {
  prepareWriteTargetForMutation,
  type ResolvedWriteTarget,
  resolveWorkingStashTarget,
  resolveWriteTarget,
} from "./write-source";

export interface ResolvedMutationTarget {
  target: ResolvedWriteTarget;
  /** Ref with the resolved source's stable identity, suitable for durable use. */
  ref: AssetRef;
  /** User-facing spelling, short only for the configured default bundle. */
  displayRef: string;
}

interface CanonicalSource {
  bundleId: string;
  source: SearchSource;
}

function canonicalSources(config: AkmConfig): CanonicalSource[] {
  const sources = resolveSourceEntries(undefined, config);
  const installations = deriveInstallations(sources);
  return sources.flatMap((source, index) => {
    const bundleId = installations[index]?.id;
    return bundleId ? [{ bundleId, source }] : [];
  });
}

function targetForCanonicalSource(
  config: AkmConfig,
  canonical: CanonicalSource,
  options: { requireWritable?: boolean },
): ResolvedWriteTarget {
  const target = canonical.source.registryId
    ? resolveWriteTarget(config, canonical.source.registryId, options)
    : resolveWorkingStashTarget(config, options);
  if (path.resolve(target.source.path) !== path.resolve(canonical.source.path)) {
    throw new UsageError(`Bundle "${canonical.bundleId}" no longer resolves to its indexed source root.`);
  }
  return target;
}

/** Resolve the canonical bundle id currently assigned to a write target. */
export function canonicalBundleIdForTarget(config: AkmConfig, target: ResolvedWriteTarget): string {
  return (
    canonicalSources(config).find(
      (candidate) => path.resolve(candidate.source.path) === path.resolve(target.source.path),
    )?.bundleId ?? target.source.name
  );
}

/** Resolve a canonical bundle qualifier to its writable target without preparing a Git boundary. */
export function resolveBundleWriteTarget(
  config: AkmConfig,
  bundleId: string,
  options: { requireWritable?: boolean } = {},
): ResolvedWriteTarget {
  const canonical = canonicalSources(config).find((candidate) => candidate.bundleId === bundleId);
  if (!canonical) {
    throw new UsageError(`Bundle "${bundleId}" is not configured.`, "INVALID_FLAG_VALUE");
  }
  const target = targetForCanonicalSource(config, canonical, options);
  return { ...target, source: { ...target.source, name: canonical.bundleId } };
}

function resolveExplicitMutationTarget(
  config: AkmConfig,
  explicitTarget: string,
  options: { requireWritable?: boolean },
): ResolvedWriteTarget {
  try {
    return resolveWriteTarget(config, explicitTarget, options);
  } catch (error) {
    try {
      return resolveBundleWriteTarget(config, explicitTarget, options);
    } catch {
      throw error;
    }
  }
}

/** Reconcile a qualified mutation ref with `--target`, then resolve the write destination. */
export function resolveMutationTarget(
  config: AkmConfig,
  ref: AssetRef,
  explicitTarget?: string,
  options: { requireWritable?: boolean; allowedAdapters?: readonly string[] } = {},
): ResolvedMutationTarget {
  const writeOptions = { requireWritable: options.requireWritable };
  const qualifiedTarget = ref.origin ? resolveBundleWriteTarget(config, ref.origin, writeOptions) : undefined;
  const explicitResolved = explicitTarget
    ? resolveExplicitMutationTarget(config, explicitTarget, writeOptions)
    : undefined;
  if (
    qualifiedTarget &&
    explicitResolved &&
    path.resolve(qualifiedTarget.source.path) !== path.resolve(explicitResolved.source.path)
  ) {
    throw new UsageError(
      `Qualified ref bundle "${ref.origin}" conflicts with --target "${explicitTarget}".`,
      "INVALID_FLAG_VALUE",
      `Drop --target or select the same bundle.`,
    );
  }

  let target = qualifiedTarget ?? explicitResolved ?? resolveWriteTarget(config, undefined, writeOptions);
  const bundleId = ref.origin ?? canonicalBundleIdForTarget(config, target);
  target = prepareWriteTargetForMutation(
    { ...target, source: { ...target.source, name: bundleId } },
    { allowedAdapters: options.allowedAdapters },
  );
  const stableRef = { ...ref, origin: bundleId };
  const defaultBundle = defaultBundleForTarget(config, target);
  return {
    target,
    ref: stableRef,
    displayRef: displayRef({ type: stableRef.type, name: stableRef.name, bundleId: stableRef.origin }, defaultBundle),
  };
}

export function defaultBundleForTarget(config: AkmConfig, target: ResolvedWriteTarget): string | undefined {
  if (config.defaultBundle) return config.defaultBundle;
  try {
    return path.resolve(target.source.path) === path.resolve(resolveStashDir({ readOnly: true }))
      ? target.source.name
      : undefined;
  } catch {
    return undefined;
  }
}
