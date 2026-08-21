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
import { bundleRefToString, parseBundleRef } from "../../core/asset/asset-ref";
import { validateExtraParams } from "../../core/extra-params";
import { checkJsonSchemaDefinition } from "../../core/json-schema";
import { parseReference } from "../program/expressions";
import { PROGRAM_RETRY_REASONS } from "../program/schema";
import {
  jsonBytes,
  utf8Bytes,
  WORKFLOW_ENGINE_NAME_PATTERN,
  WORKFLOW_ENV_VAR_NAME_PATTERN,
  WORKFLOW_MAX_CONCURRENCY,
  WORKFLOW_MAX_ENGINE_NAME_LENGTH,
  WORKFLOW_MAX_EXEC_ARG_BYTES,
  WORKFLOW_MAX_EXEC_ARGV,
  WORKFLOW_MAX_EXEC_CWD_LENGTH,
  WORKFLOW_MAX_EXEC_PASS_ENV,
  WORKFLOW_MAX_EXTRA_PARAMS_BYTES,
  WORKFLOW_MAX_GATE_LOOPS,
  WORKFLOW_MAX_INPUTS,
  WORKFLOW_MAX_MAP_EXPANSION,
  WORKFLOW_MAX_PARAMS,
  WORKFLOW_MAX_RETRIES,
  WORKFLOW_MAX_ROUTE_BRANCHES,
  WORKFLOW_MAX_SCHEMA_BYTES,
  WORKFLOW_MAX_TIMEOUT_MS,
} from "../resource-limits";
import { canonicalTopologicalJobs, compareWorkflowSourceCodePoints } from "./ordering";
import {
  canonicalizeWorkflowCron,
  canonicalizeWorkflowRun,
  canonicalizeWorkflowWorkingDirectory,
  classifyWorkflowStepUses,
  rejectNulInArgv,
  validateWorkflowBuiltinCommand,
  WorkflowSourceSemanticError,
} from "./semantics";

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
export type WorkflowSourceJsonValue = WorkflowSourceExtensionValue;
export type WorkflowSourceJsonObject = Record<string, WorkflowSourceJsonValue>;

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

export interface WorkflowSourceExec {
  command: string[];
  cwd?: string;
  passEnv?: string[];
  inheritEnv?: true;
}

export interface WorkflowSourceUnit {
  engine?: string;
  model?: string;
  llm?: WorkflowSourceJsonObject;
  timeoutMs?: number | null;
  retry?: { max: number; on: string[] };
  onError?: "fail" | "continue";
  output?: WorkflowSourceJsonObject;
  env?: string[];
  isolation?: "none" | "worktree";
}

export interface WorkflowSourceMap {
  over: string;
  concurrency?: number;
  reducer?: "collect" | "vote";
}

export interface WorkflowSourceRoute {
  input: string;
  branches: Array<{ match: string; stepId: string }>;
  defaultStepId?: string;
}

export interface WorkflowSourceGate {
  maxLoops?: number;
  rubric?: string;
}

export interface WorkflowSourceStep {
  id: string;
  name?: string;
  /** One of the dispatch targets; mutually exclusive with `run` and `exec`. */
  uses?: string;
  /** Exactly one of `uses`, `run`, and `exec` is present unless this is a route. */
  run?: string;
  /** Lossless direct-spawn argv. It is never joined into a shell string. */
  exec?: WorkflowSourceExec;
  with?: Record<string, WorkflowSourceScalar>;
  env?: Record<string, WorkflowSourceEnvironmentValue>;
  shell?: WorkflowSourceHostShell;
  workingDirectory?: string;
  unit?: WorkflowSourceUnit;
  map?: WorkflowSourceMap;
  route?: WorkflowSourceRoute;
  inputs?: string[];
  output?: WorkflowSourceJsonObject;
  gate?: WorkflowSourceGate;
  /** Format-native prose retained explicitly for display/source round trips. */
  instructions?: string;
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
  description?: string;
  tags?: string[];
  params?: Record<string, WorkflowSourceJsonObject>;
  defaults?: Omit<WorkflowSourceUnit, "retry" | "output" | "env" | "isolation">;
  budget?: { maxTokens?: number; maxUnits?: number };
  preamble?: string;
  triggers: WorkflowSourceTrigger[];
  /** Dependency-topological order with lexical tie-breaking. */
  jobs: WorkflowSourceJob[];
  extensions?: WorkflowSourceExtensions;
  source: WorkflowSourceSpan;
}

