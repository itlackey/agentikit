// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import { parseFrontmatter } from "../core/asset/frontmatter";
import {
  cloneExecutionJson,
  cloneExecutionJsonObject,
  type ExecutionJsonObject,
  type ExecutionJsonValue,
} from "./json";

export const EXECUTION_SOURCE_SCHEMA_VERSION = 1 as const;

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
 * Construction rejects duplicate owners so one adapter cannot shadow another.
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

type ExtensionEntry = readonly [owner: string, values: ExecutionJsonObject];

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
  const entries: readonly ExtensionEntry[] =
    typeof first === "string"
      ? [[first, second as ExecutionJsonObject]]
      : [first, ...(second === undefined ? [] : [second as ExtensionEntry]), ...rest];
  const seen = new Set<string>();
  const cloned: Array<[string, ExecutionJsonObject]> = [];
  for (const [owner, values] of entries) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(owner)) {
      throw new TypeError("extension owner must be a canonical adapter identifier");
    }
    if (seen.has(owner)) throw new TypeError(`duplicate extension owner: ${owner}`);
    seen.add(owner);
    cloned.push([owner, cloneExecutionJsonObject(values, `extensions.${owner}`)]);
  }
  return Object.freeze(Object.fromEntries(cloned));
}

function cloneExtensions(value: AdapterOwnedExtensions, path: string): AdapterOwnedExtensions {
  const entries = Object.entries(value).map(
    ([owner, values]) => [owner, cloneExecutionJsonObject(values, `${path}.${owner}`)] as const,
  );
  const [first, ...rest] = entries;
  return first ? createAdapterExtensions(first, ...rest) : Object.freeze({});
}

function assertCanonicalIdentity(input: Omit<ExecutionSourceIdentity, "hash">): void {
  if (!input.bundle || input.bundle.trim() !== input.bundle) {
    throw new TypeError("execution source bundle must be a non-empty canonical string");
  }
  if (!input.adapter || input.adapter.trim() !== input.adapter) {
    throw new TypeError("execution source adapter must be a non-empty canonical string");
  }
  if (!input.ref.startsWith(`${input.bundle}//`) || input.ref.length <= input.bundle.length + 2) {
    throw new TypeError(`execution source ref must be fully qualified by bundle "${input.bundle}"`);
  }
  if (input.ref.includes("#")) throw new TypeError("execution source ref must not contain a fragment");
  const segments = input.file.split("/");
  if (
    !input.file ||
    input.file.startsWith("/") ||
    input.file.includes("\\") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new TypeError("execution source file must be a normalized relative POSIX path");
  }
}

/** Validate and freeze a source identity read back from a frozen request. */
export function decodeExecutionSourceIdentity(
  value: unknown,
  path = "execution source identity",
): Readonly<ExecutionSourceIdentity> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(["ref", "bundle", "adapter", "file", "hash"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new TypeError(`${path} contains unsupported field: ${key}`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(input, key) || typeof input[key] !== "string") {
      throw new TypeError(`${path}.${key} must be a string`);
    }
  }
  const identity = input as unknown as ExecutionSourceIdentity;
  assertCanonicalIdentity(identity);
  if (!/^[a-f0-9]{64}$/.test(identity.hash)) throw new TypeError(`${path}.hash must be a SHA-256 hex digest`);
  return Object.freeze({
    ref: identity.ref,
    bundle: identity.bundle,
    adapter: identity.adapter,
    file: identity.file,
    hash: identity.hash,
  });
}

