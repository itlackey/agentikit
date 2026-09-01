/**
 * Wave-2 QA fixes tests — Cluster B (#21, #36) and Cluster C (#6, #14, #24).
 *
 * Cluster B: defaultWriteTarget and llm/embedding subkey support in config-cli.
 * Cluster C: empty-query guards + minScore floor for semantic-only hits.
 */

import { describe, expect, test } from "bun:test";
import { getConfigValue, listConfig, setConfigValue, unsetConfigValue } from "../../../../src/commands/config-cli";
import type { AkmConfig } from "../../../../src/core/config/config";
import { getDbPath } from "../../../../src/core/paths";
import { deriveEntryProvenance } from "../../../../src/indexer/installations";
import type { IndexDocument } from "../../../../src/indexer/passes/metadata";
import { searchLocal } from "../../../../src/indexer/search/db-search";
import { _setEmbedderForTests } from "../../../../src/llm/embedder";
import { closeDatabase, openIndexDatabase } from "../../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../../src/storage/repositories/index-entries-repository";
import { rebuildFts } from "../../../../src/storage/repositories/index-fts-repository";
import { setMeta } from "../../../../src/storage/repositories/index-meta-repository";
import { upsertEmbedding } from "../../../../src/storage/repositories/index-vec-repository";
import { withIsolatedAkmStorage } from "../../../_helpers/sandbox";
import { overrideSeam } from "../../../_helpers/seams";

// ── Cluster B: #21 defaultWriteTarget ────────────────────────────────────────

describe("config-cli: defaultWriteTarget (#21)", () => {
  const base: AkmConfig = { semanticSearchMode: "auto" };

  // R-063 #5: "setConfigValue cannot set defaultWriteTarget without a
  // configured bundle" used to be a `parseConfigValue`-shim test (removed —
  // dead code); it duplicated the "rejects defaultWriteTarget when no
  // bundles are configured" case below, so it is not re-added here.
  test("setConfigValue rejects empty defaultWriteTarget", () => {
    expect(() => setConfigValue(base, "defaultWriteTarget", "")).toThrow();
  });

  test("getConfigValue returns null when not set", () => {
    expect(getConfigValue(base, "defaultWriteTarget")).toBeNull();
  });

  test("getConfigValue returns the set value", () => {
    const config: AkmConfig = { ...base, defaultWriteTarget: "my-stash" };
    expect(getConfigValue(config, "defaultWriteTarget")).toBe("my-stash");
  });

  test("setConfigValue rejects defaultWriteTarget when no bundles are configured", () => {
    expect(() => setConfigValue(base, "defaultWriteTarget", "any-name")).toThrow(/Unknown bundle/);
  });

  test("setConfigValue validates the name against configured bundles", () => {
    const config: AkmConfig = {
      ...base,
      bundles: { primary: { path: "/tmp/stash" } },
    };
    expect(() => setConfigValue(config, "defaultWriteTarget", "unknown-stash")).toThrow(/Unknown bundle/);
  });

  test("setConfigValue accepts a valid source name", () => {
    const config: AkmConfig = {
      ...base,
      bundles: { primary: { path: "/tmp/stash" } },
    };
    const result = setConfigValue(config, "defaultWriteTarget", "primary");
    expect(result.defaultWriteTarget).toBe("primary");
  });

  test("unsetConfigValue clears defaultWriteTarget", () => {
    const config: AkmConfig = { ...base, defaultWriteTarget: "primary" };
    const result = unsetConfigValue(config, "defaultWriteTarget");
    expect(result.defaultWriteTarget).toBeUndefined();
  });

  test("listConfig includes defaultWriteTarget when set", () => {
    const config: AkmConfig = { ...base, defaultWriteTarget: "primary" };
    const listed = listConfig(config);
    expect(listed.defaultWriteTarget).toBe("primary");
  });

  test("listConfig omits defaultWriteTarget when not set", () => {
    const listed = listConfig(base);
    expect(listed.defaultWriteTarget).toBeUndefined();
  });
});

// ── Cluster B: engine/embedding subkey support ────────────────────────────────

