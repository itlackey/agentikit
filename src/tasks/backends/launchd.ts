// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * launchd backend for `akm task` (macOS default).
 *
 * Each task is written as a per-user LaunchAgent plist at
 * `~/Library/LaunchAgents/com.akm.task.<id>.plist` and registered via
 * `launchctl bootstrap gui/<uid> <plist>`. Disabling uses
 * `launchctl disable gui/<uid>/<label>` and re-enabling uses `enable`.
 *
 * Platform notes:
 *   • The `bootstrap` / `bootout` / `enable` / `disable` subcommands require
 *     macOS 10.10 (Yosemite) or newer. On older systems the equivalents
 *     are `launchctl load -w` / `unload -w`. We only target modern macOS.
 *   • `gui/<uid>` is the per-user GUI launchd domain — agents in this
 *     domain only run while the user is logged in (no background runs at
 *     the loginwindow). Tasks that need to run when the user is logged
 *     out should be installed as system Daemons, which is out of scope.
 *
 * Tests inject a fake exec + filesystem so the backend can be unit-tested
 * without touching the host launchctl.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import launchdTemplate from "../../assets/backends/launchd-template.xml" with { type: "text" };
import { ConfigError } from "../../core/errors";
import { getTaskLogDir } from "../../core/paths";
import { resolveAkmInvocation } from "../resolve-akm-bin";
import { type LaunchdTrigger, parseSchedule, translateToLaunchd } from "../schedule";
import {
  assertSchedulerExpectationIdentity,
  assertSchedulerMutationArtifact,
  assertSchedulerNativeArtifactCardinality,
  assertSchedulerNativeArtifactOwner,
  assertSchedulerRemovalArtifact,
  assertSchedulerRollbackArtifactCardinality,
  type SchedulerBackendInspection,
  type SchedulerBinding,
  type SchedulerMutationExpectation,
  type SchedulerNativeArtifact,
  type SchedulerRemovalExpectation,
  type SchedulerRollbackExpectation,
  schedulerBindingNativeId,
  schedulerLogicalBindingId,
  schedulerLogicalBindingOwner,
  schedulerNativeArtifactKey,
} from "../scheduler-binding";
import {
  buildScheduledBindingInvocation,
  parseScheduledBindingArgv,
  resolveScheduledTaskContext,
  type ScheduledTaskContext,
  schedulerContextDescriptor,
  schedulerContextPath,
} from "../scheduler-invocation";
import { type BackendExec, escapeXml, type NodeFs, nodeExec, nodeFs, runOrThrow } from "./exec-utils";
import type { InstalledTaskRef, TaskBackend, TaskInstallOptions } from "./types";

export type LaunchdExec = BackendExec<{ uid(): number }>;

export type LaunchdFs = NodeFs & {
  readFile(file: string): string;
  removeFile(file: string): void;
  replaceFile(source: string, destination: string): void;
  list(dir: string): string[];
  exists(file: string): boolean;
};

export interface LaunchdBackendOptions {
  exec?: LaunchdExec;
  fs?: LaunchdFs;
  /** Override the LaunchAgents directory. Defaults to `~/Library/LaunchAgents`. */
  agentsDir?: string;
  /** Override the absolute log directory. */
  logDir?: string;
  /** Override the akm invocation argv. */
  akmArgv?: string[];
  /**
   * Override the PATH captured for `EnvironmentVariables` in the plist.
   * Set to `false` to disable PATH capture entirely.
   * When omitted, `process.env.PATH` at install time is used.
   */
  envPath?: string | false;
  /** Override the resolved non-secret AKM directory context. */
  scheduledContext?: ScheduledTaskContext;
}

export const LAUNCHD_LABEL_PREFIX = "com.akm.task.";
const LAUNCHD_SNAPSHOT = Symbol("akm-launchd-binding-snapshot");

interface LaunchdBindingSnapshot {
  readonly kind: typeof LAUNCHD_SNAPSHOT;
  readonly nativeIds: readonly string[];
  readonly artifacts: readonly SchedulerNativeArtifact[];
  readonly entries: readonly Readonly<{
    id: string;
    plist?: string;
    loaded: boolean;
    enabled: boolean;
  }>[];
}

