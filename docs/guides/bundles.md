# Bundles

akm works toward two outcomes: bring the agent assets you already have into
one library, and install (or share) reusable capability bundles with other
people. Both go through the same primitive — a **bundle** — which can be a
local directory, a git repo, an npm package, or a crawled website.
**Registries** are discovery indexes that let you find bundles you haven't
heard of yet. Together they give you a unified, searchable library that pulls
from anywhere and grows over time.

## Bring what you already have into one library

If you already have skills, commands, or agent configs scattered across
different tools, point akm at each of them. Nothing moves — akm indexes assets
in place — and every asset becomes retrievable through the same search and
curate commands regardless of which agent originally created it.

```sh
akm bundle add ~/.claude               # Claude Code's project/user assets
akm bundle add ~/.config/opencode      # OpenCode's config directory
akm index                              # Bring the search index up to date
akm curate "plan a release"            # Pull the best matches from every bundle you added
```

This is the "one library for every agent" idea in practice: assets authored
for one tool become discoverable — and usable — from any other.

## akm bundle add

`akm bundle add` connects a new bundle. The source kind is inferred from the
input: known git hosts and URLs ending in `.git` are git bundles, while other
HTTP(S) URLs are website bundles.

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

| Bundle kind | Input shape | Behavior |
| --- | --- | --- |
| `filesystem` | local path | Indexed in place, writable by default |
| `git` | `github:`, known git-host URL, or URL ending in `.git` | Cloned into `~/.cache/akm/registry/`, read-only by default |
| `npm` | `@scope/pkg` | Installed into cache, read-only |
| `website` | Other HTTP/HTTPS URL | Crawled, converted to markdown, refreshed every 12 hours |

After `akm bundle add`, run `akm index` to bring the search index up to date.

**Website bundles.** A `website` URL is offered to a set of specialized
fetchers (YouTube, Bluesky, X, RSS/Atom feeds) before falling back to a
general crawl, and crawl behavior (page/depth limits, timeouts, robots.txt)
is configurable. See the
[website source recipe](recipes/website-source.md) for a walkthrough and
[Website Sources](../reference/website-sources.md) for the full fetcher
reference, X credential setup, and crawl-option details. Low-level knobs like
`crawlTimeoutMs` and `respectRobots` live in the bundle's `website`
descriptor — see [Configuration](../reference/configuration.md).

**Example: add a team bundle from GitHub**

```sh
akm bundle add github:my-org/team-bundle --name team
akm index
akm search "deploy" --type script
```

## akm bundle list

`akm bundle list` shows all configured bundles — local directories, managed
packages, and remote providers — so you know what is in your library.

```sh
akm bundle list                          # All bundles
akm bundle list --kind filesystem        # Only local directories
akm bundle list --kind git               # Only git-cloned bundles
akm bundle list --kind npm               # Only npm packages
akm bundle list --kind filesystem,git    # Multiple kinds (comma-separated)
```

Valid `--kind` values are the four bundle providers: `filesystem`, `git`,
`npm`, `website`.

## akm bundle update / akm bundle remove

`akm bundle update` pulls the latest version of a managed (git or npm)
bundle. `akm bundle remove` disconnects a bundle and re-indexes without it.

```sh
# Update
akm bundle update @scope/bundle          # One managed bundle
akm bundle update --all                 # All managed bundles
akm bundle update --all --force         # Force fresh download even if version unchanged

# Remove
akm bundle remove @scope/bundle          # By npm id
akm bundle remove github:owner/repo     # By git ref
akm bundle remove ~/.claude/skills      # By path
akm bundle remove my-provider           # By name
```

**Example: keep bundles fresh**

```sh
akm bundle update --all && akm index
```

## akm clone

`akm clone` copies a single asset from any bundle into your writable bundle
(or a custom destination) for local editing. After cloning, your local copy
wins in subsequent searches automatically.

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
the complement to `akm bundle add`: once you have made changes locally,
`sync` persists them to git. (There is no `akm save` command — use
`akm sync`.)

```sh
akm sync                          # Primary bundle, auto timestamp message
akm sync -m "Add deploy skill"   # Custom commit message
akm sync my-skills -m "Update"   # Named writable git bundle
```

Push behavior depends on configuration: if the bundle is a git repo with a
remote and `writable: true`, sync also pushes. Otherwise it commits only.

Writes that land on a writable git bundle via an explicit destination flag
(e.g. `akm remember --bundle my-skills`, proposal accept/revert, consolidate)
are committed automatically in a single batch at the end of the operation —
one complete commit (staging `.akm/` + assets together), pushed under the
same `writable + remote` gate as `akm sync`. `options.pushOnCommit` is
rejected at config load; remove it and rely on `writable: true` + push
instead.

**Example: publish your own bundle**

```sh
# One-time setup: make the primary bundle push on sync
# Set `"writable": true` in ~/.config/akm/config.json
akm sync -m "Add deployment skills"
# → stages, commits, and pushes to your configured remote
```

For the full workflow of turning a bundle into something others can install —
manifest conventions, versioning, and publishing to a registry — see the
[Bundle Author's Guide](author-bundles.md). For how a bundle's provider kind
maps to the code that indexes and fetches it, see
[Architecture](../architecture/architecture.md).

## Install and share reusable capability bundles

The other half of the bundle story is discovery: finding bundles other people
have published, and publishing your own so others can install it. `akm bundle
add` (above) is how you install one once you know where it lives; the
registry (below) is how you find it in the first place.

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

For the registry index schema, hosting a private registry, and how entries
get discovered, see [Registry](../reference/registry.md).

## See also

- [Discover & Load](discover-and-load.md) — querying the index after bundles are connected
- [Knowledge Management](knowledge-management.md) — writing your own assets
- [Use akm With Any Agent](use-with-any-agent.md) — using refs across bundles in prompts
- [Website Source Recipe](recipes/website-source.md) — walkthrough for adding a crawled website bundle
- [Website Sources](../reference/website-sources.md) — fetcher reference, X credentials, crawl options
- [Configuration](../reference/configuration.md) — bundle descriptor fields including `website` crawl knobs
- [CLI Reference](../reference/cli.md) — full flag documentation for `add`, `list`, `update`, `remove`, `clone`, `sync`, `registry`
- [Registry](../reference/registry.md) — registry index format and private registry setup
- [Bundle Author's Guide](author-bundles.md) — build and publish your own bundle
- [Architecture](../architecture/architecture.md) — how bundle providers are implemented
