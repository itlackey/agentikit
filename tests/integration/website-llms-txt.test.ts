// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * llms.txt-aware website ingestion (issue #749).
 *
 * Unit tests for the pure parser (`parseLlmsTxtLinks`) and the root-URL gate
 * (`isOriginRootUrl`), plus loopback-fixture integration tests proving: the
 * manifest is used as the crawl frontier when present, off-origin manifest
 * links are dropped, the probe does not fire for a non-root start URL, and a
 * site with no llms.txt falls through to the crawler completely unchanged.
 *
 * Follows the Bun.serve loopback fixture pattern from
 * website-robots-crawl.test.ts / add-website-source.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { SourceConfigEntry } from "../../src/core/config/config";
import { _setWarnSinkForTests } from "../../src/core/warn";
import {
  ensureWebsiteMirror,
  getWebsiteCachePaths,
  isOriginRootUrl,
  parseLlmsTxtLinks,
} from "../../src/sources/snapshot-fetchers/website-ingest";
import { overrideSeam } from "../_helpers/seams";

// ── Unit tests: parseLlmsTxtLinks ────────────────────────────────────────────

describe("parseLlmsTxtLinks", () => {
  test("parses `- [title](path) - description` list items", () => {
    const text = [
      "# Example Docs",
      "",
      "> A summary line, not a link.",
      "",
      "## Guides",
      "",
      "- [Getting Started](/guides/start) - How to begin",
      "- [Advanced](/guides/advanced): colon-separated notes also work",
      "- [No description](/guides/bare)",
    ].join("\n");

    const links = parseLlmsTxtLinks(text, "https://docs.example.com/llms.txt");

    expect(links.map((l) => l.toString())).toEqual([
      "https://docs.example.com/guides/start",
      "https://docs.example.com/guides/advanced",
      "https://docs.example.com/guides/bare",
    ]);
  });

  test("resolves relative paths against the manifest URL", () => {
    const links = parseLlmsTxtLinks("- [Page](page.html) - notes", "https://docs.example.com/nested/llms.txt");
    expect(links.map((l) => l.toString())).toEqual(["https://docs.example.com/nested/page.html"]);
  });

  test("ignores non-link lines: headings, prose, blank lines", () => {
    const text = ["# Title", "", "Some prose that is not a list item.", "## Section", "- not a markdown link"].join(
      "\n",
    );
    expect(parseLlmsTxtLinks(text, "https://docs.example.com/llms.txt")).toEqual([]);
  });

  test("drops non-http(s) link targets", () => {
    const text = "- [Mail](mailto:hello@example.com) - contact\n- [Page](/ok) - fine";
    const links = parseLlmsTxtLinks(text, "https://docs.example.com/llms.txt");
    expect(links.map((l) => l.toString())).toEqual(["https://docs.example.com/ok"]);
  });

  test("dedupes repeated link targets", () => {
    const text = "- [A](/dup) - one\n- [B](/dup) - two";
    const links = parseLlmsTxtLinks(text, "https://docs.example.com/llms.txt");
    expect(links).toHaveLength(1);
  });
});

// ── Unit tests: isOriginRootUrl ──────────────────────────────────────────────

describe("isOriginRootUrl", () => {
  test("true for an origin root with no path or query", () => {
    expect(isOriginRootUrl(new URL("https://docs.example.com/"))).toBe(true);
  });

  test("false for a deep path", () => {
    expect(isOriginRootUrl(new URL("https://docs.example.com/guides/foo"))).toBe(false);
  });

  test("false for the root path with a query string", () => {
    expect(isOriginRootUrl(new URL("https://docs.example.com/?ref=x"))).toBe(false);
  });
});

// ── Integration: ensureWebsiteMirror probing /llms.txt ──────────────────────

interface FixtureRoute {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

interface RequestRecord {
  pathname: string;
}

interface FixtureServer {
  url: string;
  requestLog: RequestRecord[];
}

const servers: Array<{ stop: (force: boolean) => void }> = [];
const cacheRoots: string[] = [];

function startFixtureServer(opts: {
  robots?: FixtureRoute | null;
  pages: Record<string, string | FixtureRoute>;
}): FixtureServer {
  const requestLog: RequestRecord[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requestLog.push({ pathname: url.pathname });

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
      const isLlmsTxt = url.pathname === "/llms.txt";
      return new Response(route.body ?? "", {
        status: route.status ?? 200,
        headers: {
          "content-type": isLlmsTxt ? "text/plain; charset=utf-8" : "text/html; charset=utf-8",
          ...(route.headers ?? {}),
        },
      });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, requestLog };
}

function websiteEntry(url: string, options?: Record<string, unknown>): SourceConfigEntry {
  return { type: "website", url, options } as SourceConfigEntry;
}

function stashPages(stashDir: string): string[] {
  const knowledgeDir = path.join(stashDir, "knowledge");
  if (!fs.existsSync(knowledgeDir)) return [];
  const found: string[] = [];
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (entry.name.endsWith(".md")) found.push(fs.readFileSync(entryPath, "utf8"));
    }
  }
  walk(knowledgeDir);
  return found;
}

