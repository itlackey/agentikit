// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Additive durable workflow plan v4.
 *
 * V3 remains a closed compatibility island in `schema.ts`. This module
 * validates the v4-only execution snapshots, then delegates a key-stripped
 * shadow graph to the byte-stable v3 decoder for all shared graph semantics.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { UsageError } from "../../core/errors";
import {
  canonicalResolvedExecutionRequest,
  decodeResolvedExecutionRequest,
  type ResolvedExecutionRequestV1,
} from "../../execution/resolved-request";
import { decodeExecutionSourceIdentity, type ExecutionSourceIdentity } from "../../execution/source";
import { decodeFrozenRunnerSpec } from "../../integrations/agent/execution-lowering";
import type { RunnerSpec } from "../../integrations/agent/runner";
import {
  decodeWorkflowPlanV3,
  type IrMapNode,
  type IrStepPlan,
  type IrUnitNode,
  WORKFLOW_IR_VERSION,
  type WorkflowPlanGraph,
  type WorkflowPlanValidationHooks,
} from "./schema";

export const WORKFLOW_IR_V4_VERSION = 4 as const;

export interface DurableWorkflowSourceSnapshot {
  readonly identity: Readonly<ExecutionSourceIdentity>;
  readonly containmentPhysicalIdentity: string;
  readonly physicalIdentity: string;
  readonly size: number;
}

export interface FrozenWorkflowDirectoryIdentity {
  readonly requestedRoot: string;
  readonly realRoot: string;
  readonly rootDevice: string;
  readonly rootInode: string;
  readonly requestedCwd: string;
  readonly realCwd: string;
  readonly cwdDevice: string;
  readonly cwdInode: string;
}

export interface FrozenWorkflowEnvironmentOwner {
  readonly bundle: string;
  readonly adapter: string;
  readonly requestedRoot: string;
  readonly realRoot: string;
  readonly rootPhysicalIdentity: string;
  readonly requestedPath: string;
  readonly realPath: string;
  readonly relativePath: string;
}

export type FrozenWorkflowEnvironmentBinding =
  | { readonly kind: "literal"; readonly name: string; readonly value: string }
  | { readonly kind: "pass-through"; readonly name: string }
  | {
      readonly kind: "env-ref";
      readonly ref: string;
      readonly owner: FrozenWorkflowEnvironmentOwner;
      readonly keys: readonly string[];
      readonly secretNames: readonly string[];
      readonly precedence: number;
    };

export interface FrozenWorkflowCommandTarget {
  readonly kind: "command";
  readonly ref: string | null;
  readonly contentHash: string;
  readonly request: ResolvedExecutionRequestV1;
  readonly runner: RunnerSpec;
}

export interface FrozenWorkflowShellTarget {
  readonly kind: "shell";
  readonly contentHash: string;
  readonly cwdIdentity: FrozenWorkflowDirectoryIdentity;
}

export interface FrozenWorkflowScriptTarget {
  readonly kind: "script";
  readonly ref: string;
  readonly contentHash: string;
  readonly interpreter: string;
  readonly extension: string;
  readonly bytesBase64: string;
  readonly byteLength: number;
  readonly cwdIdentity: FrozenWorkflowDirectoryIdentity;
  readonly materialization: "ephemeral-0700-delete";
}

export type FrozenWorkflowTarget = FrozenWorkflowCommandTarget | FrozenWorkflowShellTarget | FrozenWorkflowScriptTarget;

export interface IrUnitNodeV4 extends IrUnitNode {
  readonly frozenTarget: FrozenWorkflowTarget;
  readonly environment: readonly FrozenWorkflowEnvironmentBinding[];
}

export interface IrMapNodeV4 extends Omit<IrMapNode, "template"> {
  readonly template: IrUnitNodeV4;
}

export type IrExecNodeV4 = IrUnitNodeV4 | IrMapNodeV4;

export interface IrStepPlanV4 extends Omit<IrStepPlan, "root"> {
  root?: IrExecNodeV4;
}

export interface WorkflowPlanGraphV4 extends Omit<WorkflowPlanGraph, "irVersion" | "steps"> {
  readonly irVersion: typeof WORKFLOW_IR_V4_VERSION;
  readonly sourceReadSet: DurableWorkflowSourceSnapshot[];
  readonly steps: IrStepPlanV4[];
}

