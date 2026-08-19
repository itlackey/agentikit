// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Process-isolated capture for the OpenCode SDK lowering characterization.
 *
 * The SDK runner's injected server is deliberately process-global. Running
 * this capture in the unit-test shard would race the runner's own tests, so
 * the contract suite invokes this helper in a short-lived Bun child.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { AgentDispatchRequest } from "../../src/integrations/agent/builder-shared";
import type { AgentProfile } from "../../src/integrations/agent/profiles";
import {
  __setTestServer,
  buildSdkConfig,
  closeServer,
  runOpencodeSdk,
} from "../../src/integrations/harnesses/opencode-sdk/sdk-runner";

interface CharacterizationRequest {
  prompt: string;
  systemPrompt: string;
  model: string;
  tools: string[];
}

const fixtureRoot = path.resolve(import.meta.dir, "../fixtures/execution-contracts/lowering");
const request = JSON.parse(readFileSync(path.join(fixtureRoot, "request.json"), "utf8")) as CharacterizationRequest;
const dispatch: AgentDispatchRequest = {
  prompt: request.prompt,
  systemPrompt: request.systemPrompt,
  model: request.model,
  modelIsExact: true,
  tools: request.tools,
};
const profile: AgentProfile = {
  name: "fixture-opencode-sdk",
  platform: "opencode-sdk",
  bin: "opencode",
  args: [],
  stdio: "captured",
  envPassthrough: [],
  parseOutput: "text",
  model: request.model,
  modelIsExact: true,
};
const fallback = {
  provider: "openai-compatible",
  endpoint: "https://fixture.invalid/v1/chat/completions",
  model: "configured/base-model",
};
const capture: Record<string, unknown> = {};
const server = {
  client: {
    session: {
      create: async (args: unknown) => {
        capture.create = args;
        return { data: { id: "fixture-session" } };
      },
      prompt: async (args: unknown) => {
        capture.prompt = args;
        return { data: { parts: [{ type: "text", text: "fixture-response" }] } };
      },
      delete: async (args: unknown) => {
        capture.delete = args;
        return {};
      },
    },
  },
  server: { close() {} },
};

__setTestServer(server as never);
try {
  const result = await runOpencodeSdk(
    profile,
    request.prompt,
    { cwd: "/fixture/workspace", dispatch, timeoutMs: null },
    fallback,
  );
  process.stdout.write(
    JSON.stringify({
      config: buildSdkConfig(profile, fallback),
      request: capture,
      result: {
        ok: result.ok,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        sessionId: result.sessionId,
      },
    }),
  );
} finally {
  await closeServer();
}
