// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * @removeIn 0.10.0
 *
 * The one-time three-DB cutover DATA step (akm 0.9.0 Chunk 8, WI-8.2;
 * plan §3.2/§3.3/§8, normative §11.4, chunk-8 cutover design). Migration
 * `020-three-db-cutover` is the pure additive
 * DDL (`CREATE TABLE IF NOT EXISTS` the merge-target tables); THIS module is the
 * code that MOVES the durable rows into place, exactly once, while the
 * migrate-apply incomplete sentinel blocks normal runtime access. The ATTACH
 * path is runtime-resolved and the old-ref → item_ref map is
 * filesystem/index-derived.
 *
 * ## Frozen-resolver rule (plan §3.3 item 2)
 *
 * Old-ref resolution NEVER runs through new-layout code. This module therefore
 * imports ONLY the frozen legacy surface (`./legacy-layout`), the stored-ref
 * grammar (`../legacy-ref-grammar`), storage-engine helpers (`openDatabase`,
 * `applyStandardPragmas`), core path/warn leaves, and Node builtins. It imports
 * NOTHING from `src/indexer/` or `src/workflows/`: the last-good-index join
 * reads the ATTACHED old index.db by raw SQL, never through indexer code, and
 * the workflow merge reads the ATTACHED old workflow.db by raw SQL.
 *
 * ## Design choices where the design is silent (documented per the WI brief)
 *
 *  - **ATTACH is read-write, safety enforced by construction.** `cutover-design`
 *    calls for read-only ATTACH; to stay driver-portable (bun:sqlite has no
 *    URI-mode guarantee) we ATTACH normally but (a) pre-check `fs.existsSync`
 *    before every ATTACH so a missing file is never silently CREATED, and (b)
 *    only ever `SELECT` from the attached schemas — the sole writes target
 *    `main` (state.db). This is behaviourally equivalent to a read-only ATTACH.
 *  - **Column-intersection copy.** The workflow / usage_events merge copies the
 *    INTERSECTION of columns present in both the source and the target table, so
 *    a source DB at any pre-cutover shape (or a partially-migrated test fixture)
 *    copies verbatim what it holds without tripping "no such column".
 *  - **Durable idempotency marker.** The merge writes a singleton row into
 *    `akm_cutover_ledger` INSIDE the same transaction as the data move, so a
 *    crash after COMMIT (but before the workflow.db unlink) never re-runs the
 *    INSERT…SELECT (which would duplicate rows). The
 *    boundary ops (index quarantine, workflow.db unlink) key on that committed
 *    marker and are idempotent.
 *  - **Ref-map source (b) — the frozen legacy-layout walk — is best-effort.**
 *    It only ADDS mappings for on-disk assets the index no longer holds, using
 *    the source's `registryId` (or a local basename slug) as the bundle. The
 *    primary correctness path is source (a): the last-good index join, which
 *    reads the durable `item_ref` directly.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { warn } from "../../../../src/core/warn";
import { writeFileAtomic } from "../../../../src/core/common";
import { type Database, openDatabaseFinalizing, type SqlValue } from "../../../../src/storage/database";
import { applyStandardPragmas } from "../../../../src/storage/sqlite-pragmas";
import { classifyRefGrammar, parseStoredRef } from "../legacy-ref-grammar";
import { deriveCanonicalAssetName, TYPE_DIRS } from "./legacy-layout";

// ═══════════════════════════════════════════════════════════════════════
// Errors + report shapes
// ═══════════════════════════════════════════════════════════════════════

/**
 * A re-key INTEGRITY failure (unparseable stored ref, or a post-pass row-count
 * mismatch). Distinct from an EXPECTED orphan (old ref → no live item), which is
 * quarantined and never aborts the cutover. The apply flow retains its sentinel
 * so the operator can repair the input and retry.
 */
export class CutoverIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CutoverIntegrityError";
  }
}

/** Per-table counts from a re-key pass (for logging + test assertions). */
export interface CutoverRekeyReport {
  /** Distinct old refs re-keyed onto their new item_ref, per table. */
  readonly rekeyed: Record<string, number>;
  /** Distinct old refs quarantined to `legacy_state` (expected orphans), per table. */
  readonly quarantined: Record<string, number>;
  /** Scalar-table collisions collapsed by most-recently-updated-wins, per table. */
  readonly merged: Record<string, number>;
  /** Tables/columns skipped because they do not exist on an older DB. */
  readonly skipped: string[];
}

export interface RunThreeDbCutoverResult {
  /** False when the merge was skipped because the committed marker was already present. */
  readonly merged: boolean;
  /** True when workflow.db was absent, so the merge arm was skipped (fresh install). */
  readonly workflowMissing: boolean;
  /** Rows copied per workflow/usage table. */
  readonly copied: Record<string, number>;
  /** The state re-key report (undefined when the marker short-circuited the run). */
  readonly rekey?: CutoverRekeyReport;
}

// ═══════════════════════════════════════════════════════════════════════
// Old-ref → item_ref map
// ═══════════════════════════════════════════════════════════════════════

/** A configured stash source root the ref map consults for origin aliases + the source (b) walk. */
export interface CutoverStashRoot {
  path: string;
  /** Canonical target bundle id used in the new item_ref. */
  bundleId?: string;
  /** Bundle id emitted by the pre-reservation derivation, when it differs. */
  legacyBundleId?: string;
  registryId?: string;
  /** True for the workspace-primary stash (bare / `stash` / `local` origins resolve here). */
  primary?: boolean;
}

export interface BuildCutoverRefMapOptions {
  /** Path to the pre-cutover index.db (the last-good index — may be absent). */
  oldIndexDbPath: string;
  /** Configured stash roots (from config sources); the first primary owns the bare/stash/local origins. */
  stashRoots?: readonly CutoverStashRoot[];
  /** Where the computed map is persisted as JSON, fsynced. */
  mapOutputPath: string;
}

const CUTOVER_REFMAP_FORMAT = 1 as const;

/**
 * Compute the old-ref → new item_ref map BEFORE any re-layout without writing.
 * Sources, in precedence order:
 *
 *   (a) last-good index join — `entries.entry_key` / `item_ref`, generalizing
 *       the F4c `classifyLegacyRefForRekey` origin rules to a full-table pass.
 *   (b) frozen legacy-layout walk of the configured stash roots, for on-disk
 *       refs the index no longer holds (best-effort — source (a) wins).
 */
