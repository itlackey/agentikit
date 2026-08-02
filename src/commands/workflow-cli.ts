// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm workflow` command family. `run` is the canonical start/resume/execute
 * surface; the former public `start`, `next`, and `complete` lifecycle is gone.
 * `brief`/`report` retain the experimental harness-neutral driver protocol.
 * Workflows are markdown-only; authoring uses `create --print` and validation
 * uses `akm lint --type workflows`.
 */

import { getStringArg } from "../cli/parse-args";
import { defineGroupCommand, defineJsonCommand, EXIT_CODES, output } from "../cli/shared";
import { assertFlatAssetName, combineCreatePath, normalizeCreateSubPath } from "../core/asset/asset-create";
import { loadConfig } from "../core/config/config";
import { NotFoundError, UsageError } from "../core/errors";
import { akmIndex } from "../indexer/indexer";
import { assertWorkflowMarkdownName, createWorkflowAsset, getWorkflowTemplate } from "../workflows/authoring/authoring";
import { requireWorkflowEngineEnabled } from "../workflows/exec/workflow-engine-gate";
import type { WorkflowParameterFlag } from "../workflows/ir/params";
import { WORKFLOW_MAX_RETRIES, WORKFLOW_MAX_TIMEOUT_MS } from "../workflows/ir/schema";
import {
  abandonWorkflowRun,
  getWorkflowStatus,
  hasWorkflowRun,
  listWorkflowRuns,
  resumeWorkflowRun,
} from "../workflows/runtime/runs";

const workflowStatusCommand = defineJsonCommand({
  meta: {
    name: "status",
    description: "Show full workflow run state for review or resume; workflow refs resolve within the current scope",
  },
  args: {
    target: { type: "positional", description: "Workflow run id or workflow ref (workflows/<name>)", required: true },
    units: {
      type: "boolean",
      description:
        "Also list per-unit rows from the run journal (unit id, status, failure_reason, and any result/error " +
        "diagnostic text). Diagnostics only — step evidence stays deterministic and is unaffected.",
      default: false,
    },
  },
  async run({ args }) {
    const target = args.target;
    const includeUnits = args.units === true;
    if (await hasWorkflowRun(target)) {
      const result = await getWorkflowStatus(target, { includeUnits });
      output("workflow-status", result);
      return;
    }
    let runs: Awaited<ReturnType<typeof listWorkflowRuns>>["runs"];
    try {
      ({ runs } = await listWorkflowRuns({ workflowRef: target }));
    } catch (error) {
      if (!target.includes(":") && !target.includes("/")) {
        throw new NotFoundError(`Workflow run "${target}" not found.`, "WORKFLOW_NOT_FOUND");
      }
      throw error;
    }
    const mostRecent = runs[0];
    if (!mostRecent) throw new NotFoundError(`No workflow runs found for ${target}`, "WORKFLOW_NOT_FOUND");
    const result = await getWorkflowStatus(mostRecent.id, { includeUnits });
    output("workflow-status", result);
  },
});

const workflowListCommand = defineJsonCommand({
  meta: {
    name: "list",
    description: "List workflow runs in the current working scope",
  },
  args: {
    ref: { type: "string", description: "Filter to one workflow ref" },
    active: { type: "boolean", description: "Only show active runs", default: false },
  },
  async run({ args }) {
    const result = await listWorkflowRuns({ workflowRef: args.ref, activeOnly: args.active });
    output("workflow-list", result);
  },
});

