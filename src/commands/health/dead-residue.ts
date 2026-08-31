// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `stash-dead-residue` advisory for `akm health` (itlackey/akm#889).
 *
 * On a real stash, `$STASH/.akm` had grown to 165 MB / 1,523 files, 82% of
 * which (135 MB) was `.akm/proposals/` alone — a filesystem layout that the
 * `proposals` table in `$DATA/state.db` superseded back in 0.9.0. The
 * migrations that made these paths obsolete happened; nothing ever cleaned
 * up the paths they left behind.
 *
 * Each entry below was independently re-verified (not just taken from the
 * issue) to have zero live writer or reader in `src/` — the only `src/`
 * references are comments describing the legacy layout
 * (`core/state/migrations.ts:107`, `core/fs-txn.ts:16`). This module never
 * deletes anything on its own: {@link collectDeadResidueAdvisory} only
 * reports what exists and how big it is, and {@link removeDeadResidue} is a
 * separate, explicitly-invoked opt-in action (`akm health --clean-dead-residue`).
 */

import fs from "node:fs";
import path from "node:path";
import type { HealthCheckResult } from "./types";

/**
 * One dead-residue path, relative to `$STASH/.akm`. `runs.archived-<ts>/` is
 * timestamp-suffixed (from a directory that no longer exists), so it is
 * matched by prefix rather than an exact name.
 */
interface DeadResiduePath {
  /** Exact file/dir name under `.akm/`, or a `prefix` match when set. */
  name?: string;
  prefix?: string;
  reason: string;
}

export const DEAD_RESIDUE_PATHS: readonly DeadResiduePath[] = [
  { name: "proposals", reason: "superseded by the `proposals` table in $DATA/state.db (0.9.0)" },
  { prefix: "runs.archived-", reason: "orphaned archive of a directory that no longer exists" },
  {
    name: "archive",
    reason: "legacy consolidation archive; current prune writes .akm/memory-cleanup/archive/ instead",
  },
  { name: "graph.json", reason: "superseded by the graph_* tables in $DATA/index.db" },
  { name: "consolidate-journal.json", reason: "legacy consolidation journal; unused" },
  { name: "proposals.db", reason: "empty legacy database file" },
  { name: "mv-transactions", reason: "legacy fs-txn journal location; unused" },
];

/** One resolved dead-residue path found on disk, with its computed size. */
export interface DeadResidueEntry {
  /** Path relative to the stash root (e.g. `.akm/proposals`). */
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  reason: string;
}

function dirSizeBytes(target: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const entryPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      total += dirSizeBytes(entryPath);
    } else if (entry.isFile()) {
      try {
        total += fs.statSync(entryPath).size;
      } catch {
        // Skip files that vanish or are inaccessible between readdir and stat.
      }
    }
  }
  return total;
}

function sizeOf(target: string): number {
  const st = fs.statSync(target);
  return st.isDirectory() ? dirSizeBytes(target) : st.size;
}

/**
 * Find every Tier-1 dead-residue path that actually exists under
 * `$STASH/.akm`, with its computed size. Read-only — never deletes.
 */
export function findDeadResidueEntries(stashDir: string): DeadResidueEntry[] {
  const akmDir = path.join(stashDir, ".akm");
  let names: string[];
  try {
    names = fs.readdirSync(akmDir);
  } catch {
    return [];
  }

  const found: DeadResidueEntry[] = [];
  for (const spec of DEAD_RESIDUE_PATHS) {
    const matches = spec.name !== undefined ? [spec.name] : names.filter((n) => n.startsWith(spec.prefix ?? "\0"));
    for (const name of matches) {
      if (!names.includes(name)) continue;
      const absolutePath = path.join(akmDir, name);
      let sizeBytes: number;
      try {
        sizeBytes = sizeOf(absolutePath);
      } catch {
        continue; // vanished between readdir and stat
      }
      found.push({ relativePath: path.join(".akm", name), absolutePath, sizeBytes, reason: spec.reason });
    }
  }
  return found;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * Build the `stash-dead-residue` advisory, or `undefined` when none of the
 * known-dead paths exist. Read-only: names paths and sizes, and points at
 * the opt-in removal flag rather than deleting anything itself.
 */
export function collectDeadResidueAdvisory(stashDir: string): HealthCheckResult | undefined {
  const entries = findDeadResidueEntries(stashDir);
  if (entries.length === 0) return undefined;

  const totalBytes = entries.reduce((sum, e) => sum + e.sizeBytes, 0);
  const preview = entries.map((e) => `${e.relativePath} (${formatBytes(e.sizeBytes)})`).join(", ");

  return {
    name: "stash-dead-residue",
    kind: "deterministic",
    status: "warn",
    confidence: "high",
    message:
      `${entries.length} dead pre-0.9.0 path(s) under $STASH/.akm total ${formatBytes(totalBytes)}: ${preview}. ` +
      "Nothing in akm reads or writes these any more. Run 'akm health --clean-dead-residue' to delete them " +
      "(this is user data — the advisory alone never deletes anything).",
    evidence: {
      totalBytes,
      entries: entries.map((e) => ({ path: e.relativePath, sizeBytes: e.sizeBytes, reason: e.reason })),
    },
  };
}

/** One path removed (or that failed to remove) by {@link removeDeadResidue}. */
export interface DeadResidueRemoval {
  relativePath: string;
  sizeBytes: number;
  removed: boolean;
  error?: string;
}

/**
 * Delete every Tier-1 dead-residue path found under `$STASH/.akm`. Only
 * invoked when the caller has explicitly opted in (`akm health
 * --clean-dead-residue`) — never as a side effect of a plain `akm health`
 * read. Best-effort per-path: one failure does not abort the rest.
 */
export function removeDeadResidue(stashDir: string): DeadResidueRemoval[] {
  const entries = findDeadResidueEntries(stashDir);
  return entries.map((entry) => {
    try {
      fs.rmSync(entry.absolutePath, { recursive: true, force: true });
      return { relativePath: entry.relativePath, sizeBytes: entry.sizeBytes, removed: true };
    } catch (error) {
      return {
        relativePath: entry.relativePath,
        sizeBytes: entry.sizeBytes,
        removed: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
