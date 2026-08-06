# Bundle Types

akm doesn't only manage its own asset library — it can point at directories
that already follow a *different* convention (a Claude Code project, an OKF
knowledge base, a Karpathy-style LLM wiki, …) and index, search, and validate
them in place. A directory akm indexes is a **bundle**; the code that decides
what a bundle's files *are*, how they're indexed, how `akm lint` validates
them, and where a new item would be placed is a **`BundleAdapter`**
(`src/core/adapter/bundle-adapter.ts`). 0.9.0 ships 11 built-in adapters,
covering every bundle type this page documents.

This page is the type-by-type detail doc. For a quick scannable summary, see
the [README](https://github.com/itlackey/akm/blob/main/README.md#bundle-types);
for sources, registries, refs, and the mental model these formats sit inside,
see [Concepts](https://github.com/itlackey/akm/blob/main/docs/guides/concepts.md).

> **Stability note.** The adapter set, bundle-recognition rules, and the
> `bundles` config shape are still evolving — see
> [STABILITY.md](../../STABILITY.md).

## How akm picks an adapter for a bundle

Each bundle root is owned by exactly **one** adapter, decided once at
install/index time:

1. If the bundle's config entry sets `components.<id>.adapter` explicitly,
   that adapter wins — no detection runs.
2. Otherwise, every built-in adapter's `looksLikeRoot(root)` probe runs in a
   **fixed order**, most-specific markers first (a website snapshot's
   `manifest.json`, a Claude tool dir's `CLAUDE.md`, …), down to the loosest,
   most portable probes (`akm`, then `okf`) last. The first probe that
   returns `true` claims the root.
3. If no probe fires, the bundle falls back to the `akm` adapter.

The sections below are ordered exactly as the probes run
(`src/core/adapter/adapters/index.ts`).

## Read vs. write in 0.9.0

0.9.0 is a **read-and-validate** refactor first. Every adapter defines
`recognize()` (what a file *is*) and `validate()` (what `akm lint` checks),
and most also define `placeNew()` (where a new item of that format would
live) — but **nothing in the write path calls `placeNew()` yet**: AKM-native
writes still route through akm's own flat type→directory placement table.
That wiring is deferred to 0.10 ([D12](https://github.com/itlackey/akm/blob/main/docs/architecture/specs/0.9.0-decisions.md#d12--bundleadapterplacenew-stays-unwired-until-010)).

Separately — and this is the part that actually determines whether
`akm remember`, `akm import`, `proposal accept`, etc. can write into a given
bundle today — every AKM-native write command checks the target bundle's
adapter id against a small allowlist before touching the filesystem
(`assertAkmAssetWrite`, `src/core/write-source.ts`). The default allowlist is
`["akm"]`; two commands widen it:

- `akm env create` / `env remove` / `secret set` also allow `dotenv`.
- `akm workflow create` also allows `akm-workflow`.

Every other adapter — including ones that implement `placeNew()` — is
rejected by every AKM-native write command in 0.9.0. Reading, searching, and
`akm lint` are unaffected; only creating/editing/deleting through akm's own
commands is restricted. "Read-only" below means this write-command
restriction, not a filesystem permission.

## Quick reference

| Adapter | Format | Write commands reach it? |
| --- | --- | --- |
| [`website-snapshot`](#website-snapshot) | A crawled website snapshot | No |
| [`agent-skills`](#agent-skills) | A collection of standalone Agent Skills packages | No |
| [`claude`](#claude) | A Claude Code `.claude` tool directory | No |
| [`opencode`](#opencode) | An OpenCode `.opencode` tool directory | No |
| [`dotenv`](#dotenv) | An env/secrets-only bundle | Yes — `env`/`secret` commands only |
| [`akm-workflow`](#akm-workflow) | A standalone workflow bundle | Yes — `akm workflow create` only |
| [`akm-task`](#akm-task) | A standalone scheduled-task bundle | No |
| [`llm-wiki`](#llm-wiki) | A Karpathy-style LLM wiki (`schema.md` + `raw/` + `pages/`) | No |
| [`akm`](#akm) | akm's own native workspace (14 asset types) | Yes — every write command |
| [`okf`](#okf) | Open Knowledge Format — plain markdown, `type` from frontmatter | No |
| [`generic-files`](#generic-files) | Catch-all fallback, classified by extension | No |

## `website-snapshot`

**Format.** A materialized website crawl produced by `akm bundle add
<url>`. Pages are plain knowledge-shaped markdown written under
`stash/knowledge/**` (no `type:` frontmatter field); a `manifest.json` at
the bundle root records crawl provenance (`{url, fetchedAt}`).

**Detected by.** A root `manifest.json` whose JSON carries string `url` and
`fetchedAt` fields. Checked first — no other format uses this marker.

**conceptId / ref.** Strips the `stash/knowledge/` prefix and `.md`
extension: `stash/knowledge/guide/intro.md` → conceptId `guide/intro`, ref
`bundle//guide/intro`.

**Indexed.** Only pages carrying a `website` tag or a `sourceUrl`
frontmatter field are recognized (re-typed to `type: website`); a page under
`stash/knowledge/` with neither is not recognized by this adapter and so is
not indexed at all (a root has exactly one adapter). Recognized pages
surface `name` (frontmatter `title`, falling back to the path's last
segment), `description`, the full body (bounded to 100k chars), and the
original crawl URL (`documentJson.sourceRef`).

**Validation.** Shared base checks only (unquoted-colon, stale-path,
missing-ref) — `missing-updated` is filtered out defensively. (Note: the
snapshot writer does stamp `updated:` on every crawled page, so the filter
is belt-and-braces rather than a response to a missing field.)

**Read/write (0.9.0).** Read-only. No `placeNew` — refreshing a snapshot
re-crawls and rewrites the markdown outside the adapter layer entirely.

**Caveats.** `manifest.json` itself is provenance, never indexed as a
concept.

## `agent-skills`

**Format.** A flat collection of standalone Agent Skills packages (the
[github.com/anthropics/skills](https://github.com/anthropics/skills)
layout) — one `<name>/SKILL.md` per package directly under the bundle root,
optionally with bundled resource files alongside it.

**Detected by.** At least one direct child directory of the root containing
a `SKILL.md`. Only the install-time probe is depth-limited — once the
bundle is claimed, any path ending in `/SKILL.md` is recognized as a
package, at any depth.

**conceptId / ref.** The package directory path, e.g. `pdf-processing` →
ref `bundle//pdf-processing`. Files other than `SKILL.md` inside the
package (bundled resources) are part of that one item, not separate
concepts.

**Indexed.** Type `skill`; `name` from frontmatter `name` (projected
as-is, even when invalid, so it stays inspectable), `description`, `tags`,
and the body (bounded).

**Validation.** The full Agent Skills contract: `skill-name-invalid` (NFKC,
1-64 chars, `^[a-z0-9]+(-[a-z0-9]+)*$`, no `anthropic`/`claude` substring,
must equal the parent directory name) and `skill-description-too-long`
(description must be 1-1024 chars). **`missing-skill-md` is not reachable
here**: `validate()` only inspects changes that resolve to an actual
`SKILL.md`, so a package directory with no manifest at all is never
flagged (the adapter's own comment defers this to a directory-scanning
helper that does not exist). Recognition and validation are decoupled — an invalid
skill is still indexed as `skill` (with its raw, invalid name projected);
the violation only surfaces in `akm lint`.

**Read/write (0.9.0).** `placeNew` is implemented (`<conceptId>/SKILL.md`),
but write commands don't reach it — see
[Read vs. write in 0.9.0](#read-vs-write-in-090).

**Caveats.** Shares its SKILL.md codec with `claude`/`opencode`, but here
the package sits directly at the bundle root (no `skills/` prefix).

## `claude`

**Format.** A Claude Code `.claude` tool directory: a root `CLAUDE.md`
plus `commands/`, `agents/`, and/or `skills/<name>/SKILL.md`.

**Detected by.** A root `CLAUDE.md` AND at least one of `commands/`,
`agents/`, `skills/`. Runs ahead of the native `akm` probe so a `.claude`
root — whose subdirectory names happen to match akm's own stash
subdirectories — isn't misclassified.

**conceptId / ref.** Root `CLAUDE.md` → conceptId `CLAUDE` (type
`instruction`); `commands/<name>.md` → `commands/<name>` (type `command`);
`agents/<name>.md` → `agents/<name>` (type `agent`);
`skills/<name>/SKILL.md` → `skills/<name>` (type `skill`, item = the
directory). `settings.json` / `.mcp.json` runtime config is not recognized.

**Indexed.** `name`, `description`, `tags` where the file's frontmatter
carries them, plus the body (bounded).

**Validation.** Lenient — tolerates the tool's native frontmatter
(`argument-hint`, `allowed-tools`, `model`, …). A `command`/`agent` file
only gets `missing-name-or-type` when it has *neither* a name/description
*nor* a type-shaped signal — but the signal escape applies to `command`
files only (a body using `$ARGUMENTS`/`$1`, or an `agent` frontmatter key).
An `agent` file gets no signal-based escape: it is flagged unless its
frontmatter carries a `name` or `description`. `skill` gets a
`missing-skill-md` directory check, which fires only for the canonical
plural `skills/` directory. The root instruction
file runs the shared base checks (a no-op on a frontmatter-free
`CLAUDE.md`). No `missing-updated` check runs on command/agent/skill files
— their native frontmatter never carries `updated`.

**Read/write (0.9.0).** `placeNew` is implemented (writes normalize to the
canonical plural directory names), but write commands don't reach it — see
[Read vs. write in 0.9.0](#read-vs-write-in-090).

**Caveats.** Shares its whole recognition/placement/validation codec with
`opencode` (`src/core/adapter/adapters/tool-dir-shared.ts`) — the two
differ only in instruction filename, accepted subdirectory spellings, and
adapter/component ids.

## `opencode`

**Format.** An OpenCode `.opencode` tool directory: a root `AGENTS.md`
plus `commands/`/`agents/`/`skills/` — the singular `command/`/`agent/`/
`skill/` spellings are also accepted on read as backwards-compatible
aliases — or an `opencode.json`/`opencode.jsonc` config file.

**Detected by.** `opencode.json`/`opencode.jsonc` alone, OR a root
`AGENTS.md` plus at least one tool directory (either spelling). Runs ahead
of `akm` for the same reason as `claude`.

**conceptId / ref.** Same scheme as `claude`, with `AGENTS` as the root
instruction conceptId. A file found under a singular alias directory keeps
the on-disk spelling in its conceptId (e.g. `command/legacy`); new writes
always normalize to the canonical plural.

**Indexed / Validation.** Same rules as `claude` — see that section; both
share `tool-dir-shared.ts`. One divergence: the `missing-skill-md` check
matches the literal `skills/` segment, so a skill package under opencode's
singular `skill/` alias is never checked for a missing manifest, while the
same package under `skills/` is.

**Read/write (0.9.0).** Same as `claude`: `placeNew` implemented, not
reachable by write commands.

**Caveats.** Same as `claude`, plus the singular/plural alias duplication
on read.

## `dotenv`

**Format.** A bundle containing only `env/` (whole `.env` files) and/or
`secrets/` (single sensitive-value files) — no other content directories.

**Detected by.** Every top-level directory in the root is `env/` and/or
`secrets/`, with at least one present. Runs ahead of `akm` — a full akm
workspace also has `env/`/`secrets/`, but alongside many other
directories, so a *dedicated* env/secrets bundle is claimed here first.

**conceptId / ref.** `env/<name>.env` → `env/<name>` (`.env` extension
stripped, e.g. `env/app.env` → `env/app`); any file under `secrets/` other
than `.lock`/`.sensitive` control files, which are skipped entirely →
`secrets/<natural-path>` (extension kept, e.g. `secrets/ci.env` stays a
*secret* — the directory gate wins over the `.env` suffix).

**Indexed.** Redaction is a hard, adapter-level contract that no
frontmatter `type:` override can bypass: `env` entries surface only their
KEY NAMES (via `hints`), never values, comments, or raw content; `secret`
entries surface only the file NAME, never any content. A `.env` file
placed under `secrets/` is a secret (name-only), not an env group.

**Validation.** The dangerous-key scan (`dangerous-env-key`) — flags 41
known process-hijacking key names (`LD_PRELOAD`, `PATH`, `NODE_OPTIONS`,
…) plus two regex families, scoped to `.env`-suffixed files only (a bare
`secrets/<name>` file is never scanned, since its whole content is one
opaque value).

**Read/write (0.9.0).** Writable, narrowly: `akm env create`/`env
remove`/`secret set` explicitly widen the write allowlist to include
`dotenv` — one of only two non-`akm` adapters any AKM-native write command
can reach in 0.9.0 (the other is `akm-workflow`). The general write
commands (`remember`, `import`, proposal-accept) still cannot target it.

**Caveats.** None beyond the command scoping above.

## `akm-workflow`

**Format.** A native akm workflow bundle: any `.md` file whose frontmatter
graph and `## <step-id>` body sections follow the unified workflow format,
one workflow per file.

**Detected by.** A top-level `.md` file with **explicit** `type: workflow`
frontmatter (a plain untyped `.md` isn't enough at install time, so an
OKF/llm-wiki root with an incidental root markdown file isn't
misclassified). Once a root is claimed, recognition is lenient: any `.md`
under the bundle *is* a workflow unless its frontmatter declares a
different, non-empty `type:` (an explicit opt-out) or it's the reserved
`README.md`.

**conceptId / ref.** File path minus `.md`, e.g. `release.md` → conceptId
`release`.

**Indexed.** `name`, `description`, `tags`, and the step-instruction body
(bounded).

**Validation.** Shared base checks plus the workflow-specific checks:
`placeholder-stub` (scaffold placeholder text left in place) and
`invalid-workflow-structure` (the file fails to parse/compile through the
unified workflow frontend).

**Read/write (0.9.0).** Writable for authoring: `akm workflow create`
explicitly widens the write allowlist to include `akm-workflow` — the
second of the two non-`akm` adapters reachable by an AKM-native write
command. `placeNew` is also implemented. The general write commands
(`remember`, `import`, proposal-accept) still cannot target it.

**Caveats.** None beyond the command scoping above.

## `akm-task`

**Format.** A native akm task bundle: `.yml` files, each pairing a
`schedule` with exactly one target (`prompt` XOR `workflow` XOR
`command`). Once the bundle is claimed, tasks are recognized at any depth,
not only at the root.

**Detected by.** A *top-level* `.yml` file that parses with a non-empty
`schedule` key — the install-time probe does not recurse, even though
recognition afterwards does.

**conceptId / ref.** File path minus `.yml`, e.g. `nightly-index.yml` →
conceptId `nightly-index`.

**Indexed.** Type `task`; `name`; the full raw YAML content (bounded).

**Validation.** `invalid-task-yaml` — requires `version: 2`, a `schedule`,
and *exactly one* target. This is stricter than the native `akm` adapter's
task check, which only requires "at least one" target.

**Read/write (0.9.0).** `placeNew` is implemented (`<conceptId>.yml`), but
`akm task add` uses the default write allowlist (`akm` only), so a
standalone `akm-task` bundle is read-only through AKM-native write
commands.

**Caveats.** None beyond the general placeNew-not-wired note above.

## `llm-wiki`

**Format.** [Andrej Karpathy's LLM-wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f):
a `schema.md` rulebook at the root, immutable ingested sources under
`raw/`, and agent-authored pages under `pages/`.

**Detected by.** A root `schema.md` AND a `pages/` directory, both
present.

**conceptId / ref.** `raw/<slug>.md` → `raw/<slug>` (type `wiki-source`);
`pages/<path>.md` → `pages/<path>` (type = frontmatter `pageKind`, default
`note`). `schema.md`/`index.md`/`log.md` at the wiki root are reserved and
never indexed; anything outside `raw/`/`pages/` is not recognized.

**Indexed.** `name`, `description`, the body (bounded). A page's `links` =
its resolved `xrefs:` frontmatter plus body markdown links (deduped); its
cited `sources:` (raw conceptIds) and `wikiRole` ride `documentJson`.

**Validation.** Native wiki checks only: `broken-xref` (a same-wiki
cross-reference target that doesn't resolve to an existing page —
non-blocking), `uncited-raw` (a `raw/` source no page cites),
`missing-description` (a page with no frontmatter description),
`broken-source` (a page's `sources:` entry pointing at a non-existent raw
file). The shared base checks do not run — wiki files never carry
`updated`.

**Read/write (0.9.0).** Consumer/read-only, like `okf`. `placeNew` is
implemented on the interface, but AKM-native write commands
(`remember`/`import`/proposal-accept) reject an `llm-wiki` target before
they reach it — the same write-allowlist rejection as `okf`, unrelated to
the general placeNew-wiring deferral. Author pages the way the pattern
intends: your agent writes directly into `pages/`, and akm indexes and
serves the result.

**Caveats.** `akm lint` still runs against a wiki bundle, dispatching to
this adapter's own checks rather than a generic subdirectory scan. See
[Wikis](https://github.com/itlackey/akm/blob/main/docs/guides/wikis.md) for
the authoring workflow.

## `akm`

**Format.** akm's own native workspace — a directory of typed
subdirectories: `skills/`, `commands/`, `agents/`, `knowledge/`,
`instructions/`, `env/`, `secrets/`, `workflows/`, `lessons/`,
`memories/`, `tasks/`, `sessions/`, `facts/`, `scripts/`. This is also the
**fallback** adapter when no other probe claims a root.

**Detected by.** A `.stash` marker directory, OR two or more native stash
subdirectories present, OR exactly one native subdirectory whose *first*
markdown file (by directory-listing order — only one file is sampled)
carries no `type:` frontmatter, or declares the matching type. Runs
after `llm-wiki` but before `okf` among the native/portable probes — AKM
markdown is a superset of OKF, so native evidence wins before falling back
to the looser OKF baseline.

**conceptId / ref.** `<stash-subdir>/<canonical-name>`, e.g.
`knowledge/http-caching`, `workflows/release`, `skills/<dir>`, `env/prod`,
`secrets/deploy-token`.

**Indexed — the 14 native asset types.**

| Type | What it is | What the agent gets | Example ref |
| --- | --- | --- | --- |
| **script** | Executable code or shell automation | A `run` command and optional `setup`/`cwd` | `scripts/deploy.sh` |
| **skill** | A set of instructions (directory + `SKILL.md`) | Step-by-step guidance the agent follows | `skills/code-review` |
| **command** | A prompt template | A template with placeholders to fill in | `commands/summarize` |
| **agent** | An agent definition | A system prompt, model hint, and tool policy | `agents/reviewer` |
| **knowledge** | A reference document | Navigable content with TOC and section views | `knowledge/api-guide` |
| **instruction** | Project guidance | Instructions an agent should follow in the project | `instructions/repository` |
| **env** | A `.env` file of related configuration for an app/service | Key names and comments, never values — a group of related settings. Inject via `akm env run <ref> -- <cmd>` | `env/prod` |
| **secret** | A single sensitive value for authentication (token, key, cert) | Name only — the whole file is the value and never appears in output. Access via `akm secret run` | `secrets/deploy-token` |
| **workflow** | A unified Markdown/frontmatter multi-step procedure | Parsed steps, completion criteria, and resumable run state | `workflows/ship-release` |
| **lesson** | A distilled feedback lesson | `when_to_use` guidance plus the lesson body | `lessons/prefer-dry-run` |
| **memory** | Context from a previous session or external system | Background information the agent should consider | `memories/vpn-note` |
| **fact** | A durable bundle-level fact | Mostly-static semantic knowledge — identity, conventions, bundle-meta. `category` scopes it; `pinned: true` marks always-injected core context | `facts/team/tool-stack` |
| **task** | A scheduled or on-demand automation task | Stored under `tasks/`, version-2 YAML | `tasks/nightly-review` |
| **session** | An indexed session summary | Machine-placed under `sessions/<harness>/<id>.md`; excluded from untyped search by default | `sessions/claude/session-id` |

Each type maps to its stash subdirectory through
`src/core/asset/asset-placement.ts`'s `PLACEMENT_SPECS` map — the single
source of truth this table is generated from. Classification is by file
shape, not directory name: scripts/knowledge are classified by *what they
are* (extension/content), commands/agents by *how an LLM should use them*
(frontmatter shape), skills by packaging convention (a `SKILL.md`
directory). See [Classification](https://github.com/itlackey/akm/blob/main/docs/architecture/internals/classification.md)
for the full specificity-based matching system.

**Validation.** Shared base checks (unquoted-colon, missing-updated,
stale-path, missing-ref, plus the `xrefs`/`supersededBy`/`contradictedBy`
frontmatter ref channels) plus per-type extra checks: `command`/`agent` →
missing-name-or-type; `fact` → missing-category; `task` →
invalid-task-yaml (at least one target); `workflow` → placeholder-stub +
invalid-workflow-structure; `memory` → orphaned-stub; `skill` →
missing-skill-md; `env`/`secret` → dangerous-env-key, which only scans
files whose name ends in `.env` (a bare `secrets/<name>` file with no
`.env` suffix is not scanned). `knowledge` / `lesson` / `script` /
`session` get base checks only.

**Read/write (0.9.0).** Fully writable — the only adapter every AKM-native
write command's default allowlist admits (`akm remember`, `akm import`,
`proposal accept`, `akm task add`, `akm workflow create`, `akm env
create`, `akm secret set`, …).

**Caveats.** `index.md`/`log.md` are reserved structural files at any
depth — never indexed as concepts, never valid write targets.

## `okf`

**Format.** The [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) —
plain markdown with `type` read from frontmatter; the directory a file
sits in never affects its type. This is the portable baseline every other
markdown-based adapter is a superset of.

**Detected by.** A root `index.md`, or — absent that — at least one `.md`
file anywhere under the root carrying a non-empty frontmatter `type`. Runs
last of all probes, since it's the least specific.

**conceptId / ref.** File path minus `.md`, anywhere under the root — no
directory gate.

**Indexed.** `type` from frontmatter (defaults to `knowledge` when
absent); `name` from frontmatter `title` (fallback: the path's last
segment); `description`; `tags`; both OKF link forms (`/`-rooted
bundle-relative and standard relative) resolved into `links`; the v0.2
trust/provenance family (`generated`/`verified`/`sources`/`status`/
`stale_after`/`okf_version`) when present; the document body (bounded to
100,000 chars) as full-text content; any other frontmatter rides
`documentJson`.

**Validation.** Lenient *in wording*, not in gating: base checks (minus the
AKM-specific `updated` expectation), plus `missing-type` (labelled `info:`
in the diagnostic text — the type defaults to `knowledge`) and broken OKF
links (labelled `warning:`). Those labels are free text inside the
diagnostic's detail, **not** a severity tier: diagnostics carry no severity
field, `akm lint` funnels every adapter finding into one `flagged` list,
and `--fail-on-flagged` fails on any non-empty list. A bundle whose only
finding is a missing `type:` will fail a CI gate exactly like any other.

**Read/write (0.9.0).** Consumer/read-only. No `placeNew`. AKM-native
write commands reject an `okf` target via the shared write allowlist
before any adapter method runs.

**Caveats.** `index.md`/`log.md` reserved everywhere, same as `akm` and
`llm-wiki`.

## `generic-files`

**Format.** The catch-all fallback for anything else, classified purely
by extension: a recognized script extension → `script` (conceptId keeps
the extension); markdown/plain-text (`.md`, `.markdown`, `.txt`, `.text`)
→ `document` (conceptId strips the extension); everything else → `file`
(conceptId keeps the extension).

**Detected by.** Nothing — `looksLikeRoot` always returns `false`. A
bundle only gets this adapter through an explicit config override:
`components.<id>.adapter: "generic-files"` on its config entry (the same
mechanism that lets you pin any bundle to any adapter id).

**conceptId / ref.** Identity-based, per the classify rule above, e.g.
`build.sh` (script, kept), `notes.md` → `notes` (document, stripped),
`data.csv` (file, kept).

**Indexed.** `name` — always the conceptId's last path segment, never read
from frontmatter; `description` and `tags` where the file's frontmatter
carries them; and the body (bounded; a leading `---` frontmatter block is
stripped when present, for every classified type — script files simply
don't usually have one).

**Validation.** Base checks only — no type-specific validators.

**Read/write (0.9.0).** `placeNew` is implemented (identity placement;
`document` appends `.md`), but write commands don't reach it — see
[Read vs. write in 0.9.0](#read-vs-write-in-090).

**Caveats.** Same reserved-file exclusion as the native formats
(`index.md`/`log.md` never indexed).
