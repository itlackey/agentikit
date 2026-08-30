// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm task` — register, inspect, run, and remove scheduled task assets.
 *
 * Each handler exported here is a pure function that performs the real work;
 * `src/cli.ts` wraps these in citty `defineCommand`s and shapes their return
 * values via `output()`.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { detectAdapterId } from "../../core/adapter/detect-adapter";
import { assetPathForName } from "../../core/asset/asset-placement";
import { makeBundleRef, parseBundleRef } from "../../core/asset/asset-ref";
import { type AssetRef, conceptIdFromTypeName, isFullRefInput } from "../../core/asset/resolve-ref";
import { isWithin, resolveStashDir } from "../../core/common";
import { loadConfig } from "../../core/config/config";
import { resolveConfiguredSources } from "../../core/config/config-sources";
import type { AkmConfig } from "../../core/config/config-types";
import { IMPROVE_AUTONOMY_CONFIG_KEY, isImproveAutonomyEnabled } from "../../core/config/experimental";
import { ConfigError, NotFoundError, UsageError } from "../../core/errors";
import { getTaskHistoryDir, getTaskLogDir } from "../../core/paths";
import {
  commitWriteTargetBoundary,
  deleteAssetFromSource,
  prepareWriteTargetForMutation,
  type ResolvedWriteTarget,
  resolveWorkingStashTarget,
  resolveWriteTarget,
  writeAssetToSource,
} from "../../core/write-source";
import type { InputFlag } from "../../execution/input-contract";
import { withEngineFallback } from "../../integrations/agent/engine-fallback";
import { resolveAssetPath } from "../../sources/resolve";
import { backendNameForPlatform, selectBackend } from "../../tasks/backends";
import type { InstalledSchedulerBinding, RebindSchedulerBinding, SchedulerBackend } from "../../tasks/backends/types";
import { prepareTaskV3Execution } from "../../tasks/prepare/prepare";
import type { PrepareTaskV3ExecutionContext } from "../../tasks/prepare/prepared-execution";
import { type ResolvedAkmInvocation, resolveAkmInvocation } from "../../tasks/resolve-akm-bin";
import { createExecutionProvenanceContext } from "../../tasks/run/provenance";
import { runTask } from "../../tasks/run/run-task";
import { readTaskHistory } from "../../tasks/run/task-history";
import { exitCodeForStatus, type RunTaskOptions, type TaskRunResult } from "../../tasks/run/task-result";
import { parseSchedule, SCHEDULE_SUPPORTED_SUBSET_HINT } from "../../tasks/schedule";
import {
  assertSchedulerMutationArtifact,
  assertSchedulerNativeArtifactCardinality,
  compileTaskSchedulerBindings,
  type SchedulerBinding,
  type SchedulerInstallOptions,
  type SchedulerMutationExpectation,
  type SchedulerRollbackExpectation,
  type SchedulerRollbackState,
  type SchedulerTransactionSnapshot,
  schedulerBindingNativeId,
  schedulerBindingOrdinal,
  schedulerNativeArtifactKey,
  schedulerNativeBindingId,
} from "../../tasks/scheduler-binding";
import {
  schedulerContextDescriptor,
  schedulerContextPath,
  validateSchedulerContextDescriptor,
  writeSchedulerContextDescriptor,
} from "../../tasks/scheduler-invocation";
import {
  assertSchedulerNativeArtifactOwnership,
  assertSchedulerSourceSnapshot,
  buildSchedulerRemoveOperation,
  finalizeSchedulerSyncPlan,
  prepareSchedulerSyncSourceSet,
  type SchedulerSyncOperation,
  type SchedulerSyncPlan,
} from "../../tasks/scheduler-sync";
import {
  renderSchedulerPlanPreview,
  renderSchedulerSyncPlanPreview,
  type SchedulerPlanPreview,
} from "../../tasks/scheduler-sync-preview";
import { parseTaskSource } from "../../tasks/source/parse-task-source";
import { projectTaskSourceV4 } from "../../tasks/source/project-v4";
import { TASK_V3_MAX_SOURCE_BYTES, type TaskV3SourceDocument } from "../../tasks/source-v3";
import { normaliseTaskConceptId, normaliseTaskId } from "../../tasks/task-id";
import { applyAutonomyGate, configuredDirectAutonomyLanes, describeGatedLanes } from "../improve/autonomy-gate";
import { resolveImproveStrategy } from "../improve/improve-strategies";

export interface TasksAddInput {
  id: string;
  schedule: string;
  /**
   * Bundle to write the task into and schedule from. Defaults to the primary /
   * default write target. Resolved via {@link resolveWriteTarget}; a non-default
   * bundle is recorded in the scheduled invocation as `--bundle <bundle>`.
   */
  target?: string;
  workflow?: string;
  prompt?: string;
  /**
   * Exact shell command string to run on the schedule. Arrays are rejected so
   * authoring cannot silently change shell semantics. Mutually exclusive with
   * `workflow` and `prompt`.
   */
  command?: string | string[];
  engine?: string;
  model?: string;
  timeoutMs?: number;
  params?: string;
  name?: string;
  description?: string;
  when_to_use?: string;
  tags?: string[];
  disabled?: boolean;
  force?: boolean;
  /** Explicitly permit scheduler creation from an ineligible local invocation. */
  rebind?: boolean;
}

export interface TasksAddResult {
  id: string;
  ref: string;
  path: string;
  bundleDir: string;
  schedule: string;
  enabled: boolean;
  backend: string;
  target: TaskV3SourceDocument["target"];
}

export interface TaskMutationDeps {
  backend?: SchedulerBackend;
  writeAsset?: typeof writeAssetToSource;
  deleteAsset?: typeof deleteAssetFromSource;
  commitBoundary?: typeof commitWriteTargetBoundary;
  schedulerRuntime?: () => PreparedSchedulerRuntime;
}

export interface PreparedSchedulerRuntime {
  binding: string[];
  contextPath: string;
  /** Eligibility of the resolved invocation; absent when the caller supplied its own runtime. */
  eligible?: boolean;
  kind?: ResolvedAkmInvocation["kind"];
}

