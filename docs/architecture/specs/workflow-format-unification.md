# Workflow Format Unification

Status: PROPOSAL — owner review requested
Date: 2026-07-30
Supersedes: the dual markdown/YAML-program authoring surface (both unreleased)

## 0. Why now

The workflow feature has never shipped (`experimental.workflowEngine` opt-in,
0.9.0-rc). There are currently **two authoring formats** for one asset type,
and the seams between them have started leaking into unrelated systems — the
OKF provenance work (#730) tripped over workflow's closed frontmatter
allowlist, which exists only because the markdown format grew its own bespoke
validation instead of sharing the asset envelope every other type uses. This
is the moment to unify: nothing on disk to migrate, no users to break.

## 1. Review of the two current formats

### 1.1 Format A — markdown workflow (`src/workflows/parser.ts`, ~500 lines)

```markdown
---
description: Ship a tagged release
params:
  version: The semver version string to release   # name → description string
---

# Workflow: Ship Release

## Step: Validate inputs
Step ID: validate

### Instructions
Check that `version` follows semver.

### Completion Criteria
- Tag does not already exist
```

A bespoke prose grammar: one magic `# Workflow:` H1, magic `## Step:` H2s, a
magic `Step ID:` body line, magic `### Instructions` / `### Completion
Criteria` subsection names. Capabilities: **linear steps only**. No routing,
fan-out, retry, timeout, engine/model selection, output schemas, or budgets —
the compile path (`ir/compile.ts` `compileWorkflowPlan`) lowers every step to
one fail-fast unit node.

### 1.2 Format B — YAML program (`src/workflows/program/*`, ~1,300 lines)

```yaml
version: 2
name: example-workflow
params:
  example_param: { type: string, description: ... }   # name → JSON Schema
defaults: { timeout: 10m, on_error: fail }
steps:
  - id: first-step
    unit:
      instructions: |
        Do the thing. Reference ${{ params.example_param }}.
    gate:
      criteria: [Confirm the first step is complete]
```

The full orchestration surface: `unit | map | route` steps, `${{ … }}`
expressions, retries keyed on the failure taxonomy, timeouts, per-unit
engine/model/llm overrides, JSON-Schema-typed params and step outputs, gates
with `max_loops`/`required`, budgets, worktree isolation.

### 1.3 The divergences (each one is a standing cost)

| Concern | Markdown | YAML program |
|---|---|---|
| Step id grammar | `[A-Za-z0-9][A-Za-z0-9._-]*` — dots allowed | `[A-Za-z_][A-Za-z0-9_-]*` — dots forbidden (expression/`.gate` safety) |
| Params | name → description string, untyped | name → JSON Schema |
| Templating | **none** — instructions verbatim | `${{ … }}` expressions, real substitution |
| Gate | `### Completion Criteria` bullets; no `max_loops`, no `required` | `gate:` with criteria/max_loops/required |
| Capabilities | linear only | full orchestration |
| Frontmatter validation | closed hand-maintained allowlist (`validator.ts`) | closed key lists per level, JSON Schema published |
| Title | required `# Workflow:` H1 prefix | `name:` field duplicating the filename |
| Version | internal `schemaVersion 1` | `version: 2` (IR is v3) |

Beyond the table, four structural costs:

1. **The fake templating trap.** Every shipped example workflow
   (`scripts/akm-eval/example-stash/workflows/*.md`) uses `{{ repo }}`-style
   moustaches that **the engine never substitutes** — markdown instructions
   are compiled `templating: "verbatim"`. The YAML format substitutes
   `${{ … }}` for real. Two syntaxes; one is decorative and exists only as a
   convention the executing agent is hoped to honor. This is the single worst
   authoring trap in the feature.
2. **Content sniffing everywhere.** Two structural probes
   (`looksLikeWorkflow`, `looksLikeWorkflowProgram`) consulted by the indexer
   matchers, the workflow adapter (`recognize()` returns `"markdown" |
   "yaml-program"`), the asset loader (extension dispatch + probe), and the
   proposal validator (which sniffs *content* when no path is available).
   `canonicalizeWorkflowName` collapses `foo.md` / `foo.yaml` / `foo.yml` to
   one identity, so the two formats can silently collide on one ref.
3. **The closed-allowlist special case.** Workflow markdown is the only AKM
   type validating frontmatter against a closed hand-maintained key set. It
   is why #730's provenance stamping needed a re-validation fallback in the
   promotion path, why the allowlist had to learn `generated`/`verified`/
   `provenance` by name, and why its error message is now stale (it still
   enumerates the pre-#730 keys — `validator.ts:94`). Every future
   machine-stamped key repeats this.
4. **Double everything.** Two parsers, two templates, two doc sections, two
   test suites, two JSON representations feeding one `WorkflowPlanDraft`.
   ~1,800 lines of format code for one asset type.

### 1.4 What is genuinely good and must survive

- **The IR and engine.** Both frontends compile to one `WorkflowPlanDraft` →
  frozen IR v3. Deterministic replay, journaled units, leases, brief/report —
  none of that is format-coupled. This proposal changes **frontends only**.
- **The closed expression grammar** (`program/expressions.ts`): four roots,
  parse-once, substituted-content-never-rescanned. Keep verbatim.
- **The program vocabulary** (unit/map/route, gate, retry taxonomy, budgets,
  defaults): well-designed, schema-validated, keep nearly verbatim.
- **Markdown prose as the instruction medium.** The example workflows prove
  the point: real instructions are long structured prose with code fences,
  sub-headings, and lists. YAML block scalars are a hostile medium for that;
  markdown is the native one. Any unification that abandons markdown bodies
  loses search quality, wiki cohesion, and authorability.

## 2. Design

### 2.1 Principle

> **One file. Machine surface in frontmatter, prose surface in the body,
> joined by step id. The body rule fits in two sentences.**

A workflow is an ordinary AKM markdown asset — same envelope as every other
type, OKF-conformant frontmatter + body — whose frontmatter carries the
entire orchestration graph (the YAML program vocabulary, minus embedded
prose) and whose body carries the per-step instructions under plain headings.

This is not a third format. It is the YAML program with its `instructions:`
strings lifted out into a markdown body, wearing the standard asset envelope.

### 2.2 The format

````markdown
---
type: workflow
description: Drive a batch of GitHub issues to merged PRs.
tags: [github, multi-agent]
params:
  repo:   { type: string, description: Target repository owner/name }
  issues: { type: array,  description: Issue numbers to implement }
defaults:
  timeout: 10m
  on_error: fail
budget: { max_units: 60 }
steps:
  - id: intake
  - id: implement
    map:
      over: ${{ steps.intake.output.issues }}
      concurrency: 3
      unit: { isolation: worktree, retry: { max: 2, on: [timeout] } }
    output: { type: object }             # JSON Schema for the step artifact
    gate:
      criteria: [Every issue has a mergeable PR or a recorded blocker]
      required: true
      max_loops: 2
  - id: verdict
    route:
      input: ${{ steps.implement.output.status }}
      when: [{ match: clean, step: done }]
      default: intake
  - id: done
---

# GitHub Issues Parallel Implementer

Free preamble prose. Indexed for search, shown in `akm show`, never
dispatched. Any headings except level-2 are fine here.

## intake: Intake and validate

Everything under this heading, byte-exact, is the step's instructions —
sub-headings, fences, lists, all of it. `${{ params.repo }}` is a real
substitution here, same grammar as frontmatter expressions.

## implement: Implement one issue

This section is the **map unit template** — instantiated per item.
Work on issue `${{ item }}` (position ${{ item_index }}).

## done: Wrap up

Post the summary comment.
````

**Frontmatter** (validated by one published JSON Schema):

- The standard AKM asset envelope — `type`, `title`, `description`, `tags`,
  `when_to_use`, `xrefs`, `updated`/`timestamp`, and the OKF v0.2 families
  (`generated`, `verified`, `provenance`, `status`, `stale_after`) — via a
  shared `$ref`'d envelope definition (see §2.5).
- The orchestration keys, adopted from program v2 with these changes:
  - `version:` and `name:` are **dropped**. Identity is the ref (like every
    asset); the frozen plan already versions execution semantics (IR v3), and
    the authoring schema evolves additively like every other asset type.
  - `steps[].unit.instructions` / `steps[].map.unit.instructions` are
    **removed** — instructions live only in the body.
  - A step with no `map:` and no `route:` **is** a unit step; a bare
    `- id: validate` is the complete minimal declaration. `unit:` remains as
    the optional bag of dispatch overrides (engine/model/llm/timeout/retry/
    on_error/env/isolation/output).
  - One id grammar everywhere: the program's `[A-Za-z_][A-Za-z0-9_-]*`
    (expression-addressable, `.gate`-collision-free). The markdown grammar's
    dotted ids die.
  - Keys stay snake_case (`on_error`, `max_loops`, `stale_after`) — the
    existing AKM/OKF frontmatter convention (`when_to_use`).

**Body** (two rules):

1. Every level-2 heading must be `## <step-id>` or `## <step-id>: <display
   title>`, where `<step-id>` is a declared step. (The id grammar contains no
   `:`, so the split is unambiguous. Fenced code blocks are skipped when
   scanning for headings, as `looksLikeWorkflow` already does.)
2. A unit or map step **must** have a section (its instructions / per-item
   template, taken byte-exact to the next H2 or EOF). A route step **may**
   have one (documentation only — routes dispatch nothing). Everything before
   the first H2 is free preamble.

Nothing else. No `Step ID:` lines, no `# Workflow:` prefix, no reserved H3
names. H1 and all H3+ headings are ordinary content.

### 2.3 Semantics: nothing below the frontend changes

Compilation targets the existing `WorkflowPlanDraft` exactly as
`compileWorkflowProgram` does today, with instructions supplied from body
sections (as `SourceRef`-spanned text, which the markdown parser already
produces). Freeze, engine, journal, classic `start`/`next`/`complete` driver,
brief/report, leases, budgets: untouched. The classic human-driven mode reads
the same compiled plan it reads today.

Two deliberate behavior changes, both fixing traps:

- **Templating is real everywhere.** Body instructions are `${{ … }}`
  templates (parse-once, closed grammar). The fake `{{ … }}` convention dies
  with the format that hosted it.
- **Escape syntax.** Because prose bodies legitimately contain literal
  `${{` (e.g. a workflow *about* GitHub Actions), the expression grammar
  gains its first escape: `$${{` → literal `${{`. Single-pass, deterministic,
  and closes the "no way to write a literal opener" gap the program format
  shipped with. (Open question §5.1 if the owner prefers to keep the v1
  no-escape stance.)

### 2.4 Gate criteria stay in frontmatter

Criteria are part of the control contract (judged, `max_loops`-bounded,
`required`-blocking), so they live with the graph. The markdown format's
`### Completion Criteria` magic subsection dies. This is the one place prose
moves *into* frontmatter; criteria are short judge-facing strings, not
documents.

### 2.5 Validation model — and the end of the allowlist special case

One published JSON Schema (`schemas/akm-workflow.json`, repurposed) validates
the entire frontmatter. Its top level `$ref`s a new **shared asset-envelope
schema** — the common keys every AKM markdown type carries, including the
machine-stamped OKF families. Consequences:

- Workflow stops being the only type with a bespoke closed key set; "closed"
  becomes `additionalProperties: false` over `envelope ∪ workflow-keys`,
  defined in one place.
- A future machine-stamped key is added to the envelope definition **once**,
  and every schema-validated type inherits it — the #730 fallback dance and
  the stale hand-written "Use only: …" message become structurally
  impossible. The promotion-path re-validation backstop can be deleted.
- Editors get frontmatter completion/validation for free via the published
  schema (yaml-language-server association), which no bespoke markdown
  grammar can offer.

Semantic passes the schema cannot express keep their existing implementations
from the program parser, retargeted at frontmatter: duplicate ids, route
targets exist / are forward-only / are unique, expression references resolve
to earlier steps, timeout format, retry-reason taxonomy, resource limits.
Body checks are the two rules of §2.2 plus template parsing.

Recognition simplifies to: frontmatter `type: workflow`, or residence under
`workflows/` — no content sniffing. `WORKFLOW_EXTENSIONS` shrinks to `.md`.

### 2.6 OKF cohesion

The unified asset **is** an OKF-shaped document: frontmatter + markdown body.
Provenance stamping applies with zero special-casing. A third-party OKF
reader sees a normal document — title, prose overview, step sections —
degrading gracefully to readable procedure documentation, which is exactly
the right fallback for a workflow. `status: draft` / `stale_after` become
meaningful on workflows for free (e.g. a future rule that draft workflows
refuse `run` — noted, not proposed here).

## 3. What gets deleted

- `src/workflows/parser.ts`'s grammar: `# Workflow:` / `## Step:` /
  `Step ID:` / reserved H3s (the frontmatter/toc plumbing is reused by the
  new body binder).
- `looksLikeWorkflow` / `looksLikeWorkflowProgram` sniffing and the
  `"markdown" | "yaml-program"` mode split in the adapter, matchers, loader,
  and proposal validator.
- The YAML program as a distinct on-disk format: `program/parser.ts`'s
  field-validation logic survives as the frontmatter semantic passes; its
  file-level concerns (version key, name key, `.yaml` handling) die.
- The workflow-only closed frontmatter allowlist and its hand-maintained
  error string (`src/workflows/validator.ts`), replaced by the schema.
- The `#730` promotion-path re-validation fallback for closed-allowlist
  types.
- One of the two authoring templates, one of the two doc sections, the
  extension-collapse logic beyond `.md`, `isWorkflowProgramPath`.
- The markdown formats' divergent id grammar and untyped `params:` shape.

Net: two formats' worth of parsing/dispatch (~1,800 lines) replaced by one
frontmatter schema + semantic passes + a two-rule body binder, with the IR,
engine, and expression language reused unchanged.

## 4. Blast radius (all unreleased surfaces)

- **Templates**: `src/assets/workflows/workflow-template.md` and
  `workflow-program-template.yaml` → one new template.
- **Examples**: 9 example-stash markdown workflows rewritten (their `{{ … }}`
  moustaches become real `${{ … }}` expressions — an upgrade, not a port).
- **Fixtures/goldens**: `format-family-goldens/`, `all-types` stash fixtures,
  workflow parser/program test suites (program-parser tests largely port —
  same vocabulary, new host).
- **Docs**: `docs/reference/workflows.md` collapses its two format sections
  into one; the "Writing a workflow" section shrinks.
- **Index cache**: `workflow_documents` re-derives on reindex (unreleased).
- **CLI**: `akm workflow create` emits the unified template; `create
  <name>.yaml` dies.

## 5. Open questions for the owner

1. **`$${{` escape** — adopt now (recommended: prose bodies make literal
   `${{` a real need) or keep the v1 no-escape stance and accept the lint
   error as the answer?
2. **Gate criteria in frontmatter** (recommended, §2.4) vs body bullets under
   a reserved subsection — the latter reads better in rendered markdown but
   reintroduces exactly one magic H3, and splits the gate contract across two
   surfaces.
3. **Route-step display titles** — via optional doc-only body sections
   (recommended) or a `title:` key on route steps only?
4. **Step heading form** — `## <id>: <title>` (recommended) vs `## <id>`
   only. The former keeps rendered docs human-titled without a frontmatter
   duplicate.

## 6. Non-goals

- No engine, IR, freeze, journal, lease, or brief/report changes.
- No new orchestration capabilities (no new step kinds, reducers, or
  expression roots).
- No change to task/env/script/secret formats; task remains a YAML type —
  tasks are machine schedules, not prose procedures, and their format fits.
