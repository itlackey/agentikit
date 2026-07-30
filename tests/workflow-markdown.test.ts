import { describe, expect, test } from "bun:test";
import { parseWorkflow } from "../src/workflows/parser";
import type { WorkflowParseResult } from "../src/workflows/schema";

const VALID_WORKFLOW = `---
type: workflow
description: Ship a release with validation checks
tags:
  - release
  - deploy
params:
  version: { type: string, description: Version being released }
steps:
  - id: validate
  - id: deploy
---

# Ship Release

## validate

Confirm release notes, tag, and version are present.

### gate

- Release notes reviewed
- Version matches tag

## deploy

Run the deployment command and watch health checks.
`;

function parse(markdown: string, path = "workflows/test.md"): WorkflowParseResult {
  return parseWorkflow(markdown, { path });
}

function expectOk(
  result: WorkflowParseResult,
): asserts result is { ok: true; document: NonNullable<Extract<WorkflowParseResult, { ok: true }>["document"]> } {
  if (!result.ok) {
    throw new Error(`Expected ok parse, got errors: ${result.errors.map((e) => `${e.line}: ${e.message}`).join("; ")}`);
  }
}

describe("parseWorkflow", () => {
  test("parses a valid workflow document into structured steps", () => {
    const result = parse(VALID_WORKFLOW);
    expectOk(result);
    const doc = result.document;

    expect(doc.description).toBe("Ship a release with validation checks");
    expect(doc.tags).toEqual(["release", "deploy"]);
    expect(doc.params).toEqual({ version: { type: "string", description: "Version being released" } });
    expect(doc.steps).toHaveLength(2);
    expect(doc.steps[0]!.id).toBe("validate");
    expect(doc.steps[0]!.instructions?.text).toBe("Confirm release notes, tag, and version are present.");
    expect(doc.steps[0]!.gateRubric?.text).toBe("- Release notes reviewed\n- Version matches tag");
    expect(doc.steps[0]!.sequenceIndex).toBe(0);
    expect(doc.steps[1]!.gateRubric).toBeUndefined();
  });

  test("bare `- id:` with no map/route/unit is a complete minimal unit step", () => {
    const minimal = `---
type: workflow
steps:
  - id: only
---

## only

Do the one thing.
`;
    const result = parse(minimal);
    expectOk(result);
    expect(result.document.steps).toHaveLength(1);
    expect(result.document.steps[0]!.id).toBe("only");
    expect(result.document.steps[0]!.unit).toBeUndefined();
    expect(result.document.steps[0]!.map).toBeUndefined();
    expect(result.document.steps[0]!.route).toBeUndefined();
  });

  test("accepts canonical opaque xrefs in workflow frontmatter", () => {
    const withXrefs = VALID_WORKFLOW.replace(
      "params:\n",
      "xrefs:\n  - memories/project-a/deploy-order\n  - catalog//tables/customers\n  - guide#usage\nparams:\n",
    );
    expect(parse(withXrefs).ok).toBe(true);
  });

  test("rejects xrefs that are not an array of canonical asset refs", () => {
    for (const xrefs of [
      "xrefs: memories/deploy-order\n",
      "xrefs:\n  - environment:production\n",
      "xrefs:\n  - ../outside\n",
      "xrefs:\n  - memories/deploy-order\n  - 42\n",
    ]) {
      const result = parse(VALID_WORKFLOW.replace("params:\n", `${xrefs}params:\n`));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.some((error) => error.message.includes("xrefs"))).toBe(true);
    }
  });

  test("attaches accurate SourceRef line spans to steps and instructions", () => {
    const result = parse(VALID_WORKFLOW);
    expectOk(result);
    const [first, second] = result.document.steps;

    expect(first!.instructions?.source.path).toBe("workflows/test.md");
    expect(first!.instructions!.source.end).toBeLessThan(first!.gateRubric!.source.start);
    expect(first!.gateRubric!.source.start).toBeGreaterThan(first!.instructions!.source.end);
    expect(second!.instructions!.source.start).toBeGreaterThan(first!.gateRubric!.source.end);
  });

  test("rejects duplicate step ids", () => {
    const result = parse(VALID_WORKFLOW.replace("- id: deploy", "- id: validate"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.message.includes("Duplicate step id") && e.message.includes("validate"))).toBe(
      true,
    );
  });

  test("unit/map steps must have a body section", () => {
    const missingSection = VALID_WORKFLOW.replace(
      "## deploy\n\nRun the deployment command and watch health checks.\n",
      "",
    );
    const result = parse(missingSection);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.message.includes('"## deploy" body section'))).toBe(true);
  });

  test("a route step MAY omit its body section", () => {
    const routeOnly = `---
type: workflow
steps:
  - id: intake
  - id: triage
    route:
      input: steps.intake.output.status
      when: [{ match: pass, step: done }]
      default: done
  - id: done
---

## intake

Do the intake work.

## done

Post the summary.
`;
    const result = parse(routeOnly);
    expectOk(result);
    expect(result.document.steps.find((s) => s.id === "triage")?.instructions).toBeUndefined();
  });

  test("every level-2 heading must exactly match a declared step id", () => {
    const invalid = VALID_WORKFLOW.replace("## deploy\n", "## deployment\n");
    const result = parse(invalid);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.message.includes('Unexpected level-2 heading "## deployment"'))).toBe(true);
  });

  test("frontmatter gate: without a ### gate rubric is a lint error", () => {
    const invalid = VALID_WORKFLOW.replace("- id: deploy\n", "- id: deploy\n    gate: { required: true }\n");
    const result = parse(invalid);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.errors.some((e) => e.message.includes('declares frontmatter "gate:"') && e.message.includes("### gate")),
    ).toBe(true);
  });

  test("a ### gate rubric alone (no frontmatter gate:) declares a default gate", () => {
    // VALID_WORKFLOW's "validate" step already has a "### gate" rubric with no
    // frontmatter `gate:` block — this is the documented default (fail-open,
    // unbounded loops), not an error.
    const result = parse(VALID_WORKFLOW);
    expectOk(result);
    const validate = result.document.steps.find((s) => s.id === "validate")!;
    // The rubric's presence alone declares the gate; the frontmatter control
    // object defaults to `{}` (fail-open, unbounded loops).
    expect(validate.gate).toEqual({});
    expect(validate.gateRubric).toBeDefined();
  });

  test("rejects unsupported workflow frontmatter keys", () => {
    const invalid = VALID_WORKFLOW.replace("type: workflow\n", "type: workflow\nmodel: gpt-5\n");
    const result = parse(invalid);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.message.includes('"model"'))).toBe(true);
  });

  test("rejects an invalid step id (dots forbidden, one grammar everywhere)", () => {
    const invalid = VALID_WORKFLOW.replace("- id: validate", "- id: valid.ate");
    const result = parse(invalid);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.message.includes("invalid id"))).toBe(true);
  });

  test("collects every error in one pass instead of stopping at the first", () => {
    const broken = `---
type: workflow
steps:
  - id: a b
  - id: c d
---

## a b

x
`;
    const result = parse(broken);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const idErrors = result.errors.filter((e) => e.message.includes("invalid id"));
    expect(idErrors.length).toBeGreaterThanOrEqual(2);
  });
});
