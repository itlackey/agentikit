// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The task source version router (spec docs/plans/specs/p2a-task-source-v4.md
 * §3.4, §1.5 D2-N2).
 *
 * Runs the bounded YAML front end ONCE (`readBoundedTaskSourceYaml`), reads
 * `root.version`, and dispatches into `parseTaskV3Document` (unmodified,
 * exported from `../source-v3`) or `parseTaskSourceV4Document` with that
 * SAME `{root, lineAt}` — no second parse, no re-serialization, no synthetic
 * document (the P1b §4.3 invariant this phase carries forward).
 *
 * D2-N2's exact routing table:
 *
 *   | root `version` | routed to                  | observable result                       |
 *   |-----------------|-----------------------------|------------------------------------------|
 *   | `4`             | `parseTaskSourceV4Document` | new grammar                              |
 *   | `3`             | `parseTaskV3Document`       | byte-identical to today                  |
 *   | `2`             | `parseTaskV3Document`       | byte-identical (raises TASK_SCHEMA_VERSION_UNSUPPORTED itself) |
 *   | absent/other    | `parseTaskV3Document`       | byte-identical (its own preserved wording) |
 *
 * Only `version: 4` needs an explicit branch: `parseTaskV3Document` already
 * raises `taskV2UnsupportedError` for `version: 2` and its own "version is
 * required.../must be exactly 3" wording for everything else
 * (`source-v3.ts:720-722`) — a DELIBERATELY preserved wart, not fixed here
 * (P4 owns the final version-error text).
 *
 * The front end's own pre-version failures (source not a string, source too
 * large, YAML parse/warning/expansion) ALWAYS render with the "task v3
 * source" label, even when the document later declares `version: 4` —
 * `root.version` cannot be read until the front end already succeeded. This
 * is a deliberate, spec-recorded wart (§3.4): "P4 owns the final label once
 * v3 is gone."
 */

import type { TaskV3SourceDocument } from "../source-v3";
import { parseTaskV3Document } from "../source-v3";
import { readBoundedTaskSourceYaml } from "./bounded-document";
import { parseTaskSourceV4Document, TASK_SOURCE_V4_VERSION, type TaskSourceV4Document } from "./task-source-v4";

export type ParsedTaskSource =
  | Readonly<{ version: 3; v3: TaskV3SourceDocument }>
  | Readonly<{ version: 4; v4: TaskSourceV4Document }>;

export interface ParseTaskSourceInput {
  readonly yaml: string;
  readonly filePath: string;
  readonly workspaceRoot?: string;
}

/** Read the root `version` field without over-accepting non-number values (e.g. the string `"4"`). */
export function peekTaskSourceVersion(root: unknown): number | undefined {
  if (root === null || typeof root !== "object" || Array.isArray(root)) return undefined;
  const value = (root as Record<string, unknown>).version;
  return typeof value === "number" ? value : undefined;
}

/** Parse task source YAML, routing to the task v3 or task source v4 grammar per D2-N2's table. */
export function parseTaskSource(input: ParseTaskSourceInput): ParsedTaskSource {
  const { root, lineAt } = readBoundedTaskSourceYaml(input, { sourceLabel: "task v3 source" });
  const documentOptions = {
    filePath: input.filePath,
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    lineAt,
  };
  if (peekTaskSourceVersion(root) === TASK_SOURCE_V4_VERSION) {
    return Object.freeze({ version: 4 as const, v4: parseTaskSourceV4Document(root, documentOptions) });
  }
  return Object.freeze({ version: 3 as const, v3: parseTaskV3Document(root, documentOptions) });
}
