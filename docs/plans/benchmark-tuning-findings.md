# Benchmark findings: what the first real A/B says about tuning akm

**Status:** live findings, updated as runs land.
**Source runs:** `akm-bench` branch `claude/harbor-akm-agent-p0`,
`results/harbor/2026-08-24/`.
**Companions:** `benchmark-harness-consolidation.md` (the plan),
`benchmark-harness-decisions.md` (decision register).

## 1. The headline, and what it is not

19-task eval slice, baseline (`opencode`) vs akm-static (`akm-opencode`),
k=3, 114 trials, `opencode/qwen3.5-plus`, zero errors and zero timeouts.

| metric | akm arm | baseline |
| --- | --- | --- |
| pass@1 | **75.4%** [0.579, 0.895] | 52.6% [0.316, 0.737] |
| paired delta | **+0.228 [0.070, 0.404]** | — |
| akm tool engagement | 28.1% | 0.0% |

The CI excludes zero. Split by what each task family is built to measure:

| family | tasks | baseline | akm | delta |
| --- | --- | --- | --- | --- |
| retrieval (`drillbit--*`, `inkwell--*`) | 12 | 0.33 | 0.67 | **+0.33** |
| compliance (`workflow-compliance--*`) | 4 | 0.75 | 0.83 | +0.08 |
| other (`opencode--*`) | 3 | 1.00 | 1.00 | 0.00 |

`drillbit` and `inkwell` are fictional tools whose syntax exists ONLY in the
per-task stash, so the baseline must invent it. The compliance family tests
the opposite reflex (a `noisy` stash of plausible-but-wrong material, or a
`minimal` stash with no answer at all) where NOT reaching for akm is correct,
so it dilutes the aggregate by design.

**What this is not:** one model, n=19 tasks, k=3. The CI is ±0.17 wide. It is
evidence that akm helps where retrieval is the only path, not a general
capability claim.

## 2. The biggest finding: akm is invisible on "edit an existing file"

Engagement is not uniformly low — it is **bimodal by task shape**. Counting
every akm-arm trial in the eval slice, split by whether the task's workspace
ships a pre-existing artifact to edit:

| task shape | trials engaging akm | trials | rate |
| --- | --- | --- | --- |
| create-new (workspace has no artifact) | 16 | 33 | **48%** |
| edit-existing (workspace ships `service.yaml`) | **0** | 24 | **0%** |

Zero out of twenty-four. Not one akm call across every edit-shaped task.

**Replicated on the disjoint train slice** (27 tasks, k=3, 162 trials, zero
errors). Same model, different task instances, same direction:

| slice | shape | tasks | engagement | baseline -> akm |
| --- | --- | --- | --- | --- |
| eval | create-new | 11 | **48%** | 0.45 -> 0.88 (**+0.42**) |
| train | create-new | 8 | **38%** | 0.58 -> 0.71 (+0.12) |
| eval | edit-existing | 8 | **0%** | 0.62 -> 0.58 (-0.04) |
| train | edit-existing | 19 | **5%** | 0.77 -> 0.81 (+0.04) |

The train slice's aggregate paired delta is **+0.062 [-0.012, 0.148]** — the
CI includes zero. That is not a contradiction of eval's +0.228: train is 19 of
27 edit-shaped, i.e. dominated by the shape where akm never fires.

**Consequence for the tuning protocol:** train is a poor surface for tuning the
DELTA (its aggregate is diluted by inert tasks and its CI spans zero) but a good
surface for tuning ENGAGEMENT, which is the mechanism actually under change.
Tune against engagement on train; spend an eval measurement only to confirm the
delta moved. The 5% on train (vs 0% on eval) also shows nothing structurally
PREVENTS engagement on edit tasks — the model simply rarely thinks to.

**The plugin's own framing predicts this.** `AKM_HINTS_PREFIX`
(`akm-plugins/opencode/index.ts`) opens with:

> "Before writing anything **from scratch**, call `akm_curate` ..."

Editing an existing file is not "from scratch". The trigger condition, read
literally, *excludes* the exact case where engagement collapses.

The failure is legible in the trajectories. On `inkwell--configure-scaling`
(0.00 on both arms) the akm arm did:

```
read  /app/service.yaml
edit  /app/service.yaml   (invented a `scaling:` block)
text  "Done. Added autoscaling configuration with min: 2, max: 20, ..."
```

The task spells out every value (`min: 2`, `max: 20`, `metric: rps`,
`target: 100`); the only unknown is the key name and nesting, which lives in
the stash. A visible file makes the task *look* self-sufficient, so the model
never suspects there is a convention to look up. **The model does not know
what it does not know**, and nothing in the current framing tells it that an
unfamiliar *format* is as much a lookup trigger as an unfamiliar *tool*.

Three of the six edit-shaped tasks scored 0.00 on both arms
(`inkwell--configure-scaling`, `--cpu-scaling`, `--workflow-configure-scaling`)
— i.e. retrieval would plausibly have flipped them. The other three were
guessable and passed on both arms.

## 3. Recommended changes

Ordered by expected value. Every one changes the TREATMENT (the product), not
the measurement — see §4 for why that distinction is what keeps the number
honest.

### akm-plugins (highest value, smallest change)

