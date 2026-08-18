// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { LlmConnectionConfig } from "../../core/config/config";
import { deepMergeConfig } from "../../core/config/deep-merge";
import { resolveCredentialFromEnv } from "../../integrations/agent/engine-resolution";
import type { AgentTokenUsage } from "../../integrations/agent/spawn";
import type { FrozenEngineSnapshot, IrExecSpec, IrInvocation } from "../ir/schema";

/** Everything the dispatcher needs to run one frozen workflow unit. */
export interface UnitDispatchRequest {
  runId: string;
  stepId: string;
  unitId: string;
  nodeId: string;
  /** Fully assembled user prompt. */
  prompt: string;
  /** Optional system prompt, used by frozen workflow gate judges. */
  systemPrompt?: string;
  /**
   * Frozen v3 engine snapshot. Dispatch never consults live config. Absent on
   * `exec` units, which name no engine — see {@link UnitDispatchRequest.exec}.
   */
  engine?: FrozenEngineSnapshot;
  fallbackEngine?: Extract<FrozenEngineSnapshot, { kind: "llm" }>;
  /** Engine dispatch settings. Present on exactly the units that reach an engine. */
  invocation?: IrInvocation;
  /**
   * Frozen shell command for an `exec` unit — argv, relative cwd, resolved
   * timeout. Present on EXACTLY the units that carry no `engine`/`invocation`;
   * the frozen-plan decoder enforces that exclusive-or, so a dispatcher can
   * branch on this field alone.
   */
  exec?: IrExecSpec;
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
}

/** The one dispatch seam. `feedback` carries a structured-output retry prompt. */
export type UnitDispatcher = (request: UnitDispatchRequest, feedback?: string) => Promise<UnitDispatchResult>;

/**
 * Materialize a frozen llm engine snapshot into a live connection: resolve the
 * credential out of `process.env`, then apply the invocation's model/llm
 * overrides. The ONE definition — the default dispatcher's llm runner and the
 * frozen gate judge both dispatch through it, so credential resolution and
 * connection-field mapping cannot drift between the two llm dispatch paths.
 *
 * The credential read itself is {@link resolveCredentialFromEnv}, shared with
 * the live-config dispatch boundary (`materializeLlmConnection`): a frozen
 * snapshot's `credential` and a resolved engine's `CredentialDescriptor` are the
 * same descriptor, so lookup order and the "required … is not set" failure are
 * one implementation, not two that happen to agree.
 */
export function materializeFrozenLlm(
  snapshot: Extract<FrozenEngineSnapshot, { kind: "llm" }>,
  invocation: IrInvocation | undefined,
): LlmConnectionConfig {
  const apiKey = resolveCredentialFromEnv(snapshot.credential);
  const base = {
    provider: snapshot.provider,
    endpoint: snapshot.endpoint,
    model: invocation?.model ?? snapshot.model,
    ...(snapshot.temperature !== undefined ? { temperature: snapshot.temperature } : {}),
    ...(snapshot.maxTokens !== undefined ? { maxTokens: snapshot.maxTokens } : {}),
    ...(snapshot.supportsJsonSchema !== undefined ? { supportsJsonSchema: snapshot.supportsJsonSchema } : {}),
    ...(snapshot.extraParams ? { extraParams: snapshot.extraParams } : {}),
    ...(snapshot.contextLength !== undefined ? { contextLength: snapshot.contextLength } : {}),
    ...(snapshot.enableThinking !== undefined ? { enableThinking: snapshot.enableThinking } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
  return invocation?.llm ? (deepMergeConfig(base, invocation.llm as Record<string, unknown>) as typeof base) : base;
}
