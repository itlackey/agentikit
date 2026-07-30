// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm mv <ref> <new-name>` — rename an asset within its type directory
 * (SPEC-7, stash-conventions-code-spec.md).
 *
 * The stash organization conventions' forced-rename procedure ("grep and fix
 * inbound xrefs in the same pass") is agent-executable EXCEPT for the part
 * only the CLI can do: a rename mints a new `entries` row (entry_key is
 * UNIQUE), which orphans the utility_scores / utility_scores_scoped /
 * embeddings rows keyed by entry_id, detaches usage_events keyed by the old
 * entry_ref, and strands the state.db asset_salience / asset_outcome rows
 * keyed by `asset_ref` TEXT — the "rename resets learned ranking" cost the
 * conventions warn about. This verb does the whole pass: move the file,
 * rewrite inbound refs, re-key the index row IN PLACE (including the
 * usage_events entry_ref history), and re-key the state.db salience/outcome
 * rows so the accumulated history survives.
 *
 * Scope (v1, Experimental — see STABILITY.md):
 *   - flat-markdown asset types only ({@link MV_SUPPORTED_TYPES});
 *   - the primary writable stash only (no `--target`);
 *   - the source ref uses the current conceptId spelling; deterministic
 *     `.md`-suffixed aliases are canonicalized before anything is keyed off
 *     them, while lint-resolver fallback spellings are rejected with the canonical ref named (see
 *     {@link resolveMoveSourcePath});
 *   - a memory's `.derived.md` twin moves together and keeps its
 *     `entry_key === <base entry_key> + ".derived"` coupling; a twin ref
 *     cannot be moved alone, and target names ending `.derived` are rejected
 *     (reserved suffix).
 *
 * Ordering: the complete mutation holds the index-writer lease. After validation,
 * citer replacements are staged beside durable byte-for-byte backups and a small
 * phase journal under `getDataDir()/txn/`. Publication uses same-filesystem
 * renames; any synchronous failure restores every citer and asset rename. A later
 * invocation rolls back an interrupted prepared/applying journal before planning
 * another move. Derived index state remains fail-open and heals on a full index.
 * Graph tables (graph_files) key extractions by file path and stay stale
 * until the next graph pass — acceptable, the graph is a derived cache.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { defineJsonCommand, output } from "../cli/shared";
import { detectAdapterId } from "../core/adapter/detect-adapter";
import { deriveCanonicalAssetNameFromStashRoot, stashDirFor } from "../core/asset/asset-placement";
import { conceptIdFromTypeName, isFullRefInput, parseRefInput } from "../core/asset/resolve-ref";
import { isWithin, resolveStashDir, toPosix } from "../core/common";
import { loadConfig } from "../core/config/config";
import { ConfigError, UsageError } from "../core/errors";
import {
  _setTxnMutationHookForTests,
  advanceTxn,
  beginTxn,
  cleanupTxn,
  fsyncTxnFile,
  type JournaledFileChange,
  mintTxnId,
  recoverTxnsForRoot,
  registerTxnKind,
  type Txn,
  type TxnJournal,
  txnDirFor,
  txnMutationHook,
} from "../core/fs-txn";
import { getDbPath } from "../core/paths";
import { getStateDbPath, openStateDatabase } from "../core/state-db";
import { warnVerbose } from "../core/warn";
import { assertAkmAssetWrite } from "../core/write-source";
import { withAssetMutationLease } from "../indexer/index-writer-lock";
import { indexWrittenAssets, WRITE_PATH_INDEX_BUSY_TIMEOUT_MS } from "../indexer/index-written-assets";
import { resolveSourceEntries } from "../indexer/search/search-source";
import { insertEventOnce } from "../storage/repositories/events-repository";
import { closeDatabase, openExistingDatabase } from "../storage/repositories/index-connection";
import { rekeyEntryInPlace } from "../storage/repositories/index-entries-repository";
import { rebuildFts } from "../storage/repositories/index-fts-repository";
import {
  REF_BOUNDARY_PREFIX_CLASS_SRC,
  REF_SLUG_CHAR_CLASS_SRC,
  refToRelPath,
  resolveRefPathInStash,
} from "./lint/base-linter";

// ── Scope ─────────────────────────────────────────────────────────────────────

/**
 * Asset types `akm mv` can rename in v1: exactly the types whose canonical
 * layout is one flat `.md` file per name (the `markdownSpec` family), so a
 * rename is a single-file move and inbound refs are rewritable by complete-ref
 * matching. Deliberately excluded:
 *   - `skill` — the canonical layout is a multi-file `skills/<name>/SKILL.md`
 *     directory (a directory rename, out of v1 scope);
 *   - `script` — unresolvable by the slug resolver (contract-pinned);
 *   - `workflow` — workflows may live as `.yaml`/`.yml` programs
 *     (`WORKFLOW_EXTENSIONS`), and `workflowSpec.toAssetPath` resolves them
 *     by a cwd-relative existence probe with a `<name>.md` fallback — a mv
 *     would either rename a YAML program to `.md` (misclassifying it) or
 *     fail to resolve it from any cwd but the stash root. Out of v1 scope;
 *     rejected with a dedicated error naming the manual procedure;
 *   - `task` / `env` / `secret` — not markdown assets.
 */
const MV_SUPPORTED_TYPES: readonly string[] = ["memory", "knowledge", "command", "agent", "lesson", "session", "fact"];

// ── Ref rewriting ─────────────────────────────────────────────────────────────

/**
 * Boundary grammar IMPORTED from lint's `REF_RE` fragments (base-linter.ts
 * `REF_BOUNDARY_PREFIX_CLASS_SRC` / `REF_SLUG_CHAR_CLASS_SRC`) so the two
 * grammars cannot drift: a ref starts at line start or after whitespace /
 * backtick / quote / `(` / `[` / `,` (the `[` admits flow-style YAML lists
 * like `xrefs: [memories/foo]` and bracketed body refs; the `,` admits refs
 * after the first in a no-space flow list), and
 * its slug runs until
 * the first non-slug character. Complete-ref matching is what keeps a longer
 * ref sharing the old ref as a prefix (e.g. `memories/a/base-note-extra` when
 * moving `memories/a/base-note`) untouched.
 */
const REF_PREFIX_SRC = `(^|${REF_BOUNDARY_PREFIX_CLASS_SRC})`;
const REF_SUFFIX_SRC = `(?!${REF_SLUG_CHAR_CLASS_SRC})`;

/**
 * Parse `akm mv`'s target argument. The target may be a bare name
 * ("projectA/new-note") or a full new-grammar ref. Parsing the bare form
 * through the same ref grammar gives it identical name validation (traversal,
 * null bytes, absolute paths). A bare name's leading segment maps to no asset
 * type (`isFullRefInput` is false), so it is qualified with the source type's
 * conceptId prefix; a full new-grammar ref (`memories/x`) is parsed as-is.
 */
