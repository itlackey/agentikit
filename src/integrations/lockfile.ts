// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../core/common";
import { ConfigError, rethrowIfTestIsolationError } from "../core/errors";
import { createLockPayload, probeLock, reclaimStaleLock, releaseLock, tryAcquireLockSync } from "../core/file-lock";
import { acquireMaintenanceBarrier } from "../core/maintenance-barrier";
import { classifyPathAccess, describeInaccessiblePath } from "../core/path-access";
import { getDataDir, getLockfileLockPath, getLockfilePath } from "../core/paths";
import type { InstallKind } from "../registry/types";
// `InstallKind` is the install/registry source discriminator — exactly the
// four kinds `parseRegistryRef` can emit ("npm" | "github" | "git" | "local").
// The lockfile reader validates against this 4-set at runtime.

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * LockfileEntry — resolved lock state for one bundle (spec §10.2).
 *
 * SHAPE BUMP (Chunk-8 WI-8.4): evolved from the pre-cutover per-source entry
 * (`{ id, source, ref, resolvedVersion?, resolvedRevision?, integrity? }`) to
 * the §10.2 bundle lock shape — ONE entry per bundle id, adding the optional
 * resolved fields the spec lists as SHOULD: `localRoot` (materialized root),
 * `manifestDigest`, `adapterIds`, and `installedAt`. The core identity/locator
 * fields are UNCHANGED (`id` = bundle id; `source` = source kind; `ref` =
 * locator), so old per-source `akm.lock` files still read (shape-tolerant:
 * `readLockfile` validates only id/source/ref and carries unknown/absent
 * optional fields through); an entry is upgraded to the new shape lazily on its
 * next `upsertLockEntry` write. The desired configuration lives in config.json's
 * `bundles`; this file records ONLY the resolved cache state (spec §10.2: the
 * config MUST NOT duplicate resolved cache paths/revisions).
 *
 * The lockfile lives at `<dataDir>/akm.lock` and is managed independently from
 * `config.json`.
 */
export interface LockfileEntry {
  /** Bundle id (the stable identifier shared with the matching bundle config). */
  id: string;
  /** Source kind. */
  source: InstallKind;
  /** Source locator (the install ref). */
  ref: string;
  resolvedVersion?: string;
  resolvedRevision?: string;
  integrity?: string;
  /** Local materialized root (spec §10.2 "local materialized root"). */
  localRoot?: string;
  /** Manifest digest (spec §10.2), when the install flow computed one. */
  manifestDigest?: string;
  /** Component adapter ids (spec §10.2), when known. */
  adapterIds?: string[];
  /** Installation timestamp (spec §10.2). */
  installedAt?: string;
}

// ── Lock sentinel ────────────────────────────────────────────────────────────

const LOCK_MAX_RETRIES = 3;
const LOCK_RETRY_DELAY_MS = 100;

async function acquireLockSentinel(): Promise<() => void> {
  const sentinelPath = getLockfileLockPath();
  // Ensure the directory exists before attempting to create the sentinel.
  fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    const releaseBarrier = acquireMaintenanceBarrier();
    try {
      const ownership = tryAcquireLockSync(sentinelPath, createLockPayload());
      if (ownership) {
        return () => releaseLock(ownership);
      }
      const probe = probeLock(sentinelPath);
      if (probe.state === "stale" && reclaimStaleLock(sentinelPath, probe)) {
        continue; // Reclaimed — retry immediately.
      }
    } finally {
      releaseBarrier();
    }
    // Another process holds the lock — wait briefly before retrying.
    if (attempt < LOCK_MAX_RETRIES - 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
    }
  }
  throw new ConfigError(
    `Could not acquire lockfile sentinel at ${sentinelPath}; refusing to write without exclusive ownership.`,
    "INVALID_CONFIG_FILE",
  );
}

// ── Read / Write ────────────────────────────────────────────────────────────

