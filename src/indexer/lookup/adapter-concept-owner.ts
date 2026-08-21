// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import type { AdapterPathContext, AdapterReadCandidate, BundleAdapter } from "../../core/adapter/bundle-adapter";
import { adapterForId } from "../../core/adapter/registry";
import type { BundleComponent } from "../../core/adapter/types";
import { isWithin } from "../../core/common";
import { UsageError } from "../../core/errors";
import { canonicalizeWorkflowName } from "../../core/recognition-util";
import {
  resolveUniqueWorkflowSource,
  type WorkflowSourceFile,
  workflowNameForConceptId,
} from "../../workflows/source-files";
import { buildFileContext, type FileContext } from "../walk/file-context";

const CONTENT_READ_REQUIRED = Symbol("adapter ownership probe requires content");
const OWNER_SCAN_MAX_DIRECTORIES = 4_096;
const OWNER_SCAN_MAX_FILES = 16_384;
const OWNER_SCAN_SKIP_DIRECTORIES = new Set([".git", "node_modules", "bin", ".cache"]);
const OWNER_SCAN_SKIP_FILES = new Set([".stash.json", ".gitignore", ".gitattributes"]);

export interface AdapterConceptOwner {
  /** Authored path spelling used by index/show/runtime provenance. */
  path: string;
  /** Resolved path used only for containment and identity checks. */
  realPath: string;
  conceptId: string;
  adapterId: string;
  workflowSource?: WorkflowSourceFile;
}

export abstract class AdapterConceptOwnershipError extends UsageError {}

