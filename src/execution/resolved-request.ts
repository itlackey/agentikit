// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { cloneExecutionJson, cloneExecutionJsonObject, type ExecutionJsonObject, sortExecutionJson } from "./json";
import { EXECUTION_MAX_TIMEOUT_MS } from "./limits";
import {
  type AdapterOwnedExtensions,
  type AdapterRenderedCommandSource,
  type AdapterRenderedPersonaSource,
  cloneAdapterExtensions,
  cloneToolSelection,
  decodeExecutionSourceIdentity,
  type ExecutionSourceIdentity,
  isAdapterRenderedCommandSource,
  isAdapterRenderedPersonaSource,
  type ToolSelection,
} from "./source";

export const RESOLVED_EXECUTION_SCHEMA_VERSION = 1 as const;

const resolvedCommandBrand: unique symbol = Symbol("akm.resolved-command");
const resolvedPersonaBrand: unique symbol = Symbol("akm.resolved-persona");

export interface ResolvedCommandContent {
  /** Adapter-rendered or anonymous content before portable argument substitution. */
  readonly template: string;
  /** Omitted means no argument input; an explicit empty string is meaningful. */
  readonly argumentInput?: string;
  /** Final command content after the caller's approved one-pass substitution. */
  readonly content: string;
  /** `null` only for explicitly anonymous inline command content. */
  readonly source: Readonly<ExecutionSourceIdentity> | null;
  readonly extensions?: AdapterOwnedExtensions;
  readonly [resolvedCommandBrand]: true;
}

export interface ResolvedPersonaContent {
  readonly content: string;
  /** Personas are selected assets; anonymous inline persona input is not a 0.9.2 surface. */
  readonly source: Readonly<ExecutionSourceIdentity>;
  readonly extensions?: AdapterOwnedExtensions;
  readonly [resolvedPersonaBrand]: true;
}

export interface ResolvedEngineSelection {
  readonly name: string;
  /** Transport family only, not a claim about model or harness capabilities. */
  readonly kind: "agent" | "sdk" | "llm";
  readonly platform?: string | null;
  readonly settings?: ExecutionJsonObject | null;
  readonly extensions?: AdapterOwnedExtensions;
}

export interface ResolvedModelSelection {
  /** Exact invocation input before alias interpretation. */
  readonly input: string;
  readonly interpretation: "alias" | "exact";
  /** Exact provider/harness model identifier after alias expansion. */
  readonly resolved: string;
  readonly extensions?: AdapterOwnedExtensions;
}

export interface ToolAuthorizationResult {
  /** `not-required` means no tool grant was selected; it is not an unknown authorization state. */
  readonly status: "allowed" | "denied" | "not-required";
  readonly reason?: string | null;
  readonly policy?: ExecutionJsonObject | null;
}

export interface ResolvedRuntimeSettings {
  readonly timeoutMs?: number | null;
  readonly workspace?: string | null;
  readonly environment?: Readonly<Record<string, string>> | null;
  readonly settings?: ExecutionJsonObject | null;
  readonly extensions?: AdapterOwnedExtensions;
}

export interface LoweringNotice {
  readonly code: string;
  readonly severity: "info" | "warning";
  readonly adapter: string;
  readonly field?: string | null;
  readonly message: string;
  readonly details?: ExecutionJsonObject | null;
}

/**
 * One versioned dispatch/freeze boundary for direct, task, and workflow callers.
 * WP1 defines this contract; production caller cutover is explicitly owned by
 * WP3, WP4, and WP5 and is not claimed by the presence of this type.
 */
export interface ResolvedExecutionRequestV1 {
  readonly schemaVersion: typeof RESOLVED_EXECUTION_SCHEMA_VERSION;
  readonly command: ResolvedCommandContent;
  readonly persona?: ResolvedPersonaContent | null;
  readonly engine: Readonly<ResolvedEngineSelection>;
  readonly model?: Readonly<ResolvedModelSelection> | null;
  readonly inference?: ExecutionJsonObject | null;
  readonly outputSchema?: ExecutionJsonObject | null;
  /** Selected tools. Authorization is deliberately a separate policy result. */
  readonly tools?: ToolSelection;
  readonly authorization: Readonly<ToolAuthorizationResult>;
  readonly runtime: Readonly<ResolvedRuntimeSettings>;
  readonly notices: readonly Readonly<LoweringNotice>[];
  readonly extensions?: AdapterOwnedExtensions;
}

