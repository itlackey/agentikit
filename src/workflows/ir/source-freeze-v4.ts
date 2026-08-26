// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type PreparedCommandInvocation, prepareCommandInvocation } from "../../commands/command/command-execution";
import { loadAdapterExecutionSource } from "../../commands/command/execution-source-loader";
import { makeBundleRef, parseBundleRef } from "../../core/asset/asset-ref";
import type { AkmConfig } from "../../core/config/config-types";
import { parseEnvRef } from "../../core/env-secret-ref";
import { ConfigError, UsageError } from "../../core/errors";
import { captureFrozenDirectoryIdentity } from "../../execution/directory-identity";
import { type FrozenExecutableIdentity, freezeExecutableIdentity } from "../../execution/executable-identity";
import type { GuardedExecutionSource, GuardedExecutionSourceCollector } from "../../execution/guarded-source";
import {
  canonicalResolvedExecutionRequest,
  decodeResolvedExecutionRequest,
  type ResolvedExecutionRequestV1,
} from "../../execution/resolved-request";
import type { UnresolvedExecutionDefaults } from "../../execution/source";
import { deriveInstallations } from "../../indexer/installations";
import { resolveSourceEntries } from "../../indexer/search/search-source";
import { fallbackAnnouncement } from "../../integrations/agent/engine-fallback";
import { requireAuthorizedExecutionPlan } from "../../integrations/agent/execution-cascade";
import { lowerResolvedExecutionRequest } from "../../integrations/agent/execution-lowering";
import { prepareInlineExecution } from "../../integrations/agent/inline-execution";
import type { RunnerSpec } from "../../integrations/agent/runner";
import { resolveAssetPath } from "../../sources/resolve";
import { prepareTaskV3Execution } from "../../tasks/prepare/prepare";
import { prepareScriptTarget } from "../../tasks/prepare/prepare-script-target";
import type { PreparedTaskV3Execution, TaskV3ScriptInterpreter } from "../../tasks/prepare/prepared-execution";
import { readBoundedTaskSourceYaml } from "../../tasks/source/bounded-document";
import { peekTaskSourceVersion } from "../../tasks/source/parse-task-source";
import { TASK_SOURCE_V4_VERSION } from "../../tasks/source/task-source-v4";
import { parseTaskV3Yaml } from "../../tasks/source-v3";
import { defaultLlmEngineConcurrency } from "../concurrency-policy";
import type { ProgramExec, ProgramUnit } from "../program/schema";
import { DEFAULT_EXEC_TIMEOUT_MS } from "../resource-limits";
import type { WorkflowAsset } from "../runtime/workflow-asset-loader";
import { compileWorkflowSource } from "../source-ir/compile";
import { sourceStepProgramUnit, sourceStepRef, workflowShellCommand } from "../source-ir/program";
import type { WorkflowSourceIrV1, WorkflowSourceStep } from "../source-ir/schema";
import { classifyWorkflowStepUses } from "../source-ir/semantics";
import { freezeWorkflowEnvironment } from "./environment-v4";
import type { IrExecSpec } from "./schema";
import type {
  FrozenWorkflowCommandTarget,
  FrozenWorkflowEnvironmentBinding,
  FrozenWorkflowScriptTarget,
  FrozenWorkflowShellTarget,
  FrozenWorkflowTarget,
} from "./schema-v4";

export interface ResolvedWorkflowUnitV4 {
  readonly target: FrozenWorkflowTarget;
  readonly environment: readonly FrozenWorkflowEnvironmentBinding[];
  readonly unit: ProgramUnit;
  readonly instructions: string;
  readonly engineAnnouncement?: string;
}

export interface ResolvedWorkflowSourceV4 {
  readonly sourceIr: WorkflowSourceIrV1;
  readonly units: ReadonlyMap<string, ResolvedWorkflowUnitV4>;
  readonly judges: ReadonlyMap<string, FrozenWorkflowCommandTarget>;
  readonly engineAnnouncement?: string;
}

interface OwnedAsset {
  readonly ref: string;
  readonly bundle: string;
  readonly adapter: string;
  readonly root: string;
  readonly file: string;
}

