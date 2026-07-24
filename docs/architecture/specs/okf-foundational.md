# OKF as the foundational format

**Status:** DECIDED (0.9.0). Supersedes the "OKF is one flagship adapter among
many" position in the normative workspace spec §2, and folds in the findings of
the retired OKF v0.1 conformance audit.

## The decision

**OKF is akm's foundational content model.** Every item akm indexes is an OKF
concept: a markdown file, identified by its path within its bundle, whose
`type` is an open descriptive label read from its own frontmatter, and whose
relationships are ordinary markdown links.

**Adapters are extensions on top of that model, not alternatives to it.** An
adapter's job is to project a native format *into* the OKF model — to answer
"what concepts does this directory contain, at what paths, of what type, linked
to what?" — for formats that do not natively answer it. Claude command dirs,
Agent Skills packages, dotenv files, YAML workflows, website snapshots, and
akm's own stash layout are all *projections*. OKF is what they project onto.

### What this does not mean

- **Native files stay native.** akm does not rewrite a `.claude/commands/*.md`,
  a `SKILL.md`, or a `.env` into OKF shape. The adapter reads it where it lives
  and in its own format. Nothing in this decision requires a native file to
  become an OKF document.
- **OKF is not a new asset type.** It is the shape of the model, not an entry
  in it.
- **The akm stash keeps its directory conventions.** `memories/`, `skills/`,
  `knowledge/` remain the recommended organization. What changes is their
  *status*: they become a **convention** that a well-behaved writer follows,
  not the **mechanism** by which type is determined.

### The one substantive change

Today two incompatible identity models run at once:

| | OKF model | akm-adapter model |
| --- | --- | --- |
| Identity | the file's path in the bundle | the file's path in the bundle |
| Type | frontmatter `type`, open set | the **directory**, closed set of 13 |
| A file at `tables/customers.md` | a `table` named "Customers Table" | not addressable — `tables` is not a known subdir |

Under this decision the first column wins everywhere, and the directory
becomes advisory. Concretely: **the leading path segment stops being a type
predicate.** A conceptId is an opaque path.

---

## Verified misalignments

Reproduced against the working tree with a conformant three-concept OKF bundle
(`index.md`, `tables/customers.md` with `type: table`, `guides/onboarding.md`
with no type) installed via `akm add`.

### M1 — the primary documented flow is broken for OKF bundles (blocker)

`ref.md` states the intended flow as "search → pick a hit → pass its ref to
show". For an OKF bundle, search prints the command and the command fails:

```console
$ akm search "customers"
  "type": "table", "name": "Customers Table",
  "action": "akm show okfbundle//tables/customers"

$ akm show okfbundle//tables/customers
  "ok": false,
  "error": "Unrecognized asset ref \"okfbundle//tables/customers\":
            conceptId \"tables/customers\" has no known asset-type prefix."
```

**Cause.** `parseRefInput` (`src/core/asset/resolve-ref.ts`) routes every ref
through `typeNameFromConceptId`, which requires the leading conceptId segment
to be one of the 13 `akm`-adapter placement subdirs. OKF conceptIds are
arbitrary paths, so no OKF concept outside that accidental vocabulary is
addressable. `akm graph related` fails identically — same parser.

This is the single change that decides the question: while a ref must carry a
type predicate in its first path segment, akm cannot be an OKF system.

### M2 — item identity depends on an optional file

OKF explicitly tolerates a missing index. Deleting the optional root `index.md`
hands the same bundle to a different adapter, and every concept in it silently
changes identity **and** loses its declared metadata:

| | with `index.md` | without `index.md` |
| --- | --- | --- |
| ref | `nb//tables/customers` | `nb//knowledge/tables/customers` |
| type | `table` (frontmatter) | `knowledge` (discarded) |
| name | `Customers Table` (title) | `tables/customers` (discarded) |

A synthetic `knowledge/` segment is injected into the identity of every item.
Adding or removing one optional file re-keys the whole bundle.

### M3 — what search finds, `show` cannot open; what `show` opens, search cannot find

In one bundle, after `akm remember --target okfbundle`:

- `okfbundle//tables/customers` — indexed, findable, **not** openable (M1).
- `okfbundle//memories/test-note` — openable (its path happens to start with a
  known subdir, so it resolves through the filesystem fallback), but **absent
  from the index**: no query returns it, while its OKF siblings all match.

