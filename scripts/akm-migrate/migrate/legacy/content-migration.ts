// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * @removeIn 0.10.0
 *
 * The one-time content migration (akm 0.9.0 Chunk 8, WI-8.5d; ref-grammar
 * decision D-R6; plan §3.4). Three idempotent filesystem folds retire the last
 * pre-0.9 on-disk shapes after the state transaction commits. Malformed legacy
 * data is reported and retained; operational failures leave the apply sentinel
 * in place so the whole transform sequence can be retried.
 *
 *  1. **`.stash.json` death.** For each per-directory `.stash.json` sidecar under
 *     the configured stash roots, fold its curated overrides into the matching
 *     file's YAML frontmatter (the sidecar override WON at read time, so it wins
 *     on fold too), then delete the sidecar. Only markdown targets are folded:
 *     the indexer reads curated frontmatter for `.md` files only
 *     ({@link applyCuratedFrontmatter} runs on `ext === ".md"`), and prepending a
 *     `---` block to a shell/script/env asset would corrupt it — non-markdown
 *     entries are counted + logged, never rewritten. A sidecar is deleted only
 *     after every entry folds successfully; otherwise its source bytes remain.
 *  2. **D-R6 reserved-filename conformance.** OKF reserves `index.md`/`log.md` as
 *     bundle structure at every depth (never concept documents). A pre-existing
 *     stash file so named that the frozen layout treated as an asset (or that
 *     carries explicit asset frontmatter outside a canonical type root) is
 *     renamed to a collision-safe reported name (`index-content.md`,
 *     `log-content.md`, appending `-2`/`-3`/… on collision) so the akm adapter's
 *     new reserved-file exclusion never silently drops it. A structural
 *     `index.md`/`log.md` (no asset frontmatter) is left in place.
 *  3. **`derived_from` backref grammar (Group-C item 2).** A derived memory's
 *     `source: memory:<name>` frontmatter backref — the last deliberately-legacy
 *     ref channel (WI-8.5c survivor) — is rewritten forward to the 0.9.0
 *     `source: memories/<name>` conceptId, matching the flipped producer output.
 *     Idempotent: a value already in `memories/<name>` (or any non-`memory:`
 *     `source`) is left untouched. The index `derived_from` COLUMN needs no fold
 *     — it is regenerable, so the producer flip + a reindex re-key it.
 *
 * PRE-RELEASE EXTENSION NOTE: 0.9.0 is UNRELEASED, so no user has run the cutover
 * yet. Fold #3 was ADDED to this step (not a second migration) after folds #1/#2
 * shipped in-branch — the module's READ behavior (the frozen sidecar reader) is
 * unchanged; only the rewrite/fold set grew. Post-release this file is frozen.
 * The pre-0.9 filesystem-proposal import (`proposal-fs-import.ts`) is a sibling
 * transform wired in `config-migrate.ts`; its count rides
 * the {@link ContentMigrationReport} (`legacyProposalsImported`) — this module
 * defaults it to 0 since the fold itself only rewrites on-disk shapes.
 *
 * This module is migrator-only and imports the frozen sidecar reader
 * ({@link readLegacyStashOverrides}) plus core leaves; it is never on a live
 * indexer path.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IndexDocument } from "../../../../src/core/adapter/types";
import { mutateFrontmatter, parseFrontmatter } from "../../../../src/core/asset/frontmatter";
import { asNonEmptyString, writeFileAtomic } from "../../../../src/core/common";
import { warn } from "../../../../src/core/warn";
import { isRelevantAssetFile, TYPE_DIRS } from "./legacy-layout";
import { inspectLegacyStashOverrides, legacyStashFilePath } from "./legacy-stash-json";

/** A single D-R6 reserved-filename rename, recorded in the step report. */
export interface ReservedRename {
  /** Absolute path of the mis-named reserved file. */
  readonly from: string;
  /** Absolute path it was renamed to (collision-safe). */
  readonly to: string;
}