export function computeCutoverRefMap(
  opts: Omit<BuildCutoverRefMapOptions, "mapOutputPath">,
): Map<string, string> {
  const map = new Map<string, string>();

  // ── Source (a): the last-good index join (authoritative). ──
  if (fs.existsSync(opts.oldIndexDbPath)) {
    const db = openDatabaseFinalizing(opts.oldIndexDbPath, { readonly: true });
    try {
      const entryColumns = tableExists(db, "main", "entries") ? new Set(columnNames(db, "main", "entries")) : undefined;
      if (["entry_key", "item_ref", "entry_type", "stash_dir"].every((column) => entryColumns?.has(column))) {
        const rows = db
          .prepare(
            "SELECT entry_key AS entryKey, item_ref AS itemRef, entry_type AS entryType, stash_dir AS stashDir " +
              "FROM entries WHERE item_ref IS NOT NULL AND item_ref <> ''",
          )
          .all() as Array<{ entryKey: string; itemRef: string; entryType: string | null; stashDir: string | null }>;
        for (const row of rows) addIndexEntryMappings(map, row, opts.stashRoots);
      }
    } finally {
      db.close();
    }
  }

  // ── Source (b): the frozen legacy-layout walk (completeness for stale-index refs). ──
  for (const root of opts.stashRoots ?? []) walkLegacyLayoutInto(map, root);

  return map;
}

/** Compute and durably persist the immutable operation ref map. */
export function buildCutoverRefMap(opts: BuildCutoverRefMapOptions): Map<string, string> {
  const map = computeCutoverRefMap(opts);
  persistRefMapJson(opts.mapOutputPath, map);
  return map;
}

/** First-wins insertion: an old spelling that already maps to a different item_ref keeps its first target. */
function setMapping(map: Map<string, string>, oldRef: string, itemRef: string): void {
  if (!map.has(oldRef)) map.set(oldRef, itemRef);
}

function addIndexEntryMappings(
  map: Map<string, string>,
  row: { entryKey: string; itemRef: string; stashDir: string | null },
  stashRoots: readonly CutoverStashRoot[] | undefined,
): void {
  const bareTail = row.entryKey.includes("//") ? row.entryKey.slice(row.entryKey.indexOf("//") + 2) : row.entryKey; // `type:name`
  const bundle = row.itemRef.includes("//") ? row.itemRef.slice(0, row.itemRef.indexOf("//")) : undefined;

  const matched = stashRoots?.find((r) => samePath(r.path, row.stashDir));
  const conceptId = bundle ? row.itemRef.slice(row.itemRef.indexOf("//") + 2) : undefined;
  const rekeyedBundle =
    matched?.bundleId && matched.legacyBundleId !== matched.bundleId && bundle === matched.legacyBundleId
      ? matched.bundleId
      : undefined;
  const targetItemRef = rekeyedBundle && conceptId ? `${rekeyedBundle}//${conceptId}` : row.itemRef;
  // No stash-root info (or an unrecognized root) → treat as the primary source,
  // so single-source installs (and the test fixtures) always get bare keys.
  const isPrimary = matched ? matched.primary === true || stashRoots?.[0] === matched : true;

  if (isPrimary) {
    setMapping(map, bareTail, targetItemRef); // bare `type:name` resolves to the default/primary
    setMapping(map, `stash//${bareTail}`, targetItemRef);
    setMapping(map, `local//${bareTail}`, targetItemRef);
  }
  if (bundle) setMapping(map, `${bundle}//${bareTail}`, targetItemRef);
  if (matched?.registryId) setMapping(map, `${matched.registryId}//${bareTail}`, targetItemRef);
  if (targetItemRef !== row.itemRef) setMapping(map, row.itemRef, targetItemRef);
  setMapping(map, row.entryKey, targetItemRef); // the literal stored key
}

/**
 * Best-effort source (b): walk a configured stash root's `TYPE_DIRS` with the
 * frozen resolver and add a mapping for each on-disk asset the index map does
 * not already cover. The bundle is the source's `registryId`, or a basename slug
 * for the primary (matching how the index mints the primary bundle id).
 */
function walkLegacyLayoutInto(map: Map<string, string>, root: CutoverStashRoot): void {
  let bundle: string;
  if (root.bundleId && root.bundleId.length > 0) bundle = root.bundleId;
  else if (root.registryId && root.registryId.length > 0) bundle = root.registryId;
  else if (root.primary) bundle = basenameSlug(root.path);
  else return; // non-primary source with no registryId — cannot form a stable bundle here
  for (const [type, dirName] of Object.entries(TYPE_DIRS)) {
    const typeRoot = path.join(root.path, dirName);
    let files: string[];
    try {
      files = listFilesRecursive(typeRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const filePath of files) {
      const name = safeDerive(type, typeRoot, filePath);
      if (name === undefined) continue;
      const bareTail = `${type}:${name}`;
      const conceptId = `${dirName}/${name}`;
      const itemRef = `${bundle}//${conceptId}`;
      setMapping(map, bareTail, itemRef);
      if (root.primary) {
        setMapping(map, `stash//${bareTail}`, itemRef);
        setMapping(map, `local//${bareTail}`, itemRef);
      }
      if (root.registryId) setMapping(map, `${root.registryId}//${bareTail}`, itemRef);
      if (root.legacyBundleId && root.legacyBundleId !== bundle) {
        setMapping(map, `${root.legacyBundleId}//${conceptId}`, itemRef);
      }
    }
  }
}

function safeDerive(type: string, typeRoot: string, filePath: string): string | undefined {
  try {
    return deriveCanonicalAssetName(type, typeRoot, filePath);
  } catch {
    return undefined;
  }
}

/** Basename slug matching the index's `slugForPath` primary-bundle derivation (reimplemented, not imported). */
function basenameSlug(sourcePath: string): string {
  const base = path
    .basename(path.resolve(sourcePath))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : "bundle";
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(abs);
    }
  };
  walk(dir);
  return out;
}

function samePath(a: string, b: string | null | undefined): boolean {
  if (!b) return false;
  return path.resolve(a) === path.resolve(b);
}

