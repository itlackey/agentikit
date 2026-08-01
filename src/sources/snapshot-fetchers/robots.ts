// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * robots.txt parsing, matching, and a crawl-scoped fetch/cache policy.
 *
 * Behavioral reference: docs/plans/specs/p1-robots.md (authoritative). This
 * module is a clean rewrite against akm's contracts, not a port of any
 * upstream source file.
 *
 * Pure by design: no fetching happens here (see `RobotsTxtLoader`/
 * `loadRobotsTxt` in `website-ingest.ts`), and there is deliberately no
 * module-level mutable state. The per-origin cache lives on the object
 * `createRobotsPolicy` returns so it dies with the crawl that created it —
 * a module-level `Map` would leak `disallowAll` results across crawls and
 * across the test suite's process-wide `bun test` run (see spec §6.1).
 */

import { warnVerbose } from "../../core/warn";

// ── §2 Constants (pinned by spec) ───────────────────────────────────────────

/** Group-matching tokens for `User-agent`, compared case-insensitively. */
export const ROBOTS_PRODUCT_TOKENS = ["akm", "akm-cli"] as const;
/** 512 KiB. RFC 9309 §2.5 requires parsing at least 500 KiB. */
export const ROBOTS_BYTE_CAP = 512 * 1024;
/** Matches the existing website page-fetch timeout. */
export const ROBOTS_FETCH_TIMEOUT_MS = 15_000;
/** Body-read deadline; robots.txt is tiny. */
export const ROBOTS_BODY_TIMEOUT_MS = 15_000;
/** Ceiling applied to any parsed `Crawl-delay`, so a hostile robots.txt cannot stall the crawl. */
export const MAX_CRAWL_DELAY_MS = 10_000;
/** Identical to the existing website-fetch `User-Agent` header. */
export const ROBOTS_USER_AGENT_HEADER = "akm-cli website provider";

// ── §3 Public API surface (pinned by spec) ──────────────────────────────────

export type RobotsRuleKind = "allow" | "disallow";

export interface RobotsPathRule {
  readonly kind: RobotsRuleKind;
  /** Raw pattern text as written in robots.txt, e.g. "/private/", "/*.pdf$". */
  readonly pattern: string;
  /** Match specificity = pattern.length. Used for longest-match-wins. */
  readonly specificity: number;
}

export interface RobotsRuleSet {
  /** true => the entire origin is off-limits regardless of `rules`. */
  readonly disallowAll: boolean;
  readonly rules: readonly RobotsPathRule[];
  /** Already clamped to [0, MAX_CRAWL_DELAY_MS]; null when unspecified. */
  readonly crawlDelayMs: number | null;
}

export const ALLOW_ALL_RULES: RobotsRuleSet = { disallowAll: false, rules: [], crawlDelayMs: null };
export const DISALLOW_ALL_RULES: RobotsRuleSet = { disallowAll: true, rules: [], crawlDelayMs: null };

export type RobotsFetchOutcome =
  | { readonly kind: "body"; readonly text: string }
  | { readonly kind: "unavailable" } // 4xx / oversized / transport failure => allow all
  | { readonly kind: "unreachable" }; // 5xx => disallow all

/** Injected by website-ingest.ts. Receives the absolute `<origin>/robots.txt` URL. */
export type RobotsTxtLoader = (robotsUrl: string) => Promise<RobotsFetchOutcome>;

export interface RobotsPolicy {
  /** Resolves (and caches) the rule set for the URL's origin. */
  rulesFor(url: string): Promise<RobotsRuleSet>;
  isAllowed(url: string): Promise<boolean>;
  /** Clamped crawl delay in ms for the URL's origin; 0 when none. */
  crawlDelayMs(url: string): Promise<number>;
}

// ── §4.1/§4.2 parseRobotsTxt ─────────────────────────────────────────────────

interface RobotsGroup {
  /** Lowercased User-agent tokens naming this group. */
  agents: string[];
  rules: RobotsPathRule[];
  /** Unclamped ms; clamping happens once at the end, on the selected max. */
  crawlDelayMsRaw: number | null;
}

/** Strips a trailing `# comment` (RFC 9309 comments run to end of line). */
function stripRobotsComment(line: string): string {
  const hashIndex = line.indexOf("#");
  return hashIndex === -1 ? line : line.slice(0, hashIndex);
}

