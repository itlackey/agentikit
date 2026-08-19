// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm agent [--engine <name>] [--prompt <text>] [--command <ref>] [--workflow <ref>]`
 *
 * Dispatch an agent by named engine, optionally injecting a prompt from
 * inline text, a stash command: asset, or a stash workflow: asset.
 *
 * When none of --prompt, --command, or --workflow are given, the agent is
 * launched interactively (no injected prompt).
 *
 * The command arm is a compatibility delegate to the canonical command
 * invocation path. Workflow loading remains on the legacy path until WP7.
 */

import fs from "node:fs";
import { parseRefInput } from "../../core/asset/resolve-ref";
import type { AkmConfig } from "../../core/config/config";
import { NotFoundError, UsageError } from "../../core/errors";
import { warn } from "../../core/warn";
import type { UnresolvedExecutionDefaults } from "../../execution/source";
import type { AgentDispatchRequest } from "../../integrations/agent/builder-shared";
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
  /** Portable agent ref or native selector used by the canonical command path. */
  agentRef?: string;
  workflowRef?: string;
  args?: string[];
  agentConfig?: AkmConfig;
  timeoutMs?: number;
  /**
   * Working directory for the spawned agent CLI. Not honoured by the
   * opencode-sdk path (the SDK server is process-wide; see the plan's open
   * seam decision on per-call cwd).
   */
  cwd?: string;
  /**
   * When present, the platform-specific AgentCommandBuilder uses these fields
   * to construct the argv (system prompt, model alias, tool policy). When
   * absent, uses positional-prompt dispatch.
   */
  dispatch?: AgentDispatchRequest;
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
}

/**
 * Fill `{{0}}`, `{{1}}`, ... placeholders in `template` with the
 * corresponding entries in `args`. Any placeholder index that exceeds the
 * args array is left as-is.
 */
function fillPlaceholders(template: string, args: string[]): string {
  return template.replace(/\{\{(\d+)\}\}/g, (match, idx) => {
    const i = Number.parseInt(idx, 10);
    return i < args.length ? args[i]! : match;
  });
}

/**
 * Resolve the body of an asset by ref string. The ref must parse as a
 * valid asset ref (e.g. `command:my-cmd`, `workflow:my-flow`). The file
 * must exist on disk (the index provides the file path).
 *
 * Throws `NotFoundError` when the ref cannot be resolved.
 */
async function resolveAssetBody(ref: string): Promise<string> {
  let parsed: ReturnType<typeof parseRefInput>;
  try {
    parsed = parseRefInput(ref);
  } catch (err) {
    throw new UsageError(
      `Invalid asset ref "${ref}": ${err instanceof Error ? err.message : String(err)}`,
      "INVALID_FLAG_VALUE",
    );
  }

  // Lazy import to avoid pulling the full indexer at startup.
  const { lookup } = await import("../../indexer/indexer.js");
  const entry = await lookup(parsed);
  if (!entry) {
    throw new NotFoundError(`Asset "${ref}" not found in the index. Run \`akm index\` to rebuild the index.`);
  }

  try {
    return fs.readFileSync(entry.filePath, "utf8");
  } catch (err) {
    throw new NotFoundError(
      `Asset "${ref}" is indexed but the file could not be read (${entry.filePath}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function akmAgentDispatch(
  options: AkmAgentDispatchOptions,
  seams: AkmAgentDispatchSeams = {},
): Promise<AkmAgentDispatchResult> {
  if (!options.agentConfig)
    throw new UsageError("agent requires a valid config with an agent engine.", "MISSING_REQUIRED_ARGUMENT");

  if (options.commandRef) {
    if (options.prompt !== undefined || options.workflowRef !== undefined) {
      throw new UsageError("--command cannot be combined with --prompt or --workflow.", "INVALID_FLAG_VALUE");
    }
    if (options.args?.length) {
      throw new UsageError(
        "Command arguments must be supplied as one exact string, not a positional argv array.",
        "INVALID_FLAG_VALUE",
        "Use --arguments <text> or the argumentInput API field.",
      );
    }
    if (options.dispatch?.systemPrompt !== undefined) {
      throw new UsageError(
        "A command persona must be selected by agent ref; raw systemPrompt injection is not portable.",
        "INVALID_FLAG_VALUE",
      );
    }
    const current: Record<string, unknown> = {};
    if (options.agentRef !== undefined) current.agent = options.agentRef;
    if (options.engine !== undefined) current.engine = options.engine;
    if (options.dispatch?.model !== undefined) current.model = options.dispatch.model;
    if (options.dispatch?.tools !== undefined) current.tools = options.dispatch.tools;
    if (options.dispatch?.effort !== undefined) current.inference = { effort: options.dispatch.effort };
    if (options.dispatch?.schema !== undefined) current.outputSchema = options.dispatch.schema;
    if (options.timeoutMs !== undefined) current.timeout = options.timeoutMs;
    if (options.cwd !== undefined) current.workspace = options.cwd;
    const action = {
      ref: options.commandRef,
      ...(options.argumentInput === undefined ? {} : { arguments: options.argumentInput }),
    };
    const execute = seams.executeCommand ?? executeCommandInvocation;
    const result = await execute({
      action,
      config: options.agentConfig,
      current: current as UnresolvedExecutionDefaults,
    });
    for (const message of result.warnings ?? []) warn(message);
    return result;
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

  // Resolve the prompt text from whichever source was provided.
  let prompt: string | undefined;

  if (options.workflowRef) {
    const body = await resolveAssetBody(options.workflowRef);
    prompt = options.args?.length ? fillPlaceholders(body, options.args) : body;
  } else if (options.prompt !== undefined) {
    prompt = options.prompt;
  }
  // When prompt is undefined, the agent is launched interactively.

  const stdio = prompt === undefined && runner.kind !== "sdk" ? ("interactive" as const) : profile.stdio;
  // Build the final dispatch request: merge the caller-supplied dispatch with
  // the resolved prompt so the builder has all context in one place.
  const dispatchRequest: AgentDispatchRequest | undefined = options.dispatch
    ? { ...options.dispatch, prompt: prompt ?? options.dispatch.prompt }
    : undefined;

  const runOptions = {
    stdio,
    parseOutput: "text" as const,
    ...(options.args?.length && !options.workflowRef ? { args: options.args } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(dispatchRequest !== undefined ? { dispatch: dispatchRequest } : {}),
  };
  const result: AgentRunResult = await executeRunner(runner, prompt ?? "", runOptions);

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
