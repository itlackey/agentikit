# Stability policy

`akm-cli` follows [Semantic Versioning](https://semver.org/) on the 0.x line
**with one caveat**: until 1.0, minor releases (0.x → 0.x+1) may include
breaking changes.

**0.9.x series exception.** The 0.9.x releases are a deliberate refactoring
and clean-up series: the goal is to pay off all remaining technical debt and
land every planned breaking change before 0.10. While that work completes,
**0.9.x patch releases may also contain breaking changes** — each one called
out in the CHANGELOG with a migration note. The 0.10.x series returns to bug
fixes and tuning, and aims to restore the normal discipline of breaking
changes only in major and minor releases.

This document classifies **every** user-facing surface by stability so you can
decide which parts of `akm` are safe to script against today and which to
treat as still-evolving. If a surface is not listed here, that is a bug —
please file it.

## How to read this

| Tier | Contract |
| --- | --- |
| **Stable** | Scripted use is supported. Changes are additive within a minor release; breaking changes are called out in the CHANGELOG with a migration note. |
| **Evolving** | Available across minor releases, but flag names, prompts, and payload shapes may shift. Breaking changes are flagged in the CHANGELOG. |
| **Experimental** | Subject to change without notice. Not recommended for scripted use. Some experimental surfaces additionally require an explicit opt-in (see [Experimental opt-in](#experimental-opt-in)). |
| **Internal** | Not a public interface. May change or disappear in any release, without a CHANGELOG note. Listed here only so you can recognize it. |

## Stable

- **Asset ref syntax** — `[bundle//]conceptId[#fragment]`. A `conceptId` is
  subdir-qualified within its bundle: `memories/<name>`, `lessons/<name>`,
  `knowledge/<name>`, `skills/<name>`, `scripts/<name>`, `workflows/<name>`,
  `env/<name>`, `secrets/<name>`, `tasks/<name>`, `facts/<name>`,
  `sessions/<name>`, `commands/<name>`, `agents/<name>`. Other adapters
  declare their own conceptId layouts. The optional `bundle//` prefix names an
  installed bundle; omit it and the ref resolves against the workspace
  `defaultBundle`, then the remaining bundles in installation-priority order.
  Durable state always stores the fully-qualified `bundle//conceptId`; the
  short form is accepted input only, at the CLI, the programmatic surface, and
  inside bundle content (where it resolves against the containing bundle). The
  older `<type>:<name>` grammar is no longer accepted.
  - `#fragment` is **input-only** and never stored. On markdown-document items
    the core resolves it as a section selector; elsewhere it is an
    adapter-owned selector opaque to the core. See
    [`docs/architecture/specs/ref.md`](./docs/architecture/specs/ref.md).
  - **Refs in prose** must be fully qualified (`bundle//conceptId`) or a native
    adapter link form. A bare conceptId in prose is ordinary text, not a ref,
    and no akm tool rewrites it.
- **Ref-prefix enumeration** — `akm search "memories/"`,
  `"memories/projecta/"`, `"bundle//"`, `"bundle//skills/"`. A trailing `/` is
  required for a non-empty prefix.
- **Read commands** — `akm search`, `akm show`, `akm list`, `akm curate`,
  `akm info`, `akm config get`, `akm config list`, `akm config path`,
  `akm env list`, `akm secret list`, `akm proposal list` (list filters),
  `akm help`, `akm hints`, `akm completions`.
- **Write commands core surface** — `akm add`, `akm update`, `akm remove`,
  `akm clone`, `akm import`, `akm sync`, `akm index`, `akm init`, `akm setup`,
  `akm remember`, `akm feedback`, `akm config set`, `akm config unset`.
- **Renames are delete + create** — moving or renaming an item gives it a new
  identity; learned state does not follow it. Cross-bundle movement is
  copy/import plus delete. (0.9.0 removed `akm mv`, which promised otherwise.)
- **Asset `type` is a free-form, open string** — `--type` filtering is an
  exact match against an open set and is deliberately **not validated**: an
  unrecognized type returns zero hits, not an error. Adapters emit types
  outside the built-in set. Filter by conceptId prefix when you need a closed
  set.
- **Output contracts** — JSON output shape (the top-level keys, error envelope
  `{ok: false, error, hint}`), and the exit-code table below. All six
  `--format` values (`json|jsonl|yaml|text|md|html`) are available on every
  non-exempt command; `--detail` is verbosity only (`brief|normal|full`);
  `--shape` (`human|agent|summary`) is the output-projection axis (see
  Experimental). A small set of commands is **format-exempt** by nature
  (`completions`, the interactive `setup` wizard, child-process passthrough in
  `env run` / `secret run` / `agent`, and document payloads from
  `workflow template` / `hints` / `help migrate`); the exemption is declared,
  documented, and warned about rather than silent.

  | Exit code | Meaning |
  | --- | --- |
  | `0` | Success |
  | `1` | General error / not found |
  | `2` | Usage / bad input |
  | `4` | Health warning (`akm health` only) |
  | `70` | Internal / unclassified |
  | `78` | Configuration error |
- **Install scripts** — `install.sh` and `install.ps1` URLs; the `--prefix`
  / `AKM_INSTALL_DIR` environment override.
- **Runtime** — the npm package requires Node.js >= 22 as its bootstrap and
  prefers a working Bun >= 1.0 for execution when both are available; old,
  unusable, or absent Bun installations fall back to Node.js. Standalone
  binaries are runtime-free.
- **On-disk storage** — durable workspace state (events, proposals, history,
  workflow runs, salience) lives in `state.db`; the search index (`index.db`)
  is a fully **regenerable** cache rebuilt by `akm index`; high-volume logs stay
  in a separate `logs.db`. Asset metadata lives as file-local frontmatter plus
  the index (there is no separate metadata sidecar). Treat the on-disk schema
  as internal (use `akm` commands, not direct SQL).

## Evolving

These surfaces are in active iteration as we learn from users. They will
remain available across minor releases, but flag names, prompts, and
proposal-queue shape may shift. Breaking changes will be flagged in the
CHANGELOG with a migration note.

- **Improvement loop** — `akm improve`, `akm propose`, `akm extract`, and the
  proposal noun group
  `akm proposal {list,show,diff,accept,reject,revert,drain}`. Output JSON keys
  are stable; CLI flags (`--strategy`, `--task`, `--generator`) may add
  options or tighten validation across releases. `akm improve` itself stays on
  by default and review-first; its directly-mutating lanes require an opt-in
  (see [Experimental opt-in](#experimental-opt-in)). `--auto-accept` is
  deprecated and ignored; it becomes a hard error in 0.10 — the replacement is
  `akm improve && akm proposal drain --promote --yes`, or a `triage` block
  with `applyMode: "promote"` in your strategy.
- **Tasks** — `akm tasks` subcommand surface (singular `akm task` is an
  additive alias); strict version-2 YAML for scheduled tasks. Prompt tasks use
  named engines and task history metadata is versioned. Schema additions in
  patch releases; removals only at minor. Bare `akm tasks` reports scheduler
  diagnostics (equivalent to `akm tasks doctor`).
- **Events / log** — `akm log` is the primary event-stream surface (`akm
  history` is a different, asset-scoped surface).
- **Lessons** — `akm lessons` subcommand surface (singular `akm lesson` is an
  additive alias).
- **Bundles & the workspace model** — installed sources are *bundles*; each is
  recognized by a built-in *adapter* (native Agent Skills, Claude and OpenCode
  commands/agents, knowledge, YAML workflows, tasks, env/secret files, scripts,
  OKF and LLM-wiki knowledge bases). Config is keyed by `bundles` and
  `defaultBundle`. The adapter set, bundle-recognition rules, and the
  `bundles` config shape may still shift. Bundles are inspected through
  `akm list` and enumerated through `akm search "bundle//"` — the separate
  `akm bundle` noun group was removed in 0.9.0 as duplicative. OKF is the
  first-class baseline for Markdown concept identity and generic reads; every
  applicable OKF conformance case is required to pass. AKM-authored Markdown is
  an OKF-compatible superset whose adapter adds native behavior progressively.
- **LLM Wiki bundles** — the Karpathy-style LLM wiki is a first-class built-in
  bundle format (the `llm-wiki` adapter owns `schema.md` / `index.md` /
  `log.md` / `raw/` / `pages/` and its ingest flow); wiki pages are addressed
  as ordinary concepts inside their bundle. Adapter behavior and page
  conventions are still iterating.
- **Agent dispatch** — `akm agent` subcommand. Supported backends: `claude`,
  `opencode`, `opencode-sdk`, `codex`, `copilot`, `pi`, `gemini`, `aider`,
  `amazonq`, `openhands`. The set will grow.
- **Proposal queue** — quality classifications (`accepted`, `pending`,
  `proposed`, `rejected`, `archived`) are stable; the JSON shape of a
  proposal record may add fields.
- **Registries** — `akm registry {list,add,remove,search}`.
  `akm registry build-index` is maintainer tooling (Internal).
- **Upgrade** — `akm upgrade`. Checksum verification is not optional; the
  recovery hatch is the `AKM_UPGRADE_SKIP_CHECKSUM` environment variable
  (Internal), not a flag.
- **Lint** — `akm lint`. The rule set and finding shapes iterate; the
  `--fail-on-flagged` CI contract and the exit codes are stable.
- **Health** — `akm health` and its exit codes (0 pass / 4 warn / 1 fail) are
  Evolving; the *content* of the report (metrics, advisories) and the rendered
  `md` / `html` layouts are Experimental — do not script against report layout.

## Experimental

Subject to change without notice within minor releases. Not yet recommended
for scripted use.

- **`lesson` asset type** — schema (`when_to_use`, `description`) is
  stable, but lesson-distillation triggers and ranking are tuning targets.
- **`--shape agent` and `--shape summary`** — the output-projection axis
  (`--shape human|agent|summary`). `summary` is implemented only on
  `akm show`; `agent` is implemented on `search`, `show`, and `curate`.
  Coverage will expand. `--detail` is verbosity only (`brief|normal|full`).
- **Protected env & secret values** — `env` (a whole `.env` group; key names
  are surfaced for discoverability, values never are) and `secret` (a single
  sensitive value). Values are never written to stdout, the index, or
  structured output; the safe injection path is `akm env run <name> --
  <command>` (or `akm secret run <name> <VAR> -- …`). The `env` / `secret`
  **write** verbs (`create`, `set`, `unset`, `remove`) are Experimental; the
  `list` / `path` / `run` / `export` read-and-inject surface is Stable.
- **Memory belief-state transitions** — `captureMode`, `beliefState`,
  contradiction edges, and the consolidate journal are observable but
  the algorithm that writes them is tuning across patch releases.
- **`akm graph`** — read-only inspection of the indexed entity graph
  (`summary`, `entities`, `relations`, `related`, `entity`, `orphans`,
  `export`, `update`). It exposes indexer internals; its shapes will change.
- **Improve tuning config** — `improve.strategies.*.processes.*` (per-process
  engines, limits, gates, and the anti-collapse / CLS / fidelity knobs) and
  the `index.*` per-pass config. The 0.9.x series is explicitly still settling
  the design of the improve processes, so **keys in these two families may be
  added, renamed, or dropped in any 0.9.x or 0.10.x release**. The `akm
  improve` *command* surface is Evolving (above); its tuning config is not.
- **`akm workflow run` + YAML workflow programs** — orchestrated workflows
  written as YAML programs (`workflows/*.yaml`, `version: 2`, validated
  against `schemas/akm-workflow.json`), executed by `akm workflow run`, plus
  the harness-neutral driver protocol (`akm workflow brief` / `akm workflow
  report`) and `akm workflow watch`. Requires the
  `experimental.workflowEngine` opt-in. The YAML format, its schema, the
  flags, and all JSON output shapes may change. Classic **linear markdown
  workflows are unchanged and stable**, as is the workflow CLI contract
  (`start` / `next` / `complete` / `status` / `list` / `create` / `validate` /
  `template` / `resume` / `abandon`).

### Experimental opt-in

Some experimental surfaces are gated: they refuse to run until you set the
corresponding config key, and the refusal names the key. A gated lane never
degrades into a silent no-op — a scheduled run that hits one emits an event,
surfaces in `akm tasks doctor`, and raises a health advisory.

| Key | Gates |
| --- | --- |
| `experimental.workflowEngine` | `akm workflow run` / `brief` / `report` / `watch`, and creating YAML workflow programs |
| `experimental.improveAutonomy` | The improve lanes that mutate assets without review: consolidate's merge/delete/contradict, the memory-cleanup and contradiction passes, memory-inference writes, triage `applyMode: "promote"`, and unattended `push` |

Without `experimental.improveAutonomy`, `akm improve` still runs and still
generates proposals for review — reflect, distill, extract candidates,
validation, proactive-maintenance selection, and graph extraction are all
ungated. Two direct writes remain ungated by design and are called out here so
they are not a surprise: `extract`'s session indexing (additive `sessions/**`
writes, `processes.extract.indexSessions`, default on) and distill's
encoding-salience frontmatter stamp (metadata only).

## Internal

Not public interfaces. Listed so you can recognize them, not so you can rely
on them.

- **Migration surfaces** — `akm migrate {status,apply}`,
  `akm backup {create,restore}`, and the `akm-migrate-storage` binary
  implement the one-time 0.8→0.9 cutover. They are **scheduled for removal at
  0.10**, moving to a separately published `akm-migrate` package; `akm
  migrate` and `akm backup` become thin forwarders. `akm config migrate` is
  removed in 0.9.0 (use `akm migrate`). `akm help migrate <version>` is
  Stable — it renders release notes and is unrelated to the apply machinery.
- **`akm registry build-index`** — maintainer tooling for building a registry
  index.
- **Environment variables** — see the table below.

### Environment variables

**Supported** — documented interfaces; changes get a CHANGELOG note:

| Variable | Purpose |
| --- | --- |
| `AKM_STASH_DIR`, `AKM_CONFIG_DIR`, `AKM_DATA_DIR`, `AKM_CACHE_DIR` | Filesystem layout overrides |
| `AKM_LLM_API_KEY`, `AKM_EMBED_API_KEY`, `AKM_ENGINE_<NAME>_API_KEY` | Credential provision for `$VAR` config references |
| `AKM_LLM_ENDPOINT`, `AKM_LLM_BASE_URL` | Setup provider inference |
| `AKM_VERBOSE`, `AKM_DEBUG`, `AKM_NON_INTERACTIVE` | Diagnostics and CI behavior |
| `AKM_REGISTRY_URL`, `AKM_NPM_REGISTRY` | Registry / mirror overrides |
| `AKM_SQLITE_JOURNAL_MODE` | SQLite journal mode (network filesystems) |
| `AKM_BIN` | Absolute `akm` path for scheduler registration |
| `AKM_INSTALL_DIR` | Install-script prefix |
| `AKM_FORCE_SETUP_TMP_STASH` | Documented escape hatch for intentional temp-directory stashes |
| `AKM_UPGRADE_SKIP_CHECKSUM` | Recovery hatch for a broken upgrade checksum |

**Internal** — no compatibility guarantee, may vanish without notice:
`AKM_NODE_ENTRY`, `AKM_EVENT_SOURCE`, `AKM_SESSION_ID`, `AKM_AGENT_HARNESS`,
`AKM_EMBED_DETERMINISTIC`, `AKM_CLAUDE_PROJECTS_DIR`,
`AKM_FORCE_INIT_TMP_STASH`, `AKM_STATE_DIR`.

Anything matching `AKM_TEST_*` is test-only fault injection, compiled out of
release builds. Never set it.

## On the horizon

These changes are planned and will land in a known future release. They
are not part of the current stability contract; you should plan migrations
around them.

- **0.10 — migration extraction.** The migration machinery leaves the CLI for
  a separately published `akm-migrate` package (see Internal above).
- **0.10 — `--auto-accept` hard error.** Currently warn-and-ignore.
- **1.0 contract freeze** — the `[bundle//]conceptId[#fragment]` ref grammar,
  the supported source model, search behavior, and write-target rules are
  frozen at 1.0. The SDK and in-process plugin story ship on top of that
  frozen core.

## Reporting stability regressions

If you script against a stable surface and a release breaks it without a
CHANGELOG migration note, please open an issue at
<https://github.com/itlackey/akm/issues> labeled `regression`. We treat
stable-surface regressions as priority bugs.

For experimental surfaces, expect change — but file an issue if a change
isn't called out in the CHANGELOG, since that's still a documentation gap
worth fixing.

## See also

- [`CHANGELOG.md`](./CHANGELOG.md) — every release's behavior changes.
- [`SECURITY.md`](./SECURITY.md) — security supported-version policy
  (independent of the feature-stability policy above).
- [`docs/architecture/specs/ref.md`](./docs/architecture/specs/ref.md) — the
  normative ref grammar.
- [`docs/architecture/specs/0.9.0-decisions.md`](./docs/architecture/specs/0.9.0-decisions.md)
  — the decision record behind the 0.9.0 surface changes.
- [`docs/reference/data-and-telemetry.md`](./docs/reference/data-and-telemetry.md) — what
  state akm reads and writes locally.
