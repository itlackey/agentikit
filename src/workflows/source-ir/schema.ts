// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Strict, adapter-neutral workflow source IR.
 *
 * This is deliberately separate from the durable workflow plan in `../ir`.
 * Source adapters produce this representation; the durable freeze lane owns
 * resolving executable targets and creating resumable dispatch state.
 */

import { types as utilTypes } from "node:util";

export const WORKFLOW_SOURCE_IR_VERSION = 1;
export const WORKFLOW_SOURCE_IR_MAX_BYTES = 2 * 1024 * 1024;
export const WORKFLOW_SOURCE_IR_MAX_DEPTH = 64;
export const WORKFLOW_SOURCE_IR_MAX_NODES = 50_000;

export const WORKFLOW_SOURCE_EXTENSION_OWNER_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

export const WORKFLOW_SOURCE_HOST_SHELLS = ["bash", "sh", "zsh", "pwsh", "powershell", "cmd"] as const;
export type WorkflowSourceHostShell = (typeof WORKFLOW_SOURCE_HOST_SHELLS)[number];

export interface WorkflowSourceSpan {
  path: string;
  /** 1-indexed inclusive source line. */
  start: number;
  /** 1-indexed inclusive source line. */
  end: number;
}

export type WorkflowSourceScalar = string | number | boolean | null;
export type WorkflowSourceEnvironmentValue = string | number | boolean;
export type WorkflowSourceExtensionValue =
  | WorkflowSourceScalar
  | WorkflowSourceExtensionValue[]
  | { [key: string]: WorkflowSourceExtensionValue };
export type WorkflowSourceExtensions = Record<string, WorkflowSourceExtensionValue>;

export interface WorkflowDispatchSourceTrigger {
  kind: "workflow_dispatch";
  source: WorkflowSourceSpan;
}

export interface ScheduleSourceTrigger {
  kind: "schedule";
  cron: string;
  ordinal: number;
  source: WorkflowSourceSpan;
}

export type WorkflowSourceTrigger = WorkflowDispatchSourceTrigger | ScheduleSourceTrigger;

export interface WorkflowSourceStep {
  id: string;
  name?: string;
  /** Exactly one of `uses` and `run` is present. */
  uses?: string;
  /** Exactly one of `uses` and `run` is present. */
  run?: string;
  with?: Record<string, WorkflowSourceScalar>;
  env?: Record<string, WorkflowSourceEnvironmentValue>;
  shell?: WorkflowSourceHostShell;
  workingDirectory?: string;
  extensions?: WorkflowSourceExtensions;
  source: WorkflowSourceSpan;
}

export interface WorkflowSourceJob {
  id: string;
  name?: string;
  needs: string[];
  steps: WorkflowSourceStep[];
  extensions?: WorkflowSourceExtensions;
  source: WorkflowSourceSpan;
}

export interface WorkflowSourceIrV1 {
  sourceIrVersion: typeof WORKFLOW_SOURCE_IR_VERSION;
  name: string;
  triggers: WorkflowSourceTrigger[];
  /** Dependency-topological order with lexical tie-breaking. */
  jobs: WorkflowSourceJob[];
  extensions?: WorkflowSourceExtensions;
  source: WorkflowSourceSpan;
}

const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const HOST_SHELLS = new Set<string>(WORKFLOW_SOURCE_HOST_SHELLS);

/** Strictly decode untrusted plain data before it reaches source lowering. */
export function decodeWorkflowSourceIrV1(input: unknown): WorkflowSourceIrV1 {
  const decoded = snapshotPlainData(input);
  const root = record(decoded, "source IR");
  keys(root, ["sourceIrVersion", "name", "triggers", "jobs", "extensions", "source"], "source IR");
  if (root.sourceIrVersion !== WORKFLOW_SOURCE_IR_VERSION) fail("sourceIrVersion must be 1");
  nonEmptyString(root.name, "name");
  span(root.source, "source");
  extensions(root.extensions, "extensions");

  if (!Array.isArray(root.triggers) || root.triggers.length === 0 || root.triggers.length > 64) {
    fail("triggers must contain 1 through 64 entries");
  }
  validateTriggers(root.triggers);

  if (!Array.isArray(root.jobs) || root.jobs.length === 0 || root.jobs.length > 256) {
    fail("jobs must contain 1 through 256 entries");
  }
  const jobIds = new Set<string>();
  for (const [index, job] of root.jobs.entries()) validateJob(job, index, jobIds);
  for (const job of root.jobs as unknown as WorkflowSourceJob[]) {
    for (const need of job.needs) if (!jobIds.has(need)) fail(`job ${job.id} needs missing job ${need}`);
  }
  validateTopologicalJobs(root.jobs as unknown as WorkflowSourceJob[]);
  return decoded as WorkflowSourceIrV1;
}

