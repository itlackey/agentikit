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
import { withEngineFallback } from "../../integrations/agent/engine-fallback";
import { resolveAssetPath } from "../../sources/resolve";
import { backendNameForPlatform, selectBackend } from "../../tasks/backends";
import type { InstalledSchedulerBinding, RebindSchedulerBinding, SchedulerBackend } from "../../tasks/backends/types";
import { type ResolvedAkmInvocation, resolveAkmInvocation } from "../../tasks/resolve-akm-bin";
import { exitCodeForStatus, readTaskHistory, runTask, type TaskRunResult } from "../../tasks/runner";
import { type PrepareTaskV3ExecutionContext, prepareTaskV3Execution } from "../../tasks/runtime-v3";
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
  finalizeSchedulerSyncPlan,
  prepareSchedulerSyncSourceSet,
  type SchedulerSyncPlan,
} from "../../tasks/scheduler-sync";
import { parseTaskV3Yaml, TASK_V3_MAX_SOURCE_BYTES, type TaskV3SourceDocument } from "../../tasks/source-v3";
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

  const task = parseTaskV3Yaml({ yaml, filePath: assetPath, workspaceRoot: stashDir });
  const qualifiedRef = makeBundleRef(bundle.bundleName, `tasks/${id}`);
  await prepareTaskV3Execution(task, {
    taskId: id,
    taskRef: qualifiedRef,
    bundleName: bundle.bundleName,
    bundleRoot: stashDir,
    config: bundle.config,
    resolveAsset: taskProjectionAssetResolver(bundle.config, bundle.bundleName, stashDir),
  });
  const taskBindings = compileTaskSchedulerBindings({
    id,
    qualifiedRef,
    ...(bundle.installTarget ? { bundleTarget: bundle.installTarget } : {}),
    enabled: task.akm?.enabled !== false,
    schedules: task.triggers.schedules,
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
  options: { scheduled?: boolean; target?: string } = {},
): Promise<TasksRunResultEnvelope> {
  const parsed = parseTaskRef(id);
  const bundle = resolveTaskReadBundle(parsed.bundle, options.target);
  const adapterId = bundle.source.adapterId ?? detectAdapterId(bundle.source.path);
  const resolvedId = taskIdForAdapter(parsed.id, adapterId);
  const runOptions = {
    stashDir: bundle.source.path,
    bundleName: bundle.source.name,
    adapterId,
    scheduled: options.scheduled === true,
  } as Parameters<typeof runTask>[1] & { bundleName: string };
  // The runner owns the prepare-before-reserve boundary. Invalid source,
  // projectability, and resolver failures therefore create no history row.
  const result = await runTask(resolvedId, runOptions);
  const exitCode =
    result.status === "failed" && result.target.kind === "command" && result.detail?.exitCode === 78
      ? 78
      : exitCodeForStatus(result.status);
  return {
    ok: result.status === "completed" || result.status === "disabled",
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
export async function akmTasksSync(
  deps: { backend?: SchedulerBackend; schedulerRuntime?: () => PreparedSchedulerRuntime } = {},
  bundleTarget?: string,
  options: { rebind?: boolean } = {},
): Promise<TasksSyncResult> {
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
  const allEntries: InstalledSchedulerBinding[] = rawEntries.map((entry) => ({
    ...entry,
    ...(entry.nativeId !== undefined ? { nativeId: entry.nativeId } : {}),
    ...(entry.invocation !== undefined ? { invocation: Object.freeze([...entry.invocation]) } : {}),
    binding: "binding" in entry ? [...entry.binding] : [],
    contextPath: "contextPath" in entry ? entry.contextPath : "",
  }));
  const nativeArtifacts = inspection.artifacts;
  const common = {
    sourceRoot: stashDir,
    adapterId: resolved.source.adapterId ?? detectAdapterId(stashDir),
    bundleName: resolved.source.name,
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

function resolveTaskReadBundle(refBundle: string | undefined, flagBundle: string | undefined): ResolvedWriteTarget {
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

function renderTaskYaml(input: RenderInput): string {
  const obj: Record<string, unknown> = { version: 3 };
  if (input.workflow) {
    obj.uses = input.workflow;
    if (input.params) obj.with = parseJsonObjectArg(input.params);
  } else if (input.prompt) {
    obj.uses = "akm/command";
    obj.with = { content: input.prompt };
  } else if (input.command !== undefined) {
    if (Array.isArray(input.command)) {
      throw new UsageError(
        "Task v3 --command accepts one shell string; argv arrays require manual migration.",
        "INVALID_FLAG_VALUE",
      );
    }
    obj.run = input.command;
  }
  if (input.name) obj.name = input.name;
  obj.akm = {
    schedule: input.schedule,
    enabled: input.enabled,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.when_to_use !== undefined ? { when_to_use: input.when_to_use } : {}),
    ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
    ...(input.engine !== undefined ? { engine: input.engine } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.timeoutMs !== undefined ? { timeout: input.timeoutMs } : {}),
  };
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
 * Toggle the v3 `akm.enabled:` value in a task YAML file without a full
 * parse/render round-trip (which would reformat the file). Appends the key
 * if absent.
 *
 * Preserves inline comments (e.g. `enabled: true # important`) and uses
 * case-sensitive matching (YAML keys are case-sensitive).
 */
export function setEnabledInYaml(yaml: string, enabled: boolean): string {
  const lines = yaml.replace(/\r\n/g, "\n").split("\n");
  const akmLine = lines.findIndex((line) => /^akm:\s*(?:#.*)?$/.test(line));
  if (akmLine < 0) return `${yaml.trimEnd()}\nakm:\n  enabled: ${enabled}\n`;

  let insertAt = akmLine + 1;
  for (let index = akmLine + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) break;
    if (line !== "" && !/^[ \t]/.test(line)) break;
    insertAt = index + 1;
    const match = line.match(/^([ \t]+enabled:\s*)([^\s#\r\n][^\r\n]*?)(\s*(?:#[^\r\n]*))?$/);
    if (match) {
      lines[index] = `${match[1]}${enabled}${match[3] ?? ""}`;
      return `${lines.join("\n").trimEnd()}\n`;
    }
    const bare = line.match(/^([ \t]+enabled:)\s*$/);
    if (bare) {
      lines[index] = `${bare[1]} ${enabled}`;
      return `${lines.join("\n").trimEnd()}\n`;
    }
  }
  lines.splice(insertAt, 0, `  enabled: ${enabled}`);
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

function taskIdForAdapter(parsedId: string, adapterId: string): string {
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
