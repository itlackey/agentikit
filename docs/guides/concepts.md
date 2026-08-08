# Concepts

AKM is a portable capability library for AI agents: one local index that
holds every capability you've connected, and a small set of verbs any agent
can use to find, load, and improve it. Four ideas cover the whole mental
model.

## 1. A capability is something an agent can discover and use

A **capability** is any asset an agent can search for and act on: a script,
skill, command, agent definition, knowledge document, instruction, env file,
secret, workflow, lesson, memory, task, session summary, or fact. AKM
classifies capabilities by **what they are** (file extension and content),
not by which directory they live in — a `.sh` file is a script whether it
lives in `scripts/`, `deploy/`, or the bundle root.

See [Asset Types](../reference/asset-types.md) for the full taxonomy,
directory layout, and metadata field reference.

## 2. A bundle is a portable directory of capabilities

A **bundle** is a directory of capabilities you can connect, share, and
install — a local folder, a git repo, an npm package, or a crawled website.
`akm bundle add` infers the bundle's kind from the input shape; you never
pick it yourself. Every bundle materializes to a local directory that the
indexer walks.

Your **working bundle** (`~/akm`, created by `akm setup`) is the default
destination for `akm remember`, `akm import`, and other writes — the one
bundle guaranteed to be writable.

See [Author Bundles](author-bundles.md) for how to build and share one, and
[Registry](../reference/registry.md) for finding bundles other people have
published.

## 3. AKM builds a local index and uses progressive disclosure

Every connected bundle is folded into one local FTS5 index — there's no
per-bundle fan-out at query time. Two verbs work that index:

```text
search decides   -- a lean menu: type, name, action, score
show delivers     -- the full dispatch envelope: run command, prompt, content
```

Search should not accumulate show-level detail, and show should not require
a prior search call. When two bundles hold a capability with the same name,
the working bundle wins by ranking convention rather than a fixed lookup
order — `akm clone` copies a capability into your working bundle so your
local edits override the upstream copy in subsequent searches.

## 4. A ref is an opaque handle returned by discovery and consumed by show

A **ref** is the compact identifier `akm search` returns and `akm show`
consumes: `[bundle//]conceptId[#fragment]`. Treat it as an opaque token — get
it from search or curate, and pass it straight to `show`. Don't parse it or
construct one by hand; the structured `conceptId` and `bundle` fields on a
search hit carry the same information in parseable form.

See [Refs](../reference/refs.md) for the full grammar, rename semantics, and
namespacing conventions.

## How it fits together

```text
local folders / git / npm / websites
              |
              v
           bundles
              |
              v
        one local index
              |
              v
   curate -> show -> use/run -> feedback -> proposals
```

This is the retrieval loop: **connect** a source, **index** it, **curate** a
shortlist for a task, **show** the full payload, **use/run** it, send
**feedback**, and let accumulated signal become a **proposal**. AKM
retrieves every supported capability type. It directly orchestrates defined
execution surfaces such as workflows, agent dispatch, tasks, and guarded
subprocess injection. It does not blindly execute arbitrary indexed content
merely because that content appears in search results.

## See also

- [Asset Types](../reference/asset-types.md) — the full capability taxonomy, directory layout, and metadata fields
- [Refs](../reference/refs.md) — ref grammar, rename semantics, and namespacing
- [Memory](../reference/memory.md) — belief states, capture modes, and derived memories
- [Registry](../reference/registry.md) — finding and installing bundles
- [Architecture](../architecture/architecture.md) — how indexing, search, and execution fit together
- [Author Bundles](author-bundles.md) — how to build and share a bundle