function validateTrigger(value: unknown, index: number): void {
  const trigger = record(value, `trigger ${index}`);
  if (trigger.kind === "workflow_dispatch") {
    keys(trigger, ["kind", "source"], `trigger ${index}`);
    span(trigger.source, `trigger ${index} source`);
    return;
  }
  if (trigger.kind !== "schedule") fail(`trigger ${index} has an unsupported kind`);
  keys(trigger, ["kind", "cron", "ordinal", "source"], `trigger ${index}`);
  nonEmptyString(trigger.cron, `trigger ${index} cron`);
  if (!Number.isSafeInteger(trigger.ordinal) || (trigger.ordinal as number) < 0) {
    fail(`trigger ${index} ordinal must be a non-negative integer`);
  }
  span(trigger.source, `trigger ${index} source`);
}

function validateTriggers(value: unknown[]): void {
  let nextScheduleOrdinal = 0;
  let manualSeen = false;
  for (const [index, trigger] of value.entries()) {
    validateTrigger(trigger, index);
    const decoded = trigger as WorkflowSourceTrigger;
    if (decoded.kind === "schedule") {
      if (manualSeen || decoded.ordinal !== nextScheduleOrdinal) {
        fail("triggers are not in canonical schedule-then-manual order");
      }
      nextScheduleOrdinal++;
    } else {
      if (manualSeen) fail("triggers contain duplicate workflow_dispatch entries");
      manualSeen = true;
    }
  }
}

function validateJob(value: unknown, index: number, jobIds: Set<string>): void {
  const job = record(value, `job ${index}`);
  keys(job, ["id", "name", "needs", "steps", "extensions", "source"], `job ${index}`);
  const id = sourceId(job.id, `job ${index} id`);
  if (jobIds.has(id)) fail(`duplicate job id ${id}`);
  jobIds.add(id);
  optionalString(job.name, `job ${id} name`);
  stringList(job.needs, `job ${id} needs`, 256, true);
  const needs = job.needs as string[];
  if (needs.some((need, needIndex) => needIndex > 0 && compareCodePoints(needs[needIndex - 1] ?? "", need) > 0)) {
    fail(`job ${id} needs are not in canonical order`);
  }
  if (!Array.isArray(job.steps) || job.steps.length === 0 || job.steps.length > 256) {
    fail(`job ${id} steps must contain 1 through 256 entries`);
  }
  const stepIds = new Set<string>();
  for (const [stepIndex, step] of job.steps.entries()) validateStep(step, id, stepIndex, stepIds);
  extensions(job.extensions, `job ${id} extensions`);
  span(job.source, `job ${id} source`);
}