function defineBrand<T extends object>(value: T, brand: symbol): T {
  Object.defineProperty(value, brand, { value: true, enumerable: false });
  return Object.freeze(value);
}

function cloneIdentity(value: ExecutionSourceIdentity): Readonly<ExecutionSourceIdentity> {
  return decodeExecutionSourceIdentity(value);
}

function copyArgumentInput(input: { readonly argumentInput?: string }, output: Record<string, unknown>): void {
  if (!Object.hasOwn(input, "argumentInput")) return;
  if (typeof input.argumentInput !== "string") {
    throw new TypeError("command argumentInput must be omitted or a string");
  }
  output.argumentInput = input.argumentInput;
}

export function createResolvedCommand(input: {
  readonly source: AdapterRenderedCommandSource;
  readonly argumentInput?: string;
  readonly content: string;
}): ResolvedCommandContent {
  const record = requireObject(input, "resolved command input");
  assertOnlyKeys(record, ["source", "argumentInput", "content"], "resolved command input");
  const source = requireOwn(record, "source", "resolved command input");
  const content = requireOwn(record, "content", "resolved command input");
  if (!isAdapterRenderedCommandSource(source)) {
    throw new TypeError("source must be an adapter-rendered command source");
  }
  if (typeof content !== "string") throw new TypeError("resolved command content must be a string");
  const out: Record<string, unknown> = {
    template: source.content,
    content,
    source: cloneIdentity(source.identity),
    ...(source.extensions
      ? { extensions: cloneAdapterExtensions(source.extensions, "resolved command extensions") }
      : {}),
  };
  copyArgumentInput(input, out);
  return defineBrand(out, resolvedCommandBrand) as unknown as ResolvedCommandContent;
}

export function createInlineResolvedCommand(input: {
  readonly template: string;
  readonly argumentInput?: string;
  readonly content: string;
}): ResolvedCommandContent {
  const record = requireObject(input, "inline resolved command input");
  assertOnlyKeys(record, ["template", "argumentInput", "content"], "inline resolved command input");
  const template = requireOwn(record, "template", "inline resolved command input");
  const content = requireOwn(record, "content", "inline resolved command input");
  if (typeof template !== "string" || typeof content !== "string") {
    throw new TypeError("inline command template and content must be strings");
  }
  const out: Record<string, unknown> = { template, content, source: null };
  copyArgumentInput(input, out);
  return defineBrand(out, resolvedCommandBrand) as unknown as ResolvedCommandContent;
}

export function createResolvedPersona(source: AdapterRenderedPersonaSource): ResolvedPersonaContent {
  if (!isAdapterRenderedPersonaSource(source)) {
    throw new TypeError("source must be an adapter-rendered persona source");
  }
  const out: Record<string, unknown> = {
    content: source.content,
    source: cloneIdentity(source.identity),
    ...(source.extensions
      ? { extensions: cloneAdapterExtensions(source.extensions, "resolved persona extensions") }
      : {}),
  };
  return defineBrand(out, resolvedPersonaBrand) as unknown as ResolvedPersonaContent;
}

function hasOwnFrozenBrand(value: unknown, brand: symbol): value is Record<PropertyKey, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    !Object.isFrozen(value) ||
    !Object.hasOwn(value, brand)
  ) {
    return false;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, brand);
  return (
    descriptor?.value === true &&
    descriptor.enumerable === false &&
    descriptor.configurable === false &&
    descriptor.writable === false
  );
}

function isResolvedCommand(value: unknown): value is ResolvedCommandContent {
  return hasOwnFrozenBrand(value, resolvedCommandBrand);
}

