/**
 * Dead pre-0.9.0 `$STASH/.akm` residue: superseded filesystem layouts with no
 * live reader or writer anywhere in src/ (each verified by grep before being
 * listed — see #889 for the audit). The largest, `.akm/proposals/`, was
 * replaced by the `proposals` table in state.db in 0.9.0 and measured 135 MB
 * on a real bundle.
 *
 * This lives under `migrate/` because removing a superseded layout IS
 * migration — the tail end of the moves that created these paths' replacements.
 * It was first shipped as a bolted-on `akm health --clean-dead-residue` flag
 * plus a health advisory; that was the wrong shape (a special-purpose switch
 * apologizing for migrations that did not finish their own job) and was
 * removed. `akm migrate status` reports what is here; `akm migrate apply`
 * removes it, exactly as it applies every other pending migration.
 */

import fs from "node:fs";
import path from "node:path";

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

const DEAD_RESIDUE_PATHS: readonly DeadResiduePath[] = [
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
interface DeadResidueEntry {
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

/** One path removed (or that failed to remove) by {@link removeDeadResidue}. */
interface DeadResidueRemoval {
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
