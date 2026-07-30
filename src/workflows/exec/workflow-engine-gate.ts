// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `akm workflow` engine gate (`experimental.workflowEngine`, Q-05).
 *
 * Mirrors the shape of `src/commands/improve/autonomy-gate.ts` (D8) for a
 * different failure mode. `akm improve`'s gated lanes have a safe downgrade —
 * skip the lane, keep the rest of the run going — but a workflow step either
 * executes or it does not: there is no partial-execution fallback to degrade
 * into. So this gate REFUSES outright rather than silently skipping: an
 * ungated call throws a classified `ConfigError` naming the exact config key,
 * which the CLI's JSON error envelope (`emitJsonError`, `src/cli/shared.ts`)
 * always routes to stderr with a non-zero exit — in every `--format`, not
 * just `json` — so the refusal is visible and never a silent no-op. (A
 * second, plain-text `warn()` call alongside the throw was deliberately
 * rejected: it would interleave non-JSON text with the JSON error envelope on
 * the SAME stream, corrupting stderr for any `--json` caller — a real defect,
 * not just a test inconvenience.)
 *
 * Gated surfaces:
 *  - `akm workflow run`    — the native step-execution engine
 *  - `akm workflow brief`  — the harness-neutral driver protocol (read half)
 *  - `akm workflow report` — the harness-neutral driver protocol (write half)
 *
 * Deliberately NOT gated: authoring/linting the unified markdown format and
 * the manual workflow CLI contract (`start`, `next`, `complete`, `status`,
 * `list`, `create`, `resume`, `abandon`) remain stable per STABILITY.md.
 */

import { ConfigError } from "../../core/errors";

/**
 * The config key an operator sets to enable the workflow engine.
 *
 * Named rather than inlined because it is user-facing text: it goes into the
 * thrown error's message and `akm task doctor`, and those must name the same
 * key as the schema.
 */
export const WORKFLOW_ENGINE_CONFIG_KEY = "experimental.workflowEngine";

/**
 * The minimum config shape this gate needs. Deliberately NOT a `Pick` off the
 * full `AkmConfig` — that would make the property required, forcing every
 * caller holding a partial config (tests, doctor) to supply it.
 */
export interface WorkflowEngineConfigHolder {
  experimental?: { workflowEngine?: boolean | undefined } | undefined;
}

/**
 * True only when the user has explicitly opted into the workflow engine.
 * Absent, an absent `experimental` section, and an explicit `false` all read
 * as off — the engine is never enabled by inference.
 */
export function isWorkflowEngineEnabled(config: WorkflowEngineConfigHolder | undefined): boolean {
  return config?.experimental?.workflowEngine === true;
}

/** The message shown to the user AND matched by tests naming the config key. */
export function workflowEngineGateMessage(surface: string): string {
  return (
    `\`akm workflow ${surface}\` is EXPERIMENTAL and refuses to run until ` +
    `\`${WORKFLOW_ENGINE_CONFIG_KEY}\` is set. Run \`akm config set ${WORKFLOW_ENGINE_CONFIG_KEY} true\` to enable it.`
  );
}

/**
 * Refuse a gated workflow-engine surface unless the opt-in is set.
 *
 * `surface` is the human name of the subcommand/action being refused (e.g.
 * `"run"`, `"brief"`, `"create <name>.yaml"`) — it is folded into the thrown
 * error's message so the refusal names both the surface and the exact config
 * key that would enable it. The throw alone is the whole mechanism: every
 * command defined with `defineJsonCommand` routes an uncaught throw through
 * `runWithJsonErrors`/`emitJsonError`, which prints the error to stderr and
 * exits non-zero regardless of `--format` — so this is never a silent no-op.
 */
export function requireWorkflowEngineEnabled(config: WorkflowEngineConfigHolder | undefined, surface: string): void {
  if (isWorkflowEngineEnabled(config)) return;
  throw new ConfigError(workflowEngineGateMessage(surface), "WORKFLOW_ENGINE_NOT_ENABLED");
}
