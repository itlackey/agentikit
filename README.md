# akm — Agent Knowledge Manager

[![npm version](https://img.shields.io/npm/v/akm-cli)](https://www.npmjs.com/package/akm-cli)
[![CI](https://github.com/itlackey/akm/actions/workflows/ci.yml/badge.svg)](https://github.com/itlackey/akm/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/akm-cli)](LICENSE)

**A knowledge toolkit for AI agents** — capture, curate, search, and share scripts, skills, commands, agents, knowledge, instructions, memories, workflows, env files, secrets, lessons, tasks, sessions, and facts — working with any AI coding assistant that can run shell commands.

akm gives agents a curated, searchable library built from local directories, GitHub repos, npm packages, and websites. Instead of front-loading a giant prompt, agents pull exactly what they need, when they need it, and feed results back so the library improves over time.

## What akm does

- **Manage sources** — add local dirs, git repos, npm packages, and websites as searchable asset sources [(details)](docs/guides/sources-registries.md)
  ```sh
  akm bundle add github:owner/repo         # GitHub
  akm bundle add https://docs.example.com  # crawled website
  ```
- **Search a unified index** — one FTS5 index across all your sources [(details)](docs/guides/search-discovery.md)
  ```sh
  akm search "deploy" --type script --limit 5
  ```
- **Curate a shortlist** — get the best-match assets for a task without knowing exact names [(details)](docs/guides/search-discovery.md)
  ```sh
  akm curate "set up a kubernetes deployment"
  ```
- **Load assets on demand** — show the full content of any asset by ref [(details)](docs/guides/search-discovery.md)
  ```sh
  akm show workflows/ship-release
  ```
- **Capture local knowledge** — save discoveries as memories or imported docs [(details)](docs/guides/knowledge-management.md)
  ```sh
  akm remember "Staging deploys require VPN"
  akm import ./notes/runbook.md
  ```
- **Run structured workflows** — execute and verify resumable multi-step procedures [(details)](docs/reference/workflows.md)
  ```sh
  akm workflow run workflows/onboarding
  ```
- **Improve continuously** — feedback drives proposals; proposals drive asset quality [(details)](docs/guides/improvement-loop.md)
  ```sh
  akm feedback skills/code-review --positive
  akm improve && akm proposal list
  ```


## Install

**Option 1 — npm package (recommended; requires [Node.js](https://nodejs.org) >= 22):**

```sh
npm install -g akm-cli
```

**Option 2 — Prebuilt binary (no runtime required):**

```sh
# Linux / macOS
curl -fsSL https://github.com/itlackey/akm/releases/latest/download/install.sh | bash

# Windows (PowerShell)
irm https://github.com/itlackey/akm/releases/latest/download/install.ps1 | iex
```

Upgrade in place: `akm upgrade`

The npm package always uses Node.js to bootstrap its cross-platform command.
If a working [Bun](https://bun.sh) >= 1.0 is also on `PATH`, the launcher
prefers Bun for execution; old, unusable, or absent Bun installations fall back
to Node.js. Node.js remains required for the npm package. The standalone
binaries are runtime-free.

## Quick start

```sh
akm setup                             # guided first-time setup
akm task doctor                       # verify scheduler and installed runtime
akm bundle add github:itlackey/akm-stash     # install the official onboarding bundle
akm index                             # build the search index
akm curate "deploy"                   # get a curated shortlist
akm show workflows/deploy             # load the best match
akm remember "Deployment needs VPN"  # capture a memory
akm feedback workflows/deploy --positive
```

For non-interactive setup: `akm setup --yes` (or `--dir ~/custom-bundle` for a custom path).
Non-interactive setup never activates schedules.

See [docs/guides/getting-started.md](docs/guides/getting-started.md) for a full walkthrough.

## Bundle types

akm doesn't only manage its own asset library — it recognizes and indexes
several existing directory layouts in place, each through its own **adapter**:

| Format | What it is | Read/write (0.9.0) |
| --- | --- | --- |
| `akm` | akm's own typed workspace — scripts, skills, commands, agents, knowledge, instructions, env, secrets, workflows, lessons, memories, tasks, sessions, facts | Writable |
| `okf` | Open Knowledge Format — plain markdown, type read from frontmatter | Read-only |
| `llm-wiki` | Karpathy-style LLM wiki (`schema.md` + `raw/` + `pages/`) | Read-only |
| `claude` | A Claude Code `.claude` tool directory (`CLAUDE.md`, `commands/`, `agents/`, `skills/`) | Read-only |
| `opencode` | An OpenCode `.opencode` tool directory (`AGENTS.md`, `commands/`, `agents/`, `skills/`) | Read-only |
| `agent-skills` | A standalone collection of Agent Skills packages (`<name>/SKILL.md`) | Read-only |
| `dotenv` | An env/secrets-only bundle | Writable (env/secret commands only) |
| `akm-workflow` | A standalone workflow bundle | Writable (`akm workflow create` only) |
| `akm-task` | A standalone scheduled-task bundle | Read-only |
| `website-snapshot` | A crawled website snapshot | Read-only |
| `generic-files` | Catch-all fallback, classified by extension (explicit opt-in only) | Read-only |

Most formats are recognized automatically the moment you `akm bundle add`
their directory. "Read-only" means AKM's write commands (`akm remember`,
`akm import`, proposal-accept, …) can't create or edit items there in
0.9.0 — search, show, and `akm lint` all work normally regardless.

See [Bundle Types](docs/reference/bundle-types.md) for detection rules, ref
shapes, what's indexed, validation, and the full read/write picture for
every format — including the fourteen asset types akm's own native format
recognizes. See [Concepts](docs/guides/concepts.md) for the ref format,
sources vs. bundles, and classification rules.

## Key workflows

**Add and search a bundle**
```sh
akm bundle add github:owner/team-bundle
akm index
akm search "database migration" --type script
akm show scripts/migrate.sh
```

**Capture and route knowledge**
```sh
akm remember "Hot-fix deploys skip staging" --bundle team-bundle
akm import ./incident-report.md
```

**Use a living wiki (Karpathy LLM wiki pattern)**
```sh
akm bundle add github:team/research-wiki          # install an LLM-wiki bundle (schema.md + pages/ + raw/)
akm search "attention"                     # its pages are indexed like any other content
akm show research-wiki//pages/attention    # read a page by bundle//conceptId ref
```

akm supports [Andrej Karpathy's LLM wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern as a first-class **bundle format**: raw sources live in `raw/` (immutable), the agent writes synthesized pages under `pages/`, and a `schema.md` rulebook keeps the voice and structure consistent across sessions. A bundle whose root holds `schema.md` plus `pages/` is recognized automatically at install time; there is no separate wiki command family — your agent does the writing, akm indexes the result. See [docs/guides/wikis.md](docs/guides/wikis.md).

**Improvement loop**
```sh
akm feedback skills/planner --negative --reason "Doesn't account for merge conflicts"
akm improve                   # generate proposals from feedback + history
akm proposal list             # review pending proposals
akm proposal accept <uuid-or-ref>   # apply a proposal
akm proposal reject <uuid-or-ref>   # discard it
```

**Clone and customize an asset**
```sh
akm clone workflows/ship-release --dest ./project/.claude
# edit the local copy — it wins in subsequent searches automatically
```

**Schedule tasks safely**
```sh
akm setup                 # review definitions, schedules, and enabled state
# Confirm scheduler activation only after reviewing the complete task summary.
akm task doctor           # verify backend, runtime, task state, and warnings
```

Setup shows the complete task review — both the general-purpose core
templates and the maintainer-oriented improve cadence — before asking one
explicit question about changing task files and the OS scheduler. Only
confirmation prepares the definitions and syncs the scheduler. Declining, or
running setup non-interactively, leaves both unchanged. A scheduled entry
captures the installed akm runtime used during activation. Ordinary
`akm task sync` preserves that runtime; after moving or replacing the
installation, use `akm task sync --rebind` explicitly to migrate or repair
scheduler entries, then run `akm task doctor` again.

Rerunning setup preserves existing scheduler bindings. If setup changes the AKM
storage path, or the installed runtime path changes, run
`akm task sync --rebind` explicitly.

## The improvement loop

akm tracks which assets agents actually use (`select` events) and what agents think of them (`akm feedback`). Running `akm improve` processes that signal to generate proposals — suggested edits, promotions, or deprecations. Review with `akm proposal list`, then `akm proposal accept` or `akm proposal reject`. Accepted changes write back to your writable sources. Distilled lessons surface automatically as part of `akm improve` (via the `distill` process in the active strategy).

## Tell your agent about akm

Add this to your `AGENTS.md`, `CLAUDE.md`, or system prompt:

```markdown
## Resources & Capabilities

You have access to a searchable library of scripts, skills, commands, agents,
knowledge, instructions, workflows, env files, secrets, lessons, tasks,
sessions, facts, and memories via the `akm` CLI. Use `akm -h` for details.
```

No plugins or SDKs required. Platform-specific integrations are available in [akm-plugins](https://github.com/itlackey/akm-plugins).

## Ecosystem

| Repo | What it is |
| --- | --- |
| [itlackey/akm-stash](https://github.com/itlackey/akm-stash) | Official bundle — ready-made skills, workflows, commands, and knowledge |
| [itlackey/akm-plugins](https://github.com/itlackey/akm-plugins) | Optional editor and agent integrations (OpenCode, etc.) |
| [itlackey/akm-registry](https://github.com/itlackey/akm-registry) | Official registry index — pre-configured in every akm install |
| [itlackey/akm-bench](https://github.com/itlackey/akm-bench) | Benchmark harness for measuring agent performance with akm |
| [itlackey/akm-eval](https://github.com/itlackey/akm-eval) | Eval framework and tools for akm asset quality |

## Documentation

### Features

| Feature | Description |
| --- | --- |
| [Search & Discovery](docs/guides/search-discovery.md) | Build the index, search, curate a shortlist, and load assets by ref |
| [Knowledge Management](docs/guides/knowledge-management.md) | Capture memories, import docs, manage wikis, and store protected env/secret assets |
| [Sources & Registries](docs/guides/sources-registries.md) | Connect local dirs, git repos, npm packages, and websites; browse the registry |
| [Workflows](docs/reference/workflows.md) | Structured multi-step procedures with resumable run state |
| [The Improvement Loop](docs/guides/improvement-loop.md) | Feedback, history, proposals, and automated asset improvement |
| [Agent Integration](docs/guides/agent-integration.md) | Wire akm into Claude Code, OpenCode, Cursor, and other coding assistants |

### Reference docs

| Doc | Description |
| --- | --- |
| [Getting Started](docs/guides/getting-started.md) | Install, first-time setup, add sources, search, show |
| [Concepts](docs/guides/concepts.md) | Sources, registries, asset types, refs, and the bundle |
| [Bundle Types](docs/reference/bundle-types.md) | Every bundle format akm recognizes: detection, refs, indexing, validation, read/write |
| [CLI Reference](docs/reference/cli.md) | All commands and flags |
| [Configuration](docs/reference/configuration.md) | Settings, providers, embedding, and Ollama setup |
| [Bundle Maker's Guide](docs/guides/stash-makers.md) | Build, publish, and share your own bundles |
| [Registry](docs/reference/registry.md) | Registries, the index format, and private registry setup |
| [Wikis](docs/guides/wikis.md) | Multi-wiki knowledge bases |
| [Release Notes — 0.9.0](docs/migration/release-notes/0.9.0.md) | Latest release notes and migration guide |
| [Stability policy](STABILITY.md) | Which CLI surfaces are stable, evolving, or experimental |
| [Security policy](SECURITY.md) | Threat model and how to report vulnerabilities |
| [Changelog](CHANGELOG.md) | Per-release behavior changes |

## Privacy & data

AKM stores data locally and has **no remote telemetry**. Events, proposals, and improve history are written to `~/.local/share/akm/state.db`. Registry packages and config backups go to `~/.cache/akm/`. Nothing leaves your machine except requests to sources you explicitly configure (GitHub, npm, your own LLM endpoint).

Running on a network filesystem (NFS/SMB), where SQLite's WAL mode is unsupported? Set `AKM_SQLITE_JOURNAL_MODE` (`WAL` default, or `DELETE` / `TRUNCATE`) to pick the journal mode applied at every db open. At the `WAL` default AKM auto-detects a network mount and falls back to `DELETE`. See [docs/reference/configuration.md](docs/reference/configuration.md) for details.

See [docs/reference/data-and-telemetry.md](docs/reference/data-and-telemetry.md) for the complete on-disk inventory, event type reference, and instructions for inspecting or clearing local data.

## License

[MPL-2.0](LICENSE)
