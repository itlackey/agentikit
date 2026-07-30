# OKF format support

**Status:** DECIDED (0.9.0). OKF is a first-class format supported by AKM
through the built-in `okf` adapter. First-class means every applicable case in
the conformance runbook passes end to end; adapter-local recognition alone is
not sufficient.

## The decision

OKF is AKM's least-common-denominator format for Markdown concepts and generic
read behavior. AKM can install, recognize, index, search, and show conformant
OKF bundles without converting them to an AKM-native layout. OKF support is
held to the observable conformance contract in the
[OKF v0.2 conformance runbook](../testing/okf-v0.2-conformance-runbook.md).

That baseline does not make OKF AKM's database schema or force non-Markdown
formats through Markdown. In particular, OKF is **not**:

- an AKM asset type;
- a serialization imposed on scripts, YAML tasks, environment files, secrets,
  Agent Skills, or other native non-Markdown assets;
- a replacement for adapter-owned capability, validation, redaction, placement,
  or execution rules.

The core provides path identity, open descriptive types, generic Markdown
content/fragment reads, and a normalized search projection. Adapters add
behavior to that baseline. They never narrow the core by rejecting an item only
because its `type` is unfamiliar.

## First-class support contract

For a bundle selected as `adapter: okf`, AKM must provide all of the following:

1. Every conformant non-reserved Markdown concept is recognized with its OKF
   path-minus-`.md` concept ID.
2. `type`, `title`, `description`, `tags`, and `timestamp` are read according
   to OKF rules. Unknown types and unknown frontmatter fields remain valid.
3. `index.md` and `log.md` retain their OKF structural meaning and are not
   indexed as concepts.
4. OKF links are retained as relationships. A dangling link does not prevent
   indexing.
5. A ref emitted by search for an OKF concept is accepted by show and other
   applicable ref-consuming commands. Adapter-owned concept IDs such as
   `tables/customers` must not be rejected merely because they do not use an
   AKM stash placement directory.
6. Markdown heading fragments are accepted as input-only selectors and never
   become part of durable identity.
7. An OKF target without adapter-owned authoring rejects AKM-native write
   commands before touching disk. AKM must never silently place native files in
   an OKF bundle.

The shipped `okf` adapter is consumer-only. Its supported behavior is the
portable content/fragment baseline; it does not infer task, command, script,
environment, or secret capabilities from an arbitrary OKF `type` value.

## Progressive enhancement

AKM Markdown is an OKF-compatible superset. Newly authored AKM Markdown emits a
non-empty native `type` plus any AKM-specific frontmatter required by its asset
kind. The `akm` adapter still derives native identity and capability from its
directory, extension, filename, and content rules; frontmatter `type` does not
override those rules. Existing legacy Markdown without `type` remains readable
and is upgraded when AKM creates or semantically rewrites it rather than during
indexing.

The result is progressive enhancement:

1. Any OKF type gets path identity, indexing, search, content show, and heading
   fragments through the `okf` adapter.
2. The `akm` adapter recognizes AKM-owned types and adds their specialized
   behavior: command prompts, runnable scripts, workflows, tasks, redacted
   environment/secret views, memories, lessons, and other native capabilities.
3. Unknown `type` values remain valid data. They get generic behavior unless
   the selected adapter explicitly adds more.

`akm bundle create` records `adapter: akm`. `akm bundle add` records the detected adapter, and an
explicit configured adapter always wins over probing. Strong native AKM layout
evidence wins before the broader OKF probe because AKM Markdown is an OKF
superset. An index-less bundle containing conformant typed Markdown can still be
recognized as OKF.

The normalized `IndexDocument` is the additive cross-format projection. Its
basic Markdown fields align with OKF, while adapters may project additional
metadata and capabilities without changing identity.

## v0.2 update (#730)

OKF v0.2 (Google Cloud) adds a trust/provenance frontmatter family
(`generated`/`verified`/`sources`) and a lifecycle family
(`status`/`stale_after`), standardizes an actor convention
(`<producer>/<version>` / `human:<id>` / `process:<id>`), and makes one
breaking-with-fallback change: `timestamp` is superseded by `generated.at`,
with consumers permitted (and expected) to fall back to the legacy
`timestamp` field when `generated`/`generated.at` is absent. The decision
above is unchanged by this update — the `okf` adapter remains **consumer-only**
and the read/write split stays exactly where §5/§5.1 already drew it:

- **Read side (any OKF bundle, third-party or AKM-authored):** the `okf`
  adapter parses the full v0.2 family — `generated.at` (with the `timestamp`
  fallback), `verified` (a list, or v0.2's permitted single-mapping
  shorthand), `sources` (an object list), `status`, `stale_after`, and
  `okf_version` — leniently, exactly like every other optional OKF field
  (missing, malformed, or foreign values never reject a document). These land
  on new, NAMESPACED `IndexDocument` fields (`provenance`, `lifecycleStatus`,
  `staleAfter`, `okfVersion`) rather than overloading the three AKM-native
  fields that already occupy adjacent names: `sources?: string[]` (wiki
  citation strings), `generation?: number` (consolidation merge depth), and
  the existing `quality: "generated"` enum value. See
  `akm-0.9.0-bundle-adapter-spec.md` §0.1 for the full mapping.
- **Write side (AKM-native assets only, through the proposal path):** since
  AKM Markdown is already an OKF-compatible superset (the progressive-
  enhancement contract above), the new provenance fields are *written* only
  to AKM-native assets, at proposal-promotion time (`promoteProposal`) —
  never through the `okf` adapter, which stays consumer-only. Accepting a
  proposal stamps a namespaced `provenance:` frontmatter block (the v0.2
  `generated`/`verified`/`sources` shape, under a distinct top-level key to
  avoid the same wiki-`sources` collision noted above) using the existing
  `source`/`sourceRun`/`gateDecision`/`review` provenance the proposals system
  already tracks in `state.db`. `stale_after`-driven re-verification and
  trust-tier ranking are explicitly out of scope for 0.9.0 (an 0.9.x
  improve-tuning track).

OKF is a month-old, single-vendor **Draft** with no governance body; AKM
vendors a frozen copy of the spec rules it implements rather than tracking
upstream live. See the conformance runbook for the pinned upstream reference.

## See also

- [`akm-0.9.0-bundle-adapter-spec.md`](./akm-0.9.0-bundle-adapter-spec.md)
  defines the concrete `okf` and `akm` adapter boundaries.
- [`ref.md`](./ref.md) defines the cross-format ref grammar.
- [`0.9.0-decisions.md`](./0.9.0-decisions.md) records this positioning as D11.