function isResolvedPersona(value: unknown): value is ResolvedPersonaContent {
  return hasOwnFrozenBrand(value, resolvedPersonaBrand);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${path} must be a non-empty string`);
  return value;
}

function cloneEngine(input: ResolvedEngineSelection): Readonly<ResolvedEngineSelection> {
  const record = requireObject(input, "engine");
  assertOnlyKeys(record, ["name", "kind", "platform", "settings", "extensions"], "engine");
  requireOwn(record, "name", "engine");
  requireOwn(record, "kind", "engine");
  requireString(input.name, "engine.name");
  if (!(["agent", "sdk", "llm"] as const).includes(input.kind)) throw new TypeError("engine.kind is invalid");
  const out: Record<string, unknown> = { name: input.name, kind: input.kind };
  for (const key of ["platform", "settings", "extensions"] as const) {
    if (!Object.hasOwn(input, key)) continue;
    const value = input[key];
    if (value === undefined) throw new TypeError(`engine.${key} must be omitted rather than undefined`);
    if (key === "platform") {
      if (value !== null && typeof value !== "string") throw new TypeError("engine.platform must be a string or null");
      out.platform = value;
    } else if (key === "settings") {
      out.settings = value === null ? null : cloneExecutionJsonObject(value, "engine.settings");
    } else {
      out.extensions = cloneAdapterExtensions(value, "engine.extensions");
    }
  }
  return Object.freeze(out) as unknown as Readonly<ResolvedEngineSelection>;
}

function cloneModel(input: ResolvedModelSelection): Readonly<ResolvedModelSelection> {
  const record = requireObject(input, "model");
  assertOnlyKeys(record, ["input", "interpretation", "resolved", "extensions"], "model");
  for (const key of ["input", "interpretation", "resolved"] as const) requireOwn(record, key, "model");
  requireString(input.input, "model.input");
  requireString(input.resolved, "model.resolved");
  if (input.interpretation !== "alias" && input.interpretation !== "exact") {
    throw new TypeError("model.interpretation is invalid");
  }
  if (input.interpretation === "exact" && input.input !== input.resolved) {
    throw new TypeError("model.input must match model.resolved when interpretation is exact");
  }
  const out: Record<string, unknown> = {
    input: input.input,
    interpretation: input.interpretation,
    resolved: input.resolved,
  };
  if (Object.hasOwn(input, "extensions")) {
    if (input.extensions === null || input.extensions === undefined) {
      throw new TypeError("model.extensions must be omitted or an adapter-owned extension object");
    }
    out.extensions = cloneAdapterExtensions(input.extensions, "model.extensions");
  }
  return Object.freeze(out) as unknown as Readonly<ResolvedModelSelection>;
}

function cloneAuthorization(input: ToolAuthorizationResult): Readonly<ToolAuthorizationResult> {
  const record = requireObject(input, "authorization");
  assertOnlyKeys(record, ["status", "reason", "policy"], "authorization");
  requireOwn(record, "status", "authorization");
  if (!(["allowed", "denied", "not-required"] as const).includes(input.status)) {
    throw new TypeError("authorization.status is invalid");
  }
  const out: Record<string, unknown> = { status: input.status };
  if (Object.hasOwn(input, "reason")) {
    if (input.reason !== null && typeof input.reason !== "string") {
      throw new TypeError("authorization.reason must be a string or null");
    }
    out.reason = input.reason;
  }
  if (Object.hasOwn(input, "policy")) {
    out.policy = input.policy === null ? null : cloneExecutionJsonObject(input.policy, "authorization.policy");
  }
  return Object.freeze(out) as unknown as Readonly<ToolAuthorizationResult>;
}

function cloneRuntime(input: ResolvedRuntimeSettings): Readonly<ResolvedRuntimeSettings> {
  const record = requireObject(input, "runtime");
  assertOnlyKeys(record, ["timeoutMs", "workspace", "environment", "settings", "extensions"], "runtime");
  const out: Record<string, unknown> = {};
  if (Object.hasOwn(input, "timeoutMs")) {
    if (
      input.timeoutMs !== null &&
      (typeof input.timeoutMs !== "number" ||
        !Number.isInteger(input.timeoutMs) ||
        input.timeoutMs < 0 ||
        input.timeoutMs > EXECUTION_MAX_TIMEOUT_MS)
    ) {
      throw new TypeError(`runtime.timeoutMs must be null or an integer from 0 through ${EXECUTION_MAX_TIMEOUT_MS}`);
    }
    out.timeoutMs = input.timeoutMs;
  }
  if (Object.hasOwn(input, "workspace")) {
    if (input.workspace !== null && typeof input.workspace !== "string") {
      throw new TypeError("runtime.workspace must be a string or null");
    }
    out.workspace = input.workspace;
  }
  if (Object.hasOwn(input, "environment")) {
    if (input.environment === null) out.environment = null;
    else {
      const environment = cloneExecutionJsonObject(input.environment, "runtime.environment");
      if (Object.values(environment).some((value) => typeof value !== "string")) {
        throw new TypeError("runtime.environment values must be strings");
      }
      out.environment = environment;
    }
  }
  if (Object.hasOwn(input, "settings")) {
    out.settings = input.settings === null ? null : cloneExecutionJsonObject(input.settings, "runtime.settings");
  }
  if (Object.hasOwn(input, "extensions")) {
    out.extensions = cloneAdapterExtensions(input.extensions, "runtime.extensions");
  }
  return Object.freeze(out) as unknown as Readonly<ResolvedRuntimeSettings>;
}

function cloneNotice(input: LoweringNotice, index: number): Readonly<LoweringNotice> {
  const path = `notices[${index}]`;
  const record = requireObject(input, path);
  assertOnlyKeys(record, ["code", "severity", "adapter", "field", "message", "details"], path);
  for (const key of ["code", "severity", "adapter", "message"] as const) requireOwn(record, key, path);
  requireString(input.code, `notices[${index}].code`);
  requireString(input.adapter, `notices[${index}].adapter`);
  requireString(input.message, `notices[${index}].message`);
  if (input.severity !== "info" && input.severity !== "warning") {
    throw new TypeError(`notices[${index}].severity is invalid`);
  }
  const out: Record<string, unknown> = {
    code: input.code,
    severity: input.severity,
    adapter: input.adapter,
    message: input.message,
  };
  if (Object.hasOwn(input, "field")) {
    if (input.field !== null && typeof input.field !== "string") {
      throw new TypeError(`notices[${index}].field must be a string or null`);
    }
    out.field = input.field;
  }
  if (Object.hasOwn(input, "details")) {
    out.details = input.details === null ? null : cloneExecutionJsonObject(input.details, `notices[${index}].details`);
  }
  return Object.freeze(out) as unknown as Readonly<LoweringNotice>;
}

function cloneResolvedCommandLeaf(input: ResolvedCommandContent): ResolvedCommandContent {
  if (!isResolvedCommand(input)) throw new TypeError("command must be constructed by the execution boundary");
  const record = input as unknown as Record<PropertyKey, unknown>;
  assertOnlyKeys(record, ["template", "argumentInput", "content", "source", "extensions"], "command", [
    resolvedCommandBrand,
  ]);
  const template = requireOwn(record, "template", "command");
  const content = requireOwn(record, "content", "command");
  const source = requireOwn(record, "source", "command");
  if (typeof template !== "string" || typeof content !== "string") {
    throw new TypeError("command template and content must be strings");
  }
  const out: Record<string, unknown> = {
    template,
    content,
    source: source === null ? null : decodeExecutionSourceIdentity(source, "command.source"),
  };
  copyArgumentInput(input, out);
  if (Object.hasOwn(input, "extensions")) {
    out.extensions = cloneAdapterExtensions(input.extensions, "command.extensions");
  }
  return defineBrand(out, resolvedCommandBrand) as unknown as ResolvedCommandContent;
}

function cloneResolvedPersonaLeaf(input: ResolvedPersonaContent): ResolvedPersonaContent {
  if (!isResolvedPersona(input)) throw new TypeError("persona must be constructed by the execution boundary");
  const record = input as unknown as Record<PropertyKey, unknown>;
  assertOnlyKeys(record, ["content", "source", "extensions"], "persona", [resolvedPersonaBrand]);
  const content = requireOwn(record, "content", "persona");
  if (typeof content !== "string") throw new TypeError("persona.content must be a string");
  const out: Record<string, unknown> = {
    content,
    source: decodeExecutionSourceIdentity(requireOwn(record, "source", "persona"), "persona.source"),
  };
  if (Object.hasOwn(input, "extensions")) {
    out.extensions = cloneAdapterExtensions(input.extensions, "persona.extensions");
  }
  return defineBrand(out, resolvedPersonaBrand) as unknown as ResolvedPersonaContent;
}

export type ResolvedExecutionRequestInput = Omit<ResolvedExecutionRequestV1, "schemaVersion">;

/** Validate and freeze one request without normalizing away optional-field presence. */
export function createResolvedExecutionRequest(input: ResolvedExecutionRequestInput): ResolvedExecutionRequestV1 {
  const record = requireObject(input, "resolved execution request input");
  assertOnlyKeys(
    record,
    [
      "command",
      "persona",
      "engine",
      "model",
      "inference",
      "outputSchema",
      "tools",
      "authorization",
      "runtime",
      "notices",
      "extensions",
    ],
    "resolved execution request input",
  );
  const command = requireOwn(record, "command", "resolved execution request input");
  const engine = requireOwn(record, "engine", "resolved execution request input");
  const authorization = requireOwn(record, "authorization", "resolved execution request input");
  const runtime = requireOwn(record, "runtime", "resolved execution request input");
  const notices = requireOwn(record, "notices", "resolved execution request input");
  if (!isResolvedCommand(command)) throw new TypeError("command must be constructed by the execution boundary");
  const clonedNotices = cloneExecutionJson(notices, "notices");
  if (!Array.isArray(clonedNotices)) throw new TypeError("notices must be an array");
  const out: Record<string, unknown> = {
    schemaVersion: RESOLVED_EXECUTION_SCHEMA_VERSION,
    command: cloneResolvedCommandLeaf(command),
    engine: cloneEngine(engine as unknown as ResolvedEngineSelection),
    authorization: cloneAuthorization(authorization as unknown as ToolAuthorizationResult),
    runtime: cloneRuntime(runtime as unknown as ResolvedRuntimeSettings),
    notices: Object.freeze(clonedNotices.map((notice, index) => cloneNotice(notice as LoweringNotice, index))),
  };
  if (Object.hasOwn(input, "persona")) {
    if (input.persona !== null && !isResolvedPersona(input.persona)) {
      throw new TypeError("persona must be null or constructed by the execution boundary");
    }
    out.persona = input.persona === null ? null : cloneResolvedPersonaLeaf(input.persona);
  }
  if (Object.hasOwn(input, "model")) {
    if (input.model === undefined) throw new TypeError("model must be omitted, null, or a model selection");
    out.model = input.model === null ? null : cloneModel(input.model);
  }
  if (Object.hasOwn(input, "inference")) {
    out.inference = input.inference === null ? null : cloneExecutionJsonObject(input.inference, "inference");
  }
  if (Object.hasOwn(input, "outputSchema")) {
    out.outputSchema =
      input.outputSchema === null ? null : cloneExecutionJsonObject(input.outputSchema, "outputSchema");
  }
  if (Object.hasOwn(input, "tools")) out.tools = cloneToolSelection(input.tools, "tools");
  const toolsRequireAuthorization = toolSelectionRequiresAuthorization(out.tools, Object.hasOwn(out, "tools"));
  const authorizationStatus = (out.authorization as ToolAuthorizationResult).status;
  if (toolsRequireAuthorization && authorizationStatus === "not-required") {
    throw new TypeError("authorization.status not-required is valid only when no tools are selected");
  }
  if (!toolsRequireAuthorization && authorizationStatus !== "not-required") {
    throw new TypeError("empty or omitted tool selection requires authorization.status not-required");
  }
  if (Object.hasOwn(input, "extensions")) {
    out.extensions = cloneAdapterExtensions(input.extensions, "request.extensions");
  }
  return Object.freeze(out) as unknown as ResolvedExecutionRequestV1;
}

function toolSelectionRequiresAuthorization(value: unknown, present: boolean): boolean {
  // WP1's transport-level invariant is intentionally syntax based: omitted,
  // null, "", [], and {} are the only empty spellings. Adapters/resolvers own
  // any format-specific normalization before they construct this request.
  if (!present || value === null) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === "object" && value !== null && Object.keys(value).length > 0;
}

function requireObject(value: unknown, path: string): Record<PropertyKey, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must use a plain or null prototype`);
  }
  return value as Record<PropertyKey, unknown>;
}

