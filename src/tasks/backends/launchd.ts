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
const MAX_LAUNCHD_DOMAIN_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_LAUNCHD_AKM_NAMESPACE_ENTRIES = 4096;
const LAUNCHD_AKM_LABEL_RE = /^com\.akm\.task\.[A-Za-z0-9._-]{1,1024}$/u;
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

interface LaunchdNamespaceEntry {
  readonly nativeId: string;
  readonly plist?: string;
  readonly loaded: boolean;
  readonly enabled: boolean;
  readonly artifact: SchedulerNativeArtifact;
}

interface StableLaunchdNamespace {
  readonly inspection: SchedulerBackendInspection;
  readonly entries: readonly LaunchdNamespaceEntry[];
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
      const inspectionContext = { exec, fsLike, agentsDir, plistPath, target, label };
      const initialNamespace = inspectStableLaunchdNamespace([nativeId], inspectionContext);
      let initialArtifact: SchedulerNativeArtifact | undefined;
      if (expected) {
        assertSchedulerExpectationIdentity({ ...expected, state: "present" });
        initialArtifact = assertSchedulerNativeArtifactCardinality(initialNamespace.inspection.artifacts, nativeId, 1);
        if (!initialArtifact) {
          throw new ConfigError(
            `launchd artifact ${JSON.stringify(nativeId)} disappeared during inspection.`,
            "INVALID_CONFIG_FILE",
          );
        }
        assertSchedulerRemovalArtifact(
          initialArtifact.nativeId,
          expected,
          initialArtifact.invocation,
          initialArtifact.fingerprint,
        );
      } else {
        initialArtifact = assertLaunchdDirectRemovalOwner(initialNamespace.inspection.artifacts, nativeId);
      }
      let resolvedNativeId = initialArtifact?.nativeId ?? nativeId;
      const file = plistPath(resolvedNativeId);
      const snapshot = snapshotLaunchdBindings([resolvedNativeId], {
        exec,
        fsLike,
        agentsDir,
        plistPath,
        target,
        label,
      });
      const finalArtifact = expected
        ? assertSchedulerNativeArtifactCardinality(snapshot.artifacts, nativeId, 1)
        : assertLaunchdDirectRemovalOwner(snapshot.artifacts, nativeId);
      if (expected) {
        if (!finalArtifact) {
          throw new ConfigError(
            `launchd artifact ${JSON.stringify(nativeId)} disappeared during snapshot.`,
            "INVALID_CONFIG_FILE",
          );
        }
        assertSchedulerRemovalArtifact(
          finalArtifact.nativeId,
          expected,
          finalArtifact.invocation,
          finalArtifact.fingerprint,
        );
      }
      if (!finalArtifact) return;
      resolvedNativeId = finalArtifact.nativeId;
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
            launchdRollbackExpectationForCurrent(resolvedNativeId, inspectionContext, initialArtifact),
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
      const namespace = inspectStableLaunchdNamespace([], { exec, fsLike, agentsDir, plistPath, target, label });
      const refs: Array<{ id: string; target?: string }> = [];
      for (const entry of namespace.entries) {
        if (entry.plist === undefined) continue;
        const installed = extractPlistInvocation(entry.plist);
        const id = entry.nativeId;
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
  const inspectionContext = { exec, fsLike, agentsDir, plistPath, target, label };
  const initialNamespace = inspectStableLaunchdNamespace([nativeId], inspectionContext);
  const initialArtifact = expected
    ? assertSchedulerNativeArtifactCardinality(
        initialNamespace.inspection.artifacts,
        nativeId,
        expected.state === "absent" ? 0 : 1,
      )
    : assertLaunchdDirectMutationOwner(initialNamespace.inspection.artifacts, nativeId, task);
  if (expected) assertSchedulerMutationArtifact(initialArtifact, expected);
  const priorEntry = initialArtifact
    ? initialNamespace.entries.find((entry) => entry.nativeId === initialArtifact.nativeId)
    : undefined;
  const previousPlist = priorEntry?.plist;
  const previousEnabled = priorEntry?.enabled ?? true;
  const tempFile = path.join(agentsDir, `.${nativeId}.${Date.now()}.tmp`);
  fsLike.writeFile(tempFile, xml);
  let bootoutCompleted = false;
  let previousWasLoaded = false;
  let fileReplaced = false;
  let enableStateTouched = false;
  try {
    if (expected) {
      const finalInspection = inspectStableLaunchdNamespace([nativeId], inspectionContext).inspection;
      const finalArtifact = assertSchedulerNativeArtifactCardinality(
        finalInspection.artifacts,
        nativeId,
        expected.state === "absent" ? 0 : 1,
      );
      assertSchedulerMutationArtifact(finalArtifact, expected);
    } else {
      const finalArtifact = assertLaunchdDirectMutationOwner(
        inspectStableLaunchdNamespace([nativeId], inspectionContext).inspection.artifacts,
        nativeId,
        task,
      );
      if (
        finalArtifact?.nativeId !== initialArtifact?.nativeId ||
        finalArtifact?.fingerprint !== initialArtifact?.fingerprint
      ) {
        throw new ConfigError(
          `launchd task ${JSON.stringify(nativeId)} changed while it was being prepared; refusing to replace an unverified owner.`,
          "INVALID_CONFIG_FILE",
        );
      }
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
  const requestedKeys = new Set(ids.map(schedulerNativeArtifactKey));
  const namespace = inspectStableLaunchdNamespace(ids, context);
  const matchingEntries = namespace.entries.filter((entry) =>
    requestedKeys.has(schedulerNativeArtifactKey(entry.nativeId)),
  );
  const matchedKeys = new Set(matchingEntries.map((entry) => schedulerNativeArtifactKey(entry.nativeId)));
  const entries = [
    ...matchingEntries.map((entry) =>
      Object.freeze({
        id: entry.nativeId,
        ...(entry.plist !== undefined ? { plist: entry.plist } : {}),
        loaded: entry.loaded,
        enabled: entry.enabled,
      }),
    ),
    ...ids
      .filter((id) => !matchedKeys.has(schedulerNativeArtifactKey(id)))
      .map((id) => Object.freeze({ id, loaded: false, enabled: true })),
  ];
  const artifacts = matchingEntries.map((entry) => entry.artifact);
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
      rollbackInventory = inspectStableLaunchdNamespace(snapshot.nativeIds, context).inspection;
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

function inspectStableLaunchdNamespace(
  seedIds: readonly string[],
  context: {
    exec: LaunchdExec;
    fsLike: LaunchdFs;
    agentsDir: string;
    plistPath: (id: string) => string;
    target: (id: string) => string;
    label: (id: string) => string;
  },
): StableLaunchdNamespace {
  const first = captureLaunchdNamespacePass(seedIds, context);
  const second = captureLaunchdNamespacePass(seedIds, context);
  if (first.stabilityKey !== second.stabilityKey) {
    throw new ConfigError(
      "The launchd AKM service namespace changed while scheduler state was being stabilized.",
      "INVALID_CONFIG_FILE",
    );
  }
  return second.namespace;
}

function captureLaunchdNamespacePass(
  seedIds: readonly string[],
  context: {
    exec: LaunchdExec;
    fsLike: LaunchdFs;
    agentsDir: string;
    plistPath: (id: string) => string;
    target: (id: string) => string;
    label: (id: string) => string;
  },
): Readonly<{ namespace: StableLaunchdNamespace; stabilityKey: string }> {
  const domain = context.exec.run(["launchctl", "print", `gui/${context.exec.uid()}`]);
  if (domain.status !== 0) {
    throw new ConfigError(
      `launchctl failed to enumerate the loaded user domain during scheduler state inspection: ${domain.stderr || domain.stdout || "no output"}.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const loadedLabels = parseLaunchdLoadedLabels(domain.stdout);
  if (loadedLabels === undefined) {
    throw new ConfigError(
      "launchctl returned an unsafe, unsupported, or oversized loaded-service inventory during scheduler state inspection.",
      "INVALID_CONFIG_FILE",
    );
  }
  const disabledLabels = readDisabledLabels(context.exec);
  if (disabledLabels === undefined) {
    throw new ConfigError("launchctl print-disabled failed during scheduler state inspection.", "INVALID_CONFIG_FILE");
  }
  const akmDisabledLabels = [...disabledLabels].filter((label) => label.startsWith(LAUNCHD_LABEL_PREFIX)).sort();
  const plistEntries: Array<readonly [nativeId: string, raw: string]> = [];
  if (context.fsLike.exists(context.agentsDir)) {
    for (const file of context.fsLike.list(context.agentsDir).sort()) {
      if (!file.startsWith(LAUNCHD_LABEL_PREFIX) || !file.endsWith(".plist")) continue;
      const nativeId = file.slice(LAUNCHD_LABEL_PREFIX.length, -".plist".length);
      plistEntries.push(Object.freeze([nativeId, context.fsLike.readFile(context.plistPath(nativeId))]));
    }
  }
  const ids = new Set(seedIds);
  for (const [nativeId] of plistEntries) ids.add(nativeId);
  for (const serviceLabel of loadedLabels) ids.add(serviceLabel.slice(LAUNCHD_LABEL_PREFIX.length));
  for (const serviceLabel of akmDisabledLabels) ids.add(serviceLabel.slice(LAUNCHD_LABEL_PREFIX.length));
  if (ids.size > MAX_LAUNCHD_AKM_NAMESPACE_ENTRIES) {
    throw new ConfigError(
      `launchd AKM scheduler inventory exceeds ${MAX_LAUNCHD_AKM_NAMESPACE_ENTRIES} namespace entries.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const plistByNativeId = new Map(plistEntries);
  const entries: LaunchdNamespaceEntry[] = [];
  for (const nativeId of [...ids].sort()) {
    const serviceLabel = context.label(nativeId);
    const plist = plistByNativeId.get(nativeId);
    const enabled = !disabledLabels.has(serviceLabel);
    const loaded = loadedLabels.has(serviceLabel);
    if (plist === undefined && enabled && !loaded) continue;
    const artifact =
      plist === undefined
        ? launchdMissingPlistArtifact(nativeId, enabled, loaded)
        : launchdArtifact(nativeId, plist, enabled, loaded);
    entries.push(Object.freeze({ nativeId, ...(plist !== undefined ? { plist } : {}), enabled, loaded, artifact }));
  }
  const artifacts = entries.map((entry) => entry.artifact);
  const installed: InstalledTaskRef[] = [];
  for (const entry of entries) {
    if (entry.plist === undefined) continue;
    const parsed = extractPlistInvocation(entry.plist);
    if (!parsed) continue;
    installed.push(
      withInstalledInvocation(
        {
          id: schedulerLogicalBindingId(entry.nativeId, parsed.invocation),
          ...(entry.loaded ? { signature: entry.artifact.fingerprint } : {}),
          ...(parsed.target !== undefined ? { target: parsed.target } : {}),
          binding: parsed.binding,
          contextPath: parsed.contextPath,
        },
        parsed.invocation,
        entry.nativeId,
      ),
    );
  }
  return Object.freeze({
    namespace: Object.freeze({
      inspection: Object.freeze({ installed: Object.freeze(installed), artifacts: Object.freeze(artifacts) }),
      entries: Object.freeze(entries),
    }),
    stabilityKey: JSON.stringify({
      loadedLabels: [...loadedLabels].sort(),
      disabledLabels: akmDisabledLabels,
      plistEntries,
    }),
  });
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
  return inspectStableLaunchdNamespace([], context).inspection;
}

function assertLaunchdDirectMutationOwner(
  artifacts: readonly SchedulerNativeArtifact[],
  nativeId: string,
  task: SchedulerBinding,
): SchedulerNativeArtifact | undefined {
  const key = schedulerNativeArtifactKey(nativeId);
  const count = artifacts.filter((artifact) => schedulerNativeArtifactKey(artifact.nativeId) === key).length;
  const artifact = assertSchedulerNativeArtifactCardinality(artifacts, nativeId, count === 0 ? 0 : 1);
  if (artifact) assertSchedulerNativeArtifactOwner(artifact.nativeId, task, artifact.invocation);
  return artifact;
}

function assertLaunchdDirectRemovalOwner(
  artifacts: readonly SchedulerNativeArtifact[],
  nativeId: string,
): SchedulerNativeArtifact | undefined {
  const key = schedulerNativeArtifactKey(nativeId);
  const count = artifacts.filter((artifact) => schedulerNativeArtifactKey(artifact.nativeId) === key).length;
  const artifact = assertSchedulerNativeArtifactCardinality(artifacts, nativeId, count === 0 ? 0 : 1);
  if (!artifact) return undefined;
  if (artifact.nativeId !== nativeId || artifact.invocation === undefined) {
    throw new ConfigError(
      `launchd artifact ${JSON.stringify(artifact.nativeId)} is not the exact proven requested owner ${JSON.stringify(nativeId)}; refusing direct removal.`,
      "INVALID_CONFIG_FILE",
    );
  }
  return artifact;
}

function launchdRollbackExpectationForCurrent(
  nativeId: string,
  context: {
    exec: LaunchdExec;
    fsLike: LaunchdFs;
    agentsDir: string;
    plistPath: (id: string) => string;
    target: (id: string) => string;
    label: (id: string) => string;
  },
  priorArtifact: SchedulerNativeArtifact | undefined,
): SchedulerRollbackExpectation {
  const namespace = inspectStableLaunchdNamespace([nativeId], context);
  const key = schedulerNativeArtifactKey(nativeId);
  const count = namespace.inspection.artifacts.filter(
    (artifact) => schedulerNativeArtifactKey(artifact.nativeId) === key,
  ).length;
  const artifact = assertSchedulerNativeArtifactCardinality(
    namespace.inspection.artifacts,
    nativeId,
    count === 0 ? 0 : 1,
  );
  if (!artifact) {
    return Object.freeze({ nativeId, allowed: Object.freeze([{ state: "absent" as const }]) });
  }
  if (
    artifact.fingerprint === undefined ||
    artifact.invocation === undefined ||
    priorArtifact?.invocation === undefined ||
    !sameStringArray(artifact.invocation, priorArtifact.invocation)
  ) {
    throw new ConfigError(
      `launchd artifact ${JSON.stringify(nativeId)} has no exact transaction-owned rollback fingerprint.`,
      "INVALID_CONFIG_FILE",
    );
  }
  return Object.freeze({
    nativeId,
    allowed: Object.freeze([
      Object.freeze({
        state: "present" as const,
        ...(artifact.bindingId !== undefined ? { bindingId: artifact.bindingId } : {}),
        invocation: Object.freeze([...artifact.invocation]),
        fingerprint: artifact.fingerprint,
      }),
    ]),
  });
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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

/** Parse only proven loaded-service labels from bounded launchctl domain/list output. */
export function parseLaunchdLoadedLabels(output: string): Set<string> | undefined {
  if (Buffer.byteLength(output, "utf8") > MAX_LAUNCHD_DOMAIN_OUTPUT_BYTES || hasUnsafeLaunchdControlCharacter(output)) {
    return undefined;
  }
  const lines = output.replace(/\r\n?/gu, "\n").split("\n");
  const labels = new Set<string>();
  const add = (label: string): boolean => {
    if (!LAUNCHD_AKM_LABEL_RE.test(label)) return false;
    labels.add(label);
    return labels.size <= MAX_LAUNCHD_AKM_NAMESPACE_ENTRIES;
  };
  const firstContent = lines.findIndex((line) => line.trim() !== "");
  if (firstContent >= 0 && /^PID\s+Status\s+Label$/iu.test(lines[firstContent]!.trim())) {
    for (const line of lines.slice(firstContent + 1)) {
      if (!line.trim()) continue;
      const row = /^\s*(?:-|\d+)\s+-?\d+\s+(\S+)\s*$/u.exec(line);
      if (!row?.[1]) return undefined;
      if (row[1].startsWith(LAUNCHD_LABEL_PREFIX) && !add(row[1])) return undefined;
    }
    return labels;
  }

  const firstLine = firstContent < 0 ? undefined : lines[firstContent];
  if (firstLine === undefined || !/^\s*(?:gui|user)\/\d+\s*=\s*\{\s*$/u.test(firstLine)) return undefined;
  let lastContent = lines.length - 1;
  while (lastContent >= 0 && !lines[lastContent]?.trim()) lastContent -= 1;
  const lastLine = lines[lastContent];
  if (lastContent <= firstContent || lastLine === undefined || !/^\s*\}\s*$/u.test(lastLine)) return undefined;

  let depth = 1;
  let servicesSeen = false;
  let insideServices = false;
  for (let index = firstContent + 1; index <= lastContent; index += 1) {
    const line = lines[index]!;
    if (index === lastContent) {
      if (insideServices || depth !== 1) return undefined;
      depth = 0;
      continue;
    }

    const servicesBlock = /^\s*services\s*=\s*\{\s*$/u.test(line);
    const emptyServicesBlock = /^\s*services\s*=\s*\{\s*\}\s*$/u.test(line);
    if (servicesBlock || emptyServicesBlock) {
      if (servicesSeen || insideServices || depth !== 1) return undefined;
      servicesSeen = true;
      if (servicesBlock) {
        insideServices = true;
        depth += 1;
      }
      continue;
    }
    if (/^\s*services\s*=/u.test(line)) return undefined;

    if (insideServices && depth === 2) {
      if (!line.trim()) continue;
      if (/^\s*\}\s*$/u.test(line)) {
        insideServices = false;
        depth -= 1;
        continue;
      }
      const assignment = /^\s*-?\d+\s*=\s*"?([^"\s{}=]+)"?\s*$/u.exec(line);
      const domainTable = /^\s*(?:-|\d+)\s+(?:-|-?\d+)\s+(\S+)\s*$/u.exec(line);
      const dictionary = /^\s*"?([^"\s{}=]+)"?\s*=\s*\{\s*$/u.exec(line);
      const candidate = assignment?.[1] ?? domainTable?.[1] ?? dictionary?.[1];
      if (!candidate) return undefined;
      if (candidate.startsWith(LAUNCHD_LABEL_PREFIX) && !add(candidate)) return undefined;
      if (dictionary) depth += 1;
      continue;
    }

    if (line.includes(LAUNCHD_LABEL_PREFIX)) return undefined;
    depth += countCharacter(line, "{") - countCharacter(line, "}");
    if (depth < 1 || (insideServices && depth < 2)) return undefined;
  }
  return servicesSeen && depth === 0 ? labels : undefined;
}

function countCharacter(value: string, needle: "{" | "}"): number {
  let count = 0;
  for (const character of value) if (character === needle) count += 1;
  return count;
}

function hasUnsafeLaunchdControlCharacter(output: string): boolean {
  for (let index = 0; index < output.length; index += 1) {
    const code = output.charCodeAt(index);
    if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || (code >= 127 && code <= 159)) {
      return true;
    }
  }
  return false;
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
