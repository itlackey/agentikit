// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { deepMergeConfig } from "../src/core/config/deep-merge";
import { resolveDispatchModel } from "../src/integrations/agent/builder-shared";
import {
  materializeLlmConnection,
  resolveEngine,
  resolveLlmEngineUse,
} from "../src/integrations/agent/engine-resolution";
import { buildSdkConfig } from "../src/integrations/harnesses/opencode-sdk/sdk-runner";

const config = {
  configVersion: "0.9.0",
  engines: {
    fast: {
      kind: "llm" as const,
      endpoint: "https://example.test/v1/chat/completions",
      model: "base-model",
      apiKey: `\${FAST_API_KEY}`,
      extraParams: { seed: 1, nested: { keep: true } },
    },
    reviewer: {
      kind: "agent" as const,
      platform: "pi" as const,
      model: "review-model",
    },
    sdk: {
      kind: "agent" as const,
      platform: "opencode-sdk" as const,
      llmEngine: "fast",
    },
  },
  defaults: { engine: "reviewer", llmEngine: "fast" },
};

describe("deepMergeConfig", () => {
  test("recursively merges plain objects while replacing arrays and preserving explicit values", () => {
    const merged = deepMergeConfig(
      { nested: { keep: 1, replace: true }, values: ["old"], nullable: 100 },
      { nested: { replace: false, added: 0 }, values: [], nullable: null },
    );

    expect(merged).toEqual({
      nested: { keep: 1, replace: false, added: 0 },
      values: [],
      nullable: null,
    });
  });

  test("rejects prototype-pollution keys at every depth", () => {
    expect(() => deepMergeConfig({}, JSON.parse('{"nested":{"__proto__":{"polluted":true}}}'))).toThrow(
      "Unsafe configuration key",
    );
  });
});

