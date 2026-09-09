// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assetPathForName, stashDirFor } from "../asset/asset-placement";
import { type BundleRef, isBundleSlug, parseBundleRef } from "../asset/asset-ref";
import { typeNameFromConceptId } from "../asset/resolve-ref";
import { isRecord } from "../common";
import { ConfigError } from "../errors";
import { liftLegacyEngineExtraParams } from "../extra-params";
import { formatRegistryLabel, hasRegistryUrlCredentials } from "../registry-url";
import {
  acquireConfigLock,
  backupExistingConfig,
  parseConfigText,
  readConfigText,
  withConfigLock,
  writeConfigAtomic,
} from "./config-io";
import { AkmConfigSchema, CURRENT_CONFIG_VERSION } from "./config-schema";
import { bundleContentRoot, bundlesToSourceEntries } from "./config-sources";
import type {
  AkmConfig,
  ImproveProcessConfig,
  ImproveProfileConfig,
  IndexConfig,
  IndexPassConfig,
  RegistryConfigEntry,
  SourceConfigEntry,
} from "./config-types";
import { upgradeConfigVersion } from "./config-version-shim";
import { deepMergeConfig } from "./deep-merge";
import { migrateLegacySourceShape } from "./legacy-source-shape-shim";
import { isApiKeyReference, SECRET_STORE_REFERENCE_PATTERN } from "./schema/primitives";

export { stripJsonComments } from "./config-io";

import { getConfigPath } from "../paths";
import { warn, warnOnce } from "../warn";

// Re-export type surface from config-types.ts so call sites don't need to
// move (the runtime values live here; the types are documentation-only).
export type {
  AkmConfig,
  BundleConfigEntry,
  ConfiguredSource,
  EmbeddingConnectionConfig,
  EngineConfig,
  HarnessId,
  ImproveConfig,
  ImproveProcessConfig,
  ImproveProfileConfig,
  IndexConfig,
  IndexPassConfig,
  LlmConnectionConfig,
  LlmProfileConfig,
  OutputConfig,
  RegistryConfigEntry,
  SourceConfigEntry,
  SourceSpec,
} from "./config-types";
// Canonical harness-id source of truth (#565) — runtime value re-export.
export { VALID_HARNESS_IDS } from "./config-types";

// ── Feedback failure-mode constants (F-3 / #384) ────────────────────────────

// Canonical taxonomy lives in the schema/validator layer; re-exported here so
// existing `../core/config/config` import sites keep working.
export { FEEDBACK_FAILURE_MODES, type FeedbackFailureMode } from "./config-schema";

/**
 * Default value for {@link IndexPassConfig.graphExtractionBatchSize}. Chosen
 * empirically: 4 amortises the per-call HTTP overhead 4× while keeping the
 * combined prompt size well under common 8K/16K context windows (each body is
 * sliced to ~500 chars in the graph-extract prompt builder).
 */
export const DEFAULT_GRAPH_EXTRACTION_BATCH_SIZE = 4;

/**
 * Approximate character budget per asset body inside a batched
 * graph-extraction prompt — used by {@link resolveBatchSize} to derive a
 * context-window ceiling when `llm.contextLength` is configured. This accounts
 * for the actual `MAX_BODY_CHARS` (500) in graph-extract.ts plus the system
 * prompt, user prompt wrapper, and expected JSON response overhead.
 */
const GRAPH_EXTRACTION_CHARS_PER_BODY = 1500;

/**
 * Clamp a configured batch size against the model's known context window.
 *
 * `configured` defaults to {@link DEFAULT_GRAPH_EXTRACTION_BATCH_SIZE} when
 * `undefined`. When `contextLength` is provided, the result is the smaller of
 * `configured` and `floor(contextLength / GRAPH_EXTRACTION_CHARS_PER_BODY)`,
 * with a floor of 1 so the batched path always processes at least one body.
 */
