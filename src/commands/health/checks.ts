// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { spawnSync } from "node:child_process";
import { type AkmConfig, type LlmConnectionConfig, loadConfig } from "../../core/config/config";
import { ConfigError } from "../../core/errors";
import { listPendingStateMigrations } from "../../core/state-db";
import type { WhichFn } from "../../integrations/agent/detect";
import { withEngineFallback } from "../../integrations/agent/engine-fallback";
import { lookupApiKeyFileValue, resolveEngine } from "../../integrations/agent/engine-resolution";
import { executionEngineDefinitionsFromConfig } from "../../integrations/agent/execution-definitions";
import {
  type LoadedModelMap,
  type LoadModelMapOptions,
  loadModelMap,
  mergeModelMapLayers,
  parseModelMapLayer,
  readInstalledModelMapText,
  resolveModelMapAlias,
  userModelMapPath,
} from "../../integrations/agent/model-map";
import type { RunnerSpec } from "../../integrations/agent/runner";
import type { ExtractOutcomeCount } from "../../storage/repositories/extract-sessions-repository";
import { resolveImprovePlan } from "../improve/improve-strategies";
import { ACTIVE_RUN_WARN_MS, type HealthCheckResult, type ImproveHealthMetrics, TASK_FAIL_RATE_WARN } from "./types";

/**
 * #914: skip-reasons that indicate infrastructure being down rather than a
 * session being legitimately uninteresting. Duplicated here (rather than
 * imported) because `src/core/improve-types.ts` is owned by a parallel
 * change on this release — unify with `EXTRACT_INFRASTRUCTURE_SKIP_REASONS`
 * (improve-types) once #912 lands.
 */
const INFRASTRUCTURE_SKIP_REASONS = ["llm_unavailable", "read_failed", "exception", "locked_concurrent"] as const;

/**
 * Pre-computed inputs shared by the health-check registry. `akmHealth` runs the
 * (verbatim) probes/queries once, populates this context, then dispatches each
 * registered {@link HealthCheck} in declaration order. Keeping all probe state
 * here lets every check be a pure projection — no check re-runs IO — so the
 * emitted hardChecks/advisories arrays are byte-identical to the previous
 * inline implementation.
 */
export interface HealthCheckContext {
  stateDbPath: string;
  since: string;
  /** Sorted names of the state.db tables that exist among the required set. */
  tableNames: string[];
  /** Required tables absent from {@link tableNames}. */
  missingTables: string[];
  /** Result of the append/read round-trip probe. */
  probe: { ok: boolean; durationMs: number | null; error?: string };
  /** Total task_history rows read in the window. */
  taskRowCount: number;
  /** Fraction of task_history rows in the window whose status is `failed` (0..1, raw). */
  taskFailRate: number;
  /** task_history rows whose log_path is non-null. */
  taskRowsWithLogsCount: number;
  /** Subset of {@link taskRowsWithLogsCount} whose log_path resolves on disk. */
  existingLogRowsCount: number;
  logBackingRate: number;
  /** Active runs older than the stale threshold. */
  stuckActiveRuns: number;
  /** One entry per {@link stuckActiveRuns} row: which task and how stale. */
  stuckActiveTasks: { taskId: string; ageMs: number }[];
  /**
   * The task_id with the highest per-task fail rate among tasks with at least
   * `MIN_ROWS_FOR_WORST_TASK_FAIL_RATE` rows in the window. `null` when no
   * task_id meets the row-count floor.
   */
  worstTaskFailRate: { taskId: string; rate: number; rows: number } | null;
  sessionExtraction: ImproveHealthMetrics["sessionExtraction"];
  /**
   * #914: `extract_sessions_seen` outcome counts for the rolling 7-day
   * ledger window (independent of the top-level `--since`) — what lets
   * `session-extraction` tell "off on purpose" apart from "broken" on a
   * hook-driven (`akm proposal extract --session-id`) machine, which never
   * writes an `improve_runs` row at all.
   */
  sessionExtractionLedger: { since: string; rows: ExtractOutcomeCount[] };
  autoAccept: ImproveHealthMetrics["autoAccept"];
  /** Engine availability collected once and shared by its three registry projections. */
  engineProbes: HealthEngineProbeResults;
}

/** Which array a check's result is collected into. */
export type HealthCheckChannel = "hard" | "advisory";

/**
 * A single health check: a named probe that projects pre-computed context into
 * one {@link HealthCheckResult}. The `channel` decides whether the result lands
 * in `hardChecks` (can gate overall status) or `advisories`.
 */
export interface HealthCheck {
  name: string;
  channel: HealthCheckChannel;
  run(ctx: HealthCheckContext): HealthCheckResult;
}

/**
 * Probe the configured agent profile. Self-contained (reads config + PATH); the
 * only check that performs IO at dispatch time, preserving the original inline
 * `runDefaultEngineProbe()` call site behaviour exactly.
 */
export interface DefaultEngineProbeDependencies {
  loadConfig?: () => AkmConfig;
  resolveEngine?: (name: string, config: AkmConfig) => RunnerSpec;
  spawnSync?: typeof spawnSync;
  resolvePackage?: (name: string) => string;
  which?: WhichFn;
  env?: NodeJS.ProcessEnv;
  /**
   * #914: reachability seam for a `kind: "llm"` runner's connection, and an
   * SDK runner's LLM fallback connection. Absent ⇒ the probe is skipped and
   * the check's message notes that reachability was not probed — this keeps
   * every existing caller (including the whole test suite, which never
   * supplies this) fully offline. The CLI wires the real `probeLlmReachable`
   * (`src/llm/client.ts`) here unless `--no-probe` is given.
   */
  probeReachable?: (connection: LlmConnectionConfig) => Promise<{ reachable: boolean; error?: string }>;
}

