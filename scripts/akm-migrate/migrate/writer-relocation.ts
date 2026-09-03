// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * itlackey/akm#890: five machine-local `akm improve` writers moved out of
 * `$STASH/.akm` (where they never met the "must travel with the content"
 * rule — see docs/architecture/internals/storage-locations.md) into
 * `$STATE`/`$CACHE`, namespaced per stash by {@link getStashStateKey}. Unlike
 * the Tier-1 dead residue in `dead-residue.ts` (superseded, safe to delete),
 * these paths still have a live writer at their NEW location — the fix here
 * is relocation, not deletion:
 *
 *   - `.akm/distill-rejected/`      -> $STATE/improve/distill-rejected/<stash>/
 *   - `.akm/eval-cases/`            -> $STATE/improve/eval-cases/<stash>/
 *   - `.akm/measurement/verdicts/`  -> $STATE/improve/measurement/verdicts/<stash>/
 *   - the improve-pipeline `.lock` files (+ their `.operations.sensitive`
 *     mutex siblings) are DELETED, never moved — a lock held by a live run
 *     must never be silently relocated out from under it; the next run
 *     simply creates a fresh lock at the new location. A lock is only ever
 *     deleted when {@link probeLock} — the SAME staleness check
 *     `src/commands/improve/locks.ts` uses to decide whether a running
 *     `akm improve` may reclaim it — says its holder is dead. A lock a live
 *     run currently holds (or one this process cannot even read) is left
 *     exactly where it is and reported separately (`skippedLocks`), never
 *     silently dropped.
 *
 * `.akm/unresolved-sources/` is not migrated here: it was never written to
 * disk (a synthetic placeholder path only), so there is nothing to move.
 * `.akm/measurement/` itself (the pilot treatment file) is untouched — only
 * its `verdicts/` subdirectory relocates.
 *
 * Read-only `find*` / mutating `apply*` split mirrors `dead-residue.ts`:
 * `akm migrate status` / `apply --dry-run` call the finder only.
 */

import fs from "node:fs";
import path from "node:path";
import { probeLock } from "../../../src/core/file-lock";
import { getDistillRejectedDir, getEvalCasesDir, getMeasurementVerdictsDir } from "../../../src/core/paths";

interface RelocationSpec {
  /** Report key / human label. */
  key: string;
  /** Old directory, relative to `$STASH/.akm`. */
  oldRelative: string | string[];
  /** New stash-scoped directory (already resolved). */
  newDir: string;
}

function relocationSpecs(stashDir: string): RelocationSpec[] {
  return [
    { key: "distillRejected", oldRelative: "distill-rejected", newDir: getDistillRejectedDir(stashDir) },
    { key: "evalCases", oldRelative: "eval-cases", newDir: getEvalCasesDir(stashDir) },
    {
      key: "measurementVerdicts",
      oldRelative: ["measurement", "verdicts"],
      newDir: getMeasurementVerdictsDir(stashDir),
    },
  ];
}

/** The four lock-file basenames the improve pipeline has ever written under `.akm/` (itlackey/akm#890). */
const LOCK_NAMES = ["improve.lock", "consolidate.lock", "reflect-distill.lock", "triage.lock"] as const;

function mutexSiblingName(lockName: string): string {
  return `.${lockName}.operations.sensitive`;
}

/** One writer directory pending relocation. */
export interface WriterRelocationEntry {
  key: string;
  oldPath: string;
  newPath: string;
  fileCount: number;
}

/** One stale lock artifact (a lock file, or its operations-mutex sibling) pending deletion. */
export interface LockArtifactEntry {
  path: string;
  sizeBytes: number;
}

/**
 * A lock artifact left in place because its holder could not be proven dead.
 * `reason: "held"` is a live `akm improve` (or a sibling process using the
 * same lock name); `reason: "inaccessible"` is a sentinel this process lacks
 * permission to read (#791) — never treated as stale, since the holder may
 * be alive and simply invisible to us.
 */
