// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveJudgeCalibrationSandboxConfig } from "../scripts/akm-eval/src/runners/judge-calibration";
import { validateConfigShape } from "../src/core/config/config-schema";

const roots: string[] = [];

function configDir(config: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-judge-config-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify(config)}\n`);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("judge calibration current config boundary", () => {
  test("projects one selected LLM engine into a valid current distill-only strategy", () => {
    const source = {
      configVersion: "0.9.0",
      engines: {
        judge: {
          kind: "llm",
          endpoint: "https://llm.example.test/v1/chat/completions",
          model: "judge-model",
          apiKey: "$JUDGE_API_KEY",
        },
        unused: { kind: "agent", platform: "codex" },
      },
      defaults: { llmEngine: "judge" },
    };

    const result = resolveJudgeCalibrationSandboxConfig({ AKM_CONFIG_DIR: configDir(source) });
    expect(result.ok).toBe(true);
    expect(validateConfigShape(result.config).ok).toBe(true);
    expect(result.config).toMatchObject({
      configVersion: "0.9.0",
      engines: { judge: source.engines.judge },
      defaults: { llmEngine: "judge", improveStrategy: "judge-calibration" },
      improve: {
        strategies: {
          "judge-calibration": {
            engine: "judge",
            processes: { reflect: { enabled: false }, distill: { enabled: true } },
          },
        },
      },
    });
    expect((result.config?.engines as Record<string, unknown>).unused).toBeUndefined();
    expect(result.config).not.toHaveProperty("profiles");
  });

  test("rejects retired profiles and non-LLM default engines", () => {
    const retired = resolveJudgeCalibrationSandboxConfig({
      AKM_CONFIG_DIR: configDir({ defaults: { llm: "default" }, profiles: { llm: { default: {} } } }),
    });
    expect(retired.ok).toBe(false);
    expect(retired.reason).toContain("defaults.llmEngine");

    const agent = resolveJudgeCalibrationSandboxConfig({
      AKM_CONFIG_DIR: configDir({
        engines: { reviewer: { kind: "agent", platform: "codex" } },
        defaults: { llmEngine: "reviewer" },
      }),
    });
    expect(agent.ok).toBe(false);
    expect(agent.reason).toContain('kind: "llm"');
  });

  test("does not treat a bundle-local .akm config as an active config layer", () => {
    const bundle = fs.mkdtempSync(path.join(os.tmpdir(), "akm-judge-bundle-"));
    roots.push(bundle);
    fs.mkdirSync(path.join(bundle, ".akm"));
    fs.writeFileSync(
      path.join(bundle, ".akm", "config.json"),
      `${JSON.stringify({
        defaults: { llm: "judge" },
        profiles: {
          llm: {
            judge: {
              endpoint: "https://llm.example.test/v1/chat/completions",
              model: "judge-model",
            },
          },
        },
      })}\n`,
    );

    const result = resolveJudgeCalibrationSandboxConfig({ AKM_BUNDLE_DIR: bundle });
    expect(result.ok).toBe(false);
    expect(result.sourceConfigPath).toBeUndefined();
  });
});
