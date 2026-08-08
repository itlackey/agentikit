// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The gate judge built from a frozen v3 engine catalog.
 *
 * Two contracts this module owns, both of which the rest of the engine already
 * enforces for ordinary units and neither of which the judge may opt out of:
 *
 *  1. **Redaction.** A judge response IS journaled — `journalGateEvaluationFinish`
 *     (exec/step-work.ts) writes the parsed verdict into the gate row's
 *     `result_json`, and a judge failure's message becomes the blocked step's
 *     notes. So the judge outcome goes through the SAME scrub every unit outcome
 *     goes through: {@link collectWorkflowDispatchSensitiveValues} +
 *     {@link redactUnitOutcome} (exec/dispatch-redaction.ts). Nothing about a
 *     judge call reaches durable state before that scrub.
 *
 *  2. **Identity.** The dispatch request carries the REAL run/step and the gate's
 *     real node/unit ids — the same ids `journalGateEvaluationStart/Finish` write
 *     (`<stepId>.gate` / `<stepId>.gate:l<loop>`) — so per-dispatch telemetry and
 *     harness-side correlation describe the same thing the gate row describes.
 *     The identity is threaded in from the caller that writes the row
 *     ({@link SummaryJudge}'s `identity` argument); it is never synthesized here.
 *
 * A judge dispatch carries NO `env` bindings: a gate judge is an
 * {@link IrInvocation} (`IrGateNode.judge`), which has no `env` key, so there is
 * nothing authored to thread — and a step's unit `env` is scoped to the WORK,
 * not to the verifier. Redaction is unaffected: the sensitive-value set below
 * still covers the judge engine's credential and unsafe passthrough values.
 *
 * @module workflows/exec/frozen-judge
 */

import type { LlmConnectionConfig } from "../../core/config/config";
import { deepMergeConfig } from "../../core/config/deep-merge";
import { ConfigError } from "../../core/errors";
import { redactSensitiveText } from "../../core/redaction";
import type { FrozenLlmEngine, IrInvocation, WorkflowPlanGraph } from "../ir/schema";
import type { JudgeCallIdentity, SummaryJudge } from "../validate-summary";
import { collectWorkflowDispatchSensitiveValues, redactUnitOutcome } from "./dispatch-redaction";
import type { UnitDispatcher } from "./unit-dispatch";

/**
 * The run/step a judge belongs to, known when the judge is BUILT. Callers that
 * also journal a gate row (the engine's completion path) additionally pass the
 * exact row identity per call; callers that journal no row (the manual
 * `akm workflow step complete` path) fall back to this.
 */
export interface JudgeOwner {
  runId: string;
  stepId: string;
}

/** The gate's node id — identical to what `journalGateEvaluationStart` writes. */
export function gateNodeId(stepId: string): string {
  return `${stepId}.gate`;
}

/**
 * Identity for one judge dispatch: the journaling caller's exact row identity
 * when it supplied one, else the owning run/step with the gate's node id as the
 * unit id. Either way the request names the REAL run — never a synthetic
 * `"gate"` placeholder, which made every judge dispatch indistinguishable from
 * every other one.
 */
function dispatchIdentity(owner: JudgeOwner, identity: JudgeCallIdentity | undefined): JudgeCallIdentity {
  return identity ?? { ...owner, unitId: gateNodeId(owner.stepId) };
}

/** Build a gate judge from a v3 catalog entry without consulting live config. */
export function frozenSummaryJudge(
  plan: WorkflowPlanGraph,
  invocation: IrInvocation | null | undefined,
  signal: AbortSignal | undefined,
  dispatcher: UnitDispatcher | undefined,
  owner: JudgeOwner,
): SummaryJudge | null {
  if (!invocation) return null;
  const engine = plan.execution?.engines[invocation.engine];
  if (!engine)
    throw new ConfigError(`Frozen gate engine "${invocation.engine}" is unavailable.`, "INVALID_CONFIG_FILE");
  if (engine.kind === "agent") {
    if (!dispatcher) {
      throw new ConfigError(
        `Frozen agent gate engine "${invocation.engine}" has no unit dispatcher.`,
        "INVALID_CONFIG_FILE",
      );
    }
    return async ({ system, user }, identity) => {
      const fallbackEngine = engine.fallbackLlmEngine ? plan.execution.engines[engine.fallbackLlmEngine] : undefined;
      const fallback = fallbackEngine?.kind === "llm" ? fallbackEngine : undefined;
      const id = dispatchIdentity(owner, identity);
      // Same collector the unit path uses — see the module doc on why `env` is
      // absent here but the credential/passthrough values are still collected.
      const sensitiveValues = collectWorkflowDispatchSensitiveValues(
        { engine, ...(fallback ? { fallbackEngine: fallback } : {}) },
        undefined,
      );
      const result = await dispatcher({
        runId: id.runId,
        stepId: id.stepId,
        unitId: id.unitId,
        nodeId: gateNodeId(id.stepId),
        prompt: user,
        systemPrompt: system,
        engine,
        ...(fallback ? { fallbackEngine: fallback } : {}),
        invocation,
        timeoutMs: invocation.timeoutMs,
        ...(sensitiveValues.length > 0 ? { sensitiveValues } : {}),
        ...(signal ? { signal } : {}),
      });
      // Scrub BEFORE the verdict (or the failure message) can reach the gate row
      // / the blocked step's notes. Identical contract to the unit path,
      // including the failureReason downgrade when redaction altered it.
      const outcome = redactUnitOutcome(
        {
          unitId: id.unitId,
          ok: result.ok,
          ...(result.text !== undefined ? { text: result.text } : {}),
          ...(result.failureReason !== undefined ? { failureReason: result.failureReason } : {}),
          ...(result.error !== undefined ? { error: result.error } : {}),
        },
        sensitiveValues,
      );
      if (!outcome.ok) {
        throw new Error(outcome.error || `Verification engine "${invocation.engine}" failed.`);
      }
      return outcome.text ?? "";
    };
  }
  return async ({ system, user }) => {
    const { chatCompletion } = await import("../../llm/client");
    // An llm judge's only secret is its own credential (materialize reads it out
    // of process.env); collect it through the SHARED collector so the llm and
    // agent judge paths cannot drift.
    const sensitiveValues = collectWorkflowDispatchSensitiveValues({ engine }, undefined);
    try {
      const text = await chatCompletion(
        materialize(engine, invocation),
        [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        {
          timeoutMs: invocation.timeoutMs,
          ...(signal ? { signal } : {}),
        },
      );
      return redactSensitiveText(text, sensitiveValues);
    } catch (err) {
      // A transport error's message becomes the blocked step's notes (see
      // `judgeState.failure` in step-work.ts) — a durable surface. Re-wrap ONLY
      // when redaction actually changed the message, so the untouched path keeps
      // the original error object (and its type) byte-identical.
      throw redactJudgeError(err, sensitiveValues);
    }
  };
}

function redactJudgeError(err: unknown, sensitiveValues: readonly string[]): unknown {
  if (sensitiveValues.length === 0 || !(err instanceof Error)) return err;
  const redacted = redactSensitiveText(err.message, sensitiveValues);
  if (redacted === err.message) return err;
  const replacement = new Error(redacted);
  replacement.name = err.name;
  return replacement;
}

function materialize(engine: FrozenLlmEngine, invocation: IrInvocation): LlmConnectionConfig {
  let apiKey: string | undefined;
  for (const name of engine.credential?.names ?? []) {
    const value = process.env[name]?.trim();
    if (value) {
      apiKey = value;
      break;
    }
  }
  if (engine.credential?.required && !apiKey)
    throw new ConfigError(
      `Required engine credential ${engine.credential.names[0]} is not set.`,
      "INVALID_CONFIG_FILE",
    );
  const base = {
    provider: engine.provider,
    endpoint: engine.endpoint,
    model: invocation.model ?? engine.model,
    ...(engine.temperature !== undefined ? { temperature: engine.temperature } : {}),
    ...(engine.maxTokens !== undefined ? { maxTokens: engine.maxTokens } : {}),
    ...(engine.supportsJsonSchema !== undefined ? { supportsJsonSchema: engine.supportsJsonSchema } : {}),
    ...(engine.extraParams ? { extraParams: engine.extraParams } : {}),
    ...(engine.contextLength !== undefined ? { contextLength: engine.contextLength } : {}),
    ...(engine.enableThinking !== undefined ? { enableThinking: engine.enableThinking } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
  return (
    invocation.llm ? deepMergeConfig(base, invocation.llm as Record<string, unknown>) : base
  ) as LlmConnectionConfig;
}
