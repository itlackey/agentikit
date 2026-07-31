# AKM 0.9.0 — Bundle Adapter Specification

**Status:** binding implementation spec, reconciled with `akm-format-neutral-bundle-workspace-spec.md` **v0.3** (the normative RFC, amended in place — the two documents agree; where wording differs the normative spec governs) and `akm-architecture-decision-history.md` (decision register, D1–D30). This doc is the concrete *how* for the adapter/index/ref core; it **defers to the normative spec** for activation (§18, Tier A staging), improve (§24), and memory (§25, deferred) rather than duplicate them. Grounded in code at HEAD as `file:line`, or **NEW** with the mandate. Amended 2026-07-13/14 after the review passes: adapter contract is recognize-required/index-optional over a core-owned walk; index persistence is a diff keyed on ref; query-time ranking/filter signals are first-class `IndexDocument` fields; `validate` receives a snapshot+overlay context; adapter selection has a deterministic probe order; native links do not feed the graph boost; `KNOWN_TYPES`-typed presentation tables; bindings Tier A / memory deferred / no new trust machinery (deviation §4.3a–3c).

**Reconciliation decisions applied (maintainer, 2026-07-13)** — resolving the plan/spec deviations:

1. **OKF is the first-class Markdown baseline (DEV-1).** Every applicable conformance case passes. The built-in `okf` adapter provides generic path identity, open type, content, links, and heading fragments. AKM-authored Markdown is an OKF-compatible superset; native adapters progressively add behavior. Non-Markdown Claude/OpenCode/Agent-Skills/workflow/task/env formats retain native serialization. The normalized `type` field is open and **MAY** drive adapter-owned presentation/ranking/filtering but **MUST NOT** authorize execution, grant runtime authority, be part of identity, or select the core storage/write path.
2. **Ref = adapter-owned concept ID + optional `bundle//` prefix (DEV-2).** Identity is the concept ID produced by the selected adapter; the workspace-qualified ref prepends an optional `<bundle>//`. Component is **absorbed into the path**, not a separate ref segment.
3. **Final scope (2026-07-14 refinements, deviation §4.3a–3c — supersede the earlier "DEV-3/4/5 restore full"):** the third `consolidate` verb is IN SCOPE as vocabulary (DEV-5); **bindings ship at Tier A only** (consolidation of existing install≠activation enforcement into one activation-policy point; the persisted `Binding` record, digests, rebind, and bind CLI are Tier B, deferred indefinitely); **the memory lifecycle is deferred entirely** (0.9.0 = consolidate decomposition with behavior preserved); **no new trust/approval machinery ships**. Retained simplifications: renderer/action as a **data table** typed over `KNOWN_TYPES`, and adapter facets expressed as **optional methods** on one interface (History §8.3), not a rigid `extends` hierarchy.
4. **LLM Wiki adapter restored (DEV-7).** The `wiki` *asset type* dies; the **LLM Wiki adapter** is a first-class built-in owning `schema.md`/`index.md`/`log.md`/raw/pages/citations/xrefs/ingest.

**Amendment (v0.4, 2026-07-21 — owner ruling).** Two §1.2 resolution steps are removed and one dispatch behavior is confirmed shipped: (a) the `akm.bundle.yaml` **manifest** step is removed entirely (it was never implemented and should never have been approved); (b) **sub-mount registration** is replaced by **adapter-owned file processing** — one bundle = one component = one adapter, and that adapter's `recognize` claims/abstains on its bundle's files and subdirectories as it sees fit (the core provides the walk and persistence). The consequent multi-component machinery (nested-root subtraction §9.3, cross-component collisions, manifest `exports:`) no longer applies to 0.9.0. (c) Adapter **dispatch is live**: the indexer's per-directory drain resolves `adapterForId(component.adapter)` and skips a component whose adapter id is unknown with a warning (§4).

---

## 0. OKF: first-class format support in a format-neutral kernel

OKF v0.1 (Google Cloud, June 2026 — [SPEC](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)) defines a bundle as a directory tree of markdown "concept" files (`--- frontmatter ---` + body) where **the file path is the concept's identity** and the only required field is an open **`type`**. AKM supports that format directly through the built-in `okf` adapter. An OKF bundle indexes without conversion. OKF is the generic Markdown behavior floor, not AKM's database representation or a serialization imposed on non-Markdown formats.

