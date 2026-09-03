// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// #852 (following #815): a 0.9.1-shaped config using the documented
// `extraParams.reasoning_effort` workaround used to load silently, lifting
// the value onto `reasoningEffort` (now a first-class — and therefore
// protected — engine field) on every load, forever, and never writing the
// rewrite back to disk. That silent-lift-forever shape was deleted: the lift
// is now `akm migrate apply`'s job (tests/commands/migrate-config-extra-
// params.test.ts), and a not-yet-migrated config fails closed here instead,
// naming `akm migrate apply` as the fix. `parseAndValidateConfigText` is
// pure (no filesystem), so these run directly against it rather than
// through the tmp-XDG-dir config-load integration harness.
import { describe, expect, test } from "bun:test";
import { parseAndValidateConfigText } from "../src/core/config/config";
import { ConfigError } from "../src/core/errors";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";

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

function expectThrows(text: string): string {
  try {
    parseAndValidateConfigText(text);
    throw new Error("expected parseAndValidateConfigText to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return String(err);
  }
}

function loadCapturingWarnings(text: string): {
  config: ReturnType<typeof parseAndValidateConfigText>;
  warnings: string[];
} {
  const warnings: string[] = [];
  _resetWarnOnceForTests();
  _setWarnSinkForTests((level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
  try {
    return { config: parseAndValidateConfigText(text), warnings };
  } finally {
    _setWarnSinkForTests(undefined);
  }
}

describe("legacy extraParams -> first-class field config (#852) loads via the in-memory lift", () => {
  test("a real 0.9.1-shaped config (extraParams.reasoning_effort) loads, lifted onto reasoningEffort, warning once", () => {
    const text = configWithEngine({ extraParams: { reasoning_effort: "none" } });
    const { config, warnings } = loadCapturingWarnings(text);
    expect(config.engines?.default?.reasoningEffort).toBe("none");
    expect(
      (config.engines?.default?.extraParams as Record<string, unknown> | undefined)?.reasoning_effort,
    ).toBeUndefined();
    expect(warnings.some((w) => w.includes("extraParams.reasoning_effort -> engines.default.reasoningEffort"))).toBe(
      true,
    );
    expect(warnings.some((w) => w.includes("akm migrate apply"))).toBe(true);
  });

  test("extraParams.temperature lifts onto temperature, warning once", () => {
    const { config, warnings } = loadCapturingWarnings(configWithEngine({ extraParams: { temperature: 0.2 } }));
    expect(config.engines?.default?.temperature).toBe(0.2);
    expect(warnings.some((w) => w.includes("extraParams.temperature -> engines.default.temperature"))).toBe(true);
    expect(warnings.some((w) => w.includes("akm migrate apply"))).toBe(true);
  });

  test("extraParams.maxtokens lifts onto maxTokens, warning once", () => {
    const { config, warnings } = loadCapturingWarnings(configWithEngine({ extraParams: { maxtokens: 512 } }));
    expect(config.engines?.default?.maxTokens).toBe(512);
    expect(warnings.some((w) => w.includes("extraParams.maxtokens -> engines.default.maxTokens"))).toBe(true);
    expect(warnings.some((w) => w.includes("akm migrate apply"))).toBe(true);
  });

  test("extraParams.enable_thinking lifts onto enableThinking, warning once", () => {
    const { config, warnings } = loadCapturingWarnings(configWithEngine({ extraParams: { enable_thinking: false } }));
    expect(config.engines?.default?.enableThinking).toBe(false);
    expect(warnings.some((w) => w.includes("extraParams.enable_thinking -> engines.default.enableThinking"))).toBe(
      true,
    );
    expect(warnings.some((w) => w.includes("akm migrate apply"))).toBe(true);
  });

  test("a liftable key alongside an unrelated, still-protected extraParams key still rejects for the protected key", () => {
    // The lift only removes the liftable key from extraParams; `stream` has
    // no first-class equivalent and stays protected, so schema validation
    // (which runs on the LIFTED config) still rejects it.
    const text = configWithEngine({ extraParams: { reasoning_effort: "none", stream: true } });
    const message = expectThrows(text);
    expect(message).toContain("stream is protected by AKM");
  });

  test("a protected key with no first-class equivalent still rejects, and the error names the remedy", () => {
    const message = expectThrows(configWithEngine({ extraParams: { stream: true } }));
    expect(message).toContain("stream is protected by AKM");
    expect(message).toContain("AKM controls streaming internally");
  });

  test("extraParams.reasoning_effort conflicting with a different first-class reasoningEffort value still rejects, naming both", () => {
    const text = configWithEngine({ reasoningEffort: "high", extraParams: { reasoning_effort: "none" } });
    const message = expectThrows(text);
    expect(message).toContain('extraParams.reasoning_effort ("none")');
    expect(message).toContain('engines.default.reasoningEffort ("high")');
  });

  test("extraParams.reasoning_effort matching the same first-class value loads, dropping the redundant duplicate", () => {
    // Not a conflict (same value both places) — the redundant extraParams
    // duplicate is dropped and the load succeeds, warning once.
    const text = configWithEngine({ reasoningEffort: "none", extraParams: { reasoning_effort: "none" } });
    const { config, warnings } = loadCapturingWarnings(text);
    expect(config.engines?.default?.reasoningEffort).toBe("none");
    expect(warnings.some((w) => w.includes("redundant"))).toBe(true);
    expect(warnings.some((w) => w.includes("akm migrate apply"))).toBe(true);
  });
});