export type ExecutableWorkflowPlan = WorkflowPlanGraph | WorkflowPlanGraphV4;

/** Strictly decode either supported executable plan, optionally bound to a DB row version. */
export function decodeExecutableWorkflowPlan(
  input: unknown,
  expectedVersion?: number | null,
  hooks: WorkflowPlanValidationHooks = {},
): ExecutableWorkflowPlan {
  const version = record(input, "plan").irVersion;
  if (expectedVersion !== undefined && expectedVersion !== null && version !== expectedVersion) {
    fail(`plan irVersion ${String(version)} does not match expected stored version ${expectedVersion}`);
  }
  if (version === WORKFLOW_IR_VERSION) return decodeWorkflowPlanV3(input, hooks);
  if (version === WORKFLOW_IR_V4_VERSION) return decodeWorkflowPlanV4(input, hooks);
  fail(`unsupported workflow plan version ${String(version)}`);
}

/** Strict v4 corruption gate. No authored source or config is consulted here. */
export function decodeWorkflowPlanV4(input: unknown, hooks: WorkflowPlanValidationHooks = {}): WorkflowPlanGraphV4 {
  const raw = record(input, "plan");
  if (raw.irVersion !== WORKFLOW_IR_V4_VERSION) fail("irVersion must be 4");
  assertKeys(
    raw,
    ["irVersion", "title", "params", "paramSchemas", "budget", "execution", "steps", "sourceReadSet"],
    "plan",
  );
  if (!Object.hasOwn(raw, "sourceReadSet")) fail("sourceReadSet is required");
  const sourceReadSet = decodeSourceReadSet(raw.sourceReadSet);
  rejectV4InheritEnv(raw.steps);
  const shadow = sharedV3Shadow(raw);
  const shared = decodeWorkflowPlanV3(shadow, hooks);
  const rawSteps = raw.steps as unknown[];
  const requiredSources: ExecutionSourceIdentity[] = [];
  const steps = shared.steps.map((step, index) => {
    const sourceStep = record(rawSteps[index], `step ${step.stepId}`);
    if (!step.root) return step as IrStepPlanV4;
    const rawRoot = record(sourceStep.root, `step ${step.stepId} root`);
    const root =
      step.root.kind === "map"
        ? ({
            ...step.root,
            template: decodeUnitV4(
              record(rawRoot.template, `map ${step.root.id} template`),
              step.root.template,
              requiredSources,
            ),
          } satisfies IrMapNodeV4)
        : decodeUnitV4(rawRoot, step.root, requiredSources);
    return { ...step, root } satisfies IrStepPlanV4;
  });
  assertRequiredSources(sourceReadSet, requiredSources);
  return Object.freeze({
    ...shared,
    irVersion: WORKFLOW_IR_V4_VERSION,
    sourceReadSet,
    steps,
  });
}

function decodeUnitV4(
  raw: Record<string, unknown>,
  shared: IrUnitNode,
  requiredSources: ExecutionSourceIdentity[],
): IrUnitNodeV4 {
  if (!Object.hasOwn(raw, "frozenTarget")) fail(`unit ${shared.id} frozenTarget is required`);
  if (!Object.hasOwn(raw, "environment")) fail(`unit ${shared.id} environment is required`);
  const environment = decodeEnvironment(raw.environment, shared.id);
  const frozenTarget = decodeFrozenTarget(raw.frozenTarget, shared, environment, requiredSources);
  return Object.freeze({ ...shared, frozenTarget, environment: Object.freeze(environment) });
}

function decodeFrozenTarget(
  value: unknown,
  unit: IrUnitNode,
  environment: readonly FrozenWorkflowEnvironmentBinding[],
  requiredSources: ExecutionSourceIdentity[],
): FrozenWorkflowTarget {
  const target = record(value, `unit ${unit.id} frozenTarget`);
  if (target.kind === "command") return decodeCommandTarget(target, unit, requiredSources);
  if (target.kind === "shell") return decodeShellTarget(target, unit, environment);
  if (target.kind === "script") return decodeScriptTarget(target, unit, requiredSources);
  fail(`unit ${unit.id} frozenTarget has unsupported kind ${String(target.kind)}`);
}

