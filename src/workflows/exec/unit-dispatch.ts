// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { ConfigError } from "../../core/errors";
import { assertFrozenDirectoryIdentity } from "../../execution/directory-identity";
import { assertFrozenExecutableIdentity } from "../../execution/executable-identity";
import {
  canonicalResolvedExecutionRequest,
  decodeResolvedExecutionRequest,
  type LoweringNotice,
} from "../../execution/resolved-request";
import {
  dispatchLoweredExecutionRequest,
  type LoweredExecutionRequest,
  lowerResolvedExecutionRequestWithRunner,
} from "../../integrations/agent/execution-lowering";
import type { AgentTokenUsage } from "../../integrations/agent/spawn";
import { getHarness } from "../../integrations/harnesses";
import type { FrozenWorkflowTarget } from "../ir/schema-v4";

/** Everything the dispatcher needs to run one frozen workflow unit. */
export interface UnitDispatchRequest {
  runId: string;
  stepId: string;
  unitId: string;
  nodeId: string;
  /** Append-only attempt ordinal when the journal policy uses attempt rows. */
  attempt?: number;
  /** Stable external correlation/idempotency key for an append-only attempt. */
  dispatchId?: string;
  /** Fully assembled user prompt. */
  prompt: string;
  /** Optional system prompt, used by frozen workflow gate judges. */
  systemPrompt?: string;
  /** The sole normalized execution target. Dispatch authority comes from this snapshot only. */
  frozenTarget: FrozenWorkflowTarget;
  /**
   * `AKM_*` context environment for an exec unit's child — run/step/unit ids,
   * the run params, a map unit's item + index, and the step's declared
   * `inputs:` artifacts, all as canonical JSON. Applied ON TOP of {@link env}
   * so an engine-authored context variable cannot be shadowed by a binding.
   * Kept separate from `env` on purpose: `env` values are the resolved SECRETS
   * that must be redacted out of the journal, and these plainly are not.
   */
  execContext?: Record<string, string>;
  timeoutMs: number | null;
  schema?: Record<string, unknown>;
  /** Resolved env bindings to merge into the child environment. */
  env?: Record<string, string>;
  /** Exact values that must be removed before output reaches the journal. */
  sensitiveValues?: readonly string[];
  /** Working directory for the unit's child process or SDK session. */
  cwd?: string;
  signal?: AbortSignal;
  /**
   * F-1 (spec docs/plans/specs/p1b-model-extraction.md §5.2 point 2): the
   * task runner's resolved provenance event source, forwarded to an exec
   * unit's child env (exec-unit.ts's RunExecUnitInput.eventSource ->
   * childEnv). The "agent"/"sdk" defaultUnitDispatcher arms never read it —
   * only a "script"/"shell" frozenTarget's exec unit does. Typed as a bare
   * `string` (not `UsageEventSource`) — see run-workflow.ts's
   * RunWorkflowOptions.eventSource for why.
   */
  eventSource?: string;
}

export interface UnitDispatchResult {
  ok: boolean;
  /** Normalized final text, or raw text when the harness has no extractor. */
  text: string;
  /** Harness-native session id, when available. */
  sessionId?: string;
  /** Structured failure vocabulary used by workflow retry policies. */
  failureReason?: string;
  error?: string;
  usage?: AgentTokenUsage;
  /** Safe, structured diagnostics emitted by the common execution lowerer. */
  notices?: readonly Readonly<LoweringNotice>[];
}

/** The one dispatch seam. `feedback` carries a structured-output retry prompt. */
export type UnitDispatcher = (request: UnitDispatchRequest, feedback?: string) => Promise<UnitDispatchResult>;