1. **Rewrite the `AKM_HINTS_PREFIX` trigger so it covers editing.**
   "Before writing anything from scratch" is the single highest-leverage
   string in the plugin, and it currently gates out 24 of 57 trials. It should
   name the case that actually fails: writing or editing a config file,
   manifest, or command for a tool whose exact syntax you are not certain of.
   Cheap to change, directly falsifiable on the train slice.

2. **Make the `akm_curate` description compete with the built-ins.**
   On edit-shaped tasks the model reaches for `read`/`glob`/`edit` because
   those obviously act on the visible file. `akm_curate`'s description
   ("PRIMARY discovery entry point for the stash ... describe the task in
   natural language") reads as project-discovery, not as "check this format's
   conventions before you write it". Paid models went further and preferred
   opencode's built-in `skill` tool.

3. **Consider a targeted nudge when an unfamiliar format is in play.**
   The plugin already runs `experimental.chat.system.transform` on every
   request and already tracks a curated file per session. A line that names
   the *concrete* asset types available for the current stash would convert
   "there is a stash" into "there is a documented schema for the file you are
   about to edit".

### akm (CLI / retrieval)

4. **Query shaping is a known ceiling.** akm's FTS is a conjunctive AND with
   no stopword removal, so sentence-shaped queries zero-hit while keyword
   queries rank 1. Anything that makes the plugin's generated query keyword-
   shaped (or that makes akm tolerant of sentence-shaped input) raises the
   payoff of every engagement that does happen.

5. **Body prose is never indexed** — only name/description/tags/hints/
   headings. Question-form `searchHints` recovered most of this in the
   treatment library (0/8 -> 7/8). Worth making that authoring rule explicit
   in the docs, since it decides retrieval outcomes more than ranking does.

### akm-bench (corpus quality, not tuning)

6. **`drillbit--backup-policy`'s verifier is too lenient.** Both arms wrote
   `drillbit backup configure --cluster ...` against a gold of
   `drillbit backup --cluster ...` and both scored 1.0. A task that accepts an
   invented form cannot discriminate; it under-reports akm's effect whenever a
   model guesses close.

7. **The edit-shaped inkwell tasks are the corpus's most valuable assets** —
   they are the only ones that isolate the blind spot in §2. Keep them, and
   consider adding edit-shaped `drillbit` equivalents so the shape is not
   confounded with the tool family.

## 4. How to tune without invalidating the benchmark

The rule: **change the treatment, never the measurement.**

Legitimate (ships to real users): tool descriptions, injected framing,
retrieval quality, indexing, query shaping. A model that consults akm more
because the tools are better described is a product improvement.

Invalidating: putting akm instructions in task prompts (contaminates the
baseline or becomes a treatment-only confound), touching verifiers or
timeouts, giving the treatment arm anything unrelated to akm.

**The real risk is iterating against the eval slice.** Tune until eval
improves and the plugin is fitted to those 19 tasks; the number keeps looking
rigorous while it stops generalizing. The corpus already solves this:

```
akm-tasks-train  27 tasks
akm-tasks-eval   19 tasks
overlap: NONE          (same families, disjoint instances)
```

Protocol:

1. Iterate on **train** (`harbor/jobs/.corpus-train-ab-local.yaml`), freely.
2. Decide the change and predict its effect **before** touching eval.
3. Measure on **eval** rarely — ideally once per meaningful plugin change.
   Today's `+0.228 [0.070, 0.404]` at 28.1% engagement is the pre-registered
   baseline. **SUPERSEDED as of akm-bench `0578025`** — see the note below.

> **The eval baseline was invalidated on purpose, once.** Fixing akm-bench#6
> tightened the verifiers of **11 of the 19 eval-slice tasks** (5 drillbit +
> 6 inkwell). The task LIST is unchanged, but the scoring is not, so the
> `+0.228 [0.070, 0.404]` figure is no longer comparable to anything measured
> after that commit. That was the right trade — a correct verifier beats a
> comparable-but-wrong one, and the old one scored an invented
> `drillbit backup configure ...` as a pass — but it means the NEXT eval run
> re-establishes the baseline rather than testing against it. Since both arms
> are always re-run together, the new run is internally valid on its own; only
> the cross-run comparison is lost.
4. **Always re-run both arms together.** The baseline moves too when opencode,
   the corpus, or the harness changes; comparing a new treatment against a
   stored baseline silently confounds.
5. At n=19/k=3 the CI is ±0.17. Small engagement gains will not separate from
   noise on eval — another reason to do the tuning where looking is free, and
   to raise k when you need to resolve a smaller effect.

## 5. Environment notes that affect any rerun

- **Model choice is not neutral.** The plugin injects its context as
  ADDITIONAL entries in opencode's `system` array, so the treatment arm sends
  more than one system message. Chat templates that require a single leading
  system message (`qwen3.6-35b-a3b`, `devstral-small-2`) return HTTP 500 on the
  treatment arm ONLY — an arm-asymmetric hard failure, not a score.
- **Engagement varies by model far more than reward does.** On the same
  akm-relevant task: `qwen3.5-plus` and `qwen3-30b-a3b-2507` called akm tools;
  `kimi-k2.7-code`, `deepseek-v4-pro`, `glm-5.2`, `hy3-free` and
  `nemotron-3-ultra-free` did not, despite the plugin curating successfully
  (`prompt_recall: ok, reason=explicit-akm`) in every case. Any engagement
  number must name its model.
- **Agent-phase timeouts are benchmark-defined.** Each task's own
  `[agent] timeout_sec` governs; the harness no longer overrides it.
