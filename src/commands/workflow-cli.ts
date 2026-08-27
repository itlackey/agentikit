// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm workflow` command family. `run` is the canonical start/resume/execute
 * surface; the former public `start`, `next`, and `complete` lifecycle is gone.
 * `create --print` emits Markdown; execution accepts peer `.md` and
 * GitHub-shaped `.yml` workflow sources. Validate with `akm lint --type workflows`.
 */

import { getParsedInvocation } from "../cli/invocation";
import { getStringArg } from "../cli/parse-args";
import { defineGroupCommand, defineJsonCommand, EXIT_CODES, output } from "../cli/shared";
import { armAbortDeadline } from "../core/abort-deadline";
import { assertFlatAssetName, combineCreatePath, normalizeCreateSubPath } from "../core/asset/asset-create";
import { NotFoundError, UsageError } from "../core/errors";
import { akmIndex } from "../indexer/indexer";
import { getOutputMode } from "../output/context";
import { renderGenericText } from "../output/generic-render";
import { deliverRendered } from "../output/html-render";
import { shapeForCommand } from "../output/shapes";
import { formatPlain } from "../output/text";
import { assertWorkflowMarkdownName, createWorkflowAsset, getWorkflowTemplate } from "../workflows/authoring/authoring";
import type { WorkflowParameterFlag } from "../workflows/ir/params";
import { WORKFLOW_MAX_RETRIES, WORKFLOW_MAX_TIMEOUT_MS } from "../workflows/ir/schema";
import {
  abandonWorkflowRun,
  getWorkflowStatus,
  hasWorkflowRun,
  listWorkflowRuns,
  resumeWorkflowRun,
} from "../workflows/runtime/runs";
import { akmWorkflowPlan } from "./workflow/plan";

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
    children: {
      type: "boolean",
      description: "Also include child workflow runs (hidden by default, P3b)",
      default: false,
    },
  },
  async run({ args }) {
    const result = await listWorkflowRuns({
      workflowRef: args.ref,
      activeOnly: args.active,
      includeChildren: args.children,
    });
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
    let signalExitCode: number | undefined;
    const interrupt = (signal: "SIGINT" | "SIGTERM") => {
      signalExitCode = signal === "SIGINT" ? 130 : 143;
      controller.abort(new Error(`Workflow run interrupted by ${signal}.`));
    };
    const onSigint = () => interrupt("SIGINT");
    const onSigterm = () => interrupt("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    // The same deadline a scheduled workflow task arms (`tasks/runner.ts`),
    // sharing this controller with the signal handlers above.
    const deadline = armAbortDeadline(controller, {
      timeoutMs,
      reason: `Workflow run timed out after ${timeoutMs}ms.`,
    });
    try {
      const result = await runWorkflowSteps({
        target: args.target,
        parameterFlags,
        ...(maxSteps !== undefined ? { maxSteps } : {}),
        ...(maxRetries !== undefined ? { maxRetries } : {}),
        signal: controller.signal,
      });
      // The abort is observed between steps, so a deadline landing in the run's
      // final bookkeeping fires on a run that then finishes. Reporting that as
      // timed out would send an operator to resume a run with nothing left to
      // resume — `tasks/runner.ts` suppresses the same case.
      const timedOut = deadline.timedOut() && result.run.status !== "completed";
      const rendered = { ...result, ...(timedOut ? { timedOut: true as const } : {}) };
      output("workflow-run", rendered);
      // `blocked` is a stopped, unverified run — a verification-judge failure
      // leaves it there for `akm workflow resume` — so it must not exit 0 and
      // read as success to a script (it maps to 1 for scheduled tasks too).
      if (result.run.status === "failed" || result.run.status === "blocked" || result.gateRejection || result.aborted) {
        process.exitCode = signalExitCode ?? EXIT_CODES.GENERAL;
      }
    } finally {
      deadline.disarm();
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

// P3b Lane B (spec docs/plans/specs/p3b-child-executor.md §4.6): read-only
// compile+freeze introspection — zero durable writes, zero usage/event rows
// (row B-48). `--json` is deliberately NOT a flag anywhere in this CLI
// (B-N9); the global `--format json` is spliced on by `defineJsonCommand`.
const workflowPlanCommand = defineJsonCommand({
  meta: {
    name: "plan",
    description:
      "Compile and freeze a workflow WITHOUT publishing it: the canonical step graph, per-step frozen target " +
      "kinds, task/child expansion, input bindings, source read set, and lowering notices. Zero durable writes.",
  },
  args: {
    ref: { type: "positional", description: "Workflow ref (workflows/<name>)", required: true },
  },
  async run({ args }) {
    const result = await akmWorkflowPlan(args.ref);
    // B-46/B-57: `akm workflow plan` is read-only introspection whose UNMARKED
    // default is a human summary — `--format json` (B-N9) is the opt-in for
    // the full structure, the mirror image of every other verb's json-by-
    // default (DEFAULT_CONFIG.output.format).
    //
    // Detecting "the caller named no format at all" MUST NOT read
    // `args.format` (code-review round 4, finding 3 / Review log R3):
    // citty's one-parse rule (GLOBAL_OUTPUT_ARGS's own doc comment, "no
    // command body may read these args") isn't just style here — reading it
    // is actively wrong. citty parses each command level against only that
    // level's own remaining argv, so a GLOBAL, pre-subcommand `--format json`
    // (e.g. `akm --format json workflow plan <ref>`) is consumed by the ROOT
    // command's own declared `format` arg before the `workflow`/`plan`
    // subcommand tokens are even resolved — this LEAF's `args.format` reads
    // `undefined` in exactly that case too, indistinguishable from "no
    // format was named anywhere". Reproduced live: that invocation printed
    // the human TEXT summary at exit 0 even though `getOutputMode().format`
    // was already `"json"` (the control, `akm --format json workflow list`,
    // correctly emitted JSON — only this leaf's own arg-read was wrong).
    // Detect it instead off the process-wide invocation singleton
    // (`getParsedInvocation`, src/cli/invocation.ts) — the same canonical,
    // position-independent argv parse `src/cli.ts` mints ONCE at startup
    // (`setParsedInvocation`, immediately before `initOutputMode` builds the
    // `getOutputMode()` singleton from that identical argv), so this agrees
    // with `getOutputMode()` regardless of where `--format` appeared. A bare
    // `process.argv` read is reserved for `src/cli.ts`/`cli/invocation.ts`
    // themselves (`lint-process-argv.ts`); every other module reads through
    // this singleton instead. When explicit, this defers to the normal
    // `output()` path (json/yaml/text/md/html/jsonl, `--output <path>`)
    // unchanged; when absent, it reproduces `output()`'s OWN "text" branch
    // verbatim (same shape/detail projection, same registered-formatter-or-
    // generic-fallback, same `--output <path>` handling) without touching
    // the shared dispatcher other commands rely on.
    if (getParsedInvocation().getFlagValue("--format") === undefined) {
      const mode = getOutputMode();
      const shaped = shapeForCommand("workflow-plan", result, mode.detail, mode.shape);
      const plain = formatPlain("workflow-plan", shaped, mode.detail);
      deliverRendered(plain ?? renderGenericText("workflow-plan", shaped), mode.outputPath);
      return;
    }
    output("workflow-plan", result);
  },
});

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
    plan: workflowPlanCommand,
  },
  // No `defaultRun`: bare `akm workflow` is a usage error (exit 2), the
  // canonical bare-group behavior — owner ruling 12. Run `akm workflow list
  // --active` for what the bare form used to print. This group was previously
  // hand-rolled on `defineCommand` with its own `hasWorkflowSubcommand` guard,
  // which duplicated the subcommand names in a second hand-maintained set;
  // `defineGroupCommand` derives the guard from `subCommands` directly.
});