export interface ReservedRenameBatch {
  readonly formatVersion: 1;
  readonly operationId: string;
  readonly entries: ReservedRename[];
}

/** Per-run counts + the D-R6 rename list, for logging + test assertions. */
export interface ContentMigrationReport {
  /** Directories whose `.stash.json` sidecar was folded then deleted. */
  sidecarsFolded: number;
  /** Curated sidecar entries folded into a markdown file's frontmatter. */
  entriesFolded: number;
  /** Sidecar entries skipped (no `filename`, missing target, or non-markdown). */
  entriesSkipped: number;
  /** D-R6 reserved-file renames performed. */
  reservedRenames: ReservedRename[];
  /**
   * Group-C item 2: derived-memory `source: memory:<name>` frontmatter backrefs
   * rewritten forward to the 0.9.0 `source: memories/<name>` conceptId. A value
   * already in `memories/<name>` (or any non-`memory:` `source`) is not counted.
   */
  sourceBackrefsRewritten: number;
  /**
   * Pre-0.9.0 filesystem proposals (`<stash>/.akm/proposals/`) imported into the
   * migrated state.db `proposals` table. Populated by the migrate-apply step
   * (`config-migrate.ts` folds in the {@link importLegacyProposalsIntoState}
   * count), NOT by {@link runContentMigration}, which only rewrites the on-disk
   * shapes above — the proposal import needs the migrated state.db handle, so it
   * runs as a sibling additive step in the same apply and reports its count here.
   * Idempotent: a second apply re-inserts nothing (INSERT OR IGNORE on UUID), so
   * it reports 0.
   */
  legacyProposalsImported: number;
  /** Mandatory disposition for every sidecar that could not be fully folded. */
  sidecarReports: Array<{ path: string; status: "malformed" | "partial"; detail: string }>;
}

/** OKF reserved structural filenames (case-insensitive, any depth). */
const RESERVED_BASENAMES = new Set(["index.md", "log.md"]);

/**
 * The sidecar `IndexDocument` fields that {@link applyCuratedFrontmatter} reads
 * back off frontmatter, paired with the frontmatter KEY the indexer expects
 * (one key is renamed on the way in: `whenToUse`→`when_to_use`; legacy
 * `sourceRefs` arrives already merged into `xrefs` by the sidecar reader).
 * Fields the indexer never reads off frontmatter
 * (`confidence`/`source`/`fileSize`/`filename`/…) are intentionally absent — the
 * fold preserves only what survives a re-index, so it stays faithful.
 */
const CURATED_FIELD_MAP: ReadonlyArray<readonly [keyof IndexDocument | "sourceRefs", string]> = [
  ["description", "description"],
  ["tags", "tags"],
  ["aliases", "aliases"],
  ["searchHints", "searchHints"],
  ["usage", "usage"],
  ["examples", "examples"],
  ["run", "run"],
  ["setup", "setup"],
  ["cwd", "cwd"],
  ["quality", "quality"],
  ["category", "category"],
  ["beliefState", "beliefState"],
  ["supersededBy", "supersededBy"],
  ["contradictedBy", "contradictedBy"],
  ["generation", "generation"],
  // `xrefs` carries both the sidecar's own xrefs and any legacy `sourceRefs`
  // (merged in by the migrator's sidecar reader — see legacy-stash-json.ts):
  // the retired `sourceRefs`→`source_refs` mapping could never fire, because
  // `validateStashEntry` stopped copying the field, and `source_refs` has no
  // 0.9 readers anyway. `sources` is the wiki provenance list, validated and
  // round-tripped by the indexer alongside `xrefs`.
  ["xrefs", "xrefs"],
  ["sources", "sources"],
  ["currentBeliefRefs", "currentBeliefRefs"],
  ["captureMode", "captureMode"],
  ["whenToUse", "when_to_use"],
  ["lessonStrength", "lessonStrength"],
  ["evidenceSources", "evidenceSources"],
  ["intent", "intent"],
  ["scope", "scope"],
];

