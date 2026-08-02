# P1 — robots.txt compliance (behavior spec)

**Status:** ready for test authoring
**Phase:** P1 of the inform capability port
**Owner artifacts:** `src/sources/snapshot-fetchers/robots.ts` (new),
`src/sources/snapshot-fetchers/website-ingest.ts` (modified)

This document is the **single source of truth** for the test author and the
implementer of P1. Neither reads the parent plan's phase section; everything
needed is here.

---

## 0. Summary

akm's `website` source provider crawls a site (`crawlWebsite` in
`website-ingest.ts`) with no awareness of `/robots.txt`. P1 makes akm a polite
crawler: before crawling an origin it fetches and parses that origin's
`robots.txt`, skips paths the site disallows for our product token, and honors
`Crawl-delay` (clamped).

**This is a deliberate behavior change.** `respectRobots` defaults to `true`,
so existing website sources may return fewer pages after upgrade. The opt-out
is `respectRobots: false` on the website source descriptor.

---

## 1. Scope

### In scope

- New module `src/sources/snapshot-fetchers/robots.ts`: a pure parser + matcher
  plus a crawl-scoped, per-origin caching policy object.
- `crawlWebsite()` in `website-ingest.ts` consults the policy before every page
  fetch and spaces requests by `Crawl-delay`.
- `ensureWebsiteMirror()` reads `options.respectRobots` and threads it down.
- `respectRobots` added to the website descriptor in the config zod schema, with
  the generated JSON schema regenerated.
- CHANGELOG entry and docs describing the change and the opt-out.

### Explicitly out of scope for P1

| Item | Decision | Rationale |
|---|---|---|
| `fetchWebsiteMarkdownSnapshot()` (the single-URL `akm add <url>` snapshot path) | **Not gated by robots.txt** | It is a user-directed fetch of one URL the user typed, not a crawl. There is no config entry to carry `respectRobots` at that point, so gating it would produce a hard failure with no local opt-out. If a reviewer wants it gated, the follow-up is a `--ignore-robots` CLI flag, not a silent block. |
| `Sitemap:` directive | Parsed lines ignored | No consumer in P1. |
| A `--respect-robots` / `--ignore-robots` CLI flag on `akm bundle add` | Not added | Config-only surface in P1. |
| Cross-origin robots caching beyond one crawl | Not added | Cache is crawl-scoped by construction (see §6.1). |
| `robots.txt` `Allow`-aware *fetch scheduling* / host-level rate limiting beyond `Crawl-delay` | Not added | — |

---

## 2. Constants (pin these exactly)

Exported from `robots.ts` unless noted.

| Constant | Value | Notes |
|---|---|---|
| `ROBOTS_PRODUCT_TOKENS` | `["akm", "akm-cli"]` (readonly, lowercase) | Group-matching tokens. |
| `ROBOTS_BYTE_CAP` | `512 * 1024` | 512 KiB. RFC 9309 §2.5 requires parsing at least 500 KiB. |
| `ROBOTS_FETCH_TIMEOUT_MS` | `15_000` | Matches the existing page-fetch timeout. |
| `ROBOTS_BODY_TIMEOUT_MS` | `15_000` | Body-read deadline; robots.txt is tiny. |
| `MAX_CRAWL_DELAY_MS` | `10_000` | Ceiling applied to any parsed `Crawl-delay`. |
| `ROBOTS_USER_AGENT_HEADER` | `"akm-cli website provider"` | Sent as `User-Agent`; identical to the existing website fetch UA. Not a new string — reuse the literal already in `fetchWebsiteResponse`. |

---

## 3. Public API surface (pin these signatures)

Tests and the implementation must agree on these. No barrel exports; import by
path (`../../src/sources/snapshot-fetchers/robots`).

```ts
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

export const ALLOW_ALL_RULES: RobotsRuleSet;    // { disallowAll: false, rules: [], crawlDelayMs: null }
export const DISALLOW_ALL_RULES: RobotsRuleSet; // { disallowAll: true,  rules: [], crawlDelayMs: null }

/** Pure. Never throws, never fetches. */
export function parseRobotsTxt(text: string): RobotsRuleSet;

/**
 * Pure. `url` is an absolute http(s) URL string. Matching uses
 * `pathname + search` of the parsed URL. Returns true when the URL cannot be
 * parsed (caller has already validated it; do not fail closed on a parse bug).
 */
export function isPathAllowedByRobots(rules: RobotsRuleSet, url: string): boolean;

export type RobotsFetchOutcome =
  | { readonly kind: "body"; readonly text: string }
  | { readonly kind: "unavailable" }   // 4xx / oversized / transport failure => allow all
  | { readonly kind: "unreachable" };  // 5xx => disallow all

/** Injected by website-ingest.ts. Receives the absolute `<origin>/robots.txt` URL. */
export type RobotsTxtLoader = (robotsUrl: string) => Promise<RobotsFetchOutcome>;

export interface RobotsPolicy {
  /** Resolves (and caches) the rule set for the URL's origin. */
  rulesFor(url: string): Promise<RobotsRuleSet>;
  isAllowed(url: string): Promise<boolean>;
  /** Clamped crawl delay in ms for the URL's origin; 0 when none. */
  crawlDelayMs(url: string): Promise<number>;
}

/** Crawl-scoped. Caches per origin (including in-flight promises). */
export function createRobotsPolicy(load: RobotsTxtLoader): RobotsPolicy;

/** Never fetches. isAllowed => true, crawlDelayMs => 0. Used when respectRobots is false. */
export function createAllowAllRobotsPolicy(): RobotsPolicy;
```

`robots.ts` must **not** import from `website-ingest.ts` (circular). The guarded
fetch lives in `website-ingest.ts` and is passed in as a `RobotsTxtLoader`.

---

## 4. Behavior tables

### 4.1 `parseRobotsTxt` — grouping and directives

Input is the raw robots.txt body. Output is a `RobotsRuleSet`.

