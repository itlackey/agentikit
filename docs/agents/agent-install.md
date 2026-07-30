# Agent Install Guide

Step-by-step instructions for automated installation and configuration of
`akm`. Designed for agents performing headless setup on behalf of a user.


## Quick Automation Script

The following sequence performs a complete headless setup with local
embeddings and no interactive prompts:

```sh
#!/usr/bin/env bash
set -euo pipefail

# 1. Install (standalone binary)
curl -fsSL https://github.com/itlackey/akm/releases/latest/download/install.sh | bash

# 2. Initialize stash and accept all defaults (no prompts)
akm setup --yes

# 3. Don't rely on the implicit semantic-search default in an unattended
#    script — the default can vary by release and by install path. Set it
#    explicitly so this script's behavior is deterministic. `auto` uses local
#    embeddings (downloaded on first index run); `off` skips them entirely.
akm config set semanticSearchMode auto

# 4. Add sources (adjust paths as needed)
# akm bundle add ~/.claude/skills

# 5. Build index (downloads embedding model on first run)
akm index

# 6. Verify
akm info
echo "akm setup complete"
```

To pre-configure a specific LLM endpoint at the same time, use `--config`:

```sh
#!/usr/bin/env bash
set -euo pipefail

# Install
curl -fsSL https://github.com/itlackey/akm/releases/latest/download/install.sh | bash

# Initialize and configure in one step (no prompts)
akm setup --config '{
  "engines": {
    "default": {
      "kind": "llm",
      "endpoint": "http://localhost:11434/v1/chat/completions",
      "model": "llama3.2"
    }
  },
  "defaults": { "llmEngine": "default" }
}'

akm index
akm info
echo "akm setup complete"
```

## 1. Install the Binary

Choose one method based on what runtime is available on the host. The npm
package requires Node.js >= 22; a working Bun >= 1.0 is optional and
preferred for execution only after Node starts the package launcher. Old,
unusable, or absent Bun installations fall back to Node.js. The standalone
binary is runtime-free.

```sh
# Option A: Standalone binary (runtime-free)
curl -fsSL https://github.com/itlackey/akm/releases/latest/download/install.sh | bash

# Option B: npm package (Node.js >= 22)
npm install -g akm-cli

# Option C: npx (Node.js >= 22, one-shot, no global install)
npx akm-cli <command>
```

Verify the install:

```sh
akm --version
```

## 2. Detect the Host Environment

Collect information to guide configuration decisions:

```sh
# Check available disk space (for model downloads)
df -h ~

# Check available memory
free -m || vm_stat   # Linux or macOS

# Confirm akm info output after init
akm info
```

## 3. Initialize the Working Stash

`akm setup` creates the stash directory, installs ripgrep, and optionally
configures AI connections. Three modes are available for automated use:

```sh
# Interactive wizard (default)
akm setup

# Non-interactive: accept all defaults, no prompts
akm setup --yes

# Non-interactive with a custom stash path
akm setup --yes --dir /path/to/stash

# Pre-configure with known settings (no prompts)
akm setup --config '{"engines":{"default":{"kind":"llm","endpoint":"http://localhost:11434/v1/chat/completions","model":"llama3.2"}},"defaults":{"llmEngine":"default"}}'

# Pre-configure LLM + agent connection in one step
akm setup --config '{
  "engines": {
    "default": {
      "kind": "llm",
      "endpoint": "https://api.openai.com/v1/chat/completions",
      "model": "gpt-4o-mini",
      "apiKey": "$OPENAI_API_KEY"
    },
    "opencode": { "kind": "agent", "platform": "opencode-sdk", "model": "gpt-4o", "llmEngine": "default" }
  },
  "defaults": { "llmEngine": "default", "engine": "opencode" }
}'

# Probe the configured endpoint after writing (verifies connectivity)
akm setup --config '{"engines":{"default":{"kind":"llm",...}}}' --probe
```

The `--config` flag accepts a JSON object using any top-level key the config
schema recognizes — generated from `src/core/config/config-schema.ts` into
[`schemas/akm-config.json`](../../schemas/akm-config.json), and validated
against directly (not a hand-copied list, so it can't silently fall out of
sync with the schema). As of this writing that's:

`archiveRetentionDays`, `bundles`, `configVersion`, `defaultBundle`,
`defaultWriteTarget`, `defaults`, `embedding`, `engines`, `experimental`,
`feedback`, `improve`, `index`, `modelAliases`, `output`, `registries`,
`search`, `semanticSearchMode`, `setup`, `workflow`.

Agent and LLM engines share `engines.*`; selections live under
`defaults.engine`, `defaults.llmEngine`, and `defaults.improveStrategy`.
`stashDir` and `sources` are pre-0.9 spellings — passing either fails loudly
(exit 78) with a message pointing at the standalone `akm-migrate` tool, rather
than being silently dropped. Use `bundles`/`defaultBundle` instead. Any other
unrecognized key is dropped with a warning, and the run still exits 0.

