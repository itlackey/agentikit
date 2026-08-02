# Adversarial review — task-workflow-format-unification.md v9 (round 2, cold read)

Scope: read the spec cold, then verified its file:line evidence against the actual
tree at HEAD (`ec5d062`, branch `claude/akm-markdown-tasks-history-75l6du`) for
src/workflows, src/tasks, src/core, src/integrations/agent, scripts/akm-migrate.
Most citations were spot-checked directly; two rounds of prior Sonnet panel
review already landed on v8→v9, so this pass hunts specifically for what those
missed rather than re-litigating settled findings (all of which I re-verified
and found accurate: freeze.ts:50/67-73 dead llm guard, config-schema.ts
DefaultsSchema passthrough + no model field + defaults.llm/agent/improve
hard-rejected at line ~234-241, show.ts:433-445 tools: ceiling, runner.ts:592-593
raw-frontmatter bug, activation-policy.ts's no-new-trust-machinery decision,
task-target-ref-migration.ts:25 importing the live `src/tasks/parser`,
compile.ts:204/229 output vs outputSchema split, param-secrets.ts's
detectSecretShapedParams, model-aliases.ts's claude/opencode-only columns,
step-work.ts hashVersion 4 preimage, WORKFLOW_IR_VERSION currently 3).

## Findings

### MAJOR — §2.4's cited "current filler" evidence points at the wrong function; the actual bug lives in a different, unmentioned call site

§2.4 states: "the current filler substitutes only positional `{{0}}` forms
leniently (`src/output/renderers.ts:164-186` — a live bug fixed by this work)."

`src/output/renderers.ts:164-186` is `extractParameters()`, called only from
`commandMdRenderer.buildShowResponse` (line 235) to populate the `parameters`
field shown by `akm show`. It does not fill or substitute anything — it just
regexes the template for `$ARGUMENTS`/`$1-9`/`{{name}}` names for display.

The actual filler with exactly the described `{{0}}`/`{{1}}`-only lenient
behavior is `fillPlaceholders()` in `src/commands/agent/agent-dispatch.ts:67-72`,
used by `akm agent --command <ref>` dispatch (a CLI entry point the spec never
mentions). This is a load-bearing citation — it's the concrete evidence
anchoring §2.4's entire contract and the §9 "inherited bugs fixed en route"
line — and it misdirects an implementer to a display-only function while
leaving the actual buggy code, and its actual call site, uncited. It also
hides a real open question the spec doesn't address: does the new
cascade-driven `with:`/`$ARGUMENTS`/`{{name}}` filler specified in §2.4
replace `agent-dispatch.ts`'s `fillPlaceholders`, or do the two now coexist
with different (old lenient-`{{0}}`-only vs new full-grammar) semantics for
the same command asset type depending on dispatch path? The spec is silent.

Refs: `docs/architecture/specs/task-workflow-format-unification.md:113-114`,
`src/output/renderers.ts:164-186,220-238`, `src/commands/agent/agent-dispatch.ts:14-16,63-72`.

### MAJOR — §3's "recognition requires `type: task`" evidence covers only bundle-root probing; the actual per-file indexer classifier that types ordinary `tasks/*.md` files has no task branch at all, and has an ordering hazard the spec's own example would trip

§3 argues residence-only recognition is unimplementable "because the workflow
adapter is ordered first and claims `.md` files without a contrary `type:`"
citing `src/core/adapter/adapters/index.ts:73-90`. That citation (plus
`akm-workflow-adapter.ts`'s `isWorkflowFile`, which returns true when
`type === undefined`) is accurate, but it is evidence about **single-file
bundle-root detection** (`akmWorkflowAdapter`/`akmTaskAdapter` `looksLikeRoot`,
i.e. "is this repo root itself one task/workflow file") — a different code
path from the one that actually assigns a `type` to every ordinary file inside
a ordinary akm stash during `akm index`, which is `src/indexer/walk/matchers.ts`
(consumed directly by `akmAdapter`, per `akm-adapter.ts:27`).

In that classifier:
- `classifyBySmartMd` (matchers.ts:199-248) special-cases `fm.type === "workflow"`
  (line 223-225) but has **no `fm.type === "task"` branch at all** today.
