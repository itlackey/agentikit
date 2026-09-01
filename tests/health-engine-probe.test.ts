// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import * as healthChecks from "../src/commands/health/checks";
import {
  HEALTH_CHECKS,
  runConfiguredEnginesProbe,
  runDefaultEngineProbe,
  runDefaultLlmEngineProbe,
} from "../src/commands/health/checks";
import type { AkmConfig } from "../src/core/config/config";
import { validateConfigShape } from "../src/core/config/config-schema";

const llm = {
  kind: "llm" as const,
  endpoint: "https://example.test/v1/chat/completions",
  model: "fallback-model",
};

describe("health engine probes", () => {
  test("shares one availability probe across default, default LLM, and configured projections", () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: { shared: { kind: "agent", platform: "claude" } },
      defaults: { engine: "shared", llmEngine: "shared" },
    };
    let spawnCalls = 0;

    const probe = (
      healthChecks as unknown as {
        runHealthEngineProbes?: (deps: {
          loadConfig: () => AkmConfig;
          spawnSync: typeof import("node:child_process").spawnSync;
        }) => {
          defaultEngine: { name: string; status: string };
          defaultLlmEngine: { name: string; status: string };
          configuredEngines: { name: string; status: string; evidence?: unknown };
        };
      }
    ).runHealthEngineProbes;
    expect(typeof probe).toBe("function");
    if (!probe) return;

    const result = probe({
      loadConfig: () => config,
      spawnSync: (() => {
        spawnCalls += 1;
        return { status: 0 };
      }) as never,
    });

    expect(spawnCalls).toBe(1);
    expect(result.defaultEngine).toMatchObject({ name: "default-engine", status: "pass" });
    expect(result.defaultLlmEngine).toMatchObject({ name: "default-llm-engine", status: "pass" });
    expect(result.configuredEngines).toMatchObject({
      name: "configured-engines",
      status: "pass",
      evidence: { engines: [{ engine: "shared", status: "pass" }] },
    });
  });

  test("sanitizes SDK executable probe exceptions, including a NUL bin", () => {
    const sentinel = "PRIVATE_SDK_BIN_SENTINEL";
    const parsed = validateConfigShape({
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: {
        sdk: { kind: "agent", platform: "opencode-sdk", bin: `${sentinel}\0` },
      },
      defaults: { engine: "sdk" },
    });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));

    const result = runDefaultEngineProbe({
      loadConfig: () => parsed.value,
      resolvePackage: () => "/sdk/package.json",
      spawnSync: (() => {
        throw new TypeError(`spawn rejected ${sentinel}: raw child output`);
      }) as never,
    });

    expect(result).toEqual({
      name: "default-engine",
      kind: "deterministic",
      status: "warn",
      confidence: "high",
      message: 'SDK engine "sdk" executable availability could not be checked.',
      evidence: { engine: "sdk", runtimeKind: "sdk", binaryAvailable: false },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain("raw child output");
    expect(serialized).not.toContain("NUL");
  });

  test("reports all explicitly configured engine availability in sorted, safe evidence", () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: {
        zeta: {
          ...llm,
          endpoint: "https://private-zeta.example/v1/chat/completions",
          model: "private-zeta-model",
          apiKey: "$PRIVATE_ZETA_HEALTH_TOKEN",
        },
        alpha: {
          ...llm,
          endpoint: "https://private-alpha.example/v1/chat/completions",
          model: "private-alpha-model",
        },
      },
    };

    const result = runConfiguredEnginesProbe({ loadConfig: () => config, env: {} });
    expect(result).toEqual({
      name: "configured-engines",
      kind: "deterministic",
      status: "warn",
      confidence: "high",
      message: "1 of 2 explicitly configured engines is unavailable.",
      evidence: {
        engines: [
          { engine: "alpha", status: "pass" },
          { engine: "zeta", status: "warn" },
        ],
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("PRIVATE_ZETA_HEALTH_TOKEN");
    expect(serialized).not.toContain("private-zeta.example");
    expect(serialized).not.toContain("private-alpha.example");
    expect(serialized).not.toContain("private-zeta-model");
    expect(serialized).not.toContain("private-alpha-model");
  });

  test("returns unknown when there are no explicitly configured engines", () => {
    const config: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "off" };
    expect(runConfiguredEnginesProbe({ loadConfig: () => config })).toEqual({
      name: "configured-engines",
      kind: "deterministic",
      status: "unknown",
      confidence: "high",
      message: "No engines are explicitly configured.",
      evidence: { engines: [] },
    });
  });

  test("registers aggregate availability after default-llm-engine", () => {
    const names = HEALTH_CHECKS.map((check) => check.name);
    expect(names.indexOf("configured-engines")).toBe(names.indexOf("default-llm-engine") + 1);
    expect(names.indexOf("active-improve-strategy")).toBe(names.indexOf("configured-engines") + 1);
    expect(HEALTH_CHECKS.find((check) => check.name === "configured-engines")?.channel).toBe("hard");
  });

  test("probes defaults.llmEngine independently from the general default", () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: { fast: llm },
      defaults: { llmEngine: "fast" },
    };
    const general = runDefaultEngineProbe({ loadConfig: () => config, which: () => undefined });
    const result = runDefaultLlmEngineProbe({ loadConfig: () => config });
    expect(general.status).toBe("unknown");
    expect(result.status).toBe("pass");
    expect(result.message).toBe('LLM engine "fast" is configured.');
    expect(result.evidence).toMatchObject({ engine: "fast", runtimeKind: "llm", model: "fallback-model" });
  });

  test("accepts the SDK fallback model and reports it as the effective model", () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: {
        sdk: { kind: "agent", platform: "opencode-sdk", bin: "opencode-test", llmEngine: "fallback" },
        fallback: llm,
      },
      defaults: { engine: "sdk", llmEngine: "fallback" },
    };
    const inheritedModel = runDefaultEngineProbe({
      loadConfig: () => config,
      resolvePackage: () => "/sdk/package.json",
      spawnSync: (() => ({ status: 0 })) as never,
    });
    expect(inheritedModel.status).toBe("pass");
    expect(inheritedModel.message).toBe('SDK engine "sdk" is available.');
    expect(inheritedModel.evidence).toMatchObject({
      binary: "opencode-test",
      binaryAvailable: true,
      packageAvailable: true,
      fallbackEngine: "fallback",
      fallbackModel: "fallback-model",
      model: "fallback-model",
      configuredModel: null,
      modelSource: "fallback",
    });

    const readyConfig: AkmConfig = {
      ...config,
      engines: {
        ...config.engines,
        sdk: { ...config.engines?.sdk, kind: "agent", platform: "opencode-sdk", model: "sdk-model" },
      },
    };
    const ready = runDefaultEngineProbe({
      loadConfig: () => readyConfig,
      resolvePackage: () => "/sdk/package.json",
      spawnSync: (() => ({ status: 0 })) as never,
    });
    expect(ready.status).toBe("pass");
    expect(ready.message).toBe('SDK engine "sdk" is available.');
    expect(ready.evidence).toMatchObject({ model: "sdk-model", configuredModel: "sdk-model", modelSource: "sdk" });
  });

  test("reports SDK package and binary failures independently", () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: {
        sdk: { kind: "agent", platform: "opencode-sdk", model: "sdk-model", llmEngine: "fallback" },
        fallback: llm,
      },
      defaults: { engine: "sdk", llmEngine: "fallback" },
    };
    const result = runDefaultEngineProbe({
      loadConfig: () => config,
      resolvePackage: () => {
        throw new Error("missing");
      },
      spawnSync: (() => ({ status: 1 })) as never,
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("@opencode-ai/sdk package");
    expect(result.message).toContain("opencode binary");
  });

  test("accepts native OpenCode SDK configuration without an AKM LLM fallback", () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: { sdk: { kind: "agent", platform: "opencode-sdk", model: "sdk-model" } },
      defaults: { engine: "sdk" },
    };
    const result = runDefaultEngineProbe({
      loadConfig: () => config,
      spawnSync: (() => ({ status: 0 })) as never,
    });
    expect(result.status).toBe("pass");
    expect(result.evidence).toMatchObject({
      packageAvailable: true,
      binaryAvailable: true,
      model: "sdk-model",
      fallbackEngine: null,
    });
  });

  test("warns when an explicitly configured SDK fallback cannot be resolved", () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: { sdk: { kind: "agent", platform: "opencode-sdk", llmEngine: "missing" } },
      defaults: { engine: "sdk" },
    };
    const result = runDefaultEngineProbe({
      loadConfig: () => config,
      resolvePackage: () => "/sdk/package.json",
      spawnSync: (() => ({ status: 0 })) as never,
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("configured fallback LLM connection");
  });

  test("reports an unavailable required LLM credential without exposing its name", () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: {
        agent: { kind: "agent", platform: "claude" },
        improve: { ...llm, apiKey: "$PRIVATE_IMPROVE_TOKEN" },
      },
      defaults: { engine: "agent", llmEngine: "improve" },
    };
    const general = runDefaultEngineProbe({
      loadConfig: () => config,
      spawnSync: (() => ({ status: 0 })) as never,
      env: {},
    });
    const improve = runDefaultLlmEngineProbe({ loadConfig: () => config, env: {} });
    expect(general.status).toBe("pass");
    expect(improve.status).toBe("warn");
    expect(improve.message).toContain("required credential is unavailable");
    expect(JSON.stringify(improve)).not.toContain("PRIVATE_IMPROVE_TOKEN");
  });

  test("warns when an enabled active improve process lacks its required credential", () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: {
        ready: llm,
        private: { ...llm, apiKey: "$PRIVATE_REFLECT_TOKEN" },
      },
      defaults: { llmEngine: "ready", improveStrategy: "health-test" },
      improve: {
        strategies: {
          "health-test": { processes: { reflect: { enabled: true, engine: "private" } } },
        },
      },
    };
    const probe = (
      healthChecks as unknown as {
        runActiveImproveStrategyProbe: (deps: { loadConfig: () => AkmConfig; env: NodeJS.ProcessEnv }) => {
          status: string;
          message: string;
          evidence?: unknown;
        };
      }
    ).runActiveImproveStrategyProbe;
    expect(typeof probe).toBe("function");

    const result = probe({ loadConfig: () => config, env: {} });

    expect(result.status).toBe("warn");
    expect(result.message).toContain("reflect");
    expect(result.evidence).toMatchObject({ strategy: "health-test", unavailableProcesses: ["reflect"] });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_REFLECT_TOKEN");
  });

  test("warns when SDK triage judgment lacks its required fallback credential", () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: {
        ready: llm,
        fallback: { ...llm, apiKey: "$PRIVATE_SDK_FALLBACK_TOKEN" },
        reviewer: { kind: "agent", platform: "opencode-sdk", model: "review", llmEngine: "fallback" },
      },
      defaults: { llmEngine: "ready", improveStrategy: "sdk-triage-health" },
      improve: {
        strategies: {
          "sdk-triage-health": {
            processes: { triage: { enabled: true, judgment: { engine: "reviewer" } } },
          },
        },
      },
    };

    const result = healthChecks.runActiveImproveStrategyProbe({ loadConfig: () => config, env: {} });

    expect(result.status).toBe("warn");
    expect(result.message).toContain("triage.judgment");
    expect(result.evidence).toMatchObject({
      strategy: "sdk-triage-health",
      unavailableProcesses: ["triage.judgment"],
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SDK_FALLBACK_TOKEN");
  });

  test("disabled triage judgment neither requires credentials nor appears unavailable", () => {
    const parsed = validateConfigShape({
      configVersion: "0.9.0",
      engines: {
        ready: llm,
        private: { ...llm, apiKey: "$PRIVATE_DISABLED_JUDGMENT_TOKEN" },
      },
      defaults: { llmEngine: "ready", improveStrategy: "disabled-triage-health" },
      improve: {
        strategies: {
          "disabled-triage-health": {
            processes: { triage: { enabled: true, judgment: { enabled: false, engine: "private" } } },
          },
        },
      },
    });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));

    const result = healthChecks.runActiveImproveStrategyProbe({ loadConfig: () => parsed.value, env: {} });

    expect(result.status).toBe("pass");
    expect(result.message).not.toContain("triage.judgment");
    expect(result.evidence).toMatchObject({ strategy: "disabled-triage-health", unavailableProcesses: [] });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_DISABLED_JUDGMENT_TOKEN");
  });
});