| # | Input | Expected output |
|---|---|---|
| P-01 | `""` (empty) | `{ disallowAll: false, rules: [], crawlDelayMs: null }` |
| P-02 | Whitespace / comments only (`# hi\n\n   \n`) | Same as P-01 |
| P-03 | `User-agent: *\nDisallow: /private/` | one `disallow` rule `/private/` |
| P-04 | `USER-AGENT: *\nDISALLOW: /a` | Same as P-03 with `/a` — directive names are case-**insensitive** |
| P-05 | `User-agent: *\nDisallow: /Case` | Rule pattern kept verbatim `/Case` — pattern values are case-**sensitive** |
| P-06 | `user-agent: akm\nDisallow: /x` | Matches: `akm` is in `ROBOTS_PRODUCT_TOKENS` |
| P-07 | `User-agent: AKM-CLI\nDisallow: /x` | Matches (case-insensitive token compare) |
| P-08 | `User-agent: googlebot\nDisallow: /x` | No matching specific group and no `*` group → `rules: []` |
| P-09 | `User-agent: *\nDisallow: /all\n\nUser-agent: akm\nDisallow: /mine` | **Only** `/mine`. A matching specific group **suppresses the `*` group entirely.** |
| P-10 | `User-agent: akm\nUser-agent: akm-cli\nDisallow: /x` | Consecutive UA lines form ONE group; `/x` applied once (dedupe identical rules is optional; one or two identical entries both acceptable — assert on match behavior, not array length) |
| P-11 | `User-agent: akm\nDisallow: /a\n\nUser-agent: akm-cli\nDisallow: /b` | Both `/a` and `/b` — rules from **all** matching specific groups are unioned |
| P-12 | `User-agent: *\nDisallow: /a\n\nUser-agent: *\nDisallow: /b` | Both `/a` and `/b` — multiple `*` groups are unioned |
| P-13 | `Disallow: /orphan` (no preceding `User-agent`) | Ignored → `rules: []` |
| P-14 | Lines terminated with CRLF (`\r\n`) | Parsed identically to LF; no `\r` leaks into a pattern |
| P-15 | `User-agent: *  # our bot\nDisallow: /x # secret` | Comment stripped; `pattern === "/x"`, group value `*` |
| P-16 | `User-agent: *\nDisallow:` (empty value) | Ignored — an empty `Disallow` matches nothing (RFC 9309: allows everything) |
| P-17 | `User-agent: *\nAllow: /pub/\nDisallow: /` | one `allow` `/pub/` + one `disallow` `/` |
| P-18 | `User-agent: *\nDisallow: relative/path` | Ignored (value starts with neither `/` nor `*`); emit `warnVerbose`, not `warn` |
| P-19 | `User-agent: *\nSitemap: https://x/s.xml` | Ignored; no rules, no error |
| P-20 | `User-agent: *\nUnknown-Directive: foo` | Ignored; no rules, no error |
| P-21 | A line with no `:` (`garbage`) | Ignored |
| P-22 | `User-agent: *\nDisallow: /a:b` | Pattern is `/a:b` — only the **first** `:` splits directive from value |
| P-23 | Leading UTF-8 BOM before `User-agent` | BOM stripped; group parsed normally |
| P-24 | 5000 rule lines | Parsed without error (no pathological blowup); no cap required |

### 4.2 `parseRobotsTxt` — `Crawl-delay`

| # | Input (within a matching group) | `crawlDelayMs` |
|---|---|---|
| D-01 | `Crawl-delay: 2` | `2000` |
| D-02 | `Crawl-delay: 0.5` | `500` |
| D-03 | `Crawl-delay: 0` | `null` (non-positive ignored) |
| D-04 | `Crawl-delay: -5` | `null` |
| D-05 | `Crawl-delay: abc` | `null` |
| D-06 | `Crawl-delay:` (empty) | `null` |
| D-07 | `Crawl-delay: 3600` | `10000` — clamped to `MAX_CRAWL_DELAY_MS` |
| D-08 | `Crawl-delay: 1e9` | `10000` — clamped |
| D-09 | Two matching groups with `Crawl-delay: 1` and `Crawl-delay: 4` | `4000` — the **maximum** across selected groups (most polite), then clamped |
| D-10 | `Crawl-delay: 2` inside a **non**-matching group only | `null` |
| D-11 | `Crawl-delay: 2.5` with a matching group and clamp not hit | `2500` (fractional ms rounded to nearest integer) |
| D-12 | `Crawl-delay: NaN` / `Infinity` | `null` for `NaN`; `10000` for `Infinity` (clamped) |

### 4.3 `isPathAllowedByRobots` — pattern matching

Matching target is `url.pathname + url.search`. Patterns are always anchored at
the **start** of that string. `*` matches any sequence including empty. A single
**trailing** `$` anchors the end; a `$` anywhere else is a literal `$`. All other
regex metacharacters in the pattern are literal.