describe("config-cli: engines.* and embedding.* subkeys (#36)", () => {
  const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };

  // ── setConfigValue ────────────────────────────────────────────────────────
  // R-063 #5: previously exercised via `parseConfigValue`, a compatibility
  // shim removed as dead code (zero production callers) — see the note in
  // tests/config-cli.test.ts. `setConfigValue` is the live implementation.

  test("setConfigValue handles engines.local.endpoint", () => {
    const result = setConfigValue(base, "engines.local.endpoint", "http://localhost:11434/v1/chat/completions");
    expect(result.engines?.local?.endpoint).toBe("http://localhost:11434/v1/chat/completions");
  });

  test("setConfigValue handles engines.local.model", () => {
    const result = setConfigValue(base, "engines.local.model", "llama3.2");
    expect(result.engines?.local?.model).toBe("llama3.2");
  });

  // "apiKey cannot be persisted" is covered by "setConfigValue: retired
  // llm.apiKey is rejected with an env-var hint (#454)" below; this adds the
  // AKM_LLM_API_KEY hint-text assertion that test doesn't check.
  test("setConfigValue explicitly rejects the retired llm.apiKey path with the env-var hint (#454)", () => {
    expect(() => setConfigValue(base, "llm.apiKey", "sk-test")).toThrow(/AKM_LLM_API_KEY/);
  });

  test("setConfigValue handles embedding.endpoint", () => {
    const result = setConfigValue(base, "embedding.endpoint", "http://localhost:11434/v1/embeddings");
    expect(result.embedding?.endpoint).toBe("http://localhost:11434/v1/embeddings");
  });

  test("setConfigValue handles embedding.model", () => {
    const result = setConfigValue(base, "embedding.model", "nomic-embed-text");
    expect(result.embedding?.model).toBe("nomic-embed-text");
  });

  test("setConfigValue accepts symbolic embedding credentials and rejects literals", () => {
    expect(setConfigValue(base, "embedding.apiKey", "$AKM_EMBED_API_KEY").embedding?.apiKey).toBe("$AKM_EMBED_API_KEY");
    expect(() => setConfigValue(base, "embedding.apiKey", "sk-embed")).toThrow(/apiKey must be \$VAR/);
  });

  test("setConfigValue rejects an empty engine endpoint", () => {
    expect(() => setConfigValue(base, "engines.local.endpoint", "")).toThrow(/endpoint must be a complete URL/);
  });

  // ── getConfigValue ────────────────────────────────────────────────────────

  test("getConfigValue: engines.local.endpoint returns null when the engine is not set", () => {
    expect(getConfigValue(base, "engines.local.endpoint")).toBeNull();
  });

  test("getConfigValue: engine connection fields return values when set", () => {
    const config: AkmConfig = {
      ...base,
      engines: {
        local: { kind: "llm", endpoint: "http://localhost/v1/chat/completions", model: "llama3.2" },
      },
      defaults: { llmEngine: "local" },
    };
    expect(getConfigValue(config, "engines.local.endpoint")).toBe("http://localhost/v1/chat/completions");
    expect(getConfigValue(config, "engines.local.model")).toBe("llama3.2");
    expect(getConfigValue(config, "engines.local.apiKey")).toBeNull();
  });

  test("getConfigValue: embedding subkeys work", () => {
    const config: AkmConfig = {
      ...base,
      embedding: { endpoint: "http://localhost/emb", model: "bge-small" },
    };
    expect(getConfigValue(config, "embedding.endpoint")).toBe("http://localhost/emb");
    expect(getConfigValue(config, "embedding.model")).toBe("bge-small");
    expect(
      getConfigValue({ ...config, embedding: { ...config.embedding, apiKey: "$EMBED_KEY" } }, "embedding.apiKey"),
    ).toBe("$EMBED_KEY");
  });

  // ── setConfigValue with deep merge ────────────────────────────────────────

  test("setConfigValue: engine endpoint preserves sibling model field", () => {
    const config: AkmConfig = {
      ...base,
      engines: { local: { kind: "llm", endpoint: "http://old/chat/completions", model: "old-model" } },
      defaults: { llmEngine: "local" },
    };
    const result = setConfigValue(config, "engines.local.endpoint", "http://new/chat/completions");
    expect(result.engines?.local?.endpoint).toBe("http://new/chat/completions");
    expect(result.engines?.local?.model).toBe("old-model");
  });

  test("setConfigValue: engine model preserves sibling endpoint field", () => {
    const config: AkmConfig = {
      ...base,
      engines: {
        local: { kind: "llm", endpoint: "http://localhost/v1/chat/completions", model: "old-model" },
      },
      defaults: { llmEngine: "local" },
    };
    const result = setConfigValue(config, "engines.local.model", "gpt-4o");
    expect(result.engines?.local?.model).toBe("gpt-4o");
    expect(result.engines?.local?.endpoint).toBe("http://localhost/v1/chat/completions");
  });

  test("setConfigValue: retired llm.apiKey is rejected with an env-var hint (#454)", () => {
    const config: AkmConfig = { ...base };
    expect(() => setConfigValue(config, "llm.apiKey", "sk-secret")).toThrow(/apiKey cannot be persisted/);
  });

  test("setConfigValue: embedding.endpoint works when embedding was undefined", () => {
    const result = setConfigValue(base, "embedding.endpoint", "http://localhost/emb");
    expect(result.embedding?.endpoint).toBe("http://localhost/emb");
    // Post-rewrite: subkey-set no longer scaffolds an empty `model`. The
    // user runs `embedding.model <name>` as a follow-up.
    expect(result.embedding?.model).toBeUndefined();
  });

  // ── unsetConfigValue ──────────────────────────────────────────────────────

  test("unsetConfigValue: engine endpoint removes the key", () => {
    const config: AkmConfig = {
      ...base,
      engines: {
        local: { kind: "llm", endpoint: "http://localhost/v1/chat/completions", model: "llama3.2" },
      },
      defaults: { llmEngine: "local" },
    };
    const result = unsetConfigValue(config, "engines.local.endpoint");
    expect(result.engines?.local?.endpoint).toBeUndefined();
    expect(result.engines?.local?.model).toBe("llama3.2");
  });

  test("unsetConfigValue: engine apiKey removes the key", () => {
    const config: AkmConfig = {
      ...base,
      engines: {
        local: {
          kind: "llm",
          endpoint: "http://localhost/v1/chat/completions",
          model: "llama3.2",
          apiKey: "$LOCAL_API_KEY",
        },
      },
      defaults: { llmEngine: "local" },
    };
    const result = unsetConfigValue(config, "engines.local.apiKey");
    expect(result.engines?.local?.apiKey).toBeUndefined();
    expect(result.engines?.local?.endpoint).toBe("http://localhost/v1/chat/completions");
  });

  test("unsetConfigValue: embedding.apiKey removes the key", () => {
    const config: AkmConfig = {
      ...base,
      embedding: { endpoint: "http://localhost/emb", model: "bge-small", apiKey: "sk-embed" },
    };
    const result = unsetConfigValue(config, "embedding.apiKey");
    expect(result.embedding?.apiKey).toBeUndefined();
    expect(result.embedding?.endpoint).toBe("http://localhost/emb");
  });
});