/**
 * Endpoint → in-flight/settled reachability probe, scoped to ONE call of an
 * engine-probe entry point (never shared across health invocations — #914's
 * fix spec is explicit that a cross-run cache would reintroduce the stale
 * "reachable" verdict this check exists to catch). Callers create a fresh
 * `Map` per call; distinct engine NAMES that resolve to the same endpoint
 * (e.g. `default-llm-engine` and a `configured-engines` entry) share one
 * probe instead of hitting the endpoint twice.
 */
type ReachabilityCache = Map<string, Promise<{ reachable: boolean; error?: string }>>;

interface ReachabilityOutcome {
  probed: boolean;
  reachable: boolean | null;
  error?: string;
}

/** Probe (and de-dupe by endpoint) one LLM connection's reachability, bounded to a 3s timeout applied only to this probe call. */
async function probeConnectionReachable(
  connection: LlmConnectionConfig,
  deps: DefaultEngineProbeDependencies,
  cache: ReachabilityCache,
): Promise<ReachabilityOutcome> {
  if (!deps.probeReachable) return { probed: false, reachable: null };
  const key = connection.endpoint;
  let pending = cache.get(key);
  if (!pending) {
    pending = deps.probeReachable({ ...connection, timeoutMs: 3000 });
    cache.set(key, pending);
  }
  const result = await pending;
  return { probed: true, reachable: result.reachable, ...(result.error ? { error: result.error } : {}) };
}

/**
 * #914: an unreachable LLM engine is a hard `fail` when it is the resolved
 * `default-llm-engine` — extraction and improve depend on it directly — but
 * only a `warn` for the identical probe result viewed as `default-engine` or
 * a `configured-engines` entry. Escalates ONLY a reachability-derived warn
 * (`evidence.reachable === false`); a credential-unavailable warn is
 * untouched, matching the fix spec's "keep the credential-unavailable branch
 * as it is."
 */
function escalateDefaultLlmEngineFailure(result: HealthCheckResult): HealthCheckResult {
  if (result.status === "warn" && result.evidence?.reachable === false) {
    return { ...result, status: "fail" };
  }
  return result;
}

export interface SelectedModelAliasesProbeDependencies extends LoadModelMapOptions {
  loadConfig?: () => AkmConfig;
  loadModelMap?: (options: LoadModelMapOptions) => LoadedModelMap;
}

export interface HealthEngineProbeResults {
  readonly defaultEngine: HealthCheckResult;
  readonly defaultLlmEngine: HealthCheckResult;
  readonly configuredEngines: HealthCheckResult;
}

function credentialAvailable(
  credential: { names: readonly string[]; required: boolean } | undefined,
  env: NodeJS.ProcessEnv,
  apiKeyFile?: string,
): boolean {
  if (credential?.required) return credential.names.some((name) => Boolean(env[name]?.trim()));
  // #905: an engine with no env descriptor may still require a file-backed
  // credential — probe it too, rather than reporting an unreadable/empty
  // apiKeyFile as available just because it carries no env var names.
  if (apiKeyFile !== undefined) return lookupApiKeyFileValue(apiKeyFile) !== undefined;
  return true;
}

