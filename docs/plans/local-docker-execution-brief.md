# Execution Brief: Remaining Benchmark Work (Local Machine, Docker Required)

**Audience:** the agent running on the maintainer's machine (`~/code/github/*`, Docker daemon available)
**Status:** Ready to execute — everything below is the work this environment was built for but could not run (the build environment had no Docker daemon)
**Companions:** `benchmark-harness-consolidation.md` (the plan), `benchmark-harness-decisions.md` (decisions + open risks)

Everything that does NOT need Docker is already done, adversarially reviewed,
CI-gated, and green. Your job is the container-side validation and the real
A/B runs. Work the phases in order — each is a gate for the next.

---

## 0. Ground rules

- **Branches, not main.** All work lives on open PRs:

  | Repo | Branch | PR |
  | --- | --- | --- |
  | `itlackey/akm-bench` | `claude/harbor-akm-agent-p0` | #5 |
  | `itlackey/akm-eval` | `claude/memory-eval-refactor` | #3 |
  | `itlackey/akm` | `claude/akm-benchmark-measurement-75rpsg` | #818 (docs) |

- **Never weaken a loud failure to get past it.** The entire design converts
  "silently invalid measurement" into "loud setup abort". If an install
  self-check probe fails, that probe just did its job — fix the cause, not
  the probe. Every probe's failure message names what to look at.
- **Pin check before anything paid.** The stack pins `opencode-ai@1.18.21`,
  `akm-cli@0.9.1`, `akm-opencode@0.9.202808220049`, `harbor==0.22.0`. Run
  `npm view akm-cli dist-tags.latest` (and the other two) first. If a newer
  version shipped, the self-check probes (7b/7c/realign) will fail loudly on
  drift — that is correct behavior; update the pins in
  `harbor/akm_opencode.py` module constants + both job yamls together, or
  proceed knowing the pins still hold.
- **Record outcomes** as PR comments on #5/#3 and, for milestone results, a
  changelog entry in `akm/docs/plans/benchmark-harness-decisions.md`. Do not
  commit raw `jobs/` trees (large); commit only the analysis reports
  (`report.md`/`report.json`) under `akm-bench/results/harbor/<date>/`.
- **Hardware:** x86_64 Linux strongly preferred. SWE-bench images are
  x86_64-only (full Verified needs ~120GB disk; subsets far less). On Apple
  Silicon expect emulation pain — prefer a Linux box for Phase 4+.

## 1. Setup and static sanity (~15 min, no cost)

```sh
cd ~/code/github/akm-bench && git fetch && git checkout claude/harbor-akm-agent-p0 && git pull
cd ~/code/github/akm-eval  && git fetch && git checkout claude/memory-eval-refactor && git pull
cd ~/code/github/akm       && git fetch && git checkout claude/akm-benchmark-measurement-75rpsg && git pull

# Harbor in a repo-local venv (Python >= 3.12 required; harbor is pinned)
cd ~/code/github/akm-bench
uv venv .venv --python 3.12
uv pip install --python .venv/bin/python -r harbor/requirements.txt pytest pyyaml

# Reproduce the green gates locally before spending anything:
PYTHONPATH="$(pwd)" .venv/bin/python -m pytest harbor/tests -q   # expect: 174 passed
HARBOR_PYTHON=.venv/bin/python bin/check-harbor-contract         # expect: 14/14
bun install && bun run check                                     # expect: exit 0
docker info                                                      # daemon up
```

If the contract check fails, harbor's internals moved — STOP; every
downstream assumption is suspect (decision D12).

## 2. Phase P0 — the gate everything else waits on (~$1, 30 min)

Goal: prove, in a real container, that the model actually calls `akm_*`
tools. **"Nothing else starts until this passes"** (plan §7).

