// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { frozenSummaryJudge } from "../../src/workflows/exec/frozen-judge";
import type { UnitDispatchRequest } from "../../src/workflows/exec/native-executor";
import type { WorkflowPlanGraph } from "../../src/workflows/ir/schema";

describe("frozen workflow judge", () => {
  test("dispatches an agent judge from its frozen snapshot with separated prompts", async () => {
    const invocation = { engine: "reviewer", model: "exact-model", timeoutMs: 1234 };
    const plan = {
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
            envPassthrough: [],
            commandBuilder: "codex",
            fallbackLlmEngine: null,
          },
        },
      },
      steps: [],
    } satisfies WorkflowPlanGraph;
    let request: UnitDispatchRequest | undefined;
    const judge = frozenSummaryJudge(plan, invocation, undefined, async (input) => {
      request = input;
      return { ok: true, text: '{"complete":true,"missing":[]}' };
    });

    expect(await judge?.({ system: "judge system", user: "judge user" })).toContain('"complete":true');
    expect(request).toMatchObject({
      prompt: "judge user",
      systemPrompt: "judge system",
      invocation,
      timeoutMs: 1234,
      engine: { kind: "agent", platform: "codex" },
    });
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
    const judge = frozenSummaryJudge(plan, invocation, undefined, async () => ({
      ok: false,
      text: "",
      error: "agent unavailable",
    }));

    await expect(judge?.({ system: "system", user: "user" })).rejects.toThrow("agent unavailable");
  });
});