| # | Rules | URL path | Allowed? |
|---|---|---|---|
| M-01 | `rules: []` | `/anything` | `true` |
| M-02 | `disallowAll: true` | `/` | `false` |
| M-03 | `Disallow: /` | `/` | `false` |
| M-04 | `Disallow: /` | `/deep/page` | `false` |
| M-05 | `Disallow: /private` | `/private` | `false` |
| M-06 | `Disallow: /private` | `/private/x` | `false` (prefix match) |
| M-07 | `Disallow: /private` | `/privateer` | `false` (prefix match, no word boundary — matches RFC 9309) |
| M-08 | `Disallow: /private/` | `/privateer` | `true` |
| M-09 | `Disallow: /private` | `/public` | `true` |
| M-10 | `Disallow: /private` | `/Private` | `true` (paths are case-sensitive) |
| M-11 | `Disallow: /*.pdf$` | `/docs/a.pdf` | `false` |
| M-12 | `Disallow: /*.pdf$` | `/docs/a.pdf?v=1` | `true` (`?v=1` is part of the match target, so `$` no longer anchors) |
| M-13 | `Disallow: /*.pdf` | `/docs/a.pdf?v=1` | `false` |
| M-14 | `Disallow: /a/*/b` | `/a/x/b` | `false` |
| M-15 | `Disallow: /a/*/b` | `/a//b` | `false` (`*` matches empty) |
| M-16 | `Disallow: /a/*/b` | `/a/x/c` | `true` |
| M-17 | `Disallow: /x$` | `/x` | `false` |
| M-18 | `Disallow: /x$` | `/xy` | `true` |
| M-19 | `Disallow: /a$b` | `/a$b` | `false` (mid-pattern `$` is literal) |
| M-20 | `Disallow: /a+b` | `/a+b` | `false` (regex meta escaped) |
| M-21 | `Disallow: /a+b` | `/aab` | `true` |
| M-22 | `Disallow: /a(b)` | `/a(b)` | `false` |
| M-23 | `Disallow: /` **and** `Allow: /pub` | `/pub/x` | `true` — longest match wins (`/pub` len 4 > `/` len 1) |
| M-24 | `Disallow: /` **and** `Allow: /pub` | `/other` | `false` |
| M-25 | `Disallow: /p` **and** `Allow: /p` | `/p` | `true` — tie goes to `Allow` (least restrictive) |
| M-26 | `Disallow: /folder/` **and** `Allow: /folder/*.html$` | `/folder/a.html` | `true` (17 > 9) |
| M-27 | `Disallow: /folder/` **and** `Allow: /folder/*.html$` | `/folder/a.txt` | `false` |
| M-28 | `Allow: /x` only (no disallow) | `/y` | `true` |
| M-29 | `Disallow: /?q=` | `/search?q=1` | `true` — the pattern begins matching at `/` and `?q=` must follow immediately; `/search?q=1` does not start with `/?q=` |
| M-30 | `Disallow: /*?q=` | `/search?q=1` | `false` |
| M-31 | `Disallow: /caf%C3%A9` | `/caf%C3%A9` | `false` — compare the percent-encoded form as `URL.pathname` produces it |
| M-32 | any rules | url string that fails `new URL()` | `true` (do not fail closed on an unparseable input) |

**Specificity note:** `specificity = pattern.length` counting `*` and `$`
characters as written. This is the Google/RFC 9309 convention.

### 4.4 `RobotsTxtLoader` outcome → rule set

Produced by `createRobotsPolicy`'s cache layer.

| # | Loader outcome | Cached `RobotsRuleSet` | Diagnostics |
|---|---|---|---|
| L-01 | `{ kind: "body", text }` | `parseRobotsTxt(text)` | none |
| L-02 | `{ kind: "unavailable" }` | `ALLOW_ALL_RULES` | none from the policy (the loader already warned if warranted) |
| L-03 | `{ kind: "unreachable" }` | `DISALLOW_ALL_RULES` | none from the policy |
| L-04 | loader **throws** | error propagates out of `rulesFor`/`isAllowed`; nothing cached | — |

### 4.5 `loadRobotsTxt` (the loader implemented in `website-ingest.ts`)

Signature: `async function loadRobotsTxt(robotsUrl: string, options?: WebsiteValidationOptions): Promise<RobotsFetchOutcome>`

Order of operations (this order is load-bearing for security — see §6.2):

1. `assertWebsiteRequestUrl(robotsUrl, UsageError, options)` — **outside** the
   try/catch, so guard rejections propagate.
2. `await assertResolvedHostAllowed(new URL(robotsUrl).hostname, options)` —
   also outside the try/catch.
3. Inside a try/catch: `await fetchWebsiteResponse(robotsUrl, 0, options)`
   (the existing helper: `fetchWithRetry` with `{ timeout: 15_000, retries: 1 }`,
   `redirect: "manual"`, manual redirect following re-guarded on every hop,
   capped at `WEBSITE_MAX_REDIRECTS`).
4. Map the response per the table below, reading the body with
   `readBodyWithByteCap(response, ROBOTS_BYTE_CAP, { bodyTimeoutMs: ROBOTS_BODY_TIMEOUT_MS })`.

| # | Condition | Outcome | Diagnostic |
|---|---|---|---|
| F-01 | `200` with body | `{ kind: "body", text }` | none |
| F-02 | `204` / any 2xx with empty body | `{ kind: "body", text: "" }` → parses to allow-all | none |
| F-03 | `404` | `{ kind: "unavailable" }` | none (the common case; must be silent) |
| F-04 | `401` / `403` | `{ kind: "unavailable" }` | none |
| F-05 | any other 4xx | `{ kind: "unavailable" }` | none |
| F-06 | `500` / `502` / `503` / any 5xx (after `fetchWithRetry`'s retry) | `{ kind: "unreachable" }` | `warn()` naming the URL, the status, and that the crawl is being blocked; must mention `respectRobots` |
| F-07 | any other non-2xx (e.g. `1xx`) | `{ kind: "unavailable" }` | none |
| F-08 | body exceeds `ROBOTS_BYTE_CAP` (`ResponseTooLargeError`) | `{ kind: "unavailable" }` | `warn()` naming the URL and the cap |
| F-09 | network error / timeout / abort thrown from `fetchWebsiteResponse` | `{ kind: "unavailable" }` | `warnVerbose()` |
| F-10 | redirect chain exceeds `WEBSITE_MAX_REDIRECTS`, or a redirect `Location` is missing | `{ kind: "unavailable" }` (thrown inside the try) | `warnVerbose()` |
| F-11 | a redirect hop points at a private/forbidden host | `{ kind: "unavailable" }`; **no request is made to that host** (the guard rejects before recursing) | `warnVerbose()` |
| F-12 | `assertWebsiteRequestUrl` / `assertResolvedHostAllowed` reject the *initial* robots URL (step 1–2) | **throws** — never converted to allow-all | — |

Redirect to a different origin is permitted and the resulting body is used for
the **requesting** origin's rules (rules are cached under the origin we asked
about, not the origin that answered).

### 4.6 `crawlWebsite` integration

`crawlWebsite`'s options gain `respectRobots?: boolean`.

```ts
const robots = options.respectRobots === false
  ? createAllowAllRobotsPolicy()
  : createRobotsPolicy((robotsUrl) =>
      loadRobotsTxt(robotsUrl, { allowPrivateHosts: options.allowPrivateHosts }));
```

