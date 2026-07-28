// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Source operations: list, remove, update.
 *
 * Provides unified operations across all configured bundle source providers.
 * The CLI's `akm list`, `akm remove`, and `akm update` commands are wired here.
 *
 * 0.9.0 (spec §10.1/§10.2): the retired `installed[]` array is gone — a
 * registry-managed source is now a `bundles.<slug>` entry (the desired locator)
 * paired with a lock entry (the resolved `localRoot`/version). A bundle that has
 * a lock entry is "managed" (installed from a registry and overwritten on
 * `akm update`); a bundle with no lock is a plain filesystem/git/website source.
 */

import fs from "node:fs";
import path from "node:path";
import { isWithin, resolveStashDir } from "../../core/common";
import type { AkmConfig, BundleConfigEntry } from "../../core/config/config";
import { getSources, loadConfig } from "../../core/config/config";
import { ConfigError, NotFoundError, UsageError } from "../../core/errors";
import { getDbPath } from "../../core/paths";
import { warn } from "../../core/warn";
import { withAssetMutationLease } from "../../indexer/index-writer-lock";
import { akmIndex } from "../../indexer/indexer";
import type { LockfileEntry } from "../../integrations/lockfile";
import { compareAndSwapLockfile, readLockfile } from "../../integrations/lockfile";
import { parseRegistryRef } from "../../registry/resolve";
import type { InstalledBundle, InstallKind } from "../../registry/types";
import { sha256Hex } from "../../runtime";
import { parseGitRepoUrl, syncMirroredRepo } from "../../sources/providers/git";
import { syncFromRef } from "../../sources/providers/sync-from-ref";
import {
  ensureWebsiteMirror,
  shouldAllowPrivateWebsiteUrlForTests,
} from "../../sources/snapshot-fetchers/website-ingest";
import type {
  RemoveResponse,
  SourceComponent,
  SourceDescriptor,
  SourceEntry,
  SourceKind,
  SourceListResponse,
  SourceLock,
  UpdatePlainSyncedItem,
  UpdateResponse,
  UpdateResultItem,
  UpdateSkippedItem,
} from "../../sources/types";
import type { Database } from "../../storage/database";
import { closeDatabase, openReadonlyExistingDatabase } from "../../storage/repositories/index-connection";
import { getAllEntries } from "../../storage/repositories/index-entries-repository";
import { removeInstalledRegistryEntry } from "./source-add";
import { removeStash } from "./source-manage";

/**
 * A registry-managed source: its `bundles` entry (desired locator) joined with
 * its lock entry (resolved cache state). `installId` is the original registry id
 * — the bundle's preserved `registryId`, else the slug-legal bundle key used
 * verbatim.
 */
interface ManagedInstall {
  bundleKey: string;
  installId: string;
  source: InstallKind;
  ref: string;
  localRoot: string;
  resolvedVersion?: string;
  resolvedRevision?: string;
  writable: boolean;
  requiredRoots: string[];
}

/** Enumerate the registry-managed installs (lock-backed bundles) in a config. */
function listManagedInstalls(config: AkmConfig): ManagedInstall[] {
  const bundles = config.bundles ?? {};
  const locks = new Map(readLockfile().map((entry) => [entry.id, entry]));
  const out: ManagedInstall[] = [];
  for (const [key, bundle] of Object.entries(bundles)) {
    const lock = locks.get(key);
    if (!lock) continue; // only lock-backed bundles are registry-managed
    const componentWritable = Object.values(bundle.components ?? {})[0]?.writable;
    out.push({
      bundleKey: key,
      installId: bundle.registryId ?? key,
      source: lock.source,
      ref: lock.ref,
      localRoot: lock.localRoot ?? "",
      resolvedVersion: lock.resolvedVersion,
      resolvedRevision: lock.resolvedRevision,
      writable: componentWritable ?? bundle.writable === true,
      requiredRoots: lock.localRoot
        ? Object.values(bundle.components ?? {}).map((component) =>
            path.resolve(lock.localRoot as string, component.root ?? "."),
          )
        : [],
    });
  }
  return out;
}

