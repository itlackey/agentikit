// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Task asset schema. A task pairs a cron-style schedule with exactly one of:
 *
 *   • a workflow target  — executed via `runWorkflowSteps()`
 *   • a prompt target    — invoked via `runAgent()` against the configured
 *                          agent harness (e.g. `opencode run`)
 *   • a command target   — invoked directly via `Bun.spawn()`, no AI agent
 *
 * Tasks are stored as pure YAML files at `<stash>/tasks/<id>.yml`. Multi-line
 * inline prompts use a YAML block scalar (`prompt: |`).
 */

import { parse as parseYaml } from "yaml";
import { WORKFLOW_MAX_EXEC_PASS_ENV, WORKFLOW_MAX_TIMEOUT_MS } from "../workflows/resource-limits";

export const TASK_SCHEMA_VERSION = 2;

/** The ONE recognized on-disk task extension (spec §6 task row). */
export const TASK_EXTENSION = ".yml";

/**
 * The near-miss spelling. `.yaml` is NOT a task extension: the indexer's
 * `tasks` matcher (`indexer/walk/matchers.ts`) gates on `.yml`, so a
 * `tasks/<id>.yaml` file is never indexed, never scheduled, and never runs.
 * It is recognized HERE only so lint can say so out loud instead of walking
 * past it (issue #760).
 */
export const TASK_NEAR_MISS_EXTENSION = ".yaml";

/**
 * Largest expressible `timeoutMs` — `setTimeout`'s 32-bit signed ceiling
 * (2^31-1, ~24.8 days). A larger delay overflows and fires almost immediately,
 * which would silently abort a run seconds after it started instead of hours
 * later. One definition with the workflow bound (`WORKFLOW_MAX_TIMEOUT_MS`) —
 * it is a platform fact, not a per-surface policy. Mirrored as `maximum` on
 * `timeoutMs` in `schemas/akm-task.json`.
 */
export const TASK_MAX_TIMEOUT_MS = WORKFLOW_MAX_TIMEOUT_MS;

/**
 * Most names a task's `redact:` list may carry. Shares its bound with exec
 * units' `pass_env:` — both are "name the one or two the defaults miss", not a
 * way to declare the whole environment secret. Mirrored as `maxItems` on
 * `redact` in `schemas/akm-task.json`.
 */
export const TASK_MAX_REDACT_NAMES = WORKFLOW_MAX_EXEC_PASS_ENV;

/**
 * Lint-level shape problems for a parsed task YAML mapping: the field rules
 * `src/tasks/parser.ts` enforces at load time, phrased as diagnostics. The ONE
 * definition shared by both task linters (`core/adapter/adapters/akm-lint.ts`
 * and `akm-task-adapter.ts`) so lint and runtime cannot disagree — they
 * previously did, in both directions: lint demanded `enabled` (which the
 * parser defaults to `true`, so a runnable task was flagged) and never checked
 * `version` (which the parser hard-requires as `2`, so a lint-clean task died
 * at runtime with TASK_SCHEMA_VERSION_UNSUPPORTED). `schemas/akm-task.json`
 * agrees with the parser: `required: [version, schedule]`, `version:
 * {const: 2}`, `enabled` optional but boolean. Target-arity rules stay with
 * each caller (they legitimately differ: at-least-one vs exactly-one).
 */
export function taskFieldProblems(data: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (data.version !== TASK_SCHEMA_VERSION) problems.push(`version (must be ${TASK_SCHEMA_VERSION})`);
  if (typeof data.schedule !== "string" || data.schedule.trim() === "") problems.push("schedule");
  if ("enabled" in data && typeof data.enabled !== "boolean") problems.push("enabled (must be a boolean when present)");
  return problems;
}

/**
 * The outcome of parsing a task YAML file, keeping "this file is broken" and
 * "this file has nothing in it" DISTINGUISHABLE.
 *
 * Every task reader used to collapse both onto `{}` and every task linter
 * short-circuits on an empty mapping, so a `tasks/*.yml` that could not be
 * parsed at all (bad indentation, unterminated quote, tab characters) reported
 * ZERO findings — a clean `akm lint` for a task that cannot run (issue #760).
 */
export type ParsedTaskYaml =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; data: Record<string, unknown>; error: string };

/**
 * Parse a task YAML document into a plain mapping. Non-mapping documents (a
 * scalar, a sequence, an empty file) are NOT a parse failure — they parse fine
 * and simply carry no fields, which the field rules above already describe.
 *
 * The ONE parse used by all three task-lint surfaces (`commands/lint/index.ts`'s
 * akm sweep, the `akm` adapter's `validate`, and the `akm-task` adapter) so a
 * malformed file cannot be a finding on one surface and silence on another.
 */
