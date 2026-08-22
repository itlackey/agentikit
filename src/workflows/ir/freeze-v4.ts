// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { detectAdapterId } from "../../core/adapter/detect-adapter";
import { assetPathForName } from "../../core/asset/asset-placement";
import { parseBundleRef } from "../../core/asset/asset-ref";
import { isWithin } from "../../core/common";
import type { AkmConfig } from "../../core/config/config";
import { parseEnvRef } from "../../core/env-secret-ref";
import { UsageError } from "../../core/errors";
import { type GuardedExecutionSource, GuardedExecutionSourceCollector } from "../../execution/guarded-source";
import type { ExecutionJsonObject } from "../../execution/json";
import { canonicalResolvedExecutionRequest } from "../../execution/resolved-request";
import { deriveInstallations } from "../../indexer/installations";
import { resolveSourceEntries } from "../../indexer/search/search-source";
import { prepareInlineExecutionWithRunner } from "../../integrations/agent/inline-execution";
import { resolveSourcesForOrigin } from "../../registry/origin-resolve";
import { frozenWorkflowRunner } from "../exec/unit-dispatch";
import type { WorkflowAsset } from "../runtime/workflow-asset-loader";
import { freezeWorkflowEnvironment } from "./environment-v4";
import { compileResolveFreezeWorkflow, type FrozenWorkflow } from "./freeze";
import { canonicalJson } from "./plan-hash";
import type { FrozenEngineSnapshot, IrExecSpec, IrUnitNode, WorkflowPlanGraph } from "./schema";
import {
  decodeWorkflowPlanV4,
  type FrozenWorkflowDirectoryIdentity,
  type FrozenWorkflowEnvironmentBinding,
  type IrExecNodeV4,
  type IrStepPlanV4,
  type IrUnitNodeV4,
  WORKFLOW_IR_V4_VERSION,
  type WorkflowPlanGraphV4,
} from "./schema-v4";

export interface FrozenWorkflowV4 extends Omit<FrozenWorkflow, "plan"> {
  readonly plan: WorkflowPlanGraphV4;
  /** Retained in-memory read set used for the final pre-publication CAS. */
  readonly sourceCollector: GuardedExecutionSourceCollector;
}

export interface FreezeWorkflowV4Options {
  readonly sourceCollector?: GuardedExecutionSourceCollector;
}

/**
 * Additive v4 freeze entry point. It deliberately builds on the byte-stable v3
 * graph compiler, then freezes the extra durable execution material without
 * changing any v3 canonical encoding or resume behavior.
 */
export function compileResolveFreezeWorkflowV4(
  asset: WorkflowAsset,
  config: AkmConfig,
  options: FreezeWorkflowV4Options = {},
): FrozenWorkflowV4 {
  const sourceCollector = options.sourceCollector ?? new GuardedExecutionSourceCollector();
  const workflowSource = captureWorkflowSource(asset, sourceCollector);
  const v3 = compileResolveFreezeWorkflow(asset, config);
  const steps = v3.plan.steps.map((step): IrStepPlanV4 => {
    if (!step.root) {
      const { root: _root, ...withoutRoot } = step;
      return withoutRoot;
    }
    const root: IrExecNodeV4 =
      step.root.kind === "map"
        ? {
            ...step.root,
            template: freezeUnitV4(step.root.template, v3.plan, asset, config, sourceCollector),
          }
        : freezeUnitV4(step.root, v3.plan, asset, config, sourceCollector);
    return { ...step, root };
  });
  const plan = decodeWorkflowPlanV4({
    ...v3.plan,
    irVersion: WORKFLOW_IR_V4_VERSION,
    sourceReadSet: [sourceSnapshot(workflowSource)],
    steps,
  });
  return Object.freeze({
    ...v3,
    plan,
    sourceCollector,
  });
}

