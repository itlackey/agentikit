// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AkmConfig } from "../../core/config/config-types";
import {
  createInlineResolvedCommand,
  type ResolvedConversationMessage,
  type ResolvedExecutionRequestV1,
  type ResolvedPersonaContent,
} from "../../execution/resolved-request";
import type { UnresolvedExecutionDefaults } from "../../execution/source";
import type { ExecutionInvocationKind, ResolvedExecutionPlanV1, ToolAuthorizer } from "./execution-cascade";
import { executionEngineDefinitionFromRunner } from "./execution-definitions";
import { planPreparedExecution, prepareResolvedExecution } from "./execution-preparation";
import { MODEL_MAP_VERSION, type ResolvedModelMapV1 } from "./model-map";
import type { RunnerSpec } from "./runner";

export interface PrepareInlineExecutionOptions {
  readonly content: string;
  readonly argumentInput?: string;
  readonly config: AkmConfig;
  readonly invocationKind: ExecutionInvocationKind;
  readonly conversation?: readonly Readonly<ResolvedConversationMessage>[];
  readonly persona?: ResolvedPersonaContent | null;
  readonly invocationDefaults?: UnresolvedExecutionDefaults;
  readonly current?: UnresolvedExecutionDefaults;
  readonly modelMap?: ResolvedModelMapV1;
  readonly authorizeTools?: ToolAuthorizer;
}

export interface PrepareInlineExecutionWithRunnerOptions {
  readonly content: string;
  readonly argumentInput?: string;
  readonly runner: RunnerSpec;
  readonly invocationKind: ExecutionInvocationKind;
  readonly conversation?: readonly Readonly<ResolvedConversationMessage>[];
  readonly persona?: ResolvedPersonaContent | null;
  readonly invocationDefaults?: UnresolvedExecutionDefaults;
  readonly current?: UnresolvedExecutionDefaults;
  readonly modelMap?: ResolvedModelMapV1;
  readonly authorizeTools?: ToolAuthorizer;
}

export interface PreparedInlineExecution {
  readonly plan: ResolvedExecutionPlanV1;
  readonly request: ResolvedExecutionRequestV1;
  readonly config: AkmConfig;
  readonly fallbackEngineName?: string;
}

export interface PreparedInlineExecutionWithRunner {
  readonly plan: ResolvedExecutionPlanV1;
  readonly request: ResolvedExecutionRequestV1;
  readonly runner: RunnerSpec;
}

const EMPTY_EXACT_MODEL_MAP: ResolvedModelMapV1 = Object.freeze({
  version: MODEL_MAP_VERSION,
  aliases: Object.freeze(Object.create(null)) as Readonly<
    Record<string, Readonly<Record<string, { readonly model: string }>>>
  >,
});

function own(value: object, key: PropertyKey): boolean {
  return Object.hasOwn(value, key);
}

/**
 * Resolve anonymous command content through the same far-to-near cascade used
 * by stored commands. Tasks, workflows, and internal model work adapt their
 * already-rendered content here rather than rebuilding engine/model precedence.
 */
export function prepareInlineExecution(options: PrepareInlineExecutionOptions): PreparedInlineExecution {
  const command = createInlineResolvedCommand({
    template: options.content,
    ...(own(options, "argumentInput") ? { argumentInput: options.argumentInput as string } : {}),
    content: options.content,
  });
  return prepareResolvedExecution({
    command,
    config: options.config,
    invocationKind: options.invocationKind,
    ...(own(options, "conversation") ? { conversation: options.conversation } : {}),
    ...(own(options, "persona") ? { persona: options.persona } : {}),
    commandLayer: { id: "inline-command", values: {} },
    ...(options.invocationDefaults ? { invocationDefaults: options.invocationDefaults } : {}),
    ...(options.current ? { current: options.current } : {}),
    ...(options.modelMap ? { modelMap: options.modelMap } : {}),
    ...(options.authorizeTools ? { authorizeTools: options.authorizeTools } : {}),
  });
}

/**
 * Prepare anonymous work from an already-resolved runner without reading live
 * config or interpreting aliases. Used by resume-safe workflow/judge and by
 * improve/proposal calls that already froze runner material.
 */
export function prepareInlineExecutionWithRunner(
  options: PrepareInlineExecutionWithRunnerOptions,
): PreparedInlineExecutionWithRunner {
  const command = createInlineResolvedCommand({
    template: options.content,
    ...(own(options, "argumentInput") ? { argumentInput: options.argumentInput as string } : {}),
    content: options.content,
  });
  const material = executionEngineDefinitionFromRunner(options.runner);
  const engines = Object.create(null) as Record<string, typeof material.definition>;
  Object.defineProperty(engines, material.engineName, {
    value: material.definition,
    enumerable: true,
    configurable: false,
    writable: false,
  });
  const plan = planPreparedExecution({
    command,
    ...(own(options, "conversation") ? { conversation: options.conversation } : {}),
    ...(own(options, "persona") ? { persona: options.persona } : {}),
    installationEngine: material.engineName,
    commandLayer: { id: "inline-command", values: {} },
    ...(options.invocationDefaults ? { invocationDefaults: options.invocationDefaults } : {}),
    ...(options.current ? { current: options.current } : {}),
    engines: Object.freeze(engines),
    modelMap: options.modelMap ?? EMPTY_EXACT_MODEL_MAP,
    invocationKind: options.invocationKind,
    ...(options.authorizeTools ? { authorizeTools: options.authorizeTools } : {}),
  });
  return Object.freeze({ plan, request: plan.request, runner: material.runner });
}
