// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import {
  type CommandExecutionSourceLoader,
  dispatchPreparedCommandInvocation,
  prepareCommandInvocation,
} from "../../src/commands/command/command-execution";
import type { AkmConfig } from "../../src/core/config/config-types";
import { canonicalResolvedExecutionRequest } from "../../src/execution/resolved-request";
import { type AdapterRenderedExecutionSource, createAdapterRenderedExecutionSource } from "../../src/execution/source";
import { mergeModelMapLayers, parseModelMapLayer } from "../../src/integrations/agent/model-map";

const config: AkmConfig = {
  configVersion: "0.9.0",
  semanticSearchMode: "off",
  defaults: { engine: "reviewer" },
  engines: {
    reviewer: {
      kind: "agent",
      platform: "claude",
      bin: "/bin/true",
      model: "engine-exact",
      timeoutMs: 60_000,
    },
  },
};

const modelMap = mergeModelMapLayers(
  parseModelMapLayer(
    JSON.stringify({
      version: 1,
      aliases: {
        balanced: { claude: "claude-balanced-exact" },
        reasoning: { claude: { model: "claude-reasoning-exact", inference: { effort: "high" } } },
      },
    }),
    "command execution fixture",
  ),
);

function rendered(
  kind: "command" | "persona",
  ref: string,
  content: string,
  defaults: Record<string, unknown> = {},
): AdapterRenderedExecutionSource {
  const [bundle = "fixture", concept = ""] = ref.split("//");
  return createAdapterRenderedExecutionSource({
    kind,
    content,
    defaults,
    identity: {
      ref,
      bundle,
      adapter: "akm",
      file: `${concept}.md`,
      hash: "a".repeat(64),
    },
  });
}

function loaderFor(command: AdapterRenderedExecutionSource, persona?: AdapterRenderedExecutionSource) {
  const calls: Array<{ ref: string; kind: string }> = [];
  const loader: CommandExecutionSourceLoader = async (ref, kind) => {
    calls.push({ ref, kind });
    const value = kind === "command" ? command : persona;
    if (!value || value.kind !== kind) throw new Error(`missing ${kind} fixture`);
    return value as never;
  };
  return { calls, loader };
}

function projectedWithoutStoredIdentity(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as { command: { source: unknown }; [key: string]: unknown };
  parsed.command = { ...parsed.command, source: null };
  return parsed;
}

