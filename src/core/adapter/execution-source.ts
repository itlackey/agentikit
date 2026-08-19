// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import { isMap, isScalar, parseDocument, visit } from "yaml";
import {
  cloneExecutionJson,
  cloneExecutionJsonObject,
  type ExecutionJsonObject,
  type ExecutionJsonValue,
} from "../../execution/json";
import {
  type AdapterOwnedExtensions,
  type AdapterRenderedCommandSource,
  type AdapterRenderedExecutionSource,
  type AdapterRenderedPersonaSource,
  cloneToolSelection,
  createAdapterRenderedExecutionSource,
  type ExecutionSourceIdentity,
  type UnresolvedExecutionDefaults,
} from "../../execution/source";

interface ParsedExecutionMarkdown {
  readonly content: string;
  readonly data: Readonly<Record<string, unknown>>;
}

function nextLine(text: string, start: number): { line: string; next: number } {
  const lf = text.indexOf("\n", start);
  if (lf < 0) return { line: text.slice(start), next: text.length };
  const end = lf > start && text[lf - 1] === "\r" ? lf - 1 : lf;
  return { line: text.slice(start, end), next: lf + 1 };
}

/** Strict execution-only frontmatter parser; indexing's tolerant parser is deliberately not reused. */
export function parseExecutionMarkdown(raw: string): ParsedExecutionMarkdown {
  if (typeof raw !== "string") throw new TypeError("execution source raw content must be a string");
  const withoutBom = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
  const opening = nextLine(withoutBom, 0);
  if (opening.line !== "---") return { content: raw, data: Object.freeze({}) };
  if (opening.next === withoutBom.length) {
    throw new TypeError("execution source has unterminated frontmatter");
  }

  let cursor = opening.next;
  let frontmatterEnd = -1;
  let bodyStart = -1;
  while (cursor <= withoutBom.length) {
    const lineStart = cursor;
    const current = nextLine(withoutBom, cursor);
    if (current.line === "---") {
      frontmatterEnd = lineStart;
      bodyStart = current.next;
      break;
    }
    if (current.next === cursor || current.next === withoutBom.length) break;
    cursor = current.next;
  }
  if (frontmatterEnd < 0 || bodyStart < 0) {
    throw new TypeError("execution source has unterminated frontmatter");
  }

  const yaml = withoutBom.slice(opening.next, frontmatterEnd);
  const document = parseDocument(yaml, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new TypeError(
      `execution source has invalid YAML frontmatter: ${document.errors[0]?.message ?? "parse error"}`,
    );
  }
  if (document.warnings.length > 0) {
    throw new TypeError(
      `execution source YAML frontmatter uses an unsupported tag or construct: ${document.warnings[0]?.message}`,
    );
  }
  if (!isMap(document.contents)) {
    throw new TypeError("execution source YAML frontmatter must be a mapping");
  }

  let unsupported: string | undefined;
  visit(document, {
    Alias: () => {
      unsupported ??= "aliases";
    },
    Node: (_key, node) => {
      if (node.tag) unsupported ??= "custom or explicit tags";
      if ((node as { anchor?: unknown }).anchor !== undefined) unsupported ??= "anchors";
    },
    Pair: (_key, pair) => {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") unsupported ??= "non-string mapping keys";
    },
  });
  if (unsupported) throw new TypeError(`execution source YAML frontmatter does not support ${unsupported}`);

  let root: unknown;
  try {
    root = document.toJS({ maxAliasCount: 0 });
  } catch (cause) {
    throw new TypeError("execution source YAML frontmatter could not be converted safely", { cause });
  }
  const data = cloneExecutionJsonObject(root, "execution source YAML frontmatter");
  return { content: withoutBom.slice(bodyStart), data: Object.freeze(data) };
}

