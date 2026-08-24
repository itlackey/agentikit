# Configuration

AKM reads one user configuration file: `$XDG_CONFIG_HOME/akm/config.json`
(normally `~/.config/akm/config.json` on Linux and macOS, or
`%APPDATA%\akm\config.json` on Windows). Set `AKM_CONFIG_DIR` to override the
directory. Project `.akm/config.json` files are not merged.

## Version 0.9

A present configuration file must set `configVersion` to exactly `"0.9.0"`.
Missing, older, newer, numeric, and malformed versions are rejected by ordinary
commands without rewriting the file. `akm migrate status` reports config and
database state independently; it exits nonzero when migration is blocked.
`akm migrate apply` installs an operator-prepared 0.9 config and applies pending
database migrations, but it never guesses profile-to-engine mappings. See [the
migration guide](../migration/v0.8-to-v0.9.md) before editing an existing
installation.

Canonical config and durable database access fail closed while a restore or
migration-apply operation is incomplete. Use `akm migrate status` to inspect it
and `akm migrate apply` to retry; do not delete migration control files manually.

AKM 0.8 does not provide these migration commands. To cross from 0.8 to 0.9,
prepare the target and an independent filesystem backup first, install or stage
the 0.9 binary manually, then invoke that new binary with `migrate apply
--config`. Do not use `upgrade --migration-config` from 0.8; that installed 0.8
code cannot enforce safeguards introduced by 0.9.

```jsonc
{
  "configVersion": "0.9.0",
  "$schema": "https://itlackey.github.io/akm/schemas/akm-config.json",
  "engines": {
    "fast": {
      "kind": "llm",
      "endpoint": "http://localhost:11434/v1/chat/completions",
      "model": "qwen3",
      "apiKey": "${LOCAL_LLM_API_KEY}"
    },
    "reviewer": {
      "kind": "agent",
      "platform": "opencode",
      "model": "anthropic/claude-sonnet-4-6"
    }
  },
  "defaults": {
    "engine": "reviewer",
    "llmEngine": "fast",
    "improveStrategy": "default"
  },
  "workflow": {
    "maxConcurrency": 8,
    "judgeEngine": "reviewer"
  },
  "improve": {
    "strategies": {
      "nightly": {
        "engine": "fast",
        "processes": {
          "reflect": {},
          "memoryInference": { "model": "qwen3-small", "llm": { "temperature": 0.1 } }
        }
      }
    }
  }
}
```

## Engines

`engines` is the only public execution map. An engine name is lowercase
kebab-case, at most 63 characters, and cannot start with `akm-`.

| Kind | Required fields | Use |
| --- | --- | --- |
| `llm` | `endpoint`, `model` | OpenAI-compatible chat completions |
| `agent` | `platform` | A registered dispatch-capable harness |

LLM endpoints must be complete `http://` or `https://` chat-completions URLs
ending in `/chat/completions`, without userinfo, query, or fragment. API keys
are symbolic only: `$VAR` or `${VAR}`. AKM resolves them only at dispatch.

An LLM engine may set `reasoningEffort` to a non-empty provider-supported
value such as `"none"`, `"low"`, or `"high"`. AKM sends it as the top-level
OpenAI-compatible `reasoning_effort` parameter alongside the existing
`enableThinking` control, because providers do not all honor the same thinking
switch. `reasoning_effort` is AKM-owned and cannot be set through
`extraParams`. If a response reports reasoning tokens despite
`enableThinking: false`, AKM emits a runtime warning so an ineffective provider
control is visible.

An agent engine may set `bin`, `args`, `workspace`, `model`, and `timeoutMs`.
Only `platform: "opencode-sdk"` may set `llmEngine`; it names
the LLM engine used as that SDK engine's fallback connection.

`platform: "opencode-sdk"` needs the **`opencode` binary** on PATH (or a `bin`
pointing at it). akm bundles `@opencode-ai/sdk`, but that package is an HTTP
client with no dependencies — it spawns `opencode serve` and talks to it — so
the npm dependency alone does not make the platform usable. Install the binary
with `npm i -g opencode-ai` or opencode's own installer.

### Model-map files

AKM ships an immutable `models.json` package asset with three intent aliases:
`fast`, `balanced`, and `reasoning`. The installed starter has separate
columns for Claude Code, OpenCode, and OpenCode SDK only. A provider-specific
identifier is not pretended to work on unrelated engines. Add mappings for
Gemini, Codex, named direct LLM engines, or other harnesses in your user file.
Config-root and per-engine `modelAliases` are rejected; this file is the only
alias definition surface.

