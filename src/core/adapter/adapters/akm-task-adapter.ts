// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `akm-task` adapter — akm 0.9.0 format-family work item (#46).
 *
 * A native akm task-YAML bundle (spec §6/§7). A `.yml` file derives
 * `type: task`; conceptId strips the `.yml` extension. Tasks are AKM-native
 * YAML, NOT OKF markdown concepts. Recognition does NOT gate on validity — an
 * invalid task (e.g. two targets) is still RECOGNIZED; the `invalid-task-yaml`
 * violation surfaces only in `validate`.
 *
 * `.yaml` is the one extension `validate` inspects but `recognize` refuses: it
 * is not a task spelling (nothing indexes or schedules it), so it is reported
 * as `invalid-task-yaml` rather than silently skipped (issue #760).
 *
 * ── validate (spec §6 task validation column) ──
 *
 * A task must declare `version: 2`, a `schedule`, and EXACTLY ONE target
 * (`prompt` XOR `workflow` XOR `command`). `enabled` is OPTIONAL — the parser
 * defaults it to `true`, so an omitted field means an ACTIVE task — but must
 * be a boolean when present. The akm adapter's `TaskLinter` port checks
 * "at least one" target; the native task family here is STRICTER — declaring
 * two targets is `invalid-task-yaml`. So this adapter owns a purpose-built
 * one-target check rather than reusing that port.
 *
 * Conformance oracle (authored, DO NOT modify): fixture
 * `tests/fixtures/bundles/akm-task/` + goldens
 * `tests/fixtures/format-family-goldens/akm-task/{recognition,placement,lint,renderer}.json`.
 */

import fs from "node:fs";
import path from "node:path";
import type { FileContext } from "../../../indexer/walk/file-context";
import {
  parseTaskYaml,
  TASK_EXTENSION,
  TASK_NEAR_MISS_EXTENSION,
  taskExtensionDetail,
  taskFieldProblems,
  taskYamlParseDetail,
} from "../../../tasks/schema";
import type { FileChange } from "../../file-change";
import type { BundleAdapter } from "../bundle-adapter";
import type { BundleComponent, Diagnostic, IndexDocument, ValidateContext } from "../types";
import { hashContent } from "./shared";

/** A native task bundle is single-component; its one component is `main`. */
const COMPONENT_ID = "main";
/** The task YAML extension (spec §6 task row). */
const TASK_EXT = TASK_EXTENSION;
/** The mutually-exclusive task target keys (exactly one required). */
const TARGET_KEYS = ["prompt", "workflow", "command"] as const;
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

/**
 * The native `invalid-task-yaml` check: the shared field rules
 * ({@link taskFieldProblems} — see its doc for the lint-vs-parser
 * reconciliation story) plus this adapter's stricter EXACTLY-ONE-target rule.
 */
function taskDiagnostics(relPath: string, data: Record<string, unknown>): Diagnostic[] {
  if (Object.keys(data).length === 0) return [];
  const problems = taskFieldProblems(data);
  const targets = TARGET_KEYS.filter((k) => k in data && data[k] !== undefined && data[k] !== null);
  if (targets.length === 0) problems.push("exactly one target (prompt, workflow, or command)");
  else if (targets.length > 1) problems.push(`exactly one target — declares ${targets.length} (${targets.join(", ")})`);
  if (problems.length === 0) return [];
  return [
    { file: relPath, issue: "invalid-task-yaml", detail: `task field errors: ${problems.join("; ")}`, fixed: false },
  ];
}

async function validate(_c: BundleComponent, changes: FileChange[], ctx: ValidateContext): Promise<Diagnostic[]> {
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
    }
    const parsed = parseTaskYaml(raw);
    if (!parsed.ok) {
      // Distinguish "unparseable" from "empty": `taskDiagnostics` returns []
      // for an empty mapping, so collapsing a parse failure onto `{}` made a
      // broken task file lint clean.
      diagnostics.push({
        file: relPath,
        issue: "invalid-task-yaml",
        detail: taskYamlParseDetail(parsed.error),
        fixed: false,
      });
      continue;
    }
    diagnostics.push(...taskDiagnostics(relPath, parsed.data));
  }
  return diagnostics;
}

export const akmTaskAdapter: BundleAdapter = {
  id: "akm-task",
  version: "0.9.0",
  // `.yaml` is listed as a COLLECTION hint only — `recognize` still gates on
  // `.yml`, so a `.yaml` file is never indexed as a task. Listing it is what
  // routes the near-miss file into `validate`, where it is reported instead of
  // silently skipped (issue #760).
  extensions: [TASK_EXT, TASK_NEAR_MISS_EXTENSION],

  recognize,
  validate,

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
   * Install-time probe (§1.2): a root holding a top-level `.yml` file that
   * parses as a task (a `schedule` key). The task-shape probe keeps it disjoint
   * from non-task YAML.
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
      const { data } = parseTaskYaml(raw);
      if (typeof data.schedule === "string" && data.schedule.trim() !== "") return true;
    }
    return false;
  },
};
