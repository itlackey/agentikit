// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import { parseFrontmatterBlock } from "../../core/asset/frontmatter";
import { classifyTaskV3Triggers, classifyTaskV3Uses } from "../../tasks/source-v3";
import { parseWorkflow } from "../parser";
import { type ProgramUnit, projectExecCore } from "../program/schema";
import type { WorkflowStep as MarkdownWorkflowStep } from "../schema";
import { type GithubWorkflowSourceOptions, parseGithubWorkflowSource } from "./github-yaml";
import { sourceFailureResult, type WorkflowSourceCompileResult, WorkflowSourceFailure } from "./result";
import {
  decodeWorkflowSourceIrV1,
  type WorkflowSourceExtensionValue,
  type WorkflowSourceIrV1,
  type WorkflowSourceSpan,
  type WorkflowSourceStep,
} from "./schema";
import { canonicalizeWorkflowWorkingDirectory, WorkflowSourceSemanticError } from "./semantics";

export type { GithubWorkflowSourceOptions } from "./github-yaml";
export { looksLikeGithubWorkflowSource } from "./github-yaml";
export type { WorkflowSourceCompileResult, WorkflowSourceError } from "./result";

export interface MarkdownWorkflowSourceOptions {
  path: string;
  workspaceRoot?: string;
}

export function compileGithubWorkflowSource(
  source: string,
  options: GithubWorkflowSourceOptions,
): WorkflowSourceCompileResult {
  try {
    return {
      ok: true,
      ir: decodeWorkflowSourceIrV1(
        parseGithubWorkflowSource(source, {
          ...options,
          classifyUses: options.classifyUses ?? classifyTaskV3Uses,
          classifyTriggers: options.classifyTriggers ?? classifyTaskV3Triggers,
        }),
        {
          workspaceRoot: options.workspaceRoot,
        },
      ),
    };
  } catch (cause) {
    return sourceFailureResult(cause, options.path);
  }
}

export function compileMarkdownWorkflowSource(
  source: string,
  options: MarkdownWorkflowSourceOptions,
): WorkflowSourceCompileResult {
  const parsed = parseWorkflow(source, {
    path: options.path,
    validateExecCwd: (value) => {
      try {
        return { ok: true, value: canonicalizeWorkflowWorkingDirectory(value, options.workspaceRoot) };
      } catch (cause) {
        if (cause instanceof WorkflowSourceSemanticError) {
          return { ok: false, code: cause.code, message: cause.message };
        }
        return {
          ok: false,
          code: "working-directory-unverifiable",
          message: cause instanceof Error ? cause.message : "working-directory cannot be physically verified.",
        };
      }
    },
  });
  if (!parsed.ok) {
    return {
      ok: false,
      errors: parsed.errors.map((error) => ({
        code: error.code ?? "invalid-markdown-workflow",
        message: error.message,
        path: options.path,
        line: error.line,
      })),
    };
  }
  try {
    const sourceSpan = wholeSourceSpan(source, options.path);
    const steps = parsed.document.steps.map((step) => markdownStep(step, options.path));
    const ir: WorkflowSourceIrV1 = {
      sourceIrVersion: 1,
      name: markdownName(source, options.path),
      ...(parsed.document.description ? { description: parsed.document.description } : {}),
      ...(parsed.document.tags ? { tags: [...parsed.document.tags] } : {}),
      ...(parsed.document.params ? { params: jsonClone(parsed.document.params) as WorkflowSourceIrV1["params"] } : {}),
      ...(parsed.document.defaults
        ? { defaults: jsonClone(parsed.document.defaults) as WorkflowSourceIrV1["defaults"] }
        : {}),
      ...(parsed.document.budget ? { budget: jsonClone(parsed.document.budget) } : {}),
      ...(parsed.document.preamble ? { preamble: parsed.document.preamble } : {}),
      triggers: [{ kind: "workflow_dispatch", source: sourceSpan }],
      jobs: [
        {
          id: "contract",
          needs: [],
          steps,
          source: sourceSpan,
        },
      ],
      extensions: {
        "akm.dev/workflow-markdown": jsonExtension({
          workflowSchemaVersion: parsed.document.schemaVersion,
        }),
      },
      source: sourceSpan,
    };
    return {
      ok: true,
      ir: decodeWorkflowSourceIrV1(ir, { workspaceRoot: options.workspaceRoot }),
    };
  } catch (cause) {
    return sourceFailureResult(cause, options.path);
  }
}