export function LAUNCHD_BACKEND(options: LaunchdBackendOptions = {}): TaskBackend {
  const exec = options.exec ?? defaultLaunchdExec();
  const fsLike = options.fs ?? defaultLaunchdFs();
  const agentsDir = options.agentsDir ?? defaultAgentsDir();
  const logDir = options.logDir ?? getTaskLogDir();
  const akmArgv = options.akmArgv ?? resolveAkmInvocation().argv;
  const scheduledContext = options.scheduledContext ?? resolveScheduledTaskContext();

  const plistPath = (nativeId: string) => path.join(agentsDir, `${LAUNCHD_LABEL_PREFIX}${nativeId}.plist`);
  const label = (nativeId: string) => `${LAUNCHD_LABEL_PREFIX}${nativeId}`;
  const target = (nativeId: string) => `gui/${exec.uid()}/${label(nativeId)}`;
  const defaultContextPath = launchdDefaultContextPath(options, scheduledContext);
  const setEnableState = (nativeId: string, enabled: boolean) => setLaunchdEnableState(exec, target(nativeId), enabled);

  return {
    name: "launchd",
    install(task: SchedulerBinding, opts?: TaskInstallOptions, expected?: SchedulerMutationExpectation) {
      installLaunchdBinding(task, opts, expected, {
        exec,
        fsLike,
        agentsDir,
        logDir,
        akmArgv,
        defaultContextPath,
        plistPath,
        label,
        target,
        setEnableState,
      });
    },
    uninstall(nativeId: string, expected?: SchedulerRemovalExpectation) {
      let resolvedNativeId = findLaunchdNativeId(fsLike, agentsDir, nativeId) ?? nativeId;
      if (expected) {
        assertSchedulerExpectationIdentity({ ...expected, state: "present" });
        const inspection = inspectLaunchdState({ exec, fsLike, agentsDir, plistPath, target, label });
        const artifact = assertSchedulerNativeArtifactCardinality(inspection.artifacts, nativeId, 1);
        resolvedNativeId = artifact?.nativeId ?? nativeId;
        const current = readLaunchdArtifactState(resolvedNativeId, {
          exec,
          fsLike,
          plistPath,
          target,
          label,
        });
        if (!current) {
          throw new ConfigError(
            `launchd artifact ${JSON.stringify(nativeId)} disappeared after coherent inspection.`,
            "INVALID_CONFIG_FILE",
          );
        }
        assertSchedulerRemovalArtifact(
          current.artifact.nativeId,
          expected,
          current.artifact.invocation,
          current.artifact.fingerprint,
        );
      }
      const file = plistPath(resolvedNativeId);
      const snapshot = snapshotLaunchdBindings([resolvedNativeId], {
        exec,
        fsLike,
        agentsDir,
        plistPath,
        target,
        label,
      });
      if (snapshot.artifacts.length === 0) return;
      try {
        runOrThrow(exec, ["launchctl", "bootout", target(resolvedNativeId)], {
          isOk: (r) => r.status === 0 || isServiceNotFoundResult(r),
          message: (r) => `launchctl bootout failed (exit ${r.status}): ${r.stderr || r.stdout || "no output"}.`,
        });
        // launchctl disable overrides persist after the plist is removed.
        setEnableState(resolvedNativeId, true);
        if (fsLike.exists(file)) fsLike.removeFile(file);
      } catch (primaryError) {
        try {
          const rollbackExpected = [
            launchdRollbackExpectationForCurrent(resolvedNativeId, { exec, fsLike, plistPath, target, label }),
          ];
          restoreLaunchdBindings(
            snapshot,
            { exec, fsLike, agentsDir, plistPath, target, label, setEnableState },
            rollbackExpected,
          );
        } catch (rollbackError) {
          throw new AggregateError(
            [primaryError, rollbackError],
            `${errorMessage(primaryError)}; rollback for launchd removal ${JSON.stringify(nativeId)} was incomplete.`,
          );
        }
        throw primaryError;
      }
    },
    setEnabled(nativeId: string, enabled: boolean) {
      setEnableState(nativeId, enabled);
    },
    list(): InstalledTaskRef[] {
      return [
        ...inspectLaunchdState({ exec, fsLike, agentsDir, plistPath, target, label }).installed,
      ] as InstalledTaskRef[];
    },
    listForRebind() {
      if (!fsLike.exists(agentsDir)) return [];
      const refs: Array<{ id: string; target?: string }> = [];
      for (const file of fsLike.list(agentsDir)) {
        if (!file.startsWith(LAUNCHD_LABEL_PREFIX) || !file.endsWith(".plist")) continue;
        const id = file.slice(LAUNCHD_LABEL_PREFIX.length, -".plist".length);
        const installed = extractPlistInvocation(fsLike.readFile(plistPath(id)));
        const ref = {
          id: installed ? schedulerLogicalBindingId(id, installed.invocation) : id,
          ...(installed?.target !== undefined ? { target: installed.target } : {}),
        };
        Object.defineProperty(ref, "nativeId", { value: id });
        if (installed) Object.defineProperty(ref, "invocation", { value: Object.freeze([...installed.invocation]) });
        refs.push(ref);
      }
      return refs;
    },
    listNativeArtifacts() {
      return [...inspectLaunchdState({ exec, fsLike, agentsDir, plistPath, target, label }).artifacts];
    },
    inspectBindings() {
      return inspectLaunchdState({ exec, fsLike, agentsDir, plistPath, target, label });
    },
    snapshotBindings(ids: readonly string[]): LaunchdBindingSnapshot {
      return snapshotLaunchdBindings(ids, { exec, fsLike, agentsDir, plistPath, target, label });
    },
    restoreBindings(snapshot: unknown, expectedCurrent?: readonly SchedulerRollbackExpectation[]) {
      restoreLaunchdBindings(
        snapshot,
        { exec, fsLike, agentsDir, plistPath, target, label, setEnableState },
        expectedCurrent,
      );
    },
    expectedSignature(task: SchedulerBinding, opts?: TaskInstallOptions): string {
      return launchdFingerprint(
        buildPlistXml(
          task,
          [...(opts?.binding ?? akmArgv)],
          logDir,
          opts?.contextPath ?? defaultContextPath,
          opts?.target,
        ),
        task.enabled,
        true,
      );
    },
  };
}

