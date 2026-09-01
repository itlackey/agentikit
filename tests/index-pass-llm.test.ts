import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../src/core/config/config";
import { loadUserConfig, resetConfigCache } from "../src/core/config/config";
import { ConfigError } from "../src/core/errors";
import { getConfigPath } from "../src/core/paths";
import type { LoweringNotice } from "../src/execution/resolved-request";
import { createEnrichmentDeadline } from "../src/indexer/indexer";
import { resolveIndexPassExecution } from "../src/llm/index-passes";
import { type Cleanup, sandboxXdgConfigHome } from "./_helpers/sandbox";

// Tests for standalone index-pass engine resolution.

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cfgResult = sandboxXdgConfigHome();
  envCleanup = cfgResult.cleanup;
  resetConfigCache();
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
  resetConfigCache();
});

function writeUserConfig(raw: object): void {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(raw, null, 2));
}

const SAMPLE_LLM = {
  endpoint: "http://localhost:11434/v1/chat/completions",
  model: "llama3.2",
};

function resolvedConnection(passName: string, config: AkmConfig): Record<string, unknown> | undefined {
  const runner = resolveIndexPassExecution(passName, config).runner;
  return runner
    ? {
        ...runner.connection,
        ...(Object.hasOwn(runner, "timeoutMs") ? { timeoutMs: runner.timeoutMs } : {}),
      }
    : undefined;
}

