// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure task-v3 runtime projection.
 *
 * This is the only bridge from authored task-v3 source into executable work.
 * It performs all source/config/asset reads before the task runner reserves a
 * durable attempt and returns immutable snapshots. In particular, script work
 * contains frozen bytes and their digest, never a path that can be reread when
 * a delayed or resumed dispatch begins.
 *
 * Moved body-intact out of the pre-P1b src/tasks/runtime-v3.ts (spec
 * docs/plans/specs/p1b-model-extraction.md §4.1, Lane B / D4 module map).
 * runtime-v3.ts is now a compat re-export shim; prepareTaskV3Execution's
 * three production callers (src/tasks/runner.ts, src/tasks/scheduler-sync.ts,
 * src/workflows/ir/source-freeze-v4.ts's taskDispatch) import it from here.
 */

import fs from "node:fs";
import { prepareCommandInvocation } from "../../commands/command/command-execution";
import { UsageError } from "../../core/errors";
import type { TaskV3SourceDocument } from "../source-v3";
import {
  base,
  commandEnvironmentSnapshot,
  currentExecutionValues,
  defaultTaskShell,
  environmentSnapshot,
  qualifyOwnedRef,
  resolvedOwnedAsset,
  validatePreparedCommand,
  validateWorkflowRuntimeSource,
} from "./prepare-support";
import type { PreparedTaskV3Execution, PrepareTaskV3ExecutionContext } from "./prepared-execution";
import { captureDirectoryIdentity, captureScriptTarget } from "./script-capture";

/** Project one canonical task-v3 source into immutable executable work. */
export async function prepareTaskV3Execution(
  document: TaskV3SourceDocument,
  context: PrepareTaskV3ExecutionContext,
): Promise<PreparedTaskV3Execution> {
  const environment = environmentSnapshot(document.env);
  const commandEnvironment = commandEnvironmentSnapshot(environment, context.schedulerContext);
  const common = base(document, context, environment);
  if (document.target.kind === "run") {
    const cwdIdentity = captureDirectoryIdentity(context.bundleRoot, document.target.workingDirectory);
    return Object.freeze({
      ...common,
      kind: "shell" as const,
      command: document.target.run,
      shell: document.target.shell ?? defaultTaskShell(context.platform ?? process.platform),
      cwd: cwdIdentity.realCwd,
      cwdIdentity,
    });
  }

  const target = document.target.uses;
  if (target.kind === "builtin-command") {
    const command = document.target.command;
    if (!command) throw new Error("invariant: parsed built-in command target has no command action");
    const action =
      command.kind === "stored"
        ? {
            ref: qualifyOwnedRef(command.ref, context).qualified,
            ...(command.arguments !== undefined ? { arguments: command.arguments } : {}),
          }
        : { content: command.content, ...(command.arguments !== undefined ? { arguments: command.arguments } : {}) };
    const invocation = validatePreparedCommand(
      await (context.prepareCommand ?? prepareCommandInvocation)({
        action,
        config: context.config,
        invocationKind: "task",
        current: currentExecutionValues(document, context, commandEnvironment),
        ...(context.commandSourceLoader ? { sourceLoader: context.commandSourceLoader } : {}),
      }),
      context,
    );
    return Object.freeze({ ...common, kind: "command" as const, invocation });
  }

  const { qualified } = qualifyOwnedRef(target.ref, context);
  if (target.kind === "command") {
    if (document.target.with !== undefined) {
      throw new UsageError(
        "Task v3 command refs do not accept with; use akm/command with {ref, arguments} for portable arguments.",
        "INVALID_FLAG_VALUE",
      );
    }
    const invocation = validatePreparedCommand(
      await (context.prepareCommand ?? prepareCommandInvocation)({
        action: { ref: qualified },
        config: context.config,
        invocationKind: "task",
        current: currentExecutionValues(document, context, commandEnvironment),
        ...(context.commandSourceLoader ? { sourceLoader: context.commandSourceLoader } : {}),
      }),
      context,
    );
    return Object.freeze({ ...common, kind: "command" as const, invocation });
  }
  if (target.kind === "workflow") {
    if (Object.keys(environment).length > 0) {
      throw new UsageError(
        "Task v3 workflow env cannot be consumed by the durable workflow runtime in 0.9.2; remove env or use a command target.",
        "INVALID_FLAG_VALUE",
      );
    }
    const resolved = await resolvedOwnedAsset(qualified, "workflow", context);
    validateWorkflowRuntimeSource(
      resolved.file,
      resolved.bundleRoot,
      context.readFile ?? ((targetPath: string) => fs.readFileSync(targetPath)),
    );
    return Object.freeze({
      ...common,
      kind: "workflow" as const,
      ref: qualified,
      params: Object.freeze({ ...(document.target.with ?? {}) }),
      ...(document.akm?.maxSteps !== undefined ? { maxSteps: document.akm.maxSteps } : {}),
      ...(document.akm?.maxRetries !== undefined ? { maxRetries: document.akm.maxRetries } : {}),
    });
  }
  if (document.target.with !== undefined) {
    throw new UsageError("Task v3 script refs do not accept with.", "INVALID_FLAG_VALUE");
  }
  const resolved = await resolvedOwnedAsset(qualified, "script", context);
  // Shared with prepare-script-target.ts's prepareScriptTarget() (spec §4.3):
  // one implementation of the byte/interpreter capture, not two.
  const captured = captureScriptTarget(
    qualified,
    resolved.file,
    resolved.bundleRoot,
    context.readFile ?? ((targetPath: string) => fs.readFileSync(targetPath)),
  );
  return Object.freeze({
    ...common,
    kind: "script" as const,
    sourceRef: qualified,
    ...captured,
  });
}
