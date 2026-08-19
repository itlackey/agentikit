// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { ENGINE_NAME_PATTERN_SOURCE } from "../../core/config/engine-semantics";
import { ConfigError } from "../../core/errors";
import { DURATION_UNITS, parseDuration } from "../../core/time";
import {
  cloneExecutionJson,
  cloneExecutionJsonObject,
  type ExecutionJsonObject,
  type ExecutionJsonValue,
  sortExecutionJson,
} from "../../execution/json";
import { EXECUTION_MAX_TIMEOUT_MS } from "../../execution/limits";
import {
  assertSnapshotKeys,
  requireSnapshotField,
  type StrictRecordSnapshot,
  snapshotStrictRecord,
} from "../../execution/record";
import {
  canonicalResolvedExecutionRequest,
  cloneResolvedCommandContent,
  cloneResolvedPersonaContent,
  createResolvedExecutionRequest,
  type ResolvedCommandContent,
  type ResolvedConversationMessage,
  type ResolvedEngineSelection,
  type ResolvedExecutionRequestV1,
  type ResolvedPersonaContent,
  type ToolAuthorizationResult,
} from "../../execution/resolved-request";
import {
  cloneAdapterExtensions,
  cloneToolSelection,
  cloneUnresolvedExecutionDefaults,
  executionPersonaMatchesSelector,
  isPortableExecutionAgentSelector,
  requireStableExecutionSelector,
  type ToolSelection,
  type UnresolvedExecutionDefaults,
} from "../../execution/source";
import { type ModelMapCompatibilityAliases, type ResolvedModelMapV1, resolveModelMapAlias } from "./model-map";

export const EXECUTION_CASCADE_PLAN_VERSION = 1 as const;
export const FIXED_EXECUTION_ENGINE_FALLBACK = "opencode-sdk" as const;

export type ExecutionInvocationKind = "direct" | "task" | "workflow";
export type ExecutionCascadeLayerKind =
  | "installation"
  | "engine"
  | "agent"
  | "command"
  | "invocation-defaults"
  | "current";

export interface ExecutionCascadeLayerInput {
  /** Stable, non-secret layer identity used only for diagnostics/provenance. */
  readonly id: string;
  readonly values: UnresolvedExecutionDefaults;
}

export interface ExecutionEngineDefinition {
  readonly selection: ResolvedEngineSelection;
  /** Ordinary values contributed after this engine has been selected. */
  readonly defaults?: UnresolvedExecutionDefaults;
  /** Model-map column; defaults to platform and then engine name. */
  readonly modelMapKey?: string;
  readonly modelCompatibility?: ModelMapCompatibilityAliases;
}

export interface ExecutionCascadeLayersInput {
  readonly installation: ExecutionCascadeLayerInput;
  readonly agent?: ExecutionCascadeLayerInput;
  readonly command?: ExecutionCascadeLayerInput;
  readonly invocationDefaults?: ExecutionCascadeLayerInput;
  readonly current?: ExecutionCascadeLayerInput;
}

export interface ToolAuthorizationInput {
  readonly tools: ToolSelection;
  readonly engine: Readonly<Pick<ResolvedEngineSelection, "name" | "kind" | "platform">>;
  readonly invocationKind: ExecutionInvocationKind;
  readonly commandRef: string | null;
  readonly personaRef: string | null;
}

export interface ToolAuthorizationDecision {
  readonly status: "allowed" | "denied";
  /** Stable non-secret policy identifier. Policy values never enter provenance. */
  readonly policy: string;
}

export type ToolAuthorizer = (input: Readonly<ToolAuthorizationInput>) => ToolAuthorizationDecision;

export interface PlanExecutionCascadeInput {
  readonly command: ResolvedCommandContent;
  /** Code-owned ordered turns before the terminal user command. */
  readonly conversation?: readonly Readonly<ResolvedConversationMessage>[];
  readonly persona?: ResolvedPersonaContent | null;
  readonly layers: ExecutionCascadeLayersInput;
  readonly engines: Readonly<Record<string, ExecutionEngineDefinition>>;
  readonly modelMap: ResolvedModelMapV1;
  readonly invocationKind: ExecutionInvocationKind;
  readonly authorizeTools?: ToolAuthorizer;
}

export type ExecutionProvenanceKind = ExecutionCascadeLayerKind | "fallback" | "authorization";
export type ExecutionProvenanceVia = "explicit" | "model-alias" | "fallback" | "source" | "policy";

export interface ExecutionFieldProvenance {
  readonly layer: string;
  readonly kind: ExecutionProvenanceKind;
  readonly via: ExecutionProvenanceVia;
}

