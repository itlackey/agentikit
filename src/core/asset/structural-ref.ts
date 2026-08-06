// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Bundle-structure show targets — "reserved is not invisible" (D-R6 usability
 * revision, 2026-08-06).
 *
 * The D-R6 reserved structural files (the OKF directory listing and update
 * history at any depth; an LLM wiki's root rulebook/catalog/log) are the
 * bundle's ORIENTATION LAYER: agents are meant to read them first ("what's
 * here, what are the rules, what happened recently"). They are deliberately
 * never indexed as concepts — but until this module they were also unreachable
 * through `akm show`, which resolves via the index. That inverted their
 * purpose and bred workarounds (renaming content to `*-content.md` names to
 * stay visible).
 *
 * This is the thin resolver that fixes it, modeled on the stash `.meta/`
 * convention (`stash-meta.ts`): a show ref whose FINAL segment is a structural
 * basename (`index` / `log` / `schema`, spelled WITHOUT the extension — the
 * same path-minus-extension rule every conceptId follows; a pasted `.md`
 * suffix is tolerated and stripped) is direct-read from disk when normal index
 * resolution finds nothing. Search is untouched: these files never become
 * concepts or search hits. Serving is fallback-only, so a genuinely indexed
 * concept that happens to end in `schema` (not a reserved name) still wins.
 *
 * Examples of refs this module recognizes:
 *   - `docs-bundle//index`              → <root>/index.md   (OKF root listing)
 *   - `docs-bundle//guides/index`       → <root>/guides/index.md (nested listing)
 *   - `team-wiki//schema`               → <root>/schema.md  (wiki rulebook)
 *   - `local//wikis/articles/index`     → a stash wiki's catalog
 *   - `local//knowledge/log`            → a directory's update history
 *   - `docs-bundle//`                   → root listing shorthand (bare bundle)
 *
 * Fragment refs (`#…`) are not structural targets — they fall through to
 * normal resolution and its error reporting.
 */

import fs from "node:fs";
import path from "node:path";
import { UsageError } from "../errors";
import { isBundleSlug } from "./asset-ref";

/**
 * Structural basenames served by the fallback, matched case-insensitively on
 * the ref's final segment (the reservation itself is case-insensitive, so a
 * `knowledge/INDEX.md` is just as unindexed — and just as readable — as a
 * lowercase one; the on-disk lookup uses the ref's verbatim spelling).
 */
const STRUCTURAL_BASENAMES = new Set(["index", "log", "schema"]);

export interface StructuralRef {
  /** Bundle/installation id the ref was scoped to, or undefined for "search sources in order". */
  origin?: string;
  /** Bundle-root-relative POSIX path WITHOUT the `.md` extension (`index`, `wikis/articles/index`). */
  relPath: string;
}

/** True when `ref` is the bare-bundle root shorthand `<bundle>//` (empty concept body). */
export function parseBundleRootRef(ref: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed.endsWith("//")) return null;
  const origin = trimmed.slice(0, -2);
  return origin && isBundleSlug(origin) ? origin : null;
}

/**
 * Parse a show target into a {@link StructuralRef}, or `null` when the ref is
 * not a structural target (callers fall through to normal resolution / normal
 * errors). Pure syntax — existence is the resolver's job.
 */
export function parseStructuralRef(ref: string): StructuralRef | null {
  const trimmed = ref.trim();
  if (!trimmed || trimmed.includes("#") || trimmed.includes("\0")) return null;

  let origin: string | undefined;
  let body = trimmed;
  const boundary = trimmed.indexOf("//");
  if (boundary >= 0) {
    origin = trimmed.slice(0, boundary);
    body = trimmed.slice(boundary + 2);
    if (!origin || !isBundleSlug(origin)) return null;
  }
  if (body === "" && origin) return { origin, relPath: "index" }; // `<bundle>//` → root listing

  const posix = body.replace(/\\/g, "/");
  if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix)) return null;
  const normalized = path.posix.normalize(posix);
  if (normalized === ".." || normalized.startsWith("../")) return null;
  if (normalized.split("/").some((seg) => seg === "." || seg === ".." || seg === "")) return null;

  const withoutExt = normalized.replace(/\.md$/i, ""); // tolerate a pasted `.md`; extensionless is canonical
  const finalSegment = withoutExt.split("/").pop() ?? "";
  if (!STRUCTURAL_BASENAMES.has(finalSegment.toLowerCase())) return null;
  return origin ? { origin, relPath: withoutExt } : { relPath: withoutExt };
}

/**
 * Resolve a structural ref to an absolute file under `sourceRoot`, or `null`
 * when the file does not exist. Containment-guarded before and after
 * resolution, mirroring `resolveMetaFilePath`.
 */
export function resolveStructuralFilePath(sourceRoot: string, relPath: string): string | null {
  const root = path.resolve(sourceRoot);
  const resolved = path.resolve(root, `${relPath}.md`);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new UsageError("Structural ref resolves outside the bundle root.", "PATH_ESCAPE_VIOLATION");
  }
  try {
    return fs.statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}
