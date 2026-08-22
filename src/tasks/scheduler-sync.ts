// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Pure whole-set scheduler reconciliation planning. */

import fs from "node:fs";
import path from "node:path";
import { makeBundleRef } from "../core/asset/asset-ref";
import type { AkmConfig } from "../core/config/config-types";
import { UsageError } from "../core/errors";
import { canonicalizeWorkflowName } from "../core/recognition-util";
import {
  resolveUniqueWorkflowSource,
  type WorkflowSourceFile,
  WorkflowSourceRejectionError,
  workflowNameForSourcePath,
} from "../workflows/source-files";
import { compileWorkflowSource } from "../workflows/source-ir/compile";
import { workflowSourceIrToDocument } from "../workflows/source-ir/document";
import type { WorkflowSourceIrV1 } from "../workflows/source-ir/schema";
import { type PrepareTaskV3ExecutionContext, prepareTaskV3Execution } from "./runtime-v3";
import { parseSchedule, type ScheduleBackend } from "./schedule";
import {
  compileTaskSchedulerBindings,
  compileWorkflowSchedulerBindings,
  type InstalledSchedulerBinding,
  type SchedulerBinding,
  type SchedulerInstallOptions,
  type SchedulerNativeArtifact,
  schedulerNativeArtifactKey,
  schedulerNativeBindingId,
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
  /** Complete read-only backend inventory, including malformed artifacts. */
  readonly nativeArtifacts?: readonly SchedulerNativeArtifact[];
  /** Frozen config used only while projecting command targets. */
  readonly config?: AkmConfig;
  /** Bundle-aware local asset resolver used while freezing workflow/script targets. */
  readonly resolveAsset?: PrepareTaskV3ExecutionContext["resolveAsset"];
  readonly installOptions?: SchedulerInstallOptions;
  readonly rebind?: boolean;
  readonly expectedSignature?: (binding: SchedulerBinding, options?: SchedulerInstallOptions) => string;
}

export type SchedulerSyncOperation =
  | Readonly<{ kind: "install" | "update"; binding: SchedulerBinding; options?: SchedulerInstallOptions }>
  | Readonly<{ kind: "remove"; id: string; nativeId: string }>;

export interface SchedulerSyncPlan {
  readonly desired: readonly SchedulerBinding[];
  readonly installed: readonly string[];
  readonly updated: readonly string[];
  readonly removed: readonly string[];
  readonly unchanged: readonly string[];
  readonly operations: readonly SchedulerSyncOperation[];
}

const SCHEDULER_PROJECTION_CONFIG: AkmConfig = Object.freeze({
  configVersion: "0.9.0",
  semanticSearchMode: "off",
});

/**
 * Read and validate the complete desired bundle before signatures are computed.
 * This function performs no writes and invokes no backend mutation method.
 */
export async function planSchedulerSync(input: SchedulerSyncPlanInput): Promise<SchedulerSyncPlan> {
  const desired = await compileDesiredSourceSet(input);
  assertUniqueDesiredIds(desired);
  assertUniqueInstalledIds(input.installed);
  assertSchedulerNativeArtifactOwnership(desired, nativeArtifactsForPlan(input));
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
  for (const id of removed) {
    const current = present.get(id);
    operations.push(
      Object.freeze({
        kind: "remove" as const,
        id,
        nativeId: exactInstalledNativeId(id, current, nativeArtifactsForPlan(input)),
      }),
    );
  }

  return Object.freeze({
    desired,
    installed: Object.freeze(installed),
    updated: Object.freeze(updated),
    removed: Object.freeze(removed),
    unchanged: Object.freeze(unchanged),
    operations: Object.freeze(operations),
  });
}

function exactInstalledNativeId(
  logicalId: string,
  current: InstalledSchedulerBinding | undefined,
  artifacts: readonly SchedulerNativeArtifact[],
): string {
  const logicalKind = current?.invocation?.[0] === "workflow" ? "workflow" : "task";
  const exact = artifacts.find((artifact) => artifact.logicalId === logicalId && artifact.logicalKind === logicalKind);
  return exact?.nativeId ?? current?.nativeId ?? schedulerNativeBindingId(logicalId);
}

function nativeArtifactsForPlan(input: SchedulerSyncPlanInput): readonly SchedulerNativeArtifact[] {
  return (
    input.nativeArtifacts ??
    input.installed.map((entry) => ({
      nativeId: entry.nativeId ?? schedulerNativeBindingId(entry.id),
      logicalId: entry.id,
      logicalKind: entry.invocation?.[0] === "workflow" ? ("workflow" as const) : ("task" as const),
    }))
  );
}