function parseMoveTarget(targetArg: string, sourceType: string): ReturnType<typeof parseRefInput> {
  return parseRefInput(isFullRefInput(targetArg) ? targetArg : conceptIdFromTypeName(sourceType, targetArg));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One deterministic rewrite pattern and the ref spelling its matches become. */
interface RewritePattern {
  re: RegExp;
  /** Replacement ref (`prefix` + this + `derivedTail`). */
  to: string;
}

/**
 * Build rewrite patterns for short and bundle-qualified current refs. The
 * optional `.derived` tail moves explicit memory-twin refs with their base.
 */
function buildRewritePatterns(
  fromConcept: string,
  toConcept: string,
  bundleId: string,
  includeDerivedTail: boolean,
): RewritePattern[] {
  const tail = includeDerivedTail ? "(\\.derived)?" : "()";
  const conceptCore = escapeRegExp(fromConcept);
  const qualifiedCore = escapeRegExp(`${bundleId}//${fromConcept}`);
  return [
    { re: new RegExp(`${REF_PREFIX_SRC}${conceptCore}${tail}${REF_SUFFIX_SRC}`, "gm"), to: toConcept },
    { re: new RegExp(`${REF_PREFIX_SRC}${conceptCore}${tail}\\.md${REF_SUFFIX_SRC}`, "gm"), to: toConcept },
    {
      re: new RegExp(`${REF_PREFIX_SRC}${qualifiedCore}${tail}${REF_SUFFIX_SRC}`, "gm"),
      to: `${bundleId}//${toConcept}`,
    },
    {
      re: new RegExp(`${REF_PREFIX_SRC}${qualifiedCore}${tail}\\.md${REF_SUFFIX_SRC}`, "gm"),
      to: `${bundleId}//${toConcept}`,
    },
  ];
}

/**
 * Everything {@link rewriteRefs} needs to rewrite one file's current ref
 * spellings.
 */
interface RewriteContext {
  patterns: RewritePattern[];
}

function buildRewriteContext(opts: {
  fromRef: string;
  toRef: string;
  bundleId: string;
  isBaseMemory: boolean;
}): RewriteContext {
  return {
    patterns: buildRewritePatterns(opts.fromRef, opts.toRef, opts.bundleId, opts.isBaseMemory),
  };
}

/**
 * Replace every occurrence of the moved ref, returning the count replaced.
 *
 * Runs at planning time before the rename.
 */
function rewriteRefs(content: string, ctx: RewriteContext): { content: string; count: number } {
  let count = 0;
  let next = content;
  for (const { re, to } of ctx.patterns) {
    next = next.replace(re, (_match, prefix: string, derivedTail: string | undefined) => {
      count += 1;
      return `${prefix}${to}${derivedTail ?? ""}`;
    });
  }
  return { content: next, count };
}

// ── File walking ──────────────────────────────────────────────────────────────

/**
 * Every ref-carrying file under `root`, recursively: all `.md` files, plus
 * `.yml`/`.yaml` files under the `tasks/` and `workflows/` type dirs — task
 * YAML legitimately carries refs in prompts and workflow YAML *programs*
 * carry refs in their step/instructions text, and lint's missing-ref body
 * scan covers both, so a rename must rewrite them like any other citer or
 * the scheduled task / workflow step dangles. (Workflows are CITERS only:
 * `workflow:` refs still cannot be MOVED — see {@link MV_SUPPORTED_TYPES}.)
 * Skips dot-directories (index state, `.cache/` mirrors) and `registry/`
 * caches — the same read-only carve-outs `akm lint --fix` honours
 * (lint/index.ts).
 */
function collectCiterFiles(root: string): string[] {
  const tasksRoot = path.join(root, stashDirFor("task") ?? "tasks");
  const workflowsRoot = path.join(root, stashDirFor("workflow") ?? "workflows");
  const results: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "registry") continue;
        walk(full);
      } else if (entry.isFile()) {
        if (entry.name.endsWith(".md")) {
          results.push(full);
        } else if (
          (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml")) &&
          (isWithin(full, tasksRoot) || isWithin(full, workflowsRoot))
        ) {
          results.push(full);
        }
      }
    }
  };
  walk(root);
  return results;
}

interface CiterRewritePlan {
  absPath: string;
  relPath: string;
  count: number;
  content: string;
  originalHash: string;
}

/**
 * Kind-owned payload of an `mv` transaction, riding the unified fs-txn
 * engine (WI-6.3). The envelope carries kind/phase/transactionId/root
 * (= the stash)/changes/decidedAt.
 */
interface MvTxnPayload {
  sourceName: string;
  sourceRoot: string;
  eventTs: string;
  eventMetadata: Record<string, unknown>;
  oldPath: string;
  newPath: string;
  twinOldPath: string | null;
  twinNewPath: string | null;
  sourceOriginalHash: string;
  expectedNewHash: string;
  twinOriginalHash: string | null;
  expectedTwinNewHash: string | null;
  type: string;
  oldName: string;
  newName: string;
  fromRef: string;
  toRef: string;
  citers: Array<{
    absPath: string;
    backupPath: string;
    stagedPath: string;
    ownedPath: string;
    mode: number;
    originalHash: string;
    replacementHash: string;
  }>;
}

type MvTxn = Txn<MvTxnPayload>;

const MV_TXN_KIND = "mv";
const MV_TXN_PHASES = [
  "prepared",
  "applying",
  "filesystem-committed",
  "index-finalized",
  "state-finalized",
  "event-finalized",
  "committed",
] as const;

/** TEST-ONLY crash-window hook used by subprocess recovery tests. */
export function _setMvMutationHookForTests(hook?: (point: string) => void): void {
  _setTxnMutationHookForTests(hook);
}