function emptyReport(): ContentMigrationReport {
  return {
    sidecarsFolded: 0,
    entriesFolded: 0,
    entriesSkipped: 0,
    reservedRenames: [],
    sourceBackrefsRewritten: 0,
    legacyProposalsImported: 0,
    sidecarReports: [],
  };
}

function safeIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Absolute directories under `root` (inclusive), best-effort (unreadable dirs
 * skipped). Dot-directories (`.git`, `.meta`, …) are skipped: the indexer never
 * descends into them, so they hold no items to migrate and no `.stash.json` the
 * live reader would have merged.
 */
function collectDirs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    out.push(dir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) walk(path.join(dir, entry.name));
    }
  };
  walk(root);
  return out;
}

/**
 * Run the content migration over the configured stash roots. Malformed content
 * is retained and reported; filesystem failures other than direct absence
 * propagate so migrate-apply can retry.
 */
export function runContentMigration(
  stashRoots: readonly string[],
  options: { renameBatchPath?: string; operationId?: string } = {},
): ContentMigrationReport {
  const report = emptyReport();
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const root of stashRoots) {
    const resolved = path.resolve(root);
    if (seen.has(resolved) || !safeIsDir(resolved)) continue;
    seen.add(resolved);
    roots.push(resolved);
  }
  for (const resolved of roots) {
    const dirs = collectDirs(resolved);
    for (const dir of dirs) foldSidecarInDir(dir, report);
    for (const dir of dirs) rewriteSourceBackrefsInDir(dir, report);
  }
  const operationId = options.operationId ?? `direct-${process.pid}-${randomBytes(8).toString("hex")}`;
  const batchPath =
    options.renameBatchPath ?? path.join(os.tmpdir(), `akm-reserved-renames-${operationId}-${randomBytes(8).toString("hex")}.json`);
  let batch: ReservedRenameBatch;
  try {
    batch = loadReservedRenameBatch(batchPath, operationId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    batch = planReservedRenameBatch(roots, batchPath, operationId);
  }
  applyReservedRenameBatch(batch, operationId);
  report.reservedRenames.push(...batch.entries.map(({ from, to }) => ({ from, to })));
  if (!options.renameBatchPath) fs.rmSync(batchPath, { force: true });
  return report;
}

/**
 * Group-C item 2: rewrite each markdown file's legacy `source: memory:<name>`
 * derived-memory backref forward to the 0.9.0 `source: memories/<name>`
 * conceptId. Idempotent — a `source` already in `memories/<name>` (or any value
 * that is not a `memory:` backref) is skipped, so a second apply rewrites
 * nothing. Best-effort per file (log + continue on error).
 */
function rewriteSourceBackrefsInDir(dir: string, report: ContentMigrationReport): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".md") continue;
    const filePath = path.join(dir, entry.name);
    try {
      const source = asNonEmptyString(parseFrontmatter(fs.readFileSync(filePath, "utf8")).data.source);
      const rewritten = legacyMemoryBackrefToConceptId(source);
      if (rewritten === undefined) continue; // already conceptId / not a memory backref → no-op
      mutateFrontmatterAtomic(filePath, (parsed) => ({ ...parsed.data, source: rewritten }));
      report.sourceBackrefsRewritten++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      warn(`[akm] content-migration: could not rewrite source backref in ${filePath}: ${errMsg(error)}`);
    }
  }
}

/**
 * Return the `memories/<name>` conceptId for a legacy `memory:<name>` backref,
 * or `undefined` when `value` is absent, already a `memories/<name>` conceptId,
 * or not a `memory:` backref at all. Only the bare legacy spelling the producer
 * ever wrote is rewritten (origin-prefixed values were never produced on
 * `source:` and are left untouched — the tolerant reader still normalises them).
 */
function legacyMemoryBackrefToConceptId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const MEMORY_PREFIX = "memory:";
  if (!trimmed.startsWith(MEMORY_PREFIX)) return undefined;
  return `memories/${trimmed.slice(MEMORY_PREFIX.length)}`;
}