/**
 * Parses a `Crawl-delay` value (seconds, possibly fractional) into ms.
 * Non-positive, unparseable, and empty values are ignored (`null`).
 * `Infinity` is preserved so the caller's clamp reduces it to the ceiling
 * rather than the value silently vanishing.
 */
function parseCrawlDelayMs(raw: string): number | null {
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isNaN(seconds) || seconds <= 0) return null;
  return Math.round(seconds * 1000);
}

/**
 * Pure. Never throws, never fetches.
 *
 * Grouping follows RFC 9309 §2.2.1: consecutive `User-agent` lines (no
 * intervening directive) form one group; a matching *specific* product-token
 * group suppresses the wildcard (`*`) group entirely; rules from all matching
 * groups of the winning kind are unioned; `Crawl-delay` is the maximum across
 * those groups, clamped once at the end.
 */
export function parseRobotsTxt(text: string): RobotsRuleSet {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = stripped.split(/\r\n|\r|\n/);

  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  // True once any non-user-agent directive has been seen for `current`, so
  // the next `User-agent` line starts a NEW group instead of extending it.
  let sawDirectiveSinceLastUserAgent = false;

  for (const rawLine of lines) {
    const line = stripRobotsComment(rawLine).trim();
    if (!line) continue;

    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue; // P-21: no colon => ignored

    const directive = line.slice(0, colonIndex).trim().toLowerCase();
    const value = line.slice(colonIndex + 1).trim();

    if (directive === "user-agent") {
      if (!value) continue;
      const token = value.toLowerCase();
      if (current && !sawDirectiveSinceLastUserAgent) {
        current.agents.push(token);
      } else {
        current = { agents: [token], rules: [], crawlDelayMsRaw: null };
        groups.push(current);
        sawDirectiveSinceLastUserAgent = false;
      }
      continue;
    }

    if (!current) continue; // P-13: directive with no preceding User-agent => ignored
    sawDirectiveSinceLastUserAgent = true;

    if (directive === "disallow" || directive === "allow") {
      if (!value) continue; // P-16: empty value matches nothing
      if (!(value.startsWith("/") || value.startsWith("*"))) {
        // P-18: neither "/" nor "*"-rooted => ignored, diagnosed quietly.
        warnVerbose("[akm] robots.txt: ignoring %s value %s (patterns must start with '/' or '*')", directive, value);
        continue;
      }
      current.rules.push({
        kind: directive === "allow" ? "allow" : "disallow",
        pattern: value,
        specificity: value.length,
      });
      continue;
    }

    if (directive === "crawl-delay") {
      const parsed = parseCrawlDelayMs(value);
      if (parsed !== null) current.crawlDelayMsRaw = parsed;
    }

    // Sitemap / unknown directives: ignored without diagnostic (P-19, P-20).
  }

  const productTokens: readonly string[] = ROBOTS_PRODUCT_TOKENS;
  const specificGroups = groups.filter((group) => group.agents.some((agent) => productTokens.includes(agent)));
  const wildcardGroups = groups.filter((group) => group.agents.includes("*"));
  const selected = specificGroups.length > 0 ? specificGroups : wildcardGroups;

  const rules = selected.flatMap((group) => group.rules);
  let maxDelayMs: number | null = null;
  for (const group of selected) {
    if (group.crawlDelayMsRaw !== null) {
      maxDelayMs = maxDelayMs === null ? group.crawlDelayMsRaw : Math.max(maxDelayMs, group.crawlDelayMsRaw);
    }
  }
  const crawlDelayMs = maxDelayMs === null ? null : Math.min(maxDelayMs, MAX_CRAWL_DELAY_MS);

  return { disallowAll: false, rules, crawlDelayMs };
}

// ── §4.3 isPathAllowedByRobots ───────────────────────────────────────────────

// Every regex metacharacter EXCEPT '*' (our wildcard) and a trailing '$'
// (our end-anchor, handled separately). Escaping these keeps a hostile
// pattern like "/a(b)" or "/a+b" from being interpreted as a sub-pattern.
const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;