export interface ResolvedExecutionPlanV1 {
  readonly schemaVersion: typeof EXECUTION_CASCADE_PLAN_VERSION;
  readonly invocationKind: ExecutionInvocationKind;
  readonly selectedAgent?: string | null;
  readonly request: ResolvedExecutionRequestV1;
  readonly provenance: Readonly<Record<string, Readonly<ExecutionFieldProvenance>>>;
}

interface NormalizedLayer {
  readonly id: string;
  readonly kind: ExecutionCascadeLayerKind;
  readonly values: Readonly<UnresolvedExecutionDefaults>;
}

interface NormalizedEngineDefinition {
  readonly selection: Readonly<ResolvedEngineSelection>;
  readonly defaults: Readonly<UnresolvedExecutionDefaults>;
  readonly modelMapKey: string;
  readonly modelCompatibility?: ModelMapCompatibilityAliases;
}

interface SelectedValue<T = unknown> {
  readonly present: boolean;
  readonly value?: T;
  readonly layer?: NormalizedLayer;
  readonly index: number;
}

const planInstances = new WeakSet<object>();
const ENGINE_NAME_PATTERN = new RegExp(ENGINE_NAME_PATTERN_SOURCE);
const MODEL_ALIAS_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const RESERVED_ENGINE_KEYS = new Set(["__proto__", "constructor", "prototype", "tostring"]);

function record(value: unknown, path: string): StrictRecordSnapshot {
  return snapshotStrictRecord(value, path);
}

function only(recordValue: StrictRecordSnapshot, allowed: readonly string[], path: string): void {
  assertSnapshotKeys(recordValue, allowed, path);
}

function own(recordValue: object, key: string): boolean {
  return Object.hasOwn(recordValue, key);
}

function required(recordValue: StrictRecordSnapshot, key: string, path: string): unknown {
  return requireSnapshotField(recordValue, key, path);
}

function stableIdentifier(value: unknown, path: string): string {
  return requireStableExecutionSelector(value, path);
}

function canonicalEngineName(value: unknown, path: string): string {
  const name = stableIdentifier(value, path);
  if (!ENGINE_NAME_PATTERN.test(name) || RESERVED_ENGINE_KEYS.has(name.toLowerCase())) {
    throw new TypeError(`${path} must be a canonical, non-reserved engine name`);
  }
  return name;
}

function frozenNullPrototypeRecord<T>(entries: Iterable<readonly [string, T]>): Readonly<Record<string, T>> {
  const out = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) {
    Object.defineProperty(out, key, { value, enumerable: true, configurable: false, writable: false });
  }
  return Object.freeze(out);
}

function normalizeLayer(value: unknown, kind: ExecutionCascadeLayerKind, path: string): NormalizedLayer {
  const input = record(value, path);
  only(input, ["id", "values"], path);
  const id = stableIdentifier(required(input, "id", path), `${path}.id`);
  const values = cloneUnresolvedExecutionDefaults(
    required(input, "values", path) as UnresolvedExecutionDefaults,
    `${path}.values`,
  );
  return Object.freeze({ id, kind, values });
}

function normalizeCompatibility(value: unknown, path: string): ModelMapCompatibilityAliases {
  const input = record(value, path);
  only(input, ["engineAliases", "globalAliases", "fallbackEngines"], path);
  const out: {
    engineAliases?: Readonly<Record<string, string>>;
    globalAliases?: Readonly<Record<string, Readonly<Record<string, string>>>>;
    fallbackEngines?: readonly string[];
  } = {};
  if (own(input, "engineAliases")) {
    const aliases = cloneExecutionJsonObject(input.engineAliases, `${path}.engineAliases`);
    if (Object.values(aliases).some((entry) => typeof entry !== "string")) {
      throw new TypeError(`${path}.engineAliases values must be strings`);
    }
    out.engineAliases = aliases as Readonly<Record<string, string>>;
  }
  if (own(input, "globalAliases")) {
    const tiers = cloneExecutionJsonObject(input.globalAliases, `${path}.globalAliases`);
    for (const [alias, engines] of Object.entries(tiers)) {
      if (engines === null || Array.isArray(engines) || typeof engines !== "object") {
        throw new TypeError(`${path}.globalAliases.${alias} must be an object`);
      }
      if (Object.values(engines).some((entry) => typeof entry !== "string")) {
        throw new TypeError(`${path}.globalAliases.${alias} values must be strings`);
      }
    }
    out.globalAliases = tiers as Readonly<Record<string, Readonly<Record<string, string>>>>;
  }
  if (own(input, "fallbackEngines")) {
    const fallbacks = cloneExecutionJson(input.fallbackEngines, `${path}.fallbackEngines`);
    if (!Array.isArray(fallbacks) || fallbacks.some((entry) => typeof entry !== "string" || entry.length === 0)) {
      throw new TypeError(`${path}.fallbackEngines must be an array of non-empty strings`);
    }
    out.fallbackEngines = fallbacks as readonly string[];
  }
  return Object.freeze(out);
}