export function resolveBatchSize(configured: number | undefined, contextLength?: number): number {
  const base = configured && configured > 0 ? configured : DEFAULT_GRAPH_EXTRACTION_BATCH_SIZE;
  if (!contextLength || contextLength <= 0) return base;
  const ceiling = Math.max(1, Math.floor(contextLength / GRAPH_EXTRACTION_CHARS_PER_BODY));
  return Math.max(1, Math.min(base, ceiling));
}

// ── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: AkmConfig = {
  configVersion: "0.9.0",
  semanticSearchMode: "off",
  registries: [
    { url: "https://raw.githubusercontent.com/itlackey/akm-registry/main/index.json", name: "akm-registry" },
    { url: "https://skills.sh", name: "skills.sh", provider: "skills-sh", enabled: false },
  ],
  output: {
    format: "json",
    detail: "brief",
  },
};

// ── Load / Save / Update ────────────────────────────────────────────────────

let cachedConfig: { config: AkmConfig; path: string; mtime: number; size: number } | undefined;

export function resetConfigCache(): void {
  cachedConfig = undefined;
}

export function loadUserConfig(): AkmConfig {
  const configPath = getConfigPath();

  let stat: fs.Stats;
  try {
    stat = fs.statSync(configPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ConfigError(
        `Unable to read config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
        "INVALID_CONFIG_FILE",
      );
    }
    cachedConfig = undefined;
    return { ...DEFAULT_CONFIG };
  }

  // Cache key: mtimeMs + size. Tests that write rapidly back-to-back inside
  // the mtime resolution window MUST call resetConfigCache() between writes —
  // every public test helper already does.
  if (
    cachedConfig &&
    cachedConfig.path === configPath &&
    cachedConfig.mtime === stat.mtimeMs &&
    cachedConfig.size === stat.size
  ) {
    return cachedConfig.config;
  }

  let text: string | undefined;
  try {
    text = readConfigText(configPath);
  } catch (err) {
    throw new ConfigError(
      `Unable to read config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
      "INVALID_CONFIG_FILE",
    );
  }
  if (text === undefined) {
    cachedConfig = undefined;
    return { ...DEFAULT_CONFIG };
  }

  const finalConfig = parseAndValidateConfigText(text, configPath);

  // Re-stat after potential write-back so the cache key reflects the new mtime.
  let finalStat = stat;
  try {
    finalStat = fs.statSync(configPath);
  } catch {
    // Stat failed — use original stat for cache; no harm done.
  }
  cachedConfig = {
    config: finalConfig,
    path: configPath,
    mtime: finalStat.mtimeMs,
    size: finalStat.size,
  };
  return finalConfig;
}

/**
 * Acquire the existing config-write sentinel and read a fresh validated
 * generation while keeping the sentinel held. Source update uses this to
 * fence an audited bundle descriptor through publication: a cooperating
 * config writer can commit either before this snapshot or after the update,
 * never between the final generation check and index commit.
 */
export function acquireConfigReadFence(): { config: AkmConfig; release: () => void } {
  const release = acquireConfigLock();
  try {
    cachedConfig = undefined;
    return { config: loadUserConfig(), release };
  } catch (error) {
    release();
    throw error;
  }
}

/**
 * Run the per-file config pipeline every raw config object goes through
 * before it is either validated (the local/top-level file) or merged in as
 * an `extends` base: JSONC parse already done by the caller, then version
 * shim, then legacy `stashDir`/`sources[]`/`installed[]` shim, then the
 * legacy `extraParams` lift (#852). Shared by {@link parseAndValidateConfigText}
 * (the local file) and {@link resolveExtendsChain} (each base in the chain) so
 * a fleet-shared base config can carry its own old `configVersion` / legacy
 * shape independently of the file that extends it.
 */
function runConfigFilePipeline(text: string, sourcePath?: string): Record<string, unknown> {
  const versioned = upgradeConfigVersion(parseConfigText(text, sourcePath), sourcePath);
  const parsedRaw = migrateLegacySourceShape(versioned, sourcePath);
  return liftExtraParamsOrThrow(parsedRaw, sourcePath);
}

/**
 * #852 (following #815): a config still using legacy `extraParams` keys —
 * e.g. `reasoning_effort`, a documented 0.9.1 workaround — needs to be
 * rewritten onto the first-class engine field they now shadow. This used
 * to happen silently, in memory, on every load; that ran forever and never
 * converged. The lift itself is now `akm migrate apply`'s job (see
 * scripts/akm-migrate/migrate/config-extra-params.ts) and persists to disk, so a
 * config that has not been migrated yet fails closed here instead of
 * silently drifting from what's on disk.
 */
function liftExtraParamsOrThrow(parsedRaw: Record<string, unknown>, sourcePath?: string): Record<string, unknown> {
  const where = sourcePath ? ` at ${sourcePath}` : "";
  const { config: liftedConfig, lifted, conflicts } = liftLegacyEngineExtraParams(parsedRaw);
  if (conflicts.length > 0) {
    const lines = conflicts
      .map(
        (c) =>
          `  - engines.${c.engine}.extraParams.${c.key} (${JSON.stringify(c.extraParamsValue)}) conflicts with engines.${c.engine}.${c.field} (${JSON.stringify(c.fieldValue)})`,
      )
      .join("\n");
    throw new ConfigError(
      `Invalid config${where}: extraParams and the first-class field disagree:\n${lines}\n\nEach extraParams key above has a first-class equivalent and akm will not guess which value you meant — remove the extraParams entry once the field carries the value you want.`,
      "INVALID_CONFIG_FILE",
    );
  }
  if (lifted.length > 0) {
    warnOnce(
      `config:extra-params-lift${sourcePath ? `:${sourcePath}` : ""}`,
      `Config${where} uses deprecated extraParams keys with first-class equivalents — auto-lifted in memory:\n  - ${lifted.join("\n  - ")}\n\nRun \`akm migrate apply\` to rewrite the config file and silence this warning.`,
    );
  }
  return liftedConfig;
}

/**
 * Parse raw config text and validate via Zod.
 * ({@link AkmConfigSchema}). Returns the merged-with-defaults AkmConfig.
 *
 * The schema accepts only the current config version. A known older version
 * is auto-upgraded in memory first (see `./config-version-shim`); anything
 * else — including anything newer — is rejected before the canonical shape
 * is validated. When the config sets `extends` (#945), its resolved chain is
 * deep-merged underneath before validation — see {@link resolveExtendsChain}.
 */
export function parseAndValidateConfigText(text: string, sourcePath?: string): AkmConfig {
  const versioned = upgradeConfigVersion(parseConfigText(text, sourcePath), sourcePath);
  const parsedRaw = migrateLegacySourceShape(versioned, sourcePath);
  const liftedConfig = liftExtraParamsOrThrow(parsedRaw, sourcePath);
  const withExtends = resolveExtendsChain(liftedConfig, sourcePath);

  const where = sourcePath ? ` at ${sourcePath}` : "";
  const parsed = AkmConfigSchema.safeParse(withExtends);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new ConfigError(`Invalid config${where}:\n${lines}`, "INVALID_CONFIG_FILE");
  }
  const merged = deepMergeConfig(DEFAULT_CONFIG, parsed.data as Partial<AkmConfig>) as AkmConfig;
  const finalResult = AkmConfigSchema.safeParse(merged);
  if (!finalResult.success) {
    const lines = finalResult.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new ConfigError(
      `Invalid merged config${sourcePath ? ` at ${sourcePath}` : ""}:\n${lines}`,
      "INVALID_CONFIG_FILE",
    );
  }
  return finalResult.data;
}

