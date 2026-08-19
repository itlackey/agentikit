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
import { assertSnapshotKeys, type StrictRecordSnapshot, snapshotStrictRecord } from "../../execution/record";
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
  if (opening.line !== "---") return { content: withoutBom, data: Object.freeze({}) };
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

function own(data: StrictRecordSnapshot, key: string): boolean {
  return Object.hasOwn(data, key);
}

function requireMetadataMapping(value: unknown, path: string): StrictRecordSnapshot {
  try {
    return snapshotStrictRecord(value, path);
  } catch (cause) {
    throw new TypeError(`${path} must be a mapping with enumerable data fields`, { cause });
  }
}

function nullableString(value: unknown, path: string): string | null {
  if (value !== null && typeof value !== "string") throw new TypeError(`${path} must be a string or null`);
  return value;
}

function nullableObject(value: unknown, path: string): ExecutionJsonObject | null {
  return value === null ? null : cloneExecutionJsonObject(value, path);
}

function nullableEnvironment(value: unknown, path: string): ExecutionJsonObject | null {
  if (value === null) return null;
  const environment = cloneExecutionJsonObject(value, path);
  if (Object.values(environment).some((entry) => typeof entry !== "string")) {
    throw new TypeError(`${path} values must be strings`);
  }
  return environment;
}

