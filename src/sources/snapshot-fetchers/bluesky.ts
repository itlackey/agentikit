// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { fetchWithRetry, readBodyWithByteCap } from "../../core/common";
import { isSafeLinkUrl } from "./content-extract";
import type { WikiSnapshotFetcher, WikiSnapshotResult } from "./types";

/**
 * Bluesky profile fetcher, using the public AT Protocol XRPC endpoints.
 *
 * No authentication: `public.api.bsky.app` serves public profiles unauthed.
 * The fetcher contract takes a URL, so bare-handle input (`@user.bsky.social`)
 * is out of scope — that is `akm bundle add` sugar, not an addressable source.
 */

const BSKY_HOSTS = new Set(["bsky.app", "www.bsky.app"]);
const PUBLIC_API_BASE = "https://public.api.bsky.app";
/** The XRPC endpoint caps `limit` at 100; asking for more is an error. */
const MAX_FEED_LIMIT = 100;
const DEFAULT_FEED_LIMIT = 50;
/** Bound the JSON read: fetch timeouts cover only the header phase. */
const BSKY_BYTE_CAP = 4 * 1024 * 1024;
const BSKY_BODY_TIMEOUT_MS = 30_000;

interface BlueskyPost {
  text: string;
  createdAt: string;
  uri: string;
  likeCount: number;
  repostCount: number;
  externalUri: string;
}

/** Extract a handle from `https://bsky.app/profile/<handle>`. */
export function extractBlueskyHandle(url: URL): string | null {
  if (!BSKY_HOSTS.has(url.hostname.toLowerCase())) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2 || segments[0] !== "profile") return null;
  const handle = segments[1]?.trim();
  if (!handle) return null;
  // Only the profile root is a snapshot target; /post/<id> and other
  // sub-routes are individual records, not a profile feed.
  if (segments.length > 2) return null;
  return handle.replace(/^@/, "");
}

/**
 * Neutralize markdown structure in attacker-controlled prose. Without this a
 * post body containing a line starting with `##` forges a section boundary in
 * the snapshot, letting it impersonate content the fetcher vouched for.
 */
function escapeStructure(value: string): string {
  return value
    .split("\n")
    .map((line) => line.replace(/^(\s*)([#>\-*+=]|\d+\.)/, "$1\\$2"))
    .join("\n");
}

/** Emit a link only when it is a safe absolute http(s) URL. */
function safeLink(value: string): string {
  if (!value) return "";
  try {
    return isSafeLinkUrl(new URL(value)) ? value : "";
  } catch {
    return "";
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function xrpcJson(url: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown | null> {
  const response = await fetchWithRetry(
    url,
    {
      headers: { Accept: "application/json", "User-Agent": "akm-cli bluesky fetcher" },
      signal,
      redirect: "manual",
    },
    { timeout: timeoutMs, retries: 1 },
  );
  // `redirect: "manual"`: these are pinned API endpoints that have no
  // legitimate reason to redirect. Following a 3xx would send the next
  // request to an unvalidated host — potentially loopback or a private
  // range — with none of the SSRF guards the crawl path applies.
  if (response.status >= 300 && response.status < 400) return null;
  if (!response.ok) return null;
  try {
    const body = await readBodyWithByteCap(response, BSKY_BYTE_CAP, {
      bodyTimeoutMs: BSKY_BODY_TIMEOUT_MS,
      signal,
    });
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** Resolve a handle to its DID. Returns null when the handle does not exist. */
async function resolveHandle(handle: string, timeoutMs: number, signal?: AbortSignal): Promise<string | null> {
  const url = `${PUBLIC_API_BASE}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`;
  const json = (await xrpcJson(url, timeoutMs, signal)) as { did?: unknown } | null;
  const did = str(json?.did);
  return did || null;
}

function readPosts(feed: unknown, limit: number): BlueskyPost[] {
  if (!Array.isArray(feed)) return [];
  const posts: BlueskyPost[] = [];
  for (const entry of feed.slice(0, limit)) {
    const post = (entry as { post?: Record<string, unknown> } | null)?.post;
    if (!post) continue;
    const record = (post.record ?? {}) as Record<string, unknown>;
    const embed = (post.embed ?? {}) as Record<string, unknown>;
    const external = (embed.external ?? {}) as Record<string, unknown>;
    posts.push({
      text: str(record.text),
      createdAt: str(record.createdAt),
      uri: str(post.uri),
      likeCount: num(post.likeCount),
      repostCount: num(post.repostCount),
      externalUri: safeLink(str(external.uri)),
    });
  }
  return posts;
}

/** Convert an `at://did/app.bsky.feed.post/<rkey>` URI to a bsky.app permalink. */
function permalink(handle: string, uri: string): string {
  const rkey = uri.split("/").pop();
  return rkey ? `https://bsky.app/profile/${handle}/post/${rkey}` : "";
}

function renderMarkdown(handle: string, posts: BlueskyPost[]): string {
  const sections: string[] = [];
  for (const post of posts) {
    if (!post.text && !post.externalUri) continue;
    const when = post.createdAt ? new Date(post.createdAt) : null;
    const iso = when && !Number.isNaN(when.getTime()) ? when.toISOString() : "";
    sections.push(`## ${iso || "(undated)"}`, "");
    if (post.text) sections.push(escapeStructure(post.text), "");
    const meta: string[] = [];
    const link = permalink(handle, post.uri);
    if (link) meta.push(link);
    if (post.externalUri) meta.push(`link: ${post.externalUri}`);
    meta.push(`${post.likeCount} likes, ${post.repostCount} reposts`);
    sections.push(meta.join(" — "), "");
  }
  return sections.join("\n").trimEnd();
}

const blueskyFetcher: WikiSnapshotFetcher = {
  name: "bluesky-profile",
  matches(url) {
    return extractBlueskyHandle(url) !== null;
  },
  async fetch(url, context): Promise<WikiSnapshotResult | null> {
    const handle = extractBlueskyHandle(url);
    if (!handle) return null;

    const did = await resolveHandle(handle, context.timeoutMs, context.signal);
    if (!did) return null;

    const feedUrl =
      `${PUBLIC_API_BASE}/xrpc/app.bsky.feed.getAuthorFeed` +
      `?actor=${encodeURIComponent(did)}&limit=${Math.min(DEFAULT_FEED_LIMIT, MAX_FEED_LIMIT)}`;
    const json = (await xrpcJson(feedUrl, context.timeoutMs, context.signal)) as { feed?: unknown } | null;
    if (!json) return null;

    const posts = readPosts(json.feed, DEFAULT_FEED_LIMIT);
    const markdown = renderMarkdown(handle, posts);
    if (!markdown) return null;

    return {
      url: `https://bsky.app/profile/${handle}`,
      title: `Bluesky — @${handle}`,
      markdown,
      preferredName: `bluesky/${handle}`,
      tags: ["bluesky", "social"],
    };
  },
};

export default blueskyFetcher;
