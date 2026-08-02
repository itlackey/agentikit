# Workflows

A workflow is a structured markdown document that defines a multi-step
procedure. `akm workflow run` compiles it to a frozen plan, persists run and
unit state, dispatches its work, verifies declared gates, and can resume after
an interruption without replaying completed units.

> **`akm workflow run` is Stable, ungated, and the only execution surface.**
> It is the canonical start/resume/execute command; there is no separate
> external-driver protocol.

> **Every workflow run needs a selected engine.** Freezing resolves an engine
> for each unit, so a config with no `defaults.engine` fails with
> `INVALID_CONFIG_FILE` and exit 78. A workflow with a non-empty `### gate`
> additionally requires `workflow.judgeEngine` to name a configured LLM or
> agent engine. `akm setup` normally selects a default execution engine; on a
> bare container or CI image, set one explicitly:
>
> ```sh
> akm config set engines.claude '{"kind":"agent","platform":"claude"}'
> akm config set defaults.engine claude
> ```

## akm workflow run

`akm workflow run <run-id|workflows/ref>` starts or continues a persisted run
and executes it until completion, failure, verification rejection,
interruption, or an explicit invocation limit. Run state is scoped to the
current project directory (nearest `.akm/config.json`, git root, bundle root,
or current directory), so the same workflow can run independently in separate
projects.

```sh
akm workflow run workflows/ship-release --version 1.2.3
akm workflow run workflows/review --changed_files a.ts --changed_files b.ts
akm workflow run <run-id> --max-retries 2 --timeout 10m
```

Parameter flags must come after the target and exactly match declared `params`
keys. Values are coerced through each parameter's JSON Schema: repeat an array
flag, pass an object or whole array as JSON, and use a bare boolean flag for
`true`. There are no hyphen/underscore aliases. The old `--params` JSON bag is
removed, and parameters are accepted only while creating a new run.

`--max-steps <n>` leaves a partial run active after at most `n` steps.
`--max-retries <n>` retries a failed step on the same run up to `n` additional
times (0 through 100). `--timeout <duration>` bounds the whole invocation and
accepts `N`, `Nms`, `Ns`, or `Nm`; bare `N` is milliseconds. A timeout or
signal abort releases the run lease without advancing the active step, so the
run remains resumable. Failed, gate-rejected, timed-out, and interrupted runs
exit nonzero.

The run freezes its plan, exact models, execution limits, parameter snapshot,
and verifier selection at creation. Edits to source or config do not alter an
in-flight run.

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
— never the raw error text — so step evidence stays reproducible across
resumes. When you need the human-facing *why*
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
   section byte-exact. An omitted or empty `### gate` section needs no
   verification. A non-empty rubric enables mandatory fail-closed verification;
   frontmatter `gate:` only tunes its retry bound.

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
- `gate` — optional validation-loop configuration: `max_loops` bounds
  evaluator-optimizer retries (see *Gates judge the artifact*). The rubric
  itself lives in the body's `### gate` section. Without non-empty rubric
  text, the configuration is inert.

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
      unit:
        engine: reviewer
        model: deep
        timeout: 5m
        retry: { max: 1, on: [timeout, llm_rate_limit] }
        on_error: continue
        isolation: worktree
        output: { type: object, properties: { file: { type: string }, verdict: { type: string } }, required: [file, verdict] }
    # `output` here describes the REDUCER RESULT, not one unit's result: the
    # default `collect` reducer folds per-item unit results into an array.
    output: { type: array }
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

Address the review findings. Confirming the fix is a fresh `akm workflow run`
of this workflow, not a step this run routes back to.

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
  step's own `output` schema describes a reduced, single-value shape instead.

**An empty successful free-text output is treated as no output.** When a
schemaless unit (one that declares no `output` schema) succeeds but returns
the empty string, akm normalizes it to *absent*: nothing is journaled for its
result, and its contribution to the step artifact is `null` — a `null` slot
in a collected array, or `output = null` for a solo step. This absence is
deliberate, so a live run and a resumed run promote the
identical artifact. The practical consequence: a downstream step that
declares an empty upstream result in its `inputs:` gets nothing meaningful
attached for it — akm surfaces this loudly rather than silently attaching an
empty string. A unit that declares an `output` schema is unaffected — an
empty response is not valid JSON, so it fails as a parse error and can never
satisfy a schema as a silent `null`.

## Frozen plans

The first `akm workflow run <ref>` compiles the workflow and freezes the
resulting plan on the run row (`plan_json` + `plan_hash`). **A run executes the
plan compiled at creation; edits to the source file need a new run** — the file
is never re-read for an in-flight run, so `run` and `resume` retain the same
workflow no matter what changed on disk. Orchestration decisions are pure
functions of the frozen plan, run params, and journaled unit results.

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
reaches them. **Routes are forward-only**: every target (each `when.step`
and `default`) must be a step declared *later* in the workflow than the
routing step, and a step never routes to itself — this keeps the plan a DAG,
so termination is structural rather than a runtime budget's job. A
`default:` that names an earlier step is a lint error, not a loop. An
unroutable value with no `default` fails the step rather than letting every
branch run.

**"Go back and fix it" is a gate, not a backward route.** A failed gate
re-runs its *own* step with the judge's feedback, bounded by `gate.max_loops`
— and a declared `output:` schema the promoted artifact fails is specifically
the error a gate loop retries through. A workflow that used to describe "loop
back to an earlier step until this passes" expresses that as a bounded gate
on the step doing the work, not as routing.

Route decisions are journaled, so a resumed run replays the same choice.
Skips cascade: when a route step is itself skipped (it was the unselected
target of an earlier route), its own branch targets are skipped too — a
router that never decided selects nothing.

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
(`<step-id>.gate:l<loop>`).

`gate.max_loops: <n>` (frontmatter) turns the gate into a bounded
evaluator-optimizer loop: on a rejection (or a typed-artifact schema
mismatch) with loop budget left, the engine re-executes the step's units
with the gate feedback and the missing-criteria list appended as attached
context. The feedback changes each unit's inputs, so the re-run naturally
dispatches fresh units instead of replaying journaled results. When the loop
budget is spent, the rejection stands exactly as in the one-shot case.

## Fail-closed verification

With no non-empty `### gate` rubric, no verification runs. When a rubric is
present, the workflow requires `workflow.judgeEngine` to name a configured LLM
or agent engine before the plan can be frozen. That verifier invocation is
frozen into the run.

Only a well-formed `complete: true` verdict advances a criteria-bearing step.
A missing verifier, dispatch failure, or malformed result rejects the gate
instead of silently bypassing it. A well-formed `complete: false` verdict
returns its missing criteria and feedback and can trigger another bounded
`max_loops` attempt.

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
engine owns the step spine. `workflow status` remains read-only; run detail
surfaces a live lease as `engineLease` (holder + expiry).

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

## Security: workflow sources are executed code

Workflow steps that include shell commands run with **the full environment
and PATH of the user invoking `akm workflow run`** — same as if the user had
typed those commands in their shell. There is no sandbox, no env-var
allowlist, and no separation between trusted and untrusted workflows.

This is by design: a workflow is a runbook authored by you or by a stash
maintainer you trust. The flexibility of "run any shell command, read any
file, hit any network" is what makes workflows useful as automation.

The consequence is that **you should treat workflow sources the same way you
treat package dependencies**:

- **Only add workflow sources you trust.** `akm bundle add github:<some-user>/stash`
  followed by `akm workflow run workflows/<their-thing>` is functionally
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
  `akm workflow status` is read-only; `akm workflow run` executes configured
  units with your process's access.

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