function validateStep(value: unknown, jobId: string, index: number, stepIds: Set<string>): void {
  const step = record(value, `job ${jobId} step ${index}`);
  keys(
    step,
    ["id", "name", "uses", "run", "with", "env", "shell", "workingDirectory", "extensions", "source"],
    `job ${jobId} step ${index}`,
  );
  const id = sourceId(step.id, `job ${jobId} step ${index} id`);
  if (stepIds.has(id)) fail(`job ${jobId} has duplicate step id ${id}`);
  stepIds.add(id);
  optionalString(step.name, `step ${id} name`);
  const hasUses = typeof step.uses === "string" && step.uses.length > 0;
  const hasRun = typeof step.run === "string" && step.run.length > 0;
  if (hasUses === hasRun) fail(`step ${id} must contain exactly one of uses or run`);
  if (step.uses !== undefined && !hasUses) fail(`step ${id} uses must be a non-empty string`);
  if (step.run !== undefined && !hasRun) fail(`step ${id} run must be a non-empty string`);
  scalarRecord(step.with, `step ${id} with`, true);
  environment(step.env, `step ${id} env`);
  if (step.with !== undefined && !hasUses) fail(`step ${id} with is legal only with uses`);
  if ((step.shell !== undefined || step.workingDirectory !== undefined) && !hasRun) {
    fail(`step ${id} shell and workingDirectory are legal only with run`);
  }
  if (step.shell !== undefined && (typeof step.shell !== "string" || !HOST_SHELLS.has(step.shell))) {
    fail(`step ${id} has an unsupported shell`);
  }
  optionalString(step.workingDirectory, `step ${id} workingDirectory`);
  extensions(step.extensions, `step ${id} extensions`);
  span(step.source, `step ${id} source`);
}

function validateTopologicalJobs(jobs: WorkflowSourceJob[]): void {
  const emitted = new Set<string>();
  for (const job of jobs) {
    const expected = jobs
      .filter((candidate) => !emitted.has(candidate.id) && candidate.needs.every((need) => emitted.has(need)))
      .sort((left, right) => compareCodePoints(left.id, right.id))[0];
    if (!expected || expected.id !== job.id) fail("jobs are not in canonical dependency-topological order");
    emitted.add(job.id);
  }
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface SnapshotState {
  nodes: number;
  bytes: number;
}

function snapshotPlainData(input: unknown): unknown {
  return snapshotValue(input, 0, "source IR", { nodes: 0, bytes: 0 });
}

function snapshotValue(value: unknown, depth: number, location: string, state: SnapshotState): unknown {
  state.nodes++;
  if (state.nodes > WORKFLOW_SOURCE_IR_MAX_NODES) fail("source IR exceeds the node limit");
  if (depth > WORKFLOW_SOURCE_IR_MAX_DEPTH) fail("source IR exceeds the depth limit");
  if (value === null || typeof value === "boolean") {
    countJsonBytes(state, value === null ? "null" : String(value));
    return value;
  }
  if (typeof value === "string") {
    if (!wellFormedUnicode(value)) fail(`${location} must contain well-formed Unicode`);
    countJsonBytes(state, JSON.stringify(value));
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${location} contains a non-finite number`);
    const canonical = Object.is(value, -0) ? 0 : value;
    countJsonBytes(state, JSON.stringify(canonical));
    return canonical;
  }
  if (typeof value !== "object") fail(`${location} contains non-JSON data`);
  if (utilTypes.isProxy(value)) fail(`${location} must not be a Proxy object`);
  return Array.isArray(value)
    ? snapshotArray(value, depth, location, state)
    : snapshotObject(value, depth, location, state);
}

function snapshotArray(value: unknown[], depth: number, location: string, state: SnapshotState): unknown[] {
  if (Object.getPrototypeOf(value) !== Array.prototype) fail(`${location} must be a plain array`);
  const ownKeys = Reflect.ownKeys(value);
  const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) {
    fail(`${location} has an invalid array length`);
  }
  const length = lengthDescriptor.value as number;
  if (length < 0 || length > WORKFLOW_SOURCE_IR_MAX_NODES) fail(`${location} exceeds the array length limit`);
  const expected = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
  for (const key of ownKeys) {
    if (typeof key === "symbol") fail(`${location} contains symbol keys`);
    if (!expected.has(key)) fail(`${location} contains unexpected array property ${key}`);
  }
  const snapshot = new Array<unknown>(length);
  countJsonBytes(state, "[");
  for (let index = 0; index < length; index++) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor) fail(`${location} contains a sparse array`);
    if (!("value" in descriptor)) fail(`${location}[${index}] is an accessor property`);
    if (!descriptor.enumerable) fail(`${location}[${index}] is non-enumerable`);
    if (index > 0) countJsonBytes(state, ",");
    snapshot[index] = snapshotValue(descriptor.value, depth + 1, `${location}[${index}]`, state);
  }
  countJsonBytes(state, "]");
  return snapshot;
}

function snapshotObject(value: object, depth: number, location: string, state: SnapshotState): Record<string, unknown> {
  if (Object.getPrototypeOf(value) !== Object.prototype) fail(`${location} must be a plain object`);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length > WORKFLOW_SOURCE_IR_MAX_NODES) fail(`${location} exceeds the object key limit`);
  const snapshot: Record<string, unknown> = {};
  countJsonBytes(state, "{");
  for (const [index, key] of ownKeys.entries()) {
    if (typeof key === "symbol") fail(`${location} contains symbol keys`);
    if (!wellFormedUnicode(key)) fail(`${location} contains an ill-formed key`);
    if (UNSAFE_KEYS.has(key)) fail(`${location} contains unsafe key ${key}`);
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor) fail(`${location}.${key} has no stable own descriptor`);
    if (!("value" in descriptor)) fail(`${location}.${key} is an accessor property`);
    if (!descriptor.enumerable) fail(`${location}.${key} is non-enumerable`);
    if (index > 0) countJsonBytes(state, ",");
    countJsonBytes(state, `${JSON.stringify(key)}:`);
    Object.defineProperty(snapshot, key, {
      configurable: true,
      enumerable: true,
      value: snapshotValue(descriptor.value, depth + 1, `${location}.${key}`, state),
      writable: true,
    });
  }
  countJsonBytes(state, "}");
  return snapshot;
}

function countJsonBytes(state: SnapshotState, token: string): void {
  state.bytes += Buffer.byteLength(token, "utf8");
  if (state.bytes > WORKFLOW_SOURCE_IR_MAX_BYTES) fail("source IR exceeds the byte limit");
}

function wellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function record(value: unknown, location: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${location} must be an object`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], location: string): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) if (!accepted.has(key)) fail(`${location} has unknown key ${key}`);
}