function normalizeEngineSelection(value: unknown, path: string): Readonly<ResolvedEngineSelection> {
  const input = record(value, path);
  only(input, ["name", "kind", "platform", "settings", "extensions"], path);
  const name = canonicalEngineName(required(input, "name", path), `${path}.name`);
  const kind = required(input, "kind", path);
  if (kind !== "agent" && kind !== "sdk" && kind !== "llm") {
    throw new TypeError(`${path}.kind must be agent, sdk, or llm`);
  }
  const out: Record<string, unknown> = { name, kind };
  if (own(input, "platform")) {
    if (input.platform !== null && typeof input.platform !== "string") {
      throw new TypeError(`${path}.platform must be a string or null`);
    }
    out.platform = input.platform;
  }
  if (own(input, "settings")) {
    out.settings = input.settings === null ? null : cloneExecutionJsonObject(input.settings, `${path}.settings`);
  }
  if (own(input, "extensions")) {
    out.extensions = cloneAdapterExtensions(input.extensions, `${path}.extensions`);
  }
  return Object.freeze(out) as unknown as Readonly<ResolvedEngineSelection>;
}

function normalizeEngineDefinition(value: unknown, name: string): NormalizedEngineDefinition {
  const path = `engines.${name}`;
  const input = record(value, path);
  only(input, ["selection", "defaults", "modelMapKey", "modelCompatibility"], path);
  const selection = normalizeEngineSelection(required(input, "selection", path), `${path}.selection`);
  if (selection.name !== name) {
    throw new TypeError(`${path}.selection.name must match its engine registry key`);
  }
  const defaults = own(input, "defaults")
    ? cloneUnresolvedExecutionDefaults(input.defaults as UnresolvedExecutionDefaults, `${path}.defaults`)
    : Object.freeze({});
  if (own(defaults, "engine")) {
    throw new TypeError(`${path}.defaults.engine is invalid because the engine layer cannot select itself`);
  }
  const rawMapKey = own(input, "modelMapKey") ? input.modelMapKey : (selection.platform ?? selection.name);
  const modelMapKey = stableIdentifier(rawMapKey, `${path}.modelMapKey`);
  const modelCompatibility = own(input, "modelCompatibility")
    ? normalizeCompatibility(input.modelCompatibility, `${path}.modelCompatibility`)
    : undefined;
  return Object.freeze({ selection, defaults, modelMapKey, ...(modelCompatibility ? { modelCompatibility } : {}) });
}

function normalizeEngines(value: unknown): Readonly<Record<string, NormalizedEngineDefinition>> {
  const input = record(value, "engines");
  const entries: Array<readonly [string, NormalizedEngineDefinition]> = [];
  for (const [name, definition] of Object.entries(input)) {
    canonicalEngineName(name, `engines.${name}`);
    entries.push([name, normalizeEngineDefinition(definition, name)]);
  }
  return frozenNullPrototypeRecord(entries);
}