function installLaunchdBinding(
  task: SchedulerBinding,
  opts: TaskInstallOptions | undefined,
  expected: SchedulerMutationExpectation | undefined,
  context: {
    exec: LaunchdExec;
    fsLike: LaunchdFs;
    agentsDir: string;
    logDir: string;
    akmArgv: readonly string[];
    defaultContextPath: string;
    plistPath: (id: string) => string;
    label: (id: string) => string;
    target: (id: string) => string;
    setEnableState: (id: string, enabled: boolean) => void;
  },
): void {
  const { exec, fsLike, agentsDir, logDir, akmArgv, defaultContextPath, plistPath, label, target, setEnableState } =
    context;
  if (expected) assertSchedulerExpectationIdentity(expected, task);
  // Capture PATH at install time so launchd (which strips the environment
  // aggressively) can find the same binaries the user sees interactively.
  const xml = buildPlistXml(
    task,
    [...(opts?.binding ?? akmArgv)],
    logDir,
    opts?.contextPath ?? defaultContextPath,
    opts?.target,
  );
  const nativeId = schedulerBindingNativeId(task);
  const file = plistPath(nativeId);
  fsLike.ensureDir(agentsDir);
  // launchd refuses to start a job when StandardOutPath/StandardErrorPath
  // points at a non-existent directory; create it before reading or mutating
  // launchd state so a local preparation failure has no scheduler side effect.
  fsLike.ensureDir(logDir);
  const initialInspection = inspectLaunchdState({ exec, fsLike, agentsDir, plistPath, target, label });
  const initialArtifact = expected
    ? assertSchedulerNativeArtifactCardinality(
        initialInspection.artifacts,
        nativeId,
        expected.state === "absent" ? 0 : 1,
      )
    : undefined;
  const existingNativeId = initialArtifact?.nativeId ?? findLaunchdNativeId(fsLike, agentsDir, nativeId);
  const priorState = expected
    ? readLaunchdArtifactState(existingNativeId ?? nativeId, { exec, fsLike, plistPath, target, label })
    : undefined;
  if (expected) assertSchedulerMutationArtifact(priorState?.artifact, expected);
  const { previousPlist, previousEnabled } = expected
    ? { previousPlist: priorState?.plist, previousEnabled: priorState?.enabled ?? true }
    : readLaunchdPriorState(fsLike, file, exec, nativeId, label(nativeId), task);
  const tempFile = path.join(agentsDir, `.${nativeId}.${Date.now()}.tmp`);
  fsLike.writeFile(tempFile, xml);
  let bootoutCompleted = false;
  let previousWasLoaded = false;
  let fileReplaced = false;
  let enableStateTouched = false;
  try {
    if (expected) {
      const finalInspection = inspectLaunchdState({ exec, fsLike, agentsDir, plistPath, target, label });
      const finalArtifact = assertSchedulerNativeArtifactCardinality(
        finalInspection.artifacts,
        nativeId,
        expected.state === "absent" ? 0 : 1,
      );
      const finalState = readLaunchdArtifactState(finalArtifact?.nativeId ?? nativeId, {
        exec,
        fsLike,
        plistPath,
        target,
        label,
      });
      assertSchedulerMutationArtifact(finalState?.artifact, expected);
    } else {
      assertLaunchdArtifactUnchanged(fsLike, file, previousPlist, nativeId, label(nativeId), task);
    }
    const bootout = runOrThrow(exec, ["launchctl", "bootout", target(nativeId)], {
      isOk: (r) => r.status === 0 || isServiceNotFoundResult(r),
      message: (r) => `launchctl bootout failed (exit ${r.status}): ${r.stderr || r.stdout || "no output"}.`,
    });
    bootoutCompleted = true;
    previousWasLoaded = previousPlist !== undefined && bootout.status === 0;
    fsLike.replaceFile(tempFile, file);
    fileReplaced = true;
    // A disable override survives bootout and plist replacement. Clear it
    // before bootstrap, then apply the desired state after registration.
    enableStateTouched = true;
    setEnableState(nativeId, true);
    runOrThrow(exec, ["launchctl", "bootstrap", `gui/${exec.uid()}`, file], {
      message: (r) => `launchctl bootstrap failed (exit ${r.status}): ${r.stderr || r.stdout || "no output"}.`,
      hint: "Ensure `launchctl` is available; on macOS it is part of the base system.",
    });
    if (!task.enabled) setEnableState(nativeId, false);
  } catch (err) {
    if (!bootoutCompleted) throw err;
    const rollbackErrors: unknown[] = [];
    let priorFileRestored = !fileReplaced;
    if (fileReplaced) {
      let replacementUnloaded = false;
      try {
        const rollbackBootout = exec.run(["launchctl", "bootout", target(nativeId)]);
        replacementUnloaded = rollbackBootout.status === 0 || isServiceNotFoundResult(rollbackBootout);
        if (!replacementUnloaded) {
          rollbackErrors.push(
            new ConfigError(
              `launchctl bootout during rollback failed: ${rollbackBootout.stderr || rollbackBootout.stdout || "no output"}.`,
              "INVALID_CONFIG_FILE",
            ),
          );
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      if (replacementUnloaded) {
        try {
          if (previousPlist === undefined) {
            if (fsLike.exists(file)) fsLike.removeFile(file);
          } else {
            fsLike.writeFile(tempFile, previousPlist);
            fsLike.replaceFile(tempFile, file);
          }
          priorFileRestored = true;
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
    }
    restoreLaunchdInstallState({
      exec,
      nativeId,
      file,
      previousPlist,
      previousEnabled,
      previousWasLoaded,
      priorFileRestored,
      enableStateTouched,
      setEnableState,
      rollbackErrors,
    });
    if (rollbackErrors.length > 0) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AggregateError(
        [err, ...rollbackErrors],
        `${message}; rollback for launchd task "${task.id}" was incomplete.`,
      );
    }
    throw err;
  } finally {
    if (fsLike.exists(tempFile)) fsLike.removeFile(tempFile);
  }
}

function restoreLaunchdInstallState(input: {
  exec: LaunchdExec;
  nativeId: string;
  file: string;
  previousPlist: string | undefined;
  previousEnabled: boolean;
  previousWasLoaded: boolean;
  priorFileRestored: boolean;
  enableStateTouched: boolean;
  setEnableState: (id: string, enabled: boolean) => void;
  rollbackErrors: unknown[];
}): void {
  const {
    exec,
    nativeId,
    file,
    previousPlist,
    previousEnabled,
    previousWasLoaded,
    priorFileRestored,
    enableStateTouched,
    setEnableState,
    rollbackErrors,
  } = input;
  if (previousPlist !== undefined && previousWasLoaded && priorFileRestored) {
    try {
      setEnableState(nativeId, true);
      const restore = exec.run(["launchctl", "bootstrap", `gui/${exec.uid()}`, file]);
      if (restore.status !== 0) {
        rollbackErrors.push(
          new ConfigError(
            `launchctl bootstrap during rollback failed: ${restore.stderr || restore.stdout || "no output"}.`,
            "INVALID_CONFIG_FILE",
          ),
        );
      }
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (!previousEnabled) {
      try {
        setEnableState(nativeId, false);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
  } else if (enableStateTouched) {
    try {
      setEnableState(nativeId, previousPlist === undefined || previousEnabled);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
  }
}

function snapshotLaunchdBindings(
  ids: readonly string[],
  context: {
    exec: LaunchdExec;
    fsLike: LaunchdFs;
    agentsDir: string;
    plistPath: (id: string) => string;
    target: (id: string) => string;
    label: (id: string) => string;
  },
): LaunchdBindingSnapshot {
  const disabledLabels = readDisabledLabels(context.exec);
  if (disabledLabels === undefined) {
    throw new ConfigError(
      "launchctl print-disabled failed; cannot snapshot scheduler bindings.",
      "INVALID_CONFIG_FILE",
    );
  }
  const requestedKeys = new Set(ids.map(schedulerNativeArtifactKey));
  const enumeratedIds = new Set(ids);
  if (context.fsLike.exists(context.agentsDir)) {
    for (const file of context.fsLike.list(context.agentsDir)) {
      if (!file.startsWith(LAUNCHD_LABEL_PREFIX) || !file.endsWith(".plist")) continue;
      const nativeId = file.slice(LAUNCHD_LABEL_PREFIX.length, -".plist".length);
      if (requestedKeys.has(schedulerNativeArtifactKey(nativeId))) enumeratedIds.add(nativeId);
    }
  }
  for (const serviceLabel of disabledLabels) {
    if (!serviceLabel.startsWith(LAUNCHD_LABEL_PREFIX)) continue;
    const nativeId = serviceLabel.slice(LAUNCHD_LABEL_PREFIX.length);
    if (requestedKeys.has(schedulerNativeArtifactKey(nativeId))) enumeratedIds.add(nativeId);
  }
  const entries = [...enumeratedIds].map((id) => {
    const file = context.plistPath(id);
    const plist = context.fsLike.exists(file) ? context.fsLike.readFile(file) : undefined;
    const loadedResult = context.exec.run(["launchctl", "print", context.target(id)]);
    if (loadedResult.status !== 0 && !isServiceNotFoundResult(loadedResult)) {
      throw new ConfigError(
        `launchctl print failed while snapshotting task "${id}": ${loadedResult.stderr || loadedResult.stdout || "no output"}.`,
        "INVALID_CONFIG_FILE",
      );
    }
    return Object.freeze({
      id,
      ...(plist !== undefined ? { plist } : {}),
      loaded: loadedResult.status === 0,
      enabled: !disabledLabels.has(context.label(id)),
    });
  });
  const artifacts = entries.flatMap((entry) => {
    if (entry.plist !== undefined) return [launchdArtifact(entry.id, entry.plist, entry.enabled, entry.loaded)];
    if (!entry.enabled || entry.loaded) return [launchdMissingPlistArtifact(entry.id, entry.enabled, entry.loaded)];
    return [];
  });
  return Object.freeze({
    kind: LAUNCHD_SNAPSHOT,
    nativeIds: Object.freeze([...ids]),
    artifacts: Object.freeze(artifacts),
    entries: Object.freeze(entries),
  });
}

function restoreLaunchdBindings(
  snapshot: unknown,
  context: {
    exec: LaunchdExec;
    fsLike: LaunchdFs;
    agentsDir: string;
    plistPath: (id: string) => string;
    target: (id: string) => string;
    label: (id: string) => string;
    setEnableState: (id: string, enabled: boolean) => void;
  },
  expectedCurrent?: readonly SchedulerRollbackExpectation[],
): void {
  if (!isLaunchdBindingSnapshot(snapshot)) {
    throw new ConfigError("Invalid launchd scheduler snapshot.", "INVALID_CONFIG_FILE");
  }
  const errors: unknown[] = [];
  let rollbackInventory: SchedulerBackendInspection | undefined;
  if (expectedCurrent) {
    try {
      rollbackInventory = inspectLaunchdRollbackState(snapshot.nativeIds, context);
    } catch (error) {
      errors.push(error);
    }
  }
  for (const entry of snapshot.entries) {
    if (expectedCurrent) {
      try {
        if (!rollbackInventory) continue;
        const expected = expectedCurrent.find((candidate) => candidate.nativeId === entry.id);
        if (!expected) {
          throw new ConfigError(
            `Missing launchd rollback expectation for ${JSON.stringify(entry.id)}.`,
            "INVALID_CONFIG_FILE",
          );
        }
        assertSchedulerRollbackArtifactCardinality(rollbackInventory.artifacts, expected);
      } catch (error) {
        errors.push(error);
        continue;
      }
    }
    restoreLaunchdBindingEntry(entry, context, errors);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `Failed to completely restore ${errors.length} launchd scheduler operation(s).`);
  }
}

function inspectLaunchdRollbackState(
  seedIds: readonly string[],
  context: {
    exec: LaunchdExec;
    fsLike: LaunchdFs;
    agentsDir: string;
    plistPath: (id: string) => string;
    target: (id: string) => string;
    label: (id: string) => string;
  },
): SchedulerBackendInspection {
  const disabledLabels = readDisabledLabels(context.exec);
  if (disabledLabels === undefined) {
    throw new ConfigError("launchctl print-disabled failed during rollback CAS inspection.", "INVALID_CONFIG_FILE");
  }
  const ids = new Set(seedIds);
  if (context.fsLike.exists(context.agentsDir)) {
    for (const file of context.fsLike.list(context.agentsDir)) {
      if (!file.startsWith(LAUNCHD_LABEL_PREFIX) || !file.endsWith(".plist")) continue;
      ids.add(file.slice(LAUNCHD_LABEL_PREFIX.length, -".plist".length));
    }
  }
  for (const serviceLabel of disabledLabels) {
    if (serviceLabel.startsWith(LAUNCHD_LABEL_PREFIX)) ids.add(serviceLabel.slice(LAUNCHD_LABEL_PREFIX.length));
  }
  const artifacts: SchedulerNativeArtifact[] = [];
  for (const nativeId of [...ids].sort()) {
    const file = context.plistPath(nativeId);
    const plist = context.fsLike.exists(file) ? context.fsLike.readFile(file) : undefined;
    const loadedResult = context.exec.run(["launchctl", "print", context.target(nativeId)]);
    if (loadedResult.status !== 0 && !isServiceNotFoundResult(loadedResult)) {
      throw new ConfigError(
        `launchctl print failed during rollback CAS for task ${JSON.stringify(nativeId)}: ${loadedResult.stderr || loadedResult.stdout || "no output"}.`,
        "INVALID_CONFIG_FILE",
      );
    }
    const enabled = !disabledLabels.has(context.label(nativeId));
    const loaded = loadedResult.status === 0;
    if (plist !== undefined) artifacts.push(launchdArtifact(nativeId, plist, enabled, loaded));
    else if (!enabled || loaded) artifacts.push(launchdMissingPlistArtifact(nativeId, enabled, loaded));
  }
  return Object.freeze({ installed: Object.freeze([]), artifacts: Object.freeze(artifacts) });
}

function restoreLaunchdBindingEntry(
  entry: LaunchdBindingSnapshot["entries"][number],
  context: {
    exec: LaunchdExec;
    fsLike: LaunchdFs;
    agentsDir: string;
    plistPath: (id: string) => string;
    target: (id: string) => string;
    label: (id: string) => string;
    setEnableState: (id: string, enabled: boolean) => void;
  },
  errors: unknown[],
): void {
  try {
    runOrThrow(context.exec, ["launchctl", "bootout", context.target(entry.id)], {
      isOk: (result) => result.status === 0 || isServiceNotFoundResult(result),
      message: (result) =>
        `launchctl bootout failed while restoring task "${entry.id}": ${result.stderr || result.stdout || "no output"}.`,
    });
  } catch (error) {
    errors.push(error);
    return;
  }

  const file = context.plistPath(entry.id);
  let priorFileRestored = false;
  try {
    if (entry.plist === undefined) {
      if (context.fsLike.exists(file)) context.fsLike.removeFile(file);
    } else {
      context.fsLike.ensureDir(context.agentsDir);
      context.fsLike.writeFile(file, entry.plist);
    }
    priorFileRestored = true;
  } catch (error) {
    errors.push(error);
  }

  if (entry.loaded && entry.plist !== undefined && priorFileRestored) {
    let overrideCleared = false;
    try {
      // A disable override survives bootout. Clear it before bootstrap or
      // launchd can refuse to register the exact prior loaded definition.
      context.setEnableState(entry.id, true);
      overrideCleared = true;
    } catch (error) {
      errors.push(error);
    }
    if (overrideCleared) {
      try {
        runOrThrow(context.exec, ["launchctl", "bootstrap", `gui/${context.exec.uid()}`, file], {
          message: (result) =>
            `launchctl bootstrap failed while restoring task "${entry.id}": ${result.stderr || result.stdout || "no output"}.`,
        });
      } catch (error) {
        errors.push(error);
      }
    }
  }

  try {
    // Apply the prior override last even when an earlier step failed; this is
    // both the exact state ordering and the best available partial recovery.
    context.setEnableState(entry.id, entry.enabled);
  } catch (error) {
    errors.push(error);
  }
}

function isLaunchdBindingSnapshot(value: unknown): value is LaunchdBindingSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === LAUNCHD_SNAPSHOT &&
    Array.isArray((value as { entries?: unknown }).entries)
  );
}

function inspectLaunchdState(context: {
  exec: LaunchdExec;
  fsLike: LaunchdFs;
  agentsDir: string;
  plistPath: (id: string) => string;
  target: (id: string) => string;
  label: (id: string) => string;
}): SchedulerBackendInspection {
  if (!context.fsLike.exists(context.agentsDir)) {
    return Object.freeze({ installed: Object.freeze([]), artifacts: Object.freeze([]) });
  }
  const disabledLabels = readDisabledLabels(context.exec);
  const installed: InstalledTaskRef[] = [];
  const artifacts: SchedulerNativeArtifact[] = [];
  for (const file of context.fsLike.list(context.agentsDir).sort()) {
    if (!file.startsWith(LAUNCHD_LABEL_PREFIX) || !file.endsWith(".plist")) continue;
    const nativeId = file.slice(LAUNCHD_LABEL_PREFIX.length, -".plist".length);
    const raw = context.fsLike.readFile(context.plistPath(nativeId));
    const enabled = disabledLabels ? !disabledLabels.has(context.label(nativeId)) : undefined;
    const loadedResult =
      enabled !== undefined ? context.exec.run(["launchctl", "print", context.target(nativeId)]) : undefined;
    const loaded = loadedResult?.status === 0;
    const loadedKnown = loadedResult !== undefined && (loaded || isServiceNotFoundResult(loadedResult));
    const artifact =
      enabled !== undefined && loadedKnown
        ? launchdArtifact(nativeId, raw, enabled, loaded)
        : launchdArtifact(nativeId, raw);
    artifacts.push(artifact);
    const parsed = extractPlistInvocation(raw);
    if (!parsed) continue;
    const ref = withInstalledInvocation(
      {
        id: schedulerLogicalBindingId(nativeId, parsed.invocation),
        ...(artifact.fingerprint !== undefined && loaded ? { signature: artifact.fingerprint } : {}),
        ...(parsed.target !== undefined ? { target: parsed.target } : {}),
        binding: parsed.binding,
        contextPath: parsed.contextPath,
      },
      parsed.invocation,
      nativeId,
    );
    installed.push(ref);
  }
  return Object.freeze({ installed: Object.freeze(installed), artifacts: Object.freeze(artifacts) });
}

function readLaunchdArtifactState(
  nativeId: string | undefined,
  context: {
    exec: LaunchdExec;
    fsLike: LaunchdFs;
    plistPath: (id: string) => string;
    target: (id: string) => string;
    label: (id: string) => string;
  },
):
  | Readonly<{
      plist?: string;
      enabled: boolean;
      loaded: boolean;
      artifact: SchedulerNativeArtifact;
    }>
  | undefined {
  if (nativeId === undefined) return undefined;
  const file = context.plistPath(nativeId);
  const disabledLabels = readDisabledLabels(context.exec);
  if (disabledLabels === undefined) {
    throw new ConfigError("launchctl print-disabled failed during scheduler CAS inspection.", "INVALID_CONFIG_FILE");
  }
  const loadedResult = context.exec.run(["launchctl", "print", context.target(nativeId)]);
  if (loadedResult.status !== 0 && !isServiceNotFoundResult(loadedResult)) {
    throw new ConfigError("launchctl print failed during scheduler CAS inspection.", "INVALID_CONFIG_FILE");
  }
  const plist = context.fsLike.exists(file) ? context.fsLike.readFile(file) : undefined;
  const enabled = !disabledLabels.has(context.label(nativeId));
  const loaded = loadedResult.status === 0;
  if (plist === undefined && enabled && !loaded) return undefined;
  const artifact =
    plist === undefined
      ? launchdMissingPlistArtifact(nativeId, enabled, loaded)
      : launchdArtifact(nativeId, plist, enabled, loaded);
  return Object.freeze({ ...(plist !== undefined ? { plist } : {}), enabled, loaded, artifact });
}

function launchdRollbackExpectationForCurrent(
  nativeId: string,
  context: Parameters<typeof readLaunchdArtifactState>[1],
): SchedulerRollbackExpectation {
  const current = readLaunchdArtifactState(nativeId, context);
  if (!current) {
    return Object.freeze({ nativeId, allowed: Object.freeze([{ state: "absent" as const }]) });
  }
  if (current.artifact.fingerprint === undefined) {
    throw new ConfigError(
      `launchd artifact ${JSON.stringify(nativeId)} has no exact rollback fingerprint.`,
      "INVALID_CONFIG_FILE",
    );
  }
  return Object.freeze({
    nativeId,
    allowed: Object.freeze([
      Object.freeze({
        state: "present" as const,
        ...(current.artifact.bindingId !== undefined ? { bindingId: current.artifact.bindingId } : {}),
        ...(current.artifact.invocation !== undefined
          ? { invocation: Object.freeze([...current.artifact.invocation]) }
          : {}),
        fingerprint: current.artifact.fingerprint,
      }),
    ]),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function launchdMissingPlistArtifact(nativeId: string, enabled: boolean, loaded: boolean): SchedulerNativeArtifact {
  const artifact: SchedulerNativeArtifact = { nativeId };
  Object.defineProperty(artifact, "fingerprint", {
    value: `launchd:missing-plist:enabled=${enabled}:loaded=${loaded}`,
  });
  return artifact;
}

function launchdArtifact(nativeId: string, raw: string, enabled?: boolean, loaded?: boolean): SchedulerNativeArtifact {
  const parsed = extractPlistInvocation(raw);
  const owner = parsed ? schedulerLogicalBindingOwner(nativeId, parsed.invocation) : undefined;
  const artifact: SchedulerNativeArtifact = parsed
    ? {
        nativeId,
        ...(owner !== undefined ? { bindingId: owner } : {}),
        invocation: Object.freeze([...parsed.invocation]),
      }
    : { nativeId };
  if (enabled !== undefined && loaded !== undefined) {
    Object.defineProperty(artifact, "fingerprint", { value: launchdFingerprint(raw, enabled, loaded) });
  }
  return artifact;
}

function launchdFingerprint(raw: string, enabled: boolean, loaded: boolean): string {
  const signed = raw.replace(/<!-- akm-enabled:(?:true|false) -->/, `<!-- akm-enabled:${enabled} -->`);
  return `${normalizeSignature(signed)}:loaded=${loaded}`;
}

function findLaunchdNativeId(fsLike: LaunchdFs, agentsDir: string, intended: string): string | undefined {
  if (!fsLike.exists(agentsDir)) return undefined;
  const key = schedulerNativeArtifactKey(intended);
  for (const file of fsLike.list(agentsDir)) {
    if (!file.startsWith(LAUNCHD_LABEL_PREFIX) || !file.endsWith(".plist")) continue;
    const nativeId = file.slice(LAUNCHD_LABEL_PREFIX.length, -".plist".length);
    if (schedulerNativeArtifactKey(nativeId) === key) return nativeId;
  }
  return undefined;
}

function withInstalledInvocation(
  ref: InstalledTaskRef,
  invocation: readonly string[],
  nativeId: string,
): InstalledTaskRef {
  Object.defineProperty(ref, "nativeId", { value: nativeId });
  Object.defineProperty(ref, "invocation", { value: Object.freeze([...invocation]) });
  return ref;
}

function launchdDefaultContextPath(options: LaunchdBackendOptions, scheduledContext: ScheduledTaskContext): string {
  const pathEnv =
    options.envPath === false
      ? undefined
      : typeof options.envPath === "string"
        ? options.envPath
        : (process.env.PATH ?? "");
  return schedulerContextPath(schedulerContextDescriptor(scheduledContext, pathEnv ?? ""));
}

function setLaunchdEnableState(exec: LaunchdExec, nativeTarget: string, enabled: boolean): void {
  const verb = enabled ? "enable" : "disable";
  runOrThrow(exec, ["launchctl", verb, nativeTarget], {
    message: (result) => `launchctl ${verb} failed: ${result.stderr || result.stdout || "no output"}.`,
  });
}

function readLaunchdPriorState(
  fsLike: LaunchdFs,
  file: string,
  exec: LaunchdExec,
  nativeId: string,
  nativeLabel: string,
  task: SchedulerBinding,
): { previousPlist: string | undefined; previousEnabled: boolean } {
  const previousPlist = fsLike.exists(file) ? fsLike.readFile(file) : undefined;
  if (previousPlist === undefined) return { previousPlist, previousEnabled: true };
  assertSchedulerNativeArtifactOwner(nativeId, task, extractPlistInvocation(previousPlist)?.invocation);
  const disabledLabels = readDisabledLabels(exec);
  if (disabledLabels === undefined) {
    throw new ConfigError(
      `launchctl print-disabled failed; cannot safely replace existing task "${task.id}".`,
      "INVALID_CONFIG_FILE",
    );
  }
  return { previousPlist, previousEnabled: !disabledLabels.has(nativeLabel) };
}

/** Close the read/prepare-to-bootout ownership race at the native boundary. */
function assertLaunchdArtifactUnchanged(
  fsLike: LaunchdFs,
  file: string,
  previousPlist: string | undefined,
  nativeId: string,
  nativeLabel: string,
  task: SchedulerBinding,
): void {
  const currentPlist = fsLike.exists(file) ? fsLike.readFile(file) : undefined;
  if (currentPlist !== previousPlist) {
    throw new ConfigError(
      `launchd task "${nativeLabel}" changed while it was being prepared; refusing to replace an unverified owner.`,
      "INVALID_CONFIG_FILE",
    );
  }
  if (currentPlist !== undefined) {
    assertSchedulerNativeArtifactOwner(nativeId, task, extractPlistInvocation(currentPlist)?.invocation);
  }
}

export function extractPlistInvocation(xml: string): ReturnType<typeof parseScheduledBindingArgv> {
  const block = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!block) return undefined;
  const args = [...block[1]!.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => decodeXmlEntities(m[1]!));
  return parseScheduledBindingArgv(args);
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

// ── XML builder (exported for tests) ────────────────────────────────────────

export function buildPlistXml(
  task: SchedulerBinding,
  akmArgv: string[],
  logDir: string,
  contextPath: string,
  _target?: string,
): string {
  const spec = parseSchedule(task.cron, "launchd");
  const trigger = translateToLaunchd(spec);
  const invocation = buildScheduledBindingInvocation(akmArgv, contextPath, task.invocation);
  const argv = invocation.argv;
  const programArgs = argv.map((a) => `      <string>${escapeXml(a)}</string>`).join("\n");
  const nativeId = schedulerBindingNativeId(task);
  const logPath = path.join(logDir, `${nativeId}.log`);
  const triggerXml = renderLaunchdTrigger(trigger);

  const xml = launchdTemplate
    .replace("<dict>\n", `<dict>\n  <!-- akm-enabled:${task.enabled} -->\n`)
    .replace("{{LABEL}}", LAUNCHD_LABEL_PREFIX + escapeXml(nativeId))
    .replace("{{PROGRAM_ARGS}}", programArgs)
    .replaceAll("{{LOG_PATH}}", escapeXml(logPath))
    .replace("{{ENV_VARS}}", "")
    .replace("{{TRIGGER_XML}}", triggerXml);
  for (const char of xml) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f)) {
      throw new ConfigError(
        "Launchd plist values must not contain XML-forbidden control characters.",
        "INVALID_CONFIG_FILE",
      );
    }
  }
  return xml;
}

function renderLaunchdTrigger(trigger: LaunchdTrigger): string {
  if (trigger.calendars !== undefined) {
    const lines = ["  <key>StartCalendarInterval</key>", "  <array>"];
    for (const calendar of trigger.calendars) {
      lines.push(...renderCalendar(calendar, "    "));
    }
    lines.push("  </array>");
    return lines.join("\n");
  }
  const cal = trigger.calendar ?? {};
  const lines = ["  <key>StartCalendarInterval</key>", ...renderCalendar(cal, "  ")];
  return lines.join("\n");
}

function renderCalendar(calendar: NonNullable<LaunchdTrigger["calendar"]>, indent: string): string[] {
  const valueIndent = `${indent}  `;
  const lines = [`${indent}<dict>`];
  if (calendar.Minute !== undefined) {
    lines.push(`${valueIndent}<key>Minute</key><integer>${calendar.Minute}</integer>`);
  }
  if (calendar.Hour !== undefined) lines.push(`${valueIndent}<key>Hour</key><integer>${calendar.Hour}</integer>`);
  if (calendar.Day !== undefined) lines.push(`${valueIndent}<key>Day</key><integer>${calendar.Day}</integer>`);
  if (calendar.Month !== undefined) lines.push(`${valueIndent}<key>Month</key><integer>${calendar.Month}</integer>`);
  if (calendar.Weekday !== undefined) {
    lines.push(`${valueIndent}<key>Weekday</key><integer>${calendar.Weekday}</integer>`);
  }
  lines.push(`${indent}</dict>`);
  return lines;
}

function normalizeSignature(xml: string): string {
  return xml.replace(/\r\n/g, "\n").trim();
}

function readDisabledLabels(exec: LaunchdExec): Set<string> | undefined {
  try {
    const result = exec.run(["launchctl", "print-disabled", `gui/${exec.uid()}`]);
    if (result.status !== 0) return undefined;
    return parseDisabledLabels(result.stdout);
  } catch {
    return undefined;
  }
}

function parseDisabledLabels(output: string): Set<string> | undefined {
  const envelope = /^\s*disabled services\s*=\s*\{([\s\S]*)\}\s*$/.exec(output);
  if (!envelope) return undefined;

  const disabled = new Set<string>();
  let body = envelope[1]!;
  while (body.trim()) {
    const entry = /^\s*"([^"\r\n]+)"\s*=>\s*(true|false|enabled|disabled)\s*/.exec(body);
    if (!entry) return undefined;
    if (entry[2] === "true" || entry[2] === "disabled") disabled.add(entry[1]!);
    body = body.slice(entry[0].length);
  }
  return disabled;
}

function isServiceNotFoundResult(result: { stdout: string; stderr: string }): boolean {
  const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  return /could not find service\b|service\b.*\bnot found\b|\bno such process\b/i.test(output);
}

function defaultAgentsDir(): string {
  // launchd's per-user LaunchAgents live under the user's home directory.
  // If we can't determine HOME, refuse rather than silently producing a
  // relative path that would write somewhere unexpected.
  const home = os.homedir();
  if (!home) {
    throw new ConfigError(
      "Cannot determine user home directory; launchd backend requires HOME to locate ~/Library/LaunchAgents.",
      "INVALID_CONFIG_FILE",
      "Set $HOME (POSIX) or the equivalent before running `akm task` on macOS.",
    );
  }
  return path.join(home, "Library", "LaunchAgents");
}

function defaultLaunchdExec(): LaunchdExec {
  return {
    ...nodeExec(),
    uid() {
      const fn = (process as { getuid?: () => number }).getuid;
      return typeof fn === "function" ? fn.call(process) : 0;
    },
  };
}

function defaultLaunchdFs(): LaunchdFs {
  return {
    ...nodeFs(),
    readFile(file) {
      return fs.readFileSync(file, "utf8");
    },
    removeFile(file) {
      fs.rmSync(file, { force: true });
    },
    replaceFile(source, destination) {
      fs.renameSync(source, destination);
    },
    list(dir) {
      try {
        return fs.readdirSync(dir);
      } catch {
        return [];
      }
    },
    exists(file) {
      return fs.existsSync(file);
    },
  };
}
