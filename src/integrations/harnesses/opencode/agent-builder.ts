// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenCode agent command builder (migrated from `agent/builders.ts`, #564).
 *
 * Translates a platform-agnostic {@link AgentDispatchRequest} into the exact
 * argv the `opencode` CLI expects. This is the OpenCode-specific slice of the
 * builder strategy; the shared infrastructure (`AgentCommandBuilder`,
 * `getCommandBuilder`, the default builder, flag/tool helpers) stays in
 * `agent/builders.ts`, which imports this builder back into `BUILTIN_BUILDERS`.
 *
 * Behaviour-preserving relocation: the produced argv is byte-identical to the
 * pre-migration `opencodeBuilder`. The builder's `platform` stays `'opencode'`
 * (the canonical harness id).
 */

import { type AgentCommandBuilder, assertNotFlag, resolveDispatchModel } from "../../agent/builder-shared";
import { createAgentRequestLowerer } from "../../agent/request-lowering";

/**
 * OpenCode builder.
 * Command shape: opencode run [--system-prompt "..."] [--agent <name>] [--model <m>] "<prompt>"
 *
 * Tool policy is omitted — opencode manages tool access through its own agent
 * config files, not via CLI flags.
 */
export const opencodeBuilder: AgentCommandBuilder = {
  platform: "opencode",
  personaChannel: "native",
  lower: createAgentRequestLowerer({
    adapter: "opencode",
    personaChannel: "native",
    nativeAgentSelector: true,
    tools: "none",
    outputSchema: false,
  }),
  build(profile, req) {
    assertNotFlag(req.systemPrompt, "systemPrompt");
    assertNotFlag(req.model, "model");
    assertNotFlag(req.agent, "agent");
    let configuredModel: string | undefined;
    const args: string[] = req.model ? [] : [...profile.args];
    if (req.model) {
      for (let index = 0; index < profile.args.length; index += 1) {
        const arg = profile.args[index];
        if (arg === undefined) continue;
        if (arg === "--model") {
          configuredModel = profile.args[index + 1];
          index += 1;
        } else if (arg.startsWith("--model=")) {
          configuredModel = arg.slice("--model=".length);
        } else {
          args.push(arg);
        }
      }
    }
    if (req.systemPrompt) {
      args.push("--system-prompt", req.systemPrompt);
    }
    if (req.agent) {
      args.push("--agent", req.agent);
    }
    if (req.model) {
      const resolved = resolveDispatchModel(req, profile, "opencode") as string;
      const provider = configuredModel?.split("/", 1)[0];
      args.push("--model", provider && !resolved.includes("/") ? `${provider}/${resolved}` : resolved);
    }
    args.push("--");
    args.push(req.prompt);
    return { argv: [profile.bin, ...args] };
  },
};