function persistRefMapJson(outputPath: string, map: Map<string, string>): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const entries = Object.fromEntries([...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const payload = { formatVersion: CUTOVER_REFMAP_FORMAT, entries };
  writeFileAtomic(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 0o600);
}

/** Load the persisted cutover map when a committed migration resumes at a boundary step. */
export function loadCutoverRefMap(inputPath: string): Map<string, string> {
  if (!fs.existsSync(inputPath)) {
    throw new CutoverIntegrityError(`persisted cutover ref map is missing: ${inputPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(inputPath, "utf8")) as {
    formatVersion?: unknown;
    entries?: unknown;
  };
  if (
    parsed.formatVersion !== CUTOVER_REFMAP_FORMAT ||
    !parsed.entries ||
    typeof parsed.entries !== "object" ||
    Array.isArray(parsed.entries)
  ) {
    throw new CutoverIntegrityError(`invalid persisted cutover ref map: ${inputPath}`);
  }
  const map = new Map<string, string>();
  for (const [oldRef, itemRef] of Object.entries(parsed.entries)) {
    if (!oldRef || typeof itemRef !== "string" || !itemRef) {
      throw new CutoverIntegrityError(`invalid persisted cutover ref map entry for ${oldRef}`);
    }
    map.set(oldRef, itemRef);
  }
  return map;
}

export function completeCutoverRefMap(
  inputPath: string,
  outputPath: string,
): void {
  try {
    fs.statSync(inputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    loadCutoverRefMap(outputPath);
    return;
  }
  persistRefMapJson(outputPath, loadCutoverRefMap(inputPath));
  fs.unlinkSync(inputPath);
}

export function loadCompletedCutoverRefMap(inputPath: string): {
  map: Map<string, string>;
} {
  return { map: loadCutoverRefMap(inputPath) };
}

const PILOT_TREATMENT_FILE = path.join(".akm", "measurement", "treatment-pilot-2026-06-14.txt");

function fsyncPilotTreatmentDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(directory, "r");
    fs.fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR" && code !== "EPERM") throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Re-key the one pre-0.9 pilot cohort file while the frozen old-ref map is available. */
export function migratePilotTreatmentFiles(
  stashRoots: readonly CutoverStashRoot[],
  refMap: Map<string, string>,
): number {
  let migrated = 0;
  const seen = new Set<string>();
  for (const root of stashRoots) {
    const file = path.join(root.path, PILOT_TREATMENT_FILE);
    const resolved = path.resolve(file);
    if (seen.has(resolved) || !fs.existsSync(file)) continue;
    seen.add(resolved);
    const original = fs.readFileSync(file, "utf8");
    const rewritten = original
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return line;
        const target = refMap.get(trimmed);
        if (!target) return line;
        const prefix = line.slice(0, line.indexOf(trimmed));
        const suffix = line.slice(line.indexOf(trimmed) + trimmed.length);
        return `${prefix}${target}${suffix}`;
      })
      .join("\n");
    if (rewritten === original) {
      fsyncPilotTreatmentDirectory(path.dirname(file));
      continue;
    }
    const mode = fs.statSync(file).mode & 0o777;
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
    let ownsTmp = false;
    try {
      const fd = fs.openSync(tmp, "wx", mode);
      ownsTmp = true;
      try {
        fs.fchmodSync(fd, mode);
        fs.writeFileSync(fd, rewritten);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
      ownsTmp = false;
      fsyncPilotTreatmentDirectory(path.dirname(file));
    } catch (error) {
      if (ownsTmp) fs.rmSync(tmp, { force: true });
      throw error;
    }
    migrated += 1;
  }
  return migrated;
}

// ═══════════════════════════════════════════════════════════════════════
// The re-key engine (per-table policy, cutover-design.md §3)
// ═══════════════════════════════════════════════════════════════════════

/** Scalar tables (PK = ref column) — most-recently-updated wins on collision. */
const SCALAR_REKEY_TABLES: ReadonlyArray<{ table: string; keyColumn: string; tsColumn: string }> = [
  { table: "asset_salience", keyColumn: "asset_ref", tsColumn: "updated_at" },
  { table: "asset_outcome", keyColumn: "asset_ref", tsColumn: "updated_at" },
];

/** Row-carried tables — UPDATE the ref column in place, rows preserved as-is. */
const EVENT_REKEY_TABLES: ReadonlyArray<{ table: string; keyColumn: string }> = [
  { table: "events", keyColumn: "ref" },
  { table: "proposals", keyColumn: "ref" },
  { table: "task_history", keyColumn: "target_ref" },
  { table: "proposal_fingerprints", keyColumn: "ref" },
  { table: "canary_queries", keyColumn: "anchor_ref" },
];

const HISTORICAL_REKEY_TABLES: ReadonlyArray<{ table: string; keyColumn: string }> = [
  { table: "usage_events", keyColumn: "entry_ref" },
];

const WORKFLOW_REF_TABLE = { table: "workflow_runs", keyColumn: "workflow_ref" } as const;

type RefResolution =
  | { kind: "rekey"; target: string }
  | { kind: "orphan" }
  | { kind: "skip" }
  | { kind: "integrity"; reason: string };

/**
 * Classify one stored ref against the map:
 *   - in the map            → re-key to its item_ref;
 *   - already new-grammar    → skip (idempotent; already canonical);
 *   - legacy + parseable     → EXPECTED orphan (no live item) → quarantine;
 *   - legacy + unparseable   → INTEGRITY failure → fail closed.
 */
function classifyCutoverRef(ref: string, refMap: Map<string, string>): RefResolution {
  const target = refMap.get(ref);
  if (target !== undefined) return { kind: "rekey", target };
  if (classifyRefGrammar(ref) === "bundle") return { kind: "skip" };
  try {
    parseStoredRef(ref);
  } catch {
    return { kind: "integrity", reason: `unparseable stored ref "${ref}"` };
  }
  return { kind: "orphan" };
}

function emptyReport(): {
  rekeyed: Record<string, number>;
  quarantined: Record<string, number>;
  merged: Record<string, number>;
  skipped: string[];
} {
  return { rekeyed: {}, quarantined: {}, merged: {}, skipped: [] };
}

function ensureLegacyStateTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS legacy_state (
      surface        TEXT NOT NULL,
      old_ref        TEXT NOT NULL,
      row_count      INTEGER NOT NULL DEFAULT 0,
      reason         TEXT NOT NULL,
      quarantined_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (surface, old_ref)
    );
  `);
}

/**
 * Full-row retention for quarantined refs.
 *
 * `legacy_state` records only a COUNT, so quarantining used to destroy the
 * payload — proposals (a user's pending queue), event and task history,
 * fingerprints, canary anchors — while
 * `docs/migration/v0.8-to-v0.9.md` promises "unresolvable refs are
 * quarantined, not dropped". Each row is preserved verbatim as JSON here
 * before it leaves its live table, so nothing the migration cannot re-key is
 * destroyed.
 *
 * Created ad hoc by the migrator (like `legacy_state`), NOT by a
 * `STATE_MIGRATIONS` body: those bodies are released and append-only.
 */
function ensureLegacyStateRowsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS legacy_state_rows (
      surface        TEXT NOT NULL,
      old_ref        TEXT NOT NULL,
      row_json       TEXT NOT NULL,
      quarantined_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS legacy_state_rows_lookup ON legacy_state_rows (surface, old_ref);
  `);
}

/**
 * Retain the complete rows for one quarantined ref. `__rowid` is stripped: it
 * is a read artifact, not part of the row's data.
 */
function retainQuarantinedRows(
  db: Database,
  surface: string,
  oldRef: string,
  rows: ReadonlyArray<Record<string, unknown>>,
): void {
  if (rows.length === 0) return;
  const stmt = db.prepare(`INSERT INTO legacy_state_rows (surface, old_ref, row_json) VALUES (?, ?, ?)`);
  for (const row of rows) {
    const { __rowid: _ignored, ...data } = row as Record<string, unknown> & { __rowid?: number };
    stmt.run(surface, oldRef, JSON.stringify(data));
  }
}

function quarantineRow(db: Database, surface: string, oldRef: string, count: number, reason: string): void {
  db.prepare(
    `INSERT INTO legacy_state (surface, old_ref, row_count, reason, quarantined_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(surface, old_ref) DO UPDATE SET row_count = excluded.row_count, reason = excluded.reason`,
  ).run(surface, oldRef, count, reason);
}

function rekeyHistoricalTable(
  db: Database,
  spec: { table: string; keyColumn: string },
  refMap: Map<string, string>,
  report: CutoverRekeyReport,
): void {
  if (!tableExists(db, "main", spec.table) || !columnNames(db, "main", spec.table).includes(spec.keyColumn)) {
    report.skipped.push(`${spec.table}.${spec.keyColumn}`);
    return;
  }
  const refs = db
    .prepare(`SELECT DISTINCT ${spec.keyColumn} AS ref FROM ${spec.table} WHERE ${spec.keyColumn} IS NOT NULL`)
    .all() as Array<{ ref: string }>;
  for (const { ref } of refs) {
    if (classifyRefGrammar(ref) !== "legacy") continue;
    const resolution = classifyCutoverRef(ref, refMap);
    if (resolution.kind === "integrity") throw new CutoverIntegrityError(`${spec.table}: ${resolution.reason}`);
    if (resolution.kind === "skip") continue;
    const rowCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM ${spec.table} WHERE ${spec.keyColumn} = ?`).get(ref) as { n: number }
    ).n;
    if (resolution.kind === "rekey") {
      db.prepare(`UPDATE ${spec.table} SET ${spec.keyColumn} = ? WHERE ${spec.keyColumn} = ?`).run(
        resolution.target,
        ref,
      );
      bump(report.rekeyed, spec.table);
      continue;
    }
    // Append-only history stays readable in place while the old spelling is
    // archived for audit; unlike event-row quarantine, no history is deleted.
    quarantineRow(db, spec.table, ref, rowCount, "orphan");
    bump(report.quarantined, spec.table);
  }
}

