// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P3/P4/P5 — RSS, Bluesky, and X snapshot fetchers.
 *
 * Covers URL matching, parsing across feed dialects, the fall-through contract
 * (a fetcher returning null hands the URL back to the generic website crawler),
 * and — for X — that the bearer token never reaches snapshot output or logs.
 *
 * All HTTP goes through withMockedFetch; no real network, no real DNS.
 */
import { afterEach, describe, expect, test } from "bun:test";
import blueskyFetcher, { extractBlueskyHandle } from "../src/sources/snapshot-fetchers/bluesky";
import rssFetcher, { parseFeed } from "../src/sources/snapshot-fetchers/rss";
import type { FetcherContext } from "../src/sources/snapshot-fetchers/types";
import xFetcher, { buildXRssUrl, extractXUsername } from "../src/sources/snapshot-fetchers/x";
import { withMockedFetch } from "./_helpers/sandbox";

const CTX: FetcherContext = { stashDir: "", timeoutMs: 5_000 };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function xmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/xml" } });
}

const RSS2 = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Example Blog</title>
  <item>
    <title>First post</title>
    <link>https://blog.example/1</link>
    <pubDate>Tue, 01 Apr 2025 10:00:00 GMT</pubDate>
    <description>&lt;p&gt;Body &lt;b&gt;one&lt;/b&gt;.&lt;/p&gt;</description>
  </item>
  <item>
    <title>Second post</title>
    <link>https://blog.example/2</link>
    <description><![CDATA[<p>Body two.</p>]]></description>
  </item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  <entry>
    <title>Atom entry</title>
    <link rel="alternate" href="https://atom.example/a"/>
    <updated>2025-04-01T10:00:00Z</updated>
    <summary>Atom summary.</summary>
  </entry>
</feed>`;

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <channel><title>RDF Feed</title></channel>
  <item>
    <title>RDF item</title>
    <link>https://rdf.example/1</link>
    <description>RDF body.</description>
  </item>
</rdf:RDF>`;

describe("RSS fetcher — matching", () => {
  test.each([
    ["https://blog.example/feed", true],
    ["https://blog.example/rss", true],
    ["https://blog.example/index.xml", true],
    ["https://blog.example/posts.rss", true],
    ["https://blog.example/atom.atom", true],
    ["https://blog.example/articles", false],
    ["https://blog.example/", false],
  ])("%s -> %s", (href, expected) => {
    expect(rssFetcher.matches(new URL(href), CTX)).toBe(expected);
  });

  test("non-http(s) URLs never match", () => {
    expect(rssFetcher.matches(new URL("ftp://blog.example/feed"), CTX)).toBe(false);
  });
});

describe("RSS fetcher — parsing dialects", () => {
  test("RSS 2.0: items, ISO dates, HTML stripped from descriptions", () => {
    const feed = parseFeed(RSS2);
    expect(feed?.title).toBe("Example Blog");
    expect(feed?.items).toHaveLength(2);
    expect(feed?.items[0]?.title).toBe("First post");
    expect(feed?.items[0]?.date).toBe("2025-04-01T10:00:00.000Z");
    expect(feed?.items[0]?.summary).toBe("Body one .");
    expect(feed?.items[0]?.summary).not.toContain("<");
  });

  test("CDATA sections are unwrapped and stripped", () => {
    expect(parseFeed(RSS2)?.items[1]?.summary).toBe("Body two.");
  });

  test("Atom: attribute-shaped alternate links are resolved", () => {
    const feed = parseFeed(ATOM);
    expect(feed?.title).toBe("Atom Feed");
    expect(feed?.items[0]?.link).toBe("https://atom.example/a");
    expect(feed?.items[0]?.date).toBe("2025-04-01T10:00:00.000Z");
  });

  test("RDF / RSS 1.0: root-level items are found", () => {
    const feed = parseFeed(RDF);
    expect(feed?.title).toBe("RDF Feed");
    expect(feed?.items[0]?.title).toBe("RDF item");
  });

  test("item limit is honored", () => {
    expect(parseFeed(RSS2, 1)?.items).toHaveLength(1);
  });

  test("non-feed XML and malformed input return null", () => {
    expect(parseFeed("<html><body>not a feed</body></html>")).toBeNull();
    expect(parseFeed("")).toBeNull();
  });

  test("undated items do not emit an Invalid Date", () => {
    expect(parseFeed(RSS2)?.items[1]?.date).toBe("");
  });
});

