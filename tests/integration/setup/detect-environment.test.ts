// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests for the consolidated environment-detection pipeline (issue #514).
 *
 * Coverage:
 *   - `scanProviderEnvVars()` returns env var NAMES only — never values.
 *   - `pickDefaultModel()` name heuristic.
 *   - `detectStashDir()` ranking from a temp HOME/CWD.
 *   - `detectLocalServers()` tolerates every endpoint being down.
 *   - `detectEnvironment()` aggregator shape + safety invariant.
 *   - `deriveRecommendedConfig()` opinionated defaults.
 *   - `runDetectOnly()` never returns an API key value.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectEnvironment,
  detectLocalServers,
  detectStashDir,
  pickDefaultModel,
  scanProviderEnvVars,
} from "../../../src/setup/detect";
import { deriveRecommendedConfig, runDetectOnly } from "../../../src/setup/setup";
import { withEnv } from "../../_helpers/sandbox";

// A value no test should ever surface anywhere in output.
const SECRET_VALUE = "sk-SECRET-VALUE-MUST-NEVER-LEAK-1234567890";

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-detect-"));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe("scanProviderEnvVars", () => {
  test("returns the env var NAME and never the value", () => {
    const fakeEnv = { ANTHROPIC_API_KEY: SECRET_VALUE } as NodeJS.ProcessEnv;
    const result = scanProviderEnvVars(fakeEnv);

    expect(result.length).toBe(1);
    const entry = result[0];
    expect(entry?.provider).toBe("anthropic");
    expect(entry?.envVar).toBe("ANTHROPIC_API_KEY");
    expect(entry?.kind).toBe("apiKey");

    // Hard invariant: the value must appear NOWHERE in the serialized result.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET_VALUE);
    // And no field carries the value under any key.
    for (const e of result) {
      for (const v of Object.values(e)) {
        expect(v).not.toBe(SECRET_VALUE);
      }
    }
  });

  test("ignores empty/whitespace-only env vars", () => {
    expect(scanProviderEnvVars({ OPENAI_API_KEY: "" } as NodeJS.ProcessEnv)).toEqual([]);
    expect(scanProviderEnvVars({ OPENAI_API_KEY: "   " } as NodeJS.ProcessEnv)).toEqual([]);
  });

  test("detects endpoint-kind vars and multiple providers", () => {
    const result = scanProviderEnvVars({
      OPENAI_API_KEY: "x",
      OLLAMA_HOST: "http://localhost:11434",
      AKM_LLM_API_KEY: "y",
    } as NodeJS.ProcessEnv);
    const byVar = Object.fromEntries(result.map((r) => [r.envVar, r.kind]));
    expect(byVar.OPENAI_API_KEY).toBe("apiKey");
    expect(byVar.OLLAMA_HOST).toBe("endpoint");
    expect(byVar.AKM_LLM_API_KEY).toBe("apiKey");
  });

  test("returns nothing for an empty environment", () => {
    expect(scanProviderEnvVars({} as NodeJS.ProcessEnv)).toEqual([]);
  });
});

describe("pickDefaultModel", () => {
  test("prefers an instruct variant", () => {
    expect(pickDefaultModel(["llama-3-8b", "llama-3-8b-instruct", "tiny"])).toBe("llama-3-8b-instruct");
  });
  test("prefers the longer name when no instruct variant", () => {
    expect(pickDefaultModel(["a", "longer-model-name", "mid"])).toBe("longer-model-name");
  });
  test("returns undefined for an empty list", () => {
    expect(pickDefaultModel([])).toBeUndefined();
  });
});