function hashContent(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function hashFile(filePath: string): string {
  return hashContent(fs.readFileSync(filePath));
}

function rollbackMoveJournal(journal: TxnJournal<MvTxnPayload>): void {
  const p = journal.payload;
  const restoreRename = (
    oldPath: string | null,
    newPath: string | null,
    originalHash: string | null,
    publishedHash: string | null,
  ): void => {
    if (!oldPath || !newPath || !fs.existsSync(newPath)) return;
    if (!publishedHash || hashFile(newPath) !== publishedHash) {
      throw new Error(`cannot roll back ${newPath}: published file diverged after the move`);
    }
    if (fs.existsSync(oldPath)) {
      if (hashFile(oldPath) !== publishedHash) {
        throw new Error(`cannot roll back ${newPath}: source path ${oldPath} is occupied by divergent content`);
      }
      fs.unlinkSync(newPath);
      return;
    }
    fs.linkSync(newPath, oldPath);
    fs.unlinkSync(newPath);
    if (originalHash && hashFile(oldPath) !== publishedHash) {
      throw new Error(`cannot verify rolled-back source ${oldPath}`);
    }
  };

  // Undo asset publication before restoring self-citing files at their old paths.
  restoreRename(p.oldPath, p.newPath, p.sourceOriginalHash, p.expectedNewHash);
  restoreRename(p.twinOldPath, p.twinNewPath, p.twinOriginalHash, p.expectedTwinNewHash);
  for (const [index, citer] of p.citers.entries()) {
    if (!fs.existsSync(citer.backupPath)) {
      throw new Error(`cannot restore ${citer.absPath}: backup is missing`);
    }
    const currentHash = fs.existsSync(citer.absPath) ? hashFile(citer.absPath) : null;
    if (fs.existsSync(citer.ownedPath)) {
      if (currentHash !== null && currentHash !== citer.replacementHash && currentHash !== citer.originalHash) {
        throw new Error(`cannot restore ${citer.absPath}: file diverged after exclusive ownership`);
      }
      if (currentHash === citer.replacementHash) fs.unlinkSync(citer.absPath);
      if (!fs.existsSync(citer.absPath)) fs.linkSync(citer.ownedPath, citer.absPath);
      continue;
    }
    if (currentHash === citer.originalHash) continue;
    if (currentHash !== citer.replacementHash) {
      throw new Error(`cannot restore ${citer.absPath}: file diverged after move planning`);
    }
    const restorePath = path.join(path.dirname(citer.backupPath), `restore-${index}`);
    fs.copyFileSync(citer.backupPath, restorePath);
    fs.chmodSync(restorePath, citer.mode);
    fs.renameSync(restorePath, citer.absPath);
  }
}

function validateCommittedMove(journal: TxnJournal<MvTxnPayload>): void {
  const p = journal.payload;
  if (fs.existsSync(p.oldPath) || !fs.existsSync(p.newPath)) {
    throw new Error(`Cannot finalize move: expected only committed target ${p.newPath}.`);
  }
  if (hashFile(p.newPath) !== p.expectedNewHash) {
    throw new Error(`Cannot finalize move: committed target ${p.newPath} diverged.`);
  }
  if (p.twinNewPath) {
    if (p.twinOldPath && fs.existsSync(p.twinOldPath)) {
      throw new Error(`Cannot finalize move: old twin ${p.twinOldPath} still exists.`);
    }
    if (!fs.existsSync(p.twinNewPath) || hashFile(p.twinNewPath) !== p.expectedTwinNewHash) {
      throw new Error(`Cannot finalize move: committed twin ${p.twinNewPath} diverged.`);
    }
  }
  for (const citer of p.citers) {
    if (citer.absPath === p.oldPath || citer.absPath === p.twinOldPath) continue;
    if (!fs.existsSync(citer.absPath) || hashFile(citer.absPath) !== citer.replacementHash) {
      throw new Error(`Cannot finalize move: citer ${citer.absPath} diverged.`);
    }
  }
}

/**
 * Kind-level safety fence for an `mv` journal (the engine fences root binding
 * and the uniform changes[] separately).
 */
function fenceMvTxnJournal(journal: TxnJournal<MvTxnPayload>, txnDir: string, root: string): void {
  const p = journal.payload;
  const hasCurrentIdentity =
    typeof p.sourceName === "string" &&
    p.sourceName.length > 0 &&
    typeof p.sourceRoot === "string" &&
    path.resolve(p.sourceRoot) === path.resolve(root) &&
    typeof p.type === "string" &&
    typeof p.oldName === "string" &&
    typeof p.newName === "string" &&
    typeof p.fromRef === "string" &&
    typeof p.toRef === "string" &&
    p.fromRef === conceptIdFromTypeName(p.type, p.oldName) &&
    p.toRef === conceptIdFromTypeName(p.type, p.newName);
  const stashPaths = [p.oldPath, p.newPath, p.twinOldPath, p.twinNewPath]
    .concat(p.citers.map((citer) => citer.absPath))
    .filter((candidate): candidate is string => candidate !== null);
  const transactionPaths = p.citers.flatMap((citer) => [citer.backupPath, citer.stagedPath, citer.ownedPath]);
  if (
    !hasCurrentIdentity ||
    stashPaths.some((candidate) => !isWithin(candidate, root)) ||
    transactionPaths.some((candidate) => !isWithin(candidate, txnDir))
  ) {
    throw new Error(`Refusing unsafe move recovery journal at ${path.join(txnDir, "journal.json")}.`);
  }
}

/**
 * Recover every interrupted `mv` transaction for `stashDir` (rolls back
 * pre-commit journals, rolls committed ones forward). A thin wrapper over the
 * unified engine's root recovery, kept exported for mv's own pre-flight.
 */
export async function recoverInterruptedMoveTransactions(stashDir: string): Promise<void> {
  await recoverTxnsForRoot(stashDir, (journal) => journal.kind === MV_TXN_KIND);
}

function applyMoveFilesystem(opts: {
  stashDir: string;
  oldPath: string;
  newPath: string;
  twinOldPath: string | null;
  twinNewPath: string | null;
  sourceOriginalHash: string;
  twinOriginalHash: string | null;
  type: string;
  oldName: string;
  newName: string;
  fromRef: string;
  toRef: string;
  sourceName: string;
  sourceRoot: string;
  eventMetadata: Record<string, unknown>;
  plans: CiterRewritePlan[];
}): MvTxn {
  // Mint the id first: the payload embeds sidecar paths under the transaction
  // dir, and the `prepared` journal must be written exactly once with its
  // final contents (crash runners intercept the first rename per phase).
  const transactionId = mintTxnId();
  const transactionDir = txnDirFor(opts.stashDir, transactionId);
  fs.mkdirSync(transactionDir, { recursive: true, mode: 0o700 });
  const journalPath = path.join(transactionDir, "journal.json");
  let txn: MvTxn | undefined;

  try {
    const citers = opts.plans.map((plan, index) => {
      const mode = fs.statSync(plan.absPath).mode;
      const backupPath = path.join(transactionDir, `backup-${index}`);
      const stagedPath = path.join(transactionDir, `staged-${index}`);
      const ownedPath = path.join(transactionDir, `owned-${index}`);
      if (hashFile(plan.absPath) !== plan.originalHash) {
        throw new Error(`refusing to stage divergent citer ${plan.absPath}`);
      }
      fs.copyFileSync(plan.absPath, backupPath);
      fs.chmodSync(backupPath, mode);
      fs.writeFileSync(stagedPath, plan.content, { encoding: "utf8", mode });
      fsyncTxnFile(backupPath);
      fsyncTxnFile(stagedPath);
      return {
        absPath: plan.absPath,
        backupPath,
        stagedPath,
        ownedPath,
        mode,
        originalHash: plan.originalHash,
        replacementHash: hashContent(plan.content),
      };
    });

    if (hashFile(opts.oldPath) !== opts.sourceOriginalHash) throw new Error(`source ${opts.oldPath} diverged`);
    if (opts.twinOldPath && opts.twinOriginalHash && hashFile(opts.twinOldPath) !== opts.twinOriginalHash) {
      throw new Error(`twin ${opts.twinOldPath} diverged`);
    }
    const sourceCiter = citers.find((citer) => citer.absPath === opts.oldPath);
    const twinCiter = citers.find((citer) => citer.absPath === opts.twinOldPath);

    const payload: MvTxnPayload = {
      sourceName: opts.sourceName,
      sourceRoot: opts.sourceRoot,
      eventTs: new Date().toISOString(),
      eventMetadata: opts.eventMetadata,
      oldPath: opts.oldPath,
      newPath: opts.newPath,
      twinOldPath: opts.twinOldPath,
      twinNewPath: opts.twinNewPath,
      sourceOriginalHash: opts.sourceOriginalHash,
      expectedNewHash: sourceCiter?.replacementHash ?? opts.sourceOriginalHash,
      twinOriginalHash: opts.twinOriginalHash,
      expectedTwinNewHash: twinCiter?.replacementHash ?? opts.twinOriginalHash,
      type: opts.type,
      oldName: opts.oldName,
      newName: opts.newName,
      fromRef: opts.fromRef,
      toRef: opts.toRef,
      citers,
    };
    const expectedNewHash = payload.expectedNewHash;
    txn = beginTxn<MvTxnPayload>({
      kind: MV_TXN_KIND,
      root: opts.stashDir,
      transactionId,
      changes: [
        { path: opts.newPath, op: "create", beforeHash: null, afterHash: expectedNewHash },
        { path: opts.oldPath, op: "delete", beforeHash: opts.sourceOriginalHash, afterHash: null },
        ...(opts.twinOldPath && opts.twinNewPath
          ? ([
              { path: opts.twinNewPath, op: "create", beforeHash: null, afterHash: payload.expectedTwinNewHash },
              { path: opts.twinOldPath, op: "delete", beforeHash: opts.twinOriginalHash, afterHash: null },
            ] as JournaledFileChange[])
          : []),
        ...citers
          .filter((citer) => citer.absPath !== opts.oldPath && citer.absPath !== opts.twinOldPath)
          .map(
            (citer): JournaledFileChange => ({
              path: citer.absPath,
              op: "update",
              beforeHash: citer.originalHash,
              afterHash: citer.replacementHash,
            }),
          ),
      ],
      payload,
      decidedAt: payload.eventTs,
    });
    advanceTxn(txn, "applying");

    for (const citer of citers) {
      fs.renameSync(citer.absPath, citer.ownedPath);
      if (hashFile(citer.ownedPath) !== citer.originalHash) {
        if (!fs.existsSync(citer.absPath)) fs.linkSync(citer.ownedPath, citer.absPath);
        throw new Error(`refusing to replace divergent citer ${citer.absPath}`);
      }
      try {
        fs.linkSync(citer.stagedPath, citer.absPath);
        fs.unlinkSync(citer.stagedPath);
      } catch (error) {
        if (!fs.existsSync(citer.absPath)) fs.linkSync(citer.ownedPath, citer.absPath);
        throw error;
      }
    }
    if (hashFile(opts.oldPath) !== payload.expectedNewHash) throw new Error(`source ${opts.oldPath} diverged`);
    fs.linkSync(opts.oldPath, opts.newPath);
    fs.unlinkSync(opts.oldPath);
    if (opts.twinOldPath && opts.twinNewPath) {
      if (hashFile(opts.twinOldPath) !== payload.expectedTwinNewHash)
        throw new Error(`twin ${opts.twinOldPath} diverged`);
      fs.linkSync(opts.twinOldPath, opts.twinNewPath);
      fs.unlinkSync(opts.twinOldPath);
    }

    advanceTxn(txn, "filesystem-committed");
    return txn;
  } catch (error) {
    if (txn) {
      try {
        rollbackMoveJournal(txn.journal);
        cleanupTxn(transactionDir);
      } catch (rollbackError) {
        throw new Error(
          `Move failed (${error instanceof Error ? error.message : String(error)}) and rollback failed ` +
            `(${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}). ` +
            `Recovery journal retained at ${journalPath}.`,
        );
      }
    } else {
      cleanupTxn(transactionDir);
    }
    throw error;
  }
}

// ── Source resolution ─────────────────────────────────────────────────────────

/**
 * Return the ON-DISK casing of `relPath` under `root` as a posix-separated
 * relative path, or `null` when a segment cannot be found (file deleted
 * mid-flight, unreadable directory — callers treat null as "unverifiable"
 * and keep the `existsSync` verdict).
 *
 * The casing guard for {@link resolveMoveSourcePath}: on a case-INSENSITIVE
 * filesystem (macOS/Windows defaults) `existsSync` matches a wrong-case
 * spelling and `resolveRefPathInStash` returns the user-cased join verbatim,
 * so a byte-comparison of the resolved path against the ref-derived path
 * compares the string against itself. This helper reads each path segment's
 * true name from its parent's directory listing instead — deliberately NOT
 * `fs.realpathSync.native`, which also resolves symlinks and would
 * false-mismatch a stash root reached through one (e.g. /tmp on macOS).
 * Matching is byte-first, then Unicode-lowercase — an approximation of the
 * filesystem's own case folding that can only miss toward `null`
 * (unverifiable), never toward a wrong entry.
 */
export function deriveOnDiskCasedRelPath(root: string, relPath: string): string | null {
  const segments = toPosix(relPath).split("/").filter(Boolean);
  const cased: string[] = [];
  let dir = root;
  for (const segment of segments) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return null;
    }
    const onDisk = entries.includes(segment)
      ? segment
      : entries.find((entry) => entry.toLowerCase() === segment.toLowerCase());
    if (onDisk === undefined) return null;
    cased.push(onDisk);
    dir = path.join(dir, onDisk);
  }
  return cased.join("/");
}

