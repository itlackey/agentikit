// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { XMLParser } from "fast-xml-parser";
import { fetchWithRetry, ResponseTooLargeError, readBodyWithByteCap } from "../../core/common";
import type { WikiSnapshotFetcher, WikiSnapshotResult } from "./types";

/**
 * RSS 2.0 / Atom 1.0 / RDF (RSS 1.0) feed fetcher.
 *
 * `matches` is deliberately loose — feed URLs are not reliably identifiable
 * from their path alone — so `fetch` content-sniffs the body and returns
 * `null` for anything that is not actually a feed. Returning `null` lets the
 * registry fall through to the generic website crawler, which is the correct
 * outcome for a `/feed`-shaped URL that serves HTML.
 */

/** Feeds far larger than this are aggregators, not knowledge sources. */
const FEED_BYTE_CAP = 5 * 1024 * 1024;
const FEED_BODY_TIMEOUT_MS = 30_000;
const DEFAULT_ITEM_LIMIT = 50;

/** Paths that usually indicate a feed. Confirmed by sniffing before parsing. */
const FEED_PATH_PATTERN = /(?:\.(?:rss|atom|xml)$|\/(?:feed|rss|atom)\/?$)/i;

/**
 * fast-xml-parser resolves no external entities and has no DTD/XXE surface,
 * so the classic billion-laughs and file-disclosure vectors do not apply.
 * The remaining risk is sheer size, which `FEED_BYTE_CAP` bounds before any
 * parsing happens.
 */
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  isArray: (name) => ["item", "entry"].includes(name),
  trimValues: true,
  parseTagValue: false,
  processEntities: true,
});

interface FeedItem {
  title: string;
  link: string;
  date: string;
  summary: string;
}

/** Coerce fast-xml-parser's string | {#text} | array shapes to a string. */
function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return text(value[0]);
  if (value && typeof value === "object") {
    const node = value as Record<string, unknown>;
    if ("#text" in node) return text(node["#text"]);
  }
  return "";
}

/** Atom links are attribute-shaped and may repeat with different rels. */
function atomLink(value: unknown): string {
  const candidates = Array.isArray(value) ? value : [value];
  let fallback = "";
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      fallback ||= candidate.trim();
      continue;
    }
    if (!candidate || typeof candidate !== "object") continue;
    const node = candidate as Record<string, unknown>;
    const href = typeof node["@_href"] === "string" ? node["@_href"].trim() : "";
    if (!href) continue;
    const rel = typeof node["@_rel"] === "string" ? node["@_rel"] : "";
    if (rel === "alternate" || rel === "") return href;
    fallback ||= href;
  }
  return fallback;
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toIsoDate(value: string): string {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function readRssItems(channel: Record<string, unknown>, limit: number): FeedItem[] {
  const items = Array.isArray(channel.item) ? channel.item : [];
  return items.slice(0, limit).map((raw) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    return {
      title: text(item.title),
      link: text(item.link) || text(item.guid),
      date: toIsoDate(text(item.pubDate) || text(item["dc:date"])),
      summary: stripHtml(text(item.description) || text(item["content:encoded"])),
    };
  });
}

function readAtomEntries(feed: Record<string, unknown>, limit: number): FeedItem[] {
  const entries = Array.isArray(feed.entry) ? feed.entry : [];
  return entries.slice(0, limit).map((raw) => {
    const entry = (raw ?? {}) as Record<string, unknown>;
    return {
      title: text(entry.title),
      link: atomLink(entry.link),
      date: toIsoDate(text(entry.updated) || text(entry.published)),
      summary: stripHtml(text(entry.summary) || text(entry.content)),
    };
  });
}

interface ParsedFeed {
  title: string;
  items: FeedItem[];
}

/** Returns null when the document is not a recognizable feed. */
export function parseFeed(xml: string, limit = DEFAULT_ITEM_LIMIT): ParsedFeed | null {
  let doc: Record<string, unknown>;
  try {
    doc = xmlParser.parse(xml) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return null;

  const rss = doc.rss as Record<string, unknown> | undefined;
  if (rss?.channel) {
    const channel = rss.channel as Record<string, unknown>;
    return { title: text(channel.title), items: readRssItems(channel, limit) };
  }

  const feed = doc.feed as Record<string, unknown> | undefined;
  if (feed) {
    return { title: text(feed.title), items: readAtomEntries(feed, limit) };
  }

  // RDF / RSS 1.0 hoists <item> to the document root alongside <channel>.
  const rdf = doc["rdf:RDF"] as Record<string, unknown> | undefined;
  if (rdf) {
    const channel = (rdf.channel ?? {}) as Record<string, unknown>;
    const scope = Array.isArray(rdf.item) ? rdf : channel;
    return { title: text(channel.title), items: readRssItems(scope as Record<string, unknown>, limit) };
  }

  return null;
}

/** Cheap pre-parse check so HTML served at a feed-shaped URL is not parsed. */
function looksLikeFeed(body: string): boolean {
  const head = body.slice(0, 2048);
  return /<(?:rss\b|feed\b|rdf:RDF\b)/i.test(head);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function preferredNameFor(url: URL): string {
  const host = slugify(url.hostname);
  const pathPart = slugify(url.pathname.replace(/\.(rss|atom|xml)$/i, ""));
  return pathPart ? `feeds/${host}-${pathPart}` : `feeds/${host}`;
}

function renderMarkdown(feed: ParsedFeed, url: URL): string {
  const sections: string[] = [];
  for (const item of feed.items) {
    const heading = item.title || item.link || "(untitled)";
    sections.push(`## ${heading}`, "");
    const meta: string[] = [];
    if (item.date) meta.push(item.date);
    if (item.link) meta.push(item.link);
    if (meta.length > 0) sections.push(meta.join(" — "), "");
    if (item.summary) sections.push(item.summary, "");
  }
  if (sections.length === 0) sections.push(`No items in feed ${url.toString()}`, "");
  return sections.join("\n").trimEnd();
}

const rssFetcher: WikiSnapshotFetcher = {
  name: "rss-feed",
  matches(url) {
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return FEED_PATH_PATTERN.test(url.pathname) || url.searchParams.has("feed");
  },
  async fetch(url, context): Promise<WikiSnapshotResult | null> {
    const response = await fetchWithRetry(
      url.toString(),
      {
        headers: {
          Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8",
          "User-Agent": "akm-cli rss fetcher",
        },
        signal: context.signal,
      },
      { timeout: context.timeoutMs, retries: 1 },
    );
    if (!response.ok) return null;

    let body: string;
    try {
      body = await readBodyWithByteCap(response, FEED_BYTE_CAP, { bodyTimeoutMs: FEED_BODY_TIMEOUT_MS });
    } catch (error) {
      // An oversized feed is not a hard failure — fall through to the generic
      // crawler rather than aborting the whole `akm bundle add`.
      if (error instanceof ResponseTooLargeError) return null;
      throw error;
    }

    if (!looksLikeFeed(body)) return null;
    const feed = parseFeed(body);
    if (!feed || feed.items.length === 0) return null;

    return {
      url: url.toString(),
      title: feed.title || url.hostname,
      markdown: renderMarkdown(feed, url),
      preferredName: preferredNameFor(url),
      tags: ["rss", "feed", url.hostname],
    };
  },
};

export default rssFetcher;
