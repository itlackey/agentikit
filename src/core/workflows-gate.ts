// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Release gate for the workflow feature (0.9.2 only — remove in 0.9.3).
 *
 * 0.9.2 ships with the workflow feature disabled; it returns in 0.9.3.
 * Rather than tearing the feature out (and putting it back one release
 * later), every entry point calls {@link assertWorkflowsEnabled} and fails
 * closed with a message naming the re-enable release. The gated entry
 * points are:
 *
 *   - the six `akm workflow` subcommands (src/commands/workflow-cli.ts),
 *     which also covers OS-scheduler firings — scheduled workflow triggers
 *     invoke `akm workflow run <ref>` (src/tasks/scheduler-binding.ts);
 *   - `akm task add --workflow <ref>` (src/commands/tasks/tasks.ts);
 *   - the task runner's workflow dispatch branch (src/tasks/runner.ts),
 *     which covers pre-existing and YAML-authored workflow-bound tasks.
 *
 * Everything passive stays on: workflow assets remain indexed, searchable,
 * showable, and lintable (`akm lint --type workflows`), and `akm task sync`
 * still validates them — so users can keep authoring for 0.9.3.
 *
 * The env escape hatch exists for two reasons: the test suite enables it
 * process-wide (tests/_preload.ts) so the workflow suites keep running
 * against the real implementation, and 0.9.1 users who depend on workflows
 * have a release valve instead of a hard strand.
 */

import { UsageError } from "./errors";

/** Escape hatch: set to `1` to re-enable workflows despite the 0.9.2 gate. */
export const WORKFLOWS_ENABLE_ENV = "AKM_ENABLE_WORKFLOWS";

/** True when the 0.9.2 gate is lifted via {@link WORKFLOWS_ENABLE_ENV}. */
export function workflowsEnabled(): boolean {
  return process.env[WORKFLOWS_ENABLE_ENV] === "1";
}

/**
 * Fail closed with the release notice unless the escape hatch is set. The
 * thrown `UsageError` renders through the standard JSON envelope (exit 2),
 * the same path retired-command spellings use.
 */
export function assertWorkflowsEnabled(): void {
  if (workflowsEnabled()) return;
  throw new UsageError(
    "Workflows are disabled in akm 0.9.2 and will be re-enabled in 0.9.3.",
    "WORKFLOWS_DISABLED",
    "Workflow assets stay indexed, searchable, and lintable (`akm lint --type workflows`); " +
      "only execution and run management are paused. " +
      `Set ${WORKFLOWS_ENABLE_ENV}=1 to opt back in early, at your own risk.`,
  );
}