/** Resolve an `akm remove`/`akm update` target to a managed install, if any. */
function resolveManagedTarget(config: AkmConfig, target: string): ManagedInstall | undefined {
  const installs = listManagedInstalls(config);
  const byId = installs.find((m) => m.installId === target || m.bundleKey === target);
  if (byId) return byId;
  const byRef = installs.find((m) => m.ref === target);
  if (byRef) return byRef;
  const isUrl = target.startsWith("http://") || target.startsWith("https://");
  if (!isUrl) {
    const resolved = path.resolve(target);
    const byPath = installs.find((m) => m.localRoot && path.resolve(m.localRoot) === resolved);
    if (byPath) return byPath;
  }
  let parsedId: string | undefined;
  try {
    parsedId = parseRegistryRef(target).id;
  } catch {
    parsedId = undefined;
  }
  if (parsedId) return installs.find((m) => m.installId === parsedId);
  return undefined;
}

function describeBundleSource(entry: BundleConfigEntry): SourceDescriptor {
  if (entry.path) return { kind: "path", locator: entry.path };
  if (entry.git) return { kind: "git", locator: entry.git };
  if (entry.website) {
    return {
      kind: "website",
      locator: entry.website.url,
      ...(entry.website.maxPages !== undefined ? { maxPages: entry.website.maxPages } : {}),
    };
  }
  return { kind: "npm", locator: entry.npm ?? "" };
}

function describeComponents(entry: BundleConfigEntry): SourceComponent[] {
  return Object.entries(entry.components ?? {}).map(([name, component]) => ({
    name,
    ...(component.root !== undefined ? { root: component.root } : {}),
    ...(component.adapter !== undefined ? { adapter: component.adapter } : {}),
    ...(component.writable !== undefined ? { writable: component.writable } : {}),
  }));
}

function describeLock(entry: LockfileEntry | undefined): SourceLock | null {
  if (!entry) return null;
  return {
    source: entry.source,
    ref: entry.ref,
    ...(entry.resolvedVersion !== undefined ? { resolvedVersion: entry.resolvedVersion } : {}),
    ...(entry.resolvedRevision !== undefined ? { resolvedRevision: entry.resolvedRevision } : {}),
    ...(entry.integrity !== undefined ? { integrity: entry.integrity } : {}),
    ...(entry.localRoot !== undefined ? { localRoot: entry.localRoot } : {}),
    ...(entry.manifestDigest !== undefined ? { manifestDigest: entry.manifestDigest } : {}),
    ...(entry.adapterIds !== undefined ? { adapterIds: entry.adapterIds } : {}),
    ...(entry.installedAt !== undefined ? { installedAt: entry.installedAt } : {}),
  };
}

interface BundleCounts {
  itemCount: number;
  byType: Record<string, number>;
}

function readBundleCounts(): Map<string, BundleCounts> {
  const counts = new Map<string, BundleCounts>();
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) return counts;

  let db: Database | undefined;
  try {
    db = openReadonlyExistingDatabase(dbPath);
    if (!db) return counts;
    for (const row of getAllEntries(db)) {
      if (!row.bundleId) continue;
      const count = counts.get(row.bundleId) ?? { itemCount: 0, byType: {} };
      count.itemCount += 1;
      count.byType[row.entry.type] = (count.byType[row.entry.type] ?? 0) + 1;
      counts.set(row.bundleId, count);
    }
  } catch (error) {
    warn(`[akm list] failed to read bundle counts from ${dbPath}: ${String(error)}`);
  } finally {
    if (db) {
      try {
        closeDatabase(db);
      } catch {
        // The inventory read is already complete; a close failure is non-fatal.
      }
    }
  }
  return counts;
}