The two halves of the core loop cover disjoint sets of items.

### M4 — akm cannot produce a conformant OKF concept

`akm remember --target <okf-bundle>` writes:

```markdown
---
captureMode: hot
beliefState: asserted
---
test note
```

No `type`, no `title`, no `description`, no `timestamp` — none of the four
fields the OKF projection reads. akm's own writes are not self-describing: read
back by any OKF consumer (including akm's own OKF adapter) the item is an
untyped, untitled `knowledge` blob. Every akm write depends on the directory to
carry meaning the file itself does not state.

### M5 — akm's default workspace is not an OKF bundle

`akm init` scaffolds the placement subdirs plus `.meta/index.md`. Because
`.meta/` is a dot-directory, the OKF probe — which looks for a **root**
`index.md` — never fires. The default workspace is therefore always claimed by
the `akm` adapter. The foundational format is never the format of the thing
every user starts with.

### M6 — the OKF relationship graph is not retained

The adapter resolves both OKF link forms into target conceptIds and sets
`IndexDocument.links`, but nothing persists them: `akm graph` has no OKF edges,
and `akm graph related` cannot even parse an OKF ref (M1). akm reads OKF's
relationships and drops them.

### Carried over from the retired conformance audit

Two further gaps, recorded there and not re-verified here: `type + name`
deduplication can collapse distinct path-identified concepts, and the walker's
hidden/ignored-directory exclusions can hide conformant concepts from the
adapter. Reference-style markdown links are also outside the adapter's regex.

---

## Target model

### T1 — a conceptId is an opaque path

`parseRefInput` must stop requiring a known-subdir prefix. Resolution order:
the index (path → item, which already knows its bundle, adapter, and type),
then the filesystem. Type is an **attribute** of a resolved item, never a
predicate parsed out of its ref. This fixes M1, M3, and M6's addressability
half.

The legacy `type`/`name` pair stays available as a *derived view* for the akm
adapter's own items (it is what `--type` filtering and placement need), but it
is derived from the resolved item, not from the ref string.

### T2 — akm writes self-describing concepts

Every akm write emits the OKF projection fields it can honestly fill:
`type` (the akm type it is writing — `memory`, `lesson`, …), `title` when a
display name is known, `description`, and `timestamp`. akm-specific keys
(`captureMode`, `beliefState`, `xrefs`, `scope_*`) remain as unknown-to-OKF
frontmatter, which OKF tolerates by design. This fixes M4 and makes the akm
stash readable by any OKF consumer.

### T3 — the akm stash layout becomes an OKF profile

The `akm` adapter continues to recognize the stash's subdirectories, but as a
**default for type when frontmatter does not state one**, not as an override.
Frontmatter `type` always wins. A stash written under T2 is then valid OKF: its
directories are conventional organization, and every file states its own type.

Consequence: `akm init` should scaffold a root `index.md` so the default
workspace is a conformant OKF bundle (fixing M5), and the akm adapter should be
understood as the OKF adapter plus placement conventions.

### T4 — recognition stops changing identity

Adapter selection may change *how much akm understands* about a bundle. It must
never change an item's ref. A missing optional `index.md` may not re-key a
bundle, and no adapter may inject a synthetic segment into a conceptId. This
fixes M2.

### T5 — links are persisted

`IndexDocument.links` reaches durable storage and backs `akm graph related`,
making the OKF relationship graph a first-class query surface. This fixes M6.

---

## Sequencing

T1 and T4 are the load-bearing pair — they are what make akm an OKF system
rather than a system that can read OKF. T2 is independent and cheap. T3 and T5
follow.

T1 is a behavior change to a Stable surface (refs that used to fail now
resolve) but it is **widening**, not breaking: every ref that resolves today
continues to resolve. T4 changes refs for index-less bundles that are currently
mis-keyed; those refs are broken today by M2, so the change repairs them.

## See also

- [`ref.md`](./ref.md) — the normative ref grammar.
- [`0.9.0-decisions.md`](./0.9.0-decisions.md) — D11 records this decision.
- [`akm-format-neutral-bundle-workspace-spec.md`](./akm-format-neutral-bundle-workspace-spec.md)
  — §2 is amended by this document.
