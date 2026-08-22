// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The ONE redaction contract every frozen-workflow dispatch is held to before
 * anything about its outcome reaches durable state.
 *
 * This is a LEAF module on purpose. Both dispatch paths need it — the unit path
 * (`exec/native-executor.ts`) and the gate-judge path (`exec/frozen-judge.ts`) —
 * and the judge path is reached from `runtime/runs.ts`, which the executor's own
 * dependency chain runs back into. Keeping the helpers here (importing only
 * `core/redaction` plus erased types) means the judge can reuse the exact unit
 * scrub without opening a runtime import cycle.
 *
 * @module workflows/exec/dispatch-redaction
 */

import {
  collectSensitiveValues,
  isEnvPassthroughValueSafeToExpose,
  redactSensitiveText,
  redactSensitiveValue,
} from "../../core/redaction";
import type { FrozenEngineSnapshot } from "../ir/schema";
import type { UnitDispatcher } from "./unit-dispatch";

/** The engine pair a dispatch may draw credentials from. `StepWorkUnit` satisfies it structurally. */
export interface DispatchEngines {
  engine?: FrozenEngineSnapshot;
  fallbackEngine?: Extract<FrozenEngineSnapshot, { kind: "llm" }>;
  /** Values sampled by a durable-v4 symbolic environment materializer. */
  sensitiveValues?: readonly string[];
}

/**
 * Every exact value that must never survive into the journal from ONE frozen
 * dispatch: the resolved `env` bindings injected into the child, the selected
 * engine's (and its SDK fallback's) credential env values, and any
 * `envPassthrough` value the redaction policy does not consider safe to expose.
 *
 * Shared by the unit path and the gate-judge path. There is deliberately ONE
 * collector: a second, parallel implementation is exactly how a dispatch path
 * silently loses the scrub.
 *
 * The credential values are read from `process.env` AT CALL TIME, so a caller
 * must collect no earlier than the dispatch whose outcome it scrubs. A snapshot
 * taken when the dispatch was merely *planned* can predate a credential the
 * dispatch then resolves live, leaving the exact value it must remove out of
 * the set.
 */
export function collectWorkflowDispatchSensitiveValues(
  dispatch: DispatchEngines,
  env: Record<string, string> | undefined,
): string[] {
  const values = new Set<string>([...Object.values(env ?? {}), ...(dispatch.sensitiveValues ?? [])]);
  const addCredential = (engine: FrozenEngineSnapshot | undefined): void => {
    if (!engine) return;
    if (engine.kind === "llm") {
      for (const name of engine.credential?.names ?? []) {
        const value = process.env[name]?.trim();
        if (value) values.add(value);
      }
      return;
    }
    for (const name of engine.envPassthrough) {
      const value = process.env[name];
      if (!isEnvPassthroughValueSafeToExpose(name, value) && value) values.add(value);
    }
  };
  addCredential(dispatch.engine);
  addCredential(dispatch.fallbackEngine);
  return collectSensitiveValues(values);
}

/**
 * Scrub a dispatch outcome before ANYTHING about it is journaled.
 *
 * The `failureReason` downgrade is part of the contract: if redaction ALTERED
 * the reason, the reason itself carried a secret, and the persisted failure
 * vocabulary must not become a side channel for it.
 *
 * Structurally typed over `{ failureReason? }` rather than importing
 * `UnitOutcome` from `step-work.ts`: this module must stay a LEAF, and even an
 * erased `import type` edge here would put `frozen-judge → step-work →
 * runtime/runs → frozen-judge` back on the static import graph (the
 * import-cycle ratchet is shrink-only). Callers keep their exact outcome type
 * through the generic.
 */
export function redactUnitOutcome<T extends { failureReason?: string }>(
  outcome: T,
  sensitiveValues: readonly string[],
): T {
  const redacted = redactSensitiveValue(outcome, sensitiveValues);
  if (outcome.failureReason !== undefined && redacted.failureReason !== outcome.failureReason) {
    redacted.failureReason = "reported_failure";
  }
  return redacted;
}

/**
 * Scrub a value THROWN out of a dispatch. A rejection is as durable as a
 * resolved failure — the message becomes the blocked step's notes — so it goes
 * through the same value set. Re-wrapped ONLY when redaction actually changed
 * the message, so an untouched throw keeps its original object (and its type,
 * which callers branch on) byte-identical.
 */
function redactDispatchError(err: unknown, sensitiveValues: readonly string[]): unknown {
  if (sensitiveValues.length === 0 || !(err instanceof Error)) return err;
  const redacted = redactSensitiveText(err.message, sensitiveValues);
  if (redacted === err.message) return err;
  const replacement = new Error(redacted);
  replacement.name = err.name;
  return replacement;
}

/**
 * Wrap a dispatcher so BOTH its exits are scrubbed with the request's own
 * `sensitiveValues` — the outcome it resolves to and the error it throws — so a
 * caller holding the wrapped dispatcher cannot observe (or journal) either one
 * unredacted. Used at seams whose results head STRAIGHT for durable state (the
 * gate judge, on both its agent and its llm branch); the unit path instead
 * scrubs once at its own journal boundary (`dispatchJournaledAttempt`), AFTER
 * the structured-output parse loop has seen the raw text.
 */
export function withDispatchRedaction(inner: UnitDispatcher): UnitDispatcher {
  return async (request, feedback) => {
    const sensitiveValues = request.sensitiveValues ?? [];
    try {
      return redactUnitOutcome(await inner(request, feedback), sensitiveValues);
    } catch (err) {
      throw redactDispatchError(err, sensitiveValues);
    }
  };
}
