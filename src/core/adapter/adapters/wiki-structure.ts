// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Wiki catalog honesty checks — shared by the `llm-wiki` adapter's
 * `validate()` (standalone wiki bundles) and the akm lint sweep's stash-wiki
 * pass (`wikis/<name>/` directories).
 *
 * The wiki's root catalog is the orientation surface agents read before
 * working ("check the catalog to see what pages already exist"), so a stale
 * catalog is worse than none. akm's division of labor is read-only: these
 * checks DETECT drift and the agent fixes it (its `schema.md` tells it how) —
 * akm never rewrites the catalog itself. Both findings are attributed to the
 * CATALOG file (staleness is the catalog's defect, not the page's) and are
 * non-blocking warnings.
 *
 * Partial-set safety (validate() receives arbitrary change sets — a proposal
 * may carry one page): the page→catalog direction checks only the pages
 * PRESENT in the change set (against the catalog read through the overlay),
 * and the catalog→page direction runs only when the catalog itself is in the
 * change set. A change set with neither pages nor the catalog produces no
 * findings.
 */

import { parseFrontmatter } from "../../asset/frontmatter";
import type { FileChange } from "../../file-change";
import type { Diagnostic } from "../types";

/** POSIX-normalize separators. */
function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Decode a ValidateContext.readFile result to text, or null. */
function asText(value: string | Uint8Array | null): string | null {
  if (value === null) return null;
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

/**
 * Extract the catalog's listed page files: markdown link targets that resolve
 * (relative to the catalog's own directory) to `<prefix>pages/**.md`.
 * Returned as bundle-root-relative POSIX paths, deduped. External schemes,
 * anchors, and targets escaping the wiki are dropped (tolerant).
 */
function listedPageFiles(catalogBody: string, prefix: string): Set<string> {
  const listed = new Set<string>();
  for (const match of catalogBody.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = match[1]!.trim();
    const wsIdx = target.search(/\s/);
    if (wsIdx >= 0) target = target.slice(0, wsIdx);
    const hashIdx = target.indexOf("#");
    if (hashIdx >= 0) target = target.slice(0, hashIdx);
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue;
    if (!target.toLowerCase().endsWith(".md")) continue;
    // Resolve relative to the catalog's directory (= the wiki root, `prefix`).
    const joined = target.startsWith("/") ? target.slice(1) : `${prefix}${target}`;
    const segments: string[] = [];
    for (const seg of toPosix(joined).split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        if (segments.length === 0) {
          segments.length = 0;
          break;
        }
        segments.pop();
        continue;
      }
      segments.push(seg);
    }
    const resolved = segments.join("/");
    if (resolved.startsWith(`${prefix}pages/`)) listed.add(resolved);
  }
  return listed;
}

/**
 * Catalog-honesty diagnostics for one wiki rooted at `prefix` (`""` for a
 * standalone llm-wiki bundle; `wikis/<name>/` for a stash wiki). `changes`
 * paths and `readFile` are bundle-root-relative.
 */
export async function wikiCatalogDiagnostics(input: {
  prefix: string;
  changes: readonly FileChange[];
  readFile: (p: string) => Promise<string | Uint8Array | null>;
}): Promise<Diagnostic[]> {
  const { prefix, changes, readFile } = input;
  const diagnostics: Diagnostic[] = [];
  const catalogPath = `${prefix}index.md`;

  const livePaths = new Set<string>();
  const deletedPaths = new Set<string>();
  for (const change of changes) {
    const p = toPosix(change.path);
    if (change.op === "delete") deletedPaths.add(p);
    else livePaths.add(p);
  }
  const pagePaths = [...livePaths].filter((p) => p.startsWith(`${prefix}pages/`) && p.toLowerCase().endsWith(".md"));
  const catalogInSet = livePaths.has(catalogPath);

  const catalogChange = changes.find((c) => toPosix(c.path) === catalogPath && c.op !== "delete");
  const catalogRaw = deletedPaths.has(catalogPath)
    ? null
    : (asText(catalogChange?.after ?? null) ?? asText(await readFile(catalogPath)));

  if (catalogRaw === null) {
    if (pagePaths.length > 0) {
      diagnostics.push({
        file: catalogPath,
        issue: "missing-index",
        detail:
          "warning: this wiki has pages but no root catalog — agents orient by reading the catalog first; " +
          "create one listing the pages (non-blocking).",
        fixed: false,
      });
    }
    return diagnostics;
  }

  const listed = listedPageFiles(parseFrontmatter(catalogRaw).content, prefix);

  // page → catalog: every page in the change set must be listed.
  for (const page of pagePaths.sort()) {
    if (!listed.has(page)) {
      diagnostics.push({
        file: catalogPath,
        issue: "stale-index",
        detail: `warning: page ${page} is not listed in ${catalogPath} — add it to the catalog (non-blocking).`,
        fixed: false,
      });
    }
  }

  // catalog → page: only when the catalog itself is being validated (a full
  // lint / a catalog edit), so partial page-only sets never false-positive.
  if (catalogInSet) {
    for (const target of [...listed].sort()) {
      if (livePaths.has(target)) continue;
      if (deletedPaths.has(target) || asText(await readFile(target)) === null) {
        diagnostics.push({
          file: catalogPath,
          issue: "stale-index",
          detail: `warning: ${catalogPath} lists ${target} which does not exist — remove or fix the entry (non-blocking).`,
          fixed: false,
        });
      }
    }
  }

  return diagnostics;
}
