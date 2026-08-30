// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `configVersion` read shim (#863) — establishes the mechanism BEFORE
 * any real bump ever needs it. `"0.9.0"` is the only `configVersion` akm has
 * ever shipped, so `"0.0.1"` here is a SYNTHETIC placeholder fixture (see
 * `src/core/config/config-version-shim.ts`'s module doc), not a real prior
 * release shape. It still has to load-bear: it exercises the actual shim
 * that ships in production, through the real `loadUserConfig()` path.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadUserConfig, resetConfigCache } from "../../src/core/config/config";
import { KNOWN_OLD_CONFIG_VERSIONS, upgradeConfigVersion } from "../../src/core/config/config-version-shim";
import { ConfigError } from "../../src/core/errors";
import { getConfigPath } from "../../src/core/paths";
import { resetQuiet, setQuiet } from "../../src/core/warn";

beforeEach(() => resetConfigCache());
afterEach(() => resetConfigCache());

function writeConfig(value: unknown): void {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(value));
}

describe("configVersion read shim (#863)", () => {
  describe("known old version — synthetic 0.0.1 fixture", () => {
    let warnSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      // The harness sets quiet=true by default (tests/_preload.ts); opt into
      // real warn() output so the spy actually observes the deprecation line.
      setQuiet(false);
      warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
      resetQuiet();
    });

    test("a plausibly-older 0.0.1 shape (root-level defaultEngine) loads successfully via the shim", () => {
      writeConfig({
        configVersion: "0.0.1",
        defaultEngine: "fast",
        engines: {
          fast: {
            kind: "llm",
            endpoint: "https://example.test/v1/chat/completions",
            model: "test",
          },
        },
      });

      const config = loadUserConfig();
      // Upgraded to the current shape: defaultEngine -> defaults.llmEngine.
      expect(config.configVersion).toBe("0.9.0");
      expect(config.defaults?.llmEngine).toBe("fast");
      expect(config.engines?.fast?.model).toBe("test");
      // Never rewritten to disk — the on-disk file still says 0.0.1.
      expect(JSON.parse(fs.readFileSync(getConfigPath(), "utf8")).configVersion).toBe("0.0.1");
    });

    test("warns once on stderr naming the old version and the upgrade", () => {
      writeConfig({
        configVersion: "0.0.1",
        defaultEngine: "fast",
        engines: { fast: { kind: "llm", endpoint: "https://example.test/v1/chat/completions", model: "test" } },
      });
      loadUserConfig();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = warnSpy.mock.calls[0]?.[0] as string;
      expect(message).toContain("0.0.1");
      expect(message).toContain("0.9.0");
    });

    test("an existing defaults.llmEngine in the 0.0.1 document wins over the root-level defaultEngine", () => {
      writeConfig({
        configVersion: "0.0.1",
        defaultEngine: "fast",
        defaults: { llmEngine: "other" },
        engines: {
          fast: { kind: "llm", endpoint: "https://example.test/v1/chat/completions", model: "test" },
          other: { kind: "llm", endpoint: "https://example.test/v1/chat/completions", model: "test2" },
        },
      });
      expect(loadUserConfig().defaults?.llmEngine).toBe("other");
    });

    test("a 0.0.1 document with no defaultEngine loads with no defaults.llmEngine set", () => {
      writeConfig({ configVersion: "0.0.1" });
      expect(loadUserConfig().defaults?.llmEngine).toBeUndefined();
    });
  });

  describe("forward-incompatibility still fails closed", () => {
    test("an unknown newer configVersion is rejected, not silently coerced", () => {
      writeConfig({ configVersion: "99.0.0" });
      expect(() => loadUserConfig()).toThrow(ConfigError);
      expect(() => loadUserConfig()).toThrow(/UNSUPPORTED_CONFIG_VERSION|configVersion/);
    });

    test("a plausible-but-unlisted older version is rejected, not guessed at", () => {
      writeConfig({ configVersion: "0.7.0" });
      expect(() => loadUserConfig()).toThrow(ConfigError);
    });

    test("upgradeConfigVersion throws UNSUPPORTED_CONFIG_VERSION with a clear, actionable hint for an unknown version", () => {
      try {
        upgradeConfigVersion({ configVersion: "99.0.0" }, "/tmp/akm-config.json");
        throw new Error("expected upgradeConfigVersion to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        const configErr = err as ConfigError;
        expect(configErr.code).toBe("UNSUPPORTED_CONFIG_VERSION");
        expect(configErr.message).toContain("99.0.0");
        expect(configErr.message).toContain("/tmp/akm-config.json");
        expect(configErr.hint()).toBeTruthy();
      }
    });

    test("a missing configVersion is rejected", () => {
      writeConfig({ engines: {} });
      expect(() => loadUserConfig()).toThrow(ConfigError);
    });
  });

  describe("upgradeConfigVersion (unit)", () => {
    test("passes an already-current config through unchanged", () => {
      const raw = { configVersion: "0.9.0", engines: {} };
      expect(upgradeConfigVersion(raw)).toBe(raw);
    });

    test("KNOWN_OLD_CONFIG_VERSIONS does not include the current version", () => {
      expect(KNOWN_OLD_CONFIG_VERSIONS).not.toContain("0.9.0");
    });
  });
});
