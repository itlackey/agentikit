# P1a — behavior spec: fail-closed `with` rejection + target-ref classifier

**Status:** ready for test authoring
**Phase:** P1a of the akm task/workflow refactor
**Branch:** `claude/breaking-changes-0-9-2-3cfyvp`
**Predecessor:** `docs/plans/specs/p0-invariants.md` (P0 pinned every row named here)

This document is the **single source of truth** for the P1a implementation and
test lanes. Test authors and implementers read **this** spec, not the parent
plan. Every `file:line` below was verified at the current head of
`claude/breaking-changes-0-9-2-3cfyvp`. Do not re-derive the design decisions —
they are binding and reproduced verbatim in §1.

---

## 0. What P1a is (and is not)

P1a makes exactly **one** behavior change and **one** structural change:

1. **The fail-closed correction (Lane A).** A workflow step that authors `with:`
   on a `uses: tasks/<ref>` target is rejected at freeze instead of having its
   authored mapping silently dropped. This flips P0 row **R-01(c)**.
2. **The classification seam (Lane B).** Workflow `uses` classification stops
   delegating to the task-v3 grammar. A new `classifyTargetRef` owns canonical
   asset refs; workflow classification imports **nothing** from
   `src/tasks/source-v3.ts`. This is **behavior-preserving** — see the parity
   table in §4.3.

Everything else is diagnostics plumbing (§1, D7): five new `UsageError` codes
declared, two wired.

**P1a is NOT:** task-input support (P2b), the typed preparer (P1b), child
workflows (P3), grammar removal (P4). Nothing in this phase implements `with`
bindings; the rejection message must say so.

**Exit-code contract is untouched.** Every code introduced here is a
`UsageError`, so `classifyExitCode` still maps it to exit **2**. No test that
asserts an exit code changes in P1a.

---

## 1. Binding design decisions (verbatim)

These were decided before this spec was written. They are reproduced exactly;
do not re-derive or re-litigate them.

> **D7 diagnostics:** add UsageError codes `COMPOSITION_INVALID`,
> `TASK_SOURCE_INVALID`, `TARGET_REF_INVALID`, `WORKFLOW_SOURCE_INVALID`,
> `INPUT_BINDING_INVALID` to `src/core/errors.ts` with `USAGE_HINTS` entries. In
> P1a, only two are WIRED: `COMPOSITION_INVALID` (the new with-rejection) and
> `TASK_SOURCE_INVALID` (re-code the `sourceError` funnel at
> `src/tasks/source-v3.ts:210-226` — message text unchanged, code changes from
> `INVALID_FLAG_VALUE`). The other three are declared now, wired in later
> phases. Exit-code contract untouched (all are UsageError -> exit 2).

> **Lane A (with-rejection):** at the head of `taskDispatch`
> (`src/workflows/ir/source-freeze-v4.ts:211`), if `source.with !== undefined`
> throw UsageError code `COMPOSITION_INVALID`, message naming the step id and
> stating task-call inputs are not yet supported (implemented in a later phase;
> today they were silently ignored — this is the fail-closed correction). The
> DECODER still accepts `with` on task steps (`schema.ts:144` unchanged);
> rejection is at freeze. builtin-command with-consumption
> (`source-freeze-v4.ts:145-151`) must be untouched.

> **Lane B (classifier):** new `src/execution/target-ref.ts` exporting
> `classifyTargetRef(value): {kind:"command"|"script"|"task"|"workflow", ref}`
> for canonical asset refs, throwing UsageError `TARGET_REF_INVALID` on anything
> else (fragments, malformed, empty). NO GitHub grammar, NO `akm/command`
> special case (callers layer builtin detection). Rewire
> `src/workflows/source-ir/semantics.ts` (`classifyWorkflowStepUses` at
> `:111-148`) and `src/workflows/source-ir/uses.ts` (currently a delegator to
> `classifyTaskV3Uses` at `:39-41`) so workflow classification imports NOTHING
> from `src/tasks/source-v3.ts`. **PARITY REQUIREMENT** (P1a is
> behavior-preserving except the with-rejection): every currently-classifiable
> workflow `uses` value classifies identically; `akm/command` still routes to
> builtin; a GitHub-locator-SHAPED value (slash-segmented `owner/repo[/path]@rev`
> shape) in a workflow step must STILL throw `WorkflowSourceSemanticError` code
> `remote-action-acquisition-out-of-scope` — `semantics.ts` implements its own
> minimal locator-shape detection (shape only, no full grammar) to preserve that
> error until P4 removes it. Nested-workflow rejection at `semantics.ts:141-146`
> stays. Task documents keep using `classifyTaskV3Uses` (untouched until P4).

> **Ratchet:** new `tests/architecture/diagnostic-codes.test.ts` counting the
> literal string `INVALID_FLAG_VALUE` in `src/tasks/**` + `src/workflows/**` and
> asserting count `<=` the post-P1a baseline (measure it during implementation;
> hardcode the measured number with a comment explaining the
> ratchet-only-declines rule, mirroring
> `tests/architecture/src-fn-size-ratchet.test.ts` style).

> **Docs ride with code** (docs-only commits skip CI):
> `docs/reference/workflow-schema.md` documents that `with:` on a task-step ref
> errors (`COMPOSITION_INVALID`) pending task-input support; `CHANGELOG.md` gets
> an `[Unreleased]` "Breaking changes & migration" entry for the with-rejection
> AND a note that task-source validation errors now use code
> `TASK_SOURCE_INVALID` (scripts consuming JSON envelopes must update);
> `docs/migration/v0.9.1-to-v0.9.2.md` gains the with-rejection note.