function normalizeModelMap(value: unknown): ResolvedModelMapV1 {
  const input = record(value, "modelMap");
  only(input, ["version", "aliases"], "modelMap");
  if (required(input, "version", "modelMap") !== 1) {
    throw new TypeError("modelMap.version must be 1");
  }
  const aliasesInput = record(required(input, "aliases", "modelMap"), "modelMap.aliases");
  const aliases: Array<
    readonly [string, Readonly<Record<string, Readonly<{ model: string; inference?: ExecutionJsonObject | null }>>>]
  > = [];
  for (const [alias, rawEngines] of Object.entries(aliasesInput)) {
    stableIdentifier(alias, `modelMap.aliases.${alias}`);
    if (!MODEL_ALIAS_PATTERN.test(alias) || RESERVED_ENGINE_KEYS.has(alias.toLowerCase())) {
      throw new TypeError(`modelMap alias ${JSON.stringify(alias)} is not canonical`);
    }
    const engineInput = record(rawEngines, `modelMap.aliases.${alias}`);
    const profiles: Array<readonly [string, Readonly<{ model: string; inference?: ExecutionJsonObject | null }>]> = [];
    for (const [engine, rawProfile] of Object.entries(engineInput)) {
      if (engine !== "*") canonicalEngineName(engine, `modelMap.aliases.${alias}.${engine}`);
      const profile = record(rawProfile, `modelMap.aliases.${alias}.${engine}`);
      only(profile, ["model", "inference"], `modelMap.aliases.${alias}.${engine}`);
      const model = required(profile, "model", `modelMap.aliases.${alias}.${engine}`);
      if (typeof model !== "string" || model.length === 0 || model.trim() !== model) {
        throw new TypeError(`modelMap.aliases.${alias}.${engine}.model must be a non-empty exact identifier`);
      }
      const normalized: { model: string; inference?: ExecutionJsonObject | null } = { model };
      if (own(profile, "inference")) {
        normalized.inference =
          profile.inference === null
            ? null
            : cloneExecutionJsonObject(profile.inference, `modelMap.aliases.${alias}.${engine}.inference`);
      }
      profiles.push([engine, Object.freeze(normalized)]);
    }
    aliases.push([alias, frozenNullPrototypeRecord(profiles)]);
  }
  return Object.freeze({ version: 1, aliases: frozenNullPrototypeRecord(aliases) });
}

function normalizeLayers(value: unknown): {
  readonly installation: NormalizedLayer;
  readonly agent?: NormalizedLayer;
  readonly command?: NormalizedLayer;
  readonly invocationDefaults?: NormalizedLayer;
  readonly current?: NormalizedLayer;
} {
  const input = record(value, "layers");
  only(input, ["installation", "agent", "command", "invocationDefaults", "current"], "layers");
  const out: {
    installation: NormalizedLayer;
    agent?: NormalizedLayer;
    command?: NormalizedLayer;
    invocationDefaults?: NormalizedLayer;
    current?: NormalizedLayer;
  } = {
    installation: normalizeLayer(required(input, "installation", "layers"), "installation", "layers.installation"),
  };
  for (const [key, kind] of [
    ["agent", "agent"],
    ["command", "command"],
    ["invocationDefaults", "invocation-defaults"],
    ["current", "current"],
  ] as const) {
    if (own(input, key)) {
      if (input[key] === undefined) throw new TypeError(`layers.${key} must be omitted rather than undefined`);
      out[key] = normalizeLayer(input[key], kind, `layers.${key}`);
    }
  }
  return Object.freeze(out);
}

function orderedWithoutEngine(layers: ReturnType<typeof normalizeLayers>): NormalizedLayer[] {
  return [layers.installation, layers.agent, layers.command, layers.invocationDefaults, layers.current].filter(
    (layer): layer is NormalizedLayer => layer !== undefined,
  );
}

function selectNearest<T = unknown>(
  layers: readonly NormalizedLayer[],
  key: keyof UnresolvedExecutionDefaults,
): SelectedValue<T> {
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    if (layer && own(layer.values, key)) {
      return { present: true, value: layer.values[key] as T, layer, index };
    }
  }
  return { present: false, index: -1 };
}

function provenance(layer: NormalizedLayer, via: ExecutionProvenanceVia = "explicit"): ExecutionFieldProvenance {
  return Object.freeze({ layer: layer.id, kind: layer.kind, via });
}

function fallbackProvenance(): ExecutionFieldProvenance {
  return Object.freeze({ layer: FIXED_EXECUTION_ENGINE_FALLBACK, kind: "fallback", via: "fallback" });
}

function sourceProvenance(layer: string, kind: "command" | "agent"): ExecutionFieldProvenance {
  return Object.freeze({ layer, kind, via: "source" });
}

function chooseEngine(
  layers: readonly NormalizedLayer[],
  engines: Readonly<Record<string, NormalizedEngineDefinition>>,
): {
  readonly definition: NormalizedEngineDefinition;
  readonly field: ExecutionFieldProvenance;
  readonly requested?: ExecutionFieldProvenance;
  readonly fallback: boolean;
} {
  const selected = selectNearest<string | null>(layers, "engine");
  let name: string;
  let field: ExecutionFieldProvenance;
  let fallback = false;
  if (!selected.present || selected.value === null) {
    name = FIXED_EXECUTION_ENGINE_FALLBACK;
    field = fallbackProvenance();
    fallback = true;
  } else {
    if (typeof selected.value !== "string" || selected.value.length === 0) {
      throw new ConfigError("Selected engine must be a non-empty configured engine name.", "INVALID_CONFIG_FILE");
    }
    name = selected.value;
    field = provenance(selected.layer as NormalizedLayer);
  }
  const definition = engines[name];
  if (!definition) {
    if (fallback) {
      throw new ConfigError(
        "No engine was selected and the fixed opencode-sdk fallback is unavailable.",
        "INVALID_CONFIG_FILE",
        "Configure defaults.engine or configure/install the opencode-sdk engine.",
      );
    }
    throw new ConfigError(`Selected engine ${JSON.stringify(name)} is not configured.`, "INVALID_CONFIG_FILE");
  }
  return {
    definition,
    field,
    ...(selected.present ? { requested: provenance(selected.layer as NormalizedLayer) } : {}),
    fallback,
  };
}

