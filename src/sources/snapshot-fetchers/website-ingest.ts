// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  fetchWithRetry,
  ResponseTooLargeError,
  readBodyWithByteCap,
  resolveStashDir,
  todayIso,
} from "../../core/common";
import type { SourceConfigEntry } from "../../core/config/config";
import { ConfigError, UsageError } from "../../core/errors";
import { getRegistryIndexCacheDir } from "../../core/paths";
import { warn, warnVerbose } from "../../core/warn";
import { withFreshnessCache } from "../freshness";
import { sanitizeString } from "../providers/provider-utils";
import { extractDocumentLinks, htmlToMarkdown } from "./content-extract";
import {
  assertResolvedHostAllowed,
  assertWebsiteRequestUrl,
  type HostnameResolver,
  isLoopbackWebsiteHostname,
  type WebsiteUrlErrorCtor,
} from "./host-guard";
import { loadWikiSnapshotFetchers } from "./registry";
import {
  createAllowAllRobotsPolicy,
  createRobotsPolicy,
  isPathAllowedByRobots,
  ROBOTS_BODY_TIMEOUT_MS,
  ROBOTS_BYTE_CAP,
  type RobotsFetchOutcome,
  type RobotsPolicy,
  type RobotsRuleSet,
} from "./robots";
import type { FetcherContext, WikiSnapshotResult } from "./types";

/** Refresh website snapshots every 12 hours to balance freshness with scraping load. */
const CACHE_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** Allow up to 7 days of stale snapshots when refresh fails so search remains available during outages. */
const CACHE_STALE_MS = 7 * 24 * 60 * 60 * 1000;
/** Allow limited breadth-first expansion without letting the crawl queue grow unbounded. */
const QUEUE_EXPANSION_FACTOR = 5;

const MAX_PAGES_DEFAULT = 50;
const MAX_DEPTH_DEFAULT = 3;

/**
 * Per-page body cap for website scraping. HTML pages this large are
 * almost never useful as agent knowledge sources and a runaway server
 * streaming tens of megabytes would blow memory with no upside.
 */
const WEBSITE_PAGE_BYTE_CAP = 5 * 1024 * 1024;

/**
 * Wall-clock cap for a full crawl (10 minutes). With per-request timeouts
 * of 15s and a `maxPages` default of 50, an unresponsive site could
 * otherwise stall `akm add` for 12.5 minutes with no feedback. Cap the
 * whole crawl and return what we have when time runs out.
 */
const WEBSITE_CRAWL_WALL_CLOCK_MS = 10 * 60 * 1000;
const WEBSITE_MAX_REDIRECTS = 8;

/**
 * Body-read deadline for a single page (30s). The per-request fetch timeout
 * (15s) bounds only the connection/header phase; without this a server that
 * dribbles body bytes below the size cap could stall the crawl until the whole
 * wall-clock cap elapses.
 */
const WEBSITE_PAGE_BODY_TIMEOUT_MS = 30_000;

interface WebsitePage {
  url: string;
  title: string;
  markdown: string;
}

export interface WebsiteMarkdownSnapshot {
  url: string;
  title: string;
  markdown: string;
  preferredName: string;
  content: string;
}

export interface FetchSnapshotOptions {
  stashDir?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  allowPrivateHosts?: boolean;
}

interface WebsiteValidationOptions {
  allowPrivateHosts?: boolean;
  /**
   * Override the DNS resolver used by the resolve-then-validate SSRF guard.
   * Defaults to a real `node:dns` lookup; tests inject a stub so no real DNS
   * ever runs.
   */
  resolveHostname?: HostnameResolver;
  /**
   * When set, `fetchWebsitePage` re-checks the *final* (post-redirect) URL
   * against this policy and drops the page (warnVerbose, no error) when
   * disallowed. Only `crawlWebsite` passes this — `fetchWebsiteMarkdownSnapshot`
   * (single-URL, user-typed fetches) intentionally stays ungated per spec §1.
   * Without this, `normalizeCrawlUrl` stripping trailing slashes plus a
   * server's own redirect (e.g. `/secret` -> `/secret/`) could land on a page
   * disallowed by a `Disallow: /secret/`-shaped rule that was never re-checked
   * post-redirect.
   */
  robots?: RobotsPolicy;
}

export function shouldAllowPrivateWebsiteHostsForTests(): boolean {
  return process.env.BUN_TEST === "1" || process.env.NODE_ENV === "test";
}

