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
 *     {@link withDispatchRedaction} (exec/dispatch-redaction.ts). Nothing about
 *     a judge call reaches durable state before that scrub. Agent and direct-LLM
 *     judges share one prepared/lowered dispatch request; the manual completion
 *     path uses the same config-free dispatcher without opening an executor
 *     import cycle.
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
 * Lowering notices are transitional in WP5: units expose a typed live result,
 * while judges retain their public string contract and emit only the common
 * lowerer's prompt/body-free notice projection through `warn()`. WP7 owns a
 * versioned durable journal/IR representation.
 *
 * @module workflows/exec/frozen-judge
 */

import { ConfigError } from "../../core/errors";
import { warn } from "../../core/warn";
import type { LoweringNotice } from "../../execution/resolved-request";
import type { IrInvocation, WorkflowPlanGraph } from "../ir/schema";
import type { JudgeCallIdentity, SummaryJudge } from "../validate-summary";
import { collectWorkflowDispatchSensitiveValues, withDispatchRedaction } from "./dispatch-redaction";
import { dispatchFrozenWorkflowExecution, prepareFrozenWorkflowExecution, type UnitDispatcher } from "./unit-dispatch";

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

function warnLoweringNotices(...groups: readonly (readonly Readonly<LoweringNotice>[] | undefined)[]): void {
  const emitted = new Set<string>();
  for (const notices of groups) {
    for (const notice of notices ?? []) {
      const key = JSON.stringify([notice.code, notice.severity, notice.adapter, notice.field, notice.message]);
      if (emitted.has(key)) continue;
      emitted.add(key);
      warn(`Workflow judge lowering notice (${notice.code}; ${notice.adapter}; ${notice.field}): ${notice.message}`);
    }
  }
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
  const fallbackEngine =
    engine.kind === "agent" && engine.fallbackLlmEngine ? plan.execution.engines[engine.fallbackLlmEngine] : undefined;
  const fallback = fallbackEngine?.kind === "llm" ? fallbackEngine : undefined;
  const dispatch = withDispatchRedaction(dispatcher ?? dispatchFrozenWorkflowExecution);
  return async ({ system, user }, identity) => {
    const id = dispatchIdentity(owner, identity);
    const request = {
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
      ...(signal ? { signal } : {}),
    };
    // Lowering and authorization precede every live credential/passthrough
    // sample. The injected dispatcher may be a test seam, but it receives the
    // exact same already-validated request and redaction declaration.
    const lowered = prepareFrozenWorkflowExecution(request);
    const sensitiveValues = collectWorkflowDispatchSensitiveValues(
      { engine, ...(fallback ? { fallbackEngine: fallback } : {}) },
      undefined,
    );
    const outcome = await dispatch({
      ...request,
      ...(sensitiveValues.length > 0 ? { sensitiveValues } : {}),
    });
    // Only the common lowerer's own sanitized notices are loggable here. An
    // injected dispatcher is not trusted to supply prompt/body-free messages.
    warnLoweringNotices(lowered.notices);
    if (!outcome.ok) {
      throw new Error(outcome.error || `Verification engine "${invocation.engine}" failed.`);
    }
    return outcome.text ?? "";
  };
}
