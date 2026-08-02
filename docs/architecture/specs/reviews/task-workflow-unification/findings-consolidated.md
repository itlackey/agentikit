# Consolidated findings — three independent Opus reviews of spec v7 + codebase

Sources: review-1.md (758 lines), review-2.md (645), review-3.md (602).
"R1/R2/R3" = which reviewers found it independently. 3/3 = unanimous.

## Critical (all confirmed by ≥2 reviewers)

C1. 3/3 — **`output:` is NOT a duplicate; the flatten collides two different schemas.**
    `unit.output` = per-dispatch structured-result schema (LLM responseSchema, structured
    retry, driver --result-file); `step.output` = promoted artifact / reducer result feeding
    the gate loop. Deleting the bag merges them and makes per-item schemas on map steps
    unexpressible. (compile.ts:204,229; step-work.ts:555-561; native-executor.ts:663,928,1092)

C2. 3/3 — **`run:` shell units are unrepresentable in IR v3 / the dispatch seam.**
    UnitDispatchRequest.engine and IrInvocation.engine are required; FrozenEngineSnapshot is
    a closed 2-kind union; freeze hard-errors with no engine; IR rejects empty instructions;
    no shell runner exists; brief/report behavior undefined. §10's "no IR/freeze changes" is
    false. (unit-dispatch.ts:15-19; ir/schema.ts:29-85,434-441,481-497; freeze.ts:49-75)

C3. 3/3 — **The unit input-hash preimage is unaddressed → silent replay-reuse bugs.**
    hashVersion 4 hashes template instructions/item/inputs/params/dispatch/env NAMES only.
    run: text, uses: refs, cwd, shell, appended prose, and env literal values are all
    outside the preimage; editing any of them would reuse completed journal rows. The
    prose-append also can't happen "at one seam" — prompts are assembled per-unit at
    dispatch (item/inputs/gate blocks), so the append must be a freeze-time concat plus a
    hash-version bump. (step-work.ts:333-393,473-500)

C4. 3/3 — **The cascade's far layers don't exist; the worked example is a no-op today.**
    DefaultsSchema has no `model` (passthrough swallows it silently); `defaults.llm` is
    explicitly hard-rejected as retired; freeze's layer list is only [documentDefaults,
    unit]; there is no persona layer. The spec presents "exposing an existing mechanism";
    reality is a 2-layer mechanism that must be extended to 5.
    (config-schema.ts:102-108,234-241; freeze.ts:50,163-209)

C5. 2/3 — **`uses: scripts/*` reverses a documented security boundary.**
    Script run/setup/cwd frontmatter is advisory/display-only today; "registering a bundle
    never activates code" is an explicit invariant; executing a third-party bundle's script
    at cron time is net-new RCE surface with no activation-policy rule.
    (indexer/passes/metadata.ts:140-144; renderers.ts:118-142; core/activation-policy.ts)

## Major

M1. 3/3 — **`params` acquires 3-4 conflicting meanings** (frontmatter schema declarations,
    workflow run-args, command placeholder fills, cascade value field) — the same
    indictment the spec levels at `prompt:`. Cascaded params also violate the params-are-
    non-secret/un-redactable contract and inject undeclared names the flag validators
    reject. (ir/params.ts:34-72; param-secrets.ts:9-19; akm-workflow.json:22-32)

M2. 3/3 — **Command-template filling contradicts the real placeholder contract.**
    Placeholders are $ARGUMENTS/$1-$9 positional (+ {{name}} advertised, but
    fillPlaceholders only substitutes positional {{0}} leniently — a live bug); named
    `params:` has no projection onto positionals; the proposed fill-time hard error makes
    every $ARGUMENTS command unusable as a target. (renderers.ts:164-186;
    matchers.ts:126; agent-dispatch.ts:63-72)

M3. 3/3 — **`env:` list shape is NOT additive.** IR types env as string[]; the input hash
    deliberately carries env NAMES ONLY (values never durable); literal values would be
    frozen into plan_json, hashed, and surfaced by brief; every resolved value joins
    sensitiveValues with no floor, so `LOG_LEVEL: debug` over-redacts "debug" everywhere;
    AKM_ITEM fan-out needs per-unit env (env resolves once per step today).
    (ir/compile.ts:46; step-work.ts:353-357,387; native-executor.ts:449-457,1163-1193)

M4. 3/3 — **Alias portability claim unimplemented.** BUILTIN_ALIASES has only
    claude/opencode columns; `model: sonnet` passes through verbatim to LLM endpoints and
    opencode-sdk. (model-aliases.ts:45-76,103-109)

M5. 2/3 — **`agent:` selector needs plumbing + a provenance decision.** systemPrompt and
    toolPolicy cannot reach a workflow unit; the self-declared `tools:` policy is gated by
    a writable-vs-third-party provenance ceiling applied at the show layer that freeze
    knows nothing about. ALSO: the spec's corroboration "command assets already read an
    agent: field" is FALSE — it's a type-classification signal; nothing consumes the value.
    (native-executor.ts:1026-1035; renderers.ts:250-262; matchers.ts:234-236)