describe("common command invocation preparation", () => {
  test("loads command/persona through adapters, applies exact arguments, then resolves cascade and authorization", async () => {
    const command = rendered("command", "fixture//commands/review", "Review [$ARGUMENTS].", {
      agent: "agents/reviewer",
      model: "balanced",
      tools: ["read"],
    });
    const persona = rendered("persona", "fixture//agents/reviewer", "You are a reviewer.", {
      model: "balanced",
    });
    const { calls, loader } = loaderFor(command, persona);
    const authorized: unknown[] = [];

    const prepared = await prepareCommandInvocation({
      action: { ref: "fixture//commands/review", arguments: "  exact\ninput  " },
      config,
      modelMap,
      sourceLoader: loader,
      current: { model: "reasoning" },
      authorizeTools(input) {
        authorized.push(input);
        return { status: "allowed", policy: "fixture-policy" };
      },
    });

    expect(calls).toEqual([
      { ref: "fixture//commands/review", kind: "command" },
      { ref: "fixture//agents/reviewer", kind: "persona" },
    ]);
    expect(prepared.request.command).toMatchObject({
      template: "Review [$ARGUMENTS].",
      argumentInput: "  exact\ninput  ",
      content: "Review [  exact\ninput  ].",
      source: { ref: "fixture//commands/review" },
    });
    expect(prepared.request.persona).toMatchObject({
      content: "You are a reviewer.",
      source: { ref: "fixture//agents/reviewer" },
    });
    expect(prepared.request.model).toEqual({
      input: "reasoning",
      interpretation: "alias",
      resolved: "claude-reasoning-exact",
    });
    expect(prepared.request.inference).toEqual({ effort: "high" });
    expect(prepared.request.authorization).toMatchObject({ status: "allowed", policy: { id: "fixture-policy" } });
    expect(authorized).toHaveLength(1);
  });

  test("stored and inline actions converge when effective inputs match apart from intentional source identity", async () => {
    const command = rendered("command", "fixture//commands/plain", "Review $ARGUMENTS.");
    const { loader } = loaderFor(command);
    const stored = await prepareCommandInvocation({
      action: { ref: "fixture//commands/plain", arguments: "this" },
      config,
      modelMap,
      sourceLoader: loader,
      current: { model: "exact/model" },
    });
    const inline = await prepareCommandInvocation({
      action: { content: "Review $ARGUMENTS.", arguments: "this" },
      config,
      modelMap,
      sourceLoader: loader,
      current: { model: "exact/model" },
    });

    expect(projectedWithoutStoredIdentity(canonicalResolvedExecutionRequest(stored.request))).toEqual(
      projectedWithoutStoredIdentity(canonicalResolvedExecutionRequest(inline.request)),
    );
    expect(stored.request.command.source?.ref).toBe("fixture//commands/plain");
    expect(inline.request.command.source).toBeNull();
  });

  test("native selectors stay native and do not trigger portable persona resolution", async () => {
    const command = rendered("command", "fixture//commands/native", "Review this.", { agent: "native-reviewer" });
    const { calls, loader } = loaderFor(command);
    const prepared = await prepareCommandInvocation({
      action: { ref: "fixture//commands/native" },
      config,
      modelMap,
      sourceLoader: loader,
    });
    expect(calls).toEqual([{ ref: "fixture//commands/native", kind: "command" }]);
    expect(prepared.request.agent).toBe("native-reviewer");
    expect(prepared.request.persona).toBeNull();
  });

  test("unsupported templates and denied tools fail before runner dispatch", async () => {
    let authorizationCalls = 0;
    let dispatchCalls = 0;
    const unsafe = rendered("command", "fixture//commands/unsafe", "Review $1.", { tools: ["shell"] });
    await expect(
      prepareCommandInvocation({
        action: { ref: "fixture//commands/unsafe" },
        config,
        modelMap,
        sourceLoader: loaderFor(unsafe).loader,
        authorizeTools() {
          authorizationCalls += 1;
          return { status: "allowed", policy: "unexpected" };
        },
      }),
    ).rejects.toThrow(/unsupported.*template/i);
    expect(authorizationCalls).toBe(0);

    const safe = rendered("command", "fixture//commands/denied", "Review this.", { tools: ["shell"] });
    const denied = await prepareCommandInvocation({
      action: { ref: "fixture//commands/denied" },
      config,
      modelMap,
      sourceLoader: loaderFor(safe).loader,
      authorizeTools() {
        return { status: "denied", policy: "fixture-deny" };
      },
    });
    await expect(
      dispatchPreparedCommandInvocation(denied, {
        executeRunner: async () => {
          dispatchCalls += 1;
          throw new Error("must not dispatch");
        },
      }),
    ).rejects.toThrow(/authorized|policy|selected tools/i);
    expect(dispatchCalls).toBe(0);
  });

  test("dispatches direct LLM commands with final content and persona messages", async () => {
    const llmConfig: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      defaults: { engine: "direct" },
      engines: {
        direct: {
          kind: "llm",
          endpoint: "https://fixture.invalid/v1/chat/completions",
          model: "engine-model",
        },
      },
    };
    const command = rendered("command", "fixture//commands/llm", "Review $ARGUMENTS.", {
      agent: "agents/reviewer",
    });
    const persona = rendered("persona", "fixture//agents/reviewer", "You are exact.");
    const prepared = await prepareCommandInvocation({
      action: { ref: "fixture//commands/llm", arguments: "the target" },
      config: llmConfig,
      modelMap,
      sourceLoader: loaderFor(command, persona).loader,
      current: { model: "provider/exact", timeout: 0 },
    });
    const captures: unknown[] = [];
    const result = await dispatchPreparedCommandInvocation(prepared, {
      chat: async (connection, messages, options) => {
        captures.push({ connection, messages, options });
        return "reviewed";
      },
    });

    expect(result).toMatchObject({ ok: true, engine: "direct", stdout: "reviewed", exitCode: 0 });
    expect(captures).toEqual([
      {
        connection: expect.objectContaining({
          endpoint: "https://fixture.invalid/v1/chat/completions",
          model: "provider/exact",
        }),
        messages: [
          { role: "system", content: "You are exact." },
          { role: "user", content: "Review the target." },
        ],
        options: { timeoutMs: 0 },
      },
    ]);
  });

  test("explicit null clears configured agent model and workspace before lowering", async () => {
    const configured: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      defaults: { engine: "reviewer" },
      engines: {
        reviewer: {
          kind: "agent",
          platform: "claude",
          bin: "/bin/true",
          model: "configured-model",
          workspace: "/configured/workspace",
        },
      },
    };
    const command = rendered("command", "fixture//commands/clear-agent", "Review this.");
    const prepared = await prepareCommandInvocation({
      action: { ref: "fixture//commands/clear-agent" },
      config: configured,
      modelMap,
      sourceLoader: loaderFor(command).loader,
      current: { model: null, workspace: null },
    });
    let captured: unknown;
    await dispatchPreparedCommandInvocation(prepared, {
      executeRunner: async (runner) => {
        captured = runner;
        return { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
      },
    });

    expect(prepared.request.model).toBeNull();
    expect(prepared.request.runtime.workspace).toBeNull();
    expect(captured).toMatchObject({ kind: "agent", profile: { name: "reviewer" } });
    expect((captured as { profile: Record<string, unknown> }).profile).not.toHaveProperty("model");
    expect((captured as { profile: Record<string, unknown> }).profile).not.toHaveProperty("modelIsExact");
    expect((captured as { profile: Record<string, unknown> }).profile).not.toHaveProperty("workspace");
  });

  test("explicit null clears configured LLM model and inference before lowering", async () => {
    const configured: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      defaults: { engine: "direct" },
      engines: {
        direct: {
          kind: "llm",
          endpoint: "https://fixture.invalid/v1/chat/completions",
          model: "configured-model",
          temperature: 0.7,
          extraParams: { configured: true },
        },
      },
    };
    const command = rendered("command", "fixture//commands/clear-llm", "Review this.");
    const prepared = await prepareCommandInvocation({
      action: { ref: "fixture//commands/clear-llm" },
      config: configured,
      modelMap,
      sourceLoader: loaderFor(command).loader,
      current: { model: null, inference: null },
    });
    let captured: unknown;
    await dispatchPreparedCommandInvocation(prepared, {
      executeRunner: async (runner) => {
        captured = runner;
        return { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
      },
    });

    expect(prepared.request.model).toBeNull();
    expect(prepared.request.inference).toBeNull();
    const connection = (captured as { connection: Record<string, unknown> }).connection;
    expect(connection.endpoint).toBe("https://fixture.invalid/v1/chat/completions");
    expect(connection).not.toHaveProperty("model");
    expect(connection).not.toHaveProperty("temperature");
    expect(connection).not.toHaveProperty("extraParams");
  });

  test("LLM inference cannot replace the selected model or transport identity", async () => {
    const configured: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      defaults: { engine: "direct" },
      engines: {
        direct: {
          kind: "llm",
          provider: "openai-compatible",
          endpoint: "https://fixture.invalid/v1/chat/completions",
          model: "configured-model",
        },
      },
    };
    const command = rendered("command", "fixture//commands/protected-llm", "Review this.");
    const prepared = await prepareCommandInvocation({
      action: { ref: "fixture//commands/protected-llm" },
      config: configured,
      modelMap,
      sourceLoader: loaderFor(command).loader,
      current: {
        model: "vendor/exact-model",
        inference: {
          endpoint: "https://attacker.invalid/v1/chat/completions",
          provider: "attacker",
          apiKey: "do-not-use",
          model: "attacker-model",
          timeoutMs: 1,
          temperature: 0,
        },
      },
    });
    let captured: unknown;
    await dispatchPreparedCommandInvocation(prepared, {
      executeRunner: async (runner) => {
        captured = runner;
        return { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
      },
    });

    expect(prepared.request.inference).toMatchObject({ endpoint: "https://attacker.invalid/v1/chat/completions" });
    const connection = (captured as { connection: Record<string, unknown> }).connection;
    expect(connection).toMatchObject({
      endpoint: "https://fixture.invalid/v1/chat/completions",
      provider: "openai-compatible",
      model: "vendor/exact-model",
      temperature: 0,
    });
    expect(connection).not.toHaveProperty("apiKey");
    expect(connection).not.toHaveProperty("timeoutMs");
  });
});