export async function akmListSources(input?: { stashDir?: string; kind?: SourceKind[] }): Promise<SourceListResponse> {
  const stashDir = input?.stashDir ?? resolveStashDir();
  const config = loadConfig();
  const kindFilter = input?.kind;
  const locks = new Map(readLockfile().map((entry) => [entry.id, entry]));
  const counts = readBundleCounts();

  const sources: SourceEntry[] = [];

  for (const bundle of getSources(config)) {
    const key = bundle.name ?? bundle.path ?? bundle.url ?? "unknown";
    const configured = config.bundles?.[key];
    if (!configured) continue;
    const lock = locks.get(key);
    const kind = bundle.type as SourceKind;
    if (kindFilter && !kindFilter.includes(kind)) continue;
    const root = lock?.localRoot ?? bundle.path ?? "";
    const componentWritable = Object.values(configured.components ?? {})[0]?.writable;
    const bundleCounts = counts.get(key) ?? { itemCount: 0, byType: {} };
    sources.push({
      name: key,
      kind,
      default: key === config.defaultBundle,
      source: describeBundleSource(configured),
      ...(root ? { path: root } : {}),
      ...(lock ? { ref: lock.ref } : {}),
      provider: bundle.url != null ? bundle.type : undefined,
      ...(lock?.resolvedVersion !== undefined ? { version: lock.resolvedVersion } : {}),
      writable: componentWritable ?? bundle.writable ?? kind === "filesystem",
      ...(configured.registryId !== undefined ? { registryId: configured.registryId } : {}),
      components: describeComponents(configured),
      lock: describeLock(lock),
      itemCount: bundleCounts.itemCount,
      byType: bundleCounts.byType,
      status: { exists: root ? directoryExists(root) : true },
    });
  }

  return {
    schemaVersion: 1,
    stashDir,
    defaultBundle: config.defaultBundle ?? null,
    sources,
    totalSources: sources.length,
  };
}

export async function akmRemove(input: { target: string; stashDir?: string }): Promise<RemoveResponse> {
  const target = input.target.trim();
  if (!target)
    throw new UsageError(
      "Target is required. Provide the source id, ref, path, URL, or name (e.g. `akm remove npm:@scope/stash` or `akm remove ~/my-stash`).",
    );

  const stashDir = input.stashDir ?? resolveStashDir();
  const config = loadConfig();

  // Registry-managed installs (lock-backed bundles) first.
  const managed = resolveManagedTarget(config, target);
  if (managed) {
    const updatedConfig = await removeInstalledRegistryEntry(managed.installId);
    if (managed.source !== "local" && managed.localRoot) {
      cleanupDirectoryBestEffort(managed.localRoot, "remove");
    }
    const index = await akmIndex({ stashDir });

    return {
      schemaVersion: 1,
      stashDir,
      target,
      removed: {
        id: managed.installId,
        source: managed.source,
        ref: managed.ref,
        cacheDir: managed.localRoot,
        stashRoot: managed.localRoot,
      },
      config: {
        sourceCount: getSources(updatedConfig).length,
      },
      index: {
        mode: index.mode,
        totalEntries: index.totalEntries,
        directoriesScanned: index.directoriesScanned,
        directoriesSkipped: index.directoriesSkipped,
      },
    };
  }

  // Plain sources (filesystem/git/website bundles) via the bundle-map remover.
  const stashResult = removeStash(target);
  if (!stashResult.removed || !stashResult.entry) {
    throw new NotFoundError(`No matching source for target: ${target}`, "SOURCE_NOT_FOUND");
  }

  const removedEntry = stashResult.entry;
  const index = await akmIndex({ stashDir });
  const updatedConfig = loadConfig();

  return {
    schemaVersion: 1,
    stashDir,
    target,
    removed: {
      id: removedEntry.name ?? removedEntry.path ?? removedEntry.url ?? target,
      source: removedEntry.type,
      ref: removedEntry.path ?? removedEntry.url ?? target,
      cacheDir: "",
      stashRoot: removedEntry.path ?? "",
    },
    config: {
      sourceCount: getSources(updatedConfig).length,
    },
    index: {
      mode: index.mode,
      totalEntries: index.totalEntries,
      directoriesScanned: index.directoriesScanned,
      directoriesSkipped: index.directoriesSkipped,
    },
  };
}

