# The Improvement Loop

akm does not require a perfect library on day one. It tracks which assets
agents actually use and what agents think of them, then generates improvement
proposals you can selectively apply. Over time the library adapts to your team's
real patterns — surfacing what works, flagging what doesn't, and consolidating
scattered memories into durable knowledge.

## akm feedback

`akm feedback` records a positive or negative signal for any indexed asset.
The signal updates the asset's utility score immediately — a bounded-step EMA
nudges the score toward the signal on every call, no reindex required — so
highly-rated assets rank higher and underperformers surface less often right
away.

```sh
akm feedback skills/code-review --positive
akm feedback agents/reviewer --negative --reason "Gave outdated migration steps"
akm feedback workflows/ship-release --positive --reason "Worked end-to-end on 0.8.0"
akm feedback skills/planner --negative --reason "Doesn't account for merge conflicts"

# With a structured reason slug (consumed by improve/distill prompts):
akm feedback skills/planner --negative --reason "incomplete-edge-cases"
```

Specify exactly one of `--positive` or `--negative`. The ref must be present in
the current local index. `--negative` additionally requires `--reason` —
negative signals need a written reason for the distillation pipeline to use, and
omitting it exits 2. `--failure-mode` adds a curated taxonomy label but does
**not** substitute for `--reason`. (Set `feedback.requireReason: false` to
downgrade the gate to a warning.)

**Example: flag a skill that gave bad advice**

```sh
akm feedback skills/deploy --negative \
  --reason "Skips the dry-run step; caused prod incident 2026-05-10" \
  --failure-mode dangerous
```

## akm log

`akm log` gives the realtime append-only event stream that every mutating CLI
verb writes to.

```sh
akm log                                         # All events, oldest first
akm log --type feedback                         # Filter by event type
akm log --ref skills/deploy
```

`akm log` supports `--since '@offset:<id>'` cursors so you can resume from
exactly where you left off across process boundaries without duplicates.

**Example: see what was used recently**

`akm log --since` takes an ISO timestamp or epoch ms — not a duration
shorthand like `7d`. That shorthand is accepted by a different parser, used by
both `akm health --since` and `akm proposal extract --since` (e.g. `akm
proposal extract --since 24h`); several commands share the `--since` flag name
but not all of them accept the same format.

```sh
akm log --since 2026-05-01T00:00:00Z --type select --format text
```

## akm improve

`akm improve` is the main entry point for the self-improvement pass. It reads
feedback signals and usage patterns, then runs whichever processes the active
strategy enables — reflect, distill, consolidate, memory inference, graph
extraction, session extraction, and proactive maintenance — to generate
proposals. By default, generated proposals always queue for review: the
built-in `proactive-maintenance` strategy's `triage.applyMode: "promote"`
(auto-accept up to `maxAcceptsPerRun`) is downgraded to `"queue"` unless you
explicitly opt in via `experimental.improveAutonomy` (see
[Configuration](../reference/configuration.md#experimental-opt-ins)).
`akm proposal drain --promote` is a second, explicit promote surface,
independent of that gate.

```sh
akm improve                           # Full stash pass
akm improve memory                    # Scope to memory assets only
akm improve skills/code-review         # One asset
akm improve --task "reduce duplication"
akm improve --dry-run                 # Show planned refs without generating proposals
akm improve --limit 10                # Cap assets processed
```

The shipped `default` and `frequent` strategies leave improve-stage session
extraction off. Proactive maintenance is also opt-in: use `akm improve
--strategy proactive-maintenance` or explicitly enable the process in your
selected strategy. Direct extraction commands (`akm proposal extract --type
<harness>` and `akm proposal extract --auto`) remain independent of the
improve-stage toggle.

Selection defaults to assets with recent feedback signals first, with a
retrieval-count fallback for high-traffic assets that have no feedback yet.

**Example: auto-generate lessons from usage patterns**

```sh
akm improve --dry-run        # preview what would be processed
akm improve --limit 20       # run a bounded pass
akm proposal list            # review what was generated
```

**End-of-run auto-sync:** For git-backed stashes (detected by a `.git`
directory), `akm improve` automatically commits all changes as a single batch
at the end of the run — the same operation as `akm sync` — and pushes if the
stash is writable, per the active strategy's `sync` setting. The
`reflect-distill` and `proactive-maintenance` strategies skip sync entirely
(an interrupted run would otherwise leave an uncommitted backlog). Use
`--no-sync` to disable for any single run, or `--no-push` to commit without
pushing. Strategy sync behavior can be configured via the `sync` block under
`improve.strategies.<name>` in your config.

## akm proposal (list, show, diff, accept, reject, revert)

`akm proposal list` lists pending proposals in the queue. Each proposal is an
AI-generated suggested change — an edit to an existing asset, a new lesson, a
memory consolidation, or a deprecation. Review the diff, then accept or reject.

```sh
# List proposals
akm proposal list
akm proposal list --status pending
akm proposal list --ref skills/code-review

# Inspect a proposal
akm proposal show <id>
akm proposal diff <id>                          # Preview the change vs. the live asset

# Apply or discard
akm proposal accept <uuid-or-prefix>
akm proposal accept skills/akm-dream --target team-stash
akm proposal reject <uuid-or-prefix> --reason "duplicates existing workflow"
```

Accepts full UUIDs, 8-character UUID prefixes, or asset refs. `akm proposal accept` runs
full validation before promoting the proposal into your stash.

**Example: review and accept a memory consolidation**

```sh
akm proposal list --status pending
akm proposal diff abc12345             # preview the proposed consolidation
akm proposal accept abc12345           # write it to the stash
```

## akm proposal new

`akm proposal new` authors a brand-new asset via the LLM pipeline — useful
when you want to create something from scratch rather than improving an
existing asset. Output always goes to the proposal queue, never directly to
the stash.

```sh
akm proposal new skill code-review --task "PR-style review skill for TypeScript repos"
akm proposal new lesson docker-cleanup --file ./prompts/docker-cleanup.md
akm proposal new workflow release-checklist --task "Standard steps for shipping a release"
```

After the proposal is generated, review it with `akm proposal diff <id>` and apply with
`akm proposal accept`.

**Example: generate a new lesson from a prompt file**

```sh
akm proposal new lesson deployment-gotchas --file ./prompts/lessons-from-may-incidents.md
akm proposal list --status pending
akm proposal diff deployment-gotchas
akm proposal accept deployment-gotchas
```

## See also

- [Search & Discovery](search-discovery.md) — feedback improves ranking over time
- [Knowledge Management](knowledge-management.md) — capturing memories and docs
- [Agent Integration](agent-integration.md) — wiring feedback into agent workflows
- [CLI Reference](../reference/cli.md) — full flag documentation for `feedback`, `history`, `log`, `improve`, `proposal`, `propose`
- [Concepts](../guides/concepts.md) — how utility scores affect search ranking
