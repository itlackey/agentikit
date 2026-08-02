# Task / Workflow Unification: One Target Vocabulary, One Prose Rule

Status: PROPOSAL — grounded in the owner's model; target vocabulary corrected
in review round 3. Baselined on `claude/release-0-9-0-polish-d6sycl`
(post-"`run` is the canonical orchestrator").
Date: 2026-08-01
Related: [`workflow-format-unification.md`](./workflow-format-unification.md),
[`okf-support.md`](./okf-support.md),
[`docs/reference/workflows.md`](../../reference/workflows.md),
[`docs/migration/v0.7-to-v0.8.md`](../../migration/v0.7-to-v0.8.md)

---

## 1. Grounding — what tasks and workflows are in akm

Stated by the owner; everything below derives from these three points.

1. **A task is a bundle asset that abstracts over OS-scheduled work.** It is
   meant to be *discovered* (search/show, like any asset) and *enabled* —
   enabling creates an entry in the OS scheduler (cron / launchd / schtasks)
   that executes the work the task defines, or dispatches an agent with the
   task's prompt. The point is a platform-agnostic way to **share and store
   repeatable processes** that can be scheduled through one consistent CLI.

2. **A task and a workflow step have no technical relationship today, but
   conceptually a step is doing the same job** — execute a command, a script,
   or a prompt — just positioned inside a procedure instead of behind a
   schedule. Unifying the underlying execution code cuts duplication and gives
   workflows abilities steps currently lack: run a script as a step, execute a
   command asset as a step.

3. **Reduce the number of concepts and formats a user must learn.** The
   measure of success is lower cognitive load, not architectural novelty.

Not in scope (corrections from earlier drafts on this branch): tasks do not
grow `steps:`; workflows do not grow `schedule:`; there is no step
reference/reuse system. The unit of sharing stays the asset, the unit of
scheduling stays the task, the unit of procedure stays the workflow.

## 2. Baseline: what `run`-as-canonical-orchestrator already settled

This proposal is rebased onto `claude/release-0-9-0-polish-d6sycl`, whose
`feat(workflow): make run the canonical orchestrator` changes three things
that earlier drafts of this document got wrong:

- **`workflow start` / `next` / `complete` are removed.** `akm workflow run
  <ref|run-id>` owns creation, continuation, native dispatch, completion, and
  durable replay. A workflow is no longer "a procedure an agent advances one
  step at a time"; it is a plan the orchestrator executes and resumes.
- **`run` is Stable and ungated.** Only the harness-neutral `brief`/`report`
  driver protocol still requires `experimental.workflowEngine`. There is
  therefore **no execution-gate asymmetry left between tasks and workflows** —
  both execute ungated. Any design that leaned on the gate as a type boundary
  (as an earlier draft did) is obsolete.
- **Scheduled workflow tasks now execute.** `runWorkflowTask()` calls
  `runWorkflowSteps()` instead of `startWorkflowRun()`, so the old
  fire-and-forget defect — create a run, record exit 0, never drive it — is
  already fixed. That section is deleted from this proposal rather than
  proposed.

Two other pieces of that change are load-bearing here:

- **Params are declared flags, not an opaque bag.** `--version 1.2.3`,
  repeated flags for arrays, coerced through the frozen param schemas
  (`src/workflows/ir/params.ts`). Whatever "pass parameters through" means
  below must ride this mechanism, not invent a second one.
- **`src/workflows/exec/unit-dispatch.ts` is the one dispatch seam.**
  `UnitDispatchRequest` already carries a fully-assembled `prompt`, a frozen
  engine snapshot, `timeoutMs`, `env`, `cwd`, `sensitiveValues`, and a
  structured `failureReason` vocabulary on the way back. It is where a shared
  target-execution layer plugs in, and its existence makes §6 much smaller
  than it would have been a week ago.

## 3. The target vocabulary

akm already has asset types for each kind of executable work. The correction
in this round is that a target should **name one of those assets**, not
reinvent it:

