// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Pure whole-set scheduler reconciliation planning. */

import fs from "node:fs";
import path from "node:path";
import { makeBundleRef } from "../core/asset/asset-ref";
import { UsageError } from "../core/errors";
import { canonicalizeWorkflowName } from "../core/recognition-util";
import {
  resolveUniqueWorkflowSource,
  type WorkflowSourceFile,
  WorkflowSourceRejectionError,
  workflowNameForSourcePath,
} from "../workflows/source-files";
import { compileWorkflowSource } from "../workflows/source-ir/compile";
import type { WorkflowSourceIrV1 } from "../workflows/source-ir/schema";
import { classifyWorkflowSourceUses } from "../workflows/source-ir/uses";
import { parseSchedule, type ScheduleBackend } from "./schedule";
import {
  compileTaskSchedulerBindings,
  compileWorkflowSchedulerBindings,
  type InstalledSchedulerBinding,
  type SchedulerBinding,
  type SchedulerInstallOptions,
} from "./scheduler-binding";
import { parseTaskV3Yaml, taskV3SourceErrorDetail } from "./source-v3";

export interface SchedulerSyncPlanInput {
  readonly sourceRoot: string;
  readonly adapterId: string;
  readonly bundleName: string;
  /** CLI selector embedded only in task invocations for a non-primary bundle. */
  readonly bundleTarget?: string;
  readonly backend: ScheduleBackend;
  readonly installed: readonly InstalledSchedulerBinding[];
  readonly installOptions?: SchedulerInstallOptions;
  readonly rebind?: boolean;
  readonly expectedSignature?: (binding: SchedulerBinding, options?: SchedulerInstallOptions) => string;
}

export type SchedulerSyncOperation =
  | Readonly<{ kind: "install" | "update"; binding: SchedulerBinding; options?: SchedulerInstallOptions }>
  | Readonly<{ kind: "remove"; id: string }>;

export interface SchedulerSyncPlan {
  readonly desired: readonly SchedulerBinding[];
  readonly installed: readonly string[];
  readonly updated: readonly string[];
  readonly removed: readonly string[];
  readonly unchanged: readonly string[];
  readonly operations: readonly SchedulerSyncOperation[];
}

/**
 * Read and validate the complete desired bundle before signatures are computed.
 * This function performs no writes and invokes no backend mutation method.
 */
export function planSchedulerSync(input: SchedulerSyncPlanInput): SchedulerSyncPlan {
  const desired = compileDesiredSourceSet(input);
  assertUniqueDesiredIds(desired);
  assertUniqueInstalledIds(input.installed);
  assertNoForeignIds(desired, input);

  const scopedInstalled = input.installed.filter((entry) => belongsToBundle(entry, input));
  const present = new Map(scopedInstalled.map((entry) => [entry.id, entry] as const));
  const installed: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  const operations: SchedulerSyncOperation[] = [];

  for (const binding of desired) {
    const current = present.get(binding.id);
    const options = installOptionsFor(input, current);
    if (!current) {
      installed.push(binding.id);
      operations.push(freezeOperation({ kind: "install", binding, ...(options ? { options } : {}) }));
      continue;
    }
    const expected = input.expectedSignature?.(binding, options);
    if (current.signature !== undefined && expected !== undefined && current.signature === expected) {
      unchanged.push(binding.id);
      continue;
    }
    updated.push(binding.id);
    operations.push(freezeOperation({ kind: "update", binding, ...(options ? { options } : {}) }));
  }

  const desiredIds = new Set(desired.map(({ id }) => id));
  const removed = scopedInstalled
    .map(({ id }) => id)
    .filter((id) => !desiredIds.has(id))
    .sort(compareCodePoints);
  for (const id of removed) operations.push(Object.freeze({ kind: "remove" as const, id }));

  return Object.freeze({
    desired,
    installed: Object.freeze(installed),
    updated: Object.freeze(updated),
    removed: Object.freeze(removed),
    unchanged: Object.freeze(unchanged),
    operations: Object.freeze(operations),
  });
}