function cloneJsonValue(value: ExecutionJsonValue, path: string): ExecutionJsonValue {
  return cloneExecutionJson(value, path);
}

function isObject(value: ExecutionJsonValue | undefined): value is ExecutionJsonObject {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);
}

function deleteInferenceProvenance(fields: Record<string, ExecutionFieldProvenance>): void {
  for (const key of Object.keys(fields)) {
    if (key === "/inference" || key.startsWith("/inference/")) delete fields[key];
  }
}

function deleteInferenceDescendantProvenance(fields: Record<string, ExecutionFieldProvenance>, path: string): void {
  for (const key of Object.keys(fields)) {
    if (key.startsWith(`${path}/`)) delete fields[key];
  }
}

function jsonPointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function setInferenceTreeProvenance(
  value: ExecutionJsonValue,
  path: string,
  source: ExecutionFieldProvenance,
  fields: Record<string, ExecutionFieldProvenance>,
): void {
  fields[path] = source;
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    setInferenceTreeProvenance(child, `${path}/${jsonPointerSegment(key)}`, source, fields);
  }
}

function mergeInferenceObject(
  base: ExecutionJsonObject,
  overlay: ExecutionJsonObject,
  prefix: string,
  source: ExecutionFieldProvenance,
  fields: Record<string, ExecutionFieldProvenance>,
): ExecutionJsonObject {
  const out = new Map<string, ExecutionJsonValue>();
  for (const [key, value] of Object.entries(base)) out.set(key, cloneJsonValue(value, `${prefix}.${key}`));
  for (const [key, value] of Object.entries(overlay)) {
    const path = `${prefix}/${jsonPointerSegment(key)}`;
    const previous = out.get(key);
    if (isObject(previous) && isObject(value)) {
      out.set(key, mergeInferenceObject(previous, value, path, source, fields));
      fields[path] = source;
    } else {
      deleteInferenceDescendantProvenance(fields, path);
      out.set(key, cloneJsonValue(value, path));
      setInferenceTreeProvenance(value, path, source, fields);
    }
  }
  return Object.freeze(Object.fromEntries(out));
}

function resolveInference(
  layers: readonly NormalizedLayer[],
  aliasInferenceByLayer: ReadonlyMap<number, ExecutionJsonObject | null>,
  fields: Record<string, ExecutionFieldProvenance>,
): { readonly present: boolean; readonly value?: ExecutionJsonObject | null } {
  let present = false;
  let current: ExecutionJsonObject | null | undefined;
  const apply = (value: ExecutionJsonObject | null, layer: NormalizedLayer, via: "explicit" | "model-alias"): void => {
    const field = provenance(layer, via);
    present = true;
    if (value === null) {
      current = null;
      deleteInferenceProvenance(fields);
      fields["/inference"] = field;
      return;
    }
    fields["/inference"] = field;
    current = mergeInferenceObject(isObject(current) ? current : Object.freeze({}), value, "/inference", field, fields);
  };

  for (const [index, layer] of layers.entries()) {
    if (aliasInferenceByLayer.has(index)) {
      apply(aliasInferenceByLayer.get(index) as ExecutionJsonObject | null, layer, "model-alias");
    }
    if (own(layer.values, "inference")) {
      apply(layer.values.inference as ExecutionJsonObject | null, layer, "explicit");
    }
  }
  return present ? { present: true, value: current as ExecutionJsonObject | null } : { present: false };
}

