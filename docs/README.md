# Documentation

Each subdirectory has its own README indexing everything inside it.

## [Guides](https://github.com/itlackey/akm/blob/main/docs/guides/README.md)

Task-oriented guides for using akm.

- [Getting Started](https://github.com/itlackey/akm/blob/main/docs/guides/getting-started.md) -- Quick setup guide
- [Concepts](https://github.com/itlackey/akm/blob/main/docs/guides/concepts.md) -- Bundles, adapters, asset types, and refs
- [Stash Maker's Guide](https://github.com/itlackey/akm/blob/main/docs/guides/stash-makers.md) -- Build and share a stash on GitHub, npm, or a network directory
- [Wikis](https://github.com/itlackey/akm/blob/main/docs/guides/wikis.md) -- Multi-wiki knowledge bases (Karpathy-style)
- [Local Development](https://github.com/itlackey/akm/blob/main/docs/guides/local-development.md) -- Dogfooding akm while editing its own source
- [Claude Code workflows vs. akm workflows](https://github.com/itlackey/akm/blob/main/docs/guides/claude-code-vs-akm-workflows.md) -- Comparing the two things that share a name
- Command tours: [search & discovery](https://github.com/itlackey/akm/blob/main/docs/guides/search-discovery.md), [sources & registries](https://github.com/itlackey/akm/blob/main/docs/guides/sources-registries.md), [knowledge management](https://github.com/itlackey/akm/blob/main/docs/guides/knowledge-management.md), [the improvement loop](https://github.com/itlackey/akm/blob/main/docs/guides/improvement-loop.md), [agent integration](https://github.com/itlackey/akm/blob/main/docs/guides/agent-integration.md)

## [Reference](reference/README.md)

- [Bundle Types](reference/bundle-types.md) -- Every bundle format akm recognizes: detection, refs, indexing, validation, read/write
- [CLI](reference/cli.md) -- All `akm` commands and flags
- [Configuration](reference/configuration.md) -- Engines, strategies, bundles, and settings
- [Workflows](reference/workflows.md) -- Unified Markdown workflow schema, run state, and native orchestration engine
- [Wiki Snapshot Fetchers](https://github.com/itlackey/akm/blob/main/docs/reference/wiki-snapshot-fetchers.md) -- The pluggable fetcher API for URL-based knowledge reads
- [Registry](https://github.com/itlackey/akm/blob/main/docs/reference/registry.md) -- Registries, search, hosting, and managing sources
- [Data & Telemetry](reference/data-and-telemetry.md) -- Exactly what akm reads and writes on your machine (no remote telemetry)
- [akm-eval](https://github.com/itlackey/akm/blob/main/docs/reference/akm-eval.md) -- Standalone toolkit for measuring whether `akm improve` is working
- [Roadmap](https://github.com/itlackey/akm/blob/main/docs/reference/roadmap.md) -- High-level focus for the 0.9 and 1.0 releases

## [Agents](https://github.com/itlackey/akm/blob/main/docs/agents/README.md)

- `akm help agents` (short guide by default; `akm help agents --full` for the complete guide) -- The CLI reference agents load to use akm; always the embedded corpus at `src/assets/hints/cli-hints-{full,short}.md`
- [Agent Install Guide](https://github.com/itlackey/akm/blob/main/docs/agents/agent-install.md) -- Step-by-step automated install for agents
- [Curate Workmap](https://github.com/itlackey/akm/blob/main/docs/agents/curate-workmap.md) -- Read before changing `akm curate` ranking or output

## [Architecture](https://github.com/itlackey/akm/blob/main/docs/architecture/README.md)

System overview, normative specs, decision history, and subsystem internals.

- [Architecture](https://github.com/itlackey/akm/blob/main/docs/architecture/architecture.md) -- How akm's bundles, cache, index, and registries fit together
- [Core Principles](https://github.com/itlackey/akm/blob/main/docs/architecture/akm-core-principles.md) -- Design principles and constraints
- [Specs](https://github.com/itlackey/akm/blob/main/docs/architecture/README.md#specs-specs) -- Normative specifications (bundle/adapter model, ref grammar, stash conventions)
- [Internals](https://github.com/itlackey/akm/blob/main/docs/architecture/README.md#internals-internals) -- Current-truth subsystem references (storage, search, indexing, improve, health)
- [Testing](https://github.com/itlackey/akm/blob/main/docs/architecture/README.md#testing-testing) -- Testing workflow and pre-release checklist

## [Migration](migration/README.md)

- [v0.8 -> v0.9 migration guide](migration/v0.8-to-v0.9.md) -- Current-cycle breaking changes
- [Release notes](migration/release-notes/) -- The short per-release notes `akm help migrate <version>` prints

## [Posts](https://github.com/itlackey/akm/blob/main/docs/posts/README.md)

Source articles for the dev.to publishing pipeline (historical record).

## Official Ecosystem Repositories

- [itlackey/akm-stash](https://github.com/itlackey/akm-stash) -- the official onboarding stash with ready-made assets you can install with `akm bundle add`
- [itlackey/akm-registry](https://github.com/itlackey/akm-registry) -- the official registry index that powers built-in discovery
- [itlackey/akm-plugins](https://github.com/itlackey/akm-plugins) -- optional integrations for tools like OpenCode
- [itlackey/akm-bench](https://github.com/itlackey/akm-bench) -- the standalone benchmark and evaluation repo for akm

---

New docs, in five lines: keep one current-truth doc per subsystem, don't fork a
second one. Planning, review, and analysis material lives in the untracked
`.plans/` directory, never under `docs/` -- promote conclusions into the
current-truth doc or drop them. Normative specs live in
`docs/architecture/specs/`. Cite code by symbol and memories by search-terms --
not line numbers or exact refs, both rot. Nothing in `docs/` may reference
`.plans/`.
