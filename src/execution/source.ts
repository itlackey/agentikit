// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { bundleRefToString, isBundleSlug, parseBundleRef } from "../core/asset/asset-ref";
import {
  cloneExecutionJson,
  cloneExecutionJsonObject,
  type ExecutionJsonObject,
  type ExecutionJsonValue,
} from "./json";
import { assertSnapshotKeys, type StrictRecordSnapshot, snapshotStrictRecord } from "./record";

export const EXECUTION_SOURCE_SCHEMA_VERSION = 1 as const;

/** Current internal adapter identifiers are lowercase kebab-case registry keys. */
export const EXECUTION_ADAPTER_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const CONTROL_OR_LINE_SEPARATOR_PATTERN = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const FORMAT_CHARACTER_PATTERN = /\p{Cf}/u;
const WINDOWS_DRIVE_PREFIX_PATTERN = /^[A-Za-z]:/;
const RESERVED_EXTENSION_OWNERS = new Set(["__proto__", "constructor", "prototype", "tostring"]);

/** Exact identity of the authoritative native file from which content was rendered. */
export interface ExecutionSourceIdentity {
  /** Fully-qualified `bundle//conceptId`; short input sugar is never frozen. */
  readonly ref: string;
  readonly bundle: string;
  readonly adapter: string;
  /** POSIX path relative to the owning bundle/component root. */
  readonly file: string;
  /** SHA-256 of the authoritative native file bytes decoded as UTF-8. */
  readonly hash: string;
}

/**
 * Extensions are keyed by their owning adapter, not merged into common fields.
 * Construction rejects duplicate/reserved owners and returns a frozen
 * null-prototype owner map so object-prototype names cannot collide.
 */
export type AdapterOwnedExtensions = Readonly<Record<string, ExecutionJsonObject>>;

/** Portable selected-tool spellings; policy objects may contain nested JSON values. */
export type ToolSelection = string | readonly string[] | ExecutionJsonObject | null;

/** Ordinary defaults contributed by one command or persona source layer. */
export interface UnresolvedExecutionDefaults {
  readonly agent?: string | null;
  readonly engine?: string | null;
  readonly model?: string | null;
  readonly inference?: ExecutionJsonObject | null;
  readonly outputSchema?: ExecutionJsonObject | null;
  readonly tools?: ToolSelection;
  /** Native duration spelling or already-normalized milliseconds. */
  readonly timeout?: string | number | null;
  readonly workspace?: string | null;
  readonly environment?: Readonly<Record<string, string>> | null;
  readonly runtime?: ExecutionJsonObject | null;
}

const renderedSourceBrand: unique symbol = Symbol("akm.adapter-rendered-execution-source");
const renderedSourceInstances = new WeakSet<object>();

interface AdapterRenderedExecutionSourceBase {
  readonly schemaVersion: typeof EXECUTION_SOURCE_SCHEMA_VERSION;
  readonly content: string;
  readonly defaults: Readonly<UnresolvedExecutionDefaults>;
  readonly identity: Readonly<ExecutionSourceIdentity>;
  readonly extensions?: AdapterOwnedExtensions;
  /** Construction brand: native sources can only enter through an adapter renderer. */
  readonly [renderedSourceBrand]: true;
}

export interface AdapterRenderedCommandSource extends AdapterRenderedExecutionSourceBase {
  readonly kind: "command";
}

export interface AdapterRenderedPersonaSource extends AdapterRenderedExecutionSourceBase {
  readonly kind: "persona";
}

export type AdapterRenderedExecutionSource = AdapterRenderedCommandSource | AdapterRenderedPersonaSource;

function requireRecord(value: unknown, path: string): StrictRecordSnapshot {
  return snapshotStrictRecord(value, path);
}

function assertOnlyKeys(value: StrictRecordSnapshot, allowed: readonly string[], path: string): void {
  assertSnapshotKeys(value, allowed, path);
}

function validateExtensionOwner(owner: string): void {
  const normalized = owner.toLowerCase();
  if (!EXECUTION_ADAPTER_ID_PATTERN.test(owner) || RESERVED_EXTENSION_OWNERS.has(normalized)) {
    throw new TypeError(`extension owner must be a canonical, non-reserved adapter identifier: ${owner}`);
  }
}

function frozenNullPrototypeMap<T>(entries: readonly (readonly [string, T])[]): Readonly<Record<string, T>> {
  const out = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) {
    Object.defineProperty(out, key, { value, enumerable: true, configurable: false, writable: false });
  }
  return Object.freeze(out);
}

