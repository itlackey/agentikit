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

import fs from "node:fs";
import path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { detectAdapterId } from "../../core/adapter/detect-adapter";
import { assetPathForName } from "../../core/asset/asset-placement";
import { makeBundleRef } from "../../core/asset/asset-ref";
import { type AssetRef, conceptIdFromTypeName, parseRefInput } from "../../core/asset/resolve-ref";
import { isWithin, resolveStashDir } from "../../core/common";
import { loadConfig } from "../../core/config/config";
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
import { backendNameForPlatform, selectBackend } from "../../tasks/backends";
import type { InstalledTaskRef, RebindTaskRef, TaskBackend } from "../../tasks/backends/types";
import { type ResolvedAkmInvocation, resolveAkmInvocation } from "../../tasks/resolve-akm-bin";
import { exitCodeForStatus, readTaskHistory, runTask, type TaskRunResult } from "../../tasks/runner";
import { parseSchedule, SCHEDULE_SUPPORTED_SUBSET_HINT } from "../../tasks/schedule";
import {
  compileTaskSchedulerBindings,
  type SchedulerBinding,
  type SchedulerInstallOptions,
} from "../../tasks/scheduler-binding";
import {
  schedulerContextDescriptor,
  schedulerContextPath,
  validateSchedulerContextDescriptor,
  writeSchedulerContextDescriptor,
} from "../../tasks/scheduler-invocation";
import { planSchedulerSync, type SchedulerSyncPlan } from "../../tasks/scheduler-sync";
import { parseTaskV3Yaml, type TaskV3SourceDocument } from "../../tasks/source-v3";
import { normaliseTaskId } from "../../tasks/task-id";
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
  backend?: TaskBackend;
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
  const hasCommand =
    input.command !== undefined &&
    input.command !== null &&
    !(typeof input.command === "string" && input.command.trim() === "") &&
    !(Array.isArray(input.command) && input.command.length === 0);
  const targetCount = [Boolean(input.workflow), Boolean(input.prompt), hasCommand].filter(Boolean).length;
  if (targetCount !== 1) {
    throw new UsageError(
      "Pass exactly one of --workflow <ref>, --prompt <asset-ref|./file.md|text>, or --command <shell-command>.",
      "INVALID_FLAG_VALUE",
    );
  }
  // `--timeout-ms` IS valid on a workflow task: it is the whole-run bound the
  // task runner turns into an abort signal (issue 11), the same one
  // `akm workflow run --timeout` applies interactively. Engine and model stay
  // prompt-only — a workflow's engines come from its frozen plan.
  if (input.workflow && (input.engine !== undefined || input.model !== undefined)) {
    throw new UsageError(
      "Workflow tasks accept --params and --timeout-ms; engine and model are prompt-task fields.",
      "INVALID_FLAG_VALUE",
    );
  }
  if (hasCommand && (input.engine !== undefined || input.model !== undefined)) {
    throw new UsageError("Command tasks accept --timeout-ms but not --engine or --model.", "INVALID_FLAG_VALUE");
  }

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
  // Pre-0.8.0 tasks were markdown; the 0.8.0 cutover moved them to pure YAML
  // (see the tasks dir rule in src/indexer/walk/matchers.ts). A leftover
  // `<id>.md` still names the same task, so creating `<id>.yml` beside it
  // must collide loudly rather than silently minting a duplicate.
  const legacyAssetPath = path.join(typeRoot, `${id}.md`);
  if ((fs.existsSync(assetPath) || fs.existsSync(legacyAssetPath)) && !input.force) {
    throw new UsageError(
      `Task "${id}" already exists. Pass --force to overwrite, or delete its file and run \`akm task sync\` first.`,
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
  if (task.target.kind === "uses" && task.target.uses.kind === "github-action") {
    throw new UsageError(
      `${assetPath}: remote GitHub actions are recognized but cannot execute locally in 0.9.2.`,
      "INVALID_FLAG_VALUE",
    );
  }
  const [taskBinding] = compileTaskSchedulerBindings({
    id,
    qualifiedRef: makeBundleRef(bundle.bundleName, `tasks/${id}`),
    ...(bundle.installTarget ? { bundleTarget: bundle.installTarget } : {}),
    enabled: task.akm?.enabled !== false,
    schedules: task.triggers.schedules,
  });
  if (!taskBinding) throw new UsageError(`Task "${id}" has no schedulable trigger.`, "INVALID_FLAG_VALUE");

  const ref = taskAssetRef(id);
  const previousYaml = fs.existsSync(assetPath) ? fs.readFileSync(assetPath, "utf8") : undefined;
  let previousTask: SchedulerBinding | undefined;
  let previousTaskError: unknown;
  if (previousYaml !== undefined) {
    try {
      const previous = parseTaskV3Yaml({ yaml: previousYaml, filePath: assetPath, workspaceRoot: stashDir });
      [previousTask] = compileTaskSchedulerBindings({
        id,
        qualifiedRef: makeBundleRef(bundle.bundleName, `tasks/${id}`),
        ...(bundle.installTarget ? { bundleTarget: bundle.installTarget } : {}),
        enabled: previous.akm?.enabled !== false,
        schedules: previous.triggers.schedules,
      });
    } catch (err) {
      previousTaskError = err;
    }
  }
  const sched = deps.backend ?? selectBackend();
  const writeAsset = deps.writeAsset ?? writeAssetToSource;
  const deleteAsset = deps.deleteAsset ?? deleteAssetFromSource;
  const commitBoundary = deps.commitBoundary ?? commitWriteTargetBoundary;
  const installedEntries = await sched.list();
  assertNoForeignSchedule(installedEntries, taskBinding.id, bundle.installTarget);
  const wasInstalled = previousYaml !== undefined && installedEntries.some((entry) => entry.id === id);
  const installedEntry = installedEntries.find((entry) => entry.id === id);
  const runtimeOpts = schedulerInstallOptions(
    installOpts,
    installedEntry,
    deps,
    installedEntry ? false : input.rebind === true,
    `create scheduler entry for task "${id}"`,
  );
  let sourceRestoreArmed = false;
  let installSucceeded = false;

  try {
    sourceRestoreArmed = true;
    await writeAsset(writeTarget.source, writeTarget.config, ref, yaml);
    await sched.install(taskBinding, runtimeOpts);
    installSucceeded = true;
    commitBoundary(writeTarget, `Update tasks/${id}`);
  } catch (err) {
    const rollbackErrors: unknown[] = [];
    let sourceRestored = false;
    if (sourceRestoreArmed) {
      try {
        if (previousYaml === undefined) {
          if (fs.existsSync(assetPath)) {
            await deleteAsset(writeTarget.source, writeTarget.config, ref);
            sourceRestored = true;
          }
        } else {
          await restoreTaskSourceBytes(
            writeAsset,
            writeTarget.source,
            writeTarget.config,
            ref,
            assetPath,
            previousYaml,
          );
          sourceRestored = true;
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }

    if (installSucceeded && !wasInstalled) {
      try {
        await sched.uninstall(id);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    } else if (installSucceeded && previousTask) {
      try {
        await sched.install(previousTask, runtimeOpts);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
        try {
          if (typeof sched.setEnabled !== "function") {
            throw new Error(`Scheduler backend "${sched.name}" cannot disable task "${id}".`);
          }
          await sched.setEnabled(id, false);
        } catch (disableError) {
          rollbackErrors.push(disableError);
          try {
            await sched.uninstall(id);
          } catch (uninstallError) {
            rollbackErrors.push(uninstallError);
          }
        }
      }
    } else if (installSucceeded && wasInstalled) {
      rollbackErrors.push(previousTaskError ?? new Error(`Prior task "${id}" could not be restored.`));
    }

    if (sourceRestored) {
      try {
        commitBoundary(writeTarget, `Restore tasks/${id}`);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }

    if (rollbackErrors.length > 0) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AggregateError([err, ...rollbackErrors], `${message}; rollback for task "${id}" was incomplete.`);
    }
    throw err;
  }

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
  const runOptions = {
    stashDir: bundle.source.path,
    bundleName: bundle.source.name,
    scheduled: options.scheduled === true,
  } as Parameters<typeof runTask>[1] & { bundleName: string };
  // The runner owns the prepare-before-reserve boundary. Invalid source,
  // projectability, and resolver failures therefore create no history row.
  const result = await runTask(parsed.id, runOptions);
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
  resolveTaskReadBundle(parsed?.bundle, input.target);
  const id = parsed?.id;
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
 *   • install missing tasks (after validating them — invalid files are
 *     skipped with a per-task reason rather than aborting the whole sync)
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
  deps: { backend?: TaskBackend; schedulerRuntime?: () => PreparedSchedulerRuntime } = {},
  bundleTarget?: string,
  options: { rebind?: boolean } = {},
): Promise<TasksSyncResult> {
  const resolved = resolveTaskReadBundle(undefined, bundleTarget);
  const stashDir = resolved.source.path;
  const syncTarget = bundleTarget !== undefined && !isPrimaryStashPath(stashDir) ? bundleTarget : undefined;
  const sched = deps.backend ?? selectBackend();
  const rawEntries: Array<InstalledTaskRef | RebindTaskRef> =
    options.rebind && sched.listForRebind ? await sched.listForRebind() : await sched.list();
  const allEntries: InstalledTaskRef[] = rawEntries.map((entry) => ({
    ...entry,
    binding: "binding" in entry ? [...entry.binding] : [],
    contextPath: "contextPath" in entry ? entry.contextPath : "",
  }));
  const common = {
    sourceRoot: stashDir,
    adapterId: resolved.source.adapterId ?? detectAdapterId(stashDir),
    bundleName: resolved.source.name,
    ...(syncTarget ? { bundleTarget: syncTarget } : {}),
    backend: sched.name,
    installed: allEntries,
    rebind: options.rebind === true,
  } as const;

  // Pass one validates every desired source, ownership domain, schedule, and
  // installed-id collision before runtime descriptor preparation is possible.
  const preflight = planSchedulerSync(common);
  const warnings: string[] = [];
  const expectedSignature = sched.expectedSignature?.bind(sched);
  const needsInstall = preflight.operations.some((operation) => operation.kind !== "remove");
  const prepared = needsInstall
    ? prepareSchedulerSyncRuntime(
        syncTarget ? { target: syncTarget } : undefined,
        deps,
        options.rebind === true,
        "reconcile native scheduler bindings",
        warnings,
      )
    : undefined;
  const plan = planSchedulerSync({
    ...common,
    ...(prepared?.options ? { installOptions: prepared.options } : {}),
    ...(expectedSignature
      ? {
          expectedSignature: (binding: SchedulerBinding, install?: SchedulerInstallOptions) =>
            expectedSignature(binding, install),
        }
      : {}),
  });

  if (prepared?.publish && plan.operations.some((operation) => operation.kind !== "remove")) prepared.publish();
  await applySchedulerSyncPlan(sched, plan);
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
  deps: { backend?: TaskBackend; resolveInvocation?: typeof resolveAkmInvocation } = {},
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
  let installed: InstalledTaskRef[] = [];
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

async function applySchedulerSyncPlan(backend: TaskBackend, plan: SchedulerSyncPlan): Promise<void> {
  for (const operation of plan.operations) {
    if (operation.kind === "remove") await backend.uninstall(operation.id);
    else await backend.install(operation.binding, operation.options);
  }
}

function prepareSchedulerSyncRuntime(
  base: { target?: string } | undefined,
  deps: { backend?: TaskBackend; schedulerRuntime?: () => PreparedSchedulerRuntime },
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

function schedulerInstallOptions(
  base: { target?: string } | undefined,
  installed: InstalledTaskRef | undefined,
  deps: { backend?: TaskBackend; schedulerRuntime?: () => PreparedSchedulerRuntime },
  explicitRebind: boolean,
  operation: string,
  warnings: string[] = [],
): { target?: string; binding?: readonly string[]; contextPath?: string } | undefined {
  if (installed && !explicitRebind) {
    return {
      ...base,
      binding: installed.binding,
      contextPath: installed.contextPath,
    };
  }
  // Injected backends can own their default runtime unless a resolver is supplied.
  if (deps.backend && !deps.schedulerRuntime) return base;
  const runtime = deps.schedulerRuntime?.() ?? prepareSchedulerRuntime(explicitRebind, operation);
  warnIneligibleRebind(runtime, explicitRebind, warnings);
  return { ...base, binding: runtime.binding, contextPath: runtime.contextPath };
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
  entries: readonly InstalledTaskRef[],
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

function inspectInstalledBinding(entry: InstalledTaskRef, invocation: TasksDoctorResult["akm"]): string[] {
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

async function restoreTaskSourceBytes(
  writeAsset: typeof writeAssetToSource,
  source: Parameters<typeof writeAssetToSource>[0],
  config: Parameters<typeof writeAssetToSource>[1],
  ref: AssetRef,
  filePath: string,
  yaml: string,
): Promise<void> {
  await writeAsset(source, config, ref, yaml);
  // The normal write path adds a trailing newline; rollback restores the raw snapshot exactly.
  fs.writeFileSync(filePath, yaml, "utf8");
}

/**
 * Resolve the bundle a mutating/run task command targets. Returns the resolved
 * write/read target, its stash path, and the `--bundle <bundle>` token to embed
 * in scheduled invocations. The primary bundle uses the target-less form.
 */
function resolveTaskBundle(
  target: string | undefined,
  opts: { requireWritable: boolean },
): { resolved: ResolvedWriteTarget; stashDir: string; bundleName: string; installTarget: string | undefined } {
  const selected = resolveWriteTarget(loadConfig(), target, { requireWritable: opts.requireWritable });
  const resolved = opts.requireWritable ? prepareWriteTargetForMutation(selected) : selected;
  const stashDir = resolved.source.path;
  const installTarget = isPrimaryStashPath(stashDir) ? undefined : (resolved.selector ?? resolved.source.name);
  return { resolved, stashDir, bundleName: resolved.source.name, installTarget };
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
  const resolved = selector
    ? resolveWriteTarget(config, selector, { requireWritable: false })
    : resolveWorkingStashTarget(config, { requireWritable: false });
  if (refBundle && resolved.source.name !== refBundle) {
    throw new UsageError(
      `Task ref bundle ${JSON.stringify(refBundle)} does not match the resolved source.`,
      "INVALID_FLAG_VALUE",
    );
  }
  return resolved;
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

function foreignScheduleMessage(id: string, existingTarget: string | undefined): string {
  const where = existingTarget === undefined ? "the default bundle" : `bundle "${existingTarget}"`;
  return `Task id "${id}" is already scheduled from ${where}; rename the task or disable the existing one first.`;
}

/**
 * Refuse to schedule an id already installed from a DIFFERENT bundle. Scheduler
 * ids are the bare task id (never namespaced), so a single id can be active from
 * only one bundle at a time — a collision is a hard error, not an auto-rename.
 */
function assertNoForeignSchedule(
  entries: readonly InstalledTaskRef[],
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
    obj.with = isCanonicalCommandRef(input.prompt) ? { ref: input.prompt } : { content: input.prompt };
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

function isCanonicalCommandRef(input: string): boolean {
  try {
    return parseRefInput(input).type === "command";
  } catch {
    return false;
  }
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

// Accept a bare task id or the canonical `[bundle//]tasks/<id>` ref.
export function parseTaskRef(input: string): { id: string; bundle?: string } {
  const trimmed = input.trim();
  // Canonical conceptId form: `[bundle//]tasks/<id>`. A `/` unambiguously marks
  // it — a bare task id can never contain `/` (`validateTaskId` forbids it) — so
  // route it through the shared parser, which strips any bundle prefix and maps
  // the `tasks/` stash-subdir back to the `task` type in one place.
  if (trimmed.includes("/")) {
    try {
      const parsed = parseRefInput(trimmed);
      if (parsed.type === "task") {
        const separator = trimmed.indexOf("//");
        const bundle = separator >= 0 ? trimmed.slice(0, separator) : undefined;
        return { id: normaliseTaskId(parsed.name), ...(bundle ? { bundle } : {}) };
      }
    } catch {
      // fall through to the shared error below
    }
    throw new UsageError(`Expected a task id or tasks/<id> ref, got "${input}".`, "INVALID_FLAG_VALUE");
  }
  return { id: normaliseTaskId(trimmed) };
}