const workflowCreateCommand = defineJsonCommand({
  meta: {
    name: "create",
    description: "Create a workflow (markdown document) in the working bundle",
  },
  args: {
    name: {
      type: "positional",
      description: "Workflow name (flat, no '/'; use --path for a subdirectory).",
      required: true,
    },
    path: {
      type: "string",
      description:
        "Relative subdirectory under workflows/ to place the workflow in (e.g. 'release'). The filename comes from the name.",
    },
    from: {
      type: "string",
      description: "Import and validate content from an existing file",
    },
    force: {
      type: "boolean",
      description: "Overwrite an existing workflow (requires --from or --reset)",
      default: false,
    },
    reset: {
      type: "boolean",
      description: "Explicitly replace an existing workflow with a fresh template (use with --force)",
      default: false,
    },
    print: {
      type: "boolean",
      description:
        "Print the RAW template that would be written to stdout without creating anything — pipe it to a file as a starter document",
      default: false,
    },
  },
  async run({ args }) {
    // `name` is flat; subdirectory placement is `--path`'s job.
    assertFlatAssetName(args.name);
    const effectiveName = combineCreatePath(normalizeCreateSubPath(args.path), args.name);
    const namePattern = /^[a-z0-9][a-z0-9._/-]*$/;
    if (!namePattern.test(effectiveName)) {
      throw new UsageError(
        "Workflow name must start with a lowercase letter or digit and contain only lowercase letters, digits, hyphens, dots, underscores, and slashes.",
      );
    }
    assertWorkflowMarkdownName(effectiveName);
    if (args.print) {
      // Raw document, not an envelope — the retired `workflow template` was
      // format-exempt for the same reason: `--print > starter.md` must yield
      // a usable starter file, not `{ok,template,kind}` JSON.
      process.stdout.write(getWorkflowTemplate());
      return;
    }
    if (args.force && !args.from && !args.reset) {
      throw new UsageError(
        "Refusing to overwrite with template: pass --from <file> to replace content, or --reset to explicitly replace with a fresh template.",
      );
    }
    const result = createWorkflowAsset({
      name: effectiveName,
      from: args.from,
      force: args.force,
    });
    // Index the newly-written workflow so `akm workflow run` can resolve
    // a workflowEntryId without requiring an explicit `akm index` call
    // first. Uses the same incremental index path that `akm add` uses.
    await akmIndex({ stashDir: result.stashDir });
    output("workflow-create", { ok: true, ...result });
  },
});

const workflowRunCommand = defineJsonCommand({
  meta: {
    name: "run",
    description:
      "Start or resume a workflow and execute it through completion, failure, a verification gate, or an explicit limit",
  },
  args: {
    target: { type: "positional", description: "Workflow run id or workflow ref (auto-starts a run)", required: true },
    "max-steps": { type: "string", description: "Stop after executing this many steps" },
    "max-retries": { type: "string", description: "Retry a failed workflow step this many additional times" },
    timeout: { type: "string", description: "Whole-run timeout: N, Nms, Ns, or Nm (bare N is milliseconds)" },
  },
  async run({ args, rawArgs }) {
    const { runWorkflowSteps } = await import("../workflows/exec/run-workflow.js");
    const parameterFlags = parseWorkflowParameterFlags(rawArgs, args.target);
    const maxSteps = parseIntegerFlag(getStringArg(args, "max-steps"), "--max-steps", 1);
    const maxRetries = parseIntegerFlag(getStringArg(args, "max-retries"), "--max-retries", 0, WORKFLOW_MAX_RETRIES);
    const timeoutMs = parseWorkflowTimeout(getStringArg(args, "timeout"));
    const controller = new AbortController();
    let timedOut = false;
    let signalExitCode: number | undefined;
    const interrupt = (signal: "SIGINT" | "SIGTERM") => {
      signalExitCode = signal === "SIGINT" ? 130 : 143;
      controller.abort(new Error(`Workflow run interrupted by ${signal}.`));
    };
    const onSigint = () => interrupt("SIGINT");
    const onSigterm = () => interrupt("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            controller.abort(new Error(`Workflow run timed out after ${timeoutMs}ms.`));
          }, timeoutMs);
    timer?.unref?.();
    try {
      const result = await runWorkflowSteps({
        target: args.target,
        parameterFlags,
        ...(maxSteps !== undefined ? { maxSteps } : {}),
        ...(maxRetries !== undefined ? { maxRetries } : {}),
        signal: controller.signal,
      });
      const rendered = { ...result, ...(timedOut ? { timedOut: true as const } : {}) };
      output("workflow-run", rendered);
      if (result.run.status === "failed" || result.gateRejection || result.aborted) {
        process.exitCode = signalExitCode ?? EXIT_CODES.GENERAL;
      }
    } finally {
      if (timer) clearTimeout(timer);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    }
  },
});

