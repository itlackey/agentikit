// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Additive durable workflow plan v4.
 *
 * This is the sole executable workflow plan. Older stored plans are rejected
 * at the run-storage boundary instead of being replayed through a second
 * runtime architecture.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { UsageError } from "../../core/errors";
import { decodeFrozenExecutableIdentity, type FrozenExecutableIdentity } from "../../execution/executable-identity";
import {
  canonicalResolvedExecutionRequest,
  decodeResolvedExecutionRequest,
  type ResolvedExecutionRequestV1,
} from "../../execution/resolved-request";
import { decodeExecutionSourceIdentity, type ExecutionSourceIdentity } from "../../execution/source";
import { decodeFrozenRunnerSpec } from "../../integrations/agent/execution-lowering";
import type { RunnerSpec } from "../../integrations/agent/runner";
import {
  decodeWorkflowExecSpec,
  type IrMapNode,
  type IrRouteSpec,
  type IrUnitNodeCore,
  validateWorkflowPlanStructure,
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
  /** Frozen provider concurrency cap for this resolved target, when applicable. */
  readonly concurrency?: number;
  readonly cwdIdentity?: FrozenWorkflowDirectoryIdentity;
  readonly executable?: FrozenExecutableIdentity;
  readonly gitCommitOid?: string;
}

export interface FrozenWorkflowShellTarget {
  readonly kind: "shell";
  readonly contentHash: string;
  readonly exec: import("./schema").IrExecSpec;
  readonly cwdIdentity: FrozenWorkflowDirectoryIdentity;
  readonly executable?: FrozenExecutableIdentity;
  readonly gitCommitOid?: string;
}

export interface FrozenWorkflowScriptTarget {
  readonly kind: "script";
  readonly ref: string;
  readonly contentHash: string;
  readonly exec: import("./schema").IrExecSpec;
  readonly interpreter: string;
  readonly extension: string;
  readonly bytesBase64: string;
  readonly byteLength: number;
  readonly cwdIdentity: FrozenWorkflowDirectoryIdentity;
  readonly materialization: "ephemeral-0700-delete";
  readonly executable?: FrozenExecutableIdentity;
  readonly gitCommitOid?: string;
}

export type FrozenWorkflowTarget = FrozenWorkflowCommandTarget | FrozenWorkflowShellTarget | FrozenWorkflowScriptTarget;

export interface IrUnitNodeV4 extends IrUnitNodeCore {
  readonly frozenTarget: FrozenWorkflowTarget;
  readonly environment: readonly FrozenWorkflowEnvironmentBinding[];
}

export interface IrMapNodeV4 extends Omit<IrMapNode, "template"> {
  readonly template: IrUnitNodeV4;
}

export type IrExecNodeV4 = IrUnitNodeV4 | IrMapNodeV4;

export interface IrGateNodeV4 {
  readonly kind: "gate";
  readonly id: string;
  readonly stepId: string;
  readonly criteria: string[];
  readonly maxLoops?: number;
  readonly frozenJudge: FrozenWorkflowCommandTarget | null;
}

export interface IrStepPlanV4 {
  readonly stepId: string;
  readonly title: string;
  readonly sequenceIndex: number;
  root?: IrExecNodeV4;
  readonly route?: IrRouteSpec;
  readonly outputSchema?: Record<string, unknown>;
  readonly gate: IrGateNodeV4;
}

export interface WorkflowPlanGraphV4 {
  readonly irVersion: typeof WORKFLOW_IR_V4_VERSION;
  readonly title: string;
  readonly params?: string[];
  readonly paramSchemas?: Record<string, Record<string, unknown>>;
  readonly budget?: import("./schema").IrBudget;
  readonly execution: { readonly maxConcurrency: number };
  readonly sourceReadSet: DurableWorkflowSourceSnapshot[];
  readonly steps: IrStepPlanV4[];
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
  validateWorkflowPlanStructure(
    raw,
    {
      expectedVersion: WORKFLOW_IR_V4_VERSION,
      planExtraKeys: ["sourceReadSet"],
      unitExtraKeys: ["frozenTarget", "environment"],
      gateExtraKeys: ["frozenJudge"],
    },
    hooks,
  );
  const rawSteps = raw.steps as unknown[];
  const requiredSources: ExecutionSourceIdentity[] = [];
  const steps = rawSteps.map((rawStep, index) => {
    const step = rawStep as Omit<IrStepPlanV4, "root" | "gate"> & { root?: unknown; gate: unknown };
    const sourceStep = record(rawSteps[index], `step ${step.stepId}`);
    const gate = decodeGateV4(sourceStep.gate, step.stepId, requiredSources);
    if (!step.root) return Object.freeze({ ...step, gate }) as IrStepPlanV4;
    const rawRoot = record(sourceStep.root, `step ${step.stepId} root`);
    const root =
      rawRoot.kind === "map"
        ? (() => {
            const { template: _template, ...map } = rawRoot;
            return {
              ...(map as unknown as Omit<IrMapNodeV4, "template">),
              template: decodeUnitV4(record(rawRoot.template, `map ${String(rawRoot.id)} template`), requiredSources),
            } satisfies IrMapNodeV4;
          })()
        : decodeUnitV4(rawRoot, requiredSources);
    return Object.freeze({ ...step, root, gate }) satisfies IrStepPlanV4;
  });
  assertRequiredSources(sourceReadSet, requiredSources);
  return Object.freeze({
    ...(raw as unknown as Omit<WorkflowPlanGraphV4, "steps" | "sourceReadSet">),
    irVersion: WORKFLOW_IR_V4_VERSION,
    sourceReadSet,
    steps,
  });
}

