# Workflows

A workflow is a structured markdown document that defines a multi-step
procedure. `akm workflow run` compiles it to a frozen plan, persists run and
unit state, dispatches its work, verifies declared gates, and can resume after
an interruption without replaying completed units.

> **`akm workflow run` is Stable, ungated, and the only execution surface.**
> It is the canonical start/resume/execute command; there is no separate
> external-driver protocol.

Workflows are one of the execution surfaces AKM directly orchestrates: AKM
retrieves every supported capability type, but a workflow's declared steps —
not arbitrary indexed content — are what actually gets dispatched. See
[Architecture: Core Principles](../architecture/akm-core-principles.md) for
that boundary.

This page is a short map. The full contract now lives across four pages,
split by what you're doing:

- **[Running Workflows](../guides/run-workflows.md)** — operating a run:
  start, check status, resume a blocked run, abandon one, and follow its
  events. Includes the trust model for running a workflow sourced from
  someone else's bundle.
- **[Author's Guide: Writing Workflows](../guides/author-workflows.md)** —
  writing and testing a workflow definition: the markdown structure, a
  minimal complete example, common authoring mistakes, choosing engines and
  models, and engine-selection troubleshooting.
- **[Workflow Schema](../reference/workflow-schema.md)** — the exhaustive,
  authoritative reference: every frontmatter key, the bare-reference grammar,
  routing, failure policy, gates, and budget ceilings, with exact syntax.
- **[Architecture: The Workflow Engine](../architecture/workflow-engine.md)**
  — how a frozen plan actually executes: persistence, the run lease, dispatch,
  worktree isolation, concurrency limits, and resume-without-replay.

For task- or schedule-driven workflow runs — an `akm task` bound to
`--workflow <ref>` and reconciled with the OS scheduler — see
[Scheduling](../guides/scheduling.md).

## See also

- [Discover and Load](../guides/discover-and-load.md) — find available
  workflows with `akm curate` before running one
- [Capture Knowledge](../guides/capture-knowledge.md) — turn a workflow run's
  outputs into searchable memories
- [Improve the Library](../guides/improve-the-library.md) — feed run outcomes
  back into a workflow asset's ranking and proposed edits
- [Concepts](../guides/concepts.md) — the workflow asset type and run-state
  storage in the broader AKM model
- [CLI Reference](cli.md) — full flag documentation for all `workflow`
  subcommands
