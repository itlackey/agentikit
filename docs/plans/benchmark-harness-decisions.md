# Decision Register: Benchmark Harness Consolidation

**Status:** Live — updated as decisions are made. Last reconciled against
executed results 2026-08-25.
**Companion to:** [`benchmark-harness-consolidation.md`](./benchmark-harness-consolidation.md) §8
**Numbers:** [`benchmark-tuning-findings.md`](./benchmark-tuning-findings.md) is
the source of truth for every figure quoted here; the reports it derives from are
committed under `akm-bench/results/harbor/<date>/`.
**Branch:** `claude/akm-benchmark-measurement-75rpsg`

Each decision is numbered to match §8 of the brief. `DECIDED` entries carry the
consequence that follows from them — the point of this file is that later phases
can be checked against it without re-litigating.

| # | Decision | Status | Blocks |
| --- | --- | --- | --- |
| D1 | Longitudinal workflows (`evolve`, `attribute`) | **DECIDED — never exercised** | P7 |
| D2 | How akm reaches the trial container | **DECIDED + proven live** | P0 |
| D3 | Network policy for the akm arm | **RESOLVED for the scope actually run** | P2 |
| D4 | Canonical reward shape | **DECIDED** (provisional lifted) | P3 |
| D5 | Where workflow-compliance is scored | **DECIDED by implementation** (post-hoc) | P4 |
| D6 | Cold-start library content | **BUILT — quality still unmeasured** | P2 |
| D7 | Cross-task accumulation policy | **SUPERSEDED by D15** (two arms ran, not three) | P2 |
| D8 | Which upstream memory harness `akm-eval` adapts | **DECIDED by implementation** | P6 |
| D9 | Judge-model cost budget | **OPEN** (narrowed: coding side measured) | P6 |
| D10 | Slice / fixture delivery / token budgets / masking | **DECIDED + amended** | P3 |
| D11 | Ownership of `akm-plugins/evals` | **OPEN** (untouched by this work) | — |
| D12 | Harbor version pin | **DECIDED + held** (14/14 throughout) | P2 |
| D13 | SWE-bench A/B | **DROPPED** (2026-08-25) | — |
| D14 | terminal-bench 2 at full scale | **NOT RUN** (2026-08-25) | — |
| D15 | Accumulating arm | **PARKED, not dropped** (2026-08-25) | — |