function decodeUnitV4(raw: Record<string, unknown>, requiredSources: ExecutionSourceIdentity[]): IrUnitNodeV4 {
  const id = raw.id as string;
  if (!Object.hasOwn(raw, "frozenTarget")) fail(`unit ${id} frozenTarget is required`);
  if (!Object.hasOwn(raw, "environment")) fail(`unit ${id} environment is required`);
  const environment = decodeEnvironment(raw.environment, id);
  const frozenTarget = decodeFrozenTarget(
    raw.frozenTarget,
    raw as unknown as IrUnitNodeCore,
    environment,
    requiredSources,
  );
  const { frozenTarget: _target, environment: _environment, ...core } = raw;
  return Object.freeze({
    ...(core as unknown as IrUnitNodeCore),
    frozenTarget,
    environment: Object.freeze(environment),
  });
}

function decodeGateV4(value: unknown, stepId: string, requiredSources: ExecutionSourceIdentity[]): IrGateNodeV4 {
  const gate = record(value, `gate ${stepId}`);
  const criteria = gate.criteria as string[];
  if (criteria.length === 0) {
    if (gate.frozenJudge !== null) fail(`gate ${stepId} without criteria cannot have a frozen judge target`);
    return Object.freeze({
      kind: "gate",
      id: gate.id as string,
      stepId,
      criteria,
      maxLoops: gate.maxLoops as number,
      frozenJudge: null,
    });
  }
  if (!Object.hasOwn(gate, "frozenJudge") || gate.frozenJudge === null) {
    fail(`gate ${stepId} with criteria requires a frozen judge target`);
  }
  const identity: IrUnitNodeCore = {
    kind: "unit",
    id: gate.id as string,
    instructions: criteria.join("\n"),
    onError: "fail",
    isolation: "none",
  };
  return Object.freeze({
    kind: "gate",
    id: gate.id as string,
    stepId,
    criteria,
    maxLoops: gate.maxLoops as number,
    frozenJudge: decodeCommandTarget(record(gate.frozenJudge, `gate ${stepId} frozenJudge`), identity, requiredSources),
  });
}

function decodeFrozenTarget(
  value: unknown,
  unit: IrUnitNodeCore,
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
  unit: IrUnitNodeCore,
  requiredSources: ExecutionSourceIdentity[],
): FrozenWorkflowCommandTarget {
  assertKeys(
    target,
    ["kind", "ref", "contentHash", "request", "runner", "concurrency", "cwdIdentity", "executable", "gitCommitOid"],
    `unit ${unit.id} command target`,
  );
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
  if (
    target.concurrency !== undefined &&
    (!Number.isSafeInteger(target.concurrency) ||
      (target.concurrency as number) < 1 ||
      (target.concurrency as number) > 64)
  ) {
    fail(`unit ${unit.id} frozen target concurrency is invalid`);
  }
  if (runner.engine !== request.engine.name || runner.kind !== request.engine.kind) {
    fail(`unit ${unit.id} frozen runner must match the resolved request engine`);
  }
  const source = request.command.source;
  if (source) {
    requiredSources.push(source);
    if (target.ref !== source.ref) fail(`unit ${unit.id} command target ref must match request source`);
  } else if (target.ref !== null) {
    fail(`unit ${unit.id} inline command target ref must be null`);
  }
  if (request.persona) requiredSources.push(request.persona.source);
  const cwdIdentity = Object.hasOwn(target, "cwdIdentity")
    ? decodeDirectoryIdentity(target.cwdIdentity, unit.id)
    : undefined;
  const executable = Object.hasOwn(target, "executable")
    ? decodeFrozenExecutableIdentity(target.executable, `unit ${unit.id} executable`)
    : undefined;
  if (runner.kind === "agent" && (cwdIdentity !== undefined || executable !== undefined)) {
    if (!cwdIdentity || !executable) fail(`unit ${unit.id} CLI command target requires cwdIdentity and executable`);
    if (runner.profile.bin !== executable.requested && runner.profile.bin !== executable.absolutePath) {
      fail(`unit ${unit.id} executable does not match the frozen runner bin`);
    }
  } else if (runner.kind !== "agent" && executable !== undefined) {
    fail(`unit ${unit.id} non-CLI target cannot carry a host executable`);
  }
  const gitCommitOid = decodeGitCommitOid(target.gitCommitOid, unit);
  // Force the shared request canonicalizer across every accepted wire request.
  canonicalResolvedExecutionRequest(request);
  return Object.freeze({
    kind: "command",
    ref: target.ref as string | null,
    contentHash,
    request,
    runner,
    ...(target.concurrency !== undefined ? { concurrency: target.concurrency as number } : {}),
    ...(cwdIdentity ? { cwdIdentity } : {}),
    ...(executable ? { executable } : {}),
    ...(gitCommitOid ? { gitCommitOid } : {}),
  });
}