export function shouldAllowPrivateWebsiteUrlForTests(rawUrl: string): boolean {
  if (!shouldAllowPrivateWebsiteHostsForTests()) return false;
  try {
    return isLoopbackWebsiteHostname(new URL(rawUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function resolveFetcherStashDir(explicitStashDir?: string): string | null {
  if (explicitStashDir) return explicitStashDir;
  try {
    return resolveStashDir();
  } catch {
    return null;
  }
}

export function getWebsiteCachePaths(siteUrl: string): {
  rootDir: string;
  stashDir: string;
  manifestPath: string;
} {
  const key = createHash("sha256").update(normalizeSiteUrl(siteUrl)).digest("hex").slice(0, 16);
  const rootDir = path.join(getRegistryIndexCacheDir(), `website-${key}`);
  return {
    rootDir,
    stashDir: path.join(rootDir, "stash"),
    manifestPath: path.join(rootDir, "manifest.json"),
  };
}

export async function ensureWebsiteMirror(
  config: SourceConfigEntry,
  options?: {
    requireStashDir?: boolean;
    force?: boolean;
    allowPrivateHosts?: boolean;
    /**
     * TEST-ONLY. Overrides `WEBSITE_CRAWL_WALL_CLOCK_MS` for this crawl.
     * Mirrors the `allowPrivateHosts` escape hatch: production callers never
     * set this, but the crawl's wall-clock cap is otherwise a hardcoded
     * 10-minute constant, which makes deadline-boundary behavior (breaking
     * a crawl rather than sleeping past the cap) impossible to exercise in a
     * fast test without it. Not surfaced through config.
     */
    wallClockCapMs?: number;
  },
): Promise<ReturnType<typeof getWebsiteCachePaths>> {
  const rawUrl = config.url ?? "";
  const normalizedUrl = validateWebsiteUrl(rawUrl, { allowPrivateHosts: options?.allowPrivateHosts });
  const cachePaths = getWebsiteCachePaths(normalizedUrl);
  const requireStashDir = options?.requireStashDir === true;

  await withFreshnessCache({
    markerPath: cachePaths.manifestPath,
    ttlMs: CACHE_REFRESH_INTERVAL_MS,
    staleMs: CACHE_STALE_MS,
    force: options?.force === true,
    isUsable: () => !requireStashDir || hasExtractedSite(cachePaths.stashDir),
    refresh: async () => {
      fs.mkdirSync(cachePaths.rootDir, { recursive: true });
      await scrapeWebsiteToStash(normalizedUrl, cachePaths.stashDir, {
        maxPages: coercePositiveInt(config.options?.maxPages, MAX_PAGES_DEFAULT),
        maxDepth: coercePositiveInt(config.options?.maxDepth, MAX_DEPTH_DEFAULT),
        respectRobots: coerceRespectRobots(config.options?.respectRobots),
        allowPrivateHosts: options?.allowPrivateHosts,
        wallClockCapMs: options?.wallClockCapMs,
        // As-supplied, pre-normalization start URL (see crawlWebsite's
        // `rawStartUrl` doc comment): threaded through purely for the C-02
        // robots.txt check, which must see the trailing slash the user
        // actually typed before `normalizeSiteUrl` strips it.
        rawStartUrl: rawUrl,
      });
      fs.writeFileSync(
        cachePaths.manifestPath,
        `${JSON.stringify({ url: normalizedUrl, fetchedAt: new Date().toISOString() }, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    },
  });
  return cachePaths;
}

function hasExtractedSite(stashDir: string): boolean {
  try {
    const knowledgeDir = path.join(stashDir, "knowledge");
    if (!fs.statSync(stashDir).isDirectory() || !fs.statSync(knowledgeDir).isDirectory()) return false;
    for (const entry of fs.readdirSync(knowledgeDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) return true;
      if (entry.isDirectory()) {
        const subEntries = fs.readdirSync(path.join(knowledgeDir, entry.name));
        if (subEntries.some((e) => e.endsWith(".md"))) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function scrapeWebsiteToStash(
  startUrl: string,
  stashDir: string,
  options: {
    maxPages: number;
    maxDepth: number;
    respectRobots?: boolean;
    allowPrivateHosts?: boolean;
    wallClockCapMs?: number;
    rawStartUrl?: string;
  },
): Promise<void> {
  const pages = await crawlWebsite(startUrl, options);
  if (pages.length === 0) {
    throw new Error(`No content could be scraped from ${startUrl}`);
  }

  fs.rmSync(stashDir, { recursive: true, force: true });
  const knowledgeDir = path.join(stashDir, "knowledge");
  fs.mkdirSync(knowledgeDir, { recursive: true });

  const usedPaths = new Set<string>();
  for (const page of pages) {
    const relPath = avoidReservedBasename(urlToRelativePath(page.url));
    const uniquePath = uniqueSlug(relPath, usedPaths);
    const filePath = path.join(knowledgeDir, `${uniquePath}.md`);
    const dir = path.dirname(filePath);
    if (dir !== knowledgeDir) fs.mkdirSync(dir, { recursive: true });
    const slug = uniquePath.split("/").pop() ?? "index";
    fs.writeFileSync(filePath, buildMarkdownSnapshot(page, slug), "utf8");
  }
}

export async function fetchWebsiteMarkdownSnapshot(
  rawUrl: string,
  options?: FetchSnapshotOptions,
): Promise<WebsiteMarkdownSnapshot> {
  const normalizedUrl = validateWebsiteInputUrl(rawUrl, { allowPrivateHosts: options?.allowPrivateHosts });
  const parsedUrl = new URL(normalizedUrl);
  const stashDir = resolveFetcherStashDir(options?.stashDir);
  const context: FetcherContext = {
    stashDir: stashDir ?? "",
    timeoutMs: options?.timeoutMs ?? 15_000,
    signal: options?.signal,
    ...(options?.allowPrivateHosts ? { allowPrivateHosts: true } : {}),
  };

  for (const fetcher of await loadWikiSnapshotFetchers(stashDir)) {
    try {
      if (!fetcher.matches(parsedUrl, context)) continue;
      const snapshot = await fetcher.fetch(parsedUrl, context);
      if (!snapshot) continue;
      return websiteMarkdownSnapshotFromResult(snapshot);
    } catch (error) {
      warn(
        "[akm] wiki-fetcher %s threw on %s: %s",
        fetcher.name,
        normalizedUrl,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const fetched = await fetchWebsitePage(normalizedUrl, { allowPrivateHosts: options?.allowPrivateHosts });
  if (!fetched) {
    throw new UsageError(`No content could be fetched from ${normalizedUrl}`);
  }

  return websiteMarkdownSnapshotFromResult({
    url: fetched.page.url,
    title: fetched.page.title,
    markdown: fetched.page.markdown,
  });
}

function websiteMarkdownSnapshotFromResult(snapshot: WikiSnapshotResult): WebsiteMarkdownSnapshot {
  const preferredName = snapshot.preferredName ?? deriveImportPath(snapshot.url);
  const slug = preferredName.split("/").pop() ?? preferredName;
  return {
    url: snapshot.url,
    title: snapshot.title,
    markdown: snapshot.markdown,
    preferredName,
    content: buildMarkdownSnapshot(
      {
        url: snapshot.url,
        title: snapshot.title,
        markdown: snapshot.markdown,
      },
      slug || "website",
      snapshot.tags,
    ),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Evaluates a URL against robots.txt, checking both `normalizedUrl` — the
 * form akm treats as canonical for dedup/storage, with any bare trailing
 * slash already stripped by `normalizeCrawlUrl`/`normalizeSiteUrl` — and,
 * when it differs, `rawUrl`: the URL exactly as discovered (a link's literal
 * `href`), as-supplied (the user's typed start URL), or redirected-to (a
 * `Location` header), before any such stripping. Delegates the actual
 * allow/disallow decision to {@link decideRobotsAllowance}'s asymmetric
 * matrix — see its doc comment — rather than a plain AND of both forms: a
 * `Disallow: /dir/`-shaped rule needs the un-stripped `rawUrl` to ever match
 * (closing that gap), while an `Allow: /docs/`-shaped rule needs it too, in
 * the *other* direction (a normalized-disallowed-but-raw-allowed URL must
 * still be treated as allowed here, not just at the point where akm chooses
 * which literal URL to fetch — a URL reaching this function has already been
 * fetched, under whichever form `crawlWebsite`/`resolveCrawlRobotsDecision`
 * selected, so only the `allowed` verdict matters here, never `fetchUrl`).
 *
 * `normalizeCrawlUrl`/`normalizeSiteUrl` strip a bare trailing slash before
 * any robots check ever runs, so a `Disallow: /dir/`-shaped rule — which
 * requires a literal trailing `/` in the target, see
 * `matchesCompiledPattern`'s prefix check — can never match the stripped
 * alias. Checking the un-stripped `rawUrl` closes that gap without changing
 * what akm treats as the canonical URL for storage/dedup, and (crucially)
 * without over-blocking a URL that never had a trailing slash to begin with
 * — e.g. a `/secret` link that happens to redirect to `/secret/`: the
 * pre-redirect request itself is unaffected by a `Disallow: /secret/` rule,
 * only the redirect target is.
 */
async function isCrawlUrlAllowedByRobots(
  robots: RobotsPolicy,
  normalizedUrl: string,
  rawUrl?: string,
): Promise<boolean> {
  return (await resolveCrawlRobotsDecision(robots, normalizedUrl, rawUrl)).allowed;
}

/**
 * Decides whether `normalizedUrl` (akm's canonical form — dedup/cache key,
 * with any bare trailing slash already stripped by `normalizeCrawlUrl`/
 * `normalizeSiteUrl`) may be crawled, and which literal URL to actually
 * request.
 *
 * A `Disallow: /dir/`-shaped rule requires a literal trailing `/` in the
 * target (see `matchesCompiledPattern`'s prefix check), so it can never match
 * the slash-stripped normalized alias — checking the un-stripped `rawUrl` (a
 * link's literal `href`, the user's as-typed start URL, or a redirect
 * `Location`) closes that gap. Symmetrically, an `Allow: /docs/`-shaped rule
 * requires that same trailing `/` to match, so a start URL or link typed as
 * `.../docs/` under `Disallow: / \n Allow: /docs/` is allowed in its raw form
 * but disallowed once normalized — over-blocking a site the owner explicitly
 * opened to crawlers.
 *
 * Resolution matrix (raw form only consulted when it differs from normalized):
 *  - normalized allowed, raw allowed (or no distinct raw)  => allowed, fetch normalized
 *  - normalized allowed, raw disallowed                    => BLOCKED (raw wins: closes the Disallow: /dir/ gap)
 *  - normalized disallowed, raw allowed                    => allowed, fetch the RAW url (closes the Allow: /docs/ gap)
 *  - normalized disallowed, raw disallowed                 => BLOCKED
 *
 * Only the third row switches the fetch target; every other row fetches the
 * normalized form akm already treats as canonical. Do not collapse this to a
 * plain OR of the two checks — that would also flip the second row to
 * "allowed" and reopen the `Disallow: /dir/` bypass this matrix exists to
 * close.
 */
function decideRobotsAllowance(
  rules: RobotsRuleSet,
  normalizedUrl: string,
  rawUrl?: string,
): { allowed: boolean; fetchUrl: string } {
  const normalizedAllowed = isPathAllowedByRobots(rules, normalizedUrl);
  if (!rawUrl || rawUrl === normalizedUrl) {
    return { allowed: normalizedAllowed, fetchUrl: normalizedUrl };
  }
  const rawAllowed = isPathAllowedByRobots(rules, rawUrl);
  if (!normalizedAllowed && rawAllowed) {
    return { allowed: true, fetchUrl: rawUrl };
  }
  return { allowed: normalizedAllowed && rawAllowed, fetchUrl: normalizedUrl };
}

/**
 * Async wrapper of {@link decideRobotsAllowance} for call sites holding a
 * `RobotsPolicy` (which resolves/caches rules per origin) rather than an
 * already-fetched `RobotsRuleSet`.
 */
async function resolveCrawlRobotsDecision(
  robots: RobotsPolicy,
  normalizedUrl: string,
  rawUrl?: string,
): Promise<{ allowed: boolean; fetchUrl: string }> {
  const rules = await robots.rulesFor(normalizedUrl);
  return decideRobotsAllowance(rules, normalizedUrl, rawUrl);
}

/**
 * C-02/C-03: fail fast, before any page fetch, when the start URL itself is
 * off-limits. A 5xx robots.txt (RobotsPolicy caches `DISALLOW_ALL_RULES` for
 * that case) gets a distinct message calling out the server error, per spec
 * §4.6.
 *
 * Checks both `start`'s (normalized) URL and `rawStartUrl` — the URL exactly
 * as the user supplied it in config, before `validateWebsiteUrl` ->
 * `normalizeSiteUrl` stripped any trailing slash — via
 * `decideRobotsAllowance`. Without this, a start URL typed as `.../secret/`
 * under `Disallow: /secret/` would never match that rule and would be
 * crawled instead of rejected with the spec §4.6 C-02 UsageError; conversely,
 * a start URL typed as `.../docs/` under `Disallow: / \n Allow: /docs/`
 * would be normalized to `.../docs`, fail to match `Allow: /docs/`, and be
 * rejected even though the site owner explicitly opened `/docs/` to
 * crawlers. `crawlWebsite`'s queue gate applies the same decision (and, in
 * the Allow case, actually fetches the raw URL this function only validates
 * against) — see its call to `resolveCrawlRobotsDecision`.
 */
async function assertStartUrlAllowedByRobots(robots: RobotsPolicy, start: URL, rawStartUrl?: string): Promise<void> {
  const startUrl = start.toString();
  const robotsUrl = new URL("/robots.txt", start.origin).toString();
  const rules = await robots.rulesFor(startUrl);

  if (rules.disallowAll) {
    throw new UsageError(
      `Refusing to crawl ${startUrl}: ${robotsUrl} returned a server error, which robots.txt conventions ` +
        `treat as a full disallow until it recovers. Set respectRobots: false on this website source to bypass ` +
        `robots.txt.`,
    );
  }
  let rawStartUrlNormalized: string | undefined;
  if (rawStartUrl) {
    try {
      rawStartUrlNormalized = new URL(rawStartUrl).toString();
    } catch {
      rawStartUrlNormalized = undefined;
    }
  }
  const { allowed } = decideRobotsAllowance(rules, startUrl, rawStartUrlNormalized);
  if (!allowed) {
    throw new UsageError(
      `Refusing to crawl ${startUrl}: disallowed by ${robotsUrl}. Set respectRobots: false on this website ` +
        `source to bypass robots.txt.`,
    );
  }
}

async function crawlWebsite(
  startUrl: string,
  options: {
    maxPages: number;
    maxDepth: number;
    respectRobots?: boolean;
    allowPrivateHosts?: boolean;
    wallClockCapMs?: number;
    /**
     * The start URL exactly as the user supplied it in config, before
     * `validateWebsiteUrl` -> `normalizeSiteUrl` stripped any trailing
     * slash. Passed through to `assertStartUrlAllowedByRobots` only — see
     * `decideRobotsAllowance`'s doc comment for why. `startUrl` itself is
     * always already normalized by the time it reaches here (every caller
     * routes it through `validateWebsiteUrl` first), so it cannot stand in
     * for the as-typed form on its own.
     */
    rawStartUrl?: string;
  },
): Promise<WebsitePage[]> {
  const start = new URL(normalizeSiteUrl(startUrl));
  const allowedOrigin = start.origin;
  const queue: Array<{ url: string; rawUrl: string; depth: number }> = [
    { url: start.toString(), rawUrl: options.rawStartUrl ?? start.toString(), depth: 0 },
  ];
  const visited = new Set<string>();
  const pages: WebsitePage[] = [];
  const wallClockCapMs = options.wallClockCapMs ?? WEBSITE_CRAWL_WALL_CLOCK_MS;
  const deadline = Date.now() + wallClockCapMs;

  const robots =
    options.respectRobots === false
      ? createAllowAllRobotsPolicy()
      : createRobotsPolicy((robotsUrl) => loadRobotsTxt(robotsUrl, { allowPrivateHosts: options.allowPrivateHosts }));

  await assertStartUrlAllowedByRobots(robots, start, options.rawStartUrl);

  // Counts actual `fetchWebsitePage` invocations (regardless of outcome) so
  // Crawl-delay pacing skips the first fetch and never charges a delay slot
  // to a URL that robots.txt skipped without ever being fetched (C-11).
  let fetchAttempts = 0;
  let deadlineHit = false;

  while (queue.length > 0 && pages.length < options.maxPages) {
    if (Date.now() > deadline) {
      deadlineHit = true;
      break;
    }
    const next = queue.shift();
    if (!next) break;
    const normalized = normalizeCrawlUrl(next.url);
    if (!normalized || visited.has(normalized)) continue;
    visited.add(normalized);

    const decision = await resolveCrawlRobotsDecision(robots, normalized, next.rawUrl);
    if (!decision.allowed) {
      warnVerbose("[akm] website crawl: skipping %s (disallowed by robots.txt)", normalized);
      continue;
    }

    if (fetchAttempts > 0) {
      const delayMs = await robots.crawlDelayMs(normalized);
      if (delayMs > 0) {
        if (Date.now() + delayMs >= deadline) {
          deadlineHit = true;
          break;
        }
        await sleep(delayMs);
      }
    }
    fetchAttempts++;

    const fetched = await fetchWebsitePage(decision.fetchUrl, { allowPrivateHosts: options.allowPrivateHosts, robots });
    if (!fetched) continue;
    pages.push(fetched.page);

    if (next.depth >= options.maxDepth) continue;
    for (const link of fetched.links) {
      if (queue.length + pages.length >= options.maxPages * QUEUE_EXPANSION_FACTOR) break;
      if (link.origin !== allowedOrigin) continue;
      const rawLinkUrl = link.toString();
      const candidate = normalizeCrawlUrl(rawLinkUrl);
      if (!candidate || visited.has(candidate) || isAssetLikePath(link.pathname)) continue;
      queue.push({ url: candidate, rawUrl: rawLinkUrl, depth: next.depth + 1 });
    }
  }

  if (deadlineHit || Date.now() > deadline) {
    warn(
      "[akm] website crawl stopped at the %ds wall-clock cap with %d/%d pages collected from %s.",
      wallClockCapMs / 1000,
      pages.length,
      options.maxPages,
      startUrl,
    );
  }

  return pages;
}

/**
 * Sentinel thrown by `fetchWebsiteResponse` when a redirect hop's target is
 * disallowed by robots.txt (see the doc comment above the check in
 * `fetchWebsiteResponse`). Never escapes `fetchWebsitePage`, which maps it to
 * `null` — the same "page skipped, no error" outcome as any other
 * robots-disallowed URL. Not exported; purely an internal control-flow
 * signal between the two functions.
 */
class RobotsDisallowedRedirectError extends Error {
  constructor(url: string) {
    super(`robots.txt disallows redirect target ${url}`);
    this.name = "RobotsDisallowedRedirectError";
  }
}

async function fetchWebsitePage(
  pageUrl: string,
  options?: WebsiteValidationOptions,
): Promise<{ page: WebsitePage; links: URL[] } | null> {
  let response: Response;
  try {
    response = await fetchWebsiteResponse(pageUrl, 0, options);
  } catch (err) {
    if (err instanceof RobotsDisallowedRedirectError) return null;
    throw err;
  }

  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`Failed to fetch website content (${response.status}) from ${pageUrl}`);
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  let body: string;
  try {
    body = await readBodyWithByteCap(response, WEBSITE_PAGE_BYTE_CAP, {
      bodyTimeoutMs: WEBSITE_PAGE_BODY_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof ResponseTooLargeError) return null;
    throw err;
  }
  const rawFinalUrl = response.url || pageUrl;
  const finalUrl = normalizeCrawlUrl(rawFinalUrl) ?? pageUrl;
  assertWebsiteRequestUrl(finalUrl, Error, options);

  // Re-check robots.txt against the FINAL (post-redirect) URL, not just the
  // pre-redirect URL crawlWebsite already gated. normalizeCrawlUrl strips
  // trailing slashes before the initial gate, so a rule shaped like
  // `Disallow: /secret/` correctly lets `/secret` through that gate; if the
  // server then redirects to `/secret/` (a common trailing-slash
  // canonicalization), the disallowed page would otherwise be fetched and
  // stored without ever being weighed against robots.txt. See spec §4.6 C-04.
  // Checks `rawFinalUrl` (the un-normalized `response.url`, slash intact) as
  // well as `finalUrl`, per `isCrawlUrlAllowedByRobots` — `normalizeCrawlUrl`
  // would otherwise strip the very trailing slash a `Disallow: /secret/`
  // rule needs to match.
  if (options?.robots && !(await isCrawlUrlAllowedByRobots(options.robots, finalUrl, rawFinalUrl))) {
    warnVerbose("[akm] website crawl: skipping %s (disallowed by robots.txt after redirect)", finalUrl);
    return null;
  }

  if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml") || looksLikeMarkup(body)) {
    const title = extractHtmlTitle(body) || new URL(finalUrl).hostname;
    return {
      page: {
        url: finalUrl,
        title,
        markdown: htmlToMarkdown(body, finalUrl),
      },
      links: extractDocumentLinks(body, finalUrl),
    };
  }

  return {
    page: {
      url: finalUrl,
      title: extractTextTitle(body) || new URL(finalUrl).hostname,
      markdown: body.trim(),
    },
    links: [],
  };
}

async function fetchWebsiteResponse(
  pageUrl: string,
  redirectCount = 0,
  options?: WebsiteValidationOptions,
): Promise<Response> {
  assertWebsiteRequestUrl(pageUrl, Error, options);
  // Resolve-then-validate BEFORE connecting: the hostname checks above only
  // catch IP-literal / well-known-name hosts, so a public-looking DNS name that
  // resolves into a private range would otherwise slip through. This runs on
  // every hop because the redirect path re-enters this function recursively.
  await assertResolvedHostAllowed(new URL(pageUrl).hostname, options);
  const response = await fetchWithRetry(
    pageUrl,
    {
      headers: {
        Accept: "text/html, text/markdown, text/plain;q=0.9, application/xhtml+xml;q=0.8",
        "User-Agent": "akm-cli website provider",
      },
      redirect: "manual",
    },
    { timeout: 15_000, retries: 1 },
  );

  if (response.status >= 300 && response.status < 400) {
    if (redirectCount >= WEBSITE_MAX_REDIRECTS) {
      throw new Error(`Too many redirects while fetching ${pageUrl}`);
    }
    const location = response.headers.get("location");
    if (!location) {
      throw new Error(`Redirect response from ${pageUrl} did not include a Location header`);
    }
    const nextUrl = new URL(location, pageUrl).toString();
    assertWebsiteRequestUrl(nextUrl, Error, options);

    // Robots-check every intermediate redirect hop, not just the pre-redirect
    // queue URL (`crawlWebsite`'s gate) and the FINAL URL (the post-redirect
    // recheck below in `fetchWebsitePage`). Without this, a chain like
    // `/go` -> 302 `/secret/` -> 302 `/public` issues a live GET to
    // `/secret/` even when robots.txt disallows it, because that hop is
    // never the queue URL and never the final URL. Only gated when a
    // `RobotsPolicy` was actually threaded in (`crawlWebsite`); single-URL
    // `fetchWebsiteMarkdownSnapshot` fetches stay deliberately ungated per
    // spec §1.
    if (options?.robots) {
      const normalizedNext = normalizeCrawlUrl(nextUrl);
      if (!normalizedNext) {
        // `normalizeCrawlUrl` returns null for anything that isn't http(s) —
        // a redirect `Location` can legally point at `mailto:`, `tel:`, a
        // bare relative path that resolves to an opaque scheme, etc.
        // `RobotsPolicy.rulesFor` computes `new URL(url).origin` and then
        // resolves `/robots.txt` against it; for a non-http(s) URL that
        // origin is the literal string "null", and re-resolving against it
        // throws an unhandled TypeError that aborts the whole crawl. Refuse
        // the hop outright instead of ever handing such a URL to the policy —
        // `fetchWebsitePage` maps this to a graceful skip. Regression
        // introduced by a67412c, which fell back to the raw `nextUrl` here.
        warnVerbose("[akm] website crawl: skipping redirect to %s (not an http(s) URL)", nextUrl);
        throw new RobotsDisallowedRedirectError(nextUrl);
      }
      if (!(await isCrawlUrlAllowedByRobots(options.robots, normalizedNext, nextUrl))) {
        warnVerbose("[akm] website crawl: skipping redirect to %s (disallowed by robots.txt)", nextUrl);
        throw new RobotsDisallowedRedirectError(nextUrl);
      }
    }

    return fetchWebsiteResponse(nextUrl, redirectCount + 1, options);
  }

  return response;
}

/**
 * Fetches and classifies `<origin>/robots.txt`. Reuses `fetchWebsiteResponse`
 * (spec §6.2: no second fetch path) so robots.txt gets the exact same SSRF
 * guards, retry, and redirect handling as a page fetch.
 *
 * Steps 1–2 (the guard on the INITIAL URL) run OUTSIDE the try/catch on
 * purpose: a guard rejection there must propagate as-is, never be downgraded
 * to "unavailable" (spec §4.5 F-12, §6.2). Guard rejections on a LATER
 * redirect hop happen inside `fetchWebsiteResponse`, which the try/catch
 * below does cover — the guard has already refused to fetch that host, so
 * only the error *reporting* is downgraded (F-11).
 */
export async function loadRobotsTxt(
  robotsUrl: string,
  options?: WebsiteValidationOptions,
): Promise<RobotsFetchOutcome> {
  assertWebsiteRequestUrl(robotsUrl, UsageError, options);
  await assertResolvedHostAllowed(new URL(robotsUrl).hostname, options);

  try {
    const response = await fetchWebsiteResponse(robotsUrl, 0, options);

    if (response.status >= 200 && response.status < 300) {
      try {
        const text = await readBodyWithByteCap(response, ROBOTS_BYTE_CAP, {
          bodyTimeoutMs: ROBOTS_BODY_TIMEOUT_MS,
        });
        return { kind: "body", text };
      } catch (err) {
        if (err instanceof ResponseTooLargeError) {
          warn(
            "[akm] robots.txt at %s exceeded the %d-byte cap; treating it as unavailable.",
            robotsUrl,
            ROBOTS_BYTE_CAP,
          );
          return { kind: "unavailable" };
        }
        throw err;
      }
    }

    if (response.status >= 500 && response.status < 600) {
      // RFC 9309 §2.3.1.4: an unreachable robots.txt is a full disallow, not
      // an allow-all. `fetchWithRetry` already retried this once, so a
      // transient blip does not trip it.
      warn(
        "[akm] robots.txt at %s returned %d; treating the crawl as fully disallowed until it recovers. " +
          "Set respectRobots: false on this website source to bypass robots.txt.",
        robotsUrl,
        response.status,
      );
      return { kind: "unreachable" };
    }

    // 4xx (404 is the common, silent case), and any other non-2xx/5xx status.
    return { kind: "unavailable" };
  } catch (err) {
    warnVerbose(
      "[akm] failed to fetch robots.txt at %s: %s",
      robotsUrl,
      err instanceof Error ? err.message : String(err),
    );
    return { kind: "unavailable" };
  }
}

/**
 * Coerces `SourceConfigEntry.options.respectRobots` to a boolean. The bundle
 * descriptor is boolean-validated at config load (schema), but the legacy
 * `sources[].options` bag is `z.record(z.unknown())` and accepts anything, so
 * the runtime read still validates. A misspelled non-boolean opt-out fails
 * loudly (`ConfigError`) rather than silently defaulting either way — the
 * user would otherwise think robots.txt handling is something other than
 * what akm is actually doing (spec §4.7).
 */
export function coerceRespectRobots(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  throw new ConfigError(
    `Invalid value for respectRobots: expected a boolean (or "true"/"false"), got ${JSON.stringify(value)}.`,
  );
}

function buildMarkdownSnapshot(page: WebsitePage, slug: string, tags?: string[]): string {
  const title = sanitizeString(page.title, 200) || slug;
  const host = sanitizeString(new URL(page.url).hostname, 120);
  const description = sanitizeString(`Website snapshot from ${host}`, 500);
  const content = page.markdown.trim() || `Source: ${page.url}`;
  const normalizedTags = Array.from(new Set(["website", host, ...(tags ?? [])]));

  return [
    "---",
    `name: ${JSON.stringify(slug)}`,
    `description: ${JSON.stringify(description)}`,
    `sourceUrl: ${JSON.stringify(page.url)}`,
    `title: ${JSON.stringify(title)}`,
    `updated: ${todayIso()}`,
    "lint_skip:",
    "  - stale-path",
    "tags:",
    ...normalizedTags.map((tag) => `  - ${JSON.stringify(tag)}`),
    "---",
    "",
    `# ${title}`,
    "",
    `Source: ${page.url}`,
    "",
    content,
    "",
  ].join("\n");
}

export function validateWebsiteUrl(rawUrl: string, options?: WebsiteValidationOptions): string {
  return validateWebsiteUrlWithError(rawUrl, ConfigError, options);
}

export function validateWebsiteInputUrl(rawUrl: string, options?: WebsiteValidationOptions): string {
  return validateWebsiteUrlWithError(rawUrl, UsageError, options);
}

function validateWebsiteUrlWithError(
  rawUrl: string,
  ErrorType: typeof ConfigError | typeof UsageError,
  options?: WebsiteValidationOptions,
): string {
  if (!rawUrl) {
    throw new ErrorType("Website provider requires a URL");
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ErrorType(`Website URL is not valid: "${rawUrl}"`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ErrorType(`Website URL must use http:// or https://, got "${parsed.protocol}" in "${rawUrl}"`);
  }
  if (parsed.username || parsed.password) {
    throw new ErrorType("Website URL must not contain embedded credentials");
  }
  assertWebsiteRequestUrl(parsed.toString(), ErrorType, options);

  parsed.hash = "";
  return normalizeSiteUrl(parsed.toString());
}

function normalizeSiteUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  parsed.hash = "";
  if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  }
  return parsed.toString();
}

function normalizeCrawlUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.hash = "";
    if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * D-R6: `index.md`/`log.md` are OKF reserved structural filenames at every
 * depth — no adapter indexes them, so a crawled page must never land on one.
 * Same remap convention as the content migration (`index.md` →
 * `index-content.md`). Segments are already lowercased by slugifySegment.
 */
function avoidReservedBasename(relPath: string): string {
  const segments = relPath.split("/");
  const last = segments[segments.length - 1] ?? "";
  if (last === "index" || last === "log") {
    segments[segments.length - 1] = `${last}-content`;
  }
  return segments.join("/");
}

function urlToRelativePath(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  const segments = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => slugifySegment(segment))
    .filter(Boolean);
  if (parsed.search) {
    const querySuffix = slugifySegment(parsed.search.slice(1));
    if (querySuffix && segments.length > 0) {
      segments[segments.length - 1] = `${segments[segments.length - 1]}_${querySuffix}`;
    }
  }
  return segments.length > 0 ? segments.join("/") : "index";
}

function deriveImportPath(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  const relativePath = urlToRelativePath(rawUrl);
  if (relativePath !== "index") return relativePath;

  const host = slugifySegment(parsed.hostname) || "website";
  if (!parsed.search) return host;

  const querySuffix = slugifySegment(parsed.search.slice(1));
  return querySuffix ? `${host}-${querySuffix}` : host;
}

function slugifySegment(value: string): string {
  return sanitizeString(value, 200)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function uniqueSlug(base: string, used: Set<string>): string {
  const seed = base || "website";
  let candidate = seed;
  let i = 2;
  while (used.has(candidate)) {
    candidate = `${seed}-${i}`;
    i += 1;
  }
  used.add(candidate);
  return candidate;
}

function coercePositiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function looksLikeMarkup(body: string): boolean {
  return /<html[\s>]|<body[\s>]|<\/[a-z][\w:-]*>/i.test(body);
}

/** True for URL paths that are plainly binary assets, never crawlable pages. */
function isAssetLikePath(pathname: string): boolean {
  return /\.(css|js|json|png|jpe?g|gif|svg|ico|webp|pdf|zip|tar|gz|mp4|mp3|woff2?)$/i.test(pathname);
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

function decodeHtmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    nbsp: " ",
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  };

  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    const normalized = String(entity).toLowerCase();
    if (normalized.startsWith("#x")) {
      return safeCodePointToString(Number.parseInt(normalized.slice(2), 16)) ?? match;
    }
    if (normalized.startsWith("#")) {
      return safeCodePointToString(Number.parseInt(normalized.slice(1), 10)) ?? match;
    }
    return namedEntities[normalized] ?? match;
  });
}

function extractHtmlTitle(html: string): string | undefined {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (title) return decodeHtmlEntities(stripTags(title)).trim();
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  if (h1) return decodeHtmlEntities(stripTags(h1)).trim();
  return undefined;
}

function extractTextTitle(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) return trimmed.replace(/^#+\s*/, "");
    return trimmed.slice(0, 120);
  }
  return undefined;
}

function safeCodePointToString(value: number): string | undefined {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return undefined;
  try {
    return String.fromCodePoint(value);
  } catch {
    return undefined;
  }
}

// Re-exported for existing importers (the SSRF suite pins these entry points).
export { assertResolvedHostAllowed, type HostnameResolver } from "./host-guard";