| # | Situation | Expected behavior |
|---|---|---|
| C-01 | `respectRobots !== false`, start URL allowed | Crawl proceeds as before |
| C-02 | `respectRobots !== false`, **start URL disallowed** | Throw `UsageError` **before** fetching any page. Message must contain the start URL, the robots.txt URL, and the substring `respectRobots` |
| C-03 | Start origin robots.txt is 5xx (`disallowAll`) | Same `UsageError` as C-02, message additionally states that robots.txt returned a server error |
| C-04 | A **queued** (non-start) URL is disallowed | Skip it: do not fetch, do not add to `pages`, mark visited, `warnVerbose` once per skipped URL, continue the loop. No error |
| C-05 | `respectRobots: false` | `createAllowAllRobotsPolicy()` is used: **zero** requests to `/robots.txt`, every URL allowed, crawl delay always `0`. Byte-for-byte identical outcome to pre-P1 behavior |
| C-06 | robots.txt fetched once per origin | The crawl issues exactly **one** `/robots.txt` request per origin regardless of page count (per-origin cache, in-flight promise deduped) |
| C-07 | `Crawl-delay: 2` present | Sleep 2000 ms before each page fetch **after the first**. The first page fetch is not delayed |
| C-08 | `Crawl-delay: 3600` present | Effective delay is `MAX_CRAWL_DELAY_MS` (10 000 ms), never 3 600 000 ms |
| C-09 | No `Crawl-delay` | No sleep at all (timing identical to pre-P1) |
| C-10 | Sleeping would cross the crawl wall-clock deadline (`Date.now() + delayMs >= deadline`) | Break out of the loop instead of sleeping; the existing wall-clock `warn()` fires and partial pages are returned |
| C-11 | Delay accounting | A counter increments after **every** `fetchWebsitePage` call regardless of outcome (200, 404 → `null`, oversized → `null`). A skipped-by-robots URL does **not** increment it |
| C-12 | `pages.length === 0` after robots filtering | Existing `scrapeWebsiteToStash` behavior stands: `No content could be scraped from <url>` — but C-02 makes the start-URL-blocked case an earlier, clearer `UsageError` |
| C-13 | `allowPrivateHosts: true` (test escape hatch) | Threaded into `loadRobotsTxt`, so loopback fixture servers can serve `/robots.txt` |
| C-14 | robots.txt served over a redirect to `https` etc. | Handled by `fetchWebsiteResponse`; no special casing in the crawl |

The robots.txt URL is `new URL("/robots.txt", origin).toString()` — always the
origin root, never relative to the start path.

### 4.7 `ensureWebsiteMirror` config coercion

`coerceRespectRobots(value: unknown): boolean` (private to `website-ingest.ts`):

| # | `config.options?.respectRobots` | Result |
|---|---|---|
| G-01 | `undefined` (key absent) | `true` |
| G-02 | `null` | `true` |
| G-03 | `true` | `true` |
| G-04 | `false` | `false` |
| G-05 | `"false"` / `"FALSE"` / `" false "` | `false` |
| G-06 | `"true"` / `"TRUE"` | `true` |
| G-07 | `0`, `1`, `"no"`, `"yes"`, `{}`, `[]` | Throw `ConfigError` whose message names `respectRobots` and states that a boolean is required |

Rationale for G-07 being loud rather than defaulting: silently ignoring a
misspelled opt-out would make a user think robots is disabled while akm keeps
enforcing it (or vice versa). `ConfigError` exits 78.

---

## 5. Inform-parity notes (deliberate divergences)

inform's reference is `src/RobotsParser.js` (CC-BY-4.0). akm's is a clean
TypeScript rewrite. Where we differ, and why:

| # | inform behavior | akm (P1) behavior | Why |
|---|---|---|---|
| I-01 | `Allow:` is not parsed at all | `Allow:` is parsed and participates in longest-match-wins resolution (§4.3 M-23…M-27) | Without `Allow`, the extremely common `Disallow: /` + `Allow: /docs/` pattern blocks a site the owner explicitly opened to crawlers, producing zero pages. Ignoring `Allow` is stricter than the site intends and is a correctness bug, not a safety feature. |
| I-02 | Group selection: `isRelevant` is set per `User-agent` line and rules accumulate across *any* matching group, including `*` alongside a specific match | A matching **specific** group suppresses the `*` group entirely (§4.1 P-09) | RFC 9309 §2.2.1. Honoring both means we obey rules the site wrote for other crawlers. |
| I-03 | UA match is `ourAgent.includes(pattern) \|\| ourAgent.startsWith(pattern)` against the full UA string `Inform/1.0` | Case-insensitive **exact** match against `ROBOTS_PRODUCT_TOKENS` (`akm`, `akm-cli`), plus `*` | `includes()` with an empty or one-character pattern matches almost anything; e.g. `User-agent: i` would capture inform. Exact product-token matching is predictable and testable. |
| I-04 | Prefix match `path.startsWith(pattern)` only when the pattern has no `*`/`$`; otherwise a regex built by string replacement | One matcher for all patterns; regex metacharacters escaped; only a **trailing** `$` anchors | inform's `.replace(/\*/g, '.*')` runs *after* escaping and its `/\$$/` replacement is a no-op, and a pattern containing `(`/`+` builds an unintended regex or throws. |
| I-05 | Any `!response.ok` (including 5xx) ⇒ allow everything | 4xx ⇒ allow everything; **5xx ⇒ disallow everything** (§4.5 F-06) | RFC 9309 §2.3.1.4 treats an unreachable robots.txt as a full disallow. `fetchWithRetry` already retries a 5xx once, so a transient blip does not trip it, and `respectRobots: false` is a documented escape. A server actively erroring is an authoritative signal we should not hammer it. |
| I-06 | Transport error ⇒ allow everything, with `console.warn` | Transport error ⇒ allow everything, with `warnVerbose()` | Same policy (fail open on "we could not reach it at all", unlike "the server told us it is broken"), but never `console.*` (repo rule). Keeping this fail-open is what stops an offline/proxied environment from being unable to add any website source. |
| I-07 | `this.cache` is an instance `Map`, but the instance is long-lived | Cache is created inside `crawlWebsite` and dies with it; **no module-level state** | akm's test preload resets module singletons and trips on leaks; a module-level cache would leak rules across tests and across `akm` invocations in one process. |
| I-08 | Raw `fetch()` with only a `User-Agent` header | `assertWebsiteRequestUrl` + `assertResolvedHostAllowed` + `fetchWithRetry` (15 s, 1 retry, manual redirects, redirect cap) + `readBodyWithByteCap` | akm's non-negotiable SSRF/DoS posture. See §6. |
| I-09 | No byte cap on the robots.txt body | 512 KiB cap; over-cap ⇒ treated as unavailable | A hostile origin could otherwise stream unbounded bytes into memory from a URL we fetch automatically. |
| I-10 | `crawlDelay` returned unclamped and never applied by the caller | Clamped to 10 s and actually applied between page fetches, deadline-aware | An unclamped `Crawl-delay: 86400` would let a hostile robots.txt burn the entire 10-minute wall-clock cap producing nothing. |
| I-11 | `isAllowed()` returns `true` when the origin was never fetched | `isAllowed()` is async and loads the origin on first use | Removes a whole class of "forgot to call `fetch()` first" bugs. |
| I-12 | `clearCache()` / `hasRobotsTxt()` helpers | Not ported | No consumer; crawl-scoped cache makes them dead code. |