interface ResolutionContext {
  readonly asset: WorkflowAsset;
  readonly config: AkmConfig;
  readonly collector: GuardedExecutionSourceCollector;
  readonly sourceIr: WorkflowSourceIrV1;
}

interface ResolvedDispatch extends ResolvedWorkflowUnitV4 {
  readonly unit: ProgramUnit;
  readonly instructions: string;
}

/** Resolve every authored target through the shared command/task authorities before v4 publication. */
export async function resolveWorkflowSourceV4(
  asset: WorkflowAsset,
  workflowSource: GuardedExecutionSource,
  config: AkmConfig,
  collector: GuardedExecutionSourceCollector,
): Promise<ResolvedWorkflowSourceV4> {
  const compiled = compileWorkflowSource(workflowSource.content, { path: asset.path, workspaceRoot: asset.sourcePath });
  if (!compiled.ok) {
    throw new UsageError(
      `Workflow source cannot be frozen: ${compiled.errors.map((error) => error.message).join("; ")}`,
      "INVALID_FLAG_VALUE",
    );
  }
  if (compiled.ir.jobs.length !== 1) {
    throw new UsageError(
      "Multi-job workflow cannot execute until job boundaries and needs have a durable runtime representation.",
      "INVALID_FLAG_VALUE",
    );
  }
  const context: ResolutionContext = { asset, config, collector, sourceIr: compiled.ir };
  const units = new Map<string, ResolvedWorkflowUnitV4>();
  const judges = new Map<string, FrozenWorkflowCommandTarget>();
  let engineAnnouncement: string | undefined;
  const sourceSteps = compiled.ir.jobs[0]?.steps ?? [];
  for (const sourceStep of sourceSteps) {
    if (!sourceStep.route) {
      const resolved = await resolveStep(sourceStep, context);
      units.set(sourceStep.id, Object.freeze(resolved));
      engineAnnouncement ??= resolved.engineAnnouncement;
    }
    if (sourceStep.gate?.rubric?.trim()) {
      const judge = resolveJudge(sourceStep, context);
      if (judge.target.kind !== "command")
        throw new Error(`workflow judge ${sourceStep.id} did not resolve to a command target`);
      judges.set(sourceStep.id, judge.target);
      engineAnnouncement ??= judge.engineAnnouncement;
    }
  }
  return Object.freeze({
    sourceIr: compiled.ir,
    units,
    judges,
    ...(engineAnnouncement ? { engineAnnouncement } : {}),
  });
}

