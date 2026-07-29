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
| **Experimental** | Subject to change without notice. Not recommended for scripted use. Some experimental surfaces additionally require an explicit opt-in — see [`akm improve` autonomy](#akm-improve-autonomy--opt-in-in-090) and [`akm workflow` engine](#akm-workflow-engine--opt-in-in-090). |
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
    the core resolves it as a section selector — `akm show <ref>#<heading-slug>`
    returns that one section, no fragment returns the whole item, and an
    unmatched fragment lists the available slugs. Elsewhere it is an
    adapter-owned selector opaque to the core. See
    [`docs/architecture/specs/ref.md`](./docs/architecture/specs/ref.md).
  - **Refs in prose** must be fully qualified (`bundle//conceptId`) or a native
    adapter link form. A bare conceptId in prose is ordinary text, not a ref,
    and no akm tool rewrites it.
- **ConceptId-prefix enumeration** — `akm search "memories/"`,
  `"memories/projecta/"`, `"bundle//"`, `"bundle//skills/"`. A trailing `/` is
  required. The prefix matches the **conceptId** — the spelling every emitted
  `ref` carries — so a ref copied out of search output can be truncated to a
  prefix and pasted back in. Enumeration is not tied to any adapter's type set,
  so every adapter's items browse the same way, and `bundle//` lists a whole
  bundle (this replaced `akm bundle items`). A prefix is explicit intent, so
  `search.defaultExcludeTypes` does not apply to it. The pre-0.9.0
  `"<type>:"` / `"<type>:<prefix>/"` spelling was removed; a query in that
  shape is now an ordinary keyword search whose empty-result tip names the
  conceptId spelling that replaces it.
- **Read commands** — `akm search`, `akm show`, `akm list`, `akm curate`,
  `akm info`, `akm config get`, `akm config list`, `akm config path`,
  `akm env list`, `akm secret list`, `akm proposal list` (list filters),
  `akm help`, `akm hints`, `akm completions`.
- **Write commands core surface** — `akm add`, `akm update`, `akm remove`,
  `akm clone`, `akm import`, `akm sync`, `akm index`, `akm init`, `akm setup`,
  `akm remember`, `akm feedback`, `akm config set`, `akm config unset`.
- **Renames are delete + create** — moving or renaming an item gives it a new
  identity; learned state does not follow it. Cross-bundle movement is
  copy/import plus delete. `akm mv` still ships and claims to preserve identity
  across a rename, but it is **Experimental and not covered by this contract**:
  its inbound-ref rewriting targets bare conceptIds rather than the anchored
  `bundle//conceptId` prose form, so it can rewrite non-refs while leaving real
  refs dangling. Prefer a plain filesystem move plus `akm index` and `akm lint`.
- **Asset `type` is a free-form, open string** — `--type` filtering is an
  exact match against an open set and is deliberately **not validated**: an
  unrecognized type returns zero hits, not an error. Adapters emit types
  outside the built-in set, so there is no closed list to validate against —
  `--type website` or `--type wiki-source` are ordinary, valid filters.
- **Output contracts** — JSON output shape (the top-level keys) and the error
  envelope `{ok: false, error, code?, hint?}` on envelope surfaces: `ok` and
  `error` are always present; `code` is a stable machine-readable identifier
  present on every classified failure (exit 1 / 2 / 78) and absent only on
  unexpected internal errors (exit 70); `hint` is best-effort and may be absent. Prefer
  `code` over matching on `error` prose. Plus the exit-code table below.
  **All six** `--format` values (`json|jsonl|yaml|text|md|html`) are available
  on every non-exempt command. `json`, `jsonl`, and `yaml` serialize the
  envelope; `text`, `md`, and `html` render it. A command may register a bespoke
  renderer for a document format — `akm health` does, for its per-run and
  window-compare tables and its full HTML report — and anything unregistered
  falls back to a generic rendering derived from the envelope's own shape. No
  command emits one format's bytes when another was asked for, none rejects a
  format outright, and **no command reads `--format` to decide what data to
  fetch**: a registered renderer fires on the shape of the result (`akm health
  --report` carries the report dataset in the envelope, so the same data is
  available as JSON), never on the format alone.
  `--detail` is verbosity only (`brief|normal|full`);
  `--shape` (`human|agent|summary`) is the output-projection axis (see
  Experimental). A small set of commands is **format-exempt** because their
  output is not a result envelope at all: `completions` (shell script source),
  child-process passthrough in `env run` / `secret run` / `migrate` (`status`
  and `apply` both spawn the
  standalone `akm-migrate` tool), a bare-path payload from `env path`, and
  document payloads from `workflow template` / `help migrate` / `hints`. The
  set is declared in
  `src/output/format-exempt.ts`, and
  passing `--format` to one of them warns rather than silently doing something
  else. Scripted `setup` modes emit a normal format-aware result; interactive
  `setup` is a terminal UI and emits no result document. `agent` leaves
  inherited child streams raw and formats its final result envelope. `akm graph
  export` has no local `--format`: the artifact payload
  follows the `--out` extension (`.jsonl` writes JSONL, anything else JSON),
  and the global flag only renders the command's own envelope.

  | Exit code | Meaning |
  | --- | --- |
  | `0` | Success |
  | `1` | Not found / command-reported failure |
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
  options or tighten validation across releases. `akm improve` stays on by
  default and is **review-first**: the lanes that mutate assets without review
  require `experimental.improveAutonomy` — see
  [`akm improve` autonomy](#akm-improve-autonomy--opt-in-in-090).
  `--auto-accept` was removed in 0.9.0. It is now accepted-and-warned rather
  than silently absorbed: passing it prints a deprecation warning naming the
  replacement, and the space-separated form (`--auto-accept 90`) no longer
  poisons the asset-type positional — its value is discarded with a second
  warning instead of silently reducing the run to a zero-match no-op. It
  becomes a hard error in 0.10. The replacement is
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
- **Registries** — `akm registry {list,add,remove,search}`. Building a registry
  index is maintainer tooling (Internal) and lives outside the CLI, in
  `scripts/build-registry-index.ts`.
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
  report`) and `akm workflow watch`. Requires the `experimental.workflowEngine`
  opt-in — see [below](#akm-workflow-engine--opt-in-in-090). The YAML format,
  its schema, the flags, and all JSON output shapes may change. Classic **linear markdown
  workflows are unchanged and stable**, as is the workflow CLI contract
  (`start` / `next` / `complete` / `status` / `list` / `create` / `validate` /
  `template` / `resume` / `abandon`) — none of that is gated.

### `akm workflow` engine — opt-in in 0.9.0

**The native workflow engine requires an explicit opt-in in 0.9.0.** Classic
linear markdown workflows — `start` / `next` / `complete` / `status` / `list` /
`create` (markdown, the default) / `template` / `validate` / `resume` /
`abandon` — are unaffected and ship unconditionally, exactly as before. The
engine-execution surface is gated:

```sh
akm config set experimental.workflowEngine true
```

Without it, these refuse OUTRIGHT rather than degrading — unlike the improve
autonomy gate below, a workflow step either executes or it does not, so there
is no partial-execution fallback to downgrade into:

| Surface | What it does when enabled |
| --- | --- |
| `akm workflow run` | Executes a run's steps with the native engine, dispatching each step's units to the configured runner |
| `akm workflow brief` | Read-only half of the harness-neutral driver protocol |
| `akm workflow report` | Mutating half of the harness-neutral driver protocol |
| `akm workflow watch` | Streams a run's `workflow_*` events |
| `akm workflow create <name>.yaml` | Authors a YAML (`version: 2`) workflow *program* — the format the engine executes |

Each refusal is a classified `ConfigError` (`WORKFLOW_ENGINE_NOT_ENABLED`, exit
78) naming the exact surface and config key — never a silent no-op — and `akm
tasks doctor` reports the gate's state under `workflowEngine.enabled` /
`workflowEngine.configKey`. `akm workflow validate` is unaffected even against
a `.yaml` program file: it type-checks the file without executing anything,
and creating a *markdown* workflow (the `create` default) is unaffected too.

The engine is never enabled by inference: an absent `experimental` section, an
absent key, and an explicit `false` all read as off.

### `akm improve` autonomy — opt-in in 0.9.0

**`akm improve` is review-first by default in 0.9.0.** The command itself is ON
— its schedules, reflect/distill proposals, and graph extraction all run — but
the lanes that mutate assets *without* review require an explicit opt-in:

```sh
akm config set experimental.improveAutonomy true
```

Without it, these three lanes are downgraded, and each downgrade is **reported,
not silent**: it warns on stderr naming the lane and the key, appends an
`improve_skipped` event with `reason: "autonomy_gated"`, is counted in
`akm health`'s improve skip-reason summary, and is listed by `akm tasks doctor`
under `improveAutonomy.gatedLanes` — which is where to look when a *scheduled*
run stops doing something it used to. `akm tasks doctor` also reports the
**effective** `improveTriage.applyMode`, so a `promote` strategy under a
review-first config correctly shows `queue`.

| Lane | What it does when enabled | With autonomy off |
| --- | --- | --- |
| `memoryInference` | Writes `.derived.md` children and rewrites parent frontmatter | disabled |
| memory cleanup | Belief-state frontmatter rewrites, archive moves | analyzed but not applied |
| `triage` `applyMode: "promote"` | Auto-accepts queued proposals into the stash | downgraded to `queue` — triage still runs, it just does not auto-accept |

Consolidation remains enabled with autonomy off because merge, delete, and
contradiction operations are advisory; promotion only emits a reviewable
proposal.

Because the gate is applied before the LLM preflight, a review-first workspace
also needs fewer engines configured: a strategy whose only model-backed process
is a gated lane resolves without an engine at all.

**Three direct writes are deliberately NOT gated**, because they are additive or
already independently controlled:

| Write | Why it stays ungated |
| --- | --- |
| `extract` session indexing | Additive `sessions/**` writes; nothing is overwritten or deleted |
| distill's encoding-salience stamp | Frontmatter metadata only |
| `sync.push` | Publishes already-committed content to a remote the user configured for that purpose, and has its own `improve.strategies.<name>.sync.push: false` and `--no-push` |

Autonomy is never inferred: an absent `experimental` section, an absent key, and
an explicit `false` all read as off, so a partially-written or older config is
review-first rather than accidentally permissive.

Reflect, distill, extract candidates, validation, proactive-maintenance
selection, and graph extraction are proposal-only and never write assets
directly. Two further direct writes are ungated by design: `extract`'s session
indexing (additive `sessions/**` writes,
`processes.extract.indexSessions`, default on) and distill's
encoding-salience frontmatter stamp (metadata only).

## Internal

Not public interfaces. Listed so you can recognize them, not so you can rely
on them.

- **Migration surfaces** — the standalone `akm-migrate` tool owns the one-time
  0.8→0.9 cutover, storage migration, and recovery backups (`akm-migrate
  backup` / `restore`). `akm migrate` is a thin process forwarder; `akm backup`
  and `akm config migrate` are removed. `akm help migrate <version>` is Stable
  and only renders release notes.
- **`bun scripts/build-registry-index.ts`** — maintainer tooling for building a
  registry index. It is a repository script, not a CLI command (the former
  `akm registry build-index` subcommand was removed).
- **Environment variables** — see the table below.

### Environment variables

**Supported** — documented interfaces; changes get a CHANGELOG note:

| Variable | Purpose |
| --- | --- |
| `AKM_STASH_DIR`, `AKM_CONFIG_DIR`, `AKM_DATA_DIR`, `AKM_CACHE_DIR` | Filesystem layout overrides |
| `AKM_LLM_API_KEY`, `AKM_EMBED_API_KEY`, `AKM_ENGINE_<NAME>_API_KEY` | Credential provision for `$VAR` config references |
| `AKM_LLM_ENDPOINT`, `AKM_LLM_BASE_URL` | Setup provider inference |
| `AKM_VERBOSE`, `AKM_DEBUG`, `AKM_NON_INTERACTIVE` | Diagnostics and CI behavior |
| `AKM_REGISTRY_URL` | akm registry mirror override |
| `AKM_NPM_REGISTRY` | npm mirror override — redirects BOTH the trusted-tarball host allowlist and package metadata lookups (`npm view`-equivalent resolution) to the given registry base, replacing `registry.npmjs.org` wholesale rather than merging with it |
| `AKM_SQLITE_JOURNAL_MODE` | SQLite journal mode (network filesystems) |
| `AKM_BIN` | Absolute `akm` path for scheduler registration |
| `AKM_INSTALL_DIR` | Install-script prefix |
| `AKM_FORCE_SETUP_TMP_STASH` | Documented escape hatch for intentional temp-directory stashes |
| `AKM_UPGRADE_SKIP_CHECKSUM` | Recovery hatch for a broken upgrade checksum |

**Internal** — no compatibility guarantee, may vanish without notice:
`AKM_NODE_ENTRY`, `AKM_EVENT_SOURCE`, `AKM_SESSION_ID`, `AKM_AGENT_HARNESS`,
`AKM_EMBED_DETERMINISTIC`, `AKM_CLAUDE_PROJECTS_DIR`,
`AKM_FORCE_INIT_TMP_STASH`, `AKM_STATE_DIR`.

Anything matching `AKM_TEST_*` is test-only fault injection. Never set it.
`AKM_VERSION` is the only variable actually stripped from release builds, via
`bun build --define` (see `.github/workflows/release.yml`); no `src/` code
reads an `AKM_TEST_*` variable, so the compiled `akm` binary itself carries
none. That said, three fault-injection hooks are NOT compiled out and DO ship
in every install: `AKM_TEST_MIGRATION_CRASH_AFTER`,
`AKM_TEST_MIGRATION_CRASH_GAP`, `AKM_TEST_MIGRATION_FAIL_WORKFLOW_DELETE`
(`scripts/akm-migrate/config-migrate.ts`,
`scripts/akm-migrate/migrate/legacy/three-db-cutover.ts`) — `akm
migrate`/`akm upgrade` dispatch to `scripts/akm-migrate.ts` as a separate,
unbundled Bun script (`src/commands/migration-tool.ts`) that ships as plain
TypeScript source in the npm package, outside the `--compile`/`--define`
binary build. At rest they are runtime-guarded no-ops (`SIGKILL`/throw only
when the exact env value matches an internal phase name), but they are
physically present, not stripped. Never set them.

## On the horizon

These changes are planned and will land in a known future release. They
are not part of the current stability contract; you should plan migrations
around them.

**The 0.9.0 decision record is fully shipped.** The
[decision record](./docs/architecture/specs/0.9.0-decisions.md) settles a set of
breaking changes; every one of them is now in the code, and each decision
carries its own shipped status.

Shipped from that record: **D1** (`#fragment` section selection),
**D2** (the `akm show <ref> toc|section|lines|frontmatter|full` view grammar is
gone — `#fragment` is the only section selector), **D4** (conceptId /
`bundle//` prefix browse), **D5** (`akm bundle` removed), **D6** (open `type`
set at runtime), **D7** (all six `--format` values everywhere), **D8** (the
`experimental.improveAutonomy` gate), **D9** (`--auto-accept` warn-and-ignore),
and partially **D10** (an `akm-migrate` binary now exists, though the code still
lives in this repo). **D3** is not on this list: `akm mv` ships in 0.9.0 as an
Experimental surface (see the Renames bullet above), and no removal is planned.

- **0.10 — migration extraction.** The migration machinery leaves the CLI for
  a separately published `akm-migrate` package (see Internal above).
- **0.10 — `--auto-accept` hard error.** It is currently accepted-and-warned;
  see the Improvement loop entry.
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
