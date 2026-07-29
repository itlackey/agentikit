# akm CLI — Full Reference

You have access to a searchable library of scripts, skills, commands, agents, knowledge documents, workflows, env files, secrets, lessons, and memories via `akm`. Search your sources first before writing something from scratch.

## Search

```sh
akm search "<query>"                          # Search all sources
akm curate "<task>"                          # Curate the best matches for a task
akm search "<query>" --type workflow          # Filter by asset type
akm search "<query>" --source both            # Also search registries
akm search "<query>" --source registry        # Search registries only
akm search "<query>" --limit 10               # Limit results
akm search "<query>" --detail full            # Include scores, paths, timing
akm search "memories/projectA/"               # Enumerate a subtree (conceptId prefix; trailing slash required)
akm search "knowledge/"                       # List every knowledge item
akm search "team-catalog//"                   # List every item in one bundle
```

| Flag | Values | Default |
| --- | --- | --- |
| `--type` | free-form. Built-ins: `skill`, `command`, `agent`, `knowledge`, `workflow`, `script`, `memory`, `lesson`, `task`, `session`, `fact`, `env`, `secret`, `instruction` — plus any adapter-defined type (`website`, `wiki-source`, a wiki `pageKind`). Exact match; an unknown type returns no hits. | `any` |
| `--source` | `stash`, `registry`, `both`, or a configured bundle name | `stash` |
| `--limit` | number | `20` |
| `--format` | `json`, `jsonl`, `text`, `yaml`, `md`, `html` | `json` |
| `--detail` | `brief`, `normal`, `full` | `brief` |
| `--shape` | `human`, `agent`, `summary` (`summary` only on `show`) | `human` |

Ref-prefix queries (a conceptId prefix ending in `/`, optionally bundle-qualified)
return a deterministic listing, not a relevance ranking. Drop the trailing slash
and the same text becomes an ordinary keyword search — resolving a single asset
by its `<subdir>/<name>` id is `akm show`'s job. Because prefixes match
conceptIds, you can paste a ref prefix straight from search output back into a
query.

## Curate

Combine search + follow-up hints into a dense summary for a task or prompt.

```sh
akm curate "plan a release"                   # Pick top matches across asset types
akm curate "deploy a Bun app" --limit 3       # Keep the summary shorter
akm curate "review architecture" --type workflow # Restrict to one asset type
```

## Show

Display an asset by ref. On a markdown document `#fragment` selects one section by heading slug.

```sh
akm show scripts/deploy.sh                    # Show script (returns run command)
akm show skills/code-review                   # Show skill (returns full content)
akm show commands/release                     # Show command (returns template)
akm show agents/architect                     # Show agent (returns system prompt)
akm show workflows/ship-release               # Show parsed workflow steps
akm show knowledge/guide                      # Whole document
akm show knowledge/guide#auth                 # Just the "Auth" section
akm show knowledge/guide#nope                 # Lists the available fragment slugs
akm show knowledge/my-doc                     # Show content (local or remote)
```

| Type | Key fields returned |
| --- | --- |
| script | `run`, `setup`, `cwd` |
| skill | `content` (full SKILL.md) |
| command | `template`, `description`, `parameters` |
| agent | `prompt`, `description`, `modelHint`, `toolPolicy` |
| knowledge | `content` (whole document, or one section via `#fragment`) |
| workflow | `workflowTitle`, `workflowParameters`, `steps` |
| memory | `content` (recalled context) |
| env | `keys` (key names only — values and comment text never returned) |
| secret | `name` only (the whole file is the value — never returned) |
| lesson | `content` plus `action` (rendered from the `when_to_use` frontmatter) — read both before applying the lesson |

## Capture Knowledge While You Work

```sh
akm remember "Deployment needs VPN access"     # Record a memory in your stash
akm remember --name release-retro < notes.md   # Save multiline memory from stdin
akm remember "note" --target my-other-stash    # Route write to a named writable stash source
akm remember "note" --xref knowledge/auth-flow # Cite provenance in frontmatter xrefs (repeatable; ref must resolve)
akm remember "fix" --supersedes memories/old-note # Write a correction AND demote the old asset (beliefState: superseded)
akm import ./docs/auth-flow.md                 # Import a file as knowledge
akm import ./doc.md --xref knowledge/auth-flow # Merge provenance xrefs into the imported doc's frontmatter
akm import ./new.md --supersedes knowledge/old # Import a correction AND demote the doc it replaces
akm import - --name scratch-notes < notes.md   # Import stdin as a knowledge doc
akm import https://example.com/docs/auth       # Fetch one URL and import it as knowledge
akm import ./doc.md --target my-other-stash    # Route import to a named writable stash source
akm workflow create ship-release               # Create a workflow asset in the stash
akm workflow validate workflows/foo.yaml       # Validate a YAML v2/markdown workflow or ref; lists every error
akm workflow next workflows/ship-release       # Start or resume the next workflow step
akm feedback skills/code-review --positive     # Record that an asset helped
akm feedback agents/reviewer --negative        # Record that an asset missed the mark
akm feedback memories/deployment-notes --positive # Works for memories too
akm feedback env/prod --positive               # Records env feedback without surfacing values
```