function cloneDefaults(input: UnresolvedExecutionDefaults): Readonly<UnresolvedExecutionDefaults> {
  const allowed = new Set([
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
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new TypeError(`execution source defaults contain unsupported field: ${key}`);
  }
  const json = {
    ...cloneExecutionJsonObject(input, "execution source defaults"),
  } as Record<string, ExecutionJsonValue>;
  for (const key of ["agent", "engine", "model", "workspace"] as const) {
    const value = json[key];
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw new TypeError(`execution source defaults.${key} must be a string or null`);
    }
  }
  const timeout = json.timeout;
  if (timeout !== undefined && timeout !== null && typeof timeout !== "string" && typeof timeout !== "number") {
    throw new TypeError("execution source defaults.timeout must be a string, number, or null");
  }
  for (const key of ["inference", "outputSchema", "runtime"] as const) {
    const value = json[key];
    if (value !== undefined && value !== null && (Array.isArray(value) || typeof value !== "object")) {
      throw new TypeError(`execution source defaults.${key} must be an object or null`);
    }
  }
  const environment = json.environment;
  if (environment !== undefined && environment !== null) {
    if (Array.isArray(environment) || typeof environment !== "object") {
      throw new TypeError("execution source defaults.environment must be an object or null");
    }
    for (const value of Object.values(environment)) {
      if (typeof value !== "string") {
        throw new TypeError("execution source defaults.environment values must be strings");
      }
    }
  }
  if (Object.hasOwn(json, "tools")) json.tools = cloneToolSelection(json.tools, "execution source defaults.tools");
  return Object.freeze(json as unknown as UnresolvedExecutionDefaults);
}

export function cloneToolSelection(value: unknown, path = "tools"): ToolSelection {
  if (value === null || typeof value === "string") return value;
  if (Array.isArray(value)) {
    if (value.some((tool) => typeof tool !== "string")) throw new TypeError(`${path} array values must be strings`);
    return Object.freeze([...value]) as readonly string[];
  }
  return cloneExecutionJsonObject(value, path);
}

export interface RenderMarkdownExecutionSourceInput {
  readonly kind: "command" | "persona";
  /** Authoritative native file text. It is hashed, then frontmatter is removed. */
  readonly raw: string;
  readonly identity: Omit<ExecutionSourceIdentity, "hash">;
  readonly defaults?: UnresolvedExecutionDefaults;
  readonly extensions?: AdapterOwnedExtensions;
}

/**
 * The only constructor for stored command/persona sources.
 *
 * Callers provide authoritative native bytes, never a preselected prompt.
 * This function strips frontmatter and exposes only the adapter-rendered body.
 * The raw bytes and parsed frontmatter are intentionally absent
 * from the returned type and enumerable object.
 */
export function renderMarkdownExecutionSource(
  input: RenderMarkdownExecutionSourceInput & { readonly kind: "command" },
): AdapterRenderedCommandSource;
export function renderMarkdownExecutionSource(
  input: RenderMarkdownExecutionSourceInput & { readonly kind: "persona" },
): AdapterRenderedPersonaSource;
export function renderMarkdownExecutionSource(
  input: RenderMarkdownExecutionSourceInput,
): AdapterRenderedExecutionSource;
export function renderMarkdownExecutionSource(
  input: RenderMarkdownExecutionSourceInput,
): AdapterRenderedExecutionSource {
  if (typeof input.raw !== "string") throw new TypeError("execution source raw content must be a string");
  assertCanonicalIdentity(input.identity);
  const parsed = parseFrontmatter(input.raw);
  if (/^\uFEFF?---(?:\r?\n|\r|$)/.test(input.raw) && parsed.frontmatter === null) {
    throw new TypeError("execution source frontmatter must have a well-formed closing fence");
  }
  const identity = Object.freeze({
    ref: input.identity.ref,
    bundle: input.identity.bundle,
    adapter: input.identity.adapter,
    file: input.identity.file,
    hash: createHash("sha256").update(input.raw, "utf8").digest("hex"),
  });
  const source: Record<PropertyKey, unknown> = {
    schemaVersion: EXECUTION_SOURCE_SCHEMA_VERSION,
    kind: input.kind,
    content: parsed.content,
    defaults: cloneDefaults(input.defaults ?? {}),
    identity,
    ...(Object.hasOwn(input, "extensions")
      ? { extensions: cloneExtensions(input.extensions as AdapterOwnedExtensions, "execution source extensions") }
      : {}),
  };
  Object.defineProperty(source, renderedSourceBrand, { value: true, enumerable: false });
  return Object.freeze(source) as unknown as AdapterRenderedExecutionSource;
}

