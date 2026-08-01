// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AgentTokenUsage } from "../../integrations/agent/spawn";
import type { FrozenEngineSnapshot, IrInvocation } from "../ir/schema";

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
  /** Frozen v3 engine snapshot. Dispatch never consults live config. */
  engine: FrozenEngineSnapshot;
  fallbackEngine?: Extract<FrozenEngineSnapshot, { kind: "llm" }>;
  invocation: IrInvocation;
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
