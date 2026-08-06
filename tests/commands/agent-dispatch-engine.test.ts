// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { akmAgentDispatch } from "../../src/commands/agent/agent-dispatch";
import { UsageError } from "../../src/core/errors";
import { _setWarnSinkForTests } from "../../src/core/warn";
import { FALLBACK_ANNOUNCEMENT } from "../../src/integrations/agent/engine-fallback";
import { overrideSeam } from "../_helpers/seams";

describe("akmAgentDispatch engine capability", () => {
  test("returns the exact v2 public result envelope", async () => {
    const result = await akmAgentDispatch({
      engine: "test-agent",
      prompt: "hello",
      agentConfig: {
        configVersion: "0.9.0",
        semanticSearchMode: "auto",
        engines: {
          "test-agent": { kind: "agent", platform: "aider", bin: "/bin/true" },
        },
        defaults: { engine: "test-agent" },
      },
    });
    expect(result).toEqual({
      schemaVersion: 2,
      ok: true,
      shape: "agent-result",
      engine: "test-agent",
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: expect.any(Number),
    });
  });

  test("rejects an LLM engine instead of falling back to an agent profile", async () => {
    await expect(
      akmAgentDispatch({
        engine: "fast",
        prompt: "hello",
        agentConfig: {
          configVersion: "0.9.0",
          semanticSearchMode: "auto",
          engines: {
            fast: {
              kind: "llm",
              endpoint: "https://example.test/v1/chat/completions",
              model: "test",
            },
          },
          defaults: { engine: "fast" },
        },
      }),
    ).rejects.toBeInstanceOf(UsageError);
  });

  test("returns one structured envelope for a normal runner failure", async () => {
    const result = await akmAgentDispatch({
      engine: "test-agent",
      prompt: "hello",
      agentConfig: {
        configVersion: "0.9.0",
        semanticSearchMode: "auto",
        engines: {
          "test-agent": { kind: "agent", platform: "aider", bin: "/bin/false" },
        },
        defaults: { engine: "test-agent" },
      },
    });

    const parsed = JSON.parse(JSON.stringify(result)) as typeof result;
    expect(parsed).toMatchObject({ schemaVersion: 2, ok: false, shape: "agent-result" });
    expect(result).toMatchObject({ schemaVersion: 2, ok: false, shape: "agent-result", exitCode: 1 });
  });

  test("the implicit engine fallback is announced, never silent — result warnings + warn()", async () => {
    const warned: string[] = [];
    overrideSeam(_setWarnSinkForTests, (level, args) => {
      if (level === "warn") warned.push(args.map(String).join(" "));
    });

    const result = await akmAgentDispatch({
      prompt: "hello",
      agentConfig: {
        configVersion: "0.9.0",
        semanticSearchMode: "auto",
        // No defaults.engine: withEngineFallback must select the opencode-sdk
        // entry. Operator-configured wins over synthesis, and the pinned
        // absolute bin keeps the probe (and the dispatch) off the real
        // opencode binary and PATH.
        engines: {
          "opencode-sdk": { kind: "agent", platform: "aider", bin: "/bin/true" },
        },
      },
    });

    expect(result.engine).toBe("opencode-sdk");
    expect(result.warnings).toEqual([FALLBACK_ANNOUNCEMENT]);
    expect(warned).toContain(FALLBACK_ANNOUNCEMENT);
  });
});