| Asset type (existing) | What it is (`concepts.md`) |
|---|---|
| **command** | *A prompt template* — a template with placeholders to fill in |
| **script** | *Executable code or shell automation* — a `run` command plus optional `setup` / `cwd` |
| **workflow** | *A unified markdown multi-step procedure* |

So the vocabulary is four cases, three of which are "execute this asset":

| Declaration | Work performed | Params |
|---|---|---|
| *(no target key)* | Dispatch an agent with **the nearest prose** as the prompt | — |
| `command: commands/<name>` | Fill the command asset's template and dispatch an agent with the result | fill the template's placeholders |
| `script: scripts/<name>` **or** an inline script | Execute — no AI. An asset honors its `run`/`setup`/`cwd`; inline is a shell body, GitHub-Actions style | passed as environment (§9 Q2) |
| `workflow: workflows/<ref>` | Run a workflow through `runWorkflowSteps()` | the workflow's declared param flags |

Three consequences of the correction:

- **`prompt:` is deleted.** It existed to answer "where is the prompt text,"
  and the answer is now structural: the body. Its three overloaded meanings
  (inline text / asset ref / file path) and the `resolvePromptSource()` sniff
  that disambiguated them all go with it. Inline text → the body. An asset ref
  → `command:` (that *is* what a command asset is). A file path → §9 Q3.
- **`command:` changes meaning.** Today it is raw shell argv. It becomes a
  command-asset ref. Raw shell moves to `script:`. This is the single biggest
  hazard in the change and gets its own section (§7).
- **`script:` is new execution capability.** akm stores, clones, and shows
  `scripts/<name>` assets but has no path that runs one. Both tasks and steps
  gain it.

### 3.1 One prose rule

> **The machine surface names the target; the nearest prose is the
> instructions. With no target key, the work *is* the prose, dispatched to an
> agent.**

- In a **task**, the nearest prose is the document body.
- In a **workflow step**, the nearest prose is its `## <step-id>` section
  (unchanged from today).

That sentence is the whole shared learning curve, which is point 3's actual
deliverable. It also removes the `prompt: inline` sentinel problem for good:
whether the body is the prompt is decided structurally, by the absence of a
target key, not by a magic value.

### 3.2 Template filling is the command asset's own contract

`workflow-format-unification.md` §2.3 deliberately removed interpolation from
prose and scoped any future substitution to the unit kind that needs it. A
command asset is *defined* as "a prompt template with placeholders to fill in"
— filling it is that type's contract, predating this proposal, and it happens
**before** dispatch, to produce the `prompt` string that
`UnitDispatchRequest` already expects. It is not a reintroduction of prose
templating: bodies stay verbatim, and no other target interpolates.

## 4. The task format — markdown on the unified parser

A task becomes an ordinary akm markdown asset at `<bundle>/tasks/<id>.md`:
the shared envelope (`description`, `tags`, `when_to_use`, `xrefs`, plus the
OKF v0.2 `generated`/`verified`/`provenance`/`status`/`stale_after` families
via `$ref akm-asset-envelope.json`), the scheduling keys (`schedule`,
`enabled`), at most one target, and the dispatch-options bag (`engine`,
`model`, `timeout`, `llm`) in the workflow side's existing spelling.

An agent task — the 0.7.x shape restored, minus the sentinel:

````markdown
---
type: task
description: Weekly review digest.
schedule: "0 8 * * 1"
engine: reviewer
timeout: 10m
---

Review the week's completed tasks and summarize action items.
Group the summary by bundle. Call out anything that failed more than twice.
````

A script task — what today's `command: akm improve …` tasks become. The body
is optional runbook prose: indexed, shown by `akm show`, never executed.

````markdown
---
type: task
description: Full nightly quality sweep.
schedule: "15 2 * * *"
script: akm improve --strategy thorough --skip-if-locked
---

# Nightly improve sweep

If this starts failing, check `akm task history --id akm-improve-nightly`,
then `akm health`. A `blocked` status usually means a stale improve lock.
````

A command-asset task, with params filling the template's placeholders:

