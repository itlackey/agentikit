// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The complete migration surface: explicit task-v2 files to task-v3 files. */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXIT_CODES } from "../../src/cli/shared";
import { detectAdapterId } from "../../src/core/adapter/detect-adapter";
import { bundleComponentConfig, bundlesToSourceEntries } from "../../src/core/config/config-sources";
import { type AkmConfig, loadConfig, resetConfigCache } from "../../src/core/config/config";
import { withConfigLock } from "../../src/core/config/config-io";
import { ConfigError } from "../../src/core/errors";
import { withMaintenanceStartBarrier } from "../../src/core/maintenance-barrier";
import { getDataDir } from "../../src/core/paths";
import { resolveWritable } from "../../src/core/write-source";
import { lockContentRootFor } from "../../src/integrations/lockfile";
import { applyTaskToV3MigrationPlan, inspectTaskToV3Files, type TaskToV3Root } from "./migrate/task-files-to-v3";
import { planTaskToV3Migration, type TaskToV3MigrationPlan } from "../../src/tasks/source/task-to-v3";
import { applyTaskToV4MigrationPlan, inspectTaskToV4Files } from "./migrate/task-files-to-v4";
import { planTaskToV4Migration, type TaskToV4MigrationPlan } from "../../src/tasks/source/task-to-v4";

export interface MigrationCommandOptions {
  dryRun?: boolean;
}

export interface TaskV3MigrationFileSummary {
  filePath: string;
  status: "changed" | "skipped" | "blocked";
  reason: string;
  beforeHash: string;
  afterHash?: string;
  detail?: string;
}

export interface TaskV3MigrationSummary {
  schemaVersion: 1;
  generation: string;
  changed: number;
  skipped: number;
  blocked: number;
  files: TaskV3MigrationFileSummary[];
}

export interface MigrationPlan {
  schemaVersion: 1;
  status: "current" | "ready" | "blocked";
  blockers: string[];
  taskV3Migration: TaskV3MigrationSummary;
  backupPath?: string;
  applied?: number;
}

function expandTilde(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function existingDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

function taskRoots(config: AkmConfig, resolutionBase = process.cwd()): TaskToV3Root[] {
  const sources = new Map((bundlesToSourceEntries(config) ?? []).map((source) => [source.name, source]));
  const roots: TaskToV3Root[] = [];
  for (const [bundleId, bundle] of Object.entries(config.bundles ?? {})) {
    if (bundle.enabled === false) continue;
    const source = sources.get(bundleId);
    if (!source) continue;
    const configuredRoot =
      source.type === "filesystem" && source.path
        ? path.resolve(resolutionBase, expandTilde(source.path))
        : lockContentRootFor(bundleId, source.type);
    if (!configuredRoot || !existingDirectory(configuredRoot)) continue;

    const bundleRoot = path.resolve(configuredRoot);
    const component = bundleComponentConfig(bundle);
    const componentRoot = path.resolve(bundleRoot, component?.root ?? ".");
    const relative = path.relative(bundleRoot, componentRoot);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new ConfigError(
        `Task migration component root ${componentRoot} escapes bundle ${bundleId} at ${bundleRoot}.`,
        "INVALID_CONFIG_FILE",
      );
    }
    if (!existingDirectory(componentRoot)) continue;

    const adapter = component?.adapter ?? detectAdapterId(componentRoot, "");
    if (!component?.adapter && adapter === "") {
      const flatTasks = fs
        .readdirSync(componentRoot, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".yml"))
        .map((entry) => entry.name)
        .sort();
      if (flatTasks.length > 0) {
        throw new ConfigError(
          `Task migration cannot classify top-level task file(s) ${flatTasks.join(", ")} in bundle ${bundleId}; configure adapter "akm-task" or move them under tasks/.`,
          "INVALID_CONFIG_FILE",
        );
      }
    }
    if (adapter !== "akm" && adapter !== "akm-task") continue;
    roots.push({
      bundleId,
      root: componentRoot,
      bundleRoot,
      writable: component?.writable ?? resolveWritable(source),
      layout: adapter === "akm-task" ? "akm-task" : "akm-stash",
    });
  }
  return roots;
}

function summarize(plan: TaskToV3MigrationPlan): TaskV3MigrationSummary {
  const files = plan.files.map((file) => ({
    filePath: file.filePath,
    status: file.status,
    reason: file.reason,
    beforeHash: file.beforeHash,
    ...(file.status === "changed" ? { afterHash: file.afterHash } : {}),
    ...(file.detail ? { detail: file.detail } : {}),
  }));
  return {
    schemaVersion: 1,
    generation: plan.generation,
    changed: files.filter((file) => file.status === "changed").length,
    skipped: files.filter((file) => file.status === "skipped").length,
    blocked: files.filter((file) => file.status === "blocked").length,
    files,
  };
}

function blockerText(plan: TaskToV3MigrationPlan): string[] {
  return plan.files.flatMap((file) =>
    file.status === "blocked"
      ? [`${file.filePath}: ${file.reason}${file.detail ? ` (${file.detail})` : ""}`]
      : [],
  );
}

function inspectCurrentTaskPlan(): { result: MigrationPlan; plan: TaskToV3MigrationPlan } {
  resetConfigCache();
  const config = loadConfig();
  const plan = planTaskToV3Migration(inspectTaskToV3Files(taskRoots(config)));
  const blockers = blockerText(plan);
  const summary = summarize(plan);
  return {
    plan,
    result: {
      schemaVersion: 1,
      status: blockers.length > 0 ? "blocked" : summary.changed > 0 ? "ready" : "current",
      blockers,
      taskV3Migration: summary,
    },
  };
}