describe("engine resolution", () => {
  test("projects invocation overrides over one selected LLM engine without resolving its credential", () => {
    const resolved = resolveLlmEngineUse(config, [
      { engine: "fast", llm: { extraParams: { nested: { override: true } }, temperature: 0.1 } },
      { model: "leaf-model", timeoutMs: null },
    ]);

    expect(resolved).toMatchObject({
      engine: "fast",
      timeoutMs: null,
      credential: { names: ["FAST_API_KEY"], required: true },
      connection: {
        endpoint: "https://example.test/v1/chat/completions",
        model: "leaf-model",
        temperature: 0.1,
        extraParams: { seed: 1, nested: { keep: true, override: true } },
      },
    });
    expect(JSON.stringify(resolved)).not.toContain(process.env.FAST_API_KEY ?? "not-set");
  });

  test("projects first-class reasoning effort through engine and invocation resolution", () => {
    const configured = {
      ...config,
      engines: {
        ...config.engines,
        fast: { ...config.engines.fast, reasoningEffort: "high" },
      },
    };
    expect(resolveLlmEngineUse(configured, [{ engine: "fast" }]).connection.reasoningEffort).toBe("high");
    expect(
      resolveLlmEngineUse(configured, [{ engine: "fast", llm: { reasoningEffort: "none" } }]).connection
        .reasoningEffort,
    ).toBe("none");
  });

  test("preserves exact direct and SDK fallback model selectors", () => {
    const exact = {
      ...config,
      engines: {
        ...config.engines,
        fast: { ...config.engines.fast, model: "provider/exact", apiKey: undefined },
      },
    };
    expect(resolveLlmEngineUse(exact, [{ engine: "fast" }]).connection.model).toBe("provider/exact");
    const sdk = resolveEngine("sdk", exact);
    expect(sdk.kind === "sdk" && sdk.fallbackConnection?.model).toBe("provider/exact");
  });

  test("materializes an explicit symbolic credential only at dispatch", () => {
    // ISOLATION-01/02: FAST_API_KEY is not one of the AKM_*/XDG_*/HOME vars
    // tests/_preload.ts owns (HARNESSED + the leak tripwire only cover those
    // prefixes), so an unrestored set here would leak into every later test
    // in the shard. Snapshot + restore explicitly, even on assertion failure.
    const originalFastApiKey = process.env.FAST_API_KEY;
    process.env.FAST_API_KEY = "engine-secret";
    try {
      const resolved = resolveLlmEngineUse(config, [{ engine: "fast" }]);
      expect(materializeLlmConnection(resolved)?.apiKey).toBe("engine-secret");
    } finally {
      if (originalFastApiKey === undefined) delete process.env.FAST_API_KEY;
      else process.env.FAST_API_KEY = originalFastApiKey;
    }
  });

  test("revalidates extraParams at the dispatch boundary", () => {
    expect(() =>
      materializeLlmConnection({
        engine: "bypassed-validation",
        connection: {
          endpoint: "https://example.test/v1/chat/completions",
          model: "test",
          extraParams: { nested: [{ Authorization: "leak" }] },
        },
        timeoutMs: null,
      }),
    ).toThrow("cannot carry credentials");
  });

  test("uses the agent platform, rather than the engine name, to lower an SDK engine", () => {
    const resolved = resolveEngine("sdk", config);
    expect(resolved.kind).toBe("sdk");
    if (resolved.kind === "sdk") {
      expect(resolved.engine).toBe("sdk");
      expect(resolved.profile.platform).toBe("opencode-sdk");
      expect(resolved.fallbackConnection?.endpoint).toBe("https://example.test/v1/chat/completions");
    }
  });

  test("lowers an OpenCode SDK engine without requiring an LLM fallback", () => {
    const resolved = resolveEngine("native-sdk", {
      engines: { "native-sdk": { kind: "agent", platform: "opencode-sdk" } },
      defaults: { engine: "native-sdk" },
    });
    expect(resolved).toMatchObject({ kind: "sdk", engine: "native-sdk" });
    if (resolved.kind !== "sdk") throw new Error("fixture must lower to SDK");
    expect(resolved.fallbackConnection).toBeUndefined();
    expect(resolved.fallbackCredential).toBeUndefined();
  });

  test("applies exact timeout precedence and preserves explicit null in direct HTTP materialization", () => {
    // ISOLATION-01/02 fallout: `materializeLlmConnection` throws unless the
    // "fast" engine's required FAST_API_KEY credential resolves (see
    // src/integrations/agent/engine-resolution.ts:242-247). This test only
    // cares about timeoutMs, but before FAST_API_KEY was brought under
    // explicit save/restore in the "materializes an explicit symbolic
    // credential" test above, this test silently depended on that other
    // test's UNRESTORED leak of `process.env.FAST_API_KEY` to avoid throwing
    // here — a hidden order dependency masked by the very isolation bug this
    // package fixes. Set and restore it locally so this test is hermetic on
    // its own.
    const originalFastApiKey = process.env.FAST_API_KEY;
    process.env.FAST_API_KEY = "timeout-precedence-fixture-key";
    try {
      const defaults = resolveLlmEngineUse(config, [{ engine: "fast" }]);
      expect(defaults.timeoutMs).toBe(600_000);
      expect(materializeLlmConnection(defaults).timeoutMs).toBe(600_000);

      const disabled = resolveLlmEngineUse(config, [{ engine: "fast", timeoutMs: null }]);
      expect(disabled.timeoutMs).toBeNull();
      expect(Object.hasOwn(materializeLlmConnection(disabled), "timeoutMs")).toBe(true);
      expect(materializeLlmConnection(disabled).timeoutMs).toBeNull();

      const overridden = resolveLlmEngineUse(
        { ...config, engines: { ...config.engines, fast: { ...config.engines.fast, timeoutMs: 90_000 } } },
        [{ engine: "fast" }, { timeoutMs: 12_000 }],
      );
      expect(overridden.timeoutMs).toBe(12_000);
    } finally {
      if (originalFastApiKey === undefined) delete process.env.FAST_API_KEY;
      else process.env.FAST_API_KEY = originalFastApiKey;
    }
  });

  test("uses no timeout for CLI agents and inherits the fallback LLM timeout for SDK agents", () => {
    const direct = resolveEngine("reviewer", config);
    expect(direct.timeoutMs).toBeNull();

    const inherited = resolveEngine("sdk", {
      ...config,
      engines: { ...config.engines, fast: { ...config.engines.fast, timeoutMs: 345_000 } },
    });
    expect(inherited.timeoutMs).toBe(345_000);

    const explicitNull = resolveEngine("sdk", {
      ...config,
      engines: { ...config.engines, sdk: { ...config.engines.sdk, timeoutMs: null } },
    });
    expect(explicitNull.timeoutMs).toBeNull();
  });

  test("preserves an exact lowered agent model through SDK dispatch", () => {
    const lowered = resolveEngine("sdk", {
      ...config,
      engines: { ...config.engines, sdk: { ...config.engines.sdk, model: "provider/exact" } },
    });
    if (lowered.kind !== "sdk") throw new Error("fixture must lower to SDK");
    expect(lowered.profile.model).toBe("provider/exact");
    expect(buildSdkConfig(lowered.profile, lowered.fallbackConnection).model).toBe("akm-custom/provider/exact");
    expect(resolveDispatchModel({ model: "provider/exact" }, lowered.profile, "opencode-sdk")).toBe("provider/exact");
  });

  test("rejects non-canonical harness ids", () => {
    expect(() =>
      resolveEngine("invalid-claude", {
        engines: {
          "invalid-claude": { kind: "agent", platform: "claude-code" as "claude", model: "sonnet" },
        },
      }),
    ).toThrow(/cannot dispatch agents/);
  });
});