type ExtensionEntry = readonly [owner: string, values: ExecutionJsonObject];

function cloneExtensionEntry(value: unknown, index: number): ExtensionEntry {
  const path = `extension entry ${index}`;
  const cloned = cloneExecutionJson(value, path);
  if (!Array.isArray(cloned) || cloned.length !== 2) {
    throw new TypeError(`${path} must be a two-element [owner, values] array`);
  }
  const [owner, values] = cloned;
  if (typeof owner !== "string") throw new TypeError(`${path} owner must be a string`);
  if (values === null || Array.isArray(values) || typeof values !== "object") {
    throw new TypeError(`${path} values must be a JSON object`);
  }
  return [owner, values];
}

export function createAdapterExtensions(owner: string, values: ExecutionJsonObject): AdapterOwnedExtensions;
export function createAdapterExtensions(
  first: ExtensionEntry,
  ...rest: readonly ExtensionEntry[]
): AdapterOwnedExtensions;
export function createAdapterExtensions(
  first: string | ExtensionEntry,
  second?: ExecutionJsonObject | ExtensionEntry,
  ...rest: readonly ExtensionEntry[]
): AdapterOwnedExtensions {
  const rawEntries: readonly unknown[] =
    typeof first === "string"
      ? [[first, second as ExecutionJsonObject]]
      : [first, ...(second === undefined ? [] : [second as ExtensionEntry]), ...rest];
  const seen = new Set<string>();
  const cloned: Array<readonly [string, ExecutionJsonObject]> = [];
  for (const [index, rawEntry] of rawEntries.entries()) {
    const [owner, values] = cloneExtensionEntry(rawEntry, index);
    validateExtensionOwner(owner);
    if (seen.has(owner)) throw new TypeError(`duplicate extension owner: ${owner}`);
    seen.add(owner);
    cloned.push([owner, cloneExecutionJsonObject(values, `extensions.${owner}`)]);
  }
  return frozenNullPrototypeMap(cloned);
}

export function cloneAdapterExtensions(value: unknown, path: string): AdapterOwnedExtensions {
  const record = requireRecord(value, path);
  const entries = Object.entries(record).map(
    ([owner, fields]) => [owner, cloneExecutionJsonObject(fields, `${path}.${owner}`)] as const,
  );
  const [first, ...rest] = entries;
  return first ? createAdapterExtensions(first, ...rest) : frozenNullPrototypeMap([]);
}

function requireCanonicalString(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !isWellFormedUnicode(value) ||
    value.normalize("NFC") !== value
  ) {
    throw new TypeError(`${path} must be a non-empty NFC string`);
  }
  if (hasUnsafeIdentityCharacter(value)) {
    throw new TypeError(`${path} must not contain Unicode control or dangerous format characters`);
  }
  return value;
}

/**
 * Validate a selector/layer identifier that may cross the durable execution
 * boundary. Keep this shared with the cascade planner so resume cannot admit a
 * selector the live planner would reject.
 */
export function requireStableExecutionSelector(value: unknown, path: string): string {
  let selector: string;
  try {
    selector = requireCanonicalString(value, path);
  } catch (cause) {
    throw new TypeError(`${path} must be a non-empty stable NFC identifier`, { cause });
  }
  if (selector.length > 512 || selector.trim() !== selector) {
    throw new TypeError(`${path} must be a non-empty stable NFC identifier`);
  }
  return selector;
}

export function isPortableExecutionAgentSelector(value: string): boolean {
  return /^(?:[^/]+\/\/)?agents\/[^/]/.test(value);
}

export function executionPersonaMatchesSelector(selector: string, personaRef: string): boolean {
  return selector.includes("//") ? selector === personaRef : personaRef.endsWith(`//${selector}`);
}

