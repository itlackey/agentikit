// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import type { BundleAdapter } from "../../core/adapter/bundle-adapter";
import { adapterForId } from "../../core/adapter/registry";
import type { BundleComponent } from "../../core/adapter/types";
import { isWithin } from "../../core/common";
import { UsageError } from "../../core/errors";
import {
  resolveUniqueWorkflowSource,
  type WorkflowSourceFile,
  workflowNameForConceptId,
} from "../../workflows/source-files";
import { buildFileContext, type FileContext } from "../walk/file-context";

const CONTENT_READ_REQUIRED = Symbol("adapter ownership probe requires content");

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
function candidateSpellings(candidate: string, sourcePath: string, realRoot: string): string[] {
  const authored = path.resolve(candidate);
  if (!lexicallyWithin(authored, sourcePath)) return [authored];
  const parent = path.dirname(authored);
  let realParent: string;
  let entries: fs.Dirent[];
  try {
    realParent = fs.realpathSync(parent);
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return [authored];
  }
  if (!isWithin(realParent, realRoot)) return [authored];

  const extension = path.extname(authored);
  if (!extension) return [authored];
  const stem = path.basename(authored, extension);
  return entries
    .filter((entry) => {
      const entryExtension = path.extname(entry.name);
      return (
        path.basename(entry.name, entryExtension) === stem && entryExtension.toLowerCase() === extension.toLowerCase()
      );
    })
    .map((entry) => path.join(parent, entry.name));
}

function inspectCandidate(
  sourcePath: string,
  realRoot: string,
  adapterId: string,
  conceptId: string,
  candidate: string,
): AdapterConceptOwner | undefined {
  const authoredPath = path.resolve(candidate);
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
  return { path: authoredPath, realPath, conceptId, adapterId };
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

  const workflowName = workflowNameForConceptId(adapterId, normalized);
  if (workflowName !== undefined) {
    const workflowSource = resolveUniqueWorkflowSource(sourcePath, adapterId, workflowName);
    if (!workflowSource) return undefined;
    const canonicalConceptId =
      adapterId === "akm" ? `workflows/${workflowSource.canonicalName}` : workflowSource.canonicalName;
    return {
      path: workflowSource.path,
      realPath: workflowSource.realPath,
      conceptId: canonicalConceptId,
      adapterId,
      workflowSource,
    };
  }
  if (!adapter.readCandidates) return undefined;

  let realRoot: string;
  try {
    realRoot = fs.realpathSync(sourcePath);
  } catch {
    return undefined;
  }
  const component = componentFor(sourcePath, adapterId);
  const spellings = adapter
    .readCandidates(component, normalized)
    .flatMap((candidate) => candidateSpellings(candidate, sourcePath, realRoot));
  const inspected = [...new Set(spellings.map((candidate) => path.resolve(candidate)))]
    .sort(comparePaths)
    .flatMap((candidate) => {
      const owner = inspectCandidate(sourcePath, realRoot, adapterId, normalized, candidate);
      return owner ? [owner] : [];
    });
  const owners = inspected.filter((candidate) => claimsWithoutContent(adapter, component, candidate));
  if (owners.length > 1) {
    throw new AdapterConceptCollisionError(
      adapterId,
      normalized,
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
