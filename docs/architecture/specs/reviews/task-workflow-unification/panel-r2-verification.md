# Round-2 verification of v9 against round-1 Sonnet panel (coverage/architecture/adversarial/security)

Spec: docs/architecture/specs/task-workflow-format-unification.md, v9 (ec5d062), branch
claude/akm-markdown-tasks-history-75l6du. Baseline for code claims: same checkout.

Method: for every critical/major in the four r1 reports, located the v9 text via §11's
cross-reference table, read the cited section in full, and where the fix leans on a
factual code claim, re-verified the claim by reading the cited file. Then checked the
new text against the rest of v9 for reintroduced contradictions, with extra scrutiny on
the five areas called out (§5.6 ceiling, persona-snapshot hash, `with:` merge, tombstone
+ crash-window ordering, shim vs resolve-akm-bin.ts).

## Criticals — all four verified fixed, no reintroduced contradiction

- **coverage C5** (§5.6 grant contradicts activation-policy's no-new-trust decision):
  v9 deletes the `bundles.<name>.allowScriptExecution` grant entirely and replaces it
  with exact inheritance of the existing `tools:` provenance ceiling (primary-stash-only,
  no override, fail-closed) — verified `show.ts:433-445` really has no override
  (`if (response.toolPolicy !== undefined && !isPrimaryStash) delete ...`), matching v9's
  description exactly. `activation-policy.ts`'s "no new trust machinery" decision (header
  comment, 2026-07-14) is respected: zero new config, zero persisted state. Fixed.
- **security "grant mechanism doesn't exist" / "ceiling philosophy unverified"**: moot —
  v8's grant is withdrawn. The second half of this finding (reviewer claimed the `tools:`
  ceiling "was not found" in code) is factually wrong — it exists at `show.ts:433-445` —
  and v9 §11 correctly flags this as the one rejected panel claim. Confirmed correct.
