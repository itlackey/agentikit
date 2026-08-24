// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { compileWorkflowPlan, type WorkflowPlanDraft } from "../../src/workflows/ir/compile";
import { computePlanHash } from "../../src/workflows/ir/plan-hash";
import { WORKFLOW_IR_VERSION, type WorkflowPlanGraph } from "../../src/workflows/ir/stored-plan-v3";
import type { WorkflowError } from "../../src/workflows/schema";
import { compileWorkflowSource } from "../../src/workflows/source-ir/compile";
import type { WorkflowSourceIrV1 } from "../../src/workflows/source-ir/schema";
import { freezeWorkflow } from "../_helpers/workflow";

/**
 * Both authoring adapters compile to source IR, then `compileWorkflowPlan`
 * lowers that one representation into the structural
 * draft — reference-grammar validation, earlier-step checks, source selectors
 * retained for the single resolve/freeze boundary). This replaces the
 * pre-unification split between the classic linear-markdown compiler and the
 * YAML workflow-program compiler — both lowered into the same
 * `WorkflowPlanDraft` shape, which this file now exercises through the one
 * remaining frontend.
 */

function parseMarkdown(markdown: string, path = "workflows/test.md"): WorkflowSourceIrV1 {
  const result = compileWorkflowSource(markdown, { path });
  if (!result.ok) {
    throw new Error(`source compile failed: ${result.errors.map((e) => `${e.line}: ${e.message}`).join(" | ")}`);
  }
  return result.ir;
}

function compileOk(markdown: string, title = "t", path = "workflows/test.md"): WorkflowPlanDraft {
  const result = compileWorkflowPlan(parseMarkdown(markdown, path), title);
  if (!result.ok) {
    throw new Error(`compile failed: ${result.errors.map((e) => `${e.line}: ${e.message}`).join(" | ")}`);
  }
  return result.plan;
}

function compileErrors(markdown: string, title = "t", path = "workflows/test.md"): WorkflowError[] {
  const result = compileWorkflowPlan(parseMarkdown(markdown, path), title);
  if (result.ok) throw new Error("expected compile errors, got a plan");
  return result.errors;
}

/**
 * Errors from EITHER stage: reference-syntax checks on `map.over`/`route.input`
 * now run at PARSE time (`parser.ts`'s `checkReferenceSyntax`), while the
 * earlier-step / self-reference semantic checks stay at COMPILE time
 * (`ir/compile.ts`). Tests that only care about the accumulated error set
 * (not which stage produced it) go through this helper instead of
 * `compileErrors`, which requires a clean parse.
 */
function errorsFrom(markdown: string, title = "t", path = "workflows/test.md"): WorkflowError[] {
  const source = compileWorkflowSource(markdown, { path });
  if (!source.ok) return source.errors.map(({ line, message }) => ({ line, message }));
  const compiled = compileWorkflowPlan(source.ir, title);
  if (compiled.ok) throw new Error("expected errors, got a plan");
  return compiled.errors;
}

// ─────────────────────────────────────────────────────────────────────────────
// Structural golden (stable CLI contract) — two plain unit steps, one gated
// ─────────────────────────────────────────────────────────────────────────────

const LINEAR_MD = `---
type: workflow
steps:
  - id: build
  - id: deploy
---

## build

Build the artifact.

### gate

- artifact exists

## deploy

Deploy the artifact.
`;

