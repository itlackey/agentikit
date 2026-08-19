// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { getStringArg, parsePositiveIntFlag } from "../../cli/parse-args";
import { defineGroupCommand, defineJsonCommand, EXIT_CODES, output } from "../../cli/shared";
import { loadConfig } from "../../core/config/config";
import { warn } from "../../core/warn";
import type { UnresolvedExecutionDefaults } from "../../execution/source";
import { executeCommandInvocation } from "./command-execution";

function exactStringArg(args: unknown, key: string): string | undefined {
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

export const commandRunCommand = defineJsonCommand({
  meta: {
    name: "run",
    description:
      "Resolve a stored command through its bundle adapter, apply portable arguments, and execute one fresh session",
  },
  args: {
    ref: {
      type: "positional",
      description: "Command asset ref (for example commands/review or team//commands/review)",
      required: true,
    },
    arguments: {
      type: "string",
      description: "Exact string substituted for each literal $ARGUMENTS occurrence (no tokenization or trimming)",
    },
    agent: {
      type: "string",
      description: "Override the command's agent selector with a portable agent ref or native harness selector",
    },
    engine: { type: "string", description: "Override the selected execution engine" },
    model: { type: "string", description: "Override the selected model alias or exact model identifier" },
    "timeout-ms": { type: "string", description: "Override the execution timeout in milliseconds" },
    cwd: { type: "string", description: "Override the execution workspace/current working directory" },
  },
  async run({ args }) {
    const timeoutMs = parsePositiveIntFlag(exactStringArg(args, "timeout-ms"), "--timeout-ms");
    const current: Record<string, unknown> = {};
    const agent = getStringArg(args, "agent");
    const engine = getStringArg(args, "engine");
    const model = getStringArg(args, "model");
    const workspace = getStringArg(args, "cwd");
    if (agent !== undefined) current.agent = agent;
    if (engine !== undefined) current.engine = engine;
    if (model !== undefined) current.model = model;
    if (timeoutMs !== undefined) current.timeout = timeoutMs;
    if (workspace !== undefined) current.workspace = workspace;

    const argumentInput = exactStringArg(args, "arguments");
    const result = await executeCommandInvocation({
      action: {
        ref: args.ref,
        ...(argumentInput === undefined ? {} : { arguments: argumentInput }),
      },
      config: loadConfig(),
      current: current as UnresolvedExecutionDefaults,
    });
    for (const message of result.warnings ?? []) warn(message);
    output("agent-result", result);
    if (!result.ok) process.exitCode = EXIT_CODES.GENERAL;
  },
});

export const commandCommand = defineGroupCommand({
  meta: {
    name: "command",
    description: "Run reusable agent prompt templates through AKM's common execution resolver",
  },
  subCommands: { run: commandRunCommand },
});
