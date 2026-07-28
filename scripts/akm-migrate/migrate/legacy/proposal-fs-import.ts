// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * @removeIn 0.10.0
 *
 * One-time import of pre-0.9.0 filesystem proposals into the migrated state.db
 * `proposals` table (akm 0.9.0 Chunk-5 fold, completed in Chunk-8; plan §3.4).
 *
 * Before 0.9.0 the proposal queue lived as per-uuid JSON directories under
 * `<stashDir>/.akm/proposals/` (live) and `…/proposals/archive/` (archived).
 * This fold USED to run on EVERY proposal operation (through
 * `withProposalsDb`, guarded by a `proposal_fs_imports` ledger). That disk
 * probe is gone from the live path: the import now runs ONCE, as an ADDITIVE
 * filesystem step of `akm-migrate apply`'s `cutover-applied` phase — a sibling
 * of the `.stash.json`/D-R6 content migration — AFTER the committed state txn,
 * strict for operational failures and idempotent.
 *
 * Idempotency without the old ledger: each row lands through
 * {@link insertProposalIfAbsent} (INSERT OR IGNORE keyed on the proposal UUID),
 * so re-walking the still-on-disk legacy files on a resumed or re-run apply
 * inserts nothing new and never duplicates. The legacy files are never modified
 * or deleted — after import they are inert artifacts the operator can remove at
 * leisure. Legacy `backup.<ext>` files are inlined into `backupContent` so
 * `akm proposal revert` keeps working for proposals accepted before 0.9.0.
 *
 * Parsing and backup inlining retain the frozen pre-0.9.0 behavior from the
 * deleted `src/commands/proposal/legacy-import.ts`. Before insertion, refs are
 * translated through the frozen legacy grammar module so normal proposal
 * runtime boundaries remain new-grammar-only.
 *
 * Migrator-only: opens state.db through the raw storage engine (leaving its
 * journal mode untouched — the apply has already collapsed it to single-file
 * DELETE mode) and never sits on a live indexer or command path.
 */

import fs from "node:fs";
import path from "node:path";
import type { Proposal } from "../../../../src/commands/proposal/proposal-types";
import { parseBundleRef } from "../../../../src/core/asset/asset-ref";
import { warn } from "../../../../src/core/warn";
import { parseRegistryRef } from "../../../../src/registry/resolve";
import { type Database, openDatabase } from "../../../../src/storage/database";
import { classifyRefGrammar, legacyRefToBundleRef, parseAssetRef as parseLegacyAssetRef } from "../legacy-ref-grammar";

/** Legacy (pre-0.9.0) proposal directory: `<stashDir>/.akm/proposals[/archive]`. */
function legacyProposalsRoot(stashDir: string, archive: boolean): string {
  const root = path.join(stashDir, ".akm", "proposals");
  return archive ? path.join(root, "archive") : root;
}

/**
 * Shape of a legacy `proposal.json` file. Identical to {@link Proposal} except
 * that the pre-0.9.0 `backup` field held a path (relative to the proposal
 * directory) instead of the backup content itself.
 */
type LegacyProposalFile = Omit<Proposal, "backupContent"> & { backup?: string };

/**
 * Import every stash root's legacy `proposal.json` files into the state.db at
 * `stateDbPath`. Returns the total number of rows actually inserted (a re-run
 * over the same roots returns 0 after exact UUID verification). Malformed JSON
 * sources are retained and skipped; database and filesystem failures propagate.
 */
export interface LegacyProposalImportRoot {
  path: string;
  bundleId: string;
  legacyBundleId?: string;
  registryId?: string;
}