function assertOnlyKeys(
  value: Record<PropertyKey, unknown>,
  allowed: readonly string[],
  path: string,
  allowedSymbols: readonly symbol[] = [],
): void {
  const allowedSet = new Set(allowed);
  const allowedSymbolSet = new Set(allowedSymbols);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      if (!allowedSymbolSet.has(key)) throw new TypeError(`${path} contains unsupported field: ${String(key)}`);
      continue;
    }
    if (!allowedSet.has(key)) throw new TypeError(`${path} contains unsupported field: ${key}`);
  }
}

function requireOwn(value: Record<PropertyKey, unknown>, key: string, path: string): unknown {
  if (!Object.hasOwn(value, key)) throw new TypeError(`${path}.${key} is required`);
  return value[key];
}

function decodeExtensions(value: unknown, path: string): AdapterOwnedExtensions {
  return cloneAdapterExtensions(requireObject(value, path), path);
}

function decodeResolvedCommand(value: unknown): ResolvedCommandContent {
  const input = requireObject(value, "command");
  assertOnlyKeys(input, ["template", "argumentInput", "content", "source", "extensions"], "command");
  const template = requireOwn(input, "template", "command");
  const content = requireOwn(input, "content", "command");
  const source = requireOwn(input, "source", "command");
  if (typeof template !== "string" || typeof content !== "string") {
    throw new TypeError("command template and content must be strings");
  }
  const out: Record<string, unknown> = {
    template,
    content,
    source: source === null ? null : decodeExecutionSourceIdentity(source, "command.source"),
  };
  if (Object.hasOwn(input, "argumentInput")) {
    if (typeof input.argumentInput !== "string") throw new TypeError("command.argumentInput must be a string");
    out.argumentInput = input.argumentInput;
  }
  if (Object.hasOwn(input, "extensions")) out.extensions = decodeExtensions(input.extensions, "command.extensions");
  return defineBrand(out, resolvedCommandBrand) as unknown as ResolvedCommandContent;
}

