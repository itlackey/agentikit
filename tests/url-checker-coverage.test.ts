// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #892 — `checkDeadUrls` must report what it did NOT check.
 *
 * The old implementation applied `MAX_URLS = 20` plus a second, undocumented
 * `slice(0, 3)` per entry, and returned a bare `DeadUrl[]`. A bundle with
 * thousands of links therefore produced "0 dead URLs" after examining at most
 * twenty of them, and the caller logged that as a completed check. A health
 * check that silently examines a fraction and reports success is worse than
 * one that does not run, because it is trusted.
 *
 * The bound itself is fine — every URL is a real network round trip. These
 * tests pin the two things that were missing: the coverage numbers come back,
 * and the ceiling is overridable.
 *
 * `fetch` is stubbed, so this file makes no network calls and belongs in the
 * unit tree per the AGENTS.md classification rule.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { checkDeadUrls, DEFAULT_MAX_URLS } from "../src/commands/url-checker";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub every request with `status`, recording each URL requested. */
function stubFetch(status: number): string[] {
  const requested: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    requested.push(String(input));
    return new Response(null, { status });
  }) as typeof fetch;
  return requested;
}

/** One entry whose body holds `count` distinct URLs. */
function entryWithUrls(count: number): { ref: string; body: string } {
  const urls = Array.from({ length: count }, (_, i) => `https://example.invalid/p${i}`);
  return { ref: "knowledge/many-links", body: urls.join("\n") };
}

describe("checkDeadUrls reports coverage, not just findings (#892)", () => {
  test("truncation is reported: found exceeds checked", async () => {
    stubFetch(200);

    const report = await checkDeadUrls("/unused", [entryWithUrls(50)]);

    expect(report.found).toBe(50);
    expect(report.checked).toBe(DEFAULT_MAX_URLS);
    // The whole point: a caller can SEE that 30 links went unexamined rather
    // than reading `dead: []` as an all-clear.
    expect(report.found - report.checked).toBe(30);
    expect(report.dead).toEqual([]);
  });

  test("the ceiling is overridable", async () => {
    const requested = stubFetch(200);

    const report = await checkDeadUrls("/unused", [entryWithUrls(50)], { maxUrls: 40 });

    expect(report.checked).toBe(40);
    expect(requested).toHaveLength(40);
  });

  test("no truncation when everything fits — found equals checked", async () => {
    stubFetch(200);

    const report = await checkDeadUrls("/unused", [entryWithUrls(5)]);

    expect(report.found).toBe(5);
    expect(report.checked).toBe(5);
  });

  test("every URL in an entry is eligible, not just the first three", async () => {
    // The old code took `matches.slice(0, 3)` per entry, so a single document
    // with ten links had seven of them silently ignored even when the global
    // ceiling had room to spare.
    const requested = stubFetch(200);

    const report = await checkDeadUrls("/unused", [entryWithUrls(10)]);

    expect(report.checked).toBe(10);
    expect(requested).toContain("https://example.invalid/p9");
  });

  test("a 4xx is still reported dead", async () => {
    stubFetch(404);

    const report = await checkDeadUrls("/unused", [entryWithUrls(2)]);

    expect(report.dead).toHaveLength(2);
    expect(report.dead[0]).toMatchObject({ ref: "knowledge/many-links", status: 404 });
  });
});