function resolveModels(
  layers: readonly NormalizedLayer[],
  definition: NormalizedEngineDefinition,
  modelMap: ResolvedModelMapV1,
): {
  readonly selected: SelectedValue<string | null>;
  readonly resolved?: Readonly<{ input: string; interpretation: "alias" | "exact"; resolved: string }> | null;
  readonly aliasInferenceByLayer: ReadonlyMap<number, ExecutionJsonObject | null>;
} {
  let selected: SelectedValue<string | null> = { present: false, index: -1 };
  let resolved: Readonly<{ input: string; interpretation: "alias" | "exact"; resolved: string }> | null | undefined;
  const aliasInferenceByLayer = new Map<number, ExecutionJsonObject | null>();
  for (const [index, layer] of layers.entries()) {
    if (!own(layer.values, "model")) continue;
    const value = layer.values.model;
    selected = { present: true, value, layer, index };
    if (value === null) {
      resolved = null;
      continue;
    }
    if (typeof value !== "string" || value.length === 0) {
      throw new ConfigError("Resolved model must be null or a non-empty string.", "INVALID_CONFIG_FILE");
    }
    const selection = resolveModelMapAlias(value, definition.modelMapKey, modelMap, definition.modelCompatibility);
    if (selection.interpretation === "alias" && selection.inference !== undefined) {
      aliasInferenceByLayer.set(index, selection.inference);
    }
    resolved = Object.freeze({
      input: selection.input,
      interpretation: selection.interpretation,
      resolved: selection.model,
    });
  }
  return Object.freeze({ selected, resolved, aliasInferenceByLayer });
}

function normalizeTimeout(value: string | number | null): number | null {
  if (value === null) return null;
  const milliseconds = typeof value === "string" ? parseDuration(value, DURATION_UNITS) : value;
  if (
    milliseconds === null ||
    !Number.isInteger(milliseconds) ||
    milliseconds < 0 ||
    milliseconds > EXECUTION_MAX_TIMEOUT_MS
  ) {
    throw new ConfigError(
      `Resolved execution timeout must be null, a bounded integer in milliseconds, or a duration such as 20m.`,
      "INVALID_CONFIG_FILE",
    );
  }
  return milliseconds;
}

function toolsRequireAuthorization(value: ToolSelection | undefined, present: boolean): boolean {
  if (!present || value === null) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === "object" && value !== null && Object.keys(value).length > 0;
}

function normalizeAuthorizationDecision(value: unknown): ToolAuthorizationDecision {
  const input = record(value, "tool authorization decision");
  only(input, ["status", "policy"], "tool authorization decision");
  const status = required(input, "status", "tool authorization decision");
  if (status !== "allowed" && status !== "denied") {
    throw new TypeError("tool authorization decision.status must be allowed or denied");
  }
  const policy = stableIdentifier(
    required(input, "policy", "tool authorization decision"),
    "tool authorization decision.policy",
  );
  return Object.freeze({ status, policy });
}

function authorizationFor(
  requiresAuthorization: boolean,
  authorizer: ToolAuthorizer | undefined,
  input: ToolAuthorizationInput | undefined,
): ToolAuthorizationResult {
  if (!requiresAuthorization) return Object.freeze({ status: "not-required" as const });
  if (!authorizer || !input) {
    return Object.freeze({
      status: "denied" as const,
      reason: "Selected tools require an explicit machine/user authorization policy.",
      policy: Object.freeze({ id: "unconfigured" }),
    });
  }
  const decision = normalizeAuthorizationDecision(authorizer(Object.freeze(input)));
  return Object.freeze({
    status: decision.status,
    reason:
      decision.status === "allowed"
        ? "Selected tools were authorized by operator policy."
        : "Selected tools are not authorized by operator policy.",
    policy: Object.freeze({ id: decision.policy }),
  });
}

function freezeProvenance(
  fields: Record<string, ExecutionFieldProvenance>,
): Readonly<Record<string, Readonly<ExecutionFieldProvenance>>> {
  return frozenNullPrototypeRecord(
    Object.entries(fields)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, value]) => [key, Object.freeze({ ...value })] as const),
  );
}

