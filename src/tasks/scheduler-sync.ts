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
  type SchedulerRemovalExpectation,
  schedulerBindingNativeId,
  schedulerBindingOrdinal,
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
  | Readonly<{ kind: "remove"; id: string; nativeId: string; expected: SchedulerRemovalExpectation }>;

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
  assertNoForeignIds(desired, input);
  assertSchedulerNativeArtifactOwnership(desired, nativeArtifactsForPlan(input));

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
    if (!current?.invocation) {
      throw nativeArtifactCollision(
        { nativeId: current?.nativeId ?? schedulerNativeBindingId(id), bindingId: id },
        { nativeId: current?.nativeId ?? schedulerNativeBindingId(id) },
      );
    }
    const nativeId = exactInstalledNativeId(id, current, nativeArtifactsForPlan(input));
    const artifact = nativeArtifactsForPlan(input).find(
      (candidate) => candidate.nativeId === nativeId && candidate.bindingId === id,
    );
    const logicalSource = installedLogicalSource(current.invocation, input);
    const ordinal = schedulerBindingOrdinal(id, logicalSource, current.invocation);
    if (ordinal === undefined) {
      throw new UsageError(
        `Installed scheduler binding ${JSON.stringify(id)} cannot be attributed to an exact schedule ordinal; refusing removal.`,
        "RESOURCE_ALREADY_EXISTS",
      );
    }
    operations.push(
      Object.freeze({
        kind: "remove" as const,
        id,
        nativeId,
        expected: freezeRemovalExpectation({
          bindingId: id,
          nativeId,
          logicalSource,
          ordinal,
          invocation: current.invocation,
          ...(current.signature !== undefined
            ? { fingerprint: current.signature }
            : artifact?.fingerprint !== undefined
              ? { fingerprint: artifact.fingerprint }
              : {}),
        }),
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
  const exact = artifacts.find((artifact) => artifact.bindingId === logicalId);
  return exact?.nativeId ?? current?.nativeId ?? schedulerNativeBindingId(logicalId);
}

function nativeArtifactsForPlan(input: SchedulerSyncPlanInput): readonly SchedulerNativeArtifact[] {
  return (
    input.nativeArtifacts ??
    input.installed.map((entry) => ({
      nativeId: entry.nativeId ?? schedulerNativeBindingId(entry.id),
      bindingId: entry.id,
      ...(entry.invocation ? { invocation: Object.freeze([...entry.invocation]) } : {}),
      ...(entry.signature !== undefined ? { fingerprint: entry.signature } : {}),
    }))
  );
}

export function assertSchedulerNativeArtifactOwnership(
  desired: readonly SchedulerBinding[],
  installed: readonly SchedulerNativeArtifact[],
): void {
  const desiredByKey = new Map<string, SchedulerBinding>();
  for (const binding of desired) {
    const nativeId = schedulerBindingNativeId(binding);
    const key = schedulerNativeArtifactKey(nativeId);
    const prior = desiredByKey.get(key);
    if (prior && !sameDesiredArtifact(prior, binding)) {
      throw nativeArtifactCollision(desiredArtifact(prior), desiredArtifact(binding));
    }
    desiredByKey.set(key, binding);
  }

  const installedByKey = new Map<string, SchedulerNativeArtifact>();
  for (const artifact of installed) {
    const key = schedulerNativeArtifactKey(artifact.nativeId);
    const prior = installedByKey.get(key);
    if (prior && !sameInstalledArtifact(prior, artifact)) {
      throw nativeArtifactCollision(prior, artifact);
    }
    installedByKey.set(key, artifact);
    const wanted = desiredByKey.get(key);
    if (!wanted) continue;
    if (
      artifact.nativeId !== schedulerBindingNativeId(wanted) ||
      artifact.bindingId !== wanted.id ||
      artifact.invocation === undefined ||
      !sameInvocation(artifact.invocation, wanted.invocation)
    ) {
      throw nativeArtifactCollision(desiredArtifact(wanted), artifact);
    }
  }
}

function nativeArtifactCollision(
  left: { nativeId: string; bindingId?: string; invocation?: readonly string[] },
  right: { nativeId: string; bindingId?: string; invocation?: readonly string[] },
): UsageError {
  const owner = (value: { nativeId: string; bindingId?: string; invocation?: readonly string[] }) =>
    value.bindingId === undefined || value.invocation === undefined
      ? `${JSON.stringify(value.nativeId)} (unproven owner)`
      : `binding ${JSON.stringify(value.bindingId)} invoking ${JSON.stringify(value.invocation)}`;
  return new UsageError(
    `Native scheduler artifact collision between ${owner(left)} and ${owner(right)}; refusing to overwrite an existing or ambiguous native owner.`,
    "RESOURCE_ALREADY_EXISTS",
  );
}

function desiredArtifact(binding: SchedulerBinding): SchedulerNativeArtifact {
  return {
    nativeId: schedulerBindingNativeId(binding),
    bindingId: binding.id,
    invocation: binding.invocation,
  };
}

function sameDesiredArtifact(left: SchedulerBinding, right: SchedulerBinding): boolean {
  return (
    schedulerBindingNativeId(left) === schedulerBindingNativeId(right) &&
    left.id === right.id &&
    left.logicalSource.kind === right.logicalSource.kind &&
    left.logicalSource.ref === right.logicalSource.ref &&
    left.ordinal === right.ordinal &&
    sameInvocation(left.invocation, right.invocation)
  );
}

function sameInstalledArtifact(left: SchedulerNativeArtifact, right: SchedulerNativeArtifact): boolean {
  return (
    left.nativeId === right.nativeId &&
    left.bindingId === right.bindingId &&
    left.fingerprint === right.fingerprint &&
    ((left.invocation === undefined && right.invocation === undefined) ||
      (left.invocation !== undefined &&
        right.invocation !== undefined &&
        sameInvocation(left.invocation, right.invocation)))
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

function installedLogicalSource(
  invocation: readonly string[],
  input: Pick<SchedulerSyncPlanInput, "adapterId" | "bundleName">,
): SchedulerBinding["logicalSource"] {
  if (invocation[0] === "workflow" && invocation[1] === "run" && invocation.length === 3) {
    return Object.freeze({ kind: "workflow", ref: invocation[2]! });
  }
  if (invocation[0] === "task" && invocation[1] === "run" && invocation[2]) {
    const bundleIndex = invocation.indexOf("--bundle", 3);
    const bundle = bundleIndex === -1 ? input.bundleName : invocation[bundleIndex + 1];
    if (!bundle) {
      throw new UsageError("Installed task invocation has no resolvable bundle owner.", "RESOURCE_ALREADY_EXISTS");
    }
    const conceptId = input.adapterId === "akm" ? `tasks/${invocation[2]}` : invocation[2];
    return Object.freeze({ kind: "task", ref: makeBundleRef(bundle, conceptId) });
  }
  throw new UsageError(
    "Installed scheduler invocation has no exact canonical source owner.",
    "RESOURCE_ALREADY_EXISTS",
  );
}

function freezeRemovalExpectation(expectation: SchedulerRemovalExpectation): SchedulerRemovalExpectation {
  return Object.freeze({
    ...expectation,
    logicalSource: Object.freeze({ ...expectation.logicalSource }),
    invocation: Object.freeze([...expectation.invocation]),
  });
}

function freezeOperation<T extends SchedulerSyncOperation>(operation: T): T {
  return Object.freeze(operation);
}

function sameInvocation(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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