export interface SkippedLockEntry {
  path: string;
  reason: "held" | "inaccessible";
  holderPid?: number;
}

export interface WriterRelocationPlan {
  directories: WriterRelocationEntry[];
  lockArtifacts: LockArtifactEntry[];
  skippedLocks: SkippedLockEntry[];
}

function fileCountIfExists(dir: string): number | undefined {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  return entries.filter((entry) => entry.isFile()).length;
}

function statFileIfExists(filePath: string): fs.Stats | undefined {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Classify every old-location lock artifact under `$STASH/.akm` into what's
 * safe to remove and what must be left alone. Read-only — only reads and
 * `stat`s files, matching `probeLock`'s own contract.
 *
 * The lock file and its `.operations.sensitive` mutex sibling are decided
 * together, by probing ONLY the lock file (the mutex sidecar is a transient
 * sqlite handle for the acquire/release critical section — it never carries
 * the holder's PID, so it has no liveness of its own to check):
 *
 *   - lock file absent: any orphaned mutex sidecar is dead residue from a
 *     lock already released elsewhere — removable.
 *   - `probeLock` reports `"held"`: a live run owns this lock (or, past
 *     #872, once mistakenly reclaimed one purely for being old) — leave
 *     both files untouched and report the lock path as skipped.
 *   - `"inaccessible"`: cannot verify the holder is dead — the same hard
 *     stop `src/commands/improve/locks.ts` applies before ever reclaiming a
 *     lock — leave both files untouched and report it as skipped.
 *   - `"stale"` (dead holder pid, or unreadable/invalid content) or
 *     `"absent"` (raced: gone between our `stat` and the probe's own read):
 *     removable, together with any mutex sidecar.
 */
function classifyLockArtifacts(akmDir: string): { removable: LockArtifactEntry[]; skipped: SkippedLockEntry[] } {
  const removable: LockArtifactEntry[] = [];
  const skipped: SkippedLockEntry[] = [];
  for (const lockName of LOCK_NAMES) {
    const lockPath = path.join(akmDir, lockName);
    const mutexPath = path.join(akmDir, mutexSiblingName(lockName));
    const lockStat = statFileIfExists(lockPath);
    const mutexStat = statFileIfExists(mutexPath);
    if (!lockStat) {
      if (mutexStat) removable.push({ path: mutexPath, sizeBytes: mutexStat.size });
      continue;
    }
    const probe = probeLock(lockPath);
    if (probe.state === "held") {
      skipped.push({ path: lockPath, reason: "held", holderPid: probe.holderPid });
      continue;
    }
    if (probe.state === "inaccessible") {
      skipped.push({ path: lockPath, reason: "inaccessible" });
      continue;
    }
    if (probe.state === "absent") continue; // raced: already gone, nothing to remove
    removable.push({ path: lockPath, sizeBytes: lockStat.size });
    if (mutexStat) removable.push({ path: mutexPath, sizeBytes: mutexStat.size });
  }
  return { removable, skipped };
}

/**
 * Find every old-location writer directory that still has files in it, plus
 * every lock artifact under `$STASH/.akm` — split into what a live holder
 * still needs (`skippedLocks`) and what is safe to delete (`lockArtifacts`).
 * Read-only — never mutates.
 */
export function findWriterRelocationEntries(stashDir: string): WriterRelocationPlan {
  const akmDir = path.join(stashDir, ".akm");
  const directories: WriterRelocationEntry[] = [];
  for (const spec of relocationSpecs(stashDir)) {
    const relativeParts = Array.isArray(spec.oldRelative) ? spec.oldRelative : [spec.oldRelative];
    const oldPath = path.join(akmDir, ...relativeParts);
    const fileCount = fileCountIfExists(oldPath);
    if (fileCount === undefined || fileCount === 0) continue;
    directories.push({ key: spec.key, oldPath, newPath: spec.newDir, fileCount });
  }

  const { removable, skipped } = classifyLockArtifacts(akmDir);
  return { directories, lockArtifacts: removable, skippedLocks: skipped };
}

/** One directory's move result. */
export interface WriterRelocationResult {
  key: string;
  oldPath: string;
  newPath: string;
  moved: number;
  errors: string[];
}

/** One deleted (or failed-to-delete) lock artifact. */
export interface LockArtifactRemoval {
  path: string;
  removed: boolean;
  error?: string;
}

function moveFile(oldFilePath: string, newFilePath: string): void {
  try {
    fs.renameSync(oldFilePath, newFilePath);
  } catch (error) {
    // EXDEV: old and new locations are on different filesystems (e.g. a
    // stash on a separate mount from $STATE/$CACHE) — same-filesystem rename
    // is not available, so copy then delete.
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    fs.copyFileSync(oldFilePath, newFilePath);
    fs.rmSync(oldFilePath, { force: true });
  }
}

function moveDirectoryContents(entry: WriterRelocationEntry): WriterRelocationResult {
  const errors: string[] = [];
  let moved = 0;
  fs.mkdirSync(entry.newPath, { recursive: true });
  let names: string[];
  try {
    names = fs.readdirSync(entry.oldPath).sort();
  } catch {
    return { key: entry.key, oldPath: entry.oldPath, newPath: entry.newPath, moved: 0, errors: [] };
  }
  for (const name of names) {
    const oldFilePath = path.join(entry.oldPath, name);
    const newFilePath = path.join(entry.newPath, name);
    let oldStat: fs.Stats;
    try {
      oldStat = fs.lstatSync(oldFilePath);
    } catch {
      continue; // vanished between readdir and stat
    }
    if (!oldStat.isFile()) continue; // idempotent re-run / unexpected subdir: leave it, never force
    if (fs.existsSync(newFilePath)) continue; // already migrated by a previous run
    try {
      moveFile(oldFilePath, newFilePath);
      moved += 1;
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { key: entry.key, oldPath: entry.oldPath, newPath: entry.newPath, moved, errors };
}

function removeIfEmptyDir(dir: string): void {
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    // Not present, not empty, or a race with another process — leave it.
  }
}

function removeLockArtifact(entry: LockArtifactEntry): LockArtifactRemoval {
  try {
    fs.rmSync(entry.path, { force: true });
    return { path: entry.path, removed: true };
  } catch (error) {
    return { path: entry.path, removed: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface WriterRelocationApplyResult {
  directories: WriterRelocationResult[];
  lockArtifacts: LockArtifactRemoval[];
  /** Locks left alone (live holder, or unreadable) — see {@link classifyLockArtifacts}. */
  skippedLocks: SkippedLockEntry[];
}

/**
 * Relocate every pending writer directory (same-filesystem rename per file,
 * else copy-then-delete) and delete every lock artifact `probeLock` says is
 * stale. Idempotent: a file already present at its new path is left alone,
 * and a second run against an already-migrated stash reports zero moves and
 * zero removals. Best-effort per path — one failure does not abort the rest.
 * A lock a live run holds (or one this process cannot read) is NEVER
 * deleted — it comes back in `skippedLocks`, unchanged on disk, and a later
 * run retries it once its holder is gone.
 */
export function applyWriterRelocation(stashDir: string): WriterRelocationApplyResult {
  const { directories, lockArtifacts, skippedLocks } = findWriterRelocationEntries(stashDir);
  const directoryResults = directories.map(moveDirectoryContents);
  const lockResults = lockArtifacts.map(removeLockArtifact);

  // Best-effort cleanup of now-empty old directories this step vacated.
  // `measurement/` itself is never removed here — the pilot treatment file
  // may still live there; only its now-empty `verdicts/` child is (the
  // "measurementVerdicts" spec below covers exactly that path).
  for (const spec of relocationSpecs(stashDir)) {
    const relativeParts = Array.isArray(spec.oldRelative) ? spec.oldRelative : [spec.oldRelative];
    removeIfEmptyDir(path.join(stashDir, ".akm", ...relativeParts));
  }

  return { directories: directoryResults, lockArtifacts: lockResults, skippedLocks };
}
