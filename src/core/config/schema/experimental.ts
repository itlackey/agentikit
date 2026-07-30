// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `experimental` config section — explicit opt-ins for behaviour that is not
 * covered by the stability contract (D8).
 *
 * An entry here exists so a user can turn something ON deliberately. Every key
 * defaults to OFF, and the runtime must treat "absent" and "false" identically:
 * autonomy is never inferred from a partially-written config.
 */
import { z } from "zod";

export const ExperimentalConfigSchema = z
  .object({
    /**
     * Allow `akm improve` to mutate assets without review.
     *
     * OFF by default. Gates memory-cleanup, memory-inference writes, and triage
     * `applyMode: "promote"`. Consolidation stays enabled because destructive
     * operations are advisory and promotion emits a reviewable proposal.
     * `akm improve` itself stays on either way — what this gates is autonomy,
     * not the feature.
     *
     * `sync.push` is deliberately NOT gated by this key: it publishes
     * already-committed content to a remote the user configured for that
     * purpose, and it has its own `sync.push: false` / `--no-push` controls.
     */
    improveAutonomy: z.boolean().optional(),

    /**
     * Allow the `akm workflow` native engine to run (Q-05).
     *
     * OFF by default. Gates `akm workflow run` (the native step-execution
     * engine) and `akm workflow brief`/`report` (the harness-neutral driver
     * protocol).
     *
     * Deliberately NOT gated: authoring/linting the unified markdown format
     * and the manual workflow CLI contract (`start`/`next`/`complete`/
     * `status`/`list`/`create`/`resume`/`abandon`) remain stable regardless of
     * this key.
     *
     * Unlike `improveAutonomy`, a gated call here REFUSES outright rather than
     * degrading: a workflow step either executes or it does not, so there is
     * no safe partial-execution fallback to fall back to.
     */
    workflowEngine: z.boolean().optional(),
  })
  .passthrough();