function hasUnsafeIdentityCharacter(value: string): boolean {
  for (const character of value) {
    if (CONTROL_OR_LINE_SEPARATOR_PATTERN.test(character)) return true;
    // Join controls are meaningful in emoji and several writing systems. All
    // other format controls are rejected because they can conceal identity.
    if (FORMAT_CHARACTER_PATTERN.test(character) && character !== "\u200C" && character !== "\u200D") return true;
  }
  return false;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function validateCanonicalIdentity(input: StrictRecordSnapshot, path: string): ExecutionSourceIdentity {
  assertOnlyKeys(input, ["ref", "bundle", "adapter", "file", "hash"], path);
  const ref = requireCanonicalString(input.ref, `${path}.ref`);
  const bundle = requireCanonicalString(input.bundle, `${path}.bundle`);
  const adapter = requireCanonicalString(input.adapter, `${path}.adapter`);
  const file = requireCanonicalString(input.file, `${path}.file`);
  const hash = requireCanonicalString(input.hash, `${path}.hash`);

  let parsed: ReturnType<typeof parseBundleRef>;
  try {
    parsed = parseBundleRef(ref);
  } catch (cause) {
    throw new TypeError(`${path}.ref is not a canonical bundle ref`, { cause });
  }
  if (
    parsed.bundle === undefined ||
    parsed.bundle !== bundle ||
    parsed.fragment !== undefined ||
    !isBundleSlug(bundle) ||
    bundleRefToString(parsed) !== ref
  ) {
    throw new TypeError(`${path}.ref must round-trip as the same fully-qualified bundle ref without a fragment`);
  }
  if (!EXECUTION_ADAPTER_ID_PATTERN.test(adapter)) {
    throw new TypeError(`${path}.adapter must use the current lowercase kebab-case adapter identifier grammar`);
  }
  const segments = file.split("/");
  if (
    file.startsWith("/") ||
    WINDOWS_DRIVE_PREFIX_PATTERN.test(file) ||
    file.includes("\\") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new TypeError(`${path}.file must be a normalized relative POSIX path`);
  }
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new TypeError(`${path}.hash must be a SHA-256 hex digest`);

  return { ref, bundle, adapter, file, hash };
}

/** Validate, clone, and freeze an identity produced by an adapter renderer. */
export function createExecutionSourceIdentity(input: ExecutionSourceIdentity): Readonly<ExecutionSourceIdentity> {
  return Object.freeze(
    validateCanonicalIdentity(requireRecord(input, "execution source identity"), "execution source identity"),
  );
}

/** Validate and freeze a source identity read back from a frozen request. */
export function decodeExecutionSourceIdentity(
  value: unknown,
  path = "execution source identity",
): Readonly<ExecutionSourceIdentity> {
  return Object.freeze(validateCanonicalIdentity(requireRecord(value, path), path));
}

export function cloneUnresolvedExecutionDefaults(
  input: UnresolvedExecutionDefaults,
  path = "execution source defaults",
): Readonly<UnresolvedExecutionDefaults> {
  const record = requireRecord(input, path);
  assertOnlyKeys(
    record,
    [
      "agent",
      "engine",
      "model",
      "inference",
      "outputSchema",
      "tools",
      "timeout",
      "workspace",
      "environment",
      "runtime",
    ],
    path,
  );
  const json = { ...cloneExecutionJsonObject(record, path) } as Record<string, ExecutionJsonValue>;
  for (const key of ["agent", "engine", "model", "workspace"] as const) {
    const value = json[key];
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw new TypeError(`${path}.${key} must be a string or null`);
    }
  }
  const timeout = json.timeout;
  if (timeout !== undefined && timeout !== null && typeof timeout !== "string" && typeof timeout !== "number") {
    throw new TypeError(`${path}.timeout must be a string, number, or null`);
  }
  for (const key of ["inference", "outputSchema", "runtime"] as const) {
    const value = json[key];
    if (value !== undefined && value !== null && (Array.isArray(value) || typeof value !== "object")) {
      throw new TypeError(`${path}.${key} must be an object or null`);
    }
  }
  const environment = json.environment;
  if (environment !== undefined && environment !== null) {
    if (Array.isArray(environment) || typeof environment !== "object") {
      throw new TypeError(`${path}.environment must be an object or null`);
    }
    if (Object.values(environment).some((value) => typeof value !== "string")) {
      throw new TypeError(`${path}.environment values must be strings`);
    }
  }
  if (Object.hasOwn(json, "tools")) json.tools = cloneToolSelection(json.tools, `${path}.tools`);
  return Object.freeze(json as unknown as UnresolvedExecutionDefaults);
}

export function cloneToolSelection(value: unknown, path = "tools"): ToolSelection {
  if (value === null || typeof value === "string") return value;
  const cloned = cloneExecutionJson(value, path);
  if (Array.isArray(cloned)) {
    if (cloned.some((tool) => typeof tool !== "string")) throw new TypeError(`${path} array values must be strings`);
    return cloned as readonly string[];
  }
  return cloneExecutionJsonObject(cloned, path);
}