const WORKFLOW_RUN_VALUE_FLAGS = new Set([
  "max-steps",
  "maxSteps",
  "max-retries",
  "maxRetries",
  "timeout",
  "format",
  "detail",
  "shape",
  "output",
]);
const WORKFLOW_RUN_BOOLEAN_FLAGS = new Set(["quiet", "verbose", "help", "no-quiet", "no-verbose"]);

export function parseWorkflowParameterFlags(rawArgs: readonly string[], target: string): WorkflowParameterFlag[] {
  const flags: WorkflowParameterFlag[] = [];
  let targetSeen = false;
  for (let index = 0; index < rawArgs.length; index += 1) {
    const token = rawArgs[index] as string;
    if (token === "--") {
      throw new UsageError("`akm workflow run` does not accept positional arguments after `--`.", "INVALID_FLAG_VALUE");
    }
    if (!token.startsWith("-") || token === "-" || /^-\d/.test(token)) {
      if (!targetSeen) {
        if (token !== target) {
          throw new UsageError(
            "Workflow parameter flags must come after the workflow ref or run id.",
            "INVALID_FLAG_VALUE",
          );
        }
        targetSeen = true;
        continue;
      }
      throw new UsageError(`Unexpected positional workflow argument "${token}".`, "INVALID_FLAG_VALUE");
    }
    if (!token.startsWith("--")) continue;

    const body = token.slice(2);
    const equalsAt = body.indexOf("=");
    const name = equalsAt === -1 ? body : body.slice(0, equalsAt);
    const inlineValue = equalsAt === -1 ? undefined : body.slice(equalsAt + 1);
    if (name === "params") {
      throw new UsageError(
        "--params was removed. Pass each declared workflow parameter as its own flag, for example `--version=1.2.3`.",
        "INVALID_FLAG_VALUE",
      );
    }
    if (WORKFLOW_RUN_VALUE_FLAGS.has(name)) {
      if (inlineValue === undefined) index += 1;
      continue;
    }
    if (WORKFLOW_RUN_BOOLEAN_FLAGS.has(name)) continue;
    if (!targetSeen) {
      throw new UsageError(
        "Workflow parameter flags must come after the workflow ref or run id.",
        "INVALID_FLAG_VALUE",
      );
    }

    if (inlineValue !== undefined) {
      flags.push({ name, value: inlineValue });
      continue;
    }
    const next = rawArgs[index + 1];
    if (next !== undefined && (!next.startsWith("-") || /^-\d/.test(next))) {
      flags.push({ name, value: next });
      index += 1;
    } else {
      flags.push({ name, value: true });
    }
  }
  return flags;
}

function parseIntegerFlag(
  raw: string | undefined,
  name: string,
  minimum: number,
  maximum?: number,
): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!/^\d+$/.test(raw) || value < minimum || (maximum !== undefined && value > maximum)) {
    const range = maximum === undefined ? `at least ${minimum}` : `from ${minimum} through ${maximum}`;
    throw new UsageError(`${name} must be an integer ${range}, got "${raw}".`, "INVALID_FLAG_VALUE");
  }
  return value;
}

function parseWorkflowTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const match = /^(\d+)(ms|s|m)?$/.exec(raw);
  if (!match) {
    throw new UsageError(`--timeout must be N, Nms, Ns, or Nm, got "${raw}".`, "INVALID_FLAG_VALUE");
  }
  const amount = Number(match[1]);
  const multiplier = match[2] === "m" ? 60_000 : match[2] === "s" ? 1_000 : 1;
  const timeoutMs = amount * multiplier;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > WORKFLOW_MAX_TIMEOUT_MS) {
    throw new UsageError(
      `--timeout must resolve to 1 through ${WORKFLOW_MAX_TIMEOUT_MS} milliseconds, got "${raw}".`,
      "INVALID_FLAG_VALUE",
    );
  }
  return timeoutMs;
}

const workflowBriefCommand = defineJsonCommand({
  meta: {
    name: "brief",
    description:
      "EXPERIMENTAL, gated behind `experimental.workflowEngine`: describe a run's active step as an executable " +
      "work-list for ANY agent session (the harness-neutral driver protocol) — read-only, takes no engine lease, " +
      "mutates nothing; prints per-unit instructions, output schema, env binding names, and the exact " +
      "`akm workflow report` command lines",
  },
  args: {
    target: {
      type: "positional",
      description: "Workflow run id (or a workflow ref with an active run)",
      required: true,
    },
  },
  async run({ args }) {
    requireWorkflowEngineEnabled(loadConfig(), "brief");
    const { buildWorkflowBrief } = await import("../workflows/exec/brief.js");
    const result = await buildWorkflowBrief(args.target);
    output("workflow-brief", result);
  },
});

