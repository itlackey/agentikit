// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test } from "bun:test";
import { akmPropose } from "../../src/commands/proposal/propose";
import type { AkmConfig } from "../../src/core/config/config";
import { buildProposePrompt } from "../../src/integrations/agent/prompts";
import { makeStashDir, type SandboxedDir, withEnv, withMockedFetch } from "../_helpers/sandbox";

const sandboxes: SandboxedDir[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) sandbox.cleanup();
});

function proposalStash(): string {
  const sandbox = makeStashDir();
  sandboxes.push(sandbox);
  return sandbox.dir;
}

function directConfig(stashDir: string, apiKey?: string): AkmConfig {
  return {
    configVersion: "0.9.0",
    semanticSearchMode: "auto",
    bundles: { work: { path: stashDir, writable: true } },
    defaultBundle: "work",
    defaultWriteTarget: "work",
    engines: {
      direct: {
        kind: "llm",
        endpoint: "https://proposal.invalid/v1/chat/completions",
        model: "provider/exact-proposal-092",
        temperature: 0.17,
        maxTokens: 222,
        contextLength: 16_384,
        enableThinking: false,
        extraParams: { seed: 92 },
        ...(apiKey ? { apiKey } : {}),
      },
    },
  } as AkmConfig;
}

describe("proposal consumers lower resolved execution requests", () => {
  test("proposal new sends exact live fields without changing the legacy user prompt", async () => {
    const stashDir = proposalStash();
    let requestBody: Record<string, unknown> | undefined;

    const result = await withMockedFetch(
      () =>
        akmPropose({
          type: "skill",
          name: "lowered",
          task: "AUTHORING-CONTENT-MUST-NOT-ENTER-NOTICES",
          engine: "direct",
          timeoutMs: 2_000,
          stashDir,
          agentConfig: directConfig(stashDir),
        }),
      (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  ref: "skills/lowered",
                  content: "---\ndescription: Exercises resolved proposal lowering\n---\n\nUse the shared boundary.\n",
                }),
              },
            },
          ],
        });
      },
    );

    expect(result.ok).toBe(true);
    expect(result.engine).toBe("direct");
    expect(requestBody).toMatchObject({
      model: "provider/exact-proposal-092",
      temperature: 0.17,
      max_tokens: 222,
      enable_thinking: false,
      seed: 92,
    });
    const messages = requestBody?.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(1);
    const content = String(messages[0]?.content);
    const draftFilePath = content.match(/\/tmp\/akm-propose-[^\s`"']+\.md/)?.[0];
    expect(draftFilePath).toBeDefined();
    expect(messages[0]).toEqual({
      role: "user",
      content: buildProposePrompt({
        type: "skill",
        name: "lowered",
        task: "AUTHORING-CONTENT-MUST-NOT-ENTER-NOTICES",
        draftFilePath: draftFilePath as string,
      }),
    });
    expect(requestBody).not.toHaveProperty("response_format");
    expect(requestBody).not.toHaveProperty("tools");
    const notices = (result as typeof result & { notices?: Array<Record<string, unknown>> }).notices ?? [];
    expect(JSON.stringify(notices)).not.toContain("AUTHORING-CONTENT-MUST-NOT-ENTER-NOTICES");
    expect(JSON.stringify(notices)).not.toContain("proposal.invalid");
  });

  test("proposal failure returns the centrally redacted direct-LLM envelope", async () => {
    const stashDir = proposalStash();
    const secret = "proposal-consumer-secret";
    const result = await withEnv({ PROPOSAL_TEST_KEY: secret }, () =>
      withMockedFetch(
        () =>
          akmPropose({
            type: "skill",
            name: "provider-failure",
            task: "Keep provider failures secret-free",
            engine: "direct",
            stashDir,
            agentConfig: directConfig(stashDir, "$PROPOSAL_TEST_KEY"),
          }),
        () => {
          throw new Error(`provider body echoed ${secret}`);
        },
      ),
    );

    expect(result).toMatchObject({ ok: false, reason: "spawn_failed", engine: "direct" });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.notices).toBeUndefined();
  });
});