export function parseTaskYaml(raw: string): ParsedTaskYaml {
  try {
    const doc = parseYaml(raw);
    if (doc && typeof doc === "object" && !Array.isArray(doc))
      return { ok: true, data: doc as Record<string, unknown> };
    return { ok: true, data: {} };
  } catch (e) {
    // yaml's errors carry a multi-line source excerpt; keep the first line so
    // the diagnostic stays one readable finding.
    const message = (e instanceof Error ? e.message : String(e)).split("\n")[0]?.trim() ?? "unknown parse error";
    return { ok: false, data: {}, error: message };
  }
}

/** The `invalid-task-yaml` detail for a file whose YAML could not be parsed. */
export function taskYamlParseDetail(error: string): string {
  return `task YAML does not parse: ${error}`;
}

/**
 * The `invalid-task-yaml` detail for a task file using the `.yaml` near-miss
 * spelling. See {@link TASK_NEAR_MISS_EXTENSION} for why this is an error and
 * not a style nit.
 */
export function taskExtensionDetail(relPath: string): string {
  const base = relPath.replace(/\.yaml$/i, "");
  return (
    `task file uses the ${TASK_NEAR_MISS_EXTENSION} extension; akm recognizes tasks only as ` +
    `${TASK_EXTENSION}, so this file is never indexed or scheduled — rename it to ${base}${TASK_EXTENSION}.`
  );
}

export interface TaskWorkflowTarget {
  kind: "workflow";
  /** A workflow ref, e.g. `workflows/daily-backup`. */
  ref: string;
  params: Record<string, unknown>;
  /**
   * Whole-run timeout (ms) for the orchestration this task drives — the same
   * bound `akm workflow run --timeout` applies, expressed in the task file.
   *
   *   • `undefined` → `DEFAULT_WORKFLOW_TASK_TIMEOUT_MS` (see `runner.ts`).
   *     An unattended run is never left unbounded by accident.
   *   • `null`      → explicit opt-out: run until the workflow itself stops.
   *   • integer     → that many milliseconds; an explicit value always wins.
   *
   * On expiry the runner aborts the run's signal, which the engine treats as a
   * graceful break at a step boundary — the run stays resumable.
   */
  timeoutMs?: number | null;
  /** Stop after this many spine steps (`akm workflow run --max-steps`). */
  maxSteps?: number;
  /** Retry a failed step this many additional times (`--max-retries`). */
  maxRetries?: number;
}

export type TaskPromptSource =
  | { kind: "inline"; text: string }
  /** A stash asset ref like `agents/my-agent` or `commands/foo`. */
  | { kind: "asset"; ref: string }
  /** A path resolved relative to the task file's directory. */
  | { kind: "file"; path: string };

export interface TaskPromptTarget {
  kind: "prompt";
  source: TaskPromptSource;
  /** Named engine; defaults to `defaults.engine` when undefined. */
  engine?: string;
  model?: string;
  timeoutMs?: number | null;
  llm?: {
    temperature?: number;
    maxTokens?: number;
    supportsJsonSchema?: boolean;
    extraParams?: Record<string, unknown>;
    contextLength?: number;
    enableThinking?: boolean;
  };
}

export interface TaskCommandTarget {
  kind: "command";
  /** Pre-split argv — first element is the executable. */
  cmd: string[];
}

export type TaskTarget = TaskWorkflowTarget | TaskPromptTarget | TaskCommandTarget;

export interface TaskDocument {
  /** Runtime and on-disk schema version. */
  version: typeof TASK_SCHEMA_VERSION;
  schemaVersion: typeof TASK_SCHEMA_VERSION;
  /** Filesystem-derived id (basename without `.yml`). */
  id: string;
  /** Cron-style expression, possibly an `@`-alias. */
  schedule: string;
  enabled: boolean;
  target: TaskTarget;
  /** Human-readable display name shown in `akm show` and search results. */
  name?: string;
  description?: string;
  /** Guidance on when this task should be used or triggered manually. */
  when_to_use?: string;
  tags?: string[];
  source: { path: string };
  /**
   * Per-task agent timeout override (ms).
   *
   * Command-task timeout. Prompt task timeout is stored on its engine use, and
   * a workflow task's whole-run timeout on {@link TaskWorkflowTarget.timeoutMs}
   * — every target kind reads the same `timeoutMs` YAML key, it just lands
   * where that kind's dispatch consumes it.
   */
  timeoutMs?: number | null;
  /**
   * Environment variable NAMES whose values are scrubbed from this task's
   * persisted output (the run `.log` and `logs.db`) before it is written.
   *
   * NAMES ONLY, never values. akm looks each name up in the environment the run
   * is given and feeds the value to the log redactor. A literal secret here
   * would leak through a channel far wider than the one it closes: a task file
   * is an indexed, searchable asset whose raw text lands in the FTS `content`
   * column and can be sent to an embedding provider, `akm show` prints it
   * verbatim, and bundles ship over git and npm. This is the same ruling
   * `pass_env:` states for exec units.
   *
   * The escape hatch, not the mechanism: akm already redacts config-declared
   * credentials and infers others from the variable name. Use this for a secret
   * exported under a name none of those rules recognise. A name that is unset
   * at run time contributes nothing. Present only when non-empty.
   */
  redact?: string[];
}