function decodeShellTarget(
  target: Record<string, unknown>,
  unit: IrUnitNodeCore,
  environment: readonly FrozenWorkflowEnvironmentBinding[],
): FrozenWorkflowShellTarget {
  assertKeys(
    target,
    ["kind", "contentHash", "exec", "cwdIdentity", "executable", "gitCommitOid"],
    `unit ${unit.id} shell target`,
  );
  const exec = decodeWorkflowExecSpec(target.exec, `unit ${unit.id} shell target exec`);
  const cwdIdentity = decodeDirectoryIdentity(target.cwdIdentity, unit.id);
  const executable = Object.hasOwn(target, "executable")
    ? decodeFrozenExecutableIdentity(target.executable, `unit ${unit.id} executable`)
    : undefined;
  if (executable && exec.command[0] !== executable.requested && exec.command[0] !== executable.absolutePath) {
    fail(`unit ${unit.id} shell executable does not match the frozen command`);
  }
  const gitCommitOid = decodeGitCommitOid(target.gitCommitOid, unit);
  const contentHash = digest(target.contentHash, `unit ${unit.id} shell contentHash`);
  const expected = createHash("sha256")
    .update("akm.workflow.shell.v1\0")
    .update(canonicalJsonLocal({ exec, environment, cwdIdentity }))
    .digest("hex");
  if (contentHash !== expected) fail(`unit ${unit.id} shell contentHash does not match its frozen dispatch`);
  return Object.freeze({
    kind: "shell",
    contentHash,
    exec,
    cwdIdentity,
    ...(executable ? { executable } : {}),
    ...(gitCommitOid ? { gitCommitOid } : {}),
  });
}

function decodeScriptTarget(
  target: Record<string, unknown>,
  unit: IrUnitNodeCore,
  requiredSources: ExecutionSourceIdentity[],
): FrozenWorkflowScriptTarget {
  assertKeys(
    target,
    [
      "kind",
      "ref",
      "contentHash",
      "exec",
      "interpreter",
      "extension",
      "bytesBase64",
      "byteLength",
      "cwdIdentity",
      "materialization",
      "executable",
      "gitCommitOid",
    ],
    `unit ${unit.id} script target`,
  );
  const exec = decodeWorkflowExecSpec(target.exec, `unit ${unit.id} script target exec`);
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
  const executable = Object.hasOwn(target, "executable")
    ? decodeFrozenExecutableIdentity(target.executable, `unit ${unit.id} executable`)
    : undefined;
  const gitCommitOid = decodeGitCommitOid(target.gitCommitOid, unit);
  requiredSources.push({ ref: target.ref, bundle: "", adapter: "", file: "", hash: contentHash });
  return Object.freeze({
    kind: "script",
    ref: target.ref,
    contentHash,
    exec,
    interpreter: target.interpreter,
    extension: target.extension,
    bytesBase64: target.bytesBase64,
    byteLength: target.byteLength as number,
    cwdIdentity,
    materialization: "ephemeral-0700-delete",
    ...(executable ? { executable } : {}),
    ...(gitCommitOid ? { gitCommitOid } : {}),
  });
}

function decodeGitCommitOid(value: unknown, unit: IrUnitNodeCore): string | undefined {
  if (unit.isolation === "worktree") {
    if (typeof value !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
      fail(`unit ${unit.id} worktree target requires a canonical gitCommitOid`);
    }
    return value;
  }
  if (value !== undefined) fail(`unit ${unit.id} gitCommitOid is only valid for worktree isolation`);
  return undefined;
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
