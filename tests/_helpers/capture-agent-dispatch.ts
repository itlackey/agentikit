// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Process-isolated capture of the real `akmAgentDispatch` → `executeRunner`
 * boundary. The command exposes a narrow dependency seam for the prompt-free
 * interactive exemption, so this helper never partially replaces the runtime
 * runner module or hides newly-added named exports.
 */

import { akmAgentDispatch } from "../../src/commands/agent/agent-dispatch";
import { executeCommandInvocation } from "../../src/commands/command/command-execution";
import { loadConfig } from "../../src/core/config/config";
import type { RunnerSpec } from "../../src/integrations/agent/runner";
import type { RunAgentOptions } from "../../src/integrations/agent/spawn";

interface Capture {
  runner?: RunnerSpec;
  prompt?: string;
  options?: RunAgentOptions;
}

const capture: Capture = {};

const executeRunner = async (runner: RunnerSpec, prompt: string, options: RunAgentOptions) => {
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
};
const raw = process.argv[2];
if (!raw) throw new Error("capture-agent-dispatch requires one JSON options argument");
const result = await akmAgentDispatch(
  {
    ...(JSON.parse(raw) as Record<string, unknown>),
    agentConfig: loadConfig(),
  },
  { executeCommand: (options) => executeCommandInvocation(options, { executeRunner }) },
);
if (!capture.runner || capture.prompt === undefined || !capture.options) {
  throw new Error("akmAgentDispatch did not reach executeRunner");
}
process.stdout.write(JSON.stringify({ ...capture, result }));
