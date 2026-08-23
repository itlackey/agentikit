# Decision Register: Benchmark Harness Consolidation

**Status:** Live — updated as decisions are made
**Companion to:** [`benchmark-harness-consolidation.md`](./benchmark-harness-consolidation.md) §8
**Branch:** `claude/akm-benchmark-measurement-75rpsg`

Each decision is numbered to match §8 of the brief. `DECIDED` entries carry the
consequence that follows from them — the point of this file is that later phases
can be checked against it without re-litigating.

| # | Decision | Status | Blocks |
| --- | --- | --- | --- |
| D1 | Longitudinal workflows (`evolve`, `attribute`) | **DECIDED** | P7 |
| D2 | How akm reaches the trial container | **DECIDED** | P0 |
| D3 | Network policy for the akm arm | **PARTIALLY RESOLVED** | P2 |
| D4 | Canonical reward shape | **DECIDED (provisional)** | P3 |
| D5 | Where workflow-compliance is scored | OPEN | P4 |
| D6 | Cold-start library content | **DECIDED + built** | P2 |
| D7 | Cross-task accumulation policy | **DECIDED** | P2 |
| D8 | Which upstream memory harness `akm-eval` adapts | OPEN | P6 |
| D9 | Judge-model cost budget | OPEN | P6 |
| D10 | Slice / fixture delivery / token budgets / masking | **DECIDED (by implementation)** | P3 |
| D11 | Ownership of `akm-plugins/evals` | OPEN | — |
| D12 | Harbor version pin | **DECIDED + implemented** | P2 |

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

### D5 — Where workflow-compliance is scored *(blocks P4)*
In-container `tests/test.sh` — which **can** read `/logs/agent/trajectory.json`
(verified: `_sync_agent_output` runs before `_run_verifier`, and cloud envs upload
logs back in) and akm's own `state.db` — puts compliance into the reward.
Post-hoc in our analysis keeps it out of every Harbor artifact and regrade path.
Coupled to D4; decide both together at P4.

### D8 — Which upstream memory harness `akm-eval` adapts *(blocks P6)*
Per-benchmark, and the surfaces differ: LongMemEval v1 is thinnest (JSONL +
shell out to `evaluate_qa.py`); LoCoMo is already done; BEAM has no plugin
interface (fork or mem0-shim); `supermemoryai/memorybench` costs ~200 LOC for one
`Provider` and buys three benchmarks plus head-to-head vs mem0/zep.
Recommendation on the table: LongMemEval v1 first, memorybench second.

### D9 — Judge-model cost budget *(blocks P6)*
No estimate exists. Reference points: Harbor's own LoCoMo parity run cost ~$35
for 5×10 trials on gpt-5-mini; LongMemEval-V2 defaults to a gpt-5.2
medium-reasoning judge; BEAM-10M ingest is likely the single most expensive item
in the suite. **D7 triples the coding-benchmark side.** Force a number before P6.

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

### D11 — Ownership of `akm-plugins/evals`
A third eval surface neither repo covers: tier2 deterministic plugin metrics
against a fake-akm shim, tier3 LLM-judge scenarios. It holds akm's ranker constant
so it does not overlap akm-bench, but ownership and CI wiring need a call. Note
`evals/README.md:50` claims a git-ref pairwise A/B mode that **does not exist** in
`tier3/runner.ts` — a doc/code mismatch to fix or drop.

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
- **RESOLVED (2026-08-23): LongMemEval retrieval is now wired** through
  MemoryBackend.search() with real retrieval metrics vs evidence session ids;
  the inert-arm warning became a regression tripwire. The A/B config is now
  meaningful.
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
- **LongMemEval retrieval is not yet wired through the memory backend** (D8):
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

## Changelog

- **2026-08-23 (final)** - D6 built and wired; D3 partially resolved; in-process akm-cli pin hole closed via realign (overrides file proven inert); LongMemEval wiring landed; CI green on all three PRs' gated jobs; the FTS query-shape validity risk recorded from both gates.
- **2026-08-23 (later)** - P5/P6 landed on akm-eval `claude/memory-eval-refactor`; four further open items recorded (longmemeval retrieval wiring, evaluator provenance, judgedPass naming, opencode-config retention).
- **2026-08-23** - D10 and D12 decided by implementation (P1-P3 landed on
  akm-bench `claude/harbor-akm-agent-p0`); five new open questions recorded
  from the implementation gates.
- **2026-08-22** — D1, D2, D4 (provisional), D6, D7 decided. D2 was settled by the
  instruction to implement the Harbor agent. D7 chose three arms over the
  recommended two, which adds the shared-volume requirement and raises D9's cost.