function decodeCommandTarget(
  target: Record<string, unknown>,
  unit: IrUnitNode,
  requiredSources: ExecutionSourceIdentity[],
): FrozenWorkflowCommandTarget {
  assertKeys(target, ["kind", "ref", "contentHash", "request", "runner"], `unit ${unit.id} command target`);
  if (!unit.invocation || unit.exec) fail(`unit ${unit.id} command target requires an invocation arm`);
  if (target.ref !== null && typeof target.ref !== "string") fail(`unit ${unit.id} command target ref is invalid`);
  const request = decodeResolvedExecutionRequest(target.request);
  if (request.authorization.status === "denied") fail(`unit ${unit.id} command authorization is denied by policy`);
  if (Object.hasOwn(request.runtime, "environment")) {
    fail(`unit ${unit.id} resolved request runtime.environment is live and cannot be persisted`);
  }
  const contentHash = digest(target.contentHash, `unit ${unit.id} command contentHash`);
  const actualContentHash = sha256(request.command.content);
  if (contentHash !== actualContentHash) fail(`unit ${unit.id} command contentHash does not match request content`);
  const runner = decodeFrozenRunnerSpec(target.runner);
  if (runner.engine !== request.engine.name || runner.kind !== request.engine.kind) {
    fail(`unit ${unit.id} frozen runner must match the resolved request engine`);
  }
  if (unit.invocation.engine !== request.engine.name) {
    fail(`unit ${unit.id} invocation engine must match the resolved request engine`);
  }
  const source = request.command.source;
  if (source) {
    requiredSources.push(source);
    if (target.ref !== source.ref) fail(`unit ${unit.id} command target ref must match request source`);
  } else if (target.ref !== null) {
    fail(`unit ${unit.id} inline command target ref must be null`);
  }
  if (request.persona) requiredSources.push(request.persona.source);
  // Force the shared request canonicalizer across every accepted wire request.
  canonicalResolvedExecutionRequest(request);
  return Object.freeze({ kind: "command", ref: target.ref as string | null, contentHash, request, runner });
}

function decodeShellTarget(
  target: Record<string, unknown>,
  unit: IrUnitNode,
  environment: readonly FrozenWorkflowEnvironmentBinding[],
): FrozenWorkflowShellTarget {
  assertKeys(target, ["kind", "contentHash", "cwdIdentity"], `unit ${unit.id} shell target`);
  if (!unit.exec || unit.invocation) fail(`unit ${unit.id} shell target requires an exec arm`);
  if (unit.exec.inheritEnv) fail(`unit ${unit.id} inheritEnv is forbidden; use named environment bindings`);
  const cwdIdentity = decodeDirectoryIdentity(target.cwdIdentity, unit.id);
  const contentHash = digest(target.contentHash, `unit ${unit.id} shell contentHash`);
  const expected = createHash("sha256")
    .update("akm.workflow.shell.v1\0")
    .update(canonicalJsonLocal({ exec: unit.exec, environment, cwdIdentity }))
    .digest("hex");
  if (contentHash !== expected) fail(`unit ${unit.id} shell contentHash does not match its frozen dispatch`);
  return Object.freeze({ kind: "shell", contentHash, cwdIdentity });
}