/** Fold + delete one directory's `.stash.json`, if present. */
function foldSidecarInDir(dir: string, report: ContentMigrationReport): void {
  const sidecarPath = legacyStashFilePath(dir);
  const inspected = inspectLegacyStashOverrides(dir);
  if (inspected.status !== "valid") {
    if (inspected.status === "invalid") {
      report.sidecarReports.push({ path: sidecarPath, status: "malformed", detail: inspected.detail });
    }
    if (inspected.status === "invalid") warn(`[akm] content-migration: retained unreadable sidecar ${sidecarPath}.`);
    return;
  }
  let complete = inspected.complete;
  for (const entry of inspected.stash.entries) complete = foldEntry(dir, entry, report) && complete;
  if (!complete) {
    report.sidecarReports.push({
      path: sidecarPath,
      status: "partial",
      detail: "one or more entries could not be folded",
    });
    warn(`[akm] content-migration: retained partially migrated sidecar ${sidecarPath}.`);
    return;
  }
  fs.rmSync(sidecarPath);
  syncRenameDirectory(dir);
  report.sidecarsFolded++;
}

/** Fold one sidecar entry into its target markdown file's frontmatter. */
function foldEntry(dir: string, entry: IndexDocument, report: ContentMigrationReport): boolean {
  if (!entry.filename) {
    report.entriesSkipped++;
    return false;
  }
  const target = path.resolve(dir, entry.filename);
  const relative = path.relative(path.resolve(dir), target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    report.entriesSkipped++;
    return false;
  }
  let targetExists = true;
  try {
    fs.statSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    targetExists = false;
  }
  if (!targetExists || path.extname(target).toLowerCase() !== ".md") {
    report.entriesSkipped++;
    return false;
  }
  try {
    const realRelative = path.relative(fs.realpathSync(dir), fs.realpathSync(target));
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      report.entriesSkipped++;
      return false;
    }
    mutateFrontmatterAtomic(target, (parsed) => foldCuratedFields(parsed.data, entry));
    report.entriesFolded++;
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    report.entriesSkipped++;
    warn(`[akm] content-migration: could not fold entry into ${target}: ${errMsg(error)}`);
    return false;
  }
}

/** Merge the sidecar entry's curated fields onto the existing frontmatter (sidecar wins). */
function foldCuratedFields(existing: Record<string, unknown>, entry: IndexDocument): Record<string, unknown> {
  const next: Record<string, unknown> = { ...existing };
  const source = entry as unknown as Record<string, unknown>;
  for (const [field, fmKey] of CURATED_FIELD_MAP) {
    const value = source[field as string];
    if (value !== undefined) next[fmKey] = value;
  }
  return next;
}