// ── `extends` inheritance (#945) ────────────────────────────────────────────

/** One layer of an `extends` chain, from the local file (`ref: undefined`) outward to the chain's root. */
interface ConfigLayer {
  /** The `extends` value that led here; `undefined` for the local/topmost layer. */
  ref: string | undefined;
  /** This layer's raw config, already through {@link runConfigFilePipeline}. */
  raw: Record<string, unknown>;
}

/**
 * Walk an `extends` chain starting at `localRaw` (already through
 * {@link runConfigFilePipeline}), returning every layer from the local file
 * outward to the chain's root, local first. A chain is allowed (a base may
 * itself set `extends`); a cycle (a resolved source repeating) throws
 * {@link ConfigError} instead of recursing forever.
 */
function collectExtendsLayers(localRaw: Record<string, unknown>, configPath: string | undefined): ConfigLayer[] {
  const layers: ConfigLayer[] = [{ ref: undefined, raw: localRaw }];
  const visited = new Set<string>(configPath ? [path.resolve(configPath)] : []);
  let current = localRaw;
  let currentPath = configPath;
  while (true) {
    const ref = current.extends;
    if (ref === undefined) return layers;
    if (typeof ref !== "string" || !ref.trim()) {
      throw new ConfigError(
        `Invalid "extends"${currentPath ? ` at ${currentPath}` : ""}: expected a non-empty string (a file path or bundle//conceptId ref), got ${JSON.stringify(ref)}.`,
        "INVALID_CONFIG_FILE",
      );
    }
    const { text, resolvedPath } = resolveConfigRefSource(ref, current, currentPath);
    if (visited.has(resolvedPath)) {
      throw new ConfigError(
        `Config "extends" cycle detected: "${ref}"${currentPath ? ` (from ${currentPath})` : ""} resolves back to an already-visited config at ${resolvedPath}.`,
        "INVALID_CONFIG_FILE",
      );
    }
    visited.add(resolvedPath);
    const baseRaw = runConfigFilePipeline(text, resolvedPath);
    layers.push({ ref, raw: baseRaw });
    current = baseRaw;
    currentPath = resolvedPath;
  }
}