export function isAdapterRenderedCommandSource(value: unknown): value is AdapterRenderedCommandSource {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[renderedSourceBrand] === true &&
    (value as { kind?: unknown }).kind === "command"
  );
}

export function isAdapterRenderedPersonaSource(value: unknown): value is AdapterRenderedPersonaSource {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[renderedSourceBrand] === true &&
    (value as { kind?: unknown }).kind === "persona"
  );
}

function own(data: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(data, key);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOrNull(value: unknown): string | null | undefined {
  return value === null || typeof value === "string" ? value : undefined;
}

/** Adapter helper for the common frontmatter fields fixed by the 0.9.2 design. */
export function executionDefaultsFromFrontmatter(
  data: Record<string, unknown>,
  options: {
    readonly kind: "command" | "persona";
    readonly allowTopLevelEngine?: boolean;
    readonly toolsKeys?: readonly string[];
  },
): UnresolvedExecutionDefaults {
  const namespace = record(data.akm) ?? {};
  const out: Record<string, unknown> = {};
  if (options.kind === "command" && own(data, "agent")) {
    const agent = stringOrNull(data.agent);
    if (agent !== undefined) out.agent = agent;
  }
  const engineOwner = options.allowTopLevelEngine && own(data, "engine") ? data : namespace;
  if (own(engineOwner, "engine")) {
    const engine = stringOrNull(engineOwner.engine);
    if (engine !== undefined) out.engine = engine;
  }
  if (own(data, "model")) {
    const model = stringOrNull(data.model);
    if (model !== undefined) out.model = model;
  }
  for (const key of options.toolsKeys ?? ["tools"]) {
    if (!own(data, key)) continue;
    out.tools = cloneExecutionJson(data[key], `frontmatter.${key}`);
    break;
  }

  const inference: Record<string, ExecutionJsonValue> = {};
  const namespacedInference = record(namespace.inference);
  if (namespacedInference)
    Object.assign(inference, cloneExecutionJsonObject(namespacedInference, "frontmatter.akm.inference"));
  for (const key of ["temperature", "effort"] as const) {
    if (own(data, key)) inference[key] = cloneExecutionJson(data[key], `frontmatter.${key}`);
  }
  if (Object.keys(inference).length > 0) out.inference = inference;

  const schemaOwner = own(data, "schema") ? data : namespace;
  if (own(schemaOwner, "schema")) {
    const schema = schemaOwner.schema;
    out.outputSchema = schema === null ? null : cloneExecutionJsonObject(schema, "frontmatter.schema");
  }
  const timeoutKey = own(namespace, "timeoutMs") ? "timeoutMs" : own(namespace, "timeout") ? "timeout" : undefined;
  const topLevelTimeoutKey = options.allowTopLevelEngine
    ? own(data, "timeoutMs")
      ? "timeoutMs"
      : own(data, "timeout")
        ? "timeout"
        : undefined
    : undefined;
  const selectedTimeoutKey = topLevelTimeoutKey ?? timeoutKey;
  const timeoutOwner = topLevelTimeoutKey ? data : namespace;
  if (selectedTimeoutKey) out.timeout = cloneExecutionJson(timeoutOwner[selectedTimeoutKey], "frontmatter.timeout");

  for (const key of ["workspace", "environment", "runtime"] as const) {
    const owner = options.allowTopLevelEngine && own(data, key) ? data : namespace;
    if (own(owner, key)) out[key] = cloneExecutionJson(owner[key], `frontmatter.${key}`);
  }
  return cloneDefaults(out as UnresolvedExecutionDefaults);
}