export function inspectMigrationPlan(): MigrationPlan {
  return inspectCurrentTaskPlan().result;
}

function printPlan(plan: { readonly status: "current" | "ready" | "blocked" }): void {
  console.log(JSON.stringify(plan));
  if (plan.status === "blocked") process.exitCode = EXIT_CODES.GENERAL;
}

export async function runMigrationStatus(): Promise<void> {
  printPlan(inspectMigrationPlan());
}

export async function runMigrationApply(options: MigrationCommandOptions = {}): Promise<void> {
  if (options.dryRun) {
    printPlan(inspectMigrationPlan());
    return;
  }
  const result = withConfigLock(() =>
    withMaintenanceStartBarrier(() => {
      const before = inspectCurrentTaskPlan();
      if (before.result.status !== "ready") return before.result;
      const backupPath = path.join(getDataDir(), "backups", "task-v3", `${Date.now()}-${randomUUID()}`);
      const applied = applyTaskToV3MigrationPlan(before.plan, { backupRoot: backupPath });
      const after = inspectCurrentTaskPlan().result;
      if (after.status !== "current") {
        throw new ConfigError("Task migration did not converge to task v3.", "INVALID_CONFIG_FILE");
      }
      return { ...after, backupPath, applied: applied.changed.length };
    }),
  );
  printPlan(result);
}

// ─── Second generation: task v3 -> task source v4 (spec docs/plans/specs/p2b-input-bindings.md §5) ───
// Wired the SAME way as the v2 -> v3 generation above: same withConfigLock +
// withMaintenanceStartBarrier + timestamped-UUID backup root + --dry-run plan
// + summary shape. `taskRoots` is version-agnostic (it only locates each
// bundle's task directory; it never reads file contents) so it is reused
// as-is — `TaskToV3Root`'s fields are structurally identical to `TaskToV4Root`.

export interface TaskV4MigrationFileSummary {
  filePath: string;
  status: "changed" | "skipped" | "blocked";
  reason: string;
  beforeHash: string;
  afterHash?: string;
  detail?: string;
  notice?: string;
}

export interface TaskV4MigrationSummary {
  schemaVersion: 1;
  generation: string;
  changed: number;
  skipped: number;
  blocked: number;
  files: TaskV4MigrationFileSummary[];
}

export interface TaskV4MigrationStatus {
  schemaVersion: 1;
  status: "current" | "ready" | "blocked";
  blockers: string[];
  taskV4Migration: TaskV4MigrationSummary;
  backupPath?: string;
  applied?: number;
}

function summarizeV4(plan: TaskToV4MigrationPlan): TaskV4MigrationSummary {
  const files = plan.files.map((file) => ({
    filePath: file.filePath,
    status: file.status,
    reason: file.reason,
    beforeHash: file.beforeHash,
    ...(file.status === "changed" ? { afterHash: file.afterHash } : {}),
    ...(file.detail ? { detail: file.detail } : {}),
    ...(file.status === "changed" && file.notice ? { notice: file.notice } : {}),
  }));
  return {
    schemaVersion: 1,
    generation: plan.generation,
    changed: files.filter((file) => file.status === "changed").length,
    skipped: files.filter((file) => file.status === "skipped").length,
    blocked: files.filter((file) => file.status === "blocked").length,
    files,
  };
}

function blockerTextV4(plan: TaskToV4MigrationPlan): string[] {
  return plan.files.flatMap((file) =>
    file.status === "blocked"
      ? [`${file.filePath}: ${file.reason}${file.detail ? ` (${file.detail})` : ""}`]
      : [],
  );
}

function inspectCurrentTaskV4Plan(): { result: TaskV4MigrationStatus; plan: TaskToV4MigrationPlan } {
  resetConfigCache();
  const config = loadConfig();
  const plan = planTaskToV4Migration(inspectTaskToV4Files(taskRoots(config)));
  const blockers = blockerTextV4(plan);
  const summary = summarizeV4(plan);
  return {
    plan,
    result: {
      schemaVersion: 1,
      status: blockers.length > 0 ? "blocked" : summary.changed > 0 ? "ready" : "current",
      blockers,
      taskV4Migration: summary,
    },
  };
}

export function inspectTaskV4MigrationStatus(): TaskV4MigrationStatus {
  return inspectCurrentTaskV4Plan().result;
}

export async function runTaskV4MigrationStatus(): Promise<void> {
  printPlan(inspectTaskV4MigrationStatus());
}

export async function runTaskV4MigrationApply(options: MigrationCommandOptions = {}): Promise<void> {
  if (options.dryRun) {
    printPlan(inspectTaskV4MigrationStatus());
    return;
  }
  const result = withConfigLock(() =>
    withMaintenanceStartBarrier(() => {
      const before = inspectCurrentTaskV4Plan();
      if (before.result.status !== "ready") return before.result;
      const backupPath = path.join(getDataDir(), "backups", "task-v4", `${Date.now()}-${randomUUID()}`);
      const applied = applyTaskToV4MigrationPlan(before.plan, { backupRoot: backupPath });
      const after = inspectCurrentTaskV4Plan().result;
      if (after.status !== "current") {
        throw new ConfigError("Task migration did not converge to task source v4.", "INVALID_CONFIG_FILE");
      }
      return { ...after, backupPath, applied: applied.changed.length };
    }),
  );
  printPlan(result);
}