**v0.2 update (#730):** upstream OKF minor-versioned to v0.2, adding a trust/
provenance frontmatter family (`generated`/`verified`/`sources`), a lifecycle
family (`status`/`stale_after`), and an actor convention
(`<producer>/<version>` / `human:<id>` / `process:<id>`), with one
breaking-with-fallback change: `timestamp` is superseded by `generated.at`,
and consumers are expected to fall back to `timestamp` when absent. The `okf`
adapter parses the full v0.2 family (§0.1 below); it remains **consumer-only**
— see `okf-support.md`'s v0.2 note for the read/write split and the
namespacing rationale (`provenance`/`lifecycleStatus`/`staleAfter`/
`okfVersion`, chosen to avoid overloading the three AKM-native fields that
already occupy adjacent names: `sources?: string[]`, `generation?: number`,
`quality: "generated"`).

### 0.1 OKF support mapping

| OKF v0.1 | AKM | Note |
|---|---|---|
| Bundle = directory tree of markdown concepts | AKM bundle selected with `adapter: okf` (§5) | Other AKM bundles retain their native formats |
| **Concept ID** = file path − `.md` (`tables/users.md` → `tables/users`) | The `okf` adapter emits that concept ID; the ref adds an optional `<bundle>//` prefix (§1.3) | Other adapters define their own concept IDs |
| Required **`type`** (open string) | The `okf` adapter maps it to AKM's open indexed `type` field | Other adapters derive `type` from native semantics |
| **`title`** | `name` (FTS 10) — read `title` first; write `title` | OKF-compat output |
| **`description`** | `description` (FTS 5) | direct |
| **`tags`** | `tags` (FTS 3) | direct |
| Optional **`timestamp`** (v0.1) | `updated` when present | absence is not an AKM freshness error; v0.2's `generated.at` takes precedence when present (see below) |
| **`resource`** (URI) | provenance (`sourceRef`) | carried |
| Reserved **`index.md`**/**`log.md`** | reserved, not indexed as concepts (§5) | |
| bundle-relative links = relationship | deterministic native link graph (§9) | replaces LLM graph extraction for OKF content |
| **`okf_version`** | `IndexDocument.okfVersion` | Upstream declares it only on a bundle-root `index.md` (never indexed as a concept); read defensively from any concept's frontmatter, best-effort |
| consumers MUST tolerate unknown fields + broken links | `okf` adapter `validate` is **lenient** (§5) | interop guarantee |
| **`generated`** (v0.2: `{by, at}`) | `IndexDocument.updated` ← `generated.at` (precedence over `timestamp`); `IndexDocument.provenance.generatedBy`/`.generatedAt` | breaking-with-fallback: `timestamp` remains a valid legacy reading when `generated`/`generated.at` is absent |
| **`verified`** (v0.2: a list, or a single mapping without the list dash) | `IndexDocument.provenance.verified: Array<{by, at?}>` | both forms normalize to a non-empty array; a malformed entry is dropped, never rejecting the document |
| **`sources`** (v0.2: object list — `resource` required, `id`/`title`/`author`/`usage_count`/`last_modified` optional) | `IndexDocument.provenance.sources` | NAMESPACED — landed under `provenance.sources`, never the bare `IndexDocument.sources: string[]` field (wiki citation strings; a naive fold would silently drop every object entry as non-string) |
| **`status`** (v0.2: `draft`\|`stable`\|`deprecated`) | `IndexDocument.lifecycleStatus` | strict whitelist; any other value is left unset, never guessed at |
| **`stale_after`** (v0.2: `YYYY-MM-DD`) | `IndexDocument.staleAfter` | read verbatim; read-only in 0.9.0 — no re-verification/trust-tier ranking is driven off it (0.9.x improve-tuning track) |
| AKM-native writes (proposal-path provenance stamping, D2) | `promoteProposal` stamps `generated`/`verified` BARE at the top level (OKF v0.2's own spelling) and `sources` alone NAMESPACED as `provenance: {sources}` (avoids the wiki-citation-string collision) onto accepted AKM-native assets — same `IndexDocument.provenance` shape either way | write-only path is proposal-mediated, never through the `okf` adapter (which stays consumer-only); projects the proposals system's own `source`/`sourceRun`/`gateDecision`/`review` provenance and `evidenceSources`; every AKM-native markdown type is stamped, `workflow` included (its closed frontmatter allowlist admits these keys) |

### 0.2 The clean taxonomy — identity / type / adapter / component

The old `AkmAssetType` conflated five roles (source selection, classification, naming, routing, state keys — History §4.4); 0.9.0 separates them:

| Concept | Is | Source | Role | NOT |
|---|---|---|---|---|
| **identity** | the one name of an item | adapter-owned concept ID; ref `[<bundle>//]<concept-id>` (§1.3) | refs, addressing, links, state keys | not type/adapter/component |
| **`type`** | open descriptive label | supplied by the selected adapter | presentation, ranking, filtering | not identity; not an adapter; **never execution authority**; not a core storage switch |
| **adapter** | native format-family owner | static id, one per component root | recognize / place / validate; optional authoring/export/memory methods | not a type; never competes per-file |
| **component** | a materialized root under one adapter | the bundle's single configured component | provenance, write policy, adapter selection, git pathspecs | not a distinct ref segment; not identity; not type |

**Orthogonality:** (1) `type` ≠ adapter, many-to-many. (2) presentation/ranking key on `type`; validation keys on `(adapter, type)` via shared functions. (3) a "tool directory" (`.claude`) is a component; provenance, never identity/type. (4) identity is the adapter-owned concept ID; changing indexed metadata without moving or renaming the native item does not change it. (5) `type` **presents but never executes** — runtime authority comes only from a binding or explicit one-shot approval (normative §18, §28; History D8).

**OKF baseline vs AKM capabilities.** For an OKF bundle, the `okf` adapter preserves path identity, open `type`, `title`/`description`/`tags`/`timestamp`, content, links, and heading fragments. AKM Markdown emits conformant OKF frontmatter and its adapter adds native behavior based on the recognized AKM asset kind. Executable, sensitive, YAML, and tool-native formats remain adapter-native rather than being translated through Markdown.

---

## 1. Bundle / component / installation model

### 1.1 Interfaces (replaces `AssetSpec`/`TYPE_DIRS`/`ConfiguredSource`)

```ts
export type BundleId = string;       // stable bundle name (workspace identity); the optional ref prefix
export type ComponentId = string;    // a configured root under one adapter; PROVENANCE, not a ref segment (§1.3)
export type ItemRef = string;        // "[<bundle>//]<concept-id>" (§1.3)

export interface BundleInstallation {
  id: BundleId;
  revision?: string;                 // resolved git sha / npm version+integrity / snapshot digest
  source?: string;                   // transport locator, kept OUT of identity (normative §11.2)
  components: BundleComponent[];     // exactly one entry in 0.9.0
  trusted: boolean;                  // explicit trust; installation grants nothing (History D8)
}

export interface BundleComponent {
  id: ComponentId;
  adapter: string;                   // static adapter id, one per root — no per-file competition
  root: string;                      // absolute materialized root; workspace state NEVER written here
  writable: boolean;
}
```

`BundleInstallation`, `BundleComponent`, `IndexDocument`, `FileChange`, `Proposal`, and `Diagnostic` are the minimal durable core set for 0.9.0 (`Binding` is Tier-B target vocabulary — History §5.2, §10).

### 1.2 How a directory becomes a bundle

*(Amended v0.4, 2026-07-21 — owner ruling: the `akm.bundle.yaml` manifest step and the sub-mount proposal step are removed; a bundle maps to exactly one component/adapter.)*

1. **Workspace config `bundles` map** (normative §10.1).
2. **Deterministic install-time probe** (no config): `looksLikeRoot` probes run in a fixed, most-specific-first order. Specific native formats, LLM Wiki, and strong AKM layout evidence run before the broad OKF probe. A root OKF `index.md` or an index-less conformant typed Markdown tree selects `okf` when no stronger format claims it. First match wins; probes MUST be pure (stat/read only), and the result is persisted per normative §9.4 and never re-guessed. `generic-files` is **never auto-selected** — explicit configuration only.
3. **Single-component default** — nothing else matched ⇒ one component using the `akm` adapter. OKF is selected by explicit configuration or its own deterministic probe, never merely as the generic fallback.

**One bundle = one component = one adapter** (owner ruling 2026-07-21). The component's adapter processes the files and subdirectories of its bundle as it sees fit: the core provides symlink-safe traversal and persistence, while adapter-specific walk policy determines whether ordinary dot/cache directories participate. The adapter's `recognize` decides which walked files it claims and which it abstains on. There is no `akm.bundle.yaml` manifest and no sub-mount registration. Intra-component conceptId collisions are `duplicate-concept-id` diagnostics with a deterministic extension-priority winner.

### 1.3 Ref grammar — adapter-owned concept ID + optional `bundle//` prefix

**Identity = the adapter-owned concept ID.** For OKF this is the Markdown path minus `.md`; other adapters define the corresponding path for their native item. The workspace-qualified ref prepends an optional `<bundle>//` (the `//` echoes the old `origin//`, and disambiguates the bundle prefix from the `/`-separated path):

```
ref        := [ bundle "//" ] conceptId [ "#" fragment ]
bundle     := slug                      # no "/", ":", ".", "#" ; workspace bundle name (not the upstream package name)
conceptId  := adapter-owned path within bundle  # MAY contain "/"; MUST NOT contain "#"; opaque to the core below the first "//"
```

Normative §11.1 rules apply verbatim: **all durable state keys store the fully-qualified `bundle//conceptId` form** (the short form is CLI sugar only); **short refs inside bundle content resolve to the containing bundle**; conceptIds are NFC-normalized, `/`-separated, byte-wise case-sensitive, with `case-collision` diagnostics; body refs in prose use only the fully-qualified anchored form. `akm bundle rename` was specced as a first-class rekey transaction (normative §11.5), but the `bundle` command group itself was removed (D5, `0.9.0-decisions.md`) — no `akm bundle` subcommand exists in the shipped CLI. The startup guard that references it (`src/indexer/bundle-identity-guard.ts`) still points at a command that does not exist; see the drift register.

```
personal//knowledge/http-caching     # bundle-qualified; "knowledge" is part of the AKM concept path
team-catalog//workflows/release      # component "workflows"
project-claude//commands/test        # component root is .claude; type=command (derived), NOT in the id
knowledge/http-caching               # default-bundle implied (bundle omitted)
```

**Component is not a ref segment.** Each bundle has one configured component root, and its adapter derives concept IDs relative to that root. Component is recorded as a **provenance column**, used for filtering/write-policy/adapter-selection, never for identity.

**Invariants (normative §11.2):** provider details never appear in refs; `type` never appears in the ref; changing a Git remote/cache/materializer never changes a ref; reclassifying `type` without moving the file never changes the ref; moving/renaming is an explicit state-rekey. The core MUST NOT parse a file path *out of* a concept ID — it stores the ref and looks the path up in the index. `asset-ref.ts` survives as a **pure parser** (bundle-prefix split on `//`, `validateName` traversal/null-byte/drive-letter guards `:121-136`); the closed union `isAssetType` `:109`, `TYPE_ALIASES` `:25`, `type:name` parsing are deleted.

### 1.4 Config shape (normative §10.1) — replaces `stashDir`/`sources[]`/`installed[]`/`wikiName`

```jsonc
{ "defaultBundle": "personal",
  "bundles": {
    "personal": { "path": "~/akm", "components": { "main": { "root": ".", "adapter": "akm", "writable": true } } },
    "team-catalog": { "git": "https://github.com/acme/team-catalog.git", "components": { "main": { "root": ".", "adapter": "okf" } } }
  },
  // "bindings": { ... }  — Tier-B target shape; NOT emitted or read in 0.9.0 (normative §18 staging note)
}
```

`bindings` are workspace state (normative §18), never written into portable files.

---

## 2. The adapter contract (one interface; optional methods, not a facet hierarchy)

Per History §8.3 / the reconciliation, the adapter is **one interface with optional capability methods** — not separate `extends` facets, and not a semantic-view registry. Renderer/action is a **data table** keyed on `type`.

```ts
export interface BundleAdapter {
  readonly id: string;
  readonly version: string;                                  // feeds incrementality (§4) + fingerprints
  readonly extensions: readonly string[];                    // recognized extensions; longest-match stripping + collision priority

  // REQUIRED — the single-file recognition primitive; replaces the matcher stack
  // (matchers.ts:151-305; file-context.ts:242-265)
  recognize(c: BundleComponent, file: FileContext): IndexDocument | null;

  // OPTIONAL — full-component scan for non-per-file layouts (website snapshots,
  // llm-wiki multi-file semantics). When absent, the CORE scans:
  //   scanComponent(c, adapter) = core walk (git-aware, symlink-safe,
  //   adapter-specific directory policy) × adapter.recognize per file.
  // The core walk is ONE implementation carrying the security policy; adapters never
  // reimplement it. An adapter overriding index() MUST keep recognize() coherent
  // (conformance: index() == fold of recognize() over the walk) or declare
  // component-level incrementality (§4).
  index?(inst: BundleInstallation, c: BundleComponent): AsyncIterable<IndexDocument>;

  // OPTIONAL — item-scoped incrementality (§4). Default: identity (one file = one item).
  affectedItems?(c: BundleComponent, changedPaths: string[]): string[];

  // REQUIRED — native validation (change-transaction pre-commit + lint --fix); adapter
  // MUST NOT write and MUST NOT read the live filesystem: ctx serves the run snapshot
  // WITH the pending changes overlaid (one core overlay implementation), plus a
  // read-only resolveRef for link/xref existence (normative §12.1). Cross-component
  // ref existence is a CORE base check, not an adapter concern.
  validate(c: BundleComponent, changes: FileChange[], ctx: ValidateContext): Promise<Diagnostic[]>;

  // OPTIONAL — placement / discovery
  placeNew?(c: BundleComponent, conceptId: string): string;  // replaces TYPE_DIRS + resolveAssetPathFromName
  directoryList?(c: BundleComponent): string[];              // owned dirs; feeds git exact-path staging (git-stash.ts:241)
  looksLikeRoot?(root: string): boolean;                     // install-time probe; ordered per §1.2

  // OPTIONAL — authoring facet (normative §12.2)
  getAuthoringContext?(c: BundleComponent, target: AuthoringTarget, op: "create"|"update"|"move"|"consolidate"): Promise<AuthoringContext>;
  create?(c: BundleComponent, req: CreateRequest): Promise<FileChange[]>;

  // OPTIONAL — export facet (normative §12.3): portable runtime exports (workflow/task/env/agent/command/skill/script)
  listExports?(inst: BundleInstallation, c: BundleComponent): AsyncIterable<BundleExport>;
  planBinding?(c: BundleComponent, exp: BundleExport, req: BindingRequest): Promise<BindingPlan>;

  // OPTIONAL — memory lifecycle facet (normative §12.4, §25)
  listMemories?(inst: BundleInstallation, c: BundleComponent): AsyncIterable<MemoryRecord>;
  renderMemoryPlan?(c: BundleComponent, plan: MemorySemanticPlan): Promise<FileChange[]>;
  validateMemoryPlan?(c: BundleComponent, plan: MemorySemanticPlan, changes: FileChange[]): Promise<Diagnostic[]>;
}
```

**Status (verified against `src/core/adapter/bundle-adapter.ts`): the 7
OPTIONAL authoring/export/memory facet methods above (`getAuthoringContext`,
`create`, `listExports`, `planBinding`, `listMemories`, `renderMemoryPlan`,
`validateMemoryPlan`) are not declared on the shipped `BundleAdapter`
interface.** They are deliberately deferred Tier-B — the referenced types
(`AuthoringContext`, `CreateRequest`, `BundleExport`, `BindingRequest`,
`BindingPlan`, `MemoryRecord`, `MemorySemanticPlan`) are shapeless in every
spec doc, and the code leaves an explicit "FLAGGED for maintainer" note
rather than committing placeholder `Record<string, unknown>` types. The
`recognize`/`index?`/`affectedItems?`/`validate`/`placeNew?`/`directoryList?`/
`looksLikeRoot?` methods above are shipped as declared.

**Renderer/action = data table keyed on the open `type`, pointing at a named-function core module** (plan §2.3; normative §15.4). The *mapping* is data; the renderer *implementations* (env-keys-only, secret-name-only, script-exec-hints, markdown view modes, generic) remain a small static core module — env/secret redaction is existing behavior ported as code, keyed on the **adapter**, never on `type`. The table is **typed over the `KNOWN_TYPES` const tuple** so the compiler enforces an entry for every type AKM itself knows (restoring the closed union's exhaustiveness for our own tables), while lookup stays open-string with a generic fallback:

```ts
export const KNOWN_TYPES = ["knowledge", "workflow", /* … */] as const;
export type KnownType = (typeof KNOWN_TYPES)[number];