function sourceId(value: unknown, location: string): string {
  nonEmptyString(value, location);
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(value as string)) fail(`${location} has an invalid identifier`);
  return value as string;
}

function nonEmptyString(value: unknown, location: string): void {
  if (typeof value !== "string" || value.trim() === "") fail(`${location} must be a non-empty string`);
}

function optionalString(value: unknown, location: string): void {
  if (value !== undefined) nonEmptyString(value, location);
}

function stringList(value: unknown, location: string, max: number, allowEmpty: boolean): void {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > max) {
    fail(`${location} must be ${allowEmpty ? "an" : "a non-empty"} array with at most ${max} entries`);
  }
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    nonEmptyString(item, `${location}[${index}]`);
    if (seen.has(item as string)) fail(`${location} contains duplicate ${item as string}`);
    seen.add(item as string);
  }
}

function scalarRecord(value: unknown, location: string, allowNull: boolean): void {
  if (value === undefined) return;
  const map = record(value, location);
  for (const [key, item] of Object.entries(map)) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(key)) fail(`${location} has invalid key ${key}`);
    if (item === null && allowNull) continue;
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
      fail(`${location}.${key} must be a scalar`);
    }
  }
}

function environment(value: unknown, location: string): void {
  if (value === undefined) return;
  const map = record(value, location);
  for (const [key, item] of Object.entries(map)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) fail(`${location} has invalid environment name ${key}`);
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
      fail(`${location}.${key} must be a string, number, or boolean`);
    }
  }
}

function extensions(value: unknown, location: string): void {
  if (value === undefined) return;
  const map = record(value, location);
  for (const owner of Object.keys(map)) {
    if (!WORKFLOW_SOURCE_EXTENSION_OWNER_PATTERN.test(owner)) fail(`${location} has invalid owner ${owner}`);
  }
}

function span(value: unknown, location: string): void {
  const source = record(value, location);
  keys(source, ["path", "start", "end"], location);
  nonEmptyString(source.path, `${location}.path`);
  if (!Number.isSafeInteger(source.start) || (source.start as number) < 1) fail(`${location}.start is invalid`);
  if (!Number.isSafeInteger(source.end) || (source.end as number) < (source.start as number)) {
    fail(`${location}.end is invalid`);
  }
}

function fail(message: string): never {
  throw new Error(`Invalid workflow source IR v1: ${message}`);
}