````markdown
---
type: task
schedule: "@daily"
command: commands/weekly-review
params: { scope: team }
---
````

A workflow task, unchanged in meaning:

````markdown
---
type: task
schedule: "0 9 * * 1"
workflow: workflows/ship-release
params: { version: nightly }
---
````

The lifecycle is untouched — discovery via `akm search --type task` /
`akm show tasks/<id>`; enablement via `enabled:` + `akm task sync`; the OS
entry still invokes `akm task run <id>`; setup still reviews templates before
touching the scheduler. What the asset gains by being markdown: a home for the
prompt and for the runbook, OKF provenance stamping with no special-casing,
`xrefs` to the lesson or incident behind the task, and `status: draft` as a
natural author-now-arm-later state (draft tasks are never installed by `sync`).

## 5. Workflow steps gain the same targets

A step entry may name a target instead of relying on its prose:

````yaml
steps:
  - id: run-tests
    script: bun test
  - id: lint
    script: scripts/lint-all
  - id: review
    command: commands/code-review
  - id: summarize                 # no target → agent + its ## summarize section
    inputs: [steps.review.output]
````

- Target keys are legal wherever `unit:` dispatch overrides are legal today
  (unit steps and `map.unit`); route steps are unchanged.
- A step with a target key needs no body section; its section, if present, is
  documentation. A step without one still requires its section — that is the
  prose rule, unchanged.
- A `script:` step is a non-AI unit. It still journals as a unit
  (`workflow_run_units`), so tokens are absent but status, timing, attempts,
  and `failure_reason` behave like any other unit.

This is point 2's payoff: *"running a script as a step, or executing a command
asset in the bundle as a step."*

## 6. Shared plumbing — the point-2 code reduction

| Layer | Today | After |
|---|---|---|
| Target + dispatch-options schema | `akm-task.json` standalone (87 lines, loaded by nothing at runtime); separate `unit` defs in `akm-workflow.json` | one shared definitions file `$ref`'d by both published schemas; one spelling (`timeout: 10m`, `llm.max_tokens`) |
| Parsing | `parseTaskDocument()` + `TASK_KEYS` + `rejectTargetFields()` + `resolvePromptSource()` (368 lines) | the unified frontmatter+body parser; at-most-one-target as a semantic pass |
| Envelope | hand-listed keys, no OKF | `$ref akm-asset-envelope.json`; future stamped keys inherited free |
| Target resolution | prompt/ref/path sniffing in `src/tasks/` | one resolver: ref → asset, inline → literal, producing the assembled prompt or argv |
| Command-template filling | n/a | one implementation, used by both surfaces |
| Script execution | n/a (`runCommandTask` runs raw argv only) | one executor honoring `run`/`setup`/`cwd`, used by both |
| Lint | `invalid-task-yaml` in the task adapter | shared envelope + schema + prose-rule passes; task-only passes (cron parse, at-most-one-target) on top |
| Adapter | `.yml`-only recognize/place | markdown task recognized by `type: task` / `tasks/` residence; `place()` → `.md` |

Honest boundary, unchanged by the rebase: agent dispatch stays two paths — the
task runner's `executeRunner()` and the engine's journaled unit dispatch —
because run recording, leases, and replay genuinely differ between "cron fired
one job" and "the orchestrator is executing a plan." What unifies is
everything *upstream* of the seam: resolving a target to an assembled prompt or
argv, plus the options bag. `UnitDispatchRequest` (§2) is already shaped to
receive exactly that.

## 7. The `command:` key collision — the one real hazard

Today `command:` means **raw shell argv**; all ten shipped task templates use
it that way (`command: akm improve --strategy thorough --skip-if-locked`).
Under the corrected vocabulary it means **a command-asset ref**. Same key, new
meaning — reinterpreted silently, every shipped task either fails as
"command asset not found" or, worse, resolves to an unrelated asset.

The format boundary contains it, which is why this is manageable:

- **`.yml` tasks keep the old meaning, permanently.** The legacy format is
  frozen and retires as a whole (§8); its `command:` is shell argv until then.
