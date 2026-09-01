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

describe("legacy extraParams -> first-class field config (#852) fails closed at load", () => {
  test("a real 0.9.1-shaped config (extraParams.reasoning_effort) is rejected, naming akm migrate apply", () => {
    const text = configWithEngine({ extraParams: { reasoning_effort: "none" } });
    const message = expectThrows(text);
    expect(message).toContain("extraParams.reasoning_effort -> engines.default.reasoningEffort");
    expect(message).toContain("akm migrate apply");
  });

  test("extraParams.temperature is rejected, naming akm migrate apply", () => {
    const message = expectThrows(configWithEngine({ extraParams: { temperature: 0.2 } }));
    expect(message).toContain("extraParams.temperature -> engines.default.temperature");
    expect(message).toContain("akm migrate apply");
  });

  test("extraParams.maxtokens is rejected, naming akm migrate apply", () => {
    const message = expectThrows(configWithEngine({ extraParams: { maxtokens: 512 } }));
    expect(message).toContain("extraParams.maxtokens -> engines.default.maxTokens");
    expect(message).toContain("akm migrate apply");
  });

  test("extraParams.enable_thinking is rejected, naming akm migrate apply", () => {
    const message = expectThrows(configWithEngine({ extraParams: { enable_thinking: false } }));
    expect(message).toContain("extraParams.enable_thinking -> engines.default.enableThinking");
    expect(message).toContain("akm migrate apply");
  });

  test("a liftable key alongside an unrelated, still-protected extraParams key is rejected for the liftable key first", () => {
    // The extraParams-needs-migration check runs before schema validation
    // ever gets a chance to inspect `stream`, so the error names the
    // migration path rather than the unrelated protected-key rejection.
    const text = configWithEngine({ extraParams: { reasoning_effort: "none", stream: true } });
    const message = expectThrows(text);
    expect(message).toContain("akm migrate apply");
  });

  test("a protected key with no first-class equivalent still rejects, and the error names the remedy", () => {
    const message = expectThrows(configWithEngine({ extraParams: { stream: true } }));
    expect(message).toContain("stream is protected by AKM");
    expect(message).toContain("AKM controls streaming internally");
  });

  test("extraParams.reasoning_effort conflicting with a different first-class reasoningEffort value rejects, naming both", () => {
    const text = configWithEngine({ reasoningEffort: "high", extraParams: { reasoning_effort: "none" } });
    const message = expectThrows(text);
    expect(message).toContain('extraParams.reasoning_effort ("none")');
    expect(message).toContain('engines.default.reasoningEffort ("high")');
  });

  test("extraParams.reasoning_effort matching the same first-class value is still rejected as not-yet-migrated", () => {
    // Not a conflict (same value both places), but still a legacy-shaped
    // config that has not run `akm migrate apply` — it is rejected the same
    // way as a genuinely differing value, just via the lifted (not conflict)
    // path.
    const text = configWithEngine({ reasoningEffort: "none", extraParams: { reasoning_effort: "none" } });
    const message = expectThrows(text);
    expect(message).toContain("redundant");
    expect(message).toContain("akm migrate apply");
  });
});
