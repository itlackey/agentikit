# Defensive-guard audit

Repo-wide sweep of machinery that makes akm refuse to do its job. Six
read-only auditors over `src/**` (662 files), one bar:

> A guard survives only if removing it could cause **data loss, data
> corruption, or an unrecoverable state.**

Backups, atomic writes, write-path validation, path containment, and
lock/lease machinery clear that bar and were left alone; each auditor
returned an explicit keep-list. Everything below did not clear it.

House rule this restates: AGENTS.md § *Defensive Code* — **remove the limit >
degrade with a warning > abort** — and § *Reading persisted data*.

Two findings were fixed before this document was written and are not listed:
the state.db newer-ledger refusal and `akm agent --prompt` template validation.

---

## Tier 1 — destroys data, or bricks every command

| # | Site | What it does |
|---|---|---|
| 1 | `commands/proposal/validators/proposals.ts:107,116` | `proposal accept` silently deletes every body line matching `description:`/`when_to_use:` and every `---` in a body with frontmatter. A knowledge asset documenting frontmatter is corrupted on accept, and the original bytes are overwritten in the DB. No warning. |
| 2 | `workflows/resource-limits.ts:208` | A step artifact over 1 MiB is replaced by a tombstone. The run looks fine, then resume fails permanently: *"cannot be recovered. Start a new run."* Every prior LLM step must be re-paid. |
| 3 | `core/config/config-schema.ts:152-193` | A 0.8-era config (`stashDir`/`sources`/`installed`) fails config load, so every command exits 78. **No migrator exists** — `akm migrate apply` does not fix it. |
| 4 | `core/config/schema/primitives.ts:44-59` | `endpoint` rejects any URL with a query string, so **Azure OpenAI cannot be configured at all** (`?api-version=` is mandatory). Whole config fails to load. |
| 5 | `core/config/config.ts:234-240` | Legacy `extraParams` fails config load. AGENTS.md cites this exact guard as already fixed to warn-and-lift; the refusal was reintroduced. |
| 6 | `core/config/schema/engines.ts:85` | A literal `apiKey` in config fails config load — the most common thing anyone hand-edits. |
| 7 | `core/config/schema/sources-bundles.ts:66` | A registry URL with credentials fails config load. The warn-and-ignore path (`formatRegistryCredentialWarning`) already exists and is unreachable from config load. |
| 8 | `sources/snapshot-fetchers/host-guard.ts:60,82` | Any non-public website host is refused with **no escape hatch**: `localhost:8000` docs, a corp wiki, or a public hostname that VPN/split-horizon DNS resolves to a private IP. |
| 9 | `commands/env/secret-cli.ts:190` | `secret run <ref> GIT_SSH_COMMAND` — the canonical use — is refused with **no flag, no env var, no recovery**. The sibling `env run` already does the correct first-party/third-party warn/block split. |
| 10 | `commands/sources/self-update.ts:413` | One interrupted upgrade leaves `akm.bak`, and **every future `akm upgrade` refuses forever**. The message names no remedy and the file is usually root-owned. |
| 11 | `tasks/schedule.ts:198` | `0 9 * * 1-5` — weekdays at 9am — is rejected on the cron backend, which passes the expression through verbatim and would accept it. |
| 12 | `storage/repositories/index-schema.ts:181` | An index.db from another akm version is wiped **silently** (zero `warn()` in the file). Two versions sharing a data dir re-walk, re-embed and re-run LLM enrichment on every alternating invocation. |

## Tier 2 — blocks legitimate work, recovery exists but is poor

Selected; full detail in the per-area reports.

- `commands/tasks/tasks.ts:1262` — `task add`/`sync` refuse on any install akm cannot prove it owns: `bun install -g`, pnpm, yarn, Volta, asdf. `--rebind` exists purely because the default refuses too much.
- `setup/setup.ts:100` — `akm setup --dir $(mktemp -d)` is refused on **every macOS machine** (`mktemp -d` returns `/var/folders/…`). Remedy is an undocumented env var.
- `commands/proposal/repository.ts:2243` — `proposal accept` blocks on prose heuristics ("looks like a section heading", "unbalanced backticks"). There is no `proposal edit` and no `--force`: the remedy is unreachable.
- `commands/command/portable-template.ts:24-28` — `$NAME`, `$(`, `${`, `$N`, `@file` reject prose in stored command files and inline workflow commands. `"Budget is $5 per run"` fails.
- `workflows/source-ir/semantics.ts:44` — `run: |` multiline, `&&`, and pipes are rejected in `.yml` workflows, while `exec: ["sh","-c", <same bytes>]` passes. Blocks nothing.
- `workflows/freeze/resolve-steps.ts:71` — akm's own `workflow create` template ships a `### gate`, so `workflow run` on a default install fails for want of `workflow.judgeEngine`.
- `commands/improve/preparation.ts:295` — `minPoolSize: 500` means `akm improve --strategy consolidate`, typed by a human, silently does nothing on almost every install.
- `commands/improve/improve-strategies.ts:181` — one agent-only engine aborts the entire improve run instead of disabling the processes that need an LLM.
- `indexer/search/search-fields.ts:19` — `SEARCH_TEXT_MAX_CHARS = 8192` silently truncates what is both FTS content and embedding input, so long documents are unfindable. The sibling token cap was deleted for exactly this reason.
- `core/json-schema.ts:69` — a 100k-node budget invalidates a large but valid structured output, after the LLM call is paid for.
- `core/write-source.ts:1123` — writing to a git bundle is refused while it has unpushed commits or is behind. No CLI flag.
- `tasks/prepare/script-capture.ts:50` — `.js` task scripts are refused under the Node launcher, which is the install akm itself calls eligible.
- `llm/index-passes.ts:63` — one misconfigured enrichment engine aborts the whole `akm index`, so FTS and embeddings never run.
- `integrations/agent/model-map.ts:325` — a symlinked `~/.config/akm/models.json` (stow, chezmoi, yadm) breaks every model resolution.
- `output/shapes.ts:88` — `--shape summary` is a hard error on every command but `show`, though `--shape` is documented as global and `--format` on an exempt command only warns.

## Recurring shapes

1. **Config-load refusals.** Six separate schema rejections take down every
   command for one bad line. A bad value should warn and be ignored or
   transformed, never fail the load.
2. **Free text validated as code.** Prompts, command bodies, task `run:`, and
   descriptions are parsed for constructs akm never expands.
3. **Version skew treated as corruption.** state.db, index.db, task-history
   metadata and workflow spines all assume one akm per data directory.
4. **Symlinks refused on read paths.** Meta docs, task sources, clone parents,
   `akm.include`, models.json. Dotfile-managed setups are broken throughout;
   containment checks on the resolved path already cover the real hazard.
5. **A second gate on an explicitly typed command.** `--force` that refuses to
   force, `--rebind`, `accept`, `secret run`.
6. **The degraded path already exists and is unreachable.** Findings 7, 12 and
   several others have a written warn-path the refusing caller does not use.