It **merges** with the existing config rather than replacing it, so
subsequent runs are safe to use in idempotent scripts.

Verify:

```sh
akm config path --all
akm config get engines.default
```

To see the exact set of top-level keys your installed version accepts (in
case this list has drifted since this doc was written), trigger the
validation error deliberately — it lists every valid key:

```sh
akm config get not-a-real-key
```

## 4. Configure Semantic Search (Local Embeddings)

Local embeddings need no external dependencies beyond a one-time model
download. Whether semantic search is *effectively* on depends on the release
and on how the stash was set up (interactive `akm setup` wizard vs. headless
`--yes`/`--config`) — check rather than assume:

```sh
akm config get semanticSearchMode   # "auto" (embeddings enabled) or "off"
akm config get embedding            # null unless a remote embedding endpoint is configured
```

The interactive `akm setup` wizard pre-selects semantic search **ON**, shows
a note before anything downloads, then asks a separate confirmation —
"Download and verify semantic-search assets now?" (also pre-selected
**yes**). Accepting that prompt with no remote `embedding` endpoint
configured downloads and caches a local model (`Xenova/bge-small-en-v1.5`,
~130 MB) **immediately, during `akm setup` itself** — not deferred to the
first `akm index` run — and may first shell out to install
`@huggingface/transformers` (`bun add`, bounded to 10 minutes) if it isn't
already present. The model is cached at `~/.cache/akm/models/`. Pointing the
wizard at a remote embedding endpoint skips the local download entirely.
Deferring the download to the first `akm index` run is what happens in
**headless** setups (`--yes`/`--config`, no wizard prompts), not the
interactive path described above.

For headless installs, don't rely on the implicit default — set the mode
explicitly so the script's behavior doesn't change across releases:

```sh
# Enable (local embeddings; downloads the model on first `akm index` run)
akm config set semanticSearchMode auto

# Disable (e.g. on memory-constrained hosts, or to skip the download)
akm config set semanticSearchMode off

# Fall back to whatever this version's config schema default is
akm config unset semanticSearchMode
```

### Disk and Memory Requirements for Local Embeddings

| Resource | Requirement |
| --- | --- |
| Model download | ~130 MB (one-time, cached) |
| RAM during indexing | ~200 MB peak |
| Indexing time | Seconds to minutes depending on stash size |

If the host is too constrained for local embeddings, configure a remote
embedding endpoint instead (see [configuration.md](../reference/configuration.md)).

## 5. Add Sources

Add the directories or packages that contain the agent's assets:

```sh
# Add a local directory
akm bundle add /path/to/skills

# Add a GitHub stash
akm bundle add github:owner/repo

# Add an npm stash
akm bundle add @scope/my-stash

# Add the current project's .claude directory (common for Claude Code)
akm bundle add ./.claude
```

## 6. Build the Search Index

```sh
akm index
```

For a full rebuild (after changing embedding config or adding many sources):

```sh
akm index --full
```

Check status:

```sh
akm info
```

Look for:
- `indexStats.entryCount` > 0
- `semanticSearch.status` = `"ready-js"` or `"ready-vec"` (not `"blocked"`)

## 7. Verify Search Works

```sh
akm search "test"
```

If the stash is empty, add some content first (step 5), then re-index (step 6).

## 8. Expose akm to the Agent

Add the following to the agent's `AGENTS.md`, `CLAUDE.md`, or system prompt:

```sh
akm help agents
```

Or add it manually:

```markdown
## Resources & Capabilities

You have access to a searchable library of scripts, skills, commands, agents,
knowledge, workflows, env files, secrets, lessons, memories, tasks, sessions,
and facts via the `akm` CLI.

Use `akm search "<query>"` to find assets and `akm show <ref>` to inspect them.
Run `akm -h` for the full command reference.
```

## Troubleshooting

### Semantic search is blocked

```sh
akm info   # Check semanticSearch.status and reason
```

Common reasons and fixes:

| Reason | Fix |
| --- | --- |
| `missing-package` | Run `bun add @huggingface/transformers` or `npm install @huggingface/transformers` |
| `native-lib-missing` | System libc incompatibility (Alpine/musl). Disable semantic search: `akm config set semanticSearchMode off` |
| `local-model-download` | Network issue during model download. Retry `akm index --full` once network is available |
| `remote-unreachable` | Remote embedding endpoint is down. Switch to local: `akm config unset embedding` |

### No results from search

1. Check that sources are configured: `akm bundle list`
2. Check that the index is built: `akm info` → `indexStats.entryCount`
3. Re-run `akm index` if sources were added after the last index run

### Index database path

```sh
akm config path --all   # Shows config, stash, cache, and index paths
```
