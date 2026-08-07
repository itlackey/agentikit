# Documentation

**Category:** Portable capability library for AI agents (think of it as a
package manager for agent capabilities).

**Give every coding agent the capabilities your team has already built.**
AKM indexes existing agent assets in place, loads only what a task needs,
packages capabilities into shareable bundles, improves the library through
reviewable proposals, and runs durable workflows -- locally and without tying
the library to one assistant.

Build your agent library once. Use it from any shell-capable coding agent.

This page is organized around what you're trying to do, not around
subdirectories. Pick a section below.

## Start

- [What AKM is](https://github.com/itlackey/akm/blob/main/README.md) -- Project overview, the five pillars, and the retrieval loop
- [Getting Started](https://github.com/itlackey/akm/blob/main/docs/guides/getting-started.md) -- Quick setup guide
- [Concepts](https://github.com/itlackey/akm/blob/main/docs/guides/concepts.md) -- Bundles, adapters, asset types, and refs
- [Use AKM with your agent](https://github.com/itlackey/akm/blob/main/docs/guides/agent-integration.md) -- Wiring akm into Claude Code, OpenCode, Cursor, Aider, Windsurf, or any shell-capable assistant
- [Agent Install Guide](https://github.com/itlackey/akm/blob/main/docs/agents/agent-install.md) -- Step-by-step automated/headless install for agents (full index: [docs/agents/README.md](https://github.com/itlackey/akm/blob/main/docs/agents/README.md))
  - For the CLI reference agents load at runtime, see `akm help agents` (short guide by default; `akm help agents --full` for the complete guide), backed by the embedded corpus at `src/assets/hints/cli-hints-{full,short}.md`.

## Use

Task-oriented tours through the retrieval loop: connect -> index -> curate ->
show -> use/run -> feedback -> proposal. Not every task uses every stage.
(Full index: [docs/guides/README.md](https://github.com/itlackey/akm/blob/main/docs/guides/README.md).)

- [Discover and load capabilities](https://github.com/itlackey/akm/blob/main/docs/guides/search-discovery.md) -- Search or curate a shortlist, then load full content by ref
- [Connect and share bundles](https://github.com/itlackey/akm/blob/main/docs/guides/sources-registries.md) -- Sources, registries, and installing/sharing bundles
- [Capture knowledge](https://github.com/itlackey/akm/blob/main/docs/guides/knowledge-management.md) -- Turning notes and docs into retrievable memories
- [Improve the library](https://github.com/itlackey/akm/blob/main/docs/guides/improvement-loop.md) -- Feedback that influences retrieval and produces diffable, reviewable proposals
- [Run workflows](https://github.com/itlackey/akm/blob/main/docs/reference/workflows.md) -- Durable, persisted workflows with dispatch, gates, retries, budgets, and resume

## Build and operate

- [Bundle Authoring](https://github.com/itlackey/akm/blob/main/docs/guides/stash-makers.md) -- Build and share a bundle on GitHub, npm, or a network directory
- [Multi-wiki knowledge bases](https://github.com/itlackey/akm/blob/main/docs/guides/wikis.md) -- Wikis (Karpathy-style)
- [Local development](https://github.com/itlackey/akm/blob/main/docs/guides/local-development.md) -- Dogfooding akm while editing its own source
- [Claude Code workflows vs. akm workflows](https://github.com/itlackey/akm/blob/main/docs/guides/claude-code-vs-akm-workflows.md) -- Comparing the two things that share a name

## Look up details

Full index: [docs/reference/README.md](https://github.com/itlackey/akm/blob/main/docs/reference/README.md).

- [CLI Reference](https://github.com/itlackey/akm/blob/main/docs/reference/cli.md) -- All `akm` commands and flags
- [Configuration](https://github.com/itlackey/akm/blob/main/docs/reference/configuration.md) -- Engines, strategies, bundles, and settings
- [Bundle Types](https://github.com/itlackey/akm/blob/main/docs/reference/bundle-types.md) -- Every bundle format akm recognizes: detection, refs, indexing, validation, read/write
- [Registry](https://github.com/itlackey/akm/blob/main/docs/reference/registry.md) -- Registries, search, hosting, and managing sources
- [Wiki Snapshot Fetchers](https://github.com/itlackey/akm/blob/main/docs/reference/wiki-snapshot-fetchers.md) -- The pluggable fetcher API for URL-based knowledge reads
- [Data & Privacy](https://github.com/itlackey/akm/blob/main/docs/reference/data-and-telemetry.md) -- Exactly what akm reads and writes on your machine (no remote telemetry)
- [akm-eval](https://github.com/itlackey/akm/blob/main/docs/reference/akm-eval.md) -- Standalone toolkit for measuring whether `akm improve` is working (maintainer/eval tooling)
- [Roadmap](https://github.com/itlackey/akm/blob/main/docs/reference/roadmap.md) -- High-level focus for the 0.9 and 1.0 releases
- [Architecture](https://github.com/itlackey/akm/blob/main/docs/architecture/README.md) -- System overview, normative specs, decision history, and subsystem internals
  - [Core Principles](https://github.com/itlackey/akm/blob/main/docs/architecture/akm-core-principles.md) -- Design principles and constraints
  - [System Architecture](https://github.com/itlackey/akm/blob/main/docs/architecture/architecture.md) -- How akm's bundles, cache, index, and registries fit together
- [Migration](https://github.com/itlackey/akm/blob/main/docs/migration/README.md) -- Upgrade guides and release notes
  - [v0.8 -> v0.9 migration guide](https://github.com/itlackey/akm/blob/main/docs/migration/v0.8-to-v0.9.md) -- Current-cycle breaking changes
  - [Release notes](https://github.com/itlackey/akm/blob/main/docs/migration/release-notes/) -- The short per-release notes `akm help migrate <version>` prints
- [Curate Workmap](https://github.com/itlackey/akm/blob/main/docs/agents/curate-workmap.md) -- Maintainer-only: read before changing `akm curate` ranking or output

## Execution boundary

AKM retrieves every supported capability type. It directly orchestrates
defined execution surfaces such as workflows, agent dispatch, tasks, and
guarded subprocess injection. It does not blindly execute arbitrary indexed
content merely because that content appears in search results.

AKM is local-first and works with existing tool layouts (current read/write
support varies by bundle type -- see [Bundle Types](https://github.com/itlackey/akm/blob/main/docs/reference/bundle-types.md)).
Git, npm, website sources, registries, and configured model endpoints can
still reach the network. AKM complements MCP and assistant-native skills
rather than replacing either.

## Posts

Dated publishing archive -- not current product reference.

- [Posts](https://github.com/itlackey/akm/blob/main/docs/posts/README.md) -- Source articles for the dev.to publishing pipeline (historical record)

## Official Ecosystem Repositories

- [itlackey/akm-stash](https://github.com/itlackey/akm-stash) -- the official onboarding capability bundle with ready-made skills, workflows, commands, and knowledge, installable with `akm bundle add`
- [itlackey/akm-registry](https://github.com/itlackey/akm-registry) -- the official registry index that powers built-in discovery
- [itlackey/akm-plugins](https://github.com/itlackey/akm-plugins) -- optional integrations for tools like OpenCode
- [itlackey/akm-bench](https://github.com/itlackey/akm-bench) -- the standalone benchmark and evaluation repo for akm

---

New docs, in five lines: keep one current-truth doc per subsystem, don't fork
a second one. Planning, review, and analysis material lives in the untracked
`.plans/` directory, never under `docs/` -- promote conclusions into the
current-truth doc or drop them. Normative specs live in
`docs/architecture/specs/`. Cite code by symbol and memories by search-terms,
not line numbers or exact refs -- both rot. Nothing in `docs/` may reference
`.plans/`.
