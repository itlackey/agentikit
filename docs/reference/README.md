# Reference

Authoritative reference documentation for the akm CLI and its data.

- [Bundle Types](bundle-types.md) -- Pointer page: where the bundle-format compatibility table and adapter internals now live
- [CLI](cli.md) -- All `akm` commands and flags
- [Configuration](configuration.md) -- Engines, strategies, bundles, and settings
- [Supported Formats](supported-formats.md) -- Formats akm can index, from its own bundle layout to other tools' existing asset directories
- [Workflow Schema](workflow-schema.md) -- Authoritative reference for a workflow asset's exact frontmatter and body syntax
- [Workflows](workflows.md) -- Map of the workflow documentation: running, authoring, the schema, and the engine
- [Memory](memory.md) -- The `memory` asset type: capture, belief states, and derived memories
- [Refs](refs.md) -- The ref grammar `akm search` emits and `akm show` consumes, rename semantics, and namespacing
- [Asset Types](asset-types.md) -- The capability taxonomy the native `akm` adapter recognizes, bundle layout, and asset metadata
- [Environment & Secrets](env-and-secrets.md) -- `akm env` and `akm secret`, the two protected-value asset types
- [Registry](registry.md) -- Registries, search, hosting, and managing sources
- [Website Sources](website-sources.md) -- The pluggable fetcher API behind `akm import <url>` and other URL-based knowledge reads
- [Data & Telemetry](data-and-telemetry.md) -- Exactly what akm reads and writes on your machine (no remote telemetry)

See also: [akm-eval](../maintainers/eval.md) -- the standalone toolkit for measuring whether `akm improve` is working (maintainer docs), and the repo-root [Roadmap](../../ROADMAP.md) -- high-level focus for upcoming releases.