An optional operator-owned file lives beside `config.json` at
`$XDG_CONFIG_HOME/akm/models.json` (or `<AKM_CONFIG_DIR>/models.json`). It uses
the same version-1 schema as the installed file:

```json
{
  "version": 1,
  "aliases": {
    "fast": {
      "gemini": "gemini-2.5-flash"
    },
    "reasoning": {
      "claude": {
        "inference": {
          "effort": "medium"
        }
      },
      "local-reasoner": {
        "model": "qwen3:30b",
        "inference": {
          "effort": "high"
        }
      }
    }
  }
}
```

Each engine mapping is either a non-empty exact model string or a structured
profile with the documented fields `model` and `inference`. A user profile may
omit `model` when the installed layer already supplies it, as the partial
Claude override above does. After overlay, every alias/engine entry must have a
usable model. Unknown profile fields are rejected; JSON-safe fields inside
`inference` are preserved for engine adapters to lower optimistically.

The user file overlays the installed file by alias, engine, and nested object
field. Objects merge recursively. Arrays, scalars, and explicit `null` replace
the lower value; omitted fields preserve it. Alias and engine keys are
case-normalized, and case-colliding definitions are rejected. Unknown model
inputs still pass through byte-for-byte as exact identifiers. Once a name is a
known merged alias, selecting an engine with no mapping is an actionable
configuration error rather than silently sending the alias as a model ID.

The common execution cascade reads these files for current direct command and
non-interactive agent calls, task-v3 runs, and improve/proposal/index
model work routed through that resolver. A structured alias expands as
defaults at the layer that selected it; explicit sibling fields and nearer
layers still win. The resulting request carries the exact model ID and merged
inference object. Engine lowerers consume that exact selection and never run
alias resolution again. New workflow starts persist the exact request and
symbolic runner selection in durable plan v4; resume consumes that frozen
material without resolving aliases again.

Copy the complete installed starter into the user configuration directory when
you want to customize all fields:

```sh
akm models copy-defaults
akm models copy-defaults --overwrite  # explicit replacement confirmation
```

The command validates the installed asset, creates the config directory, and
writes a fully synced sibling before publication. Without `--overwrite`, a
hard-link/no-replace operation makes publication atomic: a racing creator wins
without losing its bytes. A filesystem that cannot provide that operation
fails safely instead of falling back to a clobbering rename.

With `--overwrite`, the portable guarantee is an atomic pathname replacement
that never follows the target when it is a symlink. AKM verifies the observed
regular-file identity again immediately before rename, but the portable
filesystem APIs do not provide a conditional compare-and-swap rename. Another
process can still change the directory entry after that check; AKM replaces
the entry at the pathname without dereferencing it. Consequently,
`overwritten: true` means overwrite was requested for an entry AKM observed,
not that an inode identity was transactionally locked. Symlinks and other
non-regular targets observed at either check are refused.

AKM does not auto-create or sync this file, and authoritative defaults never
live in the cache. npm/Node and normal Bun installs read the packaged
`dist/assets/models.json` lazily, so `akm health` can report a missing or
malformed package asset as a `model-map-files` failure. A standalone binary has
the same authoritative bytes embedded at compile time and therefore has no
external model-map asset that can later disappear; its health check validates
the embedded copy, and release tests pin copied bytes to `src/assets/models.json`.
The health check passes when the optional user file is absent and warns with
its path and JSON location when the user file is unreadable or invalid.

`defaults.engine` names an LLM or agent engine. `defaults.llmEngine` must name
an LLM engine. There is no first-engine fallback: an unset `defaults.engine`
never resolves to some arbitrary entry in `engines`. It resolves instead to a
synthesized, config-free `opencode-sdk` engine when the `opencode` binary is on
PATH — announced once per run, and preempted by any `opencode-sdk` engine you
configure yourself. Naming an engine that is not configured is always an error
and is never rescued by that fallback.

Index passes select engines through `index.defaults.engine` or
`index.<pass>.engine`. Per-pass `model`, `timeoutMs`, and `llm` fields are
invocation overrides; `enabled: false` disables that pass. Connection fields
such as `endpoint`, `provider`, and `apiKey` belong only on named engines.

`workflow.maxConcurrency` is the native workflow engine ceiling. An explicit
value is clamped to `1..64`. When absent, AKM derives the cap once from the CPU
count (`min(16, max(1, cores - 2))`) and freezes it into the run plan, so resume
does not change policy on a different host or after config edits.