export interface CreateAdapterRenderedExecutionSourceInput {
  readonly kind: "command" | "persona";
  /** Body-only content after the owning adapter has removed native metadata. */
  readonly content: string;
  readonly identity: ExecutionSourceIdentity;
  readonly defaults?: UnresolvedExecutionDefaults;
  readonly extensions?: AdapterOwnedExtensions;
}

/** Brand a fully adapter-rendered, body-only source after strict validation. */
export function createAdapterRenderedExecutionSource(
  input: CreateAdapterRenderedExecutionSourceInput & { readonly kind: "command" },
): AdapterRenderedCommandSource;
export function createAdapterRenderedExecutionSource(
  input: CreateAdapterRenderedExecutionSourceInput & { readonly kind: "persona" },
): AdapterRenderedPersonaSource;
export function createAdapterRenderedExecutionSource(
  input: CreateAdapterRenderedExecutionSourceInput,
): AdapterRenderedExecutionSource;
export function createAdapterRenderedExecutionSource(
  input: CreateAdapterRenderedExecutionSourceInput,
): AdapterRenderedExecutionSource {
  const record = requireRecord(input, "adapter-rendered execution source");
  assertOnlyKeys(
    record,
    ["kind", "content", "identity", "defaults", "extensions"],
    "adapter-rendered execution source",
  );
  const kind = record.kind;
  const content = record.content;
  if (kind !== "command" && kind !== "persona") throw new TypeError("execution source kind is invalid");
  if (typeof content !== "string") throw new TypeError("execution source content must be a string");
  const defaults = Object.hasOwn(record, "defaults") ? record.defaults : {};
  if (defaults === undefined) {
    throw new TypeError("execution source defaults must be omitted or be an object");
  }
  const source: Record<PropertyKey, unknown> = {
    schemaVersion: EXECUTION_SOURCE_SCHEMA_VERSION,
    kind,
    content,
    defaults: cloneUnresolvedExecutionDefaults(defaults as UnresolvedExecutionDefaults),
    identity: createExecutionSourceIdentity(record.identity as ExecutionSourceIdentity),
  };
  if (Object.hasOwn(record, "extensions")) {
    source.extensions = cloneAdapterExtensions(record.extensions, "execution source extensions");
  }
  Object.defineProperty(source, renderedSourceBrand, { value: true, enumerable: false });
  const frozen = Object.freeze(source) as unknown as AdapterRenderedExecutionSource;
  renderedSourceInstances.add(frozen);
  return frozen;
}

function isAdapterRenderedSource(value: unknown, kind: "command" | "persona"): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (!renderedSourceInstances.has(value)) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype || !Object.isFrozen(value)) return false;
  if (!Object.hasOwn(value, renderedSourceBrand)) return false;
  const required = new Set(["schemaVersion", "kind", "content", "defaults", "identity"]);
  const optional = new Set(["extensions"]);
  for (const key of Reflect.ownKeys(value)) {
    if (key === renderedSourceBrand) continue;
    if (typeof key !== "string" || (!required.delete(key) && !optional.has(key))) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
  }
  if (required.size > 0) return false;
  const brand = Object.getOwnPropertyDescriptor(value, renderedSourceBrand);
  const source = value as Record<string, unknown>;
  if (
    brand?.value !== true ||
    brand.enumerable !== false ||
    brand.configurable !== false ||
    brand.writable !== false ||
    source.schemaVersion !== EXECUTION_SOURCE_SCHEMA_VERSION ||
    source.kind !== kind ||
    typeof source.content !== "string" ||
    typeof source.defaults !== "object" ||
    source.defaults === null ||
    !Object.isFrozen(source.defaults) ||
    typeof source.identity !== "object" ||
    source.identity === null ||
    Object.getPrototypeOf(source.identity) !== Object.prototype ||
    !Object.isFrozen(source.identity)
  ) {
    return false;
  }
  if (Object.hasOwn(source, "extensions")) {
    if (
      typeof source.extensions !== "object" ||
      source.extensions === null ||
      Object.getPrototypeOf(source.extensions) !== null ||
      !Object.isFrozen(source.extensions)
    ) {
      return false;
    }
  }
  try {
    decodeExecutionSourceIdentity(source.identity);
  } catch {
    return false;
  }
  return true;
}

export function isAdapterRenderedCommandSource(value: unknown): value is AdapterRenderedCommandSource {
  return isAdapterRenderedSource(value, "command");
}

export function isAdapterRenderedPersonaSource(value: unknown): value is AdapterRenderedPersonaSource {
  return isAdapterRenderedSource(value, "persona");
}
