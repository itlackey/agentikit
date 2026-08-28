// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The canonical workflow YAML trigger classifier (spec
 * docs/plans/specs/p4-deletions-closeout.md §3.2.3, P4-N3).
 *
 * Re-homed body-intact from `src/tasks/source-v3.ts`'s `classifyTaskV3Triggers`
 * (renamed `classifyWorkflowYamlTriggers` here, along with its result types
 * — `TaskV3TriggerPlan`/`TaskV3ScheduleBinding` are now
 * `WorkflowYamlTriggerPlan`/`WorkflowYamlScheduleBinding`, and
 * `ClassifyTaskV3TriggersOptions` is now `ClassifyWorkflowYamlTriggersOptions`)
 * — the ONE function `src/workflows/source-ir/compile.ts` injects into
 * `github-yaml.ts`'s trigger-classifier-drift cross-check
 * (`compileGithubWorkflowSource`'s `classifyTriggers` option, wired as its
 * default). "The second scheduling syntax dies with v3" (P4 §3.2) is about a
 * TASK document's `akm.schedule` / top-level `on:` — never about a
 * WORKFLOW's `on:`, which this file classifies independently and which task
 * source v4 has nothing to do with; this classifier's subject was always the
 * workflow-YAML trigger fragment, not a task document.
 *
 * After this move, `src/workflows/**` imports nothing at all from
 * `src/tasks/**` source modules (§5.2's widened import-seam assertion) —
 * only the version-agnostic bounded-document front end
 * (`src/tasks/source/bounded-document.ts`, shared with task source v4's own
 * parser) is imported below.
 *
 * Review finding (docs/plans/specs/p4-deletions-closeout.md review, on this
 * file): the initial re-home moved the task-v3 `akm:` options-bag grammar
 * (`parseAkm`, `AKM_KEYS`, `WorkflowYamlAkmOptions`, `nullableSelector`, and
 * `compileTriggers`'s "exactly one scheduling source: akm.schedule or on"
 * rule) body-intact, on the theory that this should "stay a general-purpose
 * classifier, not narrowed to what today's one caller happens to use." That
 * theory does not survive contact with §3.2.3's own instruction — "DELETE,
 * except the parts `classifyTaskV3Triggers` needs" — because the ONE
 * production caller (`github-yaml.ts`'s `verifyOwnerTriggerPlan`) only ever
 * calls this classifier with `{on: ...}`; it never carries an `akm` key, and
 * no other production path reaches this function at all. The `akm:` bag is
 * therefore deleted here: `checkKeys` narrows to `["on"]`, and
 * `compileTriggers` requires `on:` unconditionally rather than choosing
 * between two scheduling sources — a WORKFLOW's `on:` is the only
 * scheduling source this classifier has ever had a live caller for. This
 * closes row R-06's disposition for real: "the exactly-one-scheduling-source
 * rule has no document left to apply to" is now true of the CODE, not just
 * of the task-v3 grammar it used to gate.
 *
 * `parseOn`/`ON_KEYS` and the rest of the `on:` grammar moved unchanged.
 * `SOURCE_LABEL` stays the original "task v3 source" wording, since it is
 * the one permitted bare "task v3" form (§0.1: naming the retired source
 * version) and changing it would be an unrelated message/behavior change,
 * not a pure move.
 */

import type { ExecutionJsonObject, ExecutionJsonValue } from "../../execution/json";
import {
  asRecord,
  type BoundedDocumentContext,
  checkKeys,
  cloneBoundedJson,
  noGithubExpression,
  own,
  presentJsonValue,
  sourceError,
  stringField,
  TASK_V3_MAX_SCHEDULES,
} from "../../tasks/source/bounded-document";

export interface WorkflowYamlScheduleBinding {
  readonly cron: string;
  readonly source: string;
  readonly ordinal: number;
}

export interface WorkflowYamlTriggerPlan {
  readonly manual: boolean;
  readonly schedules: readonly WorkflowYamlScheduleBinding[];
}

export interface ClassifyWorkflowYamlTriggersOptions {
  readonly filePath: string;
  readonly lineAt?: (path: readonly (string | number)[]) => number | undefined;
}

/** This file's own parse context is exactly a `BoundedDocumentContext`. */
type ParseContext = BoundedDocumentContext;

const SOURCE_LABEL = "task v3 source";

function ctxFrom(options: ClassifyWorkflowYamlTriggersOptions): ParseContext {
  return {
    filePath: options.filePath,
    sourceLabel: SOURCE_LABEL,
    ...(options.lineAt ? { lineAt: options.lineAt } : {}),
  };
}

const ON_KEYS = ["schedule", "workflow_dispatch"];

function parseOn(value: ExecutionJsonValue, ctx: ParseContext): WorkflowYamlTriggerPlan {
  const input = asRecord(value, ctx, ["on"]);
  const keys = Object.keys(input);
  if (keys.length === 0) sourceError(ctx, ["on"], "must declare schedule and/or workflow_dispatch.");
  const unsupported = keys.find((key) => !ON_KEYS.includes(key));
  if (unsupported)
    sourceError(ctx, ["on", unsupported], "is an unsupported local service event; no scheduler binding was created.");
  const schedules: WorkflowYamlScheduleBinding[] = [];
  if (own(input, "schedule")) {
    if (!Array.isArray(input.schedule) || input.schedule.length === 0) {
      sourceError(ctx, ["on", "schedule"], "must be a non-empty list of {cron: string} records.");
    }
    if (input.schedule.length > TASK_V3_MAX_SCHEDULES) {
      sourceError(ctx, ["on", "schedule"], `accepts at most ${TASK_V3_MAX_SCHEDULES} entries.`);
    }
    for (const [index, raw] of input.schedule.entries()) {
      const entry = asRecord(raw, ctx, ["on", "schedule", index]);
      checkKeys(entry, ["cron"], ctx, ["on", "schedule", index]);
      if (!own(entry, "cron")) sourceError(ctx, ["on", "schedule", index, "cron"], "is required.");
      const cron = stringField(entry.cron, ctx, ["on", "schedule", index, "cron"], { nonempty: true }) as string;
      noGithubExpression(cron, ctx, ["on", "schedule", index, "cron"]);
      schedules.push(Object.freeze({ cron, source: `on.schedule[${index}].cron`, ordinal: index }));
    }
  }
  let manual = false;
  if (own(input, "workflow_dispatch")) {
    const dispatch = input.workflow_dispatch;
    if (dispatch !== null) {
      const mapping = asRecord(presentJsonValue(dispatch, ctx, ["on", "workflow_dispatch"]), ctx, [
        "on",
        "workflow_dispatch",
      ]);
      if (Object.keys(mapping).length > 0) {
        sourceError(ctx, ["on", "workflow_dispatch"], "must be null or an empty mapping; inputs are unsupported.");
      }
    }
    manual = true;
  }
  return Object.freeze({ manual, schedules: Object.freeze(schedules) });
}

/**
 * `on:` is the one canonical scheduling source a workflow YAML trigger
 * fragment has a live caller for (see file header — the task-v3 `akm:`
 * options bag this used to also accept is deleted, along with the
 * "exactly one scheduling source" choice between the two).
 */
function compileTriggers(input: ExecutionJsonObject, ctx: ParseContext): WorkflowYamlTriggerPlan {
  if (!own(input, "on")) sourceError(ctx, ["on"], "is required.");
  return parseOn(presentJsonValue(input.on, ctx, ["on"]), ctx);
}

/**
 * Classify the strict trigger fragment `{on}` into deterministic local
 * scheduler bindings. Full workflow adapters pass only that one field; this
 * rejects `jobs` and every other workflow field (and, since the review fix
 * above, `akm` too) rather than owning the document grammar.
 */
export function classifyWorkflowYamlTriggers(
  value: unknown,
  options: ClassifyWorkflowYamlTriggersOptions,
): WorkflowYamlTriggerPlan {
  const ctx = ctxFrom(options);
  const cloned = cloneBoundedJson(value, ctx, [], { nodes: 0 });
  const input = asRecord(cloned, ctx, []);
  checkKeys(input, ["on"], ctx, []);
  return compileTriggers(input, ctx);
}
