# Concepts

`akm` is a knowledge toolkit for AI agents. It organizes scripts, skills,
commands, agents, knowledge documents, env files, secrets, workflows, and
memories into a searchable library that any AI coding assistant can use, and
gives you the verbs to capture, curate, and share what accumulates there.

## Mental Model

Two core concepts:

```text
sources       → where assets come from (local dirs, git repos, websites, npm)
registries    → where you discover sources you don't know about yet
```

A **source** is anything you add with `akm bundle add`. Every source materialises
files to a local directory; the indexer walks that directory and builds the
search index. Each source has a **kind** inferred from the input:

| Input | Kind | Behavior |
| --- | --- | --- |
| `~/.claude/skills` | `filesystem` | Indexed in place. Not updatable. Writable by default. |
| `github:owner/repo` | `git` | Cloned into `~/.cache/akm/registry/`. Updatable via `akm bundle update`. Read-only by default. |
| `npm:@scope/bundle` | `npm` | Installed into `~/.cache/akm/registry/`. Updatable via `akm bundle update`. Read-only. |
| `https://docs.example.com` | `website` | Crawled, converted to markdown, cached. Refreshed every 12 hours. Read-only. |

The user never picks the kind. `akm bundle add` infers it from the input shape.

1. **Sources** are places assets come from. Add any source with `akm bundle add` —
   a local directory, a GitHub repo, an npm package, or a website. Use
   `akm bundle list` to see all your sources.
2. **Registries** are discovery indexes for finding sources you don't know
   about yet. The official registry ships by default; add third-party
   registries with `akm registry add`.
3. **Assets** are the individual capabilities an agent discovers and uses:
   scripts, skills, commands, agents, knowledge documents, env files,
   secrets, workflows, and memories.

Your **working bundle** (`~/akm`) is created by `akm setup` — it's the
primary directory for your personal, editable assets, and is registered as
a `filesystem` source automatically.

When you search, akm queries the unified local FTS5 index, which includes
every source's directory. There is no per-source fan-out at search time.

### Source vs. working bundle

The two terms come up often:

- **Source** is the configuration concept (an entry in the `bundles` map in
  your config file). It's any directory akm has been told to index.
  Configured via `akm bundle add`.
- **Working bundle** is the special source created by `akm setup` — the
  default destination for `akm remember`, `akm import`, and other writes.
  Named by `defaultBundle` in config and registered automatically as a
  `filesystem` source.

If you don't pick a write destination explicitly with `--target` (or a
command-specific `--bundle`) or `defaultWriteTarget`, writes land in the
working bundle.

## What's In a Bundle?

A bundle is a directory of assets you can share and install. There's no required
structure -- `akm` classifies assets by **file extension and content**, not by
directory name. A `.sh` file is a script whether it lives in `scripts/`,
`deploy/`, or at the root.

That said, using these directory names as an opt-in convention improves
indexing confidence. Env files are the current exception: `.env` env assets are
only discovered under `env/` paths.

```text
my-bundle/
  scripts/        # Executable scripts (.sh, .ts, .js, .py, .rb, .go, etc.)
  skills/         # Skill definitions (directories with SKILL.md)
  commands/       # Slash commands (.md with $ARGUMENTS or agent frontmatter)
  agents/         # Agent definitions (.md with model/tools frontmatter)
  knowledge/      # Reference documents (.md)
  instructions/   # Project guidance (.md)
  env/            # Environment files (.env) — groups of related config, loaded whole
  secrets/        # Secrets — one sensitive value per file (auth tokens, keys, certs)
  workflows/      # Unified workflow assets (.md)
  lessons/        # Distilled lessons (.md, see akm improve / proposals)
  memories/       # Recalled context fragments (.md)
  facts/          # Durable bundle-level facts (.md, see "Asset Types" below)
  tasks/          # Scheduled or on-demand automation tasks (.yml)
  sessions/       # Machine-placed indexed session summaries (.md)
  .meta/          # Optional bundle orientation, not indexed (see "Metadata" below)
```

