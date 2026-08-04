# Website Snapshot Extraction Fix

**Status:** Implemented and verified
**Date:** 2026-08-04
**Reference:** [`fwdslsh/inform`](https://github.com/fwdslsh/inform) at `f708313` (CC-BY-4.0)

## Goal

Make `akm import <url>` produce focused, readable Markdown for repository pages,
X posts, X Articles linked from posts, and ordinary article/documentation pages.
Keep the existing website provider, snapshot-fetcher registry, SSRF guards, and
secret-resolution boundary.

## Findings

The current behavior is not caused by an obsolete importer. The active import
path sends every HTTP URL through `fetchWebsiteMarkdownSnapshot()`.

Inform avoids the reported GitHub failure because its CLI classifies GitHub URLs
before generic crawling and sends them to `GitCrawler`. Its generic crawler also
removes navigation, menus, sidebars, ads, sharing controls, comments, related
content, breadcrumbs, cookie notices, popups, modals, and overlays from a selected
content region.

AKM currently differs in four material ways:

1. GitHub repository roots reach the generic HTML converter, so GitHub's whole
   application `<main>` can win over the much narrower README.
2. The X fetcher matches profiles only. `/user/status/<id>` therefore reaches the
   generic converter and captures X's loading shell.
3. Content-region cleanup runs only for the `<body>` fallback, not inside a
   matched `<main>` or `<article>`.
4. Redirected short links are classified only before the redirect. A URL that
   resolves to a supported site never gets a second specialized dispatch.

## Design

### Keep one extension point

Extend `WikiSnapshotFetcher`; do not add provider kinds or URL-specific command
branches. Built-in fetchers remain ordered before the generic website fallback,
and stash-local fetchers retain precedence over built-ins.

### GitHub repository roots

Add a `github-repository` fetcher for `github.com/<owner>/<repo>` roots. Fetch the
preferred README through GitHub's documented
`GET /repos/{owner}/{repo}/readme` endpoint using the rendered-HTML media type,
then pass that narrow HTML through AKM's existing safe HTML-to-Markdown converter.

- Use `githubHeaders()` so `GITHUB_TOKEN` / `GH_TOKEN` / `gh auth token` continue
  to provide optional authentication.
- Read from the fixed `api.github.com` host with manual redirect rejection and a
  byte cap, so credentials cannot follow a redirect.
- Return `null` on unavailable repositories or READMEs so generic extraction can
  still handle unusual public pages.
- Limit matching to repository roots. Blob, tree, issue, release, and discussion
  pages remain ordinary web pages; `akm bundle add github:owner/repo` remains the
  full-repository ingestion path.

### X resources

Replace profile-only URL parsing with a discriminated parser for:

- profile roots: `/username`
- posts: `/username/status/<id>`, `/username/statuses/<id>`, `/i/status/<id>`,
  and `/i/web/status/<id>`
- Articles: `/i/article/<id>`

Profile behavior remains unchanged. For a post:

1. Fetch its public X HTML through `fetchGuardedResponse()` without credentials.
2. If the serialized page data contains an `ArticleEntity`, extract its title and
   `plain_text` body using a bounded JavaScript-string scanner plus `JSON.parse`.
   The scanner executes no page code and emits plain text only.
3. Otherwise, when a bearer token exists, use documented
   `GET /2/tweets/{id}` with `note_tweet` and author fields.
4. Without API content, use the target page's Open Graph description as the
   public fallback for an ordinary post.

This supports the reported X Article URL because it is an Article's enclosing
status URL and X includes the complete Article body in that public response.
A bare `/i/article/<id>` is recognized and the same public-data extraction is
attempted, but remains best-effort: X currently omits the body from that page and
documents create/publish Article endpoints only, not Article lookup. Do not bind
AKM to private GraphQL operation IDs or third-party reader services.

All post and Article text is escaped with the existing
`escapeMarkdownStructure()` helper. Bearer tokens stay confined to the fixed
`api.x.com` request and never enter page requests, warnings, or snapshots.

### Redirect re-dispatch

After the guarded generic fetch follows redirects, compare the final URL with the
input URL. If it changed, offer the final URL to the same registry before using
the already-produced generic Markdown. This enables short links that resolve to
GitHub, X, feeds, or stash-local fetchers without weakening per-hop SSRF checks.

Only the single-URL import path gets this second dispatch. Multi-page crawls keep
their existing same-origin and robots behavior.

### Generic extraction

Improve the shared extractor rather than adding per-site selector tables:

- Prefer narrow content classes (`.markdown-body`, `.article-content`,
  `.entry-content`, `.post-content`, `.main-content`, `.docs-content`) before
  broad `<main>` and `.content` containers.
- Remove Inform's unwanted-element set inside every selected region, not only
  the `<body>` fallback.
- Preserve whole-document link collection for crawl discovery.
- Add a small Turndown rule for tables with explicit header cells so common
  documentation/README tables remain GFM tables instead of disconnected text.
- Preserve all current dangerous-markup, link-scheme, credential-stripping,
  code-fence, nesting-budget, and residual-markup protections.

## Files

- Add `src/sources/snapshot-fetchers/github.ts`.
- Modify `src/sources/snapshot-fetchers/registry.ts`.
- Modify `src/sources/snapshot-fetchers/x.ts`.
- Modify `src/sources/snapshot-fetchers/host-guard.ts` only to share a
  fixed-host, redirect-rejecting text response helper if needed.
- Modify `src/sources/snapshot-fetchers/website-ingest.ts` for final-URL
  re-dispatch.
- Modify `src/sources/snapshot-fetchers/content-extract.ts` for region cleanup,
  selector precedence, and tables.
- Extend `tests/website-feed-fetchers.test.ts` and
  `tests/website-content-extract.test.ts`; add a focused GitHub fetcher test file
  if keeping those cases separate is clearer.

## Verification

Tests must prove:

- GitHub repository roots return README content without repository navigation.
- GitHub API redirects are rejected and never receive an authorization header at
  their target.
- X URL parsing distinguishes profiles, posts, and Articles.
- Exact post lookup uses API v2 when configured, including `note_tweet` text.
- Public ordinary posts work without a token.
- Public status pages containing an Article emit the Article title and full body,
  not the X loading shell or only the `t.co` seed post.
- A redirect to a specialized URL invokes the specialized fetcher.
- Unwanted chrome nested inside a selected `<main>` is removed.
- `.markdown-body` beats a broader ancestor `<main>`.
- Headered HTML tables become valid GFM tables.
- Existing security regression suites remain green and no credential reaches
  output.

Run:

```sh
bunx biome check --write src/ tests/
bun test tests/website-content-extract.test.ts
bun test tests/website-feed-fetchers.test.ts
bun test tests/website-github-fetcher.test.ts
bunx tsc --noEmit
bun run check:changed
```

Run `bun run check` if focused verification exposes shared website-provider or
CLI-contract changes.
