// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Process-isolated capture of the real `akmAgentDispatch` → `executeRunner`
 * boundary. Module replacement is process-global, so the characterization
 * suite invokes this helper in a short-lived Bun child instead of polluting an
 * integration shard that also exercises the real runner module.
 */

import { mock } from "bun:test";
import type { RunnerSpec } from "../../src/integrations/agent/runner";
import type { RunAgentOptions } from "../../src/integrations/agent/spawn";

interface Capture {
  runner?: RunnerSpec;
  prompt?: string;
  options?: RunAgentOptions;
}

const capture: Capture = {};

mock.module("../../src/integrations/agent/runner-dispatch", () => ({
  executeRunner: async (runner: RunnerSpec, prompt: string, options: RunAgentOptions) => {
    capture.runner = runner;
    capture.prompt = prompt;
    capture.options = options;
    return {
      ok: true,
      exitCode: 0,
      stdout: "captured-direct",
      stderr: "",
      durationMs: 1,
    };
  },
}));

const [{ akmAgentDispatch }, { loadConfig }] = await Promise.all([
  import("../../src/commands/agent/agent-dispatch"),
  import("../../src/core/config/config"),
]);
const raw = process.argv[2];
if (!raw) throw new Error("capture-agent-dispatch requires one JSON options argument");
const result = await akmAgentDispatch({
  ...(JSON.parse(raw) as Record<string, unknown>),
  agentConfig: loadConfig(),
});
if (!capture.runner || capture.prompt === undefined || !capture.options) {
  throw new Error("akmAgentDispatch did not reach executeRunner");
}
process.stdout.write(JSON.stringify({ ...capture, result }));
