// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Durable-v4 symbolic workflow environments.
 *
 * Env-file values are the deliberately narrow live-value exception to a
 * frozen workflow plan. Freeze persists only the qualified owner, physical
 * containment, exact key set, and secret-token topology. Materialization
 * later reads current values directly through that descriptor, without
 * consulting config, the index, or authored workflow source.
 */

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { assetPathForName } from "../../core/asset/asset-placement";
import { isWithin } from "../../core/common";
import { NotFoundError, UsageError } from "../../core/errors";
import { captureGuardedExecutionSource, GuardedExecutionSourceCollector } from "../../execution/guarded-source";
import type { FrozenWorkflowEnvironmentBinding, FrozenWorkflowEnvironmentOwner } from "./schema-v4";

const SECRET_TOKEN_RE = /\$\{secret:([A-Za-z0-9_./-]+)\}/g;
const ENVIRONMENT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const QUALIFIED_ENV_REF_RE = /^([^/]+)\/\/env\/(.+)$/;

export interface WorkflowEnvironmentRefResolution {
  readonly ref: string;
  readonly bundle: string;
  readonly adapter: string;
  readonly root: string;
  readonly path: string;
}

export interface FreezeWorkflowEnvironmentOptions {
  readonly resolveRef: (ref: string) => WorkflowEnvironmentRefResolution;
  readonly collector?: GuardedExecutionSourceCollector;
}

export interface MaterializeFrozenWorkflowEnvironmentOptions {
  readonly readEnvFile?: (descriptor: FrozenWorkflowEnvironmentBinding) => string | Uint8Array;
  readonly readSecret?: (input: {
    readonly name: string;
    readonly descriptor: FrozenWorkflowEnvironmentBinding;
  }) => string | Uint8Array | undefined;
  readonly readPassThrough?: (name: string) => string | undefined;
}

export interface FrozenWorkflowEnvironmentAudit {
  readonly eventType: "env_access";
  readonly ref: string;
  readonly keys: readonly string[];
  readonly secretNames: readonly string[];
}

export interface MaterializedFrozenWorkflowEnvironment {
  readonly values: Record<string, string>;
  readonly sensitiveValues: string[];
  readonly audits: FrozenWorkflowEnvironmentAudit[];
}

/** Freeze value-free descriptors in authored ref order. */
export function freezeWorkflowEnvironment(
  refs: readonly string[],
  options: FreezeWorkflowEnvironmentOptions,
): FrozenWorkflowEnvironmentBinding[] {
  const collector = options.collector ?? new GuardedExecutionSourceCollector();
  const logical = new Set<string>();
  const physical = new Map<string, string>();
  const out: FrozenWorkflowEnvironmentBinding[] = [];

  for (const [precedence, inputRef] of refs.entries()) {
    const resolved = options.resolveRef(inputRef);
    const match = QUALIFIED_ENV_REF_RE.exec(resolved.ref);
    if (!match || match[1] !== resolved.bundle) {
      throw new UsageError(
        `Workflow env ref ${JSON.stringify(inputRef)} did not resolve to a canonical fully-qualified owner.`,
        "INVALID_FLAG_VALUE",
      );
    }
    if (logical.has(resolved.ref)) {
      throw new UsageError(`Workflow environment contains duplicate ref ${resolved.ref}.`, "INVALID_FLAG_VALUE");
    }
    logical.add(resolved.ref);

    trackParentDirectories(collector, resolved.root, resolved.path);
    const retained = collector.capture(resolved.path, resolved.root, { authored: true });
    const captured = collector.bindIdentity(resolved.path, resolved.root, {
      ref: resolved.ref,
      bundle: resolved.bundle,
      adapter: resolved.adapter,
      file: retained.relativePath,
      hash: retained.sha256,
    });
    const physicalKey = `${captured.containmentPhysicalIdentity}\0${captured.physicalIdentity}`;
    const alias = physical.get(physicalKey);
    if (alias !== undefined && alias !== resolved.ref) {
      throw new UsageError(
        `${resolved.ref} aliases the same physical environment source as ${alias} under a different logical owner.`,
        "RESOURCE_ALREADY_EXISTS",
      );
    }
    physical.set(physicalKey, resolved.ref);

    const parsed = dotenv.parse(Buffer.from(captured.bytesBase64, "base64"));
    const keys = sortedCodePoints(Object.keys(parsed));
    const secretNames = secretTokenNames(parsed);
    out.push(
      Object.freeze({
        kind: "env-ref" as const,
        ref: resolved.ref,
        owner: Object.freeze({
          bundle: resolved.bundle,
          adapter: resolved.adapter,
          requestedRoot: captured.containmentRoot,
          realRoot: captured.containmentRealPath,
          rootPhysicalIdentity: captured.containmentPhysicalIdentity,
          requestedPath: captured.sourcePath,
          realPath: captured.realPath,
          relativePath: captured.relativePath,
        }),
        keys: Object.freeze(keys),
        secretNames: Object.freeze(secretNames),
        precedence,
      }),
    );
  }
  return out;
}

