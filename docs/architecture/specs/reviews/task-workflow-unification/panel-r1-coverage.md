# Audit of v8 §11 findings cross-reference

Spec: /home/user/akm/docs/architecture/specs/task-workflow-format-unification.md (v8)
Baseline: claude/akm-markdown-tasks-history-75l6du @ current HEAD (d8095a0)
Consolidated findings: scratchpad/review-consolidated.md

Method: for each finding, located v8's claimed resolution via §11's table, read the
referenced section in full, and where v8 makes a factual claim about current code
(to justify the design), re-verified that claim by reading the cited file/lines
directly. Flagged anything that only restates the finding, that is logically
incomplete relative to the finding's actual scope, or that conflicts with another
part of v8 or with a documented architectural decision elsewhere in the codebase.

## Verified genuinely resolved (design-level; spec, not code, so "resolved" = coherent design that actually addresses the mechanism, not just names it)

- C1 (output collision): compile.ts:204 (`step.output` → `outputSchema`) and
  compile.ts:229 (`unit?.output` → `schema`) confirm the two real, distinct
  schema slots v8's §7 two-homes design targets. Accurate and complete.
- C2 (shell units in IR): unit-dispatch.ts:19 confirms `engine: FrozenEngineSnapshot`
  is non-optional today, matching v8's premise; §5.2's discriminated-union +
  per-kind engine resolution is a real fix, not a rename.
- C3 (hash preimage): hashVersion 5 table in §5.3 covers every named gap (run: text,
  shell/cwd, uses: ref + content hash, env literals) and the freeze-time-append
  design in §2.3 correctly resolves the "no single seam" objection.
- C4 (cascade layers): config-schema.ts:102-108 confirms `DefaultsSchema` is
  `.passthrough()` with no `model` field, matching v8's claim; §4's "build, not
  expose" inventory (6 concrete numbered work items) is substantive, not hand-wavy.
- M2 (placeholder grammar): agent-dispatch.ts:67-72 confirms `fillPlaceholders`
  only substitutes positional `{{\d+}}` (matches v7-era `{{0}}` bug claim); named
  `{{name}}` is recognized only by `extractParameters` (renderers.ts) for metadata,
  never filled — confirms the bug is real and v8's with:/with.arguments design
  addresses it.
- M3 (env additive): compile.ts:46 confirms `env?: string[]` — IR literally cannot
  carry literal values today. §5.5's provenance split is a real fix.
- M4 (alias portability): model-aliases.ts confirms `BUILTIN_ALIASES` has only
  `claude`/`opencode` columns (no `"*"`), while the *global* config-level alias
  table already supports a `"*"` fallback (config-schema.ts / model-aliases.ts
  doc comment) — so v8's proposed "give builtins a `*` column too" is consistent
  with an existing pattern, not novel invention.
- M6 (dead kind-gate): freeze.ts:67-73 confirms the exact dead-code shape
  (`llm` computed only when `kind==="llm"`, then guarded on `kind!=="llm"`).
  Accurate; the capability-notice replacement in §4 item 4 is coherent.
- M9 (akm-bin resolution) — see PARTIAL below.
- M11 (freeze IO / lint never freezes): grep confirms `compileResolveFreezeWorkflow`
  has exactly one call site (runs.ts:241). The two-stage compile/resolve/freeze +
  lint dry-freeze design in §5.4 is a real structural fix.
- M12 (defaults.on_error exists today): program/schema.ts:204-211 confirms
  `ProgramDefaults.onError` already exists at document level, exactly as the
  finding states. §4's decision to keep on_error/retry as value fields is a
  direct, correct response.
- M8 (adapter ordering): akm-workflow-adapter.ts:66-70 confirms `isWorkflowFile`
  returns true whenever `type` is undefined or `"workflow"` — any `.md` without a
  contrary `type:` is claimed by the workflow adapter, confirming the collision.
  Making `type: task` mandatory (§3) is a workable, not hand-waved, fix.