describe("resolveIndexPassExecution", () => {
  test("returns the symbolic runner with stable initial lowering notices", () => {
    const modelMapPath = path.join(path.dirname(getConfigPath()), "models.json");
    fs.writeFileSync(
      modelMapPath,
      JSON.stringify({
        version: 1,
        aliases: {
          reasoning: {
            index: { model: "exact-index-model", inference: { effort: "high" } },
          },
        },
      }),
    );
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      engines: { index: { kind: "llm", ...SAMPLE_LLM, model: "reasoning" } },
      index: { defaults: { engine: "index" } },
    };

    const resolved = resolveIndexPassExecution("graph", config);

    expect(resolved.runner?.connection.model).toBe("exact-index-model");
    expect(resolved.runner?.connection).not.toHaveProperty("effort");
    expect(resolved.notices).toEqual([
      expect.objectContaining({
        code: "untranslated-field",
        severity: "warning",
        adapter: "llm",
        field: "inference.effort",
      }) as LoweringNotice,
    ]);
    expect(Object.isFrozen(resolved.notices)).toBe(true);
  });

  test("returns undefined when no index engine is configured", () => {
    const config: AkmConfig = { semanticSearchMode: "auto" };
    expect(resolveIndexPassExecution("enrichment", config).runner).toBeUndefined();
    expect(resolveIndexPassExecution("graph", config).runner).toBeUndefined();
  });

  test("returns the index default engine for any pass", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      engines: { index: { kind: "llm", ...SAMPLE_LLM } },
      index: { defaults: { engine: "index" } },
    };
    expect(resolvedConnection("enrichment", config)).toEqual({ ...SAMPLE_LLM, timeoutMs: 600_000 });
    expect(resolvedConnection("memory", config)).toEqual({ ...SAMPLE_LLM, timeoutMs: 600_000 });
    expect(resolvedConnection("graph", config)).toEqual({ ...SAMPLE_LLM, timeoutMs: 600_000 });
  });

  test("keeps a required credential symbolic until the resolved request dispatches", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      engines: {
        index: {
          kind: "llm",
          ...SAMPLE_LLM,
          apiKey: "$AKM_INDEX_PASS_REQUIRED_KEY",
        },
      },
      index: { defaults: { engine: "index" } },
    };

    expect(() => resolveIndexPassExecution("enrichment", config)).not.toThrow();
    const runner = resolveIndexPassExecution("enrichment", config).runner;
    expect(runner).toMatchObject({
      kind: "llm",
      engine: "index",
      credential: { names: ["AKM_INDEX_PASS_REQUIRED_KEY"], required: true },
    });
    expect(runner?.connection).toEqual(SAMPLE_LLM);
    expect(runner?.connection).not.toHaveProperty("apiKey");
  });

  test("standalone enrichment preserves an explicit unbounded timeout", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      engines: { index: { kind: "llm", ...SAMPLE_LLM, timeoutMs: null } },
      index: { defaults: { engine: "index" } },
    };

    expect(resolveIndexPassExecution("enrichment", config).runner?.timeoutMs).toBeNull();
    expect(
      createEnrichmentDeadline(resolveIndexPassExecution("enrichment", config).runner?.timeoutMs, 3),
    ).toBeUndefined();
  });

  describe("per-pass engines", () => {
    const PRIMARY = { endpoint: "http://localhost:11434/v1/chat/completions", model: "primary" };
    const MINISTRAL = { endpoint: "http://localhost:11434/v1/chat/completions", model: "ministral-3b" };

    test("memory pass uses index.memory.engine when set", () => {
      const config: AkmConfig = {
        semanticSearchMode: "auto",
        engines: {
          primary: { kind: "llm", ...PRIMARY },
          ministral: { kind: "llm", ...MINISTRAL },
        },
        index: { defaults: { engine: "primary" }, memory: { engine: "ministral" } },
      };
      expect(resolvedConnection("memory", config)).toEqual({ ...MINISTRAL, timeoutMs: 600_000 });
      // Default LLM still wins for passes WITHOUT a per-process override.
      expect(resolvedConnection("enrichment", config)).toEqual({ ...PRIMARY, timeoutMs: 600_000 });
    });

    test("graph pass uses index.graph.engine when set", () => {
      const config: AkmConfig = {
        semanticSearchMode: "auto",
        engines: {
          primary: { kind: "llm", ...PRIMARY },
          ministral: { kind: "llm", ...MINISTRAL },
        },
        index: { defaults: { engine: "primary" }, graph: { engine: "ministral" } },
      };
      expect(resolvedConnection("graph", config)).toEqual({ ...MINISTRAL, timeoutMs: 600_000 });
      // Memory pass still falls through to default — no override for memory.
      expect(resolvedConnection("memory", config)).toEqual({ ...PRIMARY, timeoutMs: 600_000 });
    });

    test("rejects a missing per-pass engine instead of silently using the default", () => {
      const config: AkmConfig = {
        semanticSearchMode: "auto",
        engines: { primary: { kind: "llm", ...PRIMARY } },
        index: { defaults: { engine: "primary" }, graph: { engine: "missing" } },
      };
      expect(() => resolveIndexPassExecution("graph", config)).toThrow(/missing/i);
    });

    test("index.<pass>.enabled === false opts the pass out", () => {
      const config: AkmConfig = {
        semanticSearchMode: "auto",
        engines: { primary: { kind: "llm", ...PRIMARY } },
        index: { defaults: { engine: "primary" }, memory: { enabled: false } },
      };
      expect(resolveIndexPassExecution("memory", config).runner).toBeUndefined();
    });
  });

  test("per-pass enabled false opts that pass out, leaving siblings intact", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      engines: { index: { kind: "llm", ...SAMPLE_LLM } },
      index: {
        defaults: { engine: "index" },
        enrichment: { enabled: false },
        graph: { enabled: true },
      },
    };
    expect(resolveIndexPassExecution("enrichment", config).runner).toBeUndefined();
    expect(resolvedConnection("graph", config)).toEqual({ ...SAMPLE_LLM, timeoutMs: 600_000 });
    expect(resolvedConnection("memory", config)).toEqual({ ...SAMPLE_LLM, timeoutMs: 600_000 });
  });

  test("per-pass model overrides the selected engine without mutating siblings", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      engines: { index: { kind: "llm", ...SAMPLE_LLM } },
      index: { defaults: { engine: "index" }, enrichment: { model: "override" } },
    };
    expect(resolvedConnection("enrichment", config)).toEqual({
      ...SAMPLE_LLM,
      model: "override",
      timeoutMs: 600_000,
    });
    expect(resolvedConnection("graph", config)).toEqual({ ...SAMPLE_LLM, timeoutMs: 600_000 });
  });

  test("projects pass-over-default model, merged inference, and timeout onto the symbolic runner", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      engines: {
        index: {
          kind: "llm",
          ...SAMPLE_LLM,
          temperature: 0.9,
          maxTokens: 999,
          supportsJsonSchema: true,
          timeoutMs: 9_000,
        },
      },
      index: {
        defaults: {
          engine: "index",
          model: "default-model",
          timeoutMs: 4_000,
          llm: { temperature: 0.4, maxTokens: 400 },
        },
        enrichment: {
          model: "pass-model",
          timeoutMs: 2_000,
          llm: { temperature: 0.2 },
        },
      },
    };

    const runner = resolveIndexPassExecution("enrichment", config).runner;
    expect(runner?.connection).toMatchObject({
      model: "pass-model",
      temperature: 0.2,
      maxTokens: 400,
      supportsJsonSchema: true,
    });
    expect(runner?.timeoutMs).toBe(2_000);
  });

  test("improve strategy engines never configure standalone index passes", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      engines: { improve: { kind: "llm", ...SAMPLE_LLM } },
      defaults: { improveStrategy: "default" },
      improve: {
        strategies: {
          default: {
            engine: "improve",
            processes: { memoryInference: { enabled: true }, graphExtraction: { enabled: true } },
          },
        },
      },
    };
    expect(resolveIndexPassExecution("memory", config).runner).toBeUndefined();
    expect(resolveIndexPassExecution("graph", config).runner).toBeUndefined();
  });
});