function canonicalWorkflowRunRef(ref: string): string | undefined {
  if (ref.startsWith("workflow:")) return `workflows/${ref.slice("workflow:".length)}`;
  const marker = "//workflow:";
  const markerIndex = ref.indexOf(marker);
  if (markerIndex < 0) return undefined;
  return `${ref.slice(0, markerIndex + 2)}workflows/${ref.slice(markerIndex + marker.length)}`;
}

function rekeyWorkflowRunRefs(db: Database, report: CutoverRekeyReport): void {
  const { table, keyColumn } = WORKFLOW_REF_TABLE;
  if (!tableExists(db, "main", table) || !columnNames(db, "main", table).includes(keyColumn)) {
    report.skipped.push(`${table}.${keyColumn}`);
    return;
  }
  const refs = db.prepare(`SELECT DISTINCT ${keyColumn} AS ref FROM ${table}`).all() as Array<{ ref: string }>;
  for (const { ref } of refs) {
    const target = canonicalWorkflowRunRef(ref);
    if (target === undefined || target === ref) continue;
    db.prepare(`UPDATE ${table} SET ${keyColumn} = ? WHERE ${keyColumn} = ?`).run(target, ref);
    bump(report.rekeyed, table);
  }
}

function isMissingTableOrColumn(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes("no such table") || msg.includes("no such column");
}

/**
 * The re-key engine over the caller's OPEN handle, INSIDE the caller's
 * transaction. Exposed via {@link rekeyStateDb} (which opens + wraps a txn) so
 * the Chunk-0b property harness can drive it directly.
 */
export function rekeyStateDbCore(db: Database, refMap: Map<string, string>): CutoverRekeyReport {
  const report = emptyReport();
  ensureLegacyStateTable(db);
  ensureLegacyStateRowsTable(db);
  for (const spec of SCALAR_REKEY_TABLES) rekeyScalarTable(db, spec, refMap, report);
  for (const spec of EVENT_REKEY_TABLES) rekeyEventTable(db, spec, refMap, report);
  for (const spec of HISTORICAL_REKEY_TABLES) rekeyHistoricalTable(db, spec, refMap, report);
  rekeyWorkflowRunRefs(db, report);
  return report;
}

/**
 * Open the state.db at `dbPath`, run the full re-key inside its own
 * transaction, and close. This is the shape the Chunk-0b `RekeyFn` harness
 * drives (`(dbPath, refMap)`); the cutover itself calls {@link rekeyStateDbCore}
 * directly inside the ATTACH transaction.
 */
export function rekeyStateDb(dbPath: string, refMap: Map<string, string>): CutoverRekeyReport {
  const db = openDatabaseFinalizing(dbPath);
  try {
    applyStandardPragmas(db, { dataDir: path.dirname(dbPath) });
    let report: CutoverRekeyReport = emptyReport();
    db.transaction(() => {
      report = rekeyStateDbCore(db, refMap);
    })();
    return report;
  } finally {
    db.close();
  }
}