async function runConfiguredEngineProbe(
  checkName: string,
  engineName: string | undefined,
  config: AkmConfig,
  deps: DefaultEngineProbeDependencies,
  reachabilityCache: ReachabilityCache,
): Promise<HealthCheckResult> {
  if (!engineName) {
    return {
      name: checkName,
      kind: "deterministic",
      status: "unknown",
      confidence: "high",
      message:
        checkName === "default-llm-engine"
          ? "No default LLM engine is configured."
          : "No default engine is configured.",
    };
  }
  const env = deps.env ?? process.env;
  const configuredEngine = config.engines?.[engineName];
  if (configuredEngine?.kind === "agent" && configuredEngine.platform === "opencode-sdk") {
    let packageAvailable = false;
    try {
      const resolvePackage = deps.resolvePackage ?? ((name: string) => import.meta.resolve(name));
      resolvePackage("@opencode-ai/sdk");
      packageAvailable = true;
    } catch {
      packageAvailable = false;
    }
    const binary = configuredEngine.bin ?? "opencode";
    let binaryAvailable: boolean;
    try {
      const version = (deps.spawnSync ?? spawnSync)(binary, ["--version"], { encoding: "utf8", timeout: 5_000 });
      binaryAvailable = (version.status ?? 1) === 0;
    } catch {
      return {
        name: checkName,
        kind: "deterministic",
        status: "warn",
        confidence: "high",
        message: `SDK engine "${engineName}" executable availability could not be checked.`,
        evidence: { engine: engineName, runtimeKind: "sdk", binaryAvailable: false },
      };
    }
    const fallbackEngine = configuredEngine.llmEngine ?? config.defaults?.llmEngine;
    let fallback: Extract<RunnerSpec, { kind: "llm" }> | undefined;
    let fallbackCredential: Extract<RunnerSpec, { kind: "llm" }>["credential"];
    let fallbackApiKeyFile: string | undefined;
    let sdkRunner: Extract<RunnerSpec, { kind: "sdk" }> | undefined;
    const resolve = deps.resolveEngine ?? resolveEngine;
    try {
      const resolved = resolve(engineName, config);
      if (resolved.kind === "sdk") sdkRunner = resolved;
    } catch {
      sdkRunner = undefined;
    }
    if (sdkRunner?.fallbackConnection && fallbackEngine) {
      fallback = { kind: "llm", engine: fallbackEngine, connection: sdkRunner.fallbackConnection };
      fallbackCredential = sdkRunner.fallbackCredential;
      fallbackApiKeyFile = sdkRunner.fallbackApiKeyFile;
    } else if (fallbackEngine) {
      try {
        const resolved = resolve(fallbackEngine, config);
        if (resolved.kind === "llm") {
          fallback = resolved;
          fallbackCredential = resolved.credential;
          fallbackApiKeyFile = resolved.apiKeyFile;
        }
      } catch {
        fallback = undefined;
      }
    }
    const configuredModel = configuredEngine.model;
    const effectiveModel = sdkRunner?.profile.model ?? configuredModel ?? fallback?.connection.model;
    const fallbackCredentialAvailable = credentialAvailable(fallbackCredential, env, fallbackApiKeyFile);
    const missing = [
      !packageAvailable ? "@opencode-ai/sdk package" : undefined,
      !binaryAvailable ? `${binary} binary` : undefined,
      fallbackEngine && !fallback ? "configured fallback LLM connection" : undefined,
      !fallbackCredentialAvailable ? "required fallback credential" : undefined,
    ].filter((value): value is string => value !== undefined);
    const sdkEvidence = {
      engine: engineName,
      platform: configuredEngine.platform,
      runtimeKind: "sdk",
      binary,
      binaryAvailable,
      package: "@opencode-ai/sdk",
      packageAvailable,
      model: effectiveModel ?? null,
      configuredModel: configuredModel ?? null,
      modelSource: configuredModel ? "sdk" : effectiveModel ? "fallback" : null,
      fallbackEngine: fallbackEngine ?? null,
      fallbackEndpoint: fallback?.connection.endpoint ?? null,
      fallbackModel: fallback?.connection.model ?? null,
      requiredCredentialAvailable: fallbackCredentialAvailable,
    };
    if (missing.length > 0) {
      return {
        name: checkName,
        kind: "deterministic",
        status: "warn",
        confidence: "high",
        message: `SDK engine "${engineName}" is incomplete: missing ${missing.join(", ")}.`,
        evidence: sdkEvidence,
      };
    }
    // #914: probe the SDK's LLM fallback connection — the only place this
    // engine actually talks to a network endpoint. Ordering matches the
    // plain-LLM branch below: only reached once every non-network
    // precondition (package, binary, fallback resolution, credential) is
    // already satisfied.
    if (fallback) {
      const reach = await probeConnectionReachable(fallback.connection, deps, reachabilityCache);
      if (reach.probed) {
        return {
          name: checkName,
          kind: "deterministic",
          status: reach.reachable ? "pass" : "warn",
          confidence: "high",
          message: reach.reachable
            ? `SDK engine "${engineName}" is available and its LLM fallback is reachable.`
            : `SDK engine "${engineName}" is available, but its LLM fallback is not reachable: ${reach.error ?? "unknown error"}`,
          evidence: {
            ...sdkEvidence,
            probed: true,
            reachable: reach.reachable,
            ...(reach.error ? { error: reach.error } : {}),
          },
        };
      }
      return {
        name: checkName,
        kind: "deterministic",
        status: "pass",
        confidence: "high",
        message: `SDK engine "${engineName}" is available. Reachability was not probed.`,
        evidence: { ...sdkEvidence, probed: false, reachable: null },
      };
    }
    return {
      name: checkName,
      kind: "deterministic",
      status: "pass",
      confidence: "high",
      message: `SDK engine "${engineName}" is available.`,
      evidence: sdkEvidence,
    };
  }
  try {
    const runner = (deps.resolveEngine ?? resolveEngine)(engineName, config);
    if (runner.kind === "llm") {
      const requiredCredentialAvailable = credentialAvailable(runner.credential, env, runner.apiKeyFile);
      const llmEvidence = {
        engine: engineName,
        platform: null,
        runtimeKind: "llm",
        model: runner.connection.model,
        endpoint: runner.connection.endpoint,
        requiredCredentialAvailable,
      };
      if (!requiredCredentialAvailable) {
        return {
          name: checkName,
          kind: "deterministic",
          status: "warn",
          confidence: "high",
          message: `LLM engine "${engineName}" is configured, but its required credential is unavailable.`,
          evidence: llmEvidence,
        };
      }
      // #914: reachability probe — bounded to a 3s timeout (see
      // probeConnectionReachable) and shared across every engine name that
      // resolves to this same endpoint within this health invocation.
      const reach = await probeConnectionReachable(runner.connection, deps, reachabilityCache);
      if (!reach.probed) {
        return {
          name: checkName,
          kind: "deterministic",
          status: "pass",
          confidence: "high",
          message: `LLM engine "${engineName}" is configured. Reachability was not probed.`,
          evidence: { ...llmEvidence, probed: false, reachable: null },
        };
      }
      return {
        name: checkName,
        kind: "deterministic",
        status: reach.reachable ? "pass" : "warn",
        confidence: "high",
        message: reach.reachable
          ? `LLM engine "${engineName}" is configured and reachable.`
          : `LLM engine "${engineName}" is not reachable: ${reach.error ?? "unknown error"}`,
        evidence: {
          ...llmEvidence,
          probed: true,
          reachable: reach.reachable,
          ...(reach.error ? { error: reach.error } : {}),
        },
      };
    }
    const profile = runner.profile;
    if (runner.kind === "sdk") throw new Error(`SDK engine "${engineName}" has no matching SDK config.`);
    const version = (deps.spawnSync ?? spawnSync)(profile.bin, ["--version"], { encoding: "utf8", timeout: 5_000 });
    if ((version.status ?? 1) !== 0) {
      return {
        name: checkName,
        kind: "deterministic",
        status: "warn",
        confidence: "medium",
        message: `Agent engine "${engineName}" was found but \`--version\` failed.`,
        evidence: {
          engine: engineName,
          platform: profile.platform ?? null,
          runtimeKind: "agent",
          model: profile.model ?? null,
        },
      };
    }
    return {
      name: checkName,
      kind: "deterministic",
      status: "pass",
      confidence: "high",
      message: `Agent engine "${engineName}" is available.`,
      evidence: {
        engine: engineName,
        platform: profile.platform ?? null,
        runtimeKind: "agent",
        model: profile.model ?? null,
      },
    };
  } catch (error) {
    return {
      name: checkName,
      kind: "deterministic",
      status: "warn",
      confidence: "high",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function projectEngineProbe(result: HealthCheckResult, name: string): HealthCheckResult {
  return result.name === name ? result : { ...result, name };
}

function projectSelectedEngineProbe(
  availability: ReadonlyMap<string, HealthCheckResult>,
  engineName: string,
  checkName: "default-engine" | "default-llm-engine",
): HealthCheckResult {
  const result = availability.get(engineName);
  if (result) {
    const projected = projectEngineProbe(result, checkName);
    return checkName === "default-llm-engine" ? escalateDefaultLlmEngineFailure(projected) : projected;
  }
  return {
    name: checkName,
    kind: "deterministic",
    status: "warn",
    confidence: "high",
    message: `Engine "${engineName}" availability could not be checked.`,
    evidence: { engine: engineName },
  };
}

function unconfiguredEngineProbe(name: "default-engine" | "default-llm-engine"): HealthCheckResult {
  return {
    name,
    kind: "deterministic",
    status: "unknown",
    confidence: "high",
    message:
      name === "default-llm-engine" ? "No default LLM engine is configured." : "No default engine is configured.",
  };
}

function configuredEnginesProjection(
  engineNames: readonly string[],
  availability: ReadonlyMap<string, HealthCheckResult>,
): HealthCheckResult {
  if (engineNames.length === 0) {
    return {
      name: "configured-engines",
      kind: "deterministic",
      status: "unknown",
      confidence: "high",
      message: "No engines are explicitly configured.",
      evidence: { engines: [] },
    };
  }

  const engines = engineNames.map((engine) => ({
    engine,
    status: availability.get(engine)?.status === "pass" ? ("pass" as const) : ("warn" as const),
  }));
  const unavailable = engines.filter((engine) => engine.status === "warn").length;
  return {
    name: "configured-engines",
    kind: "deterministic",
    status: unavailable === 0 ? "pass" : "warn",
    confidence: "high",
    message:
      unavailable === 0
        ? `All ${engines.length} explicitly configured engines are available.`
        : `${unavailable} of ${engines.length} explicitly configured engines ${unavailable === 1 ? "is" : "are"} unavailable.`,
    evidence: { engines },
  };
}

export async function runDefaultEngineProbe(deps: DefaultEngineProbeDependencies = {}): Promise<HealthCheckResult> {
  // Probe the effective view: an install with no `defaults.engine` but a usable
  // opencode binary DOES have a working default, and reporting otherwise would
  // contradict what `workflow run` / `task run` actually do.
  const { config } = withEngineFallback(deps.loadConfig?.() ?? loadConfig(), deps.which);
  return runConfiguredEngineProbe("default-engine", config.defaults?.engine, config, deps, new Map());
}

export async function runDefaultLlmEngineProbe(deps: DefaultEngineProbeDependencies = {}): Promise<HealthCheckResult> {
  const config = deps.loadConfig?.() ?? loadConfig();
  const result = await runConfiguredEngineProbe(
    "default-llm-engine",
    config.defaults?.llmEngine,
    config,
    deps,
    new Map(),
  );
  return escalateDefaultLlmEngineFailure(result);
}

/** Probe every explicitly configured engine without exposing connection or model material. */
export async function runConfiguredEnginesProbe(deps: DefaultEngineProbeDependencies = {}): Promise<HealthCheckResult> {
  const config = deps.loadConfig?.() ?? loadConfig();
  const engineNames = Object.keys(config.engines ?? {}).sort();
  const cache: ReachabilityCache = new Map();
  const availability = new Map(
    await Promise.all(
      engineNames.map(
        async (engine) =>
          [engine, await runConfiguredEngineProbe("configured-engine", engine, config, deps, cache)] as const,
      ),
    ),
  );
  return configuredEnginesProjection(engineNames, availability);
}

/**
 * Build the per-health-run availability snapshot. Each distinct selected or
 * explicitly configured engine is probed once (reachability probes further
 * de-duped by endpoint, see {@link ReachabilityCache}); the three public
 * checks are projections of that immutable result set.
 */
export async function runHealthEngineProbes(
  deps: DefaultEngineProbeDependencies = {},
): Promise<HealthEngineProbeResults> {
  const configured = deps.loadConfig?.() ?? loadConfig();
  const effective = withEngineFallback(configured, deps.which).config;
  const defaultEngineName = effective.defaults?.engine;
  const defaultLlmEngineName = configured.defaults?.llmEngine;
  const explicitEngineNames = Object.keys(configured.engines ?? {}).sort();
  const probeNames = [...new Set([...explicitEngineNames, defaultEngineName, defaultLlmEngineName])]
    .filter((name): name is string => name !== undefined)
    .sort();
  const cache: ReachabilityCache = new Map();
  const availability = new Map(
    await Promise.all(
      probeNames.map(
        async (engine) =>
          [engine, await runConfiguredEngineProbe("configured-engine", engine, effective, deps, cache)] as const,
      ),
    ),
  );

  return Object.freeze({
    defaultEngine: defaultEngineName
      ? projectSelectedEngineProbe(availability, defaultEngineName, "default-engine")
      : unconfiguredEngineProbe("default-engine"),
    defaultLlmEngine: defaultLlmEngineName
      ? projectSelectedEngineProbe(availability, defaultLlmEngineName, "default-llm-engine")
      : unconfiguredEngineProbe("default-llm-engine"),
    configuredEngines: configuredEnginesProjection(explicitEngineNames, availability),
  });
}

export function runActiveImproveStrategyProbe(deps: DefaultEngineProbeDependencies = {}): HealthCheckResult {
  const config = deps.loadConfig?.() ?? loadConfig();
  const strategyName = config.defaults?.improveStrategy ?? "default";
  try {
    const plan = resolveImprovePlan(strategyName, config);
    const env = deps.env ?? process.env;
    const unavailableProcesses = Object.entries(plan.processes).flatMap(([name, process]) => {
      if (!process.enabled || !process.runner) return [];
      return credentialAvailable(process.runner.credential, env, process.runner.apiKeyFile) ? [] : [name];
    });
    if (plan.triageJudgment) {
      const judgmentCredential =
        plan.triageJudgment.kind === "llm"
          ? plan.triageJudgment.credential
          : plan.triageJudgment.kind === "sdk"
            ? plan.triageJudgment.fallbackCredential
            : undefined;
      const judgmentApiKeyFile =
        plan.triageJudgment.kind === "llm"
          ? plan.triageJudgment.apiKeyFile
          : plan.triageJudgment.kind === "sdk"
            ? plan.triageJudgment.fallbackApiKeyFile
            : undefined;
      if (!credentialAvailable(judgmentCredential, env, judgmentApiKeyFile)) {
        unavailableProcesses.push("triage.judgment");
      }
    }
    // #913: name the engine each process actually resolved to, so a
    // strategy-level `engine` pin that shadows `defaults.llmEngine` is
    // visible on `akm health` instead of requiring config archaeology.
    const engines: Record<string, string> = {};
    for (const [name, process] of Object.entries(plan.processes)) {
      if (process.enabled && process.runner) engines[name] = process.runner.engine;
    }
    if (plan.triageJudgment) engines["triage.judgment"] = plan.triageJudgment.engine;
    const engineList = Object.entries(engines)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([process, engine]) => `${process}: "${engine}"`)
      .join(", ");
    return {
      name: "active-improve-strategy",
      kind: "deterministic",
      status: unavailableProcesses.length === 0 ? "pass" : "warn",
      confidence: "high",
      message:
        unavailableProcesses.length === 0
          ? `Active improve strategy "${plan.strategy.name}" has available process engines${engineList ? ` (${engineList})` : ""}.`
          : `Active improve strategy "${plan.strategy.name}" has unavailable required credentials for: ${unavailableProcesses.join(", ")}${engineList ? ` (engines: ${engineList})` : ""}.`,
      evidence: {
        strategy: plan.strategy.name,
        unavailableProcesses,
        engines,
      },
    };
  } catch (error) {
    const explicitlyConfigured =
      config.defaults?.improveStrategy !== undefined || Object.keys(config.improve?.strategies ?? {}).length > 0;
    return {
      name: "active-improve-strategy",
      kind: "deterministic",
      status: explicitlyConfigured ? "warn" : "unknown",
      confidence: "high",
      message: `Active improve strategy "${strategyName}" is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      evidence: { strategy: strategyName, unavailableProcesses: [] },
    };
  }
}

/**
 * Validate the immutable installed model map and optional user overlay.
 * Installed corruption is a package defect (fail); a bad optional user file
 * is operator-fixable configuration (warn); absence is the normal state.
 */
export function runModelMapProbe(options: LoadModelMapOptions = {}): HealthCheckResult {
  let installedText: string;
  try {
    installedText = readInstalledModelMapText(options);
    mergeModelMapLayers(parseModelMapLayer(installedText, "installed models.json"));
  } catch (error) {
    return {
      name: "model-map-files",
      kind: "deterministic",
      status: "fail",
      confidence: "high",
      message: `Installed models.json is invalid; this AKM installation cannot resolve model aliases: ${error instanceof Error ? error.message : String(error)}`,
      evidence: { installedSource: "package asset" },
    };
  }

  try {
    const loaded = loadModelMap({ ...options, installedText });
    return {
      name: "model-map-files",
      kind: "deterministic",
      status: "pass",
      confidence: "high",
      message:
        loaded.userStatus === "loaded"
          ? `Installed defaults and user models.json at ${loaded.userPath} are valid.`
          : "Installed model defaults are valid; no optional user models.json is present.",
      evidence: {
        installedSource: "package asset",
        userPath: loaded.userPath,
        userStatus: loaded.userStatus,
        aliases: Object.keys(loaded.map.aliases).sort(),
      },
    };
  } catch (error) {
    const hint = error instanceof ConfigError ? error.hint() : undefined;
    return {
      name: "model-map-files",
      kind: "deterministic",
      status: "warn",
      confidence: "high",
      message: `${error instanceof Error ? error.message : String(error)}${hint ? ` ${hint}` : ""}`,
      evidence: {
        installedSource: "package asset",
        userPath: userModelMapPath(options.env),
        userStatus: "invalid",
      },
    };
  }
}

/**
 * Check model selections owned by configured engines against the common model
 * map. Unknown identifiers are deliberate exact-model pass-throughs; only an
 * alias known somewhere in the map but absent for the selected engine warns.
 */
export function runSelectedModelAliasesProbe(deps: SelectedModelAliasesProbeDependencies = {}): HealthCheckResult {
  const config = deps.loadConfig?.() ?? loadConfig();
  const definitions = executionEngineDefinitionsFromConfig(config);
  const selected = Object.entries(definitions)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([engine, definition]) => {
      const model = definition.defaults?.model;
      const modelMapKey = definition.modelMapKey ?? definition.selection.platform ?? definition.selection.name;
      return typeof model === "string" ? [{ engine, alias: model, modelMapKey }] : [];
    });
  if (selected.length === 0) {
    return {
      name: "selected-model-aliases",
      kind: "deterministic",
      status: "unknown",
      confidence: "high",
      message: "No configured engines select a model.",
      evidence: { checked: [], missing: [] },
    };
  }

  let modelMap: LoadedModelMap;
  try {
    modelMap = (deps.loadModelMap ?? loadModelMap)({ env: deps.env, installedText: deps.installedText });
  } catch {
    return {
      name: "selected-model-aliases",
      kind: "deterministic",
      status: "unknown",
      confidence: "high",
      message: "Configured model selections could not be checked because the model map is invalid.",
      evidence: { checked: [], missing: [] },
    };
  }

  const outcomes = selected.map(({ engine, alias, modelMapKey }) => {
    try {
      const resolution = resolveModelMapAlias(alias, modelMapKey, modelMap.map);
      return resolution.interpretation === "alias"
        ? { kind: "alias" as const, evidence: { engine, alias, modelMapKey } }
        : { kind: "exact" as const };
    } catch {
      return { kind: "missing" as const, evidence: { engine, alias, modelMapKey } };
    }
  });
  const checked = outcomes.flatMap((outcome) => (outcome.kind === "exact" ? [] : [outcome.evidence]));
  const missing = outcomes.flatMap((outcome) => (outcome.kind === "missing" ? [outcome.evidence] : []));
  return {
    name: "selected-model-aliases",
    kind: "deterministic",
    status: missing.length === 0 ? "pass" : "warn",
    confidence: "high",
    message:
      missing.length === 0
        ? `All ${selected.length} configured model selections resolve for their selected engines.`
        : `${missing.length} of ${selected.length} configured model selections ${missing.length === 1 ? "has" : "have"} no mapping for ${missing.length === 1 ? "its" : "their"} selected engine${missing.length === 1 ? "" : "s"}.`,
    evidence: { checked, missing },
  };
}

export interface PendingStateMigrationsCheckDependencies {
  listPendingStateMigrations?: (dbPath?: string) => string[];
}

/**
 * Hard check: state.db's migration ledger has no pending entries.
 *
 * Read-only via `listPendingStateMigrations` (a preflight open, never a
 * managed one), so running this check is always safe — even when the
 * corresponding managed open would refuse outright because a pending
 * migration is historical-destructive (see `beforeMigrationLocked` in
 * `src/core/state/migrations.ts`). This is what lets `akm health` report that
 * refusal as an ordinary `fail` check instead of crashing the whole command —
 * and what replaces a bundler grepping akm's refusal error text
 * to detect the same case.
 */
export function runPendingStateMigrationsCheck(
  stateDbPath: string,
  deps: PendingStateMigrationsCheckDependencies = {},
): HealthCheckResult {
  const pending = (deps.listPendingStateMigrations ?? listPendingStateMigrations)(stateDbPath);
  if (pending.length === 0) {
    return {
      name: "state-db-migrations",
      kind: "deterministic",
      status: "pass",
      confidence: "high",
      message: "state.db has no pending migrations.",
      evidence: { path: stateDbPath, pending: [] },
    };
  }
  const range = pending.length > 1 ? `${pending[0]} … ${pending[pending.length - 1]}` : pending[0];
  return {
    name: "state-db-migrations",
    kind: "deterministic",
    status: "fail",
    confidence: "high",
    message: `${pending.length} pending state.db migration(s) (${range}); run \`akm migrate apply\`.`,
    evidence: { path: stateDbPath, pending },
  };
}

/**
 * The ordered health-check registry. ORDER IS LOAD-BEARING: `akmHealth`
 * iterates this array and appends to hardChecks/advisories in sequence, so the
 * declaration order below is exactly the emission order (hard checks first in
 * their array, advisories in theirs). Each `run` is a verbatim copy of the
 * corresponding former inline block.
 */
export const HEALTH_CHECKS: readonly HealthCheck[] = [
  {
    name: "state-db-schema",
    channel: "hard",
    run: (ctx) => ({
      name: "state-db-schema",
      kind: "deterministic",
      status: ctx.missingTables.length === 0 ? "pass" : "fail",
      confidence: "high",
      message:
        ctx.missingTables.length === 0
          ? "state.db opened and required tables are present."
          : `state.db is missing required tables: ${ctx.missingTables.join(", ")}`,
      evidence: { path: ctx.stateDbPath, tables: ctx.tableNames },
    }),
  },
  {
    name: "state-db-round-trip",
    channel: "hard",
    run: (ctx) => ({
      name: "state-db-round-trip",
      kind: "deterministic",
      status: ctx.probe.ok ? "pass" : "fail",
      confidence: "high",
      message: ctx.probe.ok
        ? "state.db append/read round-trip succeeded."
        : `state.db round-trip failed: ${ctx.probe.error}`,
      evidence: { path: ctx.stateDbPath, durationMs: ctx.probe.durationMs },
    }),
  },
  {
    name: "state-db-migrations",
    channel: "hard",
    run: (ctx) => runPendingStateMigrationsCheck(ctx.stateDbPath),
  },
  {
    name: "task-history-read",
    channel: "hard",
    run: (ctx) => ({
      name: "task-history-read",
      kind: "deterministic",
      status: "pass",
      confidence: "high",
      message: `Read ${ctx.taskRowCount} task-history row(s) since ${ctx.since}.`,
      evidence: { rows: ctx.taskRowCount, since: ctx.since },
    }),
  },
  {
    name: "task-log-backing",
    channel: "hard",
    run: (ctx) => ({
      name: "task-log-backing",
      kind: "deterministic",
      status: ctx.logBackingRate === 1 ? "pass" : "fail",
      confidence: "high",
      message:
        ctx.logBackingRate === 1
          ? "Every task_history log_path resolved on disk."
          : `${ctx.taskRowsWithLogsCount - ctx.existingLogRowsCount} task log(s) referenced in task_history are missing.`,
      evidence: { totalWithLogs: ctx.taskRowsWithLogsCount, existingLogs: ctx.existingLogRowsCount },
    }),
  },
  {
    name: "active-runs",
    channel: "hard",
    run: (ctx) => {
      // Name the stuck task_ids (deduped, oldest first) so an operator knows
      // WHICH tasks to investigate, not just how many rows are stale. No
      // pid/liveness detection — that's out of scope here.
      const named = [...ctx.stuckActiveTasks].sort((a, b) => b.ageMs - a.ageMs);
      const detail = named.map((t) => `${t.taskId} (${Math.round(t.ageMs / 60000)}m)`).join(", ");
      return {
        name: "active-runs",
        kind: "deterministic",
        status: ctx.stuckActiveRuns === 0 ? "pass" : "warn",
        confidence: "high",
        message:
          ctx.stuckActiveRuns === 0
            ? "No active task runs exceeded the stale threshold."
            : `${ctx.stuckActiveRuns} active task run(s) are older than ${Math.round(ACTIVE_RUN_WARN_MS / 60000)} minutes: ${detail}.`,
        evidence: { stuckActiveRuns: ctx.stuckActiveRuns, stuckActiveTasks: ctx.stuckActiveTasks },
      };
    },
  },
  {
    name: "default-engine",
    channel: "hard",
    run: (ctx) => ctx.engineProbes.defaultEngine,
  },
  {
    name: "model-map-files",
    channel: "hard",
    run: () => runModelMapProbe(),
  },
  {
    name: "selected-model-aliases",
    channel: "hard",
    run: () => runSelectedModelAliasesProbe(),
  },
  {
    name: "default-llm-engine",
    channel: "hard",
    run: (ctx) => ctx.engineProbes.defaultLlmEngine,
  },
  {
    name: "configured-engines",
    channel: "hard",
    run: (ctx) => ctx.engineProbes.configuredEngines,
  },
  {
    name: "active-improve-strategy",
    channel: "hard",
    run: () => runActiveImproveStrategyProbe(),
  },
  {
    // C2 (13-bus-factor): the cron task-failure rate was computed and rendered
    // in the HTML report but never surfaced as an advisory, so a sustained
    // 15–16% fail rate stayed invisible on `akm health`. Warn at/above the SAME
    // 5% threshold the html-report badge uses (see TASK_FAIL_RATE_WARN).
    //
    // Item 6: the aggregate can hide a single consistently-failing task inside
    // a large, mostly-healthy population (e.g. 1 flaky task at 100 rows total
    // reads as <5% aggregate). Also warn when the single worst task_id (with
    // enough rows to be a real signal — see MIN_ROWS_FOR_WORST_TASK_FAIL_RATE)
    // crosses the same threshold, naming it explicitly.
    name: "task-fail-rate",
    channel: "advisory",
    run: (ctx) => {
      const pctStr = `${(ctx.taskFailRate * 100).toFixed(1)}%`;
      const thresholdPct = `${(TASK_FAIL_RATE_WARN * 100).toFixed(0)}%`;
      const aggregateWarn = ctx.taskFailRate >= TASK_FAIL_RATE_WARN;
      const worst = ctx.worstTaskFailRate;
      const worstWarn = worst !== null && worst.rate >= TASK_FAIL_RATE_WARN;
      const warn = aggregateWarn || worstWarn;

      let message: string;
      if (ctx.taskRowCount === 0) {
        message = `No cron tasks ran since ${ctx.since} — no task-fail-rate signal.`;
      } else if (warn) {
        const parts: string[] = [];
        if (aggregateWarn) {
          parts.push(`aggregate ${pctStr} across ${ctx.taskRowCount} task(s) since ${ctx.since} ≥ ${thresholdPct}`);
        }
        if (worstWarn && worst) {
          const worstPctStr = `${(worst.rate * 100).toFixed(1)}%`;
          parts.push(`task "${worst.taskId}" fails ${worstPctStr} of its ${worst.rows} run(s) ≥ ${thresholdPct}`);
        }
        message = `Cron task fail rate warning: ${parts.join("; ")} — inspect failed runs (ok=false) for early-exit/harness errors.`;
      } else {
        message = `Cron task fail rate ${pctStr} across ${ctx.taskRowCount} task(s) since ${ctx.since} (below ${thresholdPct} threshold).`;
      }

      return {
        name: "task-fail-rate",
        kind: "deterministic",
        status: warn ? "warn" : "pass",
        confidence: "high",
        message,
        evidence: {
          taskFailRate: ctx.taskFailRate,
          taskRowCount: ctx.taskRowCount,
          threshold: TASK_FAIL_RATE_WARN,
          worstTaskFailRate: worst,
        },
      };
    },
  },
  {
    // #914: derived from the `extract_sessions_seen` LEDGER, not
    // `improve_runs.result_json` — the hook-driven `akm proposal extract
    // --session-id ...` (the standard Claude Code plugin setup) never writes
    // an `improve_runs` row, so the old improve_runs-only source reported
    // "not active" as `pass` unconditionally on a plugin-driven machine, no
    // matter how healthy or broken extraction actually was. The
    // `improve_runs`-derived numbers (`ctx.sessionExtraction`) are kept in
    // evidence for continuity, but the status/message come from the ledger.
    name: "session-extraction",
    channel: "advisory",
    run: (ctx) => {
      const sx = ctx.sessionExtraction;
      const legacyEvidence = {
        sessionsScanned: sx.sessionsScanned,
        sessionsExtracted: sx.sessionsExtracted,
        sessionsSkipped: sx.sessionsSkipped,
        proposalsCreated: sx.proposalsCreated,
        warnings: sx.warnings,
        durationMs: sx.durationMs,
      };
      const { since: ledgerSince, rows } = ctx.sessionExtractionLedger;
      const totalRows = rows.reduce((sum, row) => sum + row.count, 0);

      if (totalRows === 0) {
        return {
          name: "session-extraction",
          kind: "heuristic",
          status: "unknown",
          confidence: "medium",
          message: "No extraction recorded in the last 7 days.",
          evidence: { ran: sx.ran, ledgerSince, ledgerRows: rows, ...legacyEvidence },
        };
      }

      const allSkipped = rows.every((row) => row.outcome === "skipped");
      const knownSkipReasons = [...new Set(rows.flatMap((row) => (row.skipReason ? [row.skipReason] : [])))];
      const hasUnknownReasonRows = rows.some((row) => row.skipReason === null);
      const allKnownReasonsAreInfra = knownSkipReasons.every((reason) =>
        (INFRASTRUCTURE_SKIP_REASONS as readonly string[]).includes(reason),
      );

      if (allSkipped && allKnownReasonsAreInfra) {
        const reasonClauses = [...knownSkipReasons].sort().map((reason) => {
          const engines = [
            ...new Set(
              rows.filter((row) => row.skipReason === reason && row.engine).map((row) => row.engine as string),
            ),
          ].sort();
          return engines.length > 0
            ? `${reason} (engine ${engines.map((engine) => `"${engine}"`).join(", ")})`
            : reason;
        });
        if (hasUnknownReasonRows) reasonClauses.push("unknown reason");
        return {
          name: "session-extraction",
          kind: "heuristic",
          status: "warn",
          confidence: "medium",
          message: `${totalRows} of ${totalRows} sessions in the last 7 days skipped: ${reasonClauses.join(", ")}.`,
          evidence: { ran: sx.ran, ledgerSince, ledgerRows: rows, ...legacyEvidence },
        };
      }

      const outcomeCounts = new Map<string, number>();
      for (const row of rows) outcomeCounts.set(row.outcome, (outcomeCounts.get(row.outcome) ?? 0) + row.count);
      const outcomeSummary = [...outcomeCounts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([outcome, count]) => `${outcome}: ${count}`)
        .join(", ");
      return {
        name: "session-extraction",
        kind: "heuristic",
        status: "pass",
        confidence: "medium",
        message: `Session extraction active in the last 7 days (${outcomeSummary}).`,
        evidence: { ran: sx.ran, ledgerSince, ledgerRows: rows, ...legacyEvidence },
      };
    },
  },
  {
    // #603: pool-saturation advisory. The raw `sessionsScanned` count fired on
    // normal cadence changes (the Jun 12 false alarm). Instead track the ratio
    // of NEW (unseen) sessions to the total session pool extract evaluated in
    // the window: a low ratio is the *expected* steady state, only a near-zero
    // ratio signals a possible discovery/dedup bug.
    //
    // unseen ≈ `sessionsScanned` (extract only processes new sessions; already-
    // seen ones are deduped into `sessionsSkipped`). total = scanned + skipped.
    // This is a heuristic approximation — `sessionsSkipped` also folds in
    // too-short skips — so the check is informational and never gates status.
    name: "pool-saturation",
    channel: "advisory",
    run: (ctx) => {
      const sx = ctx.sessionExtraction;
      const total = sx.sessionsScanned + sx.sessionsSkipped;
      const unseen = sx.sessionsScanned;
      const ratio = total > 0 ? unseen / total : null;
      const pct = ratio === null ? null : Math.round(ratio * 1000) / 10;

      let status: HealthCheckResult["status"] = "pass";
      let confidence: HealthCheckResult["confidence"] = "low";
      let message: string;
      if (!sx.ran || ratio === null) {
        message = "Pool saturation: no extract activity in the window — no signal.";
      } else if (ratio < 0.02) {
        status = "warn";
        confidence = "medium";
        message = `Session pool near-exhausted: only ${pct}% of the ${total}-session pool was new (<2%). Possible discovery/dedup bug — verify extract is still finding new sessions.`;
      } else if (ratio < 0.1) {
        confidence = "medium";
        message = `Session pool saturation: ${pct}% of ${total} sessions were new (<10%, steady-state expected — informational).`;
      } else {
        confidence = "medium";
        message = `Session pool healthy: ${pct}% of ${total} sessions were new.`;
      }
      return {
        name: "pool-saturation",
        kind: "heuristic",
        status,
        confidence,
        message,
        evidence: { totalSessions: total, unseenSessions: unseen, saturationRatio: ratio },
      };
    },
  },
  {
    name: "auto-accept-validation",
    channel: "advisory",
    run: (ctx) => {
      const aa = ctx.autoAccept;
      return {
        name: "auto-accept-validation",
        kind: "heuristic",
        status: aa.validationFailed > 0 ? "warn" : "pass",
        confidence: aa.promoted + aa.validationFailed > 0 ? "high" : "low",
        message:
          aa.validationFailed > 0
            ? `${aa.validationFailed} auto-accept validation attempt(s) failed after passing the confidence threshold (truncated description, invalid frontmatter, etc.) — the affected proposals remain pending for manual review.`
            : aa.promoted > 0
              ? `Auto-accept healthy: ${aa.promoted} proposal(s) promoted, 0 validation failures.`
              : "Auto-accept gate did not run (disabled or no proposals above threshold).",
        evidence: { promoted: aa.promoted, validationFailed: aa.validationFailed },
      };
    },
  },
];
