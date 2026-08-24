// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Display-only projection from source IR for renderer/index metadata. */

import { parseBuiltinCommandAction } from "../../commands/command/builtin-action";
import { applyPortableCommandArguments } from "../../commands/command/portable-template";
import type { ProgramDefaults, ProgramExec, ProgramUnit } from "../program/schema";
import { type SourceRef, WORKFLOW_SCHEMA_VERSION, type WorkflowDocument, type WorkflowStep } from "../schema";
import {
  decodeWorkflowSourceIrV1,
  type WorkflowSourceIrV1,
  type WorkflowSourceJob,
  type WorkflowSourceStep,
} from "./schema";
export type WorkflowSourceProjectionMode = "display";

/**
 * Project source semantics into the document consumed by display/index paths.
 * Execution consumes source IR directly and never calls this projection.
 */
export function workflowSourceIrToDocument(
  input: WorkflowSourceIrV1,
  options: { mode: WorkflowSourceProjectionMode },
): WorkflowDocument {
  const ir = decodeWorkflowSourceIrV1(input);
  void options;
  const allSteps = ir.jobs.flatMap((job) => job.steps.map((step) => ({ job, step })));
  const duplicateIds = duplicateStepIds(allSteps.map(({ step }) => step.id));
  const steps = allSteps.map(({ job, step }, sequenceIndex) => projectStep(job, step, sequenceIndex, duplicateIds));
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    ...(ir.description ? { description: ir.description } : {}),
    ...(ir.tags ? { tags: [...ir.tags] } : {}),
    ...(ir.params ? { params: clone(ir.params) as unknown as NonNullable<WorkflowDocument["params"]> } : {}),
    ...(ir.defaults ? { defaults: clone(ir.defaults) as unknown as ProgramDefaults } : {}),
    ...(ir.budget ? { budget: { ...ir.budget } } : {}),
    steps,
    ...(ir.preamble ? { preamble: ir.preamble } : {}),
    source: { path: ir.source.path, lineCount: ir.source.end },
  };
}

function projectStep(
  job: WorkflowSourceJob,
  step: WorkflowSourceStep,
  sequenceIndex: number,
  duplicateIds: ReadonlySet<string>,
): WorkflowStep {
  const id = duplicateIds.has(step.id) ? `${job.id}-${step.id}` : step.id;
  const source = toSourceRef(step.source);
  const { unit, instructions } = projectDispatch(step, source);
  const out: WorkflowStep = {
    id,
    sequenceIndex,
    ...(step.route ? { route: clone(step.route) } : {}),
    ...(step.map
      ? {
          map: {
            ...clone(step.map),
            ...(unit ? { unit } : {}),
          },
        }
      : unit
        ? { unit }
        : {}),
    ...(step.inputs ? { inputs: [...step.inputs] } : {}),
    ...(step.output ? { output: clone(step.output) as unknown as Record<string, unknown> } : {}),
    ...(step.gate?.maxLoops !== undefined ? { gate: { maxLoops: step.gate.maxLoops } } : {}),
    ...(instructions !== undefined ? { instructions: { text: instructions, source } } : {}),
    ...(step.gate?.rubric ? { gateRubric: { text: step.gate.rubric, source } } : {}),
    source,
  };
  return out;
}

function projectDispatch(step: WorkflowSourceStep, source: SourceRef): { unit?: ProgramUnit; instructions?: string } {
  if (step.route) return { instructions: step.instructions };
  const unit: ProgramUnit = {
    ...(step.unit ? (clone(step.unit) as unknown as Omit<ProgramUnit, "source">) : {}),
    source,
  };
  if (step.exec) {
    unit.exec = clone(step.exec) as ProgramExec;
    return { unit, instructions: step.instructions };
  }
  if (step.run !== undefined) {
    unit.exec = {
      command: shellCommand(step.shell, step.run),
      ...(step.workingDirectory ? { cwd: step.workingDirectory } : {}),
    };
    return { unit, instructions: step.instructions ?? `Run ${step.run}.` };
  }
  if (step.uses === "akm/command") {
    const action = parseBuiltinCommandAction(step.with);
    if (action.kind === "stored") {
      return {
        unit,
        instructions: `Invoke stored command ${action.ref}${action.arguments === undefined ? "" : " with arguments"}.`,
      };
    }
    if (step.commandMode === "literal") return { unit, instructions: action.content };
    const applied = applyPortableCommandArguments(action.content, action.arguments, "inline workflow command");
    return { unit, instructions: applied.content };
  }
  if (step.uses !== undefined) {
    return { unit, instructions: `Invoke local target ${step.uses}.` };
  }
  throw new Error(`Workflow step ${JSON.stringify(step.id)} has no displayable target.`);
}

function shellCommand(shell: WorkflowSourceStep["shell"], run: string): string[] {
  switch (shell ?? "sh") {
    case "pwsh":
    case "powershell":
      return [shell ?? "powershell", "-Command", run];
    case "cmd":
      return ["cmd", "/d", "/s", "/c", run];
    case "bash":
    case "sh":
    case "zsh":
      return [shell ?? "sh", "-c", run];
  }
}

function toSourceRef(source: WorkflowSourceStep["source"]): SourceRef {
  return { path: source.path, start: source.start, end: source.end };
}

function duplicateStepIds(ids: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return duplicates;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