/**
 * Materialize all current values atomically from frozen descriptors. Nothing
 * is returned until every owner/key/token check and every secret lookup has
 * succeeded.
 */
export function materializeFrozenWorkflowEnvironment(
  descriptors: readonly FrozenWorkflowEnvironmentBinding[],
  options: MaterializeFrozenWorkflowEnvironmentOptions = {},
): MaterializedFrozenWorkflowEnvironment {
  const values: Record<string, string> = {};
  const sensitive = new Set<string>();
  const audits: FrozenWorkflowEnvironmentAudit[] = [];
  const seenRefs = new Set<string>();
  let priorPrecedence = -1;

  for (const descriptor of descriptors) {
    if (!descriptor || typeof descriptor !== "object") invalid("environment descriptor must be an object");
    if (descriptor.kind === "literal") {
      exactKeys(descriptor, ["kind", "name", "value"]);
      environmentName(descriptor.name);
      if (typeof descriptor.value !== "string") invalid("literal environment value must be a string");
      values[descriptor.name] = descriptor.value;
      if (descriptor.value) sensitive.add(descriptor.value);
      continue;
    }
    if (descriptor.kind === "pass-through") {
      exactKeys(descriptor, ["kind", "name"]);
      environmentName(descriptor.name);
      const value = options.readPassThrough ? options.readPassThrough(descriptor.name) : process.env[descriptor.name];
      if (value !== undefined) {
        values[descriptor.name] = value;
        if (value) sensitive.add(value);
      }
      continue;
    }
    if (descriptor.kind !== "env-ref") invalid("environment descriptor has an unsupported kind");
    exactKeys(descriptor, ["kind", "ref", "owner", "keys", "secretNames", "precedence"]);
    validateEnvRefDescriptor(descriptor);
    if (seenRefs.has(descriptor.ref)) invalid(`duplicate environment ref ${descriptor.ref}`);
    if (descriptor.precedence <= priorPrecedence) invalid("env-ref precedence must be strictly increasing");
    seenRefs.add(descriptor.ref);
    priorPrecedence = descriptor.precedence;

    const source = options.readEnvFile ? options.readEnvFile(descriptor) : readFrozenEnvironmentFile(descriptor.owner);
    const parsed = dotenv.parse(typeof source === "string" ? source : Buffer.from(source));
    const keys = sortedCodePoints(Object.keys(parsed));
    const tokenNames = secretTokenNames(parsed);
    if (!sameStrings(keys, descriptor.keys)) {
      invalid(`environment ${descriptor.ref} key set changed after it was frozen`);
    }
    if (!sameStrings(tokenNames, descriptor.secretNames)) {
      invalid(`environment ${descriptor.ref} secret-token topology changed after it was frozen`);
    }

    const secretValues = new Map<string, string>();
    for (const name of descriptor.secretNames) {
      const raw = options.readSecret
        ? options.readSecret({ name, descriptor })
        : readFrozenSecret(descriptor.owner, name);
      if (raw === undefined) {
        throw new NotFoundError(
          `Environment ${descriptor.ref} references missing secret ${name}; nothing was materialized.`,
          "FILE_NOT_FOUND",
        );
      }
      const value = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
      secretValues.set(name, value);
      if (value) sensitive.add(value);
    }
    for (const [key, rawValue] of Object.entries(parsed)) {
      const resolved = rawValue.replace(SECRET_TOKEN_RE, (_token, name: string) => {
        const secret = secretValues.get(name);
        if (secret === undefined) invalid(`environment ${descriptor.ref} secret ${name} was not materialized`);
        return secret;
      });
      values[key] = resolved;
      if (resolved) sensitive.add(resolved);
    }
    audits.push(
      Object.freeze({
        eventType: "env_access" as const,
        ref: descriptor.ref,
        keys: Object.freeze([...descriptor.keys]),
        secretNames: Object.freeze([...descriptor.secretNames]),
      }),
    );
  }

  return {
    values,
    sensitiveValues: [...sensitive],
    audits,
  };
}

