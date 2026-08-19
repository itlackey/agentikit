// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { ConfigError } from "../../src/core/errors";
import { _setWarnSinkForTests } from "../../src/core/warn";
import { _setChatCompletionForTests, type ChatCompletionConfig, type ChatMessage } from "../../src/llm/client";
import { frozenSummaryJudge } from "../../src/workflows/exec/frozen-judge";
import type { UnitDispatchRequest } from "../../src/workflows/exec/native-executor";
import type { WorkflowPlanGraph } from "../../src/workflows/ir/schema";
import { overrideSeam } from "../_helpers/seams";

const OWNER = { runId: "11111111-1111-4111-8111-111111111111", stepId: "review" };

function agentPlan(overrides?: Partial<{ envPassthrough: string[] }>): WorkflowPlanGraph {
  return {
    irVersion: 3,
    title: "judge",
    execution: {
      maxConcurrency: 1,
      engines: {
        reviewer: {
          name: "reviewer",
          kind: "agent",
          runnerKind: "agent",
          platform: "codex",
          bin: "codex",
          args: [],
          workspace: null,
          envPassthrough: overrides?.envPassthrough ?? [],
          commandBuilder: "codex",
          fallbackLlmEngine: null,
        },
      },
    },
    steps: [],
  } satisfies WorkflowPlanGraph;
}

function llmPlan(credentialNames: [string, ...string[]]): WorkflowPlanGraph {
  return {
    irVersion: 3,
    title: "judge",
    execution: {
      maxConcurrency: 1,
      engines: {
        grader: {
          name: "grader",
          kind: "llm",
          endpoint: "http://localhost:1/v1/chat/completions",
          model: "test-model",
          concurrency: 1,
          credential: { names: credentialNames, required: false },
        },
      },
    },
    steps: [],
  } satisfies WorkflowPlanGraph;
}

/** Swap the llm transport for the duration of `fn`, then restore it. */
async function withChatCompletion(
  fake: (config: ChatCompletionConfig, messages: ChatMessage[]) => Promise<string>,
  fn: () => Promise<void>,
): Promise<void> {
  _setChatCompletionForTests(async (config, messages) => fake(config, messages));
  try {
    await fn();
  } finally {
    _setChatCompletionForTests(undefined);
  }
}

