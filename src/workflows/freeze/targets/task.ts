// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import { parseBundleRef } from "../../../core/asset/asset-ref";
import { UsageError } from "../../../core/errors";
import { freezeExecutableIdentity } from "../../../execution/executable-identity";
import type { InputContract, TaskInputBinding } from "../../../execution/input-contract";
import { prepareTaskV3Execution } from "../../../tasks/prepare/prepare";
import { parseTaskSource } from "../../../tasks/source/parse-task-source";
import { projectTaskSourceV4 } from "../../../tasks/source/project-v4";
import type { FrozenWorkflowShellTarget, FrozenWorkflowTarget } from "../../ir/schema-v4";
import type { ProgramExec, ProgramUnit } from "../../program/schema";
import { workflowShellCommand } from "../../source-ir/program";
import type { WorkflowSourceIrV1, WorkflowSourceStep } from "../../source-ir/schema";
import { captureOwned, freezeEnvironment, guardedExecutionSource, resolveOwnedAsset } from "../environment";
import { gitIdentity } from "../identity";
import { freezeExecSpec, type ResolutionContext, type ResolvedDispatch } from "../step-values";
import { freezeTaskInputBindings } from "../task-bindings";
import { commandResult } from "./command";
import { scriptResult } from "./script";

/** The one message shared by every "cannot prove this is a valid binding surface" rejection (A-N5). */
function noDeclaredInputsError(stepId: string, ref: string): UsageError {
  return new UsageError(
    `Workflow step ${stepId} cannot pass with: to task target ${ref}; ${ref} declares no inputs.`,
    "COMPOSITION_INVALID",
  );
}

interface ResolvedTaskForComposition {
  readonly owned: Awaited<ReturnType<typeof resolveOwnedAsset>>;
  readonly task: Parameters<typeof prepareTaskV3Execution>[0];
  /** The composed task's OWN declared inputs: contract. Undefined = declares no inputs at all (A-N5). */
  readonly contract: InputContract | undefined;
}

/**
 * A-N6 (spec docs/plans/specs/p2b-input-bindings.md §1.7): LC-N1's
 * peek-and-throw (p2a §1.5) is GONE — a version: 4 target now composes.
 * `parseTaskSource` parses the YAML ONCE and routes on the SAME {root,
 * lineAt} the v3 arm always used, so a v3 composition stays byte-identical
 * (B-07, B-08). `contract` is undefined for a v3 task (which can never
 * declare `inputs:`, P2a §1.2 D2) or a v4 task with no `inputs:` key at all —
 * either way, "no declared inputs" (A-N5).
 *
 * RECORDED TENSION (spec §0, Review log): A-N5's "no declared inputs"
 * rejection is reasoned from the target's PARSED `inputs:` contract, which
 * needs the target to resolve — yet `tests/workflows/with-rejection.test.ts`
 * B-02b pins `COMPOSITION_INVALID` (not an asset-resolution error) for an
 * UNRESOLVABLE task ref with an authored `with:`. Reconciled here: an
 * authored `with:` whose target cannot even be resolved/parsed "cannot be
 * proven a valid binding surface", so it is refused the same
 * no-declared-inputs way — a `with:`-free step's resolution failure is
 * untouched and propagates as before.
 */
async function resolveTaskForComposition(
  source: WorkflowSourceStep,
  refInput: string,
  context: ResolutionContext,
): Promise<ResolvedTaskForComposition> {
  try {
    const owned = await resolveOwnedAsset(refInput, "task", context);
    const retained = captureOwned(owned, context.collector);
    const parsed = parseTaskSource({ yaml: retained.content, filePath: owned.file, workspaceRoot: owned.root });
    const contract = parsed.version === 4 ? parsed.v4.inputs : undefined;
    const task = parsed.version === 4 ? projectTaskSourceV4(parsed.v4) : parsed.v3;
    return { owned, task, contract };
  } catch (cause) {
    if (source.with !== undefined) throw noDeclaredInputsError(source.id, refInput);
    throw cause;
  }
}

export async function taskDispatch(
  source: WorkflowSourceStep,
  baseUnit: ProgramUnit,
  refInput: string,
  context: ResolutionContext,
): Promise<ResolvedDispatch> {
  const { owned, task, contract } = await resolveTaskForComposition(source, refInput, context);

  // A-N5: a with: on a target that declares no inputs: at all — a v3 task,
  // or a v4 task with no inputs: — is COMPOSITION_INVALID. Fires on ANY
  // authored with: shape, including `{}` (the check is `!== undefined`, not
  // "non-empty").
  if (source.with !== undefined && contract === undefined) {
    throw noDeclaredInputsError(source.id, refInput);
  }

  if (task.target.kind === "uses" && task.target.uses.kind === "workflow") {
    throw new UsageError("A workflow task step cannot compose a nested workflow target.", "INVALID_FLAG_VALUE");
  }

  // Lane A2 (§3.2-§3.5): normalize THIS step's own with: against THIS task's
  // OWN declared inputs — no merge across a composition chain (B-29). A v3
  // task (or a v4 task with no inputs:) has contract === undefined, so an
  // empty {} contract is used; freezeTaskInputBindings then produces no
  // bindings for it (there is nothing to bind, and the COMPOSITION_INVALID
  // check above already fired for any authored with:).
  const bindings = freezeTaskInputBindings({
    stepId: source.id,
    targetRef: refInput,
    with: source.with,
    contract: contract ?? {},
    earlierStepIds: earlierStepIds(context.sourceIr, source.id),
    declaredParamNames: declaredParamNames(context.sourceIr),
  });

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
    return withInputBindings(commandResult(source, baseUnit, prepared.invocation, context, taskLiterals), bindings);
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
    return withInputBindings(
      {
        target,
        environment,
        unit: { ...baseUnit, exec: authoredExec },
        instructions: source.instructions ?? `Run task ${owned.ref}.`,
      },
      bindings,
    );
  }
  return withInputBindings(scriptResult(source, baseUnit, prepared, context, taskLiterals), bindings);
}

/** Attach the frozen inputBindings (A-N7) to whichever target shape taskDispatch produced. Absent, never [], when empty. */
function withInputBindings(resolved: ResolvedDispatch, bindings: readonly TaskInputBinding[]): ResolvedDispatch {
  if (bindings.length === 0) return resolved;
  return {
    ...resolved,
    target: Object.freeze({ ...resolved.target, inputBindings: bindings }) as FrozenWorkflowTarget,
  };
}

/** Step ids that appear BEFORE `stepId` in the frozen step order (A-N4) — the SAME ordering map.over/inputs[] rely on. */
function earlierStepIds(sourceIr: WorkflowSourceIrV1, stepId: string): ReadonlySet<string> {
  const steps = sourceIr.jobs[0]?.steps ?? [];
  const index = steps.findIndex((step) => step.id === stepId);
  return new Set(index < 0 ? [] : steps.slice(0, index).map((step) => step.id));
}

/** THIS workflow's own declared param names (A-N4) — never an outer composing task's. */
function declaredParamNames(sourceIr: WorkflowSourceIrV1): ReadonlySet<string> {
  return new Set(sourceIr.params ? Object.keys(sourceIr.params) : []);
}