/** Compile by authoritative source extension without rewriting either format. */
export function compileWorkflowSource(
  source: string,
  options: GithubWorkflowSourceOptions,
): WorkflowSourceCompileResult {
  const extension = path.extname(options.path).toLowerCase();
  if (extension === ".md") return compileMarkdownWorkflowSource(source, options);
  if (extension === ".yml") return compileGithubWorkflowSource(source, options);
  return {
    ok: false,
    errors: [
      {
        code: "unsupported-workflow-extension",
        message: `Workflow source ${options.path} must use .md or .yml.`,
        path: options.path,
        line: 1,
      },
    ],
  };
}

function markdownStep(step: MarkdownWorkflowStep, filePath: string): WorkflowSourceStep {
  const source = step.source ?? { path: filePath, start: 1, end: 1 };
  const dispatchUnit = step.map?.unit ?? step.unit;
  const unit = markdownUnit(dispatchUnit);
  const common: Omit<WorkflowSourceStep, "uses" | "run" | "exec" | "source"> & {
    source: WorkflowSourceSpan;
  } = {
    id: step.id,
    ...(unit ? { unit } : {}),
    ...(step.map
      ? {
          map: {
            over: step.map.over,
            ...(step.map.concurrency !== undefined ? { concurrency: step.map.concurrency } : {}),
            ...(step.map.reducer !== undefined ? { reducer: step.map.reducer } : {}),
          },
        }
      : {}),
    ...(step.route ? { route: jsonClone(step.route) } : {}),
    ...(step.inputs ? { inputs: [...step.inputs] } : {}),
    ...(step.output ? { output: jsonClone(step.output) as WorkflowSourceStep["output"] } : {}),
    ...(step.gate || step.gateRubric
      ? {
          gate: {
            ...(step.gate?.maxLoops !== undefined ? { maxLoops: step.gate.maxLoops } : {}),
            ...(step.gateRubric?.text.trim() ? { rubric: step.gateRubric.text } : {}),
          },
        }
      : {}),
    source,
  };
  if (step.route) {
    return {
      ...common,
      ...(step.instructions?.text.trim() ? { instructions: step.instructions.text } : {}),
    };
  }
  if (dispatchUnit?.exec) {
    return {
      ...common,
      exec: projectExecCore(dispatchUnit.exec),
      ...(step.instructions?.text.trim() ? { instructions: step.instructions.text } : {}),
    };
  }
  const content = step.instructions?.text ?? "";
  if (content.trim() === "") {
    throw new WorkflowSourceFailure(
      "markdown-command-content-required",
      `Markdown step ${JSON.stringify(step.id)} has no executable command content.`,
      source,
    );
  }
  return {
    ...common,
    uses: "akm/command",
    commandMode: "literal",
    with: { content },
  };
}

function markdownUnit(value: ProgramUnit | undefined): WorkflowSourceStep["unit"] {
  if (!value) return undefined;
  const { exec: _exec, source: _source, ...unit } = value;
  return Object.keys(unit).length > 0
    ? (jsonClone(unit) as unknown as NonNullable<WorkflowSourceStep["unit"]>)
    : undefined;
}

function markdownName(source: string, filePath: string): string {
  const block = parseFrontmatterBlock(source);
  const body = block?.content ?? source;
  const title = body.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim();
  if (title) return title;
  return path.basename(filePath, path.extname(filePath));
}

function wholeSourceSpan(source: string, filePath: string): WorkflowSourceSpan {
  return { path: filePath, start: 1, end: Math.max(1, source.split(/\r?\n/).length) };
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function jsonExtension(value: unknown): WorkflowSourceExtensionValue {
  return JSON.parse(JSON.stringify(value)) as WorkflowSourceExtensionValue;
}
