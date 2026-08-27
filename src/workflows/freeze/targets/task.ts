// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import { parseBundleRef } from "../../../core/asset/asset-ref";
import { UsageError } from "../../../core/errors";
import { freezeExecutableIdentity } from "../../../execution/executable-identity";
import { prepareTaskV3Execution } from "../../../tasks/prepare/prepare";
import { readBoundedTaskSourceYaml } from "../../../tasks/source/bounded-document";
import { peekTaskSourceVersion } from "../../../tasks/source/parse-task-source";
import { TASK_SOURCE_V4_VERSION } from "../../../tasks/source/task-source-v4";
import { parseTaskV3Yaml } from "../../../tasks/source-v3";
import type { FrozenWorkflowShellTarget } from "../../ir/schema-v4";
import type { ProgramExec, ProgramUnit } from "../../program/schema";
import { workflowShellCommand } from "../../source-ir/program";
import type { WorkflowSourceStep } from "../../source-ir/schema";
import { captureOwned, freezeEnvironment, guardedExecutionSource, resolveOwnedAsset } from "../environment";
import { gitIdentity } from "../identity";
import { freezeExecSpec, type ResolutionContext, type ResolvedDispatch } from "../step-values";
import { commandResult } from "./command";
import { scriptResult } from "./script";

export async function taskDispatch(
  source: WorkflowSourceStep,
  baseUnit: ProgramUnit,
  refInput: string,
  context: ResolutionContext,
): Promise<ResolvedDispatch> {
  // P1a fail-closed correction (docs/plans/specs/p1a-with-rejection-classifier.md
  // §3.1, P0 row R-01(c)): a workflow step's with: on a task target used to be
  // silently dropped — taskDispatch never read source.with. Reject it instead,
  // before resolveOwnedAsset, so the rejection does not depend on the task
  // asset resolving. Fires on ANY authored with: shape, including `{}` (the
  // check is `!== undefined`, not "non-empty"). Task-call inputs arrive in a
  // later 0.9.x release (P2b); this rejection is temporary scaffolding for
  // that gap, not the final shape of task-call bindings.
  if (source.with !== undefined) {
    throw new UsageError(
      `Workflow step ${source.id} cannot pass with: to task target ${refInput}; task-call inputs are not supported yet.`,
      "COMPOSITION_INVALID",
    );
  }
  const owned = await resolveOwnedAsset(refInput, "task", context);
  const retained = captureOwned(owned, context.collector);
  // LC-N1 (spec docs/plans/specs/p2a-task-source-v4.md §1.5): peek the
  // source's `version` BEFORE running the full v3 grammar. taskDispatch does
  // NOT route in P2a — composing a task source v4 target from a workflow is
  // deferred to a later 0.9.x release (routing is `irVersion` work gated on
  // P2b's bindings). A cheap, independent peek here (rather than routing
  // through parseTaskSource, which would fully validate the task source v4
  // grammar before this function could react) guarantees the deferral
  // message below fires for EVERY version: 4 document, valid or not, and
  // fires before any downstream resolution of the task source v4 document's
  // own uses: (pinned by
  // tests/workflows/task-source-v4-deferral.test.ts, whose fixture's
  // uses: commands/review is deliberately unbacked by a real file). The peek
  // discards its own `{root, lineAt}` rather than threading them into the
  // v3 parse below — `parseTaskV3Yaml` keeps parsing a REAL document here,
  // unrelated to R-02's synthetic-YAML ban (tests/workflows/direct-script-typed.test.ts).
  if (
    peekTaskSourceVersion(
      readBoundedTaskSourceYaml({ yaml: retained.content, filePath: owned.file }, { sourceLabel: "task v3 source" })
        .root,
    ) === TASK_SOURCE_V4_VERSION
  ) {
    throw new UsageError(
      `Workflow step "${source.id}" targets task ${refInput}, which uses task source v4. Composing a ` +
        "task source v4 target from a workflow arrives in a later 0.9.x release; keep the " +
        "task at version 3 until then.",
      "TASK_SOURCE_INVALID",
    );
  }
  const task = parseTaskV3Yaml({ yaml: retained.content, filePath: owned.file, workspaceRoot: owned.root });
  if (task.target.kind === "uses" && task.target.uses.kind === "workflow") {
    throw new UsageError("A workflow task step cannot compose a nested workflow target.", "INVALID_FLAG_VALUE");
  }
  const prepared = await prepareTaskV3Execution(task, {
    taskId: parseBundleRef(owned.ref).conceptId.slice("tasks/".length),
    taskRef: owned.ref,
    bundleName: owned.bundle,
    bundleRoot: owned.root,
    config: context.config,
    commandSourceLoader: (ref, kind) => guardedExecutionSource(ref, kind, context),
    resolveAsset: async ({ ref, type }) => {
      const target = await resolveOwnedAsset(ref, type, context);
      captureOwned(target, context.collector);
      return { file: target.file, bundleRoot: target.root };
    },
    readFile: (file, root = owned.root) => context.collector.readBytes(file, root),
  });
  if (prepared.kind === "workflow") {
    throw new UsageError("A workflow task step cannot compose a nested workflow target.", "INVALID_FLAG_VALUE");
  }
  const taskLiterals = Object.entries(prepared.environment).map(([name, value]) =>
    Object.freeze({ kind: "literal" as const, name, value }),
  );
  if (prepared.kind === "command") {
    return commandResult(source, baseUnit, prepared.invocation, context, taskLiterals);
  }
  if (prepared.kind === "shell") {
    const authoredExec: ProgramExec = {
      command: workflowShellCommand(prepared.shell, prepared.command),
      ...(prepared.cwdIdentity.realCwd !== prepared.cwdIdentity.realRoot
        ? { cwd: path.relative(prepared.cwdIdentity.realRoot, prepared.cwdIdentity.realCwd) }
        : {}),
    };
    const exec = freezeExecSpec(source, authoredExec, context);
    const environment = Object.freeze([...taskLiterals, ...freezeEnvironment(source, authoredExec, context)]);
    const executable = freezeExecutableIdentity(exec.command[0] as string, { cwd: prepared.cwdIdentity.realCwd });
    const target: FrozenWorkflowShellTarget = Object.freeze({
      kind: "shell",
      contentHash: "",
      exec,
      cwdIdentity: prepared.cwdIdentity,
      executable,
      ...gitIdentity(baseUnit, prepared.cwdIdentity.realRoot),
    });
    return {
      target,
      environment,
      unit: { ...baseUnit, exec: authoredExec },
      instructions: source.instructions ?? `Run task ${owned.ref}.`,
    };
  }
  return scriptResult(source, baseUnit, prepared, context, taskLiterals);
}