describe("RSS fetcher — fetch contract", () => {
  test("produces a snapshot with feed tags and a feeds/ preferred name", async () => {
    const snapshot = await withMockedFetch(
      () => rssFetcher.fetch(new URL("https://blog.example/feed"), CTX),
      async () => xmlResponse(RSS2),
    );
    expect(snapshot?.title).toBe("Example Blog");
    expect(snapshot?.preferredName).toBe("feeds/blog.example-feed");
    expect(snapshot?.tags).toContain("rss");
    expect(snapshot?.markdown).toContain("## First post");
    expect(snapshot?.markdown).toContain("https://blog.example/1");
  });

  test("HTML served at a feed-shaped URL falls through to the crawler", async () => {
    const snapshot = await withMockedFetch(
      () => rssFetcher.fetch(new URL("https://blog.example/feed"), CTX),
      async () => new Response("<html><body>Hi</body></html>", { headers: { "content-type": "text/html" } }),
    );
    expect(snapshot).toBeNull();
  });

  test("a non-OK response falls through rather than throwing", async () => {
    const snapshot = await withMockedFetch(
      () => rssFetcher.fetch(new URL("https://blog.example/feed"), CTX),
      async () => xmlResponse("", 500),
    );
    expect(snapshot).toBeNull();
  });
});

describe("Bluesky fetcher — handle extraction", () => {
  test.each([
    ["https://bsky.app/profile/alice.bsky.social", "alice.bsky.social"],
    ["https://www.bsky.app/profile/@bob.example", "bob.example"],
  ])("%s -> %s", (href, expected) => {
    expect(extractBlueskyHandle(new URL(href))).toBe(expected);
  });

  test.each([
    "https://bsky.app/",
    "https://bsky.app/profile",
    "https://bsky.app/profile/alice.bsky.social/post/abc",
    "https://example.com/profile/alice",
  ])("%s is not a profile root", (href) => {
    expect(extractBlueskyHandle(new URL(href))).toBeNull();
  });
});

describe("Bluesky fetcher — fetch contract", () => {
  const FEED = {
    feed: [
      {
        post: {
          uri: "at://did:plc:xyz/app.bsky.feed.post/abc123",
          likeCount: 5,
          repostCount: 2,
          record: { text: "Hello from Bluesky", createdAt: "2025-04-01T10:00:00Z" },
        },
      },
    ],
  };

  test("resolves the handle then renders the author feed", async () => {
    const snapshot = await withMockedFetch(
      () => blueskyFetcher.fetch(new URL("https://bsky.app/profile/alice.bsky.social"), CTX),
      async (input) => {
        const url = String(input);
        if (url.includes("resolveHandle")) return jsonResponse({ did: "did:plc:xyz" });
        if (url.includes("getAuthorFeed")) return jsonResponse(FEED);
        return jsonResponse({}, 404);
      },
    );
    expect(snapshot?.preferredName).toBe("bluesky/alice.bsky.social");
    expect(snapshot?.tags).toContain("bluesky");
    expect(snapshot?.markdown).toContain("Hello from Bluesky");
    expect(snapshot?.markdown).toContain("https://bsky.app/profile/alice.bsky.social/post/abc123");
    expect(snapshot?.markdown).toContain("5 likes, 2 reposts");
  });

  test("an unresolvable handle falls through", async () => {
    const snapshot = await withMockedFetch(
      () => blueskyFetcher.fetch(new URL("https://bsky.app/profile/ghost.example"), CTX),
      async () => jsonResponse({}, 400),
    );
    expect(snapshot).toBeNull();
  });

  test("an empty feed falls through rather than emitting a blank snapshot", async () => {
    const snapshot = await withMockedFetch(
      () => blueskyFetcher.fetch(new URL("https://bsky.app/profile/alice.bsky.social"), CTX),
      async (input) =>
        String(input).includes("resolveHandle") ? jsonResponse({ did: "did:plc:xyz" }) : jsonResponse({ feed: [] }),
    );
    expect(snapshot).toBeNull();
  });

  test("the feed request never exceeds the API's limit of 100", async () => {
    const seen: string[] = [];
    await withMockedFetch(
      () => blueskyFetcher.fetch(new URL("https://bsky.app/profile/alice.bsky.social"), CTX),
      async (input) => {
        seen.push(String(input));
        return String(input).includes("resolveHandle") ? jsonResponse({ did: "did:plc:xyz" }) : jsonResponse(FEED);
      },
    );
    const feedUrl = seen.find((u) => u.includes("getAuthorFeed")) ?? "";
    const limit = Number(new URL(feedUrl).searchParams.get("limit"));
    expect(limit).toBeLessThanOrEqual(100);
  });
});

