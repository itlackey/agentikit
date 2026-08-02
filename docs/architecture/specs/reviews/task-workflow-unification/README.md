# Review corpus — task/workflow format unification

Reference record for
[`../../task-workflow-format-unification.md`](../../task-workflow-format-unification.md).
Every revision of that spec from v8 onward was shaped by these reviews; the
spec's §11 cross-references findings by the ids used here.

## Round 0 — three independent adversarial reviews of spec v7

Three reviewers, identical briefs, no shared context — overlap between
reports is therefore independent confirmation, and unanimous findings
(3/3) were treated as settled facts.

| File | Contents |
|---|---|
| [`opus-review-1.md`](./opus-review-1.md) | Reviewer 1 full report |
| [`opus-review-2.md`](./opus-review-2.md) | Reviewer 2 full report |
| [`opus-review-3.md`](./opus-review-3.md) | Reviewer 3 full report |
| [`findings-consolidated.md`](./findings-consolidated.md) | Deduplicated findings (C1–C5, M1–M13, minors) with per-reviewer attribution — the ids the spec's §11 uses |

Outcome: v7 → v8 full redesign (IR v4 invocation union, hashVersion 5,
two output schemas, cascade built-not-exposed, `with:`, env provenance
split, migration rebuilt).

## Round 1 — four-lens panel on spec v8

| File | Lens |
|---|---|
| [`panel-r1-coverage.md`](./panel-r1-coverage.md) | Findings-coverage audit: does §11 resolve each round-0 finding, or just name it |
| [`panel-r1-architecture.md`](./panel-r1-architecture.md) | Module boundaries and seams against the codebase's own idioms |
| [`panel-r1-adversarial.md`](./panel-r1-adversarial.md) | Fresh defect hunt on what v8 itself introduced |
| [`panel-r1-security.md`](./panel-r1-security.md) | Script-execution policy, env/redaction contracts, migration mechanics |

Outcome: v8 → v9. Headline: the per-bundle script-execution grant was
withdrawn (contradicted `activation-policy.ts`'s no-new-trust-machinery
decision) in favor of exact 07 P1-D ceiling inheritance; persona snapshot
added to the hash preimage; `with:` merge defined; tombstone read-only
carve-out and interruption-safe conversion ordering.

## Round 2 — verification on spec v9

| File | Lens |
|---|---|
| [`panel-r2-verification.md`](./panel-r2-verification.md) | Every round-1 critical/major re-checked against v9 and code — verdict: **all fixes hold** |
| [`panel-r2-adversarial.md`](./panel-r2-adversarial.md) | Cold pass, no prior context — verdict: no design flaws; two evidence corrections (the real placeholder filler; indexer-classifier recognition), both applied |

## Reading notes

- Reports cite `file:line` against the branch state they reviewed
  (`claude/release-0-9-0-polish-d6sycl` @ `71bb686` + this spec's branch);
  lines drift as the base moves.
- Not every claim in the raw reports survived verification — e.g. round 1's
  "the `tools:` ceiling doesn't exist" was disproven (`show.ts:433-445`).
  Where a report and the spec disagree, the spec's §11 records the
  adjudication and is authoritative.
