// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Per-command `md` / `html` renderer registries (D7).
 *
 * Mirrors `src/output/text/registry.ts`: a command may register a bespoke
 * renderer for a document format, and anything unregistered falls back to the
 * generic rendering of its shaped envelope (`./generic-render`). The fallback
 * is what makes all six `--format` values universal; the registry is what lets
 * a command that has something better to say — `akm health` and its report
 * templates — say it without the output pipeline knowing that command exists.
 *
 * Kept separate from the module that dispatches through it so per-command
 * renderer modules can import `registerMdRenderer` / `registerHtmlRenderer`
 * without a cycle back into the pipeline, exactly as the text registry does.
 *
 * Returning `null` from a handler means "I have nothing special for this
 * payload" and falls through to the generic renderer — `akm health` uses that
 * to keep its bespoke tables for the shapes that have them while still
 * rendering everything else.
 */

import { createCommandRegistry } from "./command-registry";
import type { DetailLevel } from "./context";

/**
 * Handler signature for a registered document-format renderer.
 *
 * Return a rendered string, or `null` to fall through to the generic renderer.
 */
export type DocumentRendererHandler = (result: unknown, detail: DetailLevel) => string | null;

const MD_RENDERER_REGISTRY = createCommandRegistry<DocumentRendererHandler>();
const HTML_RENDERER_REGISTRY = createCommandRegistry<DocumentRendererHandler>();

/** Register a Markdown renderer for a command name. */
export function registerMdRenderer(command: string, handler: DocumentRendererHandler): void {
  MD_RENDERER_REGISTRY.register(command, handler);
}

/** Look up a registered Markdown renderer, or `undefined` when unregistered. */
export function getMdRendererHandler(command: string): DocumentRendererHandler | undefined {
  return MD_RENDERER_REGISTRY.get(command);
}

/** Register an HTML renderer for a command name. */
export function registerHtmlRenderer(command: string, handler: DocumentRendererHandler): void {
  HTML_RENDERER_REGISTRY.register(command, handler);
}

/** Look up a registered HTML renderer, or `undefined` when unregistered. */
export function getHtmlRendererHandler(command: string): DocumentRendererHandler | undefined {
  return HTML_RENDERER_REGISTRY.get(command);
}
