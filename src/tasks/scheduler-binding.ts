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
import { normaliseTaskId } from "./task-id";

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
  readonly signature?: string;
  readonly target?: string;
}

export interface SchedulerInstallOptions {
  readonly target?: string;
  readonly binding?: readonly string[];
  readonly contextPath?: string;
}

/** Structural backend view used by the command layer without source documents. */
export interface SchedulerBackend {
  readonly name: ScheduleBackend;
  install(binding: SchedulerBinding, opts?: SchedulerInstallOptions): Promise<void> | void;
  uninstall(id: string): Promise<void> | void;
  setEnabled(id: string, enabled: boolean): Promise<void> | void;
  list(): Promise<InstalledSchedulerBinding[]> | InstalledSchedulerBinding[];
  listForRebind?(): Promise<RebindSchedulerBinding[]> | RebindSchedulerBinding[];
  expectedSignature?(binding: SchedulerBinding, opts?: SchedulerInstallOptions): string;
  /** Capture exact native definitions for a command-layer transaction. */
  snapshotBindings?(ids: readonly string[]): Promise<unknown> | unknown;
  /** Restore a snapshot returned by this backend's `snapshotBindings`. */
  restoreBindings?(snapshot: unknown): Promise<void> | void;
}

export function compileTaskSchedulerBindings(input: CompileTaskSchedulerBindingsInput): readonly SchedulerBinding[] {
  const id = normaliseTaskId(input.id);
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