- The `tasks/` directory rule (`DIR_TYPE_MAP`, matchers.ts:98-105) only tests
  `ext === ".yml"` — a `tasks/<id>.md` file gets **zero** directory-based
  specificity from either `classifyByDirectory` or `classifyByParentDirHint`
  today, contrary to what "residence is a lint expectation" implies is already
  meaningfully wired.
- Absent a new, correctly-ordered `type === "task"` branch, the classifier's
  existing `"agent" in fm → { type: "command" }` rule (matchers.ts:234-236)
  fires first and would misclassify the spec's *own* first example task (§3,
  `agent: agents/reviewer` top-level key) as a command, exactly the kind of
  silent miswiring the workflow branch at line 223 was positioned early to
  avoid.

§9's cost-inventory line ("markdown task recognition (`type: task`)") doesn't
name matchers.ts, the DIR_TYPE_MAP fix, or this ordering hazard, so an
implementer following only the cited evidence can miss the actual mechanism
that has to change and can reproduce the ordering bug live in the spec's own
worked example.

Refs: spec `docs/architecture/specs/task-workflow-format-unification.md:135-139`;
`src/indexer/walk/matchers.ts:98-105,199-248`;
`src/core/adapter/adapters/akm-adapter.ts:27`;
`src/core/adapter/adapters/akm-workflow-adapter.ts:69`.

### MINOR — "document defaults" layer's applicability to a bare (non-referenced) task is left to inference

§4's six-layer cascade table lists `document defaults:` as a layer distinct
from `uses: tasks/<ref>` and `step/task keys`, but §3's task schema shows no
`defaults:` sub-block for a standalone task file — only workflows have
`asset.document.defaults` today (`freeze.ts:52`). It's a reasonable inference
that "document defaults" is workflow-only and collapses/no-ops for a bare
task, but the spec never says so explicitly, and a task that both composes
another task (`uses: tasks/<ref>`) *and* wants its own "defaults for this
document" layer (as opposed to its own directly-set fields) has no described
home. Low risk — an implementer would likely get this right by analogy to the
existing `documentDefaults` special-casing in freeze.ts — but it's a genuine
gap in an otherwise very precisely specified cascade.

Refs: spec §4 layers table (line 238); `src/workflows/ir/freeze.ts:52`.

### MINOR — script/task "resolved content hash" for the tools: ceiling doesn't state whether frozen workflow plans re-read script bytes at dispatch

§5.3's hash preimage records "target kind + `uses:` ref + resolved content
hash" for re-dispatch invalidation, implying script *bytes* are not made
durable in the plan the way command templates are (§2.4 says command
templates are filled and frozen). If a script referenced by a frozen workflow
plan is edited between freeze and (possibly much later, queued) execution,
the plan's content hash goes stale for journal/idempotency bookkeeping, but
the spec doesn't say whether execution reads the live file (current bytes) or
a frozen copy, and doesn't note this as a deliberate asymmetry vs. commands.
Not a security issue (the ceiling only gates non-primary-stash sources, and
editing your own primary-stash file is expected), but worth one sentence so
an implementer doesn't have to guess whether "resolved content hash" implies
plan-embedded bytes.

Refs: spec §5.3 preimage table (line 368); §2.4 (lines 126-128, "filling
happens at freeze... producing the prompt string").

## Verdict

No criticals found. The two majors above are citation/evidence gaps rather
than design contradictions — the underlying design decisions (§2.4's contract,
§3's `type: task` requirement) are themselves sound and match the codebase's
real needs; what's wrong is that the evidence anchoring them points at the
wrong or incomplete code, which is exactly the kind of thing this spec has
otherwise been extremely disciplined about getting right (nearly every other
citation checked out verbatim, including several with exact line numbers).
An implementer working strictly from the cited evidence would fix the wrong
placeholder-filler function and would very plausibly ship a task-recognition
patch that misclassifies its own worked example. Both are cheap to fix in the
spec (retarget the citations, name matchers.ts + DIR_TYPE_MAP + the ordering
requirement) before implementation starts.
