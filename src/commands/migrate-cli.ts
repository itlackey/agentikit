// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { defineGroupCommand, defineJsonCommand, EXIT_CODES, output } from "../cli/shared";
import { runMigrationTool } from "./migration-tool";

/**
 * One subprocess call into the standalone task migrator. Returns the raw
 * exit status alongside the parsed JSON plan the child printed on stdout
 * (absent when the child produced none — e.g. a hard failure before its own
 * `printPlan` ran, whose `{ok:false,...}` envelope already went to stderr).
 */
export interface MigrateToolCall {
  readonly status: number;
  readonly plan?: Record<string, unknown>;
}

async function callMigrateTool(args: string[]): Promise<MigrateToolCall> {
  const result = await runMigrationTool(args);
  if (result.stderr) process.stderr.write(result.stderr);
  const resultLine = result.stdout.trim();
  if (!resultLine) return { status: result.status };
  try {
    return { status: result.status, plan: JSON.parse(resultLine) as Record<string, unknown> };
  } catch {
    console.log(resultLine);
    return { status: result.status };
  }
}

type PlanStatus = "current" | "ready" | "blocked";

function worstStatus(left: PlanStatus, right: PlanStatus): PlanStatus {
  if (left === "blocked" || right === "blocked") return "blocked";
  if (left === "ready" || right === "ready") return "ready";
  return "current";
}

/**
 * Resolve one generation's contribution to the combined status — fail
 * CLOSED, never open (code-review finding: this tool advertises itself as
 * "blocked-not-guessed").
 *
 * A generation that exited SUCCESS with no plan on stdout legitimately means
 * "nothing to report" and defaults to `"current"`. A generation that exited
 * NON-SUCCESS (by the caller's own guard, this can only be `EXIT_CODES.
 * GENERAL` — the "blocked" code) with a parsed `plan.status` reports that
 * status verbatim, same as before.
 *
 * The gap this closes: NON-SUCCESS with NO parseable plan at all —
 * `runMigrationTool` coerces a `spawnSync` `status` of `null` (the child was
 * killed by a signal — OOM, a timeout, a manual kill — never scheduled to
 * exit) to `1`, indistinguishable from the migrator's own legitimate
 * "blocked" exit code, and truncated/malformed stdout hits the same
 * `JSON.parse` catch in `callMigrateTool`. Previously `?? "current"` silently
 * read a crashed generation as "nothing to migrate"; this reports it as
 * `"blocked"` with an explanatory blocker instead, so the combined exit code
 * (`EXIT_CODES.GENERAL` below) actually reflects that the generation's real
 * state is unknown, rather than reporting success at exit 0.
 */
export function resolveGenerationStatus(call: MigrateToolCall, label: string): { status: PlanStatus; error?: string } {
  const planStatus = call.plan?.status as PlanStatus | undefined;
  if (planStatus !== undefined) return { status: planStatus };
  if (call.status !== EXIT_CODES.SUCCESS) {
    return {
      status: "blocked",
      error: `${label}: the child process exited without printing a plan (exit status ${call.status}) — its real migration state is unknown.`,
    };
  }
  return { status: "current" };
}

/**
 * Run BOTH migration generations — task-v2-to-v3, then task-v3-to-task-
 * source-v4 — and print one combined plan (spec
 * docs/plans/specs/p4-deletions-closeout.md §3.2.5, rows B-31/B-32).
 *
 * Each generation is its OWN subprocess call into the standalone migrator
 * (`scripts/akm-migrate.ts`'s `status`/`apply` and `task-v4-status`/
 * `task-v4-apply` verbs, UNCHANGED — row B-33), so each keeps its own
 * `withConfigLock` + `O_EXCL` backup root + prevalidate + TOCTOU recheck +
 * atomic replace + reverse rollback + convergence check, and the two are
 * NEVER interleaved. The two calls are unconditional and independent of
 * each other's outcome: a blocked (or otherwise incomplete) generation-1
 * result does not stop generation 2 from running against whatever is
 * already task source v4 — exactly `akm-migrate status`/`task-v4-status`
 * (or `apply`/`task-v4-apply`) run back to back by hand. Only a genuine
 * hard failure (a status neither SUCCESS nor the "blocked" GENERAL code —
 * a config error, a crash) aborts the second call, since generation 1 never
 * got to look at a stable tree in that case.
 */
async function runMigrateSubcommand(
  command: "migrate-status" | "migrate-apply",
  genOneArgs: string[],
  genTwoArgs: string[],
): Promise<void> {
  const first = await callMigrateTool(genOneArgs);
  if (first.status !== EXIT_CODES.SUCCESS && first.status !== EXIT_CODES.GENERAL) {
    process.exitCode = first.status;
    return;
  }

  const second = await callMigrateTool(genTwoArgs);
  if (second.status !== EXIT_CODES.SUCCESS && second.status !== EXIT_CODES.GENERAL) {
    process.exitCode = second.status;
    return;
  }

  if (!first.plan && !second.plan) {
    if (first.status !== EXIT_CODES.SUCCESS) process.exitCode = first.status;
    return;
  }

  const firstResolved = resolveGenerationStatus(first, "task-v2-to-v3");
  const secondResolved = resolveGenerationStatus(second, "task-v3-to-task-source-v4");
  const combined = {
    schemaVersion: 1 as const,
    status: worstStatus(firstResolved.status, secondResolved.status),
    blockers: [
      ...(firstResolved.error ? [firstResolved.error] : []),
      ...((first.plan?.blockers as string[] | undefined) ?? []),
      ...(secondResolved.error ? [secondResolved.error] : []),
      ...((second.plan?.blockers as string[] | undefined) ?? []),
    ],
    taskV3Migration: first.plan?.taskV3Migration,
    taskV4Migration: second.plan?.taskV4Migration,
    ...(first.plan?.backupPath !== undefined ? { backupPath: first.plan.backupPath } : {}),
    ...(first.plan?.applied !== undefined ? { applied: first.plan.applied } : {}),
    ...(second.plan?.backupPath !== undefined ? { taskV4BackupPath: second.plan.backupPath } : {}),
    ...(second.plan?.applied !== undefined ? { taskV4Applied: second.plan.applied } : {}),
  };
  output(command, combined);

  if (combined.status === "blocked") process.exitCode = EXIT_CODES.GENERAL;
}

export const migrateCommand = defineGroupCommand({
  meta: { name: "migrate", description: "Inspect or apply task-v2 and task-v3 sources to task source v4" },
  subCommands: {
    status: defineJsonCommand({
      meta: { name: "status", description: "Read-only task-v2 and task-v3 migration check" },
      run() {
        return runMigrateSubcommand("migrate-status", ["status"], ["task-v4-status"]);
      },
    }),
    apply: defineJsonCommand({
      meta: {
        name: "apply",
        description: "Back up and atomically convert task-v2 and task-v3 files to task source v4",
      },
      args: {
        "dry-run": {
          type: "boolean",
          default: false,
          description: "Run the same eligibility checks without mutation.",
        },
      },
      run({ args }) {
        const dryRunFlag = args.dryRun ? ["--dry-run"] : [];
        return runMigrateSubcommand("migrate-apply", ["apply", ...dryRunFlag], ["task-v4-apply", ...dryRunFlag]);
      },
    }),
  },
  // No `defaultRun`: bare `akm migrate` is a usage error (exit 2). This group
  // already threw its own hand-rolled UsageError; it now shares the canonical
  // one from `defineGroupCommand` so the message and hint match every other
  // group — owner ruling 12.
});