/** Lower a persisted v4 common request through its persisted runner only. */
export function prepareWorkflowExecution(
  request: UnitDispatchRequest & { frozenTarget: Extract<FrozenWorkflowTarget, { kind: "command" }> },
  prompt = request.prompt,
): LoweredExecutionRequest {
  const target = request.frozenTarget;
  if (target.cwdIdentity) assertFrozenDirectoryIdentity(target.cwdIdentity);
  if (target.executable) assertFrozenExecutableIdentity(target.executable, `unit ${request.unitId} executable`);
  const wire = JSON.parse(canonicalResolvedExecutionRequest(target.request)) as Record<string, unknown>;
  const command = { ...(wire.command as Record<string, unknown>), content: prompt };
  const runtime = {
    ...(wire.runtime as Record<string, unknown>),
    ...(request.cwd !== undefined
      ? { workspace: request.cwd }
      : target.cwdIdentity
        ? { workspace: target.cwdIdentity.realCwd }
        : {}),
    ...(request.env !== undefined ? { environment: request.env } : {}),
  };
  wire.command = command;
  wire.runtime = runtime;
  if (request.systemPrompt !== undefined) {
    wire.conversation = [{ role: "system", content: request.systemPrompt }];
  }
  return lowerResolvedExecutionRequestWithRunner(decodeResolvedExecutionRequest(wire), target.runner);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Dispatch one frozen workflow engine call through the common prepared/lowered
 * seam. Credential materialization happens inside the final dispatch only.
 */
export async function dispatchWorkflowExecution(
  request: UnitDispatchRequest,
  feedback?: string,
): Promise<UnitDispatchResult> {
  const prompt = feedback ? `${request.prompt}\n\n${feedback}` : request.prompt;
  if (request.frozenTarget.kind !== "command") {
    throw new ConfigError(`unit ${JSON.stringify(request.unitId)} is not a command target.`, "INVALID_CONFIG_FILE");
  }
  const lowered = prepareWorkflowExecution(
    request as UnitDispatchRequest & { frozenTarget: Extract<FrozenWorkflowTarget, { kind: "command" }> },
    prompt,
  );
  const notices = lowered.notices.length > 0 ? lowered.notices : undefined;

  if (request.env && Object.keys(request.env).length > 0 && lowered.runner.kind === "llm") {
    return {
      ok: false,
      text: "",
      failureReason: "env_unsupported",
      error:
        `unit ${JSON.stringify(request.unitId)} declares env bindings, which require a child process ` +
        `(agent or sdk runner) — the "llm" runner cannot inject a per-unit child environment.`,
      ...(notices ? { notices } : {}),
    };
  }
  if (request.cwd && lowered.runner.kind === "llm") {
    return {
      ok: false,
      text: "",
      failureReason: "isolation_unsupported",
      error:
        `unit ${JSON.stringify(request.unitId)} declares isolation: worktree but resolved to the "llm" runner, ` +
        `which has no working directory to isolate. Use the agent or sdk runner for isolated units.`,
      ...(notices ? { notices } : {}),
    };
  }

  let result: Awaited<ReturnType<typeof dispatchLoweredExecutionRequest>>;
  try {
    result = await dispatchLoweredExecutionRequest(lowered, {
      runOptions: {
        stdio: "captured",
        parseOutput: "text",
        ...(request.signal ? { signal: request.signal } : {}),
      },
    });
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    return {
      ok: false,
      text: "",
      failureReason: "dispatch_error",
      error: message(err),
      ...(notices ? { notices } : {}),
    };
  }

  let text = result.stdout;
  let sessionId = result.sessionId;
  if (lowered.runner.kind === "agent" && result.ok) {
    const harness = getHarness(lowered.runner.profile.platform ?? lowered.runner.profile.name);
    if (harness?.resultExtractor) {
      const extraction = harness.resultExtractor(result);
      text = extraction.text;
      if (extraction.sessionId !== undefined) sessionId = extraction.sessionId;
    }
  }

  return {
    ok: result.ok,
    text,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(result.reason ? { failureReason: result.reason } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
    ...(notices ? { notices } : {}),
  };
}