D13-D15 are not in the brief's §8 numbering — they are scope decisions taken
during execution and recorded here because they change what the programme
measures. See [Scope decisions](#scope-decisions-taken-during-execution-2026-08-25).

---

## Decided

### D1 — Longitudinal workflows: keep, orchestrated outside Harbor

`evolve` and `attribute` stay. akm-bench keeps a thin multi-run orchestrator that
calls `harbor run` repeatedly and performs the feedback / improve / accept /
reindex / mask steps *between* jobs. Harbor owns each individual job; the loop
around them is ours.

**Consequences**
- ~1,600 LOC of orchestration (`evolve.ts`, `evolve-metrics.ts`, masking in
  `metrics/attribution.ts`) survives the rewrite and must be ported to akm 0.9.1
  verbs. Note `akm distill` / `akm reflect` are **retired** — both fold into
  `akm improve <ref>`, which **requires a configured LLM engine** (exit 78
  otherwise). The evolve arm therefore cannot run LLM-free.
- The six `repeated_failure_group` tasks need two tasks in one orchestrated pass;
  that sequencing is the orchestrator's job, not Harbor's.
- Harbor's `resume` semantics apply per job, not across the loop — the
  orchestrator needs its own checkpoint of which jobs in a sequence completed.

**Outcome (2026-08-25): decided, never exercised.** No evolve or attribute run
happened. The orchestrator was never ported to 0.9.1 verbs because the arm it
serves (D7's accumulating arm) was parked — see D15. The decision stands; it is
simply untested. What would settle it: one orchestrated multi-run pass, which
needs a configured in-container LLM engine (`akm improve` exits 78 without one).

### D2 — akm reaches the container via a custom Harbor agent

`AkmOpenCode(OpenCode)` subclass overriding `install()`, invoked as
`--agent <module>:AkmOpenCode`. Chosen over baking akm into task
`environment/Dockerfile`s (which would contaminate 46 arm-neutral task
definitions and make the *baseline* arm run an image containing akm) and over
`--skill` upload (files, not a global install).

**Consequences**
- Task definitions stay arm-neutral: the same task runs under both arms.
- Real Python lives in akm-bench. It is small (one file) but it is a second
  language in a Bun/TS repo and needs its own test path.
- Every job must pass `--agent`; a job config that forgets it silently runs the
  baseline. The agent must force-inject its own config rather than trusting the
  job to supply it.

**Outcome (2026-08-24/25): proven live, then run at scale.** The P0 gate passed
in real containers (treatment arm made `akm_curate` x2 + `akm_show` x3 on
`opencode--select-correct-skill`, control arm zero akm activity). Across every
subsequent A/B — 114 + 168 + 114 trials — the baseline arm's engagement rate
stayed exactly 0.0% and the akm arm's did not, which is the arm-neutrality
property this decision was chosen for, measured rather than asserted. The
"a job that forgets `--agent` silently runs the baseline" hazard was never hit:
the analysis layer folds the agent kwargs digest into the arm label and every
report carries a mismatch tripwire (0 mismatches, all runs).

### D4 — Single `reward` key now; revisit at P4 *(provisional)*

Tasks emit exactly one `reward` key valued 0 or 1. Compliance sub-scores and
diagnostics go to `/logs/artifacts/` and are joined post-hoc by our analysis
layer. Revisit once the analysis layer exists and we know what the compliance
metrics actually need.

**Consequences**
- Harbor's own `pass_at_k` and `Mean` keep working as an independent sanity check
  against our statistics — worth keeping until our layer is trusted.
- The viewer's comparison grid (which hardcodes `rewards.get('reward', 0)`)
  stays usable.
- Anything richer than pass/fail is invisible in Harbor's artifacts and depends
  entirely on our artifact join. That join must exist before P4 can revisit this.

**Outcome (2026-08-25): provisional lifted, single binary `reward` confirmed.**
Every committed report discloses the count of non-errored trials whose reward is
present but not exactly 0 or 1: **0** in every run. Nothing richer than pass/fail
was ever needed, because the diagnostic that turned out to matter — whether the
model called an `akm_*` tool — is read from each trial's own opencode trajectory
by the analysis layer, not from the reward. The artifact join D4 said must exist
before P4 could revisit this exists and is what the whole findings document is
built on. No reason to reopen.

### D6 — Cold-start library: BUILT (2026-08-23)

Shipped as `akm-bench/harbor/treatment-library/`: 26 assets (knowledge 20,
skills 3, lessons 3), contamination-free, retrieval-verified against real
akm 0.9.1, wired into both A/B job yamls' akm-static arms. Seed
expectations in the agent self-check are now derived from the configured
library. The original decision text follows.

### D6 (original) — a hand-authored generic SWE skills bundle

~20–40 assets of general software-engineering practice (debugging, test running,
git, build systems, common CLI tooling). Contamination-free, reusable across both
terminal-bench and SWE-bench, and honest about what it claims.

**Consequences**
- The bundle's quality **caps the measurable effect**. A weak library produces a
  null result that says nothing about akm — so authoring effort is not overhead,
  it is the experiment.
- Assets must carry frontmatter `description` and headings. akm's FTS and
  embeddings do **not** index body prose (verified: body-only terms return zero
  hits), so an asset whose value lives in its prose is unretrievable.
- Explicitly rejected: per-domain `akm import` of real repo docs for SWE-bench
  instances (task leakage), and learned-from-train-split (needs an in-container
  LLM engine; revisit once D1's evolve arm exists — the two share machinery).
- The P0 smoke library (copied from `akm-plugins/evals/fixtures/stash/`) is a
  placeholder to prove the plumbing, **not** this bundle.

**Outcome (2026-08-25): built, wired, and still unmeasured.** The corpus A/B —
the run that produced every headline number — seeds each trial from the task's
own `AKM_TASK_STASH`, which takes precedence over `seed_library_dir`. So the
treatment library was carried but overridden on all 48 corpus tasks. The only
run that actually exercised it is the TB2 10-task 2-arm run, which returned a
null at 3.3% engagement (see D14) — a result the analysis attributes to task
shape, not to library quality. D6's central claim ("the bundle's quality caps
the measurable effect") therefore remains untested. Any future TB2 or
non-corpus run is a test of the library as much as of akm.

### D7 — Accumulation: run both static and accumulating as separate arms

Three arms total: baseline (no plugin), akm-static (pristine per-trial copy of the
library), akm-accumulating (shared mutable bundle across trials). Isolates
retrieval value from learning value.

**Consequences**
- **Run cost roughly triples.** Fold this into D9's budget before any full sweep.
- The shared-volume machinery is now required, not optional: a mount, plus a
  concurrency policy. Harbor's `--mounts` semantics were verified for the local
  Docker backend only; cloud sandbox backends are unverified.
- The accumulating arm's trials are **statistically non-independent** (ordering
  effects, concurrent-write races at `-n > 1`). It needs its own analysis
  treatment — do not pool it with the static arm, and consider `-n 1` for it.
- P0 implements per-trial seeding only (the static arm). The accumulating arm is
  additional work in P2.

**Outcome (2026-08-25): superseded in part — two arms ran, not three.** Every
executed A/B is baseline vs akm-static. The accumulating arm was never run; it is
parked with its rationale under D15, and the cost tripling D7 warned about never
landed on D9. The static half of the decision held: per-trial pristine seeding
worked on every executed A/B trial, both arms, with zero seed-related setup
failures.

---

## Open

### D3 — Network policy: partially resolved by implementation (2026-08-23)

The agent pre-installs and cache-warms everything at install() time, so a
session-start npm fetch is only needed when the warm boot failed (and the
self-check aborts setup in that case). Residual: install() itself needs npm
egress, and whether TB2/SWE-bench task network policies permit it is a
first-live-run question. A related finding closed the in-process pin hole:
live npm probing showed opencode installs plugins under
`~/.cache/opencode/packages/`, making the documented config-dir overrides
file INERT - the effective fix (shipped) is a post-warm-boot realign step
that force-reinstalls the pinned akm-cli into the plugin's hoisted tree,
plus probe 7c verifying the hoisted package version.

**Outcome (2026-08-25): resolved for the scope actually run.** Install-time npm
egress worked on every executed job on the local Docker backend — 114 + 168 + 114
corpus trials with **zero errors**, and the self-check never had to fall back to
a session-start fetch. The residual this entry named was "whether TB2/SWE-bench
task network policies permit it": SWE-bench is dropped (D13) and TB2's 10-task
run failed on the tasks' own agent-phase time budgets, not on network policy
(43/60 errored trials, all budget). Cloud sandbox backends remain unverified, and
that is now the only open part of D3.

### D5 — Where workflow-compliance is scored *(blocks P4)*
In-container `tests/test.sh` — which **can** read `/logs/agent/trajectory.json`
(verified: `_sync_agent_output` runs before `_run_verifier`, and cloud envs upload
logs back in) and akm's own `state.db` — puts compliance into the reward.
Post-hoc in our analysis keeps it out of every Harbor artifact and regrade path.
Coupled to D4; decide both together at P4.

**Outcome (2026-08-25): decided by implementation, in the post-hoc direction.**
Nothing compliance-shaped was ever folded into a reward. The four
`workflow-compliance--*` tasks score pass/fail through their own in-container
verifiers like every other task, and every cross-cutting metric (engagement,
gate-reason histogram, per-cell rates) is computed post-hoc by the analysis layer
from trajectories and the plugin ledger. The in-container branch had no claimant
by the time P4 arrived and P4 never ran as a distinct phase. Reopen only if a
future run needs a compliance sub-score to enter the reward itself.

### D8 — Which upstream memory harness `akm-eval` adapts *(blocks P6)*
Per-benchmark, and the surfaces differ: LongMemEval v1 is thinnest (JSONL +
shell out to `evaluate_qa.py`); LoCoMo is already done; BEAM has no plugin
interface (fork or mem0-shim); `supermemoryai/memorybench` costs ~200 LOC for one
`Provider` and buys three benchmarks plus head-to-head vs mem0/zep.
Recommendation on the table: LongMemEval v1 first, memorybench second.

**Outcome (2026-08-25): decided by implementation — LongMemEval v1 + LoCoMo.**
Both adapters shipped, both ran three variants at smoke scale (n=5 questions,
`qwen3.5-plus`), and both are committed. BEAM and `supermemoryai/memorybench`
were not adopted. The recommendation on the table ("LongMemEval first,
memorybench second") is half-taken; the second half is not worth buying yet,
because the two packs already in hand both bottom out on the same retrieval
ceiling (akm#819) — a third harness would measure that ceiling a third time
rather than tell us anything new.

### D9 — Judge-model cost budget *(blocks P6)*
No estimate exists. Reference points: Harbor's own LoCoMo parity run cost ~$35
for 5×10 trials on gpt-5-mini; LongMemEval-V2 defaults to a gpt-5.2
medium-reasoning judge; BEAM-10M ingest is likely the single most expensive item
in the suite. **D7 triples the coding-benchmark side.** Force a number before P6.

**Outcome (2026-08-25): still open, but much narrower.** Two of the three cost
drivers evaporated: D7's tripling never happened (D15) and SWE-bench — the item
with a real per-instance bill — is dropped (D13). The coding side now has
measured numbers rather than an estimate: the 114-trial enforce-mode eval run
cost **~$0.32 total** (mean $0.0044/trial on the akm arm vs $0.0012 on the
baseline — the treatment arm carries ~1.7x the input tokens, 44k vs 26k, at
~3.7x the cost; the gap between those two ratios is not explained by anything
in the report) over 2h13m wall. What is still unbudgeted is the memory side: both packs ran at
n=5 questions, and no per-question judge cost has been extracted from them.
Recommended sequencing, not a decision: do not spend judge budget scaling a pack
whose akm arm returns nothing on 5/5 questions — re-measure after akm#819 first.

### D10 — Corpus mechanics: decided by implementation (2026-08-23)

All four sub-decisions were settled during the P3 conversion:
- **Slices** — two `registry.json` DatasetSpecs: `akm-tasks-train@1.0` (27) and
  `akm-tasks-eval@1.0` (19), disjoint, union = the full corpus; the flat
  `harbor/tasks/` dir also resolves via `-p` (46 incl. the reference task).
- **Fixture delivery** — the AkmOpenCode agent uploads `harbor/stashes/` once
  and the container-side seed step selects the stash named by the task's
  `[environment].env.AKM_TASK_STASH`; unknown names abort setup loudly. Task
  environments stay arm-neutral (zero akm/opencode/node in any Dockerfile).
  Benchmark metadata lives in `harbor/stashes-meta/` (never uploaded), and the
  agent additionally purges non-directory entries from the uploaded root
  in-container — a stray answer-key file cannot become an arm-asymmetric
  channel.
- **Token budgets** — carried in `[metadata]` (`budget_tokens`, `budget_wall_ms`),
  not enforced by Harbor; the analysis layer reads per-trial token totals and
  can report violations post-hoc.
- **Attribution masking** — an orchestrator concern under D1; not expressed in
  task format.

**Correction (2026-08-25): the slice counts above are stale.** akm-bench#6 added
two tasks — `drillbit--fix-runbook-train` (edit-shaped drillbit) and
`inkwell--new-service-scaled-train` (create-shaped inkwell), authored to break
the shape/tool-family confound — so `akm-tasks-train@1.0` is **29** (incl. the
reference fixture task) and the corpus is **48** registered tasks. Both went to
TRAIN deliberately: eval is a pre-registered measurement surface and adding tasks
to it would invalidate comparison outright. The eval task LIST has never changed;
only its verifiers have.

**Amendment (2026-08-25): one train task is barred from ARM COMPARISONS.**
`workflow-compliance--repeated-fail-opencode-disable-provider` ships an
`opencode.json` whose `$schema` the write gate resolves against the task's own
stash, handing the model that task's `gold_ref` unasked — on the treatment arm
only. The task exists to measure whether the model CHOOSES to look the asset up,
so the adherence pass would accrue to one arm from the harness rather than from
the model. Barred via `exclude_task_names` in both A/B job yamls (akm-bench
`2e40003`); registry membership deliberately unchanged, since the task is valid
and still runs under the oracle. Fixed benchmark-side on purpose: firing on a
real user's `opencode.json` is correct product behaviour, and making the plugin
benchmark-aware would special-case the benchmark.

**Amendment (2026-08-25): fixture delivery gained a rule.** akm-bench#7 found
that graded artifacts were sitting on filenames opencode itself claims: `/app/opencode.json`
(project config) and `/app/AGENTS.md` (project instructions, spliced verbatim
into the agent's own system prompt via `Instruction.systemPaths`). Seven tasks
were affected, including `opencode--select-correct-skill` — the task P0 was
validated on — where the model's own half-written output was being fed back to it
as a standing instruction mid-trial. Fixed by renaming the graded artifacts
(`agent-guidance.md`, and off `opencode.json`), proven against the pinned
opencode 1.18.21 binary rather than reasoned about. The D10 rule is now: a graded
artifact must not sit on any filename an agent loader claims. This changed three
eval-slice tasks and so cost a second baseline invalidation — see the changelog.

### D11 — Ownership of `akm-plugins/evals`
A third eval surface neither repo covers: tier2 deterministic plugin metrics
against a fake-akm shim, tier3 LLM-judge scenarios. It holds akm's ranker constant
so it does not overlap akm-bench, but ownership and CI wiring need a call. Note
`evals/README.md:50` claims a git-ref pairwise A/B mode that **does not exist** in
`tier3/runner.ts` — a doc/code mismatch to fix or drop.

**Outcome (2026-08-25): unchanged and still open.** Nothing in this work touched
`akm-plugins/evals`; ownership and CI wiring are still uncalled. The doc/code
mismatch this entry recorded is still live — `evals/README.md` still advertises
"pairwise A/B between two git refs" and `evals/tier3/` still contains no git-ref
handling at all (re-verified 2026-08-25).

### D12 — Harbor version pin: decided and implemented (2026-08-23)

Harbor is pinned to **0.22.0** (`akm-bench/harbor/requirements.txt`), and
`akm-bench/bin/check-harbor-contract` executes **14 assertions** over the
internal behaviors the stack depends on (trial_results exclusion, pass@k k-set,
exclude-after-include log filtering, result.json naming, config deep-merge
layering, metadata exclusion from results, agent-log sync ordering, reward-file
parsing, one-level task scanning, provider/model splitting, trial-dir layout,
XDG log path, and sync-before-populate ordering). Run it on every Harbor bump;
a failure names exactly which load-bearing behavior moved. Not yet wired into
CI (see Open questions below).

**Outcome (2026-08-25): held for the whole effort.** `bin/check-harbor-contract`
stayed **14/14** across every run on Harbor 0.22.0 — no pinned internal behavior
moved under us, and no result had to be re-litigated against a harness change.
This is the decision that most clearly paid for itself: it is the reason the two
baseline invalidations below can be attributed to the corpus and the plugin
rather than to the harness. Still not wired into CI.

---

## Scope decisions taken during execution (2026-08-25)

Three decisions that were not in the brief's §8 set. Each changes what the
programme measures, so each is recorded here with what it was traded against.

### D13 — SWE-bench A/B: DROPPED

`harbor/jobs/swebench-ab.yaml` deleted (akm-bench `a543820`).

SWE-bench is maximally edit-an-existing-file-for-a-tool-the-model-already-knows:
real Python repos whose conventions are in the model's weights. That is the exact
cell this programme measured at **0/35 engagement** with a paired delta of
**-0.011** on tasks where akm was never called. The predicted result is a null.

It is not a cheap null: x86_64-only images, ~120GB for full Verified, and a real
bill per instance per arm.

And it is not a speculative prediction — the TB2 10-task run already delivered
the same null at a tenth of the price (D14). Buying the same answer twice is not
rigour.

**Consequence / caveat.** This is a deliberate narrowing of external validity.
The programme now has no evidence about akm on real-world repository work, and
should not claim any. What it has is a measurement of *when* akm is consulted
and what a consultation is worth, on a corpus built so that retrieval is the only
path. Reopen if the engagement mechanism changes enough that the known-tool cell
is expected to move — that, not cost, is the condition.

### D14 — terminal-bench 2 at full scale: NOT RUN

The 10-task 2-arm run stands as the TB2 result: **3.3% engagement** (1 trial in
30), **delta 0.000 [-0.100, 0.100]**, and **43 of 60 trials errored** on the
tasks' own agent-phase budgets. The error rate alone makes the run weak evidence
about akm and strong evidence about budget fit; scaling it would buy a
better-powered null on the shape D13 already argues is uninformative.

`harbor/jobs/tb2-ab.yaml` is **kept**: the 10-task run is a real published
result and the config is the record of how it was produced.

**Caveat.** TB2 is also the only executed job that actually uses the D6
treatment library, so "TB2 returned a null" and "the D6 library is untested" are
the same fact seen twice, not two independent findings.

### D15 — Accumulating arm: PARKED, not dropped

D7's third arm was never run. This is not a reversal of D7's reasoning — the arm
measures **learning** (does a bundle that accumulates across trials get better?),
which is a genuinely different hypothesis from the one everything else here
measures (**retrieval**: is a static, well-authored bundle worth consulting?).
Answering the retrieval question first was the right order, and it consumed the
available run budget.

**Consequence.** D7's warnings still apply verbatim when it is run:
non-independent trials, `-n 1`, its own analysis treatment, a shared mount whose
semantics are verified for the local Docker backend only. D1's evolve/attribute
orchestration is the same parked machinery.

---

## Open questions raised by implementation (2026-08-23)

- **Baseline-arm "skill" pointers**: 11 shipped workspace READMEs (drillbit x7,
  inkwell x4) keep legacy-verbatim "Consult the `<domain>` skill" prose. Both
  arms see it, as under the legacy driver, but the baseline arm cannot access
  any skill. Deleting would change difficulty vs the legacy corpus - corpus
  owner call (docs/corpus-conversion.md section 10.4).
- **Retired ref spelling as graded content**: 3 workflow-compliance tasks grade
  the literal `akm-show-ref: skill:opencode` (0.7 grammar). Legacy-faithful and
  verifier-consistent, but akm 0.9.1 rejects that spelling live - changing it
  means changing verifier + instruction together.
- **akm-cli in-process pin hole**: probe 7b makes the exec-path candidate-2
  bypass fail loudly, but the plugin's in-process tools import akm-cli directly
  and remain uncovered; the stronger npm-overrides mitigation is documented in
  docs/harbor-p0.md but NOT implemented. Latent until a newer 0.9.x publishes.
- **CI wiring**: akm-bench CI does not run the harbor pytest suite, the
  contract check, or the analysis tests - and `bun run check` was already red
  on main before this work (legacy src/ typecheck + 5 pre-existing
  tests/leakage.test.ts failures against fixtures/corpus). Nothing new is
  CI-gated until this is addressed.
- **P0 GATE PASSED (2026-08-24, live containers, x86_64 + Docker 29.1.3)**:
  on corpus task `opencode--select-correct-skill` the treatment arm made
  real `akm_curate` x2 + `akm_show` x3 calls (both evidence sources agree;
  control arm zero akm activity; both arms reward 1.0 - plumbing proven,
  benefit unmeasured). Nuance: on `hello-world` the plugin's own activation
  heuristic declined to curate (`prompt_recall skip-low-signal`), so that
  task structurally cannot answer P0 - `harbor/jobs/p0-corpus.yaml` exists
  for the corpus-task variant. Phase 3 also green: oracle 46/46 reward 1.0,
  nop fail-path 3/3 reward 0, registry slice 19/19. Live execution surfaced
  and fixed (akm-bench `1b527df`, 181 tests): the self-check derived seed
  expectations from `seed_library_dir` while the bundle is actually seeded
  from `AKM_TASK_STASH` (would have blocked the corpus programme), two
  hardcoded probe assumptions, and a pre-existing invalid-bash bug that
  would have killed every accumulating-arm trial at setup.
- **RESOLVED (2026-08-25): the multi-system-message model-compat constraint**
  (akm-plugins#96, fixed in #98, shipped in `akm-opencode@0.9.1202608242057`
  and verified in the published tarball): the plugin now pushes a single
  joined entry (`output.system.push(budgeted.join(...))`) instead of N. The
  two models observed failing were never re-run against the fix, and the A/B
  model (`qwen3.5-plus`) accepts multiple system messages anyway, so the fix
  is verified structurally, not by reproducing the 500. Original entry:
- **MODEL-COMPAT CONSTRAINT (arm-asymmetric hard failure)**: the
  akm-opencode plugin injects context as ADDITIONAL entries in opencode's
  `system` array, so the treatment arm sends multiple system messages. Chat
  templates requiring a single leading system message (observed:
  `qwen3.6-35b-a3b`, `devstral-small-2`) return HTTP 500 on the treatment
  arm ONLY. Verified accepting: `qwen3-30b-a3b-2507`, `qwen3-coder-30b`,
  `gpt-oss-20b`. Screen the model before any paid A/B; the deeper fix
  (merging into one system message) lives in akm-plugins.
- **RESOLVED (2026-08-24): akm-eval container caveat closed** (`0d66642`):
  `docker/akm-eval.Dockerfile` now ships Node 22 + `akm-cli@0.9.1` (pinned,
  asserted at build time), and `bin/doctor` reports the akm backend OK
  in-container. The three-variant locomo/longmemeval A/B remains the last
  unexecuted step (judge budget).
- **RESOLVED (2026-08-23): LongMemEval retrieval is now wired** through
  MemoryBackend.search() with real retrieval metrics vs evidence session ids;
  the inert-arm warning became a regression tripwire. The A/B config is now
  meaningful.
- **MEASURED (2026-08-25), no longer only a risk - natural-language query
  shape vs akm's conjunctive-AND FTS**: the memory packs measured what this
  entry predicted, at full strength - `akm-memory` returned zero documents on
  5/5 LongMemEval questions. It is now tracked as akm#819 with evidence (see
  the 2026-08-25 open questions below); this entry stands as the pre-registered
  prediction that it would happen. Original entry:
- **VALIDITY RISK - natural-language query shape vs akm's conjunctive-AND
  FTS** (measured independently in BOTH gates): akm FTS is an implicit AND
  over every query token with no stopword removal, so sentence-shaped
  queries ("how do I run just one failing test quickly") return zero hits
  while keyword/hint-shaped queries hit rank 1. The treatment library
  compensates with question-form searchHints (0/8 -> 7/8 rank-1), and
  akm-eval discloses zero-hit rates in every artifact - but if the MODEL
  issues sentence-shaped akm_search queries mid-benchmark, the treatment arm
  sees mostly empty results and a null result becomes attributable to query
  shape rather than akm's value. Pre-run lever: the akm-opencode plugin's
  tool description (how it steers query phrasing) - that lives in
  akm-plugins, outside these branches. An OR/fuzzy search mode in akm
  itself is the deeper fix.
- **SUPERSEDED (the entry above it, 2026-08-23, closed this): LongMemEval
  retrieval is not yet wired through the memory backend** (D8) - kept for the
  record, but read the `RESOLVED (2026-08-23)` line above first; the akm arm
  is live and its zero-hit rate is now a measured number, not an inert-arm
  artifact:
  the akm backend and the three-variant A/B config landed, but the longmemeval
  pipeline feeds full haystack context to the model and never calls
  MemoryBackend.search(). Until the adapter routes retrieval through the
  backend, its akm arm is inert - now disclosed by an unconditional warning
  stamped into result.json/summary.md, but the wiring itself is the remaining
  P6 work before longmemeval-akm-ab is worth judge budget. locomo's akm arm IS
  live (queries the backend, reports zero-hit rates and ceiling metadata).
- **longmemeval evaluator provenance**: scripts/longmemeval-evaluator.py is a
  repo-local reimplementation of the upstream rubric, not a pinned shell-out
  to LongMemEval's evaluate_qa.py as plan section 5.5 recommends. A real LLM
  judge (policy-compliant) but without upstream commit provenance.
- **locomo judgedPass naming**: the value is upstream LoCoMo's mean token-F1
  (correct metric, no judge involved) carried in a schema field named
  "judgedPass" - rename or annotate before publishing cross-pack tables.
- **src/opencode-config.ts kept** (deviation from brief section 5.1's delete):
  still used by the opencode runner for memory packs; its plugin-stripping
  comment now states the honest scope. Revisit only if the opencode runner
  itself is retired.
- **One unindexable legacy asset**: `workflow:configure-inkwell-service` fails
  akm 0.9.1 workflow schema validation and is absent from the inkwell stash
  index (recorded in harbor/stashes-meta/gold-ref-map.json).

---

## Open questions raised by execution (2026-08-24 -> 2026-08-25)

Ordered by how much each one gates the next decision.

- **akm#819 (retrieval ceiling) is now the top-priority open item, and its
  status is tangled.** Two independent packs measure it: LongMemEval
  `akm-memory` judgedPass **0.00 with 5/5 (100%) zero-hit** against
  `raw-vector`'s 0.20 at 0/5, and LoCoMo akm 0.200 with **2/5 zero-hit**
  against `raw-vector`'s 0.233 at 0/5. akm scored zero on LongMemEval because
  it **returned no documents at all**, not because its answers were wrong; on
  LoCoMo, where it did retrieve, the answer was correct. The mechanism is
  structural: akm indexes synthesized frontmatter (name, description, tags,
  searchHints, headings) and never body prose, and a LongMemEval haystack is a
  transcript whose answer lives entirely in the body. `raw-vector` is a naive
  cosine store and always returns *something* - the gap is COVERAGE, not
  ranking. **This is a measurement of the retrieval ceiling, not of memory
  quality, and must not be published as the latter** (n=5 questions, one
  sample, one model per pack - enough to separate the arms on a structural
  property, far too small to rank answer quality).
  The tangle: akm#819 was **closed on 2026-08-25 by akm PR #821**, which lands
  a strict -> prefix -> relaxed retrieval planner and projects native Markdown
  prose into lexical/semantic content - i.e. a claimed fix for both halves.
  That PR is merged to `release/0.9.2`, not yet to `main` (PR #822 open), and
  **every number in this register was produced against `akm-cli@0.9.1`, the
  pre-fix behaviour**. The evidence above was posted to the issue *after* it
  was closed. What would settle it: re-run both memory packs against 0.9.2 and
  read the zero-hit rates. Until that happens the fix is claimed, not measured.
- **The configuration that produced +0.439 is not the shipped default.** The
  write gate defaults to `observe` (ledger only, no behaviour change); the
  enforce-mode eval run set `AKM_WRITE_GATE=enforce` explicitly. The default
  was chosen deliberately - #99 measured the problem, not the gate's effect on
  reward - but it means the headline number describes a configuration users do
  not get. Promoting `enforce` is an open decision; what would settle it is a
  train-slice histogram of gate reasons plus a false-positive rate on
  real/known-tool files, since a wrong fire blocks a correct edit.
- **Post-enforce engagement is INDUCED, not elected.** The gate blocks the edit
  and tells the model to call `akm_show`, so 20% -> 100% on the fictional-edit
  cell is the mechanism working as designed, not a change in the model's
  preferences. The two engagement numbers must never be quoted side by side
  without this. The load-bearing number is reward split by whether the gate
  actually fired: **gated tasks (6) +0.333** (0.500 -> 0.833), **non-gated
  tasks (13) +0.487** (0.436 -> 0.923). Both move and the non-gated tasks move
  more, so the aggregate is mostly the plugin's pre-existing retrieval value on
  tasks the gate never touched; the gate's own contribution is the +0.333.
- **akm-plugins#97 - the Claude surface is unmeasured and still carries the
  bug that was fixed for opencode.** `SESSION_START_HEADER` in the Claude hook
  still has the "from scratch" trigger wording that akm-plugins#94 replaced on
  the opencode side after it was measured gating out the edit-shaped cell.
  Every engagement and reward number in this register is opencode-only; none of
  it has been shown to transfer to the Claude surface.
- **akm-eval#6 - longmemeval reports not-applicable lexical metrics as `0`.**
  `exactMatch` / `tokenF1` / `containsExpected` are hardcoded zeros because the
  pack scores on the official LLM judge, which is indistinguishable in the
  artifact from a measured zero. Only `judgedPass` carries signal there. This
  blocks publishing any cross-pack table without hand-annotation.
- **akm-eval#7 - `check:boundary` fails with EACCES on root-owned akm work
  dirs** because it scans `runs/`. An operational blocker on re-running the
  memory packs, not a measurement defect.
- **akm-bench#4 - workspace boilerplate is duplicated per task** rather than
  living in one shared directory copied in at runtime. Corpus maintenance cost;
  it did not affect any result, but it multiplies the cost of the next
  corpus-wide fix - and akm-bench#7 was exactly such a fix, applied to seven
  tasks by hand.
- **Cross-run reward comparability was spent twice, deliberately.**
  akm-bench#6 tightened the verifiers of 11 of the 19 eval tasks; akm-bench#7
  changed 3 more. Both were correct fixes (the old drillbit verifier scored an
  invented `drillbit backup configure ...` as a pass; the AGENTS.md tasks were
  feeding the model's own half-written output back as its own instructions).
  Because both arms are always re-run together, **each run is internally
  valid** - what is lost is only cross-run reward comparison, so +0.228,
  +0.246 and +0.439 are three measurements on three corpora, not a trend. The
  engagement CELLS stayed comparable throughout, which is why the engagement
  story is told across runs and the reward story is not.
- **Unexplained drift worth watching**: real/known-tool CREATE engagement moved
  29% -> 47% (n=15) between the pre-gate and enforce runs. The pre-registered
  criterion was real/EDIT staying at zero, which it did exactly (0/6), so this
  did not fail anything - but nothing predicted it either.

---

## Changelog

- **2026-08-25 (register update)** - D1-D12 statuses reconciled against what
  actually ran; D13 (SWE-bench dropped), D14 (TB2 not scaled) and D15
  (accumulating arm parked) recorded as scope decisions; the execution-era open
  questions recorded. Sources of truth: `benchmark-tuning-findings.md` and the
  committed reports under `akm-bench/results/harbor/`.
- **2026-08-25 (memory)** - The memory half measured and published as what it
  is: LongMemEval `akm-memory` judgedPass **0.00 with 5/5 zero-hit** vs
  `raw-vector` 0.20 at 0/5; LoCoMo akm 0.200 with 2/5 zero-hit vs 0.233. akm
  indexes synthesized frontmatter and never body prose, so a chat transcript is
  unsearchable by construction. This is a **retrieval-ceiling** measurement
  (akm#819), not a memory-quality one, and the benchmark win does not transfer
  to it. n=5 per pack.
- **2026-08-25 (late)** - Scope narrowed on evidence. SWE-bench A/B config
  deleted (akm-bench `a543820`) because it is the 0/35-engagement, -0.011-delta
  cell and TB2's 10-task run (3.3% engagement, delta 0.000, 43/60 trials
  erroring on the tasks' own budgets) already bought that null at a tenth of the
  price. TB2 full-scale not run for the same reason; `tb2-ab.yaml` kept as the
  record. See D13/D14.
- **2026-08-25 (enforce run)** - Eval slice under `AKM_WRITE_GATE=enforce`
  (akm-bench `ff71c23`; 19 tasks, k=3, 114 trials, 2h13m, zero errors,
  `akm-opencode@0.9.1202608250804`): paired delta **+0.439 [0.193, 0.684]** at
  **75.4%** engagement vs 0.0% baseline. The engagement blind spot closed:
  fictional-tool EDIT went **20% (4/20) -> 100% (18/18)** while real/known-tool
  EDIT stayed at **0% (0/6)**, which is correct behaviour and was worth more
  than the win. Caveats travel with both numbers - engagement is now largely
  INDUCED by the gate, and the gate's own contribution is +0.333 on the six
  tasks it fired on against +0.487 on the thirteen it did not.
- **2026-08-25 (train, observe)** - Stage-1 gate run on the train slice
  (akm-bench `b03f03b`; 28 tasks, k=3, 168 trials, zero errors): gate histogram
  populated and legible, **zero fires on `az-cli`/`docker-homelab`** (28
  `no-identity`), fires 3/3 on the one inkwell edit task train contains. A/B
  unchanged by observe mode, as designed (+0.155 [0.024, 0.310] at 25.0%). The
  one anomaly traced to opencode rewriting its own project config - the agent
  under test mutating a graded artifact, which became akm-bench#7 and cost the
  eval baseline a second, deliberate invalidation (3 eval tasks changed).
- **2026-08-24 (post-fix eval baseline)** - akm-plugins#94/95/96 shipped and
  akm-bench#6 tightened 11 of 19 eval verifiers; both arms re-run together
  (akm-bench `bffda4d`): engagement **28.1% -> 43.9%**, paired delta **+0.246
  [0.053, 0.456]**, superseding +0.228 @ 28.1% - which the corpus change had
  already made non-comparable. Splitting the pooled runs by whether the akm arm
  ever called a tool settled the mechanism question: **-0.011** on the 29 tasks
  with no `akm_*` call, **+0.561** on the 19 with one. Injected context alone is
  worth ~0; the -0.011 is the clean half of that pair, the +0.561 is
  selection-confounded. Corpus re-validated after the two new train tasks:
  oracle **48/48** reward 1.0, `nop` **48/48** reward 0.0.
- **2026-08-24** - First live container runs on the maintainer's machine: P0 gate PASSED, corpus oracle validation green (46/46), four live-run defects fixed upstream (akm-bench `1b527df`), akm-eval container caveat closed (`0d66642`), and the multi-system-message model-compat constraint recorded.
- **2026-08-23 (final)** - D6 built and wired; D3 partially resolved; in-process akm-cli pin hole closed via realign (overrides file proven inert); LongMemEval wiring landed; CI green on all three PRs' gated jobs; the FTS query-shape validity risk recorded from both gates.
- **2026-08-23 (later)** - P5/P6 landed on akm-eval `claude/memory-eval-refactor`; four further open items recorded (longmemeval retrieval wiring, evaluator provenance, judgedPass naming, opencode-config retention).
- **2026-08-23** - D10 and D12 decided by implementation (P1-P3 landed on
  akm-bench `claude/harbor-akm-agent-p0`); five new open questions recorded
  from the implementation gates.
- **2026-08-22** — D1, D2, D4 (provisional), D6, D7 decided. D2 was settled by the
  instruction to implement the Harbor agent. D7 chose three arms over the
  recommended two, which adds the shared-volume requirement and raises D9's cost.
