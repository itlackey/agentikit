// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `akm-task` adapter for strict task-v3 `.yml` sources.
 *
 * A native akm task-YAML bundle (spec §6/§7). A `.yml` file derives
 * `type: task`; conceptId strips the `.yml` extension. Tasks are AKM-native
 * YAML, NOT OKF markdown concepts. Recognition does NOT gate on validity — an
 * invalid task (e.g. `uses` plus `run`) is still RECOGNIZED; the `invalid-task-yaml`
 * violation surfaces only in `validate`.
 *
 * `.yaml` is the one extension `validate` inspects but `recognize` refuses: it
 * is not a task spelling (nothing indexes or schedules it), so it is reported
 * as `invalid-task-yaml` rather than silently skipped (issue #760).
 *
 * ── validate (spec §6 task validation column) ──
 *
 * Validation enters the canonical task-v3 source parser. That parser owns the
 * closed key sets, executable-selector XOR, scheduling-source XOR, hostile
 * YAML policy, trigger classification, built-in action validation, bounds,
 * and physical `working-directory` containment. The adapter only translates a
 * parser failure into the format-family diagnostic shape.
 *
 * Conformance oracle (authored, DO NOT modify): fixture
 * `tests/fixtures/bundles/akm-task/` + goldens
 * `tests/fixtures/format-family-goldens/akm-task/{recognition,placement,lint,renderer}.json`.
 */

import fs from "node:fs";
import path from "node:path";
import type { FileContext } from "../../../indexer/walk/file-context";
import { TASK_EXTENSION, TASK_NEAR_MISS_EXTENSION, taskExtensionDetail } from "../../../tasks/schema";
import { parseTaskV3Yaml, taskV3SourceErrorDetail } from "../../../tasks/source-v3";
import type { FileChange } from "../../file-change";
import type { BundleAdapter } from "../bundle-adapter";
import type { BundleComponent, Diagnostic, IndexDocument, ValidateContext } from "../types";
import { hashContent } from "./shared";

/** A native task bundle is single-component; its one component is `main`. */
const COMPONENT_ID = "main";
/** The task YAML extension (spec §6 task row). */
const TASK_EXT = TASK_EXTENSION;
/** Upper bound on the bounded `content` FTS field (mirrors okf-adapter). */
const MAX_CONTENT_CHARS = 100_000;

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function recognize(c: BundleComponent, file: FileContext): IndexDocument | null {
  if (file.ext !== TASK_EXT) return null;
  const conceptId = toPosix(file.relPath).replace(/\.yml$/i, "");
  const name = conceptId.split("/").pop() ?? conceptId;
  const raw = file.content();

  return {
    ref: `${c.id}//${conceptId}`,
    bundle: c.id,
    component: COMPONENT_ID,
    conceptId,
    path: file.absPath,
    hash: hashContent(raw),
    adapterId: "akm-task",
    type: "task",
    name,
    content: raw.length > MAX_CONTENT_CHARS ? raw.slice(0, MAX_CONTENT_CHARS) : raw,
  };
}

async function validate(c: BundleComponent, changes: FileChange[], ctx: ValidateContext): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  for (const change of changes) {
    if (change.op === "delete") continue;
    const raw = change.after ?? (await ctx.readFile(change.path));
    if (typeof raw !== "string") continue;
    const ext = path.extname(change.path).toLowerCase();
    // `.yaml` is NOT a task extension — the file never indexes and never runs.
    // It is validated here purely so the near miss is REPORTED rather than
    // skipped the way every other extension is (issue #760).
    if (ext !== TASK_EXT && ext !== TASK_NEAR_MISS_EXTENSION) continue;
    const relPath = toPosix(change.path);
    if (ext === TASK_NEAR_MISS_EXTENSION) {
      diagnostics.push({
        file: relPath,
        issue: "invalid-task-yaml",
        detail: taskExtensionDetail(relPath),
        fixed: false,
      });
      continue;
    }
    try {
      parseTaskV3Yaml({ yaml: raw, filePath: relPath, workspaceRoot: c.root });
    } catch (cause) {
      diagnostics.push({
        file: relPath,
        issue: "invalid-task-yaml",
        detail: taskV3SourceErrorDetail(cause),
        fixed: false,
      });
    }
  }
  return diagnostics;
}

export const akmTaskAdapter: BundleAdapter = {
  id: "akm-task",
  version: "0.9.2",
  // `.yaml` is listed as a COLLECTION hint only — `recognize` still gates on
  // `.yml`, so a `.yaml` file is never indexed as a task. Listing it is what
  // routes the near-miss file into `validate`, where it is reported instead of
  // silently skipped (issue #760).
  extensions: [TASK_EXT, TASK_NEAR_MISS_EXTENSION],

  recognize,
  validate,

  readCandidates(c: BundleComponent, conceptId: string): string[] {
    const posix = toPosix(conceptId).replace(/\.ya?ml$/i, "");
    return [path.join(c.root, `${posix}.yml`), path.join(c.root, `${posix}.yaml`)];
  },

  /** A task places to `<conceptId>.yml`; an already-suffixed conceptId is idempotent. */
  placeNew(c: BundleComponent, conceptId: string): string {
    const posix = toPosix(conceptId);
    return path.join(c.root, /\.yml$/i.test(posix) ? posix : `${posix}.yml`);
  },

  /** Tasks live anywhere under the component root. */
  directoryList(): string[] {
    return ["."];
  },

  /**
   * Install-time probe (§1.2): a root holding a top-level, valid task-v3
   * `.yml` file. The full parser keeps this disjoint from unrelated YAML and
   * prevents probe semantics from drifting from validation semantics.
   */
  looksLikeRoot(root: string): boolean {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== TASK_EXT) continue;
      let raw: string;
      try {
        raw = fs.readFileSync(path.join(root, entry.name), "utf8");
      } catch {
        continue;
      }
      try {
        parseTaskV3Yaml({ yaml: raw, filePath: entry.name, workspaceRoot: root });
        return true;
      } catch {
        // Continue probing the remaining top-level .yml files.
      }
    }
    return false;
  },
};