export function readLockfile(): LockfileEntry[] {
  const lockfilePath = getLockfilePath();
  try {
    const raw = JSON.parse(fs.readFileSync(lockfilePath, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter(isValidLockfileEntry);
  } catch (err) {
    // Defense-in-depth: getLockfilePath() is outside this try block, but a
    // future refactor that pushes a getDataDir() call inside must not mask
    // the bun-test isolation guard as "empty lockfile".
    rethrowIfTestIsolationError(err);
    return [];
  }
}

/**
 * Refuse to treat an UNREADABLE lockfile (or data dir) as an absent one (#791).
 *
 * Every write path here is read-modify-WRITE: it loads the current entries and
 * writes the whole array back. An unreadable `akm.lock` that reads as `[]`
 * therefore does not merely lose information — the very next
 * `writeFileAtomic` replaces the operator's entire lock record with the single
 * entry this call happened to be adding. That is the same catastrophe R-012
 * guards against for a *corrupt* file, reached instead through a permission
 * fault, and `fs.existsSync`/a swallowed `readFileSync` could not tell the two
 * apart from "the file was never created".
 *
 * No-op when the path is genuinely absent — that case really does have nothing
 * to preserve.
 */
function assertLockfilePathReadable(target: string): void {
  const { access, code } = classifyPathAccess(target);
  if (access !== "inaccessible") return;
  throw new ConfigError(
    `Refusing to modify the lockfile: ${describeInaccessiblePath(target, code)}. akm cannot read the existing lock ` +
      "records, and writing over them would destroy every bundle they track. Fix the ownership or mode of that " +
      "path (or point AKM_DATA_DIR / XDG_DATA_HOME somewhere this user owns) and retry.",
    "DATA_DIR_UNREADABLE",
  );
}

/**
 * Like {@link readLockfile}, but THROWS instead of silently degrading to `[]`
 * when the on-disk lockfile exists yet is not parseable JSON or not a JSON
 * array (R-012).
 *
 * `readLockfile`'s fail-open contract is intentional for READ paths — a
 * corrupt lock degrades a managed bundle to "unmanaged" rather than erroring
 * every read-only command (`list`, `installed-stashes`, …). But
 * {@link upsertLockEntry} and {@link removeLockEntry} read the current
 * entries and then WRITE `[...entries, change]` back out; if that read
 * silently returned `[]` for a corrupt file, the write would silently
 * replace the corrupt file with one containing only the single new/changed
 * entry — permanently destroying every other surviving lock record. Write
 * paths use this strict variant so a corrupt lockfile fails the operation
 * loudly (matching the guard `mergeLockEntriesSync` already applies) instead
 * of quietly deleting user state. A missing file is NOT corruption — there
 * is nothing to preserve, so that case still returns `[]`. Entries that fail
 * per-entry validation are still tolerated (filtered out), matching
 * `readLockfile`'s existing shape-tolerant behavior.
 */
function readLockfileOrThrow(): LockfileEntry[] {
  const lockfilePath = getLockfilePath();
  let raw: string;
  try {
    raw = fs.readFileSync(lockfilePath, "utf8");
  } catch (err) {
    rethrowIfTestIsolationError(err);
    // "Missing file" is the only failure with nothing to preserve. An
    // UNREADABLE lockfile has everything to preserve and we cannot see it —
    // degrading it to `[]` here is precisely the destructive overwrite this
    // function was written to prevent, only triggered by a permission fault
    // instead of a corrupt file (#791). Classify AFTER the failed read so the
    // happy path costs no extra syscall and the answer describes the failure
    // we actually got.
    assertLockfilePathReadable(lockfilePath);
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(
      `Refusing to modify lockfile ${lockfilePath}: existing content is not valid JSON (${error instanceof Error ? error.message : String(error)}). Fix or remove the file by hand before retrying — every existing lock entry would otherwise be lost.`,
      "INVALID_CONFIG_FILE",
    );
  }
  if (!Array.isArray(parsed)) {
    throw new ConfigError(
      `Refusing to modify lockfile ${lockfilePath}: existing content is not a JSON array. Fix or remove the file by hand before retrying — every existing lock entry would otherwise be lost.`,
      "INVALID_CONFIG_FILE",
    );
  }
  return parsed.filter(isValidLockfileEntry);
}

/**
 * The materialized content root recorded in the lock for a managed (git/npm)
 * bundle — spec §10.2 desired/resolved split, where the desired config carries
 * only the source LOCATOR and the resolved `localRoot` lives here.
 *
 * This is the SINGLE lock-first resolution point shared by the indexer READ
 * path (`resolveEntryContentDir` in indexer/search) and the command-layer WRITE
 * path (`adaptConfiguredSource` in core/write-source): consulting it first makes
 * a write land in exactly the directory a read walks. Returns `undefined` for a
 * bundle with no lock `localRoot` (e.g. a config migrated from a `sources[]`
 * url, whose provider re-derives the cache path) or a non-managed type, so both
 * callers fall back to the identical provider-path derivation.
 */
export function lockContentRootFor(bundleId: string | undefined, type: string): string | undefined {
  if (!bundleId || (type !== "git" && type !== "npm")) return undefined;
  for (const lock of readLockfile()) {
    if (lock.id === bundleId && typeof lock.localRoot === "string" && lock.localRoot.length > 0) {
      return lock.localRoot;
    }
  }
  return undefined;
}

function writeLockfileUnlocked(entries: LockfileEntry[]): void {
  // Always write to $DATA — never to the legacy $CONFIG location.
  const lockfilePath = getLockfilePath();
  const dir = path.dirname(lockfilePath);
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(lockfilePath, `${JSON.stringify(entries, null, 2)}\n`);
}

export async function writeLockfile(entries: LockfileEntry[]): Promise<void> {
  const release = await acquireLockSentinel();
  try {
    writeLockfileUnlocked(entries);
  } finally {
    release();
  }
}

/** Replace one exact parsed lock generation while the lockfile sentinel is held. */
export async function compareAndSwapLockfile(expected: LockfileEntry[], desired: LockfileEntry[]): Promise<boolean> {
  const release = await acquireLockSentinel();
  try {
    const current = readLockfileOrThrow();
    if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
    writeLockfileUnlocked(desired);
    return true;
  } finally {
    release();
  }
}

export async function upsertLockEntry(entry: LockfileEntry): Promise<void> {
  const release = await acquireLockSentinel();
  try {
    // R-012: readLockfileOrThrow (not readLockfile) — a corrupt/malformed
    // lockfile must abort the upsert loudly rather than read as `[]` and get
    // silently overwritten with just this one entry.
    const entries = readLockfileOrThrow();
    const withoutExisting = entries.filter((e) => e.id !== entry.id);
    writeLockfileUnlocked([...withoutExisting, entry]);
  } finally {
    release();
  }
}

/**
 * Synchronously upsert lock entries (merge by id) WITHOUT acquiring the async
 * sentinel — for a caller already holding an exclusive lifecycle lock (e.g.
 * migrate-apply's config lock + maintenance barrier) whose synchronous body
 * cannot await the sentinel's retry loop. No-op for an empty list.
 */
function readLockEntriesForMigration(): LockfileEntry[] {
  let existing: LockfileEntry[] = [];
  const lockfilePath = getLockfilePath();
  // `mergeLockEntriesSync` writes `existing` straight back out, so an
  // unreadable lockfile read as absent would be overwritten with just the
  // migrator's sparse entries (#791). This is also what
  // `assertMigrationLockfileReadable` promises to have checked.
  assertLockfilePathReadable(lockfilePath);
  if (fs.existsSync(lockfilePath)) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(lockfilePath, "utf8"));
    } catch (error) {
      throw new ConfigError(
        `Cannot merge migration lock entries into unreadable lockfile ${lockfilePath}: ${error instanceof Error ? error.message : String(error)}.`,
        "INVALID_CONFIG_FILE",
      );
    }
    if (!Array.isArray(raw) || !raw.every(isValidLockfileEntry)) {
      throw new ConfigError(
        `Cannot merge migration lock entries into malformed lockfile ${lockfilePath}.`,
        "INVALID_CONFIG_FILE",
      );
    }
    existing = raw;
  }
  return existing;
}