Use `akm feedback` whenever an asset materially helps or fails so future search
ranking can learn from actual usage.

## LLM Wiki bundles

An LLM Wiki (Karpathy-style knowledge base) is a **bundle format**, not an akm
asset type — there is no `akm wiki` command family. akm's LLM Wiki adapter
recognizes one deterministically at install time: a bundle component whose root
holds a `schema.md` plus a `pages/` directory is mounted as an `llm-wiki`
component. Its pages are then indexed like any other content and resolve to
`bundle//conceptId` refs (e.g. `team-catalog//pages/attention`).

Install one as a source, then search and read its pages with the ordinary
commands — no wiki-specific verbs:

```sh
akm add owner/llm-wiki-repo                    # Install an LLM Wiki bundle as a source (npm, GitHub, git, or local dir)
akm search "attention"                         # Wiki pages surface in ordinary search results
akm show team-catalog//pages/attention          # Read a page by its bundle//conceptId ref (copy the ref from search)
akm list                                       # Confirm the bundle is installed
```

Files under the bundle's `raw/` directory and the wiki infrastructure files
`schema.md`, `index.md`, and `log.md` are not indexed and do not appear in
search results. No `--llm` anywhere — akm never reasons about page content.

## Env files

A group of related CONFIGURATION for an app/service in one `.env` file at
`<stash>/env/<name>.env`, sourced/injected wholesale. Key names are
discoverable; values and comment text stay on disk and never reach stdout or
the index (comments can contain commented-out credentials). akm does not edit
entries — you edit the file with your own editor and akm loads it.

```sh
akm env create prod                           # Create an empty env file
akm env create prod --from-file ./.env        # Ingest an existing .env
akm env list                                  # List all env files across stashes with key names
akm show env/prod                             # Inspect key names (never values or comments)
akm env run env/prod -- ./deploy.sh           # Run a command with the whole .env injected (the safe path)
akm env run env/prod -- $SHELL                # Open an interactive shell with values injected
akm env export env/prod --out ./env.sh        # Write a sourceable script to a file (mode 0600)
akm env path env/prod --quiet                 # Print the raw file path (for Docker `_FILE` / `--env-file`)
akm env remove env/prod                       # Delete the env file
```

## Secrets

A single sensitive value used on its own for authentication (a token, key, or
cert) — one file = one value at `<stash>/secrets/<name>`. The ENTIRE file is
the value; only the name is ever surfaced.

```sh
printf '%s' "$TOKEN" | akm secret set secrets/deploy-token  # Store a single value
akm secret list                                             # List secrets (names only)
akm secret run secrets/deploy-token GITHUB_TOKEN -- gh release create v1.0.0  # Inject into one env var
```

## Workflows

Workflows live under `<stash>/workflows/` as markdown or YAML v2 (`.yaml`/`.yml`).

Ref-based workflow commands are scoped to the current project/worktree/directory,
so one active run does not block unrelated directories from starting the same
workflow. Direct run-id commands still target the exact run.

```sh
akm workflow template                         # Print a starter workflow template
akm workflow create ship-release             # Scaffold a new workflow asset
akm workflow start workflows/ship-release    # Start a new run in the current scope
akm workflow next workflows/ship-release     # Advance to the next step (or auto-start) in the current scope
akm workflow complete <run-id>               # Mark a step complete and advance
akm workflow status <run-id>                 # Show the exact run by id
akm workflow resume <run-id>                 # Resume a blocked or failed run
akm workflow list                            # List workflow runs in the current scope
```

## Clone

Copy an asset to the working stash or a custom destination for editing.

```sh
akm clone <ref>                               # Clone to working stash
akm clone <ref> --name new-name               # Rename on clone
akm clone <ref> --dest ./project/.claude       # Clone to custom location
akm clone <ref> --force                       # Overwrite existing
akm clone "npm:@scope/pkg//scripts/deploy.sh" # Clone from remote package
```

When `--dest` is provided, `akm init` is not required first.

## Move / Rename