function nullableTimeout(value: unknown, path: string): string | number | null {
  const timeout = cloneExecutionJson(value, path);
  if (timeout !== null && typeof timeout !== "string" && typeof timeout !== "number") {
    throw new TypeError(`${path} must be a string, number, or null`);
  }
  return timeout;
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
  const frontmatter = snapshotStrictRecord(data, "frontmatter");
  const optionRecord = snapshotStrictRecord(options, "execution frontmatter projection options");
  assertSnapshotKeys(
    optionRecord,
    ["kind", "allowTopLevelEngine", "toolsKeys"],
    "execution frontmatter projection options",
  );
  const kind = optionRecord.kind;
  if (kind !== "command" && kind !== "persona") {
    throw new TypeError("execution frontmatter projection options.kind is invalid");
  }
  const allowTopLevelEngine = Object.hasOwn(optionRecord, "allowTopLevelEngine")
    ? optionRecord.allowTopLevelEngine
    : false;
  if (typeof allowTopLevelEngine !== "boolean") {
    throw new TypeError("execution frontmatter projection options.allowTopLevelEngine must be a boolean");
  }
  const configuredToolsKeys = Object.hasOwn(optionRecord, "toolsKeys")
    ? cloneExecutionJson(optionRecord.toolsKeys, "execution frontmatter projection options.toolsKeys")
    : ["tools"];
  if (!Array.isArray(configuredToolsKeys) || configuredToolsKeys.some((key) => typeof key !== "string" || !key)) {
    throw new TypeError("execution frontmatter projection options.toolsKeys must be an array of non-empty strings");
  }

  const namespace = own(frontmatter, "akm")
    ? requireMetadataMapping(frontmatter.akm, "frontmatter.akm")
    : snapshotStrictRecord({}, "frontmatter.akm");
  const out = Object.create(null) as Record<string, unknown>;
  if (kind === "command" && own(frontmatter, "agent")) {
    out.agent = nullableString(frontmatter.agent, "frontmatter.agent");
  }
  const namespacedEngine = own(namespace, "engine")
    ? nullableString(namespace.engine, "frontmatter.akm.engine")
    : undefined;
  const topLevelEngine =
    allowTopLevelEngine && own(frontmatter, "engine")
      ? nullableString(frontmatter.engine, "frontmatter.engine")
      : undefined;
  if (topLevelEngine !== undefined) out.engine = topLevelEngine;
  else if (namespacedEngine !== undefined) out.engine = namespacedEngine;
  if (own(frontmatter, "model")) {
    out.model = nullableString(frontmatter.model, "frontmatter.model");
  }
  let toolsSelected = false;
  for (const key of configuredToolsKeys) {
    if (!own(frontmatter, key)) continue;
    const selection = cloneToolSelection(frontmatter[key], `frontmatter.${key}`);
    if (!toolsSelected) {
      out.tools = selection;
      toolsSelected = true;
    }
  }

  let inferenceEntries: Map<string, ExecutionJsonValue> | null | undefined;
  if (own(namespace, "inference")) {
    if (namespace.inference === null) inferenceEntries = null;
    else {
      inferenceEntries = new Map();
      for (const [key, value] of Object.entries(
        cloneExecutionJsonObject(namespace.inference, "frontmatter.akm.inference"),
      )) {
        inferenceEntries.set(key, value);
      }
    }
  }
  for (const key of ["temperature", "effort"] as const) {
    if (!own(frontmatter, key)) continue;
    if (inferenceEntries === null) {
      throw new TypeError(`frontmatter.${key} conflicts with explicit null frontmatter.akm.inference`);
    }
    inferenceEntries ??= new Map();
    const value = frontmatter[key];
    if (key === "temperature") {
      if (value !== null && typeof value !== "number") {
        throw new TypeError("frontmatter.temperature must be a number or null");
      }
    } else if (value !== null && typeof value !== "string") {
      throw new TypeError("frontmatter.effort must be a string or null");
    }
    inferenceEntries.set(key, cloneExecutionJson(value, `frontmatter.${key}`));
  }
  if (inferenceEntries === null) out.inference = null;
  else if (inferenceEntries !== undefined) out.inference = Object.fromEntries(inferenceEntries);

  const namespacedSchema = own(namespace, "schema")
    ? nullableObject(namespace.schema, "frontmatter.akm.schema")
    : undefined;
  const topLevelSchema = own(frontmatter, "schema")
    ? nullableObject(frontmatter.schema, "frontmatter.schema")
    : undefined;
  if (topLevelSchema !== undefined) out.outputSchema = topLevelSchema;
  else if (namespacedSchema !== undefined) out.outputSchema = namespacedSchema;

  const namespacedTimeouts = new Map<string, string | number | null>();
  for (const key of ["timeoutMs", "timeout"] as const) {
    if (own(namespace, key)) {
      namespacedTimeouts.set(key, nullableTimeout(namespace[key], `frontmatter.akm.${key}`));
    }
  }
  const topLevelTimeouts = new Map<string, string | number | null>();
  if (allowTopLevelEngine) {
    for (const key of ["timeoutMs", "timeout"] as const) {
      if (own(frontmatter, key)) {
        topLevelTimeouts.set(key, nullableTimeout(frontmatter[key], `frontmatter.${key}`));
      }
    }
  }
  const timeoutKey = namespacedTimeouts.has("timeoutMs")
    ? "timeoutMs"
    : namespacedTimeouts.has("timeout")
      ? "timeout"
      : undefined;
  const topLevelTimeoutKey = allowTopLevelEngine
    ? topLevelTimeouts.has("timeoutMs")
      ? "timeoutMs"
      : topLevelTimeouts.has("timeout")
        ? "timeout"
        : undefined
    : undefined;
  const selectedTimeoutKey = topLevelTimeoutKey ?? timeoutKey;
  if (selectedTimeoutKey) {
    out.timeout = topLevelTimeoutKey
      ? topLevelTimeouts.get(selectedTimeoutKey)
      : namespacedTimeouts.get(selectedTimeoutKey);
  }

  for (const key of ["workspace", "environment", "runtime"] as const) {
    const namespaced = own(namespace, key)
      ? key === "workspace"
        ? nullableString(namespace[key], `frontmatter.akm.${key}`)
        : key === "environment"
          ? nullableEnvironment(namespace[key], `frontmatter.akm.${key}`)
          : nullableObject(namespace[key], `frontmatter.akm.${key}`)
      : undefined;
    const topLevel =
      allowTopLevelEngine && own(frontmatter, key)
        ? key === "workspace"
          ? nullableString(frontmatter[key], `frontmatter.${key}`)
          : key === "environment"
            ? nullableEnvironment(frontmatter[key], `frontmatter.${key}`)
            : nullableObject(frontmatter[key], `frontmatter.${key}`)
        : undefined;
    if (topLevel !== undefined) out[key] = topLevel;
    else if (namespaced !== undefined) out[key] = namespaced;
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

function snapshotRendererInput(input: RenderMarkdownExecutionSourceInput): {
  readonly input: StrictRecordSnapshot;
  readonly identity: StrictRecordSnapshot;
} {
  const inputSnapshot = snapshotStrictRecord(input, "adapter execution source");
  assertSnapshotKeys(inputSnapshot, ["kind", "raw", "identity", "defaults", "extensions"], "adapter execution source");
  const identity = snapshotStrictRecord(inputSnapshot.identity, "adapter execution source identity");
  assertSnapshotKeys(identity, ["ref", "bundle", "adapter", "file"], "adapter execution source identity");
  return { input: inputSnapshot, identity };
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
  const snapshots = snapshotRendererInput(input);
  const raw = snapshots.input.raw;
  if (typeof raw !== "string") throw new TypeError("adapter execution source.raw must be a string");
  const kind = snapshots.input.kind;
  if (kind !== "command" && kind !== "persona") throw new TypeError("adapter execution source.kind is invalid");
  const parsed = parseExecutionMarkdown(raw);
  const hasDefaults = Object.hasOwn(snapshots.input, "defaults");
  const defaultsProjection = snapshots.input.defaults;
  const defaults = typeof defaultsProjection === "function" ? defaultsProjection(parsed.data) : defaultsProjection;
  if (hasDefaults && defaults === undefined) {
    throw new TypeError("adapter execution source defaults must be omitted or resolve to an object");
  }
  const extensionsProjection = snapshots.input.extensions;
  const extensionsAreProjected = typeof extensionsProjection === "function";
  const extensions = extensionsAreProjected ? extensionsProjection(parsed.data) : extensionsProjection;
  if (Object.hasOwn(snapshots.input, "extensions") && !extensionsAreProjected && extensions === undefined) {
    throw new TypeError("adapter execution source extensions must be omitted or be an adapter-owned extension object");
  }
  return createAdapterRenderedExecutionSource({
    kind,
    content: parsed.content,
    identity: {
      ref: snapshots.identity.ref as string,
      bundle: snapshots.identity.bundle as string,
      adapter: snapshots.identity.adapter as string,
      file: snapshots.identity.file as string,
      hash: createHash("sha256").update(raw, "utf8").digest("hex"),
    },
    ...(hasDefaults ? { defaults } : {}),
    ...(extensions === undefined ? {} : { extensions }),
  });
}