export interface ProposalRefRepairReport {
  rekeyed: number;
  quarantined: number;
}

export interface LegacyStateRefRecord {
  readonly table: string;
  readonly column: string;
  readonly ref: string;
  readonly rowCount: number;
}

/**
 * Read-only inventory of every residual legacy ref surface owned by the state
 * re-key transaction. Keeping this list derived from the same table policy as
 * {@link rekeyStateDbCore} prevents recovery classification from lagging the
 * actual cutover surface.
 */
export function inspectLegacyStateRefs(dbPath: string): readonly LegacyStateRefRecord[] {
  if (!fs.existsSync(dbPath)) return [];
  const db = openDatabaseFinalizing(dbPath, { readonly: true });
  try {
    const records: LegacyStateRefRecord[] = [];
    const acknowledgedHistoricalRefs = new Set<string>();
    if (tableExists(db, "main", "legacy_state")) {
      const rows = db
        .prepare("SELECT surface, old_ref FROM legacy_state WHERE surface = 'usage_events'")
        .all() as Array<{ surface: string; old_ref: string }>;
      for (const row of rows) acknowledgedHistoricalRefs.add(`${row.surface}\0${row.old_ref}`);
    }
    const specs = [
      ...SCALAR_REKEY_TABLES.map((spec) => ({ table: spec.table, column: spec.keyColumn })),
      ...EVENT_REKEY_TABLES.map((spec) => ({ table: spec.table, column: spec.keyColumn })),
      ...HISTORICAL_REKEY_TABLES.map((spec) => ({ table: spec.table, column: spec.keyColumn })),
      { table: WORKFLOW_REF_TABLE.table, column: WORKFLOW_REF_TABLE.keyColumn },
    ];
    for (const spec of specs) {
      if (!tableExists(db, "main", spec.table) || !columnNames(db, "main", spec.table).includes(spec.column)) {
        continue;
      }
      const rows = db
        .prepare(
          `SELECT ${spec.column} AS ref, COUNT(*) AS row_count FROM ${spec.table} ` +
            `WHERE ${spec.column} IS NOT NULL GROUP BY ${spec.column} ORDER BY ${spec.column}`,
        )
        .all() as Array<{ ref: string; row_count: number }>;
      for (const row of rows) {
        if (classifyRefGrammar(row.ref) !== "legacy") continue;
        if (acknowledgedHistoricalRefs.has(`${spec.table}\0${row.ref}`)) continue;
        records.push(
          Object.freeze({ table: spec.table, column: spec.column, ref: row.ref, rowCount: row.row_count }),
        );
      }
    }
    return Object.freeze(records);
  } finally {
    db.close();
  }
}

export function countLegacyStateRefs(dbPath: string): number {
  return inspectLegacyStateRefs(dbPath).reduce((total, record) => total + record.rowCount, 0);
}

/**
 * A current-ledger repair must be lossless: non-proposal durable rows may only
 * be rewritten through the provenance-bound map. Terminal proposals retain
 * their established quarantine policy; pending proposals and every other
 * unmappable surface fail before backup or mutation.
 */
export function assertLegacyStateRefsRepairable(dbPath: string, refMap: Map<string, string>): void {
  const records = inspectLegacyStateRefs(dbPath);
  if (records.length === 0) return;
  let pendingProposals: Array<{ id: string; ref: string }> = [];
  if (records.some((record) => record.table === "proposals")) {
    const db = openDatabaseFinalizing(dbPath, { readonly: true });
    try {
      pendingProposals = db
        .prepare("SELECT id, ref FROM proposals WHERE status = 'pending' ORDER BY id")
        .all() as Array<{ id: string; ref: string }>;
    } finally {
      db.close();
    }
  }
  for (const record of records) {
    if (record.table === WORKFLOW_REF_TABLE.table && canonicalWorkflowRunRef(record.ref) !== undefined) continue;
    if (refMap.has(record.ref)) continue;
    if (record.table === "proposals") {
      const pending = pendingProposals.find((row) => row.ref === record.ref);
      if (!pending) continue;
      throw new CutoverIntegrityError(`pending proposal ${pending.id} has unmappable legacy ref ${pending.ref}`);
    }
    throw new CutoverIntegrityError(
      `${record.table}.${record.column} contains unmappable legacy ref ${record.ref} (${record.rowCount} row${
        record.rowCount === 1 ? "" : "s"
      }); restore or rebuild its pre-cutover ref mapping before retrying`,
    );
  }
}

export function countLegacyProposalRefs(dbPath: string): number {
  if (!fs.existsSync(dbPath)) return 0;
  const db = openDatabaseFinalizing(dbPath, { readonly: true });
  try {
    if (!tableExists(db, "main", "proposals")) return 0;
    const refs = db.prepare("SELECT ref FROM proposals").all() as Array<{ ref: string }>;
    return refs.filter((row) => classifyRefGrammar(row.ref) === "legacy").length;
  } finally {
    db.close();
  }
}

export function assertLegacyProposalRefsRepairable(dbPath: string, refMap: Map<string, string>): void {
  if (!fs.existsSync(dbPath)) return;
  const db = openDatabaseFinalizing(dbPath, { readonly: true });
  try {
    if (!tableExists(db, "main", "proposals")) return;
    const pending = db
      .prepare("SELECT id, ref FROM proposals WHERE status = 'pending'")
      .all() as Array<{ id: string; ref: string }>;
    for (const row of pending) {
      if (classifyRefGrammar(row.ref) === "legacy" && !refMap.has(row.ref)) {
        throw new CutoverIntegrityError(`pending proposal ${row.id} has unmappable legacy ref ${row.ref}`);
      }
    }
  } finally {
    db.close();
  }
}