**A rename is delete plus create**: the new path is a new identity, so the
destination starts with fresh learned state (utility, salience, usage history)
and inbound refs to the old path dangle. Prefer NOT renaming — a ref is chosen
once. When a rename is unavoidable:

```sh
mv ~/akm/memories/projectA/old-note.md ~/akm/memories/projectA/new-note.md
# update any intentional refs (fully qualified: bundle//memories/projectA/old-note)
akm index
akm lint                                             # confirms nothing dangles
```

A memory's `.derived.md` twin must move with its base. Moving an item between
bundles is `akm clone` (or a copy) followed by deleting the source — both the
bundle and the concept identity change.

(`akm mv` ships, but it is **Experimental**: its ref rewrite is a
boundary-delimited text match, not ref-aware. It rewrites both the bare
conceptId and its `bundle//`-qualified form wherever either appears — but it
cannot tell a real ref from a coincidental mention of the same words in
ordinary prose, so it can rewrite text that was never meant as a ref. Use the
procedure above if you need finer control.)

## Sync

Commit local changes in a git-backed stash. Behaviour adapts automatically.
(`akm save` was the pre-0.8 spelling; it was removed in 0.9.0 — use `akm sync`.)

- **No `.git` directory** — no-op (silent skip)
- **Git repo, no remote** — stage and commit only (the default stash always falls here)
- **Git repo, has remote, not writable** — stage and commit only
- **Git repo, has remote, `writable: true`** — stage, commit, and push
- **Any writable repo with `--no-push`** — stage and commit only

```sh
akm sync                                      # Sync primary stash (timestamp message)
akm sync -m "Add deploy skill"               # Sync with explicit message
akm sync --no-push                            # Commit only; never push
akm sync my-skills                            # Sync a named writable git stash
akm sync my-skills -m "Update patterns"      # Sync named stash with message
```

`akm improve` also performs an end-of-run batch commit for git-backed stashes.
The `--sync` / `--no-sync` and `--push` / `--no-push` flags control this:

```sh
akm improve                                   # auto-sync per strategy default (default/thorough: on; quick/memory-focus: off)
akm improve --no-sync                         # skip the end-of-run commit
akm improve --no-push                         # commit but skip push for this run
akm improve --sync                            # force sync even on strategies that disable it
```

Strategy sync defaults: `default` and `thorough` auto-commit + push; `quick` and
`memory-focus` skip sync entirely. Override with `--sync` / `--no-sync` flags.

The `--writable` flag on `akm add` opts a remote git stash into push-on-sync:

```sh
akm add git@github.com:org/skills.git --provider git --name my-skills --writable
```

## Add & Manage Sources

```sh
akm add <ref>                                 # Add a source
akm add @scope/stash                            # From npm (managed)
akm add owner/repo                            # From GitHub (managed)
akm add ./path/to/local/stash                   # Local directory
akm add git@github.com:org/repo.git --provider git --name my-skills --writable
akm registry add https://skills.sh --name skills.sh --provider skills-sh  # Add the skills.sh registry
akm registry remove skills.sh                 # Remove the skills.sh registry
akm list                                      # List all sources
akm list --kind managed                       # List managed sources only
akm remove <target>                           # Remove by id, ref, path, or name
akm update --all                              # Update all managed sources
akm update <target> --force                   # Force re-download
```

## Registries

```sh
akm registry list                             # List configured registries
akm registry add <url>                        # Add a registry
akm registry add <url> --name my-team         # Add with label
akm registry add <url> --provider skills-sh   # Specify provider type
akm registry remove <url-or-name>             # Remove a registry
akm registry search "<query>"                 # Search all registries
akm registry search "<query>" --assets        # Include asset-level results
```

## Configuration

```sh
akm config list                               # Show current config
akm config get <key>                          # Read a value
akm config set <key> <value>                  # Set a value
akm config unset <key>                        # Remove a key
akm config path --all                         # Show all config paths
```

## Other Commands

```sh
akm init                                      # Initialize working stash (scaffold only)
akm setup                                     # Interactive wizard: stash + LLM/embedding + agent + registry config
akm setup --dir ~/custom-stash                # Run the wizard against a custom stash path
akm setup --yes                               # Non-interactive, accepts all defaults
akm index                                     # Rebuild search index (metadata enrichment when configured)
akm index --full                              # Full reindex (metadata enrichment when configured)
akm list                                      # List all sources
akm lint                                      # Structural lint over the stash; exits 0 regardless of findings
akm lint --fix                                # Auto-fix Tier 1 issues
akm lint --fail-on-flagged                    # Exit non-zero when summary.flagged > 0 (CI-friendly)
akm upgrade                                   # Upgrade akm using its install method
akm upgrade --check                           # Check for updates
akm help migrate 0.6.0                        # Print migration notes for a release (or: latest)
akm hints                                     # Print this reference
akm completions                               # Print bash completion script
akm completions --install                     # Install completions
```