function decodeScriptTarget(
  target: Record<string, unknown>,
  unit: IrUnitNode,
  requiredSources: ExecutionSourceIdentity[],
): FrozenWorkflowScriptTarget {
  assertKeys(
    target,
    [
      "kind",
      "ref",
      "contentHash",
      "interpreter",
      "extension",
      "bytesBase64",
      "byteLength",
      "cwdIdentity",
      "materialization",
    ],
    `unit ${unit.id} script target`,
  );
  if (!unit.exec || unit.invocation) fail(`unit ${unit.id} script target requires an exec arm`);
  if (unit.exec.inheritEnv) fail(`unit ${unit.id} inheritEnv is forbidden; use named environment bindings`);
  if (typeof target.ref !== "string" || !target.ref.includes("//")) fail(`unit ${unit.id} script ref is invalid`);
  if (typeof target.interpreter !== "string" || !target.interpreter)
    fail(`unit ${unit.id} script interpreter is invalid`);
  if (typeof target.extension !== "string" || !/^\.[A-Za-z0-9]+$/.test(target.extension)) {
    fail(`unit ${unit.id} script extension is invalid`);
  }
  if (typeof target.bytesBase64 !== "string") fail(`unit ${unit.id} script bytesBase64 is invalid`);
  const bytes = Buffer.from(target.bytesBase64, "base64");
  if (bytes.toString("base64") !== target.bytesBase64) fail(`unit ${unit.id} script bytesBase64 is noncanonical`);
  if (!Number.isSafeInteger(target.byteLength) || target.byteLength !== bytes.byteLength) {
    fail(`unit ${unit.id} script byteLength does not match frozen bytes`);
  }
  const contentHash = digest(target.contentHash, `unit ${unit.id} script contentHash`);
  if (contentHash !== sha256(bytes)) fail(`unit ${unit.id} script contentHash does not match frozen bytes`);
  if (target.materialization !== "ephemeral-0700-delete") fail(`unit ${unit.id} script materialization is invalid`);
  const cwdIdentity = decodeDirectoryIdentity(target.cwdIdentity, unit.id);
  requiredSources.push({ ref: target.ref, bundle: "", adapter: "", file: "", hash: contentHash });
  return Object.freeze({
    kind: "script",
    ref: target.ref,
    contentHash,
    interpreter: target.interpreter,
    extension: target.extension,
    bytesBase64: target.bytesBase64,
    byteLength: target.byteLength as number,
    cwdIdentity,
    materialization: "ephemeral-0700-delete",
  });
}

function decodeDirectoryIdentity(value: unknown, unitId: string): FrozenWorkflowDirectoryIdentity {
  const identity = record(value, `unit ${unitId} cwdIdentity`);
  const fields = [
    "requestedRoot",
    "realRoot",
    "rootDevice",
    "rootInode",
    "requestedCwd",
    "realCwd",
    "cwdDevice",
    "cwdInode",
  ] as const;
  assertKeys(identity, fields, `unit ${unitId} cwdIdentity`);
  for (const field of fields) {
    if (typeof identity[field] !== "string" || !identity[field]) fail(`unit ${unitId} cwdIdentity.${field} is invalid`);
  }
  for (const field of ["requestedRoot", "realRoot", "requestedCwd", "realCwd"] as const) {
    if (!path.isAbsolute(identity[field] as string)) fail(`unit ${unitId} cwdIdentity.${field} must be absolute`);
  }
  return Object.freeze(identity as unknown as FrozenWorkflowDirectoryIdentity);
}

function decodeEnvironment(value: unknown, unitId: string): FrozenWorkflowEnvironmentBinding[] {
  if (!Array.isArray(value)) fail(`unit ${unitId} environment must be an array`);
  const out: FrozenWorkflowEnvironmentBinding[] = [];
  const names = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const binding = record(raw, `unit ${unitId} environment[${index}]`);
    if (binding.kind === "literal") {
      assertKeys(binding, ["kind", "name", "value"], `unit ${unitId} environment[${index}]`);
      environmentName(binding.name, unitId, index);
      if (typeof binding.value !== "string") fail(`unit ${unitId} literal environment value must be a string`);
      if (literalLooksSecret(binding.name as string, binding.value)) {
        fail(`unit ${unitId} literal environment value is secret-shaped`);
      }
      out.push(Object.freeze({ kind: "literal", name: binding.name as string, value: binding.value }));
    } else if (binding.kind === "pass-through") {
      assertKeys(binding, ["kind", "name"], `unit ${unitId} environment[${index}]`);
      environmentName(binding.name, unitId, index);
      out.push(Object.freeze({ kind: "pass-through", name: binding.name as string }));
    } else if (binding.kind === "env-ref") {
      assertKeys(
        binding,
        ["kind", "ref", "owner", "keys", "secretNames", "precedence"],
        `unit ${unitId} environment[${index}]`,
      );
      if (typeof binding.ref !== "string" || !binding.ref.includes("//")) {
        fail(`unit ${unitId} environment[${index}] env-ref must be fully qualified`);
      }
      const owner = decodeEnvironmentOwner(binding.owner, binding.ref, unitId, index);
      const keys = sortedUniqueStrings(binding.keys, `unit ${unitId} environment[${index}] keys`, (value) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(value),
      );
      const secretNames = sortedUniqueStrings(
        binding.secretNames,
        `unit ${unitId} environment[${index}] secretNames`,
        (value) => /^[A-Za-z0-9_./-]+$/.test(value) && !value.includes(".."),
      );
      if (!Number.isSafeInteger(binding.precedence) || (binding.precedence as number) < 0) {
        fail(`unit ${unitId} environment[${index}] precedence is invalid`);
      }
      out.push(
        Object.freeze({
          kind: "env-ref",
          ref: binding.ref,
          owner,
          keys: Object.freeze(keys),
          secretNames: Object.freeze(secretNames),
          precedence: binding.precedence as number,
        }),
      );
    } else {
      fail(`unit ${unitId} environment[${index}] has unsupported kind`);
    }
    if (binding.kind !== "env-ref") {
      const name = binding.name as string;
      if (names.has(name)) fail(`unit ${unitId} environment contains duplicate name ${name}`);
      names.add(name);
    }
  }
  return out;
}