---

## 2. Diagnostics (D7) — exact edits

### 2.1 `src/core/errors.ts`

Append five members to the `UsageErrorCode` union (`src/core/errors.ts:66-93`).
The union is a closed string-literal type; `USAGE_HINTS`
(`src/core/errors.ts:132`) is `Partial<Record<UsageErrorCode, string>>`, so an
entry per code is optional at the type level and **required** by this spec.

| New code | Wired in P1a | Thrown from | `USAGE_HINTS` entry (exact) |
|---|---|---|---|
| `COMPOSITION_INVALID` | **yes** | `source-freeze-v4.ts` `taskDispatch` head | `Remove the step's with: block; task-call inputs arrive in a later 0.9.x release.` |
| `TASK_SOURCE_INVALID` | **yes** | `source-v3.ts` `sourceError` funnel | `Fix the task source at the reported path and line, then re-run.` |
| `TARGET_REF_INVALID` | **yes** (new module only) | `src/execution/target-ref.ts` | ``Targets are canonical asset refs: `commands/review`, `scripts/build.sh`, `tasks/nightly`, `workflows/release`.`` |
| `WORKFLOW_SOURCE_INVALID` | no — declared only | (P1b+) | ``Run `akm workflow validate <ref>` to see the failing source location.`` |
| `INPUT_BINDING_INVALID` | no — declared only | (P2b) | `Check the step's with: keys against the target's declared inputs.` |

`TARGET_REF_INVALID` is "wired" in the narrow sense that the new module throws
it; whether it reaches a user surface in P1a depends on the wrapping described
in §4.4 (workflow callers convert it to a `WorkflowSourceSemanticError`, so the
user-visible workflow codes do not change — that is the parity requirement).

### 2.2 The `TASK_SOURCE_INVALID` re-code

`sourceError` (`src/tasks/source-v3.ts:209-226`) is the single funnel for **62**
task-v3 source validation call sites in that module. Change **only** its thrown
code:

```ts
throw new UsageError(`Invalid task v3 source at ${location}: ${dotted} ${detail}`, "TASK_SOURCE_INVALID");
```

**Message text, field-path rendering (`$` for the empty path), and the
`file:line` location string are unchanged, byte for byte.**

**Scope boundary — read this before flipping any test.** The re-code covers the
`sourceError` funnel and **nothing else**. In particular it does **not** cover:

- `classifyTaskV3Uses`'s own `UsageError` throws (`src/tasks/source-v3.ts:523-593`,
  including the trailing `Task v3 uses must be akm/command, …` message). These
  are direct `new UsageError(…, "INVALID_FLAG_VALUE")` constructions, not funnel
  calls; they keep `INVALID_FLAG_VALUE` in P1a and are deleted in P4.
- `taskV2UnsupportedError` (`src/tasks/source-v3.ts:49-57`), which already
  carries its own code `TASK_SCHEMA_VERSION_UNSUPPORTED` and its own hint
  (`TASK_V2_MIGRATION_HINT`). It is unaffected by P1a.
- Any `INVALID_FLAG_VALUE` outside `src/tasks/source-v3.ts` (runtime-v3,
  schedule, scheduler-binding, task-id, workflow modules).

---

## 3. Lane A — the fail-closed `with` rejection

### 3.1 The change

At the **head** of `taskDispatch` (`src/workflows/ir/source-freeze-v4.ts:211-216`),
before `resolveOwnedAsset` at `:217` — so the rejection does not depend on the
task asset resolving:

```ts
if (source.with !== undefined) {
  throw new UsageError(
    `Workflow step ${source.id} cannot pass with: to task target ${refInput}; task-call inputs are not supported yet.`,
    "COMPOSITION_INVALID",
  );
}
```

**Pinned message contract** (test authors assert this verbatim, with `<id>` and
`<ref>` substituted):

```
Workflow step <id> cannot pass with: to task target <ref>; task-call inputs are not supported yet.
```

- `<id>` is `source.id` — the authored step id, which every decoded
  `WorkflowSourceStep` carries.
- `<ref>` is `refInput` — the classified task ref as authored
  (e.g. `tasks/nightly`, `team//tasks/nightly`), **not** the resolved owned ref.
- Rejection fires on `source.with !== undefined`, i.e. an authored `with:` block
  of **any** shape that survived decode — including an empty mapping `with: {}`.
  An absent `with:` is `undefined` and freezes exactly as today.

### 3.2 What Lane A must NOT touch