/**
 * Compiles a robots.txt path pattern to a RegExp. Anchored at the start
 * always; a single TRAILING `$` additionally anchors the end (a `$`
 * elsewhere in the pattern is a literal character, matching RFC 9309/Google's
 * convention). Consecutive `*` characters collapse to a single wildcard
 * BEFORE compiling, so an attacker-supplied run of stars (`/****...`) cannot
 * produce a regex with nested `.*` quantifiers that would otherwise invite
 * catastrophic backtracking (spec §6.4).
 *
 * Recompiled on every call rather than cached: `robots.ts` must carry no
 * module-level mutable state (spec §6.1/§4.4 acceptance criteria), and
 * compiling a short pattern is microseconds — the actual DoS risk this
 * guards against is backtracking during matching, not recompilation cost.
 */
function compileRobotsPattern(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const collapsed = body.replace(/\*+/g, "*");
  const segments = collapsed.split("*").map((segment) => segment.replace(REGEX_SPECIAL_CHARS, "\\$&"));
  const source = `^${segments.join(".*")}${anchored ? "$" : ""}`;
  return new RegExp(source);
}

/**
 * Pure. `url` is an absolute http(s) URL string. Matching uses
 * `pathname + search` of the parsed URL. Returns true when the URL cannot be
 * parsed (caller has already validated it; do not fail closed on a parse bug).
 */
export function isPathAllowedByRobots(rules: RobotsRuleSet, url: string): boolean {
  if (rules.disallowAll) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true; // M-32: fail open, never closed, on an unparseable URL.
  }

  const target = `${parsed.pathname}${parsed.search}`;
  let best: RobotsPathRule | null = null;
  for (const rule of rules.rules) {
    if (!compileRobotsPattern(rule.pattern).test(target)) continue;
    const isMoreSpecific = !best || rule.specificity > best.specificity;
    // Tie goes to Allow (least restrictive) — order-independent: this only
    // upgrades a disallow to an allow at equal specificity, never the reverse.
    const isTieBrokenByAllow =
      best !== null && rule.specificity === best.specificity && rule.kind === "allow" && best.kind === "disallow";
    if (isMoreSpecific || isTieBrokenByAllow) best = rule;
  }

  return best ? best.kind === "allow" : true;
}

// ── §4.4 createRobotsPolicy / createAllowAllRobotsPolicy ────────────────────

function outcomeToRuleSet(outcome: RobotsFetchOutcome): RobotsRuleSet {
  switch (outcome.kind) {
    case "body":
      return parseRobotsTxt(outcome.text);
    case "unavailable":
      return ALLOW_ALL_RULES;
    case "unreachable":
      return DISALLOW_ALL_RULES;
  }
}

/**
 * Crawl-scoped. Caches per origin (including in-flight promises) so the
 * `load` callback runs at most once per origin regardless of how many pages
 * or concurrent lookups reference it. Deliberately NOT a module-level cache
 * (see the file-level doc comment) — callers construct one instance per crawl.
 */
export function createRobotsPolicy(load: RobotsTxtLoader): RobotsPolicy {
  const cache = new Map<string, Promise<RobotsRuleSet>>();

  function rulesForOrigin(origin: string): Promise<RobotsRuleSet> {
    const cached = cache.get(origin);
    if (cached) return cached;

    const robotsUrl = new URL("/robots.txt", origin).toString();
    const pending = load(robotsUrl).then(outcomeToRuleSet);
    // A rejected fetch must not poison the cache: the next lookup for this
    // origin should retry the loader rather than replaying the same failure
    // forever (spec §4.4 L-04).
    pending.catch(() => {
      if (cache.get(origin) === pending) cache.delete(origin);
    });
    cache.set(origin, pending);
    return pending;
  }

  return {
    rulesFor: (url) => rulesForOrigin(new URL(url).origin),
    isAllowed: async (url) => isPathAllowedByRobots(await rulesForOrigin(new URL(url).origin), url),
    crawlDelayMs: async (url) => (await rulesForOrigin(new URL(url).origin)).crawlDelayMs ?? 0,
  };
}

/** Never fetches. isAllowed => true, crawlDelayMs => 0. Used when respectRobots is false. */
export function createAllowAllRobotsPolicy(): RobotsPolicy {
  return {
    rulesFor: async () => ALLOW_ALL_RULES,
    isAllowed: async () => true,
    crawlDelayMs: async () => 0,
  };
}