---

## 6. Security requirements

### 6.1 No module-level state

The per-origin cache **must** live on the object returned by
`createRobotsPolicy`, constructed inside `crawlWebsite`. A module-level `Map`
is forbidden: the test preload's singleton reset does not know about it, the
tripwire would not catch it, and rules would leak between crawls (and between
tests) — including a `disallowAll` from one host poisoning another run.

### 6.2 SSRF: the robots.txt URL is an attacker-influenced fetch

`/robots.txt` is fetched automatically for whatever origin the crawl reaches,
including origins arrived at through redirects. It therefore gets exactly the
same treatment as a page fetch:

- **No raw `fetch()`.** All traffic goes through `fetchWithRetry` from
  `src/core/common.ts` with an explicit timeout.
- `assertWebsiteRequestUrl` before every request, including every redirect hop.
- `assertResolvedHostAllowed` (resolve-then-validate) before every request,
  including every redirect hop.
- `readBodyWithByteCap` with `ROBOTS_BYTE_CAP` and an explicit `bodyTimeoutMs`.
- Redirects followed manually and capped at `WEBSITE_MAX_REDIRECTS`.
- Reusing `fetchWebsiteResponse` satisfies all of the above; **do not** write a
  second fetch path.

**Guard rejections must not be swallowed into "allow all" at the point of the
initial URL check** (§4.5 F-12). The catch block must wrap only the network
phase (step 3–4), never steps 1–2. Rejections that happen *inside*
`fetchWebsiteResponse` on a later redirect hop may be swallowed to
`{ kind: "unavailable" }` — the guard has already prevented the request; only
the error reporting is downgraded.

### 6.3 `allowPrivateHosts` must thread through

`crawlWebsite(options.allowPrivateHosts)` → `loadRobotsTxt(..., { allowPrivateHosts })`
→ `assertWebsiteRequestUrl` / `assertResolvedHostAllowed` / `fetchWebsiteResponse`.
Without this the loopback fixture servers in the integration tests cannot serve
`/robots.txt` and the phase is untestable end to end. The hatch is
test-only (`shouldAllowPrivateWebsiteHostsForTests`) and must not gain a new
production entry point.

### 6.4 ReDoS / parser DoS

robots.txt content is fully attacker-controlled.

- **Patterns must NOT be compiled to a `RegExp`.** The required implementation
  compiles each pattern to a flat list of literal segments split on `*`
  (consecutive `*` collapsed to one) and matches it with a single greedy,
  non-backtracking left-to-right scan: the first segment anchors the start,
  each interior segment is located with one forward `indexOf` from the
  current cursor (cursor only moves forward, never backtracks), and the final
  segment either anchors the end (trailing `$`) or is located the same way.
  This runs in time bounded by `segments × target length`, independent of
  wildcard count. A regex-based compiler (`*` → `.*`, metacharacters escaped)
  is explicitly rejected, including the earlier draft of this section that
  proposed one: collapsing consecutive `*` only defuses *adjacent*-wildcard
  blowup (`/****`), not **distinct** wildcards separated by short literals
  (e.g. `/*a*a*a*a*a*a*a*a$`), which still drives a regex engine into
  catastrophic backtracking on a long near-miss input — see the dated review
  log entry below and the `§6.4 regression` test in
  `tests/website-robots.test.ts`. Reference implementation:
  `compilePatternSegments` / `matchesCompiledPattern` in `robots.ts`.
- The 512 KiB body cap bounds the number of rules.
- Compile each pattern at most once (at parse time or memoized), not once per
  URL check.

### 6.5 Error surface

- User-input paths (`respectRobots` coercion, start URL blocked): `UsageError` /
  `ConfigError` from `src/core/errors.ts`. Never a bare `throw new Error`.
- Diagnostics: `warn()` / `warnVerbose()` from `src/core/warn.ts`. Never
  `console.*`.
- A 404 on `/robots.txt` is the normal case and must be **silent** — no `warn()`.

### 6.6 No secrets or credentials on the robots.txt request

Send only `User-Agent` (and, if convenient, `Accept: text/plain`). No cookies,
no auth headers, no query string. The URL is always `<origin>/robots.txt`.

---

## 7. Config surface and defaults

### 7.1 The knob

| Key | Location | Type | Default |
|---|---|---|---|
| `respectRobots` | website source descriptor — `bundles.<slug>.website.respectRobots`, surfaced at runtime as `SourceConfigEntry.options.respectRobots` | boolean | **`true`** |

`bundleEntryToSourceEntry` in `src/core/config/config-sources.ts` already
round-trips every non-`url` website-descriptor key into the runtime entry's
`options` bag, so **no plumbing change is needed there** — only the schema and
the read in `ensureWebsiteMirror`.

Example opt-out:

```json
{
  "bundles": {
    "docs": {
      "website": { "url": "https://docs.example.com", "respectRobots": false },
      "components": { "main": { "root": ".", "adapter": "website-snapshot", "writable": false } }
    }
  }
}
```