export const TYPE_PRESENTATION: Record<KnownType, { renderer: string; action: (r: ItemRef) => string }> = {
  "knowledge": { renderer: "knowledge-md", action: (r) => `akm show ${r} -> read reference material` },
  "workflow":  { renderer: "workflow-md",  action: buildWorkflowAction },
  // compiler enforces exhaustiveness over KNOWN_TYPES
};
export function presentationFor(type: string | undefined) { /* open lookup; unknown type ⇒ generic renderer + `akm show <ref>` — third-party OKF types never dropped */ }
```

The nine index-time metadata contributors currently registered by `output/renderers.ts` move into the owning adapters' `recognize` — they are index-time concerns and this part of the port is clean.

**Forbidden (normative §12.5):** adapters MUST NOT implement search, own proposal/outcome stores, apply writes or Git, **authorize execution**, register arbitrary improve stages, or replace core refs/diagnostics/change envelopes. The authoring/export/memory methods are **targeted ports, not semantic views** (History §8.3).

---

## 3. IndexDocument normalized projection

```ts
export interface IndexDocument {
  ref: ItemRef;             // fully-qualified "<bundle>//<concept-id>" (canonical stored spelling, §1.3)
  bundle: BundleId;
  component: ComponentId;   // PROVENANCE from the bundle's single configured component, not a ref segment
  conceptId: string;        // adapter-owned path identity; opaque to the core
  path: string;             // absolute local path (the read path)
  hash: string;
  adapterId: string;
  type?: string;            // open adapter-supplied label; presents/ranks/filters; NEVER executes or identifies

