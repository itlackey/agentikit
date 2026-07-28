// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Source provider factory map.
 *
 * Maps source kind identifiers (e.g. "filesystem", "git", "website", "npm")
 * to factory functions that build {@link SourceProvider} instances from a
 * {@link SourceConfigEntry}.
 *
 * Distinct from the registry-discovery factory (`registry/factory.ts`).
 * Both share `create-provider-registry.ts` for the underlying string→factory
 * map.
 */

import { createProviderRegistry } from "../registry/create-provider-registry";
import type { SourceProviderFactory } from "./provider";
import type { SourceKind } from "./types";

// ── Factory map ─────────────────────────────────────────────────────────────

const registry = createProviderRegistry<SourceProviderFactory>();

export function registerSourceProvider(type: SourceKind, factory: SourceProviderFactory): void {
  registry.register(type, factory);
}

export function resolveSourceProviderFactory(type: string): SourceProviderFactory | null {
  return registry.resolve(type);
}