export async function akmTasksAdd(input: TasksAddInput, deps: TaskMutationDeps = {}): Promise<TasksAddResult> {
  const id = normaliseTaskId(input.id);
  assertTaskAddTargetShape(input);

  // Validate the schedule for the active backend before writing anything.
  // WI-9.10e: the injected backend (tests) carries its own name, so derive it
  // from `deps.backend` when present — retiring the `_setBackendsForTests` seam.
  const backend = deps.backend?.name ?? backendNameForPlatform();
  parseSchedule(input.schedule, backend);

  const bundle = resolveTaskBundle(input.target, { requireWritable: true });
  const writeTarget = bundle.resolved;
  const stashDir = bundle.stashDir;
  const installOpts = bundle.installTarget !== undefined ? { target: bundle.installTarget } : undefined;
  const typeRoot = path.join(stashDir, "tasks");

  const assetPath = assetPathForName("task", typeRoot, id);
  if (!isWithin(assetPath, typeRoot)) {
    throw new UsageError(`Resolved task path escapes the stash: "${id}".`, "PATH_ESCAPE_VIOLATION");
  }
  if (fs.existsSync(assetPath) && !input.force) {
    throw new UsageError(
      `Task "${id}" already exists. Pass --force to overwrite, or delete its file and run \`akm task sync\` first.`,
      "RESOURCE_ALREADY_EXISTS",
    );
  }
  const sourceExpectation = captureTaskSourceExpectation(assetPath, stashDir);
  if (sourceExpectation.state === "present" && !input.force) {
    throw new UsageError(
      `Task "${id}" appeared while add was preparing. Pass --force only after reviewing the current owner.`,
      "RESOURCE_ALREADY_EXISTS",
    );
  }

  const yaml = renderTaskYaml({
    id,
    schedule: input.schedule,
    workflow: input.workflow,
    prompt: input.prompt,
    command: input.command,
    engine: input.engine,
    model: input.model,
    timeoutMs: input.timeoutMs,
    params: input.params,
    name: input.name,
    description: input.description,
    when_to_use: input.when_to_use,
    tags: input.tags,
    enabled: input.disabled !== true,
  });

  const parsedTask = parseTaskSource({ yaml, filePath: assetPath, workspaceRoot: stashDir });
  const task = projectTaskSourceV4(parsedTask.v4);
  const qualifiedRef = makeBundleRef(bundle.bundleName, `tasks/${id}`);
  await prepareTaskV3Execution(task, {
    taskId: id,
    taskRef: qualifiedRef,
    bundleName: bundle.bundleName,
    bundleRoot: stashDir,
    config: bundle.config,
    resolveAsset: taskProjectionAssetResolver(bundle.config, bundle.bundleName, stashDir),
  });
  // Bindings are compiled from the ORIGINAL parsed document, not the
  // `task`/`projectTaskSourceV4` projection above — mirroring
  // scheduler-sync.ts's compileTaskSources (spec §3.2.7's project-v4.ts
  // header): the projection deliberately drops each schedule entry's own
  // `enabled` (P4-N6), so building bindings from it would silently ignore
  // `--disabled`. A task source v4 document has no document-level
  // `akm.enabled`, so `enabled: true` is passed at the document level and
  // every entry's own `enabled` (always present, defaulted at parse time)
  // decides.
  const taskBindings = compileTaskSchedulerBindings({
    id,
    qualifiedRef,
    ...(bundle.installTarget ? { bundleTarget: bundle.installTarget } : {}),
    enabled: true,
    schedules: parsedTask.v4.schedule.map((schedule) => ({
      cron: schedule.cron,
      ordinal: schedule.ordinal,
      enabled: schedule.enabled,
      source: schedule.source,
      inputs: schedule.inputs,
    })),
  });
  const taskBinding = taskBindings[0];
  if (!taskBinding) throw new UsageError(`Task "${id}" has no schedulable trigger.`, "INVALID_FLAG_VALUE");

  const ref = taskAssetRef(id);
  const sched = deps.backend ?? selectBackend();
  const writeAsset = deps.writeAsset ?? writeAssetToSource;
  const deleteAsset = deps.deleteAsset ?? deleteAssetFromSource;
  const commitBoundary = deps.commitBoundary ?? commitWriteTargetBoundary;
  const transaction = await prepareTaskAddSchedulerTransaction({
    id,
    installTarget: bundle.installTarget,
    ownerTarget: bundle.bundleName,
    installOpts,
    taskBindings,
    sched,
    deps,
    rebind: input.rebind === true,
  });
  let sourceMutationReceipt: Extract<TaskSourceExpectation, { state: "present" }> | undefined;
  let sourcePublished = false;
  let sourcePublicationAttempted = false;
  const publishSource = async () => {
    assertTaskSourceExpectation(sourceExpectation);
    sourcePublicationAttempted = true;
    await writeAsset(writeTarget.source, writeTarget.config, ref, yaml);
    const publishedSource = captureTaskSourceExpectation(assetPath, stashDir);
    if (publishedSource.state !== "present" || publishedSource.sha256 !== hashTaskSource(yaml)) {
      throw new UsageError(
        `Task source ${JSON.stringify(assetPath)} changed during publication.`,
        "RESOURCE_ALREADY_EXISTS",
      );
    }
    sourceMutationReceipt = publishedSource;
    sourcePublished = true;
    transaction.publishRuntime?.();
  };

  await applySchedulerTransaction(sched, transaction.operations, {
    initialExpectations: transaction.initialExpectations,
    assertReadSet: () => {
      if (sourcePublished) {
        if (!sourceMutationReceipt) {
          throw new ConfigError("Published task source lost its transaction receipt.", "INVALID_CONFIG_FILE");
        }
        assertTaskSourceExpectation(sourceMutationReceipt);
      } else {
        assertTaskSourceExpectation(sourceExpectation);
      }
    },
    beforeOperation: async (_operation, index) => {
      if (index === transaction.publishOperationIndex && !sourcePublished) await publishSource();
    },
    afterOperations: () => commitBoundary(writeTarget, `Update tasks/${id}`),
    rollbackExternal: async () => {
      if (!sourcePublicationAttempted) return;
      if (!sourceMutationReceipt) {
        const current = captureTaskSourceExpectation(assetPath, stashDir);
        if (sameTaskSourceExpectation(current, sourceExpectation)) return;
        if (current.state !== "present" || current.sha256 !== hashTaskSource(yaml)) {
          throw new UsageError(
            `Task source ${JSON.stringify(assetPath)} has an unowned publication state; refusing rollback over a possible concurrent owner.`,
            "RESOURCE_ALREADY_EXISTS",
          );
        }
        sourceMutationReceipt = current;
      }
      assertTaskSourceExpectation(sourceMutationReceipt);
      try {
        if (sourceExpectation.state === "absent") {
          await deleteAsset(writeTarget.source, writeTarget.config, ref);
        } else {
          await writeAsset(writeTarget.source, writeTarget.config, ref, sourceExpectation.content);
          const providerRestored = captureTaskSourceExpectation(assetPath, stashDir);
          if (providerRestored.state !== "present" || providerRestored.sha256 !== sourceExpectation.sha256) {
            // Provider writers conventionally normalize a trailing newline.
            // Rollback is byte-exact, so finish the already-owned restore with
            // the frozen bytes before checking the physical source state.
            fs.writeFileSync(assetPath, Buffer.from(sourceExpectation.bytesBase64, "base64"));
          }
        }
        assertTaskSourceRestored(sourceExpectation);
        commitBoundary(writeTarget, `Restore tasks/${id}`);
      } catch (cause) {
        // A write/commit seam may report failure after it has already restored
        // the exact source bytes. Prove that state before allowing native
        // rollback; otherwise preserve the possible concurrent source owner.
        try {
          assertTaskSourceRestored(sourceExpectation);
        } catch {
          throw cause;
        }
        throw new TaskSourceRestoredBoundaryError(cause);
      }
    },
    suppressNativeRollbackWhenExternalFails: true,
    allowNativeRollbackAfterExternalFailure: (error) => error instanceof TaskSourceRestoredBoundaryError,
  });

  return {
    id,
    ref: conceptIdFromTypeName("task", id),
    path: assetPath,
    bundleDir: stashDir,
    schedule: taskBinding.cron,
    enabled: taskBinding.enabled,
    backend,
    target: task.target,
  };
}

function assertTaskAddTargetShape(input: TasksAddInput): void {
  const hasCommand =
    input.command !== undefined &&
    input.command !== null &&
    !(typeof input.command === "string" && input.command.trim() === "") &&
    !(Array.isArray(input.command) && input.command.length === 0);
  const targetCount = [Boolean(input.workflow), Boolean(input.prompt), hasCommand].filter(Boolean).length;
  if (targetCount !== 1) {
    throw new UsageError(
      "Pass exactly one of --workflow <ref>, --prompt <inline-text>, or --command <shell-command>.",
      "INVALID_FLAG_VALUE",
    );
  }
  // `--timeout-ms` is the workflow's whole-run bound. Engine and model stay
  // prompt-only because workflow engines come from the frozen plan.
  if (input.workflow && (input.engine !== undefined || input.model !== undefined)) {
    throw new UsageError(
      "Workflow tasks accept --params and --timeout-ms; engine and model are prompt-task fields.",
      "INVALID_FLAG_VALUE",
    );
  }
  if (hasCommand && (input.engine !== undefined || input.model !== undefined)) {
    throw new UsageError("Command tasks accept --timeout-ms but not --engine or --model.", "INVALID_FLAG_VALUE");
  }
  if (input.prompt !== undefined) assertInlineTaskPrompt(input.prompt);
}

export interface TasksRunResultEnvelope {
  ok: boolean;
  result: TaskRunResult;
  exitCode: number;
}

export async function akmTasksRun(
  id: string,
  options: { scheduled?: boolean; target?: string; inputFlags?: readonly InputFlag[] } = {},
): Promise<TasksRunResultEnvelope> {
  const parsed = parseTaskRef(id);
  const bundle = resolveTaskReadBundle(parsed.bundle, options.target);
  const adapterId = bundle.source.adapterId ?? detectAdapterId(bundle.source.path);
  const resolvedId = taskIdForAdapter(parsed.id, adapterId);
  const scheduled = options.scheduled === true;
  // D5 "Construction" (spec docs/plans/specs/p1b-model-extraction.md §1.2/
  // §5.2): built ONCE at this invocation boundary. eventSource is "task"
  // whether or not --scheduled was passed (§1.6 D5-N1) — scheduled stays a
  // separate field carrying its own pre-existing meaning (activation policy,
  // scheduler env), never selecting the event source.
  const provenance = createExecutionProvenanceContext(scheduled);
  // F-3 (spec §5.4): RunTaskOptions.stashDir renamed to bundleDir — VALUE-
  // preserving, no CLI flag change.
  //
  // P2a Lane C (spec docs/plans/specs/p2a-task-source-v4.md §5.1): the raw,
  // exact-name input flags `tasks-cli.ts`'s Stage 1 captures ride through
  // unchanged to `runTask` -> `loadPreparedTask`'s Stage 2 materializer,
  // which owns declaring `inputFlags` on `RunTaskOptions` and attaching the
  // materialized literals to the constructed `TaskInvocation`. This is only
  // the pass-through surface: a valid flag set stays byte-identical to the
  // same run without flags (§0), and P2a delivers nothing to the target.
  //
  // No `as` cast (test-review finding, spec §6 F-5): `RunTaskOptions` (this
  // literal's inferred type is checked directly against it, below) declares
  // every one of these fields, so the compiler — not a suppressed excess-
  // property check — enforces this seam. A future rename or removal on
  // either side now fails `tsc`, not silently at the `runTask` boundary.
  const runOptions: RunTaskOptions = {
    bundleDir: bundle.source.path,
    bundleName: bundle.source.name,
    adapterId,
    scheduled,
    provenance,
    inputFlags: options.inputFlags,
  };
  // The runner owns the prepare-before-reserve boundary. Invalid source,
  // projectability, and resolver failures therefore create no history row.
  const result = await runTask(resolvedId, runOptions);
  // C-7 (spec §5.6): after D8's result-vocabulary re-code, "command" means
  // the agent/LLM arm — the native shell/script arm now reports "shell" /
  // "script". Rewired in the SAME commit as the vocabulary re-code so a
  // shell/script task's process exit 78 still passes through as CLI exit 78
  // (documented behavior, src/assets/hints/cli-hints-short.md:95).
  const exitCode =
    result.status === "failed" &&
    (result.target.kind === "shell" || result.target.kind === "script") &&
    result.detail?.exitCode === 78
      ? 78
      : exitCodeForStatus(result.status);
  return {
    ok: result.status === "completed",
    result,
    exitCode,
  };
}

export interface TasksHistoryResult {
  rows: TaskRunResult[];
}

export async function akmTasksHistory(input: {
  id?: string;
  limit?: number;
  target?: string;
}): Promise<TasksHistoryResult> {
  const limit = input.limit !== undefined && input.limit > 0 ? input.limit : 50;
  const parsed = input.id ? parseTaskRef(input.id) : undefined;
  const bundle = resolveTaskReadBundle(parsed?.bundle, input.target);
  const adapterId = bundle.source.adapterId ?? detectAdapterId(bundle.source.path);
  const id = parsed ? taskIdForAdapter(parsed.id, adapterId) : undefined;
  // History rows are keyed by task id in state.db, not per bundle.
  return { rows: readTaskHistory({ id, limit }) };
}

export interface TasksSyncResult {
  installed: string[];
  /** Tasks whose installed schedule/enabled state drifted from the .yml and were reinstalled. */
  updated: string[];
  removed: string[];
  unchanged: string[];
  skipped: { id: string; reason: string }[];
  backend: string;
  /** Present only when a rebind bound an ineligible (e.g. mutable checkout) runtime. */
  warnings?: string[];
}

