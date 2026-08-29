// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// #852 (following #815): a 0.9.1-shaped config using the documented
// `extraParams.reasoning_effort` workaround must keep loading now that
// `reasoningEffort` is a first-class — and therefore protected — engine
// field. `parseAndValidateConfigText` is pure (no filesystem), so these run
// directly against it rather than through the tmp-XDG-dir config-load
// integration harness.
import { describe, expect, test } from "bun:test";
import { parseAndValidateConfigText } from "../src/core/config/config";
import { ConfigError } from "../src/core/errors";
import { _setWarnSinkForTests } from "../src/core/warn";

function withWarnSink(): { warnings: string[]; restore: () => void } {
  const warnings: string[] = [];
  _setWarnSinkForTests((level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
  return { warnings, restore: () => _setWarnSinkForTests(undefined) };
}

function configWithEngine(engine: Record<string, unknown>): string {
  return JSON.stringify({
    configVersion: "0.9.0",
    engines: {
      default: {
        kind: "llm",
        endpoint: "https://example.com/v1/chat/completions",
        model: "test-model",
        ...engine,
      },
    },
  });
}

describe("legacy extraParams -> first-class field migration (#852)", () => {
  test("a real 0.9.1-shaped config (extraParams.reasoning_effort) loads and lands in reasoningEffort", () => {
    const { warnings, restore } = withWarnSink();
    try {
      const text = configWithEngine({ extraParams: { reasoning_effort: "none" } });
      const config = parseAndValidateConfigText(text);
      const engine = config.engines?.default as Record<string, unknown>;
      expect(engine.reasoningEffort).toBe("none");
      expect(engine.extraParams).toBeUndefined();
      expect(warnings.some((w) => w.includes("extraParams.reasoning_effort -> engines.default.reasoningEffort"))).toBe(
        true,
      );
    } finally {
      restore();
    }
  });

  test("extraParams.temperature lifts onto the first-class temperature field", () => {
    const { restore } = withWarnSink();
    try {
      const text = configWithEngine({ extraParams: { temperature: 0.2 } });
      const config = parseAndValidateConfigText(text);
      const engine = config.engines?.default as Record<string, unknown>;
      expect(engine.temperature).toBe(0.2);
      expect(engine.extraParams).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("extraParams.maxtokens lifts onto the first-class maxTokens field", () => {
    const { restore } = withWarnSink();
    try {
      const text = configWithEngine({ extraParams: { maxtokens: 512 } });
      const config = parseAndValidateConfigText(text);
      const engine = config.engines?.default as Record<string, unknown>;
      expect(engine.maxTokens).toBe(512);
      expect(engine.extraParams).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("extraParams.enable_thinking lifts onto the first-class enableThinking field", () => {
    const { restore } = withWarnSink();
    try {
      const text = configWithEngine({ extraParams: { enable_thinking: false } });
      const config = parseAndValidateConfigText(text);
      const engine = config.engines?.default as Record<string, unknown>;
      expect(engine.enableThinking).toBe(false);
      expect(engine.extraParams).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("a lifted key alongside an unrelated, still-protected extraParams key leaves the latter rejected", () => {
    const text = configWithEngine({ extraParams: { reasoning_effort: "none", stream: true } });
    expect(() => parseAndValidateConfigText(text)).toThrow(ConfigError);
    try {
      parseAndValidateConfigText(text);
      throw new Error("expected parseAndValidateConfigText to throw");
    } catch (err) {
      expect(String(err)).toContain("stream is protected by AKM");
    }
  });

  test("a protected key with no first-class equivalent still rejects, and the error names the remedy", () => {
    const text = configWithEngine({ extraParams: { stream: true } });
    try {
      parseAndValidateConfigText(text);
      throw new Error("expected parseAndValidateConfigText to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect(String(err)).toContain("stream is protected by AKM");
      expect(String(err)).toContain("AKM controls streaming internally");
    }
  });

  test("extraParams.reasoning_effort conflicting with a different first-class reasoningEffort value rejects, naming both", () => {
    const text = configWithEngine({ reasoningEffort: "high", extraParams: { reasoning_effort: "none" } });
    try {
      parseAndValidateConfigText(text);
      throw new Error("expected parseAndValidateConfigText to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const message = String(err);
      expect(message).toContain('extraParams.reasoning_effort ("none")');
      expect(message).toContain('engines.default.reasoningEffort ("high")');
    }
  });

  test("extraParams.reasoning_effort matching the same first-class value is dropped as redundant, not a conflict", () => {
    const { warnings, restore } = withWarnSink();
    try {
      const text = configWithEngine({ reasoningEffort: "none", extraParams: { reasoning_effort: "none" } });
      const config = parseAndValidateConfigText(text);
      const engine = config.engines?.default as Record<string, unknown>;
      expect(engine.reasoningEffort).toBe("none");
      expect(engine.extraParams).toBeUndefined();
      expect(warnings.some((w) => w.includes("redundant"))).toBe(true);
    } finally {
      restore();
    }
  });
});