`workflow.defaultMapConcurrency` is the width a `map` step freezes when it
declares no `concurrency:` of its own. Unset means **4** — map steps are
parallel by default as of 0.9.1. An explicit value is clamped to `1..64`; set
it to `1` to restore the pre-0.9.1 serial-by-default fan-out for every workflow
on this machine. It is only a default: an authored `map.concurrency` always
wins, and it never raises a step past `workflow.maxConcurrency`, the selected
engine's `concurrency`, or the host CPU cap. An LLM engine that declares no
`engines.<name>.concurrency` gets **1** on a loopback endpoint (a local model
server holds one loaded model) and **4** on a remote one.

`workflow.judgeEngine` names the LLM or agent engine used to verify every
non-empty workflow `### gate` rubric. It is required when a workflow declares
completion criteria and is frozen into each new run, so later config edits do
not change an in-flight run's verifier. Missing, failed, or malformed verifier
results reject the gate; criteria are never silently bypassed.

## Strategies

Improve presets live under `improve.strategies`; invoke one with
`akm improve --strategy <name>`. The selection order is `--strategy`,
`defaults.improveStrategy`, then built-in `default`. A strategy and each process
can select `engine`, `model`, `timeoutMs`, and LLM request overrides:

```jsonc
{
  "improve": {
    "strategies": {
      "nightly": {
        "engine": "fast",
        "processes": {
          "reflect": { "llm": { "temperature": 0.2 } },
          "graphExtraction": { "model": "qwen3-small" }
        }
      }
    }
  }
}
```

LLM-only improve processes require an LLM engine; an explicit invalid or
incompatible engine never falls back to another engine. Built-in strategies
are complete presets. User-defined strategies inherit omitted fields from the
built-in `default` strategy before applying their own overrides.

`processes.triage.judgment` explicitly controls the optional judgment tier.
Use `true` to enable it, `false` to disable it, or an object with `enabled`,
`engine`, `model`, `timeoutMs`, and/or `llm` overrides. Existing object values
such as `{}` and `{ "engine": "reviewer" }` remain enabled by default. Unknown
object keys are rejected so misspellings cannot silently change execution;
the retired `mode` and `profile` keys continue to report their engine migration
guidance. When enabled, engine selection is judgment → triage → strategy →
`defaults.llmEngine`, and resolution fails closed if none is available.

```jsonc
{
  "improve": {
    "strategies": {
      "nightly": {
        "processes": {
          "triage": {
            "enabled": true,
            "judgment": { "enabled": true, "engine": "reviewer" }
          }
        }
      }
    }
  }
}
```

The shipped `default` and `frequent` strategies keep improve-stage session
extraction off. `proactiveMaintenance` is off in `default` and
`reflect-distill`; run `akm improve --strategy proactive-maintenance` to use the
dedicated opt-in preset. Because strategies inherit from `default`, a preset
that omits either process also inherits the off value. User strategy overrides
are applied last, so an explicit `enabled: true` still opts the selected
strategy in.

These improve-stage defaults do not gate explicit standalone extraction through
`akm proposal extract --type <harness>` or `akm proposal extract --auto`. The interactive
scheduled-task step also continues to offer the bundled `core/extract` template
as an unselected opt-in; it is not installed merely because the template is
bundled.

## Indexing

`index.indexBodyOpening` defaults to `false`. When enabled, AKM captures the
first prose paragraph of each Markdown asset body, capped at 280 characters,
into the lowest-weight search content and embedding text. Secret and env files
are never read for this field, and session-kind memories are excluded.

Changing this option changes indexed text. Run `akm index --full` after
toggling it so all entries and embeddings are rebuilt consistently. If the
setting differs from the state used to build the current index, AKM warns until
that full rebuild completes.

## Semantic search

`semanticSearchMode` (top-level, `"off" | "auto"`, default `"off"`) gates
embedding-based search. `"auto"` lets AKM set up embeddings (which downloads
a local model unless you point `embedding` at a remote provider) and falls
back to keyword-only FTS if the embedding runtime is unavailable; `"off"`
disables semantic search outright and search is always keyword-only FTS.
If a backend marked ready cannot serve a query, search still returns the FTS
results but reports `searchMode: "fts-fallback"` and one sanitized warning.
This is distinct from `searchMode: "keyword"`, which is the normal result when
semantic search is disabled or has not been built. A read-only sandbox that
cannot record best-effort usage telemetry does not by itself mark search as
degraded.
The npm/Bun package owns its local Transformers.js/ONNX Web dependencies as
optionals. If the package was installed with `--omit=optional`, reinstall it
without that flag or configure a remote `embedding.endpoint`; setup does not
mutate a global installation to add runtime packages.
Under Bun, an omitted local embedding runtime degrades to keyword search with
semantic status `blocked`. Under Node.js, `--omit=optional` also removes the
optional `better-sqlite3` database driver, so storage-backed commands require a
normal reinstall or execution under Bun before they can reach that status.
The default is `"off"` so a bare or headless install (`akm bundle create`, `--yes`,
`--config`) never silently downloads the local embedding model on first
index.
The interactive `akm setup` wizard pre-selects semantic search **on**
regardless of this default, and warns that choosing it downloads the model
unless a remote `embedding` config is provided.

