// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Setup wizard step: enable/disable semantic search and decide whether to
 * prepare its assets now.
 */

import * as p from "../../cli/clack";
import type { AkmConfig, EmbeddingConnectionConfig } from "../../core/config/config";
import { prompt } from "../prompt";
import { describeSemanticSearchAssets, isRemoteEmbeddingConfig } from "../semantic-assets";

export interface SemanticSearchChoice {
  mode: "off" | "auto";
  prepareAssets: boolean;
}

export async function stepSemanticSearch(
  // Owner ruling 9 (R-039): the runtime default is "off" (a bare/headless
  // install must never silently pull the ~130 MB model), but the interactive
  // wizard pre-selects semantic search ON — a human is present to read the
  // warning below and decide. `_current` is intentionally unused for the
  // enable/disable pre-selection below: it must NOT track
  // `semanticSearchMode`, or this pre-selection would silently flip to off
  // along with the runtime default. Kept in the signature for call-site
  // stability (callers pass the in-progress setup config positionally).
  _current: AkmConfig,
  embedding?: EmbeddingConnectionConfig,
): Promise<SemanticSearchChoice> {
  // Show the warning (asset sizes; "no local model download" when a remote
  // embedding endpoint is configured) BEFORE the prompt so the pre-checked
  // default is an informed choice, not a surprise.
  p.note(describeSemanticSearchAssets(embedding).join("\n"), "Semantic Search Assets");

  const enabled = await prompt(() =>
    p.confirm({
      message: "Enable semantic search?",
      initialValue: true,
    }),
  );

  if (!enabled) {
    return { mode: "off", prepareAssets: false };
  }

  const prepareAssets = await prompt(() =>
    p.confirm({
      message: isRemoteEmbeddingConfig(embedding)
        ? "Check the embedding endpoint and verify semantic search now?"
        : "Download and verify semantic-search assets now?",
      initialValue: true,
    }),
  );

  return { mode: "auto", prepareAssets };
}