/** Set an env var for the duration of `fn`, restoring whatever was there. */
async function withEnv(name: string, value: string, fn: () => Promise<void>): Promise<void> {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

describe("frozen workflow judge", () => {
  test("emits each safe lowering notice once without changing the verdict", async () => {
    const secretPrompt = "judge user containing sk-never-log-this";
    const verdict = '{"complete":true,"missing":[]}';
    const warned: string[] = [];
    overrideSeam(_setWarnSinkForTests, (level, args) => {
      if (level === "warn") warned.push(args.map(String).join(" "));
    });
    const untrustedNotice = {
      code: "conversation-prompt-composed" as const,
      severity: "warning" as const,
      adapter: "codex",
      field: "conversation",
      message: `provider body echoed ${secretPrompt}`,
    };
    const judge = frozenSummaryJudge(
      agentPlan(),
      { engine: "reviewer", model: null, timeoutMs: null },
      undefined,
      async () => ({ ok: true, text: verdict, notices: [untrustedNotice] }),
      OWNER,
    );

    expect(await judge?.({ system: "judge system", user: secretPrompt })).toBe(verdict);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("conversation-prompt-composed");
    expect(warned[0]).not.toContain(secretPrompt);
    expect(warned[0]).not.toContain("sk-never-log-this");
  });

  test("dispatches an agent judge from its frozen snapshot with separated prompts", async () => {
    const invocation = { engine: "reviewer", model: "exact-model", timeoutMs: 1234 };
    let request: UnitDispatchRequest | undefined;
    const judge = frozenSummaryJudge(
      agentPlan(),
      invocation,
      undefined,
      async (input) => {
        request = input;
        return { ok: true, text: '{"complete":true,"missing":[]}' };
      },
      OWNER,
    );

    expect(await judge?.({ system: "judge system", user: "judge user" })).toContain('"complete":true');
    expect(request).toMatchObject({
      prompt: "judge user",
      systemPrompt: "judge system",
      invocation,
      timeoutMs: 1234,
      engine: { kind: "agent", platform: "codex" },
    });
  });

  test("the dispatch carries the REAL run/step identity, never a synthetic 'gate'", async () => {
    let request: UnitDispatchRequest | undefined;
    const judge = frozenSummaryJudge(
      agentPlan(),
      { engine: "reviewer", model: null, timeoutMs: null },
      undefined,
      async (input) => {
        request = input;
        return { ok: true, text: '{"complete":true,"missing":[]}' };
      },
      OWNER,
    );

    // Journaling caller supplies the exact gate-row identity for this loop.
    await judge?.({ system: "s", user: "u" }, { runId: OWNER.runId, stepId: "review", unitId: "review.gate:l3" });
    expect(request).toMatchObject({
      runId: OWNER.runId,
      stepId: "review",
      nodeId: "review.gate",
      unitId: "review.gate:l3",
    });
  });

  test("without a per-call identity the dispatch still names the owning run/step", async () => {
    let request: UnitDispatchRequest | undefined;
    const judge = frozenSummaryJudge(
      agentPlan(),
      { engine: "reviewer", model: null, timeoutMs: null },
      undefined,
      async (input) => {
        request = input;
        return { ok: true, text: '{"complete":true,"missing":[]}' };
      },
      OWNER,
    );

    await judge?.({ system: "s", user: "u" });
    expect(request).toMatchObject({
      runId: OWNER.runId,
      stepId: "review",
      nodeId: "review.gate",
      unitId: "review.gate",
    });
    // The pre-fix synthetic identity is gone entirely.
    expect(request?.runId).not.toBe("gate");
  });

  test("a judge echoing a passthrough secret is redacted before it can be journaled", async () => {
    const name = "WORKFLOW_JUDGE_TEST_TOKEN";
    const secret = "s3cr3t-judge-token-value";
    const previous = process.env[name];
    process.env[name] = secret;
    try {
      let request: UnitDispatchRequest | undefined;
      const judge = frozenSummaryJudge(
        agentPlan({ envPassthrough: [name] }),
        { engine: "reviewer", model: null, timeoutMs: null },
        undefined,
        async (input) => {
          request = input;
          return { ok: true, text: `{"complete":false,"missing":["x"],"feedback":"saw ${secret} in the artifact"}` };
        },
        OWNER,
      );

      const raw = await judge?.({ system: "s", user: "u" });
      expect(raw).not.toContain(secret);
      expect(raw).toContain("[REDACTED]");
      // The dispatch itself declares the value, so the runner-side scrub sees it too.
      expect(request?.sensitiveValues).toContain(secret);
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });

  test("a failed dispatch's error is redacted and still surfaced to the fail-closed validator", async () => {
    const name = "WORKFLOW_JUDGE_TEST_TOKEN";
    const secret = "s3cr3t-judge-token-value";
    const previous = process.env[name];
    process.env[name] = secret;
    try {
      const judge = frozenSummaryJudge(
        agentPlan({ envPassthrough: [name] }),
        { engine: "reviewer", model: null, timeoutMs: null },
        undefined,
        async () => ({ ok: false, text: "", error: `auth failed for ${secret}` }),
        OWNER,
      );
      await expect(judge?.({ system: "system", user: "user" })).rejects.toThrow(/auth failed for \[REDACTED\]/);
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });

  test("surfaces a failed agent dispatch to the fail-closed validator", async () => {
    const invocation = { engine: "reviewer", model: null, timeoutMs: null };
    const plan = {
      irVersion: 3,
      title: "judge",
      execution: {
        maxConcurrency: 1,
        engines: {
          reviewer: {
            name: "reviewer",
            kind: "agent",
            runnerKind: "sdk",
            platform: "opencode-sdk",
            bin: "opencode",
            args: [],
            workspace: null,
            envPassthrough: [],
            commandBuilder: "opencode-sdk",
            fallbackLlmEngine: null,
          },
        },
      },
      steps: [],
    } satisfies WorkflowPlanGraph;
    const judge = frozenSummaryJudge(
      plan,
      invocation,
      undefined,
      async () => ({
        ok: false,
        text: "",
        error: "agent unavailable",
      }),
      OWNER,
    );

    await expect(judge?.({ system: "system", user: "user" })).rejects.toThrow("agent unavailable");
  });

  test("the judge dispatch declares NO env bindings (gate judges have no env surface)", async () => {
    let request: UnitDispatchRequest | undefined;
    const judge = frozenSummaryJudge(
      agentPlan(),
      { engine: "reviewer", model: null, timeoutMs: null },
      undefined,
      async (input) => {
        request = input;
        return { ok: true, text: '{"complete":true,"missing":[]}' };
      },
      OWNER,
    );
    await judge?.({ system: "s", user: "u" });
    expect(request?.env).toBeUndefined();
  });

  test("a THROWN agent dispatch is redacted too, not just a returned failure", async () => {
    const name = "WORKFLOW_JUDGE_TEST_TOKEN";
    const secret = "s3cr3t-judge-token-value";
    await withEnv(name, secret, async () => {
      const judge = frozenSummaryJudge(
        agentPlan({ envPassthrough: [name] }),
        { engine: "reviewer", model: null, timeoutMs: null },
        undefined,
        async () => {
          throw new Error(`spawn failed with ${secret}`);
        },
        OWNER,
      );
      await expect(judge?.({ system: "system", user: "user" })).rejects.toThrow(/spawn failed with \[REDACTED\]/);
    });
  });
});

describe("frozen judge sensitive values are collected at DISPATCH time, not at build time", () => {
  test("an agent judge scrubs a passthrough secret exported AFTER the judge was built", async () => {
    const name = "WORKFLOW_JUDGE_LATE_TOKEN";
    const secret = "s3cr3t-exported-after-the-judge-existed";
    let request: UnitDispatchRequest | undefined;
    // Built while the name is UNSET, so a build-time snapshot would be empty.
    const judge = frozenSummaryJudge(
      agentPlan({ envPassthrough: [name] }),
      { engine: "reviewer", model: null, timeoutMs: null },
      undefined,
      async (input) => {
        request = input;
        return { ok: true, text: `{"complete":true,"missing":[],"feedback":"the child used ${secret}"}` };
      },
      OWNER,
    );

    await withEnv(name, secret, async () => {
      const raw = await judge?.({ system: "s", user: "u" });
      expect(raw).not.toContain(secret);
      expect(raw).toContain("[REDACTED]");
      expect(request?.sensitiveValues).toContain(secret);
    });
  });

  test("an llm judge scrubs a credential exported AFTER the judge was built", async () => {
    const name = "WORKFLOW_JUDGE_LATE_LLM_KEY";
    const secret = "sk-live-rotated-after-the-judge-existed";
    const judge = frozenSummaryJudge(
      llmPlan([name]),
      { engine: "grader", model: null, timeoutMs: null },
      undefined,
      undefined,
      OWNER,
    );

    await withEnv(name, secret, async () => {
      let usedKey: string | undefined;
      await withChatCompletion(
        async (config) => {
          usedKey = config.apiKey;
          return `{"complete":true,"missing":[],"feedback":"authenticated with ${secret}"}`;
        },
        async () => {
          const raw = await judge?.({ system: "s", user: "u" });
          // The call really did authenticate with the late credential…
          expect(usedKey).toBe(secret);
          // …so the value it can echo is exactly the value that gets scrubbed.
          expect(raw).not.toContain(secret);
          expect(raw).toContain("[REDACTED]");
        },
      );
    });
  });
});

describe("frozen llm judge redaction states the same contract as the agent branch", () => {
  const invocation = { engine: "grader", model: null, timeoutMs: null };

  test("a transport error is redacted before it can become the blocked step's notes", async () => {
    const name = "WORKFLOW_JUDGE_LLM_KEY";
    const secret = "sk-live-transport-error-must-not-leak";
    const judge = frozenSummaryJudge(llmPlan([name]), invocation, undefined, undefined, OWNER);
    await withEnv(name, secret, async () => {
      await withChatCompletion(
        async () => {
          throw new Error(`connect ECONNREFUSED using ${secret}`);
        },
        async () => {
          await expect(judge?.({ system: "s", user: "u" })).rejects.toThrow(/connect ECONNREFUSED using \[REDACTED\]/);
        },
      );
    });
  });

  test("a non-secret transport error uses the uniform failed-result envelope without altering its message", async () => {
    const name = "WORKFLOW_JUDGE_LLM_KEY";
    const judge = frozenSummaryJudge(llmPlan([name]), invocation, undefined, undefined, OWNER);
    const thrown = new ConfigError("engine 'grader' is unavailable", "INVALID_CONFIG_FILE");
    await withEnv(name, "sk-live-unrelated-to-the-error", async () => {
      await withChatCompletion(
        async () => {
          throw thrown;
        },
        async () => {
          const caught = await judge?.({ system: "s", user: "u" }).then(
            () => undefined,
            (err: unknown) => err,
          );
          expect(caught).toBeInstanceOf(Error);
          expect(caught).not.toBe(thrown);
          expect((caught as Error).message).toBe(thrown.message);
        },
      );
    });
  });

  test("the prompts stay separated and the invocation's exact model is dispatched", async () => {
    const judge = frozenSummaryJudge(
      llmPlan(["WORKFLOW_JUDGE_UNSET_LLM_KEY"]),
      { engine: "grader", model: "exact-model", timeoutMs: 4321 },
      undefined,
      undefined,
      OWNER,
    );
    let messages: ChatMessage[] | undefined;
    let model: string | undefined;
    await withChatCompletion(
      async (config, sent) => {
        messages = sent;
        model = config.model;
        return '{"complete":true,"missing":[]}';
      },
      async () => {
        expect(await judge?.({ system: "judge system", user: "judge user" })).toContain('"complete":true');
        expect(messages).toEqual([
          { role: "system", content: "judge system" },
          { role: "user", content: "judge user" },
        ]);
        expect(model).toBe("exact-model");
      },
    );
  });
});