function decodeEnvironmentOwner(
  value: unknown,
  ref: string,
  unitId: string,
  index: number,
): FrozenWorkflowEnvironmentOwner {
  const label = `unit ${unitId} environment[${index}] owner`;
  const owner = record(value, label);
  const fields = [
    "bundle",
    "adapter",
    "requestedRoot",
    "realRoot",
    "rootPhysicalIdentity",
    "requestedPath",
    "realPath",
    "relativePath",
  ] as const;
  assertKeys(owner, fields, label);
  for (const field of fields) {
    if (typeof owner[field] !== "string" || !owner[field]) fail(`${label}.${field} is invalid`);
  }
  if (!ref.startsWith(`${owner.bundle as string}//`)) fail(`${label}.bundle does not own env-ref ${ref}`);
  for (const field of ["requestedRoot", "realRoot", "requestedPath", "realPath"] as const) {
    if (!path.isAbsolute(owner[field] as string)) fail(`${label}.${field} must be absolute`);
  }
  const relativePath = owner.relativePath as string;
  if (
    relativePath.includes("\\") ||
    relativePath === "." ||
    relativePath.startsWith("../") ||
    path.isAbsolute(relativePath)
  ) {
    fail(`${label}.relativePath is not canonical`);
  }
  if (path.resolve(owner.requestedRoot as string, relativePath) !== path.resolve(owner.requestedPath as string)) {
    fail(`${label}.requestedPath does not match relativePath`);
  }
  if (path.resolve(owner.realRoot as string, relativePath) !== path.resolve(owner.realPath as string)) {
    fail(`${label}.realPath does not match relativePath`);
  }
  return Object.freeze(owner as unknown as FrozenWorkflowEnvironmentOwner);
}

function sortedUniqueStrings(value: unknown, label: string, accepts: (value: string) => boolean): string[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const out: string[] = [];
  let prior: string | undefined;
  for (const item of value) {
    if (typeof item !== "string" || !accepts(item)) fail(`${label} contains an invalid value`);
    if (prior !== undefined && compareCodePoints(prior, item) >= 0) fail(`${label} must be sorted and unique`);
    prior = item;
    out.push(item);
  }
  return out;
}

function decodeSourceReadSet(value: unknown): DurableWorkflowSourceSnapshot[] {
  if (!Array.isArray(value) || value.length === 0) fail("sourceReadSet must contain at least one source identity");
  const out: DurableWorkflowSourceSnapshot[] = [];
  const logical = new Set<string>();
  const physical = new Map<string, string>();
  let priorKey: string | undefined;
  for (const [index, raw] of value.entries()) {
    const snapshot = record(raw, `sourceReadSet[${index}]`);
    assertKeys(
      snapshot,
      ["identity", "containmentPhysicalIdentity", "physicalIdentity", "size"],
      `sourceReadSet[${index}]`,
    );
    const identity = decodeExecutionSourceIdentity(snapshot.identity, `sourceReadSet[${index}].identity`);
    const key = sourceKey(identity);
    if (logical.has(key)) fail(`sourceReadSet contains duplicate identity key ${key}`);
    if (typeof snapshot.containmentPhysicalIdentity !== "string" || !snapshot.containmentPhysicalIdentity) {
      fail(`sourceReadSet[${index}] containment physical identity is invalid`);
    }
    if (typeof snapshot.physicalIdentity !== "string" || !snapshot.physicalIdentity) {
      fail(`sourceReadSet[${index}] physical identity is invalid`);
    }
    if (!Number.isSafeInteger(snapshot.size) || (snapshot.size as number) < 0)
      fail(`sourceReadSet[${index}] size is invalid`);
    const physicalKey = `${snapshot.containmentPhysicalIdentity}\0${snapshot.physicalIdentity}`;
    const alias = physical.get(physicalKey);
    if (alias !== undefined && alias !== key) fail(`sourceReadSet logical refs alias the same physical file identity`);
    physical.set(physicalKey, key);
    if (priorKey !== undefined && compareCodePoints(priorKey, key) >= 0) {
      fail("sourceReadSet is not in canonical ref, adapter, file sort order");
    }
    logical.add(key);
    priorKey = key;
    out.push(
      Object.freeze({
        identity,
        containmentPhysicalIdentity: snapshot.containmentPhysicalIdentity,
        physicalIdentity: snapshot.physicalIdentity,
        size: snapshot.size as number,
      }),
    );
  }
  return out;
}