const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const HOST_SHELLS = new Set<string>(WORKFLOW_SOURCE_HOST_SHELLS);

export interface WorkflowSourceDecodeOptions {
  workspaceRoot?: string;
}

/** Strictly decode untrusted plain data before it reaches source lowering. */
export function decodeWorkflowSourceIrV1(
  input: unknown,
  options: WorkflowSourceDecodeOptions = {},
): WorkflowSourceIrV1 {
  const decoded = snapshotPlainData(input);
  const root = record(decoded, "source IR");
  keys(
    root,
    [
      "sourceIrVersion",
      "name",
      "description",
      "tags",
      "params",
      "defaults",
      "budget",
      "preamble",
      "triggers",
      "jobs",
      "extensions",
      "source",
    ],
    "source IR",
  );
  if (root.sourceIrVersion !== WORKFLOW_SOURCE_IR_VERSION) fail("sourceIrVersion must be 1");
  nonEmptyString(root.name, "name");
  optionalString(root.description, "description");
  optionalString(root.preamble, "preamble");
  optionalStringList(root.tags, "tags", 256);
  validateParams(root.params);
  validateUnit(root.defaults, "defaults", true);
  validateBudget(root.budget);
  span(root.source, "source");
  extensions(root.extensions, "extensions");
  const markdownSource =
    root.extensions !== undefined &&
    Object.hasOwn(root.extensions as Record<string, unknown>, "akm.dev/workflow-markdown");

  if (!Array.isArray(root.triggers) || root.triggers.length === 0 || root.triggers.length > 64) {
    fail("triggers must contain 1 through 64 entries");
  }
  validateTriggers(root.triggers);

  if (!Array.isArray(root.jobs) || root.jobs.length === 0 || root.jobs.length > 256) {
    fail("jobs must contain 1 through 256 entries");
  }
  const jobIds = new Set<string>();
  for (const [index, job] of root.jobs.entries()) validateJob(job, index, jobIds, options, markdownSource);
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
  try {
    trigger.cron = canonicalizeWorkflowCron(trigger.cron as string);
  } catch (cause) {
    semanticFail(cause, `trigger ${index} cron`);
  }
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

function validateJob(
  value: unknown,
  index: number,
  jobIds: Set<string>,
  options: WorkflowSourceDecodeOptions,
  markdownSource: boolean,
): void {
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
  for (const [stepIndex, step] of job.steps.entries()) {
    validateStep(step, id, stepIndex, stepIds, options, markdownSource);
  }
  validateRouteTargets(job.steps as WorkflowSourceStep[], id);
  extensions(job.extensions, `job ${id} extensions`);
  span(job.source, `job ${id} source`);
}

function validateStep(
  value: unknown,
  jobId: string,
  index: number,
  stepIds: Set<string>,
  options: WorkflowSourceDecodeOptions,
  markdownSource: boolean,
): void {
  const step = record(value, `job ${jobId} step ${index}`);
  keys(
    step,
    [
      "id",
      "name",
      "uses",
      "run",
      "exec",
      "with",
      "env",
      "shell",
      "workingDirectory",
      "unit",
      "map",
      "route",
      "inputs",
      "output",
      "gate",
      "instructions",
      "extensions",
      "source",
    ],
    `job ${jobId} step ${index}`,
  );
  const id = sourceId(step.id, `job ${jobId} step ${index} id`);
  if (stepIds.has(id)) fail(`job ${jobId} has duplicate step id ${id}`);
  stepIds.add(id);
  optionalString(step.name, `step ${id} name`);
  const hasUses = typeof step.uses === "string" && step.uses.length > 0;
  const hasRun = typeof step.run === "string" && step.run.length > 0;
  const hasExec = step.exec !== undefined;
  const hasRoute = step.route !== undefined;
  const targetCount = Number(hasUses) + Number(hasRun) + Number(hasExec);
  if ((hasRoute && targetCount !== 0) || (!hasRoute && targetCount !== 1)) {
    fail(`step ${id} must contain exactly one of uses, run, or exec unless it is a route`);
  }
  if (step.uses !== undefined && !hasUses) fail(`step ${id} uses must be a non-empty string`);
  if (step.run !== undefined && !hasRun) fail(`step ${id} run must be a non-empty string`);
  if (hasUses) {
    try {
      const target = classifyWorkflowStepUses(step.uses as string);
      if (target.kind === "builtin-command") validateWorkflowBuiltinCommand(step.with);
    } catch (cause) {
      semanticFail(cause, `step ${id} uses`);
    }
  }
  if (hasRun) {
    try {
      step.run = canonicalizeWorkflowRun(step.run as string);
    } catch (cause) {
      semanticFail(cause, `step ${id} run`);
    }
  }
  validateExec(step.exec, `step ${id} exec`, options);
  scalarRecord(step.with, `step ${id} with`, true);
  environment(step.env, `step ${id} env`);
  rejectStepWithExpressions(step, id, markdownSource);
  rejectExpressionsInRecord(step.env, `step ${id} env`);
  if (step.with !== undefined && !hasUses) fail(`step ${id} with is legal only with uses`);
  if ((step.shell !== undefined || step.workingDirectory !== undefined) && !hasRun) {
    fail(`step ${id} shell and workingDirectory are legal only with run`);
  }
  if (step.shell !== undefined && (typeof step.shell !== "string" || !HOST_SHELLS.has(step.shell))) {
    fail(`step ${id} has an unsupported shell`);
  }
  optionalString(step.workingDirectory, `step ${id} workingDirectory`);
  if (step.workingDirectory !== undefined) {
    try {
      step.workingDirectory = canonicalizeWorkflowWorkingDirectory(
        step.workingDirectory as string,
        options.workspaceRoot,
      );
    } catch (cause) {
      semanticFail(cause, `step ${id} workingDirectory`);
    }
  }
  validateUnit(step.unit, `step ${id} unit`, false);
  if (hasExec && step.unit !== undefined) {
    const unit = step.unit as Record<string, unknown>;
    if (unit.engine !== undefined || unit.model !== undefined || unit.llm !== undefined) {
      fail(`step ${id} exec cannot also select an engine, model, or llm override`);
    }
  }
  validateMap(step.map, `step ${id} map`);
  validateRoute(step.route, `step ${id} route`);
  optionalStringList(step.inputs, `step ${id} inputs`, WORKFLOW_MAX_INPUTS);
  if (Array.isArray(step.inputs)) {
    for (const [inputIndex, input] of step.inputs.entries())
      validateReference(input, `step ${id} inputs[${inputIndex}]`);
  }
  validateSchema(step.output, `step ${id} output`);
  validateGate(step.gate, `step ${id} gate`);
  optionalString(step.instructions, `step ${id} instructions`);
  if (hasRoute && (step.map !== undefined || step.unit !== undefined || step.inputs !== undefined)) {
    fail(`step ${id} route cannot contain map, unit, or inputs`);
  }
  extensions(step.extensions, `step ${id} extensions`);
  span(step.source, `step ${id} source`);
}

function validateTopologicalJobs(jobs: WorkflowSourceJob[]): void {
  const result = canonicalTopologicalJobs(jobs);
  if (!result.ok) {
    if (result.kind === "missing") fail(`job ${result.job.id} needs missing job ${result.dependency}`);
    fail("jobs contain a dependency cycle");
  }
  if (result.jobs.some((job, index) => job.id !== jobs[index]?.id)) {
    fail("jobs are not in canonical dependency-topological order");
  }
}

function compareCodePoints(left: string, right: string): number {
  return compareWorkflowSourceCodePoints(left, right);
}

function validateExec(value: unknown, location: string, options: WorkflowSourceDecodeOptions): void {
  if (value === undefined) return;
  const exec = record(value, location);
  keys(exec, ["command", "cwd", "passEnv", "inheritEnv"], location);
  stringList(exec.command, `${location}.command`, WORKFLOW_MAX_EXEC_ARGV, false);
  for (const [index, argument] of (exec.command as string[]).entries()) {
    if (utf8Bytes(argument) > WORKFLOW_MAX_EXEC_ARG_BYTES) {
      fail(`${location}.command[${index}] exceeds ${WORKFLOW_MAX_EXEC_ARG_BYTES} bytes`);
    }
  }
  try {
    rejectNulInArgv(exec.command as string[]);
  } catch (cause) {
    semanticFail(cause, location);
  }
  optionalString(exec.cwd, `${location}.cwd`);
  if (exec.cwd !== undefined) {
    if ((exec.cwd as string).length > WORKFLOW_MAX_EXEC_CWD_LENGTH) {
      fail(`${location}.cwd exceeds ${WORKFLOW_MAX_EXEC_CWD_LENGTH} characters`);
    }
    try {
      exec.cwd = canonicalizeWorkflowWorkingDirectory(exec.cwd as string, options.workspaceRoot);
    } catch (cause) {
      semanticFail(cause, `${location}.cwd`);
    }
  }
  if (exec.passEnv !== undefined) {
    stringList(exec.passEnv, `${location}.passEnv`, WORKFLOW_MAX_EXEC_PASS_ENV, false);
  }
  if (Array.isArray(exec.passEnv)) {
    for (const name of exec.passEnv) {
      if (!WORKFLOW_ENV_VAR_NAME_PATTERN.test(name)) fail(`${location}.passEnv has invalid environment name ${name}`);
    }
  }
  if (exec.inheritEnv !== undefined && exec.inheritEnv !== true) fail(`${location}.inheritEnv must be true or absent`);
}

function validateUnit(value: unknown, location: string, defaults: boolean): void {
  if (value === undefined) return;
  const unit = record(value, location);
  const allowed = defaults
    ? ["engine", "model", "llm", "timeoutMs", "onError"]
    : ["engine", "model", "llm", "timeoutMs", "retry", "onError", "output", "env", "isolation"];
  keys(unit, allowed, location);
  optionalString(unit.engine, `${location}.engine`);
  if (typeof unit.engine === "string") {
    const engine = unit.engine.trim();
    unit.engine = engine;
    if (!WORKFLOW_ENGINE_NAME_PATTERN.test(engine) || engine.length > WORKFLOW_MAX_ENGINE_NAME_LENGTH) {
      fail(`${location}.engine has an invalid engine name`);
    }
  }
  optionalString(unit.model, `${location}.model`);
  if (typeof unit.model === "string") unit.model = unit.model.trim();
  validateLlm(unit.llm, `${location}.llm`);
  if (
    unit.timeoutMs !== undefined &&
    unit.timeoutMs !== null &&
    (!Number.isSafeInteger(unit.timeoutMs) ||
      (unit.timeoutMs as number) < 1 ||
      (unit.timeoutMs as number) > WORKFLOW_MAX_TIMEOUT_MS)
  ) {
    fail(`${location}.timeoutMs must be null or an integer from 1 through ${WORKFLOW_MAX_TIMEOUT_MS}`);
  }
  if (unit.onError !== undefined && unit.onError !== "fail" && unit.onError !== "continue") {
    fail(`${location}.onError must be fail or continue`);
  }
  if (!defaults) {
    validateRetry(unit.retry, `${location}.retry`);
    validateSchema(unit.output, `${location}.output`);
    optionalStringList(unit.env, `${location}.env`, 256);
    if (Array.isArray(unit.env)) {
      for (const [index, ref] of unit.env.entries()) validateAssetRef(ref, `${location}.env[${index}]`);
    }
    if (unit.isolation !== undefined && unit.isolation !== "none" && unit.isolation !== "worktree") {
      fail(`${location}.isolation must be none or worktree`);
    }
  }
}

function validateRetry(value: unknown, location: string): void {
  if (value === undefined) return;
  const retry = record(value, location);
  keys(retry, ["max", "on"], location);
  if (!Number.isSafeInteger(retry.max) || (retry.max as number) < 0 || (retry.max as number) > WORKFLOW_MAX_RETRIES) {
    fail(`${location}.max must be an integer from 0 through ${WORKFLOW_MAX_RETRIES}`);
  }
  stringList(retry.on, `${location}.on`, PROGRAM_RETRY_REASONS.length, false);
  for (const reason of retry.on as string[]) {
    if (!(PROGRAM_RETRY_REASONS as readonly string[]).includes(reason)) {
      fail(`${location}.on contains unknown failure reason ${reason}`);
    }
  }
}

function validateMap(value: unknown, location: string): void {
  if (value === undefined) return;
  const map = record(value, location);
  keys(map, ["over", "concurrency", "reducer"], location);
  nonEmptyString(map.over, `${location}.over`);
  validateReference(map.over as string, `${location}.over`);
  if (
    map.concurrency !== undefined &&
    (!Number.isSafeInteger(map.concurrency) ||
      (map.concurrency as number) < 1 ||
      (map.concurrency as number) > WORKFLOW_MAX_CONCURRENCY)
  ) {
    fail(`${location}.concurrency must be an integer from 1 through ${WORKFLOW_MAX_CONCURRENCY}`);
  }
  if (map.reducer !== undefined && map.reducer !== "collect" && map.reducer !== "vote") {
    fail(`${location}.reducer must be collect or vote`);
  }
}

function validateRoute(value: unknown, location: string): void {
  if (value === undefined) return;
  const route = record(value, location);
  keys(route, ["input", "branches", "defaultStepId"], location);
  nonEmptyString(route.input, `${location}.input`);
  validateReference(route.input as string, `${location}.input`);
  if (
    !Array.isArray(route.branches) ||
    route.branches.length === 0 ||
    route.branches.length > WORKFLOW_MAX_ROUTE_BRANCHES
  ) {
    fail(`${location}.branches must contain 1 through ${WORKFLOW_MAX_ROUTE_BRANCHES} entries`);
  }
  const matches = new Set<string>();
  for (const [index, value] of route.branches.entries()) {
    const branch = record(value, `${location}.branches[${index}]`);
    keys(branch, ["match", "stepId"], `${location}.branches[${index}]`);
    nonEmptyString(branch.match, `${location}.branches[${index}].match`);
    sourceId(branch.stepId, `${location}.branches[${index}].stepId`);
    if (matches.has(branch.match as string)) fail(`${location} contains duplicate match ${branch.match as string}`);
    matches.add(branch.match as string);
  }
  if (route.defaultStepId !== undefined) sourceId(route.defaultStepId, `${location}.defaultStepId`);
}

function validateGate(value: unknown, location: string): void {
  if (value === undefined) return;
  const gate = record(value, location);
  keys(gate, ["maxLoops", "rubric"], location);
  if (
    gate.maxLoops !== undefined &&
    (!Number.isSafeInteger(gate.maxLoops) ||
      (gate.maxLoops as number) < 1 ||
      (gate.maxLoops as number) > WORKFLOW_MAX_GATE_LOOPS)
  ) {
    fail(`${location}.maxLoops must be an integer from 1 through ${WORKFLOW_MAX_GATE_LOOPS}`);
  }
  optionalString(gate.rubric, `${location}.rubric`);
}

function validateRouteTargets(steps: WorkflowSourceStep[], jobId: string): void {
  const indexById = new Map(steps.map((step, index) => [step.id, index]));
  for (const [index, step] of steps.entries()) {
    if (!step.route) continue;
    const targets = [...step.route.branches.map(({ stepId }) => stepId)];
    if (step.route.defaultStepId !== undefined) targets.push(step.route.defaultStepId);
    for (const target of targets) {
      const targetIndex = indexById.get(target);
      if (targetIndex === undefined) fail(`job ${jobId} route ${step.id} targets missing step ${target}`);
      if (targetIndex <= index) fail(`job ${jobId} route ${step.id} must target a later step`);
    }
  }
}

function validateReference(value: string, location: string): void {
  const parsed = parseReference(value);
  if (!parsed.ok) fail(`${location} is invalid: ${parsed.message}`);
}

function validateParams(value: unknown): void {
  if (value === undefined) return;
  const params = record(value, "params");
  if (Object.keys(params).length === 0 || Object.keys(params).length > WORKFLOW_MAX_PARAMS) {
    fail(`params must contain 1 through ${WORKFLOW_MAX_PARAMS} entries`);
  }
  for (const [name, schema] of Object.entries(params)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail(`params has invalid name ${name}`);
    validateSchema(schema, `params.${name}`, false);
  }
}

function validateBudget(value: unknown): void {
  if (value === undefined) return;
  const budget = record(value, "budget");
  keys(budget, ["maxTokens", "maxUnits"], "budget");
  for (const key of ["maxTokens", "maxUnits"] as const) {
    if (budget[key] !== undefined && (!Number.isSafeInteger(budget[key]) || (budget[key] as number) < 1)) {
      fail(`budget.${key} must be a positive integer`);
    }
  }
  if (typeof budget.maxUnits === "number" && budget.maxUnits > WORKFLOW_MAX_MAP_EXPANSION) {
    fail(`budget.maxUnits must be at most ${WORKFLOW_MAX_MAP_EXPANSION}`);
  }
}

function validateLlm(value: unknown, location: string): void {
  if (value === undefined) return;
  const llm = record(value, location);
  keys(
    llm,
    ["temperature", "maxTokens", "supportsJsonSchema", "extraParams", "contextLength", "enableThinking"],
    location,
  );
  if (llm.temperature !== undefined && typeof llm.temperature !== "number") {
    fail(`${location}.temperature must be a finite number`);
  }
  for (const key of ["maxTokens", "contextLength"] as const) {
    if (llm[key] !== undefined && (!Number.isSafeInteger(llm[key]) || (llm[key] as number) < 1)) {
      fail(`${location}.${key} must be a positive integer`);
    }
  }
  for (const key of ["supportsJsonSchema", "enableThinking"] as const) {
    if (llm[key] !== undefined && typeof llm[key] !== "boolean") fail(`${location}.${key} must be a boolean`);
  }
  if (llm.extraParams !== undefined) {
    const extra = record(llm.extraParams, `${location}.extraParams`);
    const issues = validateExtraParams(extra);
    if (issues.length > 0) fail(`${location}.extraParams is invalid: ${issues[0]?.message ?? "invalid value"}`);
    if (jsonBytes(extra) > WORKFLOW_MAX_EXTRA_PARAMS_BYTES) {
      fail(`${location}.extraParams exceeds ${WORKFLOW_MAX_EXTRA_PARAMS_BYTES} bytes`);
    }
  }
}

function validateSchema(value: unknown, location: string, optional = true): void {
  if (value === undefined && optional) return;
  const schema = record(value, location);
  if (jsonBytes(schema) > WORKFLOW_MAX_SCHEMA_BYTES) fail(`${location} exceeds ${WORKFLOW_MAX_SCHEMA_BYTES} bytes`);
  const issue = checkJsonSchemaDefinition(schema)[0];
  if (issue) fail(`${location} is invalid: ${issue.message}`);
}

function validateAssetRef(value: string, location: string): void {
  try {
    const parsed = parseBundleRef(value);
    if (parsed.fragment !== undefined || bundleRefToString(parsed) !== value) fail(`${location} is not canonical`);
  } catch (cause) {
    fail(`${location} is invalid: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function optionalStringList(value: unknown, location: string, max: number): void {
  if (value === undefined) return;
  stringList(value, location, max, true);
}

function rejectExpressionsInRecord(value: unknown, location: string): void {
  if (value === undefined) return;
  for (const [key, item] of Object.entries(record(value, location))) {
    if (typeof item === "string" && item.includes("${{")) fail(`${location}.${key} contains an unsupported expression`);
  }
}

function rejectStepWithExpressions(step: Record<string, unknown>, id: string, markdownSource: boolean): void {
  if (step.with === undefined) return;
  for (const [key, item] of Object.entries(record(step.with, `step ${id} with`))) {
    if (typeof item !== "string" || !item.includes("${{")) continue;
    if (markdownSource && step.uses === "akm/command" && key === "content") continue;
    fail(`step ${id} with.${key} contains an unsupported expression`);
  }
}

function semanticFail(cause: unknown, location: string): never {
  if (cause instanceof WorkflowSourceSemanticError) fail(`${location}: ${cause.message}`);
  fail(`${location}: ${cause instanceof Error ? cause.message : String(cause)}`);
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
