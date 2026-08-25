// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm task` command family. Extracted verbatim from src/cli.ts (WS6) so the
 * God Module shrinks; the `main.subCommands.task` key and every subcommand's
 * args/output shape are byte-identical. Handlers whose body is a plain
 * `runWithJsonErrors(...) + output(...)` are migrated to `defineJsonCommand`,
 * which emits the same JSON envelope (stdout/stderr/exit-code) as the inline
 * form. `task run` keeps a plain `defineCommand` because it forwards the
 * task's own exit code via `process.exitCode` (F4: not `process.exit()` —
 * that would skip pending cleanup).
 *
 * 0.9 CLI overhaul (S6): the group was renamed from the plural `tasks` to the
 * singular `task` — hard break, no alias. `init`/`enable`/`disable` are
 * dropped: the default improve-schedule task set now ships as embedded
 * templates under src/assets/tasks/improve/ (see src/tasks/embedded.ts),
 * seeded through the interactive `akm setup` task-review step instead of a
 * separate CLI command, and toggling a task's enabled state is a file edit +
 * `task sync` (tasks-sync.test.ts already proves the flip path). Every
 * subcommand (`add`/`run`/`history`/`sync`) shares one `--bundle <bundle>`
 * axis (S8.4 ratified `task add`'s `--target` → `--bundle`; a later Gate-1
 * fix reverted it to match `import`/`proposal accept`, splitting the
 * write-target axis three-vs-one against `remember`/`clone`/`improve` — the
 * final review re-applied the ratified rename here).
 */

import { defineCommand } from "citty";
import { getParsedInvocation } from "../../cli/invocation";
import { parsePositiveIntFlag } from "../../cli/parse-args";
import { defineGroupCommand, defineJsonCommand, GLOBAL_OUTPUT_ARGS, output, runWithJsonErrors } from "../../cli/shared";
import { UsageError } from "../../core/errors";
import { akmTasksAdd, akmTasksDoctor, akmTasksHistory, akmTasksRun, akmTasksSync } from "./tasks";

/** Shared `--bundle <bundle>` arg wired onto every task subcommand. */
const bundleArg = {
  bundle: {
    type: "string",
    description: "Bundle to operate on (defaults to the primary/default bundle)",
  },
} as const;

/**
 * `--target` was renamed to `--bundle` on `task` in 0.9 (S8.4). citty is
 * non-strict, so the retired spelling is silently absorbed rather than
 * rejected — reject it explicitly instead (mirrors improve-cli.ts /
 * remember-cli.ts).
 */
function rejectRetiredTaskTargetFlag(): void {
  if (!getParsedInvocation().hasFlag("--target")) return;
  throw new UsageError(
    "`akm task --target` was renamed to `--bundle` in 0.9. Use `--bundle <name>` instead.",
    "INVALID_FLAG_VALUE",
  );
}

const tasksAddCommand = defineJsonCommand({
  meta: { name: "add", description: "Register a new scheduled task and install it in the OS scheduler" },
  args: {
    id: { type: "positional", description: "Task id (used as filename and scheduler entry)", required: true },
    schedule: { type: "string", description: 'Cron-style schedule, e.g. "0 9 * * *" or "@daily"', required: true },
    ...bundleArg,
    workflow: { type: "string", description: "Workflow ref to invoke (e.g. workflows/my-flow)" },
    prompt: {
      type: "string",
      description: "Inline text prompt for the configured agent harness (asset refs and file paths are rejected)",
    },
    command: {
      type: "string",
      description: 'Exact shell string to run on the schedule (no AI agent), e.g. "akm improve --strategy frequent".',
    },
    engine: { type: "string", description: "Engine to use for prompt targets (default: defaults.engine)" },
    model: { type: "string", description: "Model override for prompt targets" },
    "timeout-ms": { type: "string", description: "Positive timeout in milliseconds for prompt or command targets" },
    params: { type: "string", description: "Workflow params as a JSON object" },
    name: { type: "string", description: "Human-readable name for the task" },
    "when-to-use": { type: "string", description: "Guidance on when this task runs or should be used" },
    description: { type: "string", description: "Human-readable description" },
    tags: { type: "string", description: "Comma-separated tags" },
    disabled: { type: "boolean", description: "Register but leave disabled in the OS scheduler", default: false },
    force: { type: "boolean", description: "Overwrite an existing task with the same id", default: false },
    rebind: {
      type: "boolean",
      description: "Explicitly permit scheduler creation from this ineligible local invocation",
      default: false,
    },
  },
  async run({ args }) {
    rejectRetiredTaskTargetFlag();
    const result = await akmTasksAdd({
      id: args.id,
      schedule: args.schedule,
      target: args.bundle,
      workflow: args.workflow,
      prompt: args.prompt,
      command: args.command,
      engine: args.engine,
      model: args.model,
      timeoutMs: args["timeout-ms"] === undefined ? undefined : parsePositiveIntFlag(args["timeout-ms"]),
      params: args.params,
      name: args.name,
      when_to_use: args["when-to-use"],
      description: args.description,
      tags: args.tags
        ? args.tags
            .split(/[\s,]+/)
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
      disabled: args.disabled === true,
      force: args.force === true,
      rebind: args.rebind === true,
    });
    output("task-add", result);
  },
});

