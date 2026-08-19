// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { cloneExecutionJson, cloneExecutionJsonObject, type ExecutionJsonObject, sortExecutionJson } from "./json";
import {
  type AdapterOwnedExtensions,
  type AdapterRenderedCommandSource,
  type AdapterRenderedPersonaSource,
  cloneToolSelection,
  createAdapterExtensions,
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

/** One versioned dispatch/freeze boundary shared by direct, task, and workflow callers. */
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

function cloneExtensions(value: AdapterOwnedExtensions, path: string): AdapterOwnedExtensions {
  const entries = Object.entries(value).map(
    ([owner, fields]) => [owner, cloneExecutionJsonObject(fields, `${path}.${owner}`)] as const,
  );
  const [first, ...rest] = entries;
  return first ? createAdapterExtensions(first, ...rest) : Object.freeze({});
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
  if (!isAdapterRenderedCommandSource(input.source)) {
    throw new TypeError("source must be an adapter-rendered command source");
  }
  if (typeof input.content !== "string") throw new TypeError("resolved command content must be a string");
  const out: Record<string, unknown> = {
    template: input.source.content,
    content: input.content,
    source: cloneIdentity(input.source.identity),
    ...(input.source.extensions
      ? { extensions: cloneExtensions(input.source.extensions, "resolved command extensions") }
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
  if (typeof input.template !== "string" || typeof input.content !== "string") {
    throw new TypeError("inline command template and content must be strings");
  }
  const out: Record<string, unknown> = { template: input.template, content: input.content, source: null };
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
    ...(source.extensions ? { extensions: cloneExtensions(source.extensions, "resolved persona extensions") } : {}),
  };
  return defineBrand(out, resolvedPersonaBrand) as unknown as ResolvedPersonaContent;
}

function isResolvedCommand(value: unknown): value is ResolvedCommandContent {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[resolvedCommandBrand] === true
  );
}

function isResolvedPersona(value: unknown): value is ResolvedPersonaContent {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[resolvedPersonaBrand] === true
  );
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${path} must be a non-empty string`);
  return value;
}

function cloneEngine(input: ResolvedEngineSelection): Readonly<ResolvedEngineSelection> {
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
      out.extensions = cloneExtensions(value as AdapterOwnedExtensions, "engine.extensions");
    }
  }
  return Object.freeze(out) as unknown as Readonly<ResolvedEngineSelection>;
}

function cloneModel(input: ResolvedModelSelection): Readonly<ResolvedModelSelection> {
  requireString(input.input, "model.input");
  requireString(input.resolved, "model.resolved");
  if (input.interpretation !== "alias" && input.interpretation !== "exact") {
    throw new TypeError("model.interpretation is invalid");
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
    out.extensions = cloneExtensions(input.extensions, "model.extensions");
  }
  return Object.freeze(out) as unknown as Readonly<ResolvedModelSelection>;
}

function cloneAuthorization(input: ToolAuthorizationResult): Readonly<ToolAuthorizationResult> {
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
  const out: Record<string, unknown> = {};
  if (Object.hasOwn(input, "timeoutMs")) {
    if (input.timeoutMs !== null && (typeof input.timeoutMs !== "number" || !Number.isFinite(input.timeoutMs))) {
      throw new TypeError("runtime.timeoutMs must be a finite number or null");
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
    out.extensions = cloneExtensions(input.extensions as AdapterOwnedExtensions, "runtime.extensions");
  }
  return Object.freeze(out) as unknown as Readonly<ResolvedRuntimeSettings>;
}

function cloneNotice(input: LoweringNotice, index: number): Readonly<LoweringNotice> {
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

export type ResolvedExecutionRequestInput = Omit<ResolvedExecutionRequestV1, "schemaVersion">;

/** Validate and freeze one request without normalizing away optional-field presence. */
export function createResolvedExecutionRequest(input: ResolvedExecutionRequestInput): ResolvedExecutionRequestV1 {
  if (!isResolvedCommand(input.command)) throw new TypeError("command must be constructed by the execution boundary");
  const out: Record<string, unknown> = {
    schemaVersion: RESOLVED_EXECUTION_SCHEMA_VERSION,
    command: input.command,
    engine: cloneEngine(input.engine),
    authorization: cloneAuthorization(input.authorization),
    runtime: cloneRuntime(input.runtime),
    notices: Object.freeze(input.notices.map(cloneNotice)),
  };
  if (Object.hasOwn(input, "persona")) {
    if (input.persona !== null && !isResolvedPersona(input.persona)) {
      throw new TypeError("persona must be null or constructed by the execution boundary");
    }
    out.persona = input.persona;
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
  if (
    input.authorization.status === "not-required" &&
    toolSelectionRequiresAuthorization(out.tools, Object.hasOwn(out, "tools"))
  ) {
    throw new TypeError("authorization.status not-required is valid only when no tools are selected");
  }
  if (Object.hasOwn(input, "extensions")) {
    out.extensions = cloneExtensions(input.extensions as AdapterOwnedExtensions, "request.extensions");
  }
  return Object.freeze(out) as unknown as ResolvedExecutionRequestV1;
}

function toolSelectionRequiresAuthorization(value: unknown, present: boolean): boolean {
  if (!present || value === null) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === "object" && value !== null && Object.keys(value).length > 0;
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new TypeError(`${path} contains unsupported field: ${key}`);
  }
}

function requireOwn(value: Record<string, unknown>, key: string, path: string): unknown {
  if (!Object.hasOwn(value, key)) throw new TypeError(`${path}.${key} is required`);
  return value[key];
}

function decodeExtensions(value: unknown, path: string): AdapterOwnedExtensions {
  return cloneExtensions(requireObject(value, path) as AdapterOwnedExtensions, path);
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
  if (!Array.isArray(notices)) throw new TypeError("resolved execution request.notices must be an array");
  const request: Record<string, unknown> = {
    command: decodeResolvedCommand(requireOwn(input, "command", "resolved execution request")),
    engine: decodeEngine(requireOwn(input, "engine", "resolved execution request")),
    authorization: decodeAuthorization(requireOwn(input, "authorization", "resolved execution request")),
    runtime: decodeRuntime(requireOwn(input, "runtime", "resolved execution request")),
    notices: notices.map(decodeNotice),
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
