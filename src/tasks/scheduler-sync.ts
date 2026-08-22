// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Pure whole-set scheduler reconciliation planning. */

import { createHash } from "node:crypto";
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
  type SchedulerBackendInspection,
  type SchedulerBinding,
  type SchedulerInstallOptions,
  type SchedulerMutationExpectation,
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
  /** One coherent backend read. Production mutation paths always provide this. */
  readonly inspection?: SchedulerBackendInspection;
  /** Exact legacy artifacts authorized after physical primary-context verification. */
  readonly legacyRebindNativeIds?: readonly string[];
  /** Frozen config used only while projecting command targets. */
  readonly config?: AkmConfig;
  /** Bundle-aware local asset resolver used while freezing workflow/script targets. */
  readonly resolveAsset?: PrepareTaskV3ExecutionContext["resolveAsset"];
  readonly installOptions?: SchedulerInstallOptions;
  readonly rebind?: boolean;
  readonly expectedSignature?: (binding: SchedulerBinding, options?: SchedulerInstallOptions) => string;
}

export type SchedulerSyncOperation =
  | Readonly<{
      kind: "install" | "update";
      binding: SchedulerBinding;
      expected: SchedulerMutationExpectation;
      /** Exact native fingerprint this operation is expected to produce. */
      resultFingerprint?: string;
      options?: SchedulerInstallOptions;
    }>
  | Readonly<{ kind: "remove"; id: string; nativeId: string; expected: SchedulerRemovalExpectation }>;

export interface SchedulerSyncPlan {
  readonly desired: readonly SchedulerBinding[];
  readonly installed: readonly string[];
  readonly updated: readonly string[];
  readonly removed: readonly string[];
  readonly unchanged: readonly string[];
  readonly operations: readonly SchedulerSyncOperation[];
  readonly sourceSnapshot: SchedulerSourceSnapshot;
}

export interface SchedulerSourceSnapshot {
  readonly adapterId: string;
  readonly sourceRoot: string;
  readonly sourceRealPath: string;
  readonly sourcePhysicalIdentity: string;
  readonly files: readonly Readonly<{
    relativePath: string;
    realPath: string;
    physicalIdentity: string;
    sha256: string;
  }>[];
}

export interface PreparedSchedulerSourceSet {
  readonly desired: readonly SchedulerBinding[];
  readonly sourceSnapshot: SchedulerSourceSnapshot;
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
  const prepared = await prepareSchedulerSyncSourceSet(input);
  return finalizeSchedulerSyncPlan(input, prepared);
}

export async function prepareSchedulerSyncSourceSet(
  input: SchedulerSyncPlanInput,
): Promise<PreparedSchedulerSourceSet> {
  const before = captureSchedulerSourceSnapshot(input);
  const desired = await compileDesiredSourceSet(input);
  const after = captureSchedulerSourceSnapshot(input);
  if (!sameSourceSnapshot(before, after)) {
    throw new UsageError(
      "Scheduler desired source read set changed during projection; refusing reconciliation.",
      "RESOURCE_ALREADY_EXISTS",
    );
  }
  return Object.freeze({ desired, sourceSnapshot: after });
}