/**
 * Resolve the on-disk file for the ref being moved, within the primary
 * writable stash ONLY. Reuses lint's shared resolver (`resolveRefPathInStash`,
 * base-linter.ts — do not fork a second resolver), then requires the hit to
 * be CANONICAL: the resolved file must be exactly `<stashDir>/<relPath>`, the
 * path the ref's spelling maps to.
 *
 * Lint's resolver accepts fallback spellings on purpose (a knowledge-subdir
 * basename for `knowledge/guides/g.md`, a refName encoding a
 * full stash-relative path, a base memory ref satisfied by its `.derived.md`
 * twin, a `SKILL.md` directory primary) — fine for existence checks, fatal
 * for a move: the citer rewrite targets the typed spelling (canonical citers
 * would dangle), the index re-key derives its old entry_key from the typed
 * spelling (the real row would be stranded as a ghost and a duplicate row
 * minted — the exact utility-history reset `mv` exists to prevent), and the
 * direct-path fallback would even RELOCATE the file out of its real home into
 * the type root. So:
 *   - `null` — the ref does not resolve at all (also for a base memory ref
 *     whose only on-disk presence is the `.derived.md` twin: the base file is
 *     what `mv` renames — the twin is carried along, never moved alone —
 *     and for a `SKILL.md` directory primary, out of v1 scope);
 *   - throws `UsageError` (exit 2) — the ref resolves ONLY via a fallback
 *     spelling; the message names the canonical ref when one is derivable.
 */
function resolveMoveSourcePath(stashDir: string, relPath: string, refType: string, refName: string): string | null {
  const resolved = resolveRefPathInStash(relPath, refType, refName, stashDir);
  if (!resolved) return null;
  if (resolved.endsWith(".derived.md") && !refName.endsWith(".derived")) return null;
  if (path.basename(resolved) === "SKILL.md" && !relPath.endsWith(`${path.sep}SKILL.md`)) return null;
  // The byte-equal comparison below cannot catch a case alias: on a
  // case-insensitive filesystem the resolver's `existsSync` matches
  // `memories/Foo` against memories/foo.md and returns the user-cased join, so
  // the comparison checks the string against itself. Every downstream key is
  // case-sensitive regardless of the filesystem (the citer rewrite matches
  // bytes, the index entry_key is BINARY-collated, state.db asset_ref
  // likewise), so a wrong-case source must be rejected like any other
  // fallback spelling: verify the ON-DISK casing and, on mismatch, fall
  // through to the rejection below with the true-cased path so the error
  // names the canonical ref.
  let onDiskResolved = resolved;
  if (path.resolve(resolved) === path.resolve(stashDir, relPath)) {
    const onDiskRelPath = deriveOnDiskCasedRelPath(stashDir, relPath);
    if (onDiskRelPath === null || onDiskRelPath === toPosix(relPath)) return resolved;
    onDiskResolved = path.join(stashDir, onDiskRelPath);
  }

  // Fallback hit — reject, steering to the canonical spelling when it exists.
  const typedRef = conceptIdFromTypeName(refType, refName);
  const canonicalName = deriveCanonicalAssetNameFromStashRoot(refType, stashDir, onDiskResolved);
  const canonicalRelPath = canonicalName ? refToRelPath(refType, canonicalName) : null;
  if (
    canonicalName &&
    canonicalName !== refName &&
    canonicalRelPath &&
    path.resolve(stashDir, canonicalRelPath) === path.resolve(onDiskResolved)
  ) {
    const canonicalRef = conceptIdFromTypeName(refType, canonicalName);
    throw new UsageError(
      `"${typedRef}" resolves only through a fallback spelling — the asset's canonical ref is ${canonicalRef}. ` +
        "akm mv needs the canonical spelling so the citer rewrite and the index re-key target the same ref — nothing moved.",
      "INVALID_FLAG_VALUE",
      `Re-run with the canonical ref: akm mv ${canonicalRef} <new-name>.`,
    );
  }
  throw new UsageError(
    `"${typedRef}" resolves to ${toPosix(path.relative(stashDir, onDiskResolved))}, outside the ${stashDirFor(refType)}/ ` +
      "type root — akm mv renames within a type directory only; nothing moved.",
    "INVALID_FLAG_VALUE",
  );
}

