// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The env-credential seam both dispatch boundaries read through.
 *
 * `materializeFrozenLlm` (frozen workflow dispatch) and
 * `materializeLlmConnection` (live-config dispatch) resolve the SAME credential
 * descriptor, so lookup order and the required-credential failure must be one
 * behavior, not two that happen to agree. These tests pin it from both sides.
 */

import { describe, expect, test } from "bun:test";
import { ConfigError } from "../../src/core/errors";
import { materializeLlmConnection } from "../../src/integrations/agent/engine-resolution";
import { materializeFrozenLlm } from "../../src/workflows/exec/unit-dispatch";
import type { FrozenEngineSnapshot } from "../../src/workflows/ir/schema";

const PRIMARY = "FROZEN_CRED_PRIMARY";
const FALLBACK = "FROZEN_CRED_FALLBACK";

/**
 * ISOLATION-01/02: these names carry none of the `AKM_*` / `XDG_*` / `HOME`
 * prefixes `tests/_preload.ts` snapshots, so an unrestored set would leak into
 * every later test in the shard. Restore explicitly, even when the body throws.
 */
function withEnv<T>(vars: Record<string, string | undefined>, body: () => T): T {
  const original = Object.keys(vars).map((key): [string, string | undefined] => [key, process.env[key]]);
  const apply = (entries: Iterable<[string, string | undefined]>): void => {
    for (const [key, value] of entries) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(Object.entries(vars));
  try {
    return body();
  } finally {
    apply(original);
  }
}

function llmSnapshot(credential?: {
  names: [string, ...string[]];
  required: boolean;
}): Extract<FrozenEngineSnapshot, { kind: "llm" }> {
  return {
    name: "fast",
    kind: "llm",
    endpoint: "https://example.test/v1/chat/completions",
    model: "base-model",
    concurrency: 1,
    ...(credential ? { credential } : {}),
  };
}

describe("frozen llm credential materialization", () => {
  test("takes the first non-empty trimmed name, skipping a blank earlier one", () => {
    const connection = withEnv({ [PRIMARY]: "   ", [FALLBACK]: "  fallback-secret  " }, () =>
      materializeFrozenLlm(llmSnapshot({ names: [PRIMARY, FALLBACK], required: true }), undefined),
    );

    expect(connection.apiKey).toBe("fallback-secret");
    expect(connection.model).toBe("base-model");
    expect(connection.endpoint).toBe("https://example.test/v1/chat/completions");
  });

  test("an unset required credential fails identically at the frozen and the live boundary", () => {
    const [frozenError, liveError] = withEnv({ [PRIMARY]: undefined, [FALLBACK]: undefined }, () => {
      const capture = (run: () => unknown): unknown => {
        try {
          run();
        } catch (err) {
          return err;
        }
        return undefined;
      };
      return [
        capture(() => materializeFrozenLlm(llmSnapshot({ names: [PRIMARY, FALLBACK], required: true }), undefined)),
        capture(() =>
          materializeLlmConnection({
            engine: "fast",
            connection: { endpoint: "https://example.test/v1/chat/completions", model: "base-model" },
            credential: { names: [PRIMARY, FALLBACK], required: true },
            timeoutMs: null,
          }),
        ),
      ];
    });

    expect(frozenError).toBeInstanceOf(ConfigError);
    expect(liveError).toBeInstanceOf(ConfigError);
    expect((frozenError as ConfigError).message).toBe(`Required engine credential ${PRIMARY} is not set.`);
    expect((liveError as ConfigError).message).toBe((frozenError as ConfigError).message);
    expect((frozenError as ConfigError).code).toBe("INVALID_CONFIG_FILE");
    expect((liveError as ConfigError).code).toBe((frozenError as ConfigError).code);
  });

  test("an unset optional credential materializes no apiKey key at all", () => {
    const connection = withEnv({ [PRIMARY]: undefined }, () =>
      materializeFrozenLlm(llmSnapshot({ names: [PRIMARY], required: false }), undefined),
    );

    expect(Object.hasOwn(connection, "apiKey")).toBe(false);
  });

  test("a snapshot with no credential descriptor resolves without touching the environment", () => {
    const connection = withEnv({ [PRIMARY]: "unused-secret" }, () =>
      materializeFrozenLlm(llmSnapshot(), { engine: "fast", model: "override-model", timeoutMs: null }),
    );

    expect(Object.hasOwn(connection, "apiKey")).toBe(false);
    expect(connection.model).toBe("override-model");
  });
});
