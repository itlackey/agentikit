// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Authoritative workflow-source ownership.
 *
 * Markdown and the bounded GitHub-shaped YAML subset are peer authoring
 * formats. This module is the shared filesystem arbitration point used
 * before indexing, cache reuse, lookup/show, and runtime load/start.
 *
 * Issue 9 (guard-audit): a `.md` + `.yml` sibling for the same canonical
 * name used to be a hard collision, refusing the ref outright, and ANY
 * invalid candidate in a canonical domain (a broken symlink, an
 * unreadable file) used to poison every valid sibling alongside it. Both
 * are now warn-and-proceed: `.md` wins deterministically over `.yml`
 * (matching `source-ir/compile.ts`'s own extension-priority precedent) with
 * a warning naming the shadowed sibling, and an individually-invalid
 * candidate is skipped with a warning naming it, never blocking a valid
 * sibling in the same domain.
 */

import fs from "node:fs";
import path from "node:path";
import { compareCodePoints, toPosix } from "../core/common";
import { UsageError, type UsageErrorCode } from "../core/errors";
import { canonicalizeWorkflowName, WORKFLOW_EXTENSIONS } from "../core/recognition-util";
import { warnOnce } from "../core/warn";

export type WorkflowSourceFormat = "markdown" | "github-yaml";

export interface WorkflowSourceFile {
  /** Path with its authored filename/extension spelling. */
  path: string;
  /** Symlink-resolved path used for containment and identity comparison. */
  realPath: string;
  /** Source-root-relative path with POSIX separators. */
  relativePath: string;
  canonicalName: string;
  format: WorkflowSourceFormat;
}

interface WorkflowSourceCandidate {
  path: string;
  relativePath: string;
  lowerExtension: string;
  extensionlessStem: string;
}

interface WorkflowSourceCandidateInspection {
  source?: WorkflowSourceFile;
  issues: WorkflowSourceRejectionError[];
}

export interface WorkflowSourceDomainResolution {
  canonicalName: string;
  /** Authored, bundle-relative candidate paths in deterministic order. */
  sourcePaths: readonly string[];
  /** Present when this canonical domain has a winning owner (issue 9: `.md` over `.yml`, never a collision). */
  source?: WorkflowSourceFile;
  /**
   * Never populated by this module any more (issue 9: an invalid or
   * colliding domain now warns and resolves `source` instead of rejecting).
   * Kept for callers' existing structural type — see
   * `commands/lint/index.ts`'s `resolveWorkflowLintOwnership`, outside this
   * area.
   */
  rejection?: WorkflowSourceRejectionError;
}

export abstract class WorkflowSourceRejectionError extends UsageError {
  readonly sourcePaths: readonly string[];

  protected constructor(message: string, code: UsageErrorCode, sourcePaths: readonly string[]) {
    super(message, code);
    this.sourcePaths = [...sourcePaths].sort(compareCodePoints);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class WorkflowSourceCollisionError extends WorkflowSourceRejectionError {
  readonly canonicalName: string;

  constructor(canonicalName: string, sourcePaths: readonly string[]) {
    const sorted = [...sourcePaths].sort(compareCodePoints);
    super(
      `Workflow "${canonicalName}" resolves to multiple workflow source files: ${sorted.join(", ")}. ` +
        "A canonical workflow ref must be owned by exactly one recognized .md or .yml source; remove or rename the duplicate.",
      "RESOURCE_ALREADY_EXISTS",
      sorted,
    );
    this.name = "WorkflowSourceCollisionError";
    this.canonicalName = canonicalName;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class WorkflowSourceIdentityError extends UsageError {
  constructor(ref: string, indexedPath: string, authoritativePath: string) {
    super(
      `Indexed workflow source identity for "${ref}" points to ${indexedPath}, but the authoritative source is ${authoritativePath}. ` +
        "Refusing the stale index/cache identity; run `akm index --full` to reconcile it.",
      "WORKFLOW_SOURCE_INVALID",
    );
    this.name = "WorkflowSourceIdentityError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class WorkflowSourceNameError extends WorkflowSourceRejectionError {
  constructor(sourcePath: string, nestedSuffix: string) {
    super(
      `Workflow source filename ${sourcePath} has an extensionless stem ending in recognized workflow suffix "${nestedSuffix}". ` +
        "Nested workflow suffixes are invalid; remove the inner .md or .yml suffix instead of relying on repeated stripping.",
      "WORKFLOW_SOURCE_INVALID",
      [sourcePath],
    );
    this.name = "WorkflowSourceNameError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class WorkflowSourceLinkIdentityError extends WorkflowSourceRejectionError {
  constructor(sourcePath: string, targetPath: string) {
    super(
      `Workflow source ${sourcePath} resolves through a symlink to ${targetPath} with a different source format. ` +
        "The authored workflow path and resolved source must use the same .md or .yml format.",
      "WORKFLOW_SOURCE_INVALID",
      [sourcePath],
    );
    this.name = "WorkflowSourceLinkIdentityError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class WorkflowSourceLinkResolutionError extends WorkflowSourceRejectionError {
  constructor(sourcePath: string) {
    super(`Workflow source symlink ${sourcePath} cannot be resolved to a regular file.`, "WORKFLOW_SOURCE_INVALID", [
      sourcePath,
    ]);
    this.name = "WorkflowSourceLinkResolutionError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class WorkflowSourcePathIdentityError extends WorkflowSourceRejectionError {
  constructor(sourcePath: string, targetPath: string) {
    super(`Workflow source ${sourcePath} resolves outside the bundle root to ${targetPath}.`, "PATH_ESCAPE_VIOLATION", [
      sourcePath,
    ]);
    this.name = "WorkflowSourcePathIdentityError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Convert an adapter-owned concept id into its extensionless workflow name. */
export function workflowNameForConceptId(adapterId: string, conceptId: string): string | undefined {
  if (adapterId === "akm-workflow") return conceptId;
  if (adapterId !== "akm") return undefined;
  const prefix = "workflows/";
  if (!conceptId.startsWith(prefix) || conceptId.length === prefix.length) return undefined;
  return conceptId.slice(prefix.length);
}

/** Derive the once-canonicalizable workflow name from an adapter-owned authored path. */
export function workflowNameForSourcePath(
  sourceRoot: string,
  adapterId: string,
  sourcePath: string,
): string | undefined {
  if (adapterId !== "akm" && adapterId !== "akm-workflow") return undefined;
  const relativePath = toPosix(path.relative(path.resolve(sourceRoot), path.resolve(sourcePath)));
  if (!isSafeRelativeName(relativePath)) return undefined;
  const ownedPath = adapterId === "akm" ? relativePath.replace(/^workflows\//, "") : relativePath;
  if (adapterId === "akm" && ownedPath === relativePath) return undefined;
  const extension = path.posix.extname(ownedPath);
  if (!(WORKFLOW_EXTENSIONS as readonly string[]).includes(extension.toLowerCase())) return undefined;
  return ownedPath;
}

/**
 * Enumerate every VALID owned source path that maps to `name` under one
 * component. A candidate that fails its own inspection (nested-suffix stem,
 * unresolvable symlink, path escape, symlink/format mismatch) is skipped
 * with a warning naming it (issue 9) — never allowed to block a valid
 * sibling from being listed. Results retain authored extension case for
 * diagnostics.
 */
export function listWorkflowSourceFiles(sourceRoot: string, adapterId: string, name: string): WorkflowSourceFile[] {
  if (adapterId !== "akm" && adapterId !== "akm-workflow") return [];

  const canonicalName = canonicalizeWorkflowName(normalizeName(name));
  if (!isSafeRelativeName(canonicalName)) {
    throw new UsageError("Workflow ref resolves outside the bundle root.", "PATH_ESCAPE_VIOLATION");
  }

  let realRoot: string;
  const authoredRoot = path.resolve(sourceRoot);
  try {
    realRoot = fs.realpathSync(authoredRoot);
  } catch {
    return [];
  }
  const ownershipRoot = adapterId === "akm" ? path.join(authoredRoot, "workflows") : authoredRoot;
  const parent = path.join(ownershipRoot, path.dirname(canonicalName));
  if (!isWithinResolved(parent, authoredRoot)) {
    throw new UsageError("Workflow ref resolves outside the bundle root.", "PATH_ESCAPE_VIOLATION");
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }

  const basename = path.basename(canonicalName);
  const candidates: WorkflowSourceCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const extension = path.extname(entry.name);
    const lowerExtension = extension.toLowerCase();
    if (!(WORKFLOW_EXTENSIONS as readonly string[]).includes(lowerExtension)) continue;
    if (entry.name.slice(0, -extension.length) !== basename) continue;

    const candidatePath = path.join(parent, entry.name);
    candidates.push({
      path: candidatePath,
      relativePath: toPosix(path.relative(authoredRoot, candidatePath)),
      lowerExtension,
      extensionlessStem: entry.name.slice(0, -extension.length),
    });
  }

  candidates.sort((left, right) => compareCodePoints(left.relativePath, right.relativePath));
  return inspectWorkflowSourceDomain(candidates, canonicalName, realRoot);
}

/**
 * Resolve a pre-enumerated set of authored workflow candidates in one batch.
 *
 * Callers that already walked a component (for example full lint/index scans)
 * must use this surface instead of point-resolving every canonical ref and
 * re-reading the same parent directory once per workflow. Candidate
 * inspection and symlink containment/format rules remain shared with
 * {@link listWorkflowSourceFiles}; the `.md`-over-`.yml` tie-break (issue 9)
 * is shared with {@link resolveUniqueWorkflowSource}.
 */
export function resolveWorkflowSourceDomains(
  sourceRoot: string,
  adapterId: string,
  sourcePaths: readonly string[],
): WorkflowSourceDomainResolution[] {
  if (adapterId !== "akm" && adapterId !== "akm-workflow") return [];

  const authoredRoot = path.resolve(sourceRoot);
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(authoredRoot);
  } catch {
    return [];
  }

  const candidatesByName = new Map<string, WorkflowSourceCandidate[]>();
  const seenAuthoredPaths = new Set<string>();
  for (const sourcePath of sourcePaths) {
    // A full walk can legitimately feed the same authored file through more
    // than one lexical spelling (or a caller may repeat it verbatim). Collapse
    // only the normalized AUTHORED path here: distinct symlink/case-variant
    // paths must remain separate ownership candidates even when they resolve to
    // the same physical inode.
    const normalizedSourcePath = path.resolve(sourcePath);
    if (seenAuthoredPaths.has(normalizedSourcePath)) continue;
    seenAuthoredPaths.add(normalizedSourcePath);
    const authoredName = workflowNameForSourcePath(authoredRoot, adapterId, normalizedSourcePath);
    if (authoredName === undefined) continue;
    const canonicalName = canonicalizeWorkflowName(authoredName);
    if (!isSafeRelativeName(canonicalName)) continue;
    const extension = path.extname(normalizedSourcePath);
    const lowerExtension = extension.toLowerCase();
    if (!(WORKFLOW_EXTENSIONS as readonly string[]).includes(lowerExtension)) continue;
    const candidate: WorkflowSourceCandidate = {
      path: normalizedSourcePath,
      relativePath: toPosix(path.relative(authoredRoot, normalizedSourcePath)),
      lowerExtension,
      extensionlessStem: path.basename(normalizedSourcePath).slice(0, -extension.length),
    };
    const domain = candidatesByName.get(canonicalName) ?? [];
    domain.push(candidate);
    candidatesByName.set(canonicalName, domain);
  }

  const resolutions: WorkflowSourceDomainResolution[] = [];
  for (const canonicalName of [...candidatesByName.keys()].sort(compareCodePoints)) {
    const candidates = candidatesByName.get(canonicalName) ?? [];
    candidates.sort((left, right) => compareCodePoints(left.relativePath, right.relativePath));
    const sources = inspectWorkflowSourceDomain(candidates, canonicalName, realRoot);
    const sourcePaths = candidates.map((candidate) => candidate.relativePath);
    resolutions.push({
      canonicalName,
      sourcePaths,
      source: pickWorkflowSource(adapterId, canonicalName, sources),
    });
  }
  return resolutions;
}

/**
 * Inspect every candidate in one canonical domain, skipping (and warning
 * about) any that fails its own inspection — never letting one bad candidate
 * block a valid sibling (issue 9).
 */
function inspectWorkflowSourceDomain(
  candidates: readonly WorkflowSourceCandidate[],
  canonicalName: string,
  realRoot: string,
): WorkflowSourceFile[] {
  const sources: WorkflowSourceFile[] = [];
  for (const candidate of candidates) {
    const inspection = inspectWorkflowSourceCandidate(candidate, canonicalName, realRoot);
    if (inspection.source) {
      sources.push(inspection.source);
      continue;
    }
    for (const issue of inspection.issues) {
      warnOnce(`workflow-source-invalid:${issue.sourcePaths.join(",")}`, issue.message);
    }
  }
  return sources;
}

/**
 * Pick the ONE winning source among a canonical domain's valid candidates
 * (issue 9): `.md` deterministically over `.yml` — matching
 * `source-ir/compile.ts`'s own extension-priority precedent — warning once
 * about every shadowed sibling. `WORKFLOW_EXTENSIONS` is exactly
 * `[".md", ".yml"]`, so a domain never has more than one of each.
 */
function pickWorkflowSource(
  adapterId: string,
  canonicalName: string,
  sources: readonly WorkflowSourceFile[],
): WorkflowSourceFile | undefined {
  if (sources.length <= 1) return sources[0];
  const winner = [...sources].sort((left, right) =>
    left.format === right.format ? 0 : left.format === "markdown" ? -1 : 1,
  )[0];
  const shadowed = sources.filter((source) => source !== winner);
  const displayName = adapterId === "akm" ? `workflows/${canonicalName}` : canonicalName;
  warnOnce(
    `workflow-source-collision:${displayName}`,
    `Workflow "${displayName}" has both a .md and .yml source (${shadowed
      .map((source) => source.relativePath)
      .join(", ")} shadowed by ${winner?.relativePath}); using the .md source. Remove the shadowed sibling to ` +
      "silence this warning.",
  );
  return winner;
}

function inspectWorkflowSourceCandidate(
  candidate: WorkflowSourceCandidate,
  canonicalName: string,
  realRoot: string,
): WorkflowSourceCandidateInspection {
  // Issue 9: a nested suffix (`deploy.md.yml`) is no longer rejected — an
  // extensionless stem that happens to end in a recognized workflow suffix
  // is unusual authoring, not a hazard; the file is a perfectly readable
  // `.yml` (or `.md`) source under its own real extension either way.
  const issues: WorkflowSourceRejectionError[] = [];

  let authoredStat: fs.Stats;
  try {
    authoredStat = fs.lstatSync(candidate.path);
  } catch {
    issues.push(new WorkflowSourceLinkResolutionError(candidate.relativePath));
    return { issues };
  }
  const isLink = authoredStat.isSymbolicLink();
  if (!isLink && !authoredStat.isFile()) {
    issues.push(new WorkflowSourceLinkResolutionError(candidate.relativePath));
    return { issues };
  }

  let realPath: string;
  try {
    realPath = fs.realpathSync(candidate.path);
  } catch {
    issues.push(new WorkflowSourceLinkResolutionError(candidate.relativePath));
    return { issues };
  }
  const targetPath = toPosix(path.relative(realRoot, realPath));
  const contained = isWithinResolved(realPath, realRoot);
  if (!contained) issues.push(new WorkflowSourcePathIdentityError(candidate.relativePath, targetPath));
  if (isLink && path.extname(realPath).toLowerCase() !== candidate.lowerExtension) {
    issues.push(new WorkflowSourceLinkIdentityError(candidate.relativePath, targetPath));
  }

  if (contained) {
    try {
      if (!fs.statSync(realPath).isFile()) issues.push(new WorkflowSourceLinkResolutionError(candidate.relativePath));
    } catch {
      issues.push(new WorkflowSourceLinkResolutionError(candidate.relativePath));
    }
  }
  if (issues.length > 0) return { issues };

  return {
    issues,
    source: {
      path: candidate.path,
      realPath,
      relativePath: candidate.relativePath,
      canonicalName,
      format: candidate.lowerExtension === ".md" ? "markdown" : "github-yaml",
    },
  };
}

/**
 * Return the winning owner (`.md` over `.yml`, warning about a shadowed
 * sibling — issue 9), or `undefined` when the domain has no valid source.
 */
export function resolveUniqueWorkflowSource(
  sourceRoot: string,
  adapterId: string,
  name: string,
): WorkflowSourceFile | undefined {
  const sources = listWorkflowSourceFiles(sourceRoot, adapterId, name);
  const canonicalName = sources[0]?.canonicalName ?? canonicalizeWorkflowName(normalizeName(name));
  return pickWorkflowSource(adapterId, canonicalName, sources);
}

/** Compare an indexed path with the single authoritative on-disk source. */
export function assertIndexedWorkflowSourceIdentity(
  ref: string,
  indexedPath: string,
  authoritative: WorkflowSourceFile,
): void {
  let indexedRealPath: string;
  try {
    indexedRealPath = fs.realpathSync(indexedPath);
  } catch {
    throw new WorkflowSourceIdentityError(ref, indexedPath, authoritative.path);
  }
  if (
    path.resolve(indexedPath) !== path.resolve(authoritative.path) ||
    path.resolve(indexedRealPath) !== path.resolve(authoritative.realPath)
  ) {
    throw new WorkflowSourceIdentityError(ref, indexedPath, authoritative.path);
  }
  const indexedExtension = path.extname(indexedPath).toLowerCase();
  const authoritativeExtension = authoritative.format === "markdown" ? ".md" : ".yml";
  if (indexedExtension !== authoritativeExtension) {
    throw new WorkflowSourceIdentityError(ref, indexedPath, authoritative.path);
  }
}

function normalizeName(name: string): string {
  return name.replaceAll("\\", "/");
}

function isSafeRelativeName(name: string): boolean {
  return (
    name.length > 0 &&
    !path.posix.isAbsolute(name) &&
    name !== ".." &&
    !name.startsWith("../") &&
    path.posix.normalize(name) === name
  );
}

function isWithinResolved(candidate: string, root: string): boolean {
  const relative = path.relative(root, path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
