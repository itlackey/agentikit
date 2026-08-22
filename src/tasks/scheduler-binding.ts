// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Secret-free input to every native scheduler backend.
 *
 * The binding deliberately contains only stable source identity, trigger
 * identity, and the public CLI tail. Source content, action inputs,
 * environment values, resolved requests, and credentials must never cross
 * this boundary or be persisted by an OS scheduler.
 */

import { createHash } from "node:crypto";
import { bundleRefToString, parseBundleRef } from "../core/asset/asset-ref";
import { UsageError } from "../core/errors";
import type { ScheduleBackend } from "./schedule";
import { normaliseTaskConceptId } from "./task-id";

export type SchedulerLogicalSource = Readonly<{
  kind: "task" | "workflow";
  ref: string;
}>;

export interface SchedulerBinding {
  readonly id: string;
  readonly logicalSource: SchedulerLogicalSource;
  readonly cron: string;
  readonly source: string;
  readonly ordinal: number;
  readonly enabled: boolean;
  /** Public CLI tail, excluding the resolved launcher and context descriptor. */
  readonly invocation: readonly string[];
}

export interface SchedulerSourceSchedule {
  readonly cron: string;
  readonly source: string;
  readonly ordinal: number;
}

export interface CompileTaskSchedulerBindingsInput {
  readonly id: string;
  readonly qualifiedRef: string;
  readonly bundleTarget?: string;
  readonly enabled: boolean;
  readonly schedules: readonly SchedulerSourceSchedule[];
}

export interface CompileWorkflowSchedulerBindingsInput {
  readonly qualifiedRef: string;
  readonly schedules: readonly SchedulerSourceSchedule[];
}

/** Existing native definition as exposed to the whole-set planner. */
export interface InstalledSchedulerBinding {
  readonly id: string;
  /** Exact backend artifact spelling enumerated from the native scheduler. */
  readonly nativeId?: string;
  readonly binding: readonly string[];
  readonly contextPath: string;
  readonly signature?: string;
  readonly target?: string;
  /** Parsed public CLI tail, used to attribute higher-ordinal task bindings. */
  readonly invocation?: readonly string[];
}

/** Existing native ownership visible during an explicit destructive rebind. */
export interface RebindSchedulerBinding {
  readonly id: string;
  readonly nativeId?: string;
  readonly signature?: string;
  readonly target?: string;
}

export interface SchedulerInstallOptions {
  readonly target?: string;
  readonly binding?: readonly string[];
  readonly contextPath?: string;
}

/** Read-only native inventory, including artifacts whose invocation is malformed. */
export interface SchedulerNativeArtifact {
  readonly nativeId: string;
  /** Proven only when the stored public invocation parses and matches nativeId. */
  readonly logicalId?: string;
  readonly logicalKind?: SchedulerLogicalSource["kind"];
}

/** Structural backend view used by the command layer without source documents. */
export interface SchedulerBackend {
  readonly name: ScheduleBackend;
  install(binding: SchedulerBinding, opts?: SchedulerInstallOptions): Promise<void> | void;
  uninstall(id: string): Promise<void> | void;
  setEnabled(id: string, enabled: boolean): Promise<void> | void;
  list(): Promise<InstalledSchedulerBinding[]> | InstalledSchedulerBinding[];
  listForRebind?(): Promise<RebindSchedulerBinding[]> | RebindSchedulerBinding[];
  listNativeArtifacts?(): Promise<SchedulerNativeArtifact[]> | SchedulerNativeArtifact[];
  expectedSignature?(binding: SchedulerBinding, opts?: SchedulerInstallOptions): string;
  /** Capture exact native definitions for a command-layer transaction. */
  snapshotBindings?(ids: readonly string[]): Promise<unknown> | unknown;
  /** Restore a snapshot returned by this backend's `snapshotBindings`. */
  restoreBindings?(snapshot: unknown): Promise<void> | void;
}

export function compileTaskSchedulerBindings(input: CompileTaskSchedulerBindingsInput): readonly SchedulerBinding[] {
  const id = normaliseTaskConceptId(input.id);
  const ref = assertQualifiedRef(input.qualifiedRef, "task");
  const invocation = Object.freeze([
    "task",
    "run",
    id,
    ...(input.bundleTarget ? ["--bundle", input.bundleTarget] : []),
    "--scheduled",
  ]);
  return Object.freeze(
    input.schedules.map((schedule) =>
      freezeBinding({
        id: schedule.ordinal === 0 ? id : digestBindingId("task", ref, schedule.ordinal),
        logicalSource: { kind: "task", ref },
        cron: schedule.cron,
        source: schedule.source,
        ordinal: schedule.ordinal,
        enabled: input.enabled,
        invocation,
      }),
    ),
  );
}

