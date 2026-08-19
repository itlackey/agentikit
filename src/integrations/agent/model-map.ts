// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Installed and operator-owned model intent aliases (#802 / WP2).
 *
 * This module deliberately does not replace the legacy dispatch call sites.
 * WP3 owns resolving the common cascade through this boundary. Keeping the
 * loader and expansion API independent lets direct, task, and workflow
 * callers adopt one implementation without hard-coding provider mappings.
 */
import fs from "node:fs";
import path from "node:path";
import defaultModelMap from "../../assets/models.json" with { type: "json" };
import { writeFileAtomic } from "../../core/common";
import { ENGINE_NAME_PATTERN_SOURCE } from "../../core/config/engine-semantics";
import { ConfigError, UsageError } from "../../core/errors";
import { getConfigDir } from "../../core/paths";
import { cloneExecutionJsonObject, type ExecutionJsonObject, type ExecutionJsonValue } from "../../execution/json";

export const MODEL_MAP_VERSION = 1 as const;
/** Canonical installed bytes, derived from the statically embedded JSON asset on every runtime. */
export const DEFAULT_MODEL_MAP_TEXT = `${JSON.stringify(defaultModelMap, null, 2)}\n`;

export interface ModelMapProfileLayer {
  readonly model?: string;
  readonly inference?: ExecutionJsonObject | null;
}

export type ModelMapEntryLayer = string | ModelMapProfileLayer;
export type ModelMapEngineLayer = Readonly<Record<string, ModelMapEntryLayer>>;

export interface ModelMapLayerV1 {
  readonly version: typeof MODEL_MAP_VERSION;
  readonly aliases: Readonly<Record<string, ModelMapEngineLayer>>;
}

export interface ResolvedModelMapProfile {
  readonly model: string;
  readonly inference?: ExecutionJsonObject | null;
}

export interface ResolvedModelMapV1 {
  readonly version: typeof MODEL_MAP_VERSION;
  readonly aliases: Readonly<Record<string, Readonly<Record<string, ResolvedModelMapProfile>>>>;
}

export interface ResolvedModelMapSelection {
  readonly input: string;
  readonly interpretation: "alias" | "exact";
  readonly model: string;
  readonly inference?: ExecutionJsonObject | null;
}

export interface ModelMapCompatibilityAliases {
  /** Existing `engines.<name>.modelAliases`; nearer than models.json files. */
  readonly engineAliases?: Readonly<Record<string, string>>;
  /** Existing config-root `modelAliases`; nearer than models.json files. */
  readonly globalAliases?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Optional compatibility tiers such as `llm`, checked after the engine. */
  readonly fallbackEngines?: readonly string[];
}

const ENGINE_KEY_PATTERN = new RegExp(ENGINE_NAME_PATTERN_SOURCE);
const ALIAS_KEY_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const RESERVED_MAP_KEYS = new Set(["__proto__", "constructor", "prototype", "tostring"]);

function assertSafeMapKey(key: string, source: string, jsonPath: string): void {
  if (RESERVED_MAP_KEYS.has(key.toLowerCase())) {
    invalid(source, jsonPath, "reserved prototype-like key is not allowed");
  }
}

function invalid(source: string, jsonPath: string, detail: string): never {
  throw new ConfigError(
    `Invalid ${source} at ${jsonPath}: ${detail}`,
    "INVALID_CONFIG_FILE",
    `Fix ${source}, or remove the optional user models.json to use AKM's installed defaults.`,
  );
}

function requireRecord(value: unknown, source: string, jsonPath: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalid(source, jsonPath, "expected a JSON object");
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  source: string,
  jsonPath: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) invalid(source, `${jsonPath}.${key}`, "unknown field");
  }
}

function requireNonemptyString(value: unknown, source: string, jsonPath: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    invalid(source, jsonPath, "expected a nonempty string without surrounding whitespace");
  }
  return value;
}

function freezeRecord<T>(entries: Iterable<readonly [string, T]>): Readonly<Record<string, T>> {
  const record = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) record[key] = value;
  return Object.freeze(record);
}

function ownValue<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

