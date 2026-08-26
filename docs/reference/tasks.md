# Tasks

Task assets are strict, local automation sources. They live at
`<bundle>/tasks/<id>.yml` and can be run directly or reconciled to cron,
launchd, or Windows Task Scheduler with `akm task sync`. The task file is
authored source; scheduler entries are derived OS state.

Two task source grammars are recognized side by side in this release:

- **task v3** (`version: 3`) — the long-standing grammar: an `akm:` options
  bag, an `on:` trigger block, and exactly one required scheduling source.
  Still fully supported; nothing about it is being removed in this release.
- **task source v4** (`version: 4`) — typed `inputs:`, a single bounded
  `output:` schema, and scheduling that is OPTIONAL rather than required. See
  [Task source v4](#task-source-v4) below.

`akm task add` writes only task-v3 sources in this release; author a task
source v4 document by hand (or edit an existing `.yml` in place) to use the
newer grammar.

## Files and schema

The only recognized task extension is `.yml`. A `.yaml` near miss is never
indexed, scheduled, or run. Every task must declare `version: 3` or
`version: 4`; unknown top-level keys and any other version fail closed. The
published [task schema](../../schemas/akm-task.json) describes the
hand-authored contract for both grammars as a two-arm `oneOf` keyed on
`version`, while `src/tasks/source-v3.ts` (task v3) and
`src/tasks/source/task-source-v4.ts` (task source v4) remain the
authoritative bounded parsers.

The rest of this page documents task v3 first ([Executable targets](#executable-targets-uses-or-run)
through [Scheduling and triggers](#scheduling-and-triggers)), then
[Task source v4](#task-source-v4), then the task-v2-to-v3 migration guide
(unrelated to task source v4) and day-to-day operations, which apply to both
grammars.

At the top level a task-v3 source can use `name`, exactly one executable
selector, common step fields, and exactly one trigger source:

```yaml
version: 3
name: Nightly review
uses: workflows/nightly-review
with:
  strict: true
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

This section describes task v3. Task source v4 selects targets the same way
(exactly one of `uses` or `run`) with two differences, covered in
[Task source v4](#task-source-v4): the GitHub-action `uses:` spelling is
removed outright, and `with:` is legal only alongside `uses: akm/command`.

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

The runtime applies this target-by-target field matrix. Validation is strict;
fields are not silently discarded.
For `scripts/` asset refs, `with` is rejected before dispatch.

| Target | `with` | task `env` | Interpreter / execution |
|---|---|---|---|
| `run` | Rejected; `with` is legal only with `uses` | Allowed | One authored string through the selected closed host `shell` |
| `akm/command` | Required action object: exactly one of `ref` or `content`, plus optional portable `arguments` | Allowed and passed through the command resolver | Shared command authorization and lowering |
| `commands/<name>` | Direct command refs: `with` is rejected; use `akm/command` for portable arguments | Allowed and passed through the command resolver | Shared command authorization and lowering |
| `workflows/<name>` | Of asset refs, workflow refs alone consume `with` as workflow params | A nonempty task `env` is rejected because the durable workflow runtime cannot consume it in 0.9.2 | Fresh durable workflow start |
| `scripts/<name>.<ext>` | Script refs: `with` is rejected | Allowed for the child process | Closed extension-to-interpreter table below |
| `owner/repo[/path]@ref` | Not consumed | Not consumed | Recognized spelling, but remote acquisition is rejected in 0.9.2 |

Script refs use this closed table; any other extension fails before dispatch:

| Extensions | Interpreter |
|---|---|
| `.sh` | `sh` |
| `.ts`, `.js` | Bun; JavaScript and TypeScript script targets require Bun (the standalone binary uses its embedded Bun runtime) |
| `.ps1` | `powershell -NoProfile -NonInteractive -File` |
| `.cmd`, `.bat` | `cmd /d /s /c` |
| `.py` | `python` |
| `.rb` | `ruby` |
| `.go` | `go run` |
| `.pl` | `perl` |
| `.php` | `php` |
| `.lua` | `lua` |
| `.r` | `rscript` |
| `.swift` | `swift` |
| `.kt`, `.kts` | Kotlin (`kotlin` for `.kt`, `kotlinc -script` for `.kts`) |

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

This section describes task v3, where scheduling is mandatory. Task source
v4's `schedule:` is OPTIONAL instead — see [Task source v4](#task-source-v4).

A task-v3 source has exactly one scheduling source: either `akm.schedule` or
top-level `on`. The two sources are mutually exclusive.

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

## Task source v4

Task source v4 (`version: 4`) is a second, additive grammar — task v3
documents keep parsing, running, and scheduling unchanged. Task source v4
adds typed `inputs:` and a single bounded `output:` schema, and makes
scheduling OPTIONAL instead of required. It removes the `akm:` options bag
and the `on:` trigger block entirely: every field they used to carry is a
top-level key instead.

```yaml
version: 4
name: Review code
description: Summarize a pull request's changed surface
inputs:
  scope:
    type: string
    enum: [changed, all]
    default: changed
  strict:
    type: boolean
    default: true
  ticket:
    type: string
    required: true
output:
  type: object
  properties:
    summary: { type: string }
uses: commands/review
schedule:
  - cron: "0 8 * * 1"
    enabled: true
    inputs: { scope: all }
timeout: 45000
engine: reviewer
redact: [TOKEN]
```

Field notes:

- `inputs:` declares named, typed parameters. Each declaration is a bounded
  JSON Schema (`type`, `enum`, `properties`, `items`, `minimum`/`maximum`,
  `allOf`/`anyOf`/`oneOf`/`not`, and similar keywords — an unlisted keyword is
  rejected) plus two keys unique to task source v4: `default` (which must
  itself satisfy the rest of the declaration) and `required: true` (mutually
  exclusive with `default`). Declaration names follow the same identifier
  grammar as workflow parameters.
- `output:` is a single bounded JSON Schema, replacing v3's
  `akm.outputSchema`.
- `schedule:` is OPTIONAL. Omit it entirely for a manual-only task: the
  source still parses, still runs with `akm task run`, and `akm task sync`
  silently contributes zero scheduler bindings for it (no OS entry, no
  failure) rather than rejecting the source for missing a trigger. A bare
  string (`schedule: "0 8 * * 1"`) is shorthand for one enabled binding with
  no inputs. A list entry may set its own `enabled` (default `true`) and
  literal `inputs`; those literals are validated against the task's
  `inputs:` declarations at parse time but are not yet delivered to the
  scheduled run — delivery is a later 0.9.x release.
- Every v3 `akm.*` option is a top-level key in task source v4 instead: `agent`,
  `engine`, `model`, `inference`, `tools`, `timeout`, `redact`, `maxSteps`,
  and `maxRetries`, plus `description`, `when_to_use`, and `tags`.
  `akm.enabled` becomes each schedule entry's own `enabled` rather than one
  document-level flag.
- `env`, `shell`, and `working-directory` keep v3's meaning and top-level
  position: `shell`/`working-directory` are legal only with `run:`.
- `with:` is legal only alongside `uses: akm/command` — it is that target's
  own action-argument bag (`ref`/`content`/`arguments`), unchanged from v3.
  Every other target (`commands/`, `scripts/`, `workflows/`, `run:`) uses
  `inputs:` for typed parameters instead of `with:`.
- The GitHub-action `uses:` spelling (`owner/repo@ref`) recognized (and
  rejected before dispatch) by v3 is removed outright in task source v4 —
  author a v3 source if you need that documented syntax.
- A task source v4 document cannot yet be the target of a workflow step's
  `uses: tasks/<ref>` — composing a task source v4 target from a workflow
  arrives in a later 0.9.x release; keep the task at `version: 3` until then.

### Input flags

`akm task run <id>` accepts one exact-name flag per declared `inputs:` entry,
mirroring `akm workflow run`'s parameter flags:

```sh
akm task run review --scope all --strict  # doclint:ignore
```

Flag names are task-specific — they come from that task's own `inputs:`
declarations — so they are not listed on `akm task run --help` and the
example above uses one task's actual declared names, not a fixed syntax.
An undeclared flag fails with `UNKNOWN_FLAG`; a value that does not satisfy
its declaration, or a missing `required: true` input supplied by neither a
flag nor a default, fails with `INPUT_BINDING_INVALID` — both exit `2` with
the usual `{ok:false,error,code}` envelope on stderr. In this release the
materialized values are **validated only**: nothing yet delivers them to the
target (no `with:` params, no environment variables, no prompt
substitution), so a *valid* flag set leaves the run byte-identical to the
same run without them. `akm task add` does not gain input flags in this
release; it continues to write task-v3 sources only.

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

- `akm search --type task` and `akm show tasks/<id>` inspect task assets of
  either grammar.
- `akm task add` writes a task-v3 source and installs it after validation;
  it does not author task source v4 in this release.
- `akm task history` reads durable run history from `state.db`.
- Disable a binding by editing the source and syncing: task v3 sets
  `akm.enabled: false`; task source v4 sets that schedule entry's own
  `enabled: false`.
- Delete the `.yml` source and sync to remove its derived binding(s).
- Use `akm task sync --rebind` only when deliberately changing the captured
  AKM runtime, then verify with `akm task doctor`.

Scheduler execution is at least once. Backends provide a stable invocation
identity and AKM fences stale attempts, but an ambiguous process crash can be
observed only after the external work has started. Make scheduled side effects
idempotent where possible.

## See also

- [CLI Reference: task](cli.md#task)
- [Scheduling guide](https://github.com/itlackey/akm/blob/main/docs/guides/scheduling.md)
- [Workflow source formats](workflow-schema.md)
- [Data and telemetry](data-and-telemetry.md)
