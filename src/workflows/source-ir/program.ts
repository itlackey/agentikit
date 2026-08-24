// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { parseBuiltinCommandAction } from "../../commands/command/builtin-action";
import { applyPortableCommandArguments } from "../../commands/command/portable-template";
import type { ProgramUnit } from "../program/schema";
import type { SourceRef } from "../schema";
import type { WorkflowSourceStep } from "./schema";

/** Lower one adapter-neutral source-IR step into the shared execution unit. */
export function sourceStepProgramUnit(source: WorkflowSourceStep): ProgramUnit {
  const unit: ProgramUnit = {
    ...(source.unit ? (structuredClone(source.unit) as Omit<ProgramUnit, "source">) : {}),
    source: sourceStepRef(source),
  };
  if (source.exec) unit.exec = { ...source.exec };
  if (source.run !== undefined) {
    unit.exec = {
      command: workflowShellCommand(source.shell ?? "sh", source.run),
      ...(source.workingDirectory ? { cwd: source.workingDirectory } : {}),
    };
  }
  return unit;
}

/** Derive the instruction bytes consumed by the one workflow engine. */
export function sourceStepInstructions(source: WorkflowSourceStep): string {
  if (source.instructions !== undefined) return source.instructions;
  if (source.run !== undefined) return `Run ${source.run}.`;
  if (source.uses === "akm/command") {
    const action = parseBuiltinCommandAction(source.with);
    if (action.kind === "stored") {
      return `Invoke stored command ${action.ref}${action.arguments === undefined ? "" : " with arguments"}.`;
    }
    if (source.commandMode === "literal") return action.content;
    return applyPortableCommandArguments(action.content, action.arguments, "inline workflow command").content;
  }
  if (source.uses !== undefined) return `Invoke local target ${source.uses}.`;
  return "";
}

export function workflowShellCommand(shell: string, content: string): string[] {
  if (shell === "cmd") return ["cmd", "/d", "/s", "/c", content];
  if (shell === "pwsh" || shell === "powershell") return [shell, "-Command", content];
  return [shell, "-c", content];
}

export function sourceStepRef(source: WorkflowSourceStep): SourceRef {
  return { path: source.source.path, start: source.source.start, end: source.source.end };
}
