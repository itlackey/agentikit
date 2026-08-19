// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { cloneExecutionJson, cloneExecutionJsonObject, type ExecutionJsonObject, sortExecutionJson } from "./json";
import { EXECUTION_MAX_TIMEOUT_MS } from "./limits";
import { assertSnapshotKeys, requireSnapshotField, type StrictRecordSnapshot, snapshotStrictRecord } from "./record";
import {
  type AdapterOwnedExtensions,
  type AdapterRenderedCommandSource,
  type AdapterRenderedPersonaSource,
  cloneAdapterExtensions,
  cloneToolSelection,
  decodeExecutionSourceIdentity,
  type ExecutionSourceIdentity,
  executionPersonaMatchesSelector,
  isAdapterRenderedCommandSource,
  isAdapterRenderedPersonaSource,
  isPortableExecutionAgentSelector,
  requireStableExecutionSelector,
  type ToolSelection,
} from "./source";

export const RESOLVED_EXECUTION_SCHEMA_VERSION = 1 as const;

const resolvedCommandBrand: unique symbol = Symbol("akm.resolved-command");
const resolvedPersonaBrand: unique symbol = Symbol("akm.resolved-persona");
const resolvedCommandInstances = new WeakSet<object>();
const resolvedPersonaInstances = new WeakSet<object>();
const resolvedRequestInstances = new WeakSet<object>();

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
 * One code-owned conversation turn that precedes the terminal user command.
 * This is deliberately not persona content: a system turn here belongs to the
 * calling algorithm, while a persona remains a selected, provenance-branded
 * asset. Provider-specific message payloads are outside this common contract.
 */
export interface ResolvedConversationMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/**
 * One versioned dispatch/freeze boundary for direct, task, and workflow callers.
 * WP1 defines this contract; production caller cutover is explicitly owned by
 * WP3, WP4, and WP5 and is not claimed by the presence of this type.
 */
export interface ResolvedExecutionRequestV1 {
  readonly schemaVersion: typeof RESOLVED_EXECUTION_SCHEMA_VERSION;
  readonly command: ResolvedCommandContent;
  /** Ordered turns before the required terminal `{role:"user", command.content}` turn. */
  readonly conversation?: readonly Readonly<ResolvedConversationMessage>[];
  /** Exact selected agent ref or native harness selector; null explicitly clears selection. */
  readonly agent?: string | null;
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

function defineBrand<T extends object>(value: T, brand: symbol, instances: WeakSet<object>): T {
  Object.defineProperty(value, brand, { value: true, enumerable: false });
  const frozen = Object.freeze(value);
  instances.add(frozen);
  return frozen;
}

function cloneIdentity(value: ExecutionSourceIdentity): Readonly<ExecutionSourceIdentity> {
  return decodeExecutionSourceIdentity(value);
}

function copyArgumentInput(input: StrictRecordSnapshot, output: Record<string, unknown>): void {
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
  copyArgumentInput(record, out);
  return defineBrand(out, resolvedCommandBrand, resolvedCommandInstances) as unknown as ResolvedCommandContent;
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
  copyArgumentInput(record, out);
  return defineBrand(out, resolvedCommandBrand, resolvedCommandInstances) as unknown as ResolvedCommandContent;
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
  return defineBrand(out, resolvedPersonaBrand, resolvedPersonaInstances) as unknown as ResolvedPersonaContent;
}

function hasOwnFrozenBrand(
  value: unknown,
  brand: symbol,
  instances: WeakSet<object>,
): value is Record<PropertyKey, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    !instances.has(value) ||
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
  if (!hasOwnFrozenBrand(value, resolvedCommandBrand, resolvedCommandInstances)) return false;
  try {
    const allowedSymbols = new Set([resolvedCommandBrand]);
    const record = requireObject(value, "command", allowedSymbols);
    assertOnlyKeys(record, ["template", "argumentInput", "content", "source", "extensions"], "command", allowedSymbols);
    const template = requireOwn(record, "template", "command");
    const content = requireOwn(record, "content", "command");
    const source = requireOwn(record, "source", "command");
    if (typeof template !== "string" || typeof content !== "string") return false;
    if (Object.hasOwn(record, "argumentInput") && typeof record.argumentInput !== "string") return false;
    if (source !== null) decodeExecutionSourceIdentity(source, "command.source");
    if (Object.hasOwn(record, "extensions")) cloneAdapterExtensions(record.extensions, "command.extensions");
    return true;
  } catch {
    return false;
  }
}