describe("X fetcher — username extraction", () => {
  test.each([
    ["https://x.com/jack", "jack"],
    ["https://twitter.com/jack", "jack"],
    ["https://www.x.com/@jack", "jack"],
  ])("%s -> %s", (href, expected) => {
    expect(extractXUsername(new URL(href))).toBe(expected);
  });

  test.each([
    "https://x.com/",
    "https://x.com/jack/status/123",
    "https://x.com/i/flow/login",
    "https://x.com/home",
    "https://x.com/search",
    "https://example.com/jack",
    "https://x.com/way_too_long_username_here",
  ])("%s is not a profile", (href) => {
    expect(extractXUsername(new URL(href))).toBeNull();
  });
});

describe("X fetcher — RSS template fallback", () => {
  test("substitutes {username} and requires http(s)", () => {
    expect(buildXRssUrl("https://nitter.example/{username}/rss", "jack")?.toString()).toBe(
      "https://nitter.example/jack/rss",
    );
    expect(buildXRssUrl("javascript:alert(1)", "jack")).toBeNull();
    expect(buildXRssUrl(undefined, "jack")).toBeNull();
    expect(buildXRssUrl("   ", "jack")).toBeNull();
  });

  test("usernames are URL-encoded into the template", () => {
    // extractXUsername already restricts the charset; this guards the helper
    // itself against injection if it is ever called with looser input.
    expect(buildXRssUrl("https://n.example/{username}/rss", "a/b")?.pathname).toBe("/a%2Fb/rss");
  });
});

describe("X fetcher — token handling", () => {
  const ORIGINAL_TOKEN = process.env.X_BEARER_TOKEN;
  const ORIGINAL_TEMPLATE = process.env.X_RSS_TEMPLATE;

  afterEach(() => {
    if (ORIGINAL_TOKEN === undefined) delete process.env.X_BEARER_TOKEN;
    else process.env.X_BEARER_TOKEN = ORIGINAL_TOKEN;
    if (ORIGINAL_TEMPLATE === undefined) delete process.env.X_RSS_TEMPLATE;
    else process.env.X_RSS_TEMPLATE = ORIGINAL_TEMPLATE;
  });

  test("with no token and no template, returns null instead of throwing", async () => {
    delete process.env.X_BEARER_TOKEN;
    delete process.env.X_RSS_TEMPLATE;
    expect(await xFetcher.fetch(new URL("https://x.com/jack"), CTX)).toBeNull();
  });

  test("the bearer token is sent as a header and never appears in the snapshot", async () => {
    const secret = "SUPER_SECRET_BEARER_VALUE";
    process.env.X_BEARER_TOKEN = secret;
    delete process.env.X_RSS_TEMPLATE;

    let sawAuthHeader = false;
    const snapshot = await withMockedFetch(
      () => xFetcher.fetch(new URL("https://x.com/jack"), CTX),
      async (input, init) => {
        const auth = new Headers(init?.headers).get("authorization") ?? "";
        if (auth === `Bearer ${secret}`) sawAuthHeader = true;
        const url = String(input);
        if (url.includes("/users/by/username/")) return jsonResponse({ data: { id: "42" } });
        if (url.includes("/tweets")) {
          return jsonResponse({ data: [{ id: "9", text: "hello world", created_at: "2025-04-01T10:00:00Z" }] });
        }
        return jsonResponse({}, 404);
      },
    );

    expect(sawAuthHeader).toBe(true);
    expect(snapshot?.markdown).toContain("hello world");
    expect(snapshot?.preferredName).toBe("x/jack");
    // The token must not leak into any field of the snapshot.
    expect(JSON.stringify(snapshot)).not.toContain(secret);
  });

  test("falls back to the RSS template when the API yields nothing", async () => {
    delete process.env.X_BEARER_TOKEN;
    process.env.X_RSS_TEMPLATE = "https://nitter.example/{username}/rss";

    const snapshot = await withMockedFetch(
      () => xFetcher.fetch(new URL("https://x.com/jack"), CTX),
      async () => xmlResponse(RSS2),
    );
    expect(snapshot?.preferredName).toBe("x/jack");
    expect(snapshot?.tags).toContain("twitter");
    expect(snapshot?.markdown).toContain("First post");
  });
});