function captureWorkflowSource(
  asset: WorkflowAsset,
  collector: GuardedExecutionSourceCollector,
): GuardedExecutionSource {
  const root = path.resolve(asset.sourcePath);
  const file = path.resolve(asset.path);
  collector.trackDirectory(root, root);
  const parent = path.dirname(file);
  const relativeParent = path.relative(root, parent);
  if (relativeParent.startsWith("..") || path.isAbsolute(relativeParent)) {
    throw new UsageError(`${file} resolves outside its workflow source root.`, "PATH_ESCAPE_VIOLATION");
  }
  let current = root;
  if (relativeParent !== "") {
    for (const segment of relativeParent.split(path.sep)) {
      current = path.join(current, segment);
      collector.trackDirectory(current, root);
    }
  }
  const captured = collector.capture(file, root, { authored: true });
  const parsed = parseBundleRef(asset.ref);
  if (!parsed.bundle || !asset.adapterId) {
    throw new UsageError(
      `Workflow ${asset.ref} has no fully-qualified bundle/adapter owner for durable publication.`,
      "INVALID_FLAG_VALUE",
    );
  }
  return collector.bindIdentity(file, root, {
    ref: asset.ref,
    bundle: parsed.bundle,
    adapter: asset.adapterId,
    file: captured.relativePath,
    hash: captured.sha256,
  });
}

function sourceSnapshot(source: GuardedExecutionSource): WorkflowPlanGraphV4["sourceReadSet"][number] {
  if (!source.identity) throw new Error("durable workflow source has no bound logical identity");
  return Object.freeze({
    identity: source.identity,
    containmentPhysicalIdentity: source.containmentPhysicalIdentity,
    physicalIdentity: source.physicalIdentity,
    size: source.size,
  });
}

function freezeUnitV4(
  unit: IrUnitNode,
  plan: WorkflowPlanGraph,
  asset: WorkflowAsset,
  config: AkmConfig,
  sourceCollector: GuardedExecutionSourceCollector,
): IrUnitNodeV4 {
  if (unit.exec) return freezeExecUnit(unit, unit.exec, asset, config, sourceCollector);
  const invocation = unit.invocation;
  if (!invocation) throw new Error(`workflow unit ${unit.id} has neither exec nor invocation material`);
  const engine = plan.execution.engines[invocation.engine];
  if (!engine) throw new Error(`workflow unit ${unit.id} has no frozen engine ${invocation.engine}`);
  const fallbackEngine = fallbackFor(engine, plan.execution.engines);
  const runner = frozenWorkflowRunner({ engine, invocation, ...(fallbackEngine ? { fallbackEngine } : {}) });
  const projectsInvocationModel = Object.hasOwn(invocation, "modelPresent")
    ? invocation.modelPresent === true
    : invocation.model !== null;
  const current = {
    ...(unit.schema ? { outputSchema: unit.schema as ExecutionJsonObject } : {}),
    timeout: invocation.timeoutMs,
    ...(projectsInvocationModel ? { model: invocation.model } : {}),
    ...(Object.hasOwn(invocation, "llm") ? { inference: invocation.llm as unknown as ExecutionJsonObject } : {}),
  };
  const environment = freezeUnitEnvironment(unit.env ?? [], [], config, sourceCollector);
  const prepared = prepareInlineExecutionWithRunner({
    content: unit.instructions,
    runner,
    invocationKind: "workflow",
    current,
    ...(engine.kind === "agent" ? { sdkFallbackModelFromRequest: engine.sdkFallbackModelFromRequest === true } : {}),
  });
  return Object.freeze({
    ...unit,
    frozenTarget: Object.freeze({
      kind: "command" as const,
      ref: null,
      contentHash: createHash("sha256").update(prepared.request.command.content).digest("hex"),
      request: JSON.parse(canonicalResolvedExecutionRequest(prepared.request)),
      runner: prepared.runner,
    }),
    environment: Object.freeze(environment),
  });
}

function freezeExecUnit(
  unit: IrUnitNode,
  exec: IrExecSpec,
  asset: WorkflowAsset,
  config: AkmConfig,
  sourceCollector: GuardedExecutionSourceCollector,
): IrUnitNodeV4 {
  if (exec.inheritEnv) {
    throw new UsageError(
      `Workflow unit ${unit.id} uses inheritEnv, which durable v4 forbids. Use named pass_env or env refs.`,
      "INVALID_FLAG_VALUE",
    );
  }
  const environment = freezeUnitEnvironment(unit.env ?? [], exec.passEnv ?? [], config, sourceCollector);
  const cwdIdentity = freezeDirectoryIdentity(asset.sourcePath, exec.cwd);
  const contentHash = createHash("sha256")
    .update("akm.workflow.shell.v1\0")
    .update(canonicalJson({ exec, environment, cwdIdentity }))
    .digest("hex");
  return Object.freeze({
    ...unit,
    frozenTarget: Object.freeze({ kind: "shell" as const, contentHash, cwdIdentity }),
    environment: Object.freeze(environment),
  });
}