/** Narrow current-RC repair for the retired proposal ref grammar. */
export function repairAlreadyCurrentProposalRefs(dbPath: string, refMap: Map<string, string>): ProposalRefRepairReport {
  const db = openDatabaseFinalizing(dbPath);
  try {
    const report: ProposalRefRepairReport = { rekeyed: 0, quarantined: 0 };
    db.transaction(() => {
      ensureLegacyStateTable(db);
      ensureLegacyStateRowsTable(db);
      const rows = db.prepare("SELECT rowid AS __rowid, * FROM proposals").all() as Array<
        Record<string, SqlValue> & { __rowid: number; ref: string; status: string }
      >;
      for (const row of rows) {
        if (classifyRefGrammar(row.ref) !== "legacy") continue;
        const target = refMap.get(row.ref);
        if (target) {
          db.prepare("UPDATE proposals SET ref = ? WHERE rowid = ?").run(target, row.__rowid);
          report.rekeyed++;
          continue;
        }
        if (row.status === "pending") {
          throw new CutoverIntegrityError(`pending proposal ${String(row.id)} has unmappable legacy ref ${row.ref}`);
        }
        quarantineRow(db, "proposals", row.ref, 1, "unmappable-terminal-proposal-ref");
        retainQuarantinedRows(db, "proposals", row.ref, [row]);
        db.prepare("DELETE FROM proposals WHERE rowid = ?").run(row.__rowid);
        report.quarantined++;
      }
    })();
    return report;
  } finally {
    db.close();
  }
}

function bump(bucket: Record<string, number>, key: string, by = 1): void {
  bucket[key] = (bucket[key] ?? 0) + by;
}

function rekeyScalarTable(
  db: Database,
  spec: { table: string; keyColumn: string; tsColumn: string },
  refMap: Map<string, string>,
  report: {
    rekeyed: Record<string, number>;
    quarantined: Record<string, number>;
    merged: Record<string, number>;
    skipped: string[];
  },
): void {
  let rows: Array<Record<string, SqlValue> & { __rowid: number }>;
  try {
    rows = db.prepare(`SELECT rowid AS __rowid, * FROM ${spec.table}`).all() as Array<
      Record<string, SqlValue> & { __rowid: number }
    >;
  } catch (err) {
    if (isMissingTableOrColumn(err)) {
      report.skipped.push(spec.table);
      return;
    }
    throw err;
  }

  const groups = new Map<string, Array<Record<string, SqlValue> & { __rowid: number }>>();
  // oldRef → the FULL rows (not just rowids): a quarantined row is retained
  // verbatim before deletion, so its payload has to still be in hand here.
  const orphans = new Map<string, Array<Record<string, SqlValue> & { __rowid: number }>>();

  for (const row of rows) {
    const key = String(row[spec.keyColumn]);
    const resolution = classifyCutoverRef(key, refMap);
    if (resolution.kind === "integrity") throw new CutoverIntegrityError(`${spec.table}: ${resolution.reason}`);
    if (resolution.kind === "orphan") {
      const list = orphans.get(key) ?? [];
      list.push(row);
      orphans.set(key, list);
      continue;
    }
    const target = resolution.kind === "rekey" ? resolution.target : key; // skip → itself
    const group = groups.get(target) ?? [];
    group.push(row);
    groups.set(target, group);
  }

  // Expected orphans: audit, RETAIN the full rows, then delete.
  for (const [oldRef, orphanRows] of orphans) {
    quarantineRow(db, spec.table, oldRef, orphanRows.length, "orphan");
    retainQuarantinedRows(db, spec.table, oldRef, orphanRows);
    for (const row of orphanRows) db.prepare(`DELETE FROM ${spec.table} WHERE rowid = ?`).run(row.__rowid);
    bump(report.quarantined, spec.table);
  }

  // Groups: collapse each onto its canonical key (most-recently-updated wins).
  for (const [target, group] of groups) {
    if (group.length === 1 && String(group[0]![spec.keyColumn]) === target) continue; // already canonical, nothing maps onto it
    const winner = group.reduce((best, candidate) => (mruWins(candidate, best, spec.tsColumn) ? candidate : best));
    for (const row of group) db.prepare(`DELETE FROM ${spec.table} WHERE rowid = ?`).run(row.__rowid);
    reinsertRow(db, spec.table, winner, spec.keyColumn, target);
    if (group.length > 1) bump(report.merged, spec.table);
    bump(report.rekeyed, spec.table);
  }
}

/** True when `candidate` should beat `best`: larger tsColumn, ties broken by larger rowid (deterministic). */
function mruWins(
  candidate: Record<string, SqlValue> & { __rowid: number },
  best: Record<string, SqlValue> & { __rowid: number },
  tsColumn: string,
): boolean {
  const ct = Number(candidate[tsColumn] ?? 0);
  const bt = Number(best[tsColumn] ?? 0);
  if (ct !== bt) return ct > bt;
  return candidate.__rowid > best.__rowid;
}

function reinsertRow(
  db: Database,
  table: string,
  winner: Record<string, SqlValue> & { __rowid: number },
  keyColumn: string,
  target: string,
): void {
  const row: Record<string, SqlValue> = {};
  for (const [col, value] of Object.entries(winner)) {
    if (col === "__rowid") continue;
    row[col] = col === keyColumn ? target : value;
  }
  const columns = Object.keys(row);
  const placeholders = columns.map(() => "?").join(", ");
  db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`).run(
    ...columns.map((c) => row[c]!),
  );
}

function rekeyEventTable(
  db: Database,
  spec: { table: string; keyColumn: string },
  refMap: Map<string, string>,
  report: {
    rekeyed: Record<string, number>;
    quarantined: Record<string, number>;
    merged: Record<string, number>;
    skipped: string[];
  },
): void {
  let beforeCount: number;
  let refs: Array<{ ref: string }>;
  try {
    beforeCount = countRows(db, spec.table);
    refs = db
      .prepare(`SELECT DISTINCT ${spec.keyColumn} AS ref FROM ${spec.table} WHERE ${spec.keyColumn} IS NOT NULL`)
      .all() as Array<{ ref: string }>;
  } catch (err) {
    if (isMissingTableOrColumn(err)) {
      report.skipped.push(spec.table);
      return;
    }
    throw err;
  }

  let orphanRowsDeleted = 0;
  for (const { ref } of refs) {
    const resolution = classifyCutoverRef(ref, refMap);
    if (resolution.kind === "integrity") throw new CutoverIntegrityError(`${spec.table}: ${resolution.reason}`);
    if (resolution.kind === "skip") continue;
    if (resolution.kind === "orphan") {
      const orphanRows = db
        .prepare(`SELECT * FROM ${spec.table} WHERE ${spec.keyColumn} = ?`)
        .all(ref) as Array<Record<string, unknown>>;
      const n = orphanRows.length;
      quarantineRow(db, spec.table, ref, n, "orphan");
      retainQuarantinedRows(db, spec.table, ref, orphanRows);
      db.prepare(`DELETE FROM ${spec.table} WHERE ${spec.keyColumn} = ?`).run(ref);
      orphanRowsDeleted += n;
      bump(report.quarantined, spec.table);
      continue;
    }
    db.prepare(`UPDATE ${spec.table} SET ${spec.keyColumn} = ? WHERE ${spec.keyColumn} = ?`).run(
      resolution.target,
      ref,
    );
    bump(report.rekeyed, spec.table);
  }

  const afterCount = countRows(db, spec.table);
  if (afterCount !== beforeCount - orphanRowsDeleted) {
    throw new CutoverIntegrityError(
      `${spec.table}: row-count mismatch after re-key (before ${beforeCount}, deleted-orphans ${orphanRowsDeleted}, after ${afterCount})`,
    );
  }
}

function countRows(db: Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

// ═══════════════════════════════════════════════════════════════════════
// The data step: workflow merge + usage_events rescue + full re-key
// ═══════════════════════════════════════════════════════════════════════

export interface RunThreeDbCutoverOptions {
  /** The old-ref → item_ref map (from {@link buildCutoverRefMap}). */
  refMap: Map<string, string>;
  /** Durable operation id — persisted in the idempotency marker. */
  operationId: string;
  statePath: string;
  workflowPath: string;
  oldIndexPath: string;
}

function ensureCutoverLedger(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS akm_cutover_ledger (
      singleton    INTEGER PRIMARY KEY CHECK (singleton = 1),
      operation_id TEXT NOT NULL,
      merged_at    TEXT NOT NULL
    );
  `);
}