`akm init` only scaffolds the stash directory and registers it in config;
`akm setup` additionally walks through embedding/LLM connections, agent
profiles, sources, and registries. Use `setup` for first-time onboarding,
`init` when you just need a bare stash.

## Proposals & Improvement (0.8.0+)

```sh
akm improve <ref>                                       # Propose improvement for an asset
akm proposal list                                       # List pending proposals
akm proposal show <id>                                  # Render the proposal body
akm proposal diff <ref-or-id>                           # Diff by ref, UUID, or 8-char prefix
akm proposal diff skills/akm-dream                      # Diff by asset ref
akm proposal accept 7c115132                            # Accept by UUID prefix
akm proposal accept <id> --target team-stash            # Accept to a named writable stash source
akm proposal reject skills/my-skill --reason "not ready" # Reject by asset ref
akm proposal reject <id> --reason "..."                 # Archive with a reason
akm proposal revert <id>                                # Restore the pre-promotion content
```

The flat verbs `akm proposals` / `akm show proposal` / `akm accept` /
`akm reject` / `akm diff` / `akm revert` were removed in 0.9.0 — use the
`akm proposal <verb>` forms above.

Per-task `timeoutMs`: a task's `<stash>/tasks/<id>.yml` file (pure YAML) may
set `timeoutMs: null` to disable the agent kill timer for long-running
local-model tasks, or a number (milliseconds) to override
`config.agent.timeoutMs` for that task only.

## Output Control

Result-envelope commands accept `--format`, `--detail`, and `--shape` flags:

- `--format json` (default) — structured JSON
- `--format jsonl` — one JSON object per line (streaming-friendly)
- `--format text` — human-readable plain text
- `--format yaml` — YAML output
- `--format md` — Markdown output
- `--format html` — HTML output
- `--detail brief` (default) — compact output
- `--detail normal` — adds tags, refs, origins
- `--detail full` — includes scores, paths, timing, debug info
- `--shape human` (default) — standard projection
- `--shape agent` — agent-optimized output: strips non-actionable fields
- `--shape summary` — metadata only (no content/template/prompt), under 200 tokens; only valid on `akm show`

Run `akm -h` or `akm <command> -h` for per-command help.

### Piping JSON to jq

For any akm command emitting more than ~64KB of JSON, prefer
`akm <cmd> | cat | jq …` over the direct pipe. A known Bun stdout chunking
interaction with `jq 1.6` can truncate the stream mid-document on direct
pipes; `cat` re-buffers and presents a clean pipe to jq. `jq 1.7+` tolerates
the chunked writes without the workaround.

## Error Shapes and Exit Codes

Every command returns JSON by default. On success, the shape is command-specific.
On failure, every command emits:

```json
{"ok": false, "error": "<message>", "hint": "<optional remediation hint>"}
```

The `hint` field is present only when there is an actionable next step (a
suggested flag or alternate command).

Exit codes:

| Code | Meaning | Error class |
| --- | --- | --- |
| 0 | Success | — |
| 1 | Not found or command-reported failure | `NotFoundError`, command result |
| 2 | Usage / bad input | `UsageError` |
| 4 | Health warning (`akm health` only) | — |
| 70 | Internal / unclassified error | unexpected throw |
| 78 | Configuration error | `ConfigError` |

To detect failure reliably, check either:

- `ok === false` in the parsed JSON response, or
- a non-zero exit code (`$?` in shell, process exit code in SDK calls)

On result-envelope surfaces, both signals are always set consistently. The JSON
envelope is the preferred signal for agents parsing output programmatically;
the exit code is the preferred signal for shell scripts. Passthrough surfaces
below preserve the child's own streams and status instead.

`env run`, `secret run`, and `migrate` are process passthroughs and preserve
the spawned process's exact status. `tasks run` maps task status to 0 or 1 and
retains a command child's exact status in `result.detail.exitCode`. `agent`
maps a failed dispatch to 1 and retains the child status in its final result
envelope.

`akm lint` is the one command that does not follow the exit-code table above:
it exits **0 on every successful run regardless of findings**. Read
`summary.flagged` to detect issues, or pass `--fail-on-flagged` to opt into
the CI-friendly "exit 1 when findings exist" behavior:

```sh
akm lint | jq '.summary.flagged'              # always exit 0; read the count
akm lint --fail-on-flagged && deploy          # exit 1 if any flagged issues
```