// ── akmUpdate helpers ────────────────────────────────────────────────────────

/** Build a standard UpdateResponse summary block from the current config and index run. */
async function buildUpdateResponse(
  stashDir: string,
  target: string | undefined,
  all: boolean,
  processed: UpdateResponse["processed"],
  opts?: {
    full?: boolean;
    plainSynced?: UpdatePlainSyncedItem[];
    skipped?: UpdateSkippedItem[];
    index?: Awaited<ReturnType<typeof akmIndex>>;
  },
): Promise<UpdateResponse> {
  const index = opts?.index ?? (await akmIndex({ stashDir, ...(opts?.full ? { full: true } : {}) }));
  const finalConfig = loadConfig();
  return {
    schemaVersion: 1,
    stashDir,
    target,
    all,
    processed,
    ...(opts?.plainSynced?.length ? { plainSynced: opts.plainSynced } : {}),
    ...(opts?.skipped?.length ? { skipped: opts.skipped } : {}),
    config: {
      sourceCount: getSources(finalConfig).length,
    },
    index: {
      mode: index.mode,
      totalEntries: index.totalEntries,
      directoriesScanned: index.directoriesScanned,
      directoriesSkipped: index.directoriesSkipped,
    },
  };
}

/**
 * Sync a git-mirrored (plain) source in place. Returns the {@link UpdatePlainSyncedItem}
 * record instead of building the full response, so `--all` can batch several of
 * these into one response alongside managed installs (R-015).
 */
async function syncGitPlainSource(gitSource: ReturnType<typeof getSources>[number]): Promise<UpdatePlainSyncedItem> {
  await syncMirroredRepo(gitSource, { force: true, writable: gitSource.writable === true });
  return { id: gitSource.name ?? gitSource.url ?? "", kind: "git", ref: gitSource.url ?? "" };
}

/** Re-crawl a website (plain) source in place. See {@link syncGitPlainSource}. */
async function syncWebsitePlainSource(
  websiteSource: ReturnType<typeof getSources>[number],
): Promise<UpdatePlainSyncedItem> {
  // TODO: full incremental re-crawl with delta tracking (#19)
  await ensureWebsiteMirror(websiteSource, {
    requireStashDir: true,
    force: true,
    ...(shouldAllowPrivateWebsiteUrlForTests(websiteSource.url ?? "") ? { allowPrivateHosts: true } : {}),
  });
  return { id: websiteSource.name ?? websiteSource.url ?? "", kind: "website", ref: websiteSource.url ?? "" };
}

/** Sync a git-mirrored (plain) source and return an UpdateResponse (single-target path). */
async function updateGitSource(
  stashDir: string,
  target: string,
  all: boolean,
  gitSource: ReturnType<typeof getSources>[number],
): Promise<UpdateResponse> {
  const synced = await syncGitPlainSource(gitSource);
  return buildUpdateResponse(stashDir, target, all, [], { full: true, plainSynced: [synced] });
}

/** Re-crawl a website (plain) source and return an UpdateResponse (single-target path). */
async function updateWebsiteSource(
  stashDir: string,
  target: string,
  all: boolean,
  websiteSource: ReturnType<typeof getSources>[number],
): Promise<UpdateResponse> {
  const synced = await syncWebsitePlainSource(websiteSource);
  return buildUpdateResponse(stashDir, target, all, [], { plainSynced: [synced] });
}

