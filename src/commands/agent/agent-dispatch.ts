// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm agent [--engine <name>] [--prompt <text>] [--command <ref>]`
 *
 * Dispatch an agent by named engine, optionally injecting a prompt from
 * inline text or a stash command asset. Workflows execute only through the
 * workflow runtime.
 *
 * When no prompt, command, agent selector, or model is given, the
 * native agent is launched interactively with no dispatch payload.
 *
 * Every noninteractive arm uses the canonical command invocation path.
 */

import type { AkmConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { warn } from "../../core/warn";
import type { LoweringNotice } from "../../execution/resolved-request";
import { isPortableExecutionAgentSelector, type UnresolvedExecutionDefaults } from "../../execution/source";
import {
  fallbackAnnouncement,
  NO_ENGINE_MESSAGE_SUFFIX,
  NO_ENGINE_REMEDY,
  withEngineFallback,
} from "../../integrations/agent/engine-fallback";
import { resolveEngine } from "../../integrations/agent/engine-resolution";
import { executeRunner } from "../../integrations/agent/runner-dispatch";
import type { AgentRunResult } from "../../integrations/agent/spawn";
import { executeCommandInvocation, type PrepareCommandInvocationOptions } from "../command/command-execution";

export interface AkmAgentDispatchOptions {
  engine?: string;
  prompt?: string;
  commandRef?: string;
  /** Exact, non-tokenized string substituted for the portable `$ARGUMENTS` token. */
  argumentInput?: string;
  /** Portable agent asset ref used by the canonical command path. */
  agentRef?: string;
  args?: string[];
  agentConfig?: AkmConfig;
  timeoutMs?: number;
  /**
   * Working directory resolved into the canonical execution runtime. The SDK
   * forwards it as its per-session directory query.
   */
  cwd?: string;
  /** Current invocation-layer selections consumed by the execution cascade. */
  selection?: Pick<UnresolvedExecutionDefaults, "model" | "inference" | "outputSchema" | "tools">;
}

export interface AkmAgentDispatchSeams {
  readonly executeCommand?: (options: PrepareCommandInvocationOptions) => Promise<AkmAgentDispatchResult>;
}

export interface AkmAgentDispatchResult {
  schemaVersion: 2;
  ok: boolean;
  shape: "agent-result";
  engine: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
  reason?: string;
  /**
   * Non-fatal announcements — today only the implicit `opencode-sdk` engine
   * fallback (`integrations/agent/engine-fallback.ts`), surfaced here so JSON
   * consumers see it alongside the stderr `warn()`.
   */
  warnings?: readonly string[];
  /** Secret-free optimistic-lowering diagnostics from the selected engine adapter. */
  notices?: readonly Readonly<LoweringNotice>[];
}

function canonicalCurrent(options: AkmAgentDispatchOptions): UnresolvedExecutionDefaults {
  const current: Record<string, unknown> = {};
  if (options.agentRef !== undefined) current.agent = options.agentRef;
  if (options.engine !== undefined) current.engine = options.engine;
  if (options.selection?.model !== undefined) current.model = options.selection.model;
  if (Object.hasOwn(options.selection ?? {}, "inference")) current.inference = options.selection?.inference;
  if (options.selection?.outputSchema !== undefined) current.outputSchema = options.selection.outputSchema;
  if (options.selection?.tools !== undefined) current.tools = options.selection.tools;
  if (options.timeoutMs !== undefined) current.timeout = options.timeoutMs;
  if (options.cwd !== undefined) current.workspace = options.cwd;
  return current as UnresolvedExecutionDefaults;
}

function rejectInvalidAgentRef(agentRef: string | undefined): void {
  if (agentRef === undefined || isPortableExecutionAgentSelector(agentRef)) return;
  throw new UsageError(
    `agent expects an agent asset ref under agents/...; received ${JSON.stringify(agentRef)}.`,
    "INVALID_FLAG_VALUE",
  );
}

async function delegateCanonicalCommand(
  options: AkmAgentDispatchOptions,
  seams: AkmAgentDispatchSeams,
  action: { readonly ref: string; readonly arguments?: string } | { readonly content: string },
): Promise<AkmAgentDispatchResult> {
  const execute = seams.executeCommand ?? executeCommandInvocation;
  const result = await execute({
    action,
    config: options.agentConfig as AkmConfig,
    current: canonicalCurrent(options),
  });
  for (const message of result.warnings ?? []) warn(message);
  return result;
}

export async function akmAgentDispatch(
  options: AkmAgentDispatchOptions,
  seams: AkmAgentDispatchSeams = {},
): Promise<AkmAgentDispatchResult> {
  if (!options.agentConfig)
    throw new UsageError("agent requires a valid config with an agent engine.", "MISSING_REQUIRED_ARGUMENT");

  rejectInvalidAgentRef(options.agentRef);

  if (options.commandRef) {
    if (options.prompt !== undefined) {
      throw new UsageError("--command cannot be combined with --prompt.", "INVALID_FLAG_VALUE");
    }
    if (options.args?.length) {
      throw new UsageError(
        "Command arguments must be supplied as one exact string, not a positional argv array.",
        "INVALID_FLAG_VALUE",
        "Use --arguments <text> or the argumentInput API field.",
      );
    }
    const action = {
      ref: options.commandRef,
      ...(options.argumentInput === undefined ? {} : { arguments: options.argumentInput }),
    };
    return delegateCanonicalCommand(options, seams, action);
  }

  const hasResolvedSelection = options.agentRef !== undefined || options.selection !== undefined;
  if (options.prompt !== undefined || hasResolvedSelection) {
    if (options.prompt === undefined) {
      throw new UsageError(
        "Agent persona/model/tool/schema/inference selection requires an explicit task from --prompt, --prompt-stdin, or --command; it cannot fabricate an empty command. Omit those selections for a prompt-free interactive launch.",
        "MISSING_REQUIRED_ARGUMENT",
      );
    }
    if (options.args?.length) {
      throw new UsageError(
        "Native argv cannot accompany resolved prompt work; include the values in resolved command content instead.",
        "INVALID_FLAG_VALUE",
      );
    }
    return delegateCanonicalCommand(options, seams, { content: options.prompt });
  }
  if (options.args?.length) {
    throw new UsageError(
      "Native argv is outside the no-work interactive agent launch; select resolved command content instead.",
      "INVALID_FLAG_VALUE",
    );
  }

  // Same implicit opencode-sdk fallback the workflow and task surfaces apply,
  // so an engine-less install is usable everywhere or nowhere — not a mix.
  const { config: agentConfig, fallbackEngineName } = withEngineFallback(options.agentConfig);
  const engineName = options.engine ?? agentConfig.defaults?.engine;
  // Announced, never silent: `options.engine` outranks the default, so the
  // fallback is only reportable when it is the engine actually selected.
  const engineAnnouncement = fallbackAnnouncement(fallbackEngineName, engineName);
  if (engineAnnouncement) warn(engineAnnouncement);
  if (!engineName)
    throw new UsageError(`agent ${NO_ENGINE_MESSAGE_SUFFIX} ${NO_ENGINE_REMEDY}`, "MISSING_REQUIRED_ARGUMENT");
  const runner = resolveEngine(engineName, agentConfig);
  if (runner.kind === "llm") {
    throw new UsageError(
      `Engine "${engineName}" is an LLM engine; akm agent requires an agent engine.`,
      "INVALID_FLAG_VALUE",
    );
  }
  const profile = runner.profile;

  // This is the sole intentional low-level exemption: an interactive native
  // launch contains no prompt/model/tool work and therefore has no resolved
  // execution request or platform dispatch payload to lower.
  const stdio = runner.kind !== "sdk" ? ("interactive" as const) : profile.stdio;
  const runOptions = {
    stdio,
    parseOutput: "text" as const,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
  };
  const result: AgentRunResult = await executeRunner(runner, "", runOptions);

  return {
    schemaVersion: 2 as const,
    ok: result.ok,
    shape: "agent-result",
    engine: engineName,
    exitCode: result.exitCode,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    durationMs: result.durationMs,
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
    ...(engineAnnouncement ? { warnings: [engineAnnouncement] } : {}),
  };
}
