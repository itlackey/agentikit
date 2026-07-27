// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared `entries`-row projection + mapper for the `index.db` storage repos.
 *
 * Centralizes the one canonical `entries` SELECT column list and the
 * JSON-parse-guarded row → {@link DbIndexedEntry} mapping that several queries
 * used to reimplement. Corrupt `entry_json` rows are skipped (warn once) rather
 * than crashing the caller.
 */

import { warn } from "../../core/warn";
import type { IndexDocument } from "../../indexer/passes/metadata";
import type { DbIndexedEntry } from "./index-entry-types";

/**
 * Canonical column list for reading a full indexed entry from the `entries`
 * table, in the order {@link rowToIndexedEntry} expects.
 *
 * Durable identity columns are surfaced here so every mapped entry carries
 * current indexed provenance.
 */
export const ENTRY_COLUMNS =
  "id, entry_key, dir_path, file_path, stash_dir, entry_json, search_text, item_ref, concept_id, bundle_id, adapter_id";

/** A raw row selected via {@link ENTRY_COLUMNS}. */
export type EntryRow = {
  id: number;
  entry_key: string;
  dir_path: string;
  file_path: string;
  stash_dir: string;
  entry_json: string;
  search_text: string;
  /** Canonical durable `<bundle>//<concept-id>` ref. */
  item_ref: string | null;
  /** Durable OKF concept id (`item_ref` tail). */
  concept_id: string | null;
  /** Durable bundle id (`item_ref` head). */
  bundle_id: string | null;
  /** Owning adapter. */
  adapter_id: string | null;
};

/**
 * Map one raw `entries` row to a {@link DbIndexedEntry}, parsing `entry_json`.
 * Returns `null` (and warns, tagged with `context`) when the JSON is corrupt so
 * callers can skip the row instead of crashing.
 */
export function rowToIndexedEntry(row: EntryRow, context: string): DbIndexedEntry | null {
  let entry: IndexDocument;
  try {
    entry = JSON.parse(row.entry_json) as IndexDocument;
  } catch {
    warn(`[db] ${context}: skipping entry id=${row.id} — corrupt entry_json`);
    return null;
  }
  if (!row.item_ref || !row.concept_id || !row.bundle_id || !row.adapter_id) {
    warn(`[db] ${context}: skipping entry id=${row.id} — missing indexed provenance`);
    return null;
  }
  return {
    id: row.id,
    entryKey: row.entry_key,
    dirPath: row.dir_path,
    filePath: row.file_path,
    stashDir: row.stash_dir,
    entry,
    searchText: row.search_text,
    itemRef: row.item_ref,
    conceptId: row.concept_id,
    bundleId: row.bundle_id,
    adapterId: row.adapter_id,
  };
}