const WORKFLOW_REPORT_STATES = ["completed", "failed", "running"] as const;
type WorkflowReportStatus = (typeof WORKFLOW_REPORT_STATES)[number];

const workflowReportCommand = defineJsonCommand({
  meta: {
    name: "report",
    description:
      "EXPERIMENTAL, gated behind `experimental.workflowEngine`: report a unit's result back into a run (the " +
      "mutating half of the harness-neutral driver protocol) — ingested through the SAME shared step semantics " +
      "the engine uses. --status running claims/" +
      "heartbeats a unit; completed/failed records it and, when the step's work-list is fully terminal, runs the " +
      "engine's completion path (reducer, artifact + schema validation, gate). --settle (no --unit) advances a run " +
      "parked on a route-only/empty step. Refused while a live engine lease exists",
  },
  args: {
    target: {
      type: "positional",
      description: "Workflow run id (or a workflow ref with an active run)",
      required: true,
    },
    unit: {
      type: "string",
      description: "Content-derived unit id from `akm workflow brief` (copy it verbatim). Omit with --settle.",
    },
    settle: {
      type: "boolean",
      description:
        "Advance/finalize a run whose active step has NO unit left to report: a non-dispatching step (params-based route, empty fan-out, all-unresolvable) OR a fully-terminal step still needing finalization (every unit ran but the gate never judged — e.g. after resuming a required-gate block). Runs the deterministic completion path. Mutually exclusive with --unit; refused when the step still has genuinely pending units",
      default: false,
    },
    "expect-step": {
      type: "string",
      description:
        "Guard: the step id you briefed against. Refuses the report if the run's active step has since moved (from the `brief` report/settle command line)",
    },
    status: { type: "string", description: `Unit status: ${WORKFLOW_REPORT_STATES.join(", ")}` },
    result: { type: "string", description: "Result payload (JSON for a schema unit, else text). completed only." },
    "result-file": { type: "string", description: "Read the result payload from this file instead of --result/stdin" },
    tokens: { type: "string", description: "Tokens spent on this unit (counts against a declared budget)" },
    "session-id": { type: "string", description: "Harness-native session id revealed while executing the unit" },
    "failure-reason": { type: "string", description: "Structured failure vocabulary for a --status failed report" },
    note: { type: "string", description: "Short progress note for a --status running heartbeat (not persisted)" },
    rerun: {
      type: "boolean",
      description:
        "Re-run an already-FAILED unit: record a NEW attempt (re-applies budget) instead of refusing a differing re-report",
      default: false,
    },
  },
  async run({ args }) {
    requireWorkflowEngineEnabled(loadConfig(), "report");
    // --settle: the unit-less verb that advances a run parked on a
    // non-dispatching step. Mutually exclusive with the per-unit report flags.
    if (args.settle === true) {
      if (getStringArg(args, "unit") !== undefined || getStringArg(args, "status") !== undefined) {
        throw new UsageError(
          "--settle advances a route-only/empty step and takes no --unit or --status. Drop them, or report a " +
            "specific unit with `--unit <id> --status <state>` instead.",
          "INVALID_FLAG_VALUE",
        );
      }
      const { settleWorkflowSpine } = await import("../workflows/exec/report.js");
      const result = await settleWorkflowSpine({
        target: args.target,
        ...(getStringArg(args, "expect-step") !== undefined ? { expectStep: getStringArg(args, "expect-step") } : {}),
      });
      output("workflow-report", result);
      return;
    }

    const status = args.status as string;
    if (!status) {
      throw new UsageError(
        "--status is required (completed | failed | running), or pass --settle to advance a non-dispatching step.",
        "MISSING_REQUIRED_ARGUMENT",
      );
    }
    if (!WORKFLOW_REPORT_STATES.includes(status as WorkflowReportStatus)) {
      throw new UsageError(
        `Invalid --status "${status}". Expected one of: ${WORKFLOW_REPORT_STATES.join(", ")}.`,
        "INVALID_FLAG_VALUE",
      );
    }
    const unitId = getStringArg(args, "unit");
    if (!unitId) {
      throw new UsageError(
        "--unit is required (the content-derived unit id from `akm workflow brief`), or pass --settle for a route-only/empty step.",
        "MISSING_REQUIRED_ARGUMENT",
      );
    }

    let tokens: number | undefined;
    const rawTokens = getStringArg(args, "tokens");
    if (rawTokens !== undefined) {
      tokens = Number.parseInt(rawTokens, 10);
      if (!/^\d+$/.test(rawTokens)) {
        throw new UsageError(`--tokens must be a non-negative integer, got "${rawTokens}".`, "INVALID_FLAG_VALUE");
      }
    }

    // Result payload precedence: --result, then --result-file, then stdin
    // (completed/failed only; a running heartbeat carries no result).
    let resultRaw: string | undefined;
    if (status !== "running") {
      const resultFile = getStringArg(args, "result-file");
      if (args.result !== undefined && resultFile !== undefined) {
        throw new UsageError("Pass at most one of --result or --result-file.", "INVALID_FLAG_VALUE");
      }
      if (args.result !== undefined) {
        resultRaw = String(args.result);
      } else if (resultFile !== undefined) {
        const fs = await import("node:fs");
        resultRaw = fs.readFileSync(resultFile, "utf8");
      } else if (!process.stdin.isTTY) {
        resultRaw = await readStdin();
      }
    }

    const { reportWorkflowUnit } = await import("../workflows/exec/report.js");
    const result = await reportWorkflowUnit({
      target: args.target,
      unitId,
      status: status as WorkflowReportStatus,
      ...(getStringArg(args, "expect-step") !== undefined ? { expectStep: getStringArg(args, "expect-step") } : {}),
      ...(resultRaw !== undefined ? { resultRaw } : {}),
      ...(tokens !== undefined ? { tokens } : {}),
      ...(args.rerun === true ? { rerun: true } : {}),
      ...(getStringArg(args, "session-id") !== undefined ? { sessionId: getStringArg(args, "session-id") } : {}),
      ...(getStringArg(args, "failure-reason") !== undefined
        ? { failureReason: getStringArg(args, "failure-reason") }
        : {}),
      ...(getStringArg(args, "note") !== undefined ? { note: getStringArg(args, "note") } : {}),
    });
    output("workflow-report", result);
  },
});

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const workflowAbandonCommand = defineJsonCommand({
  meta: {
    name: "abandon",
    description: "Give up on a workflow run: mark it failed so it stops counting as active (resume can reopen it)",
  },
  args: {
    runId: { type: "positional", description: "Workflow run id", required: true },
  },
  async run({ args }) {
    const result = await abandonWorkflowRun(args.runId);
    output("workflow-abandon", result);
  },
});

