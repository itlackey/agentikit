// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P1 — robots.txt compliance: loopback-fixture crawl integration tests.
 *
 * Authoritative spec: docs/plans/specs/p1-robots.md §4.6/§4.7. Row IDs in test
 * names (C-xx) refer to that spec's crawl-behavior table.
 *
 * Follows the fixture patterns in add-website-source.test.ts (Bun.serve
 * loopback fixture) and website-ssrf.test.ts (no real network, private-host
 * hatch). `ensureWebsiteMirror` is called in-process (as in
 * tests/integration/source-source.test.ts) rather than spawning the CLI, and
 * loopback hosts are allowed via the `allowPrivateHosts` test escape hatch
 * (never a raw `globalThis.fetch` swap or CLI network — the fixture server IS
 * the network boundary).
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { SourceConfigEntry } from "../../src/core/config/config";
import { UsageError } from "../../src/core/errors";
import { ensureWebsiteMirror, getWebsiteCachePaths } from "../../src/sources/snapshot-fetchers/website-ingest";

// ── Fixture server ───────────────────────────────────────────────────────────

interface FixtureRoute {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

interface RequestRecord {
  pathname: string;
  at: number;
}

interface FixtureServer {
  url: string;
  requestLog: RequestRecord[];
}

const servers: Array<{ stop: (force: boolean) => void }> = [];
const cacheRoots: string[] = [];

function startFixtureServer(opts: {
  robots: FixtureRoute | null;
  pages: Record<string, string | FixtureRoute>;
}): FixtureServer {
  const requestLog: RequestRecord[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requestLog.push({ pathname: url.pathname, at: Date.now() });

      if (url.pathname === "/robots.txt") {
        if (!opts.robots) return new Response("not found", { status: 404 });
        return new Response(opts.robots.body ?? "", {
          status: opts.robots.status ?? 200,
          headers: { "content-type": "text/plain", ...(opts.robots.headers ?? {}) },
        });
      }

      const page = opts.pages[url.pathname];
      if (page === undefined) return new Response("not found", { status: 404 });
      const route: FixtureRoute = typeof page === "string" ? { body: page } : page;
      return new Response(route.body ?? "", {
        status: route.status ?? 200,
        headers: { "content-type": "text/html; charset=utf-8", ...(route.headers ?? {}) },
      });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, requestLog };
}

/** Builds the minimal SourceConfigEntry shape ensureWebsiteMirror() reads. */
function websiteEntry(url: string, options?: Record<string, unknown>): SourceConfigEntry {
  return { type: "website", url, options } as SourceConfigEntry;
}

/**
 * True when some crawled page's own `sourceUrl:` frontmatter is `sourceUrl`.
 * Matches the exact frontmatter line (not just "the text appears somewhere"):
 * a page that merely LINKS to a disallowed URL renders that URL into its own
 * markdown body (see htmlToMarkdown's anchor handling), so a plain substring
 * search would false-positive on "the disallowed page was never crawled, but
 * another page mentions it."
 */
function stashContainsSourceUrl(stashDir: string, sourceUrl: string): boolean {
  const knowledgeDir = path.join(stashDir, "knowledge");
  if (!fs.existsSync(knowledgeDir)) return false;
  const frontmatterLine = `sourceUrl: ${JSON.stringify(sourceUrl)}`;
  return fs
    .readdirSync(knowledgeDir)
    .filter((name) => name.endsWith(".md"))
    .some((name) => fs.readFileSync(path.join(knowledgeDir, name), "utf8").includes(frontmatterLine));
}

/** Tracks a website cache root (keyed by URL) so afterEach can remove it. */
function trackCache(url: string): void {
  cacheRoots.push(getWebsiteCachePaths(url).rootDir);
}

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of cacheRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ── §4.6 crawlWebsite integration (via ensureWebsiteMirror) ─────────────────

describe("crawlWebsite robots.txt compliance", () => {
  test("C-02: a disallowed start URL throws UsageError before fetching any page", async () => {
    const { url, requestLog } = startFixtureServer({
      robots: { body: "User-agent: *\nDisallow: /\n" },
      pages: { "/": "<html><body>Home</body></html>" },
    });
    trackCache(url);
    const normalizedUrl = `${url}/`;
    const robotsUrl = `${url}/robots.txt`;

    let caught: unknown;
    try {
      await ensureWebsiteMirror(websiteEntry(url), { allowPrivateHosts: true });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(UsageError);
    const message = (caught as Error).message;
    expect(message).toContain(normalizedUrl);
    expect(message).toContain(robotsUrl);
    expect(message).toMatch(/respectRobots/);

    // No page was fetched — only /robots.txt.
    expect(requestLog.some((r) => r.pathname === "/")).toBe(false);
  });

  test("C-03: a 5xx robots.txt on the start origin also throws UsageError, naming the server error", async () => {
    const { url } = startFixtureServer({
      robots: { status: 500, body: "boom" },
      pages: { "/": "<html><body>Home</body></html>" },
    });
    trackCache(url);

    let caught: unknown;
    try {
      await ensureWebsiteMirror(websiteEntry(url), { allowPrivateHosts: true });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(UsageError);
    const message = (caught as Error).message;
    expect(message).toMatch(/respectRobots/);
    expect(message).toMatch(/server error|5\d\d/i);
  });

  test(
    "C-04/C-05/C-06: default respectRobots skips a disallowed page without fetching it and reads robots.txt " +
      "once; respectRobots:false fully bypasses it",
    async () => {
      const { url, requestLog } = startFixtureServer({
        robots: { body: "User-agent: *\nDisallow: /secret\n" },
        pages: {
          "/": '<html><body><a href="/secret">Secret</a> <a href="/public">Public</a></body></html>',
          "/secret": "<html><body>Secret content</body></html>",
          "/public": "<html><body>Public content</body></html>",
        },
      });
      trackCache(url);
      const secretUrl = `${url}/secret`;
      const publicUrl = `${url}/public`;

      const cachePaths = await ensureWebsiteMirror(websiteEntry(url), { allowPrivateHosts: true });

      // C-04: disallowed page is skipped without erroring, and never fetched.
      expect(stashContainsSourceUrl(cachePaths.stashDir, secretUrl)).toBe(false);
      expect(stashContainsSourceUrl(cachePaths.stashDir, publicUrl)).toBe(true);
      expect(requestLog.some((r) => r.pathname === "/secret")).toBe(false);

      // C-06: exactly one robots.txt request for the whole crawl.
      expect(requestLog.filter((r) => r.pathname === "/robots.txt")).toHaveLength(1);
      const robotsRequestsBeforeBypass = requestLog.filter((r) => r.pathname === "/robots.txt").length;

      // C-05: respectRobots:false is a full bypass — force a re-crawl of the
      // same origin (same cache key) and confirm it now includes the
      // previously-disallowed page, with zero additional /robots.txt requests.
      await ensureWebsiteMirror(websiteEntry(url, { respectRobots: false }), {
        allowPrivateHosts: true,
        force: true,
      });

      expect(stashContainsSourceUrl(cachePaths.stashDir, secretUrl)).toBe(true);
      const robotsRequestsAfterBypass = requestLog.filter((r) => r.pathname === "/robots.txt").length;
      expect(robotsRequestsAfterBypass).toBe(robotsRequestsBeforeBypass);
    },
  );

  test("C-06: robots.txt is fetched exactly once per origin no matter how many pages are crawled", async () => {
    const { url, requestLog } = startFixtureServer({
      robots: { body: "User-agent: *\n" }, // no Disallow lines => allow everything
      pages: {
        "/": '<html><body><a href="/page-1">1</a> <a href="/page-2">2</a> <a href="/page-3">3</a></body></html>',
        "/page-1": "<html><body>Page 1</body></html>",
        "/page-2": "<html><body>Page 2</body></html>",
        "/page-3": "<html><body>Page 3</body></html>",
      },
    });
    trackCache(url);

    await ensureWebsiteMirror(websiteEntry(url), { allowPrivateHosts: true });

    expect(requestLog.filter((r) => r.pathname === "/robots.txt")).toHaveLength(1);
    for (const p of ["/page-1", "/page-2", "/page-3"]) {
      expect(requestLog.filter((r) => r.pathname === p)).toHaveLength(1);
    }
  });

  test(
    "C-07/C-09: Crawl-delay spaces page fetches apart but does not delay the first fetch",
    async () => {
      const { url, requestLog } = startFixtureServer({
        // 150ms: small enough to keep the test fast, well above scheduler jitter.
        robots: { body: "User-agent: *\nCrawl-delay: 0.15\n" },
        pages: {
          "/": '<html><body><a href="/page-2">2</a></body></html>',
          "/page-2": "<html><body>Page 2</body></html>",
        },
      });
      trackCache(url);

      await ensureWebsiteMirror(websiteEntry(url), { allowPrivateHosts: true });

      const pageHits = requestLog.filter((r) => r.pathname === "/" || r.pathname === "/page-2");
      const [firstHit, secondHit] = pageHits;
      if (!firstHit || !secondHit) {
        throw new Error(`expected exactly 2 page fetches, got ${pageHits.length}`);
      }
      const gapMs = secondHit.at - firstHit.at;
      expect(gapMs).toBeGreaterThanOrEqual(100);
    },
    { timeout: 15_000 },
  );
});
