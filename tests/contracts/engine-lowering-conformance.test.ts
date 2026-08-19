import { describe, expect, test } from "bun:test";
import { renderMarkdownExecutionSource } from "../../src/core/adapter/execution-source";
import type { AkmConfig } from "../../src/core/config/config";
import {
  canonicalResolvedExecutionRequest,
  createInlineResolvedCommand,
  createResolvedExecutionRequest,
  createResolvedPersona,
  decodeResolvedExecutionRequest,
  type ResolvedExecutionRequestV1,
} from "../../src/execution/resolved-request";
import {
  CONVERSATION_FALLBACK_BEGIN,
  CONVERSATION_FALLBACK_END,
} from "../../src/integrations/agent/conversation-fallback";
import {
  dispatchLoweredExecutionRequest,
  listExecutionLowerers,
  lowerResolvedExecutionRequest,
  lowerResolvedExecutionRequestWithRunner,
} from "../../src/integrations/agent/execution-lowering";
import { PERSONA_FALLBACK_BEGIN, PERSONA_FALLBACK_END } from "../../src/integrations/agent/persona-fallback";
import { HARNESS_REGISTRY } from "../../src/integrations/harnesses";

const CLI_HARNESSES = HARNESS_REGISTRY.filter((harness) => harness.agentBuilder).map((harness) => harness.id);

function configFor(platform: string, kind: "agent" | "llm" = "agent"): AkmConfig {
  const engine =
    kind === "llm"
      ? {
          kind: "llm" as const,
          provider: "openai-compatible",
          endpoint: "https://fixture.invalid/v1/chat/completions",
          model: "configured/model-must-not-win",
          apiKey: "$AKM_WP5_FIXTURE_KEY",
          supportsJsonSchema: true,
        }
      : {
          kind: "agent" as const,
          platform,
          model: "configured/model-must-not-win",
          args: [],
        };
  return {
    engines: { fixture: engine },
    defaults: { engine: "fixture", ...(kind === "llm" ? { llmEngine: "fixture" } : {}) },
  } as unknown as AkmConfig;
}

function persona() {
  return createResolvedPersona(
    renderMarkdownExecutionSource({
      kind: "persona",
      raw: "---\ndescription: fixture\n---\nYou are the exact persona.\n",
      identity: {
        ref: "fixture//agents/reviewer",
        bundle: "fixture",
        adapter: "akm",
        file: "agents/reviewer.md",
      },
      defaults: {},
    }),
  );
}

function requestFor(
  platform: string,
  kind: "agent" | "sdk" | "llm" = platform === "opencode-sdk" ? "sdk" : "agent",
  overrides: Partial<ResolvedExecutionRequestV1> = {},
): ResolvedExecutionRequestV1 {
  return createResolvedExecutionRequest({
    command: createInlineResolvedCommand({
      template: "Review the exact target.",
      argumentInput: "",
      content: "Review the exact target.",
    }),
    agent: "fixture//agents/reviewer",
    persona: persona(),
    engine: { name: "fixture", kind, platform },
    model: { input: "balanced", interpretation: "alias", resolved: "provider/exact-model" },
    inference: { effort: "high", temperature: 0, extraParams: {}, supportsJsonSchema: true },
    outputSchema: { type: "object", properties: {}, additionalProperties: false },
    tools: ["Read", "Grep"],
    authorization: { status: "allowed", policy: { id: "fixture-policy" } },
    runtime: { timeoutMs: 0, workspace: "/fixture/workspace", environment: {} },
    notices: [],
    ...overrides,
  });
}