function compileDesiredSourceSet(input: SchedulerSyncPlanInput): readonly SchedulerBinding[] {
  const bindings: SchedulerBinding[] = [];
  const failures: string[] = [];
  compileTaskSources(input, bindings, failures);
  compileWorkflowSources(input, bindings, failures);
  if (failures.length > 0) {
    throw new UsageError(
      `Scheduler sync rejected the desired source set before mutation:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
      "INVALID_FLAG_VALUE",
    );
  }
  return Object.freeze(bindings);
}

function compileTaskSources(input: SchedulerSyncPlanInput, out: SchedulerBinding[], failures: string[]): void {
  if (input.adapterId !== "akm" && input.adapterId !== "akm-task") return;
  for (const sourcePath of enumerateTaskSources(input, failures)) {
    const relative = toPosix(path.relative(input.sourceRoot, sourcePath));
    const conceptId = relative.slice(0, -4);
    const id = path.basename(sourcePath, ".yml");
    try {
      assertContainedRegularSource(sourcePath, input.sourceRoot);
      const document = parseTaskV3Yaml({
        yaml: fs.readFileSync(sourcePath, "utf8"),
        filePath: sourcePath,
        workspaceRoot: input.sourceRoot,
      });
      if (document.target.kind === "uses" && document.target.uses.kind === "github-action") {
        throw new UsageError(
          `${sourcePath}: remote GitHub actions are recognized but cannot execute locally in 0.9.2.`,
          "INVALID_FLAG_VALUE",
        );
      }
      const qualifiedRef = makeBundleRef(input.bundleName, conceptId);
      const sourceBindings = compileTaskSchedulerBindings({
        id,
        qualifiedRef,
        ...(input.bundleTarget ? { bundleTarget: input.bundleTarget } : {}),
        enabled: document.akm?.enabled !== false,
        schedules: document.triggers.schedules.map((schedule) => ({
          ...schedule,
          source: `${toPosix(path.relative(input.sourceRoot, sourcePath))}:${schedule.source}`,
        })),
      });
      for (const binding of sourceBindings) {
        parseSchedule(binding.cron, input.backend);
        out.push(binding);
      }
    } catch (cause) {
      failures.push(taskFailure(sourcePath, cause));
    }
  }
}

function enumerateTaskSources(input: SchedulerSyncPlanInput, failures: string[]): readonly string[] {
  const taskRoot = input.adapterId === "akm" ? path.join(input.sourceRoot, "tasks") : input.sourceRoot;
  if (input.adapterId === "akm-task") {
    const paths: string[] = [];
    walkOwnedFiles(taskRoot, paths, failures);
    return paths.filter((sourcePath) => sourcePath.endsWith(".yml")).sort(compareCodePoints);
  }
  try {
    return fs
      .readdirSync(taskRoot, { withFileTypes: true })
      .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".yml"))
      .map(({ name }) => path.join(taskRoot, name))
      .sort(compareCodePoints);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") failures.push(`${taskRoot}: ${errorMessage(cause)}`);
    return [];
  }
}

function compileWorkflowSources(input: SchedulerSyncPlanInput, out: SchedulerBinding[], failures: string[]): void {
  if (input.adapterId !== "akm" && input.adapterId !== "akm-workflow") return;
  const lookups = enumerateWorkflowLookups(input, failures);
  for (const [, authoredName] of lookups) {
    let source: WorkflowSourceFile | undefined;
    try {
      source = resolveUniqueWorkflowSource(input.sourceRoot, input.adapterId, authoredName);
      if (!source)
        throw new UsageError(`Workflow source ${authoredName} disappeared during sync.`, "INVALID_FLAG_VALUE");
    } catch (cause) {
      failures.push(errorMessage(cause));
      continue;
    }
    try {
      assertContainedRegularSource(source.path, input.sourceRoot);
      const compiled = compileWorkflowSource(fs.readFileSync(source.path, "utf8"), {
        path: source.relativePath,
        workspaceRoot: input.sourceRoot,
      });
      if (!compiled.ok) {
        throw new UsageError(
          compiled.errors
            .map((error) => `${error.path}:${error.line ?? 1} [${error.code}] ${error.message}`)
            .join("; "),
          "INVALID_FLAG_VALUE",
        );
      }
      assertWorkflowProjectable(compiled.ir);
      const conceptId = input.adapterId === "akm" ? `workflows/${source.canonicalName}` : source.canonicalName;
      const qualifiedRef = makeBundleRef(input.bundleName, conceptId);
      const schedules = compiled.ir.triggers.flatMap((trigger) =>
        trigger.kind === "schedule"
          ? [
              {
                cron: trigger.cron,
                source: `${trigger.source.path}:${trigger.source.start}`,
                ordinal: trigger.ordinal,
              },
            ]
          : [],
      );
      for (const binding of compileWorkflowSchedulerBindings({ qualifiedRef, schedules })) {
        parseSchedule(binding.cron, input.backend);
        out.push(binding);
      }
    } catch (cause) {
      failures.push(errorMessage(cause));
    }
  }
}

function enumerateWorkflowLookups(input: SchedulerSyncPlanInput, failures: string[]): ReadonlyMap<string, string> {
  const ownershipRoot = input.adapterId === "akm" ? path.join(input.sourceRoot, "workflows") : input.sourceRoot;
  const authoredPaths: string[] = [];
  walkOwnedFiles(ownershipRoot, authoredPaths, failures);
  const lookups = new Map<string, string>();
  for (const sourcePath of authoredPaths.sort(compareCodePoints)) {
    if (path.basename(sourcePath).toLowerCase() === "readme.md") continue;
    const authoredName = workflowNameForSourcePath(input.sourceRoot, input.adapterId, sourcePath);
    if (authoredName === undefined) continue;
    const canonicalName = canonicalizeWorkflowName(authoredName);
    if (!lookups.has(canonicalName)) lookups.set(canonicalName, authoredName);
  }
  return new Map([...lookups].sort(([left], [right]) => compareCodePoints(left, right)));
}

function walkOwnedFiles(root: string, out: string[], failures: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    failures.push(`${root}: ${errorMessage(cause)}`);
    return;
  }
  for (const entry of entries.sort((left, right) => compareCodePoints(left.name, right.name))) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) walkOwnedFiles(candidate, out, failures);
    else if (entry.isFile() || entry.isSymbolicLink()) out.push(candidate);
  }
}

function assertWorkflowProjectable(ir: WorkflowSourceIrV1): void {
  for (const job of ir.jobs) {
    for (const step of job.steps) {
      if (!step.uses) continue;
      const target = classifyWorkflowSourceUses(step.uses);
      if (target.kind === "github-action") {
        throw new UsageError(
          `${step.source.path}:${step.source.start}: remote GitHub actions are recognized but cannot execute locally in 0.9.2.`,
          "INVALID_FLAG_VALUE",
        );
      }
    }
  }
}

function installOptionsFor(
  input: SchedulerSyncPlanInput,
  current: InstalledSchedulerBinding | undefined,
): SchedulerInstallOptions | undefined {
  if (current && !input.rebind) {
    return Object.freeze({
      ...(input.bundleTarget ? { target: input.bundleTarget } : {}),
      binding: Object.freeze([...current.binding]),
      contextPath: current.contextPath,
    });
  }
  return input.installOptions ? Object.freeze({ ...input.installOptions }) : undefined;
}

function belongsToBundle(entry: InstalledSchedulerBinding, input: SchedulerSyncPlanInput): boolean {
  if (entry.target === input.bundleName || entry.target === input.bundleTarget) return true;
  return entry.target === undefined && input.bundleTarget === undefined;
}

function assertNoForeignIds(desired: readonly SchedulerBinding[], input: SchedulerSyncPlanInput): void {
  const wanted = new Set(desired.map(({ id }) => id));
  const foreign = input.installed.find((entry) => wanted.has(entry.id) && !belongsToBundle(entry, input));
  if (!foreign) return;
  const where = foreign.target ? `bundle ${JSON.stringify(foreign.target)}` : "the default bundle";
  throw new UsageError(
    `Scheduler id ${JSON.stringify(foreign.id)} is already scheduled from ${where}; desired source ids must not collide across bundles.`,
    "RESOURCE_ALREADY_EXISTS",
  );
}

function assertUniqueDesiredIds(desired: readonly SchedulerBinding[]): void {
  const seen = new Set<string>();
  for (const binding of desired) {
    if (seen.has(binding.id)) {
      throw new UsageError(
        `Desired scheduler id collision for ${JSON.stringify(binding.id)}; no native definitions were changed.`,
        "RESOURCE_ALREADY_EXISTS",
      );
    }
    seen.add(binding.id);
  }
}

function assertUniqueInstalledIds(installed: readonly InstalledSchedulerBinding[]): void {
  const seen = new Set<string>();
  for (const binding of installed) {
    if (seen.has(binding.id)) {
      throw new UsageError(
        `Installed scheduler id collision for ${JSON.stringify(binding.id)}; refusing whole-set reconciliation.`,
        "RESOURCE_ALREADY_EXISTS",
      );
    }
    seen.add(binding.id);
  }
}

function assertContainedRegularSource(file: string, root: string): void {
  const realRoot = fs.realpathSync(root);
  const realFile = fs.realpathSync(file);
  const relative = path.relative(realRoot, realFile);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.statSync(realFile).isFile()) {
    throw new UsageError(`${file} resolves outside the bundle root or is not a regular file.`, "PATH_ESCAPE_VIOLATION");
  }
}

function taskFailure(file: string, cause: unknown): string {
  const detail = taskV3SourceErrorDetail(cause);
  return detail === errorMessage(cause) ? `${file}: ${detail}` : detail;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function freezeOperation<T extends SchedulerSyncOperation>(operation: T): T {
  return Object.freeze(operation);
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toPosix(value: string): string {
  return value.replaceAll("\\", "/");
}

// Retain the concrete error in this module's public dependency graph so callers
// can continue to identify ownership failures without importing an adapter.
export { WorkflowSourceRejectionError };