/**
 * A plain (lockless) npm bundle has no deterministic content path — unlike
 * git/website, resolving an npm package requires a registry round-trip to
 * pick a concrete version/tarball, which is exactly what the lock records.
 * So a plain npm source is synced via the same registry-install pipeline as
 * `akm add <package>` and PROMOTED to a registry-managed (lock-backed)
 * install as a side effect of its first successful sync; it is reported via
 * `processed` like any other managed install from then on. Building a
 * {@link ManagedInstall} view onto the plain entry lets this reuse
 * {@link updateManagedInstall} verbatim rather than duplicating its lock/config
 * bookkeeping.
 */
function managedInstallViewOfPlainNpm(npmSource: ReturnType<typeof getSources>[number]): ManagedInstall {
  const spec = npmSource.path ?? "";
  const ref = spec.startsWith("npm:") ? spec : `npm:${spec}`;
  const id = npmSource.name ?? ref;
  return {
    bundleKey: id,
    installId: id,
    source: "npm",
    ref,
    localRoot: "",
    resolvedVersion: undefined,
    resolvedRevision: undefined,
    writable: false,
    requiredRoots: [],
  };
}

/**
 * Sync a single registry-managed install and return the processed record.
 *
 * `yes` gates ONLY the destructive branch below (deleting a previous
 * `localRoot` whose content moved) — it has no effect on the sync itself. A
 * normal refresh that resolves the SAME content directory (the overwhelming
 * majority of updates) never reaches that branch, so it never prompts and
 * never requires `--yes` (F1/R-058: `update` must stay usable bare in
 * scripts; only the branch that can `rm -rf` needs a gate, not the whole
 * command).
 */
async function updateManagedInstall(
  managed: ManagedInstall,
  force: boolean,
  yes: boolean,
  stashDir: string,
): Promise<{ item: UpdateResultItem; index: Awaited<ReturnType<typeof akmIndex>> }> {
  // No pre-cleanup of the old root, even under --force: the providers already
  // re-materialize staging-first (git clones into a `.tmp-*` sibling and swaps
  // only on success), so destroying `managed.localRoot` BEFORE `syncFromRef`
  // succeeds would turn any sync failure (network down, bad ref) into losing a
  // previously-working install. The old root is cleaned up below only after
  // config/lock publication and reindexing both succeed.
  const synced = await syncFromRef(managed.ref, {
    force,
    writable: managed.writable,
    ...(managed.writable && managed.localRoot ? { writableRoot: managed.localRoot } : {}),
    ...(managed.writable && managed.requiredRoots.length > 0 ? { writableRequiredRoots: managed.requiredRoots } : {}),
  });

  const installedEntry: InstalledBundle = {
    id: managed.installId,
    // Preserve the original source classification. syncFromRef() re-derives the
    // source type from the ref scheme (e.g. "github:" → source: "github"), but
    // an update should not reclassify an existing entry.
    source: managed.source,
    ref: synced.ref,
    artifactUrl: synced.artifactUrl,
    resolvedVersion: synced.resolvedVersion,
    resolvedRevision: synced.resolvedRevision,
    stashRoot: synced.contentDir,
    cacheDir: synced.cacheDir,
    installedAt: synced.syncedAt,
    writable: synced.writable ?? managed.writable,
  };
  const movedRoot =
    managed.localRoot !== "" &&
    path.resolve(managed.localRoot) !== path.resolve(synced.contentDir) &&
    managed.source !== "local" &&
    !managed.writable;
  if (movedRoot) {
    const { confirmDestructive } = await import("../../cli/confirm.js");
    const confirmed = await confirmDestructive(
      `Update resolved a new content directory for "${managed.installId}" (${synced.contentDir}) and would delete the previous install directory at ${managed.localRoot}. This cannot be undone.`,
      { yes },
    );
    if (!confirmed) throw new UsageError(`Update cancelled for "${managed.installId}"; no configuration was changed.`);
  }

  return withAssetMutationLease("source-update", async () => {
    const config = loadConfig();
    const oldLocks = readLockfile();
    if (!config.bundles?.[managed.bundleKey]) {
      throw new ConfigError(`Managed source "${managed.installId}" disappeared before update publication.`);
    }
    const desiredLock: LockfileEntry = {
      id: managed.bundleKey,
      // Preserve the STORED install kind: a `github:`-ref entry recorded as
      // source "git" must not be reclassified by the sync flow's re-derivation.
      source: managed.source,
      ref: synced.ref,
      resolvedVersion: synced.resolvedVersion,
      resolvedRevision: synced.resolvedRevision,
      integrity: synced.integrity ?? (synced.source === "local" ? "local" : undefined),
      localRoot: synced.contentDir,
      installedAt: synced.syncedAt,
    };
    const desiredLocks = [...oldLocks.filter((entry) => entry.id !== desiredLock.id), desiredLock];
    const desiredLockGeneration = generationHash(desiredLocks);
    if (!(await compareAndSwapLockfile(oldLocks, desiredLocks))) throw concurrentGenerationError(managed);
    const index = await akmIndex({ stashDir });
    if (generationHash(readLockfile()) !== desiredLockGeneration) throw concurrentGenerationError(managed);

    if (movedRoot) {
      const currentConfig = loadConfig();
      const currentLocks = readLockfile();
      if (referencesRoot(managed.localRoot, currentConfig, currentLocks)) {
        warn(
          `[akm update] kept previous install directory at ${managed.localRoot} because another configured or locked bundle still references it.`,
        );
      } else {
        cleanupDirectoryBestEffort(managed.localRoot, "update");
      }
    }

    const versionChanged = (managed.resolvedVersion ?? "") !== (synced.resolvedVersion ?? "");
    const revisionChanged = (managed.resolvedRevision ?? "") !== (synced.resolvedRevision ?? "");
    return {
      index,
      item: {
        id: managed.installId,
        source: managed.source,
        ref: managed.ref,
        previous: {
          resolvedVersion: managed.resolvedVersion,
          resolvedRevision: managed.resolvedRevision,
          cacheDir: managed.localRoot,
        },
        installed: { ...installedEntry, extractedDir: synced.extractedDir },
        changed: {
          version: versionChanged,
          revision: revisionChanged,
          any: versionChanged || revisionChanged,
        },
      },
    };
  });
}

