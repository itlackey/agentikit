// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import type { BundleAdapter } from "../../core/adapter/bundle-adapter";
import { adapterForId } from "../../core/adapter/registry";
import type { BundleComponent } from "../../core/adapter/types";
import { isWithin } from "../../core/common";
import { buildFileContext } from "../walk/file-context";

const CONTENT_READ_REQUIRED = new Error("adapter ownership probe requires content");

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

function placementCandidates(adapter: BundleAdapter, component: BundleComponent, conceptId: string): string[] {
  return adapter.placeNew ? [adapter.placeNew(component, conceptId)] : [];
}

function extensionCandidates(
  sourcePath: string,
  realRoot: string,
  adapter: BundleAdapter,
  conceptId: string,
): string[] {
  const extensions = [...adapter.extensions].sort((left, right) => right.length - left.length);
  const extension = extensions.find((candidate) => conceptId.toLowerCase().endsWith(candidate.toLowerCase()));
  const extensionless = extension ? conceptId.slice(0, -extension.length) : conceptId;
  const parent = path.join(sourcePath, path.posix.dirname(extensionless));
  let entries: fs.Dirent[];
  try {
    if (!lexicallyWithin(parent, sourcePath) || !isWithin(fs.realpathSync(parent), realRoot)) return [];
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }

  const basename = path.posix.basename(extensionless);
  return entries
    .filter((entry) =>
      entry.isFile()
        ? extensions.some(
            (candidate) =>
              entry.name.toLowerCase().endsWith(candidate.toLowerCase()) &&
              entry.name.slice(0, -candidate.length) === basename,
          )
        : false,
    )
    .map((entry) => path.join(parent, entry.name));
}

function lexicallyWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function containedRegularFile(sourcePath: string, realRoot: string, candidate: string): string | undefined {
  const authoredPath = path.resolve(candidate);
  if (!lexicallyWithin(authoredPath, sourcePath)) return undefined;
  try {
    if (!fs.lstatSync(authoredPath).isFile()) return undefined;
    const realPath = fs.realpathSync(authoredPath);
    return isWithin(realPath, realRoot) ? authoredPath : undefined;
  } catch {
    return undefined;
  }
}

function akmNonMarkdownPathAbstains(sourcePath: string, candidate: string): boolean {
  const relative = path.relative(sourcePath, candidate);
  const segments = relative.split(path.sep).filter(Boolean);
  if (segments[0] === "env" && (candidate.endsWith(".env") || path.basename(candidate) === ".env")) {
    return fs.existsSync(candidate.replace(/\.env$/, ".sensitive"));
  }
  if (segments[0] !== "secrets") return false;
  return candidate.endsWith(".sensitive") || candidate.endsWith(".lock") || fs.existsSync(`${candidate}.sensitive`);
}

function adapterClaimsPathWithoutContent(
  adapter: BundleAdapter,
  component: BundleComponent,
  candidate: string,
): boolean {
  if (adapter.id === "akm" && akmNonMarkdownPathAbstains(component.root, candidate)) return false;
  if (path.extname(candidate).toLowerCase() !== ".md") return true;

  const file = buildFileContext(component.root, candidate);
  const noContentFile = {
    ...file,
    content(): never {
      throw CONTENT_READ_REQUIRED;
    },
    frontmatter(): never {
      throw CONTENT_READ_REQUIRED;
    },
  };
  try {
    return adapter.recognize(component, noContentFile) !== null;
  } catch (error) {
    if (error === CONTENT_READ_REQUIRED) return true;
    throw error;
  }
}

/**
 * Probe one adapter/component for an exact physical concept owner.
 *
 * Adapter placement is authoritative and covers directory manifests, aliases,
 * and extensionless assets that `extensions` cannot enumerate. The extension
 * hint remains a fallback for adapters without placement and supported suffix
 * spelling variants. Candidates are contained regular files before either
 * placement or no-content recognition establishes ownership, and the probe
 * never reads or parses authored bytes.
 */
export function adapterOwnsConceptOnDisk(sourcePath: string, adapterId: string, conceptId: string): boolean {
  const adapter = adapterForId(adapterId);
  const normalized = normalizedConceptId(conceptId);
  if (!adapter || !normalized) return false;

  let realRoot: string;
  try {
    realRoot = fs.realpathSync(sourcePath);
  } catch {
    return false;
  }

  const component = componentFor(sourcePath, adapterId);
  const candidates = [
    ...placementCandidates(adapter, component, normalized),
    ...extensionCandidates(sourcePath, realRoot, adapter, normalized),
  ];
  for (const candidate of new Set(candidates)) {
    const contained = containedRegularFile(sourcePath, realRoot, candidate);
    if (contained && adapterClaimsPathWithoutContent(adapter, component, contained)) return true;
  }
  return false;
}
