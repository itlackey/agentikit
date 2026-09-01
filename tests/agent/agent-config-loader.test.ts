/**
 * Integration test: the AkmConfig loader preserves current engine definitions.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

describe("AkmConfig loader — agent engines", () => {
  test("loads agent engines and defaults.engine", async () => {
    const { loadUserConfig, resetConfigCache } = await import("../../src/core/config/config");
    const { getConfigPath } = await import("../../src/core/paths");
    const cfgPath = getConfigPath();
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(
      cfgPath,
      JSON.stringify(
        {
          configVersion: "0.9.0",
          semanticSearchMode: "auto",
          engines: {
            claude: { kind: "agent", platform: "claude", args: ["--print"], timeoutMs: 45000 },
            opencode: { kind: "agent", platform: "opencode", bin: "opencode-cli" },
          },
          defaults: { engine: "claude" },
        },
        null,
        2,
      ),
    );
    resetConfigCache();
    const cfg = loadUserConfig();
    expect(cfg.defaults?.engine).toBe("claude");
    expect(cfg.engines?.claude).toMatchObject({ kind: "agent", platform: "claude", args: ["--print"] });
    expect(cfg.engines?.opencode).toMatchObject({ kind: "agent", platform: "opencode", bin: "opencode-cli" });
  });
});
