# Implementation Plan: Porting Inform Crawler Capabilities into akm

**Status:** Draft — awaiting review
**Source repo:** [`fwdslsh/inform`](https://github.com/fwdslsh/inform) (Bun web crawler / content ingester, CC-BY-4.0)
**Target repo:** `itlackey/akm` (MPL-2.0)
**Branch:** `claude/inform-akm-porting-nk81wa`

---

## 1. Goal and scope

Port the highest-value capabilities from the `inform` codebase into akm's existing
website-source architecture, rewritten (not copy-pasted) to akm's TypeScript
conventions, security posture, and test-isolation harness.

### In scope (in priority order)

| # | Capability | Inform source | akm destination |
|---|-----------|---------------|-----------------|
| P1 | robots.txt compliance (Disallow / Crawl-delay, per-domain cache) | `src/RobotsParser.js` | new `src/sources/snapshot-fetchers/robots.ts`, wired into `website-ingest.ts` `crawlWebsite()` |
| P2 | Main-content extraction before HTML→Markdown conversion (strip nav/header/footer/aside, prefer `<main>`/`<article>`/content selectors) | `src/WebCrawler.js` (`extractContentWithHTMLRewriter`) | new `src/sources/snapshot-fetchers/content-extract.ts`, called from `htmlToMarkdown()` in `website-ingest.ts` |
| P3 | RSS / Atom / RDF feed ingestion as a `WikiSnapshotFetcher` | `src/sources/rss.js` | new `src/sources/snapshot-fetchers/rss.ts`, registered in `registry.ts` `BUILTIN_FETCHERS` |
| P4 | Bluesky profile ingestion as a `WikiSnapshotFetcher` | `src/sources/bluesky.js` | new `src/sources/snapshot-fetchers/bluesky.ts`, registered in `registry.ts` |
| P5 | X/Twitter ingestion (API v2 with bearer token; RSS-template fallback) as a `WikiSnapshotFetcher` | `src/sources/x.js` | new `src/sources/snapshot-fetchers/x.ts`, registered in `registry.ts` |

### Explicitly out of scope

- **Git repo downloading** (`GitCrawler.js`, `GitUrlParser.js`): akm's
  `src/sources/providers/git*.ts` clone-based mirroring is already more capable.
- **New source provider kinds**: `AGENTS.md` locks providers to
  `filesystem` / `git` / `website` / `npm`. Everything here lands *inside* the
  existing `website` provider and the `WikiSnapshotFetcher` plugin surface —
  no new `kind`, no changes to the `SourceProvider` contract
  `{ name, kind, path, sync? }`.
- **Concurrent crawling**: deferred. akm's crawl is bounded by
  wall-clock/page caps and correctness-sensitive SSRF checks; parallelism is a
  follow-up optimization, not part of this port.
- **inform's YouTube ingester**: akm already has a superior InnerTube-based
  implementation (`snapshot-fetchers/youtube.ts`).
### Approved dependencies

akm has been dependency-averse on this path, but the owner has approved adding
real parsers rather than extending the hand-rolled regex converters (see §1.1).
The following are **approved**; anything beyond them needs a fresh decision:

| Dependency | Phase | Purpose |
|-----------|-------|---------|
| `turndown` | P2 | HTML→Markdown conversion (the library inform uses; ships its own DOM shim for Node) |
| a DOM selector lib (`node-html-parser` proposed) | P2 | Selecting the main-content region before conversion |
| `fast-xml-parser` | P3 | RSS 2.0 / Atom 1.0 / RDF feed parsing (also inform's choice) |

The P2 spec must confirm the exact selector library and verify that
`bun run build` still produces working standalone binaries — akm compiles with
`bun build --compile`, so a dependency with native bindings or dynamic
`require` would break the release artifacts. `./tests/release-check.sh` must
pass before P2 closes.

### 1.1 Decisions on record

Settled by the repo owner on 2026-08-01, before implementation started. These
are inputs to the phase specs, not open questions:

1. **robots.txt is honored by default.** `respectRobots` defaults to `true`.
   This is an intentional behavior change — existing website sources may return
   fewer pages after upgrade. Requires a `CHANGELOG.md` callout and a
   documented opt-out.
2. **P2 uses a real DOM parser plus `turndown`**, not extended regex scanning.
   One code path on both Bun and Node; no HTMLRewriter runtime branching.
3. **P3 uses `fast-xml-parser`**, matching inform, rather than hand-rolled feed
   scanning.
4. **X bearer token resolves from `X_BEARER_TOKEN` *and* akm's secret store**
   via `src/core/env-secret-ref.ts`. P5 stays in scope.

### Licensing note

inform is CC-BY-4.0; akm is MPL-2.0. All ported code is a **clean rewrite in
TypeScript against akm's contracts**, using inform as a behavioral reference.
Attribution to inform goes in the PR description and this document, not in
per-file headers. Every new file carries akm's standard MPL-2.0 header.

---

## 2. Architectural constraints (from `AGENTS.md` + `docs/architecture/architecture.md`)

Implementers and reviewers must treat these as hard requirements:

1. **MPL-2.0 header** on every new `src/` and `tests/` file.
2. **No barrel exports, no public API.** New modules are internal; import them
   directly by path.
3. **SSRF guards are non-negotiable.** Any new fetch path (robots.txt, feed
   URLs, Bluesky XRPC, X API, RSS-template URLs) must go through the same
   validation as `website-ingest.ts`: `assertWebsiteRequestUrl` +
   `assertResolvedHostAllowed` (resolve-then-validate on every redirect hop),
   `fetchWithRetry` from `src/core/common.ts` with explicit timeouts,
   `readBodyWithByteCap` with a byte cap, and redirect caps. No raw `fetch`.
3a. **The `allowPrivateHosts` test escape hatch** must thread through any new
   fetch path exactly as it does today, or the test suite cannot exercise
   loopback fixtures.
4. **Fetcher contract is `WikiSnapshotFetcher`** (`snapshot-fetchers/types.ts`):
   `{ name, matches(url, context), fetch(url, context) }` returning
   `WikiSnapshotResult | null`. New ingesters are built-in fetchers appended to
   `BUILTIN_FETCHERS` in `registry.ts`. Order matters: more specific matchers
   (youtube, bluesky, x, rss) run before the generic website fallback.
5. **Output shape:** fetchers produce markdown snapshots that flow through
   `buildMarkdownSnapshot` frontmatter (name/description/sourceUrl/title/
   updated/tags, `lint_skip: [stale-path]`). Reserved basenames `index.md` /
   `log.md` must be remapped (`avoidReservedBasename`).
6. **Style:** Biome-formatted (`bunx biome check --write src/ tests/`),
   `tsc --noEmit` clean. Long prose/templates go in external `.md`/`.xml`
   asset files imported `with { type: "text" }`, not inline template literals.
7. **Errors:** user-facing failures use `UsageError` / `ConfigError` from
   `src/core/errors.ts` (exit codes 2 / 78); never bare `throw new Error` on
   user-input paths. Diagnostics via `warn()` from `src/core/warn.ts`, not
   `console.*`.
8. **Config:** any new tunables (e.g. `respectRobots`, feed `limit`) ride on the
   existing `SourceConfigEntry.options` bag, validated by the schema in
   `src/core/config/schema/sources-bundles.ts` if a schema change is needed.
   Default behavior must not change for existing users except where the change
   *is* the feature (robots.txt compliance — see §4.1).

### Test conventions

- Unit tests live under `tests/` (not `tests/integration/`); integration tests
  that exercise `akm add` end-to-end live under `tests/integration/`.
- Use `tests/_helpers/sandbox.ts` (`withMockedFetch`, `sandboxStashDir`, ...).
  **Never** assign `globalThis.fetch =`, mutate `process.env.HOME`, or
  `process.chdir` directly — `scripts/lint-tests-isolation.ts` fails the build.
- The preload tripwire throws on leaked env vars / cwd / fetch; tests must be
  hermetic. No real network in unit tests — all HTTP via `withMockedFetch`.
- Follow the fixture patterns in `tests/integration/add-website-source.test.ts`
  and `tests/integration/website-ssrf.test.ts` (loopback servers allowed via
  the test-only private-host escape hatch).

---

## 3. Process: test-first with independent review

Work proceeds in five phases (P1–P5), strictly sequential merges into the
feature branch, each phase following the same six-step cycle:

```
┌─────────────────────────────────────────────────────────────────┐
│ Step 1  SPEC        Opus 5 agent writes a behavior spec          │
│ Step 2  TESTS       Sonnet 5 agent writes failing tests          │
│ Step 3  TEST REVIEW Sonnet 5 agent (independent) reviews tests   │
│ Step 4  IMPLEMENT   Sonnet 5 agent makes the tests pass          │
│ Step 5  CODE REVIEW Opus 5 agent (independent) adversarial review│
│ Step 6  GATE        bun run check green + review findings closed │
└─────────────────────────────────────────────────────────────────┘
```

### Agent roles and models

| Role | Model | Independence rule |
|------|-------|-------------------|
| Spec author | **Opus 5** (`claude-opus-5`) | Reads inform source + akm architecture; produces the phase spec (behavior table, edge cases, security requirements, acceptance criteria). |
| Test author | **Sonnet 5** (`claude-sonnet-5`) | Works only from the spec + akm test conventions. Writes tests that fail against current `main`-of-branch. |
| Test reviewer | **Sonnet 5** (`claude-sonnet-5`) | Fresh context; has NOT seen the test author's reasoning. Checks: tests actually pin the spec, cover the edge cases, are hermetic, would catch a null implementation, don't over-fit an anticipated implementation. |
| Implementer | **Sonnet 5** | Works from spec + reviewed tests. May not modify tests except with a written justification the code reviewer must countersign. |
| Code reviewer (final gate) | **Opus 5** | Fresh context; adversarial. The heavyweight review of each phase. Reviews the diff for: convention violations (§2), SSRF gaps, silent behavior changes, missing error paths, style drift. Verdict per finding: CONFIRMED (must fix) or ADVISORY. |
| Orchestrator | session model | Runs the cycle, resolves disputes, commits at gates. |

**Independence is enforced by context**: reviewer agents are launched as fresh
subagents given only the spec, the diff, and this plan — never the transcript
of the agent whose work they review. A reviewer who authored any artifact in a
phase cannot review that phase.

### Step details

**Step 1 — Spec.** One markdown spec per phase, committed to
`docs/plans/specs/pN-<name>.md`. Contains: behavior table (input → expected
output), inform-parity notes ("inform does X; we deliberately do Y because…"),
security requirements, config surface, list of files to be created/modified,
acceptance criteria checklist.

**Step 2 — Tests.** New `tests/**.test.ts` files (unit) and, where the phase
touches `akm add` behavior, `tests/integration/**`. Committed with the message
`test(pN): failing tests for <capability>`. CI/gate expectation at this commit:
new tests fail, everything pre-existing passes
(`bun test tests/<new-file>.test.ts` shows red; `bun run test:unit` on
untouched files stays green).

**Step 3 — Test review.** Sonnet reviewer returns a findings list. CONFIRMED
findings are fixed by the test author before implementation starts. The
reviewer explicitly answers: *"Would a trivially wrong implementation (returns
empty, ignores robots, echoes input) pass these tests?"* If yes, tests are
insufficient — back to Step 2.

**Step 4 — Implementation.** Sonnet implementer writes `src/` code until the
phase's tests pass plus `bun run lint`, `bunx tsc --noEmit`, and the full
`bun run test:unit && bun run test:integration` are green. Commit:
`feat(pN): <capability>`.

**Step 5 — Code review (final gate for the phase).** Opus reviewer gets the full phase diff
(`git diff <phase-start>..HEAD`). Findings are triaged: CONFIRMED → implementer
fixes and re-runs the gate; ADVISORY → recorded in the phase spec's
"review log" section. A phase needs a clean CONFIRMED-free review to close.
If a fix commit changes more than ~30 lines, one more review round on the
fix diff.

**Step 6 — Gate.** Orchestrator verifies: all tests green, Biome clean,
typecheck clean, review log closed, spec acceptance boxes checked. Then a
single squash-tidy commit boundary; next phase begins.

### Dispute rule

If implementer and reviewer disagree after one round-trip, the orchestrator
decides, recording the rationale in the phase spec. Reviewers cannot demand
scope beyond the spec; scope changes require a spec amendment (Step 1 redo,
cheap by design).

---

## 4. Phase breakdown

### P1 — robots.txt compliance (highest value, most isolated)

**New:** `src/sources/snapshot-fetchers/robots.ts`
**Modified:** `website-ingest.ts` (`crawlWebsite`, `fetchWebsitePage` call path)

Port of inform's `RobotsParser` semantics, adapted:

- Parse `User-agent` groups, `Disallow` (prefix + `*`/`$` wildcard), and
  `Crawl-delay`; per-origin cache for the lifetime of one crawl (module-level
  caches are forbidden by the test harness's singleton-reset expectations —
  the cache lives in a crawl-scoped instance, not module state).
- User agent string: `akm-cli website provider` (match the existing fetch UA).
- Fetch `/robots.txt` through the standard guarded fetch path (§2.3), with the
  same 15s timeout and byte cap; missing/erroring robots.txt ⇒ allow-all
  (matching inform and the RFC 9309 fail-open convention for unreachable
  files ≠ 5xx).
- `Crawl-delay` honored between page fetches, clamped to a ceiling (proposed:
  10s) so a hostile robots.txt cannot stall the crawl against the existing
  10-minute wall-clock cap.
- Config surface: `options.respectRobots` on the website source entry,
  **default `true`** (decision §1.1.1) — a deliberate behavior change turning
  akm into a polite crawler. The spec must call it out, the changelog entry
  must document the opt-out, and an integration test must prove that
  `respectRobots: false` fully restores the old behavior.
- Disallowed start URL ⇒ `UsageError` explaining robots.txt blocked it and
  naming the opt-out.

**Key tests:** parser table-tests (groups, wildcards, `$` anchors, comments,
crlf, case-insensitivity of directives), fail-open on 404/timeout, fail-open
vs 5xx decision per spec, crawl skips disallowed paths (loopback integration
test with a robots.txt-serving fixture server), crawl-delay clamping,
`respectRobots: false` bypass, SSRF guard still applied to the robots.txt URL.

### P2 — main-content extraction

**New:** `src/sources/snapshot-fetchers/content-extract.ts`
**Modified:** `website-ingest.ts` (`htmlToMarkdown` gains a pre-pass)

Per decision §1.1.2, this phase replaces the hand-rolled converter with a real
DOM parse plus `turndown`, giving one code path on both Bun and Node (no
`HTMLRewriter` branching).

- **Selection:** parse once, then take the first match of a selector priority
  list — `<main>`, `<article>`, `[role="main"]`, `id`/`class` ∈
  {content, main-content, docs-content, markdown-body} — falling back to
  `<body>` with `<nav>/<header>/<footer>/<aside>` removed, falling back to the
  whole document.
- **Conversion:** `turndown` configured as inform configures it (atx headings,
  fenced code blocks, `_` emphasis) plus inform's custom rules: drop
  `script`/`style`/`noscript`, fenced `<pre><code>` with language detection
  from the `language-*` class, and empty-link removal.
- **Security carry-over (must not regress):** the existing
  `stripDangerousBlockTag` behavior and the `isSafeLinkUrl` http/https-only
  check on rewritten links are load-bearing. Turndown rules must reproduce
  both, and the SSRF/link-safety tests must still pass unchanged.
- **This churns every website-snapshot golden.** Output quality should improve
  markedly (real tables, nested lists, correct code fences), but the Opus
  review at Step 5 must walk the golden diff file-by-file rather than accepting
  it wholesale.

- Link extraction for the crawl queue stays **whole-page** (nav links are how
  crawls find pages) — only the saved markdown is content-scoped. This matches
  inform's behavior and must be pinned by a test.
- Golden-file tests: fixture HTML pages (docs-site layout, blog layout,
  no-semantic-markup layout, nested-main pathological case) → expected
  markdown, stored under `tests/fixtures/`. Update
  `tests/fixtures/format-family-goldens/website-snapshot` goldens as needed —
  golden churn must be reviewed file-by-file in Step 5.

### P3 — RSS/Atom/RDF fetcher

**New:** `src/sources/snapshot-fetchers/rss.ts` (+ registry entry)

- Detection (`matches`): URL path ending `.rss|.atom|.xml` or known feed path
  segments (`/feed`, `/rss`); plus content-sniffing on fetch (`<rss`, `<feed`,
  `<rdf:RDF` prologue) so `matches` can pass ambiguous URLs through and
  `fetch` returns `null` for non-feeds (registry falls through to the website
  crawler — this fall-through is the contract, pin it with a test).
- Parsing: **`fast-xml-parser`** (decision §1.1.3), configured as inform
  configures it — `ignoreAttributes: false`, `@_` attribute prefix,
  `isArray` for `item`/`entry`/`category`/`link`, `parseTagValue: false` so
  values stay strings. Handles RSS 2.0, Atom 1.0, RDF/RSS 1.0, CDATA, entity
  decoding, item limit (default 50, `options.limit`).
- **Parser hardening:** XML parsing on untrusted input needs explicit limits —
  the spec must confirm `fast-xml-parser` is not entity-expansion-vulnerable
  under our config (it does not resolve external entities by default), and the
  feed body must still go through `readBodyWithByteCap` before parsing.
- Output: one snapshot per feed (items concatenated as `## <title>` sections
  with source links and ISO dates), `preferredName: feeds/<slugified-host+path>`,
  tags `["rss", host]`. Single-snapshot (not per-item files) keeps it inside
  the `WikiSnapshotResult` contract; per-item asset splitting is a noted
  follow-up.
- Fixtures: real-world-shaped RSS2/Atom/RDF samples under `tests/fixtures/feeds/`.

### P4 — Bluesky fetcher

**New:** `src/sources/snapshot-fetchers/bluesky.ts` (+ registry entry)

- `matches`: `bsky.app/profile/<handle>` URLs (the fetcher contract takes a
  URL, so bare-handle input sugar from inform is out of scope).
- Public XRPC (`public.api.bsky.app`): resolve handle → DID, fetch author feed
  (limit ≤ 100), no auth. Both calls through guarded fetch with timeouts.
- Output: profile snapshot with posts as sections (text, ISO date, like/repost
  counts, external-link embeds), `preferredName: bluesky/<handle>`,
  tags `["bluesky", "social"]`.
- Tests: handle extraction table, DID-resolution failure ⇒ `null` (fall
  through, warn), pagination cap, mocked XRPC responses as fixtures.

### P5 — X/Twitter fetcher

**New:** `src/sources/snapshot-fetchers/x.ts` (+ registry entry)

- `matches`: `x.com/<user>`, `twitter.com/<user>` profile URLs.
- Strategy chain (from inform): X API v2 when a bearer token is present —
  resolved from env `X_BEARER_TOKEN` **and** akm's secret store via
  `src/core/env-secret-ref.ts` (decision §1.1.4), else RSS
  template (env `X_RSS_TEMPLATE`, e.g. a Nitter instance) delegating to the
  P3 rss module, else return `null` **with a single `warn()`** naming both
  options — never a hard error, because `matches` firing on an x.com URL must
  not break a generic website crawl fall-through.
- Bearer token must never appear in output, warn logs, or snapshot
  frontmatter; add an explicit redaction test (akm has `src/core/redaction.ts`
  precedent).
- Tests: username extraction table, API-v2 path (mocked), RSS-template path
  (mocked, template URL SSRF-validated), tokenless fall-through, redaction.

### Cross-cutting final pass (after P5)

- `docs/guides/sources-registries.md` + `docs/reference/` updates documenting
  robots behavior and the new fetchers; README bullet update.
- `CHANGELOG.md` entry (note: docs-only commits skip CI — land docs with the
  code commits, not separately, so the branch head always has CI coverage).
- One full-branch Opus 5 review sweep (fresh agent, whole diff vs. base) as a
  final gate before the branch is declared done.

---

## 5. Deliverables & sequencing summary

| Order | Deliverable | Est. new files | Risk |
|-------|-------------|----------------|------|
| 1 | This plan (committed) | 1 | — |
| 2 | P1 robots.txt | 2 src, 2–3 test | Low — isolated |
| 3 | P2 content extraction | 1 src, 1–2 test + fixtures | Medium — golden churn |
| 4 | P3 RSS/Atom | 1 src, 1–2 test + fixtures | Medium — parser breadth |
| 5 | P4 Bluesky | 1 src, 1 test + fixtures | Low |
| 6 | P5 X/Twitter | 1 src, 1 test + fixtures | Low–medium — secret handling |
| 7 | Docs + changelog + final review sweep | — | Low |

Each phase lands as its own reviewed commit series on
`claude/inform-akm-porting-nk81wa`; the branch is pushed after every gate so
progress is always recoverable.

## 6. Acceptance criteria (branch-level)

- [ ] `bun run check` fully green (lint, typecheck, unit, integration).
- [ ] Every new file: MPL header, Biome-clean, no `console.*`, no raw `fetch`.
- [ ] Only the three approved dependencies added (§2 "Approved dependencies");
      anything else requires a new decision.
- [ ] `bun run build` produces working standalone binaries with the new
      dependencies bundled, and `./tests/release-check.sh` passes.
- [ ] All five phase specs exist with closed review logs.
- [ ] robots.txt honored by default on website crawls, with documented opt-out.
- [ ] `akm bundle add <rss-url | bsky-profile | x-profile>` produces indexed,
      searchable snapshots in an integration test.
- [ ] SSRF test suite (`tests/integration/website-ssrf.test.ts`) extended to
      cover every new fetch path, all passing.
- [ ] No secrets or tokens in any snapshot output, log line, or fixture.
