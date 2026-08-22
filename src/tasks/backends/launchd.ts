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
import { type SchedulerBinding, schedulerLogicalBindingId, schedulerNativeBindingId } from "../scheduler-binding";
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

  const plistPath = (id: string) =>
    path.join(agentsDir, `${LAUNCHD_LABEL_PREFIX}${schedulerNativeBindingId(id)}.plist`);
  const label = (id: string) => `${LAUNCHD_LABEL_PREFIX}${schedulerNativeBindingId(id)}`;
  const target = (id: string) => `gui/${exec.uid()}/${label(id)}`;
  const pathEnv = () => {
    if (options.envPath === false) return undefined;
    if (typeof options.envPath === "string") return options.envPath;
    return process.env.PATH ?? "";
  };
  const defaultContextPath = schedulerContextPath(schedulerContextDescriptor(scheduledContext, pathEnv() ?? ""));

  const setEnableState = (id: string, enabled: boolean) => {
    const verb = enabled ? "enable" : "disable";
    runOrThrow(exec, ["launchctl", verb, target(id)], {
      message: (r) => `launchctl ${verb} failed: ${r.stderr || r.stdout || "no output"}.`,
    });
  };

  return {
    name: "launchd",
    install(task: SchedulerBinding, opts?: TaskInstallOptions) {
      // Capture PATH at install time so launchd (which strips the environment
      // aggressively) can find the same binaries the user sees interactively.
      const xml = buildPlistXml(
        task,
        [...(opts?.binding ?? akmArgv)],
        logDir,
        opts?.contextPath ?? defaultContextPath,
        opts?.target,
      );
      const file = plistPath(task.id);
      const previousPlist = fsLike.exists(file) ? fsLike.readFile(file) : undefined;
      let previousEnabled = true;
      if (previousPlist !== undefined) {
        const disabledLabels = readDisabledLabels(exec);
        if (disabledLabels === undefined) {
          throw new ConfigError(
            `launchctl print-disabled failed; cannot safely replace existing task "${task.id}".`,
            "INVALID_CONFIG_FILE",
          );
        }
        previousEnabled = !disabledLabels.has(label(task.id));
      }
      fsLike.ensureDir(agentsDir);
      // launchd refuses to start a job when StandardOutPath/StandardErrorPath
      // points at a non-existent directory; create it before bootstrap.
      fsLike.ensureDir(logDir);
      const tempFile = path.join(agentsDir, `.${schedulerNativeBindingId(task.id)}.${Date.now()}.tmp`);
      fsLike.writeFile(tempFile, xml);
      let bootoutCompleted = false;
      let previousWasLoaded = false;
      let fileReplaced = false;
      let enableStateTouched = false;
      try {
        const bootout = runOrThrow(exec, ["launchctl", "bootout", target(task.id)], {
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
        setEnableState(task.id, true);
        runOrThrow(exec, ["launchctl", "bootstrap", `gui/${exec.uid()}`, file], {
          message: (r) => `launchctl bootstrap failed (exit ${r.status}): ${r.stderr || r.stdout || "no output"}.`,
          hint: "Ensure `launchctl` is available; on macOS it is part of the base system.",
        });
        if (!task.enabled) {
          setEnableState(task.id, false);
        }
      } catch (err) {
        if (!bootoutCompleted) throw err;
        const rollbackErrors: unknown[] = [];
        let priorFileRestored = !fileReplaced;
        if (fileReplaced) {
          let replacementUnloaded = false;
          try {
            const rollbackBootout = exec.run(["launchctl", "bootout", target(task.id)]);
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

        if (previousPlist !== undefined && previousWasLoaded && priorFileRestored) {
          try {
            setEnableState(task.id, true);
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
              setEnableState(task.id, false);
            } catch (rollbackError) {
              rollbackErrors.push(rollbackError);
            }
          }
        } else if (enableStateTouched) {
          try {
            setEnableState(task.id, previousPlist === undefined || previousEnabled);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
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
    },
    uninstall(id: string) {
      runOrThrow(exec, ["launchctl", "bootout", target(id)], {
        isOk: (r) => r.status === 0 || isServiceNotFoundResult(r),
        message: (r) => `launchctl bootout failed (exit ${r.status}): ${r.stderr || r.stdout || "no output"}.`,
      });
      // launchctl disable overrides persist after the plist is removed.
      setEnableState(id, true);
      const file = plistPath(id);
      if (fsLike.exists(file)) fsLike.removeFile(file);
    },
    setEnabled(id: string, enabled: boolean) {
      setEnableState(id, enabled);
    },
    list(): InstalledTaskRef[] {
      if (!fsLike.exists(agentsDir)) return [];
      const ids: string[] = [];
      for (const file of fsLike.list(agentsDir)) {
        if (file.startsWith(LAUNCHD_LABEL_PREFIX) && file.endsWith(".plist")) {
          ids.push(file.slice(LAUNCHD_LABEL_PREFIX.length, -".plist".length));
        }
      }
      if (ids.length === 0) return [];
      const disabledLabels = readDisabledLabels(exec);
      return ids
        .map((id) => inspectInstalledLaunchdTask(id, fsLike.readFile(plistPath(id)), disabledLabels, exec))
        .filter((ref): ref is InstalledTaskRef => ref !== undefined);
    },
    listForRebind() {
      if (!fsLike.exists(agentsDir)) return [];
      const refs: Array<{ id: string; target?: string }> = [];
      for (const file of fsLike.list(agentsDir)) {
        if (!file.startsWith(LAUNCHD_LABEL_PREFIX) || !file.endsWith(".plist")) continue;
        const id = file.slice(LAUNCHD_LABEL_PREFIX.length, -".plist".length);
        const installed = extractPlistInvocation(fsLike.readFile(plistPath(id)));
        refs.push({
          id: installed ? schedulerLogicalBindingId(id, installed.invocation) : id,
          ...(installed?.target !== undefined ? { target: installed.target } : {}),
        });
      }
      return refs;
    },
    snapshotBindings(ids: readonly string[]): LaunchdBindingSnapshot {
      return snapshotLaunchdBindings(ids, { exec, fsLike, plistPath, target, label });
    },
    restoreBindings(snapshot: unknown) {
      restoreLaunchdBindings(snapshot, { exec, fsLike, agentsDir, plistPath, target, setEnableState });
    },
    expectedSignature(task: SchedulerBinding, opts?: TaskInstallOptions): string {
      return normalizeSignature(
        buildPlistXml(
          task,
          [...(opts?.binding ?? akmArgv)],
          logDir,
          opts?.contextPath ?? defaultContextPath,
          opts?.target,
        ),
      );
    },
  };
}

function snapshotLaunchdBindings(
  ids: readonly string[],
  context: {
    exec: LaunchdExec;
    fsLike: LaunchdFs;
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
  const entries = ids.map((id) => {
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
  return Object.freeze({ kind: LAUNCHD_SNAPSHOT, entries: Object.freeze(entries) });
}

function restoreLaunchdBindings(
  snapshot: unknown,
  context: {
    exec: LaunchdExec;
    fsLike: LaunchdFs;
    agentsDir: string;
    plistPath: (id: string) => string;
    target: (id: string) => string;
    setEnableState: (id: string, enabled: boolean) => void;
  },
): void {
  if (!isLaunchdBindingSnapshot(snapshot)) {
    throw new ConfigError("Invalid launchd scheduler snapshot.", "INVALID_CONFIG_FILE");
  }
  const errors: unknown[] = [];
  for (const entry of snapshot.entries) {
    restoreLaunchdBindingEntry(entry, context, errors);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `Failed to completely restore ${errors.length} launchd scheduler operation(s).`);
  }
}

function restoreLaunchdBindingEntry(
  entry: LaunchdBindingSnapshot["entries"][number],
  context: {
    exec: LaunchdExec;
    fsLike: LaunchdFs;
    agentsDir: string;
    plistPath: (id: string) => string;
    target: (id: string) => string;
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

function inspectInstalledLaunchdTask(
  id: string,
  raw: string,
  disabledLabels: Set<string> | undefined,
  exec: LaunchdExec,
): InstalledTaskRef | undefined {
  const installed = extractPlistInvocation(raw);
  // An invocation that no longer parses (e.g. a pre-0.9 `tasks run` entry
  // surviving the scheduler-ABI respelling) is an orphan of its marker id,
  // not a hard failure: `list()` omits it so `akmTasksSync` treats the id as
  // "not present" and reinstalls it from the current task file.
  if (!installed) return undefined;
  const logicalId = schedulerLogicalBindingId(id, installed.invocation);
  const metadata = {
    ...(installed.target !== undefined ? { target: installed.target } : {}),
    binding: installed.binding,
    contextPath: installed.contextPath,
  };
  if (!disabledLabels) return withInstalledInvocation({ id: logicalId, ...metadata }, installed.invocation);

  const jobLabel = `${LAUNCHD_LABEL_PREFIX}${id}`;
  try {
    const loaded = exec.run(["launchctl", "print", `gui/${exec.uid()}/${jobLabel}`]);
    if (loaded.status !== 0) return withInstalledInvocation({ id: logicalId, ...metadata }, installed.invocation);
  } catch {
    return withInstalledInvocation({ id: logicalId, ...metadata }, installed.invocation);
  }

  try {
    const xml = raw.replace(
      /<!-- akm-enabled:(?:true|false) -->/,
      `<!-- akm-enabled:${!disabledLabels.has(jobLabel)} -->`,
    );
    return withInstalledInvocation(
      { id: logicalId, signature: normalizeSignature(xml), ...metadata },
      installed.invocation,
    );
  } catch {
    return withInstalledInvocation({ id: logicalId, ...metadata }, installed.invocation);
  }
}

function withInstalledInvocation(ref: InstalledTaskRef, invocation: readonly string[]): InstalledTaskRef {
  Object.defineProperty(ref, "invocation", { value: Object.freeze([...invocation]) });
  return ref;
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
  const nativeId = schedulerNativeBindingId(task.id);
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