export function importLegacyProposalsIntoState(
  stateDbPath: string,
  stashRoots: readonly LegacyProposalImportRoot[],
): number {
  try {
    fs.statSync(stateDbPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`state.db not found for legacy proposal import: ${stateDbPath}`);
    }
    throw error;
  }
  const db: Database = openDatabase(stateDbPath);
  try {
    let imported = 0;
    const seen = new Set<string>();
    const canonicalBundleIds = new Set(stashRoots.map((root) => root.bundleId));
    const aliasCandidates = new Map<string, Set<string>>();
    const bundleRootCandidates = new Map<string, Set<string>>();
    const pathBundleCandidates = new Map<string, Set<string>>();
    const addAlias = (alias: string, bundleId: string) => {
      const candidates = aliasCandidates.get(alias) ?? new Set<string>();
      candidates.add(bundleId);
      aliasCandidates.set(alias, candidates);
    };
    for (const root of stashRoots) {
      const resolvedRoot = path.resolve(root.path);
      const roots = bundleRootCandidates.get(root.bundleId) ?? new Set<string>();
      roots.add(resolvedRoot);
      bundleRootCandidates.set(root.bundleId, roots);
      const pathBundles = pathBundleCandidates.get(resolvedRoot) ?? new Set<string>();
      pathBundles.add(root.bundleId);
      pathBundleCandidates.set(resolvedRoot, pathBundles);
      addAlias(root.bundleId, root.bundleId);
      if (root.legacyBundleId) addAlias(root.legacyBundleId, root.bundleId);
      if (root.registryId) {
        addAlias(root.registryId, root.bundleId);
        try {
          addAlias(parseRegistryRef(root.registryId).id, root.bundleId);
        } catch {
          // Preserve the exact alias above; malformed legacy locators stay unmapped.
        }
      }
      addAlias(resolvedRoot, root.bundleId);
    }
    const bundleRoots = new Map<string, string>();
    for (const [bundleId, roots] of bundleRootCandidates) {
      if (roots.size === 1) bundleRoots.set(bundleId, [...roots][0] as string);
    }
    const bundleAliases = new Map<string, string>();
    for (const bundleId of canonicalBundleIds) {
      if (bundleRoots.has(bundleId)) bundleAliases.set(bundleId, bundleId);
    }
    for (const [alias, candidates] of aliasCandidates) {
      if (canonicalBundleIds.has(alias) || candidates.size !== 1) continue;
      const bundleId = [...candidates][0] as string;
      if (bundleRoots.has(bundleId)) bundleAliases.set(alias, bundleId);
    }
    for (const root of stashRoots) {
      const resolved = path.resolve(root.path);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      const pathBundles = pathBundleCandidates.get(resolved);
      if (pathBundles?.size !== 1) {
        warn(`[akm] content-migration: skipping ambiguous legacy proposal root ${resolved}`);
        continue;
      }
      const bundleId = [...pathBundles][0] as string;
      imported += importLegacyProposalsForStash(db, { ...root, path: resolved, bundleId }, bundleAliases, bundleRoots);
    }
    return imported;
  } finally {
    db.close();
  }
}

/**
 * Import one stash root's legacy proposal directories (live + archive) into the
 * open state.db. Returns the number of rows inserted for this stash.
 */
function importLegacyProposalsForStash(
  db: Database,
  stash: LegacyProposalImportRoot,
  bundleAliases: ReadonlyMap<string, string>,
  bundleRoots: ReadonlyMap<string, string>,
): number {
  const stashDir = stash.path;
  const liveRoot = legacyProposalsRoot(stashDir, false);

  let imported = 0;
  for (const archive of [false, true]) {
    const root = legacyProposalsRoot(stashDir, archive);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "archive") continue;
      const proposalDir = path.join(root, entry.name);
      const proposal = readLegacyProposalFile(proposalDir, stash, bundleAliases, bundleRoots);
      if (!proposal) continue;
      if (insertProposalIfAbsent(db, proposal, stashDir)) imported += 1;
    }
  }

  if (imported > 0) {
    warn(`[akm] content-migration: imported ${imported} legacy proposal file(s) from ${liveRoot} into state.db`);
  }
  return imported;
}

