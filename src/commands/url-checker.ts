// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { warn } from "../core/warn";

export interface DeadUrl {
  ref: string;
  url: string;
  status: number | "timeout" | "error";
}

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;
const TIMEOUT_MS = 5000;

/**
 * Default ceiling on how many URLs one call will actually request.
 *
 * Unlike a purely local cap, a bound here is defensible: every URL is a real
 * network round trip, and a large bundle can hold thousands. What was NOT
 * defensible (#892) is that the old `MAX_URLS = 20` was unreachable from any
 * flag, applied a second undocumented `slice(0, 3)` per entry, and reported
 * nothing when it truncated — so a clean dead-link result on a big bundle
 * meant "the first 20 URLs are fine", while the caller logged it as though the
 * whole bundle had been checked. A health check that quietly examines 20 of
 * 4,000 links and reports success is worse than one that does not run.
 *
 * The bound stays; the silence does not. Callers get the coverage numbers back
 * and a warning fires whenever anything was skipped.
 */
export const DEFAULT_MAX_URLS = 20;

/** What one {@link checkDeadUrls} call actually covered. */
export interface DeadUrlReport {
  dead: DeadUrl[];
  /** URLs discovered across every entry. */
  found: number;
  /** URLs actually requested — less than `found` when the cap truncated. */
  checked: number;
}

export async function checkDeadUrls(
  _stashDir: string,
  entries: Array<{ ref: string; body: string }>,
  options: { maxUrls?: number } = {},
): Promise<DeadUrlReport> {
  const maxUrls = options.maxUrls ?? DEFAULT_MAX_URLS;
  const urlsToCheck: Array<{ ref: string; url: string }> = [];
  let found = 0;

  for (const entry of entries) {
    const matches = entry.body.match(URL_RE) ?? [];
    found += matches.length;
    for (const url of matches) {
      if (urlsToCheck.length >= maxUrls) continue;
      urlsToCheck.push({ ref: entry.ref, url });
    }
  }

  if (found > urlsToCheck.length) {
    warn(
      `url check: ${found} URLs found, only ${urlsToCheck.length} checked (limit ${maxUrls}). ` +
        "Dead links beyond the limit were NOT detected — this result does not clear the rest of the bundle.",
    );
  }

  const results: DeadUrl[] = [];
  await Promise.allSettled(
    urlsToCheck.map(async ({ ref, url }) => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        const res = await fetch(url, {
          method: "HEAD",
          signal: controller.signal,
          redirect: "follow",
        });
        clearTimeout(timer);
        if (res.status >= 400) {
          results.push({ ref, url, status: res.status });
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          results.push({ ref, url, status: "timeout" });
        }
        // network errors (ENOTFOUND etc.) — skip, don't report as dead
      }
    }),
  );

  return { dead: results, found, checked: urlsToCheck.length };
}
