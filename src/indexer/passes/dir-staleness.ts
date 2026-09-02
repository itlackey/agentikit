// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Incremental dir-staleness engine.
 *
 * Decides, per stash directory, whether the directory's indexed rows are still
 * fresh relative to what is on disk — so an incremental `akm index` run can
 * skip unchanged directories instead of regenerating their metadata.
 *
 * Two persisted signals back the decision:
 *   1. The `entries` rows already indexed for the directory (`getEntriesByDir`).
 *   2. The `index_dir_state` row (`getIndexDirState`): the fingerprint of the
 *      directory's walked file set (basename set + max mtime, `computeDirFingerprint`)
 *      as of its last drain, plus the row count that drain persisted.
 *
 * `getCachedDirState` is the pre-drain gate (#900): a directory whose walked
 * fingerprint still matches its row is skipped before any file is read.
 */

import fs from "node:fs";
import path from "node:path";
import type { Database } from "../../storage/database";
import { getEntriesByDir } from "../../storage/repositories/index-entries-repository";
import type { DbIndexedEntry } from "../../storage/repositories/index-entry-types";
import { getIndexDirState } from "../../storage/repositories/index-meta-repository";
import type { StashFile } from "./metadata";

/**
 * Reasons a directory is considered stale (or freshly unchanged). A subset of
 * the indexer's broader `DirScanReason` — only the kinds the staleness engine
 * itself produces.
 */
export type DirStaleReason = {
  kind:
    | "unchanged"
    | "unchanged-precheck"
    | "index-context-changed"
    | "no-previous-rows"
    | "cached-zero-row-state"
    | "mtime-changed"
    | "file-set-changed"
    | "missing-file";
  detail?: string;
};

export interface DirIndexState {
  stale: boolean;
  reason: DirStaleReason;
  persistedRowCount: number;
}

export interface DirFingerprint {
  fileSetHash: string;
  fileMtimeMaxMs: number;
}

/**
 * Post-drain freshness verdict. `files` is the recognized file set the drain
 * produced (compared against the persisted entries); `fingerprint` is the
 * walked-set fingerprint compared against the persisted row and defaults to
 * one computed over `files`.
 */
export function getDirIndexState(
  db: Database,
  dirPath: string,
  files: string[],
  builtAtMs: number,
  indexVariant = "",
  fingerprint: DirFingerprint = computeDirFingerprint(dirPath, files, indexVariant),
): DirIndexState {
  const prevEntries = getEntriesByDir(db, dirPath);
  if (prevEntries.length > 0) {
    const staleReason = getDirStaleReason(dirPath, files, prevEntries, builtAtMs);
    if (staleReason) return { stale: true, reason: staleReason, persistedRowCount: prevEntries.length };
    const cachedState = getIndexDirState(db, dirPath);
    if (!cachedState || cachedState.fileSetHash !== fingerprint.fileSetHash) {
      return {
        stale: true,
        reason: { kind: "index-context-changed", detail: indexVariant },
        persistedRowCount: prevEntries.length,
      };
    }
    return { stale: false, reason: { kind: "unchanged" }, persistedRowCount: prevEntries.length };
  }

  const cachedState = getIndexDirState(db, dirPath);
  if (
    cachedState &&
    cachedState.fileSetHash === fingerprint.fileSetHash &&
    cachedState.fileMtimeMaxMs === fingerprint.fileMtimeMaxMs
  ) {
    return {
      stale: false,
      reason: { kind: "cached-zero-row-state", detail: cachedState.reason },
      persistedRowCount: 0,
    };
  }

  return {
    stale: true,
    reason: { kind: "no-previous-rows", detail: cachedState ? `cached=${cachedState.reason}` : undefined },
    persistedRowCount: 0,
  };
}

/**
 * Pre-drain gate (#900). A directory whose walked-set fingerprint matches its
 * persisted row cannot recognize differently than last time, so it is skipped
 * before `drainDirDocuments` reads a single file. A row that recorded a real
 * generation (`rowCount > 0`) is skipped outright; a zero-row or pre-#900 row
 * goes through the entries-aware check so the dedup-order guard still applies.
 */
export function getCachedDirState(
  db: Database,
  dirPath: string,
  files: string[],
  builtAtMs: number,
  priorDirsChanged: boolean,
  indexVariant: string,
  fingerprint: DirFingerprint,
): DirIndexState | undefined {
  const cached = getIndexDirState(db, dirPath);
  if (
    !cached ||
    cached.fileSetHash !== fingerprint.fileSetHash ||
    cached.fileMtimeMaxMs !== fingerprint.fileMtimeMaxMs
  ) {
    return undefined;
  }
  if (cached.rowCount !== undefined && cached.rowCount > 0) {
    return { stale: false, reason: { kind: "unchanged-precheck" }, persistedRowCount: cached.rowCount };
  }
  const state = getDirIndexState(db, dirPath, files, builtAtMs, indexVariant, fingerprint);
  if (state.stale || state.reason.kind !== "cached-zero-row-state") return undefined;
  if (!canUseIncrementalSkip(state, priorDirsChanged)) return undefined;
  return state;
}

export function canUseIncrementalSkip(state: DirIndexState, priorDirsChanged: boolean): boolean {
  return !(
    priorDirsChanged &&
    state.reason.kind === "cached-zero-row-state" &&
    state.reason.detail === "deduped-zero-row"
  );
}

export function computeDirFingerprint(_dirPath: string, files: string[], indexVariant = ""): DirFingerprint {
  const normalizedFiles = [...new Set(files.map((file) => path.basename(file)))].sort();
  let fileMtimeMaxMs = 0;
  for (const file of files) {
    try {
      fileMtimeMaxMs = Math.max(fileMtimeMaxMs, fs.statSync(file).mtimeMs);
    } catch {
      fileMtimeMaxMs = Number.POSITIVE_INFINITY;
      break;
    }
  }
  return {
    fileSetHash: [indexVariant, ...normalizedFiles].join("\0"),
    fileMtimeMaxMs,
  };
}

function getDirStaleReason(
  _dirPath: string,
  currentFiles: string[],
  previousEntries: DbIndexedEntry[],
  builtAtMs: number,
):
  | {
      kind: "mtime-changed" | "file-set-changed" | "missing-file";
      detail?: string;
    }
  | undefined {
  const prevFileNames = new Set(
    previousEntries
      .map((ie) => {
        const fromPath = path.basename(ie.filePath);
        return fromPath || ie.entry.filename;
      })
      .filter((e): e is string => !!e),
  );
  const currFileNames = new Set(currentFiles.map((f) => path.basename(f)));
  if (prevFileNames.size !== currFileNames.size) {
    return { kind: "file-set-changed", detail: `${prevFileNames.size} -> ${currFileNames.size} files` };
  }
  for (const name of currFileNames) {
    if (!prevFileNames.has(name)) return { kind: "file-set-changed", detail: name };
  }

  for (const file of currentFiles) {
    try {
      if (fs.statSync(file).mtimeMs > builtAtMs) return { kind: "mtime-changed", detail: path.basename(file) };
    } catch {
      return { kind: "missing-file", detail: path.basename(file) };
    }
  }

  return undefined;
}

export function inferZeroRowReason(
  stash: StashFile | null,
  priorReason: { kind: string; detail?: string } | undefined,
  warnings: string[],
  dirPath: string,
  dedupedRows: number,
): string {
  if (dedupedRows > 0) return "deduped-zero-row";
  const workflowNoise = warnings.some(
    (warning) => warning.startsWith("Skipped workflow ") && warning.includes(dirPath),
  );
  if (workflowNoise) return "workflow-noise";
  if (!stash || stash.entries.length === 0) return "empty-generated-set";
  return `zero-row:${priorReason?.kind ?? "unknown"}`;
}