/** Validate the current lockfile before migrate-apply creates its backup or sentinel. */
export function assertMigrationLockfileReadable(): void {
  readLockEntriesForMigration();
}

export function mergeLockEntriesSync(entries: LockfileEntry[]): void {
  const existing = readLockEntriesForMigration();
  if (entries.length === 0) return;
  // MERGE per id, never replace: the migrator's entries are sparse (id/source/
  // ref/localRoot), while an existing row may carry `resolvedVersion`,
  // `resolvedRevision`, `integrity`, `installedAt`, … from a real install.
  // Replacing the whole row discarded the user's recorded resolution/pin and
  // left later update reporting comparing against an unknown prior version.
  // Incoming DEFINED fields win; existing fields absent from the incoming
  // entry are preserved.
  const byId = new Map(existing.map((e) => [e.id, e]));
  const merged = entries.map((incoming) => {
    const prior = byId.get(incoming.id);
    return prior ? { ...prior, ...incoming } : incoming;
  });
  const incomingIds = new Set(entries.map((e) => e.id));
  writeLockfileUnlocked([...existing.filter((e) => !incomingIds.has(e.id)), ...merged]);
}

export async function removeLockEntry(id: string): Promise<void> {
  // Returning early says "there is no lock record to remove", and the uninstall
  // that called us reports success on that basis. Only an absent data dir earns
  // it — one we cannot read may hold the very entry we were asked to drop, and
  // silently leaving it behind is how a bundle stays "installed" forever (#791).
  const dataDir = getDataDir();
  assertLockfilePathReadable(dataDir);
  if (!fs.existsSync(dataDir)) return;
  const release = await acquireLockSentinel();
  try {
    // R-012: see upsertLockEntry — same destructive-overwrite risk on a
    // corrupt lockfile, so the same strict reader is used here.
    const entries = readLockfileOrThrow();
    writeLockfileUnlocked(entries.filter((e) => e.id !== id));
  } finally {
    release();
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function isValidLockfileEntry(value: unknown): value is LockfileEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    obj.id !== "" &&
    typeof obj.source === "string" &&
    ["npm", "github", "git", "local"].includes(obj.source) &&
    typeof obj.ref === "string" &&
    obj.ref !== ""
  );
}