function rejectV4InheritEnv(value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const rawStep of value) {
    const step = record(rawStep, "step");
    if (!step.root) continue;
    const root = record(step.root, "step root");
    const unit = root.kind === "map" ? record(root.template, "map template") : root;
    if (!unit.exec) continue;
    const exec = record(unit.exec, "unit exec");
    if (exec.inheritEnv === true) fail("inheritEnv is forbidden in v4; use exact named environment bindings");
  }
}

function assertRequiredSources(
  readSet: readonly DurableWorkflowSourceSnapshot[],
  required: readonly ExecutionSourceIdentity[],
): void {
  for (const identity of required) {
    const found = readSet.find((snapshot) => snapshot.identity.ref === identity.ref);
    if (!found) fail(`source read-set is missing required command/persona/script source ${identity.ref}`);
    if (identity.bundle && sourceKey(found.identity) !== sourceKey(identity)) {
      fail(`source read-set identity mismatch for ${identity.ref}`);
    }
    if (found.identity.hash !== identity.hash) fail(`source read-set hash mismatch for ${identity.ref}`);
  }
}

function sharedV3Shadow(raw: Record<string, unknown>): Record<string, unknown> {
  const shadow = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  shadow.irVersion = WORKFLOW_IR_VERSION;
  delete shadow.sourceReadSet;
  for (const stepValue of shadow.steps as unknown[]) {
    const step = record(stepValue, "step");
    if (!step.root) continue;
    const root = record(step.root, "step root");
    const unit = root.kind === "map" ? record(root.template, "map template") : root;
    delete unit.frozenTarget;
    delete unit.environment;
  }
  return shadow;
}

function sourceKey(identity: Pick<ExecutionSourceIdentity, "ref" | "adapter" | "file">): string {
  return `${identity.ref}\0${identity.adapter}\0${identity.file}`;
}

function environmentName(value: unknown, unitId: string, index: number): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    fail(`unit ${unitId} environment[${index}] has an invalid name`);
  }
}

function literalLooksSecret(name: string, value: string): boolean {
  const key = name.toLowerCase();
  if (
    /(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|bearer|client_secret)/.test(
      key,
    )
  ) {
    return true;
  }
  const candidate = value.trim();
  if (candidate.length < 20 || /\s/.test(candidate)) return false;
  if (
    /^(?:sk-|rk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[baprs]-|AKIA|ASIA|AIza|ya29\.|-----BEGIN)/.test(candidate)
  ) {
    return true;
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(candidate)).length;
  return (candidate.length >= 24 && classes >= 3) || (candidate.length >= 32 && /^[A-Za-z0-9+/=_-]+$/.test(candidate));
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) fail(`${label} must be a SHA-256 digest`);
  return value;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJsonLocal(value: unknown): string {
  const sort = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(sort);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .sort(([left], [right]) => compareCodePoints(left, right))
          .map(([key, nested]) => [key, sort(nested)]),
      );
    }
    return entry;
  };
  return JSON.stringify(sort(value));
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label} contains unknown key ${key}`);
}

function fail(message: string): never {
  throw new UsageError(`Invalid frozen workflow plan v4: ${message}.`, "INVALID_JSON_ARGUMENT");
}
