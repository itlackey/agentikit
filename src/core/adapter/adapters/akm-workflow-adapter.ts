// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `akm-workflow` adapter — akm 0.9.0 format-family work item (#46).
 *
 * A native akm workflow bundle (spec §6/§7). One format now (workflow-format-
 * unification): `.md` files, orchestration graph in frontmatter, per-step
 * prose in the body. Recognition is frontmatter `type: workflow`, or — since
 * this adapter's whole domain IS workflows — simply residing under this
 * bundle's root; no content sniffing. conceptId strips the `.md` extension. A
 * plain `.md` that opts out via an explicit non-workflow `type:` frontmatter
 * key is abstained on.
 *
 * ── validate (spec §6 workflow row) ──
 *
 * Reuses the akm adapter's per-type workflow checks (shared base checks +
 * `placeholder-stub` + `invalid-workflow-structure`). Delegates to the SAME
 * `perTypeValidateChecks` / `runBaseValidateChecks` the `akm` adapter uses, so
 * workflow validation has one home.
 *
 * Conformance oracle (authored, DO NOT modify): fixture
 * `tests/fixtures/bundles/akm-workflow/` + goldens
 * `tests/fixtures/format-family-goldens/akm-workflow/{recognition,placement,lint,renderer}.json`.
 */

import fs from "node:fs";
import path from "node:path";
import type { FileContext } from "../../../indexer/walk/file-context";
import { parseFrontmatter } from "../../asset/frontmatter";
import type { FileChange } from "../../file-change";
import type { BundleAdapter } from "../bundle-adapter";
import type { BundleComponent, Diagnostic, IndexDocument, ValidateContext } from "../types";
import { perTypeValidateChecks } from "./akm-lint";
import { hashContent, nonEmptyString, type ParsedForValidate, readTags, runBaseValidateChecks } from "./shared";

/** A native workflow bundle is single-component; its one component is `main`. */
const COMPONENT_ID = "main";
/** One recognized workflow extension now (workflow-format-unification): `.md`. */
const WORKFLOW_EXTS = new Set([".md"]);
/** Upper bound on the bounded `content` FTS field (mirrors okf-adapter). */
const MAX_CONTENT_CHARS = 100_000;

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Strip the recognized workflow extension from a component-root-relative path → conceptId. */
function conceptIdOf(relPath: string): string {
  return toPosix(relPath).replace(/\.md$/i, "");
}

/** `README.md` (case-insensitive) is documentation, never the typed asset — mirrors the akm matcher stack's D-R6 reserved-file exclusion (`TYPED_DIR_DOC_FILES`). */
function isReservedDocFile(fileName: string): boolean {
  return fileName.toLowerCase() === "readme.md";
}

/**
 * Recognition gate: any `.md` file in this bundle IS a workflow (this
 * adapter's entire domain is workflows — spec §2.5, "residence under
 * workflows/"), UNLESS its frontmatter declares a DIFFERENT non-empty
 * `type:` (an explicit opt-out, e.g. a README-shaped doc that wants to be
 * something else). No content sniffing.
 */
function isWorkflowFile(raw: string): boolean {
  const data = parseFrontmatter(raw).data;
  const type = data.type;
  return type === undefined || type === "workflow";
}

function recognize(c: BundleComponent, file: FileContext): IndexDocument | null {
  if (!WORKFLOW_EXTS.has(file.ext)) return null;
  if (isReservedDocFile(file.fileName)) return null;
  const raw = file.content();
  if (!isWorkflowFile(raw)) return null;

  const conceptId = conceptIdOf(file.relPath);
  const name = conceptId.split("/").pop() ?? conceptId;
  const parsed = parseFrontmatter(raw);
  const description = nonEmptyString(parsed.data.description);
  const body = parsed.content;
  const tags = readTags(parsed.data.tags);

  const doc: IndexDocument = {
    ref: `${c.id}//${conceptId}`,
    bundle: c.id,
    component: COMPONENT_ID,
    conceptId,
    path: file.absPath,
    hash: hashContent(raw),
    adapterId: "akm-workflow",
    type: "workflow",
    name,
    content: body.length > MAX_CONTENT_CHARS ? body.slice(0, MAX_CONTENT_CHARS) : body,
  };
  if (description !== undefined) doc.description = description;
  if (tags !== undefined) doc.tags = tags;
  return doc;
}

async function validate(c: BundleComponent, changes: FileChange[], ctx: ValidateContext): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  for (const change of changes) {
    if (change.op === "delete") continue;
    const raw = change.after ?? (await ctx.readFile(change.path));
    if (typeof raw !== "string") continue;
    const ext = path.extname(change.path).toLowerCase();
    if (!WORKFLOW_EXTS.has(ext) || isReservedDocFile(path.basename(change.path)) || !isWorkflowFile(raw)) continue;

    const relPath = toPosix(change.path);
    const p = parseFrontmatter(raw);
    const parsed: ParsedForValidate = { data: p.data, content: p.content, frontmatter: p.frontmatter };
    diagnostics.push(...(await runBaseValidateChecks(relPath, parsed, c.root, ctx)));
    diagnostics.push(
      ...(await perTypeValidateChecks({
        type: "workflow",
        relPath,
        raw,
        data: parsed.data,
        frontmatter: parsed.frontmatter,
        body: parsed.content,
        ext,
        ctx,
      })),
    );
  }
  return diagnostics;
}

/**
 * True when a top-level file in `root` is workflow-shaped (used by
 * looksLikeRoot). Unlike `isWorkflowFile` (which admits an absent `type:` —
 * the lenient default ONCE a source is already known to be this bundle),
 * this requires an EXPLICIT `type: workflow` — the install-time probe is
 * choosing WHICH adapter owns an unconfigured root among several candidates
 * (spec §1.2), and an incidental `.md` with no frontmatter type at all
 * (common in an OKF or llm-wiki bundle) must not misclassify that root as
 * akm-workflow's.
 */
function hasTopLevelWorkflowFile(root: string, entries: fs.Dirent[]): boolean {
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!WORKFLOW_EXTS.has(ext) || isReservedDocFile(entry.name)) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(root, entry.name), "utf8");
    } catch {
      continue;
    }
    if (parseFrontmatter(raw).data.type === "workflow") return true;
  }
  return false;
}

export const akmWorkflowAdapter: BundleAdapter = {
  id: "akm-workflow",
  version: "0.9.0",
  extensions: [".md"],

  recognize,
  validate,

  /** Markdown placement; an explicit `.md` conceptId short-circuits to that extension. */
  placeNew(c: BundleComponent, conceptId: string): string {
    const posix = toPosix(conceptId);
    if (/\.md$/i.test(posix)) return path.join(c.root, posix);
    return path.join(c.root, `${posix}.md`);
  },

  /** Workflows live anywhere under the component root. */
  directoryList(): string[] {
    return ["."];
  },

  /**
   * Install-time probe (§1.2): a root holding a workflow-shaped `.md` file at
   * top level (frontmatter `type: workflow` or no `type:` at all).
   */
  looksLikeRoot(root: string): boolean {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return false;
    }
    return hasTopLevelWorkflowFile(root, entries);
  },
};
