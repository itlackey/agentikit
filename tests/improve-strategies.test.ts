// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { resolveImprovePlan, resolveImproveStrategy } from "../src/commands/improve/improve-strategies";
import type { AkmConfig } from "../src/core/config/config";
import { ConfigError } from "../src/core/errors";
import { withEnvSync } from "./_helpers/sandbox";

describe("resolveImproveStrategy", () => {
  test("deep-merges the default baseline, selected built-in, and user override in order", () => {
    const selected = resolveImproveStrategy("quick", {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      improve: {
        strategies: {
          quick: {
            processes: { reflect: { enabled: false, allowedTypes: ["memory"] } },
          },
        },
      },
    });

    expect(selected.name).toBe("quick");
    expect(selected.config.processes?.reflect).toMatchObject({ enabled: false, allowedTypes: ["memory"] });
    expect(selected.config.processes?.distill).toBeDefined();
    expect(selected.config.processes?.validation?.enabled).toBe(false);
    expect(selected.config.processes?.proactiveMaintenance?.enabled).toBe(false);
  });

  test("explicit user opt-ins override inherited built-in process defaults", () => {
    const defaultStrategy = resolveImproveStrategy("default", {
      semanticSearchMode: "off",
      improve: {
        strategies: {
          default: {
            processes: {
              extract: { enabled: true },
              proactiveMaintenance: { enabled: true },
            },
          },
        },
      },
    });
    const quick = resolveImproveStrategy("quick", {
      semanticSearchMode: "off",
      improve: {
        strategies: { quick: { processes: { extract: { enabled: true } } } },
      },
    });
    const reflectDistill = resolveImproveStrategy("reflect-distill", {
      semanticSearchMode: "off",
      improve: {
        strategies: {
          "reflect-distill": { processes: { proactiveMaintenance: { enabled: true } } },
        },
      },
    });

    expect(defaultStrategy.config.processes?.extract?.enabled).toBe(true);
    expect(defaultStrategy.config.processes?.proactiveMaintenance?.enabled).toBe(true);
    expect(quick.config.processes?.extract?.enabled).toBe(true);
    expect(reflectDistill.config.processes?.proactiveMaintenance?.enabled).toBe(true);
  });

  test("uses defaults.improveStrategy before the built-in default", () => {
    const selected = resolveImproveStrategy(undefined, {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      defaults: { improveStrategy: "quick" },
    });
    expect(selected.name).toBe("quick");
  });

  test("rejects an unknown strategy instead of silently falling back", () => {
    expect(() =>
      resolveImproveStrategy("does-not-exist", { configVersion: "0.9.0", semanticSearchMode: "auto" }),
    ).toThrow(ConfigError);
  });
});

