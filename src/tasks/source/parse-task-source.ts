// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The task source version router (spec docs/plans/specs/p4-deletions-closeout.md
 * §3.2.2).
 *
 * Runs the bounded YAML front end ONCE (`readBoundedTaskSourceYaml`), reads
 * `root.version`, and either dispatches into `parseTaskSourceV4Document` or
 * fails closed — no second parse, no re-serialization, no synthetic document
 * (the P1b §4.3 invariant this phase carries forward).
 *
 * The terminal routing table:
 *
 *   | root `version`        | outcome                                                        |
 *   |------------------------|-----------------------------------------------------------------|
 *   | `4`                    | `parseTaskSourceV4Document` — the new grammar (row B-13)        |
 *   | any other number       | `TASK_SCHEMA_VERSION_UNSUPPORTED`, naming the migrator (B-14/B-15) |
 *   | absent / not a number  | `parseTaskSourceV4Document` — its own `TASK_SOURCE_INVALID` "version is required and must be 4" / "must be exactly 4" wording (row B-16) |
 *
 * A missing or non-numeric `version:` is a MALFORMED v4 document, not a
 * legacy one — it routes into the v4 parser so the field error names the
 * one grammar `src` still accepts, rather than a generic "unsupported"
 * message that would send the user to the migrator for a document that was
 * never task v2 or v3 in the first place.
 *
 * task v2 and task v3 sources are no longer read by `src` at all — the only
 * surviving reader is the frozen, vendored copy in
 * `scripts/akm-migrate/migrate/task-source-v3-frozen.ts`, reachable only
 * through `akm migrate apply` / `akm-migrate`. The front end's own
 * pre-version failures (source not a string, source too large, YAML
 * parse/warning/expansion) render with the label `task source` (row B-17,
 * closing the "task v3 source" label wart P2a's §3.4 recorded).
 */

import { UsageError } from "../../core/errors";
import { readBoundedTaskSourceYaml } from "./bounded-document";
import { parseTaskSourceV4Document, TASK_SOURCE_V4_VERSION, type TaskSourceV4Document } from "./task-source-v4";

export type ParsedTaskSource = Readonly<{ version: 4; v4: TaskSourceV4Document }>;

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

const TASK_MIGRATE_HINT =
  "Run `akm migrate apply --dry-run` to preview the task-v3 to task-source-v4 conversion, then run `akm migrate apply`.";

/** Parse task source YAML, routing per the terminal table above. */
export function parseTaskSource(input: ParseTaskSourceInput): ParsedTaskSource {
  const { root, lineAt } = readBoundedTaskSourceYaml(input, { sourceLabel: "task source" });
  const version = peekTaskSourceVersion(root);
  if (version !== undefined && version !== TASK_SOURCE_V4_VERSION) {
    throw new UsageError(
      `TASK_SCHEMA_VERSION_UNSUPPORTED: Task at ${input.filePath} uses task schema version ${version}, which this release does not accept.`,
      "TASK_SCHEMA_VERSION_UNSUPPORTED",
      TASK_MIGRATE_HINT,
    );
  }
  const documentOptions = {
    filePath: input.filePath,
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    lineAt,
  };
  return Object.freeze({ version: 4 as const, v4: parseTaskSourceV4Document(root, documentOptions) });
}
