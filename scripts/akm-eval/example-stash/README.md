# Example Stash

This directory is a documentation-backed example stash that shows how different
AKM asset types fit together.

The example uses frontmatter on Markdown assets for metadata. `.stash.json`
sidecars are inert and are not an authoring format.

Current layout:

```text
scripts/akm-eval/example-stash/
  commands/    # command prompt templates that help launch workflows
  skills/      # reusable guidance for recurring tasks and cleanup styles
  workflows/   # resumable multi-step procedures
```

## When To Use What

- Use `commands/` when you want a reusable entrypoint that gives an agent or
  operator a fast, repeatable way to launch a task with a clean template.
- Use `workflows/` when the task is multi-step, stateful, resumable, or needs a
  durable audit trail.

In this example stash:

- `commands/start-topic-swarm-deep-research.md` is the entrypoint for kicking
  off the combined swarm-to-deep-research flow.
- `workflows/deep-research-auto-research.md` is the focused workflow for one
  already-chosen topic.
- `workflows/topic-swarm-select-and-deep-research.md` is the broader workflow
  that explores many candidate topics, selects the best one, and then transitions
  into deep research.
- `workflows/blog-publish-article.md` is a long-form editorial workflow with
  multi-reviewer gates.
- `workflows/github-issues-parallel-implementer.md` shows multi-agent parallel
  implementation across isolated worktrees.

### Common-task workflows

Smaller, repeatable workflows that double as templates for everyday
engineering work:

- `workflows/triage-bug-report.md` — intake, reproduce, localize, propose a
  fix, and promote durable lessons back into the stash and a knowledge wiki.
- `workflows/weekly-dependency-audit.md` — recurring lockfile audit that
  ships safe upgrades and queues the rest, demonstrating `akm env` for
  registry credentials.
- `workflows/code-review-pr.md` — structured PR review against the project's
  own conventions, demonstrating `akm search` for prior art and
  `akm feedback` to signal reviewer-persona quality.
- `workflows/ship-feature-from-spec.md` — spec-to-PR delivery loop with
  test-first discipline and ADR-style decision capture.
- `workflows/architecture-cleanup.md` — behavior-preserving refactor loop for
  reducing architectural duplication without changing functionality.

### Skills

- `skills/architecture-cleanup/SKILL.md` — guardrails, patterns, and local
  references for narrow architectural cleanup work.

### Nested workflow example

- `workflows/release-train.md` is an **orchestrator** that delegates to
  independent workflow runs in this stash:
  - `workflows/weekly-dependency-audit` for pre-flight maintenance
  - `workflows/code-review-pr` once per release-blocker PR

  Each delegated run has its own `runId`, can be inspected with `akm workflow
  status`, and can be resumed independently if interrupted. The orchestrator
  records those IDs explicitly; AKM does not provide implicit nesting or a
  child-run status tree. It owns the cross-cutting release book, changelog, tag,
  deploy, announcement, and retrospective.

## Suggested Flow

1. If the problem is still broad or you need topic discovery, start with the
   command in `commands/`.
2. That command creates or starts the combined workflow in `workflows/`.
3. If the topic is already known, skip the swarm and start the standalone
   deep-research workflow directly.
4. For routine engineering work, pick the common-task workflow that matches
   the job — bug, dep audit, review, feature — instead of running the
   full research stack.
5. For a release, run `workflows/release-train`; it launches the independent
   child runs it needs and records their IDs in the release book.

As this example stash grows, it can hold more asset types without overloading
the generic `docs/examples/` namespace.