describe("compileWorkflowPlan — structural golden", () => {
  test("compiles to the golden structural plan", () => {
    expect(compileWorkflowPlan(parseMarkdown(LINEAR_MD), "Ship it")).toEqual({
      ok: true,
      warnings: expect.any(Array),
      plan: {
        title: "Ship it",
        steps: [
          {
            stepId: "build",
            // The unified format has no titles anywhere — a step is its id.
            title: "build",
            sequenceIndex: 0,
            root: {
              kind: "unit",
              id: "build",
              instructions: "Build the artifact.",
              templating: "verbatim",
              onError: "fail",
              source: { path: "workflows/test.md", start: 4, end: 4 },
            },
            gate: { kind: "gate", id: "build.gate", stepId: "build", criteria: ["- artifact exists"] },
          },
          {
            stepId: "deploy",
            title: "deploy",
            sequenceIndex: 1,
            root: {
              kind: "unit",
              id: "deploy",
              instructions: "Deploy the artifact.",
              templating: "verbatim",
              onError: "fail",
              source: { path: "workflows/test.md", start: 5, end: 5 },
            },
            gate: { kind: "gate", id: "deploy.gate", stepId: "deploy", criteria: [] },
          },
        ],
      },
    });
  });

  test("keeps executable versioning out of the unresolved draft", () => {
    expect(WORKFLOW_IR_VERSION).toBe(3);
    const result = compileWorkflowPlan(parseMarkdown(LINEAR_MD), "Ship it");
    if (!result.ok) throw new Error("expected ok compile");
    expect(result.plan).not.toHaveProperty("irVersion");
  });

  test("compilation is deterministic (same document → same plan)", () => {
    const doc = parseMarkdown(LINEAR_MD);
    expect(compileWorkflowPlan(doc, "Ship it")).toEqual(compileWorkflowPlan(doc, "Ship it"));
  });

  test("an empty gate section compiles with no validation criteria", () => {
    const emptyGate = LINEAR_MD.replace("### gate\n\n- artifact exists", "### gate\n");
    const result = compileWorkflowPlan(parseMarkdown(emptyGate), "Ship it");
    if (!result.ok) throw new Error("expected ok compile");
    expect(result.plan.steps[0]?.gate.criteria).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Full-vocabulary golden (defaults merging, map/vote, route shape, typed artifacts)
// ─────────────────────────────────────────────────────────────────────────────

const FULL_WF = `---
type: workflow
description: Review changed files and route the outcome
params:
  changed_files: { type: array, items: { type: string } }
defaults: { engine: default-agent, model: balanced, timeout: 10m, on_error: continue }
steps:
  - id: discover
    unit:
      output: { type: object, properties: { files: { type: array } }, required: [files] }
  - id: review
    map:
      over: steps.discover.output.files
      concurrency: 8
      reducer: vote
      unit: { engine: reviewer, model: deep, timeout: 5m, retry: { max: 1, on: [timeout, llm_rate_limit] }, on_error: fail }
    output: { type: object, properties: { verdict: { type: string } } }
    gate: { max_loops: 2 }
  - id: triage
    route:
      input: steps.review.output.verdict
      when: [{ match: pass, step: ship }, { match: fail, step: rework }]
      default: rework
  - id: ship
  - id: rework
---

## discover

List the files that need review.

### gate

every target is listed

## review

Review the assigned issue for bugs.

### gate

every changed file has a verdict

## triage

Route on the verdict.

## ship

Ship it.

## rework

Rework it.
`;

describe("compileWorkflowPlan — full-vocabulary golden", () => {
  test("the canonical workflow-format example parses and compiles", () => {
    const specPath = path.resolve(import.meta.dir, "../../docs/architecture/specs/workflow-format-unification.md");
    const spec = fs.readFileSync(specPath, "utf8");
    const example = spec.match(/### 2\.2 The format\n\n````markdown\n([\s\S]*?)\n````/);
    if (!example?.[1]) throw new Error("canonical workflow example not found");
    expect(compileOk(example[1], "github-issues", specPath).steps).toHaveLength(6);
  });

  test("compiles the structural plan without executable engine fields", () => {
    const plan = compileOk(FULL_WF, "review-changes", "workflows/test.md");
    expect(plan.title).toBe("review-changes");
    expect(plan.params).toEqual(["changed_files"]);
    expect(plan.steps).toHaveLength(5);

    const discover = plan.steps[0]!;
    const review = plan.steps[1]!;
    const triage = plan.steps[2]!;
    const ship = plan.steps[3]!;
    const rework = plan.steps[4]!;

    // Step 1: selectors remain on the parsed source until engine freezing;
    // instructions are ALWAYS "verbatim" now — the unified format has no
    // second templated frontend (workflow-format-unification, spec §2.3).
    expect(discover).toEqual({
      stepId: "discover",
      title: "discover",
      sequenceIndex: 0,
      root: {
        kind: "unit",
        id: "discover",
        instructions: "List the files that need review.",
        templating: "verbatim",
        schema: { type: "object", properties: { files: { type: "array" } }, required: ["files"] },
        onError: "continue",
        source: expect.objectContaining({ path: "workflows/test.md" }),
      },
      gate: { kind: "gate", id: "discover.gate", stepId: "discover", criteria: ["every target is listed"] },
    });

    // Step 2: map step — per-unit declarations WIN over the defaults.
    expect(review).toEqual({
      stepId: "review",
      title: "review",
      sequenceIndex: 1,
      root: {
        kind: "map",
        id: "review.map",
        over: "steps.discover.output.files",
        template: {
          kind: "unit",
          id: "review.unit",
          instructions: "Review the assigned issue for bugs.",
          templating: "verbatim",
          retry: { max: 1, on: ["timeout", "llm_rate_limit"] },
          onError: "fail",
          source: expect.objectContaining({ path: "workflows/test.md" }),
        },
        concurrency: 8,
        reducer: "vote",
        source: expect.objectContaining({ path: "workflows/test.md" }),
      },
      outputSchema: { type: "object", properties: { verdict: { type: "string" } } },
      gate: {
        kind: "gate",
        id: "review.gate",
        stepId: "review",
        criteria: ["every changed file has a verdict"],
        maxLoops: 2,
      },
    });

    // Step 3: route step — no root, bare reference input, when as a record.
    expect(triage).toEqual({
      stepId: "triage",
      title: "triage",
      sequenceIndex: 2,
      route: {
        input: "steps.review.output.verdict",
        when: { pass: "ship", fail: "rework" },
        defaultStepId: "rework",
      },
      gate: { kind: "gate", id: "triage.gate", stepId: "triage", criteria: [] },
    });
    expect(triage.root).toBeUndefined();

    // Steps 4/5: policy defaults are structural; execution settings freeze later.
    for (const step of [ship, rework]) {
      if (step.root?.kind !== "unit") throw new Error("expected unit root");
      expect(step.root.onError).toBe("continue");
    }
  });

  test("without a defaults block, units are fail-fast", () => {
    const plan = compileOk(`---
type: workflow
steps:
  - id: a
---

## a

Do the thing.
`);
    const root = plan.steps[0]!.root;
    if (root?.kind !== "unit") throw new Error("expected unit root");
    expect(root.onError).toBe("fail");
    expect(root).not.toHaveProperty("invocation");
  });

  test(`defaults "timeout: none" remains source configuration until freeze`, () => {
    const plan = compileOk(`---
type: workflow
defaults: { timeout: none }
steps:
  - id: a
---

## a

Do the thing.
`);
    const root = plan.steps[0]!.root;
    if (root?.kind !== "unit") throw new Error("expected unit root");
    expect(root).not.toHaveProperty("timeoutMs");
  });

  test("node ids are unique and stable across the plan", () => {
    const plan = compileOk(FULL_WF, "review-changes", "workflows/test.md");
    const ids: string[] = [];
    for (const step of plan.steps) {
      ids.push(step.gate.id);
      if (step.root?.kind === "unit") ids.push(step.root.id);
      if (step.root?.kind === "map") ids.push(step.root.id, step.root.template.id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a budget block is carried onto the plan (and absent otherwise)", () => {
    const withBudget = compileOk(`---
type: workflow
budget: { max_tokens: 5000, max_units: 7 }
steps:
  - id: a
---

## a

Do the thing.
`);
    expect(withBudget.budget).toEqual({ maxTokens: 5000, maxUnits: 7 });
    // The budget is retained for the freeze boundary.
    const withoutBudget = compileOk(`---
type: workflow
steps:
  - id: a
---

## a

Do the thing.
`);
    expect(withoutBudget.budget).toBeUndefined();
    expect(withBudget).not.toEqual(withoutBudget);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reference validation (map.over / route.input / inputs[])
// ─────────────────────────────────────────────────────────────────────────────
//
// SEMANTIC CHANGE (workflow-format-unification, spec §2.3): the closed
// reference grammar now lives in exactly three frontmatter positions
// (`map.over`, `route.input`, `inputs[]`) — prose is NEVER scanned for it.
// The pre-unification tests that exercised references INSIDE instructions
// (`${{ steps.b.output.x }}` in prose) are ported onto `inputs:` — the new
// declared-input surface that replaced prose splicing as how a step names an
// upstream artifact — since that is the closest surviving equivalent
// (a step-level, non-map/route reference to a prior step's output). Tests
// about `item` / `item_index` in prose are DELETED outright below; there is
// no equivalent — those roots no longer exist in the language at all (they
// are not merely restricted to map units, per spec §2.3).

describe("compileWorkflowPlan — expression validation", () => {
  test("steps.<id> must reference an EARLIER step (forward reference rejected)", () => {
    const errors = compileErrors(`---
type: workflow
steps:
  - id: a
    inputs: [steps.b.output.x]
  - id: b
---

## a

Use it.

## b

hi
`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("steps.b.output.x");
    expect(errors[0]!.message).toContain("does not come before this step");
  });

  test("steps.<id> naming its own step is rejected", () => {
    const errors = compileErrors(`---
type: workflow
steps:
  - id: a
    inputs: [steps.a.output]
---

## a

Use it.
`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("does not come before this step");
  });

  test("steps.<id> naming an unknown step is rejected with a distinct message", () => {
    const errors = compileErrors(`---
type: workflow
steps:
  - id: a
    inputs: [steps.ghost.output]
---

## a

Use it.
`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain(`"ghost" is not a step in this workflow`);
  });

  // DELETED (workflow-format-unification, spec §2.3): the pre-unification
  // "params.<name> outside the declared block compiles — presence is a
  // run-scope concern" case was tested against an INSTRUCTIONS reference.
  // Prose is never scanned for references any more, so that specific surface
  // is gone; the identical run-scope-concern property for the two whole-value
  // positions that still carry the grammar (`map.over`/`route.input`) is
  // covered by the next test.

  test("undeclared params.<name> in map.over and route.input compiles too (run-scope concern)", () => {
    const plan = compileOk(`---
type: workflow
params:
  files: { type: array }
steps:
  - id: route
    route:
      input: params.mode
      when: [{ match: a, step: fan }]
  - id: fan
    map:
      over: params.filez
---

## route

r

## fan

f
`);
    expect(plan.params).toEqual(["files"]);
  });

  test("a declared param reference compiles cleanly", () => {
    const plan = compileOk(`---
type: workflow
params:
  files: { type: array }
steps:
  - id: fan
    map:
      over: params.files
---

## fan

Review the assigned item.
`);
    expect(plan.params).toEqual(["files"]);
  });

  test("with NO params block, any params.<name> reference is accepted (run-scope concern)", () => {
    // Documented: a workflow that declares no params block keeps the prior
    // behavior — presence is validated at run/start, not compile.
    const plan = compileOk(`---
type: workflow
steps:
  - id: a
    route:
      input: params.anything
      when: [{ match: x, step: b }]
  - id: b
---

## a

r

## b

d
`);
    expect(plan.params).toBeUndefined();
  });

  // DELETED (workflow-format-unification, spec §2.3): `item` / `item_index`
  // are deleted from the reference grammar entirely — not merely restricted
  // to map units. There is no "valid inside a map unit, invalid outside" case
  // any more: neither position exists anywhere in the language, and prose is
  // never scanned for it regardless of step kind. A map unit's item/index
  // reach it as attached context (`buildUnitPrompt` in
  // `src/workflows/exec/step-work.ts`), never as a resolved reference — see
  // `native-executor.test.ts` and `step-work.test.ts` for the new contract.

  test("map.over referencing an earlier step's output is valid", () => {
    const plan = compileOk(`---
type: workflow
steps:
  - id: discover
  - id: m
    map:
      over: steps.discover.output.files
---

## discover

Find files.

## m

Review the assigned item.
`);
    const root = plan.steps[1]!.root;
    if (root?.kind !== "map") throw new Error("expected map root");
    expect(root.over).toBe("steps.discover.output.files");
  });

  test("errors accumulate across steps instead of stopping at the first", () => {
    // Ported onto two independently-invalid whole-value references (an
    // unknown-step `inputs:` and a forward-referencing `map.over`) since
    // instructions can no longer carry a reference at all — see the module
    // doc above.
    const errors = compileErrors(`---
type: workflow
steps:
  - id: a
    inputs: [steps.zzz.output]
  - id: b
    map:
      over: steps.later.output
  - id: later
    inputs: [steps.b.output]
---

## a

x

## b

y

## later

z
`);
    expect(errors.length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Whole-value reference enforcement (map.over, route.input)
// ─────────────────────────────────────────────────────────────────────────────
//
// SEMANTIC CHANGE: with the `${{ … }}` delimiter gone, "surrounded by literal
// text" is expressed as "the string isn't a bare reference at all" — the
// parser's closed two-root grammar (`program/expressions.ts`) rejects it as
// an unknown root rather than the old "single whole-value expression"
// wording. The underlying property (only a single whole-value reference is
// legal here, never prose-with-an-expression-inside) is unchanged.

describe("compileWorkflowPlan — whole-value references", () => {
  test("map.over with surrounding literal text is rejected", () => {
    const errors = errorsFrom(`---
type: workflow
params:
  files: { type: array }
steps:
  - id: m
    map:
      over: "the params.files list"
---

## m

Do the assigned item.
`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("over");
    expect(errors[0]!.message).toContain("Unknown root");
  });

  test("map.over as a bare name (no reference grammar) is rejected — P1 ambient lookup is gone", () => {
    const errors = errorsFrom(`---
type: workflow
steps:
  - id: m
    map:
      over: changed_files
---

## m

Do the assigned item.
`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("Unknown root");
  });

  test("route.input with surrounding literal text is rejected", () => {
    const errors = errorsFrom(`---
type: workflow
steps:
  - id: a
  - id: r
    route:
      input: "verdict is steps.a.output.verdict"
      when: [{ match: pass, step: done }]
  - id: done
---

## a

Classify.

## r

Route.

## done

Done.
`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("route.input");
    expect(errors[0]!.message).toContain("Unknown root");
  });

  test("route.input referencing a later step is rejected", () => {
    const errors = compileErrors(`---
type: workflow
steps:
  - id: r
    route:
      input: steps.done.output.verdict
      when: [{ match: pass, step: done }]
  - id: done
---

## r

Route.

## done

Done.
`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("does not come before this step");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Plan hash
// ─────────────────────────────────────────────────────────────────────────────

// DELETED (workflow-format-unification): the pre-unification "both frontends
// hash through the same function (markdown plan hashes too)" test proved two
// DIFFERENT frontends (classic linear markdown + YAML program) shared one
// hashing path. There is only one frontend now, so that cross-frontend proof
// no longer has a second frontend to compare against; the determinism +
// key-order-independence properties it also covered are pinned by the two
// tests above and by `freezeWorkflow`'s exclusive use in every other suite.
describe("computePlanHash", () => {
  const executableWf = FULL_WF.replace("default-agent", "test-agent").replace("engine: reviewer", "engine: test-agent");

  test("same workflow → same hash (deterministic across compiles)", () => {
    const a = freezeWorkflow(executableWf, "workflows/test.md");
    const b = freezeWorkflow(executableWf, "workflows/test.md");
    const hash = computePlanHash(a);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(computePlanHash(b)).toBe(hash);
  });

  test("hash is key-order independent (canonical sorted-keys JSON)", () => {
    const plan = freezeWorkflow(executableWf, "workflows/test.md");
    const reordered = Object.fromEntries(Object.entries(plan).reverse()) as WorkflowPlanGraph;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(plan));
    expect(computePlanHash(reordered)).toBe(computePlanHash(plan));
  });

  test("a different workflow → a different hash", () => {
    const a = freezeWorkflow(executableWf, "workflows/test.md");
    const b = freezeWorkflow(executableWf.replace("Ship it.", "Ship it now."), "workflows/test.md");
    expect(computePlanHash(b)).not.toBe(computePlanHash(a));
  });
});
