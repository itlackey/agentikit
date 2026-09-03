// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { parseBuiltinCommandAction } from "../../commands/command/builtin-action";
import { PORTABLE_ARGUMENTS_PLACEHOLDER } from "../../commands/command/portable-template";
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

/**
 * Derive the instruction bytes consumed by the one workflow engine.
 *
 * A `portable-template` inline command's `$ARGUMENTS` placeholder is still
 * substituted here (matching what dispatch will do), but WITHOUT the native
 * construct scan `applyPortableCommandArguments` also performs (issue 4):
 * that scan exists to catch a STANDALONE command file accidentally carrying
 * native-tool-only syntax it will never expand. Inline workflow prose is
 * authored for akm alone — `@docs/style-guide.md` is just a file reference in
 * prose, not a broken portable template — so scanning it here bought only
 * false positives, exactly as `.md` steps (always `commandMode: "literal"`,
 * `source-ir/compile.ts`) already prove: identical prose containing a bare
 * `@file` mention compiles fine when it isn't routed through this scan.
 */
export function sourceStepInstructions(source: WorkflowSourceStep): string {
  if (source.instructions !== undefined) return source.instructions;
  if (source.run !== undefined) return `Run ${source.run}.`;
  if (source.uses === "akm/command") {
    const action = parseBuiltinCommandAction(source.with);
    if (action.kind === "stored") {
      return `Invoke stored command ${action.ref}${action.arguments === undefined ? "" : " with arguments"}.`;
    }
    if (source.commandMode === "literal") return action.content;
    return action.content.split(PORTABLE_ARGUMENTS_PLACEHOLDER).join(action.arguments ?? "");
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