function isResolvedPersona(value: unknown): value is ResolvedPersonaContent {
  if (!hasOwnFrozenBrand(value, resolvedPersonaBrand, resolvedPersonaInstances)) return false;
  try {
    const allowedSymbols = new Set([resolvedPersonaBrand]);
    const record = requireObject(value, "persona", allowedSymbols);
    assertOnlyKeys(record, ["content", "source", "extensions"], "persona", allowedSymbols);
    if (typeof requireOwn(record, "content", "persona") !== "string") return false;
    decodeExecutionSourceIdentity(requireOwn(record, "source", "persona"), "persona.source");
    if (Object.hasOwn(record, "extensions")) cloneAdapterExtensions(record.extensions, "persona.extensions");
    return true;
  } catch {
    return false;
  }
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${path} must be a non-empty string`);
  return value;
}

function cloneEngine(input: ResolvedEngineSelection): Readonly<ResolvedEngineSelection> {
  const record = requireObject(input, "engine");
  assertOnlyKeys(record, ["name", "kind", "platform", "settings", "extensions"], "engine");
  const name = requireString(requireOwn(record, "name", "engine"), "engine.name");
  const kind = requireOwn(record, "kind", "engine");
  if (!(kind === "agent" || kind === "sdk" || kind === "llm")) throw new TypeError("engine.kind is invalid");
  const out: Record<string, unknown> = { name, kind };
  for (const key of ["platform", "settings", "extensions"] as const) {
    if (!Object.hasOwn(record, key)) continue;
    const value = record[key];
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
  const modelInput = requireString(requireOwn(record, "input", "model"), "model.input");
  const interpretation = requireOwn(record, "interpretation", "model");
  const resolved = requireString(requireOwn(record, "resolved", "model"), "model.resolved");
  if (interpretation !== "alias" && interpretation !== "exact") {
    throw new TypeError("model.interpretation is invalid");
  }
  if (interpretation === "exact" && modelInput !== resolved) {
    throw new TypeError("model.input must match model.resolved when interpretation is exact");
  }
  const out: Record<string, unknown> = {
    input: modelInput,
    interpretation,
    resolved,
  };
  if (Object.hasOwn(record, "extensions")) {
    if (record.extensions === null || record.extensions === undefined) {
      throw new TypeError("model.extensions must be omitted or an adapter-owned extension object");
    }
    out.extensions = cloneAdapterExtensions(record.extensions, "model.extensions");
  }
  return Object.freeze(out) as unknown as Readonly<ResolvedModelSelection>;
}

function cloneAuthorization(input: ToolAuthorizationResult): Readonly<ToolAuthorizationResult> {
  const record = requireObject(input, "authorization");
  assertOnlyKeys(record, ["status", "reason", "policy"], "authorization");
  const status = requireOwn(record, "status", "authorization");
  if (!(status === "allowed" || status === "denied" || status === "not-required")) {
    throw new TypeError("authorization.status is invalid");
  }
  const out: Record<string, unknown> = { status };
  if (Object.hasOwn(record, "reason")) {
    if (record.reason !== null && typeof record.reason !== "string") {
      throw new TypeError("authorization.reason must be a string or null");
    }
    out.reason = record.reason;
  }
  if (Object.hasOwn(record, "policy")) {
    out.policy = record.policy === null ? null : cloneExecutionJsonObject(record.policy, "authorization.policy");
  }
  return Object.freeze(out) as unknown as Readonly<ToolAuthorizationResult>;
}

function cloneRuntime(input: ResolvedRuntimeSettings): Readonly<ResolvedRuntimeSettings> {
  const record = requireObject(input, "runtime");
  assertOnlyKeys(record, ["timeoutMs", "workspace", "environment", "settings", "extensions"], "runtime");
  const out: Record<string, unknown> = {};
  if (Object.hasOwn(record, "timeoutMs")) {
    const timeoutMs = record.timeoutMs;
    if (
      timeoutMs !== null &&
      (typeof timeoutMs !== "number" ||
        !Number.isInteger(timeoutMs) ||
        timeoutMs < 0 ||
        timeoutMs > EXECUTION_MAX_TIMEOUT_MS)
    ) {
      throw new TypeError(`runtime.timeoutMs must be null or an integer from 0 through ${EXECUTION_MAX_TIMEOUT_MS}`);
    }
    out.timeoutMs = timeoutMs;
  }
  if (Object.hasOwn(record, "workspace")) {
    if (record.workspace !== null && typeof record.workspace !== "string") {
      throw new TypeError("runtime.workspace must be a string or null");
    }
    out.workspace = record.workspace;
  }
  if (Object.hasOwn(record, "environment")) {
    if (record.environment === null) out.environment = null;
    else {
      const environment = cloneExecutionJsonObject(record.environment, "runtime.environment");
      if (Object.values(environment).some((value) => typeof value !== "string")) {
        throw new TypeError("runtime.environment values must be strings");
      }
      out.environment = environment;
    }
  }
  if (Object.hasOwn(record, "settings")) {
    out.settings = record.settings === null ? null : cloneExecutionJsonObject(record.settings, "runtime.settings");
  }
  if (Object.hasOwn(record, "extensions")) {
    out.extensions = cloneAdapterExtensions(record.extensions, "runtime.extensions");
  }
  return Object.freeze(out) as unknown as Readonly<ResolvedRuntimeSettings>;
}

function cloneNotice(input: LoweringNotice, index: number): Readonly<LoweringNotice> {
  const path = `notices[${index}]`;
  const record = requireObject(input, path);
  assertOnlyKeys(record, ["code", "severity", "adapter", "field", "message", "details"], path);
  const code = requireString(requireOwn(record, "code", path), `${path}.code`);
  const severity = requireOwn(record, "severity", path);
  const adapter = requireString(requireOwn(record, "adapter", path), `${path}.adapter`);
  const message = requireString(requireOwn(record, "message", path), `${path}.message`);
  if (severity !== "info" && severity !== "warning") {
    throw new TypeError(`notices[${index}].severity is invalid`);
  }
  const out: Record<string, unknown> = {
    code,
    severity,
    adapter,
    message,
  };
  if (Object.hasOwn(record, "field")) {
    if (record.field !== null && typeof record.field !== "string") {
      throw new TypeError(`notices[${index}].field must be a string or null`);
    }
    out.field = record.field;
  }
  if (Object.hasOwn(record, "details")) {
    out.details = record.details === null ? null : cloneExecutionJsonObject(record.details, `${path}.details`);
  }
  return Object.freeze(out) as unknown as Readonly<LoweringNotice>;
}

function cloneConversation(input: unknown, path = "conversation"): readonly Readonly<ResolvedConversationMessage>[] {
  const cloned = cloneExecutionJson(input, path);
  if (!Array.isArray(cloned)) throw new TypeError(`${path} must be an array`);
  return Object.freeze(
    cloned.map((message, index) => {
      const messagePath = `${path}[${index}]`;
      const record = requireObject(message, messagePath);
      assertOnlyKeys(record, ["role", "content"], messagePath);
      const role = requireOwn(record, "role", messagePath);
      const content = requireOwn(record, "content", messagePath);
      if (role !== "system" && role !== "user" && role !== "assistant") {
        throw new TypeError(`${messagePath}.role must be system, user, or assistant`);
      }
      if (typeof content !== "string") throw new TypeError(`${messagePath}.content must be a string`);
      return Object.freeze({ role, content });
    }),
  );
}

function cloneResolvedCommandLeaf(input: ResolvedCommandContent): ResolvedCommandContent {
  if (!isResolvedCommand(input)) throw new TypeError("command must be constructed by the execution boundary");
  const allowedSymbols = new Set([resolvedCommandBrand]);
  const record = requireObject(input, "command", allowedSymbols);
  assertOnlyKeys(record, ["template", "argumentInput", "content", "source", "extensions"], "command", allowedSymbols);
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
  copyArgumentInput(record, out);
  if (Object.hasOwn(record, "extensions")) {
    out.extensions = cloneAdapterExtensions(record.extensions, "command.extensions");
  }
  return defineBrand(out, resolvedCommandBrand, resolvedCommandInstances) as unknown as ResolvedCommandContent;
}

function cloneResolvedPersonaLeaf(input: ResolvedPersonaContent): ResolvedPersonaContent {
  if (!isResolvedPersona(input)) throw new TypeError("persona must be constructed by the execution boundary");
  const allowedSymbols = new Set([resolvedPersonaBrand]);
  const record = requireObject(input, "persona", allowedSymbols);
  assertOnlyKeys(record, ["content", "source", "extensions"], "persona", allowedSymbols);
  const content = requireOwn(record, "content", "persona");
  if (typeof content !== "string") throw new TypeError("persona.content must be a string");
  const out: Record<string, unknown> = {
    content,
    source: decodeExecutionSourceIdentity(requireOwn(record, "source", "persona"), "persona.source"),
  };
  if (Object.hasOwn(record, "extensions")) {
    out.extensions = cloneAdapterExtensions(record.extensions, "persona.extensions");
  }
  return defineBrand(out, resolvedPersonaBrand, resolvedPersonaInstances) as unknown as ResolvedPersonaContent;
}

/** Revalidate and detach one command leaf before any caller dereferences it. */
export function cloneResolvedCommandContent(input: ResolvedCommandContent): ResolvedCommandContent {
  return cloneResolvedCommandLeaf(input);
}

/** Revalidate and detach one persona leaf before any caller dereferences it. */
export function cloneResolvedPersonaContent(input: ResolvedPersonaContent): ResolvedPersonaContent {
  return cloneResolvedPersonaLeaf(input);
}

function cloneAgentSelector(input: unknown, path: string): string | null {
  if (input === null) return null;
  return requireStableExecutionSelector(input, path);
}

function assertAgentPersonaInvariant(request: Record<string, unknown>, path: string): void {
  if (!Object.hasOwn(request, "agent")) return;
  if (!Object.hasOwn(request, "persona")) {
    throw new TypeError(`${path}.persona must be present when ${path}.agent is selected or explicitly null`);
  }
  const agent = request.agent as string | null;
  const persona = request.persona as ResolvedPersonaContent | null;
  if (agent === null) {
    if (persona !== null) throw new TypeError(`${path}.agent null requires ${path}.persona null`);
    return;
  }
  if (isPortableExecutionAgentSelector(agent)) {
    if (persona === null || !executionPersonaMatchesSelector(agent, persona.source.ref)) {
      throw new TypeError(`${path}.agent portable selector must match the non-null persona source`);
    }
    return;
  }
  if (persona !== null) {
    throw new TypeError(`${path}.agent native selector requires ${path}.persona null`);
  }
}

export type ResolvedExecutionRequestInput = Omit<ResolvedExecutionRequestV1, "schemaVersion">;

/** Validate and freeze one request without normalizing away optional-field presence. */
export function createResolvedExecutionRequest(input: ResolvedExecutionRequestInput): ResolvedExecutionRequestV1 {
  const record = requireObject(input, "resolved execution request input");
  assertOnlyKeys(
    record,
    [
      "command",
      "conversation",
      "agent",
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
  if (Object.hasOwn(record, "conversation")) out.conversation = cloneConversation(record.conversation);
  if (Object.hasOwn(record, "agent")) {
    if (record.agent === undefined) throw new TypeError("agent must be omitted, null, or a selected agent string");
    out.agent = cloneAgentSelector(record.agent, "agent");
  }
  if (Object.hasOwn(record, "persona")) {
    if (record.persona !== null && !isResolvedPersona(record.persona)) {
      throw new TypeError("persona must be null or constructed by the execution boundary");
    }
    out.persona = record.persona === null ? null : cloneResolvedPersonaLeaf(record.persona);
  }
  assertAgentPersonaInvariant(out, "resolved execution request");
  if (Object.hasOwn(record, "model")) {
    if (record.model === undefined) throw new TypeError("model must be omitted, null, or a model selection");
    out.model = record.model === null ? null : cloneModel(record.model as ResolvedModelSelection);
  }
  if (Object.hasOwn(record, "inference")) {
    out.inference = record.inference === null ? null : cloneExecutionJsonObject(record.inference, "inference");
  }
  if (Object.hasOwn(record, "outputSchema")) {
    out.outputSchema =
      record.outputSchema === null ? null : cloneExecutionJsonObject(record.outputSchema, "outputSchema");
  }
  if (Object.hasOwn(record, "tools")) out.tools = cloneToolSelection(record.tools, "tools");
  const toolsRequireAuthorization = toolSelectionRequiresAuthorization(out.tools, Object.hasOwn(out, "tools"));
  const authorizationStatus = (out.authorization as ToolAuthorizationResult).status;
  if (toolsRequireAuthorization && authorizationStatus === "not-required") {
    throw new TypeError("authorization.status not-required is valid only when no tools are selected");
  }
  if (!toolsRequireAuthorization && authorizationStatus !== "not-required") {
    throw new TypeError("empty or omitted tool selection requires authorization.status not-required");
  }
  if (Object.hasOwn(record, "extensions")) {
    out.extensions = cloneAdapterExtensions(record.extensions, "request.extensions");
  }
  const frozen = Object.freeze(out) as unknown as ResolvedExecutionRequestV1;
  resolvedRequestInstances.add(frozen);
  return frozen;
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

function requireObject(
  value: unknown,
  path: string,
  allowedSymbols: ReadonlySet<symbol> = new Set(),
): StrictRecordSnapshot {
  return snapshotStrictRecord(value, path, { allowedSymbols });
}

function assertOnlyKeys(
  value: StrictRecordSnapshot,
  allowed: readonly string[],
  path: string,
  allowedSymbols: ReadonlySet<symbol> = new Set(),
): void {
  assertSnapshotKeys(value, allowed, path, allowedSymbols);
}

function requireOwn(value: StrictRecordSnapshot, key: string, path: string): unknown {
  return requireSnapshotField(value, key, path);
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
  return defineBrand(out, resolvedCommandBrand, resolvedCommandInstances) as unknown as ResolvedCommandContent;
}

function decodeResolvedPersona(value: unknown): ResolvedPersonaContent {
  const input = requireObject(value, "persona");
  assertOnlyKeys(input, ["content", "source", "extensions"], "persona");
  const content = requireOwn(input, "content", "persona");
  if (typeof content !== "string") throw new TypeError("persona.content must be a string");
  const source = decodeExecutionSourceIdentity(requireOwn(input, "source", "persona"), "persona.source");
  const out: Record<string, unknown> = { content, source };
  if (Object.hasOwn(input, "extensions")) out.extensions = decodeExtensions(input.extensions, "persona.extensions");
  return defineBrand(out, resolvedPersonaBrand, resolvedPersonaInstances) as unknown as ResolvedPersonaContent;
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
      "conversation",
      "agent",
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
  if (Object.hasOwn(input, "conversation")) {
    request.conversation = cloneConversation(input.conversation, "resolved execution request.conversation");
  }
  if (Object.hasOwn(input, "agent")) {
    request.agent = cloneAgentSelector(input.agent, "resolved execution request.agent");
  }
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

function projectIdentity(identity: Readonly<ExecutionSourceIdentity>): Record<string, unknown> {
  return {
    ref: identity.ref,
    bundle: identity.bundle,
    adapter: identity.adapter,
    file: identity.file,
    hash: identity.hash,
  };
}

function projectCommand(command: ResolvedCommandContent): Record<string, unknown> {
  const out: Record<string, unknown> = {
    template: command.template,
    content: command.content,
    source: command.source === null ? null : projectIdentity(command.source),
  };
  if (Object.hasOwn(command, "argumentInput")) out.argumentInput = command.argumentInput;
  if (Object.hasOwn(command, "extensions")) out.extensions = command.extensions;
  return out;
}

function projectPersona(persona: ResolvedPersonaContent): Record<string, unknown> {
  const out: Record<string, unknown> = { content: persona.content, source: projectIdentity(persona.source) };
  if (Object.hasOwn(persona, "extensions")) out.extensions = persona.extensions;
  return out;
}

function projectEngine(engine: Readonly<ResolvedEngineSelection>): Record<string, unknown> {
  const out: Record<string, unknown> = { name: engine.name, kind: engine.kind };
  for (const key of ["platform", "settings", "extensions"] as const) {
    if (Object.hasOwn(engine, key)) out[key] = engine[key];
  }
  return out;
}

function projectModel(model: Readonly<ResolvedModelSelection>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    input: model.input,
    interpretation: model.interpretation,
    resolved: model.resolved,
  };
  if (Object.hasOwn(model, "extensions")) out.extensions = model.extensions;
  return out;
}

function projectAuthorization(authorization: Readonly<ToolAuthorizationResult>): Record<string, unknown> {
  const out: Record<string, unknown> = { status: authorization.status };
  for (const key of ["reason", "policy"] as const) {
    if (Object.hasOwn(authorization, key)) out[key] = authorization[key];
  }
  return out;
}

function projectRuntime(runtime: Readonly<ResolvedRuntimeSettings>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["timeoutMs", "workspace", "environment", "settings", "extensions"] as const) {
    if (Object.hasOwn(runtime, key)) out[key] = runtime[key];
  }
  return out;
}

function projectNotice(notice: Readonly<LoweringNotice>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    code: notice.code,
    severity: notice.severity,
    adapter: notice.adapter,
    message: notice.message,
  };
  for (const key of ["field", "details"] as const) {
    if (Object.hasOwn(notice, key)) out[key] = notice[key];
  }
  return out;
}

function projectConversationMessage(message: Readonly<ResolvedConversationMessage>): Record<string, unknown> {
  return { role: message.role, content: message.content };
}

function projectResolvedExecutionWire(request: ResolvedExecutionRequestV1): Record<string, unknown> {
  const out: Record<string, unknown> = {
    schemaVersion: RESOLVED_EXECUTION_SCHEMA_VERSION,
    command: projectCommand(request.command),
    engine: projectEngine(request.engine),
    authorization: projectAuthorization(request.authorization),
    runtime: projectRuntime(request.runtime),
    notices: request.notices.map(projectNotice),
  };
  if (Object.hasOwn(request, "conversation")) {
    if (request.conversation === undefined) {
      throw new TypeError("constructed request conversation cannot be undefined");
    }
    out.conversation = request.conversation.map(projectConversationMessage);
  }
  if (Object.hasOwn(request, "agent")) {
    if (request.agent === undefined) throw new TypeError("constructed request agent cannot be undefined");
    out.agent = request.agent;
  }
  if (Object.hasOwn(request, "persona")) {
    if (request.persona === undefined) throw new TypeError("constructed request persona cannot be undefined");
    out.persona = request.persona === null ? null : projectPersona(request.persona);
  }
  if (Object.hasOwn(request, "model")) {
    if (request.model === undefined) throw new TypeError("constructed request model cannot be undefined");
    out.model = request.model === null ? null : projectModel(request.model);
  }
  for (const key of ["inference", "outputSchema", "tools", "extensions"] as const) {
    if (Object.hasOwn(request, key)) out[key] = request[key];
  }
  return out;
}

function encodeResolvedExecutionWire(request: ResolvedExecutionRequestV1): string {
  const json = cloneExecutionJson(projectResolvedExecutionWire(request), "resolved execution request wire DTO");
  return `${JSON.stringify(sortExecutionJson(json))}\n`;
}

/** Stable bytes for freeze hashes and entrypoint-equivalence projections. */
export function canonicalResolvedExecutionRequest(request: ResolvedExecutionRequestV1): string {
  if (typeof request !== "object" || request === null || !resolvedRequestInstances.has(request)) {
    throw new TypeError("resolved execution request must be constructed by the execution boundary");
  }
  const canonical = encodeResolvedExecutionWire(request);
  const decoded = decodeResolvedExecutionRequest(JSON.parse(canonical));
  if (encodeResolvedExecutionWire(decoded) !== canonical) {
    throw new TypeError("resolved execution request failed canonical decode/re-encode validation");
  }
  return canonical;
}
