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
 * Byte-identical to the pre-move behavior: the private helpers below
 * (`parseAkm`/`parseOn`/`compileTriggers`/`parseTriggerFields`/
 * `nullableSelector`) and the `AKM_KEYS`/`ON_KEYS` tables moved unchanged,
 * including the full `akm:` fragment grammar `parseAkm` accepts — the one
 * production call site (`compile.ts`) only ever passes `{on: ...}`, never
 * `akm`, but this stays a general-purpose classifier, not narrowed to what
 * today's one caller happens to use. `SOURCE_LABEL` stays the original
 * "task v3 source" wording too, since it is the one permitted bare "task v3"
 * form (§0.1: naming the retired source version) and changing it would be
 * an unauthorized message/behavior change, not a pure move.
 */

import { checkJsonSchemaDefinition } from "../../core/json-schema";
import type { ExecutionJsonObject, ExecutionJsonValue } from "../../execution/json";
import {
  asRecord,
  type BoundedDocumentContext,
  checkKeys,
  cloneBoundedJson,
  noGithubExpression,
  own,
  parseStringArray,
  parseTimeout,
  parseTools,
  presentJsonValue,
  sourceError,
  stringField,
  TASK_V3_MAX_SCHEDULES,
} from "../../tasks/source/bounded-document";
import { WORKFLOW_ENV_VAR_NAME_PATTERN, WORKFLOW_MAX_EXEC_PASS_ENV, WORKFLOW_MAX_RETRIES } from "../resource-limits";

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