function freezeUnitEnvironment(
  refs: readonly string[],
  passThrough: readonly string[],
  config: AkmConfig,
  collector: GuardedExecutionSourceCollector,
): FrozenWorkflowEnvironmentBinding[] {
  const named: FrozenWorkflowEnvironmentBinding[] = passThrough.map((name) =>
    Object.freeze({ kind: "pass-through" as const, name }),
  );
  if (refs.length === 0) return named;
  const sources = resolveSourceEntries(undefined, config);
  const installations = deriveInstallations(sources);
  return [
    ...named,
    ...freezeWorkflowEnvironment(refs, {
      collector,
      resolveRef: (input) => {
        const parsed = parseEnvRef(input);
        if (parsed.type !== "env") {
          throw new UsageError(`Expected an env ref; got ${JSON.stringify(input)}.`, "INVALID_FLAG_VALUE");
        }
        const candidates = resolveSourcesForOrigin(parsed.origin, sources);
        for (const source of candidates) {
          const envRoot = path.join(source.path, "env");
          const envPath = assetPathForName("env", envRoot, parsed.name);
          if (!isWithin(envPath, envRoot) || !fs.existsSync(envPath)) continue;
          const sourceIndex = sources.indexOf(source);
          const installation = installations[sourceIndex];
          if (!installation) continue;
          const adapter = source.adapterId ?? detectAdapterId(source.path);
          return {
            ref: `${installation.id}//env/${parsed.name}`,
            bundle: installation.id,
            adapter,
            root: source.path,
            path: envPath,
          };
        }
        throw new UsageError(`Workflow environment ref ${JSON.stringify(input)} was not found.`, "INVALID_FLAG_VALUE");
      },
    }),
  ];
}

function fallbackFor(
  engine: FrozenEngineSnapshot,
  engines: Readonly<Record<string, FrozenEngineSnapshot>>,
): Extract<FrozenEngineSnapshot, { kind: "llm" }> | undefined {
  if (engine.kind !== "agent" || !engine.fallbackLlmEngine) return undefined;
  const fallback = engines[engine.fallbackLlmEngine];
  if (!fallback || fallback.kind !== "llm") {
    throw new Error(`frozen SDK engine ${engine.name} has no LLM fallback snapshot`);
  }
  return fallback;
}

function freezeDirectoryIdentity(rootInput: string, relativeCwd?: string): FrozenWorkflowDirectoryIdentity {
  const requestedRoot = path.resolve(rootInput);
  const requestedCwd = path.resolve(requestedRoot, relativeCwd ?? ".");
  const lexical = path.relative(requestedRoot, requestedCwd);
  if (lexical.startsWith("..") || path.isAbsolute(lexical)) {
    throw new UsageError(`${requestedCwd} resolves outside its workflow execution root.`, "PATH_ESCAPE_VIOLATION");
  }
  const realRoot = fs.realpathSync(requestedRoot);
  const realCwd = fs.realpathSync(requestedCwd);
  const physical = path.relative(realRoot, realCwd);
  if (physical.startsWith("..") || path.isAbsolute(physical)) {
    throw new UsageError(`${requestedCwd} escapes its physical workflow execution root.`, "PATH_ESCAPE_VIOLATION");
  }
  const rootStat = fs.statSync(realRoot, { bigint: true });
  const cwdStat = fs.statSync(realCwd, { bigint: true });
  if (!rootStat.isDirectory() || !cwdStat.isDirectory()) {
    throw new UsageError("Workflow execution root and cwd must both be directories.", "INVALID_FLAG_VALUE");
  }
  return Object.freeze({
    requestedRoot,
    realRoot,
    rootDevice: String(rootStat.dev),
    rootInode: String(rootStat.ino),
    requestedCwd,
    realCwd,
    cwdDevice: String(cwdStat.dev),
    cwdInode: String(cwdStat.ino),
  });
}