  name: string;             // FTS 10; OKF adapter maps `title`
  description?: string;     // FTS 5
  tags?: string[];          // FTS 3
  hints?: string[];         // FTS 2
  content?: string;         // FTS 1 (bounded)

  // FIRST-CLASS query-time signals — read by ranking contributors and result
  // filters at query time, therefore NOT foldable into documentJson (the parity
  // gate fails or the filters silently vanish otherwise). Pinned by a lint.
  aliases?: string[];       // exact-alias 1.5 boost is distinct from the tags signal — NOT folded into tags
  searchHints?: string[];
  quality?: string;         // curated boost + proposed-by-default exclusion filter
  confidence?: number;
  beliefState?: string;     // + currentBeliefRefs/supersededBy: boosts, ceilings, --belief filter
  currentBeliefRefs?: string[];
  supersededBy?: string;
  scope?: Record<string, string>;
  captureMode?: string;
  lessonStrength?: number;
  pinned?: boolean;
  fileSize?: number;        // hit size + estimatedTokens
  derivedFrom?: string;     // derived-twin belief inheritance
  updated?: string;         // OKF adapter maps `timestamp`
  links?: string[];         // resolved native links = relationships (§9); navigation/lint, NOT graph boost
  documentJson?: unknown;   // opaque adapter extras ONLY; not FTS, never parsed by core
}
```

Persisted index columns migrate `entry_key/stash_dir/entry_type/entry_json` → `item_ref/bundle_id/component_id/concept_id/adapter_id/type/file_path/content_hash/document_json` plus the pinned signal columns (normative §14.4), keeping the integer row id for FTS/vector joins — and durable behavioral state (utility, usage, feedback) re-keys onto `item_ref` so row-id churn can never destroy it (§4).

**FTS5 schema + bm25 weights UNCHANGED and load-bearing** (schema.ts:159; db.ts:1024 `bm25(entries_fts,0,10,5,3,2,1)`). The fold of richer native metadata (examples/usage/intent/xrefs/whenToUse/toc/parameters/bodyOpening) into `hints`/`content` is a **core-shared helper adapters call** — one fold, not ten — because embedding-input hashes and the frozen retrieval canaries are pinned to that exact surface (search-fields.ts:28-33). The deterministic nDCG/MRR/recall/banned-hit parity gate governs the cutover **and additionally checks filter-behavior parity (proposed/belief/scope result sets) and whyMatched parity**; weights/columns do not move (normative §14.4, D12). The canary re-mint (`akm improve canary --refresh`) is a named migration step.

### 3.4 Known-`type` presentation set (not a closed union)
No closed set replaces `AkmAssetType`. AKM keeps `TYPE_PRESENTATION` + ranking rules for the `type`s it renders/ranks; any other `type` renders generically and stays searchable (normative §15.1). A lint keeps the *spelling* of the known set consistent across the presentation/ranking tables, the search `--type` filter tokens, and the shipped assets/hints (plan §7.3); it never constrains what `type`s may exist. Body-ref recognition no longer keys on types at all: lint's missing-ref scan, `akm mv` xref rewriting, and search ref-prefix queries anchor on the fully-qualified `bundle//conceptId` grammar (normative §11.1), whose bundle-slug charset (no `:`/`.`/`#`) keeps it lexically distinguishable from URLs in prose.