export class AdapterConceptCollisionError extends AdapterConceptOwnershipError {
  constructor(adapterId: string, conceptId: string, paths: readonly string[]) {
    const sorted = [...paths].sort(comparePaths);
    super(
      `Adapter "${adapterId}" has multiple physical owners for "${conceptId}": ${sorted.join(", ")}.`,
      "RESOURCE_ALREADY_EXISTS",
    );
    this.name = "AdapterConceptCollisionError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class AdapterConceptScanError extends AdapterConceptOwnershipError {
  constructor(adapterId: string, sourcePath: string, detail: string) {
    super(`Adapter "${adapterId}" could not safely enumerate ${sourcePath}: ${detail}.`, "INVALID_FLAG_VALUE");
    this.name = "AdapterConceptScanError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function normalizedConceptId(conceptId: string): string | undefined {
  const normalized = conceptId.replaceAll("\\", "/");
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.normalize(normalized) !== normalized
  ) {
    return undefined;
  }
  return normalized;
}

function componentFor(sourcePath: string, adapterId: string): BundleComponent {
  return { id: adapterId, adapter: adapterId, root: sourcePath, writable: false };
}

function lexicallyWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Add case-only suffix spellings beside an adapter-authored read candidate. */
function candidateSpellings(
  candidate: AdapterReadCandidate,
  sourcePath: string,
  realRoot: string,
): AdapterReadCandidate[] {
  const authored = path.resolve(candidate.path);
  if (!lexicallyWithin(authored, sourcePath)) return [{ ...candidate, path: authored }];
  const parent = path.dirname(authored);
  let realParent: string;
  let entries: fs.Dirent[];
  try {
    realParent = fs.realpathSync(parent);
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return [{ ...candidate, path: authored }];
  }
  if (!isWithin(realParent, realRoot)) return [{ ...candidate, path: authored }];

  const extension = path.extname(authored);
  if (!extension) return [{ ...candidate, path: authored }];
  const stem = path.basename(authored, extension);
  return entries
    .filter((entry) => {
      const entryExtension = path.extname(entry.name);
      return (
        path.basename(entry.name, entryExtension) === stem && entryExtension.toLowerCase() === extension.toLowerCase()
      );
    })
    .map((entry) => ({ ...candidate, path: path.join(parent, entry.name) }));
}

function inspectCandidate(
  sourcePath: string,
  realRoot: string,
  adapterId: string,
  candidate: AdapterReadCandidate,
): AdapterConceptOwner | undefined {
  const authoredPath = path.resolve(candidate.path);
  if (!lexicallyWithin(authoredPath, sourcePath)) return undefined;
  let authoredStat: fs.Stats;
  try {
    authoredStat = fs.lstatSync(authoredPath);
  } catch {
    return undefined;
  }
  if (!authoredStat.isFile() && !authoredStat.isSymbolicLink()) return undefined;

  let realPath: string;
  try {
    realPath = fs.realpathSync(authoredPath);
  } catch {
    return undefined;
  }
  if (!isWithin(realPath, realRoot)) return undefined;
  try {
    if (!fs.statSync(realPath).isFile()) return undefined;
  } catch {
    return undefined;
  }
  return { path: authoredPath, realPath, conceptId: candidate.conceptId, adapterId };
}

function claimsWithoutContent(adapter: BundleAdapter, component: BundleComponent, owner: AdapterConceptOwner): boolean {
  const file = buildFileContext(component.root, owner.path);
  let requestedBytes = false;
  const denyBytes = (): never => {
    requestedBytes = true;
    throw CONTENT_READ_REQUIRED;
  };
  const noContentFile: FileContext = { ...file, content: denyBytes, frontmatter: denyBytes };
  try {
    const document = adapter.recognize(component, noContentFile);
    if (requestedBytes) return true;
    return document?.conceptId === owner.conceptId;
  } catch (error) {
    if (error === CONTENT_READ_REQUIRED) return true;
    throw error;
  }
}

function adapterPathContext(root: string, authoredPath: string): AdapterPathContext {
  const file = buildFileContext(root, authoredPath);
  return {
    absPath: file.absPath,
    relPath: file.relPath,
    ext: file.ext,
    fileName: file.fileName,
    parentDir: file.parentDir,
    parentDirAbs: file.parentDirAbs,
    ancestorDirs: file.ancestorDirs,
    stashRoot: file.stashRoot,
  };
}

function scanRegularAuthoredPaths(sourcePath: string, realRoot: string, adapterId: string): string[] {
  const paths: string[] = [];
  const stack = [path.resolve(sourcePath)];
  let directories = 0;
  let files = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    directories++;
    if (directories > OWNER_SCAN_MAX_DIRECTORIES) {
      throw new AdapterConceptScanError(
        adapterId,
        sourcePath,
        `directory limit ${OWNER_SCAN_MAX_DIRECTORIES} exceeded`,
      );
    }
    let entries: fs.Dirent[];
    try {
      entries = fs
        .readdirSync(current, { withFileTypes: true })
        .sort((left, right) => comparePaths(left.name, right.name));
    } catch (error) {
      throw new AdapterConceptScanError(adapterId, sourcePath, `cannot read ${current}: ${String(error)}`);
    }
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (!entry) continue;
      const authoredPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (OWNER_SCAN_SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith(".")) continue;
        stack.push(authoredPath);
        continue;
      }
      if (!entry.isFile() || OWNER_SCAN_SKIP_FILES.has(entry.name)) continue;
      files++;
      if (files > OWNER_SCAN_MAX_FILES) {
        throw new AdapterConceptScanError(adapterId, sourcePath, `file limit ${OWNER_SCAN_MAX_FILES} exceeded`);
      }
      let realPath: string;
      try {
        realPath = fs.realpathSync(authoredPath);
      } catch {
        continue;
      }
      if (isWithin(realPath, realRoot)) paths.push(authoredPath);
    }
  }
  return paths.sort(comparePaths);
}

