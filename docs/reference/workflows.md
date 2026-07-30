# Workflows

A workflow is a structured markdown document that defines a multi-step
procedure. akm parses it, persists run state, and lets you advance through
steps one at a time — resuming after interruptions, blocking on human review
gates, and tracking completion criteria per step. The agent follows steps; the
human approves gates.

> **The native orchestration engine requires an opt-in.** `start` / `next` /
> `complete` / `status` / `list` / `create` / `resume` / `abandon` —
> everything through [Writing a workflow](#writing-a-workflow) below — work
> with no config changes, including a workflow whose frontmatter declares
> `map`/`route`/`gate`. But `akm workflow run`, `akm workflow brief`, and
> `akm workflow report` — the surfaces that actually dispatch a step's units
> with the native engine or the driver protocol — refuse outright until
> `experimental.workflowEngine` is set — see [Enabling the workflow
> engine](#enabling-the-workflow-engine-opt-in-in-090) before trying any of
> those three.

## akm workflow start

`akm workflow start` creates a new persisted run for a workflow asset. Run
state is scoped to the current project directory (nearest `.akm/config.json`,
git root, or stash root), so concurrent runs in different directories stay
independent.

```sh
akm workflow start workflows/ship-release
akm workflow start workflows/ship-release --params '{"version":"1.2.3"}'
```

The run snapshots the step list at start time. Edits to the source workflow
file after a run has started do not affect in-flight runs.

**Example: kick off a release**

```sh
akm workflow start workflows/ship-release --params '{"version":"2.0.0"}'
# → {"run": {"id":"<uuid>","status":"active","currentStepId":"validate",...}}
```

## akm workflow next

`akm workflow next` returns the current actionable step for an active run. If
no active run exists for the given ref in the current scope, it auto-starts
one. This is the primary command an agent calls in a loop.

```sh
akm workflow next workflows/ship-release
akm workflow next <run-id>
akm workflow next workflows/ship-release --params '{"version":"1.2.3"}'  # auto-start params
```

The response includes the step object (`title`, `instructions`,
`completionCriteria`) or `"done": true` when the run is complete.

**Example: step through an onboarding workflow**

```sh
# Agent loop:
akm workflow next workflows/repo-onboarding
# read instructions → perform work → mark complete → repeat
akm workflow complete <run-id> --step setup-ci --notes "CI configured in .github/workflows/"
akm workflow next workflows/repo-onboarding
```

## akm workflow status

`akm workflow status` shows the full run state — all step statuses, notes, and
evidence — for a given run ID or workflow ref.

```sh
akm workflow status <run-id>
akm workflow status workflows/ship-release
# When given a ref, resolves to the most-recently-updated run in the current scope
```

Use this to inspect where a run is after a context window break, or to verify
all steps completed cleanly before closing a PR.

**`--units` — per-unit diagnostics.** For an orchestrated run, add `--units`
to also list the run's journaled unit rows — each unit's id, status,
`failure_reason`, and any result/error diagnostic text the row carries:

```sh
akm workflow status <run-id> --units
```

This is a **diagnostic** surface, deliberately kept out of the deterministic
artifact graph. A step's promoted artifact (what `steps.x.output` resolves to,
and what a gate judges) keeps only a failed unit's structured `failure_reason`
— never the raw error text — so step evidence stays reproducible across the
engine and `brief`/`report` surfaces. When you need the human-facing *why*
behind a failure, `--units` reads the unit journal directly and shows it
without ever feeding that text back into an artifact or input hash.

## akm workflow list

`akm workflow list` shows workflow runs in the current scope.

```sh
akm workflow list              # All runs in this scope (any status)
akm workflow list --active     # Only status=active (executable) runs
akm workflow list --ref workflows/ship-release  # Runs for a specific workflow
```

`--active` filters to runs whose status is exactly `active` — currently
executable work. A `blocked` run (parked awaiting a human `akm workflow resume`)
or a `failed`/`completed` run is **not** active and is excluded, so a script
that treats `--active` output as runnable never picks one up. Blocked runs
remain listed by the unfiltered `akm workflow list` with their `blocked` status.

**Example: see what is in flight**

```sh
akm workflow list --active
# → lists runs by workflow ref, status, currentStepId, and updatedAt
```

## Writing a workflow

A workflow is an ordinary AKM markdown asset — the same envelope as every
other type, OKF-conformant frontmatter plus a markdown body — whose
frontmatter carries the entire orchestration graph (params, and how each step
dispatches, fans out, routes, and gates) and whose body carries each step's
instructions and gate rubric under plain headings, joined to the frontmatter
by step id. There is **one** format: no separate YAML "program" surface, no
`.yaml`/`.yml` workflow files.

Use `akm workflow create --print` to print a valid starter, then edit it and
register it with `akm workflow create`.

```sh
akm workflow create my-release --print   # Print the template, without writing
akm workflow create my-release --from ./my-release.md
akm lint --type workflows                # Check for structural errors before using it
```

**A minimal workflow:**

```markdown
---
type: workflow
description: Ship a tagged release to production
params:
  version: { type: string, description: The semver version string to release }
steps:
  - id: validate
  - id: build
    inputs: [steps.validate.output]
---

# Ship Release

## validate

Check that the `version` parameter follows semver and the tag does not
already exist.

### gate

- `git tag v<version>` does not already exist.
- The version string matches `^\d+\.\d+\.\d+$`.

## build

Run `npm run build && npm test`, using the validation from `validate`,
attached to this unit as input. Fix any failures before proceeding.
```

**Body rules** (checked by `akm lint --type workflows`):

1. Every level-2 heading must be `## <step-id>` for a step declared in
   frontmatter, exactly — no titles, no `Step:`/`Step ID:` lines, no
   `# Workflow:` prefix on the H1. (Fenced code blocks are skipped when
   scanning for headings.)
2. A `unit` or `map` step **must** have a body section — its instructions,
   or its per-item template for a map step, byte-exact to the next H2 or
   EOF. A `route` step **may** have one (documentation, plus a gate rubric
   if it is gated). Everything before the first H2 is free preamble —
   indexed for search, shown in `akm show`, never dispatched.
3. Inside a step's section, an optional `### gate` sub-heading starts that
   step's gate rubric, running to the section end — the format's **single
   reserved marker**. The judge that evaluates the step receives this whole
   section byte-exact. Frontmatter `gate:` without a `### gate` rubric is a
   lint error; a `### gate` rubric alone declares a default gate (fail-open,
   unbounded loops — tune with the frontmatter key, see *Required gates*
   below).

Prose is never templated — see [The reference grammar](#the-reference-grammar)
for how a step's instructions refer to run params, upstream artifacts, and a
map unit's item.

**Frontmatter**, validated by one published JSON Schema
(`schemas/akm-workflow.json`): the standard AKM asset envelope (`type`,
`description`, `tags`, `when_to_use`, `xrefs`, `updated`/`timestamp`, and the
OKF v0.2 trust/lifecycle families) plus the orchestration keys:

- `params` — name → `{ type, description }` (JSON-Schema-typed, unlike a bare
  description string).
- `defaults` — run-level dispatch defaults (`engine`, `model`, `llm`,
  `timeout`, `on_error`), overridable per unit.
- `budget` — run-lifetime ceilings (`max_units`, `max_tokens`; see *Budget
  ceilings* below).
- `steps` — an ordered list. Each step has an `id`
  (`[A-Za-z_][A-Za-z0-9_-]*` — no dots) and **at most one** of `unit`, `map`,
  or `route`. A step with neither is **still a unit step** — bare
  `- id: validate` is the complete minimal declaration. `unit:` is the
  optional dispatch-override bag (`engine`, `model`, `llm`, `timeout`,
  `retry`, `on_error`, `env`, `isolation`; see below).
- `inputs` — on a `unit`/`map` step, the prior-step artifacts this step
  consumes, as bare reference strings (sub-paths legal:
  `steps.x.output.issues`, not just `steps.x.output`). This is how a step's
  attached context sees upstream data, and how replay hashing gets its exact
  input set — a step re-dispatches only when the slice it actually consumes
  changes.
- `output` — a JSON Schema for the step's promoted artifact.
- `gate` — control only: `required` (never silently bypassed — see
  *Required gates*) and `max_loops` (bounded evaluator-optimizer retry, see
  *Gates judge the artifact*). The rubric itself lives in the body's
  `### gate` section.

No `version:`/`name:` keys — identity is the ref, and the frozen plan already
versions execution semantics — and no step titles anywhere: a step is its id,
and the asset's human name is its `description` and H1 like any other asset
type.

**A richer example** — fan-out, routing, retries, gates, and a run budget:

```markdown
---
type: workflow
description: Review changed files and route the outcome
params:
  changed_files: { type: array, description: Files to review }
defaults: { engine: reviewer, model: balanced, timeout: 10m, on_error: fail }
budget: { max_units: 40, max_tokens: 200000 }
steps:
  - id: discover
    output: { type: object, properties: { files: { type: array } }, required: [files] }
  - id: review
    map:
      over: steps.discover.output.files
      concurrency: 8
      unit: { engine: reviewer, model: deep, timeout: 5m, retry: { max: 1, on: [timeout, llm_rate_limit] }, on_error: continue, isolation: worktree }
    output: { type: object, properties: { file: { type: string }, verdict: { type: string } }, required: [file, verdict] }
    gate: { max_loops: 2 }
  - id: aggregate
    inputs: [steps.review.output]
    output: { type: object, properties: { verdict: { type: string } }, required: [verdict] }
  - id: triage
    route:
      input: steps.aggregate.output.verdict
      when: [{ match: pass, step: ship }, { match: fail, step: rework }]
      default: manual-triage
  - id: ship
  - id: rework
  - id: manual-triage
---

# Review Changes

## discover

List the files that need review, drawn from the `changed_files` parameter.

### gate

Every file named by `changed_files` is listed in the reported result.

## review

This section is the **map unit template** — the engine attaches each unit's
item (the file to review) and its index as context; instructions refer to
"the file you were given," never a template expression.

Review the file you were given for correctness bugs.

### gate

Every changed file has a verdict of `pass` or `fail`.

## aggregate

Combine the per-file review verdicts — attached to this unit as input via
`inputs: [steps.review.output]` above — into one overall verdict, `pass` or
`fail`.

## triage

Routes on the verdict `aggregate` reported: `pass` proceeds to `ship`, `fail`
proceeds to `rework`, anything else goes to `manual-triage`.

## ship

Ship the change.

## rework

Address the review findings, then re-run the review.

## manual-triage

Summarize the ambiguous verdict for a human to triage.
```

## The reference grammar

Workflow prose is **never templated** — there is no `${{ … }}`/`{{ … }}`
interpolation anywhere in a workflow's body, and no escape syntax to learn,
because there are no delimiters in prose to escape.

Bare reference strings appear in exactly three frontmatter positions, each an
unquoted-style YAML string:

| Position | What it names |
| --- | --- |
| `map.over` | The list a map step fans out over. |
| `route.input` | The value a route step matches on. |
| `inputs` (each entry) | A prior step's artifact this step consumes. |

Every reference resolves against exactly two roots:

| Reference | Meaning |
| --- | --- |
| `params.<name>` | A run parameter, by name. |
| `steps.<id>.output( .<ident> \| [<int>] )*` | A prior step's artifact, addressed by producer step id; the path walks properties (`.name`) and array indexes (`[0]`). |

Nothing else parses: no functions, no clock, no randomness, no ambient
lookup. `item` and `item_index` are **not** part of the language — a map
unit's item and its index are never referenced from anywhere in frontmatter
or body. They arrive as **attached context** instead, the same way as
everything else a unit needs.

**Context attachment, not string splicing.** Each dispatched unit receives,
alongside its byte-exact instructions, structured context:

- every run **param** (params are run-scoped and documented non-secret — see
  *Params are not secret* below);
- for a **map** unit, its **item** and **item index**;
- the artifacts named by its step's **`inputs:`**.

Instructions refer to this context in plain language — "clone the repository
named by the `repo` parameter," "review the file you were given," "using the
intake step's artifact attached to this unit" — never by splicing a value
into the instruction string. This closes the injection class at the root:
data never enters the instruction string, spliced or otherwise.

`akm lint --type workflows` still checks every bare reference statically —
unknown step, unknown param, bad path — at lint time.

**What a step's output is.** `steps.<id>.output` resolves to the value the
step's execution produced:

- a `unit` step → the unit's structured result (when the unit declares
  `output`) or its text;
- a `map` step → the collected array of per-item results, in item order
  (under `on_error: continue`, a failed item's slot is `null`), unless the
  step's own `output` schema describes a reduced, single-value shape
  instead;
- a step completed manually through `akm workflow complete` exposes whatever
  evidence was recorded for it as its output.

**An empty successful free-text output is treated as no output.** When a
schemaless unit (one that declares no `output` schema) succeeds but returns
the empty string, akm normalizes it to *absent*: nothing is journaled for its
result, and its contribution to the step artifact is `null` — a `null` slot
in a collected array, or `output = null` for a solo step. This absence is
deliberate and consistent across every driver surface (engine, and
`brief`/`report`), so a live run and a resumed/reported run promote the
identical artifact. The practical consequence: a downstream step that
declares an empty upstream result in its `inputs:` gets nothing meaningful
attached for it — akm surfaces this loudly rather than silently attaching an
empty string. A unit that declares an `output` schema is unaffected — an
empty response is not valid JSON, so it fails as a parse error and can never
satisfy a schema as a silent `null`.

## Enabling the workflow engine (opt-in in 0.9.0)

Everything above this line — `start`, `next`, `complete`, `status`, `list`,
`create`, `resume`, and `abandon` — ships unconditionally and needs no config
change, whether or not the workflow's frontmatter declares `map`/`route`/
`gate`.

The rest of this doc describes the **native orchestration engine**: the
map/route/gate/retry/budget/isolation capabilities a workflow's frontmatter
can declare, and the commands that execute them. Those commands are gated
behind an explicit opt-in and refuse outright — a classified `ConfigError`
(`WORKFLOW_ENGINE_NOT_ENABLED`, exit code 78) — until you set:

```sh
akm config set experimental.workflowEngine true
```

| Surface | What it does when enabled |
| --- | --- |
| `akm workflow run` | Executes a run's steps with the native engine, dispatching each step's units to the configured runner |
| `akm workflow brief` | Read-only half of the harness-neutral driver protocol |
| `akm workflow report` | Mutating half of the harness-neutral driver protocol |

The refusal names the exact surface and config key, e.g.:

```jsonc
{
  "ok": false,
  "error": "`akm workflow run` is EXPERIMENTAL and refuses to run until `experimental.workflowEngine` is set. Run `akm config set experimental.workflowEngine true` to enable it.",
  "code": "WORKFLOW_ENGINE_NOT_ENABLED"
}
```

`akm lint --type workflows` is **not** gated — it only type-checks a
workflow's frontmatter and body without executing anything. `akm task
doctor` reports the gate's live state under `workflowEngine.enabled`
and `workflowEngine.configKey`, so you can confirm whether it is on without
tripping a refusal. The engine is never enabled by inference: an absent
`experimental` section, an absent `workflowEngine` key, and an explicit
`false` all read as off — only `true` turns it on.

See [STABILITY.md](../../STABILITY.md) for the full stability classification
of these surfaces.

`akm workflow run <run-id|workflows/ref>` compiles the frontmatter's step
graph into a plan, freezes that plan on the run, dispatches each step's units
to the configured engine (fan-out runs units concurrently), records every
unit in `workflow_run_units`, and advances the run through the normal
completion gates. A workflow with no `map`/`route` steps compiles to a linear
plan, and the manual `next`/`complete` loop keeps working on every run either
way.

The native engine is not the only thing that can drive an orchestrated run.
The **harness-neutral driver protocol** (`akm workflow brief` /
`akm workflow report`, described in *Driving a run from any agent* below)
lets any agent session — Claude Code, opencode, Codex, or a human at a shell
— execute a run's units itself and report the results back through the same
code paths the engine uses. A run is driven by **one engine _or_ one external
driver at a time** (the run lease arbitrates), and both surfaces produce
byte-identical unit graphs.

## Frozen plans

`akm workflow start` compiles the workflow and freezes the resulting plan on
the run row (`plan_json` + `plan_hash`). **A run executes the plan compiled
at start; edits to the source file need a new run** — the file is never
re-read for an in-flight run, so `run`, `next`, and `resume` all see the same
workflow no matter what has changed on disk. Orchestration decisions are pure
functions of the frozen plan, the run params, and journaled unit results.

**Resume is journaled replay.** Every dispatched unit is journaled with a
content-derived identity — the step id plus a hash of the unit's frozen
instructions, its item (for a map unit), its declared `inputs:` artifacts,
and the params snapshot — and its input hash. On re-run, a journaled
completed unit with the same identity and the same inputs is **reused**,
never re-dispatched; a failed or missing unit is dispatched live. If a
journaled completed unit matches by identity but its recorded inputs differ,
the engine fails the step with a **replay divergence** error naming the unit
— it never silently re-runs work whose inputs changed under it. (Divergence
means the program produced different data for the "same" unit across
invocations — a nondeterminism bug worth surfacing, not papering over.)

## Failure policy

Fail-fast is the default. Per unit (or via `defaults.on_error`):

- `on_error: fail` — the first failed unit fails the step, which fails the
  run (`akm workflow resume` re-opens it; `run` re-dispatches only
  incomplete units).
- `on_error: continue` — failures are recorded in the step's results and the
  completion gate decides whether the step passes.
- `retry: { max: <n>, on: [<failure_reason>…] }` — re-dispatches a failed
  unit up to `max` extra times when its recorded `failure_reason` is listed
  (e.g. `timeout`, `llm_rate_limit`, `spawn_failed`, `non_zero_exit`); every
  attempt is journaled separately.

A unit's `output` schema is validated on every runner; a validation miss
re-dispatches once with corrective feedback before the unit is recorded as
failed.

## Routing

A `route` step makes classify-and-dispatch first-class: the engine resolves
the explicit `input:` expression, selects the matching `when:` branch (or
`default:`), and auto-skips the unselected branch targets as the spine
reaches them. A target must be a step declared in the workflow; an
unroutable value with no `default` fails the step rather than letting every
branch run. A target may name a step earlier in the frontmatter list — the
GitHub Issues Parallel Implementer example workflow uses this to loop a
batch back through `prepare-worktrees` until every issue clears its gate.
Route decisions are journaled, so a resumed run replays the same choice.
Skips cascade: when a route step is itself skipped (it was the unselected
target of an earlier route), its own branch targets are skipped too — a
router that never decided selects nothing. Routing (like fan-out) is an
engine feature: it applies under `akm workflow run` — the manual
`next`/`complete` loop does not auto-skip.

## Typed step artifacts

When a step declares `output`, the promoted step artifact (the unit's
structured result, the collected array, or a reduced single value — see
*What a step's output is* above) is validated against that schema **before**
the step can complete. A mismatch fails the step with the validation errors
in its summary. This is fail-fast on purpose: a bounded gate loop (next
section) can re-run the step with those errors as corrective feedback.

## Gates judge the artifact; `max_loops` bounds the retry

Under `akm workflow run`, a step with a body `### gate` rubric is gated on
its **artifact**, not on engine prose: the judge receives the step's
artifact as canonical JSON (clipped at 4000 characters) alongside the
`### gate` section byte-exact, so the gate evaluates real results rather
than a machine summary like "Executed 3 units". Each engine-driven gate
evaluation is itself an LLM call and is journaled as a unit row
(`<step-id>.gate:l<loop>`); human approvals are never cached — a blocked
gate stays blocked until a human acts.

`gate.max_loops: <n>` (frontmatter) turns the gate into a bounded
evaluator-optimizer loop: on a rejection (or a typed-artifact schema
mismatch) with loop budget left, the engine re-executes the step's units
with the gate feedback and the missing-criteria list appended as attached
context. The feedback changes each unit's inputs, so the re-run naturally
dispatches fresh units instead of replaying journaled results. When the loop
budget is spent, the rejection stands exactly as in the one-shot case.

## Required gates (never silently bypassed)

By default a completion gate is **fail-open**: with no `### gate` rubric, or
when no LLM judge is available (offline, or the default LLM cannot be
resolved), the step completes without judging. That keeps offline use
working, but it means a workflow that relies on a gate can be silently
bypassed in a misconfigured environment.

`gate.required: true` closes that hole for a specific step:

```markdown
---
steps:
  - id: ship
    gate: { required: true }
---
...
## ship

Ship the release.

### gate

- The changelog is updated.
- The version is bumped.
```

When a **required** gate carries a rubric but no judge is available, the step
does **not** fail open — it is **BLOCKED** (the run goes to `blocked`) with a
message telling you to configure an LLM. Nothing is silently passed. A human
resolves it via the documented manual path: `akm workflow resume <run-id>`
(re-evaluate the gate once an LLM is configured) or
`akm workflow complete`/`abandon`. A required gate that *does* have a judge
behaves exactly like a normal gate — it only diverges when a judge is missing.

`gate.required` rides the frozen plan, so **both** surfaces enforce it
identically: `akm workflow run` (the engine) and `akm workflow report` (any
external driver) block the step the same way.

`akm workflow run --require-gates` is the run-wide override: it treats
**every** rubric-bearing gate in the run as required for that invocation,
without editing the workflow. Use it in CI or any environment where an
unjudged gate must never pass. (The flag applies to the engine invocation; a
per-step `gate.required: true` is the portable form that also governs the
`report` driver path.)

## Budget ceilings

The top-level `budget:` key declares run-lifetime ceilings: `max_units`
(total dispatched units) and `max_tokens` (total reported token usage). Both
counters are seeded from the unit journal, so they measure the **whole run
across resumes**, not just the current invocation. Hitting a ceiling aborts
the step's still-pending dispatches and fails the step with a
`budget exceeded (<which> ceiling)` summary — budget exhaustion is a hard
stop that ignores `on_error: continue`. Because the plan is frozen, raising
a budget means starting a new run.

## One engine drives a run (the run lease)

`akm workflow run` takes a **run lease** before dispatching anything: a
random holder id with a 90-second expiry recorded on the run row, renewed
between steps, and released when the invocation exits. A second
`workflow run` against a live-leased run refuses up front, naming the holder
and the expiry. An *expired* lease is claimable, so a crashed engine never
wedges a run — wait out the expiry and re-run. While the lease is live the
engine owns the step spine: manual `akm workflow complete` is refused with
the same holder/expiry message until the engine finishes or the lease
lapses. `workflow next`/`status` remain read-only and always work; run
detail surfaces a live lease as `engineLease` (holder + expiry). An
orchestrated run can also be driven by an external agent instead of the
engine — see *Driving a run from any agent (brief/report)* below.

## Driving a run from any agent (brief/report)

`akm workflow run` is the engine driving a run itself. But an orchestrated
run does not require akm to spawn the agents — **any** agent session (Claude
Code, opencode, Codex, or a human at a shell) can drive the same frozen plan
by executing its units and reporting the results back. Two commands make this
work, and neither duplicates any orchestration logic: both call the exact
same shared step semantics the engine uses, so an engine-driven run and a
driver-driven run of the same plan produce **byte-identical unit graphs**.

- **`akm workflow brief <run-id|workflows/ref>`** — read-only. It finds the
  run's active step, computes the work-list the engine *would* dispatch, and
  tells you exactly what to run and how to report it. It **takes no lease,
  dispatches nothing, and mutates nothing** — it is safe to call as often as
  you like.
- **`akm workflow report <run-id> --unit <unit_id> --status …`** — the only
  mutating verb. It ingests one unit's result through the same reducer,
  artifact-promotion, schema-validation, and gate path the engine runs, and
  advances the step when its work-list is fully terminal.

### Params are not secret

Workflow **params** are declared **non-secret**. A run's params are attached
as structured context to every dispatched unit — the assembled prompt
threads them in alongside a `PARAMS_JSON` preamble block, rather than
splicing them into the instruction text — and are hashed into each unit's
identity. The driver protocol's core guarantee is that `brief` surfaces the
*byte-identical* prompt a driver must execute — so params **cannot** be
redacted without breaking the input-hash contract and cross-surface parity.
**Never put credentials in params.** Put secrets in **env bindings** (`env:`
refs), which `brief` surfaces by **name only** and never resolves.

As a guardrail, both `akm workflow start` and every `brief` emit a best-effort
**secret-shaped-value warning** (in the response `warnings` array) when a param
value *looks* like a credential — a secret-suggesting key name, a long
high-entropy string, or a known token prefix. It is advisory only: it **never
blocks** a run and is intentionally heuristic (expect false positives and
misses). It exists to nudge an author toward an env binding, not to scan.

### The protocol loop

Driving a run is a loop: **brief → execute → report → repeat**, until the
brief reports the run is done.

1. **`brief`** the run. The output lists the active step and, for each unit
   the step expects, a `WorkflowBriefUnit` with:
   - `unitId` — the content-derived id you pass back verbatim to `report`;
   - `nodeId`, `engine`, `runtimeKind`, `platform`, `model`, `timeoutMs`, `retry`, `onError`;
   - `resolved.instructions` — the fully-assembled prompt (engine preamble +
     the step's byte-exact instructions + attached params/item/`inputs:`
     context + any gate feedback + schema directive), **byte-identical** to
     what the engine would dispatch — and `resolved.inputHash`;
   - `outputSchema` — the JSON Schema your result must validate against, when
     the unit declares one;
   - `env` — env binding asset **names only** (`brief` never resolves a
     binding, so no secret value can ever appear in its output);
   - `action` — the driver-facing state: `pending` (execute it), `claimed`
     (another driver holds a live `--status running` claim), `stale` (a claim
     went silent past the check-in window — reclaimable), `done`/`failed`
     (terminal), or `do_not_run` (a live engine lease owns the spine, or the
     unit's inputs are unresolvable). A driver runs only `pending`/`stale`
     (and its own `claimed`) units;
   - `report` — the exact `akm workflow report …` command line to run. Present
     **only for actionable states**: `pending`/`stale`/`claimed` get the normal
     completed form, `failed` gets the `--rerun` form, and `done`/`do_not_run`
     carry **no command** at all. Every command embeds `--expect-step` (see
     below);
   - `journaled` — the unit's already-recorded status, if a row exists (so a
     resumed driver skips finished work).

   The top-level brief also carries a `spineToken` — an opaque watermark over
   the run id, active step id, gate loop, and a run-mutation counter — and a
   `warnings` array (see *Params are not secret* above).

   **The spine can move under you.** Between the `brief` you plan against and
   the `report` you send, a concurrent `report`/`run`/manual completion can
   advance the run to a different step. Every brief report command therefore
   carries `--expect-step <activeStep>`: `report` refuses (with a clear message
   pointing you back at `brief`) if the run's active step no longer matches, so
   you never record a result against a step you did not plan against. Compare
   `spineToken` across polls to detect the move yourself.
2. **Execute** each pending unit however you like — in the current session,
   by spawning a subagent, or by hand. `brief` also emits the step's gate
   rubric, its output-schema contract, and (for a route step) the
   deterministic branch decision.
3. **`report`** each result. For a schema unit, pass JSON matching
   `outputSchema` via `--result '<json>'`, `--result-file <path>`, or stdin;
   for a free-text unit, any text (or none). Add `--tokens N` so the result
   counts against a declared budget, and `--session-id S` to record the
   harness-native session id.
4. When your `report` makes the step's work-list fully terminal, akm runs the
   **same completion path the engine runs** — reduce the unit outputs, promote
   and validate the typed step artifact, and judge the artifact against the
   gate rubric — then either advances the spine or, on a gate rejection with
   loop budget left, leaves the step active. Re-run `brief`: if the gate
   looped, the next brief emits **loop-N's work-list with the judge feedback
   already threaded into every unit's attached context** (recovered from
   the journaled `<stepId>.gate:l<n>` row, so the loop-N unit ids and hashes
   match what the engine would compute).

Repeat until `brief` reports `done: true`.

### Advancing a step with no reportable units (`--settle`)

Two states leave the active step with **no** per-unit work a driver can
`report --unit`, so a driver looping on `brief → report --unit` would get stuck
forever. For both, `brief` emits a top-level `settleCommand` (with a message
that says what to do — never `Execute them, then report each result` when there
is nothing to execute) instead of per-unit report lines:

```sh
akm workflow report <run> --settle --expect-step <activeStep>
```

1. **Non-dispatching step** — a route step keyed on a params expression, a
   fan-out over an empty list, or a step whose entire work-list is unresolvable.
   Nothing was ever dispatchable.
2. **Fully-terminal step still needing finalization** — every unit already ran
   to a terminal state (they show as `done`/`failed` with **no** report
   command), but the step never advanced. This is the recovery state after a
   **required-gate block was resumed** (`akm workflow resume` reopens the step,
   but the gate still needs judging) or a crash between the last unit write and
   the step's completion. The work is done; only the gate/finalize remains.

`report --settle` takes **no** `--unit`/`--status` — it runs the same
deterministic completion path the engine runs (reduce → promote/validate the
typed artifact → judge the gate → `completeWorkflowStep`), advancing the spine
past every step that has no `report --unit` a driver could ever send, until it
reaches a step with real work (or the run terminates). For the fully-terminal
case it finalizes the resting step in place: it **advances** if the gate passes,
or — for a **required gate with no judge available** — correctly **re-blocks**
the run, pending a configured judge or a manual `akm workflow complete`. It is
**refused if the step still has genuinely pending units** (anything to execute,
in-flight, or a retry-eligible failure — `report --unit`/`--rerun` those
instead) and, like every mutating verb, refused under a live engine lease. It
carries `--expect-step` so a stale copy fails once the spine has moved.

### Unit check-in and heartbeat

Executing a long unit? Claim it and heartbeat so other drivers know it is in
progress:

```sh
akm workflow report <run> --unit <unit_id> --status running --note "cloning repo"
```

`--status running` records `started_at` on first claim and updates
`last_checkin_at` on every subsequent call (migration 007's additive
column). It **never advances the spine** — it is a liveness signal only, and
the `--note` is intentionally not persisted. `brief` and `status` surface any
unit that was claimed `running` but has gone silent past the check-in window
(90 s) as a **stale unit**, so a second driver can reclaim work whose driver
died. Staleness is a pure timestamp evaluation (no daemon, no background
thread — the same design as the run-level check-in), deterministic in the
injected clock.

### Lease interplay: one engine _or_ one external driver

The run lease arbitrates: a run is driven by **one engine or one external
driver at a time**, never both.

- While `akm workflow run` holds a **live** lease, `report` is **refused**
  (naming the holder and expiry) — the engine owns the spine while it drives.
  `brief` still works (it is read-only) but prints a loud warning telling you
  not to execute its units, because the engine is dispatching them right now.
- An **expired** lease is claimable, so a crashed engine never wedges a run:
  wait out the 90 s expiry, then drive it with brief/report.
- The external driver protocol itself takes **no** lease — the guard is that
  `report` refuses while a *live engine* lease exists. Coordinate concurrent
  human drivers with the unit check-in above.

### Replay and idempotency guarantees

`report` ingests through the frozen plan's journal, so its safety properties
are the engine's:

- **Idempotent re-report.** Re-reporting a COMPLETED unit with the **same**
  input hash is a no-op (exit 0, "already recorded") — safe to retry a
  `report` whose network died mid-write.
- **Replay divergence.** Re-reporting a COMPLETED unit with a **different**
  input hash is a hard error naming the unit: under a frozen plan the same
  unit identity must reproduce the same inputs, so akm refuses to silently
  overwrite it. Start a new run to re-execute the work.
- **Unknown unit.** A `--unit` id that does not belong to the active step's
  recomputed work-list is a usage error that lists the valid ids — you
  cannot report a unit the plan does not expect.
- **Schema-checked results.** A schema unit's `--result` is validated against
  its `outputSchema` before it is stored, with the same subset validator the
  engine uses.
- **Budget ceilings.** Journal-seeded `budget.max_units`/`max_tokens` are
  enforced on `report` exactly as on the engine — crossing a ceiling fails
  the step hard (budget ignores `on_error`), rather than leaving a stuck run.
- **Failure-reason taxonomy.** `report --failure-reason` is normalized to the
  persisted failure vocabulary (the same `AgentFailureReason` set `retry.on`
  matches on). A reason **in** the taxonomy (e.g. `timeout`, `non_zero_exit`)
  is stored **verbatim**, so a driver-reported failure participates in
  `retry.on` identically to an engine dispatch. Anything else is namespaced
  under `external:<slug>` (lowercase, `[a-z0-9_-]`, clipped) — recorded for
  observability but, being outside the taxonomy, it can **never** trigger a
  workflow's `retry.on`. An absent reason defaults to `reported_failure`.

Because both surfaces share one implementation, the conformance suite runs
every golden workflow twice — engine-driven, then brief/report-driven — and
asserts the two unit graphs are identical.

### Historical runs without an executable frozen plan

`brief` and `report` describe and ingest against a run's **frozen plan**
(migration 006). A run started before frozen plans exist (`plan_json` is NULL —
a pre-006 legacy run) has no plan for the driver protocol to read, so both
commands **refuse it with a clear error**. The engine never recompiles
historical rows from a mutable source asset. They remain available to
inspection and abandonment surfaces; start a new run to execute the current
workflow source.

### Worked example

Drive a two-step review workflow by hand. Start a run without dispatching,
then loop brief → execute → report:

```sh
# Start the run (freezes the plan; does not dispatch).
akm workflow start workflows/review-changes --params '{"changed_files":["a.ts"]}'
# → {"run":{"id":"r1","status":"active","currentStepId":"discover",...}}

akm workflow brief r1
```

```jsonc
{
  "ok": true,
  "active": true,
  "step": { "stepId": "discover", "gate": { "currentLoop": 1 } },
  "workList": {
    "isFanOut": false,
    "units": [
      {
        "unitId": "discover:solo",
        "engine": "reviewer",
        "runtimeKind": "sdk",
        "action": "pending",
        "outputSchema": { "type": "object", "properties": { "files": { "type": "array" } }, "required": ["files"] },
        "resolved": { "ok": true, "instructions": "…List the files that need review…", "inputHash": "9f2c…" },
        "report": "akm workflow report r1 --unit discover:solo --expect-step discover --status completed --result-file <result.json>"
      }
    ]
  }
}
```

Execute that unit, then report its structured result:

```sh
akm workflow report r1 --unit discover:solo --status completed \
  --result '{"files":["a.ts"]}' --tokens 1200
# → step "discover" gate passes on its artifact; the spine advances.
#   {"stepOutcome":{"kind":"advanced"},"runStatus":"active",
#    "message":"Step \"discover\" completed. Next: run `akm workflow brief r1` for step \"review\"."}

akm workflow brief r1
# → active step "review" is a fan-out (map over ["a.ts"]): one unit
#   "review:<hash>" with the reviewer engine and the per-file schema.

# Claim it while you work, then report:
akm workflow report r1 --unit review:1f3a… --status running --note "reviewing a.ts"
akm workflow report r1 --unit review:1f3a… --status completed \
  --result '{"file":"a.ts","verdict":"pass"}'
# → the review step's collected array promotes the artifact, the gate judges it.

akm workflow brief r1
# → {"done": true, "message": "Workflow run is completed — no work remains."}
```

If a gate had rejected the `review` step (with `max_loops` budget left), the
next `brief r1` would show `step.gate.currentLoop: 2`, a `gateFeedback`
object, and a fresh work-list whose unit prompts already carry the judge's
missing-criteria feedback in their attached context — you re-execute and
re-report exactly as in loop 1.

## Following a run's events

There is no `akm workflow watch` (0.9.0: dropped — a foreground polling
daemon in a one-shot CLI). `akm log --run <run-id>` reads the same
`workflow_*` / `workflow_unit_*` events from the general append-only events
stream: `--since '@offset:<id>'` gives a durable row-id cursor a cooperating
process can poll from, in place of `watch --stream`'s in-process loop.

```sh
akm workflow run <run-id> &                                  # engine in one shell
akm log --run <run-id> --since '@offset:0'                   # backlog so far
akm log --run <run-id> --since '@offset:<nextOffset>'        # poll for more, from the prior call's nextOffset
```

Event metadata is ids/status/enums only — never workflow-authored content —
so following a run's events is safe to pipe into logs or dashboards.

## Worktree isolation

A file-mutating unit can declare `isolation: worktree` (agent and sdk
runners). Each unit attempt gets a fresh **detached git worktree** of the
run's base repository under a run-scoped temp directory; the worktree path
is journaled on the unit row and passed to the harness as its working
directory, so parallel fan-out units can never trample each other's working
tree. After the unit finishes, a clean worktree (`git status --porcelain`
empty) is removed automatically; a dirty one is retained and its path
logged, so uncollected work is never destroyed. Declaring worktree isolation
in a non-git directory fails the step cleanly before anything dispatches.

> **⚠️ Warning — outputs matched by `.gitignore` are treated as disposable.**
> A worktree-isolated unit's output survives only if it lands on a
> **collectible path**: a tracked file, or an untracked file your repository
> does **not** `.gitignore`. Anything a unit writes to a `.gitignore`d path —
> build outputs, caches, logs, dependency directories like
> `node_modules`/`dist`, or a scratch file under an ignored directory — is
> **discarded** when its clean worktree is auto-removed. If a unit produces an
> artifact that must survive, write it to a non-ignored path, or report it as a
> result (a structured `output` / free-text result), before the unit returns.

The clean probe deliberately does **not** pass `--ignored`, so "uncollected
work" means tracked or untracked-*unignored* changes only. A worktree whose
only residue is files your repository's own `.gitignore` matches is treated as
clean and removed: those files are disposable by the repo's own declaration,
and retaining a worktree after every package install or build would blow up
disk under the temp root.

## Model tiers

Reference semantic aliases in `model:` fields instead of exact model ids so a
workflow stays harness-agnostic. Recommended vocabulary (convention, not
hardcoded) via the config-root `modelAliases` key:

```jsonc
{
  "modelAliases": {
    "fast":     { "llm": "claude-haiku-4-5", "*": "claude-haiku-4-5" },
    "balanced": { "llm": "claude-sonnet-4-6", "*": "claude-sonnet-4-6" },
    "deep":     { "claude": "claude-fable-5", "opencode": "opencode/claude-fable-5", "*": "claude-fable-5" }
  }
}
```

For an LLM engine, resolution checks its engine-name column, then `llm`, then
`*`. Agent engines check their harness platform and then `*`.

The built-in aliases `fable`, `opus`, `sonnet`, and `haiku` resolve per
platform with no config. Point `deep` work (review, verification, judging) at
`fable` — Anthropic's tier above Opus — and keep high-volume fan-out units on
`fast`/`balanced`.

Trust note: a workflow that fans out is authorizing **N parallel agents**, not
one — the security section below applies with multiplied blast radius. The
engine enforces a concurrency cap, a lifetime unit cap per run, per-unit
timeouts, and (when the workflow declares them) run budget ceilings.

Native fan-out (`akm workflow run`) uses the minimum of four limits: the map's
declared `concurrency`, the run's frozen `workflow.maxConcurrency`, the
selected frozen LLM engine's `concurrency` (including an SDK engine's fallback
LLM), and the current host's CPU-derived safety limit. Reapplying host safety
keeps a run safe when it resumes on a smaller machine.