describe("detectStashDir", () => {
  test("suggests existing config stashDir at rank 0", () => {
    const result = detectStashDir({ existingStashDir: "/some/stash", cwd: workDir, home: workDir });
    expect(result[0]?.path).toBe(path.resolve("/some/stash"));
    expect(result[0]?.rank).toBe(0);
  });

  test("suggests akm/ inside a CWD git repo", () => {
    const repo = path.join(workDir, "repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo, "akm"), { recursive: true });
    const nested = path.join(repo, "src", "deep");
    fs.mkdirSync(nested, { recursive: true });

    const fakeHome = path.join(workDir, "emptyhome");
    fs.mkdirSync(fakeHome, { recursive: true });

    const result = detectStashDir({ cwd: nested, home: fakeHome });
    expect(result.some((s) => s.path === path.join(repo, "akm"))).toBe(true);
  });

  test("suggests ~/akm and ~/.akm when present, ranked after repo", () => {
    const fakeHome = path.join(workDir, "home");
    fs.mkdirSync(path.join(fakeHome, "akm"), { recursive: true });
    fs.mkdirSync(path.join(fakeHome, ".akm"), { recursive: true });
    // cwd with no git repo
    const cwd = path.join(workDir, "nogit");
    fs.mkdirSync(cwd, { recursive: true });

    const result = detectStashDir({ cwd, home: fakeHome });
    const paths = result.map((s) => s.path);
    expect(paths).toContain(path.join(fakeHome, "akm"));
    expect(paths).toContain(path.join(fakeHome, ".akm"));
    // ranked ascending
    for (let i = 1; i < result.length; i++) {
      expect(result[i]?.rank).toBeGreaterThanOrEqual(result[i - 1]!.rank);
    }
  });
});

describe("detectLocalServers", () => {
  test("tolerates all endpoints being down without throwing", async () => {
    // Probe ports that are (essentially) never listening.
    const result = await detectLocalServers(["http://127.0.0.1:59999/v1"]);
    expect(Array.isArray(result)).toBe(true);
    // Generic defaults + the harness URL.
    expect(result.length).toBeGreaterThanOrEqual(4);
    for (const s of result) {
      expect(typeof s.available).toBe("boolean");
      expect(Array.isArray(s.models)).toBe(true);
    }
  });
});

describe("detectEnvironment aggregator", () => {
  test("returns a typed result with NAMES only (no key value)", async () => {
    const env = await detectEnvironment({
      existingStashDir: "/cfg/stash",
      envSource: { ANTHROPIC_API_KEY: SECRET_VALUE } as NodeJS.ProcessEnv,
      whichFn: () => undefined,
      cwd: workDir,
      home: workDir,
    });

    expect(["opencode-sdk", "opencode", "claude", "none"]).toContain(env.harness);
    expect(Array.isArray(env.localServers)).toBe(true);
    expect(env.stashSuggestions[0]?.path).toBe(path.resolve("/cfg/stash"));
    expect(env.providers.some((p) => p.envVar === "ANTHROPIC_API_KEY")).toBe(true);

    const serialized = JSON.stringify(env);
    expect(serialized).not.toContain(SECRET_VALUE);
  });

  test("selects claude harness when only claude bin is present", async () => {
    const env = await detectEnvironment({
      envSource: {} as NodeJS.ProcessEnv,
      whichFn: (bin) => (bin === "claude" ? "/usr/bin/claude" : undefined),
      cwd: workDir,
      home: workDir,
    });
    // opencode-sdk may resolve if installed; only assert no crash and a valid value.
    expect(["opencode-sdk", "claude"]).toContain(env.harness);
  });
});

describe("deriveRecommendedConfig", () => {
  test("uses a cloud provider endpoint when no local server is live", () => {
    const recommended = deriveRecommendedConfig({
      harness: "claude",
      providers: [{ provider: "anthropic", envVar: "ANTHROPIC_API_KEY", kind: "apiKey" }],
      harnessConfigs: [],
      localServers: [{ baseUrl: "http://localhost:11434", label: "Ollama", available: false, models: [] }],
      stashSuggestions: [],
      agentPlatforms: [],
    });
    expect(recommended.agentDefault).toBe("claude");
    expect(recommended.llm?.provider).toBe("anthropic");
    expect(recommended.llm?.endpoint).toContain("anthropic.com");
    expect(recommended).not.toHaveProperty("taskSchedules");
    // No API key value is ever present.
    expect(JSON.stringify(recommended)).not.toContain(SECRET_VALUE);
  });

  test("prefers a live local server with nomic-embed-text embeddings", () => {
    const recommended = deriveRecommendedConfig({
      harness: "none",
      providers: [],
      harnessConfigs: [],
      localServers: [
        {
          baseUrl: "http://localhost:1234",
          label: "LM Studio",
          available: true,
          models: ["m-instruct"],
          defaultModel: "m-instruct",
        },
      ],
      stashSuggestions: [],
      agentPlatforms: [],
    });
    expect(recommended.llm?.model).toBe("m-instruct");
    expect(recommended.embedding?.model).toBe("nomic-embed-text");
  });

  test("(#566) derives the agent default profile name from the harness registry", () => {
    // The old hardcoded if-chain only knew claude/opencode/opencode-sdk; the
    // default is now derived from the registry so any dispatch-capable harness
    // gets its canonical id as the headless default.
    for (const id of ["opencode", "claude", "opencode-sdk"] as const) {
      const recommended = deriveRecommendedConfig({
        harness: id,
        providers: [],
        harnessConfigs: [],
        localServers: [],
        stashSuggestions: [],
        agentPlatforms: [],
      });
      expect(recommended.agentDefault).toBe(id);
    }
  });

  test("(#566) harness 'none' yields no agent default (no spurious profile)", () => {
    const recommended = deriveRecommendedConfig({
      harness: "none",
      providers: [],
      harnessConfigs: [],
      localServers: [],
      stashSuggestions: [],
      agentPlatforms: [],
    });
    expect(recommended.agentDefault).toBeUndefined();
  });
});

describe("runDetectOnly", () => {
  test("never returns an API key value", async () => {
    await withEnv({ ANTHROPIC_API_KEY: SECRET_VALUE }, async () => {
      const env = await runDetectOnly();
      expect(JSON.stringify(env)).not.toContain(SECRET_VALUE);
      expect(env.providers.some((p) => p.envVar === "ANTHROPIC_API_KEY")).toBe(true);
    });
  });
});