function scannedReadCandidates(
  adapter: BundleAdapter,
  component: BundleComponent,
  sourcePath: string,
  realRoot: string,
  conceptId: string,
): AdapterReadCandidate[] {
  const recognizePathCandidates = adapter.recognizePathCandidates;
  if (!recognizePathCandidates) return [];
  return scanRegularAuthoredPaths(sourcePath, realRoot, adapter.id).flatMap((authoredPath) =>
    recognizePathCandidates(component, adapterPathContext(sourcePath, authoredPath)).flatMap((candidateConceptId) =>
      candidateConceptId === conceptId ? [{ path: authoredPath, conceptId: candidateConceptId }] : [],
    ),
  );
}

/**
 * Resolve one adapter/component's exact physical concept owner without reading
 * authored bytes. Native workflow arbitration is reused verbatim; every other
 * adapter supplies its own read placements and is probed with a byte-denying
 * FileContext so path-level abstention remains authoritative.
 */
export function resolveAdapterConceptOwner(
  sourcePath: string,
  adapterId: string,
  conceptId: string,
): AdapterConceptOwner | undefined {
  const adapter = adapterForId(adapterId);
  const normalized = normalizedConceptId(conceptId);
  if (!adapter || !normalized) return undefined;

  let realRoot: string;
  try {
    realRoot = fs.realpathSync(sourcePath);
  } catch {
    return undefined;
  }

  const component = componentFor(sourcePath, adapterId);
  const ownersByIdentity = new Map<string, AdapterConceptOwner>();

  const workflowName = workflowNameForConceptId(adapterId, normalized);
  const resolutionConceptId =
    workflowName === undefined
      ? normalized
      : adapterId === "akm"
        ? `workflows/${canonicalizeWorkflowName(workflowName)}`
        : canonicalizeWorkflowName(workflowName);
  if (workflowName !== undefined) {
    const workflowSource = resolveUniqueWorkflowSource(sourcePath, adapterId, workflowName);
    if (workflowSource) {
      const workflowOwner = {
        path: workflowSource.path,
        realPath: workflowSource.realPath,
        conceptId: resolutionConceptId,
        adapterId,
        workflowSource,
      };
      ownersByIdentity.set(`${path.resolve(workflowOwner.path)}\0${resolutionConceptId}`, workflowOwner);
    }
  }

  const directSpellings = (adapter.readCandidates?.(component, resolutionConceptId) ?? []).flatMap((candidate) =>
    candidateSpellings(candidate, sourcePath, realRoot),
  );
  const spellings = [
    ...directSpellings,
    ...scannedReadCandidates(adapter, component, sourcePath, realRoot, resolutionConceptId),
  ];
  const inspected = [
    ...new Map(
      spellings.map((candidate) => [`${path.resolve(candidate.path)}\0${candidate.conceptId}`, candidate]),
    ).values(),
  ]
    .sort((left, right) => comparePaths(left.path, right.path))
    .flatMap((candidate) => {
      const owner = inspectCandidate(sourcePath, realRoot, adapterId, candidate);
      return owner ? [owner] : [];
    });
  for (const candidate of inspected) {
    if (candidate.conceptId !== resolutionConceptId) continue;
    const identity = `${path.resolve(candidate.path)}\0${candidate.conceptId}`;
    if (ownersByIdentity.has(identity)) continue;
    if (claimsWithoutContent(adapter, component, candidate)) ownersByIdentity.set(identity, candidate);
  }
  const owners = [...ownersByIdentity.values()].filter((owner) => owner.conceptId === resolutionConceptId);
  if (owners.length > 1) {
    throw new AdapterConceptCollisionError(
      adapterId,
      resolutionConceptId,
      owners.map((owner) => path.relative(sourcePath, owner.path).replaceAll("\\", "/")),
    );
  }
  return owners[0];
}

export function indexedPathMatchesOwner(indexedPath: string, owner: AdapterConceptOwner): boolean {
  if (path.resolve(indexedPath) !== path.resolve(owner.path)) return false;
  try {
    return path.resolve(fs.realpathSync(indexedPath)) === path.resolve(owner.realPath);
  } catch {
    return false;
  }
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