function parseProfileLayer(value: unknown, source: string, jsonPath: string): ModelMapEntryLayer {
  if (typeof value === "string") return requireNonemptyString(value, source, jsonPath);
  const record = requireRecord(value, source, jsonPath);
  assertOnlyKeys(record, ["model", "inference"], source, jsonPath);
  if (!Object.hasOwn(record, "model") && !Object.hasOwn(record, "inference")) {
    invalid(source, jsonPath, "structured profile must contain model and/or inference");
  }
  const out: { model?: string; inference?: ExecutionJsonObject | null } = {};
  if (Object.hasOwn(record, "model")) out.model = requireNonemptyString(record.model, source, `${jsonPath}.model`);
  if (Object.hasOwn(record, "inference")) {
    if (record.inference === null) out.inference = null;
    else {
      try {
        out.inference = cloneExecutionJsonObject(record.inference, `${source} ${jsonPath}.inference`);
      } catch (error) {
        invalid(source, `${jsonPath}.inference`, error instanceof Error ? error.message : String(error));
      }
    }
  }
  return Object.freeze(out);
}

/** Parse one installed or user layer. Partial structured profiles are valid at this stage. */
export function parseModelMapLayer(text: string, source: string): ModelMapLayerV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    invalid(source, "$", `invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = requireRecord(parsed, source, "$");
  assertOnlyKeys(root, ["version", "aliases"], source, "$");
  if (root.version !== MODEL_MAP_VERSION) {
    invalid(source, "$.version", `expected ${MODEL_MAP_VERSION}, received ${JSON.stringify(root.version)}`);
  }
  if (!Object.hasOwn(root, "aliases")) invalid(source, "$.aliases", "required field is missing");
  const rawAliases = requireRecord(root.aliases, source, "$.aliases");
  const aliases: Array<readonly [string, ModelMapEngineLayer]> = [];
  const aliasesSeen = new Map<string, string>();
  for (const [rawAlias, rawEngines] of Object.entries(rawAliases)) {
    const alias = rawAlias.toLowerCase();
    assertSafeMapKey(alias, source, `$.aliases.${rawAlias}`);
    if (!ALIAS_KEY_PATTERN.test(alias)) invalid(source, `$.aliases.${rawAlias}`, "alias must be lowercase kebab-case");
    const previous = aliasesSeen.get(alias);
    if (previous !== undefined) {
      invalid(source, `$.aliases.${rawAlias}`, `alias collides case-insensitively with ${previous}`);
    }
    aliasesSeen.set(alias, rawAlias);
    const engineRecord = requireRecord(rawEngines, source, `$.aliases.${rawAlias}`);
    if (Object.keys(engineRecord).length === 0) {
      invalid(source, `$.aliases.${rawAlias}`, "alias must contain at least one engine mapping");
    }
    const engines: Array<readonly [string, ModelMapEntryLayer]> = [];
    const enginesSeen = new Map<string, string>();
    for (const [rawEngine, rawProfile] of Object.entries(engineRecord)) {
      const engine = rawEngine === "*" ? rawEngine : rawEngine.toLowerCase();
      assertSafeMapKey(engine, source, `$.aliases.${rawAlias}.${rawEngine}`);
      if (engine !== "*" && !ENGINE_KEY_PATTERN.test(engine)) {
        invalid(source, `$.aliases.${rawAlias}.${rawEngine}`, "engine key must be lowercase kebab-case or *");
      }
      const previousEngine = enginesSeen.get(engine);
      if (previousEngine !== undefined) {
        invalid(
          source,
          `$.aliases.${rawAlias}.${rawEngine}`,
          `engine key collides case-insensitively with ${previousEngine}`,
        );
      }
      enginesSeen.set(engine, rawEngine);
      engines.push([engine, parseProfileLayer(rawProfile, source, `$.aliases.${rawAlias}.${rawEngine}`)]);
    }
    aliases.push([alias, freezeRecord(engines)]);
  }
  return Object.freeze({ version: MODEL_MAP_VERSION, aliases: freezeRecord(aliases) });
}

function isJsonObject(value: ExecutionJsonValue | undefined): value is ExecutionJsonObject {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);
}

function mergeJsonValue(base: ExecutionJsonValue | undefined, overlay: ExecutionJsonValue): ExecutionJsonValue {
  if (!isJsonObject(base) || !isJsonObject(overlay)) return overlay;
  const entries = new Map<string, ExecutionJsonValue>(Object.entries(base));
  for (const [key, value] of Object.entries(overlay)) entries.set(key, mergeJsonValue(entries.get(key), value));
  return Object.freeze(Object.fromEntries(entries));
}

function normalizeLayerEntry(entry: ModelMapEntryLayer): ModelMapProfileLayer {
  return typeof entry === "string" ? Object.freeze({ model: entry }) : entry;
}

function mergeProfiles(base: ModelMapProfileLayer | undefined, overlay: ModelMapEntryLayer): ModelMapProfileLayer {
  const next = normalizeLayerEntry(overlay);
  const out: { model?: string; inference?: ExecutionJsonObject | null } = {};
  if (base?.model !== undefined) out.model = base.model;
  if (base && Object.hasOwn(base, "inference")) out.inference = base.inference;
  if (next.model !== undefined) out.model = next.model;
  if (Object.hasOwn(next, "inference")) {
    out.inference =
      next.inference !== null && next.inference !== undefined && isJsonObject(base?.inference)
        ? (mergeJsonValue(base.inference, next.inference) as ExecutionJsonObject)
        : next.inference;
  }
  return Object.freeze(out);
}

/** Overlay user fields over installed fields, then enforce usable merged profiles. */
export function mergeModelMapLayers(installed: ModelMapLayerV1, user?: ModelMapLayerV1): ResolvedModelMapV1 {
  const aliases = new Map<string, Map<string, ModelMapProfileLayer>>();
  const apply = (layer: ModelMapLayerV1): void => {
    for (const [alias, engines] of Object.entries(layer.aliases)) {
      const mergedEngines = aliases.get(alias) ?? new Map<string, ModelMapProfileLayer>();
      for (const [engine, profile] of Object.entries(engines)) {
        mergedEngines.set(engine, mergeProfiles(mergedEngines.get(engine), profile));
      }
      aliases.set(alias, mergedEngines);
    }
  };
  apply(installed);
  if (user) apply(user);

  const resolvedAliases: Array<readonly [string, Readonly<Record<string, ResolvedModelMapProfile>>]> = [];
  for (const [alias, engines] of aliases) {
    const resolvedEngines: Array<readonly [string, ResolvedModelMapProfile]> = [];
    for (const [engine, profile] of engines) {
      if (profile.model === undefined) {
        invalid("merged models.json", `$.aliases.${alias}.${engine}.model`, "a usable model is required after overlay");
      }
      resolvedEngines.push([engine, Object.freeze({ ...profile, model: profile.model })]);
    }
    resolvedAliases.push([alias, freezeRecord(resolvedEngines)]);
  }
  return Object.freeze({ version: MODEL_MAP_VERSION, aliases: freezeRecord(resolvedAliases) });
}

function selectionFromProfile(
  input: string,
  profile: ResolvedModelMapProfile | ModelMapProfileLayer,
): ResolvedModelMapSelection {
  if (!profile.model) throw new ConfigError(`Model alias ${JSON.stringify(input)} does not resolve to a usable model.`);
  return Object.freeze({
    input,
    interpretation: "alias" as const,
    model: profile.model,
    ...(Object.hasOwn(profile, "inference") ? { inference: profile.inference } : {}),
  });
}

/** Expand through compatibility config first, then the merged installed/user registry. */
export function resolveModelMapAlias(
  input: string,
  engine: string,
  map: ResolvedModelMapV1,
  compatibility: ModelMapCompatibilityAliases = {},
): ResolvedModelMapSelection {
  const alias = input.toLowerCase();
  const selectedEngine = engine.toLowerCase();
  const engineOverride = ownValue(compatibility.engineAliases, alias);
  if (engineOverride !== undefined) return selectionFromProfile(input, { model: engineOverride });

  const fallbackEngines = (compatibility.fallbackEngines ?? []).map((fallback) => fallback.toLowerCase());
  const compatibilityTier = ownValue(compatibility.globalAliases, alias);
  const compatibilityModel =
    ownValue(compatibilityTier, selectedEngine) ??
    fallbackEngines.map((fallback) => ownValue(compatibilityTier, fallback)).find((model) => model !== undefined) ??
    ownValue(compatibilityTier, "*");
  if (compatibilityModel !== undefined) return selectionFromProfile(input, { model: compatibilityModel });

  const tier = ownValue(map.aliases, alias);
  const profile =
    ownValue(tier, selectedEngine) ??
    fallbackEngines.map((fallback) => ownValue(tier, fallback)).find((candidate) => candidate !== undefined) ??
    ownValue(tier, "*");
  if (profile !== undefined) return selectionFromProfile(input, profile);

  const known =
    tier !== undefined ||
    compatibilityTier !== undefined ||
    (compatibility.engineAliases !== undefined && Object.hasOwn(compatibility.engineAliases, alias));
  if (known) {
    throw new ConfigError(
      `Known alias ${JSON.stringify(input)} has no model mapping for selected engine ${JSON.stringify(engine)}.`,
      "INVALID_CONFIG_FILE",
      `Add $.aliases.${alias}.${engine} to models.json or configure engines.${engine}.modelAliases.${alias}.`,
    );
  }
  return Object.freeze({ input, interpretation: "exact" as const, model: input });
}

export function userModelMapPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getConfigDir(env), "models.json");
}

export interface LoadModelMapOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly installedText?: string;
}

export interface LoadedModelMap {
  readonly map: ResolvedModelMapV1;
  readonly userPath: string;
  readonly userStatus: "absent" | "loaded";
}

/** Load the embedded installed authority plus the optional operator overlay. */
export function loadModelMap(options: LoadModelMapOptions = {}): LoadedModelMap {
  const installed = parseModelMapLayer(options.installedText ?? DEFAULT_MODEL_MAP_TEXT, "installed models.json");
  const userPath = userModelMapPath(options.env);
  let user: ModelMapLayerV1 | undefined;
  let userText: string | undefined;
  try {
    userText = fs.readFileSync(userPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw new ConfigError(
        `Unable to read user models.json at ${userPath}: ${error instanceof Error ? error.message : String(error)}`,
        "INVALID_CONFIG_FILE",
        "Ensure models.json is a readable regular file, or remove it to use AKM's installed defaults.",
      );
    }
  }
  if (userText !== undefined) user = parseModelMapLayer(userText, `user models.json (${userPath})`);
  return Object.freeze({ map: mergeModelMapLayers(installed, user), userPath, userStatus: user ? "loaded" : "absent" });
}

export interface CopyDefaultModelMapOptions extends LoadModelMapOptions {
  readonly overwrite?: boolean;
}

export interface CopyDefaultModelMapResult {
  readonly path: string;
  readonly copied: true;
  readonly overwritten: boolean;
}

/** Explicitly copy validated installed bytes into the normal config directory. */
export function copyDefaultModelMap(options: CopyDefaultModelMapOptions = {}): CopyDefaultModelMapResult {
  const text = options.installedText ?? DEFAULT_MODEL_MAP_TEXT;
  mergeModelMapLayers(parseModelMapLayer(text, "installed models.json"));
  const target = userModelMapPath(options.env);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  let existing: fs.Stats | undefined;
  try {
    existing = fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  if (existing && !existing.isFile()) {
    throw new UsageError(
      `Refusing to replace non-regular models.json target: ${target}`,
      "RESOURCE_ALREADY_EXISTS",
      "Move the symlink or non-regular target aside, then retry.",
    );
  }
  if (existing && options.overwrite !== true) {
    throw new UsageError(
      `User models.json already exists at ${target}.`,
      "RESOURCE_ALREADY_EXISTS",
      "Re-run with --overwrite to confirm replacing the existing regular file.",
    );
  }
  writeFileAtomic(target, text, 0o600);
  return { path: target, copied: true as const, overwritten: existing !== undefined };
}