1. Edit `harbor/jobs/p0-smoke.yaml`: fill the `PROVIDER/MODEL` placeholders
   (e.g. `anthropic/claude-sonnet-4-5`) and any `/ABSOLUTE/PATH/TO/...`
   placeholders. **Gotcha:** `-m` on the CLI does NOT override a
   config-file agent's model — edit the YAML.
2. Export the provider key (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY` /
   `OPENROUTER_API_KEY` — opencode is passthrough).
3. Run from the repo root — `PYTHONPATH` is load-bearing (the custom agent
   resolves as a cwd-relative import `harbor.akm_opencode:AkmOpenCode`):

```sh
PYTHONPATH="$(pwd)" .venv/bin/harbor run -c harbor/jobs/p0-smoke.yaml   # or: .venv/bin/python -m harbor ...
```

4. **Success criteria** (all three, per `docs/harbor-p0.md` §0 — read that
   section first; it exists because "zero akm calls" has two very different
   causes):
   - The akm arm's install self-check passed (setup did not abort).
   - The run-phase proof did not raise (`AkmPluginNotLoadedError` absent —
     the trial `result.json` has no `exception_info`).
   - `jobs/<job>/<akm-trial>/agent/opencode.txt` shows `akm_*` tool calls,
     AND the events ledger confirms it:
     `jq -r 'select(.event=="tool_observation" and (.input.tool|startswith("akm_")))' .../xdg-state/akm-opencode/events.jsonl`
     (the obvious `.event|startswith("akm.")` filter matches NOTHING — documented trap).
5. If the model never calls the tools on `hello-world`, that is a P0 signal,
   not noise: check the plugin's session-start hints landed in the prompt
   before concluding anything. `docs/harbor-p0.md` §4 lists every evidence
   source and the failure-mode table.
6. Comment the outcome on PR #5. If P0 fails structurally, stop and report.

## 3. Phase P3-gate — corpus oracle validation (no model cost, ~1-2 h of builds)

The 46 converted tasks have never had their Docker images built. The oracle
agent runs each task's `solution/solve.sh` — no LLM, no API key.

```sh
cd ~/code/github/akm-bench
PYTHONPATH="$(pwd)" .venv/bin/harbor run -p harbor/tasks -a oracle -n 4 -o jobs/oracle-sweep
# (confirm the oracle agent's exact name with `harbor run --help` / agent list if it differs)
```

**Success:** 46/46 trials reward 1.0. Then spot-check the fail path: run 2-3
tasks with the `nop` agent (or oracle with solutions temporarily absent) and
confirm reward 0 — never a crash. Registry slices must also resolve:

```sh
PYTHONPATH="$(pwd)" .venv/bin/harbor run --registry-path harbor/registry.json -d akm-tasks-eval@1.0 -a oracle -o jobs/oracle-eval-slice
```

Failures here are Dockerfile/verifier-port bugs (the reward logic itself was
proven against a pinned host venv): typical culprits are `pip install` inside
the 17 pytest-task images and `apt-get jq` in 2 tasks. Fix, rerun, push.

## 4. Phase P2-live — Terminal-Bench 2.0 A/B (first paid run)

1. Edit `harbor/jobs/tb2-ab.yaml`: model placeholders; **comment out the
   `akm-accumulating` arm for the first run** (it needs a pre-populated
   `--mounts` volume and `n_concurrent: 1`; add it back per its header
   comments once static-vs-baseline works).
2. Subset first: add `-l 10` (or `-i` globs) so both arms run 10 tasks.
   k is set in the yaml (`n_attempts`); keep >= 3.
3. `PYTHONPATH="$(pwd)" .venv/bin/harbor run -c harbor/jobs/tb2-ab.yaml -l 10`
4. Checks before scaling to the full 89 tasks:
   - Every akm-arm trial's self-check passed (any abort = real config issue).
   - The run-phase plugin proof raised on zero trials.
   - `bin/akm-bench-analyze jobs/<job> --corpus harbor/tasks --md report.md`
     produces sane numbers (pass@1 per arm, paired CI, errored-trial
     disclosure). The analysis layer is the ONLY honest aggregator —
     harbor's own mean folds errors as 0 and its pass@k never emits pass@1.
   - Network note: task images restricting egress will break the plugin's
     session-start npm resolve IF the warm-boot cache missed — the
     self-check asserts the cache, so a green setup means no runtime npm
     needed. If setup itself can't reach npm, see `--allow-agent-host` and
     the D3 note in the decision register.
5. Cost anchor: sonnet-class ~$0.5–1.5 per instance per arm. 89 tasks x 2
   arms x k=3 is a real bill — get the 10-task run clean first.
6. Resume discipline: `harbor job resume -p jobs/<job>` reuses finished
   trials but requires a byte-identical job config — do not edit the yaml
   between resume attempts. Keep `--max-retries 0` (default) so failure
   forensics survive (retries rmtree the failed trial dir).

## 5. Phase P2-live — SWE-bench Verified A/B

Same shape as Phase 4 with `harbor/jobs/swebench-ab.yaml`. Constraints:
x86_64 + big disk; subset via `-l 25` or a fixed instance list first (the
50-instance "Verified Mini" distribution-matched subset is the standard
cheap slice). Harbor grades in-container with the official SWE-bench test
scripts (~1-2pp parity vs the official leaderboard, documented in harbor's
adapter README). If official-harness numbers are wanted later, collect each
trial's final git diff into `{instance_id, model_name_or_path, model_patch}`
JSONL and run `swebench eval verified -p preds.jsonl` — scoring is
generation-independent.

## 6. Analysis and reporting

```sh
bin/akm-bench-analyze <jobs-dir> --corpus harbor/tasks --md results/harbor/<date>/report.md --json results/harbor/<date>/report.json
```

Read the disclosure blocks before the headline number: errored-trial policy
(both variants are always printed), null-token counts, and the corpus-join
coverage. Commit the reports, push, summarize on PR #5 with the
reproducibility manifest (pins, dataset ref, model, k, subset).

## 7. akm-eval memory A/B (independent of Phases 2-6; needs Docker + OPENAI key)

```sh
cd ~/code/github/akm-eval
bin/build-image
bin/doctor --pack locomo
```

**The container caveat that will bite first:** `AKM_EVAL_AKM_CMD` must
resolve INSIDE the CLI container (`docs/memory-backends.md`). Either extend
`docker/akm-eval.Dockerfile` with `npm i -g akm-cli@0.9.1`, or mount an akm
checkout and point the var at it. `bin/doctor` reports the truth — WARN
means the akm variant will fail loudly, not fake results.

Then, smoke-scale first (the configs default to smoke limits):

```sh
export OPENAI_API_KEY=...   # provider + judging
for v in baseline raw-vector akm-memory; do
  bin/eval --pack locomo --variant $v --config config/common/locomo-akm-ab.json --out runs/locomo-ab/$v
done
bin/compare --baseline runs/locomo-ab/baseline --candidate runs/locomo-ab/akm-memory
bin/summary --runs runs/locomo-ab
```

Repeat for `config/common/longmemeval-akm-ab.json` (retrieval is now truly
wired — the inert-arm era is over, and a regression tripwire guards it).
**Read the zero-hit disclosures before scaling**: akm's FTS is a conjunctive
AND with no stopword removal, so expect high zero-hit rates on
natural-language queries (see Lessons, and the validity-risk entry in the
decision register). A high zero-hit run is a true measurement of the current
retrieval ceiling — publish it as that, or first improve `buildAkmSearchQuery`
/ the plugin's tool description, then re-run.

## 8. Exit criteria

- [ ] P0: model provably calls `akm_*` in-container (evidence linked on PR #5)
- [ ] Oracle: 46/46 converted tasks reward 1.0 in real containers
- [ ] TB2: 10-task 2-arm run clean, then full-scale run + analysis report committed
- [ ] SWE-bench: subset 2-arm run + analysis report committed
- [ ] Accumulating arm: attempted once with mount + n_concurrent 1, results labeled non-independent
- [ ] akm-eval: locomo + longmemeval three-variant runs, compare/summary committed
- [ ] Decision register changelog updated; PRs merged or explicitly held

---

## Lessons learned (from building this stack — read before debugging anything)

1. **The failure class that matters is silent degradation, not crashes.**
   Every serious defect found in review was a path where the treatment arm
   quietly became the baseline while producing a plausible score: the
   plugin fails warn-only at session start; invalid permission keys were
   silently stripped; the pinned CLI was silently outranked by an unpinned
   copy; the longmemeval "akm arm" never queried the backend; hardcoded
   seed expectations would have aborted or — worse — been loosened. The fix
   pattern is always the same: make the invalid state raise, and put the
   disclosure in the artifact (result.json/warnings), never only in docs.
2. **Verify against primary sources; claims decay.** The overrides-file pin
   mitigation was documented as the strongest fix and proven inert by one
   live npm probe (opencode installs plugins under `~/.cache/opencode/
   packages/`, not the config dir). Dataset ids differed between harbor's
   registry and hub. A "VERIFIED" docstring claim was false. When a step
   matters, run it once for real before trusting the description of it.
3. **Mutation-check load-bearing tests.** A test that passes proves little;
   a test that fails when its guarded line is reverted proves the guard.
   Every safety-critical behavior here (purges, probes, tripwires, skips)
   was mutation-verified — do the same for anything you add.
4. **Audit arm symmetry explicitly.** Confounds found and removed: a PATH
   replacement in one arm only, a 120s timeout binding only the slower arm,
   warm caches on treatment vs cold on baseline, metadata files uploaded to
   one arm containing literal answer keys. Before any paid run, diff what
   each arm's container actually receives.
5. **akm indexing has sharp edges that decide retrieval outcomes:** body
   prose is never indexed (only name/description/tags/hints/headings);
   heading indexing applies to `knowledge` assets only; `keywords:`
   frontmatter is ignored (`tags:` is not); a literal `$1`/`$ARGUMENTS`
   anywhere in a body reclassifies the file as a `command`; search is
   implicit-AND with no stopword removal, so sentence-shaped queries
   zero-hit while keyword queries rank 1. Question-form `searchHints`
   recover most of it (0/8 -> 7/8 in the treatment library). This is the
   single biggest validity lever for the whole experiment.
6. **CI lies in specific, checkable ways.** The repo's CI had been red on
   main since May, masking everything; the first-ever run of akm-eval's PR
   CI exposed tests that silently depended on `python3.11` and `uv`
   existing on dev machines; and `pytest.skip` on a missing hard dependency
   let CI go green on exactly the omission that would abort every trial
   (now a fail). Treat "green" as "green on THIS runner for THESE gates".
7. **Pin the harness and make the pin executable.** Everything this stack
   relies on in Harbor is internal behavior, not documented contract.
   `bin/check-harbor-contract` (14 assertions) is the tripwire — run it
   after any harbor upgrade before believing anything else.
8. **When a check contradicts content, the design intent decides which is
   wrong.** The leakage tests vs the az-cli skill: the verifier's own
   header ("the required command goes well beyond the gold ref's coverage")
   proved the *content* was the bug. Conversely the repeated-failure pair
   overlap was *by design*, so the *check* was the bug. Read the artifact's
   own stated intent before editing either side.
9. **Reports from sub-agents (and from yourself) need execution-verification.**
   Multiple implementer claims were falsified only by running things — and
   the session lead itself once misread an empty output file as a completed
   workflow. Trust nothing that has not produced output in front of you.
10. **Docker-less pre-validation works if — and only if — every container
    assumption fails loud.** That discipline is why this handoff is safe:
    anything the build environment got wrong about containers will stop
    your run at setup with a named probe, not corrupt a number.