- **`.md` tasks use the new meaning from day one.** There is no `.md` task on
  disk anywhere, so nothing is reinterpreted.
- **The migrator rewrites, never reinterprets:** `.yml` `command: <shell>` →
  `.md` `script: <shell>`. Mechanical and reviewable.
- **Hand-authoring guard.** A `.md` task whose `command:` value is not a
  resolvable `commands/<name>` ref is a parse error naming `script:` —
  shell-shaped values (a leading `akm`/`bun`/`sh`, flags, pipes) get the
  targeted hint. This is the case the format boundary cannot catch, and it is
  worth the dedicated error message.

§9 Q1 asks whether the collision is worth avoiding entirely by naming the new
target something else.

## 8. Migration — never silently invisible

The 0.7→0.8 cutover's real failure: leftover `.md` tasks became *silently
invisible* to listing and the scheduler, so jobs stopped running with no
diagnostic. The restoration must not mirror that for `.yml`.

- **Phase 1 (additive).** Shared target schema, resolver, and script executor
  land; `.md` and `.yml` tasks are both discovered and both run, each with its
  own `command:` semantics (§7); `.md` wins an id collision and
  `sync`/`doctor` report it. Steps gain `script:`/`command:`. Embedded
  templates convert to `.md` and become the reference examples. No user action
  required.
- **Phase 2 (loud).** `sync`, `doctor`, and `lint` name every remaining `.yml`
  task by path with its one-line fix. `akm migrate` converts mechanically:
  `command:` → `script:`; `prompt: |` scalar → body; `prompt: commands/x` →
  `command: commands/x`; `prompt: agents/x` → §9 Q3; key renames
  (`timeoutMs` → `timeout`, `llm.maxTokens` → `llm.max_tokens`). Scheduler
  entries are untouched — ids and the `akm task run <id>` ABI do not change,
  so nothing is reinstalled.
- **Phase 3 (major).** `.yml` discovery retires.

## 9. Open questions

1. **Is the `command:` collision (§7) worth avoiding?** Reusing the key is
   the most learnable outcome — one key per asset type, no legacy scar — and
   the format boundary plus the parse-error guard contains it. The
   alternative is a distinct key for the new meaning, which is safer and
   uglier. Recommend reusing `command:` with the guard.
2. **How do params reach a `script:` target?** Recommend **environment
   variables**, not argv splicing — it keeps §2.3's anti-injection stance
   intact and matches how a script asset's `run`/`setup` already expect
   configuration. Argv substitution can be added later if a real case appears.
3. **What replaces `prompt: agents/<name>` and `prompt: ./file.md`?** An
   agent ref is not a command asset, and a relative file path is neither.
   Options: a narrow `agent:` target; treat both as command-asset-shaped and
   widen `command:`'s accepted refs; or drop them at the `.yml` retirement.
   Needs a decision before the migrator is written.
4. **Does an inline `script:` get a shell, or argv?** GHA-style inline implies
   a shell (`sh -c`), which brings quoting and injection surface; today's
   `command:` splits on whitespace into argv with no shell. Recommend: a
   single-line string stays argv-split (today's behavior, no new surface); a
   multi-line block scalar runs under a shell, matching author expectation.
5. **`version:` in the markdown task format.** The workflow format dropped it
   (identity is the ref; the schema evolves additively). Recommend the same;
   `.yml` keeps `version: 2` until it retires.

## 10. Non-goals

- No `steps:` in tasks; no `schedule:` on workflows; no step reference/reuse
  system; no changes to `map`/`route`/`gate`/IR/freeze/journal/leases/replay.
- No change to the scheduler backends, `sync` reconciliation, runtime binding,
  task ids, or the `akm task run <id>` ABI.
- No change to how `command`, `script`, `env`, or `secret` assets are
  *authored or stored* — this proposal executes them, it does not reformat
  them.
- No observability redesign. Sharing one failure vocabulary across the two
  execution paths is a natural follow-up, not part of this change.