LLM Wikis are a related but separate concept: a wiki is its own installable
bundle (`akm bundle add github:team/research-wiki`), not a type-subdirectory inside a
regular bundle. See [Wikis](wikis.md) for how akm recognizes and indexes them.

## Asset Types

akm's own native format (the `akm` adapter) recognizes fourteen asset
types — script, skill, command, agent, knowledge, instruction, env, secret,
workflow, lesson, memory, task, session, and fact. See
[Bundle Types → akm](../reference/bundle-types.md#akm) for the full
type-by-type table (purpose, what the agent gets, and example ref), and
[Bundle Types](../reference/bundle-types.md) for the other ten *bundle
formats* akm can also recognize, index, and validate in place (Claude Code
and OpenCode tool directories, OKF, LLM wikis, and more).

### Classification Taxonomy

Scripts and knowledge are classified by **what they are**: a `.sh` file is a
script; a plain `.md` file is knowledge. Commands and agents are classified by
**how an LLM should use them**: a `.md` file with `$ARGUMENTS` placeholders is
a command template; one with `tools` in its frontmatter is an agent definition.
Workflows are classified by their markdown structure (`# Workflow:`, `## Step:`,
`Step ID:`, `### Instructions`). Skills are a **packaging convention**: a
directory containing a `SKILL.md` file.

See [technical/classification.md](../architecture/internals/classification.md) for the full
specificity-based matching system.

### Memories

Memories are context fragments — observations, decisions, snippets — captured
as markdown files. You can capture a memory directly in your working bundle
with `akm remember "..."`, or point akm at any directory of memory files
written by another tool.

To add a memory source:

```sh
# File-based memory store from another tool
akm bundle add ~/my-agent/memories
```

Memory assets appear in search results with the `memory` type, giving agents
access to recalled context from previous sessions.

Memories captured with `akm remember` can carry optional YAML frontmatter
(`tags`, `source`, `observed_at`, `expires`, `subjective`, `description`) that
the indexer uses for ranking. Supply those fields explicitly with
`--tag`/`--expires`/`--source`, derive them from the body heuristically with
`--auto`, or have the configured LLM propose them with `--enrich`. See
[`akm remember`](../reference/cli.md#remember) for the full flag list.

Hot-path memories (those written via `akm remember`) also receive
`captureMode: hot` and `beliefState: asserted` in their frontmatter
automatically. Background-derived memories (those inferred from other assets
by `akm improve`) receive `captureMode: background`. The indexer applies a
small ranking boost to hot-captured memories so explicit user-recorded context
ranks above passive inference when both match a query.

### Belief states

Memories carry a `beliefState` field that signals how the indexer should weigh
them in search. The supported values, from strongest to weakest authority:

| State | When it's set | Ranking effect |
|-------|---------------|----------------|
| `asserted` | Written directly by `akm remember` (user-explicit) | strongest active boost |
| `active` | Default for memories with no explicit state | active boost |
| `deprecated` | Marked as no-longer-current but not yet superseded | small penalty; frozen (never auto-refreshed) |
| `superseded` | Replaced by another memory via the `supersededBy` field | larger penalty |
| `contradicted` | Marked as contradicted by other evidence | strong penalty |
| `archived` | Soft-deleted; retained for audit | strongest penalty |

`akm search` filters via `--belief current|historical|all`:
- `current` → `active` + `asserted`
- `historical` → `deprecated` + `superseded` + `contradicted` + `archived`
- `all` (default — no filter) → every belief state, including `archived` and
  `contradicted` memories, is eligible to surface. Pass `--belief current`
  explicitly to keep only active/asserted memories.

### Derived memories as retrieval shortcuts

When `akm improve` infers a derived memory from a parent (e.g. distilling a
verbose memory into a focused summary), the derived memory is written with a
`source:` frontmatter backref naming the parent and the indexer records the
parent/child link in the `derived_from` column. (This provenance backref is a
sanctioned internal channel that carries a bare parent name, not a public ref —
agents never construct it.)

Search hits for the parent memory are then enriched in-place: the parent's
description and tags are swapped with the derived child's surface text, and an
`expandTo: memories/<derived>` field on the hit points at the richer derived
ref. The parent ref itself is preserved on the hit, so existing automation
keeps working — agents that want the deeper summary follow `expandTo`.

## Refs

Assets are identified by a **ref** -- a compact handle returned by
`akm search` and consumed by `akm show`. The format is:

```text
[bundle//]conceptId[#fragment]
```

The `conceptId` is subdir-qualified: the placement subdirectory followed by the
item's canonical name (extension stripped). `type` is not part of a ref — the
subdirectory carries that signal. For example: `scripts/deploy.sh`,
`agents/reviewer`, `knowledge/api-guide`, `workflows/ship-release`.

When an item comes from an installed bundle, refs can include a **bundle**
prefix to narrow lookup to that specific bundle:

```text
bundle//conceptId
```

For example: `team-catalog//scripts/deploy.sh`,
`personal//knowledge/guide`.

Agents should treat refs as opaque tokens -- get them from search, pass them
to show. The structured fields `conceptId` and `bundle` in search results
provide the same information in a parseable form.

Source locators like `github:owner/repo` and `npm:@scope/pkg` are **install
refs**, accepted only by `akm bundle add` and `akm clone`. They are not asset refs.

### Namespacing assets across projects and teams

AKM already supports **physical-subdirectory namespacing** today — no extra
flags required. Drop assets under nested directories beneath the type folder
and the path becomes part of the ref's name. Examples:

```text
memories/projectA/auth-tip.md    →  memories/projectA/auth-tip
memories/teamA/clientX/notes.md  →  memories/teamA/clientX/notes
skills/projectB/lint-fix.md      →  skills/projectB/lint-fix
knowledge/clientX/api-guide.md   →  knowledge/clientX/api-guide
```

This works for **any** asset type. The subpath segments become part of the
conceptId, so `akm search "projectA" --type memory` narrows results to
that subtree, and `akm show memories/projectA/auth-tip` resolves the full ref.

There is also a **ref-prefix query syntax** — a query that is a conceptId
prefix ending in `/` enumerates that subtree instead of keyword-matching:

```sh
akm search "memories/"                  # every memory
akm search "memories/projectA/"         # exactly that subtree
akm search "team-catalog//"             # every item in one bundle
akm search "team-catalog//skills/"      # one subtree of one bundle
```

Enumeration is `/`-boundary exact — a sibling `projectAlpha/` scope does not
leak — and hits are a deterministic listing with the fixed browse score `1`,
not a relevance ranking. Because it matches conceptIds, it works for items
from every adapter, and you can copy a ref prefix straight out of search
output and paste it back as a query. A complete ref
(`memories/projectA/auth-tip`, no trailing `/`) stays an ordinary keyword
search — resolving a single ref is `akm show`'s job.

(Before 0.9.0 this syntax was spelled `memory:projectA/`, using the retired
singular type token. That spelling is gone; use the conceptId prefix.)

**Recommendation:** use physical subdirectories now to organize multi-project
or multi-team bundles. They sort cleanly on disk and require no configuration.

**Treat a ref as permanent.** A rename is **delete plus create**: the new path
is a new identity, so the destination starts with fresh learned state
(utility, salience, usage history) and any inbound refs to the old path
dangle. When you must rename:

```sh
mv ~/akm/memories/old-note.md ~/akm/memories/new-note.md
# update any intentional refs (they are fully qualified: bundle//memories/old-note)
akm index
akm lint          # confirms nothing dangles
```

Moving an item between bundles is copy/import followed by deletion from the
source — both the bundle and the concept identity change. (0.9.0 removed the
`akm mv` command, which promised identity-preserving renames but implemented
prose-ref rewriting inverted; the procedure above is the only one. To carry an
asset's earned signal across a rename, the maintainer script
`scripts/rekey-asset-ref.ts` re-keys its salience/outcome/usage rows onto the
new ref. See
[the decision record](../architecture/specs/0.9.0-decisions.md#d3--renames-are-delete--create-akm-mv-ships-experimental).)

**Which subdirectory?** Choose the partition axis by asset **type**:
scope-born types (`memory`, `lesson`, `task`, `env`, `secret`) take the current
**project/client** slug; reuse-born types (`knowledge`, `skill`,
`fact`, `script`) take a stable **domain**; global types (`command`, `agent`,
`workflow`) stay at the type root or a tool slug. The full rules — depth
limits, no-volatile-facets, off-axis facets as tags, and how to cross-link for
retrieval — ship as the `facts/conventions/organization`,
`facts/conventions/backlinks`, and `facts/conventions/domains` convention facts
in the bundle skeleton, and are surfaced to agents automatically at authoring
time.

Future iterations (no committed dates):

- A `--namespace <ns>` flag will provide a thin name-prefix normalizer on
  `search`, `remember`, `improve`, and `feedback` so the same
  prefix doesn't have to be typed every time.
- A `::` delimiter (for example `projectA::memories/auth-tip`) will provide
  strict isolation so refs from different namespaces never collide in
  ranking or recall.

Until those land, physical subdirectories remain the recommended pattern.

## Search Priority

`akm search` and `akm show` query a single local FTS5 index that covers every
configured source's directory. Within the index, results are ranked by
relevance and utility — there is no source-by-source fan-out.

When two sources contain an asset with the same name, the working bundle wins
by convention because its files are usually more recent, but precedence is
expressed through ranking rather than a fixed lookup order. Use `akm clone`
to copy an asset into your working bundle for local editing — your edits
override the upstream copy in subsequent searches.

## Metadata

Metadata lives with the asset itself, not in a separate `.stash.json`
sidecar: frontmatter for markdown assets, and structured comments for
scripts. The indexer derives metadata from filenames, code comments,
frontmatter, and package.json.

See [Filesystem Layout](../architecture/internals/storage-locations.md) for the full field reference.

### Bundle orientation: the `.meta/` convention

A bundle may carry an optional `.meta/` directory at its root holding
human-authored orientation for the bundle *as a whole* — purpose, key assets,
conventions, maintainer. This is distinct from per-asset metadata, which
still lives with each asset: `.meta/` never describes individual assets, only
the bundle itself.

```text
my-bundle/
  .meta/
    index.md          # shown by `akm show meta` — the default orientation doc
    about.md          # shown by `akm show meta:about`
    conventions.md    # shown by `akm show meta:conventions`
```

Because `.meta/` is a dot-directory, the indexer skips it — these docs never
appear in `akm search` and never compete for ranking. They are **direct-read on
demand**:

```sh
akm show meta                       # working bundle's .meta/index.md
akm show meta:about                 # working bundle's .meta/about.md
akm show akm//meta                  # the primary bundle explicitly
```

`akm show <origin>//meta:<name>` resolves `<name>.md` first, then an
extensionless `<name>`. The convention is open-ended: bundle owners add new docs
by dropping files into `.meta/` — no configuration or code changes required.
`akm bundle create` scaffolds a starter `.meta/index.md`.

**Known gap (Q-19):** an install-ref origin (`akm show github:owner/repo//meta`)
does not currently resolve even for an installed bundle — `resolveSourcesForOrigin`
(`src/registry/origin-resolve.ts`) matches only derived installation ids, not
raw install refs, and this is pinned by a test
(`tests/integration/origin-resolve.test.ts`: "does not parse a full install
locator as an asset bundle"). Use `akm//meta` for the primary bundle, or the
bundle key you gave it in `bundles` (`config.json`), not the original install
ref.

## Script Execution (ExecHints)

For script assets, akm resolves execution hints in this order:

1. Header comment tags (`@run`, `@setup`, `@cwd`)
2. Auto-detection from extension and nearby dependency files

## Writable sources and write targets

Each source has a `writable` flag (config field `writable`). Defaults:

- `filesystem` — `true` (you usually own directories you point akm at)
- `git` — `false` (set `writable: true` per source if you intend to push back)
- `website`, `npm` — always `false`. Setting `writable: true` for these is
  rejected at config load — the next `sync()` would clobber your edits.

Write commands (`akm remember`, `akm import`, etc.) pick a destination using
this precedence:

1. `--target <name>` flag (must name a writable source)
2. The root-level `defaultWriteTarget` field in config
3. The working bundle created by `akm setup` (named by `defaultBundle`)

If none are configured, write commands raise a `ConfigError` pointing at
`akm setup`.

### Installation is not activation

Installing a bundle grants **nothing** on its own. A bundle can carry tasks, env
files, and workflows, and none of them fire, inject, or gain write access until
you explicitly activate them:

- **Tasks** install disabled. The scheduler skips an installed task at fire time
  until you set `enabled: true` in its file and run `akm task sync`; only
  manual (non-scheduled) runs are exempt.
- **Env injection** from a registry-installed (third-party) source hard-blocks
  process-hijacking keys (`LD_PRELOAD`, `PATH`, …); your own first-party bundle
  only warns. A freshly-installed bundle carrying dangerous env keys gates the
  install unless you confirm or pass `--allow-insecure`.
- **Writes** only ever land in the primary bundle or a source explicitly marked
  `writable: true` — a registry cache is never written in place.

This is enforced at one workspace activation-policy point; installing a bundle is
safe by construction.

`akm improve` and `akm lint` only operate on writable sources. Read-only
registry caches (`git`, `npm`, `website`) are excluded from improvement and
lint passes even if they are indexed.

## Storage

akm uses XDG-compliant directories backed by **three** databases:

| Location | What lives there |
| --- | --- |
| `~/.local/share/akm/index.db` | Search index, embeddings, LLM cache, registry index cache (fully regenerable) |
| `~/.local/share/akm/state.db` | Events, proposals, task history, workflow run state, and usage events |
| `~/.local/share/akm/logs.db` | High-volume, purgeable run logs (kept separate, joined via ATTACH) |
| `~/.local/share/akm/akm.lock` | Installed bundle lockfile |
| `~/.cache/akm/registry/` | Downloaded bundle packages (regenerable) |
| `~/.config/akm/config.json` | User configuration (`bundles` / `defaultBundle`) |
| `~/akm` (the `defaultBundle` path) | Your writable working bundle |

Events, proposals, task history, and workflow run state all live in `state.db` —
not in flat files or in the search index. The search index (`index.db`) is
fully derived from the bundle directories, so it is truly regenerable and
rebuildable with `akm index`.

## Glossary

These terms have precise meanings in akm. Use this table to avoid confusion:

| Term | Meaning | Example |
| --- | --- | --- |
| **source** | A place assets come from — added via `akm bundle add` | A directory, git repo, npm package, or website |
| **filesystem source** | A directory on disk, indexed in place | `~/akm`, `~/.claude/skills` |
| **git source** | A git repo cloned into akm's cache, updatable | A GitHub repo |
| **npm source** | An npm package installed into akm's cache, updatable | `@scope/my-bundle` |
| **website source** | A crawled website stored as knowledge | `https://docs.example.com` |
| **working bundle** | Your primary directory for editable assets (`~/akm`) | Created by `akm setup` |
| **registry** | A discovery index for finding sources | The official registry, skills.sh |
| **ref** (item ref) | A `[bundle//]conceptId` handle for an item | `scripts/deploy.sh`, `team//skills/review` |
| **bundle** | Optional prefix narrowing an item ref to a bundle | `team-catalog//scripts/deploy.sh` |
| **install ref** | A package identifier passed to `akm bundle add` or `akm clone` | `npm:@scope/pkg`, `github:owner/repo` |
| **git ref** | A branch, tag, or commit (used when installing) | `main`, `v1.0.0` |
| **search source** | Where to look: `local`, `registry`, or `all` | `--from local` |

## Further Reading

- [CLI Reference](../reference/cli.md)
- [Wikis](wikis.md) -- Multi-wiki knowledge bases (Karpathy-style)
- [Bundle Maker's Guide](stash-makers.md) -- How to build and share a bundle
- [Registry](../reference/registry.md) -- Finding and installing bundles
- [Search Architecture](../architecture/internals/search.md) -- Hybrid search details
- [Indexing](../architecture/internals/indexing.md) -- How the search index is built
- [Filesystem Layout](../architecture/internals/storage-locations.md) -- Directory structure and metadata schema
- [Configuration](../reference/configuration.md) -- Providers and settings