export function planExecutionCascade(raw: PlanExecutionCascadeInput): ResolvedExecutionPlanV1 {
  const input = record(raw, "execution cascade input");
  only(
    input,
    ["command", "conversation", "persona", "layers", "engines", "modelMap", "invocationKind", "authorizeTools"],
    "execution cascade input",
  );
  const command = cloneResolvedCommandContent(
    required(input, "command", "execution cascade input") as ResolvedCommandContent,
  );
  const invocationKind = required(input, "invocationKind", "execution cascade input");
  if (invocationKind !== "direct" && invocationKind !== "task" && invocationKind !== "workflow") {
    throw new TypeError("execution cascade input.invocationKind is invalid");
  }
  const normalizedInvocationKind: ExecutionInvocationKind = invocationKind;
  const personaPresent = own(input, "persona");
  if (personaPresent && input.persona === undefined) {
    throw new TypeError("execution cascade input.persona must be omitted, null, or a resolved persona");
  }
  let persona = personaPresent
    ? input.persona === null
      ? null
      : cloneResolvedPersonaContent(input.persona as ResolvedPersonaContent)
    : undefined;
  if (
    own(input, "authorizeTools") &&
    input.authorizeTools !== undefined &&
    typeof input.authorizeTools !== "function"
  ) {
    throw new TypeError("execution cascade input.authorizeTools must be a function or omitted");
  }

  const normalizedLayers = normalizeLayers(required(input, "layers", "execution cascade input"));
  const engines = normalizeEngines(required(input, "engines", "execution cascade input"));
  const modelMap = normalizeModelMap(required(input, "modelMap", "execution cascade input"));
  const beforeEngine = orderedWithoutEngine(normalizedLayers);
  const selectedEngine = chooseEngine(beforeEngine, engines);
  const engineLayer: NormalizedLayer = Object.freeze({
    id: selectedEngine.definition.selection.name,
    kind: "engine",
    values: selectedEngine.definition.defaults,
  });
  const layers = [
    normalizedLayers.installation,
    engineLayer,
    normalizedLayers.agent,
    normalizedLayers.command,
    normalizedLayers.invocationDefaults,
    normalizedLayers.current,
  ].filter((layer): layer is NormalizedLayer => layer !== undefined);

  const fields: Record<string, ExecutionFieldProvenance> = Object.create(null);
  fields.engine = selectedEngine.field;
  if (selectedEngine.requested) fields["engine.requested"] = selectedEngine.requested;
  const commandRef = command.source?.ref ?? null;
  fields.command = sourceProvenance(commandRef ?? "inline", "command");
  const selectedAgent = selectNearest<string | null>(layers, "agent");
  let resolvedAgent: string | null | undefined;
  let requestPersonaPresent = personaPresent;
  if (selectedAgent.present) {
    fields.agent = provenance(selectedAgent.layer as NormalizedLayer);
    if (selectedAgent.value === null) {
      resolvedAgent = null;
      persona = null;
      requestPersonaPresent = true;
    } else {
      const selector = stableIdentifier(selectedAgent.value, "selected agent");
      resolvedAgent = selector;
      if (isPortableExecutionAgentSelector(selector)) {
        if (!persona || !executionPersonaMatchesSelector(selector, persona.source.ref)) {
          throw new ConfigError(
            `Selected agent ${JSON.stringify(selector)} does not match the resolved persona source.`,
            "INVALID_CONFIG_FILE",
            "Resolve the selected agent through its bundle adapter before planning execution.",
          );
        }
      } else {
        persona = null;
        requestPersonaPresent = true;
      }
    }
  }
  const personaRef = persona?.source.ref ?? null;
  if (persona) fields.persona = sourceProvenance(personaRef as string, "agent");

  const modelResolution = resolveModels(layers, selectedEngine.definition, modelMap);
  const selectedModel = modelResolution.selected;
  if (selectedModel.present) {
    fields.model = provenance(selectedModel.layer as NormalizedLayer);
  }

  const inference = resolveInference(layers, modelResolution.aliasInferenceByLayer, fields);
  const selectedSchema = selectNearest<ExecutionJsonObject | null>(layers, "outputSchema");
  if (selectedSchema.present) fields.outputSchema = provenance(selectedSchema.layer as NormalizedLayer);
  const selectedTools = selectNearest<ToolSelection>(layers, "tools");
  if (selectedTools.present) fields.tools = provenance(selectedTools.layer as NormalizedLayer);
  const selectedTimeout = selectNearest<string | number | null>(layers, "timeout");
  const selectedWorkspace = selectNearest<string | null>(layers, "workspace");
  const selectedEnvironment = selectNearest<Readonly<Record<string, string>> | null>(layers, "environment");
  const selectedRuntime = selectNearest<ExecutionJsonObject | null>(layers, "runtime");

  const runtime: Record<string, unknown> = {};
  if (selectedTimeout.present) {
    runtime.timeoutMs = normalizeTimeout(selectedTimeout.value as string | number | null);
    fields["runtime.timeoutMs"] = provenance(selectedTimeout.layer as NormalizedLayer);
  }
  if (selectedWorkspace.present) {
    runtime.workspace = selectedWorkspace.value;
    fields["runtime.workspace"] = provenance(selectedWorkspace.layer as NormalizedLayer);
  }
  if (selectedEnvironment.present) {
    runtime.environment = selectedEnvironment.value;
    fields["runtime.environment"] = provenance(selectedEnvironment.layer as NormalizedLayer);
  }
  if (selectedRuntime.present) {
    runtime.settings = selectedRuntime.value;
    fields["runtime.settings"] = provenance(selectedRuntime.layer as NormalizedLayer);
  }

  const notices = selectedEngine.fallback
    ? [
        {
          code: "engine-fallback",
          severity: "info" as const,
          adapter: "akm",
          field: "engine",
          message: "No engine was selected; using the fixed opencode-sdk fallback.",
        },
      ]
    : [];
  const tools = selectedTools.present ? cloneToolSelection(selectedTools.value, "resolved tools") : undefined;
  const requiresAuthorization = toolsRequireAuthorization(tools, selectedTools.present);

  const provisionalAuthorization: ToolAuthorizationResult = requiresAuthorization
    ? { status: "allowed", policy: { id: "pre-authorization-validation" } }
    : { status: "not-required" };
  const requestInput: Record<string, unknown> = {
    command,
    engine: selectedEngine.definition.selection,
    authorization: provisionalAuthorization,
    runtime,
    notices,
  };
  if (own(input, "conversation")) requestInput.conversation = input.conversation;
  if (selectedAgent.present) requestInput.agent = resolvedAgent;
  if (requestPersonaPresent) requestInput.persona = persona;
  if (selectedModel.present) requestInput.model = modelResolution.resolved;
  if (inference.present) requestInput.inference = inference.value;
  if (selectedSchema.present) requestInput.outputSchema = selectedSchema.value;
  if (selectedTools.present) requestInput.tools = tools;

  // Validate every dispatch-significant value and source provenance before a
  // policy callback can observe the request or any caller can dispatch it.
  const provisionalRequest = createResolvedExecutionRequest(requestInput as never);
  if (own(provisionalRequest, "conversation")) requestInput.conversation = provisionalRequest.conversation;

  const authorizationInput = requiresAuthorization
    ? {
        tools: tools as ToolSelection,
        engine: Object.freeze({
          name: selectedEngine.definition.selection.name,
          kind: selectedEngine.definition.selection.kind,
          ...(own(selectedEngine.definition.selection, "platform")
            ? { platform: selectedEngine.definition.selection.platform }
            : {}),
        }),
        invocationKind: normalizedInvocationKind,
        commandRef,
        personaRef,
      }
    : undefined;
  const authorization = authorizationFor(
    requiresAuthorization,
    input.authorizeTools as ToolAuthorizer | undefined,
    authorizationInput,
  );
  fields.authorization = Object.freeze({
    layer:
      authorization.policy && typeof authorization.policy.id === "string" ? authorization.policy.id : "not-required",
    kind: "authorization",
    via: "policy",
  });
  requestInput.authorization = authorization;
  const request = createResolvedExecutionRequest(requestInput as never);
  const planObject: Record<string, unknown> = {
    schemaVersion: EXECUTION_CASCADE_PLAN_VERSION,
    invocationKind: normalizedInvocationKind,
    request,
    provenance: freezeProvenance(fields),
  };
  if (selectedAgent.present) planObject.selectedAgent = resolvedAgent;
  const plan = Object.freeze(planObject) as unknown as ResolvedExecutionPlanV1;
  planInstances.add(plan);
  return plan;
}

export function requireAuthorizedExecutionPlan(plan: ResolvedExecutionPlanV1): ResolvedExecutionRequestV1 {
  if (!planInstances.has(plan) || !Object.isFrozen(plan)) {
    throw new TypeError("execution plan must be constructed by the common cascade resolver");
  }
  if (plan.request.authorization.status === "denied") {
    throw new ConfigError(
      plan.request.authorization.reason ?? "Resolved execution is not authorized by operator policy.",
      "EXECUTION_NOT_AUTHORIZED",
    );
  }
  return plan.request;
}

export function canonicalResolvedExecutionPlan(plan: ResolvedExecutionPlanV1): string {
  if (!planInstances.has(plan) || !Object.isFrozen(plan)) {
    throw new TypeError("execution plan must be constructed by the common cascade resolver");
  }
  const wire: Record<string, unknown> = {
    schemaVersion: plan.schemaVersion,
    invocationKind: plan.invocationKind,
    request: JSON.parse(canonicalResolvedExecutionRequest(plan.request)),
    provenance: plan.provenance,
  };
  if (own(plan, "selectedAgent")) wire.selectedAgent = plan.selectedAgent;
  return JSON.stringify(sortExecutionJson(wire as ExecutionJsonObject));
}
