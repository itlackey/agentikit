# 0010 — The external driver protocol was cut

## Context

An earlier design considered an external driver protocol for workflow
execution: `workflow brief` / `workflow report` verbs plus a `--settle`
flag, giving an outside process a way to drive a run step-by-step instead
of `akm`'s own native engine executing it end to end.

## Decision

Cut. AKM's native engine (`src/workflows/exec/native-executor.ts`) is the
only executor; no external driver protocol was implemented or shipped in
any 0.9.x release.

This ADR is a stub, not the normative record. The full decision — including
the option considered, the evidence gathered, and the verification greps
proving nothing in `src/` implements the cut surface — lives in
`docs/architecture/specs/driver-protocol-keep-or-cut.md`, which this stub
exists only to make discoverable from the ADR index (this refactor's design
history otherwise lives entirely under `docs/architecture/decisions/`).

## Consequences

See `docs/architecture/specs/driver-protocol-keep-or-cut.md` for the full
consequence analysis. In short: `workflow_run_units` has had exactly one
consumer (the native executor) throughout, with no dual-executor
compatibility surface to maintain.

## Provenance

- Normative record: `docs/architecture/specs/driver-protocol-keep-or-cut.md`.
- Cross-referenced from: `docs/plans/0.9.2-architecture-deletion-audit.md`'s
  "Deleted architecture" table; `docs/architecture/specs/
  workflow-engine-buy-vs-build.md` §7 (Recommendation).
- Extracted: P4 (`docs/plans/specs/p4-deletions-closeout.md` §4.2), 2026-08-27.
