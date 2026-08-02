// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Leaf types for the wiki-fetcher plugin contract (see
 * `sources/snapshot-fetchers/registry.ts`).
 *
 * Split out of `registry.ts` so that `youtube.ts` (a built-in fetcher that
 * `registry.ts` imports by value) does not need a type-only import back into
 * `registry.ts`.
 */

export interface WikiSnapshotResult {
  url: string;
  title: string;
  markdown: string;
  preferredName?: string;
  tags?: string[];
}

export interface FetcherContext {
  stashDir: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * Test-only: permit loopback/private hosts on this fetcher's outbound
   * requests. Mirrors the same hatch in the website crawler; production
   * callers never set it.
   */
  allowPrivateHosts?: boolean;
}

export interface WikiSnapshotFetcher {
  name: string;
  matches(url: URL, context: FetcherContext): boolean;
  fetch(url: URL, context: FetcherContext): Promise<WikiSnapshotResult | null>;
}
