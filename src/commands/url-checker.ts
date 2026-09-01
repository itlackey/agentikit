// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { DeadUrl } from "../core/improve-types";

export type { DeadUrl };

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;

/**
 * Check every URL in `entries` and report the ones that are dead.
 *
 * No cap, no per-entry slice, no ceiling option. There used to be a
 * `MAX_URLS = 20` plus an undocumented `slice(0, 3)` per entry, so this
 * examined at most twenty links in a bundle holding thousands and reported
 * success. The first attempt at fixing that kept the cap and layered a
 * coverage report, a warning, and an override on top — a constraint plus more
 * code to explain the constraint. Both are gone. It checks what you asked it
 * to check.
 *
 * A request that fails, times out, or cannot resolve surfaces as a `DeadUrl`
 * rather than being swallowed, so a network problem is visible instead of
 * looking like a clean bill of health.
 */
export async function checkDeadUrls(
  _stashDir: string,
  entries: Array<{ ref: string; body: string }>,
): Promise<DeadUrl[]> {
  const urlsToCheck = entries.flatMap((entry) =>
    (entry.body.match(URL_RE) ?? []).map((url) => ({ ref: entry.ref, url })),
  );

  const results: DeadUrl[] = [];
  await Promise.allSettled(
    urlsToCheck.map(async ({ ref, url }) => {
      try {
        const res = await fetch(url, { method: "HEAD", redirect: "follow" });
        if (res.status >= 400) results.push({ ref, url, status: res.status });
      } catch (e) {
        results.push({ ref, url, status: "error" });
      }
    }),
  );

  return results;
}