// ── Cluster C: #14 empty query guard ────────────────────────────────────────

describe("search empty-query guard (#14, #24)", () => {
  // Note: The empty-query guard for `akmSearch` lives in the CLI layer (src/cli.ts),
  // not in `akmSearch` itself (which accepts empty queries for programmatic list-all).
  // The guard for `akmCurate` IS in the function itself since curation always
  // requires a meaningful query.

  test("akmCurate throws UsageError for empty string query", async () => {
    const { akmCurate } = await import("../../../../src/commands/read/curate");
    await expect(akmCurate({ query: "" })).rejects.toThrow(/query is required/i);
  });

  test("akmCurate throws UsageError for whitespace-only query", async () => {
    const { akmCurate } = await import("../../../../src/commands/read/curate");
    await expect(akmCurate({ query: "   " })).rejects.toThrow(/query is required/i);
  });

  test("akmCurate UsageError has MISSING_REQUIRED_ARGUMENT code", async () => {
    const { akmCurate } = await import("../../../../src/commands/read/curate");
    const { UsageError } = await import("../../../../src/core/errors");
    try {
      await akmCurate({ query: "" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect((err as import("../../../../src/core/errors").UsageError).code).toBe("MISSING_REQUIRED_ARGUMENT");
    }
  });
});

// ── Cluster C: #6 minScore floor ─────────────────────────────────────────────

describe("search.minScore floor in config (#6)", () => {
  test("AkmConfig accepts search.minScore", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      search: { minScore: 0.3 },
    };
    expect(config.search?.minScore).toBe(0.3);
  });

  test("AkmConfig accepts search.minScore of 0 (disabled)", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      search: { minScore: 0 },
    };
    expect(config.search?.minScore).toBe(0);
  });

  // VALUE-01 (Phase 2 triage): the prior version of this test only asserted
  // `config.search?.minScore` is `undefined` when unset — it never drove the
  // actual floor at src/indexer/search/db-search.ts:500
  // (`const minScore = config.search?.minScore ?? 0.2;`). That left the 0.2
  // default completely unpinned anywhere in the tree. This replacement drives
  // the REAL code path end-to-end through `searchLocal`, with two
  // vector-only ("semantic" rankingMode, no FTS match) hits whose cosine
  // similarity is fully controlled (mocked query embedding + hand-inserted
  // stored embeddings), so their pre-boost score is deterministic:
  // `score = cosine * VEC_WEIGHT(0.3)`. Both entries use `type: "task"`
  // (TYPE_BOOST.task = 0, see ranking-contributors.ts) and carry no
  // tags/searchHints/quality/beliefState/captureMode, and the query shares no
  // token with either entry's name/description — so no other ranking
  // contributor fires and the floor comparison operates on the raw
  // cosine*0.3 value (verified empirically at exactly 0.18 / 0.27, matching
  // the hand-derived math with no boost contamination).
  test("minScore floor: default 0.2 is actually enforced against semantic-only hits, and is configurable", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const dbPath = getDbPath();
      const db = openIndexDatabase(dbPath, { embeddingDim: 4 });
      try {
        // cosine 0.6 -> score 0.6 * 0.3 = 0.18 (below the 0.2 default floor)
        const belowFloorId = upsertEntry(
          db,
          "/fake/tasks/below-floor.md",
          { type: "task", name: "below-floor", description: "unrelated filler content alpha" } as IndexDocument,
          "below-floor unrelated filler content alpha",
          deriveEntryProvenance({ bundleId: "stash", componentId: "stash", adapterId: "akm" }, "task", "below-floor"),
        );
        upsertEmbedding(db, belowFloorId, [0.6, 0.8, 0, 0]);

        // cosine 0.9 -> score 0.9 * 0.3 = 0.27 (above the 0.2 default floor)
        const aboveFloorId = upsertEntry(
          db,
          "/fake/tasks/above-floor.md",
          { type: "task", name: "above-floor", description: "unrelated filler content beta" } as IndexDocument,
          "above-floor unrelated filler content beta",
          deriveEntryProvenance({ bundleId: "stash", componentId: "stash", adapterId: "akm" }, "task", "above-floor"),
        );
        upsertEmbedding(db, aboveFloorId, [0.9, Math.sqrt(1 - 0.81), 0, 0]);

        rebuildFts(db);
        setMeta(db, "hasEmbeddings", "1");
        // Satisfies ensure-index.ts's indexCanServeStash() so searchLocal serves
        // this hand-built DB instead of triggering a real reindex.
        setMeta(db, "stashDir", storage.stashDir);

        // Mock the query embedding only — stored embeddings above are real
        // BLOB rows, so cosine similarity is computed by the real vector
        // search path (tryVecScores -> searchVec), not faked.
        overrideSeam(_setEmbedderForTests, { embed: async () => [1, 0, 0, 0] });

        // Shares no token with either entry's name/description, so neither
        // entry gets an FTS match — both surface only via the vector index
        // (rankingMode "semantic"), which is exactly what the floor gates.
        const query = "gizmoquery9000";
        const sources = [{ path: storage.stashDir }];
        const baseConfig: AkmConfig = { semanticSearchMode: "auto" };
        const searchArgs = {
          query,
          searchType: "any" as const,
          limit: 10,
          stashDir: storage.stashDir,
          sources,
          disableProjectContext: true,
          disableScopedUtility: true,
        };

        // (a) Default: no explicit search.minScore -> the coded 0.2 default applies.
        const defaultResult = await searchLocal({ ...searchArgs, config: baseConfig });
        const defaultNames = defaultResult.hits.map((h) => h.name);
        expect(defaultNames).not.toContain("below-floor");
        expect(defaultNames).toContain("above-floor");

        // (b) Explicit 0 disables the floor entirely -> both survive.
        const disabledResult = await searchLocal({
          ...searchArgs,
          config: { ...baseConfig, search: { minScore: 0 } },
        });
        const disabledNames = disabledResult.hits.map((h) => h.name);
        expect(disabledNames).toContain("below-floor");
        expect(disabledNames).toContain("above-floor");

        // (c) Explicit 0.3 (above both scores) -> both are dropped, proving the
        // floor genuinely compares against the hit's score rather than being a
        // fixed on/off switch that only ever reads the built-in default.
        const raisedResult = await searchLocal({
          ...searchArgs,
          config: { ...baseConfig, search: { minScore: 0.3 } },
        });
        const raisedNames = raisedResult.hits.map((h) => h.name);
        expect(raisedNames).not.toContain("below-floor");
        expect(raisedNames).not.toContain("above-floor");
      } finally {
        closeDatabase(db);
      }
    } finally {
      storage.cleanup();
    }
  });
});
