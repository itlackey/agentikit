# Author's Guide: Writing Workflows

This guide walks through writing and testing a workflow definition: the
markdown structure, a minimal complete example, common authoring mistakes,
and how to verify gates and outputs before you publish. It assumes you
already know what a workflow is; for the exhaustive, exact-syntax reference
— every frontmatter key, the reference grammar, gates, and outputs — see
[Workflow Schema](../reference/workflow-schema.md). For operating a run once
it's written, see [Running Workflows](../guides/run-workflows.md).

## Start from the template

A workflow is an ordinary AKM markdown asset — OKF-conformant frontmatter
plus a markdown body — whose frontmatter carries the orchestration graph
(params, and how each step dispatches, fans out, routes, and gates) and whose
body carries each step's instructions and gate rubric under plain headings,
joined to the frontmatter by step id. There is **one** format: no separate
YAML "program" surface, no `.yaml`/`.yml` workflow files.

Use `akm workflow create --print` to print a valid starter, then edit it and
register it with `akm workflow create`:

```sh
akm workflow create my-release --print   # Print the template, without writing
akm workflow create my-release --from ./my-release.md
akm lint --type workflows                # Check for structural errors before using it
```

## A minimal complete example

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

Walking through it: `validate` and `build` are both bare unit steps — neither
declares `unit:`, `map:`, or `route:`, so each is "still a unit step," the
minimal declaration. `build` names `steps.validate.output` in `inputs:`, so
the engine attaches `validate`'s result to `build`'s dispatched context, and
`build`'s own re-dispatch on a resumed run is keyed to that exact slice — not
the whole run. `validate` has a `### gate`; `build` does not, so `build`
completes as soon as its unit succeeds, with no verification pass.