### 7.2 Behavior change for existing users — must be called out

This is the one place P1 intentionally changes behavior for existing configs.

- Before P1: akm crawled every reachable same-origin page up to `maxPages` /
  `maxDepth`, ignoring `robots.txt`.
- After P1: pages disallowed for `akm` (or `*`) are skipped, `Crawl-delay` is
  honored, and a crawl whose **start URL** is disallowed fails with a
  `UsageError` instead of producing a stash.
- Consequence: **existing website sources may return fewer pages, or fail
  outright, after upgrade.** Re-running `akm update` on such a source is what
  surfaces it.
- Opt-out: `respectRobots: false` on the website descriptor, which restores the
  pre-P1 behavior exactly (no `/robots.txt` request at all).

A `CHANGELOG.md` entry under `## [Unreleased]` is **required** and must state
the default, the user-visible consequence, and the opt-out.

### 7.3 Schema

Add to `BundleWebsiteDescriptorSchema` in
`src/core/config/schema/sources-bundles.ts`:

```ts
respectRobots: z.boolean().optional(),
```

`schemas/akm-config.json` is generated — regenerate with
`bun scripts/gen-config-schema.ts`. `bun run lint` runs
`gen-config-schema.ts --check` and will fail if the committed JSON schema is
stale.

Note the asymmetry, which is why §4.7 still coerces strings: the *bundle*
descriptor is now boolean-validated, but the legacy `sources[].options` bag is
`z.record(z.unknown())` and accepts anything, so the runtime read must still
validate and raise `ConfigError`.

---

## 8. Files to create / modify

### Create

| Path | Purpose |
|---|---|
| `src/sources/snapshot-fetchers/robots.ts` | Parser, matcher, crawl-scoped policy. MPL-2.0 header. |
| `tests/website-robots.test.ts` | Unit tests: §4.1–§4.4 parser/matcher/policy tables + `coerceRespectRobots`. No real network. MPL-2.0 header. |
| `tests/integration/website-robots-crawl.test.ts` | Loopback-fixture integration: §4.6 crawl behavior, `respectRobots: false` bypass, SSRF guard on the robots URL. MPL-2.0 header. |

### Modify

| Path | Change |
|---|---|
| `src/sources/snapshot-fetchers/website-ingest.ts` | Add `loadRobotsTxt`; add `coerceRespectRobots`; thread `respectRobots` through `ensureWebsiteMirror` → `scrapeWebsiteToStash` → `crawlWebsite`; add the robots gate, start-URL `UsageError`, and crawl-delay sleep in `crawlWebsite`. |
| `src/core/config/schema/sources-bundles.ts` | `respectRobots: z.boolean().optional()` on `BundleWebsiteDescriptorSchema`. |
| `schemas/akm-config.json` | Regenerated (`bun scripts/gen-config-schema.ts`). |
| `CHANGELOG.md` | `## [Unreleased]` entry per §7.2. |
| `docs/guides/sources-registries.md` | Document `respectRobots`, the default, and the opt-out alongside `maxPages`/`maxDepth`. |

Do **not** modify: `src/commands/sources/source-add.ts`,
`src/commands/sources/installed-stashes.ts`,
`src/core/config/config-sources.ts` — the existing website-descriptor
passthrough already carries the new key (§7.1). No CLI flag in P1.

---

## 9. Test guidance

Hard requirements from the repo harness:

- Unit tests under `tests/`; end-to-end `akm add` coverage under
  `tests/integration/`.
- Use `tests/_helpers/sandbox.ts`: `withMockedFetch(run, (url) => Response)`,
  `sandboxStashDir()`, `writeSandboxConfig()`.
- **Never** assign `globalThis.fetch =`, mutate `process.env.HOME`, or call
  `process.chdir` — `scripts/lint-tests-isolation.ts` fails the build.
- No real network in unit tests.
- Follow the fixture patterns in `tests/integration/add-website-source.test.ts`
  and `tests/integration/website-ssrf.test.ts` (loopback servers reach the
  crawler through the test-only private-host hatch).
- MPL-2.0 header on every new test file
  (`scripts/lint-license-headers.ts` enforces it).

Testing shape that makes this cheap:

- §4.1–§4.3 are pure-function table tests on `parseRobotsTxt` /
  `isPathAllowedByRobots` — no fetch mocking needed at all.
- §4.4 tests `createRobotsPolicy` with a hand-written `RobotsTxtLoader` stub;
  also assert the loader is invoked **once** for two URLs on the same origin.
- §4.5 tests `loadRobotsTxt` through `withMockedFetch` (status codes, oversized
  body via a large `content-length`, a throwing mock for the transport case).
- §4.6 and §4.7 need the loopback fixture server serving both `/robots.txt` and
  pages, driven through `ensureWebsiteMirror` with a sandboxed stash.
- Crawl-delay timing: assert the clamped value the policy reports and that a
  configured delay produces measurable spacing with a small value (e.g.
  `Crawl-delay: 0.05`), not a 2-second sleep in CI.

---

## 10. Acceptance criteria