function generationHash(value: unknown): string {
  return sha256Hex(JSON.stringify(value));
}

function referencesRoot(target: string, config: AkmConfig, locks: LockfileEntry[]): boolean {
  const resolvedTarget = path.resolve(target);
  const locksById = new Map(locks.map((entry) => [entry.id, entry]));
  for (const [bundleId, bundle] of Object.entries(config.bundles ?? {})) {
    const root = bundle.path ?? locksById.get(bundleId)?.localRoot;
    if (!root) continue;
    if (isRootAtOrBelow(root, resolvedTarget)) return true;
    for (const component of Object.values(bundle.components ?? {})) {
      if (isRootAtOrBelow(path.resolve(root, component.root ?? "."), resolvedTarget)) return true;
    }
  }
  return locks.some((entry) => entry.localRoot && isRootAtOrBelow(entry.localRoot, resolvedTarget));
}

function isRootAtOrBelow(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  const lexicallyWithin =
    relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  return lexicallyWithin || isWithin(candidate, root);
}

function concurrentGenerationError(managed: ManagedInstall): ConfigError {
  return new ConfigError(
    `Managed source "${managed.installId}" changed concurrently; retained both materialized roots and deleted nothing.`,
    "INVALID_CONFIG_FILE",
    "Inspect `akm list` and retry the update after the concurrent source operation completes.",
  );
}

// ── akmUpdate dispatcher ─────────────────────────────────────────────────────

