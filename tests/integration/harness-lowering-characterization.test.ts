// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WP0 (#803) characterization of the 0.9.1 harness-lowering seams.
 *
 * These assertions are deliberately NON-NORMATIVE. They make the current
 * registry-complete behavior observable while WP2/WP5 evolve model resolution
 * and execution lowering; they do not declare the captured argv/SDK/LLM shapes
 * to be the 0.9.2 contract.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { AgentDispatchRequest } from "../../src/integrations/agent/builder-shared";
import { type ResolvedLlmUse, resolveLlmEngineUse } from "../../src/integrations/agent/engine-resolution";
import { getBuiltinAgentProfile } from "../../src/integrations/agent/profiles";
import { HARNESS_REGISTRY } from "../../src/integrations/harnesses";

const fixtureRoot = path.resolve(import.meta.dir, "../fixtures/execution-contracts/lowering");

interface CharacterizationRequest {
  schemaVersion: number;
  prompt: string;
  systemPrompt: string;
  model: string;
  tools: string[];
}

interface ExpectedCharacterization {
  schemaVersion: number;
  status: string;
  registeredHarnessIds: string[];
  cli: Record<
    string,
    {
      argv: readonly string[];
      env: Readonly<Record<string, string>> | null;
      stdin: string | null;
    }
  >;
  opencodeSdk: {
    config: Record<string, unknown>;
    request: Record<string, unknown>;
    result: {
      ok: boolean;
      exitCode: number | null;
      stdout: string;
      stderr: string;
      sessionId: string | undefined;
    };
  };
  directLlm: ResolvedLlmUse;
}

const request = JSON.parse(readFileSync(path.join(fixtureRoot, "request.json"), "utf8")) as CharacterizationRequest;
const expected = JSON.parse(readFileSync(path.join(fixtureRoot, "current.json"), "utf8")) as ExpectedCharacterization;

const dispatch: AgentDispatchRequest = {
  prompt: request.prompt,
  systemPrompt: request.systemPrompt,
  model: request.model,
  modelIsExact: true,
  tools: request.tools,
};

const fallbackLlm = {
  provider: "openai-compatible",
  endpoint: "https://fixture.invalid/v1/chat/completions",
  model: "configured/base-model",
};

describe("current harness lowering (non-normative characterization)", () => {
  test("the fixture covers every registered dispatch harness exactly once", () => {
    const registered = HARNESS_REGISTRY.map((harness) => harness.id as string);
    expect(expected.schemaVersion).toBe(1);
    expect(expected.status).toBe("non-normative-current-observation");
    expect(expected.registeredHarnessIds).toEqual(registered);
    expect(Object.keys(expected.cli)).toEqual(
      HARNESS_REGISTRY.filter((harness) => harness.agentBuilder).map((harness) => harness.id),
    );
    expect(registered.filter((id) => !(id in expected.cli))).toEqual(["opencode-sdk"]);
  });

  test("pins argv/env/stdin for all nine current CLI builders", () => {
    const actual: ExpectedCharacterization["cli"] = {};
    for (const harness of HARNESS_REGISTRY) {
      if (!harness.agentBuilder) continue;
      const profile = getBuiltinAgentProfile(harness.id);
      if (!profile) throw new Error(`No built-in profile for harness ${harness.id}`);
      const built = harness.agentBuilder.build(profile, dispatch);
      actual[harness.id] = {
        argv: built.argv,
        env: built.env ?? null,
        stdin: built.stdin ?? null,
      };
    }

    expect(actual).toEqual(expected.cli);
  });

  test("pins the current direct-LLM resolver lowering separately from harnesses", () => {
    const actual = resolveLlmEngineUse(
      {
        engines: {
          "fixture-llm": {
            kind: "llm",
            ...fallbackLlm,
            temperature: 0.25,
            maxTokens: 4096,
            timeoutMs: 12_345,
            supportsJsonSchema: true,
            extraParams: { beta: "two", alpha: 1 },
            contextLength: 8192,
            enableThinking: false,
          },
        },
        defaults: { llmEngine: "fixture-llm" },
      },
      [{ model: request.model }],
    );

    expect(actual).toEqual(expected.directLlm);
  });
});