For a richer example — fan-out with `map`, `route`-based branching, retries,
and a run `budget` — see
[Workflow Schema: Richer example](../reference/workflow-schema.md#richer-example).

## Common authoring mistakes

- **Templating prose.** There is no `${{ … }}`/`{{ … }}` interpolation
  anywhere in a workflow body. Write instructions in plain language that
  refer to attached context — "using the intake step's artifact attached to
  this unit" — never by splicing a value into the string. See
  [Workflow Schema: The reference grammar](../reference/workflow-schema.md#the-reference-grammar).
- **Mismatched or missing step headings.** Every `## <step-id>` must match a
  step declared in frontmatter exactly — no titles, no `Step:`/`Step ID:`
  lines, no `# Workflow:` prefix on the H1.
- **A `unit`/`map` step with no body section.** Its instructions (or, for a
  map step, its per-item template) are required — a `route`-only step is the
  one case a body section is optional.
- **Misplaced or misspelled `### gate`.** It is the format's single reserved
  marker, and it must be a `###` sub-heading inside the step's own section.
  An empty `### gate` section is the same as omitting it — no verification
  runs.
- **Referencing an item outside a map unit.** `item`/`item_index` are not
  part of the reference language anywhere — they only arrive as attached
  context inside that map step's own unit template.
- **Backward routes.** Every `route` target (`when.step`, `default`) must be
  a step declared *later* in the workflow; "loop back until it passes" is a
  bounded `### gate` on the step doing the work, not a route back to an
  earlier step.
- **Referencing an unknown step or param.** `akm lint --type workflows`
  checks every bare reference statically (unknown step, unknown param, bad
  path) — run it before you rely on a workflow working.

## Typing what a step returns

A step's `output:` (and each `params:` entry) is a JSON Schema, and the engine
validates the step's artifact against it before the step can complete. The
runtime enforces a **bounded subset** of JSON Schema — anything outside it is
an authoring error at `akm lint`, never a silent no-op, because a gate
depending on a schema that constrains nothing is worse than a loud failure.

Enforced: `type`, `enum`, `properties`, `required`, `items`,
`additionalProperties: false`, `minItems`, `maxItems`, `minLength`,
`maxLength`, `minimum`, `maximum`, `pattern`, and the combinators `allOf`,
`anyOf`, `oneOf`, `not`.

```yaml
  - id: release
    output:
      type: object
      required: [version, verdict]
      additionalProperties: false
      properties:
        version: { type: string, pattern: '^\d+\.\d+\.\d+$' }
        verdict: { type: string, enum: [pass, fail] }
        detail:
          oneOf:
            - { type: string, minLength: 1 }
            - { type: "null" }
```

Two things to know about `pattern`:

- **It is really evaluated.** A unit that returns `version: "v1.2"` fails the
  step with the mismatch in its summary, which a bounded `### gate` can feed
  back as corrective input.
- **Patterns are screened for safety before they ever run.** A regex that can
  backtrack catastrophically is rejected while you are authoring it, with the
  reason named. In practice: don't repeat a group that itself contains a
  quantifier or alternation (`(a+)+`, `(a|a)*`), and don't put two repeats
  that match the same characters next to each other (`.*.*`, `\d+\w+`).
  `(foo|bar)+`, `^v?\d+(\.\d+)*$` and `^[a-f0-9]{40}$` are all fine. Patterns
  are limited to 256 characters and are matched against strings of at most
  4096 characters.

Still outside the subset (each fails lint with the keyword named and a
suggested replacement): `$ref`/`$defs` — inline the schema instead, since
nothing resolves references; `const` — use a single-value `enum`; `format` —
annotation-only in JSON Schema 2020-12, so use `pattern` for something the
runtime actually checks; `patternProperties`, `if`/`then`/`else`,
`uniqueItems`, `multipleOf`, tuple-form `items`, and schema-form
`additionalProperties` (only `additionalProperties: false` is enforced).
Annotation keywords — `description`, `title`, `default`, `examples` — always
pass through untouched, and documenting each property is worth the keystrokes.

If lint reports a very broken workflow, note that it prints at most the first
50 errors and then says `... N more errors not shown`. They are sorted by
line, so fix from the top and re-run — the later ones are usually fallout from
the first.

## Choosing engines and models

Set `defaults.engine`/`defaults.model` (or per-unit `unit.engine`/`unit.model`)
rather than hardcoding an exact model id, so the workflow stays
harness-agnostic. Reference semantic aliases — `fast`, `balanced`, `deep`, or
whatever your `modelAliases` config defines — in `model:` fields; see
[Workflow Schema: Model references](../reference/workflow-schema.md#model-references)
for the exact resolution order and config shape.

Point `deep` work (review, verification, judging) at `fable` — Anthropic's
tier above Opus — and keep high-volume fan-out units on `fast`/`balanced`.
The richer example's `review` map step is a good template: `deep` on the
per-item reviewer, `balanced` as the run default for everything else.

## Fan-out width

**A `map` step runs its items in parallel by default — 4 at a time as of
0.9.1.** (Earlier versions defaulted to 1, so a fan-out over 500 items crawled
through them one by one unless you said otherwise.) Map units are independent
by construction, so parallel is the honest default; the number is a modest 4
rather than "whatever the machine can take" so it stays predictable across the
machines a workflow gets shared with.

Say so explicitly when the default is wrong for a step:

```yaml
  - id: review
    map:
      over: steps.discover.output.files
      concurrency: 1     # serial — this step's units are NOT independent
```

`concurrency: 1` is a genuine opt-out and always wins. Reach for it when the
units touch a shared resource, when their side effects must happen in list
order, or when they hit an external service you must not burst. To change the
default for every workflow on a machine instead — including restoring the old
serial behavior wholesale — set
`akm config set workflow.defaultMapConcurrency 1`.

The declared width is a **ceiling, not a promise**. Three other limits clamp it
and the smallest wins: `workflow.maxConcurrency`, the selected engine's
`engines.<name>.concurrency`, and the host's CPU cap. The engine limit is the
one that surprises people: an LLM engine pointed at **localhost defaults to 1**,
because local model servers hold a single loaded model and fall over under
concurrent requests — so a `map` against a local model stays serial no matter
what the step declares, until you raise that engine's own `concurrency`. Remote
LLM endpoints default to 4. See
[Workflow Schema: Fan-out and concurrency](../reference/workflow-schema.md#fan-out-and-concurrency)
for the full table.

All of it is frozen into the run when it starts, so an in-flight or resumed run
keeps the widths it began with even if you edit config or upgrade akm.

A workflow that fans out is authorizing **N parallel agents**, not one — the
same trust model described in
[Running Workflows: workflow sources are executed code](run-workflows.md#security-workflow-sources-are-executed-code)
applies with multiplied blast radius. Give the workflow explicit safety and
parameter metadata (document every `params` entry, keep destructive steps
described plainly in the body) so a reader — human or agent — can judge that
blast radius before running it.

## Verify before you publish

1. **Lint the structure.**

   ```sh
   akm lint --type workflows
   ```

   This catches the body-rule violations above, plus every static reference
   check (unknown step, unknown param, bad path, backward route).

2. **Run it for real.** A dry inspection of the markdown doesn't tell you
   whether a gate actually rejects bad output or an `output` schema actually
   matches what units return. Run the workflow against representative
   params:

   ```sh
   akm workflow run workflows/my-release --version 1.2.3
   ```

3. **Inspect the evidence.** Check that each step's promoted artifact is
   what you expect, and that a gate's rubric is judging that artifact, not
   engine prose:

   ```sh
   akm workflow status <run-id> --units
   ```

   `--units` shows per-unit diagnostics (status, `failure_reason`, raw
   result/error text) without polluting the deterministic artifact a gate
   judges — see
   [Running Workflows: Check status](run-workflows.md#check-status).

4. **Deliberately break a gate once.** Run the workflow with params you
   expect to fail validation, and confirm the gate actually rejects rather
   than silently passing — a missing `workflow.judgeEngine` or a malformed
   verdict rejects the gate rather than bypassing it (see
   [Workflow Schema: Gates and verification](../reference/workflow-schema.md#gates-and-verification)),
   so this is worth confirming once per workflow rather than assuming.

## Troubleshooting

**Every workflow run needs a selected engine.** Freezing resolves an engine
for each unit. With no `defaults.engine`, akm falls back to a config-free
`opencode-sdk` engine — provider, model, and auth come from opencode's own
configuration — and announces it once in the run's `warnings`. The fallback
needs the **`opencode` binary on PATH**: the bundled `@opencode-ai/sdk`
package is an HTTP client only and spawns `opencode serve` to have something
to talk to, so installing the npm package alone is not enough. With no
binary, freezing fails with `INVALID_CONFIG_FILE` and exit 78.

A workflow with a non-empty `### gate` additionally requires
`workflow.judgeEngine` to name a configured LLM or agent engine — the gate
judge is not covered by the fallback.

`akm setup` normally selects a default execution engine. On a bare container
or CI image, either install opencode and let the fallback apply, or choose an
engine explicitly:

```sh
npm i -g opencode-ai           # fallback route: puts `opencode` on PATH
# ...or pick an engine yourself:
akm config set engines.claude '{"kind":"agent","platform":"claude"}'
akm config set defaults.engine claude
```

## See also

- [Workflow Schema](../reference/workflow-schema.md) — exact frontmatter,
  refs, gates, and outputs syntax
- [Running Workflows](run-workflows.md) — start, inspect, resume, and abandon
  a run
- [Architecture: The Workflow Engine](../architecture/workflow-engine.md) —
  persistence, dispatch, and resume internals
- [CLI Reference](../reference/cli.md) — full flag documentation for
  `workflow create`, `run`, and `lint`