```jsonc
{ "semanticSearchMode": "off" }
```

`embedding` configures the connection used for semantic search and
`akm improve`'s memory-inference/consolidate passes when they call an
embedding model: `provider`, `endpoint`, `model`, `apiKey` (symbolic
reference, same rules as engine `apiKey`), `dimension`, `localModel`,
`maxTokens`, `batchSize`, `chunkSize`, `contextLength`, and
`ollamaOptions.num_ctx`.

## Search tuning

`search` tunes ranking, not behavior an ordinary user needs to touch:

| Key | Purpose |
| --- | --- |
| `search.minScore` | Drop results below this score |
| `search.defaultExcludeTypes` | Asset types excluded from results by default |

### Graph boost search tuning

| Key | Purpose |
| --- | --- |
| `search.graphBoost.*` | Entity-graph relevance boost: `directBoostPerEntity`/`directBoostCap` (directly related entities), `hopBoostPerEntity`/`hopBoostCap` (multi-hop, capped at `maxHops` ≤ 3), `confidenceMode` (`off`\|`blend`\|`multiply`, default `blend`), `confidenceWeight` (0–1, default `0.2`) |

## Feedback

`feedback` shapes the `akm feedback` taxonomy:

| Key | Purpose |
| --- | --- |
| `feedback.requireReason` | Whether `akm feedback --negative` without `--reason`/`--failure-mode` is a hard error. **Defaults to `true`** when unset — set `false` to downgrade the check to a warning instead |
| `feedback.allowedFailureModes` | Restrict `--failure-mode` values accepted by `akm feedback`. Curated set (also the default when unset): `incorrect`, `outdated`, `dangerous`, `incomplete`, `redundant` |

## Bundles and write target

`bundles` (replacing the retired `stashDir`/`sources[]`/`installed[]` trio)
and `defaultBundle` are the 0.9 source configuration shape — see
[Concepts](https://github.com/itlackey/akm/blob/main/docs/guides/concepts.md) and the [CLI reference](cli.md) for the
full bundle model (`path`, `git`, `website`, `npm`, `writable`, `registryId`,
`components`). `defaultBundle` must name a key in `bundles` when set. A
bundle's `components.<id>.adapter` key pins it to a specific format adapter
instead of relying on auto-detection — see [Bundle Types](bundle-types.md)
for the full adapter list and what each one reads/writes.

### defaultWriteTarget

`defaultWriteTarget` names the bundle that write commands (`akm remember`,
`akm env`/`secret create`, `akm improve`, etc.) fall back to when no
explicit destination flag is given and the command isn't already scoped to a
specific source. It must name a configured bundle; setting it with no
`bundles` configured, or naming an unconfigured bundle, is rejected at
`config set` (or config load) time. The full write-target resolution order
is the command's destination flag (`--bundle` on `remember`/`clone`/
`improve`, `--target` on `env`/`secret create`) -> `defaultWriteTarget` ->
working bundle (`defaultBundle`) -> `ConfigError`.

### Memory scope

`akm remember`'s scope flags (`--user`, `--agent`, `--run`, `--channel`)
write four canonical top-level frontmatter keys on the memory file:
`scope_user`, `scope_agent`, `scope_run`, `scope_channel` (one key per
non-empty scope value; string values). This is not a config-file setting —
it is documented here because it is the multi-tenant/multi-agent contract
that `akm search --filter` and `akm show --filter` read back:
`--filter user=<id>` / `--filter agent=<id>` / `--filter run=<id>` /
`--filter channel=<name>` (repeatable) narrow results/resolution to assets
whose frontmatter scope matches, without changing ranking. A memory with
only scope flags and no tags is valid — the tag-required check is
independent of scope. `--scope` was removed in 0.9.0 with no alias; use
`--filter`.

`archiveRetentionDays` (default `90` when unset) controls how long a pending
proposal is kept before `akm improve`'s maintenance pass archives it (status
`rejected`, reason `"expired: no action within retention window"`) — `akm
proposal` itself has no archive/expire verb. Setting it to `0` or less
disables expiry entirely.

## Registries