## Problems found

C5 | contradicts | v8 §5.6 proposes a new persisted per-bundle trust grant (`bundles.<name>.allowScriptExecution`, settable via `akm setup`/`akm config set`) to unlock third-party script execution — but src/core/activation-policy.ts explicitly documents a 2026-07-14 decision that the "installation is not activation" work "ships no new trust / approval / security machinery: no labeling, action clamps, confirm prompts, digests, trust records, or persisted `workspace_bindings`," and the existing analogous `tools:` provenance ceiling (show.ts:433-445) has no override at all — it unconditionally strips `toolPolicy` for non-primary-stash assets. v8's claimed "same ceiling philosophy" is therefore inaccurate: the tools: ceiling is a hard, ungrantable ceiling, while the new mechanism is an invertible, persisted, named per-bundle opt-in — a materially bigger and different kind of security surface than the finding's own comparison implies, and one that runs directly against a decision already on record in the codebase.

M13 | partial | v8's §11 row points only to "§3 (improve excluded from task bodies)," which resolves the improve-pipeline half of the finding, but the finding's other half — "the akm adapter special-cases type:'task' as pure YAML so markdown checks never fire" (akm-adapter.ts:404-412, confirmed: `parsed = { data, content: raw, frontmatter: null }` for `type==="task"`, explicitly to suppress `missing-updated`) — is never revisited. v8's own §3 examples give tasks substantial free-form prose bodies that are now the literal executable prompt, but no change to the lint/OKF parse path is proposed to give that prose the same base-check coverage other markdown assets get (frontmatter-shaped checks like `unquoted-colon`/`missing-updated` still never fire on tasks); only `stale-path`/`missing-ref` (body-scoped, frontmatter-independent) survive.

M9 | partial | §5.7's fix ("PATH prepend... replacing the argv-rewrite that shell text would defeat") glosses over why `resolveNestedAkmCommand` was built as an argv splice in the first place: `resolveAkmInvocation()` (resolve-akm-bin.ts) can return a *multi-element* invocation (e.g. a node/bun launcher + script path), not always a single standalone binary. A bare PATH prepend only works when there is one real executable file to point `PATH` at; the multi-arg-launcher case needs a synthesized shim (a generated `akm` script that re-invokes `node <path>`), which is materially more than "PATH prepend" and isn't mentioned.

Minor findings with no resolution anywhere in v8 (contradicts §11's blanket "all resolved or explicitly costed" claim and the Minors row's non-exhaustive listing):

- "§3.5 embodiment sentence reads backwards (--model wins over hint)" (1/3) — no trace of this in v8; the section was restructured away but the underlying precedence claim about `--model` vs. an alias/tier hint is never restated or corrected anywhere in v8's aliasing text (§4 item 5).
- "Value fields on `uses: workflows/*` tasks are structurally inert (run-workflow takes ref+params only)" (1/3) — not mentioned; §2.2's table gives `with:` → declared param flags for `uses: workflows/<r>` but never addresses whether cascade value fields (timeout, model, etc.) set on such a task do anything, which was the actual complaint.
- "uses: table covers 5 of ~15 placement types; no rule for the rest" (1/3) — not mentioned anywhere in v8.
- "single-file provenance lost" (part of the 256 KiB composition finding, 1/3) — §5.4 addresses the 256 KiB cap-breach half ("carry the existing... cap with a lint warning at 80%") but not the provenance-loss half of the same finding.

## Notes on things that check out but are worth flagging as "costed, not fixed" (v8 is honest about these, no complaint)

- M4/§4 item 6: gate judge (`judgeEngine`) explicitly stays outside the cascade in 0.9.0 — correctly flagged as deferred rather than claimed resolved.
- M7/§8: migration section is a genuine rewrite against the real migrator, spot-checked one mapping (`name:` → body H1) is plausible; not exhaustively re-verified against `task-target-ref-migration.ts` line-by-line given time budget.