function validateEnvRefDescriptor(descriptor: Extract<FrozenWorkflowEnvironmentBinding, { kind: "env-ref" }>): void {
  const match = QUALIFIED_ENV_REF_RE.exec(descriptor.ref);
  if (!match || match[1] !== descriptor.owner.bundle) invalid("env-ref has a noncanonical qualified owner");
  exactKeys(descriptor.owner, [
    "bundle",
    "adapter",
    "requestedRoot",
    "realRoot",
    "rootPhysicalIdentity",
    "requestedPath",
    "realPath",
    "relativePath",
  ]);
  for (const value of [descriptor.owner.bundle, descriptor.owner.adapter, descriptor.owner.rootPhysicalIdentity]) {
    if (typeof value !== "string" || !value) invalid("env-ref owner identity is incomplete");
  }
  for (const value of [
    descriptor.owner.requestedRoot,
    descriptor.owner.realRoot,
    descriptor.owner.requestedPath,
    descriptor.owner.realPath,
  ]) {
    if (typeof value !== "string" || !path.isAbsolute(value)) invalid("env-ref owner paths must be absolute");
  }
  const relative = descriptor.owner.relativePath;
  if (
    typeof relative !== "string" ||
    !relative ||
    relative.includes("\\") ||
    relative.startsWith("../") ||
    path.isAbsolute(relative)
  ) {
    invalid("env-ref owner relative path is noncanonical");
  }
  if (path.resolve(descriptor.owner.requestedRoot, relative) !== path.resolve(descriptor.owner.requestedPath)) {
    invalid("env-ref requested path does not match its owner");
  }
  if (path.resolve(descriptor.owner.realRoot, relative) !== path.resolve(descriptor.owner.realPath)) {
    invalid("env-ref real path does not match its owner");
  }
  sortedUnique(descriptor.keys, "env-ref keys", ENVIRONMENT_NAME_RE);
  sortedUnique(descriptor.secretNames, "env-ref secret names", /^[A-Za-z0-9_./-]+$/);
  if (!Number.isSafeInteger(descriptor.precedence) || descriptor.precedence < 0) {
    invalid("env-ref precedence is invalid");
  }
}

function readFrozenEnvironmentFile(owner: FrozenWorkflowEnvironmentOwner): Uint8Array {
  const rootLstat = fs.lstatSync(owner.requestedRoot, { bigint: true });
  if (rootLstat.isSymbolicLink() || !rootLstat.isDirectory())
    invalid("environment owner root physical identity changed");
  const currentRealRoot = fs.realpathSync(owner.requestedRoot);
  if (
    currentRealRoot !== owner.realRoot ||
    physicalIdentity(currentRealRoot, rootLstat) !== owner.rootPhysicalIdentity
  ) {
    invalid("environment owner root physical identity changed");
  }
  const captured = captureGuardedExecutionSource(owner.requestedPath, owner.requestedRoot, { authored: true });
  if (
    captured.realPath !== owner.realPath ||
    captured.relativePath !== owner.relativePath ||
    captured.containmentRealPath !== owner.realRoot ||
    captured.containmentPhysicalIdentity !== owner.rootPhysicalIdentity
  ) {
    invalid("environment owner/path physical identity changed");
  }
  return Buffer.from(captured.bytesBase64, "base64");
}

function readFrozenSecret(owner: FrozenWorkflowEnvironmentOwner, name: string): Uint8Array | undefined {
  const secretsRoot = path.join(owner.requestedRoot, "secrets");
  const secretPath = assetPathForName("secret", secretsRoot, name);
  if (!isWithin(secretPath, secretsRoot)) invalid(`secret name ${name} escapes its frozen owner`);
  let descriptor: number | undefined;
  try {
    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    descriptor = fs.openSync(secretPath, fs.constants.O_RDONLY | noFollow);
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) invalid(`secret ${name} is not a regular file`);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs
    ) {
      invalid(`secret ${name} changed while it was read`);
    }
    return bytes;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function trackParentDirectories(
  collector: GuardedExecutionSourceCollector,
  rootInput: string,
  fileInput: string,
): void {
  const root = path.resolve(rootInput);
  const parent = path.dirname(path.resolve(fileInput));
  const relative = path.relative(root, parent);
  if (relative.startsWith("..") || path.isAbsolute(relative)) invalid("environment source escapes its owner root");
  let current = root;
  collector.trackDirectory(current, root);
  if (relative === "") return;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    collector.trackDirectory(current, root);
  }
}

function secretTokenNames(values: Readonly<Record<string, string>>): string[] {
  const names = new Set<string>();
  for (const value of Object.values(values)) {
    for (const match of value.matchAll(SECRET_TOKEN_RE)) {
      const name = match[1];
      if (name) names.add(name);
    }
  }
  return sortedCodePoints([...names]);
}

function sortedCodePoints(values: string[]): string[] {
  return values.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function sortedUnique(values: readonly string[], label: string, pattern: RegExp): void {
  if (!Array.isArray(values)) invalid(`${label} must be an array`);
  let prior: string | undefined;
  for (const value of values) {
    if (typeof value !== "string" || !pattern.test(value) || value.includes("..")) invalid(`${label} is invalid`);
    if (prior !== undefined && prior >= value) invalid(`${label} must be sorted and unique`);
    prior = value;
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function exactKeys(value: object, keys: readonly string[]): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) invalid(`environment descriptor contains unknown key ${key}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) invalid(`environment descriptor is missing ${key}`);
}

function environmentName(value: string): void {
  if (typeof value !== "string" || !ENVIRONMENT_NAME_RE.test(value)) invalid("environment name is invalid");
}

function physicalIdentity(realPath: string, stat: fs.BigIntStats): string {
  return stat.ino === 0n ? `path:${realPath}` : `inode:${stat.dev}:${stat.ino}`;
}

function invalid(message: string): never {
  throw new UsageError(`Invalid frozen workflow environment: ${message}.`, "INVALID_FLAG_VALUE");
}