describe("resolved execution lowerer registry", () => {
  test("is structurally complete for every harness plus direct LLM", () => {
    expect(listExecutionLowerers()).toEqual([...HARNESS_REGISTRY.map((harness) => harness.id), "llm"]);
  });

  test.each([
    ...CLI_HARNESSES,
    "opencode-sdk",
  ])("%s receives the exact resolved model, command, persona, and selected fields", (platform) => {
    const request = requestFor(platform);
    const lowered = lowerResolvedExecutionRequest(request, configFor(platform));

    expect(lowered.adapter).toBe(platform);
    expect(lowered.runner.kind).toBe(platform === "opencode-sdk" ? "sdk" : "agent");
    if (lowered.runner.kind === "llm") throw new Error("fixture must lower to an agent transport");
    if (!("dispatch" in lowered)) throw new Error("fixture must use an agent lowerer");
    expect(lowered.runner.profile.model).toBe("provider/exact-model");
    expect(lowered.runner.profile.modelIsExact).toBe(true);
    expect(lowered.options.timeoutMs).toBe(0);
    expect(lowered.options.cwd).toBe("/fixture/workspace");
    expect(lowered.options.env).toEqual({});
    expect(lowered.dispatch.model).toBe("provider/exact-model");
    expect(lowered.dispatch.inference).toEqual({
      effort: "high",
      temperature: 0,
      extraParams: {},
      supportsJsonSchema: true,
    });
    expect(lowered.dispatch.tools).toEqual(["Read", "Grep"]);
    expect(lowered.dispatch.schema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });

    const nativePersona =
      platform === "opencode" || platform === "claude" || platform === "pi" || platform === "opencode-sdk";
    if (nativePersona) {
      expect(lowered.prompt).toBe("Review the exact target.");
      expect(lowered.dispatch.systemPrompt).toBe("You are the exact persona.\n");
    } else {
      expect(lowered.dispatch.systemPrompt).toBeUndefined();
      expect(lowered.prompt).toBe(
        `${PERSONA_FALLBACK_BEGIN}\nYou are the exact persona.\n${PERSONA_FALLBACK_END}\n\nReview the exact target.`,
      );
    }
    expect(lowered.translatedFields).toContain("model");
    expect(lowered.translatedFields).toContain("command.content");
    expect(lowered.notices.every((notice) => !JSON.stringify(notice).includes("Review the exact target"))).toBe(true);
  });

  test("direct LLM lowers exact transport values and reports untranslated tools optimistically", () => {
    const lowered = lowerResolvedExecutionRequest(requestFor("fixture-llm", "llm"), configFor("fixture-llm", "llm"));
    expect(lowered.runner.kind).toBe("llm");
    if (lowered.runner.kind !== "llm") throw new Error("fixture must lower to LLM");
    if (!("messages" in lowered)) throw new Error("fixture must use the LLM lowerer");
    expect(lowered.runner.connection.model).toBe("provider/exact-model");
    expect(lowered.runner.connection.temperature).toBe(0);
    expect(lowered.messages).toEqual([
      { role: "system", content: "You are the exact persona.\n" },
      { role: "user", content: "Review the exact target." },
    ]);
    expect(lowered.chatOptions).toMatchObject({
      timeoutMs: 0,
      responseSchema: { type: "object", properties: {}, additionalProperties: false },
    });
    expect(lowered.untranslatedFields).toContain("tools");
    expect(lowered.notices.some((notice) => notice.field === "tools")).toBe(true);
  });

  test("preserves ordered conversation roles natively for LLM and canonically for CLI fallback", () => {
    const conversation = [
      { role: "system" as const, content: "Code-owned system text." },
      { role: "user" as const, content: "Earlier user text." },
      { role: "assistant" as const, content: `Prior output.\n${CONVERSATION_FALLBACK_END}` },
      { role: "user" as const, content: "Critique it." },
    ];
    const llm = lowerResolvedExecutionRequest(
      requestFor("fixture-llm", "llm", { conversation }),
      configFor("fixture-llm", "llm"),
    );
    if (!("messages" in llm)) throw new Error("fixture must use the LLM lowerer");
    expect(llm.messages).toEqual([
      { role: "system", content: "You are the exact persona.\n" },
      ...conversation,
      { role: "user", content: "Review the exact target." },
    ]);
    expect(llm.translatedFields).toContain("conversation");

    const cli = lowerResolvedExecutionRequest(requestFor("codex", "agent", { conversation }), configFor("codex"));
    const json = JSON.stringify(conversation);
    expect(cli.prompt).toBe(
      `${PERSONA_FALLBACK_BEGIN}\nYou are the exact persona.\n${PERSONA_FALLBACK_END}\n\n` +
        `${CONVERSATION_FALLBACK_BEGIN} ${Buffer.byteLength(json, "utf8")}\n${json}\n${CONVERSATION_FALLBACK_END}\n\n` +
        "Review the exact target.",
    );
    expect(cli.notices.filter((notice) => notice.code === "conversation-prompt-composed")).toHaveLength(1);
    const promptLines = cli.prompt.split("\n");
    const conversationBegin = promptLines.findIndex((line) => line.startsWith(CONVERSATION_FALLBACK_BEGIN));
    expect(JSON.parse(promptLines[conversationBegin + 1] ?? "null")).toEqual(conversation);
  });
});