- **adversarial "`with:` merge/replace semantics undefined"**: §2.2 now states the rule
  explicitly — per-key shallow merge on a step→task→(command|workflow) composition chain,
  referencing step wins, `with.arguments` replaced whole. Checked against §2.3 ("no
  nesting: a task referencing a task is an error") — the chain is capped at depth 1
  exactly where the merge rule assumes it stops, no gap. Checked against §4 ("`with:` is
  not a value field... merges per-key at its target, outside the cascade") — value-field
  cascade (§4's layer list, which includes `uses: tasks/<ref>` as a layer) and `with:`
  merge are two disjoint mechanisms over two disjoint key sets; no overlap, no
  contradiction. Fixed.
- **adversarial "hashVersion 5 omits persona snapshot"**: §5.3's table now has a
  `persona snapshot hash` row (system prompt, tool policy, value fields). Matches §4.2's
  persona-snapshot shape (`{systemPrompt, toolPolicy, model, …valueFields}`) verbatim —
  same field list on both sides. Fixed, consistent.
- **adversarial "`.yml` tombstone hard-error has no remedy for read-only bundles"**: §8
  now carves out read-only/third-party bundles to a warning instead of a hard error,
  explicitly citing it as matching the existing migrator precedent. Verified against
  `scripts/akm-migrate/migrate/legacy/task-target-ref-migration.ts:246-266` —
  `planTaskTargetRefMigration` really does skip non-writable bundles and warn-and-continue
  for legacy files it can't rewrite, word-for-word the precedent v9 claims. Fixed.

## Majors — verified fixed unless noted

All of the following were checked and are substantively addressed with no new
contradiction: architecture's five majors (task-path staging named in §5.1 as
"resolve → execute"; `RunnerSpec`-vs-`UnitDispatchRequest` split pushed to the sink
per §5.1; `ShellUnitExecutor` explicitly extracted from the task runner's hardened path,
not rebuilt; monotemporal composition rule pins config-snapshot timing for `uses:
tasks/<ref>`; persona resolver extraction named and costed in §9); adversarial's
`extra_params` deep-merge preservation (§4 merge-classes, matches `freeze.ts:211-216`
`mergedLlmOverrides`/`deepMergeConfig` exactly), shell `timeoutMs` slot (§5.2), shell
crash/lease semantics (§5.2), persona-toolPolicy-vs-engine-capability reconciliation
(§4.2's "unconsumed-field notice" line folds it into §4 item 4's capability-notice
mechanism); security's composition-chain bypass (§5.6 bullet 3, "inherit from the
defining asset's own source"), grant-granularity/bundle-update bypass (moot — grant
removed), sync-vs-fire-time gap (§5.6 bullet 2, evaluated at resolution not at
sync/enable time), `env:` literal-secret-heuristic reuse (§5.5, points at
`param-secrets.ts`'s `detectSecretShapedParams` directly), `AKM_ITEM` shell-injection
story (§5.5 pins it to the `exec-utils` env-object pattern, never shell-text splice),
and the two-file migration atomicity gap (§8 states journal-then-verify-then-delete
ordering explicitly as new work, costed in §9, rather than claiming the existing
4-artifact `migration-backup.ts` model already covers it — checked, that model really
is scoped to `config.json`/`state.db`/`workflow.db`/`index.db` only, so v9's honesty
about this being an extension is accurate, not a claim contradicted by code).

- **coverage M13 (improve-exclusion mechanism)**: §3 now removes the `type:"task"`
  pure-YAML special-case (markdown base checks fire) and separately declares tasks
  improve-ineligible via a per-type adapter capability. The capability-declaration
  *pattern* genuinely exists today (`bundle-adapter.ts:9`, "one interface, optional
  capability methods"), so naming that seam is not fabricated — but the concrete
  eligibility check in `src/commands/improve/eligibility.ts` is currently a hardcoded
  `indexed.entry.type === "..."` string comparison, not adapter-capability-driven; v9
  doesn't say eligibility.ts itself gets refactored to consult the new capability
  rather than its own type-string list. Not a contradiction, but thinner than "names a
  mechanism" suggests — residual gap, not blocking.
- **coverage M9 / adversarial-adjacent (akm-bin shim)**: §5.7's synthesized-shim design
  (write a temp-dir `sh`/`.cmd` shim invoking the exact resolved multi-element
  invocation, PATH-prepend the shim's directory) matches `resolve-akm-bin.ts`'s actual
  return shape (`argv: string[]`, up to two elements for the npm/checkout launcher
  cases) — the shim approach correctly generalizes to the multi-element case a bare PATH
  prepend cannot. Fixed.

## Special-attention items — findings

1. **§5.6 ceiling enforceability at both resolve points**: the mechanism itself
   (primary-stash-only, checked at the point the target asset is resolved, no override)
   is sound and symmetric for workflows and tasks. However, v9 states the enforcement
   point as "freeze for workflows, dispatch for tasks" — but §5.1 (this same v9 revision)
   explicitly renames task staging to **"resolve → execute"** (no stage named "dispatch"),
   and §5.4 explicitly splits workflow freeze into **compile → resolve → freeze**, with
   asset loading (the thing the ceiling needs to inspect) happening in **resolve**, not
   in the now-narrower **freeze** ("snapshot + hash" only). So §5.6's own enforcement-point
   language doesn't line up with the stage names v9 itself just introduced elsewhere
   (§5.1, §5.4) to fix the architecture panel's "staging is unstated" finding. This is
   cosmetic (both "resolve" and "freeze"/"dispatch" as used here occur before any
   shell/agent actually spawns, so no execution-order security gap results), but it is a
   real terminology inconsistency introduced by the v9 redesign, not present as such
   before the two staging fixes existed to be inconsistent with. Not blocking; a
   copy-edit item.
2. **"scope: non-AI exec surface only" loophole for third-party `run:` tasks scheduled
   via sync review**: no loophole found. §5.6's own definition of "shell-class work"
   explicitly includes "the `run:` text of a task," so a third-party task whose target is
   `run:` is covered by the ceiling and refuses regardless of whether the operator
   reviewed and enabled it via `sync` (activation-policy rule 3 is a separate, orthogonal
   gate that only concerns *whether the task fires at all*, not *whether its shell target
   is trusted*). The "agent-dispatched third-party tasks... unchanged" carve-out only
   exempts prose/agent-dispatch tasks (which have no direct shell surface here), not
   `run:`/script tasks. No new hole.
3. **Persona-snapshot hash vs §4.2 resolver extraction**: consistent — §5.3's new row
   lists exactly the fields §4.2's snapshot shape defines (systemPrompt, toolPolicy,
   value fields), and both are attributed to the same extracted resolver.
4. **`with:` merge rule vs §4 cascade and §2.3's override bullet**: consistent — verified
   above, disjoint mechanisms, no double-counting.
5. **Tombstone carve-out + crash-window ordering vs §8's journal claims and the real
   migrator**: consistent — the read-only carve-out matches
   `task-target-ref-migration.ts`'s existing warn-and-skip behavior; the create-verify-
   delete ordering is honestly presented as new work extending (not already covered by)
   `migration-backup.ts`'s 4-artifact model, and it's costed in §9's "Named refactors" row.
6. **Shim design vs `resolve-akm-bin.ts`**: consistent — the shim generalizes correctly
   to the multi-element launcher case `resolveAkmInvocation()` can return.

## Verdict

ALL FIXES HOLD.

Residual (non-blocking) notes:
- §5.6's "freeze for workflows, dispatch for tasks" enforcement-point language uses stage
  names that don't match the stage vocabulary §5.1/§5.4 just introduced in this same
  revision ("resolve → execute" for tasks; compile→resolve→freeze for workflows, with
  asset resolution living in "resolve" not "freeze"). Suggest wording as "resolve for
  workflows, resolve for tasks" (or just "at resolve, for both") to align with §5.1/§5.4.
- §3's improve-ineligibility fix correctly names an existing capability-declaration
  *pattern* in the adapter interface, but doesn't state that
  `src/commands/improve/eligibility.ts`'s current hardcoded `entry.type === "..."` checks
  need to be rewired to consult that capability — worth a one-line addition if precision
  matters, but doesn't reopen the original finding (a mechanism is now named, whereas
  before none was).