| Site | Why it stays |
|---|---|
| `src/workflows/source-ir/schema.ts:144` (`with?: Record<string, WorkflowSourceScalar>`) | The DECODER still accepts `with` on task steps. Rejection is at freeze, not decode. R-01(a) stays green. |
| `schema.ts:389` (`scalarRecord(step.with, …, true)`) and `:393` (`step <id> with is legal only with uses`) | R-01(b) guardrails fire on the shape of `with`, before and independent of the new rejection. |
| `source-freeze-v4.ts:145-151` (`resolveStep`'s builtin-command branch, `action = source.with`) | R-01(d): `with:` on `uses: akm/command` **is** consumed and target-validated. The new rejection lives inside `taskDispatch` only, which the `target.kind === "task"` branch at `:143` reaches — the builtin branch at `:145-151` never enters it. |
| `source-freeze-v4.ts:220-222` (nested-workflow `UsageError`) | R-03 site 2 keeps its `INVALID_FLAG_VALUE` code and message. It is now unreachable for a step that also authors `with:` (the new guard fires first) — fixtures for R-03 must not author `with:`. |

### 3.3 Ordering consequence (test authors: read this)

The new guard is the **first** statement in `taskDispatch`. For a task step that
authors `with:` **and** targets a nested workflow, `COMPOSITION_INVALID` now
wins over R-03's `A workflow task step cannot compose a nested workflow target.`
The P0 R-03 fixtures author no `with:`, so R-03 is unaffected — but a new
fixture must not combine the two.

---

## 4. Lane B — the target-ref classifier seam

### 4.1 New module: `src/execution/target-ref.ts`

```ts
export type TargetRefKind = "command" | "script" | "task" | "workflow";
export interface ClassifiedTargetRef {
  readonly kind: TargetRefKind;
  readonly ref: string;
}
export function classifyTargetRef(value: string): ClassifiedTargetRef;
```

**Accepts exactly** a canonical asset ref, using the repo's one ref parser
(`parseBundleRef` / `bundleRefToString` from `src/core/asset/asset-ref.ts`).
All five conditions must hold:

1. `parseBundleRef(value)` does not throw;
2. `parsed.fragment === undefined` (no `#fragment`);
3. `bundleRefToString(parsed) === value` (round-trips — rejects non-canonical
   spellings such as `akm:commands/review` and `bad.bundle//commands/review`);
4. `parsed.conceptId` contains a `/`, and the family before the first `/` is one
   of `commands`, `scripts`, `tasks`, `workflows`;
5. the name after the first `/` is non-empty.

**Kind mapping:** `commands` → `command`, `scripts` → `script`, `tasks` →
`task`, `workflows` → `workflow`. `ref` is the input string unchanged. The
returned object is **frozen** (`Object.freeze`), matching `classifyTaskV3Uses`'s
existing contract.

**Rejects everything else** — empty string, whitespace/inner whitespace,
`${{ … }}` expressions, fragments, non-canonical refs, other families
(`agents/`, `knowledge/`, …), bare words, local paths, `docker://`, and every
GitHub locator — with:

```ts
throw new UsageError(
  `Target ref ${JSON.stringify(value)} must be a canonical commands/, scripts/, tasks/, or workflows/ asset ref.`,
  "TARGET_REF_INVALID",
);
```

**Explicit non-goals** (binding): no GitHub locator grammar, no `akm/command`
special case, no resolution, no filesystem access, no guessing. Callers layer
builtin detection.

### 4.2 Rewire: `src/workflows/source-ir/uses.ts`

Today `uses.ts:12` imports `classifyTaskV3Uses` + `TaskV3UsesTarget` from
`../../tasks/source-v3`, and `:39-41` is a one-line delegator. After P1a the
file imports **nothing** from `src/tasks/**`:

- `WorkflowSourceUsesTarget` is declared **locally** as the union of:
  `{ kind: "command" | "script" | "task" | "workflow"; ref: string }`,
  `{ kind: "builtin-command"; ref: "akm/command" }`, and a structural
  `{ kind: "github-action"; ref: string; owner: string; repository: string; path?: string; revision: string }`
  member. The `github-action` member is retained **as a type only** — it is what
  an externally injected classifier may still return (see §4.4 step 8) and what
  keeps `GithubWorkflowSourceOptions.classifyUses` type-compatible. P1a
  introduces no code that produces it.
- `classifyWorkflowSourceUses` becomes the builtin-layering wrapper:

```ts
export function classifyWorkflowSourceUses(value: string): WorkflowSourceUsesTarget {
  if (value === "akm/command") return Object.freeze({ kind: "builtin-command" as const, ref: "akm/command" as const });
  return classifyTargetRef(value); // throws UsageError TARGET_REF_INVALID
}
```

- The module docstring at `uses.ts:5-10` (which describes delegation "to WP6's
  canonical task-v3 classifier") must be rewritten to describe the new seam.

### 4.3 Rewire: `src/workflows/source-ir/semantics.ts`

`classifyWorkflowStepUses` (`:111-148`) keeps its signature — including the
**injected-classifier parameter**, which `github-yaml.ts:587,608` and
`compile.ts:41` depend on and which the P0 delegation tests exercise:

```ts
export function classifyWorkflowStepUses(
  value: string,
  classifier: WorkflowSourceUsesClassifier = classifyWorkflowSourceUses,
): WorkflowSourceUsesTarget
```

**Required evaluation order** (deviating from it breaks parity):

1. `value.includes("${{")` → `WorkflowSourceSemanticError("unsupported-github-expression", "GitHub expressions are unsupported in uses.")` — unchanged (`:115-120`).
2. empty / untrimmed / inner-whitespace → `WorkflowSourceSemanticError("unsupported-uses-target", "uses must be one exact, non-empty executable ref")` — unchanged (`:121-126`).
3. `canonicalTaskTarget(value)` → `{ kind: "task", ref: value }` — unchanged (`:127-128`, helper at `:150-163`). **Still first**, still without calling the classifier.
4. Call the injected `classifier(value)` inside `try` — unchanged (`:129-134`).
5. Returned `kind === "workflow"` → `WorkflowSourceSemanticError("nested-workflow-unsupported", \`Nested workflow target ${JSON.stringify(value)} is unsupported in a workflow step.\`)` — unchanged (`:141-146`).
6. Returned `kind === "github-action"` → `WorkflowSourceSemanticError("remote-action-acquisition-out-of-scope", …)` — unchanged (`:134-139`), retained for injected classifiers.
7. Otherwise return the target (`command` / `script` / `task` / `builtin-command`).
8. **On a classifier throw** (the `catch` at `:131-133`): compute the code
   `usesFailure` (`:229-239`) would assign. If — and only if — that code is
   `unsupported-uses-target` **and** `isGithubLocatorShape(value)` is true,
   throw `WorkflowSourceSemanticError("remote-action-acquisition-out-of-scope", \`Remote action acquisition is out of scope for ${JSON.stringify(value)}.\`)`. Otherwise `throw usesFailure(value, cause)` exactly as today.

Step 8's ordering is load-bearing: `usesFailure`'s prefix classifications
(`docker://` → `docker-action-unsupported`, `./` `../` `/` →
`local-action-path-unsupported`, `agents/` → `non-executable-asset-ref`) must
keep winning over locator-shape detection, because today's full grammar rejects
those values before reaching the locator branch.

**`isGithubLocatorShape(value)` — minimal shape detection, local to
`semantics.ts`, shape only:**

- exactly one `@`, at index > 0 (`at = value.lastIndexOf("@"); at > 0 && at === value.indexOf("@")`);
- the locator `value.slice(0, at)` splits on `/` into **≥ 2** non-empty segments, and the first two segments each match `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`;
- the revision `value.slice(at + 1)` is non-empty, matches `/^[A-Za-z0-9._/-]+$/`, does not contain `..`, does not start or end with `/`, and no `/`-separated revision segment starts with `.` or ends with `.lock`.

This is deliberately **not** the full grammar
(`src/tasks/source-v3.ts:562-588`) and must not import it.

**Accepted deviation A-1 (recorded, not a defect):** a value that is
locator-*shaped* under the rule above but that the old full grammar rejected for
a reason the shape rule does not encode now yields
`remote-action-acquisition-out-of-scope` where it previously yielded
`unsupported-uses-target`. Both are `WorkflowSourceSemanticError` rejections of
the same value at the same boundary, both keep the source non-compiling, and P4
deletes the row entirely. No existing test pins such a value — the pinned table
in §4.5 is the complete set, and its one locator near-miss
(`actions/checkout@bad:ref`, revision contains `:`) is excluded by the charset
rule and keeps `unsupported-uses-target`.

### 4.4 Rewire: `src/workflows/source-ir/compile.ts` (required — do not skip)

`compile.ts:41` injects `options.classifyUses ?? classifyTaskV3Uses` into
`parseGithubWorkflowSource`, which overrides the `semantics.ts` default for the
**entire GitHub-YAML entrypoint** (`github-yaml.ts:587` → `:608`). Rewiring
`semantics.ts` and `uses.ts` alone would leave the GitHub path still classifying
through the task-v3 grammar — and `tests/workflows/source-ir-contract.test.ts`
(the parity gate, §4.5) runs through exactly that path.

Change the default only:

```ts
classifyUses: options.classifyUses ?? classifyWorkflowSourceUses,
```

`classifyTriggers: options.classifyTriggers ?? classifyTaskV3Triggers`
(`compile.ts:42`) **stays** — trigger classification is not target-ref
classification and is owned by P2a. `compile.ts` therefore keeps exactly one
import from `src/tasks/source-v3.ts`: `classifyTaskV3Triggers`. The
"imports NOTHING from `src/tasks/source-v3.ts`" invariant is scoped to
**`uses` classification**: `semantics.ts` and `uses.ts` import nothing from it
at all, and `compile.ts` retains only the trigger import.

The two classification entrypoints after P1a:

| Entrypoint | Path | Default `uses` classifier after P1a |
|---|---|---|
| GitHub YAML | `compileGithubWorkflowSource` → `parseGithubWorkflowSource` → `github-yaml.ts:608` → `classifyWorkflowStepUses(uses, injected)` | `classifyWorkflowSourceUses` (via `compile.ts:41`) |
| Strict decode / Markdown | `decodeWorkflowSourceIrV1` (`schema.ts:358`) — no injection | `classifyWorkflowSourceUses` (the `semantics.ts:113` parameter default) |

Both must resolve to the same function.

### 4.5 PARITY TABLE — the binding acceptance for Lane B

This is `tests/workflows/source-ir-contract.test.ts:429-457`, reproduced as the
authoritative input→expected table. It runs through
`compileGithubWorkflowSource` with **no** injected classifier. **That test file
must stay green UNCHANGED** — it is the parity gate, not an authorized flip.

**Accepted (`result.ok === true`):**

| `uses:` value | Classified kind |
|---|---|
| `akm/command` (with `with: { content: … }`) | `builtin-command` |
| `commands/review` | `command` |
| `team//commands/review` | `command` |
| `tasks/review` | `task` (via `canonicalTaskTarget`, classifier never called) |
| `team//tasks/review` | `task` (via `canonicalTaskTarget`) |
| `scripts/build.sh` | `script` |

**Rejected (`result.ok === false`, `errors[].code` asserted; message not asserted):**

| `uses:` value | Expected `code` | Which rule produces it after P1a |
|---|---|---|
| `actions/checkout@v4` | `remote-action-acquisition-out-of-scope` | §4.3 step 8, locator shape |
| `./actions/review` | `local-action-path-unsupported` | `usesFailure` prefix (`./`) |
| `docker://alpine:latest` | `docker-action-unsupported` | `usesFailure` prefix (`docker://`) |
| `agents/reviewer` | `non-executable-asset-ref` | `usesFailure` regex (`agents/`) |
| `workflows/child` | `nested-workflow-unsupported` | §4.3 step 5 |
| `akm:commands/review` | `unsupported-uses-target` | `classifyTargetRef` round-trip check → `usesFailure` |
| `bad.bundle//commands/review` | `unsupported-uses-target` | `classifyTargetRef` round-trip check → `usesFailure` |
| `commands/review#fragment` | `unsupported-uses-target` | `classifyTargetRef` fragment check → `usesFailure` |
| `actions/checkout@bad:ref` | `unsupported-uses-target` | not locator-shaped (`:` in revision) → `usesFailure` |
| `review` | `unsupported-uses-target` | `classifyTargetRef` reject → `usesFailure` |

`usesFailure` derives its **message** from the thrown cause, so the wrapped
message text changes (from the task-v3 trailing message to the
`TARGET_REF_INVALID` message). **No test asserts that message** — verified: the
contract table asserts `code` only, and the only test asserting the task-v3
trailing message asserts it against `classifyTaskV3Uses` directly (which is
untouched). Message drift here is authorized; **code drift is not**.

---

## 5. Behavior table (input → expected)

| # | Input | Expected after P1a | Lane |
|---|---|---|---|
| **B-01** | Workflow step `uses: tasks/nightly` with `with: {a: 1}`, **decoded** | Decodes with no error (unchanged, `schema.ts:144`) | A |
| **B-02** | Same step, **frozen** | `UsageError`, code `COMPOSITION_INVALID`, message `Workflow step <id> cannot pass with: to task target tasks/nightly; task-call inputs are not supported yet.`; exit 2 | A |
| **B-03** | Same step with `with: {}` (empty mapping), frozen | Same rejection as B-02 (`!== undefined`, not "non-empty") | A |
| **B-04** | Same step **without** `with:`, frozen | Freezes exactly as today — resolved dispatch unchanged from P0's pinned value | A |
| **B-05** | Workflow step `uses: akm/command` with `with: {content: …}`, frozen | Unchanged: consumed into the command target, content present in the frozen plan | A |
| **B-06** | Workflow step with `with:` but **no** `uses:` | Unchanged decode failure `step <id> with is legal only with uses` (`schema.ts:393`) | A |
| **B-07** | Workflow step `uses: tasks/x` with a **non-scalar** `with` value | Unchanged decode failure from `scalarRecord` (`schema.ts:389`) — fires at decode, before freeze | A |
| **B-08** | Task **document** (`tasks/*.yml`) with `with:` on a command / script / workflow `uses` | Unchanged: P-01 / P-02 / P-03 behavior from `runtime-v3.ts`, code `INVALID_FLAG_VALUE` | — |
| **B-09** | `classifyTargetRef("commands/review")` | `{ kind: "command", ref: "commands/review" }`, frozen | B |
| **B-10** | `classifyTargetRef("team//scripts/build.sh")` | `{ kind: "script", ref: "team//scripts/build.sh" }`, frozen | B |
| **B-11** | `classifyTargetRef("tasks/nightly")` / `("workflows/release")` | `{ kind: "task", … }` / `{ kind: "workflow", … }`, frozen | B |
| **B-12** | `classifyTargetRef("akm/command")` | **throws** `UsageError` `TARGET_REF_INVALID` (no builtin special case) | B |
| **B-13** | `classifyTargetRef("commands/review#fragment")`, `("akm:commands/review")`, `("bad.bundle//commands/review")`, `("agents/reviewer")`, `("review")`, `("")`, `(" commands/review ")`, `("owner/repo@v1")`, `("docker://alpine:latest")`, `("./x")` | **throws** `UsageError` `TARGET_REF_INVALID`, message `Target ref "<value>" must be a canonical commands/, scripts/, tasks/, or workflows/ asset ref.` | B |
| **B-14** | Every row of the §4.5 parity table, through `compileGithubWorkflowSource` | Byte-identical `ok` / `code` outcomes to pre-P1a | B |
| **B-15** | Every row of the §4.5 parity table, through `decodeWorkflowSourceIrV1` (strict decode / Markdown path) | Same classification outcome as B-14 (both defaults are now one function) | B |
| **B-16** | `classifyWorkflowStepUses("tasks/build", spy)` | `{ kind: "task", ref: "tasks/build" }`; spy **not** called | B |
| **B-17** | `classifyWorkflowStepUses("commands/review", spy)` where the spy returns `{kind:"command", ref}` | Spy called once with `"commands/review"`; its return passed through | B |
| **B-18** | Task v3 source with neither `akm.schedule` nor `on:` | `UsageError`, code **`TASK_SOURCE_INVALID`**, message unchanged: `Invalid task v3 source at <path>:1: $ must declare exactly one scheduling source: akm.schedule or on.`; exit 2 | — |
| **B-19** | Task v3 source with **both** scheduling sources | Same as B-18 (byte-identical message, same new code) | — |
| **B-20** | `classifyTaskV3Uses("review")` (direct call) | Unchanged: `UsageError` `INVALID_FLAG_VALUE` with the trailing task-v3 message — **not** re-coded in P1a | — |
| **B-21** | Task document `uses: actions/checkout@v4`, prepared | Unchanged R-04(b): `UsageError` `INVALID_FLAG_VALUE`, `GitHub action "actions/checkout@v4" is recognized but remote action acquisition is unsupported in 0.9.2.` | — |
| **B-22** | Task v3 source with `version: 2` | Unchanged: `TASK_SCHEMA_VERSION_UNSUPPORTED` + `TASK_V2_MIGRATION_HINT` | — |
| **B-23** | Any of the five new codes reaching the CLI | `{ok:false, error, code}` on stderr, **exit 2** (all are `UsageError`) | — |
| **B-24** | `new UsageError("x", "<new code>").hint()` for each of the five | Returns the §2.1 hint string | — |

---

## 6. Per-lane file lists

### Lane 0 — diagnostics (lands first; both lanes rebase on it)

| File | Change |
|---|---|
| `src/core/errors.ts` | Five codes appended to `UsageErrorCode` (`:66-93`); five `USAGE_HINTS` entries (`:132-147`) |
| `src/tasks/source-v3.ts` | `sourceError` (`:209-226`) code `INVALID_FLAG_VALUE` → `TASK_SOURCE_INVALID`. **Nothing else in this file.** |
| `tests/integration/tasks-scheduling-characterization.test.ts` | Authorized flip, §7 row F-02 |
| `tests/integration/cli-errors.test.ts` | Add hint coverage for the five new codes (B-24) — additive only; existing assertions untouched |

### Lane A — with-rejection

| File | Change |
|---|---|
| `src/workflows/ir/source-freeze-v4.ts` | Guard at the head of `taskDispatch` (`:211-217`). No other edit; `:145-151` and `:220-222` untouched. |
| `tests/workflows/characterization-with-drop.test.ts` | Authorized flip, §7 rows F-01a/F-01b; new B-03 (empty `with: {}`) coverage |
| `docs/reference/workflow-schema.md` | §8 |
| `CHANGELOG.md` | §8 |
| `docs/migration/v0.9.1-to-v0.9.2.md` | §8 (**file does not exist yet — create it**) |

### Lane B — classifier seam

| File | Change |
|---|---|
| `src/execution/target-ref.ts` | **new** — `classifyTargetRef`, `TargetRefKind`, `ClassifiedTargetRef` (§4.1) |
| `src/workflows/source-ir/uses.ts` | Local `WorkflowSourceUsesTarget` union; `classifyWorkflowSourceUses` layers builtin over `classifyTargetRef`; docstring rewritten; **no `src/tasks/**` import** (§4.2) |
| `src/workflows/source-ir/semantics.ts` | Evaluation order §4.3; new local `isGithubLocatorShape`; `usesFailure` (`:229-239`) unchanged; **no `src/tasks/**` import** |
| `src/workflows/source-ir/compile.ts` | `:41` default → `classifyWorkflowSourceUses`; `:42` unchanged (§4.4) |
| `tests/execution/target-ref.test.ts` | **new** — B-09…B-13 unit coverage |
| `tests/architecture/diagnostic-codes.test.ts` | **new** — §9 ratchet + import-seam assertion |

**Untouched by both lanes (assert this in review):** `src/tasks/runtime-v3.ts`,
`src/tasks/runner.ts`, `src/workflows/source-ir/github-yaml.ts`,
`src/workflows/source-ir/schema.ts`, `classifyTaskV3Uses` itself.

---

## 7. Authorized test flips

**Only the rows marked FLIP may change. Every other test in the repo must stay
green UNCHANGED.** A test that goes red and is not in this table is a
regression, not a decision — stop and re-read §4.3/§4.4 before editing it.

| # | Test file:line | What it pins today | P1a action |
|---|---|---|---|
| **F-01a** | `tests/workflows/characterization-with-drop.test.ts:161` — R-01(c) `a task-composed step freezes byte-identically whether or not with: is authored…` | Freeze-equality of the `with:` and no-`with:` halves | **FLIP.** The `with:` half must now assert the `COMPOSITION_INVALID` rejection (type + code + exact message, §3.1). |
| **F-01b** | same test, no-`with:` half | The `with`-free fixture freezes | **KEEP GREEN** inside the flipped test — the without-block still freezes, unchanged (B-04). Assert both halves in the rewritten test. |
| **F-02** | `tests/integration/tasks-scheduling-characterization.test.ts:49` and `:64` (R-06 neither-case and both-case) | `UsageError` + `INVALID_FLAG_VALUE` + `EXACTLY_ONE_SCHEDULING_SOURCE` | **FLIP the CODE assertion only** → `TASK_SOURCE_INVALID`. The `EXACTLY_ONE_SCHEDULING_SOURCE` message constant and the `instanceof UsageError` assertion are unchanged. |
| **F-03** | `tests/workflows/characterization-classification.test.ts:149` and `:162` — the two `classifyWorkflowStepUses` delegation tests (spy-based) | Task-ref priority (spy not called) and delegation of non-task refs | **KEEP UNCHANGED.** The injected-classifier parameter is retained (§4.3), so both stay green as written. *Authorized* (P0-recorded advisory) to be rewritten as observable-result assertions through the new seam if the implementer finds them brittle — but rewriting is not required and should be avoided. |

### Examined and **not** flipped (verified against the §2.2 scope boundary)

| Test file:line | Pins | Why it does not flip |
|---|---|---|
| `tests/workflows/characterization-with-drop.test.ts:64,:72,:97,:103` | R-01(a) decode acceptance, R-01(b) `scalarRecord` + `with is legal only with uses` | Rejection moved to freeze; decode is unchanged (B-01/B-06/B-07) |
| `tests/workflows/characterization-with-drop.test.ts:116,:252` | R-01(d) builtin-command `with` consumption | `source-freeze-v4.ts:145-151` untouched (B-05) |
| `tests/workflows/characterization-classification.test.ts:91-114` (asserts at `:94`, `:108`) | R-04(a) trailing `classifyTaskV3Uses` message + `INVALID_FLAG_VALUE` | **Not funnel-produced** — a direct `new UsageError(…)` at `source-v3.ts:587-590`, outside the §2.2 re-code scope. Stays `INVALID_FLAG_VALUE`; P4 deletes it. (This site was listed as a flip candidate; inspection shows no flip is needed.) |
| `tests/workflows/characterization-classification.test.ts:116` (assert at `:134`) | R-04(b) prepare-time rejection (`runtime-v3.ts:366-371`) | Runtime module, not the source funnel |
| `tests/workflows/characterization-classification.test.ts:191` | R-04(c) `remote-action-acquisition-out-of-scope` via the **default** classifier | Parity requirement — §4.3 step 8 keeps it green |
| `tests/workflows/characterization-classification.test.ts:180` | R-03 site 1 `nested-workflow-unsupported` | `semantics.ts:141-146` unchanged |
| `tests/workflows/characterization-classification.test.ts:217` (assert at `:243`) | R-03 site 2 `INVALID_FLAG_VALUE` at `source-freeze-v4.ts:220-222` | Untouched; fixture authors no `with:` (§3.3) |
| `tests/workflows/characterization-classification.test.ts:527` (assert at `:532`) | R-05(b) multi-job `INVALID_FLAG_VALUE` | `source-freeze-v4.ts:105-110` untouched; flips in P4 |
| `tests/workflows/source-ir-contract.test.ts:429-457` | The §4.5 parity table (10 rejection codes + 6 acceptances) | **Parity gate.** Must stay green unchanged — this is Lane B's primary acceptance evidence. |
| `tests/integration/tasks-with-classification-characterization.test.ts:77,:98,:155` | P-01 / P-02 / P-04, `runtime-v3.ts` | Task layer, not the source funnel (B-08) |
| `tests/integration/commands/tasks-cli-envelope.test.ts:113,:136` | `{ok:false, code:"INVALID_FLAG_VALUE"}` for `task run commands/nightly` and a non-task adapter claiming a task-shaped ref | Ref-projection / adapter-boundary rejections, **not** `parseTaskV3Yaml`. **Implementer must re-verify** by running the file after the Lane 0 commit; if either turns red, the error came through the funnel and the row becomes an authorized code-only flip to `TASK_SOURCE_INVALID` (record it in the Review log). |
| `tests/integration/commands/tasks-lifecycle.test.ts:217` | `akmTasksAdd` workflow+engine rejection | Add-path flag validation. Same re-verify instruction as the row above. |
| `tests/tasks-task-id.test.ts:36,:54,:68`, `tests/tasks-parse-ref.test.ts:50`, `tests/integration/tasks-run-attempt-observability.test.ts:168,:172`, `tests/integration/commands/tasks-bundle-target.test.ts:226`, `tests/integration/okf-conformance.test.ts:717` | `INVALID_FLAG_VALUE` on task ids / refs / run args | `task-id.ts`, `parse-ref`, `scheduler-binding` — none reach `sourceError` |
| `tests/integration/cli-errors.test.ts:202,:217`, `tests/completions.test.ts:227` | `INVALID_FLAG_VALUE` hint and flag-value envelopes | Generic CLI surface; the `INVALID_FLAG_VALUE` hint is unchanged |
| `tests/tasks/migrate-v2-to-v3.test.ts`, `tests/integration/migrate-format.test.ts`, `tests/migrate/task-v2-to-v3-files.test.ts` | task-v2 rejection + migration hint | `taskV2UnsupportedError` already carries `TASK_SCHEMA_VERSION_UNSUPPORTED` (`source-v3.ts:49-57`) — **never** `INVALID_FLAG_VALUE`, so the funnel re-code cannot reach it |

---

## 8. Docs that ride with the code

Docs-only commits skip CI (`.github/workflows/ci.yml` ignores `docs/**`,
`CHANGELOG.md`), so these edits **must** land in the same commits as their code.

| File | Required content |
|---|---|
| `docs/reference/workflow-schema.md` | In the step-`uses`/`with` reference (near the `with:` example at `:58` and the grammar section at `:278`): `with:` on a **task-step** ref is an error — code `COMPOSITION_INVALID`, exit 2 — pending task-input support in a later 0.9.x release. `with:` on `uses: akm/command` is unchanged and still required for the builtin action. |
| `CHANGELOG.md` | Under `## [Unreleased]`, a `### Breaking changes & migration` section with **two** entries: (1) a workflow step that passes `with:` to a `tasks/<ref>` target is now **rejected** (`COMPOSITION_INVALID`) instead of having the mapping silently dropped — remove the block, or wait for task-call inputs; (2) task-source validation errors now report code **`TASK_SOURCE_INVALID`** instead of `INVALID_FLAG_VALUE` — **scripts that branch on the `code` field of the JSON error envelope must be updated**; messages and exit code 2 are unchanged. |
| `docs/migration/v0.9.1-to-v0.9.2.md` | **Create** (it does not exist). Carries the with-rejection note: what breaks, the exact new message, and the fix (delete the `with:` block from task steps). |

---

## 9. Ratchet — `tests/architecture/diagnostic-codes.test.ts` (new)

Mirrors `tests/architecture/src-fn-size-ratchet.test.ts` in style: a hardcoded
baseline number with a comment stating the rule, and a failure message that
tells the next author what to do.

**Assertion 1 — the code ratchet.** Count occurrences of the literal string
`INVALID_FLAG_VALUE` across all files under `src/tasks/**` and
`src/workflows/**`; assert `count <= INVALID_FLAG_VALUE_BASELINE`.

- **Pre-P1a measurement** (`grep -rn "INVALID_FLAG_VALUE" src/tasks/ src/workflows/ | wc -l`,
  measured 2026-08-26 at branch head): **83** —
  `runner.ts` 1, `runtime-v3.ts` 11, `schedule.ts` 12, `scheduler-binding.ts` 10,
  `scheduler-sync.ts` 3, `source-v3.ts` 12, `task-id.ts` 7,
  `ir/environment-v4.ts` 3, `ir/freeze-v4.ts` 2, `ir/params.ts` 2,
  `ir/source-freeze-v4.ts` 9, `runtime/runs.ts` 2,
  `runtime/workflow-asset-loader.ts` 4, `source-files.ts` 5.
- **Expected post-P1a: 82** (the one funnel literal at `source-v3.ts:225`
  becomes `TASK_SOURCE_INVALID`; Lane A adds `COMPOSITION_INVALID`, not
  `INVALID_FLAG_VALUE`). **Re-measure during implementation and hardcode the
  measured number** — do not copy 82 on faith.
- Required comment on the constant: the baseline **only ever declines**. A later
  phase that re-codes more sites lowers it; nothing may raise it. Raising it
  means new `INVALID_FLAG_VALUE` throws were added to task/workflow code, which
  is exactly what this ratchet exists to prevent.

**Assertion 2 — the classification import seam.** Assert that the source text of
`src/workflows/source-ir/semantics.ts` and `src/workflows/source-ir/uses.ts`
contains **no** import from `tasks/source-v3`, and that
`src/workflows/source-ir/compile.ts`'s only `tasks/source-v3` import binding is
`classifyTaskV3Triggers`. This is what keeps §4.2/§4.4 from silently regressing.

The new test file carries the MPL-2.0 header
(`scripts/lint-license-headers.ts`) and uses no env/cwd/fetch mutation
(`scripts/lint-tests-isolation.ts`).

---

## 10. Acceptance criteria

- [ ] `src/core/errors.ts` declares all five new `UsageErrorCode` members and a `USAGE_HINTS` entry for each, with the §2.1 strings.
- [ ] `sourceError` (`src/tasks/source-v3.ts:209-226`) throws `TASK_SOURCE_INVALID`; its rendered message is byte-identical to pre-P1a.
- [ ] No other `INVALID_FLAG_VALUE` in `src/tasks/source-v3.ts` was re-coded (`classifyTaskV3Uses` and `taskV2UnsupportedError` untouched).
- [ ] `taskDispatch` (`src/workflows/ir/source-freeze-v4.ts:211`) rejects `source.with !== undefined` with `COMPOSITION_INVALID` and the exact §3.1 message, **before** `resolveOwnedAsset`.
- [ ] `schema.ts:144` and the `scalarRecord`/`with is legal only with uses` guardrails are unchanged; R-01(a) and R-01(b) are green unchanged.
- [ ] `source-freeze-v4.ts:145-151` (builtin-command `with` consumption) is unchanged; R-01(d) is green unchanged.
- [ ] `src/execution/target-ref.ts` exists, exports `classifyTargetRef`, contains **no** GitHub-locator grammar and **no** `akm/command` branch, and returns frozen objects.
- [ ] `src/workflows/source-ir/semantics.ts` and `src/workflows/source-ir/uses.ts` import nothing from `src/tasks/source-v3.ts`; `src/workflows/source-ir/compile.ts` imports only `classifyTaskV3Triggers` from it.
- [ ] `compile.ts:41`'s default classifier is `classifyWorkflowSourceUses`; both classification entrypoints (§4.4) resolve to the same function.
- [ ] Every row of the §4.5 parity table produces its listed outcome, through **both** entrypoints (B-14, B-15).
- [ ] `tests/workflows/source-ir-contract.test.ts` is green **unchanged**.
- [ ] Exactly the flips in §7 (F-01a/F-01b, F-02) are present in the test diff. `git diff --stat` over `tests/` shows no other pre-existing test file modified, except any row the implementer re-verified into the table per the `tasks-cli-envelope` / `tasks-lifecycle` instruction (recorded in the Review log).
- [ ] `tests/execution/target-ref.test.ts` covers B-09…B-13, including the frozen-result assertion and each rejection shape.
- [ ] `tests/architecture/diagnostic-codes.test.ts` exists, hardcodes the **measured** post-P1a baseline with the only-ever-declines comment, and carries the §9 import-seam assertion.
- [ ] `docs/reference/workflow-schema.md`, `CHANGELOG.md`, and the newly created `docs/migration/v0.9.1-to-v0.9.2.md` carry the §8 content, committed **with** their code (never as a docs-only commit).
- [ ] No exit-code test changed; `COMPOSITION_INVALID` and `TASK_SOURCE_INVALID` both exit **2**.
- [ ] Every new test file carries the MPL-2.0 header; `bun scripts/lint-license-headers.ts` and `bun scripts/lint-tests-isolation.ts` pass.
- [ ] `bunx biome check --write src/ tests/` produces no further changes; `bunx tsc --noEmit` is clean.
- [ ] `bun run check` passes (lint + typecheck + `test:unit` + `test:integration`).
- [ ] Any behavior difference discovered during implementation that is not authorized by §4.5 (Accepted deviation A-1) or §7 is recorded in the Review log and **not** silently absorbed.

---

## Review log