const workflowResumeCommand = defineJsonCommand({
  meta: {
    name: "resume",
    description: "Resume a blocked or failed workflow run, flipping it back to active",
  },
  args: {
    runId: { type: "positional", description: "Workflow run id", required: true },
  },
  async run({ args }) {
    const result = await resumeWorkflowRun(args.runId);
    output("workflow-resume", result);
  },
});

export const workflowCommand = defineGroupCommand({
  meta: {
    name: "workflow",
    description: "Author, inspect, and execute step-by-step workflow assets",
  },
  subCommands: {
    status: workflowStatusCommand,
    list: workflowListCommand,
    create: workflowCreateCommand,
    resume: workflowResumeCommand,
    abandon: workflowAbandonCommand,
    run: workflowRunCommand,
    brief: workflowBriefCommand,
    report: workflowReportCommand,
  },
  // No `defaultRun`: bare `akm workflow` is a usage error (exit 2), the
  // canonical bare-group behavior — owner ruling 12. Run `akm workflow list
  // --active` for what the bare form used to print. This group was previously
  // hand-rolled on `defineCommand` with its own `hasWorkflowSubcommand` guard,
  // which duplicated the subcommand names in a second hand-maintained set;
  // `defineGroupCommand` derives the guard from `subCommands` directly.
});