`registries` (top-level array, distinct from `bundles`) lists remote package
registries `akm registry`/`akm bundle add` can search and install from.
Each entry is `{ url, name?, enabled?, provider?, options? }`; `provider`
defaults to `"static-index"`. See [Registries](https://github.com/itlackey/akm/blob/main/docs/reference/registry.md) for the full
field reference and provider list.

Registry `url` values must not contain username/password userinfo. The built-in
providers do not currently support authenticated registry requests; `options`
does not add an authentication mechanism. Use a credential-free HTTPS endpoint.

## Output defaults

`output.format` (one of `json`\|`yaml`\|`text`\|`jsonl`\|`md`\|`html`,
default `json`) and `output.detail` (`brief`\|`normal`\|`full`, default
`brief`) set the CLI's default `--format`/`--detail` when the flags are
omitted. Per-command flags always override these.

## Setup-derived recommendations

`setup` is reserved for configuration derived by `akm setup`. It currently
holds no keys — the `setup.taskSchedules` sub-key was removed in 0.9.0 after
nothing in the setup flow or the tasks subsystem was found to read or write
it. Scheduling lives in the tasks subsystem (`akm task`).

## Experimental opt-ins

`experimental` holds explicit opt-ins for behavior outside the 0.9
stability contract (see [STABILITY.md](../../STABILITY.md) for full
classification). Every key defaults to **off**; an absent `experimental`
section, an absent key, and an explicit `false` all read identically as off.

```jsonc
{
  "experimental": {
    "improveAutonomy": false
  }
}
```

- **`experimental.improveAutonomy`** — gates only the autonomous
  `memoryInference`, `triagePromote`, and `memoryCleanup` lanes. `akm improve`
  itself always runs; this only gates mutations without a human in the loop.
  Consolidation is not gated: it remains advisory and emits reviewable
  proposals. `sync.push` is deliberately **not** gated by this key.

## Managing Config

```sh
akm config list
akm config get engines.fast
akm config set engines.fast '{"kind":"llm","endpoint":"http://localhost:11434/v1/chat/completions","model":"qwen3"}'
akm config set engines.fast.apiKey '$LOCAL_LLM_API_KEY'
akm config unset engines.old
akm migrate status
akm migrate status --config ./prepared-0.9.json
akm migrate apply --config ./prepared-0.9.json --dry-run
akm migrate apply --config ./prepared-0.9.json
```

Object values passed to `config set` deep-merge with their current value.
Arrays replace, `null` is only valid for nullable fields, and `config unset` is
the only deletion operation. `configVersion` cannot be set or unset with the
generic walker.

## Environment

| Variable | Purpose |
| --- | --- |
| `AKM_CONFIG_DIR` | Override the user config directory (or set `XDG_CONFIG_HOME`) |
| `AKM_ENGINE_<NAME>_API_KEY` | Fallback credential for LLM engine `<name>` |
| `AKM_LLM_API_KEY` | Fallback only for the selected `defaults.llmEngine` |
| `AKM_EMBED_API_KEY` | Embedding credential |
| `AKM_BUNDLE_DIR` | Override the bundle directory |
| `AKM_DATA_DIR` | Override the data directory — durable `index.db`/`workflow.db`/`state.db`, `akm.lock`, config backups (or set `XDG_DATA_HOME`) |
| `AKM_CACHE_DIR` | Override the cache directory — regenerable caches (or set `XDG_CACHE_HOME`) |
| `AKM_STATE_DIR` | Override the state directory — task-scheduler invocation state (or set `XDG_STATE_HOME`) |
| `AKM_SQLITE_JOURNAL_MODE` | SQLite journal mode: `WAL` (default), `DELETE`, or `TRUNCATE` |
| `AKM_VERBOSE` | Truthy value enables the same diagnostics as `--verbose` |
| `AKM_DEBUG` | `1` prints a stack trace on unexpected internal errors |

For an engine named `fast`, its fallback variable is
`AKM_ENGINE_FAST_API_KEY`. An explicit `apiKey` symbolic reference is
authoritative and does not fall through to another variable.

Use `AKM_SQLITE_JOURNAL_MODE=DELETE` or `TRUNCATE` when WAL is unavailable,
such as on some NFS/SMB mounts. With the default `WAL` setting, AKM detects a
network filesystem for the data directory and falls back to `DELETE`.

## Retired Configuration

`profiles`, `llm`, `agent`, `features`, `stashes`, `defaults.llm`,
`defaults.agent`, and `defaults.improve` are rejected in 0.9. Recreate the
configuration using `engines`, `defaults.engine`, `defaults.llmEngine`, and
`improve.strategies`; AKM deliberately does not infer or rename ambiguous
profile identities.
