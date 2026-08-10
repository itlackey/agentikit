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
 *     a judge call reaches durable state before that scrub. BOTH branches below
 *     state it that way — the agent branch wrapping the injected dispatcher, the
 *     llm branch wrapping its own chatCompletion call — so a change to that one
 *     contract cannot reach only one of the two judge paths.
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

import { ConfigError } from "../../core/errors";
import type { IrInvocation, WorkflowPlanGraph } from "../ir/schema";
import type { JudgeCallIdentity, SummaryJudge } from "../validate-summary";
import { collectWorkflowDispatchSensitiveValues, withDispatchRedaction } from "./dispatch-redaction";
import { materializeFrozenLlm, type UnitDispatcher } from "./unit-dispatch";

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
    const fallbackEngine = engine.fallbackLlmEngine ? plan.execution.engines[engine.fallbackLlmEngine] : undefined;
    const fallback = fallbackEngine?.kind === "llm" ? fallbackEngine : undefined;
    // Scrub at the seam: every outcome this judge's dispatcher returns — and
    // every error it throws — is redacted BEFORE the verdict (or the failure
    // message) can reach the gate row / the blocked step's notes. Identical
    // contract to the llm branch below and to the unit path, including the
    // failureReason downgrade when redaction altered it.
    const dispatch = withDispatchRedaction(dispatcher);
    return async ({ system, user }, identity) => {
      const id = dispatchIdentity(owner, identity);
      // Collected per dispatch, not once per judge: the engine PAIR is fixed at
      // build time but its secrets are not — they are read from `process.env`,
      // which the dispatch itself re-reads, so a build-time set would miss a
      // credential set or rotated between the two reads. Same collector the unit
      // path uses; see the module doc on why `env` is absent here but the
      // credential/passthrough values are still collected.
      const sensitiveValues = collectWorkflowDispatchSensitiveValues(
        { engine, ...(fallback ? { fallbackEngine: fallback } : {}) },
        undefined,
      );
      const outcome = await dispatch({
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
      if (!outcome.ok) {
        throw new Error(outcome.error || `Verification engine "${invocation.engine}" failed.`);
      }
      return outcome.text ?? "";
    };
  }
  // The llm judge's ONE call, shaped as a {@link UnitDispatcher} so this branch
  // states its redaction through the SAME {@link withDispatchRedaction} contract
  // the agent branch above uses — including the throw, which a transport error
  // takes and which becomes the blocked step's notes (`judgeFailure` in
  // step-work.ts).
  //
  // Inline chatCompletion rather than the injected unit dispatcher ON PURPOSE:
  // the manual completion path (`runtime/runs.ts`) builds an llm judge with no
  // dispatcher, and a static runs → native-executor edge would close an import
  // cycle. The materialization itself is the shared {@link materializeFrozenLlm},
  // so the two llm dispatch paths cannot drift.
  const dispatch = withDispatchRedaction(async (request) => {
    const { chatCompletion } = await import("../../llm/client");
    const text = await chatCompletion(
      materializeFrozenLlm(engine, invocation),
      [
        { role: "system", content: request.systemPrompt ?? "" },
        { role: "user", content: request.prompt },
      ],
      {
        timeoutMs: request.timeoutMs,
        ...(signal ? { signal } : {}),
      },
    );
    return { ok: true, text };
  });
  return async ({ system, user }, identity) => {
    const id = dispatchIdentity(owner, identity);
    // An llm judge's only secret is its own credential, which
    // `materializeFrozenLlm` resolves out of `process.env` inside the dispatch
    // below — so the set is collected here, per dispatch, and cannot predate the
    // value the call actually authenticates with.
    const sensitiveValues = collectWorkflowDispatchSensitiveValues({ engine }, undefined);
    const outcome = await dispatch({
      runId: id.runId,
      stepId: id.stepId,
      unitId: id.unitId,
      nodeId: gateNodeId(id.stepId),
      prompt: user,
      systemPrompt: system,
      engine,
      invocation,
      timeoutMs: invocation.timeoutMs,
      ...(sensitiveValues.length > 0 ? { sensitiveValues } : {}),
      ...(signal ? { signal } : {}),
    });
    return outcome.text;
  };
}