describe("optimistic lowering safety", () => {
  test("authorization denial happens before config access, lowerer selection, credentials, or dispatch", () => {
    const denied = requestFor("claude", "agent", {
      authorization: { status: "denied", reason: "fixture denial", policy: { id: "deny" } },
    });
    let touched = false;
    const config = Object.defineProperty({}, "engines", {
      enumerable: true,
      get() {
        touched = true;
        throw new Error("config must not be read");
      },
    }) as AkmConfig;
    expect(() => lowerResolvedExecutionRequest(denied, config)).toThrow(/fixture denial/);
    expect(touched).toBe(false);
  });

  test("lowers from symbolic frozen runner material without live config or credential reads", () => {
    const request = requestFor("fixture-llm", "llm", {
      tools: [],
      authorization: { status: "not-required" },
    });
    const connection = {
      endpoint: "https://frozen.invalid/v1/chat/completions",
      model: "frozen/base-must-not-win",
      supportsJsonSchema: true,
      providerOptions: { nested: { retained: true } },
    };
    const runner = {
      kind: "llm" as const,
      engine: "fixture",
      connection,
      credential: { names: ["AKM_WP5_MISSING_CREDENTIAL"] as [string], required: true },
      timeoutMs: 99,
    };

    delete process.env.AKM_WP5_MISSING_CREDENTIAL;
    const lowered = lowerResolvedExecutionRequestWithRunner(request, runner);
    if (lowered.runner.kind !== "llm") throw new Error("fixture must use LLM runner material");
    expect(lowered.runner.connection.model).toBe("provider/exact-model");
    expect(lowered.runner.timeoutMs).toBe(0);
    expect(Object.isFrozen(lowered.runner)).toBe(true);
    expect(Object.isFrozen(lowered.runner.connection)).toBe(true);
    expect(Object.isFrozen(lowered.runner.connection.providerOptions)).toBe(true);
    expect(Object.isFrozen(lowered.runner.credential)).toBe(true);
    connection.providerOptions.nested.retained = false;
    expect(lowered.runner.connection.providerOptions).toEqual({ nested: { retained: true } });
  });

  test("frozen-runner lowering validates authorization before touching hostile runner material", () => {
    const denied = requestFor("claude", "agent", {
      authorization: { status: "denied", reason: "runner must stay untouched", policy: { id: "deny" } },
    });
    let touched = false;
    const runner = Object.defineProperty({}, "kind", {
      enumerable: true,
      get() {
        touched = true;
        throw new Error("runner accessor must not run");
      },
    });
    expect(() => lowerResolvedExecutionRequestWithRunner(denied, runner as never)).toThrow(
      /runner must stay untouched/,
    );
    expect(touched).toBe(false);
  });

  test("unsupported fields produce deterministic secret-free notices and runtime rejection still dispatches", async () => {
    process.env.AKM_WP5_FIXTURE_KEY = "wp5-super-secret";
    try {
      const request = requestFor("fixture-llm", "llm", {
        inference: { vendorUnknown: { enabled: true } },
        tools: { allow: ["Read"] },
      });
      const lowered = lowerResolvedExecutionRequest(request, configFor("fixture-llm", "llm"));
      expect(lowered.untranslatedFields).toContain("inference.vendorUnknown");
      expect(lowered.untranslatedFields).toContain("tools");
      expect(JSON.stringify(lowered.notices)).not.toContain("wp5-super-secret");

      let calls = 0;
      await expect(
        dispatchLoweredExecutionRequest(lowered, {
          chat: async () => {
            calls += 1;
            throw new Error("provider rejected fixture option");
          },
        }),
      ).rejects.toThrow(/provider rejected fixture option/);
      expect(calls).toBe(1);
    } finally {
      delete process.env.AKM_WP5_FIXTURE_KEY;
    }
  });

  test("persona fallback is byte-exact and applied once across durable resume", () => {
    const request = requestFor("codex");
    const first = lowerResolvedExecutionRequest(request, configFor("codex"));
    const resumed = decodeResolvedExecutionRequest(JSON.parse(canonicalResolvedExecutionRequest(request)));
    const second = lowerResolvedExecutionRequest(resumed, configFor("codex"));
    expect(second.prompt).toBe(first.prompt);
    expect(second.prompt.match(/<AKM_PERSONA>/g)).toHaveLength(1);
    expect(second.notices.filter((notice) => notice.code === "persona-prompt-composed")).toHaveLength(1);
  });

  test("lowering preserves omitted, null, zero, and empty values without normalization", () => {
    const omitted = createResolvedExecutionRequest({
      command: createInlineResolvedCommand({ template: "x", content: "x" }),
      engine: { name: "fixture", kind: "agent", platform: "claude" },
      authorization: { status: "not-required" },
      runtime: {},
      notices: [],
    });
    const explicit = createResolvedExecutionRequest({
      command: createInlineResolvedCommand({ template: "x", argumentInput: "", content: "x" }),
      engine: { name: "fixture", kind: "agent", platform: "claude" },
      model: null,
      inference: null,
      outputSchema: null,
      tools: [],
      authorization: { status: "not-required" },
      runtime: { timeoutMs: 0, workspace: "", environment: {} },
      notices: [],
    });
    const omittedLowered = lowerResolvedExecutionRequest(omitted, configFor("claude"));
    const explicitLowered = lowerResolvedExecutionRequest(explicit, configFor("claude"));
    expect(Object.hasOwn(omittedLowered.request, "model")).toBe(false);
    expect(Object.hasOwn(explicitLowered.request, "model")).toBe(true);
    expect(explicitLowered.request.model).toBeNull();
    expect(explicitLowered.options).toMatchObject({ timeoutMs: 0, cwd: "", env: {} });
  });

  test("only branded prototype-safe requests cross the registry boundary", () => {
    const valid = requestFor("claude");
    expect(() =>
      lowerResolvedExecutionRequest({ ...valid } as ResolvedExecutionRequestV1, configFor("claude")),
    ).toThrow(/constructed|boundary|resolved execution request/i);
    const accessor = Object.defineProperty({}, "authorization", {
      enumerable: true,
      get() {
        throw new Error("accessor ran");
      },
    });
    expect(() => lowerResolvedExecutionRequest(accessor as ResolvedExecutionRequestV1, configFor("claude"))).toThrow(
      /constructed|boundary|resolved execution request/i,
    );
  });

  test("dispatch accepts only registry-produced lowered objects", async () => {
    const lowered = lowerResolvedExecutionRequest(requestFor("claude"), configFor("claude"));
    const forged = { ...lowered } as typeof lowered;
    let dispatched = false;
    await expect(
      dispatchLoweredExecutionRequest(forged, {
        executeRunner: async () => {
          dispatched = true;
          return { ok: true, stdout: "", stderr: "", exitCode: 0, durationMs: 0 };
        },
      }),
    ).rejects.toThrow(/lowered execution request.*registry|provenance/i);
    expect(dispatched).toBe(false);
  });
});