async function resolveStep(source: WorkflowSourceStep, context: ResolutionContext): Promise<ResolvedDispatch> {
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

async function commandDispatch(
  source: WorkflowSourceStep,
  baseUnit: ProgramUnit,
  action: unknown,
  context: ResolutionContext,
): Promise<ResolvedDispatch> {
  const prepared = await prepareCommandInvocation({
    action,
    config: context.config,
    invocationKind: "workflow",
    ...(context.sourceIr.defaults
      ? { invocationDefaults: executionUnitValues(context.sourceIr.defaults, context.asset.sourcePath) }
      : {}),
    ...(source.commandMode === "literal" ? { inlineContentMode: "literal" as const } : {}),
    current: executionValues(source, context.asset.sourcePath),
    sourceLoader: (ref, kind) => guardedExecutionSource(ref, kind, context),
  });
  return commandResult(source, baseUnit, prepared, context);
}

function inlineDispatch(
  source: WorkflowSourceStep,
  baseUnit: ProgramUnit,
  context: ResolutionContext,
): ResolvedDispatch {
  const content = source.instructions ?? `Execute workflow step ${source.id}.`;
  const prepared = prepareInlineExecution({
    content,
    config: context.config,
    invocationKind: "workflow",
    ...(context.sourceIr.defaults
      ? { invocationDefaults: executionUnitValues(context.sourceIr.defaults, context.asset.sourcePath) }
      : {}),
    current: executionValues(source, context.asset.sourcePath),
  });
  return commandResult(source, baseUnit, prepared, context);
}

function resolveJudge(source: WorkflowSourceStep, context: ResolutionContext): ResolvedDispatch {
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

async function taskDispatch(
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

async function directScript(
  source: WorkflowSourceStep,
  baseUnit: ProgramUnit,
  refInput: string,
  context: ResolutionContext,
): Promise<ResolvedDispatch> {
  const owned = await resolveOwnedAsset(refInput, "script", context);
  captureOwned(owned, context.collector);
  // Typed preparer (P1b spec §4.3) — no synthetic task YAML, no parseTaskV3Yaml
  // call, no fabricated schedule/filePath/taskId/taskRef. The script's own
  // owned identity (ref/file/bundleRoot) is all prepareScriptTarget needs.
  const captured = prepareScriptTarget({
    ref: owned.ref,
    file: owned.file,
    bundleRoot: owned.root,
    readFile: () => context.collector.readBytes(owned.file, owned.root),
  });
  return scriptResult(
    source,
    baseUnit,
    {
      sourceRef: captured.ref,
      interpreter: captured.interpreter,
      extension: captured.extension,
      bytesBase64: captured.bytesBase64,
      byteLength: captured.byteLength,
      sha256: captured.sha256,
      cwdIdentity: captured.cwdIdentity,
    },
    context,
    [],
  );
}

/**
 * The subset of a script projection scriptResult() actually reads — shared by
 * taskDispatch's prepareTaskV3Execution-produced PreparedTaskV3Script (which
 * structurally satisfies this narrower shape) and directScript's
 * prepareScriptTarget()-produced PreparedScriptTarget above (field-mapped:
 * PreparedScriptTarget.ref -> sourceRef).
 */
type FrozenScriptCapture = Pick<
  Extract<PreparedTaskV3Execution, { kind: "script" }>,
  "sourceRef" | "interpreter" | "extension" | "bytesBase64" | "byteLength" | "sha256" | "cwdIdentity"
>;

function scriptResult(
  source: WorkflowSourceStep,
  baseUnit: ProgramUnit,
  prepared: FrozenScriptCapture,
  context: ResolutionContext,
  literals: readonly FrozenWorkflowEnvironmentBinding[],
): ResolvedDispatch {
  const requestedExecutable = scriptExecutable(prepared.interpreter);
  const executable = freezeExecutableIdentity(requestedExecutable, { cwd: prepared.cwdIdentity.realCwd });
  const authoredExec: ProgramExec = { command: [executable.absolutePath, "<frozen-script>"] };
  const exec = freezeExecSpec(source, authoredExec, context);
  const environment = Object.freeze([...literals, ...freezeEnvironment(source, authoredExec, context)]);
  const target: FrozenWorkflowScriptTarget = Object.freeze({
    kind: "script",
    ref: prepared.sourceRef,
    contentHash: prepared.sha256,
    exec,
    interpreter: prepared.interpreter,
    extension: prepared.extension,
    bytesBase64: prepared.bytesBase64,
    byteLength: prepared.byteLength,
    cwdIdentity: prepared.cwdIdentity,
    materialization: "ephemeral-0700-delete",
    executable,
    ...gitIdentity(baseUnit, prepared.cwdIdentity.realRoot),
  });
  return {
    target,
    environment,
    unit: { ...baseUnit, exec: authoredExec },
    instructions: source.instructions ?? `Run script ${prepared.sourceRef}.`,
  };
}

function directShell(source: WorkflowSourceStep, baseUnit: ProgramUnit, context: ResolutionContext): ResolvedDispatch {
  const authoredExec = baseUnit.exec;
  if (!authoredExec) throw new Error(`workflow shell step ${source.id} lost its source-IR execution spec`);
  const exec = freezeExecSpec(source, authoredExec, context);
  const cwdIdentity = captureFrozenDirectoryIdentity(context.asset.sourcePath, authoredExec.cwd);
  const executable = freezeExecutableIdentity(authoredExec.command[0] as string, { cwd: cwdIdentity.realCwd });
  const environment = Object.freeze(freezeEnvironment(source, authoredExec, context));
  const target: FrozenWorkflowShellTarget = Object.freeze({
    kind: "shell",
    contentHash: "",
    exec,
    cwdIdentity,
    executable,
    ...gitIdentity(baseUnit, cwdIdentity.realRoot),
  });
  return {
    target,
    environment,
    unit: { ...baseUnit, exec },
    instructions: source.instructions ?? `Run ${source.run ?? authoredExec.command.join(" ")}.`,
  };
}

function commandResult(
  source: WorkflowSourceStep,
  baseUnit: ProgramUnit,
  prepared: PreparedCommandInvocation,
  context: ResolutionContext,
  literals: readonly FrozenWorkflowEnvironmentBinding[] = [],
): ResolvedDispatch {
  const request = durableRequest(requireAuthorizedExecutionPlan(prepared.plan));
  const lowered = lowerResolvedExecutionRequest(request, prepared.config);
  const cwdIdentity = captureFrozenDirectoryIdentity(context.asset.sourcePath);
  let runner: RunnerSpec = lowered.runner;
  let executable: FrozenExecutableIdentity | undefined;
  if (runner.kind === "agent") {
    executable = freezeExecutableIdentity(runner.profile.bin, { cwd: cwdIdentity.realCwd });
    runner = Object.freeze({ ...runner, profile: Object.freeze({ ...runner.profile, bin: executable.absolutePath }) });
  }
  const unit: ProgramUnit = {
    ...baseUnit,
    engine: request.engine.name,
    ...(request.model ? { model: request.model.resolved } : {}),
    ...(Object.hasOwn(request.runtime, "timeoutMs") ? { timeoutMs: request.runtime.timeoutMs } : {}),
    ...(request.inference ? { llm: request.inference } : {}),
    ...(request.outputSchema ? { output: request.outputSchema } : {}),
  };
  const environment = Object.freeze([...literals, ...freezeEnvironment(source, undefined, context)]);
  const target: FrozenWorkflowCommandTarget = Object.freeze({
    kind: "command",
    ref: request.command.source?.ref ?? null,
    contentHash: createHash("sha256").update(request.command.content).digest("hex"),
    request: JSON.parse(canonicalResolvedExecutionRequest(request)) as ResolvedExecutionRequestV1,
    runner,
    ...(targetConcurrency(runner, context.config) ? { concurrency: targetConcurrency(runner, context.config) } : {}),
    cwdIdentity,
    ...(executable ? { executable } : {}),
    ...gitIdentity(baseUnit, cwdIdentity.realRoot),
  });
  const engineAnnouncement = fallbackAnnouncement(prepared.fallbackEngineName, request.engine.name);
  return {
    target,
    environment,
    unit,
    instructions: request.command.content,
    ...(engineAnnouncement ? { engineAnnouncement } : {}),
  };
}

function freezeExecSpec(source: WorkflowSourceStep, exec: ProgramExec, context: ResolutionContext): IrExecSpec {
  const declared = Object.hasOwn(source.unit ?? {}, "timeoutMs")
    ? source.unit?.timeoutMs
    : context.sourceIr.defaults && Object.hasOwn(context.sourceIr.defaults, "timeoutMs")
      ? context.sourceIr.defaults.timeoutMs
      : undefined;
  return {
    ...exec,
    command: exec.command as [string, ...string[]],
    timeoutMs: declared === undefined ? DEFAULT_EXEC_TIMEOUT_MS : declared,
  };
}

function targetConcurrency(runner: RunnerSpec, config: AkmConfig): number | undefined {
  if (runner.kind === "llm") {
    const configured = typeof runner.engine === "string" ? config.engines?.[runner.engine] : undefined;
    return defaultLlmEngineConcurrency(
      runner.connection.endpoint,
      configured?.kind === "llm" ? configured.concurrency : undefined,
    );
  }
  if (runner.kind !== "sdk" || !runner.fallbackConnection) return undefined;
  const selected = typeof runner.engine === "string" ? config.engines?.[runner.engine] : undefined;
  const fallbackName = selected?.kind === "agent" ? (selected.llmEngine ?? config.defaults?.llmEngine) : undefined;
  const fallback = fallbackName ? config.engines?.[fallbackName] : undefined;
  return defaultLlmEngineConcurrency(
    runner.fallbackConnection.endpoint,
    fallback?.kind === "llm" ? fallback.concurrency : undefined,
  );
}

function durableRequest(request: ResolvedExecutionRequestV1): ResolvedExecutionRequestV1 {
  const wire = JSON.parse(canonicalResolvedExecutionRequest(request)) as Record<string, unknown>;
  const runtime = { ...(wire.runtime as Record<string, unknown>) };
  delete runtime.environment;
  wire.runtime = runtime;
  return decodeResolvedExecutionRequest(wire);
}

function executionValues(source: WorkflowSourceStep, workspace: string): UnresolvedExecutionDefaults {
  return executionUnitValues(source.unit, workspace);
}

function executionUnitValues(
  unit: WorkflowSourceStep["unit"] | WorkflowSourceIrV1["defaults"],
  workspace: string,
): UnresolvedExecutionDefaults {
  return Object.freeze({
    ...(unit && Object.hasOwn(unit, "engine") ? { engine: unit.engine } : {}),
    ...(unit && Object.hasOwn(unit, "model") ? { model: unit.model } : {}),
    ...(unit && Object.hasOwn(unit, "llm") ? { inference: unit.llm } : {}),
    ...(unit && Object.hasOwn(unit, "timeoutMs") ? { timeout: unit.timeoutMs } : {}),
    ...(unit && "output" in unit && Object.hasOwn(unit, "output") ? { outputSchema: unit.output } : {}),
    workspace,
  }) as UnresolvedExecutionDefaults;
}

function freezeEnvironment(
  source: WorkflowSourceStep,
  exec: ProgramExec | undefined,
  context: ResolutionContext,
): FrozenWorkflowEnvironmentBinding[] {
  const literals = Object.entries(source.env ?? {}).map(([name, value]) =>
    Object.freeze({ kind: "literal" as const, name, value: String(value) }),
  );
  const passThrough = (exec?.passEnv ?? []).map((name) => Object.freeze({ kind: "pass-through" as const, name }));
  const refs = source.unit?.env ?? [];
  const envRefs = freezeWorkflowEnvironment(refs, {
    collector: context.collector,
    resolveRef: (ref) => {
      const parsedEnv = parseEnvRef(ref);
      if (parsedEnv.type !== "env") throw new UsageError(`Expected an env ref; got ${ref}.`, "INVALID_FLAG_VALUE");
      const owned = resolveOwnedAssetSync(ref, "env", context);
      return { ref: owned.ref, bundle: owned.bundle, adapter: owned.adapter, root: owned.root, path: owned.file };
    },
  });
  return [...literals, ...passThrough, ...envRefs];
}

async function guardedExecutionSource(ref: string, kind: "command" | "persona", context: ResolutionContext) {
  const owned = await resolveOwnedAsset(ref, kind === "command" ? "command" : "agent", context);
  captureOwned(owned, context.collector);
  const options = {
    config: context.config,
    fileContext: () => context.collector.fileContext(owned.root, owned.file),
  };
  const rendered =
    kind === "command"
      ? await loadAdapterExecutionSource(owned.ref, "command", options)
      : await loadAdapterExecutionSource(owned.ref, "persona", options);
  context.collector.bindIdentity(owned.file, owned.root, rendered.identity);
  return rendered;
}

async function resolveOwnedAsset(
  ref: string,
  type: "command" | "agent" | "task" | "workflow" | "script" | "env",
  context: ResolutionContext,
): Promise<OwnedAsset> {
  return resolveOwnedAssetCore(ref, type, context, false) as Promise<OwnedAsset>;
}

function resolveOwnedAssetSync(ref: string, type: "env", context: ResolutionContext): OwnedAsset {
  return resolveOwnedAssetCore(ref, type, context, true) as OwnedAsset;
}

function resolveOwnedAssetCore(
  refInput: string,
  type: "command" | "agent" | "task" | "workflow" | "script" | "env",
  context: ResolutionContext,
  sync: boolean,
): OwnedAsset | Promise<OwnedAsset> {
  const parsed = parseBundleRef(refInput);
  const plural = type === "env" ? "env" : `${type}s`;
  const conceptId = parsed.conceptId.startsWith(`${plural}/`) ? parsed.conceptId : `${plural}/${parsed.conceptId}`;
  const name = conceptId.slice(plural.length + 1);
  const direct = parsed.bundle ? configuredOwner(parsed.bundle, context.config) : undefined;
  const sources = resolveSourceEntries(undefined, context.config);
  const installations = deriveInstallations(sources);
  const candidates = direct
    ? [direct]
    : sources.flatMap((source, index) => {
        const installation = installations[index];
        if (!installation || (parsed.bundle && installation.id !== parsed.bundle)) return [];
        return [
          {
            bundle: installation.id,
            root: source.path,
            adapter: source.adapterId ?? installation.components[0]?.adapter ?? "akm",
          },
        ];
      });
  const findSync = (): OwnedAsset => {
    for (const candidate of candidates) {
      const directory = path.join(candidate.root, plural);
      for (const extension of assetExtensions(type)) {
        const file = path.resolve(directory, `${name}${extension}`);
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          return { ...candidate, ref: makeBundleRef(candidate.bundle, conceptId), file };
        }
      }
    }
    throw new UsageError(`Workflow source target ${refInput} was not found.`, "INVALID_FLAG_VALUE");
  };
  if (sync) return findSync();
  return (async () => {
    for (const candidate of candidates) {
      try {
        const file = await resolveAssetPath(candidate.root, type, name);
        return { ...candidate, ref: makeBundleRef(candidate.bundle, conceptId), file };
      } catch {
        // Continue in installation priority order.
      }
    }
    return findSync();
  })();
}

function configuredOwner(
  bundle: string,
  config: AkmConfig,
): { bundle: string; root: string; adapter: string } | undefined {
  const entry = config.bundles?.[bundle];
  if (!entry || typeof entry.path !== "string") return undefined;
  const components = entry.components ? Object.values(entry.components) : [];
  const component = components[0];
  return {
    bundle,
    root: path.resolve(entry.path, component?.root ?? "."),
    adapter: component?.adapter ?? "akm",
  };
}

function assetExtensions(type: string): readonly string[] {
  if (type === "script")
    return [
      "",
      ".sh",
      ".ts",
      ".js",
      ".py",
      ".rb",
      ".go",
      ".pl",
      ".php",
      ".lua",
      ".r",
      ".swift",
      ".kt",
      ".kts",
      ".ps1",
      ".cmd",
      ".bat",
    ];
  if (type === "env") return ["", ".env"];
  return ["", ".md", ".yml"];
}

function captureOwned(owned: OwnedAsset, collector: GuardedExecutionSourceCollector): GuardedExecutionSource {
  trackAncestry(collector, owned.root, owned.file);
  const retained = collector.capture(owned.file, owned.root, { authored: true });
  return collector.bindIdentity(owned.file, owned.root, {
    ref: owned.ref,
    bundle: owned.bundle,
    adapter: owned.adapter,
    file: retained.relativePath,
    hash: retained.sha256,
  });
}

function trackAncestry(collector: GuardedExecutionSourceCollector, rootInput: string, file: string): void {
  const root = path.resolve(rootInput);
  collector.trackDirectory(root, root);
  const relative = path.relative(root, path.dirname(file));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new UsageError(`${file} resolves outside its owning root.`, "PATH_ESCAPE_VIOLATION");
  }
  let current = root;
  for (const segment of relative === "" ? [] : relative.split(path.sep)) {
    current = path.join(current, segment);
    collector.trackDirectory(current, root);
  }
}

function qualifyRef(ref: string, plural: string, asset: WorkflowAsset, config: AkmConfig): string {
  const parsed = parseBundleRef(ref);
  if (parsed.bundle) return ref;
  const bundle = parseBundleRef(asset.ref).bundle ?? config.defaultBundle;
  if (!bundle) throw new UsageError(`Workflow ref ${ref} has no owning bundle.`, "INVALID_FLAG_VALUE");
  const concept = parsed.conceptId.startsWith(`${plural}/`) ? parsed.conceptId : `${plural}/${parsed.conceptId}`;
  return makeBundleRef(bundle, concept);
}

function scriptExecutable(interpreter: TaskV3ScriptInterpreter): string {
  if (interpreter === "bun" || interpreter === "bun-standalone") return process.execPath;
  if (interpreter === "kotlin") return "kotlin";
  return interpreter;
}

function gitIdentity(unit: ProgramUnit, root: string): { gitCommitOid?: string } {
  if (unit.isolation !== "worktree") return {};
  const result = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
  const oid = result.status === 0 ? result.stdout.trim() : "";
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) {
    throw new UsageError(
      `Worktree-isolated workflow root ${root} has no immutable Git HEAD OID.`,
      "INVALID_FLAG_VALUE",
    );
  }
  return { gitCommitOid: oid };
}