function decodeResolvedPersona(value: unknown): ResolvedPersonaContent {
  const input = requireObject(value, "persona");
  assertOnlyKeys(input, ["content", "source", "extensions"], "persona");
  const content = requireOwn(input, "content", "persona");
  if (typeof content !== "string") throw new TypeError("persona.content must be a string");
  const source = decodeExecutionSourceIdentity(requireOwn(input, "source", "persona"), "persona.source");
  const out: Record<string, unknown> = { content, source };
  if (Object.hasOwn(input, "extensions")) out.extensions = decodeExtensions(input.extensions, "persona.extensions");
  return defineBrand(out, resolvedPersonaBrand) as unknown as ResolvedPersonaContent;
}

function decodeEngine(value: unknown): Readonly<ResolvedEngineSelection> {
  const input = requireObject(value, "engine");
  assertOnlyKeys(input, ["name", "kind", "platform", "settings", "extensions"], "engine");
  requireOwn(input, "name", "engine");
  requireOwn(input, "kind", "engine");
  return cloneEngine(input as unknown as ResolvedEngineSelection);
}

function decodeModel(value: unknown): Readonly<ResolvedModelSelection> {
  const input = requireObject(value, "model");
  assertOnlyKeys(input, ["input", "interpretation", "resolved", "extensions"], "model");
  for (const key of ["input", "interpretation", "resolved"]) requireOwn(input, key, "model");
  return cloneModel(input as unknown as ResolvedModelSelection);
}