/**
 * Deep-merge an `extends` chain into its effective raw shape: each layer's
 * own fields win over its base's (`deepMergeConfig` "local wins" semantics),
 * reduced root-to-local so the local file's fields win overall. `DEFAULT_CONFIG`
 * is NOT applied here — the caller still layers it outermost, unchanged.
 *
 * The merged result's `extends` field, if any, is always the LOCAL file's own
 * literal value (never a base's) — `deepMergeConfig`'s local-wins semantics
 * already guarantee this at every level, since a layer only has `extends` set
 * when it itself declares one. Keeping it (rather than stripping it) lets
 * `akm config set`/`unset` round-trip the directive: both read the effective
 * config as `current` and write a mutated copy of it back to the SAME local
 * file (pre-existing behavior — see `DEFAULT_CONFIG` baking into `config.json`
 * on any write), so stripping `extends` here would silently delete it from
 * disk on the very next `config set`.
 */
function resolveExtendsChain(
  localRaw: Record<string, unknown>,
  configPath: string | undefined,
): Record<string, unknown> {
  const layers = collectExtendsLayers(localRaw, configPath);
  let merged: Record<string, unknown> = {};
  for (let i = layers.length - 1; i >= 0; i--) {
    merged = deepMergeConfig(merged, layers[i]!.raw);
  }
  return merged;
}

