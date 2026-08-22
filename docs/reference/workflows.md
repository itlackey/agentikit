# Workflows

A workflow is a multi-step procedure authored as either AKM Markdown or the
bounded GitHub-shaped YAML subset. `akm workflow run` compiles either peer
source format through source IR v1, freezes a durable plan, persists run and
unit state, dispatches work, verifies declared gates, and can resume after an
interruption without replaying completed units.

> **`akm workflow run` is Stable, ungated, and the only execution surface.**
> It is the canonical start/resume/execute command; there is no separate
> external-driver protocol.

Workflows are one of the execution surfaces AKM directly orchestrates: AKM
retrieves every supported capability type, but a workflow's declared steps —
not arbitrary indexed content — are what actually gets dispatched. See
[Architecture: Core Principles](https://github.com/itlackey/akm/blob/main/docs/architecture/akm-core-principles.md) for
that boundary.

This page is a short map. The full contract now lives across four pages,
split by what you're doing:

- **[Running Workflows](https://github.com/itlackey/akm/blob/main/docs/guides/run-workflows.md)** — operating a run:
  start, check status, resume a blocked run, abandon one, and follow its
  events. Includes the trust model for running a workflow sourced from
  someone else's bundle.
- **[Author's Guide: Writing Workflows](https://github.com/itlackey/akm/blob/main/docs/guides/author-workflows.md)** —
  writing and testing a workflow definition: choosing a source format, the Markdown structure, a
  minimal complete example, common authoring mistakes, choosing engines and
  models, and engine-selection troubleshooting.
- **[Workflow Schema](../reference/workflow-schema.md)** — the exhaustive,
  authoritative reference: every frontmatter key, the bare-reference grammar,
  routing, failure policy, gates, and budget ceilings, with exact syntax.
- **[Architecture: The Workflow Engine](https://github.com/itlackey/akm/blob/main/docs/architecture/workflow-engine.md)**
  — how a frozen plan actually executes: persistence, the run lease, dispatch,
  worktree isolation, concurrency limits, and resume-without-replay.

For task- or schedule-driven workflow runs — an `akm task` bound to
`uses: workflows/<ref>` and reconciled with the OS scheduler — see
[Scheduling](https://github.com/itlackey/akm/blob/main/docs/guides/scheduling.md).

## Source formats and execution versions

Markdown `.md` and GitHub-shaped YAML `.yml` are peer source formats. The
Markdown adapter preserves AKM's full prose, gates, maps, routes, typed
artifacts, and exec vocabulary. The YAML adapter accepts the documented local
`name`/`on`/`jobs` subset. `.yaml` is not a workflow source.

Both adapters produce strict source IR version 1. New starts resolve source
owners and executable targets, then freeze durable plan v4. Stored durable v3
runs resume exactly and unchanged: the compatibility decoder does not rewrite
or normalize them into v4.

## Unsupported boundary and 0.9.3

The 0.9.2 GitHub-shaped adapter is a local interoperability seam, not GitHub
Actions. Full GitHub expressions and contexts, local/Docker/remote actions,
nested workflows, service events, arbitrary hosted runners, and multi-job
runtime execution remain outside 0.9.2. Valid multi-job sources can be indexed
and displayed, but the 0.9.2 runtime executes a single job only.

These full GitHub semantics, actions, service events, and runner behaviors are
explicit 0.9.3-or-later work. AKM neither fetches remote actions nor creates
event watchers or polling daemons in the meantime.

Version 0.9.3 may extend full GitHub expressions and contexts, actions,
service events, and runners; none of those capabilities is implied by 0.9.2.

## See also

- [Discover and Load](https://github.com/itlackey/akm/blob/main/docs/guides/discover-and-load.md) — find available
  workflows with `akm curate` before running one
- [Capture Knowledge](https://github.com/itlackey/akm/blob/main/docs/guides/capture-knowledge.md) — turn a workflow run's
  outputs into searchable memories
- [Improve the Library](https://github.com/itlackey/akm/blob/main/docs/guides/improve-the-library.md) — feed run outcomes
  back into a workflow asset's ranking and proposed edits
- [Concepts](https://github.com/itlackey/akm/blob/main/docs/guides/concepts.md) — the workflow asset type and run-state
  storage in the broader AKM model
- [CLI Reference](cli.md) — full flag documentation for all `workflow`
  subcommands
