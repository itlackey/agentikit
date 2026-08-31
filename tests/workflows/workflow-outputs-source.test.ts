// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P3b Lane B TESTS — workflow `outputs:` authoring, compile, and freeze (spec
 * docs/plans/specs/p3b-child-executor.md §4.2, rows B-01…B-17; named in §7's
 * new-suites table as this file). Companion runtime-resolution coverage
 * (B-18…B-27) lives in
 * tests/integration/workflows/workflow-outputs-runtime.test.ts; the
 * freeze-time child-output reference check (B-28…B-32) lives in
 * tests/workflows/child-output-references.test.ts.
 *
 * RED phase: `outputs:` is not yet a recognized `WORKFLOW_KEYS` entry
 * (`src/workflows/parser.ts`), `WorkflowSourceIrV1` has no `outputs` field
 * (`src/workflows/source-ir/schema.ts`), `WorkflowPlanDraft` has no
 * `outputs` field (`src/workflows/ir/compile.ts`), and
 * `WorkflowPlanGraphV4`/`decodeWorkflowPlanV4` (`src/workflows/ir/schema-v4.ts`)
 * neither carry nor accept one — every positive-path assertion below
 * (parses / compiles / freezes / decodes) fails today.
 *
 * No `@ts-expect-error` directive is needed anywhere in this file, mirroring
 * `tests/workflows/plan-v5-schema.test.ts`'s and
 * `tests/workflows/child-workflow-freeze.test.ts`'s precedent for this exact
 * kind of red-phase coverage:
 *
 *   - Grammar/compile-level rows (B-03…B-10) drive the REAL, already-existing
 *     `compileWorkflowSource` / `compileWorkflowPlan` functions with plain
 *     markdown/YAML strings — `outputs:` is just untyped frontmatter content
 *     at that boundary, so there is nothing to reference that fails to
 *     type-check. `outputs:` is authoring-surface-only (B-N4): it never
 *     reaches `parseGithubWorkflowSource`'s closed `ROOT_KEYS`, so a
 *     GitHub-shaped `.yml` document is rejected exactly like any other
 *     unrecognized root key today, unchanged (B-10, PRESERVE).
 *   - Decode-level rows (B-11…B-17) build a fresh, independently-valid plan
 *     via the existing `freezeWorkflow` test helper, then splice a plain JSON
 *     `outputs` value onto the CLONED wire object (`JSON.parse`/`JSON.stringify`
 *     round trips, typed `any`) before calling `decodeWorkflowPlanV4(input:
 *     unknown, …)` — never through a not-yet-existing `FrozenWorkflowOutput`
 *     TypeScript interface. Reading a field back off a decoded plan goes
 *     through a single `as unknown as DecodedOutputsView` cast, always
 *     type-legal.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, resetConfigCache } from "../../src/core/config/config";
import { UsageError } from "../../src/core/errors";
import { akmIndex } from "../../src/indexer/indexer";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { compileWorkflowPlan, type WorkflowPlanCompileResult } from "../../src/workflows/ir/compile";
import { compileResolveFreezeWorkflowV4 } from "../../src/workflows/ir/freeze-v4";
import { canonicalPlanJson, computePlanHash } from "../../src/workflows/ir/plan-hash";
import { decodeWorkflowPlanV4 } from "../../src/workflows/ir/schema-v4";
import { startWorkflowRun } from "../../src/workflows/runtime/runs";
import { loadWorkflowAsset } from "../../src/workflows/runtime/workflow-asset-loader";
import { compileWorkflowSource, type WorkflowSourceCompileResult } from "../../src/workflows/source-ir/compile";
import { sourceStepInstructions, sourceStepProgramUnit } from "../../src/workflows/source-ir/program";
import { decodeWorkflowSourceIrV1 } from "../../src/workflows/source-ir/schema";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../_helpers/sandbox";
import { freezeWorkflow, type WorkflowPlanFixture } from "../_helpers/workflow";

/** The name pattern outputs share with `params:` (`PROGRAM_PARAM_NAME_PATTERN`). */
const BAD_OUTPUT_NAME = "1bad";