---

## 4. Indexing loop, incrementality, registry

Scan loop (replaces `akmIndex` walk + wiki branch): for each installation → each component → `scanComponent` (core walk × `recognize`, or the adapter's `index()` override) → **drain the full document stream** (any scan error aborts before the first write — this makes last-known-good true by construction, and respects the async-scan/sync-transaction split the current indexer already enforces, indexer.ts:718-723) → one write transaction that **diff-persists**:

- upsert by `item_ref` (ON CONFLICT DO UPDATE), preserving `entries.id` so embeddings/FTS/vector joins survive and re-embedding is skipped when `content_hash` is unchanged;
- delete only rows whose ref disappeared, via the full `deleteRelatedRows` cascade including the usage-event detach-and-relink behavior (never the #624-P1 cascade-wipe);
- the wipe-set includes `utility_scores_scoped` (fixing the B4 gap) — but utility/usage state re-keys onto `item_ref` in the schema migration so even id churn cannot destroy it;
- a zero-document scan is a legitimate mass-delete only when a core preflight confirms the component root exists and is readable; otherwise last-known-good rows are preserved with a warning.

**NOT truncate-and-rewrite** — truncation would mint new row ids and cascade-destroy embeddings/utility/usage, contradicting the row-id-preservation promise above.

Adapters/materializers/registry/network **never run at query time** (normative §14.3, D11). A failed component scan preserves last-known-good rows and keeps other bundles searchable.

**Incrementality is ITEM-scoped, not file-scoped**: the mount manifest is `{ scanGeneration, adapterVersion, items: {conceptId → {files: {path → hash,mtimeMs}}} }`. A changed path maps to affected item(s) via `affectedItems` (default: identity); every file of an affected item re-recognizes together, so directory-scoped items (skill = the dir; llm-wiki pages under `schema.md`) stay coherent — a sibling edit updates the item, deleting the primary file deletes the item, deleting a sibling does not. Adapters MAY declare coupling files (wiki `schema.md`) whose change escalates to a component rescan. The FTS dirty-queue (schema.ts:352) and zero-row dir-state classification (dir-staleness.ts) carry forward into this manifest.

Registry is a **static frozen `BUILTIN_ADAPTERS`** map (normative §12.6): `website-snapshot`, `agent-skills`, `claude`, `opencode`, `dotenv`, `akm-workflow`, `akm-task`, `llm-wiki`, **`akm`**, `okf`, `generic-files`. One adapter per component root is selected once via the **ordered probe list of §1.2** (deterministic winner, persisted; explicit config wins; `generic-files` is config-only). Probe overlap is intentional for supersets: OKF can recognize conformant AKM Markdown, while the earlier strong AKM probe selects the native adapter. Unknown `type` remains searchable and receives generic behavior; an unknown adapter id skips the component with a warning.

---

## 5. The first-class `okf` adapter

Pure OKF: **`type` from frontmatter, identity from path, no directory routing.**
- **recognize:** any `.md` not named `index.md`/`log.md` → one concept; `type` = frontmatter `type` (default `knowledge` + a `missing-type` info hint if absent). No directory gate (OKF §1).
- **links:** BOTH legal OKF link forms resolve — `/`-rooted bundle-relative (recommended by OKF §5.1) *and* standard relative paths (OKF §5.2). Links resolve against the component root to form the stored bundle-relative conceptId in `links`.
- **conceptId:** path within the bundle − `.md` (markdownSpec.toCanonicalName, asset-spec.ts:91-95).
- **authoring:** consumer-only in 0.9.0. AKM-specific write commands fail before touching an OKF target.
- **directoryList:** the component root (OKF concepts live anywhere).
- **renderer/action:** generic Markdown content plus heading-fragment selection for every type.
- **validate (LENIENT):** unknown frontmatter and absent optional timestamp never fail; `missing-ref` on OKF links is a **warning** (consumers MUST tolerate broken links); `missing-type` is info.
- **Reserved:** `index.md`/`log.md` recognized, not indexed as concepts; root `index.md` may carry `okf_version`; `akm index` never regenerates `index.md` (normative §14.6, D14).

---

## 5.1 The two markdown-family adapters — `akm` (current behavior) vs `okf` (frontmatter `type`) — BINDING, NOT OPEN TO RE-INTERPRETATION

`akm` and `okf` both index markdown-with-YAML-frontmatter, but they classify
`type` by **different, deliberately fixed** mechanisms. This is a binding 0.9.0
decision. An implementation MUST NOT collapse one into the other, swap their
recognition strategies, "modernize" `akm` onto frontmatter, or split `akm` into
per-`type` adapters. Any future proposal to do so is a **spec change**, not an
implementation detail, and requires amending this section first.

- **`okf` — `type` from frontmatter (OKF §1.2), NO directory gate.** The
  first-class OKF adapter (§5). `recognize` reads the OKF `type` field from
  each concept's YAML frontmatter; the directory a file lives in **never**
  determines its `type`. `type` absent ⇒ `knowledge` (+ `missing-type` info).
  Used for configured or detected OKF bundles and third-party OKF trees.

- **`akm` — CURRENT FUNCTIONALITY PRESERVED (the existing matcher stack); a
  behavior-preserving port.** The AKM workspace's own adapter. Its
  `recognize` / `placeNew` / `directoryList` / `validate` / presentation
  reproduce **today's** classification VERBATIM — the `runMatchers` →
  `classifyByExtension` / `classifyByDirectory` / `classifyByParentDirHint` /
  `classifyBySmartMd` / `classifyByWiki` / `classifyByWorkflowProgram` stack and
  the per-`type` placement / lint / render logic (`file-context.ts:242-265`,
  `matchers.ts:151-305`, `asset-spec.ts`, the per-type linters/renderers). The
  byte-for-byte recognition / placement / renderer / lint goldens (Chunk 0b) are
  its conformance gate. The `akm` adapter:
  - is **NOT** re-derived to a frontmatter-`type` model;
  - emits matching `type` frontmatter on newly authored Markdown so the same
    files remain conformant when consumed through the OKF baseline; the native
    matcher remains authoritative and legacy files without `type` stay readable;
  - is **NOT** split into one-adapter-per-`type` — per §6 / §0.2 the 14 AKM
    formats are `type` **values** the single `akm` adapter emits, never adapters
    (per-`type` renderer/validator/placement differences are data/functions keyed
    on the open `type`, exactly as §2/§6 specify);
  - introduces **NO** new positional / directory-name heuristics of its own — it
    relocates the *existing* classification behind the `BundleAdapter` interface,
    unchanged in behavior;
  - emits the **qualified conceptId spelling** (ref-grammar decision D-R2,
    `akm-0.9.0-ref-grammar-decision.md`): conceptId = the placement stash-subdir
    followed by the per-type canonical name — `knowledge/http-caching`,
    `skills/code-review`, `scripts/db/migrate/run.sh` — the same spelling
    `placeNew` consumes and this spec's §1.3 examples show. Markdown files strip
    `.md`; directory-items (skill) and non-markdown extensions follow the
    adapter's own path definition (normative §11.2 note). `entry.name`/FTS keep
    the bare canonical name — identity ≠ search text.

**Reserved filenames (BINDING — decision D-R6).** Upstream OKF v0.1 §3.1
reserves `index.md` (directory listing, §6) and `log.md` (update history, §7) at
every level of an OKF bundle. The `okf` adapter must not emit concepts or accept
concept writes at those paths. The `akm` and `llm-wiki` adapters independently
reserve the same names as part of their own format contracts. Other adapters
own their reserved-name policy; OKF does not impose it on foreign formats.

**Why the two differ.** AKM classification is derived from directory, filename,
extension, or content probes, not trusted from frontmatter. AKM-authored
Markdown nevertheless carries the matching `type` field for OKF portability.
The field makes the Markdown concept interoperable; it does not change the
bundle's selected adapter or bypass AKM's stronger native behavior.

---

## 6. The `type` values AKM recognizes

These are **`type` values, not adapters**. The `okf` adapter reads them from
OKF frontmatter; the `akm` and other native adapters derive them according to
their own format rules. Presentation is keyed on `type` via
`TYPE_PRESENTATION`.

| `type` | OKF representation | native-derivation convention | type-specific validation |
|---|---|---|---|
| knowledge | yes | default when `type` absent | base only |
| command | yes | `.md` under `commands/` + `$ARGUMENTS`/`agent`-fm probe | `missing-name-or-type`; type∈{command} |
| agent | yes | `.md` under `agents/` + `tools`(/legacy `toolPolicy`)/`model` probe | `missing-name-or-type`; type∈{agent} |
| skill | yes | `SKILL.md`; item = the dir (item-scoped incrementality, §4) | `missing-skill-md` **+ NEW** Agent Skills contract — hard: name 1–64 (`^[a-z0-9]+(-[a-z0-9]+)*$`, NFKC, == parent dir name), description 1–1024, `compatibility` ≤500, `metadata` string→string map, YAML-mapping frontmatter; soft (warnings): body <500 lines / instructions <5k tokens, lowercase `skill.md` filename, `allowed-tools` portability. Strictness is per-adapter: `agent-skills` errors on unknown frontmatter (skills-ref behavior); `claude` allows Claude Code's documented extension fields |
| memory | yes | `.md` under `memories/` | `orphaned-stub` (delete fix); memory-lifecycle (§ normative 25) |
| lesson/fact/session/instruction | yes | `lessons/`/`facts/`/`sessions/`/`CLAUDE.md`·`AGENTS.md` | base (+`missing-category` for fact) |
| workflow | ext | unified `.md` workflow; orchestration in frontmatter, prose in the body | `placeholder-stub`, `invalid-workflow-structure` |
| task | AKM ext | `.yml` under `tasks/` (not OKF markdown) | `invalid-task-yaml`: `version: 2`+schedule+one target (`enabled` optional, defaults true, boolean when present) |
| env | AKM ext | `.env`/`*.env` under `env/` — **key NAMES only, values never indexed** | dangerous-key warn scan |
| secret | AKM ext | any file under `secrets/` minus `.lock`/`.sensitive` — **filename only** | dangerous-key scan; `classifyBySmartMd` bails on `secrets/` |
| script | AKM ext | 16 `SCRIPT_EXTENSIONS`; conceptId keeps extension | none |
| website | derived | website crawl snapshot (§7) | base (read-only) |
| wiki page | **LLM Wiki adapter** | `.md` under an LLM Wiki root (§7) — its own `type` values | native wiki validation (§7) |

**6 renderer mappings** (script/skill/command/agent/knowledge/memory) live only in `TYPE_PRESENTATION` now (they carried no `rendererName` on their old spec, plan §2.3).

---

## 7. The adapter set (format families)

An **adapter is a format family**, one per component root, emitting one or more
open `type`s. Markdown belongs to OKF only when the selected adapter is `okf`;
other Markdown formats retain their native semantics. A **"tool directory"**
(`.claude`/`.opencode`) is interpreted by its own adapter; no adapter competes
per-file.

| adapter | format / root | types | writable | notes |
|---|---|---|---|---|
| **okf** (§5) | OKF markdown; `type` from frontmatter | any OKF type | yes | first-class support for third-party OKF bundles |
| **akm** (**§5.1**, BINDING) | AKM workspace — **maintains current recognition/placement/lint/render functionality via the existing matcher stack** (behavior-preserving port; **NOT** frontmatter-`type`, **NOT** per-`type` adapters). AKM Markdown + AKM extensions (workflow/task/env/secret/script) under AKM subdirs | full §6 profile | yes (markdown/workflow/task); env/secret metadata-only | AKM's own workspace bundle; recognition contract fixed in **§5.1** |
| **llm-wiki** (**restored, DEV-7**) | LLM Wiki: `schema.md`, `index.md`, `log.md`, `raw/`, `pages/`, xrefs, citations, native ingest | wiki page kinds (adapter-owned) | yes | owns its native multi-file semantics + authoring/validation; `wiki` asset-*type* is gone but the **adapter** is first-class (normative §13.3) |
| **claude** | `.claude` tool dir — translator; derives `type` from dir | command, agent, skill, instruction | yes | AKM workspace layout **is** `.claude` minus the prefix |
| **opencode** | `.opencode` tool dir — translator (NEW) | command, agent, **skill**, instruction | yes | `AGENTS.md`=instruction; `config.json` not indexed; OpenCode has first-class skills (`.opencode/skills/<name>/SKILL.md`) and reads `.claude/skills/` — plural `commands/`/`agents/` dirs |
| **agent-skills** | standalone `SKILL.md` packages — translator | skill | yes | SKILL.md codec shared with claude as functions |
| **akm-workflow / akm-task / dotenv** | native workflow / task-YAML / dotenv formats | workflow / task / env | yes / yes / metadata-only | own executable/sensitive schemas; export facet (§ normative 18) |
| **website-snapshot** | crawl snapshot (website-ingest.ts:180) — read-only | website | **no** (Mode A) | export (Mode B) routes `content` through the destination adapter + FileChange txn; all SSRF/redirect/byte/depth/wall-clock/stale protections preserved |
| **generic-files** | any leftover file | document/script/file | yes | explicit-config ONLY (never auto-selected, §1.2) — a user who mounts a root with it indexes what they pointed it at, deliberately (the v0.2 sensitive-content refusal was withdrawn, deviation §4.3c) |

Instruction files (`CLAUDE.md`/`AGENTS.md`) are NEW; tool config files are runtime-config, never indexed. `sources/wiki-fetchers/`→`snapshot-fetchers/`; the one-element youtube registry inlines.

---

## 8. Single-component ownership

*(Retired by the v0.4 owner ruling.)* A bundle has one component root and one adapter. That adapter may emit every native `type` its format contains: for example, the `claude` adapter emits command/agent/skill/instruction from one `.claude` root rather than creating sub-components. If a package needs separately governed OKF, workflow, wiki, or tool roots, each root is registered as its own bundle.

```
bundle "team-catalog"       { root: ".",         adapter: "okf" }
bundle "release-automation" { root: "workflows", adapter: "akm-workflow" }
bundle "team-wiki"          { root: "wiki",      adapter: "llm-wiki" }
bundle "project-claude"     { root: ".claude",   adapter: "claude" }
```

There is no nested-root subtraction or cross-component collision machinery. The selected adapter owns traversal policy and claims or abstains on files throughout its one component root. Shared native contracts such as `SKILL.md` are implemented by shared functions used by the relevant adapters, not nested adapter dispatch.

---

## 9. Relationships: OKF links (deterministic; replaces LLM graph extraction for OKF content)

OKF bundle-relative links (`[x](/tables/customers.md)`, `[y](./other.md)` — both legal forms, §5) **are relationships** (OKF §5.3). The `okf`/`llm-wiki` adapters resolve them at `index` time into `IndexDocument.links` (target concept IDs, component-root-resolved then bundle-prefixed, §5). They persist to a dedicated `item_links(src_ref, dst_concept_id)` table with three consumers: the L1 overview (progressive disclosure), `related`-item output, and the base-linter broken-link check. Broken links are tolerated (warning), so relationship extraction never blocks indexing.

**Links do NOT feed `computeGraphBoost`.** The existing graph signal is entity-lexical (query tokens matched against extracted entity strings expanded over a confidence-weighted entity adjacency, graph-boost.ts:212-301); doc-level link edges carry no entity strings and cannot substitute for it. LLM graph extraction and its ranking boost remain a separate, measured concern resolved by the 0.9.1 ablation pass (plan §13.2, normative §26.3) — native links are navigation/lint/overview data, not a ranking contributor. If a native link-boost is ever wanted, it is a new contributor with its own nDCG gate.

---

## 10. Installation and activation (Tier A in 0.9.0 — DEV-3 revised; record/digests/CLI are Tier B)

**Tier A in 0.9.0 (DEV-3 as revised 2026-07-14; normative §18 staging note).** **Installation is not activation** — already true in code; 0.9.0 consolidates the existing scattered enforcement (the `registryId` block/warn, the add-time dangerous-key scan, task `enabled:` state, `writable`) into one workspace activation-policy point, verified by port-preservation tests. **No new trust/approval machinery ships** (deviation §4.3c). env/secret handling is unchanged (whole-file assets in stashes/bundles, resolved from the stash). Everything else in this section is the **Tier-B target shape, deferred indefinitely**: the durable `Binding` record in `state.db` (export ref + digest, engine/harness, parameters, env/secret *references* — never resolved values, normative §28.4 — tool/fs policy, enabled state, scheduler identity), the `discover → install → index → bind → enable` lifecycle's explicit bind step, digest-pinned updates, and the bind CLI. Export kinds (`workflow`/`task`/`environment`/`agent`/`command`/`skill`/`script`) remain activation contracts, not storage types or identity; runtime handlers never infer authority from a `type` or frontmatter field (normative §8.4). Accepted Tier-A residual: refs into installed sources re-read current disk content per invocation (crontab semantics; plan Chunk 6.5). Target-state rules: normative §18–§22.

---

## 11. Improve — three semantic operations (IN SCOPE — DEV-5)

Per **History D20** and normative **§24**, restored for 0.9.0 (reversing the two-verb reduction):

```
revise       improve an existing durable item
learn        create a new durable item from evidence
consolidate  bound a memory tier while preserving knowledge (the only op that may retire source content)
```

Evidence-driven (corrective evidence required for unattended semantic change; importance only orders), one stable snapshot per run, input fingerprints, and the three-level verification ladder (native safety / objective comparison / field outcome). Model confidence is diagnostic, never authority. Full stages, corrective-evidence list, verification ladder, change classes, process mapping, and the "must earn their way back" list: normative §24 + History §9. The plan's improve *decomposition* (the god-function → passes refactor, deletions of unproven lanes) stands; the *verb count* is three, not two.

---

## 12. Memory (DEFERRED — DEV-4 revised 2026-07-14; 0.9.0 = consolidate decomposition only)

**0.9.0 ships only the consolidate.ts decomposition with existing behavior preserved exactly** (plan §6, deviation §4.3b): the current merge/delete/promote/contradict ops through `archiveMemory`, journals, LOOK/CHANGE separation, hot-capture guard, contradiction preserve-and-qualify, proposal-gating — all as today, verified by goldens. The optional memory methods on `BundleAdapter` (§2) are the **Tier-B target shape** and are not implemented by any 0.9.0 adapter.

The lifecycle state model — operational states, water-marks/backpressure, claim coverage, sandbox evaluation, the content-addressed archive, purge, overlay, two-phase — is **target-state feature work staged behind the claim extractor + benchmark** (normative §25 release-staging note; History D21–D24 record the target design). It gets its own design pass when its prerequisite exists.

---

## 13. Grounding index (what each element replaces)

| New | Replaces | file:line |
|---|---|---|
| native bundle adapters, including `okf` and `llm-wiki` | `AssetSpec` + `stashDir` + wiki-as-type | asset-spec.ts; config-types.ts:99 |
| ref `[<bundle>//]<concept-id>` (path identity) | `AssetRef{type,name,origin}` | asset-ref.ts:11-116 |
| open adapter-supplied `type` | closed `AkmAssetType` + `entry_type` | common.ts:29-88; asset-ref.ts:109 |
| normalized `IndexDocument` projection | `StashEntry` | metadata.ts:60-189 |
| adapter `recognize`/`index` + optional methods | `runMatchers`/`classifyBy*`/walker | file-context.ts:242-265; matchers.ts:151-305; walker.ts:73 |
| `placeNew`/`directoryList` | `TYPE_DIRS`/`resolveAssetPathFromName` | asset-spec.ts:140-226; path-resolver.ts:27-38 |
| `TYPE_PRESENTATION` (open `type`) | `TYPE_TO_RENDERER`/`ACTION_BUILDERS` + spec split-brain | asset-registry.ts:21-58 |
| Tier-A activation-policy point (install≠activate consolidation; `Binding` record is Tier B) | scattered existing enforcement: `registryId` block/warn, dangerous-key scan, task `enabled:`, `writable` | env-binding.ts:110-121; add-cli.ts:74-215; tasks.ts; search-source.ts:35 |
| three-verb improve + memory lifecycle | improve god-modules + consolidate.ts | commands/improve/* |
| OKF links → `links` | LLM graph extraction | indexer/graph/* |

---

## References / Citations

- **OKF v0.1 → v0.2** — [`GoogleCloudPlatform/knowledge-catalog` `okf/SPEC.md`](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md); [Google Cloud announcement (2026-06-12)](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/). Concept identity = path − `.md`; required open `type`; recommended `title`/`description`/`resource`/`tags`; reserved `index.md`/`log.md` at every level (both optional); TWO link forms (`/`-rooted and relative, §5); `okf_version` optional, root-index only (even Google's reference bundles omit it — probes must not require it); consumers MUST NOT reject on unknown types/fields/broken links (the `okf` adapter's leniency is a conformance requirement, not a courtesy). **v0.2 (#730)** adds the trust/provenance family (`generated`/`verified`/`sources`), the lifecycle family (`status`/`stale_after`), and the actor convention (`<producer>/<version>` / `human:<id>` / `process:<id>`); `timestamp` is superseded by `generated.at` but remains a valid fallback reading — see §0.1 above for the full mapping and the [conformance runbook](../testing/okf-v0.2-conformance-runbook.md) for the pinned upstream commit (`KC_REF`). Caveats absorbed into this spec: OKF is a young single-vendor **Draft** with no governance body — AKM **vendors a frozen copy of the spec rules it implements** and treats `okf_version` handling as best-effort; manifests, versioning, dependencies, integrity, and components are AKM extensions layered around OKF, not OKF features.
- **Agent Skills** — the `SKILL.md` contract: hard limits name 1–64 (charset `^[a-z0-9]+(-[a-z0-9]+)*$`, must equal the parent dir name) and description 1–1024; `compatibility` ≤500; body <500 lines is *guidance*, not a rule; progressive disclosure = metadata / instructions / resources (akm's L0/L1/L2 retrieval levels are akm-internal naming, not the upstream terms). Spec: [agentskills.io/specification](https://agentskills.io/specification) (Anthropic-originated open standard; **unversioned, no tags/changelog — pin behavior by vendoring the `skills-ref` validator rules**, currently 0.1.0); Anthropic docs now live at platform.claude.com (API) and code.claude.com (Claude Code). Claude Code *extends* the standard (~13 extra frontmatter fields, all-optional metadata), so `.claude/skills` compatibility is one-way: validation strictness is per-adapter (§6).
- **AKM normative** — `akm-format-neutral-bundle-workspace-spec.md` (bindings §18, improve §24, memory §25), `akm-architecture-decision-history.md` (D1–D26), and the `akm-0.9.0-*` companions in this directory; `file:line` refs are to the current tree.