/**
 * Reconcile the on-disk task files of ONE bundle with the OS scheduler.
 *   • compile and runtime-project the complete desired task/workflow set;
 *     one invalid source rejects the sync before descriptor/backend mutation
 *   • install missing bindings only after that whole-set preflight succeeds
 *   • reinstall tasks whose schedule or enabled state changed in the .yml
 *     (drift detected by comparing the backend's installed signature against
 *     the signature the current definition would produce)
 *   • remove orphan scheduler entries that no longer have a backing file
 *
 * `--bundle <bundle>` scopes the reconciliation to that bundle: the file set is
 * the bundle's `tasks/*.yml` and — crucially — the scheduler entries considered
 * are ONLY those attributed to the same bundle (parsed from the installed
 * `--bundle` token; absent ⇒ primary). This is the security boundary that keeps
 * "registering a bundle never activates code": a plain (primary) sync never
 * installs from, updates, or removes another bundle's entries, and sync never
 * scans all bundles. Activation happens only through explicit `add --bundle`
 * (or `sync --bundle` on a bundle whose task files are already present).
 */
/**
 * Compute (but never apply) a scheduler sync plan: everything through
 * `finalizeSchedulerSyncPlan`'s final call, stopping strictly before
 * `applySchedulerSyncPlan`. Shared by `akmTasksSync` (applies the plan) and
 * `akmTasksSyncPlan` (#849 `--dry-run`, never applies it) so the two paths
 * can never drift on what "the plan" means. `prepared?.publish`, the one
 * deferred write-producing closure in this pipeline, is returned but never
 * invoked here — only `applySchedulerSyncPlan` may call it.
 */
