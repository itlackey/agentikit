# Sources & Registries

Every asset in akm comes from a **source** — a local directory, git repo, npm
package, or crawled website. **Registries** are discovery indexes that let you
find sources you haven't heard of yet. Together they give you a unified,
searchable library that can pull from anywhere and grow over time.

## akm bundle add

`akm bundle add` connects a new source. The source kind is inferred from the
input: known git hosts and URLs ending in `.git` are git sources, while other
HTTP(S) URLs are website sources.

```sh
akm bundle add ~/.claude/skills                          # Local directory (filesystem)
akm bundle add github:owner/team-bundle                  # GitHub repo (git)
akm bundle add @scope/bundle                              # npm package
akm bundle add npm:@scope/bundle@latest                  # npm with version pin
akm bundle add github:owner/repo#v1.2.3                 # GitHub at a specific tag
akm bundle add https://docs.example.com --name docs     # Crawled website (website)
akm bundle add https://docs.example.com --max-pages 200 --max-depth 5

# Add the official onboarding bundle:
akm bundle add github:itlackey/akm-stash

# Mark a git bundle as writable (enables akm sync to push):
akm bundle add git@github.com:org/skills.git --provider git --name my-skills --writable
```

| Source kind | Input shape | Behavior |
| --- | --- | --- |
| `filesystem` | local path | Indexed in place, writable by default |
| `git` | `github:`, known git-host URL, or URL ending in `.git` | Cloned into `~/.cache/akm/registry/`, read-only by default |
| `npm` | `@scope/pkg` | Installed into cache, read-only |
| `website` | Other HTTP/HTTPS URL | Crawled, converted to markdown, refreshed every 12 hours |

After `akm bundle add`, run `akm index` to bring the search index up to date.

**Recognized URL shapes.** Before falling back to a general crawl, a `website`
URL is offered to a set of specialized fetchers. Each produces a single
markdown snapshot instead of a crawl:

| URL shape | Produces | Notes |
| --- | --- | --- |
| YouTube video | Description + transcript | No credentials |
| `bsky.app/profile/<handle>` | Recent posts | Public API, no credentials |
| `x.com/<user>`, `twitter.com/<user>` | Recent posts | Needs a token — see below |
| Feed URLs (`/feed`, `/rss`, `*.rss`, `*.atom`, `*.xml`) | Feed items | RSS 2.0, Atom 1.0, RDF |

A fetcher that cannot produce content hands the URL back to the normal crawler,
so a `/feed` path that actually serves HTML is still crawled as a web page.

**X credentials.** The X fetcher needs either `X_BEARER_TOKEN` (X API v2) or
`X_RSS_TEMPLATE` — an RSS bridge URL containing `{username}`, such as a
self-hosted Nitter instance. With neither set it emits one warning and falls
through to the crawler. To keep the token out of your shell history and config
files, store it as an akm secret and inject it for the one command that needs it:

```sh
akm secret set x-bearer-token
akm secret run x-bearer-token --as X_BEARER_TOKEN -- akm bundle add https://x.com/<user>
```

**Website crawl options.** `website` sources accept `maxPages` (default 50),
`maxDepth` (default 3), and `respectRobots` (default `true`) under the bundle's
`website` descriptor. `respectRobots` makes akm honor the origin's
`/robots.txt` — skipping disallowed paths and pacing requests by
`Crawl-delay` (clamped to 10s) — for the `akm`/`akm-cli` product tokens (or
`*`). If the crawl's start URL is itself disallowed, `akm bundle add` /
`akm bundle update` fails with an error naming the opt-out. Set
`"respectRobots": false` on the descriptor to skip `/robots.txt` entirely and
crawl every reachable page as akm did before this behavior existed:

```json
{
  "bundles": {
    "docs": {
      "website": { "url": "https://docs.example.com", "maxPages": 200, "maxDepth": 5, "respectRobots": false }
    }
  }
}
```

**Example: add a team bundle from GitHub**

```sh
akm bundle add github:my-org/team-bundle --name team
akm index
akm search "deploy" --type script
```

## akm bundle list

`akm bundle list` shows all configured sources — local directories, managed packages,
and remote providers — so you know what is in your library.