function mutateFrontmatterAtomic(filePath: string, mutate: Parameters<typeof mutateFrontmatter>[1]): void {
  const directory = path.dirname(filePath);
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.akm-migrate-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  try {
    const mode = fs.statSync(filePath).mode & 0o777;
    fs.copyFileSync(filePath, temporary, fs.constants.COPYFILE_EXCL);
    mutateFrontmatter(temporary, mutate);
    writeFileAtomic(filePath, fs.readFileSync(temporary), mode);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function reservedConceptsInDir(root: string, dir: string): ReservedRename[] {
  const renames: ReservedRename[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return renames;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !RESERVED_BASENAMES.has(entry.name.toLowerCase())) continue;
    const filePath = path.join(dir, entry.name);
    const legacyType = legacyTypeForDirectory(root, dir);
    if (legacyType === "wiki") continue;
    if (!carriesAssetFrontmatter(filePath) && !(legacyType && isRelevantAssetFile(legacyType, entry.name))) continue;
    renames.push({ from: filePath, to: collisionSafeTarget(dir, entry.name) });
  }
  return renames;
}

export function planReservedRenameBatch(
  stashRoots: readonly string[],
  batchPath: string,
  operationId: string,
): ReservedRenameBatch {
  const entries: ReservedRename[] = [];
  for (const root of stashRoots.map((value) => path.resolve(value))) {
    for (const dir of collectDirs(root)) {
      entries.push(...reservedConceptsInDir(root, dir));
    }
  }
  const batch: ReservedRenameBatch = { formatVersion: 1, operationId, entries };
  fs.mkdirSync(path.dirname(batchPath), { recursive: true, mode: 0o700 });
  writeFileAtomic(batchPath, `${JSON.stringify(batch, null, 2)}\n`, 0o600);
  return batch;
}

export function loadReservedRenameBatch(batchPath: string, operationId: string): ReservedRenameBatch {
  const parsed = JSON.parse(fs.readFileSync(batchPath, "utf8")) as Partial<ReservedRenameBatch>;
  if (
    parsed.formatVersion !== 1 ||
    parsed.operationId !== operationId ||
    !Array.isArray(parsed.entries) ||
    parsed.entries.some((entry) => typeof entry?.from !== "string" || typeof entry.to !== "string")
  ) {
    throw new Error(`Invalid or foreign reserved rename batch: ${batchPath}`);
  }
  return parsed as ReservedRenameBatch;
}

function syncRenameDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP") throw error;
  } finally {
    fs.closeSync(fd);
  }
}

export function applyReservedRenameBatch(batch: ReservedRenameBatch, operationId: string): void {
  if (batch.formatVersion !== 1 || batch.operationId !== operationId) {
    throw new Error("Reserved rename batch does not belong to this migration operation.");
  }
  for (const entry of batch.entries) {
    const sourceExists = fs.existsSync(entry.from);
    const targetExists = fs.existsSync(entry.to);
    if (!sourceExists && targetExists) continue;
    if (!sourceExists) throw new Error(`Reserved rename source and target are missing: ${entry.from}`);
    if (targetExists) throw new Error(`Reserved rename target already exists: ${entry.to}`);
    fs.renameSync(entry.from, entry.to);
    syncRenameDirectory(path.dirname(entry.to));
  }
}

function legacyTypeForDirectory(root: string, dir: string): string | undefined {
  const [top] = path.relative(root, dir).split(path.sep);
  if (!top || top === "..") return undefined;
  const exact = Object.entries(TYPE_DIRS).find(([, typeDir]) => typeDir === top)?.[0];
  if (exact) return exact;
  const actualRoot = path.join(root, top);
  try {
    const actualIdentity = fs.realpathSync(actualRoot);
    return Object.entries(TYPE_DIRS).find(([, typeDir]) => {
      const canonicalRoot = path.join(root, typeDir);
      return fs.existsSync(canonicalRoot) && fs.realpathSync(canonicalRoot) === actualIdentity;
    })?.[0];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * True when a reserved-name file actually holds akm ASSET frontmatter (a
 * concept mis-placed under a reserved name), keyed on the D-R6 example markers
 * `description` / `when_to_use`. A structural listing/log block (no asset
 * frontmatter, e.g. only the bundle-root `okf_version`) returns false.
 */
function carriesAssetFrontmatter(filePath: string): boolean {
  const parsed = parseFrontmatter(fs.readFileSync(filePath, "utf8"));
  if (parsed.frontmatter === null) return false;
  const data = parsed.data;
  return !!(
    asNonEmptyString(data.description) ||
    asNonEmptyString(data.when_to_use) ||
    asNonEmptyString(data.whenToUse)
  );
}

/** `index.md` → `index-content.md`, then `index-content-2.md`, … on collision. */
function collisionSafeTarget(dir: string, basename: string): string {
  const stem = basename.slice(0, basename.length - ".md".length);
  let candidate = path.join(dir, `${stem}-content.md`);
  let suffix = 2;
  while (pathExists(candidate)) {
    candidate = path.join(dir, `${stem}-content-${suffix}.md`);
    suffix++;
  }
  return candidate;
}

function pathExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