async function buildSchedulerSyncPlan(
  deps: { backend?: SchedulerBackend; schedulerRuntime?: () => PreparedSchedulerRuntime },
  bundleTarget: string | undefined,
  options: { rebind?: boolean },
): Promise<{
  sched: SchedulerBackend;
  plan: SchedulerSyncPlan;
  prepared: ReturnType<typeof prepareSchedulerSyncRuntime> | undefined;
  warnings: string[];
}> {
  const resolved = resolveTaskReadBundle(undefined, bundleTarget);
  const config = loadConfig();
  const stashDir = resolved.source.path;
  const syncTarget = bundleTarget !== undefined && !isPrimaryStashPath(stashDir) ? bundleTarget : undefined;
  const sched = deps.backend ?? selectBackend();
  if (!sched.inspectBindings) {
    throw new ConfigError(
      `Scheduler backend "${sched.name}" cannot provide one coherent inspection for transactional sync.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const inspection = await sched.inspectBindings({ rebind: options.rebind === true });
  const rawEntries: Array<InstalledSchedulerBinding | RebindSchedulerBinding> = [...inspection.installed];
  const allEntries: InstalledSchedulerBinding[] = rawEntries.map((entry) => {
    const contextPath = "contextPath" in entry ? entry.contextPath : "";
    // #846: recover the resolved bundle path this entry was installed
    // under from its own scheduler-context descriptor. Any failure (no
    // descriptor, unreadable, corrupt, owned by another user) leaves
    // ownerBundlePath unset — belongsToBundle must never treat that as
    // "mine".
    const ownerBundlePath = contextPath ? resolveInstalledOwnerPath(contextPath) : undefined;
    return {
      ...entry,
      ...(entry.nativeId !== undefined ? { nativeId: entry.nativeId } : {}),
      ...(entry.invocation !== undefined ? { invocation: Object.freeze([...entry.invocation]) } : {}),
      binding: "binding" in entry ? [...entry.binding] : [],
      contextPath,
      ...(ownerBundlePath !== undefined ? { ownerBundlePath } : {}),
    };
  });
  const nativeArtifacts = inspection.artifacts;
  const common = {
    sourceRoot: stashDir,
    adapterId: resolved.source.adapterId ?? detectAdapterId(stashDir),
    bundleName: resolved.source.name,
    // #846: only meaningful for a primary/unconfigured-bundle sync. A
    // `--bundle <target>` entry's scheduler-context descriptor records the
    // invoking process's OWN primary AKM_BUNDLE_DIR, not the targeted
    // bundle's directory, so path-scoping stays gated on the case it's
    // actually valid for (see belongsToBundle).
    ...(syncTarget === undefined ? { bundlePath: path.resolve(stashDir) } : {}),
    ...(syncTarget ? { bundleTarget: syncTarget } : {}),
    backend: sched.name,
    installed: allEntries,
    nativeArtifacts,
    inspection: Object.freeze({ installed: allEntries, artifacts: nativeArtifacts }),
    rebind: options.rebind === true,
    config,
    resolveAsset: taskProjectionAssetResolver(config, resolved.source.name, stashDir),
  } as const;

  // Pass one validates every desired source, ownership domain, schedule, and
  // installed-id collision before runtime descriptor preparation is possible.
  const preparedSources = await prepareSchedulerSyncSourceSet(common);
  const preflight = finalizeSchedulerSyncPlan(common, preparedSources);
  const warnings: string[] = [];
  const expectedSignature = sched.expectedSignature?.bind(sched);
  const needsRuntime = preflight.operations.some(
    (operation) => operation.kind !== "remove" && operation.options?.binding === undefined,
  );
  const prepared = needsRuntime
    ? prepareSchedulerSyncRuntime(
        syncTarget ? { target: syncTarget } : undefined,
        deps,
        options.rebind === true,
        "reconcile native scheduler bindings",
        warnings,
      )
    : undefined;
  const plan = finalizeSchedulerSyncPlan(
    {
      ...common,
      ...(prepared?.options ? { installOptions: prepared.options } : {}),
      ...(expectedSignature
        ? {
            expectedSignature: (binding: SchedulerBinding, install?: SchedulerInstallOptions) =>
              expectedSignature(binding, install),
          }
        : {}),
    },
    preparedSources,
  );

  return { sched, plan, prepared, warnings };
}

export async function akmTasksSync(
  deps: { backend?: SchedulerBackend; schedulerRuntime?: () => PreparedSchedulerRuntime } = {},
  bundleTarget?: string,
  options: { rebind?: boolean } = {},
): Promise<TasksSyncResult> {
  const { sched, plan, prepared, warnings } = await buildSchedulerSyncPlan(deps, bundleTarget, options);
  await applySchedulerSyncPlan(
    sched,
    plan,
    prepared?.publish && plan.operations.some((operation) => operation.kind !== "remove")
      ? prepared.publish
      : undefined,
  );
  return {
    installed: [...plan.installed],
    updated: [...plan.updated],
    removed: [...plan.removed],
    unchanged: [...plan.unchanged],
    skipped: [],
    backend: sched.name,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * `akm task sync --dry-run` (#849): compute the exact same plan
 * `akmTasksSync` would apply, then return a non-mutating preview instead of
 * calling `applySchedulerSyncPlan`. `buildSchedulerSyncPlan` is shared with
 * the real sync path specifically so this can never see a different plan
 * than the one a real sync would apply — and specifically so this function
 * never even holds a reference to a callable `publish` closure past this
 * point: `prepared.publish`, if any, is dropped on the floor here, never
 * invoked. Zero durable writes, mirroring `akm workflow plan`.
 */
export async function akmTasksSyncPlan(
  deps: { backend?: SchedulerBackend; schedulerRuntime?: () => PreparedSchedulerRuntime } = {},
  bundleTarget?: string,
  options: { rebind?: boolean } = {},
): Promise<SchedulerPlanPreview> {
  const { sched, plan } = await buildSchedulerSyncPlan(deps, bundleTarget, options);
  return renderSchedulerSyncPlanPreview(sched.name, plan);
}

export type TasksPruneReason = "invalid-context" | "dead-bundle-path";

export interface TasksPruneResult {
  readonly backend: string;
  readonly dryRun: boolean;
  readonly preview: SchedulerPlanPreview;
  readonly removed: readonly string[];
}

/**
 * Classify one installed scheduler binding as a prune candidate (#851), using
 * the same two signals `doctor`'s `inspectInstalledBinding` already computes
 * — deliberately narrower than that function's full `status` set. Only an
 * entry whose ownership can NEVER be resolved (`invalid-context`) or whose
 * resolved owner no longer exists on disk (`dead-bundle-path`) is a
 * candidate; `missing-path` (e.g. the akm binary itself moved) is a
 * different failure mode and is intentionally NOT folded in here, per the
 * scoping in #851 — an entry that still resolves to a live bundle is never a
 * candidate, full stop.
 */
function classifyPruneCandidate(entry: InstalledSchedulerBinding): TasksPruneReason | undefined {
  let ownerBundlePath: string | undefined;
  try {
    ownerBundlePath = validateSchedulerContextDescriptor(entry.contextPath).environment.AKM_BUNDLE_DIR;
  } catch {
    return "invalid-context";
  }
  if (ownerBundlePath !== undefined && !fs.existsSync(ownerBundlePath)) return "dead-bundle-path";
  return undefined;
}

/**
 * Compute (never apply) the exact set of remove operations `akm task prune`
 * would perform: scan every installed scheduler binding across ALL bundles
 * (orphans by definition don't resolve to a current bundle, so this is
 * deliberately not scoped the way `sync` is), keep only entries
 * `classifyPruneCandidate` flags, and build each removal through the same
 * exact-fingerprint/ordinal-attribution machinery `sync`'s own removal path
 * uses (`buildSchedulerRemoveOperation`). `belongsToBundle` and
 * `finalizeSchedulerSyncPlan` are never touched — this is a parallel,
 * narrower path so #846's guard stays exactly as conservative as it was.
 */
type SchedulerRemoveOperation = Extract<SchedulerSyncOperation, { kind: "remove" }>;

async function buildTaskPrunePlan(
  deps: { backend?: SchedulerBackend } = {},
  options: { id?: readonly string[] } = {},
): Promise<{ sched: SchedulerBackend; operations: readonly SchedulerRemoveOperation[] }> {
  const sched = deps.backend ?? selectBackend();
  if (!sched.inspectBindings) {
    throw new ConfigError(
      `Scheduler backend "${sched.name}" cannot provide one coherent inspection for prune.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const inspection = await sched.inspectBindings({});
  const candidates = new Map<string, TasksPruneReason>();
  for (const entry of inspection.installed) {
    const reason = classifyPruneCandidate(entry);
    if (reason) candidates.set(entry.id, reason);
  }
  const requestedIds = options.id?.filter((id) => id.length > 0) ?? [];
  for (const id of requestedIds) {
    if (!candidates.has(id)) {
      throw new UsageError(
        `Scheduler binding ${JSON.stringify(id)} is not an orphaned prune candidate ` +
          "(either not installed, or it still resolves to a live bundle) — refusing to prune it.",
        "INVALID_FLAG_VALUE",
      );
    }
  }
  const idFilter = requestedIds.length > 0 ? new Set(requestedIds) : undefined;
  const resolved = resolveTaskReadBundle(undefined, undefined);
  const bundleContext = {
    adapterId: resolved.source.adapterId ?? detectAdapterId(resolved.source.path),
    bundleName: resolved.source.name,
  };
  const operations: SchedulerRemoveOperation[] = [];
  for (const entry of inspection.installed) {
    const reason = candidates.get(entry.id);
    if (!reason) continue;
    if (idFilter && !idFilter.has(entry.id)) continue;
    const operation = buildSchedulerRemoveOperation(entry.id, entry, inspection.artifacts, bundleContext);
    operations.push(Object.freeze({ ...operation, reason }));
  }
  return { sched, operations: Object.freeze(operations) };
}

/**
 * `akm task prune` (#851): remove installed scheduler bindings `sync` can
 * never reclaim because their own `--scheduler-context` descriptor doesn't
 * resolve to a live bundle. Defaults to dry-run — no `--yes` and no `--id`
 * means zero backend calls that could mutate anything, matching
 * `akmTasksSyncPlan`'s zero-write guarantee. `--id` (one or more) narrows
 * execution to exactly those bindings; `--yes` alone executes every
 * currently-computed candidate. Both still return the full preview so the
 * plan is never silent about what it did.
 */
export async function akmTasksPrune(
  deps: { backend?: SchedulerBackend } = {},
  options: { yes?: boolean; id?: readonly string[] } = {},
): Promise<TasksPruneResult> {
  const { sched, operations } = await buildTaskPrunePlan(deps, options);
  const preview = renderSchedulerPlanPreview(sched.name, operations);
  if (!options.yes) {
    return { backend: sched.name, dryRun: true, preview, removed: [] };
  }
  await applySchedulerTransaction(sched, operations, {
    initialExpectations: operations.map((operation) => operation.expected as SchedulerMutationExpectation),
  });
  return {
    backend: sched.name,
    dryRun: false,
    preview,
    removed: operations.map((operation) => operation.id),
  };
}

export interface TasksDoctorResult {
  backend: string;
  akm: { argv: string[]; via: string; kind?: string; eligible?: boolean };
  caller: { argv: string[]; via: string; kind?: string; eligible?: boolean };
  bindings: Array<{
    argv: string[];
    contextPath: string;
    taskIds: string[];
    status: string[];
  }>;
  remediation?: "akm task sync --rebind";
  logDir: string;
  historyDir: string;
  engine: { defaultEngine?: string; available: string[] };
  scheduleSubset: string;
  warnings: string[];
  /**
   * Effective proposal-queue triage settings for the default improve strategy.
   * Absent when the resolved strategy has no `triage` process block.
   */
  /**
   * D8 — the autonomy gate's effect on the default improve strategy. A scheduled
   * run that quietly stopped consolidating is the silent no-op the gate exists
   * to prevent, and this is where an operator looks for the explanation.
   */
  improveAutonomy?: {
    enabled: boolean;
    configKey: string;
    gatedLanes: { lane: string; reason: string }[];
  };
  improveTriage?: {
    defaultStrategy: string;
    enabled: boolean;
    applyMode: string;
    policy: string;
  };
}

export async function akmTasksDoctor(
  deps: { backend?: SchedulerBackend; resolveInvocation?: typeof resolveAkmInvocation } = {},
): Promise<TasksDoctorResult> {
  const warnings: string[] = [];
  let invocation: { argv: string[]; via: string; kind?: string; eligible?: boolean } = {
    argv: [],
    via: "unresolved",
  };
  try {
    const r = (deps.resolveInvocation ?? resolveAkmInvocation)();
    invocation = { argv: r.argv, via: r.via, kind: r.kind, eligible: r.eligible };
  } catch (err) {
    warnings.push(err instanceof Error ? err.message : String(err));
  }
  const skipNativeInspection = process.env.BUN_TEST === "1" && !deps.backend;
  const sched = deps.backend ?? (skipNativeInspection ? undefined : selectBackend());
  const backend = sched?.name ?? backendNameForPlatform();
  let installed: InstalledSchedulerBinding[] = [];
  if (skipNativeInspection) {
    warnings.push("Native scheduler inspection is skipped inside the bun test harness.");
  } else {
    try {
      installed = await sched!.list();
    } catch (error) {
      warnings.push(
        `Unable to inspect installed ${backend} definitions: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const bindings = groupInstalledBindings(installed, invocation);
  // Report the EFFECTIVE engine view — the same one the runner resolves —
  // so doctor never says "no engine" on an install where tasks actually run.
  const { config } = withEngineFallback(loadConfig());
  const defaultEngine = config.defaults?.engine;
  const engines = Object.keys(config.engines ?? {});

  // §6.1: surface the effective triage settings for the default improve
  // strategy. The struct is a fixed shape, so this is a deliberate addition.
  const improveStrategyName =
    typeof config.defaults?.improveStrategy === "string" ? config.defaults.improveStrategy : "default";
  // D8 — report the EFFECTIVE strategy, not the raw one. Resolving the raw
  // strategy here would report `applyMode: "promote"` for a promote strategy
  // under a review-first config, while the run actually uses "queue" — a doctor
  // command lying about the thing it exists to diagnose.
  const rawStrategy = resolveImproveStrategy(config.defaults?.improveStrategy, config).config;
  const { config: effectiveStrategy, gated } = applyAutonomyGate(rawStrategy, config);
  const autonomyEnabled = isImproveAutonomyEnabled(config);
  // Memory cleanup has no strategy flag to downgrade, so add that direct lane
  // to the strategy-derived gate report.
  const allGated = autonomyEnabled ? [] : [...gated, ...describeGatedLanes(configuredDirectAutonomyLanes())];
  const improveAutonomy = {
    enabled: autonomyEnabled,
    configKey: IMPROVE_AUTONOMY_CONFIG_KEY,
    gatedLanes: allGated.map((entry) => ({ lane: entry.lane as string, reason: entry.reason })),
  };
  const triage = effectiveStrategy.processes?.triage;
  const improveTriage = triage
    ? {
        defaultStrategy: improveStrategyName,
        enabled: triage.enabled === true,
        applyMode: triage.applyMode ?? "queue",
        policy: triage.policy ?? "personal-stash",
      }
    : undefined;

  return {
    backend,
    akm: invocation,
    caller: invocation,
    bindings,
    ...(bindings.some((binding) => !binding.status.includes("ok"))
      ? { remediation: "akm task sync --rebind" as const }
      : {}),
    logDir: getTaskLogDir(),
    historyDir: getTaskHistoryDir(),
    engine: { defaultEngine, available: engines },
    scheduleSubset: SCHEDULE_SUPPORTED_SUBSET_HINT,
    warnings,
    improveAutonomy,
    ...(improveTriage ? { improveTriage } : {}),
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

async function applySchedulerSyncPlan(
  backend: SchedulerBackend,
  plan: SchedulerSyncPlan,
  publish?: () => void,
): Promise<void> {
  await applySchedulerTransaction(backend, plan.operations, {
    initialExpectations: plan.operations.map((operation) => operation.expected as SchedulerMutationExpectation),
    assertReadSet: () => assertSchedulerSourceSnapshot(plan.sourceSnapshot),
    beforeOperation: (_operation, index) => {
      if (index === 0) publish?.();
    },
  });
}

async function applySchedulerTransaction(
  backend: SchedulerBackend,
  operations: SchedulerSyncPlan["operations"],
  hooks: {
    initialExpectations: readonly SchedulerMutationExpectation[];
    assertReadSet?: () => void;
    beforeOperation?: (operation: SchedulerSyncPlan["operations"][number], index: number) => void | Promise<void>;
    afterOperations?: () => void | Promise<void>;
    rollbackExternal?: () => void | Promise<void>;
    suppressNativeRollbackWhenExternalFails?: boolean;
    allowNativeRollbackAfterExternalFailure?: (error: unknown) => boolean;
  },
): Promise<void> {
  if (operations.length === 0) {
    hooks.assertReadSet?.();
    await hooks.afterOperations?.();
    hooks.assertReadSet?.();
    return;
  }
  hooks.assertReadSet?.();
  if (!backend.snapshotBindings || !backend.restoreBindings) {
    throw new ConfigError(
      `Scheduler backend "${backend.name}" cannot snapshot and restore a whole-set transaction.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const nativeIds = [
    ...new Set(
      operations.map((operation) =>
        operation.kind === "remove" ? operation.nativeId : schedulerBindingNativeId(operation.binding),
      ),
    ),
  ];
  const snapshot = await backend.snapshotBindings(nativeIds);
  assertSchedulerTransactionSnapshot(snapshot, nativeIds, hooks.initialExpectations);
  const rollbackExpected = schedulerRollbackExpectations(snapshot, operations);
  hooks.assertReadSet?.();
  try {
    for (const [index, operation] of operations.entries()) {
      hooks.assertReadSet?.();
      await hooks.beforeOperation?.(operation, index);
      hooks.assertReadSet?.();
      if (operation.kind === "remove") await backend.uninstall(operation.nativeId, operation.expected);
      else await backend.install(operation.binding, operation.options, operation.expected);
      hooks.assertReadSet?.();
    }
    hooks.assertReadSet?.();
    await hooks.afterOperations?.();
    hooks.assertReadSet?.();
  } catch (primaryError) {
    let externalRollbackError: unknown;
    try {
      await hooks.rollbackExternal?.();
    } catch (error) {
      externalRollbackError = error;
    }
    let nativeRollbackError: unknown;
    const externalStateAllowsNativeRollback =
      externalRollbackError !== undefined &&
      hooks.allowNativeRollbackAfterExternalFailure?.(externalRollbackError) === true;
    if (
      !(externalRollbackError && hooks.suppressNativeRollbackWhenExternalFails && !externalStateAllowsNativeRollback)
    ) {
      try {
        await backend.restoreBindings(snapshot, rollbackExpected);
      } catch (error) {
        nativeRollbackError = error;
      }
    }
    const rollbackErrors = [externalRollbackError, nativeRollbackError].filter(
      (error): error is NonNullable<typeof error> => error !== undefined,
    );
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...rollbackErrors],
        `Scheduler transaction failed and rollback was incomplete: ${errorMessage(primaryError)}`,
      );
    }
    throw primaryError;
  }
}

function schedulerRollbackExpectations(
  snapshot: SchedulerTransactionSnapshot,
  operations: SchedulerSyncPlan["operations"],
): readonly SchedulerRollbackExpectation[] {
  return Object.freeze(
    snapshot.nativeIds.map((nativeId) => {
      const prior = snapshot.artifacts.find(
        (artifact) => schedulerNativeArtifactKey(artifact.nativeId) === schedulerNativeArtifactKey(nativeId),
      );
      const allowed: SchedulerRollbackState[] = [];
      if (prior) {
        if (prior.fingerprint === undefined) {
          throw new ConfigError(
            `Scheduler backend snapshot for ${JSON.stringify(nativeId)} has no exact fingerprint.`,
            "INVALID_CONFIG_FILE",
          );
        }
        allowed.push(
          Object.freeze({
            state: "present" as const,
            ...(prior.bindingId !== undefined ? { bindingId: prior.bindingId } : {}),
            ...(prior.invocation !== undefined ? { invocation: Object.freeze([...prior.invocation]) } : {}),
            fingerprint: prior.fingerprint,
          }),
        );
      } else {
        allowed.push(Object.freeze({ state: "absent" as const }));
      }
      const matchingOperations = operations.filter((candidate) => {
        const operationNativeId =
          candidate.kind === "remove" ? candidate.nativeId : schedulerBindingNativeId(candidate.binding);
        return schedulerNativeArtifactKey(operationNativeId) === schedulerNativeArtifactKey(nativeId);
      });
      for (const operation of matchingOperations) {
        if (operation.kind === "remove") {
          if (!allowed.some((state) => state.state === "absent")) {
            allowed.push(Object.freeze({ state: "absent" as const }));
          }
          continue;
        }
        if (operation.resultFingerprint === undefined) {
          throw new ConfigError(
            `Scheduler backend cannot freeze the post-mutation fingerprint for ${JSON.stringify(nativeId)}.`,
            "INVALID_CONFIG_FILE",
          );
        }
        allowed.push(
          Object.freeze({
            state: "present" as const,
            bindingId: operation.binding.id,
            invocation: Object.freeze([...operation.binding.invocation]),
            fingerprint: operation.resultFingerprint,
          }),
        );
      }
      return Object.freeze({ nativeId, allowed: Object.freeze(allowed) });
    }),
  );
}

function assertSchedulerTransactionSnapshot(
  snapshot: SchedulerTransactionSnapshot,
  nativeIds: readonly string[],
  initialExpectations: readonly SchedulerMutationExpectation[],
): void {
  if (
    !snapshot ||
    !Array.isArray(snapshot.nativeIds) ||
    !Array.isArray(snapshot.artifacts) ||
    nativeIds.some((nativeId) => !snapshot.nativeIds.includes(nativeId))
  ) {
    throw new ConfigError("Scheduler backend returned an incomplete transaction snapshot.", "INVALID_CONFIG_FILE");
  }
  const snapshotKeys = snapshot.nativeIds.map(schedulerNativeArtifactKey);
  const requestedKeys = nativeIds.map(schedulerNativeArtifactKey);
  if (
    snapshotKeys.length !== requestedKeys.length ||
    new Set(snapshotKeys).size !== snapshotKeys.length ||
    snapshotKeys.some((key) => !requestedKeys.includes(key))
  ) {
    throw new ConfigError(
      "Scheduler backend returned an inexact normalized transaction snapshot set.",
      "INVALID_CONFIG_FILE",
    );
  }
  for (const expected of initialExpectations) {
    const artifact = assertSchedulerNativeArtifactCardinality(
      snapshot.artifacts,
      expected.nativeId,
      expected.state === "absent" ? 0 : 1,
    );
    assertSchedulerMutationArtifact(artifact, expected);
  }
}

async function prepareTaskAddSchedulerTransaction(input: {
  id: string;
  installTarget: string | undefined;
  ownerTarget: string;
  installOpts: { target?: string } | undefined;
  taskBindings: readonly SchedulerBinding[];
  sched: SchedulerBackend;
  deps: TaskMutationDeps;
  rebind: boolean;
}): Promise<{
  runtimeOpts: SchedulerInstallOptions | undefined;
  publishRuntime?: () => void;
  operations: SchedulerSyncPlan["operations"];
  initialExpectations: readonly SchedulerMutationExpectation[];
  publishOperationIndex: number;
}> {
  if (!input.sched.inspectBindings) {
    throw new ConfigError(
      `Scheduler backend "${input.sched.name}" cannot provide one coherent inspection for transactional add.`,
      "INVALID_CONFIG_FILE",
    );
  }
  if (!input.sched.snapshotBindings || !input.sched.restoreBindings || !input.sched.expectedSignature) {
    throw new ConfigError(
      `Scheduler backend "${input.sched.name}" cannot provide exact snapshot, restore, and signature contracts for transactional add.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const inspection = await input.sched.inspectBindings({ rebind: input.rebind });
  const installedEntries = [...inspection.installed];
  const nativeArtifacts = [...inspection.artifacts];
  const seenNativeKeys = new Set<string>();
  for (const artifact of nativeArtifacts) {
    const key = schedulerNativeArtifactKey(artifact.nativeId);
    if (seenNativeKeys.has(key)) {
      throw new UsageError(
        `Scheduler inspection has duplicate normalized native artifact ${JSON.stringify(artifact.nativeId)}.`,
        "RESOURCE_ALREADY_EXISTS",
      );
    }
    seenNativeKeys.add(key);
  }
  for (const binding of input.taskBindings) {
    assertNoForeignSchedule(installedEntries, binding.id, input.ownerTarget);
  }
  const taskEntries = installedEntries.filter((entry) => installedEntryRunsTask(entry, input.id));
  const foreignTaskEntry = taskEntries.find((entry) => !sameBundle(entry.target, input.ownerTarget));
  if (foreignTaskEntry) {
    throw new UsageError(foreignScheduleMessage(input.id, foreignTaskEntry.target), "RESOURCE_ALREADY_EXISTS");
  }
  assertSchedulerNativeArtifactOwnership(input.taskBindings, nativeArtifacts);
  const primary = input.taskBindings[0];
  if (!primary) throw new Error("invariant: scheduler transaction has no desired binding");
  const installedEntry = installedEntries.find((entry) => entry.id === primary.id) ?? taskEntries[0];
  const preparedRuntime =
    installedEntry && !input.rebind
      ? {
          options: {
            ...input.installOpts,
            binding: Object.freeze([...installedEntry.binding]),
            contextPath: installedEntry.contextPath,
          },
        }
      : prepareSchedulerSyncRuntime(
          input.installOpts,
          input.deps,
          input.rebind,
          `create scheduler entry for task "${input.id}"`,
          [],
        );
  const runtimeOpts = preparedRuntime.options;
  const removals: SchedulerSyncPlan["operations"][number][] = taskEntries.map((entry) => {
    const invocation = entry.invocation;
    if (!invocation) {
      throw new UsageError(
        `Installed scheduler binding ${JSON.stringify(entry.id)} has no exact parsed owner; refusing replacement.`,
        "RESOURCE_ALREADY_EXISTS",
      );
    }
    const nativeId = entry.nativeId ?? schedulerNativeBindingId(entry.id);
    const artifact = assertSchedulerNativeArtifactCardinality(nativeArtifacts, nativeId, 1);
    if (!artifact?.fingerprint || artifact.bindingId !== entry.id) {
      throw new UsageError(
        `Installed scheduler binding ${JSON.stringify(entry.id)} has no exact coherent fingerprint.`,
        "RESOURCE_ALREADY_EXISTS",
      );
    }
    const logicalSource = primary.logicalSource;
    const ordinal = schedulerBindingOrdinal(entry.id, logicalSource, invocation);
    if (ordinal === undefined) {
      throw new UsageError(
        `Installed scheduler binding ${JSON.stringify(entry.id)} has no exact schedule ordinal; refusing replacement.`,
        "RESOURCE_ALREADY_EXISTS",
      );
    }
    return Object.freeze({
      kind: "remove" as const,
      id: entry.id,
      nativeId,
      expected: Object.freeze({
        bindingId: entry.id,
        nativeId,
        logicalSource,
        ordinal,
        invocation: Object.freeze([...invocation]),
        fingerprint: artifact.fingerprint,
      }),
    });
  });
  const installs: SchedulerSyncPlan["operations"][number][] = input.taskBindings.map((binding) => {
    const nativeId = schedulerBindingNativeId(binding);
    const resultFingerprint = input.sched.expectedSignature!(binding, runtimeOpts);
    if (!resultFingerprint) {
      throw new ConfigError(
        `Scheduler backend "${input.sched.name}" cannot freeze the post-install fingerprint for ${JSON.stringify(binding.id)}.`,
        "INVALID_CONFIG_FILE",
      );
    }
    return Object.freeze({
      kind: "install" as const,
      binding,
      expected: Object.freeze({
        state: "absent" as const,
        bindingId: binding.id,
        nativeId,
        logicalSource: binding.logicalSource,
        ordinal: binding.ordinal,
        invocation: binding.invocation,
      }),
      resultFingerprint,
      ...(runtimeOpts ? { options: runtimeOpts } : {}),
    });
  });
  const initialByKey = new Map<string, SchedulerMutationExpectation>();
  for (const removal of removals) {
    if (removal.kind !== "remove") continue;
    initialByKey.set(
      schedulerNativeArtifactKey(removal.nativeId),
      Object.freeze({ ...removal.expected, state: "present" as const }),
    );
  }
  for (const install of installs) {
    if (install.kind === "remove") continue;
    const key = schedulerNativeArtifactKey(schedulerBindingNativeId(install.binding));
    if (!initialByKey.has(key)) initialByKey.set(key, install.expected);
  }
  return Object.freeze({
    runtimeOpts,
    ...(preparedRuntime.publish ? { publishRuntime: preparedRuntime.publish } : {}),
    operations: Object.freeze([...removals, ...installs]),
    initialExpectations: Object.freeze([...initialByKey.values()]),
    publishOperationIndex: removals.length,
  });
}

function prepareSchedulerSyncRuntime(
  base: { target?: string } | undefined,
  deps: { backend?: SchedulerBackend; schedulerRuntime?: () => PreparedSchedulerRuntime },
  explicitRebind: boolean,
  operation: string,
  warnings: string[],
): { options?: SchedulerInstallOptions; publish?: () => void } {
  if (deps.backend && !deps.schedulerRuntime) return base ? { options: base } : {};
  if (deps.schedulerRuntime) {
    const runtime = deps.schedulerRuntime();
    warnIneligibleRebind(runtime, explicitRebind, warnings);
    return { options: { ...base, binding: runtime.binding, contextPath: runtime.contextPath } };
  }

  const invocation = resolveAndValidateSchedulerInvocation(explicitRebind, operation);
  warnIneligibleRebind(invocation, explicitRebind, warnings);
  const descriptor = schedulerContextDescriptor();
  const contextPath = schedulerContextPath(descriptor);
  return {
    options: { ...base, binding: invocation.binding, contextPath },
    publish: () => {
      const written = writeSchedulerContextDescriptor(descriptor);
      if (written !== contextPath) {
        throw new ConfigError("Scheduler context descriptor path changed after preflight.", "INVALID_CONFIG_FILE");
      }
    },
  };
}

function resolveAndValidateSchedulerInvocation(explicitRebind: boolean, operation: string): PreparedSchedulerRuntime {
  const invocation = resolveAkmInvocation();
  if (!invocation.eligible && !explicitRebind) {
    throw new UsageError(
      `Refusing to ${operation} from an ineligible ${invocation.kind ?? "unknown"} invocation (${invocation.argv.join(" ")}).`,
      "INVALID_FLAG_VALUE",
      "npm-global ownership could not be verified. Run `npm install --global akm-cli` and use that launcher, use a standalone installation, or explicitly repeat the operation with --rebind.",
    );
  }
  return { binding: invocation.argv, contextPath: "", eligible: invocation.eligible, kind: invocation.kind };
}

function warnIneligibleRebind(runtime: PreparedSchedulerRuntime, explicitRebind: boolean, warnings: string[]): void {
  if (!explicitRebind || runtime.eligible !== false || warnings.length > 0) return;
  warnings.push(
    `--rebind bound scheduled tasks to an ineligible ${runtime.kind ?? "unknown"} invocation (${runtime.binding.join(" ")}); scheduled runs will invoke a mutable, unproven binary. Install akm via \`npm install --global akm-cli\` or a standalone release, then re-run \`akm task sync --rebind\`.`,
  );
}

export function prepareSchedulerRuntime(
  explicitRebind: boolean,
  operation: string,
  deps: {
    resolveInvocation?: typeof resolveAkmInvocation;
    writeDescriptor?: typeof writeSchedulerContextDescriptor;
  } = {},
): PreparedSchedulerRuntime {
  const invocation = (deps.resolveInvocation ?? resolveAkmInvocation)();
  if (!invocation.eligible && !explicitRebind) {
    throw new UsageError(
      `Refusing to ${operation} from an ineligible ${invocation.kind ?? "unknown"} invocation (${invocation.argv.join(" ")}).`,
      "INVALID_FLAG_VALUE",
      "npm-global ownership could not be verified. Run `npm install --global akm-cli` and use that launcher, use a standalone installation, or explicitly repeat the operation with --rebind.",
    );
  }
  const contextPath = (deps.writeDescriptor ?? writeSchedulerContextDescriptor)(schedulerContextDescriptor());
  return { binding: invocation.argv, contextPath, eligible: invocation.eligible, kind: invocation.kind };
}

function groupInstalledBindings(
  entries: readonly InstalledSchedulerBinding[],
  invocation: TasksDoctorResult["akm"],
): TasksDoctorResult["bindings"] {
  const groups = new Map<string, TasksDoctorResult["bindings"][number]>();
  for (const entry of entries) {
    const argv = [...entry.binding];
    const status = inspectInstalledBinding(entry, invocation);
    const key = JSON.stringify([argv, entry.contextPath, status]);
    const existing = groups.get(key);
    if (existing) {
      existing.taskIds.push(entry.id);
      continue;
    }
    groups.set(key, {
      argv,
      contextPath: entry.contextPath,
      taskIds: [entry.id],
      status,
    });
  }
  return [...groups.values()].map((group) => ({ ...group, taskIds: group.taskIds.sort() }));
}

/** Best-effort recovery of an installed binding's owning bundle path (#846). */
function resolveInstalledOwnerPath(contextPath: string): string | undefined {
  try {
    return validateSchedulerContextDescriptor(contextPath).environment.AKM_BUNDLE_DIR;
  } catch {
    return undefined;
  }
}

function inspectInstalledBinding(entry: InstalledSchedulerBinding, invocation: TasksDoctorResult["akm"]): string[] {
  const status: string[] = [];
  const binding = entry.binding;
  if (
    !(invocation.eligible === true && sameArgv(binding, invocation.argv)) &&
    binding.some(
      (part) =>
        /(?:^|[\\/])src[\\/]cli\.ts$|(?:^|[\\/])dist[\\/](?:cli\.js|cli-node\.mjs)$/i.test(part) ||
        (path.isAbsolute(part) && hasGitAncestor(part)),
    )
  ) {
    status.push("checkout");
  }
  if (binding.some((part) => part === "akm" || part === "bun" || part === "node")) status.push("path-selected");
  try {
    validateSchedulerContextDescriptor(entry.contextPath);
  } catch {
    status.push("invalid-context");
  }
  const absolutePaths = [...binding.filter((part) => path.isAbsolute(part)), entry.contextPath];
  if (absolutePaths.some((part) => !fs.existsSync(part))) status.push("missing-path");
  if (status.length === 0) status.push("ok");
  return status;
}

function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hasGitAncestor(file: string): boolean {
  let current: string;
  try {
    current = path.dirname(fs.realpathSync(file));
  } catch {
    return false;
  }
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function taskAssetRef(id: string): AssetRef {
  return { type: "task", name: id };
}

type TaskSourceExpectation =
  | Readonly<{
      state: "absent";
      filePath: string;
      rootRealPath: string;
      rootPhysicalIdentity: string;
      rootMtimeNs: string;
      rootCtimeNs: string;
    }>
  | Readonly<{
      state: "present";
      filePath: string;
      rootRealPath: string;
      rootPhysicalIdentity: string;
      rootMtimeNs: string;
      rootCtimeNs: string;
      realPath: string;
      physicalIdentity: string;
      size: number;
      mtimeNs: string;
      ctimeNs: string;
      sha256: string;
      bytesBase64: string;
      content: string;
    }>;

function captureTaskSourceExpectation(filePathInput: string, rootInput: string): TaskSourceExpectation {
  const filePath = path.resolve(filePathInput);
  const root = path.resolve(rootInput);
  const lexicalRelative = path.relative(root, filePath);
  if (lexicalRelative === "" || lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative)) {
    throw new UsageError(`${filePathInput} resolves outside the task source root.`, "PATH_ESCAPE_VIOLATION");
  }
  const rootRealPath = fs.realpathSync(root);
  const rootStat = fs.statSync(rootRealPath, { bigint: true });
  if (!rootStat.isDirectory()) {
    throw new UsageError(`${root} is not a task source directory.`, "INVALID_FLAG_VALUE");
  }
  const common = {
    filePath,
    rootRealPath,
    rootPhysicalIdentity: rootStat.ino === 0n ? `path:${rootRealPath}` : `inode:${rootStat.dev}:${rootStat.ino}`,
    rootMtimeNs: String(rootStat.mtimeNs),
    rootCtimeNs: String(rootStat.ctimeNs),
  };
  let descriptor: number | undefined;
  try {
    const noFollow = "O_NOFOLLOW" in fs.constants ? fs.constants.O_NOFOLLOW : 0;
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) {
      throw new UsageError(`${filePath} is not a regular task source.`, "INVALID_FLAG_VALUE");
    }
    if (before.size > BigInt(TASK_V3_MAX_SOURCE_BYTES)) {
      throw new UsageError(
        `${filePath} exceeds the 1 MiB (${TASK_V3_MAX_SOURCE_BYTES}-byte) task source limit.`,
        "INVALID_FLAG_VALUE",
      );
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameTaskSourceStat(before, after) || BigInt(bytes.byteLength) !== before.size) {
      throw new UsageError(`${filePath} changed while its guarded bytes were read.`, "RESOURCE_ALREADY_EXISTS");
    }
    const realPath = fs.realpathSync(filePath);
    const physicalRelative = path.relative(rootRealPath, realPath);
    if (physicalRelative === "" || physicalRelative.startsWith("..") || path.isAbsolute(physicalRelative)) {
      throw new UsageError(`${filePath} resolves outside the task source root.`, "PATH_ESCAPE_VIOLATION");
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new UsageError(`${filePath} contains invalid UTF-8 bytes.`, "INVALID_FLAG_VALUE");
    }
    return Object.freeze({
      state: "present" as const,
      ...common,
      realPath,
      physicalIdentity: before.ino === 0n ? `path:${realPath}` : `inode:${before.dev}:${before.ino}`,
      size: bytes.byteLength,
      mtimeNs: String(before.mtimeNs),
      ctimeNs: String(before.ctimeNs),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytesBase64: bytes.toString("base64"),
      content,
    });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return Object.freeze({ state: "absent" as const, ...common });
    }
    if (cause instanceof UsageError) throw cause;
    if ((cause as NodeJS.ErrnoException).code === "ELOOP") {
      throw new UsageError(`${filePath} must not be a symbolic task source.`, "RESOURCE_ALREADY_EXISTS");
    }
    throw new UsageError(
      `${filePath} could not be guarded as a contained regular task source: ${errorMessage(cause)}`,
      "PATH_ESCAPE_VIOLATION",
    );
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function assertTaskSourceExpectation(expected: TaskSourceExpectation): void {
  const actual = captureTaskSourceExpectation(expected.filePath, expected.rootRealPath);
  if (!sameTaskSourceExpectation(actual, expected)) {
    throw new UsageError(
      `Task source ${JSON.stringify(expected.filePath)} changed after transaction planning.`,
      "RESOURCE_ALREADY_EXISTS",
    );
  }
}

function sameTaskSourceExpectation(left: TaskSourceExpectation, right: TaskSourceExpectation): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertTaskSourceRestored(expected: TaskSourceExpectation): void {
  const actual = captureTaskSourceExpectation(expected.filePath, expected.rootRealPath);
  const restored =
    actual.state === expected.state &&
    actual.rootPhysicalIdentity === expected.rootPhysicalIdentity &&
    (actual.state === "absent" ||
      (expected.state === "present" && actual.sha256 === expected.sha256 && actual.content === expected.content));
  if (!restored) {
    throw new UsageError(
      `Task source ${JSON.stringify(expected.filePath)} could not be restored without replacing a concurrent owner.`,
      "RESOURCE_ALREADY_EXISTS",
    );
  }
}

class TaskSourceRestoredBoundaryError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(errorMessage(cause));
    this.name = "TaskSourceRestoredBoundaryError";
    this.cause = cause;
  }
}

function sameTaskSourceStat(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function hashTaskSource(source: string): string {
  return createHash("sha256").update(Buffer.from(source, "utf8")).digest("hex");
}

/**
 * Resolve the bundle a mutating/run task command targets. Returns the resolved
 * write/read target, its stash path, and the `--bundle <bundle>` token to embed
 * in scheduled invocations. The primary bundle uses the target-less form.
 */
function resolveTaskBundle(
  target: string | undefined,
  opts: { requireWritable: boolean },
): {
  resolved: ResolvedWriteTarget;
  config: AkmConfig;
  stashDir: string;
  bundleName: string;
  installTarget: string | undefined;
} {
  const config = loadConfig();
  const selected = resolveWriteTarget(config, target, { requireWritable: opts.requireWritable });
  const resolved = opts.requireWritable ? prepareWriteTargetForMutation(selected) : selected;
  const stashDir = resolved.source.path;
  const installTarget = isPrimaryStashPath(stashDir) ? undefined : (resolved.selector ?? resolved.source.name);
  return { resolved, config, stashDir, bundleName: resolved.source.name, installTarget };
}

function taskProjectionAssetResolver(
  config: AkmConfig,
  bundleName: string,
  bundleRoot: string,
): NonNullable<PrepareTaskV3ExecutionContext["resolveAsset"]> {
  return async ({ bundle, type, name }) => {
    if (bundle === bundleName) {
      return { file: await resolveAssetPath(bundleRoot, type, name), bundleRoot };
    }
    const target = resolveWriteTarget(config, bundle, { requireWritable: false });
    return {
      file: await resolveAssetPath(target.source.path, type, name),
      bundleRoot: target.source.path,
    };
  };
}

/**
 * Exported for `src/commands/tasks/explain.ts` (P2b Lane B, spec
 * docs/plans/specs/p2b-input-bindings.md §4.5, B-N4): `akm task explain`
 * resolves its `--bundle` axis identically to every other read-only task
 * verb here (`akm task history`, `akm task run`) — the SAME resolver, not a
 * second one.
 */
export function resolveTaskReadBundle(
  refBundle: string | undefined,
  flagBundle: string | undefined,
): ResolvedWriteTarget {
  if (refBundle && flagBundle && refBundle !== flagBundle) {
    throw new UsageError(
      `Task ref selects bundle ${JSON.stringify(refBundle)}, but --bundle selects ${JSON.stringify(flagBundle)}.`,
      "INVALID_FLAG_VALUE",
    );
  }
  const selector = flagBundle ?? refBundle;
  const config = loadConfig();
  let resolved: ResolvedWriteTarget;
  if (!selector) {
    resolved = resolveWorkingStashTarget(config, { requireWritable: false });
  } else {
    const configured = resolveConfiguredSources(config).some((source) => source.name === selector);
    const implicit = configured ? undefined : resolveImplicitScheduledBundleTarget(config, selector);
    resolved = implicit ?? resolveWriteTarget(config, selector, { requireWritable: false });
  }
  if (refBundle && resolved.source.name !== refBundle) {
    throw new UsageError(
      `Task ref bundle ${JSON.stringify(refBundle)} does not match the resolved source.`,
      "INVALID_FLAG_VALUE",
    );
  }
  return resolved;
}

/**
 * New scheduler bindings always carry a canonical `--bundle <owner>` token,
 * including an env-selected working stash. That stash need not be persisted in
 * config (CI, one-shot tools, and fresh installs commonly use only
 * AKM_BUNDLE_DIR), so its scheduled child must accept precisely its derived
 * owner name after the scheduler context restores the environment.
 *
 * This is intentionally narrower than an unknown-bundle fallback: a configured
 * source always wins, and an unconfigured selector is accepted only when it is
 * exactly the current env-selected working stash identity.
 */
function resolveImplicitScheduledBundleTarget(config: AkmConfig, selector: string): ResolvedWriteTarget | undefined {
  if (!process.env.AKM_BUNDLE_DIR?.trim()) return undefined;
  try {
    const working = resolveWorkingStashTarget(config, { requireWritable: false });
    return working.source.name === selector ? working : undefined;
  } catch {
    return undefined;
  }
}

/** True when `candidate` resolves to the same directory as the primary stash. */
function isPrimaryStashPath(candidate: string): boolean {
  let primary: string | undefined;
  try {
    primary = path.resolve(resolveStashDir());
  } catch {
    return false;
  }
  return path.resolve(candidate) === primary;
}

/** Two bundle attributions match when both are the primary (undefined) or equal names. */
function sameBundle(a: string | undefined, b: string | undefined): boolean {
  return (a ?? undefined) === (b ?? undefined);
}

function installedEntryRunsTask(entry: InstalledSchedulerBinding, id: string): boolean {
  const invocation = entry.invocation;
  return invocation?.[0] === "task" && invocation[1] === "run" && invocation[2] === id;
}

function foreignScheduleMessage(id: string, existingTarget: string | undefined): string {
  const where = existingTarget === undefined ? "the default bundle" : `bundle "${existingTarget}"`;
  return `Task id "${id}" is already scheduled from ${where}; rename the task or disable the existing one first.`;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Refuse to schedule an id already installed from a DIFFERENT bundle. Scheduler
 * ids are the bare task id (never namespaced), so a single id can be active from
 * only one bundle at a time — a collision is a hard error, not an auto-rename.
 */
function assertNoForeignSchedule(
  entries: readonly InstalledSchedulerBinding[],
  id: string,
  installTarget: string | undefined,
): void {
  const foreign = entries.find((entry) => entry.id === id && !sameBundle(entry.target, installTarget));
  if (foreign) throw new UsageError(foreignScheduleMessage(id, foreign.target), "RESOURCE_ALREADY_EXISTS");
}

interface RenderInput {
  id: string;
  schedule: string;
  workflow?: string;
  prompt?: string;
  command?: string | string[];
  engine?: string;
  model?: string;
  timeoutMs?: number;
  params?: string;
  name?: string;
  description?: string;
  when_to_use?: string;
  tags?: string[];
  enabled: boolean;
}

/**
 * Infer a JSON-Schema-subset `type` keyword from one `--params` value's
 * runtime shape (spec docs/plans/specs/p4-deletions-closeout.md §3.2.6, row
 * B-20). `null` is not one of the five runtime types the spec enumerates
 * (string/number/boolean/object/array) but is a value JSON.parse can still
 * produce for a param; `src/core/json-schema.ts`'s subset validator accepts
 * `"null"` as a `type`, so it is handled rather than mis-typed.
 */
function jsonSchemaTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Render `--params` as typed `inputs:` declarations, one per key, each
 * carrying a `default:` equal to the authored value and a `type:` inferred
 * from its own JSON runtime shape (row B-20). Never emitted as `with:` —
 * task source v4 accepts `with:` only on `uses: akm/command` (§3.2.6's
 * `parseTarget`/`checkTopLevelKeys`), and a workflow target's declared
 * inputs are what `load-task.ts`'s existing v4 delivery override binds into
 * the child run's params.
 */
function renderInputsFromParams(params: Record<string, unknown>): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(params)) {
    inputs[name] = { type: jsonSchemaTypeOf(value), default: value };
  }
  return inputs;
}

function renderTaskYaml(input: RenderInput): string {
  const obj: Record<string, unknown> = { version: 4 };
  if (input.workflow) {
    obj.uses = input.workflow;
    if (input.params) obj.inputs = renderInputsFromParams(parseJsonObjectArg(input.params));
  } else if (input.prompt) {
    obj.uses = "akm/command";
    obj.with = { content: input.prompt };
  } else if (input.command !== undefined) {
    if (Array.isArray(input.command)) {
      throw new UsageError(
        "--command accepts one shell string; argv arrays require manual migration.",
        "INVALID_FLAG_VALUE",
      );
    }
    obj.run = input.command;
  }
  if (input.name) obj.name = input.name;
  if (input.description !== undefined) obj.description = input.description;
  if (input.when_to_use !== undefined) obj.when_to_use = input.when_to_use;
  if (input.tags && input.tags.length > 0) obj.tags = input.tags;
  if (input.engine !== undefined) obj.engine = input.engine;
  if (input.model !== undefined) obj.model = input.model;
  if (input.timeoutMs !== undefined) obj.timeout = input.timeoutMs;
  // Task source v4's `enabled` is per schedule-binding, not document-level
  // (P4-N6, row B-21): `--disabled` writes a one-entry schedule[] list
  // carrying `enabled: false` rather than the v3 `akm.enabled: false` flag.
  // `TasksAddInput.schedule`/the `add` CLI's `--schedule` are both still
  // required, so the "no schedule to disable" usage error B-21 also
  // describes is unreachable through this call site today; the check below
  // still guards `renderTaskYaml` itself against ever being called with an
  // empty schedule string.
  if (input.schedule.length === 0) {
    if (!input.enabled) {
      throw new UsageError("--disabled requires --schedule; a task with no schedule is already manual-only.");
    }
  } else {
    obj.schedule = input.enabled ? input.schedule : [{ cron: input.schedule, enabled: false }];
  }
  return yamlStringify(obj);
}

function assertInlineTaskPrompt(input: string): void {
  const value = input.trim();
  const pathShaped =
    /^(?:\.{1,2}[\\/]|~[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(value) ||
    (!/\s/.test(value) && /[\\/]/.test(value) && path.extname(value) !== "");
  if (!isFullRefInput(value) && !pathShaped) return;
  throw new UsageError(
    "--prompt accepts inline text only; asset refs and file paths are not prompt content. Use --workflow or an authored command ref where appropriate.",
    "INVALID_FLAG_VALUE",
  );
}

function parseJsonObjectArg(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageError("--params must be valid JSON.", "INVALID_JSON_ARGUMENT");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError("--params must be a JSON object.", "INVALID_JSON_ARGUMENT");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Toggle a task source v4 YAML file's `enabled` state without a full
 * parse/render round-trip (which would reformat the file). Task source v4
 * has no document-level `enabled` flag — it lives on each `schedule[]` entry
 * instead (D2-N5, P4-N6) — so this walks the top-level `schedule:` block,
 * finds every list entry in it (each line starting with `-` at the block's
 * item indent), and toggles that entry's own `enabled:` key, the closest v4
 * equivalent of v3's single document-level flag broadcasting to every
 * trigger. Each entry is handled independently — one entry already carrying
 * `enabled:` and a sibling entry with no such key (D2-N3's `schedule[i]`
 * shape: `{cron, enabled?, inputs?}`) toggles the first and inserts into the
 * second, rather than one entry's existing key short-circuiting the other's
 * insertion.
 *
 * A bare string-shorthand schedule (`schedule: "0 9 * * *"`) has nowhere for
 * `enabled:` to live and is rewritten to the one-entry list form. A list
 * entry with no explicit `enabled:` key (defaulting to `true` at parse) gets
 * one inserted rather than being silently left unaffected. A document with
 * no `schedule:` key at all throws — there is no trigger to enable or
 * disable (mirrors `renderTaskYaml`'s `--disabled`-with-no-`--schedule`
 * usage error, row B-21).
 *
 * Each entry's own key indent is taken from its `-` line (the indent before
 * `-`, plus two spaces for the conventional single space after it), so a
 * nested mapping inside an entry — e.g. `schedule[i].inputs` — sits deeper
 * and is never mistaken for the entry's own `enabled:` key.
 *
 * Preserves inline comments (e.g. `enabled: true # important`) and uses
 * case-sensitive matching (YAML keys are case-sensitive).
 */
export function setEnabledInYaml(yaml: string, enabled: boolean): string {
  const lines = yaml.replace(/\r\n/g, "\n").split("\n");

  const scalarLine = lines.findIndex((line) => /^schedule:[ \t]+\S/.test(line));
  if (scalarLine >= 0) {
    const line = lines[scalarLine];
    const match = line?.match(/^schedule:[ \t]+([^\r\n]+?)[ \t]*(#[^\r\n]*)?$/);
    const cron = match?.[1] ?? "";
    const comment = match?.[2] ? ` ${match[2]}` : "";
    lines.splice(scalarLine, 1, "schedule:", `  - cron: ${cron}${comment}`, `    enabled: ${enabled}`);
    return `${lines.join("\n").trimEnd()}\n`;
  }

  const blockLine = lines.findIndex((line) => /^schedule:\s*(?:#.*)?$/.test(line));
  if (blockLine < 0) {
    throw new UsageError("Task source v4 must declare a schedule before its enabled state can be toggled.");
  }

  // Find the block's extent and every top-level list item (`-`) within it.
  // Only items at the *first* item's own indent count as entries — anything
  // deeper belongs to a nested mapping/list inside an entry (e.g. an array
  // input under `inputs:`) and must not be treated as a sibling entry.
  let blockEnd = lines.length;
  const itemStarts: number[] = [];
  let topIndent: string | null = null;
  for (let index = blockLine + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      blockEnd = index;
      break;
    }
    if (line !== "" && !/^[ \t]/.test(line)) {
      blockEnd = index;
      break;
    }
    const itemMatch = line.match(/^([ \t]*)-(?=[ \t]|$)/);
    if (itemMatch) {
      const itemIndent = itemMatch[1] ?? "";
      if (topIndent === null) topIndent = itemIndent;
      if (itemIndent === topIndent) itemStarts.push(index);
    }
  }
  if (itemStarts.length === 0) {
    throw new UsageError("Task source v4's schedule: block has no entries to toggle enabled on.");
  }

  // Walk entries back-to-front: inserting a missing `enabled:` line shifts
  // every later line index by one, but never touches `itemStarts[j]` for
  // j <= i (an insertion for entry i lands at `itemStarts[i] + 1`, which is
  // at or after entry i's own start), so already-computed start/end bounds
  // for entries processed later in this loop (earlier in the list) stay valid.
  for (let i = itemStarts.length - 1; i >= 0; i -= 1) {
    const start = itemStarts[i]!;
    const end = i + 1 < itemStarts.length ? itemStarts[i + 1]! : blockEnd;
    const dashLead = lines[start]?.match(/^([ \t]*)-/)?.[1] ?? "";
    const keyIndent = `${dashLead}  `;
    let found = false;
    for (let index = start; index < end; index += 1) {
      const line = lines[index];
      if (line === undefined) continue;
      const isStart = index === start;
      const prefixMatch = isStart ? line.match(/^([ \t]*-[ \t]*)(.*)$/) : line.match(/^([ \t]*)(.*)$/);
      const prefix = prefixMatch?.[1] ?? "";
      const content = prefixMatch?.[2] ?? "";
      if (prefix.length !== keyIndent.length) continue;
      const withValue = content.match(/^(enabled:[ \t]*)([^\s#\r\n][^\r\n]*?)([ \t]*(?:#[^\r\n]*))?$/);
      if (withValue) {
        lines[index] = `${prefix}${withValue[1]}${enabled}${withValue[3] ?? ""}`;
        found = true;
        continue;
      }
      const bare = content.match(/^(enabled:)[ \t]*$/);
      if (bare) {
        lines[index] = `${prefix}${bare[1]} ${enabled}`;
        found = true;
      }
    }
    if (!found) {
      lines.splice(start + 1, 0, `${keyIndent}enabled: ${enabled}`);
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

// Re-exported so tests can verify the validator path directly.
// Re-export error classes consumed by callers that want to instanceof-check.
// Re-export this so the CLI can decide what process exit code to use after
// `akm task run` completes.
export { ConfigError, exitCodeForStatus, NotFoundError, UsageError };

// Parse only the bundle/ref syntax here. Whether a concept is a task is an
// adapter-specific decision made after resolving the selected bundle.
export function parseTaskRef(input: string): { id: string; bundle?: string } {
  const trimmed = input.trim();
  if (trimmed.includes("/")) {
    try {
      const parsed = parseBundleRef(trimmed);
      if (parsed.fragment !== undefined) throw new Error("task refs do not accept fragments");
      return {
        id: normaliseTaskConceptId(parsed.conceptId),
        ...(parsed.bundle ? { bundle: parsed.bundle } : {}),
      };
    } catch {
      // fall through to the shared error below
    }
    throw new UsageError(`Expected a syntactically valid task concept id, got "${input}".`, "INVALID_FLAG_VALUE");
  }
  return { id: normaliseTaskId(trimmed) };
}

/** Exported for `src/commands/tasks/explain.ts` — see {@link resolveTaskReadBundle}'s header. */
export function taskIdForAdapter(parsedId: string, adapterId: string): string {
  if (adapterId === "akm-task") return normaliseTaskConceptId(parsedId);
  if (adapterId === "akm") {
    if (!parsedId.includes("/")) return normaliseTaskId(parsedId);
    if (parsedId.startsWith("tasks/") && !parsedId.slice("tasks/".length).includes("/")) {
      return normaliseTaskId(parsedId.slice("tasks/".length));
    }
    throw new UsageError(
      `The native akm adapter accepts only a bare task id or tasks/<id>, got "${parsedId}".`,
      "INVALID_FLAG_VALUE",
    );
  }
  throw new UsageError(`Bundle adapter "${adapterId}" does not define task runtime identity.`, "INVALID_FLAG_VALUE");
}