function decodeAuthorization(value: unknown): Readonly<ToolAuthorizationResult> {
  const input = requireObject(value, "authorization");
  assertOnlyKeys(input, ["status", "reason", "policy"], "authorization");
  requireOwn(input, "status", "authorization");
  return cloneAuthorization(input as unknown as ToolAuthorizationResult);
}

function decodeRuntime(value: unknown): Readonly<ResolvedRuntimeSettings> {
  const input = requireObject(value, "runtime");
  assertOnlyKeys(input, ["timeoutMs", "workspace", "environment", "settings", "extensions"], "runtime");
  return cloneRuntime(input as unknown as ResolvedRuntimeSettings);
}

function decodeNotice(value: unknown, index: number): Readonly<LoweringNotice> {
  const input = requireObject(value, `notices[${index}]`);
  assertOnlyKeys(input, ["code", "severity", "adapter", "field", "message", "details"], `notices[${index}]`);
  for (const key of ["code", "severity", "adapter", "message"]) requireOwn(input, key, `notices[${index}]`);
  return cloneNotice(input as unknown as LoweringNotice, index);
}

/**
 * Strictly rehydrate a frozen JSON request after workflow resume/replay.
 * Symbol construction brands are restored only after every wire field has
 * been validated; raw/frontmatter lookalike fields are rejected as unknown.
 */