function trackCache(url: string): void {
  cacheRoots.push(getWebsiteCachePaths(url).rootDir);
}

let warnCalls: string[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of cacheRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  warnCalls = [];
});

describe("ensureWebsiteMirror: llms.txt manifest fast path", () => {
  test("uses the llms.txt manifest as the crawl frontier instead of BFS link discovery", async () => {
    overrideSeam(_setWarnSinkForTests, (level, args) => {
      if (level === "warn") warnCalls.push(args.map(String).join(" "));
    });

    const { url, requestLog } = startFixtureServer({
      pages: {
        "/": '<html><body><a href="/should-not-be-discovered">nope</a></body></html>',
        "/llms.txt": [
          "# Example Docs",
          "",
          "- [Guide One](/guide-one) - the first guide",
          "- [Guide Two](/guide-two) - the second guide",
        ].join("\n"),
        "/guide-one": "<html><head><title>Guide One</title></head><body>Guide one content</body></html>",
        "/guide-two": "<html><head><title>Guide Two</title></head><body>Guide two content</body></html>",
        "/should-not-be-discovered": "<html><body>should not be fetched</body></html>",
      },
    });
    trackCache(url);

    const cachePaths = await ensureWebsiteMirror(websiteEntry(url), { allowPrivateHosts: true });
    const pages = stashPages(cachePaths.stashDir);

    // Both manifest-listed pages were ingested.
    expect(pages.some((p) => p.includes(`${url}/guide-one`))).toBe(true);
    expect(pages.some((p) => p.includes(`${url}/guide-two`))).toBe(true);

    // The root page's own HTML link was never followed: the manifest
    // replaced link discovery, it didn't supplement it.
    expect(requestLog.some((r) => r.pathname === "/should-not-be-discovered")).toBe(false);

    // The manifest path was probed and logged.
    expect(requestLog.some((r) => r.pathname === "/llms.txt")).toBe(true);
    expect(warnCalls.some((m) => m.includes("Using llms.txt manifest from") && m.includes("/llms.txt"))).toBe(true);
  });

  test("drops off-origin links named in the manifest", async () => {
    const { url, requestLog } = startFixtureServer({
      pages: {
        "/": "<html><body>home</body></html>",
        "/llms.txt": [
          "- [Same origin](/same-origin) - kept",
          "- [Other host](https://evil.example.com/steal) - dropped",
        ].join("\n"),
        "/same-origin": "<html><body>kept content</body></html>",
      },
    });
    trackCache(url);

    const cachePaths = await ensureWebsiteMirror(websiteEntry(url), { allowPrivateHosts: true });
    const pages = stashPages(cachePaths.stashDir);

    expect(pages.some((p) => p.includes(`${url}/same-origin`))).toBe(true);
    // The off-origin manifest link must never be fetched or ingested at all.
    expect(pages.some((p) => p.includes("evil.example.com"))).toBe(false);
    expect(requestLog.some((r) => r.pathname === "/steal")).toBe(false);
  });

  test("does not probe llms.txt for a non-root start URL", async () => {
    const { url, requestLog } = startFixtureServer({
      pages: {
        "/guides/foo": "<html><body>the specific page the user asked for</body></html>",
        "/llms.txt": "- [Whole site](/should-not-be-reached) - manifest",
      },
    });
    trackCache(`${url}/guides/foo`);

    await ensureWebsiteMirror(websiteEntry(`${url}/guides/foo`), { allowPrivateHosts: true });

    expect(requestLog.some((r) => r.pathname === "/llms.txt")).toBe(false);
  });

  test("a site with no llms.txt falls through to the crawler completely unchanged", async () => {
    const { url, requestLog } = startFixtureServer({
      pages: {
        "/": '<html><body><a href="/about">About</a></body></html>',
        "/about": "<html><body>About page</body></html>",
      },
    });
    trackCache(url);

    const cachePaths = await ensureWebsiteMirror(websiteEntry(url), { allowPrivateHosts: true });
    const pages = stashPages(cachePaths.stashDir);

    expect(pages.some((p) => p.includes(`${url}/`))).toBe(true);
    expect(pages.some((p) => p.includes(`${url}/about`))).toBe(true);
    // /llms.txt was probed (404) but the crawl proceeded via normal BFS.
    expect(requestLog.some((r) => r.pathname === "/llms.txt")).toBe(true);
    expect(requestLog.some((r) => r.pathname === "/about")).toBe(true);
  });
});