/**
 * READ-ONLY check for the committed merge marker. Must NOT create the table:
 * this runs BEFORE the cutover transaction. The table is created inside the
 * transaction alongside the marker INSERT.
 */
function cutoverAlreadyMerged(db: Database, operationId: string): boolean {
  if (!tableExists(db, "main", "akm_cutover_ledger")) return false;
  const marker = db.prepare("SELECT operation_id FROM akm_cutover_ledger WHERE singleton = 1").get() as
    | { operation_id: string }
    | undefined;
  if (!marker) return false;
  if (marker.operation_id !== operationId) {
    throw new CutoverIntegrityError(
      `state.db cutover marker belongs to operation ${marker.operation_id}, not ${operationId}`,
    );
  }
  return true;
}

/**
 * Whether the state.db has already recorded the committed cutover merge marker —
 * the durable key the boundary ops (index quarantine, workflow.db unlink) and
 * the apply-flow idempotency check consult.
 */
export function cutoverMergeCommitted(statePath: string, operationId?: string): boolean {
  if (!fs.existsSync(statePath)) return false;
  const db = openDatabaseFinalizing(statePath, { readonly: true });
  try {
    if (!tableExists(db, "main", "akm_cutover_ledger")) return false;
    const marker = db.prepare("SELECT operation_id FROM akm_cutover_ledger WHERE singleton = 1").get() as
      | { operation_id: string }
      | undefined;
    return !!marker && (operationId === undefined || marker.operation_id === operationId);
  } finally {
    db.close();
  }
}

/**
 * The full three-DB data step (cutover-design.md §2 step 3). Opens state.db,
 * ATTACHes workflow.db + the old index.db read-only OUTSIDE any transaction,
 * then in ONE `BEGIN IMMEDIATE`: INSERT…SELECTs the three workflow tables, the
 * usage_events rescue (residual legacy `entry_ref` re-keyed via the map), and
 * the old index.db `legacy_state` carry, then the FULL state re-key
 * ({@link rekeyStateDbCore}), then writes the idempotency marker, COMMITs, and
 * DETACHes. Idempotent: a committed marker short-circuits the whole run.
 *
 * Throws {@link CutoverIntegrityError} on an integrity failure. A missing
 * workflow.db skips the merge arm (never ATTACHes it — ATTACH would CREATE the
 * file).
 */
export function runThreeDbCutover(opts: RunThreeDbCutoverOptions): RunThreeDbCutoverResult {
  const copied: Record<string, number> = {};
  const db = openDatabaseFinalizing(opts.statePath);
  try {
    db.exec("PRAGMA busy_timeout = 30000");

    if (cutoverAlreadyMerged(db, opts.operationId)) {
      return { merged: false, workflowMissing: !fs.existsSync(opts.workflowPath), copied };
    }

    const workflowExists = fs.existsSync(opts.workflowPath);
    const oldIndexExists = fs.existsSync(opts.oldIndexPath);

    assertNoStaleAttachments(db);

    if (workflowExists) db.exec(`ATTACH DATABASE '${sqliteQuote(opts.workflowPath)}' AS wf`);
    if (oldIndexExists) db.exec(`ATTACH DATABASE '${sqliteQuote(opts.oldIndexPath)}' AS oldidx`);
    let rekey: CutoverRekeyReport = emptyReport();
    try {
      db.exec("BEGIN IMMEDIATE");
      ensureLegacyStateTable(db);
      ensureCutoverLedger(db);

      if (workflowExists) {
        // Parent-first for the ON DELETE CASCADE foreign keys.
        copied.workflow_runs = copyTable(db, "wf", "workflow_runs");
        copied.workflow_run_steps = copyTable(db, "wf", "workflow_run_steps");
        copied.workflow_run_units = copyTable(db, "wf", "workflow_run_units");
      }

      if (oldIndexExists) {
        copied.usage_events = rescueUsageEvents(db);
        carryLegacyState(db, "oldidx");
      }

      rekey = rekeyStateDbCore(db, opts.refMap);

      db.prepare(
        "INSERT INTO akm_cutover_ledger (singleton, operation_id, merged_at) VALUES (1, ?, datetime('now'))",
      ).run(opts.operationId);
      db.exec("COMMIT");
    } catch (error) {
      if (db.inTransaction) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Preserve the original error.
        }
      }
      throw error;
    } finally {
      // DETACH must happen OUTSIDE any transaction (an in-txn DETACH fails).
      if (oldIndexExists) safeDetach(db, "oldidx");
      if (workflowExists) safeDetach(db, "wf");
    }

    // Flush committed pages into the main file before boundary cleanup. No-op
    // when the DB is not in WAL mode; the journal mode itself is unchanged.
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // Not in WAL mode / nothing to checkpoint.
    }

    return { merged: true, workflowMissing: !workflowExists, copied, rekey };
  } finally {
    db.close();
  }
}