/** A two-step markdown workflow with `collect` then `summarize`, plus arbitrary extra frontmatter lines. */
function twoStepDoc(extraFrontmatter: string[] = []): string {
  return [
    "---",
    "type: workflow",
    ...extraFrontmatter,
    "steps:",
    "  - id: collect",
    "  - id: summarize",
    "---",
    "",
    "## collect",
    "",
    "Collect the raw data.",
    "",
    "## summarize",
    "",
    "Summarize the results.",
    "",
  ].join("\n");
}

function compileSource(markdown: string, sourcePath = "workflows/test.md"): WorkflowSourceCompileResult {
  return compileWorkflowSource(markdown, { path: sourcePath, workspaceRoot: "/tmp" });
}

/** Compile all the way to the unresolved plan draft — pure, no config/engine resolution needed. */
function compileDraft(markdown: string, sourcePath = "workflows/test.md"): WorkflowPlanCompileResult {
  const compiled = compileSource(markdown, sourcePath);
  if (!compiled.ok) return compiled;
  const sourceSteps = compiled.ir.jobs[0]?.steps ?? [];
  const resolvedUnits = new Map(
    sourceSteps
      .filter((step) => step.route === undefined)
      .map(
        (step) => [step.id, { unit: sourceStepProgramUnit(step), instructions: sourceStepInstructions(step) }] as const,
      ),
  );
  return compileWorkflowPlan(compiled.ir, "test", resolvedUnits);
}

function errorMessages(result: { ok: false; errors: readonly { message: string }[] }): string {
  return result.errors.map((e) => e.message).join("\n");
}

/** A loose structural view onto a decoded/compiled plan's not-yet-typed `outputs` field. See file header. */
interface DecodedOutputsView {
  readonly outputs?: Record<string, { readonly from: string; readonly schema?: Record<string, unknown> }>;
}

function outputsView(plan: unknown): DecodedOutputsView {
  return plan as unknown as DecodedOutputsView;
}

// ── B-03…B-10: pure grammar / compile-level checks (no sandbox needed) ─────