export function decodeResolvedExecutionRequest(value: unknown): ResolvedExecutionRequestV1 {
  const input = requireObject(value, "resolved execution request");
  assertOnlyKeys(
    input,
    [
      "schemaVersion",
      "command",
      "persona",
      "engine",
      "model",
      "inference",
      "outputSchema",
      "tools",
      "authorization",
      "runtime",
      "notices",
      "extensions",
    ],
    "resolved execution request",
  );
  if (requireOwn(input, "schemaVersion", "resolved execution request") !== RESOLVED_EXECUTION_SCHEMA_VERSION) {
    throw new TypeError(`unsupported resolved execution schemaVersion: ${String(input.schemaVersion)}`);
  }
  const notices = requireOwn(input, "notices", "resolved execution request");
  const clonedNotices = cloneExecutionJson(notices, "resolved execution request.notices");
  if (!Array.isArray(clonedNotices)) throw new TypeError("resolved execution request.notices must be an array");
  const request: Record<string, unknown> = {
    command: decodeResolvedCommand(requireOwn(input, "command", "resolved execution request")),
    engine: decodeEngine(requireOwn(input, "engine", "resolved execution request")),
    authorization: decodeAuthorization(requireOwn(input, "authorization", "resolved execution request")),
    runtime: decodeRuntime(requireOwn(input, "runtime", "resolved execution request")),
    notices: clonedNotices.map(decodeNotice),
  };
  if (Object.hasOwn(input, "persona")) {
    request.persona = input.persona === null ? null : decodeResolvedPersona(input.persona);
  }
  if (Object.hasOwn(input, "model")) request.model = input.model === null ? null : decodeModel(input.model);
  if (Object.hasOwn(input, "inference")) request.inference = input.inference;
  if (Object.hasOwn(input, "outputSchema")) request.outputSchema = input.outputSchema;
  if (Object.hasOwn(input, "tools")) request.tools = input.tools;
  if (Object.hasOwn(input, "extensions")) request.extensions = decodeExtensions(input.extensions, "request.extensions");
  return createResolvedExecutionRequest(request as unknown as ResolvedExecutionRequestInput);
}

/** Stable bytes for freeze hashes and entrypoint-equivalence projections. */
export function canonicalResolvedExecutionRequest(request: ResolvedExecutionRequestV1): string {
  if (request.schemaVersion !== RESOLVED_EXECUTION_SCHEMA_VERSION) {
    throw new TypeError(`unsupported resolved execution schemaVersion: ${String(request.schemaVersion)}`);
  }
  const json = cloneExecutionJson(request, "resolved execution request");
  return `${JSON.stringify(sortExecutionJson(json))}\n`;
}