describe("resolveImprovePlan", () => {
  const llm = { kind: "llm" as const, endpoint: "https://example.test/v1/chat/completions", model: "base" };

  test("resolves one frozen fallback connection for every enabled process before dispatch", () => {
    const plan = resolveImprovePlan("quick", {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      engines: { default: llm, validation: { ...llm, model: "repair" } },
      defaults: { llmEngine: "default" },
      improve: { strategies: { quick: { processes: { validation: { enabled: true, engine: "validation" } } } } },
    });

    expect(plan.strategy.name).toBe("quick");
    expect(plan.processes.reflect.runner?.engine).toBe("default");
    expect(plan.processes.validation.runner?.engine).toBe("validation");
    expect(plan.processes.validation.runner?.connection.model).toBe("repair");
    expect(plan.processes.distill).toMatchObject({ enabled: false, runner: null });
    expect(Object.keys(plan.processes).sort()).toEqual([
      "consolidate",
      "distill",
      "extract",
      "graphExtraction",
      "memoryInference",
      "proactiveMaintenance",
      "reflect",
      "triage",
      "validation",
    ]);
    expect(Object.isFrozen(plan.processes)).toBe(true);
    expect(Object.isFrozen(plan.processes.reflect.config)).toBe(true);
  });

  test("preflights every enabled model-backed process and deeply freezes nested behavior", () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: { default: llm },
      defaults: { llmEngine: "default" },
      // D8 — `consolidate` and `memoryInference` are only *enabled* when autonomy
      // is opted into; without this the gate disables them and they resolve no
      // runner, which is the gate working rather than the preflight failing.
      experimental: { improveAutonomy: true },
      improve: {
        strategies: {
          all: {
            processes: {
              reflect: { enabled: true },
              distill: { enabled: true },
              consolidate: { enabled: true },
              memoryInference: { enabled: true },
              graphExtraction: { enabled: true },
              extract: { enabled: true, triage: { enabled: true } },
              validation: { enabled: true },
            },
          },
        },
      },
    };
    const plan = resolveImprovePlan("all", config);
    for (const name of [
      "reflect",
      "distill",
      "consolidate",
      "memoryInference",
      "graphExtraction",
      "extract",
      "validation",
    ] as const) {
      expect(plan.processes[name].runner?.engine).toBe("default");
    }
    expect(Object.isFrozen(plan.processes.extract.config.triage)).toBe(true);
    const sourceExtract = config.improve?.strategies?.all?.processes?.extract;
    if (sourceExtract?.triage) sourceExtract.triage.enabled = false;
    expect(plan.processes.extract.config.triage?.enabled).toBe(true);
  });

  test("retains symbolic credentials in the frozen improve plan", () => {
    withEnvSync({ IMPROVE_PLAN_API_KEY: "plan-secret-sentinel" }, () => {
      const plan = resolveImprovePlan("quick", {
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        engines: {
          default: {
            ...llm,
            apiKey: "$IMPROVE_PLAN_API_KEY",
          },
        },
        defaults: { llmEngine: "default" },
      });

      expect(plan.processes.reflect.runner?.credential).toEqual({
        names: ["IMPROVE_PLAN_API_KEY"],
        required: true,
      });
      expect(plan.processes.reflect.runner?.connection.apiKey).toBeUndefined();
      expect(JSON.stringify(plan)).not.toContain("plan-secret-sentinel");
    });
  });

  test("preflights default fallbacks and accepts an agent triage judgment", () => {
    const plan = resolveImprovePlan("reflect-distill", {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      engines: {
        default: llm,
        reviewer: { kind: "agent", platform: "pi", model: "review" },
      },
      defaults: { llmEngine: "default" },
      improve: {
        strategies: {
          "reflect-distill": { processes: { triage: { judgment: { engine: "reviewer", timeoutMs: null } } } },
        },
      },
    });

    expect(plan.processes.reflect.runner?.engine).toBe("default");
    expect(plan.processes.distill.runner?.engine).toBe("default");
    expect(plan.triageJudgment?.kind).toBe("agent");
    expect(plan.triageJudgment?.timeoutMs).toBeNull();
  });

  test("requires an explicit judgment block before folded improve enables judgment", () => {
    const plan = resolveImprovePlan("no-judgment", {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      engines: { default: llm },
      defaults: { llmEngine: "default" },
      improve: { strategies: { "no-judgment": { processes: { triage: { enabled: true } } } } },
    });

    expect(plan.triageJudgment).toBeNull();
  });

  test("uses judgment then triage then strategy then defaults.llmEngine precedence", () => {
    const engines: AkmConfig["engines"] = {
      default: { ...llm, model: "default" },
      strategy: { ...llm, model: "strategy" },
      judgment: { ...llm, model: "judgment" },
      reviewer: { kind: "agent" as const, platform: "pi", model: "agent-base" },
    };
    const base = {
      configVersion: "0.9.0" as const,
      semanticSearchMode: "auto" as const,
      engines,
      defaults: { llmEngine: "default" },
    };

    const explicit = resolveImprovePlan("precedence", {
      ...base,
      improve: {
        strategies: {
          precedence: {
            engine: "strategy",
            processes: {
              triage: {
                enabled: true,
                engine: "reviewer",
                judgment: { engine: "judgment" },
              },
            },
          },
        },
      },
    });
    expect(explicit.triageJudgment).toMatchObject({ kind: "llm", engine: "judgment" });

    const triage = resolveImprovePlan("precedence", {
      ...base,
      improve: {
        strategies: {
          precedence: {
            engine: "strategy",
            processes: {
              triage: {
                enabled: true,
                engine: "reviewer",
                model: "agent-override",
                judgment: { timeoutMs: null },
              },
            },
          },
        },
      },
    });
    expect(triage.triageJudgment).toMatchObject({
      kind: "agent",
      engine: "reviewer",
      timeoutMs: null,
      profile: { model: "agent-override" },
    });

    const strategy = resolveImprovePlan("precedence", {
      ...base,
      improve: {
        strategies: {
          precedence: { engine: "strategy", processes: { triage: { enabled: true, judgment: {} } } },
        },
      },
    });
    expect(strategy.triageJudgment).toMatchObject({ kind: "llm", engine: "strategy" });

    const fallback = resolveImprovePlan("precedence", {
      ...base,
      improve: { strategies: { precedence: { processes: { triage: { enabled: true, judgment: {} } } } } },
    });
    expect(fallback.triageJudgment).toMatchObject({ kind: "llm", engine: "default" });
  });

  test("rejects model-only and incompatible fallbacks before dispatch", () => {
    // "quick" enables only reflect, so disabling it for lack of a usable LLM
    // engine leaves the plan with nothing enabled at all — the one case that
    // still aborts (AGENTS.md Defensive Code: abort only if zero processes
    // remain).
    expect(() =>
      resolveImprovePlan("quick", {
        configVersion: "0.9.0",
        semanticSearchMode: "auto",
        improve: { strategies: { quick: { processes: { reflect: { model: "model-without-engine" } } } } },
      }),
    ).toThrow('"reflect" requires an LLM engine that is not configured');
    expect(() =>
      resolveImprovePlan("quick", {
        configVersion: "0.9.0",
        semanticSearchMode: "auto",
        engines: { wrong: { kind: "agent", platform: "pi" } },
        defaults: { llmEngine: "wrong" },
      }),
    ).toThrow('"reflect" requires an LLM engine that is not configured');
  });

  test("rejects an enabled model-backed process with no runner even when no model fields express intent", () => {
    expect(() =>
      resolveImprovePlan("quick", {
        configVersion: "0.9.0",
        semanticSearchMode: "auto",
      }),
    ).toThrow('"reflect" requires an LLM engine that is not configured');
  });

  test("disables just the processes with no usable LLM engine, instead of aborting the whole plan", () => {
    // A user with only an agent engine used to get NOTHING — not reflect, not
    // graph extraction, not validation, not proactive maintenance — because
    // the loop aborted on the FIRST llm-only process it hit, taking every
    // other process down with it (including proactiveMaintenance, which
    // needs no engine at all). Each is now disabled individually.
    const plan = resolveImprovePlan("default", {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      engines: { "only-agent": { kind: "agent", platform: "claude", bin: "/bin/true" } },
      defaults: { engine: "only-agent" },
      // Autonomy on so memoryInference reaches this fix's LLM check instead
      // of being disabled earlier by the (unrelated) D8 autonomy gate.
      experimental: { improveAutonomy: true },
      improve: {
        strategies: {
          default: { processes: { proactiveMaintenance: { enabled: true } } },
        },
      },
    } as AkmConfig);

    for (const name of [
      "reflect",
      "distill",
      "consolidate",
      "memoryInference",
      "graphExtraction",
      "validation",
    ] as const) {
      expect(plan.processes[name].enabled).toBe(false);
      expect(plan.processes[name].runner).toBeNull();
      // The disablement is visible on the strategy config too, so every
      // downstream consumer that reads `improveProfile.processes.<name>` (not
      // just `plan.processes`) sees the same answer — e.g. `shouldSkipRef`.
      expect(plan.strategy.config.processes?.[name]?.enabled).toBe(false);
    }
    // Needs no engine at all — survives untouched, unlike before this fix.
    expect(plan.processes.proactiveMaintenance.enabled).toBe(true);

    const disabledNames: string[] = plan.engineUnavailable.map((item) => item.process).sort();
    expect(disabledNames).toEqual(
      (["consolidate", "distill", "graphExtraction", "memoryInference", "reflect", "validation"] as string[]).sort(),
    );
    for (const item of plan.engineUnavailable) {
      expect(item.configKey).toBe(`improve.strategies.default.processes.${item.process}.engine`);
      expect(item.reason).toContain("Set defaults.llmEngine or improve.strategies.default.processes");
    }
  });

  test("does not require a validation engine when repair is disabled", () => {
    const plan = resolveImprovePlan(
      "default",
      {
        configVersion: "0.9.0",
        semanticSearchMode: "auto",
        engines: { default: llm },
        defaults: { llmEngine: "default" },
      },
      { repairValidationFailures: false },
    );
    expect(plan.processes.reflect.runner?.engine).toBe("default");
    expect(plan.processes.validation).toMatchObject({ enabled: true, runner: null });
  });

  test("rejects LLM-only overrides on an agent triage judgment", () => {
    expect(() =>
      resolveImprovePlan("reflect-distill", {
        configVersion: "0.9.0",
        semanticSearchMode: "auto",
        engines: {
          llm: { kind: "llm", endpoint: "https://example.test/v1/chat/completions", model: "base" },
          reviewer: { kind: "agent", platform: "pi" },
        },
        defaults: { llmEngine: "llm" },
        improve: {
          strategies: {
            "reflect-distill": {
              processes: { triage: { judgment: { engine: "reviewer", llm: { temperature: 0 } } } },
            },
          },
        },
      }),
    ).toThrow("cannot receive llm overrides");
  });
});