/** `~` expands to the home directory, mirroring `apiKeyFile`'s resolution (engine-resolution.ts). */
function expandExtendsHomePath(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

/** True when `ref`'s segment before the first `//` is a legal bundle slug — the `bundle//conceptId` shape, not a filesystem path. */
function looksLikeBundleAssetRef(ref: string): boolean {
  const boundary = ref.indexOf("//");
  return boundary > 0 && isBundleSlug(ref.slice(0, boundary));
}

/**
 * Resolve an `extends` value (or a `config diff <ref>` CLI argument — same
 * grammar) to its config text and the absolute path it was read from. Either
 * a filesystem path (relative to the directory of `fromConfigPath`; `~`
 * expands) or a `bundle//conceptId` asset ref, resolved against `context`'s
 * `bundles` map WITHOUT the index (`bundles[<bundle>].path` ->
 * `bundleContentRoot` -> `stashDirFor(type)` + `assetPathForName`, per
 * AGENTS.md's "show is local-index only"). No URL form and no fetch/sync —
 * the source must already exist locally; a missing file/bundle throws
 * {@link ConfigError} naming the ref.
 */
function resolveConfigRefSource(
  ref: string,
  context: Record<string, unknown>,
  fromConfigPath: string | undefined,
): { text: string; resolvedPath: string } {
  return looksLikeBundleAssetRef(ref)
    ? resolveConfigBundleRefSource(ref, context)
    : resolveConfigFileRefSource(ref, fromConfigPath);
}

function resolveConfigFileRefSource(
  ref: string,
  fromConfigPath: string | undefined,
): { text: string; resolvedPath: string } {
  const expanded = expandExtendsHomePath(ref);
  let resolvedPath: string;
  if (path.isAbsolute(expanded)) {
    resolvedPath = expanded;
  } else if (fromConfigPath) {
    resolvedPath = path.resolve(path.dirname(fromConfigPath), expanded);
  } else {
    throw new ConfigError(
      `extends "${ref}" is a relative path, but the current config has no known file location to resolve it against.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const text = readConfigText(resolvedPath);
  if (text === undefined) {
    throw new ConfigError(
      `extends "${ref}" resolves to ${resolvedPath}, which does not exist. Create the file first, or point "extends" at an existing config.`,
      "INVALID_CONFIG_FILE",
    );
  }
  return { text, resolvedPath };
}

function resolveConfigBundleRefSource(
  ref: string,
  context: Record<string, unknown>,
): { text: string; resolvedPath: string } {
  let parsedRef: BundleRef;
  try {
    parsedRef = parseBundleRef(ref);
  } catch (err) {
    throw new ConfigError(
      `Invalid "extends" bundle ref "${ref}": ${err instanceof Error ? err.message : String(err)}`,
      "INVALID_CONFIG_FILE",
    );
  }
  const bundleId = parsedRef.bundle;
  if (!bundleId) {
    throw new ConfigError(
      `"extends" bundle ref "${ref}" must be fully qualified as bundle//conceptId.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const bundles = isRecord(context.bundles) ? context.bundles : undefined;
  const bundleEntry = bundles?.[bundleId];
  const bundlePath =
    isRecord(bundleEntry) && typeof bundleEntry.path === "string" && bundleEntry.path.length > 0
      ? bundleEntry.path
      : undefined;
  if (!bundlePath || !isRecord(bundleEntry)) {
    throw new ConfigError(
      `extends "${ref}" names bundle "${bundleId}", which is not a configured filesystem bundle (bundles.${bundleId}.path). Only a filesystem bundle can host an "extends" source.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const components = isRecord(bundleEntry.components) ? Object.values(bundleEntry.components) : [];
  const componentRoot =
    isRecord(components[0]) && typeof components[0].root === "string" ? components[0].root : undefined;
  const bundleRoot = bundleContentRoot(bundlePath, componentRoot);

  const parts = typeNameFromConceptId(parsedRef.conceptId);
  if (!parts) {
    throw new ConfigError(
      `extends "${ref}": conceptId "${parsedRef.conceptId}" does not name a recognized asset type.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const typeRoot = path.join(bundleRoot, stashDirFor(parts.type) as string);
  const resolvedPath = assetPathForName(parts.type, typeRoot, parts.name);
  const text = readConfigText(resolvedPath);
  if (text === undefined) {
    throw new ConfigError(
      `extends "${ref}" resolves to ${resolvedPath}, which does not exist locally. Sync the bundle first, or point "extends" at an existing file.`,
      "INVALID_CONFIG_FILE",
    );
  }
  return { text, resolvedPath };
}

/**
 * `akm config get --show-source` (#945): which raw layer the dotted path's
 * value comes from — `"local"` when the local file's own raw JSON sets it,
 * `"extends:<ref>"` for the nearest chain member that sets it (the ref by
 * which that member is reached), or `"default"` when no layer sets it
 * (`DEFAULT_CONFIG` or schema default supplies it). Computed lazily by
 * re-walking the raw layers on each call — no merge-time bookkeeping.
 */
export function getConfigValueSource(dotted: string): string {
  const configPath = getConfigPath();
  const text = readConfigText(configPath);
  if (text === undefined) return "default";
  const liftedConfig = runConfigFilePipeline(text, configPath);
  const segments = dotted.split(".").filter((s) => s.length > 0);
  for (const layer of collectExtendsLayers(liftedConfig, configPath)) {
    if (hasRawPath(layer.raw, segments)) {
      return layer.ref === undefined ? "local" : `extends:${layer.ref}`;
    }
  }
  return "default";
}

function hasRawPath(raw: unknown, segments: string[]): boolean {
  let cursor: unknown = raw;
  for (const segment of segments) {
    if (!isRecord(cursor) || !(segment in cursor)) return false;
    cursor = cursor[segment];
  }
  return true;
}

// Exposed for `akm config diff` (config-cli.ts): the `<path|bundle//ref>`
// argument shares the exact same resolution grammar as `extends`.
export { resolveConfigRefSource };

/**
 * The configured stash sources as an ordered {@link SourceConfigEntry} list.
 *
 * Every source is a `bundles.<slug>` entry. This derives the provider-ready
 * source list from `bundles` (defaultBundle first, then map order). Returns
 * `[]` when no bundles are configured.
 */
export function getSources(config: AkmConfig): SourceConfigEntry[] {
  return bundlesToSourceEntries(config) ?? [];
}

export function getEffectiveRegistries(config: AkmConfig): RegistryConfigEntry[] {
  return config.registries ?? DEFAULT_CONFIG.registries ?? [];
}

type NamedKeys<T> = keyof {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: unknown;
};
export type ImproveProcessName = NamedKeys<NonNullable<ImproveProfileConfig["processes"]>>;

/**
 * Transitional internal accessor. It deliberately never consults a configured
 * default strategy; callers must pass their already selected strategy.
 */
export function getImproveProcessConfig(
  processName: ImproveProcessName,
  selected?: ImproveProfileConfig,
): ImproveProcessConfig | undefined {
  return selected?.processes?.[processName];
}

export function loadConfig(): AkmConfig {
  return loadUserConfig();
}

export function saveConfig(config: AkmConfig): void {
  // Every lifecycle write produces the only config version this binary can load.
  const currentConfig = { ...config, configVersion: CURRENT_CONFIG_VERSION } as AkmConfig;
  saveConfigReal(currentConfig);
}

function saveConfigReal(config: AkmConfig): void {
  cachedConfig = undefined;
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  withConfigLock(() => {
    const validated = validateCompleteConfig(config);
    backupExistingConfig(configPath);
    writeConfigAtomic(configPath, sanitizeConfigForWrite(validated));
  });
}

export function validateCompleteConfig(config: AkmConfig): AkmConfig {
  const parseResult = AkmConfigSchema.safeParse(config);
  if (parseResult.success) return parseResult.data;
  const lines = parseResult.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
  throw new ConfigError(
    `Refusing to save invalid config:\n${lines}`,
    "INVALID_CONFIG_FILE",
    "Fix the listed fields, or undo the offending `akm config set`. " +
      "If this looks like an akm bug, re-run with --debug to attach the traceback.",
  );
}

export interface ConfigMutationResult {
  config: AkmConfig;
  written: boolean;
}

/**
 * Mutate config under one fail-closed lock spanning read, merge, validation,
 * ordinary backup, and atomic write.
 */
export function mutateConfig(
  mutate: (current: AkmConfig) => AkmConfig,
  options?: { absentNoop?: boolean },
): ConfigMutationResult {
  cachedConfig = undefined;
  const configPath = getConfigPath();
  return withConfigLock(() => {
    const text = readConfigText(configPath);
    if (text === undefined && options?.absentNoop) {
      return { config: { ...DEFAULT_CONFIG }, written: false };
    }
    const current =
      text === undefined ? ({ ...DEFAULT_CONFIG } as AkmConfig) : parseAndValidateConfigText(text, configPath);
    const mutated = mutate(current);
    if (mutated === current) return { config: current, written: false };
    const next = validateCompleteConfig({ ...mutated, configVersion: CURRENT_CONFIG_VERSION });
    if (text !== undefined) backupExistingConfig(configPath);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    writeConfigAtomic(configPath, sanitizeConfigForWrite(next));
    return { config: next, written: true };
  });
}

/**
 * Mutate config while holding the write lock across one validated pre-commit
 * side effect. Setup uses this to reject a three-way conflict before creating
 * its stash, while preventing another config writer from racing the final save.
 */
export async function mutateConfigWithPrecommit<T>(
  mutate: (current: AkmConfig) => AkmConfig,
  precommit: (next: AkmConfig) => Promise<T>,
): Promise<ConfigMutationResult & { precommit: T }> {
  cachedConfig = undefined;
  const configPath = getConfigPath();
  const release = acquireConfigLock();
  try {
    const text = readConfigText(configPath);
    const current =
      text === undefined ? ({ ...DEFAULT_CONFIG } as AkmConfig) : parseAndValidateConfigText(text, configPath);
    const mutated = mutate(current);
    const next = validateCompleteConfig({ ...mutated, configVersion: CURRENT_CONFIG_VERSION });
    if (text !== undefined) backupExistingConfig(configPath);
    const precommitResult = await precommit(next);
    if (mutated === current) return { config: current, written: false, precommit: precommitResult };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    writeConfigAtomic(configPath, sanitizeConfigForWrite(next));
    return { config: next, written: true, precommit: precommitResult };
  } finally {
    release();
  }
}

/**
 * Strip literal apiKey fields before writing config to disk.
 * API keys are expected to come from environment variables
 * (AKM_EMBED_API_KEY, AKM_LLM_API_KEY, AKM_ENGINE_<NAME>_API_KEY).
 *
 * `${VAR}` / `$VAR` references are preserved — they are not secrets, they
 * are deferred lookups resolved at consumption by `resolveSecret`. Dropping
 * them would break the documented config-on-disk pattern.
 *
 * When a non-reference literal value is stripped, emit a `warn()` so the
 * user knows their key was dropped and how to provide it at runtime (#474).
 * Previously the strip was silent — a user invoking `akm setup --from <file>
 * --yes` with an `apiKey` field expected persistence and got a wiped config
 * with no feedback.
 */
export function sanitizeConfigForWrite(config: AkmConfig): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { ...config };
  const stripped: string[] = [];

  if (config.embedding?.apiKey !== undefined) {
    const apiKey = config.embedding.apiKey;
    if (isApiKeyReference(apiKey)) {
      // Preserve reference verbatim — not a secret.
      sanitized.embedding = { ...config.embedding };
    } else {
      const { apiKey: _drop, ...rest } = config.embedding;
      sanitized.embedding = rest;
      if (apiKey) stripped.push("embedding.apiKey (set AKM_EMBED_API_KEY to provide at runtime)");
    }
  } else if (config.embedding) {
    sanitized.embedding = { ...config.embedding };
  }

  if (config.engines) {
    const engines: Record<string, unknown> = {};
    for (const [name, engine] of Object.entries(config.engines)) {
      if (engine.kind !== "llm" || engine.apiKey === undefined || isApiKeyReference(engine.apiKey)) {
        engines[name] = { ...engine };
        continue;
      }
      const { apiKey: _drop, ...rest } = engine;
      engines[name] = rest;
      if (engine.apiKey) stripped.push(`engines.${name}.apiKey`);
    }
    sanitized.engines = engines;
  }

  if (stripped.length > 0) {
    warn(
      `Config sanitizer dropped API key(s) before writing to disk:\n  - ${stripped.join("\n  - ")}\n\nakm does not persist API keys to config.json. Set the listed environment variables to provide them at runtime, or use \`\${VAR}\` references in your config to defer lookup. See docs/reference/data-and-telemetry.md.`,
    );
  }

  if (config.registries) {
    const droppedRegistries: string[] = [];
    const registries = config.registries.filter((entry) => {
      if (!hasRegistryUrlCredentials(entry.url)) return true;
      droppedRegistries.push(formatRegistryLabel(entry));
      return false;
    });
    if (droppedRegistries.length > 0) {
      sanitized.registries = registries;
      warn(
        `Config sanitizer dropped registry entr${droppedRegistries.length === 1 ? "y" : "ies"} with URL credentials before writing to disk:\n  - ${droppedRegistries.join("\n  - ")}\n\nRegistry URLs must be credential-free; configure a credential-free HTTPS endpoint.`,
      );
    }
  }

  return sanitized;
}

export function updateConfig(partial: Partial<AkmConfig>): AkmConfig {
  return mutateConfig((current) => deepMergeConfig(current, partial) as AkmConfig).config;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Looks up a `secret://<name>` reference's stored value, or `null` if it isn't there. Implemented by `resolveSecretFromStore` in `sources/snapshot-fetchers/secret-seam.ts`; passed in rather than imported here to avoid a cycle (that module's dependencies import this one). */
export type SecretStoreResolver = (ref: string) => string | null;

/**
 * Resolve a single secret value: expand `${VAR}` / `$VAR` against
 * `process.env`, or look up `secret://<name>` via `resolveFromStore`. Use this
 * at apiKey / authorization-header consumption sites (LLM client, embedder,
 * agent SDK runner) — NOT on the load path. Non-string inputs pass through
 * unchanged.
 *
 * Returns the input unchanged when no substitution markers are present, so
 * literal API key strings (already-resolved secrets) are zero-cost.
 *
 * Other config string values (URLs, endpoints, model names, prompts) are
 * preserved verbatim on read — only fields explicitly routed through this
 * helper are expanded.
 *
 * A `secret://<name>` value that fails to resolve throws `ConfigError`
 * (naming the ref, never the secret) rather than silently sending an unusable
 * credential.
 */
export function resolveSecret(value: string | undefined, resolveFromStore?: SecretStoreResolver): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return value;
  const storeRef = SECRET_STORE_REFERENCE_PATTERN.exec(value)?.[1];
  if (storeRef !== undefined) {
    const resolved = resolveFromStore?.(storeRef) ?? null;
    if (resolved === null) {
      throw new ConfigError(
        `Secret store reference "${value}" did not resolve to a stored value.`,
        "SECRET_REFERENCE_UNRESOLVED",
      );
    }
    return resolved;
  }
  if (!value.includes("$")) return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, bare) => {
    return process.env[(braced ?? bare) as string] ?? "";
  });
}

/**
 * Read a per-pass {@link IndexPassConfig} entry from {@link IndexConfig},
 * filtering out the reserved feature-section keys so callers don't mistake
 * `metadataEnhance` for a pass.
 */
/** Reserved well-known keys on IndexConfig that are NOT per-pass entries. */
const INDEX_RESERVED_KEYS = new Set(["metadataEnhance"]);

export function getIndexPassConfig(config: IndexConfig | undefined, passName: string): IndexPassConfig | undefined {
  if (!config) return undefined;
  if (INDEX_RESERVED_KEYS.has(passName)) return undefined;
  const entry = config[passName];
  if (!entry || typeof entry !== "object") return undefined;
  return entry as IndexPassConfig;
}

// Re-export source runtime helpers — implementation lives in config-sources.ts.
export {
  bundleComponentConfig,
  bundleContentRoot,
  bundleContentRoots,
  bundleEntryToSourceEntry,
  bundleKeyForContentRoot,
  bundlesToSourceEntries,
  installedSourceDescriptor,
  parseSourceSpec,
  primaryBundlePath,
  resolveConfiguredSources,
} from "./config-sources";

/**
 * Merge a partial user-config override onto a base config. Used by
 * {@link loadUserConfig} (DEFAULT_CONFIG + on-disk) and {@link updateConfig}
 * (current config + partial patch). Sub-objects with named records (profiles,
 * defaults, etc.) shallow-merge; arrays override wholesale.
 */