function own(data: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.hasOwn(data, key);
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function stringOrNull(value: unknown): string | null | undefined {
  return value === null || typeof value === "string" ? value : undefined;
}

/** Adapter helper for the common frontmatter fields fixed by the 0.9.2 design. */
export function executionDefaultsFromFrontmatter(
  data: Readonly<Record<string, unknown>>,
  options: {
    readonly kind: "command" | "persona";
    readonly allowTopLevelEngine?: boolean;
    readonly toolsKeys?: readonly string[];
  },
): UnresolvedExecutionDefaults {
  const namespace = record(data.akm) ?? {};
  const out = Object.create(null) as Record<string, unknown>;
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
    out.tools = cloneToolSelection(data[key], `frontmatter.${key}`);
    break;
  }

  const inferenceEntries = new Map<string, ExecutionJsonValue>();
  const namespacedInference = record(namespace.inference);
  if (namespacedInference) {
    for (const [key, value] of Object.entries(
      cloneExecutionJsonObject(namespacedInference, "frontmatter.akm.inference"),
    )) {
      inferenceEntries.set(key, value);
    }
  }
  for (const key of ["temperature", "effort"] as const) {
    if (own(data, key)) inferenceEntries.set(key, cloneExecutionJson(data[key], `frontmatter.${key}`));
  }
  if (inferenceEntries.size > 0) out.inference = Object.fromEntries(inferenceEntries);

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
  return out as UnresolvedExecutionDefaults;
}

type DefaultsProjection =
  | UnresolvedExecutionDefaults
  | ((data: Readonly<Record<string, unknown>>) => UnresolvedExecutionDefaults);
type ExtensionsProjection =
  | AdapterOwnedExtensions
  | ((data: Readonly<Record<string, unknown>>) => AdapterOwnedExtensions | undefined);

export interface RenderMarkdownExecutionSourceInput {
  readonly kind: "command" | "persona";
  /** Authoritative native text; the identity hash covers these exact original UTF-8 bytes. */
  readonly raw: string;
  readonly identity: Omit<ExecutionSourceIdentity, "hash">;
  readonly defaults?: DefaultsProjection;
  readonly extensions?: ExtensionsProjection;
}

function assertRendererKeys(input: RenderMarkdownExecutionSourceInput): void {
  if (input === null || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new TypeError("adapter execution source must be a plain object");
  }
  const allowed = new Set(["kind", "raw", "identity", "defaults", "extensions"]);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`adapter execution source contains unsupported field: ${String(key)}`);
    }
  }
  if (
    input.identity === null ||
    typeof input.identity !== "object" ||
    Object.getPrototypeOf(input.identity) !== Object.prototype
  ) {
    throw new TypeError("adapter execution source identity must be a plain object");
  }
  const identityKeys = new Set(["ref", "bundle", "adapter", "file"]);
  for (const key of Reflect.ownKeys(input.identity)) {
    if (typeof key !== "string" || !identityKeys.has(key)) {
      throw new TypeError(`adapter execution source identity contains unsupported field: ${String(key)}`);
    }
  }
}

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
  assertRendererKeys(input);
  const parsed = parseExecutionMarkdown(input.raw);
  const hasDefaults = Object.hasOwn(input, "defaults");
  const defaults = typeof input.defaults === "function" ? input.defaults(parsed.data) : input.defaults;
  if (hasDefaults && defaults === undefined) {
    throw new TypeError("adapter execution source defaults must be omitted or resolve to an object");
  }
  const extensionsAreProjected = typeof input.extensions === "function";
  const extensions = extensionsAreProjected ? input.extensions(parsed.data) : input.extensions;
  if (Object.hasOwn(input, "extensions") && !extensionsAreProjected && extensions === undefined) {
    throw new TypeError("adapter execution source extensions must be omitted or be an adapter-owned extension object");
  }
  return createAdapterRenderedExecutionSource({
    kind: input.kind,
    content: parsed.content,
    identity: {
      ...input.identity,
      hash: createHash("sha256").update(input.raw, "utf8").digest("hex"),
    },
    ...(hasDefaults ? { defaults } : {}),
    ...(extensions === undefined ? {} : { extensions }),
  });
}
