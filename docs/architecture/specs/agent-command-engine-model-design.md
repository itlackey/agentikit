# Agent, Command, Engine, and Model Resolution

**Status:** Approved target design

**Decision date:** 2026-08-18

**Implementation baseline:** AKM 0.9.1 implements parts of this design; see
[Implementation status](#implementation-status).

This specification defines how agent personas, command templates, execution
engines, model mappings, tasks, and workflows interact. It is authoritative
for those semantics. It does not define the final task or workflow source
syntax.

## 1. Goals

The design has four goals:

1. Native Claude Code, OpenCode, and similar agent assets remain useful in
   place, without migration or synchronization.
2. AKM gives the same agent, command, engine, and model settings the same
   precedence regardless of whether execution starts at the CLI, a scheduled
   task, or a workflow.
3. Portable behavior stays deliberately small. Native-only behavior is not
   guessed or partially emulated.
4. Runtime policy remains separate from asset configuration. An asset can
   select requested tools or a model, but it cannot override operator
   authorization or budget policy.

## 2. The concepts

### 2.1 Agent: who performs the work

An agent asset is a **persona**, not executable work. It may contribute:

- a persona/system prompt;
- a requested tool policy;
- a model preference;
- an optional default engine; and
- other ordinary execution defaults recognized by its format and adapter.

An agent is selected with an `agent` selector. An agent ref MUST NOT be used
as an executable `uses` target. A direct invocation such as:

```sh
akm agent agents/reviewer --prompt "Review this change"
```

is shorthand for selecting `agents/reviewer` as the persona and using the
provided prompt as the work.

Agent files extend the native agent-file concepts of their source formats.
They do not select a special AKM-only runtime merely because AKM indexed them.

### 2.2 Command: reusable agent work

A command asset is a reusable **agent prompt template**, compatible with the
custom/slash-command concept in native agent tools. It is not an operating
system command.

A command may contribute defaults such as an agent selector, engine, model,
tools, and timeout. Those values participate in the normal cascade and can be
overridden by a nearer caller.

AKM owns command resolution. It loads the command through its bundle adapter,
applies the portable argument contract, resolves the agent/engine/model
cascade, and dispatches the resulting work. AKM MUST NOT send an unresolved
slash-command invocation to a native harness and rely on that harness to
reinterpret it.

`akm command run` is the target canonical CLI. `akm agent --command` may remain
as a compatibility alias, but both MUST call the same resolver and produce the
same behavior.

### 2.3 Engine: how the work runs

An engine is a named execution backend. It may be an agent harness or a direct
LLM connection. Agent and command assets may provide an optional default
engine, but neither is required to do so.

The same agent and command assets may run through agent or LLM engines. AKM
does not maintain a central, exhaustive capability registry and does not
reject an engine merely because its kind is assumed not to support a field.
See [Optimistic lowering](#7-optimistic-lowering).

### 2.4 Model mapping: portable intent to provider configuration

`model` accepts either:

- a known alias; or
- an exact provider-native identifier.

Alias identity is registry-based, not heuristic. If a value matches a known
alias, the selected engine's mapping MUST resolve it. A known alias without a
mapping is an actionable lint/resolution error. A value that is not a known
alias is an exact identifier and passes through unchanged.

### 2.5 Task: when work runs

A task is a scheduling wrapper around existing work. It adds scheduling and
invocation overrides but does not define another agent, command, or model
resolution system.

A task may describe or reference:

- a command;
- a workflow;
- a script or explicit shell operation; or
- inline prompt text with an optional agent selector.

### 2.6 Workflow: durable composition

A workflow composes work into a frozen, journaled run. A workflow step may
reuse a task's work definition; scheduling-only task fields such as `schedule`
and `enabled` do not join the step. Step values are nearer and therefore
override the referenced task.

Nested workflows are outside the initial design. A separately journaled child
workflow may be added after v1 if real usage demonstrates the need.

### 2.7 Script or shell work: deterministic process execution

Scripts and explicit shell/process declarations are the deterministic
execution surface. They MUST remain distinct from command assets. Calling a
prompt template a command does not authorize it to run as an OS command.

## 3. Native bundles and runtime translation

Native tool directories such as `.claude` and `.opencode` are registered as
ordinary AKM bundles. The owning `BundleAdapter` reads their native files and
translates recognized assets into AKM's runtime representation.

The following rules are explicit:

- The native file is authoritative.
- AKM does not create a canonical copy.
- AKM does not synchronize native directories with one another.
- AKM does not write native agent or command assets.
- Runtime translation is not a migration or a projection stored on disk.
- Identically named assets in different bundles remain distinct and can be
  addressed with bundle-qualified refs.

Fields shared with a native format remain in that format's normal location.
Optional AKM-only extensions SHOULD be namespaced under `akm` to reduce the
chance of colliding with future native fields:

```yaml
---
description: Review a change
model: balanced
akm:
  engine: reviewer
  timeout: 20m
---
```

This namespace does not imply that AKM writes the file. It only gives a native
bundle author a collision-resistant place to opt into AKM-specific runtime
defaults.

## 4. One configuration cascade

Ordinary execution values use one far-to-near cascade:

```text
installation defaults
-> selected engine
-> selected agent
-> selected command
-> task/workflow defaults
-> current task, step, or CLI invocation
```

The nearest explicit value wins. This rule includes engine, model, tools,
timeout, and other ordinary execution settings. Examples:

- a command's model overrides its selected agent's model preference;
- a task or workflow step overrides the command;
- a direct CLI model flag overrides every asset default; and
- omitting a field preserves the value from the next-farthest layer.

Selection and authorization are separate. In particular:

```text
selected tools = nearest explicit tools value
effective tools = selected tools authorized by machine/user runtime policy
```

Agent and command tool declarations do not intersect with each other. The
nearer declaration replaces the farther declaration like any other setting.
If the selected tools exceed operator authorization, AKM MUST fail explicitly;
it MUST NOT silently grant or silently reduce them.

Installed third-party bundle metadata participates in the same cascade as
locally authored metadata. Provenance does not create a second precedence
system. Authorization and budget policy remain the enforcement boundaries.

## 5. Engine selection and fallback

The ordinary cascade selects the engine. In practical nearest-first terms:

```text
CLI/step/task override
-> command default
-> agent default
-> configured installation default
-> documented fallback
```

When no layer selects an engine, AKM uses the fixed `opencode-sdk` fallback if
it is available. The fallback MUST be announced, never silent. A configured
`defaults.engine` is the normal way to select an installation default and
preempts the fallback. If the fallback is unavailable, AKM fails with setup
guidance.

The fallback is deliberately not separately configurable: such a setting
would duplicate `defaults.engine`.

## 6. Model maps and structured aliases

AKM ships a small starter map of provider-neutral intent aliases. The initial
vocabulary SHOULD stay small; `fast`, `balanced`, and `reasoning` are the
approved starting shape. These are conveniences, not permanent universal
model classifications.

The authoritative mechanism is data-driven and operator-owned. Mapping
precedence is:

```text
AKM starter defaults
-> explicitly adopted mapping pack
-> user or organization configuration
-> engine-specific overrides
```

Bundles may select aliases. They MUST NOT redefine what an alias means on the
host. A bundle may distribute a suggested map, but it becomes active only when
the operator explicitly adopts it.

An alias mapping may be either:

1. a simple exact model identifier; or
2. a structured inference profile containing a model and related defaults.

A structured alias expands as defaults at the same cascade layer that selected
it. Explicit sibling fields and nearer layers win:

```text
farther layers
-> selected alias profile
-> explicit fields beside the alias
-> nearer layers
```

For example, if `reasoning` supplies `effort: high`, then an explicit
`effort: medium` beside `model: reasoning` wins.

## 7. Optimistic lowering

AKM does not maintain a static matrix of every feature every model, endpoint,
and harness supports. Such a matrix would become stale and reject engines that
gain features independently.

Instead:

1. Resolve the common cascade.
2. Let the selected engine adapter translate the fields it understands.
3. Emit structured notices for fields the adapter does not translate.
4. Dispatch optimistically.
5. Treat an actual provider or harness rejection as a runtime failure.

An untranslated setting is not a pre-dispatch capability failure. An operator
authorization violation is still a hard failure because it is policy, not a
capability guess.

When an engine has no native system-prompt channel, AKM MUST preserve the
persona by deterministically composing a clearly delimited persona block into
the user prompt. It SHOULD emit a lowering notice when it uses this fallback.

## 8. Native agent selectors

A qualified `agents/...` ref is portable and resolves through AKM. A bare
agent name in a native command is a native harness selector.

For the initial implementation:

- a bare selector works with its matching native harness;
- an operator-defined selector mapping may translate it;
- the selected engine adapter may translate or consume it; and
- AKM fails with an actionable portability error if no deterministic
  translation exists.

The core MUST NOT use fuzzy name or content matching to guess an equivalent
persona.

## 9. Command arguments

The initial portable command-template contract is deliberately limited to a
single, one-pass `$ARGUMENTS` substitution. The invocation supplies the exact
argument string.

AKM MUST NOT initially claim portable support for positional `$N` placeholders
or named placeholders. Native tools disagree about positional indexing and
tokenization, and AKM has not established a portable named-argument source
syntax.

Native-only template constructs may remain in native source files and continue
to work when users invoke those files through their native tool. When AKM owns
execution, an unsupported native construct MUST produce an actionable
portability error before dispatch. AKM MUST NOT partially expand a command and
send the remainder to the model.

Template substitution is intentionally non-programmable: no expressions,
loops, conditionals, or recursive expansion.

## 10. Resolution time and sessions

Direct command invocations and scheduled tasks resolve the current assets and
configuration when they execute.

Workflows use the same semantic resolver, then freeze its output when a run is
created. The frozen plan must include every dispatch-significant resolved
input needed for deterministic resume and replay, including the selected
agent/persona, command content after argument substitution, exact engine/model
settings, and relevant source identities or hashes.

AKM command execution starts a fresh, one-shot session by default. Reusing or
resuming a native session requires an explicit invocation option.

## 11. Implementation status

This document describes the approved design, not a claim that 0.9.1 already
implements it. Important 0.9.1 gaps include:

- there is no canonical `akm command run` surface;
- `akm agent --command` reads raw file bytes instead of adapter-rendered command
  content and does not apply command metadata;
- command filling implements a different placeholder grammar from the one
  displayed by `show`;
- prompt tasks may send raw agent files, including frontmatter, as user text
  instead of selecting a persona;
- engine/model resolution is duplicated across direct dispatch, tasks, and
  workflow freezing;
- configured agent-engine models do not consistently reach every CLI spawn
  path;
- built-in model aliases are vendor-oriented and do not yet implement the
  approved operator-owned starter-map design;
- tool provenance and engine-kind gates do not yet follow the selection versus
  authorization and optimistic-lowering rules above; and
- workflow plans do not yet freeze command targets and persona snapshots under
  this unified resolver.

Implementation work MUST preserve current public behavior deliberately or
document a migration. It MUST NOT describe one of these gaps as approved
semantics merely because it exists in 0.9.1.

## 12. Deferred decisions

The following are deliberately not specified here:

- final task and workflow on-disk syntax;
- portable positional or named command arguments;
- nested or child workflows;
- the complete contents and distribution format of model mapping packs; and
- the CLI syntax for explicit session reuse.

These require separate decisions or implementation evidence. They are not
license to add synchronization, native-asset write-back, a central capability
registry, or a second command-execution mode.