const tasksRunCommand = defineCommand({
  meta: {
    name: "run",
    description: "Execute a task now (this is what cron / launchd / schtasks invoke at the scheduled time)",
  },
  // Raw defineCommand (it forwards the task's exit code), so the global output
  // flags are declared here or `--format md nightly` loses the task id.
  args: {
    ...GLOBAL_OUTPUT_ARGS,
    id: { type: "positional", description: "Task id", required: true },
    ...bundleArg,
    scheduled: { type: "boolean", description: "Internal marker for scheduler-generated runs", default: false },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      rejectRetiredTaskTargetFlag();
      const envelope = await akmTasksRun(args.id, {
        scheduled: args.scheduled === true,
        ...(args.bundle !== undefined ? { target: args.bundle } : {}),
      });
      output("task-run", envelope);
      // F4: was `process.exit(envelope.exitCode)`, terminating synchronously
      // and skipping any pending cleanup (this command forwards a run task's
      // own exit code, so it can be any value, not just 0/1). output() has
      // already run and this is the last statement, so process.exitCode +
      // the implicit return is equivalent without the synchronous cutoff.
      if (envelope.exitCode !== 0) process.exitCode = envelope.exitCode;
    });
  },
});

const tasksHistoryCommand = defineJsonCommand({
  meta: { name: "history", description: "Show recent task run history" },
  args: {
    id: { type: "string", description: "Filter to one task id" },
    limit: { type: "string", description: "Maximum rows to return (default 50)" },
    ...bundleArg,
  },
  async run({ args }) {
    rejectRetiredTaskTargetFlag();
    const limit = parsePositiveIntFlag(args.limit ?? undefined);
    const result = await akmTasksHistory({ id: args.id, limit, target: args.bundle });
    output("task-history", result);
  },
});

const tasksSyncCommand = defineJsonCommand({
  meta: {
    name: "sync",
    description: "Atomically preflight and reconcile a bundle's task/workflow schedules with the OS scheduler",
  },
  args: {
    ...bundleArg,
    rebind: {
      type: "boolean",
      description: "Replace installed bindings with the current invocation",
      default: false,
    },
  },
  async run({ args }) {
    rejectRetiredTaskTargetFlag();
    const result = await akmTasksSync({}, args.bundle, { rebind: args.rebind === true });
    output("task-sync", result);
  },
});

const tasksDoctorCommand = defineJsonCommand({
  meta: {
    name: "doctor",
    description: "Report the active scheduler backend, akm bin path, log dir, and supported schedule subset",
  },
  args: {},
  async run() {
    const result = await akmTasksDoctor();
    output("task-doctor", result);
  },
});

export const taskCommand = defineGroupCommand({
  meta: {
    name: "task",
    description:
      "Schedule recurring commands, prompts, and workflows through the OS scheduler (cron / launchd / schtasks)",
  },
  subCommands: {
    add: tasksAddCommand,
    run: tasksRunCommand,
    history: tasksHistoryCommand,
    sync: tasksSyncCommand,
    doctor: tasksDoctorCommand,
  },
  // Bare `akm task` reports scheduler diagnostics. Inspection of individual
  // tasks moved to the generic `akm search` / `akm show <bundle//tasks/id>`.
  // No `defaultRun`: bare `akm task` is a usage error (exit 2), the canonical
  // bare-group behavior — owner ruling 12. Run `akm task doctor` for what the
  // bare form used to run.
});