- **Unset (default):** the CPU-derived value `min(16, max(1, cores − 2))` — a
  conservative default that leaves headroom on the host and matches the
  original Claude-Code cap.
- **Set:** an explicit positive integer, clamped when frozen to `[1, 64]`
  (values above 64 are clamped down, never rejected, so one config shared
  across machines with different core counts never hard-fails).

```console
$ akm config set workflow.maxConcurrency 8   # raise the frozen workflow limit
$ akm config get workflow.maxConcurrency
8
```

This cap governs the **native** engine only. The brief/report driver surface
(`akm workflow brief` / `report`) does **not** consult it — an external driver
session owns its own parallelism; the engine caps only the units it dispatches
itself.

## Security: workflow sources are executed code

Workflow steps that include shell commands run with **the full environment
and PATH of the user invoking `akm workflow next`** — same as if the user had
typed those commands in their shell. There is no sandbox, no env-var
allowlist, and no separation between trusted and untrusted workflows.

This is by design: a workflow is a runbook authored by you or by a stash
maintainer you trust. The flexibility of "run any shell command, read any
file, hit any network" is what makes workflows useful as automation.

The consequence is that **you should treat workflow sources the same way you
treat package dependencies**:

- **Only add workflow sources you trust.** `akm bundle add github:<some-user>/stash`
  followed by `akm workflow next workflows/<their-thing>` is functionally
  equivalent to piping a stranger's bash script into your shell. Read the
  workflow file first (`akm show workflows/<name>`) before running it.