export function finalizeSchedulerSyncPlan(
  input: SchedulerSyncPlanInput,
  prepared: PreparedSchedulerSourceSet,
): SchedulerSyncPlan {
  const inspection = inspectionForPlan(input);
  const coherentInput: SchedulerSyncPlanInput = {
    ...input,
    installed: inspection.installed,
    nativeArtifacts: inspection.artifacts,
  };
  const desired = prepared.desired;
  assertUniqueDesiredIds(desired);
  assertCoherentInspection(inspection, input.inspection !== undefined);
  assertUniqueInstalledIds(coherentInput.installed);
  assertNoForeignIds(desired, coherentInput);
  assertSchedulerNativeArtifactOwnership(
    desired,
    inspection.artifacts,
    new Set(coherentInput.legacyRebindNativeIds ?? []),
  );

  const scopedInstalled = coherentInput.installed.filter((entry) => belongsToBundle(entry, coherentInput));
  const present = new Map(scopedInstalled.map((entry) => [entry.id, entry] as const));
  const installed: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  const operations: SchedulerSyncOperation[] = [];

  for (const binding of desired) {
    const current = present.get(binding.id);
    const options = installOptionsFor(coherentInput, current);
    const resultFingerprint = coherentInput.expectedSignature?.(binding, options);
    if (!current) {
      installed.push(binding.id);
      operations.push(
        freezeOperation({
          kind: "install",
          binding,
          expected: freezeMutationExpectation(expectationForBinding(binding, "absent")),
          ...(resultFingerprint !== undefined ? { resultFingerprint } : {}),
          ...(options ? { options } : {}),
        }),
      );
      continue;
    }
    if (current.signature !== undefined && resultFingerprint !== undefined && current.signature === resultFingerprint) {
      unchanged.push(binding.id);
      continue;
    }
    const artifact = exactInstalledArtifact(binding.id, current, inspection.artifacts);
    const legacy = artifact !== undefined && artifact.bindingId === undefined;
    const priorFingerprint = artifact?.fingerprint ?? current.signature;
    if (artifact === undefined || priorFingerprint === undefined) {
      throw new UsageError(
        `Installed scheduler binding ${JSON.stringify(binding.id)} has no exact native fingerprint; refusing update.`,
        "RESOURCE_ALREADY_EXISTS",
      );
    }
    updated.push(binding.id);
    operations.push(
      freezeOperation({
        kind: "update",
        binding,
        expected: freezeMutationExpectation(
          expectationForBinding(
            binding,
            legacy ? "legacy-ownerless" : "present",
            priorFingerprint,
            legacy ? current.invocation : undefined,
          ),
        ),
        ...(resultFingerprint !== undefined ? { resultFingerprint } : {}),
        ...(options ? { options } : {}),
      }),
    );
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
    const nativeId = exactInstalledNativeId(id, current, inspection.artifacts);
    const artifact = inspection.artifacts.find(
      (candidate) => candidate.nativeId === nativeId && candidate.bindingId === id,
    );
    const priorFingerprint = current.signature ?? artifact?.fingerprint;
    if (!artifact || priorFingerprint === undefined) {
      throw new UsageError(
        `Installed scheduler binding ${JSON.stringify(id)} has no exact native fingerprint; refusing removal.`,
        "RESOURCE_ALREADY_EXISTS",
      );
    }
    const logicalSource = installedLogicalSource(current.invocation, coherentInput);
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
          state: "present",
          bindingId: id,
          nativeId,
          logicalSource,
          ordinal,
          invocation: current.invocation,
          fingerprint: priorFingerprint,
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
    sourceSnapshot: prepared.sourceSnapshot,
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

function exactInstalledArtifact(
  bindingId: string,
  current: InstalledSchedulerBinding,
  artifacts: readonly SchedulerNativeArtifact[],
): SchedulerNativeArtifact | undefined {
  const nativeId = current.nativeId ?? schedulerNativeBindingId(bindingId);
  return artifacts.find(
    (artifact) =>
      artifact.nativeId === nativeId && (artifact.bindingId === bindingId || artifact.bindingId === undefined),
  );
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

function inspectionForPlan(input: SchedulerSyncPlanInput): SchedulerBackendInspection {
  return input.inspection ?? Object.freeze({ installed: input.installed, artifacts: nativeArtifactsForPlan(input) });
}

export function assertSchedulerNativeArtifactOwnership(
  desired: readonly SchedulerBinding[],
  installed: readonly SchedulerNativeArtifact[],
  allowedLegacyNativeIds: ReadonlySet<string> = new Set(),
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
      allowedLegacyNativeIds.has(artifact.nativeId) &&
      artifact.nativeId === schedulerBindingNativeId(wanted) &&
      artifact.bindingId === undefined &&
      artifact.invocation !== undefined &&
      isTargetlessLegacyInvocationFor(artifact.invocation, wanted.invocation)
    ) {
      continue;
    }
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

function assertCoherentInspection(inspection: SchedulerBackendInspection, requireCompleteFingerprint = false): void {
  for (const installed of inspection.installed) {
    const nativeId = installed.nativeId ?? schedulerNativeBindingId(installed.id);
    const artifact = inspection.artifacts.find((candidate) => candidate.nativeId === nativeId);
    if (
      !artifact ||
      (installed.signature !== undefined &&
        (artifact.fingerprint !== undefined
          ? installed.signature !== artifact.fingerprint
          : requireCompleteFingerprint)) ||
      (artifact.bindingId !== undefined && artifact.bindingId !== installed.id)
    ) {
      throw new UsageError(
        `Scheduler inspection is not coherent for ${JSON.stringify(nativeId)}: installed and native fingerprints differ.`,
        "RESOURCE_ALREADY_EXISTS",
      );
    }
    if (
      installed.invocation !== undefined &&
      (artifact.invocation === undefined || !sameInvocation(installed.invocation, artifact.invocation))
    ) {
      throw new UsageError(
        `Scheduler inspection is not coherent for ${JSON.stringify(nativeId)}: installed and native owners differ.`,
        "RESOURCE_ALREADY_EXISTS",
      );
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
  if (entry.target !== undefined) return false;
  const nativeId = entry.nativeId ?? schedulerNativeBindingId(entry.id);
  return input.legacyRebindNativeIds?.includes(nativeId) === true;
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

export function assertSchedulerSourceSnapshot(snapshot: SchedulerSourceSnapshot): void {
  const current = captureSchedulerSourceSnapshot({
    sourceRoot: snapshot.sourceRoot,
    adapterId: snapshot.adapterId,
  });
  if (!sameSourceSnapshot(snapshot, current)) {
    throw new UsageError(
      "Scheduler desired source read set changed after projection; refusing native mutation.",
      "RESOURCE_ALREADY_EXISTS",
    );
  }
}

function captureSchedulerSourceSnapshot(
  input: Pick<SchedulerSyncPlanInput, "adapterId" | "sourceRoot">,
): SchedulerSourceSnapshot {
  const sourceRealPath = fs.realpathSync(input.sourceRoot);
  const sourceStat = fs.statSync(sourceRealPath);
  if (!sourceStat.isDirectory()) {
    throw new UsageError(`${input.sourceRoot} is not a scheduler source directory.`, "INVALID_FLAG_VALUE");
  }
  const candidates: string[] = [];
  if (input.adapterId === "akm") {
    const taskRoot = path.join(input.sourceRoot, "tasks");
    try {
      for (const entry of fs.readdirSync(taskRoot, { withFileTypes: true })) {
        if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".yml")) {
          candidates.push(path.join(taskRoot, entry.name));
        }
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    collectSnapshotFiles(path.join(input.sourceRoot, "workflows"), candidates);
  } else if (input.adapterId === "akm-task") {
    collectSnapshotFiles(input.sourceRoot, candidates, (file) => file.endsWith(".yml"));
  } else if (input.adapterId === "akm-workflow") {
    collectSnapshotFiles(input.sourceRoot, candidates);
  }
  const files = candidates.sort(compareCodePoints).map((file) => {
    const realPath = fs.realpathSync(file);
    const stat = fs.statSync(realPath);
    if (!stat.isFile()) throw new UsageError(`${file} is not a regular scheduler source.`, "INVALID_FLAG_VALUE");
    return Object.freeze({
      relativePath: toPosix(path.relative(input.sourceRoot, file)),
      realPath,
      physicalIdentity: stat.ino === 0 ? `path:${realPath}` : `inode:${stat.dev}:${stat.ino}`,
      sha256: createHash("sha256").update(fs.readFileSync(realPath)).digest("hex"),
    });
  });
  return Object.freeze({
    adapterId: input.adapterId,
    sourceRoot: path.resolve(input.sourceRoot),
    sourceRealPath,
    sourcePhysicalIdentity:
      sourceStat.ino === 0 ? `path:${sourceRealPath}` : `inode:${sourceStat.dev}:${sourceStat.ino}`,
    files: Object.freeze(files),
  });
}

function collectSnapshotFiles(root: string, out: string[], include: (file: string) => boolean = () => true): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw cause;
  }
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) collectSnapshotFiles(candidate, out, include);
    else if ((entry.isFile() || entry.isSymbolicLink()) && include(candidate)) out.push(candidate);
  }
}

function sameSourceSnapshot(left: SchedulerSourceSnapshot, right: SchedulerSourceSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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

function expectationForBinding(
  binding: SchedulerBinding,
  state: SchedulerMutationExpectation["state"],
  fingerprint?: string,
  legacyInvocation?: readonly string[],
): SchedulerMutationExpectation {
  return {
    state,
    bindingId: binding.id,
    nativeId: schedulerBindingNativeId(binding),
    logicalSource: binding.logicalSource,
    ordinal: binding.ordinal,
    invocation: binding.invocation,
    ...(fingerprint !== undefined ? { fingerprint } : {}),
    ...(legacyInvocation !== undefined ? { legacyInvocation } : {}),
  };
}

function freezeMutationExpectation(expectation: SchedulerMutationExpectation): SchedulerMutationExpectation {
  return Object.freeze({
    ...expectation,
    logicalSource: Object.freeze({ ...expectation.logicalSource }),
    invocation: Object.freeze([...expectation.invocation]),
    ...(expectation.legacyInvocation ? { legacyInvocation: Object.freeze([...expectation.legacyInvocation]) } : {}),
  });
}

function isTargetlessLegacyInvocationFor(legacy: readonly string[], canonical: readonly string[]): boolean {
  return (
    legacy.length === 4 &&
    legacy[0] === "task" &&
    legacy[1] === "run" &&
    legacy[2] === canonical[2] &&
    legacy[3] === "--scheduled"
  );
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
