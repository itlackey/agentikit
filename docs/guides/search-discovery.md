# Search & Discovery

Agents rarely know the exact name of an asset they need. akm solves this
without front-loading a giant prompt: assets are indexed once, searched on
demand, and loaded by ref when needed. The four commands below form the
complete retrieval path from "I need something" to "here it is."

## akm index

`akm index` builds and refreshes the local FTS5 search index across every
configured source — local directories, git clones, npm packages, and cached
websites. You typically run it once after adding or updating sources; after
that it updates incrementally.

```sh
akm index              # Incremental — only re-scans changed directories
akm index --full       # Full rebuild from scratch
akm index --verbose    # Print phase-by-phase progress to stderr
```

When an LLM endpoint is configured, akm can enhance metadata during indexing
(titles, descriptions, tags) without a separate command. Run `akm index`
after `akm add` or `akm update` to bring the index up to date.

## akm search

`akm search` queries the unified index for matching assets. Results are ranked
by relevance and utility score; there is no source-by-source fan-out.

```sh
akm search "deploy"
akm search "deploy" --type script --limit 10
akm search "lint" --from registry            # Search the public registry instead
akm search "docker" --from all --detail full
```

**Key flags**

| Flag | Purpose |
| --- | --- |
| `--type` | Narrow to one asset type: `skill`, `script`, `workflow`, `knowledge`, etc. |
| `--limit` | Maximum hits returned (default 20) |
| `--from` | `local` (default), `registry`, or `all` |
| `--shape agent` | Adds agent-oriented fields (`path`, `editable`, `description`, `score`) on top of the default hit shape — use this from agents |

The `ref` field (e.g. `scripts/deploy.sh`) is present at `--detail brief`
(the default) and `--detail full`, and at any `--detail` level under
`--shape agent`. It is dropped at `--detail normal` (the `human`-shaped
"normal" hit has no `ref` field). Pass it directly to `akm show`.

**Example: find a deploy script**

```sh
akm search "deploy" --type script --shape agent
# → [{"type":"script","name":"deploy.sh","ref":"scripts/deploy.sh","score":0.87,...}]
```

## akm curate

`akm curate` goes beyond keyword matching: it runs a search, then applies a
task-aware ranking pass to surface the most relevant assets for what you are
actually about to do. It keeps search ranking as the backbone, uses only small
type-aware nudges for close calls, falls back when phrase hits are weak, and can
attach support refs for closely related assets. Curate still includes follow-up
commands (`akm show <ref>`) so you can immediately inspect any result.
`--detail` works on curate output (`normal`/`full` add `preview` and `run`),
and `--shape agent` adds agent-oriented fields (`path`, `editable`,
`description`, `score`) to the default item shape — the same additive
behavior as on `akm search`.

```sh
akm curate "plan a release"
akm curate "deploy a Bun app" --limit 3
akm curate "review an architecture proposal" --type skill
akm curate "learn the release workflow" --from all --format text
```

Use `akm curate` at the start of a complex task to build context before
loading individual assets. Use `--type workflow` when you want curated
step-by-step procedures rather than individual scripts or docs.

**Example: get instructions for a code review**

```sh
akm curate "code review" --type skill
# → ranked shortlist with akm show skills/code-review as the top follow-up
```

## akm show

`akm show` loads the full content of a specific asset by ref. Every asset type
returns type-specific fields: scripts include `run` and `setup`; markdown docs
accept a `#fragment` to return one section; workflows return parsed steps.

```sh
akm show scripts/deploy.sh
akm show skills/code-review
akm show workflows/ship-release
akm show knowledge/api-guide
akm show knowledge/api-guide#authentication
```

The ref format is `[bundle//]conceptId` (the `bundle//` prefix narrows lookup
to a specific installed bundle). Get refs from `akm search --shape agent` or
`akm curate`.

**Example: curate assets before starting a task, then load the best one**

```sh
akm curate "database migration" --type script --limit 3
akm show scripts/migrate.sh
```

## See also

- [Knowledge Management](knowledge-management.md) — capturing and importing assets
- [Sources & Registries](sources-registries.md) — where assets come from
- [Agent Integration](agent-integration.md) — how agents reference assets by ref
- [CLI Reference](../reference/cli.md) — full flag documentation for `search`, `curate`, `show`, `index`
- [Concepts](../guides/concepts.md) — refs, search priority, and the FTS5 index
