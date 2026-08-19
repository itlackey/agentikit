// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigError } from "../../src/core/errors";
import { getCommandBuilder } from "../../src/integrations/agent/builders";
import {
  copyDefaultModelMap,
  DEFAULT_MODEL_MAP_TEXT,
  loadModelMap,
  MODEL_MAP_VERSION,
  mergeModelMapLayers,
  parseModelMapLayer,
  resolveModelMapAlias,
} from "../../src/integrations/agent/model-map";
import type { AgentProfile } from "../../src/integrations/agent/profiles";
import { buildSdkConfig } from "../../src/integrations/harnesses/opencode-sdk/sdk-runner";

const installedText = JSON.stringify({
  version: 1,
  aliases: {
    reasoning: {
      claude: {
        model: "claude-opus-exact",
        inference: { effort: "high", temperature: 0, enabled: false },
      },
    },
    balanced: { claude: "claude-sonnet-exact" },
  },
});

function profile(platform: "claude" | "opencode"): AgentProfile {
  return {
    name: platform,
    bin: platform,
    args: platform === "opencode" ? ["run"] : [],
    stdio: "captured",
    envPassthrough: [],
    parseOutput: "text",
  };
}

describe("versioned installed/user model-map contract", () => {
  test("uses version 1 and pins only the approved starter intent aliases", () => {
    expect(MODEL_MAP_VERSION).toBe(1);
    const defaults = parseModelMapLayer(DEFAULT_MODEL_MAP_TEXT, "installed models.json");
    expect(defaults.version).toBe(1);
    expect(Object.keys(defaults.aliases).sort()).toEqual(["balanced", "fast", "reasoning"]);
    for (const alias of Object.values(defaults.aliases)) {
      expect(Object.keys(alias).sort()).toEqual(["claude", "opencode", "opencode-sdk"]);
      expect(alias).not.toHaveProperty("*");
      expect(alias).not.toHaveProperty("llm");
    }
    const merged = mergeModelMapLayers(defaults);
    const expected = {
      fast: {
        claude: "claude-haiku-4-5-20251001",
        opencode: "opencode/claude-haiku-4-5",
        sdk: "anthropic/claude-haiku-4-5",
      },
      balanced: {
        claude: "claude-sonnet-4-6",
        opencode: "opencode/claude-sonnet-4-6",
        sdk: "anthropic/claude-sonnet-4-6",
      },
      reasoning: {
        claude: "claude-opus-4-7",
        opencode: "opencode/claude-opus-4-7",
        sdk: "anthropic/claude-opus-4-7",
      },
    } as const;
    for (const [alias, exact] of Object.entries(expected)) {
      for (const platform of ["claude", "opencode"] as const) {
        const selection = resolveModelMapAlias(alias, platform, merged);
        const command = getCommandBuilder(platform).build(profile(platform), {
          prompt: "test",
          model: selection.model,
          modelIsExact: true,
        });
        expect(command.argv[command.argv.indexOf("--model") + 1]).toBe(exact[platform]);
      }
      const sdkSelection = resolveModelMapAlias(alias, "opencode-sdk", merged);
      expect(
        buildSdkConfig({
          name: "opencode-sdk",
          bin: "",
          args: [],
          stdio: "captured",
          envPassthrough: [],
          parseOutput: "text",
          model: sdkSelection.model,
          modelIsExact: true,
        }).model,
      ).toBe(exact.sdk);
    }
  });

  test("accepts a partial user profile and overlays nested inference fields", () => {
    const installed = parseModelMapLayer(installedText, "installed models.json");
    const user = parseModelMapLayer(
      JSON.stringify({
        version: 1,
        aliases: { reasoning: { claude: { inference: { effort: "medium" } } } },
      }),
      "user models.json",
    );

    const merged = mergeModelMapLayers(installed, user);
    expect(merged.aliases.reasoning?.claude).toEqual({
      model: "claude-opus-exact",
      inference: { effort: "medium", temperature: 0, enabled: false },
    });
  });

  test("uses the same layer schema but requires a usable model after merge", () => {
    const installed = parseModelMapLayer(installedText, "installed models.json");
    const partial = parseModelMapLayer(
      JSON.stringify({ version: 1, aliases: { custom: { claude: { inference: { effort: "high" } } } } }),
      "user models.json",
    );
    expect(() => mergeModelMapLayers(installed, partial)).toThrow(/custom.*claude.*model/i);
  });

  test("rejects unsupported versions and undocumented structured profile fields", () => {
    expect(() => parseModelMapLayer('{"version":2,"aliases":{}}', "models.json")).toThrow(/version/i);
    expect(() =>
      parseModelMapLayer('{"version":1,"aliases":{"fast":{"claude":{"model":"x","effort":"high"}}}}', "models.json"),
    ).toThrow(/effort/);
  });

  test("passes unknown model input through exactly", () => {
    const map = mergeModelMapLayers(parseModelMapLayer(installedText, "installed models.json"));
    expect(resolveModelMapAlias("Vendor/Model-X:Q4", "claude", map)).toEqual({
      input: "Vendor/Model-X:Q4",
      interpretation: "exact",
      model: "Vendor/Model-X:Q4",
    });
    for (const exact of ["valueOf", "hasOwnProperty", "toString", "constructor", "__proto__"]) {
      expect(resolveModelMapAlias(exact, "claude", map)).toEqual({
        input: exact,
        interpretation: "exact",
        model: exact,
      });
    }
    expect(resolveModelMapAlias("balanced", "Claude", map).model).toBe("claude-sonnet-exact");
  });

  test("fails when a known alias lacks the selected engine mapping", () => {
    const map = mergeModelMapLayers(parseModelMapLayer(installedText, "installed models.json"));
    expect(() => resolveModelMapAlias("balanced", "gemini", map)).toThrow(/known alias.*balanced.*gemini/i);
  });

  test("engine-local and legacy config-root aliases remain nearer compatibility inputs", () => {
    const map = mergeModelMapLayers(parseModelMapLayer(installedText, "installed models.json"));
    expect(
      resolveModelMapAlias("balanced", "claude", map, {
        engineAliases: { balanced: "engine-local-exact" },
        globalAliases: { balanced: { claude: "config-root-exact" } },
      }).model,
    ).toBe("engine-local-exact");
    expect(
      resolveModelMapAlias("balanced", "claude", map, {
        globalAliases: { balanced: { claude: "config-root-exact" } },
      }).model,
    ).toBe("config-root-exact");
  });

  test("normalizes alias and engine keys while rejecting case collisions", () => {
    const normalized = parseModelMapLayer('{"version":1,"aliases":{"FAST":{"Claude":"exact-model"}}}', "models.json");
    expect(normalized.aliases.fast?.claude).toBe("exact-model");
    expect(() =>
      parseModelMapLayer('{"version":1,"aliases":{"fast":{"claude":"one"},"FAST":{"claude":"two"}}}', "models.json"),
    ).toThrow(/collides case-insensitively/);
    expect(() =>
      parseModelMapLayer('{"version":1,"aliases":{"fast":{"claude":"one","CLAUDE":"two"}}}', "models.json"),
    ).toThrow(/engine.*collides case-insensitively/i);
  });

  test("rejects prototype-like alias and engine keys case-insensitively", () => {
    for (const key of ["__proto__", "constructor", "prototype", "toString", "CONSTRUCTOR"]) {
      expect(() =>
        parseModelMapLayer(JSON.stringify({ version: 1, aliases: { [key]: { claude: "x" } } }), "models.json"),
      ).toThrow(/reserved|prototype/i);
      expect(() =>
        parseModelMapLayer(JSON.stringify({ version: 1, aliases: { fast: { [key]: "x" } } }), "models.json"),
      ).toThrow(/reserved|prototype/i);
    }
  });

  test("recursively overlays objects while arrays, scalars, and null replace", () => {
    const installed = parseModelMapLayer(
      JSON.stringify({
        version: 1,
        aliases: {
          reasoning: {
            claude: {
              model: "base",
              inference: {
                nested: { keep: true, replace: "old" },
                array: [1, 2],
                scalar: "old",
                nullable: { keep: false },
              },
            },
          },
        },
      }),
      "installed models.json",
    );
    const user = parseModelMapLayer(
      JSON.stringify({
        version: 1,
        aliases: {
          reasoning: {
            claude: {
              inference: { nested: { replace: 0 }, array: [], scalar: false, nullable: null },
            },
          },
        },
      }),
      "user models.json",
    );
    const before = JSON.stringify({ installed, user });
    const merged = mergeModelMapLayers(installed, user);
    expect(merged.aliases.reasoning?.claude).toEqual({
      model: "base",
      inference: {
        nested: { keep: true, replace: 0 },
        array: [],
        scalar: false,
        nullable: null,
      },
    });
    expect(JSON.stringify({ installed, user })).toBe(before);
    expect(merged.aliases.reasoning?.claude).not.toBe(installed.aliases.reasoning?.claude);
  });

  test("a string shorthand overlays only model and preserves installed inference", () => {
    const installed = parseModelMapLayer(installedText, "installed models.json");
    const user = parseModelMapLayer(
      '{"version":1,"aliases":{"reasoning":{"claude":"operator-model"}}}',
      "user models.json",
    );
    expect(mergeModelMapLayers(installed, user).aliases.reasoning?.claude).toEqual({
      model: "operator-model",
      inference: { effort: "high", temperature: 0, enabled: false },
    });
  });

  test("missing user file is healthy while invalid and unreadable files remain distinguishable", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-model-map-load-"));
    const env = { XDG_CONFIG_HOME: root } as NodeJS.ProcessEnv;
    try {
      expect(loadModelMap({ env }).userStatus).toBe("absent");
      const target = path.join(root, "akm", "models.json");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '{"version":1,"aliases":{"fast":');
      expect(() => loadModelMap({ env })).toThrow(
        new RegExp(`user models\\.json.*${target.replaceAll("/", "\\/")}.*invalid JSON`, "i"),
      );
      fs.rmSync(target);
      fs.mkdirSync(target);
      let unreadable: unknown;
      try {
        loadModelMap({ env });
      } catch (error) {
        unreadable = error;
      }
      expect(unreadable).toBeInstanceOf(ConfigError);
      expect((unreadable as ConfigError).code).toBe("INVALID_CONFIG_FILE");
      expect((unreadable as Error).message).toMatch(/unable to read user models\.json/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("copy-defaults validates first, writes atomically, and requires safe explicit overwrite", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-model-map-copy-"));
    const env = { XDG_CONFIG_HOME: root } as NodeJS.ProcessEnv;
    const target = path.join(root, "akm", "models.json");
    try {
      expect(() => copyDefaultModelMap({ env, installedText: "not json" })).toThrow(
        /installed models\.json.*invalid JSON/i,
      );
      expect(fs.existsSync(target)).toBe(false);
      expect(copyDefaultModelMap({ env })).toEqual({ path: target, copied: true, overwritten: false });
      expect(fs.readFileSync(target, "utf8")).toBe(DEFAULT_MODEL_MAP_TEXT);
      expect(fs.readdirSync(path.dirname(target)).sort()).toEqual(["models.json"]);
      fs.writeFileSync(target, "operator bytes");
      expect(() => copyDefaultModelMap({ env })).toThrow(/already exists/);
      expect(fs.readFileSync(target, "utf8")).toBe("operator bytes");
      expect(copyDefaultModelMap({ env, overwrite: true }).overwritten).toBe(true);
      expect(fs.readFileSync(target, "utf8")).toBe(DEFAULT_MODEL_MAP_TEXT);
      fs.rmSync(target);
      fs.symlinkSync(path.join(root, "elsewhere"), target);
      expect(() => copyDefaultModelMap({ env, overwrite: true })).toThrow(/non-regular/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