/** The `akm:` fragment shape this classifier accepts (moved body-intact — see file header). */
interface WorkflowYamlAkmOptions {
  readonly schedule?: string;
  readonly enabled?: boolean;
  readonly description?: string;
  readonly when_to_use?: string;
  readonly tags?: readonly string[];
  readonly agent?: string | null;
  readonly engine?: string | null;
  readonly model?: string | null;
  readonly inference?: ExecutionJsonObject | null;
  readonly outputSchema?: ExecutionJsonObject | null;
  readonly tools?: string | readonly string[] | ExecutionJsonObject | null;
  readonly timeout?: string | number | null;
  readonly redact?: readonly string[];
  readonly maxSteps?: number;
  readonly maxRetries?: number;
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

const AKM_KEYS = [
  "schedule",
  "enabled",
  "description",
  "when_to_use",
  "tags",
  "agent",
  "engine",
  "model",
  "inference",
  "outputSchema",
  "tools",
  "timeout",
  "redact",
  "maxSteps",
  "maxRetries",
];
const ON_KEYS = ["schedule", "workflow_dispatch"];

function nullableSelector(value: unknown, ctx: ParseContext, key: string): string | null {
  const selector = stringField(value, ctx, ["akm", key], { nullable: true });
  if (selector !== null && selector.trim().length === 0)
    sourceError(ctx, ["akm", key], "must be null or a non-empty string.");
  return selector;
}

function parseAkm(value: ExecutionJsonValue, ctx: ParseContext): Readonly<WorkflowYamlAkmOptions> {
  const input = asRecord(value, ctx, ["akm"]);
  checkKeys(input, AKM_KEYS, ctx, ["akm"]);
  const out: Record<string, unknown> = {};
  if (own(input, "schedule")) {
    const schedule = stringField(input.schedule, ctx, ["akm", "schedule"], { nonempty: true }) as string;
    noGithubExpression(schedule, ctx, ["akm", "schedule"]);
    out.schedule = schedule;
  }
  if (own(input, "enabled")) {
    if (typeof input.enabled !== "boolean") sourceError(ctx, ["akm", "enabled"], "must be a boolean.");
    out.enabled = input.enabled;
  }
  for (const key of ["description", "when_to_use"] as const) {
    if (own(input, key)) out[key] = stringField(input[key], ctx, ["akm", key]);
  }
  if (own(input, "tags")) out.tags = parseStringArray(input.tags, ctx, ["akm", "tags"]);
  for (const key of ["agent", "engine", "model"] as const) {
    if (own(input, key)) out[key] = nullableSelector(input[key], ctx, key);
  }
  if (own(input, "inference")) {
    const inference = presentJsonValue(input.inference, ctx, ["akm", "inference"]);
    out.inference = inference === null ? null : asRecord(inference, ctx, ["akm", "inference"]);
  }
  if (own(input, "outputSchema")) {
    const outputSchema = presentJsonValue(input.outputSchema, ctx, ["akm", "outputSchema"]);
    if (outputSchema === null) out.outputSchema = null;
    else {
      const schema = asRecord(outputSchema, ctx, ["akm", "outputSchema"]);
      const issue = checkJsonSchemaDefinition(schema as Record<string, unknown>)[0];
      if (issue) sourceError(ctx, ["akm", "outputSchema"], `is not a supported JSON schema: ${issue.message}`);
      out.outputSchema = schema;
    }
  }
  if (own(input, "tools")) out.tools = parseTools(presentJsonValue(input.tools, ctx, ["akm", "tools"]), ctx);
  if (own(input, "timeout")) out.timeout = parseTimeout(input.timeout, ctx);
  if (own(input, "redact")) {
    const names = parseStringArray(input.redact, ctx, ["akm", "redact"], {
      max: WORKFLOW_MAX_EXEC_PASS_ENV,
      pattern: WORKFLOW_ENV_VAR_NAME_PATTERN,
    });
    if (new Set(names).size !== names.length) sourceError(ctx, ["akm", "redact"], "must not contain duplicate names.");
    out.redact = names;
  }
  if (own(input, "maxSteps")) {
    if (!Number.isSafeInteger(input.maxSteps) || (input.maxSteps as number) < 1) {
      sourceError(ctx, ["akm", "maxSteps"], "must be a positive safe integer.");
    }
    out.maxSteps = input.maxSteps;
  }
  if (own(input, "maxRetries")) {
    if (
      !Number.isSafeInteger(input.maxRetries) ||
      (input.maxRetries as number) < 0 ||
      (input.maxRetries as number) > WORKFLOW_MAX_RETRIES
    ) {
      sourceError(ctx, ["akm", "maxRetries"], `must be an integer from 0 through ${WORKFLOW_MAX_RETRIES}.`);
    }
    out.maxRetries = input.maxRetries;
  }
  return Object.freeze(out) as Readonly<WorkflowYamlAkmOptions>;
}

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

function compileTriggers(
  input: ExecutionJsonObject,
  akm: Readonly<WorkflowYamlAkmOptions> | undefined,
  ctx: ParseContext,
): WorkflowYamlTriggerPlan {
  const hasSchedule = akm !== undefined && own(akm, "schedule");
  const hasOn = own(input, "on");
  if (hasSchedule === hasOn) {
    sourceError(ctx, [], "must declare exactly one scheduling source: akm.schedule or on.");
  }
  if (hasOn) return parseOn(presentJsonValue(input.on, ctx, ["on"]), ctx);
  return Object.freeze({
    manual: false,
    schedules: Object.freeze([Object.freeze({ cron: akm?.schedule as string, source: "akm.schedule", ordinal: 0 })]),
  });
}

interface ParsedWorkflowYamlTriggerFields {
  readonly akm?: Readonly<WorkflowYamlAkmOptions>;
  readonly triggers: WorkflowYamlTriggerPlan;
}

function parseTriggerFields(input: ExecutionJsonObject, ctx: ParseContext): ParsedWorkflowYamlTriggerFields {
  const akm = own(input, "akm") ? parseAkm(presentJsonValue(input.akm, ctx, ["akm"]), ctx) : undefined;
  return Object.freeze({ ...(akm ? { akm } : {}), triggers: compileTriggers(input, akm, ctx) });
}

/**
 * Classify the strict trigger fragment `{akm?, on?}` into deterministic local
 * scheduler bindings. Full workflow adapters pass only those two fields; this
 * rejects `jobs` and every other workflow field rather than owning the
 * document grammar.
 */
export function classifyWorkflowYamlTriggers(
  value: unknown,
  options: ClassifyWorkflowYamlTriggersOptions,
): WorkflowYamlTriggerPlan {
  const ctx = ctxFrom(options);
  const cloned = cloneBoundedJson(value, ctx, [], { nodes: 0 });
  const input = asRecord(cloned, ctx, []);
  checkKeys(input, ["akm", "on"], ctx, []);
  return parseTriggerFields(input, ctx).triggers;
}