- [x] `src/sources/snapshot-fetchers/robots.ts` exists with the MPL-2.0 header and exports exactly the API in §3.
- [ ] `robots.ts` contains **no** module-level mutable state and does **not** import from `website-ingest.ts`. **Partially met, left unticked.** The import half holds (only `warnVerbose` is imported). The state half is literally violated: a module-level `WeakMap` memoizes compiled patterns, and `ALLOW_ALL_RULES` / `DISALLOW_ALL_RULES` are module-level exported `RobotsRuleSet` consts whose `rules: []` array is one shared instance. Reviewed and accepted as a documented deviation (Review log, 2026-08-01, finding 1) — the `WeakMap` is keyed on rule-object identity so it cannot leak between origins/crawls/tests, and nothing mutates the shared consts today. Not fixed in this pass; see the review log for the optional follow-up (`Object.freeze` + reword this bullet to "no module-level state carrying crawl semantics").
- [x] `parseRobotsTxt` satisfies every row of §4.1 (P-01…P-24). `bun test tests/website-robots.test.ts` — 107 pass, 0 fail.
- [x] `parseRobotsTxt` satisfies every `Crawl-delay` row of §4.2 (D-01…D-12), including the 10 s clamp.
- [x] `isPathAllowedByRobots` satisfies every row of §4.3 (M-01…M-32), including `Allow` longest-match-wins and the tie-goes-to-Allow rule.
- [x] `createRobotsPolicy` satisfies §4.4 and fetches `/robots.txt` at most once per origin (in-flight promises deduped). Proven by C-06.
- [x] `createAllowAllRobotsPolicy()` never invokes a loader and always reports allowed / 0 ms.
- [x] `loadRobotsTxt` satisfies §4.5: 2xx→body, 4xx→unavailable (silent on 404), 5xx→unreachable, oversized→unavailable, transport error→unavailable.
- [x] `loadRobotsTxt` performs **no** raw `fetch()`; every request goes through `fetchWebsiteResponse` → `fetchWithRetry` + `assertWebsiteRequestUrl` + `assertResolvedHostAllowed`, with `readBodyWithByteCap(…, ROBOTS_BYTE_CAP, { bodyTimeoutMs })`. Verified by reading `loadRobotsTxt` in `website-ingest.ts`.
- [x] A guard rejection on the **initial** robots.txt URL propagates and is not converted to allow-all (F-12), proven by a test.
- [x] `allowPrivateHosts` threads from `crawlWebsite` into the robots fetch path (C-13), proven by the loopback integration test. Every test in `tests/integration/website-robots-crawl.test.ts` passes `allowPrivateHosts: true` through `ensureWebsiteMirror` and relies on the loopback robots.txt fetch succeeding, which is only possible if the flag threads all the way to `loadRobotsTxt`'s SSRF guards.
- [x] `crawlWebsite` throws `UsageError` when the start URL is disallowed, and the message contains the start URL and the string `respectRobots` (C-02).
- [x] A 5xx robots.txt on the start origin produces the same `UsageError` with an added server-error explanation (C-03).
- [x] Disallowed non-start URLs are skipped without erroring and without being fetched (C-04).
- [x] `Crawl-delay` is applied between page fetches, skipped before the first fetch, clamped to 10 s, and never sleeps past the crawl wall-clock deadline (C-07…C-11).
- [x] With `respectRobots: false`, zero `/robots.txt` requests are made and the crawl result is identical to pre-P1 behavior — proven by an integration test whose fixture server records every requested path (C-05).
- [x] `coerceRespectRobots` satisfies §4.7 (G-01…G-07), raising `ConfigError` on non-boolean values.
- [x] `respectRobots: z.boolean().optional()` is on `BundleWebsiteDescriptorSchema` and `schemas/akm-config.json` is regenerated (`bun scripts/gen-config-schema.ts --check` passes). Verified: `src/core/config/schema/sources-bundles.ts:95` and `bun scripts/gen-config-schema.ts --check` reports "up to date".
- [x] `CHANGELOG.md` `## [Unreleased]` documents the default-on behavior change, the user-visible consequence, and the `respectRobots: false` opt-out.
- [x] `docs/guides/sources-registries.md` documents `respectRobots`.
- [x] No `console.*` anywhere in the new/changed code; diagnostics use `warn()` / `warnVerbose()`. Verified: no `console.` matches in `robots.ts` or the changed regions of `website-ingest.ts`.
- [x] No new dependencies (P1 adds none — `turndown`, a DOM selector lib, and `fast-xml-parser` belong to P2/P3).
- [x] Every new `src/` and `tests/` file carries the MPL-2.0 header; `bun scripts/lint-license-headers.ts` passes.
- [x] New tests use `withMockedFetch` / `sandboxStashDir`; no `globalThis.fetch =`, no `process.env.HOME` mutation, no `process.chdir`; `bun scripts/lint-tests-isolation.ts` passes.
- [x] `bunx biome check --write src/ tests/` produces no further changes; `bunx tsc --noEmit` is clean.
- [x] `bun run check` passes (lint + typecheck + `test:unit` + `test:integration`).

---

## 11. Open items flagged for review

These are spec-author decisions that go beyond, or tighten, the parent plan's
phase text. A reviewer may veto any of them; they are called out so nobody has
to diff the plan to find them.

1. **`Allow:` is implemented** (§5 I-01). The plan text lists only
   `User-agent` / `Disallow` / `Crawl-delay`. Omitting `Allow` would make akm
   stricter than site owners intend and would zero out sites using
   `Disallow: /` + `Allow: /docs/`.
2. **5xx fails closed** (§4.5 F-06, §5 I-05). The plan says "missing/erroring
   robots.txt ⇒ allow-all … for unreachable files ≠ 5xx" and defers the 5xx call
   to this spec. Chosen: 5xx ⇒ full disallow, per RFC 9309 §2.3.1.4, mitigated
   by `fetchWithRetry`'s retry and by `respectRobots: false`.
3. **Dedicated 512 KiB robots byte cap** rather than reusing the 5 MiB page cap
   the plan's "same … byte cap" phrasing implies (§2, §5 I-09). RFC 9309 §2.5
   only requires 500 KiB be parsed.
4. **`fetchWebsiteMarkdownSnapshot` is not gated** (§1). Single-URL, user-typed
   fetches stay ungated; only crawls are.
5. **Product tokens are `akm` / `akm-cli`**, matched exactly and
   case-insensitively (§5 I-03), while the `User-Agent` header stays
   `akm-cli website provider` as the plan requires.

---

## Review log

<!-- Reviewers append dated entries below. -->

### 2026-08-01 — Gate close-out: advisory findings from test review + code review

P1 passed its gate (`bun run check` green, all §10 tests passing). The
following ADVISORY findings from the test-review and code-review passes did
not block the gate. Recorded here with disposition, per the close-out
process.

