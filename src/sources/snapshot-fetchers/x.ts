// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { fetchWithRetry, readBodyWithByteCap } from "../../core/common";
import { warn } from "../../core/warn";
import rssFetcher from "./rss";
import type { FetcherContext, WikiSnapshotFetcher, WikiSnapshotResult } from "./types";

/**
 * X / Twitter profile fetcher.
 *
 * Strategy chain, in order:
 *   1. X API v2, when a bearer token is available.
 *   2. An RSS template (e.g. a self-hosted Nitter instance), delegating to the
 *      RSS fetcher.
 *   3. Return `null` with a single warning naming both options.
 *
 * Step 3 is deliberately not an error: `matches` fires on any x.com profile
 * URL, and a hard failure there would break the generic website-crawl
 * fall-through for users who never asked for X ingestion.
 *
 * The bearer token is read but never rendered — it appears in no snapshot,
 * no frontmatter, and no log line, including on the failure paths.
 */

const X_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);
const X_API_BASE = "https://api.x.com/2";
const DEFAULT_TWEET_LIMIT = 50;
/** Bound the JSON read: fetch timeouts cover only the header phase. */
const X_BYTE_CAP = 4 * 1024 * 1024;
const X_BODY_TIMEOUT_MS = 30_000;

/** Reserved x.com paths that are not user profiles. */
const RESERVED_X_PATHS = new Set([
  "home",
  "explore",
  "notifications",
  "messages",
  "search",
  "settings",
  "i",
  "intent",
  "share",
  "compose",
  "login",
  "signup",
  "about",
  "tos",
  "privacy",
]);

export function extractXUsername(url: URL): string | null {
  if (!X_HOSTS.has(url.hostname.toLowerCase())) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 1) return null;
  const username = segments[0]?.trim().replace(/^@/, "");
  if (!username || !/^[A-Za-z0-9_]{1,15}$/.test(username)) return null;
  if (RESERVED_X_PATHS.has(username.toLowerCase())) return null;
  return username;
}

/**
 * Resolve the bearer token from the environment.
 *
 * akm's secret store reaches this fetcher through `akm secret run`, which
 * injects a stored secret into the child process environment:
 *
 *   akm secret set x-bearer-token
 *   akm secret run secrets/x-bearer-token X_BEARER_TOKEN -- akm bundle add https://x.com/<user>
 *
 * Reading the secret file directly from here was the obvious alternative, but
 * `core/env-secret-ref` transitively imports the source providers, which import
 * this fetcher's own registry — a genuine import cycle. Going through
 * `secret run` keeps the fetcher's import graph a leaf and reuses the
 * mechanism akm already uses everywhere else to hand secrets to a process.
 *
 * Returns the token or null; never logs the value.
 */
export function resolveXBearerToken(): string | null {
  return process.env.X_BEARER_TOKEN?.trim() || null;
}

interface XTweet {
  id: string;
  text: string;
  createdAt: string;
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

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function xApiJson(url: string, token: string, context: FetcherContext): Promise<Record<string, unknown> | null> {
  const response = await fetchWithRetry(
    url,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "akm-cli x fetcher",
      },
      signal: context.signal,
    },
    { timeout: context.timeoutMs, retries: 1 },
  );
  if (!response.ok) return null;
  try {
    const body = await readBodyWithByteCap(response, X_BYTE_CAP, {
      bodyTimeoutMs: X_BODY_TIMEOUT_MS,
      signal: context.signal,
    });
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function fetchViaApi(username: string, token: string, context: FetcherContext): Promise<XTweet[] | null> {
  const lookup = await xApiJson(`${X_API_BASE}/users/by/username/${encodeURIComponent(username)}`, token, context);
  const userId = str((lookup?.data as { id?: unknown } | undefined)?.id);
  if (!userId) return null;

  const timeline = await xApiJson(
    `${X_API_BASE}/users/${encodeURIComponent(userId)}/tweets` +
      `?max_results=${DEFAULT_TWEET_LIMIT}&tweet.fields=created_at`,
    token,
    context,
  );
  const data = timeline?.data;
  if (!Array.isArray(data)) return null;

  return data.map((raw) => {
    const tweet = (raw ?? {}) as Record<string, unknown>;
    return { id: str(tweet.id), text: str(tweet.text), createdAt: str(tweet.created_at) };
  });
}

function renderMarkdown(username: string, tweets: XTweet[]): string {
  const sections: string[] = [];
  for (const tweet of tweets) {
    if (!tweet.text) continue;
    const when = tweet.createdAt ? new Date(tweet.createdAt) : null;
    const iso = when && !Number.isNaN(when.getTime()) ? when.toISOString() : "";
    sections.push(`## ${iso || "(undated)"}`, "", escapeStructure(tweet.text), "");
    if (tweet.id) sections.push(`https://x.com/${username}/status/${tweet.id}`, "");
  }
  return sections.join("\n").trimEnd();
}

/**
 * Build the RSS fallback URL from a template containing `{username}`.
 * Returns null when the template is absent or does not produce a valid URL.
 */
export function buildXRssUrl(template: string | undefined, username: string): URL | null {
  const raw = template?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.replaceAll("{username}", encodeURIComponent(username)));
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

const xFetcher: WikiSnapshotFetcher = {
  name: "x-profile",
  matches(url) {
    return extractXUsername(url) !== null;
  },
  async fetch(url, context): Promise<WikiSnapshotResult | null> {
    const username = extractXUsername(url);
    if (!username) return null;

    const token = resolveXBearerToken();
    if (token) {
      const tweets = await fetchViaApi(username, token, context);
      const markdown = tweets ? renderMarkdown(username, tweets) : "";
      if (markdown) {
        return {
          url: `https://x.com/${username}`,
          title: `X — @${username}`,
          markdown,
          preferredName: `x/${username}`,
          tags: ["x", "twitter", "social"],
        };
      }
    }

    const rssUrl = buildXRssUrl(process.env.X_RSS_TEMPLATE, username);
    if (rssUrl) {
      const snapshot = await rssFetcher.fetch(rssUrl, context);
      if (snapshot) {
        return {
          ...snapshot,
          url: `https://x.com/${username}`,
          title: `X — @${username}`,
          preferredName: `x/${username}`,
          tags: ["x", "twitter", "social"],
        };
      }
    }

    warn(
      "[akm] x-profile: no content for @%s. Set X_BEARER_TOKEN for the X API (akm secret run can inject a " +
        "stored secret), or X_RSS_TEMPLATE to an RSS bridge URL containing {username}.",
      username,
    );
    return null;
  },
};

export default xFetcher;