describe("config loader: `index` block parsing", () => {
  test("loads valid index default and per-pass engine selectors", () => {
    writeUserConfig({
      configVersion: "0.9.0",
      engines: {
        primary: { kind: "llm", ...SAMPLE_LLM },
        graph: { kind: "llm", ...SAMPLE_LLM, model: "graph-model" },
      },
      index: {
        defaults: { engine: "primary" },
        enrichment: { enabled: false },
        graph: { engine: "graph" },
      },
    });
    const config = loadUserConfig();
    expect(config.index?.defaults?.engine).toBe("primary");
    expect(config.index?.enrichment?.enabled).toBe(false);
    expect(config.index?.graph?.engine).toBe("graph");
  });

  test("loads graphExtractionIncludeTypes for graph pass", async () => {
    writeUserConfig({
      configVersion: "0.9.0",
      index: {
        graph: { graphExtractionIncludeTypes: ["memory", "command"] },
      },
    });
    const config = loadUserConfig();
    const { getIndexPassConfig } = await import("../src/core/config/config");
    expect(getIndexPassConfig(config.index, "graph")?.graphExtractionIncludeTypes).toEqual(["memory", "command"]);
  });

  test("rejects per-pass provider configuration (duplicate provider path)", () => {
    writeUserConfig({
      configVersion: "0.9.0",
      index: {
        enrichment: {
          endpoint: "http://other-host/v1/chat/completions",
          model: "other-model",
        },
      },
    });
    expect(() => loadUserConfig()).toThrow(ConfigError);
    try {
      loadUserConfig();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("INVALID_CONFIG_FILE");
      expect((err as Error).message).toContain("Retired or misplaced engine setting");
      expect((err as Error).message).toContain("index.enrichment.endpoint");
    }
  });

  test("rejects per-pass provider configuration fields", () => {
    for (const key of ["provider", "apiKey", "temperature", "maxTokens", "baseUrl", "capabilities"]) {
      writeUserConfig({
        configVersion: "0.9.0",
        index: { enrichment: { [key]: "anything" } },
      });
      resetConfigCache();
      expect(() => loadUserConfig()).toThrow(/Retired or misplaced engine setting/);
    }
  });

  test("rejects a retired boolean llm selector under a pass", () => {
    writeUserConfig({
      configVersion: "0.9.0",
      index: { enrichment: { llm: false } },
    });
    expect(() => loadUserConfig()).toThrow(/typed invocation|object/i);
  });

  test("accepts typed per-pass llm invocation overrides", () => {
    writeUserConfig({
      configVersion: "0.9.0",
      engines: { index: { kind: "llm", ...SAMPLE_LLM } },
      defaults: { llmEngine: "index" },
      index: { enrichment: { llm: { temperature: 0.2, maxTokens: 64 } } },
    });
    const resolved = resolveIndexPassExecution("enrichment", loadUserConfig()).runner;
    expect(resolved?.connection).toMatchObject({ temperature: 0.2, maxTokens: 64 });
  });

  test("rejects unknown keys under a pass entry", () => {
    writeUserConfig({
      configVersion: "0.9.0",
      index: { enrichment: { foo: true } },
    });
    expect(() => loadUserConfig()).toThrow(/Unknown key `index\.enrichment\.foo`/);
  });

  test("accepts arbitrary graphExtractionIncludeTypes values (WI-9.6c: accept-any until Chunk 2)", () => {
    // The hardcoded type allowlist (GRAPH_EXTRACTION_INCLUDE_TYPES_ALLOWED) was
    // deleted — it had already drifted from the runtime consumer's own
    // supported-type set (stale `wiki` entry, missing `fact`). The field is
    // now an array of arbitrary non-empty strings; an unrecognized type is
    // handled gracefully at runtime (silently yields zero eligible files for
    // that type — see src/indexer/graph/graph-extraction.ts's
    // SUPPORTED_GRAPH_EXTRACTION_INCLUDE_TYPES / collectEligibleFiles), not
    // rejected at config-load time.
    writeUserConfig({
      configVersion: "0.9.0",
      index: { graph: { graphExtractionIncludeTypes: ["memory", "bogus-type"] } },
    });
    const config = loadUserConfig();
    expect(config.index?.graph?.graphExtractionIncludeTypes).toEqual(["memory", "bogus-type"]);
  });

  test("rejects array-shaped `index` block", () => {
    writeUserConfig({
      configVersion: "0.9.0",
      // biome-ignore lint/suspicious/noExplicitAny: testing invalid runtime input
      index: [{ llm: false }] as any,
    });
    expect(() => loadUserConfig()).toThrow(/expected an object keyed by pass name/);
  });

  test("rejects non-object pass entry", () => {
    writeUserConfig({
      configVersion: "0.9.0",
      index: { enrichment: false },
    });
    expect(() => loadUserConfig()).toThrow(/expected an object like/);
  });

  test("missing `index` block is fine", () => {
    writeUserConfig({ configVersion: "0.9.0" });
    const config = loadUserConfig();
    expect(config.index).toBeUndefined();
    expect(resolveIndexPassExecution("enrichment", config).runner).toBeUndefined();
  });
});
