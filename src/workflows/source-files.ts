// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Authoritative workflow-source ownership.
 *
 * Markdown and the bounded GitHub-shaped YAML subset are peer authoring
 * formats, but one canonical workflow ref must have exactly one source file.
 * This module is the shared filesystem arbitration point used before indexing,
 * cache reuse, lookup/show, and runtime load/start. It never chooses one
 * extension by priority: two recognized siblings are a hard collision.
 */

import fs from "node:fs";
import path from "node:path";
import { UsageError, type UsageErrorCode } from "../core/errors";
import { canonicalizeWorkflowName, WORKFLOW_EXTENSIONS } from "../core/recognition-util";

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

export abstract class WorkflowSourceRejectionError extends UsageError {
  readonly sourcePaths: readonly string[];

  protected constructor(message: string, code: UsageErrorCode, sourcePaths: readonly string[]) {
    super(message, code);
    this.sourcePaths = [...sourcePaths].sort(comparePaths);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class WorkflowSourceCollisionError extends WorkflowSourceRejectionError {
  readonly canonicalName: string;

  constructor(canonicalName: string, sourcePaths: readonly string[]) {
    const sorted = [...sourcePaths].sort(comparePaths);
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

export class WorkflowSourceDomainError extends WorkflowSourceRejectionError {
  readonly canonicalName: string;

  constructor(
    canonicalName: string,
    sourcePaths: readonly string[],
    issues: readonly WorkflowSourceRejectionError[],
    collidingSourcePaths: readonly string[],
  ) {
    const sortedPaths = [...sourcePaths].sort(comparePaths);
    const sortedCollisions = [...collidingSourcePaths].sort(comparePaths);
    const code: UsageErrorCode = issues.some((issue) => issue.code === "PATH_ESCAPE_VIOLATION")
      ? "PATH_ESCAPE_VIOLATION"
      : "INVALID_FLAG_VALUE";
    const collisionDetail =
      sortedCollisions.length > 1 ? ` Valid owners also collide: ${sortedCollisions.join(", ")}.` : "";
    super(
      `Workflow "${canonicalName}" has an invalid source ownership domain across candidates: ${sortedPaths.join(", ")}. ` +
        `Problems: ${issues.map((issue) => issue.message).join(" ")}${collisionDetail} ` +
        "Every candidate in the canonical domain is rejected until all invalid or duplicate sources are removed.",
      code,
      sortedPaths,
    );
    this.name = "WorkflowSourceDomainError";
    this.canonicalName = canonicalName;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class WorkflowSourceIdentityError extends UsageError {
  constructor(ref: string, indexedPath: string, authoritativePath: string) {
    super(
      `Indexed workflow source identity for "${ref}" points to ${indexedPath}, but the authoritative source is ${authoritativePath}. ` +
        "Refusing the stale index/cache identity; run `akm index --full` to reconcile it.",
      "INVALID_FLAG_VALUE",
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
      "INVALID_FLAG_VALUE",
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
      "INVALID_FLAG_VALUE",
      [sourcePath],
    );
    this.name = "WorkflowSourceLinkIdentityError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class WorkflowSourceLinkResolutionError extends WorkflowSourceRejectionError {
  constructor(sourcePath: string) {
    super(`Workflow source symlink ${sourcePath} cannot be resolved to a regular file.`, "INVALID_FLAG_VALUE", [
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
 * Enumerate every owned source path that maps to `name` under one component.
 * Ownership is decided before parsing so a malformed peer cannot be hidden by
 * a valid source. Results retain authored extension case for diagnostics.
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
  const sources: WorkflowSourceFile[] = [];
  const issues: WorkflowSourceRejectionError[] = [];

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

  candidates.sort((left, right) => comparePaths(left.relativePath, right.relativePath));
  for (const candidate of candidates) {
    const inspection = inspectWorkflowSourceCandidate(candidate, canonicalName, realRoot);
    if (inspection.source) sources.push(inspection.source);
    issues.push(...inspection.issues);
  }

  if (issues.length > 0) {
    const displayedName = adapterId === "akm" ? `workflows/${canonicalName}` : canonicalName;
    throw new WorkflowSourceDomainError(
      displayedName,
      candidates.map((candidate) => candidate.relativePath),
      issues,
      sources.map((source) => source.relativePath),
    );
  }
  return sources;
}

function inspectWorkflowSourceCandidate(
  candidate: WorkflowSourceCandidate,
  canonicalName: string,
  realRoot: string,
): WorkflowSourceCandidateInspection {
  const issues: WorkflowSourceRejectionError[] = [];
  const nestedSuffix = (WORKFLOW_EXTENSIONS as readonly string[]).find((suffix) =>
    candidate.extensionlessStem.toLowerCase().endsWith(suffix),
  );
  if (nestedSuffix) issues.push(new WorkflowSourceNameError(candidate.relativePath, nestedSuffix));

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

/** Return the sole owner, throw on a collision, or return undefined when absent. */
export function resolveUniqueWorkflowSource(
  sourceRoot: string,
  adapterId: string,
  name: string,
): WorkflowSourceFile | undefined {
  const sources = listWorkflowSourceFiles(sourceRoot, adapterId, name);
  if (sources.length > 1) {
    const canonicalName = sources[0]?.canonicalName ?? canonicalizeWorkflowName(normalizeName(name));
    throw new WorkflowSourceCollisionError(
      adapterId === "akm" ? `workflows/${canonicalName}` : canonicalName,
      sources.map((source) => source.relativePath),
    );
  }
  return sources[0];
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

function toPosix(value: string): string {
  return value.replaceAll("\\", "/");
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