export async function akmUpdate(input?: {
  target?: string;
  all?: boolean;
  force?: boolean;
  stashDir?: string;
  /**
   * Skips the confirmation prompt for the destructive branch of
   * {@link updateManagedInstall} (deleting a previous `localRoot` whose
   * resolved content directory moved). Has no effect otherwise — most
   * updates never reach that branch (F1/R-058).
   */
  yes?: boolean;
}): Promise<UpdateResponse> {
  const stashDir = input?.stashDir ?? resolveStashDir();
  const target = input?.target?.trim();
  const all = input?.all === true;
  const force = input?.force === true;
  const yes = input?.yes === true;
  const config = loadConfig();
  const managedInstalls = listManagedInstalls(config);

  if (target && !all) {
    // Registry-managed install (lock-backed) — re-download from its locator.
    const managed = resolveManagedTarget(config, target);
    if (managed) {
      const updated = await updateManagedInstall(managed, force, yes, stashDir);
      return buildUpdateResponse(stashDir, target, all, [updated.item], { index: updated.index });
    }

    // Plain git / website source (bundles without a lock) — provider re-sync.
    const stashes = getSources(config);
    const isUrl = target.startsWith("http://") || target.startsWith("https://");
    const resolvedPath = !isUrl ? path.resolve(target) : undefined;
    const gitMatch = stashes.find((s) => {
      if (s.type !== "git") return false;
      if (isUrl && s.url === target) return true;
      if (resolvedPath && s.path && path.resolve(s.path) === resolvedPath) return true;
      if (s.name === target) return true;
      if (s.url) {
        try {
          const repo = parseGitRepoUrl(s.url);
          if (repo.canonicalUrl === target) return true;
        } catch {
          // Ignore malformed config here; later provider sync will surface it.
        }
      }
      return false;
    });
    if (gitMatch) return updateGitSource(stashDir, target, all, gitMatch);

    const websiteMatch = stashes.find((s) => {
      if (s.type !== "website") return false;
      if (isUrl && s.url === target) return true;
      if (s.name === target) return true;
      if (resolvedPath && s.path && path.resolve(s.path) === resolvedPath) return true;
      return false;
    });
    if (websiteMatch) return updateWebsiteSource(stashDir, target, all, websiteMatch);

    // Plain npm source (bundle without a lock) — sync via the registry
    // pipeline and promote to a managed install (see
    // managedInstallViewOfPlainNpm's doc comment for why npm can't stay
    // plain the way git/website do).
    const npmMatch = stashes.find((s) => {
      if (s.type !== "npm") return false;
      if (s.name === target) return true;
      if (s.path === target) return true;
      return false;
    });
    if (npmMatch) {
      const updated = await updateManagedInstall(managedInstallViewOfPlainNpm(npmMatch), force, yes, stashDir);
      return buildUpdateResponse(stashDir, target, all, [updated.item], { index: updated.index });
    }
  }

  const enabledManagedInstalls = all
    ? managedInstalls.filter((managed) => config.bundles?.[managed.bundleKey]?.enabled !== false)
    : managedInstalls;
  const selected = selectManagedTargets(config, enabledManagedInstalls, target, all);
  const processed: UpdateResponse["processed"] = [];
  let latestManagedIndex: Awaited<ReturnType<typeof akmIndex>> | undefined;
  for (const managed of selected) {
    const updated = await updateManagedInstall(managed, force, yes, stashDir);
    processed.push(updated.item);
    latestManagedIndex = updated.index;
  }

  // `--all` must account for EVERY configured source, not only the
  // registry-managed (lock-backed) ones (R-015) — `selectManagedTargets`
  // above returns only `installs` for `all`, so plain sources were
  // previously never even looked at. Git/npm plain sources are synced here
  // too (git in place; npm promoted to managed, same as the single-target
  // path above); website/filesystem sources have no `--all` sync path, so
  // they are reported as skipped with the same explanatory wording
  // `selectManagedTargets` already uses for a single unmatched target.
  let plainSynced: UpdatePlainSyncedItem[] | undefined;
  let skipped: UpdateSkippedItem[] | undefined;
  let sawGitSync = false;
  if (all) {
    const managedKeys = new Set(managedInstalls.map((m) => m.bundleKey));
    const plainSources = getSources(config).filter(
      (source) => source.enabled !== false && !managedKeys.has(source.name ?? ""),
    );
    plainSynced = [];
    skipped = [];
    for (const plain of plainSources) {
      const id = plain.name ?? plain.path ?? plain.url ?? "";
      try {
        if (plain.type === "git") {
          plainSynced.push(await syncGitPlainSource(plain));
          sawGitSync = true;
        } else if (plain.type === "npm") {
          const updated = await updateManagedInstall(managedInstallViewOfPlainNpm(plain), force, yes, stashDir);
          processed.push(updated.item);
          latestManagedIndex = updated.index;
        } else if (plain.type === "website") {
          skipped.push({
            id,
            kind: "website",
            reason: `website caching not yet implemented for --all; run \`akm update ${id}\` to re-mirror this source individually.`,
          });
        } else {
          skipped.push({
            id,
            kind: plain.type as SourceKind,
            reason:
              "reflects your files in place and has no remote to sync; run `akm index` to refresh the search index.",
          });
        }
      } catch (err) {
        skipped.push({
          id,
          kind: plain.type as SourceKind,
          reason: `sync failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  return buildUpdateResponse(stashDir, target, all, processed, {
    full: sawGitSync,
    plainSynced,
    skipped,
    ...(!sawGitSync && latestManagedIndex ? { index: latestManagedIndex } : {}),
  });
}

function selectManagedTargets(
  config: AkmConfig,
  installs: ManagedInstall[],
  target: string | undefined,
  all: boolean,
): ManagedInstall[] {
  if (all && target) {
    throw new UsageError("Specify either <target> or --all, not both.", "MISSING_OR_AMBIGUOUS_TARGET");
  }
  if (all) return installs;
  if (!target) {
    throw new UsageError("Either <target> or --all is required.", "MISSING_OR_AMBIGUOUS_TARGET");
  }

  const found = resolveManagedTarget(config, target);
  if (found) return [found];

  // Give a helpful message when the target names a plain (non-managed) source.
  const stashes = getSources(config);
  const isUrl = target.startsWith("http://") || target.startsWith("https://");
  const resolvedPath = !isUrl ? path.resolve(target) : undefined;
  const stashMatch = stashes.find((s) => {
    if (isUrl && s.url === target) return true;
    if (resolvedPath && s.path && path.resolve(s.path) === resolvedPath) return true;
    if (s.name === target) return true;
    return false;
  });

  if (stashMatch) {
    if (stashMatch.type === "website") {
      throw new UsageError(
        `"${target}" is a website source — website caching not yet implemented for --all. ` +
          `Run \`akm update ${target}\` to re-mirror this source individually.`,
        "TARGET_NOT_UPDATABLE",
      );
    }
    throw new UsageError(
      `"${target}" is a local directory — it reflects your files in place. To refresh the search index, run: akm index`,
      "TARGET_NOT_UPDATABLE",
    );
  }

  throw new NotFoundError(`No matching source for target: ${target}`, "SOURCE_NOT_FOUND");
}

/**
 * Best-effort removal of a directory that is no longer referenced by config
 * or the lockfile. `context` labels the call site (e.g. "remove", "update")
 * in the warning so an operator can tell which command left the directory
 * behind. Failure does not throw — callers already committed the config/lock
 * change that made `target` orphaned — but it must not be silent either
 * (F1/R-058): a swallowed `rmSync` error used to leave no trace anywhere the
 * caller could inspect, so a confirmed deletion that then failed (permission
 * error, file in use, …) looked identical to a successful one.
 */
function cleanupDirectoryBestEffort(target: string, context: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    warn(
      `[akm ${context}] failed to remove directory ${target}: ${err instanceof Error ? err.message : String(err)}. ` +
        "Remove it manually if it is no longer needed.",
    );
  }
}

function directoryExists(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}
