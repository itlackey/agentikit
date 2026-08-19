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
  test("delegates --command to the canonical invocation without normalizing exact arguments", async () => {
    const calls: unknown[] = [];
    const result = await akmAgentDispatch(
      {
        commandRef: "fixture//commands/review",
        argumentInput: "  exact\n$ARGUMENTS  ",
        agentRef: "fixture//agents/reviewer",
        engine: "reviewer",
        timeoutMs: 12_345,
        cwd: "/tmp/project",
        dispatch: { prompt: "", model: "balanced" },
        agentConfig: { configVersion: "0.9.0", semanticSearchMode: "off" },
      },
      {
        executeCommand: async (input) => {
          calls.push(input);
          return {
            schemaVersion: 2,
            ok: true,
            shape: "agent-result",
            engine: "reviewer",
            exitCode: 0,
            stdout: "done",
            stderr: "",
            durationMs: 1,
          };
        },
      },
    );

    expect(result.stdout).toBe("done");
    expect(calls).toEqual([
      {
        action: {
          ref: "fixture//commands/review",
          arguments: "  exact\n$ARGUMENTS  ",
        },
        config: { configVersion: "0.9.0", semanticSearchMode: "off" },
        current: {
          agent: "fixture//agents/reviewer",
          engine: "reviewer",
          model: "balanced",
          timeout: 12_345,
          workspace: "/tmp/project",
        },
      },
    ]);
  });

  test("rejects legacy command argv and raw persona injection before delegation", async () => {
    let calls = 0;
    const executeCommand = async () => {
      calls += 1;
      throw new Error("must not delegate");
    };
    await expect(
      akmAgentDispatch(
        {
          commandRef: "commands/review",
          args: ["lost", "spacing"],
          agentConfig: { configVersion: "0.9.0", semanticSearchMode: "off" },
        },
        { executeCommand },
      ),
    ).rejects.toThrow(/one exact string|argumentInput/i);
    await expect(
      akmAgentDispatch(
        {
          commandRef: "commands/review",
          dispatch: { prompt: "", systemPrompt: "raw persona" },
          agentConfig: { configVersion: "0.9.0", semanticSearchMode: "off" },
        },
        { executeCommand },
      ),
    ).rejects.toThrow(/agent ref|systemPrompt/i);
    expect(calls).toBe(0);
  });

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
