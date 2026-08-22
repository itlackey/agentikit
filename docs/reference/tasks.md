# Tasks

Task assets are strict, local automation sources. They live at
`<bundle>/tasks/<id>.yml`, use task schema `version: 3`, and can be run directly
or reconciled to cron, launchd, or Windows Task Scheduler with `akm task sync`.
The task file is authored source; scheduler entries are derived OS state.

## Files and schema

The only recognized task extension is `.yml`. A `.yaml` near miss is never
indexed, scheduled, or run. Every task must declare `version: 3`; unknown keys
and older versions fail closed. The published [task schema](../../schemas/akm-task.json)
describes the hand-authored contract, while `src/tasks/source-v3.ts` remains the
authoritative bounded parser.

At the top level a task can use `name`, exactly one executable selector, common
step fields, and exactly one trigger source:

```yaml
version: 3
name: Nightly review
uses: commands/review
with:
  strict: true
env:
  REPORT_FORMAT: summary
akm:
  schedule: "0 4 * * *"
  enabled: true
  timeout: 30m
```

Task YAML is bounded before expansion: source size, YAML depth, aggregate node
count, mapping width, string size, and collection sizes all have finite limits.
Aliases, merge keys, custom tags, duplicate keys, accessors, and non-plain data
are rejected rather than normalized.

## Executable targets: `uses` or `run`

A task selects exactly one of `uses` or `run`; the two fields are mutually
exclusive.

`uses` accepts these 0.9.2 target shapes:

- `akm/command`, the built-in inline/referenced command action. Its `with`
  object requires exactly one of `with.ref` or `with.content`; they are
  mutually exclusive. `with.arguments` is one optional portable string, used
  for the single, one-pass `$ARGUMENTS` substitution.
- Asset refs rooted at `commands/`, `workflows/`, or `scripts/`, optionally
  qualified with a bundle such as `team//commands/review`.
- A revision-qualified GitHub action spelling such as `owner/repo@ref` or
  `owner/repo/path@revision`. That syntax is recognized so it cannot be
  mistaken for an AKM ref, but remote action acquisition and execution are
  unsupported in 0.9.2 and fail before dispatch.

Agent refs such as `agents/reviewer` are personas and are not executable.
Task refs such as `tasks/nightly` are also not executable. Local actions
(`./action`) are rejected and Docker actions (`docker://image`) are unsupported.
GitHub expressions are unsupported and rejected before dispatch. Unqualified
remote actions are rejected too.

`run` is one non-empty shell string. It may specify `shell` from the closed host
shell table `bash`, `sh`, `zsh`, `pwsh`, `powershell`, or `cmd`. Shell expansion
is runtime behavior for an explicitly authored task `run`; AKM does not infer a
shell from `uses`. `working-directory` must be a relative, contained path under
the task's workspace root. Absolute paths, traversal, dangling links, and
symlink escapes fail before execution.

Common resolver fields live under `akm`: `agent`, `engine`, `model`,
`inference`, `outputSchema`, `tools`, `timeout`, `redact`, `maxSteps`, and
`maxRetries`. Environment entries are literal string, number, or boolean
values. Keep credentials out of task source; `redact` contains environment
variable names, never secret values.

## Scheduling and triggers

A task has exactly one scheduling source: either `akm.schedule` or top-level
`on`. The two sources are mutually exclusive.

The compact AKM spelling is:

```yaml
version: 3
run: akm improve --strategy default
akm:
  schedule: "@daily"
  enabled: false
```

The GitHub-shaped local trigger subset accepts schedule entries and an empty
manual trigger:

```yaml
version: 3
uses: commands/review
on:
  schedule:
    - cron: "0 6 * * *"
  workflow_dispatch: {}
```

`workflow_dispatch` accepts no inputs. Service events such as `push` are
rejected and create no watcher or polling daemon. A source with only
`workflow_dispatch` is manual-only and is not installed as a time schedule.
Multiple schedule entries create deterministic scheduler bindings for the one
source task.

`akm task run <id>` executes a task immediately, including a disabled task.
`akm task sync` validates the complete desired set before atomically
reconciling scheduler state. Scheduled invocations re-read the guarded current
task bytes; workflow targets then create a fresh durable workflow freeze.

## Migrating task v2 to v3

Normal execution rejects task v2 and prints the migration hint. Preview the
same fail-closed migration plan that apply consumes:

```sh
akm migrate apply --dry-run
akm migrate apply
```

The planner reports every input file as `changed`, `skipped`, or `blocked`.
Deterministic prompt, command-ref, workflow-ref, and safe command-string cases
become v3. An argv array or any command whose shell meaning cannot be preserved
is blocked for manual review and remains untouched. Apply validates a complete
v3 replacement before writing and backs up each original immediately before
replacement.

See the [0.9.1 to 0.9.2 migration guide](../migration/v0.9.1-to-v0.9.2.md)
for before/after examples, preserved fields, and recovery guidance.

## Operations

- `akm search --type task` and `akm show tasks/<id>` inspect task assets.
- `akm task add` writes a task-v3 source and installs it after validation.
- `akm task history` reads durable run history from `state.db`.
- Set `akm.enabled: false` and sync to disable a binding.
- Delete the `.yml` source and sync to remove its derived binding.
- Use `akm task sync --rebind` only when deliberately changing the captured
  AKM runtime, then verify with `akm task doctor`.

Scheduler execution is at least once. Backends provide a stable invocation
identity and AKM fences stale attempts, but an ambiguous process crash can be
observed only after the external work has started. Make scheduled side effects
idempotent where possible.

## See also

- [CLI Reference: task](cli.md#task)
- [Scheduling guide](../guides/scheduling.md)
- [Workflow source formats](workflow-schema.md)
- [Data and telemetry](data-and-telemetry.md)