```sh
akm bundle list                          # All sources
akm bundle list --kind filesystem        # Only local directories
akm bundle list --kind git               # Only git-cloned sources
akm bundle list --kind npm               # Only npm packages
akm bundle list --kind filesystem,git    # Multiple kinds (comma-separated)
```

Valid `--kind` values are the four source providers: `filesystem`, `git`,
`npm`, `website`.

## akm bundle update / akm bundle remove

`akm bundle update` pulls the latest version of a managed (git or npm) source.
`akm bundle remove` disconnects a source and re-indexes without it.

```sh
# Update
akm bundle update @scope/bundle          # One managed source
akm bundle update --all                 # All managed sources
akm bundle update --all --force         # Force fresh download even if version unchanged

# Remove
akm bundle remove @scope/bundle          # By npm id
akm bundle remove github:owner/repo     # By git ref
akm bundle remove ~/.claude/skills      # By path
akm bundle remove my-provider           # By name
```

**Example: keep sources fresh**

```sh
akm bundle update --all && akm index
```

## akm clone

`akm clone` copies a single asset from any source into your writable bundle (or
a custom destination) for local editing. After cloning, your local copy wins in
subsequent searches automatically.

```sh
akm clone scripts/deploy.sh
akm clone skills/code-review --name my-code-review
akm clone scripts/deploy.sh --dest ./project/.claude
akm clone "npm:@scope/pkg//scripts/deploy.sh"   # From uninstalled package
```

Clone is non-destructive: use `--force` to overwrite an existing local copy.
Skills (directories with `SKILL.md`) are copied recursively. All other types
copy a single file.

**Example: clone and customize a workflow**

```sh
akm clone workflows/ship-release --dest ./project/.claude
# Edit ./project/.claude/workflows/ship-release.md
# The local copy wins in searches from this directory forward
```

## akm sync

`akm sync` stages, commits, and optionally pushes your writable bundle. It is
the complement to `akm bundle add`: once you have made changes locally, `sync` persists
them to git. (There is no `akm save` command — use `akm sync`.)

```sh
akm sync                          # Primary bundle, auto timestamp message
akm sync -m "Add deploy skill"   # Custom commit message
akm sync my-skills -m "Update"   # Named writable git source
```

Push behavior depends on configuration: if the bundle is a git repo with a
remote and `writable: true`, sync also pushes. Otherwise it commits only.

Writes that land on a writable git source via an explicit destination flag
(e.g. `akm remember --bundle my-skills`, proposal accept/revert, consolidate) are
committed automatically in a single batch at the end of the operation — one
complete commit (staging `.akm/` + assets together), pushed under the same
`writable + remote` gate as `akm sync`. `options.pushOnCommit` is rejected at
config load; remove it and rely on `writable: true` + push instead.

**Example: publish your own bundle**

```sh
# One-time setup: make the primary bundle push on sync
# Set `"writable": true` in ~/.config/akm/config.json
akm sync -m "Add deployment skills"
# → stages, commits, and pushes to your configured remote
```

## akm registry

The registry is a discovery index — it lets you find and install bundles you
don't know about yet. The official registry ships pre-configured.

```sh
akm registry list                             # See configured registries
akm search "deploy" --from registry           # Search registry bundles by topic
akm search "code review" --from registry --assets  # Include asset-level hits
akm registry add https://example.com/registry/index.json --name my-team
akm registry remove my-team
```

Once you find an interesting bundle in the registry, install it with `akm bundle add`:

```sh
akm search "kubernetes" --from registry
akm bundle add github:some-org/k8s-bundle
akm index
```

## See also

- [Search & Discovery](search-discovery.md) — querying the index after sources are connected
- [Knowledge Management](knowledge-management.md) — writing your own assets
- [Agent Integration](agent-integration.md) — using refs across sources in prompts
- [CLI Reference](../reference/cli.md) — full flag documentation for `add`, `list`, `update`, `remove`, `clone`, `sync`, `registry`
- [Registry](../reference/registry.md) — registry index format and private registry setup
- [Bundle Maker's Guide](../guides/stash-makers.md) — build and publish your own bundle