M6. 2/3 — **The kind-gated llm hard error §3.4 argues against is dead code in freeze** —
    computed only when kind==="llm", then guarded kind!=="llm" && llm!==undefined
    (unreachable); workflows silently DROP llm overrides on agent engines; the live error
    exists only on the task path. (freeze.ts:67-73; runner.ts:497-502)

M7. 3/3 — **Migration section overclaims.** Not a byte-rewrite (existing migrator rewrites
    scalars in place, journals byte diffs, refuses read-only bundles; .yml→.md renames
    break that model); `name:` silently dropped; llm.supportsJsonSchema/contextLength/
    enableThinking have no home in the nine value fields; command ARRAYS have no shell
    spelling; "strays named by path" is not structural — refusals key on config/DB shape,
    not leftover files, and placement/sync filter by extension, so a stray .yml is invisible
    or wrongly installed; `<id>.yml` + `<id>.md` collide on one conceptId.
    (task-target-ref-migration.ts:27,44-66; asset-placement.ts:159-170; tasks.ts:155-164,414)

M8. 2/3 — **Markdown-task recognition collides with the .md-claiming workflow adapter**
    (ordered first; claims any .md without a different type:), so `type: task` is mandatory
    and "tasks/ residence" recognition is unimplementable as written; contradicts
    okf-support.md's current text; akm-task format-family goldens are marked immutable.
    (adapters/index.ts:73-90; akm-workflow-adapter.ts:60-76)

M9. 2/3 — **`run:` shell text defeats akm-bin resolution.** resolveNestedAkmCommand
    rewrites bare `akm` in pre-split argv to the current installation; all ten shipped
    templates depend on it; shell text makes it impossible without sniffing.
    (runner.ts:277-289,343-348; command-executable.ts:10-22)

M10. 2/3 — **Optional prose contradicts two live invariants** — the parser errors on a
    missing/empty step section and the IR rejects empty instructions.
    (workflows/parser.ts:281-296; ir/schema.ts:434-441)

M11. 1/3 — **uses: tasks/<id> makes freeze IO-dependent, and lint never freezes** — all
    composition errors escape lint (freeze has exactly one caller: run start); cross-bundle
    ref scoping undefined. (freeze.ts:39-43; runs.ts:241)

M12. 2/3 — **`defaults.on_error` already exists at document level** — "graph keys are
    steps-only" silently deletes it; no §8 migration row. (program/schema.ts:210; compile.ts:231)

M13. 1/3 — **Markdown tasks inherit the lint/OKF/improve surface** — the akm adapter
    special-cases type:"task" as pure YAML so markdown checks never fire; an
    improve-eligible body is now the literal executable prompt of a scheduled agent.
    (akm-adapter.ts:388-434)

## Notable minors (deduped)

- `status: draft` overloads OKF lifecycle with scheduler activation — second gate beside
  `enabled:`, no precedence, `deprecated` undefined. (2/3)
- `prompt: agents/x` today ships RAW file bytes incl. frontmatter to the model — live bug,
  worse than §3.5 states. (2/3)
- §3.5 embodiment sentence reads backwards (--model wins over hint). (1/3)
- Engine nodes are .passthrough() with blacklists — "strict schema" claim overstated;
  cwd/shell/env/params would be silently accepted. (2/3)
- Trigger-keys claim inaccurate: the runner also gates `enabled` at fire time. (1/3)
- Value fields on `uses: workflows/*` tasks are structurally inert (run-workflow takes
  ref+params only). (1/3)
- Subdir task ids: placement indexes `sub/x` but validateTaskId rejects `/` — inherited
  bug; `.yml` hardcoded in id length budget. (1/3)
- Embedded templates: enumeration filters .yml, drops non-command targets; setup's YAML
  round-trip would destroy markdown bodies. (2/3)
- Model aliases: gate judgeEngine sits outside the cascade. (1/3)
- Composition can breach the 256 KiB instruction cap; single-file provenance lost. (1/3)
- task_history.target_kind is a persisted 3-value enum the vocabulary outgrows. (1/3)
- cwd × isolation:worktree × llm-runner interaction unspecified. (1/3)
- uses: table covers 5 of ~15 placement types; no rule for the rest. (1/3)

## Verified accurate (all three ran verification passes)

The §2 freeze-cascade description, the UnitDispatchRequest field inventory, the
resolveModel 4-tier chain, engines.ts kind-split (as blacklists), the 368-line parser and
87-line orphan schema counts, the scheduler-ABI stability claim, and the journaled
0.9.0 migration extension point all check out.

## Convergent verdict

Direction (markdown tasks, uses:/run:, steps-are-tasks, cascade *shape*) survives.
The spec's §10 non-goals are false: this IS an IR + freeze + hash-version change and must
be costed as one. Required redesigns before implementation: keep two output concepts;
specify the shell unit kind in IR + dispatch; freeze-time prose concat + hash bump; build
(not "expose") the 5-layer cascade; split params' meanings (GHA's inputs/with split exists
precisely for this); a security/activation-policy design for script execution; rewrite §8
migration against the real migrator mechanics.
