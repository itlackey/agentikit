# 0006 — Task source version routing, from three generations to one

## Context

Between P2a and P4, `src/tasks/source/parse-task-source.ts` was the one
place every task document's `version:` field got routed to a parser.
Through that window there were three live generations to route between:
task v2 (retired at the router itself, with a dedicated unsupported-version
error), task v3 (the shipped grammar every existing task file on disk still
used), and task source v4 (the new grammar P2a introduced). The router had
to dispatch to the right parser without a second parse, a re-serialization,
or a synthetic document — an invariant P1b §4.3 established for the
front end and every later phase carried forward unchanged.

Two things about that routing were the module's own, deliberately preserved
warts, recorded as such at the time rather than fixed:

1. The bounded YAML front end's pre-version failures (source not a string,
   source too large, YAML parse/warning/expansion) render with a fixed
   label — `"task v3 source"` — even when the document under parse turns out
   to declare `version: 4`, because `root.version` cannot be read until the
   front end has already succeeded or failed. P2a's spec explicitly deferred
   fixing this: "P4 owns the final label once v3 is gone."
2. For any `version:` other than `2`, `3`, or `4`, the router fell through to
   `parseTaskV3Document`'s OWN wording — "version is required and must be
   exactly 3." — a message that names the wrong number for a document that
   was never v3 in the first place. This was also deliberately deferred:
   "P4 owns the final version-error text."

## Decision

Moved verbatim from `src/tasks/source/parse-task-source.ts`'s module header,
as it read from P2a through the end of P3b (immediately before P4 §3.2
rewrote it):

> The task source version router (spec docs/plans/specs/p2a-task-source-v4.md
> §3.4, §1.5 D2-N2).
>
> Runs the bounded YAML front end ONCE (`readBoundedTaskSourceYaml`), reads
> `root.version`, and dispatches into `parseTaskV3Document` (unmodified,
> exported from `../source-v3`) or `parseTaskSourceV4Document` with that
> SAME `{root, lineAt}` — no second parse, no re-serialization, no synthetic
> document (the P1b §4.3 invariant this phase carries forward).
>
> D2-N2's exact routing table:
>
> | root `version` | routed to | observable result |
> |---|---|---|
> | `4` | `parseTaskSourceV4Document` | new grammar |
> | `3` | `parseTaskV3Document` | byte-identical to today |
> | `2` | `parseTaskV3Document` | byte-identical (raises `taskV2UnsupportedError` itself) |
> | absent/other | `parseTaskV3Document` | byte-identical (its own preserved wording) |
>
> Only `version: 4` needs an explicit branch: `parseTaskV3Document` already
> raises `taskV2UnsupportedError` for `version: 2` and its own "version is
> required.../must be exactly 3" wording for everything else
> (`source-v3.ts:720-722`) — a DELIBERATELY preserved wart, not fixed here
> (P4 owns the final version-error text).
>
> The front end's own pre-version failures (source not a string, source too
> large, YAML parse/warning/expansion) ALWAYS render with the "task v3
> source" label, even when the document later declares `version: 4` —
> `root.version` cannot be read until the front end already succeeded. This
> is a deliberate, spec-recorded wart (§3.4): "P4 owns the final label once
> v3 is gone."

P4 §3.2 (`docs/plans/specs/p4-deletions-closeout.md`) removed task source v3
acceptance from `src` entirely (§3 family A2) and, in the same commit,
rewrote the router to close both warts. The terminal routing table, in
place since:

| root `version` | outcome |
|---|---|
| `4` | `parseTaskSourceV4Document` — the new grammar (row B-13) |
| any other number | `TASK_SCHEMA_VERSION_UNSUPPORTED`, naming the migrator (rows B-14/B-15) |
| absent / not a number | `parseTaskSourceV4Document`'s own `TASK_SOURCE_INVALID` "version is required and must be 4" / "must be exactly 4" wording (row B-16) |

A missing or non-numeric `version:` still routes into the v4 parser rather
than the generic unsupported-version rejection — that part of the shape is
unchanged from the original design — because a document with no readable
version was never task v2 or v3 in the first place, and the v4 parser's own
field error names the one grammar `src` still accepts.

## Consequences

- **Wart 1 closed (row B-17).** The front end's pre-version failure label is
  now `"task source"` — version-agnostic, since at that point in parsing no
  version has been read yet — instead of the `"task v3 source"` label that
  used to leak the retired generation's name into an error about a document
  that might turn out to be `version: 4`.
- **Wart 2 closed (row B-16).** A document with an unreadable `version:`
  (missing, or not a number) now gets the v4 parser's own "is required and
  must be 4." / "must be exactly 4." wording, naming the grammar `src`
  actually accepts, instead of `parseTaskV3Document`'s inherited "must be
  exactly 3." — which named a generation the document was never going to be.
- **The routing table shrank from three live branches to one.** `version: 3`
  and `version: 2` no longer parse at all — both now raise
  `TASK_SCHEMA_VERSION_UNSUPPORTED` with the migrator hint (rows B-14, B-15),
  where they used to route to `parseTaskV3Document` and execute
  byte-identically to any other release. This is the observable break every
  task v3 (and v2) file on disk hits; `docs/migration/v0.9.1-to-v0.9.2.md`
  and `CHANGELOG.md` document the remedy (`akm migrate apply`).
- **The router no longer imports `../source-v3` for a parser call at all.**
  `parseTaskV3Document` moved to the frozen, vendored migrator copy
  (`scripts/akm-migrate/migrate/task-source-v3-frozen.ts`) — the router's
  only remaining job is: is this `version: 4`, or not.
- `ParsedTaskSource` collapsed from a two-member discriminated union
  (`{version: 3, v3: ...} | {version: 4, v4: ...}`) to the single-member
  shape `Readonly<{version: 4; v4: TaskSourceV4Document}>` — every consumer
  that used to branch on `parsed.version === 4` simplified to its v4 arm.

## Provenance

- Source: `src/tasks/source/parse-task-source.ts` module header, as it read
  from P2a (`git show 0f16f70fdc61:src/tasks/source/parse-task-source.ts`)
  through immediately before P4 §3.2's rewrite.
- Spec: `docs/plans/specs/p2a-task-source-v4.md` §3.4, §1.5 D2-N2 (the
  original routing design and both recorded warts);
  `docs/plans/specs/p4-deletions-closeout.md` §3.2.2, §4.2 (the rewrite that
  closed both warts and required this ADR).
- Extracted: P4, 2026-08-28 (review finding against this phase's own
  close-out spec — the index row for this ADR existed from P4's ADR-move
  commit onward, but the file itself was not authored until this
  correction).