function assertNoStaleAttachments(db: Database): void {
  const attached = (db.prepare("PRAGMA database_list").all() as Array<{ name: string }>).map((r) => r.name);
  const stale = attached.filter((name) => name === "wf" || name === "oldidx");
  if (stale.length > 0) {
    for (const name of stale) safeDetach(db, name);
  }
}

function safeDetach(db: Database, schema: string): void {
  try {
    db.exec(`DETACH DATABASE ${schema}`);
  } catch {
    // Already detached / never attached.
  }
}

/** Copy the INTERSECTION of columns from an attached-schema table into the matching `main` table. */
function copyTable(db: Database, srcSchema: string, table: string): number {
  if (!tableExists(db, srcSchema, table)) return 0;
  const srcCols = new Set(columnNames(db, srcSchema, table));
  const common = columnNames(db, "main", table).filter((c) => srcCols.has(c));
  if (common.length === 0) return 0;
  const colList = common.join(", ");
  db.exec(`INSERT INTO main.${table} (${colList}) SELECT ${colList} FROM ${srcSchema}.${table}`);
  return countRows(db, table);
}

/**
 * Rescue the durable index.db `usage_events` history into state.db. Copies the
 * column intersection (fresh AUTOINCREMENT ids are fine — `entry_id` is an
 * index-generation-scoped provenance column the relink pass re-derives).
 * The shared state re-key pass handles both copied and already-present
 * `entry_ref`s afterward, so current-ledger recovery cannot miss this table.
 */
function rescueUsageEvents(db: Database): number {
  if (!tableExists(db, "oldidx", "usage_events")) return 0;
  const srcCols = new Set(columnNames(db, "oldidx", "usage_events"));
  // Never carry the source rowid/id — let state.db mint fresh AUTOINCREMENT ids.
  const common = columnNames(db, "main", "usage_events").filter((c) => c !== "id" && srcCols.has(c));
  if (common.length > 0) {
    const targetColumns = [...common];
    const selectColumns = [...common];
    // Rows from the pre-provenance schema are historical but not necessarily
    // interactive. Preserve them as unattributed rather than manufacturing
    // user demand through state.db's legacy column default.
    if (!srcCols.has("source")) {
      targetColumns.push("source");
      selectColumns.push("'unknown'");
    }
    db.exec(
      `INSERT INTO main.usage_events (${targetColumns.join(", ")}) ` +
        `SELECT ${selectColumns.join(", ")} FROM oldidx.usage_events`,
    );
  }

  return countRows(db, "usage_events");
}

/** Carry the old index.db `legacy_state` quarantine rows into state.db (durable re-home). */
function carryLegacyState(db: Database, srcSchema: string): void {
  if (!tableExists(db, srcSchema, "legacy_state")) return;
  const srcCols = new Set(columnNames(db, srcSchema, "legacy_state"));
  const common = ["surface", "old_ref", "row_count", "reason", "quarantined_at"].filter((c) => srcCols.has(c));
  if (!common.includes("surface") || !common.includes("old_ref")) return;
  const colList = common.join(", ");
  db.exec(`INSERT OR IGNORE INTO main.legacy_state (${colList}) SELECT ${colList} FROM ${srcSchema}.legacy_state`);
}

// ═══════════════════════════════════════════════════════════════════════
// Index/workflow boundary steps (AFTER the committed state txn)
// ═══════════════════════════════════════════════════════════════════════

const DB_SIDECARS = ["-wal", "-shm"] as const;

/**
 * Replayable rename of the old index.db (+ `-wal`/`-shm`) to
 * `index.db.pre-cutover-<runId>`. Runs AFTER the state transaction commits; the
 * next index run rebuilds from scratch. A failure never rolls back that committed
 * transaction, but it does retain the incomplete apply sentinel for retry.
 */
export function quarantineIndexDb(runId: string, indexPath: string): { quarantined: boolean; target?: string } {
  try {
    if (process.env.AKM_TEST_MIGRATION_FAIL_INDEX_QUARANTINE === "1") {
      throw new Error("injected index.db quarantine failure");
    }
    const target = `${indexPath}.pre-cutover-${runId}`;
    const sourceMainExists = fs.existsSync(indexPath);
    const targetMainExists = fs.existsSync(target);
    if (sourceMainExists && targetMainExists) return { quarantined: true, target };
    if (!sourceMainExists && !targetMainExists) return { quarantined: false };

    const remainingSidecars = DB_SIDECARS.filter((suffix) => fs.existsSync(`${indexPath}${suffix}`));
    if (remainingSidecars.some((suffix) => fs.existsSync(`${target}${suffix}`))) {
      const detail = "index.db quarantine sidecar collision; canonical sidecars were preserved";
      if (!targetMainExists) throw new Error(detail);
      warn(`[akm] three-DB cutover: ${detail}.`);
      return { quarantined: targetMainExists, ...(targetMainExists ? { target } : {}) };
    }

    if (sourceMainExists) fs.renameSync(indexPath, target);
    for (const suffix of remainingSidecars) fs.renameSync(`${indexPath}${suffix}`, `${target}${suffix}`);
    return { quarantined: true, target };
  } catch (error) {
    throw new Error(
      `index.db quarantine rename failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * Idempotent unlink of workflow.db + its `-wal`/`-shm` sidecars. A failure throws
 * so the incomplete apply sentinel remains and the same cutover retries.
 */
export function deleteWorkflowDb(workflowPath: string): { deleted: boolean } {
  if (process.env.AKM_TEST_MIGRATION_FAIL_WORKFLOW_DELETE === "1") {
    throw new Error("injected workflow.db unlink failure");
  }
  let deleted = false;
  for (const suffix of ["-shm", "-wal", ""] as const) {
    const target = `${workflowPath}${suffix}`;
    if (fs.existsSync(target)) {
      fs.rmSync(target, { force: true });
      if (suffix === "") deleted = true;
    }
  }
  return { deleted };
}

// ═══════════════════════════════════════════════════════════════════════
// Small SQL helpers
// ═══════════════════════════════════════════════════════════════════════

function tableExists(db: Database, schema: string, table: string): boolean {
  return !!db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`).get(table);
}

function columnNames(db: Database, schema: string, table: string): string[] {
  return (db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name);
}

/** Escape single quotes for an inline SQLite string literal (paths only — never user ref data). */
function sqliteQuote(value: string): string {
  return value.replace(/'/g, "''");
}