- **Audit before run** for any workflow that touches secrets, deploys to
  production, or writes outside the project tree. Workflow steps can read
  any environment variable visible to the akm process — including secrets
  exported by your shell or injected via `akm env run` / `akm secret run`.
- **Pin known-good versions** when adding workflow sources from a registry
  or git remote (`akm bundle add github:owner/stash#v1.2.3`), and update
  deliberately rather than via `akm bundle update --all`. A trusted workflow source
  can become hostile if its upstream is compromised.
- **Workflow steps cannot escape this trust model** by being labeled
  `dryRun` or `interactive` — those flags affect bookkeeping, not execution.
  An `akm workflow next` invocation always runs the next step's instructions
  in your shell.

If you operate a CI runner or shared host where untrusted workflows might be
executed, scope the process: a dedicated user account with no secrets in its
environment, ephemeral working directory, and a network/filesystem allowlist
enforced outside akm.

## See also

- [Search & Discovery](../guides/search-discovery.md) — find available workflows with `akm curate`
- [Knowledge Management](../guides/knowledge-management.md) — capture workflow outputs as memories
- [Improvement Loop](../guides/improvement-loop.md) — improve workflow assets over time
- [CLI Reference](../reference/cli.md) — full flag documentation for all `workflow` subcommands
- [Concepts](../guides/concepts.md) — workflow asset type and run-state storage