export function compileWorkflowSchedulerBindings(
  input: CompileWorkflowSchedulerBindingsInput,
): readonly SchedulerBinding[] {
  const ref = assertQualifiedRef(input.qualifiedRef, "workflow");
  const invocation = Object.freeze(["workflow", "run", ref]);
  return Object.freeze(
    input.schedules.map((schedule) =>
      freezeBinding({
        id: digestBindingId("workflow", ref, schedule.ordinal),
        logicalSource: { kind: "workflow", ref },
        cron: schedule.cron,
        source: schedule.source,
        ordinal: schedule.ordinal,
        enabled: true,
        invocation,
      }),
    ),
  );
}

/**
 * Map a logical binding id to the flat portable token persisted by native
 * schedulers. Existing flat ids are byte-for-byte stable; only standalone
 * component-relative ids need an encoded native spelling.
 */
export function schedulerNativeBindingId(id: string): string {
  if (!id.includes("/")) return id;
  const digest = createHash("sha256")
    .update(JSON.stringify(["nested-task", id]))
    .digest("hex")
    .slice(0, 32);
  return `task-${digest}`;
}

/** Portable collision key for scheduler namespaces with Windows semantics. */
export function schedulerNativeArtifactKey(nativeId: string): string {
  return nativeId.toLowerCase().replace(/\.+$/u, "");
}

/** Return a logical owner only when the public invocation proves the mapping. */
export function schedulerLogicalBindingOwner(nativeId: string, invocation: readonly string[]): string | undefined {
  return schedulerNativeArtifactOwner(nativeId, invocation)?.logicalId;
}

export function schedulerNativeArtifactOwner(
  nativeId: string,
  invocation: readonly string[],
): { logicalId: string; logicalKind: SchedulerLogicalSource["kind"] } | undefined {
  if (invocation[0] === "workflow" && invocation[1] === "run") {
    return { logicalId: nativeId, logicalKind: "workflow" };
  }
  const taskId = invocation[0] === "task" && invocation[1] === "run" ? invocation[2] : undefined;
  return taskId && schedulerNativeBindingId(taskId) === nativeId
    ? { logicalId: taskId, logicalKind: "task" }
    : undefined;
}

export function assertSchedulerNativeArtifactOwner(
  nativeId: string,
  intended: SchedulerBinding,
  invocation: readonly string[] | undefined,
): void {
  const owner = invocation ? schedulerNativeArtifactOwner(nativeId, invocation) : undefined;
  if (owner?.logicalId === intended.id && owner.logicalKind === intended.logicalSource.kind) return;
  const description = owner
    ? `${owner.logicalKind} ${JSON.stringify(owner.logicalId)}`
    : "an unproven or malformed owner";
  throw new UsageError(
    `Native scheduler artifact ${JSON.stringify(nativeId)} belongs to ${description}, not ${intended.logicalSource.kind} ${JSON.stringify(intended.id)}.`,
    "RESOURCE_ALREADY_EXISTS",
  );
}

/** Recover the logical nested task id from its signed public invocation. */
export function schedulerLogicalBindingId(nativeId: string, invocation: readonly string[]): string {
  return schedulerLogicalBindingOwner(nativeId, invocation) ?? nativeId;
}

function digestBindingId(kind: "task" | "workflow", ref: string, ordinal: number): string {
  const prefix = kind === "workflow" ? "wf" : "task";
  const digest = createHash("sha256")
    .update(JSON.stringify([kind, ref, ordinal]))
    .digest("hex")
    .slice(0, 32);
  return `${prefix}-${digest}`;
}

function assertQualifiedRef(value: string, kind: "task" | "workflow"): string {
  const parsed = parseBundleRef(value);
  if (!parsed.bundle || parsed.fragment !== undefined || bundleRefToString(parsed) !== value) {
    throw new UsageError(`${kind} scheduler bindings require one canonical fully-qualified ref.`, "INVALID_FLAG_VALUE");
  }
  return value;
}

function freezeBinding(binding: SchedulerBinding): SchedulerBinding {
  return Object.freeze({
    ...binding,
    logicalSource: Object.freeze({ ...binding.logicalSource }),
    invocation: Object.freeze([...binding.invocation]),
  });
}