// ── Index re-key ──────────────────────────────────────────────────────────────

/**
 * Re-key the moved row(s) in the local index, preserving row ids (and with
 * them the utility/embedding/salience history). FAIL-OPEN like every
 * write-path index touch: an absent index.db is skipped silently (the next
 * full `akm index` picks the renamed file up fresh), and any error reduces
 * to a verbose warning — the rename itself has already succeeded.
 *
 * The returned flag is the `utilityPreserved` claim in the command's output,
 * so it must be honest:
 *   - true — no index exists, the file was never indexed (nothing to
 *     preserve; the next `akm index` picks it up fresh), or the row(s) were
 *     re-keyed in place;
 *   - false — an existing index could not be re-keyed (open/SQL error), or a
 *     row for the moved file exists under some OTHER entry_key than the one
 *     the canonical spelling derives (e.g. a differently-normalized stash
 *     path at index time): that history is now stranded on a ghost row and
 *     will NOT survive the next index run.
 *
 * When `preserved` is false, `warning` carries the reason for the command's
 * JSON report — a re-key failure must be user-visible, not verbose-only.
 */
function rekeyIndexForMove(opts: {
  stashDir: string;
  type: string;
  oldName: string;
  newName: string;
  oldPath: string;
  newPath: string;
  fromRef: string;
  toRef: string;
  twinOldPath: string | null;
  twinNewPath: string | null;
  sourceName: string;
  sourceRoot: string;
}): { complete: boolean; preserved: boolean; warning: string | null } {
  const dbPath = getDbPath();
  try {
    if (!fs.existsSync(dbPath)) return { complete: true, preserved: true, warning: null };
    let preserved = true;
    const db = openExistingDatabase(dbPath);
    try {
      db.exec(`PRAGMA busy_timeout = ${WRITE_PATH_INDEX_BUSY_TIMEOUT_MS}`);
      // A null re-key means "no row under the expected old key". That is fine
      // when the file was simply never indexed, but a lie if a row for the
      // file DOES exist under another key — then history is stranded.
      const strandedRow = (movedFrom: string): boolean =>
        db.prepare("SELECT id FROM entries WHERE file_path = ? LIMIT 1").get(movedFrom) != null;
      const oldKey = `${opts.stashDir}:${opts.type}:${opts.oldName}`;
      const newKey = `${opts.stashDir}:${opts.type}:${opts.newName}`;
      const alreadyRekeyed =
        db.prepare("SELECT id FROM entries WHERE entry_key = ? AND file_path = ? LIMIT 1").get(newKey, opts.newPath) !=
        null;
      const rekeyed = rekeyEntryInPlace(db, {
        oldEntryKey: oldKey,
        newEntryKey: newKey,
        newName: opts.newName,
        newFilePath: opts.newPath,
        oldRef: opts.fromRef,
        newRef: opts.toRef,
        sourceName: opts.sourceName,
        sourceRoot: opts.sourceRoot,
      });
      if (rekeyed === null && !alreadyRekeyed && strandedRow(opts.oldPath)) preserved = false;
      let twinRekeyed: number | null = null;
      if (opts.twinNewPath) {
        // The twin coupling (db.ts getBaseBeliefStatesForDerivedTwins) is
        // `twin entry_key === base entry_key + ".derived"` — preserved here.
        const twinAlreadyRekeyed =
          db
            .prepare("SELECT id FROM entries WHERE entry_key = ? AND file_path = ? LIMIT 1")
            .get(`${newKey}.derived`, opts.twinNewPath) != null;
        twinRekeyed = rekeyEntryInPlace(db, {
          oldEntryKey: `${oldKey}.derived`,
          newEntryKey: `${newKey}.derived`,
          newName: `${opts.newName}.derived`,
          newFilePath: opts.twinNewPath,
          oldRef: `${opts.fromRef}.derived`,
          newRef: `${opts.toRef}.derived`,
          newDerivedFrom: opts.toRef,
          sourceName: opts.sourceName,
          sourceRoot: opts.sourceRoot,
        });
        if (twinRekeyed === null && !twinAlreadyRekeyed && opts.twinOldPath && strandedRow(opts.twinOldPath)) {
          preserved = false;
        }
      }
      if (rekeyed !== null || twinRekeyed !== null) {
        rebuildFts(db, { incremental: true });
      }
      txnMutationHook("index-rekeyed");
    } finally {
      closeDatabase(db);
    }
    if (!preserved) {
      const warning =
        "index re-key skipped: the index holds a row for the moved file under an unexpected key — its utility " +
        "history was not re-keyed and resets on the next `akm index`.";
      warnVerbose(`akm mv: ${warning}`);
      return { complete: false, preserved: false, warning };
    }
    return { complete: true, preserved: true, warning: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const warning =
      `index re-key failed (${message}) — the rename itself succeeded and the index heals on the next ` +
      "`akm index`, but the asset's utility history was NOT re-keyed and resets on that run.";
    warnVerbose(`akm mv: ${warning}`);
    return { complete: false, preserved: false, warning };
  }
}

/**
 * Re-key the state.db `asset_salience` / `asset_outcome` rows after a rename.
 *
 * Both tables are keyed by `asset_ref` TEXT (the qualified item ref, not
 * entry_id; see core/state/migrations.ts 009/010), so
 * the salience boost `loadSalienceRankScores` applies at search time and the
 * outcome-loop history would otherwise strand on the old ref until the next
 * improve run re-mints a type-weight stub row — losing a distill-written
 * content-derived `encoding_salience` for good.
 *
 * Collision policy (conservative): a row already sitting at the NEW ref can
 * only be an orphan of a previously deleted asset — the caller has verified
 * no file exists at the target — so the LIVE asset's history wins: the
 * orphan row is deleted and the moved asset's row re-keyed onto the ref.
 *
 * No state.db means the improve loop never ran and is complete as a no-op.
 * Other failures retain the
 * committed move journal and block completion so a later mutation retries the
 * non-regenerable state update rather than silently stranding it.
 */
function rekeyStateDbForMove(
  fromRef: string,
  toRef: string,
  includeTwin: boolean,
  sourceName: string,
): { complete: boolean; warning: string | null } {
  const statePath = getStateDbPath();
  try {
    if (!fs.existsSync(statePath)) return { complete: true, warning: null };
    if (!sourceName) return { complete: false, warning: "move source identity is unavailable" };
    const pairs: Array<[string, string]> = [[`${sourceName}//${fromRef}`, `${sourceName}//${toRef}`]];
    if (includeTwin) pairs.push([`${sourceName}//${fromRef}.derived`, `${sourceName}//${toRef}.derived`]);
    const db = openStateDatabase();
    const tableFailures: string[] = [];
    try {
      db.exec(`PRAGMA busy_timeout = ${WRITE_PATH_INDEX_BUSY_TIMEOUT_MS}`);
      for (const table of ["asset_salience", "asset_outcome"] as const) {
        try {
          db.transaction(() => {
            for (const [oldRef, newRef] of pairs) {
              const moved = db.prepare(`SELECT asset_ref FROM ${table} WHERE asset_ref = ?`).get(oldRef);
              if (!moved) continue;
              db.prepare(`DELETE FROM ${table} WHERE asset_ref = ?`).run(newRef);
              db.prepare(`UPDATE ${table} SET asset_ref = ? WHERE asset_ref = ?`).run(newRef, oldRef);
            }
          })();
          txnMutationHook(`state-${table}-rekeyed`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          tableFailures.push(`${table}: ${message}`);
        }
      }
    } finally {
      db.close();
    }
    if (tableFailures.length > 0) {
      const warning =
        `state.db salience re-key failed (${tableFailures.join("; ")}) — the rename itself succeeded, but the ` +
        "asset's salience/outcome history stays keyed to the old ref until the next improve run re-mints it.";
      warnVerbose(`akm mv: ${warning}`);
      return { complete: false, warning };
    }
    return { complete: true, warning: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const warning =
      `state.db salience re-key failed (${message}) — the rename itself succeeded, but the asset's salience/` +
      "outcome history stays keyed to the old ref until the next improve run re-mints it.";
    warnVerbose(`akm mv: ${warning}`);
    return { complete: false, warning };
  }
}

function persistMoveEvent(journal: TxnJournal<MvTxnPayload>): void {
  const p = journal.payload;
  const db = openStateDatabase();
  try {
    db.transaction(() => {
      insertEventOnce(db, {
        eventType: "mv",
        ts: p.eventTs,
        ref: `${p.sourceName}//${p.toRef}`,
        metadata: {
          ...p.eventMetadata,
          from: `${p.sourceName}//${p.fromRef}`,
          to: `${p.sourceName}//${p.toRef}`,
          mutationTransactionId: journal.transactionId,
        },
        idempotencyKey: journal.transactionId,
        idempotencyMetadataKey: "mutationTransactionId",
      });
    })();
  } finally {
    db.close();
  }
}

async function finalizeMoveTransaction(txn: MvTxn): Promise<{
  utilityPreserved: boolean;
  warnings: string[];
}> {
  const { journal } = txn;
  const p = journal.payload;
  validateCommittedMove(journal);
  const warnings: string[] = [];
  let utilityPreserved = true;
  // The journal envelope's root IS the stash the move mutates.
  const stashDir = journal.root;
  if (journal.phase === "filesystem-committed") {
    const indexResult = rekeyIndexForMove({
      stashDir,
      type: p.type,
      oldName: p.oldName,
      newName: p.newName,
      oldPath: p.oldPath,
      newPath: p.newPath,
      fromRef: p.fromRef,
      toRef: p.toRef,
      twinOldPath: p.twinOldPath,
      twinNewPath: p.twinNewPath,
      sourceName: p.sourceName,
      sourceRoot: p.sourceRoot,
    });
    utilityPreserved = indexResult.preserved;
    if (indexResult.warning) warnings.push(indexResult.warning);
    if (!indexResult.complete) throw new Error(indexResult.warning ?? "move index re-key did not complete");
    const touched = new Set<string>([p.newPath]);
    if (p.twinNewPath) touched.add(p.twinNewPath);
    for (const citer of p.citers) {
      if (citer.absPath === p.oldPath || citer.absPath === p.twinOldPath) continue;
      touched.add(citer.absPath);
    }
    if (!(await indexWrittenAssets(stashDir, [...touched], { recoverMoves: false, bundleId: p.sourceName }))) {
      utilityPreserved = false;
      warnings.push("write-path index refresh failed; the derived index will heal on the next full index");
    }
    advanceTxn(txn, "index-finalized");
  }
  if (journal.phase === "index-finalized") {
    const stateResult = rekeyStateDbForMove(p.fromRef, p.toRef, p.twinNewPath !== null, p.sourceName);
    if (stateResult.warning) warnings.push(stateResult.warning);
    if (!stateResult.complete) throw new Error(stateResult.warning ?? "move state finalization did not complete");
    advanceTxn(txn, "state-finalized");
  }
  if (journal.phase === "state-finalized") {
    persistMoveEvent(journal);
    txnMutationHook("mv-event-persisted");
    advanceTxn(txn, "event-finalized");
  }
  if (journal.phase === "event-finalized") advanceTxn(txn, "committed");
  return { utilityPreserved, warnings };
}

/**
 * Durable source identity used when the working stash has no configured bundle
 * owner — the spelling stored rows carried before 0.9.0's bundle map existed.
 */
const DEFAULT_MOVE_SOURCE_NAME = "stash";

/**
 * Refuse a move into a source the user protected with `writable: false`, and
 * assert adapter compatibility.
 *
 * `assertAkmAssetWrite` checks only the ADAPTER, so on its own it let `mv`
 * rename files inside a read-only bundle that every other write command
 * refuses. `SearchSource.writable` is already the EFFECTIVE policy (post
 * `resolveWritable`), so it is read directly. Both checks run before recovery
 * or any filesystem mutation.
 */
function assertMoveTargetWritable(
  sourceOwner: ReturnType<typeof resolveSourceEntries>[number] | undefined,
  stashDir: string,
  defaultBundle: string | undefined,
): void {
  const ownerName = sourceOwner?.registryId ?? defaultBundle ?? DEFAULT_MOVE_SOURCE_NAME;
  assertAkmAssetWrite({
    kind: sourceOwner?.type ?? "filesystem",
    name: ownerName,
    path: stashDir,
    adapterId: sourceOwner?.adapterId ?? detectAdapterId(stashDir),
  });
  if (sourceOwner?.writable === false) {
    throw new ConfigError(
      `Bundle "${ownerName}" is not writable, so \`akm mv\` cannot rename assets in it — nothing moved.`,
      "INVALID_CONFIG_FILE",
      "Set `writable: true` on the bundle in your config, or move the asset in a writable stash.",
    );
  }
}

/**
 * Resolve the move's durable source identity from the configured bundle that
 * owns the primary stash, falling back to {@link DEFAULT_MOVE_SOURCE_NAME} for
 * an explicit working-stash override.
 */
function resolveMoveSourceIdentity(
  configuredSources: ReturnType<typeof resolveSourceEntries>,
  stashDir: string,
  defaultBundle?: string,
): string {
  const primarySource = configuredSources.find((entry) => path.resolve(entry.path) === path.resolve(stashDir));
  // An explicit `AKM_BUNDLE_DIR` override is a supported CI/scripting entry
  // point, and `resolveSourceEntries` surfaces it as an identity-less source.
  // Throwing here would break every `mv` under the override; fall back to the
  // durable name the pre-0.9.0 implementation used so stored rows keep the
  // same identity they had before.
  return primarySource?.registryId ?? defaultBundle ?? DEFAULT_MOVE_SOURCE_NAME;
}

// ── Command ───────────────────────────────────────────────────────────────────

export const mvCommand = defineJsonCommand({
  meta: {
    name: "mv",
    description:
      "Rename an asset within its type directory (Experimental). Moves the file (a memory's .derived.md twin " +
      "moves together), rewrites inbound refs across the writable stash in the same pass — body prose, " +
      "frontmatter ref lists (xrefs/refs/supersededBy/...), fenced code examples, task .yml files under tasks/, " +
      "workflow .yaml/.yml programs under workflows/, and .md-suffixed spellings of the same asset — and re-keys the " +
      "search-index row in place (including its usage-event history) plus the state.db salience/outcome rows, " +
      "so the asset's accumulated usage-ranking history survives the rename. Read-only sources are scanned but " +
      "never written; their citing files are reported in `readOnlyCiters` as manual follow-ups. Operates on the " +
      "primary writable stash only. The source ref (and target name) may carry the .md-suffixed alias " +
      "spelling — both are canonicalized — but resolver-fallback source spellings are rejected, naming the " +
      "canonical ref. Workflow " +
      "refs cannot be MOVED in v1 (workflows may be .yaml programs — rename the file manually and verify with " +
      "`akm lint`), though workflow files ARE rewritten as citers.",
  },
  args: {
    ref: {
      type: "positional",
      description: "Current asset ref (required), e.g. memories/projectA/old-note",
      // Optional in citty so run() is invoked even when omitted; re-validated
      // below to surface a structured UsageError (exit 2) instead of citty's
      // unstructured missing-argument failure. The "(required)" note in the
      // description keeps the rendered help honest about that contract.
      required: false,
    },
    newName: {
      type: "positional",
      description:
        "New name (required; subdirectories allowed, e.g. projectA/new-note), or a same-type ref like memories/new-note",
      required: false,
    },
  },
  async run({ args }) {
    const refArg = typeof args.ref === "string" ? args.ref.trim() : "";
    const targetArg = typeof args.newName === "string" ? args.newName.trim() : "";
    if (!refArg || !targetArg) {
      throw new UsageError(
        "Usage: akm mv <ref> <new-name>.",
        "MISSING_REQUIRED_ARGUMENT",
        "Pass the asset's current ref and its new name, e.g. `akm mv memories/projectA/old-note projectA/new-note`.",
      );
    }

    await withAssetMutationLease("mv", async () => {
      // ── Validation (everything before any write; a failure moves nothing) ──
      const source = parseRefInput(refArg);
      if (source.origin) {
        throw new UsageError(
          `akm mv operates on the primary writable stash only — the origin prefix "${source.origin}//" is not supported.`,
          "INVALID_FLAG_VALUE",
        );
      }
      if (source.type === "workflow") {
        throw new UsageError(
          "akm mv does not support workflow refs in v1 — workflows may live as .yaml/.yml programs, which the " +
            "flat-markdown rename path would misresolve or rename to .md. Rename the file manually under " +
            "workflows/ (keeping its extension), fix inbound refs in the same pass, and verify with `akm lint`.",
          "INVALID_FLAG_VALUE",
        );
      }
      if (!MV_SUPPORTED_TYPES.includes(source.type)) {
        throw new UsageError(
          `akm mv supports flat-markdown asset types (${MV_SUPPORTED_TYPES.join(", ")}); "${source.type}" refs cannot be moved.`,
          "INVALID_FLAG_VALUE",
        );
      }
      // The `.derived` suffix is the distilled-twin marker: a twin's entry_key
      // must stay exactly `<base entry_key>.derived` (db.ts
      // getBaseBeliefStatesForDerivedTwins), so a twin can never move alone and
      // no independent asset may squat on the suffix. The `.md`-suffixed alias
      // spelling of a twin ref names the same file, so it is caught here too.
      if (source.type === "memory" && /\.derived(\.md)?$/.test(source.name)) {
        const baseRef = `memories/${source.name.replace(/\.derived(\.md)?$/, "")}`;
        throw new UsageError(
          `"${conceptIdFromTypeName(source.type, source.name)}" names a .derived.md distilled twin — a twin ` +
            "cannot be moved on its own without breaking its belief-inheritance coupling to the base memory. " +
            `Rename the base ref instead (akm mv ${baseRef} <new-name>); the twin moves with it.`,
          "INVALID_FLAG_VALUE",
        );
      }

      const target = parseMoveTarget(targetArg, source.type);
      if (target.origin) {
        throw new UsageError(
          `The target must be a name within the ${source.type} type — origin prefixes are not supported.`,
          "INVALID_FLAG_VALUE",
        );
      }
      if (target.type !== source.type) {
        throw new UsageError(
          `Cross-type move is not supported: "${conceptIdFromTypeName(source.type, source.name)}" is a ` +
            `${source.type} asset but the target names the ${target.type} type. akm mv renames within one asset type.`,
          "INVALID_FLAG_VALUE",
        );
      }
      // Accept the `.md`-suffixed alias spelling of the TARGET, but operate on
      // the canonical extensionless name: every MV_SUPPORTED_TYPES layout is
      // the markdownSpec family, whose `toAssetPath` writes `<name>.md` either
      // way — so `bar.md` names the same file as `bar`, while a `bar.md`-keyed
      // toRef/entry_key would rewrite citers to a non-canonical ref and strand
      // the re-keyed history behind a row the write-path index pass (which
      // derives the canonical name `bar` from the file) immediately duplicates.
      const newName = target.name.endsWith(".md") ? target.name.slice(0, -".md".length) : target.name;
      if (!newName) {
        throw new UsageError(
          `Target "${targetArg}" names no asset once the .md extension is stripped — nothing moved.`,
          "INVALID_FLAG_VALUE",
        );
      }
      // Reject empty path segments: `path.posix.normalize` (the ref parser's
      // name normalization) PRESERVES a trailing slash — "bar/" (and "bar\",
      // normalized to it) sails through the traversal checks, and the file
      // would land at e.g. memories/bar/.md: a dot-prefixed file the index
      // walker skips, unreachable by `akm show`, with every citer rewritten to
      // the phantom ref "memories/bar/". Interior doubles ("a//b") are collapsed
      // by the normalization, so a trailing empty segment is the only shape
      // that reaches this check — but reject ANY empty segment regardless.
      if (newName.split("/").some((segment) => segment.length === 0)) {
        throw new UsageError(
          `Target "${targetArg}" contains an empty path segment (trailing "/" or "\\") — the file would be written ` +
            "as a hidden dotfile the index cannot see. Pass a name, e.g. `akm mv <ref> projectA/new-note` — nothing moved.",
          "INVALID_FLAG_VALUE",
        );
      }
      if (source.type === "memory" && newName.endsWith(".derived")) {
        throw new UsageError(
          `The target name "${newName}" ends with the reserved .derived suffix (the distilled-twin marker) — a base ` +
            "memory renamed onto it would masquerade as a twin of a memory that does not exist. Pick a name without " +
            "the suffix; a real twin always moves together with its base.",
          "INVALID_FLAG_VALUE",
        );
      }
      const toRef = conceptIdFromTypeName(source.type, newName);

      const stashDir = resolveStashDir();
      const config = loadConfig();
      const configuredSources = resolveSourceEntries(stashDir, config);
      const sourceOwner = configuredSources.find(
        (candidate) => path.resolve(candidate.path) === path.resolve(stashDir),
      );
      assertMoveTargetWritable(sourceOwner, stashDir, config.defaultBundle);
      const durableSourceName = resolveMoveSourceIdentity(configuredSources, stashDir, config.defaultBundle);
      await recoverInterruptedMoveTransactions(stashDir);
      const typeDir = stashDirFor(source.type) as string;
      const typeRoot = path.join(stashDir, typeDir);

      const oldRelPath = refToRelPath(source.type, source.name);
      const newRelPath = refToRelPath(source.type, newName);
      if (!oldRelPath || !newRelPath) {
        // Unreachable for MV_SUPPORTED_TYPES; guards a future registry change.
        throw new UsageError(
          `"${source.type}" refs are not path-resolvable and cannot be moved.`,
          "INVALID_FLAG_VALUE",
        );
      }

      const oldPath = resolveMoveSourcePath(stashDir, oldRelPath, source.type, source.name);
      if (!oldPath) {
        throw new UsageError(
          `Cannot resolve ${conceptIdFromTypeName(source.type, source.name)} in the writable stash at ` +
            `${stashDir} — nothing moved.`,
          "MISSING_REQUIRED_ARGUMENT",
          "akm mv renames assets in the primary writable stash only. Check the ref with `akm show <ref>` or `akm search`.",
        );
      }
      // The accepted spelling may be the `.md`-suffixed alias of the same file
      // (markdownSpec.toAssetPath maps `foo` and `foo.md` to memories/foo.md).
      // Everything keyed off the source — the citer rewrite patterns, the index
      // entry_key re-key, the state.db asset_ref re-key, the report — must use
      // the CANONICAL extensionless name derived from the resolved path, or the
      // real rows (keyed by the canonical spelling) are silently missed.
      const sourceName = deriveCanonicalAssetNameFromStashRoot(source.type, stashDir, oldPath) ?? source.name;
      const fromRef = conceptIdFromTypeName(source.type, sourceName);

      const newPath = path.join(stashDir, newRelPath);
      // Defense-in-depth: the ref parser already rejects `../` traversal, but the
      // computed target must land inside the type root regardless.
      if (!isWithin(newPath, typeRoot)) {
        throw new UsageError(
          `Target "${targetArg}" escapes the ${typeDir}/ type root — nothing moved.`,
          "PATH_ESCAPE_VIOLATION",
        );
      }
      if (path.resolve(newPath) === path.resolve(oldPath)) {
        throw new UsageError(`Source and target resolve to the same file (${fromRef}) — nothing to move.`);
      }
      if (fs.existsSync(newPath)) {
        throw new UsageError(
          `Target ${toRef} already exists at ${toPosix(path.relative(stashDir, newPath))} — nothing moved.`,
          "RESOURCE_ALREADY_EXISTS",
          "Pick an unused name, or move the existing asset out of the way first.",
        );
      }

      // Memory `.derived.md` twin: moves together with its base (the entry_key
      // suffix coupling the belief-state inheritance relies on). The TARGET
      // twin-collision check runs whenever the target could carry a twin —
      // NOT only when the source has one: renaming a twin-less memory onto a
      // name whose orphaned `<name>.derived.md` lingers (consolidate/dedup
      // delete the base file without twin cleanup) would silently adopt the
      // stranger file as the renamed memory's distillation.
      const isBaseMemory = source.type === "memory" && !sourceName.endsWith(".derived");
      const twinOldPath = isBaseMemory ? oldPath.replace(/\.md$/, ".derived.md") : null;
      const hasTwin = twinOldPath !== null && fs.existsSync(twinOldPath);
      const targetTwinPath = isBaseMemory ? newPath.replace(/\.md$/, ".derived.md") : null;
      if (targetTwinPath && fs.existsSync(targetTwinPath)) {
        throw new UsageError(
          `Target twin ${toRef}.derived already exists at ${toPosix(path.relative(stashDir, targetTwinPath))} — ` +
            "renaming onto it would adopt that orphaned distilled twin as this memory's own. Nothing moved.",
          "RESOURCE_ALREADY_EXISTS",
          "Pick an unused name, or delete the orphaned .derived.md file first if it belongs to a removed memory.",
        );
      }
      const twinNewPath = hasTwin ? targetTwinPath : null;
      const sourceOriginalHash = hashFile(oldPath);
      const twinOriginalHash = hasTwin && twinOldPath ? hashFile(twinOldPath) : null;

      // ── Plan the inbound-ref rewrite (no writes yet) ───────────────────────
      const rewriteCtx = buildRewriteContext({
        fromRef,
        toRef,
        bundleId: durableSourceName,
        isBaseMemory,
      });
      const plans: CiterRewritePlan[] = [];
      for (const absPath of collectCiterFiles(stashDir)) {
        let raw: string;
        try {
          raw = fs.readFileSync(absPath, "utf8");
        } catch {
          continue;
        }
        const { content, count } = rewriteRefs(raw, rewriteCtx);
        if (count > 0) {
          plans.push({
            absPath,
            relPath: toPosix(path.relative(stashDir, absPath)),
            count,
            content,
            originalHash: hashContent(raw),
          });
        }
      }

      // Read-only sources: scanned, never written — manual follow-ups.
      const readOnlyCiters: Array<{ file: string; count: number }> = [];
      for (const src of configuredSources) {
        if (path.resolve(src.path) === path.resolve(stashDir)) continue;
        for (const absPath of collectCiterFiles(src.path)) {
          let raw: string;
          try {
            raw = fs.readFileSync(absPath, "utf8");
          } catch {
            continue;
          }
          // Same current-ref detection as the writable pass, count-only and never written.
          const { count } = rewriteRefs(raw, rewriteCtx);
          if (count > 0) readOnlyCiters.push({ file: absPath, count });
        }
      }

      // ── Apply citer edits, then rename last (see module docstring) ────────
      // The target's parent directory is created FIRST: if it cannot be (a
      // segment of the target's subdirectory path exists as a FILE, or the
      // parent is unwritable), the command must abort before any citer has
      // been edited — otherwise citers would already point at a ref whose
      // file never arrives.
      fs.mkdirSync(path.dirname(newPath), { recursive: true });
      const transaction = applyMoveFilesystem({
        stashDir,
        oldPath,
        newPath,
        twinOldPath: hasTwin ? twinOldPath : null,
        twinNewPath,
        sourceOriginalHash,
        twinOriginalHash,
        type: source.type,
        oldName: sourceName,
        newName,
        fromRef,
        toRef,
        sourceName: durableSourceName,
        sourceRoot: stashDir,
        eventMetadata: {
          from: fromRef,
          to: toRef,
          rewroteFiles: plans.length,
          readOnlyCiters: readOnlyCiters.length,
          twinMoved: hasTwin,
        },
        plans,
      });

      // Filesystem commit is irreversible. Any finalization error leaves the
      // journal for the next mutation to finish forward; it never rolls back.
      const finalized = await finalizeMoveTransaction(transaction);
      const cleanupWarning = cleanupTxn(transaction.dir);
      const warnings = [...finalized.warnings, ...(cleanupWarning ? [cleanupWarning] : [])];

      output("mv", {
        ok: true,
        from: fromRef,
        to: toRef,
        rewrote: plans.map((plan) => ({ file: plan.relPath, count: plan.count })),
        readOnlyCiters,
        utilityPreserved: finalized.utilityPreserved,
        // Additive: present only when a re-key could not be completed, so the
        // report (not just --verbose stderr) says WHY history may reset.
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    });
  },
});

// Register the mv transaction kind with the unified engine: rollback for
// pre-commit journals (prepared/applying), roll-forward finalize from
// filesystem-committed onward. Any recovery entry point that touches this
// stash root (mv pre-flight, proposal repository, indexer, write-path
// indexer) finishes or rolls back interrupted moves through this handler.
registerTxnKind<MvTxnPayload>(MV_TXN_KIND, {
  phases: MV_TXN_PHASES,
  commitPhase: "filesystem-committed",
  validate: (journal, txnDir, root) => fenceMvTxnJournal(journal, txnDir, root),
  rollback: (txn) => {
    rollbackMoveJournal(txn.journal);
  },
  finalize: async (txn) => {
    validateCommittedMove(txn.journal);
    await finalizeMoveTransaction(txn);
  },
});