describe("outputs: — authoring grammar (B-03…B-09)", () => {
  test("B-03: an output name outside the param-name grammar fails, naming the key and the grammar", () => {
    const result = compileSource(twoStepDoc(["outputs:", `  ${BAD_OUTPUT_NAME}:`, "    from: steps.summarize.output"]));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(errorMessages(result)).toContain(BAD_OUTPUT_NAME);
  });

  test("B-05: from: that is not a valid steps.<id>.output(.<seg>)* reference fails through the reference grammar", () => {
    const result = compileSource(twoStepDoc(["outputs:", "  report:", "    from: not-a-valid-reference!!"]));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(errorMessages(result)).toContain("report");
  });

  test("B-06: from: naming a step id the document does not declare fails compile, naming the step and the output", () => {
    const result = compileDraft(twoStepDoc(["outputs:", "  report:", "    from: steps.ghost.output"]));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const messages = result.errors.map((e) => e.message).join("\n");
    expect(messages).toContain("ghost");
    expect(messages).toContain("report");
  });

  test("B-07: from: params.<name> is rejected — an output projects a step artifact, never a param", () => {
    const result = compileSource(
      twoStepDoc(["params:", "  scope: { type: string }", "outputs:", "  report:", "    from: params.scope"]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(errorMessages(result)).toContain("report");
  });

  test("B-08: a schema: outside the enforced JSON Schema subset fails, same message shape as a params: schema", () => {
    const result = compileSource(
      twoStepDoc([
        "outputs:",
        "  report:",
        "    from: steps.summarize.output",
        "    schema: { type: string, pattern: '^[a-z]+$' }",
      ]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(errorMessages(result)).toContain("report");
  });

  test("B-09: a schema: over the 256 KiB resource limit fails, naming the cap", () => {
    const hugeEnum = JSON.stringify(["x".repeat(300_000)]);
    const result = compileSource(
      twoStepDoc([
        "outputs:",
        "  report:",
        "    from: steps.summarize.output",
        `    schema: { type: string, enum: ${hugeEnum} }`,
      ]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(errorMessages(result)).toContain("report");
  });
});

describe("outputs: — a GitHub-shaped workflow cannot declare one (B-10, PRESERVE, B-N4)", () => {
  test("outputs: at the root of a .yml workflow is rejected by the existing closed ROOT_KEYS check", () => {
    const yaml = [
      "name: gh-outputs-rejected",
      "on:",
      "  workflow_dispatch:",
      "outputs:",
      "  report:",
      "    from: steps.summarize.output",
      "jobs:",
      "  main:",
      "    runs-on: [self-hosted]",
      "    steps:",
      "      - id: summarize",
      "        run: echo hi",
      "",
    ].join("\n");
    const result = compileSource(yaml, "workflows/gh-outputs-rejected.yml");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(errorMessages(result)).toContain("outputs");
  });
});

// ── B-11…B-17: decode-level integrity (hand-spliced JSON, no sandbox) ──────

const TWO_STEP_MD = twoStepDoc();

function splicedOutputs(plan: WorkflowPlanFixture, outputs: unknown): unknown {
  const clone = JSON.parse(canonicalPlanJson(plan)) as Record<string, unknown>;
  clone.outputs = outputs;
  return clone;
}

function expectDecodeUsageError(input: unknown): UsageError {
  let caught: unknown;
  try {
    decodeWorkflowPlanV4(input);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(UsageError);
  if (!(caught instanceof UsageError)) throw new Error("unreachable");
  return caught;
}

describe("outputs: — decode integrity (B-11…B-16)", () => {
  test("B-11: a workflow declaring no outputs: has plan.outputs absent (never {}), and the hash is a stable function of the plan", () => {
    const plan = freezeWorkflow(TWO_STEP_MD, "workflows/no-outputs.md");
    expect(Object.hasOwn(plan, "outputs")).toBe(false);
    expect(outputsView(plan).outputs).toBeUndefined();
    const redecoded = decodeWorkflowPlanV4(JSON.parse(canonicalPlanJson(plan)));
    expect(computePlanHash(redecoded)).toBe(computePlanHash(plan));
  });

  test("B-12: decodeWorkflowPlanV4 accepts a plan with a valid outputs entry; irVersion stays 5", () => {
    const plan = freezeWorkflow(TWO_STEP_MD, "workflows/valid-outputs.md");
    const spliced = splicedOutputs(plan, { report: { from: "steps.summarize.output" } });
    expect(() => decodeWorkflowPlanV4(spliced)).not.toThrow();
    const decoded = decodeWorkflowPlanV4(spliced);
    expect(decoded.irVersion).toBe<number>(5);
    expect(outputsView(decoded).outputs?.report?.from).toBe("steps.summarize.output");
  });

  test("B-13: decodeWorkflowPlanV4 rejects outputs: {} — absent-never-empty (P2b A-N7)", () => {
    const plan = freezeWorkflow(TWO_STEP_MD, "workflows/empty-outputs.md");
    expectDecodeUsageError(splicedOutputs(plan, {}));
  });

  test("B-14: decodeWorkflowPlanV4 rejects outputs whose keys are not in sorted-unique order", () => {
    const plan = freezeWorkflow(TWO_STEP_MD, "workflows/unsorted-outputs.md");
    // Insertion order "zebra" then "apple" is deliberately NOT the canonical
    // sorted order — string keys iterate in insertion order in V8/JSC.
    const spliced = splicedOutputs(plan, {
      zebra: { from: "steps.summarize.output" },
      apple: { from: "steps.collect.output" },
    });
    expectDecodeUsageError(spliced);
  });

  test("B-15: decodeWorkflowPlanV4 rejects an outputs.<n>.from naming a step not in plan.steps, naming the output and the step", () => {
    const plan = freezeWorkflow(TWO_STEP_MD, "workflows/missing-step-outputs.md");
    const spliced = splicedOutputs(plan, { report: { from: "steps.ghost.output" } });
    const error = expectDecodeUsageError(spliced);
    expect(error.message).toContain("report");
    expect(error.message).toContain("ghost");
  });

  test("B-16: decodeWorkflowPlanV4 rejects an unknown key inside an outputs entry, through the module's existing assertKeys", () => {
    const plan = freezeWorkflow(TWO_STEP_MD, "workflows/bogus-key-outputs.md");
    const spliced = splicedOutputs(plan, { report: { from: "steps.summarize.output", bogus: 1 } });
    const error = expectDecodeUsageError(spliced);
    expect(error.message).toContain("bogus");
  });

  test("regression: decodeWorkflowSourceIrV1 rejects outputs.<n>.from that parses but names a param, not just the parser", () => {
    const compiled = compileSource(twoStepDoc(["outputs:", "  report:", "    from: steps.summarize.output"]));
    if (!compiled.ok) throw new Error("unreachable");
    const raw = JSON.parse(JSON.stringify(compiled.ir)) as { outputs: Record<string, unknown> };
    raw.outputs.report = { from: "params.scope" };
    expect(() => decodeWorkflowSourceIrV1(raw)).toThrow();
  });
});

// ── B-01, B-02, B-17: the full author -> compile -> freeze -> durable-plan
// ── pipeline (needs an isolated stash + index + config) ────────────────────

describe("outputs: — end-to-end freeze into the durable plan irVersion 5 plan (B-01, B-02, B-17)", () => {
  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    writeWorkflowTestConfig();
    resetConfigCache();
  });

  afterEach(() => {
    resetConfigCache();
    storage.cleanup();
  });

  function write(relative: string, content: string): void {
    const file = path.join(storage.stashDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  }

  async function frozenPlan(ref: string): Promise<unknown> {
    const started = await startWorkflowRun(ref);
    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    return decodeWorkflowPlanV4(JSON.parse(row?.plan_json ?? "null"));
  }

  test("B-01: outputs: {report: {from: steps.summarize.output}} parses, compiles, and freezes into plan.outputs", async () => {
    write("workflows/with-output.md", twoStepDoc(["outputs:", "  report:", "    from: steps.summarize.output"]));
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const decoded = await frozenPlan("workflows/with-output");
    expect(outputsView(decoded).outputs?.report?.from).toBe("steps.summarize.output");
  });

  test("B-02: outputs: with a schema: freezes the schema alongside from", async () => {
    write(
      "workflows/with-schema-output.md",
      twoStepDoc([
        "outputs:",
        "  changed_count:",
        "    from: steps.collect.output.total",
        "    schema: { type: integer, minimum: 0 }",
      ]),
    );
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const decoded = await frozenPlan("workflows/with-schema-output");
    expect(outputsView(decoded).outputs?.changed_count).toEqual({
      from: "steps.collect.output.total",
      schema: { type: "integer", minimum: 0 },
    });
  });

  test("B-17: two independent freezes of the same source declaring outputs: produce a byte-identical plan hash", async () => {
    write("workflows/stable-outputs.md", twoStepDoc(["outputs:", "  report:", "    from: steps.summarize.output"]));
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const asset = await loadWorkflowAsset("workflows/stable-outputs");
    const config = loadConfig();
    const first = await compileResolveFreezeWorkflowV4(asset, config);
    const second = await compileResolveFreezeWorkflowV4(asset, config);
    expect(computePlanHash(second.plan)).toBe(computePlanHash(first.plan));
    expect(canonicalPlanJson(second.plan)).toBe(canonicalPlanJson(first.plan));
  });

  test("regression: outputs: declared out of alphabetical author order still freezes, embedded in sorted order", async () => {
    write(
      "workflows/unsorted-outputs.md",
      twoStepDoc([
        "outputs:",
        "  zebra:",
        "    from: steps.summarize.output",
        "  alpha:",
        "    from: steps.collect.output",
      ]),
    );
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const decoded = await frozenPlan("workflows/unsorted-outputs");
    expect(Object.keys(outputsView(decoded).outputs ?? {})).toEqual(["alpha", "zebra"]);
  });
});