export function assertSchedulerNativeArtifactOwnership(
  desired: readonly SchedulerBinding[],
  installed: readonly SchedulerNativeArtifact[],
): void {
  const desiredByKey = new Map<string, { nativeId: string; logicalId: string; logicalKind: "task" | "workflow" }>();
  for (const binding of desired) {
    const nativeId = schedulerNativeBindingId(binding.id);
    const key = schedulerNativeArtifactKey(nativeId);
    const prior = desiredByKey.get(key);
    const candidate = { nativeId, logicalId: binding.id, logicalKind: binding.logicalSource.kind };
    if (
      prior &&
      (prior.nativeId !== nativeId || prior.logicalId !== binding.id || prior.logicalKind !== candidate.logicalKind)
    ) {
      throw nativeArtifactCollision(prior, candidate);
    }
    desiredByKey.set(key, candidate);
  }

  const installedByKey = new Map<string, SchedulerNativeArtifact>();
  for (const artifact of installed) {
    const key = schedulerNativeArtifactKey(artifact.nativeId);
    const prior = installedByKey.get(key);
    if (
      prior &&
      (prior.nativeId !== artifact.nativeId ||
        prior.logicalId !== artifact.logicalId ||
        prior.logicalKind !== artifact.logicalKind)
    ) {
      throw nativeArtifactCollision(prior, artifact);
    }
    installedByKey.set(key, artifact);
    const wanted = desiredByKey.get(key);
    if (!wanted) continue;
    if (
      artifact.nativeId !== wanted.nativeId ||
      artifact.logicalId !== wanted.logicalId ||
      artifact.logicalKind !== wanted.logicalKind
    ) {
      throw nativeArtifactCollision(wanted, artifact);
    }
  }
}

function nativeArtifactCollision(
  left: { nativeId: string; logicalId?: string; logicalKind?: "task" | "workflow" },
  right: { nativeId: string; logicalId?: string; logicalKind?: "task" | "workflow" },
): UsageError {
  const owner = (value: { nativeId: string; logicalId?: string; logicalKind?: "task" | "workflow" }) =>
    value.logicalId === undefined
      ? `${JSON.stringify(value.nativeId)} (unproven owner)`
      : `${value.logicalKind ?? "unknown"} ${JSON.stringify(value.logicalId)}`;
  return new UsageError(
    `Native scheduler artifact collision between ${owner(left)} and ${owner(right)}; refusing to overwrite an existing or ambiguous native owner.`,
    "RESOURCE_ALREADY_EXISTS",
  );
}

async function compileDesiredSourceSet(input: SchedulerSyncPlanInput): Promise<readonly SchedulerBinding[]> {
  const bindings: SchedulerBinding[] = [];
  const failures: string[] = [];
  await compileTaskSources(input, bindings, failures);
  compileWorkflowSources(input, bindings, failures);
  if (failures.length > 0) {
    throw new UsageError(
      `Scheduler sync rejected the desired source set before mutation:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
      "INVALID_FLAG_VALUE",
    );
  }
  return Object.freeze(bindings);
}

async function compileTaskSources(
  input: SchedulerSyncPlanInput,
  out: SchedulerBinding[],
  failures: string[],
): Promise<void> {
  if (input.adapterId !== "akm" && input.adapterId !== "akm-task") return;
  const physicalOwners = new Map<string, string>();
  for (const sourcePath of enumerateTaskSources(input, failures)) {
    const relative = toPosix(path.relative(input.sourceRoot, sourcePath));
    const conceptId = relative.slice(0, -4);
    const id = input.adapterId === "akm-task" ? conceptId : path.basename(sourcePath, ".yml");
    try {
      assertContainedRegularSource(sourcePath, input.sourceRoot);
      const physicalIdentity = taskSourcePhysicalIdentity(sourcePath);
      const priorOwner = physicalOwners.get(physicalIdentity);
      if (priorOwner !== undefined && priorOwner !== sourcePath) {
        throw new UsageError(
          `Task sources ${JSON.stringify(priorOwner)} and ${JSON.stringify(sourcePath)} resolve to the same physical source identity; refusing canonical task identity collision.`,
          "RESOURCE_ALREADY_EXISTS",
        );
      }
      physicalOwners.set(physicalIdentity, sourcePath);
      const document = parseTaskV3Yaml({
        yaml: fs.readFileSync(sourcePath, "utf8"),
        filePath: sourcePath,
        workspaceRoot: input.sourceRoot,
      });
      const qualifiedRef = makeBundleRef(input.bundleName, conceptId);
      await prepareTaskV3Execution(document, {
        taskId: id,
        taskRef: qualifiedRef,
        bundleName: input.bundleName,
        bundleRoot: input.sourceRoot,
        config: input.config ?? SCHEDULER_PROJECTION_CONFIG,
        ...(input.resolveAsset ? { resolveAsset: input.resolveAsset } : {}),
      });
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

function taskSourcePhysicalIdentity(file: string): string {
  const realFile = fs.realpathSync(file);
  const stat = fs.statSync(realFile);
  return stat.ino === 0 ? `path:${realFile}` : `inode:${stat.dev}:${stat.ino}`;
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
  workflowSourceIrToDocument(ir, { mode: "scheduler" });
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
