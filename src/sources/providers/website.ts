// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { SyncOptions } from "../provider";
import { registerSourceProvider } from "../provider-factory";
import {
  ensureWebsiteMirror,
  getWebsiteCachePaths,
  shouldAllowPrivateWebsiteUrlForTests,
  validateWebsiteUrl,
} from "../snapshot-fetchers/website-ingest";

/**
 * Website source provider — thin adapter over the shared website ingest module.
 */
registerSourceProvider("website", (config) => {
  const allowPrivateHosts = shouldAllowPrivateWebsiteUrlForTests(config.url ?? "");
  const url = validateWebsiteUrl(config.url ?? "", { allowPrivateHosts });
  const name = config.name ?? "website";
  return {
    kind: "website" as const,
    name,
    path() {
      return getWebsiteCachePaths(url).rootDir;
    },
    async sync(options?: SyncOptions) {
      await ensureWebsiteMirror(config, {
        requireStashDir: true,
        force: options?.force,
        // Feed the resolver into the EXISTING website-ingest plumbing that
        // already threads `resolveSecret` down to `FetcherContext`. This is the
        // line that closes the bundle-update / sync() gap: previously the X
        // fetcher on this path saw only `X_BEARER_TOKEN`, never the store.
        ...(options?.secrets ? { resolveSecret: options.secrets.resolveSecret } : {}),
        ...(allowPrivateHosts ? { allowPrivateHosts: true } : {}),
      });
    },
  };
});
