// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm health` document renderers, registered rather than intercepted (D7).
 *
 * Before D7 `src/cli.ts` branched on `mode.format` inside the health command
 * and called `deliverRendered` itself, returning before `output()` was ever
 * reached. That made health the one command whose `md`/`html` output bypassed
 * the output pipeline, and it is why `html` had to be rejected for everything
 * else. Registering the same renderers here keeps the reports byte-identical
 * while leaving exactly one rendering path in the codebase.
 *
 * Both handlers return `null` for payload shapes they have nothing better to
 * say about, which falls through to the generic renderer — so `akm health`
 * without `--group-by run` or `--windows` still renders, it just renders
 * generically instead of emitting an empty table.
 */

import { renderHtml, resolveTemplatePath } from "../../output/html-render";
import { registerHtmlRenderer, registerMdRenderer } from "../../output/render-registry";
import { buildHealthHtmlReplacements } from "./html-report";
import { renderRunsDetailMd, renderWindowCompareMd } from "./md-report";
import type { AkmHealthResult } from "./types-result";

/**
 * Context the HTML report needs that the health result does not carry: the
 * window labels the user asked for and the pending-proposal queue.
 *
 * Set by the health command immediately before `output()` when the format is
 * `html`. Module state rather than a renderer parameter because the renderer
 * signature is shared by every command; health is the only command that needs
 * to bind anything, and the alternative — widening the signature for one
 * caller — would push health's shape into the pipeline the registry exists to
 * keep it out of.
 */
export interface HealthHtmlContext {
  window: string;
  compare: string;
  proposals: ReturnType<typeof import("../proposal/proposal").listPendingProposals>;
}

let htmlContext: HealthHtmlContext | undefined;

/** Bind the HTML report's out-of-band context for the next `output()` call. */
export function setHealthHtmlContext(context: HealthHtmlContext): void {
  htmlContext = context;
}

/** Clear the bound HTML context. Test-only utility. */
export function resetHealthHtmlContext(): void {
  htmlContext = undefined;
}

function isHealthResult(value: unknown): value is AkmHealthResult {
  return value !== null && typeof value === "object" && "status" in value;
}

registerMdRenderer("health", (result) => {
  if (!isHealthResult(result)) return null;
  if (result.windows && result.windows.length > 0) {
    return renderWindowCompareMd(result.windows, result.deltas);
  }
  if (result.runs) return renderRunsDetailMd(result.runs);
  return null;
});

registerHtmlRenderer("health", (result) => {
  if (!isHealthResult(result) || !htmlContext) return null;
  const replacements = buildHealthHtmlReplacements(result, {
    window: htmlContext.window,
    compare: htmlContext.compare,
    proposals: htmlContext.proposals,
    deltas: result.deltas,
  });
  return renderHtml(resolveTemplatePath("health"), replacements);
});
