// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { resolveImprovePlan } from "../src/commands/improve/improve-strategies";
import type { AkmConfig } from "../src/core/config/config";
import {
  ImproveProcessConfigSchema,
  TriageProcessConfigSchema,
  validateConfigShape,
} from "../src/core/config/config-schema";
import { resolveTriageJudgmentRunner } from "../src/integrations/agent/runner";

const llm = {
  kind: "llm" as const,
  endpoint: "https://example.test/v1/chat/completions",
  model: "base",
};

function parseConfig(raw: unknown): AkmConfig {
  const result = validateConfigShape(raw);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

function isolatedProcesses(judgment: unknown): Record<string, unknown> {
  return {
    reflect: { enabled: false },
    distill: { enabled: false },
    consolidate: { enabled: false },
    memoryInference: { enabled: false },
    graphExtraction: { enabled: false },
    extract: { enabled: false },
    validation: { enabled: false },
    proactiveMaintenance: { enabled: false },
    triage: { enabled: true, judgment },
  };
}

describe("triage judgment config normalization (#814)", () => {
  test("normalizes boolean shorthand and legacy objects to explicit enabled state", () => {
    expect(ImproveProcessConfigSchema.parse({ judgment: true }).judgment).toEqual({ enabled: true });
    expect(ImproveProcessConfigSchema.parse({ judgment: false }).judgment).toEqual({ enabled: false });
    expect(ImproveProcessConfigSchema.parse({ judgment: {} }).judgment).toEqual({ enabled: true });
    expect(ImproveProcessConfigSchema.parse({ judgment: { engine: "judge", model: "exact" } }).judgment).toEqual({
      enabled: true,
      engine: "judge",
      model: "exact",
    });
    expect(ImproveProcessConfigSchema.parse({ judgment: { enabled: false, timeoutMs: null } }).judgment).toEqual({
      enabled: false,
      timeoutMs: null,
    });
  });

  test("rejects judgment typos and unknown keys while preserving retired-key guidance", () => {
    for (const judgment of [{ bogus: 1 }, { egnine: "judge" }]) {
      expect(ImproveProcessConfigSchema.safeParse({ judgment }).success).toBe(false);
    }
    expect(TriageProcessConfigSchema.safeParse({ judgement: true }).success).toBe(false);

    for (const key of ["mode", "profile"] as const) {
      const result = ImproveProcessConfigSchema.safeParse({ judgment: { [key]: "llm" } });
      expect(result.success).toBe(false);
      if (result.success) throw new Error("retired judgment key must fail");
      expect(result.error.issues.map((issue) => issue.message).join("\n")).toContain(`${key} is retired; use engine`);
    }
  });

  test("cross-validation ignores disabled judgment engines but validates enabled ones", () => {
    const base = { configVersion: "0.9.0" };
    expect(
      validateConfigShape({
        ...base,
        improve: {
          strategies: {
            disabled: { processes: { triage: { enabled: true, judgment: { enabled: false, engine: "missing" } } } },
          },
        },
      }).ok,
    ).toBe(true);
    expect(
      validateConfigShape({
        ...base,
        improve: {
          strategies: {
            enabled: { processes: { triage: { enabled: true, judgment: { enabled: true, engine: "missing" } } } },
          },
        },
      }).ok,
    ).toBe(false);
  });

  test("disabled judgment requires no engine and produces no runtime runner", () => {
    const config = parseConfig({
      configVersion: "0.9.0",
      engines: {
        ready: llm,
        private: { ...llm, apiKey: "$MISSING_JUDGMENT_TOKEN" },
      },
      defaults: { llmEngine: "ready" },
      improve: {
        strategies: {
          disabled: {
            processes: isolatedProcesses({ enabled: false, engine: "private" }),
          },
        },
      },
    });

    const plan = resolveImprovePlan("disabled", config);
    expect(plan.strategy.config.processes?.triage?.judgment?.enabled).toBe(false);
    expect(plan.triageJudgment).toBeNull();
  });

  test("true and legacy-object judgment remain enabled and fail closed without an engine", () => {
    for (const judgment of [true, {}]) {
      const config = parseConfig({
        configVersion: "0.9.0",
        improve: { strategies: { enabled: { processes: isolatedProcesses(judgment) } } },
      });
      expect(config.improve?.strategies?.enabled?.processes?.triage?.judgment?.enabled).toBe(true);
      expect(() => resolveImprovePlan("enabled", config)).toThrow("Enabled improve triage judgment requires an engine");
    }
  });

  test("enabled judgment keeps judgment → triage → strategy → defaults precedence", () => {
    const config = parseConfig({
      configVersion: "0.9.0",
      engines: {
        default: { ...llm, model: "default" },
        strategy: { ...llm, model: "strategy" },
        triage: { ...llm, model: "triage" },
        judgment: { ...llm, model: "judgment" },
      },
      defaults: { llmEngine: "default" },
      improve: {
        strategies: {
          enabled: {
            engine: "strategy",
            processes: {
              ...isolatedProcesses(true),
              triage: { enabled: true, engine: "triage", judgment: { enabled: true, engine: "judgment" } },
            },
          },
        },
      },
    });

    expect(resolveImprovePlan("enabled", config).triageJudgment).toMatchObject({
      kind: "llm",
      engine: "judgment",
      connection: { model: "judgment" },
    });
  });

  test("legacy resolver never revives an explicitly disabled judgment", () => {
    const config: AkmConfig = {
      semanticSearchMode: "off",
      engines: { ready: llm },
      defaults: { llmEngine: "ready" },
    };
    expect(resolveTriageJudgmentRunner({ enabled: false, engine: "ready" }, config)).toBeNull();
    expect(resolveTriageJudgmentRunner({ enabled: true }, config)).toMatchObject({ kind: "llm", engine: "ready" });
  });
});
