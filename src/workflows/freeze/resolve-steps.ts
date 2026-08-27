// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { ConfigError, UsageError } from "../../core/errors";
import { prepareInlineExecution } from "../../integrations/agent/inline-execution";
import { sourceStepProgramUnit, sourceStepRef } from "../source-ir/program";
import type { WorkflowSourceStep } from "../source-ir/schema";
import { classifyWorkflowStepUses } from "../source-ir/semantics";
import { qualifyRef } from "./environment";
import type { ResolutionContext, ResolvedDispatch } from "./step-values";
import { commandDispatch, commandResult, inlineDispatch } from "./targets/command";
import { directScript } from "./targets/script";
import { directShell } from "./targets/shell";
import { taskDispatch } from "./targets/task";

export async function resolveStep(source: WorkflowSourceStep, context: ResolutionContext): Promise<ResolvedDispatch> {
  const baseUnit = sourceStepProgramUnit(source);
  if (source.exec || source.run !== undefined) return directShell(source, baseUnit, context);
  if (!source.uses) return inlineDispatch(source, baseUnit, context);
  const target = classifyWorkflowStepUses(source.uses);
  if (target.kind === "task") return taskDispatch(source, baseUnit, target.ref, context);
  if (target.kind === "script") return directScript(source, baseUnit, target.ref, context);
  if (target.kind === "command" || target.kind === "builtin-command") {
    const action =
      target.kind === "builtin-command"
        ? source.with
        : { ref: qualifyRef(target.ref, "commands", context.asset, context.config) };
    return commandDispatch(source, baseUnit, action, context);
  }
  throw new UsageError(`Workflow target ${source.uses} is not executable in 0.9.2.`, "INVALID_FLAG_VALUE");
}

export function resolveJudge(source: WorkflowSourceStep, context: ResolutionContext): ResolvedDispatch {
  const engine = context.config.workflow?.judgeEngine;
  if (!engine) {
    throw new ConfigError(
      "This workflow declares completion criteria but no verification engine is configured. Set workflow.judgeEngine to a named LLM or agent engine.",
      "INVALID_CONFIG_FILE",
    );
  }
  const content = source.gate?.rubric?.trim() ?? "Judge workflow completion.";
  const prepared = prepareInlineExecution({
    content,
    config: context.config,
    invocationKind: "workflow",
    current: { engine },
  });
  return commandResult(source, { onError: "fail", source: sourceStepRef(source) }, prepared, context);
}