function insertProposalIfAbsent(db: Database, proposal: Proposal, stashDir: string): boolean {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(proposal.id)) {
    throw new Error(`Legacy proposal ID is not a UUID: ${proposal.id}`);
  }
  const metadata: Record<string, unknown> = {
    changes: proposal.changes.map((change, index) => ({
      path: change.path,
      op: change.op,
      ...(index > 0 && change.after !== undefined ? { after: change.after } : {}),
    })),
  };
  for (const key of [
    "proposedTarget",
    "beforeHash",
    "sourceRun",
    "review",
    "confidence",
    "gateDecision",
    "backupContent",
    "acceptedTarget",
    "eligibilitySource",
  ] as const) {
    if (proposal[key] !== undefined) metadata[key] = proposal[key];
  }
  const row = {
    id: proposal.id,
    stash_dir: stashDir,
    ref: proposal.ref,
    status: proposal.status,
    source: proposal.source,
    created_at: proposal.createdAt,
    updated_at: proposal.updatedAt,
    content: proposal.payload.content,
    frontmatter_json: proposal.payload.frontmatter ? JSON.stringify(proposal.payload.frontmatter) : null,
    metadata_json: JSON.stringify(metadata),
  };
  const result = db
    .prepare(`
      INSERT OR IGNORE INTO proposals
        (id, stash_dir, ref, status, source, created_at, updated_at, content, frontmatter_json, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      row.id,
      row.stash_dir,
      row.ref,
      row.status,
      row.source,
      row.created_at,
      row.updated_at,
      row.content,
      row.frontmatter_json,
      row.metadata_json,
    );
  if (Number((result as { changes?: number | bigint }).changes ?? 0) > 0) return true;
  const existing = db
    .prepare(
      "SELECT stash_dir, ref, status, source, created_at, updated_at, content, frontmatter_json, metadata_json FROM proposals WHERE id = ?",
    )
    .get(row.id) as Omit<typeof row, "id"> | undefined;
  const expected = { ...row } as Partial<typeof row>;
  delete expected.id;
  if (!existing || JSON.stringify(existing) !== JSON.stringify(expected)) {
    throw new Error(`Legacy proposal UUID ${proposal.id} already exists with different content.`);
  }
  return false;
}

/**
 * Parse one legacy proposal directory into a {@link Proposal}, inlining the
 * backup file (when present) as `backupContent`. Returns undefined — with a
 * warning — when the `proposal.json` is missing, unreadable, or malformed, so
 * a single corrupt legacy entry never blocks the import of the rest.
 */
function readLegacyProposalFile(
  proposalDir: string,
  stash: LegacyProposalImportRoot,
  bundleAliases: ReadonlyMap<string, string>,
  bundleRoots: ReadonlyMap<string, string>,
): Proposal | undefined {
  const filePath = path.join(proposalDir, "proposal.json");
  let parsed: LegacyProposalFile;
  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    warn(`[akm] content-migration: skipping legacy proposal at ${filePath}: ${errMsg(error)}`);
    return undefined;
  }
  try {
    parsed = JSON.parse(source) as LegacyProposalFile;
  } catch (err) {
    warn(`[akm] content-migration: skipping legacy proposal at ${filePath}: ${errMsg(err)}`);
    return undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof parsed.id !== "string" ||
    typeof parsed.ref !== "string"
  ) {
    warn(`[akm] content-migration: skipping legacy proposal at ${filePath}: not a proposal object`);
    return undefined;
  }

  const { backup, ...rest } = parsed;
  let migratedRef = rest.ref;
  if (classifyRefGrammar(rest.ref) === "legacy") {
    try {
      const translated = legacyRefToBundleRef(rest.ref);
      const legacyOrigin = parseLegacyAssetRef(rest.ref).origin;
      const explicitOrigin = legacyOrigin !== undefined && legacyOrigin !== "local" && legacyOrigin !== "stash";
      let normalizedOrigin: string | undefined;
      if (explicitOrigin) {
        try {
          normalizedOrigin = parseRegistryRef(legacyOrigin).id;
        } catch {
          // It may be a bundle id or filesystem path rather than a locator.
        }
      }
      const bundle = explicitOrigin
        ? (bundleAliases.get(legacyOrigin) ??
          (normalizedOrigin ? bundleAliases.get(normalizedOrigin) : undefined) ??
          bundleAliases.get(path.resolve(legacyOrigin)))
        : translated.bundle
          ? bundleAliases.get(translated.bundle)
          : stash.bundleId;
      if (!bundle || !bundleRoots.has(bundle)) throw new Error(`unmapped legacy proposal origin: ${legacyOrigin}`);
      migratedRef = `${bundle}//${translated.conceptId}`;
    } catch (err) {
      warn(`[akm] content-migration: skipping legacy proposal at ${filePath}: ${errMsg(err)}`);
      return undefined;
    }
  } else {
    try {
      const translated = parseBundleRef(rest.ref);
      const bundle = translated.bundle ? bundleAliases.get(translated.bundle) : stash.bundleId;
      if (!bundle || !bundleRoots.has(bundle)) throw new Error(`unmapped proposal bundle: ${translated.bundle}`);
      migratedRef = `${bundle}//${translated.conceptId}`;
    } catch (err) {
      warn(`[akm] content-migration: skipping legacy proposal at ${filePath}: ${errMsg(err)}`);
      return undefined;
    }
  }
  let backupContent: string | undefined;
  if (typeof backup === "string" && backup.length > 0) {
    try {
      backupContent = fs.readFileSync(path.join(proposalDir, backup), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Backup file lost — import the proposal anyway; revert for it will
      // surface "no backup available", same as a new-asset proposal.
    }
  }

  return {
    ...rest,
    ref: migratedRef,
    payload: {
      content: rest.payload?.content ?? "",
      ...(rest.payload?.frontmatter ? { frontmatter: rest.payload.frontmatter } : {}),
    },
    changes:
      Array.isArray(rest.changes) && rest.changes.length > 0
        ? rest.changes
        : [{ path: "", after: rest.payload?.content ?? "", op: "update" }],
    createdAt: rest.createdAt ?? "",
    updatedAt: rest.updatedAt ?? rest.createdAt ?? "",
    status: rest.status ?? "pending",
    source: rest.source ?? "import",
    ...(backupContent !== undefined ? { backupContent } : {}),
  };
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