1. **[`robots.ts:246`] Module-level `WeakMap` and `ALLOW_ALL_RULES` /
   `DISALLOW_ALL_RULES` conflict with the §6.1 / §10 "no module-level mutable
   state" wording.** `compiledPatternCache` is a module-level `WeakMap`, and
   `ALLOW_ALL_RULES` / `DISALLOW_ALL_RULES` are exported non-frozen consts
   whose `rules: []` array is a single shared instance across every crawl in
   the process.
   **Disposition: accepted deviation, no code change.** The `WeakMap` is
   semantically safe — it memoizes a pure function of an individual rule
   object's own `pattern`, keyed by that object's identity, so distinct
   `parseRobotsTxt` calls (even for identical text) get distinct cache slots
   and nothing leaks between origins, crawls, or tests. §6.4 explicitly
   sanctions memoization. This is a wording conflict with §6.1/§10, not a
   defect; the §10 checkbox is left unticked with this note rather than
   reworded, since rewording §6.1's acceptance bullet is optional and out of
   scope for this close-out. The `ALLOW_ALL_RULES`/`DISALLOW_ALL_RULES`
   shared-array risk (nothing mutates them today, but a stray `push` would
   poison every subsequent crawl) is noted as a candidate for an `Object.freeze`
   hardening pass in a later phase; not required to close P1.

2. **[`robots.ts:37`, `robots.ts:43`] `ROBOTS_FETCH_TIMEOUT_MS` /
   `ROBOTS_USER_AGENT_HEADER` are exported and asserted by
   `tests/website-robots.test.ts:65,68` but never referenced by production
   code.** `fetchWebsiteResponse` hardcodes `{ timeout: 15_000 }`
   (`website-ingest.ts:479`) and the literal `"akm-cli website provider"`
   (`website-ingest.ts:475`) instead of importing the constants, so the unit
   tests pin values that production code does not actually read from.
   **Disposition: logged as a follow-up, no code change in this pass.** Either
   wiring the constants into `fetchWebsiteResponse` or replacing the
   constant-value assertions with assertions against the actual outgoing
   `Request` (via `withMockedFetch`) closes this; deferred to a later phase
   rather than blocking P1.

3. **[`robots.ts:363`] `RobotsPolicy.crawlDelayMs` re-derives
   `crawlDelayMs ?? 0` with no re-clamp at the policy boundary.** The
   `MAX_CRAWL_DELAY_MS` ceiling (§5 I-10) is enforced only inside
   `parseRobotsTxt`; a `RobotsRuleSet` built by any other route (a hand-built
   test fixture today, a future caller tomorrow) would flow an unclamped
   delay into `sleep()`.
   **Disposition: logged as a follow-up, no code change in this pass.** Not
   exploitable today — the deadline pre-check at `website-ingest.ts:377`
   breaks the crawl loop rather than sleeping past the wall-clock cap, so no
   real crawl can stall on this. A defensive re-clamp
   (`Math.min(Math.max(rules.crawlDelayMs ?? 0, 0), MAX_CRAWL_DELAY_MS)`) in
   `createRobotsPolicy.crawlDelayMs` is a candidate one-line hardening for a
   later phase; not required to close P1.

4. **[`docs/guides/sources-registries.md:39`] The guide and `CHANGELOG.md`
   both say a disallowed start URL makes `akm bundle add`/`update` "fail with
   an error," which is accurate for a cold cache but not for `bundle update`
   on a warm one.** `crawlWebsite`'s C-02/C-03 `UsageError` is thrown inside
   `withFreshnessCache`'s `refresh` callback (`website-ingest.ts:170`), and
   `src/sources/freshness.ts:64-68` swallows any refresh failure whenever a
   usable cached mirror exists within the 7-day stale window. An existing
   website source whose start URL becomes robots-disallowed therefore keeps
   serving its stale mirror for up to 7 days before the documented error
   surfaces (on the next cold crawl, or once the stale window expires).
   **Disposition: reviewed and accepted as-is; documentation nuance only, no
   doc or code change in this pass.** This is pre-existing freshness-ladder
   behavior (§4.6) applied to a new error class, not a regression introduced
   by P1 — the integration test suite passes because its fixtures always
   start cold. A follow-up sentence in `docs/guides/sources-registries.md`
   (and optionally the `CHANGELOG.md` entry) noting the stale-fallback window
   is a candidate for a later documentation pass.

5. **[`website-ingest.ts:217`] `scrapeWebsiteToStash` still ends in a bare
   `throw new Error("No content could be scraped from …")` on a zero-page
   crawl, which plan §2.7 forbids on user-facing paths (exit 70 "internal /
   unclassified" instead of exit 2 "usage error").** Spec §4.6 C-12 leaves
   this line untouched by design, and C-02 removes the most likely *new* way
   to reach it (a fully-disallowed origin now fails earlier with a clear
   `UsageError`) — but robots filtering does put a new class of "crawl
   produced zero pages" outcomes in front of it.
   **Disposition: no change in P1; logged as a candidate cleanup for a later
   phase.** Converting `website-ingest.ts:217` to `UsageError` so a
   zero-page crawl exits 2 with an actionable message is out of scope for
   this phase (pre-existing behavior, explicitly left alone by C-12).

6. **[`docs/plans/specs/p1-robots.md` §6.4] The spec's first §6.4 bullet
   prescribed compiling patterns to `RegExp`s with `*` → `.*` and collapsing
   consecutive `*`; the implementation deliberately does something stronger
   and different — a non-backtracking segment scan
   (`compilePatternSegments`/`matchesCompiledPattern`, `robots.ts:229-290`)
   that never constructs a `RegExp`.** Verified the segment scan against
   every §4.3 M-row, including trailing-`$` anchored cases and the
   `last.length > target.length - cursor` overlap guard: it is correct. The
   risk was purely documentary — collapsing consecutive `*` does not defend
   against *distinct* wildcards separated by short literals (e.g.
   `/*a*a*a*a*a*a*a*a$`), which is the actual catastrophic-backtracking
   shape, so a future maintainer "restoring" the spec's regex approach would
   reintroduce the ReDoS surface.
   **Disposition: fixed in this pass.** §6.4's first bullet now describes the
   non-backtracking segment matcher as the required implementation and
   explicitly rejects regex compilation, with the rationale above. A
   regression test for the distinct-wildcard shape
   (`§6.4 regression: distinct '*a' wildcards …`) is already in
   `tests/website-robots.test.ts`.
