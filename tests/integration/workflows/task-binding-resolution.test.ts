// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P2b Lane A — PRE-ATTEMPT resolution of `with:` bindings on `uses:
 * tasks/<ref>` workflow steps (docs/plans/specs/p2b-input-bindings.md §2.3,
 * §3.6, B-31..B-34). Freeze-time normalization (§2.2) lives in
 * tests/workflows/task-input-bindings.test.ts; this file starts where that
 * one ends — a REAL frozen plan whose target already carries `inputBindings`
 * — and exercises `computeStepWorkList` (`src/workflows/exec/step-work.ts`),
 * the SAME pure function the native executor calls immediately before
 * `reserveUnitAttempt` (native-executor.ts:588,1021).
 *
 * Pattern: `startWorkflowRun` against an isolated stash (freeze only — no
 * dispatch), then `computeStepWorkList(plan.steps[i], {runId, params,
 * stepOutputs})` with HAND-BUILT `stepOutputs`/`params`, exactly as
 * tests/integration/workflows/chaos.test.ts's `fullWorkList` and
 * tests/integration/workflows/gate-artifacts.test.ts's `loop1Hash` already
 * do for other step-work scenarios — no live dispatcher needed to prove a
 * reference resolves (or fails to) against a given prior-step output. The one
 * exception is the "no attempt row was journaled" integration proof (B-32),
 * which drives a REAL run through `runWorkflowSteps` (params-validation.test.ts's
 * own `dispatcher: async () => ({ok:true,...})` seam) and reads the durable
 * attempt-accounting row back.
 *
 * RED TODAY: `computeStepWorkList` has no awareness of `inputBindings` at
 * all yet (§3.6 lands in Implement) — until the freeze-side work lands too
 * (A-N6, A-N3, A-N7; see task-input-bindings.test.ts's header), no fixture
 * below even reaches a frozen plan with a non-empty `inputBindings`, so
 * every reference-resolution assertion here is vacuously wrong today (a
 * reference binding is simply absent from the frozen target, and
 * `computeStepWorkList` ignores it either way). This is a RUNTIME gap, not a
 * type-level one — no `@ts-expect-error` is needed in this file: every
 * symbol referenced (`computeStepWorkList`, `runWorkflowSteps`,
 * `getAttemptAccounting`, `decodeWorkflowPlanV4`) already exists today.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../../src/core/config/config";
import { akmIndex } from "../../../src/indexer/indexer";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import { computeStepWorkList } from "../../../src/workflows/exec/step-work";
import { decodeWorkflowPlanV4 } from "../../../src/workflows/ir/schema-v4";
import { startWorkflowRun } from "../../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../../_helpers/sandbox";

const STEP_ID = "dispatch";
const TASK_REF = "tasks/nightly-v4";

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

function writeWorkflow(name: string, stepLines: readonly string[]): void {
  write(
    `workflows/${name}.yml`,
    [
      `name: ${name}`,
      "on:",
      "  workflow_dispatch:",
      "jobs:",
      "  main:",
      "    runs-on: [self-hosted]",
      "    steps:",
      ...stepLines,
      "",
    ].join("\n"),
  );
}

/** Same shared task source v4 fixture as tests/workflows/task-input-bindings.test.ts. */
function writeCentralTaskFixture(): void {
  write("commands/review.md", "Review the workflow-composed task target.\n");
  write(
    "tasks/nightly-v4.yml",
    [
      "version: 4",
      "name: Nightly review v4",
      "uses: commands/review",
      "inputs:",
      "  scope:",
      "    type: string",
      "    enum: [changed, all]",
      "    default: changed",
      "  strict:",
      "    type: boolean",
      "    default: true",
      "  ticket:",
      "    type: string",
      "    required: true",
      "  files:",
      "    type: array",
      "    items:",
      "      type: string",
      "  meta:",
      "    type: object",
      "",
    ].join("\n"),
  );
}

describe("P2b pre-attempt — a reference resolves successfully against a prior step's output (B-31)", () => {
  test("computeStepWorkList succeeds when the referenced path resolves to a value satisfying the declared schema", async () => {
    writeCentralTaskFixture();
    writeWorkflow("collect-dispatch", [
      "      - id: collect",
      "        uses: akm/command",
      "        with:",
      "          content: Collect a scope decision.",
      `      - id: ${STEP_ID}`,
      `        uses: ${TASK_REF}`,
      "        with:",
      "          ticket: T-1",
      "          scope:",
      "            from: steps.collect.output.scope",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });
    const started = await startWorkflowRun("workflows/collect-dispatch");
    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    const plan = decodeWorkflowPlanV4(JSON.parse(row?.plan_json ?? "null"));

    const computed = computeStepWorkList(plan.steps[1]!, {
      runId: started.run.id,
      params: {},
      stepOutputs: { collect: { scope: "all" } },
    });
    expect(computed.ok).toBe(true);
    if (!computed.ok) return;
    expect(computed.list.units).toHaveLength(1);
  });
});

describe("P2b pre-attempt — a resolved reference violating its declared schema fails before dispatch (B-32)", () => {
  test("computeStepWorkList fails, naming the step, the input, the reference, and the schema error", async () => {
    writeCentralTaskFixture();
    writeWorkflow("collect-dispatch", [
      "      - id: collect",
      "        uses: akm/command",
      "        with:",
      "          content: Collect a scope decision.",
      `      - id: ${STEP_ID}`,
      `        uses: ${TASK_REF}`,
      "        with:",
      "          ticket: T-1",
      "          scope:",
      "            from: steps.collect.output.scope",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });
    const started = await startWorkflowRun("workflows/collect-dispatch");
    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    const plan = decodeWorkflowPlanV4(JSON.parse(row?.plan_json ?? "null"));

    // Same plan as the success case above — ONLY the prior step's output value
    // changes, from "all" (valid) to "bogus" (violates scope's enum).
    const computed = computeStepWorkList(plan.steps[1]!, {
      runId: started.run.id,
      params: {},
      stepOutputs: { collect: { scope: "bogus" } },
    });
    expect(computed.ok).toBe(false);
    if (computed.ok) return;
    expect(computed.error).toContain(STEP_ID);
    expect(computed.error).toContain("scope");
    expect(computed.error).toContain("steps.collect.output.scope");
    expect(computed.error).toContain("is not one of");
  });

  // Deliberately steps-based, not params-based: GitHub-shaped YAML's
  // ROOT_KEYS (github-yaml.ts:36) is exactly ["name", "on", "jobs"] — there
  // is no way to author a typed `params:` declaration in this front end at
  // all ("workflow_dispatch inputs are not supported for local execution.",
  // github-yaml.ts:366) — and a `{from: "params.<name>"}}` reference needs
  // ONE that's declared (A-N4: checked against the workflow's OWN
  // `paramSchemas` at freeze, B-18). Markdown declares typed params but has
  // no `uses:`/`with:` step composition surface at all (its own STEP_KEYS
  // are id/unit/map/route/inputs/output/gate — see this file's B-27 sibling
  // comment in task-input-bindings.test.ts). A `uses: tasks/<ref>` step
  // binding `{from: "params.…"}}` is therefore unreachable from either front
  // end and cannot be exercised end-to-end; this proof uses the
  // steps-rooted grammar instead, driving a REAL two-step run so a REAL
  // attempt-accounting row is there to prove empty. The referenced path
  // ("collect" ran, but never produces a "scope" property under ANY shape
  // its output could take) fails PRE-ATTEMPT regardless of whether the
  // failure mode is "did not resolve" or "violates the schema" — both are
  // computeStepWorkList returning {ok:false} before any unit is built, which
  // is the one fact this test needs.
  test("the real engine never reserves a dispatch attempt for the failing unit — the run's attempt table stays empty (B-32, before reserveUnitAttempt)", async () => {
    writeCentralTaskFixture();
    writeWorkflow("attempt-gate", [
      "      - id: collect",
      "        uses: akm/command",
      "        with:",
      "          content: Emit a scope decision.",
      `      - id: ${STEP_ID}`,
      `        uses: ${TASK_REF}`,
      "        with:",
      "          ticket: T-1",
      "          scope:",
      "            from: steps.collect.output.definitely_missing_field",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const started = await startWorkflowRun("workflows/attempt-gate");
    const result = await runWorkflowSteps({
      target: started.run.id,
      summaryJudge: null,
      dispatcher: async () => ({ ok: true, text: "collected" }),
    });

    expect(result.run.status).toBe("failed");
    const accounting = await withWorkflowRunsRepo((repo) => repo.getAttemptAccounting(started.run.id));
    expect(accounting.totalAttempts).toBe(0);
  });
});

describe("P2b pre-attempt — a reference that fails to resolve at all fails before dispatch (B-33)", () => {
  test("computeStepWorkList fails, carrying resolveStepReference's own message when the referenced path is missing", async () => {
    writeCentralTaskFixture();
    writeWorkflow("collect-dispatch", [
      "      - id: collect",
      "        uses: akm/command",
      "        with:",
      "          content: Collect a scope decision.",
      `      - id: ${STEP_ID}`,
      `        uses: ${TASK_REF}`,
      "        with:",
      "          ticket: T-1",
      "          scope:",
      "            from: steps.collect.output.scope",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });
    const started = await startWorkflowRun("workflows/collect-dispatch");
    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    const plan = decodeWorkflowPlanV4(JSON.parse(row?.plan_json ?? "null"));

    // "collect" ran, but its output never had a "scope" property at all.
    const computed = computeStepWorkList(plan.steps[1]!, {
      runId: started.run.id,
      params: {},
      stepOutputs: { collect: {} },
    });
    expect(computed.ok).toBe(false);
    if (computed.ok) return;
    expect(computed.error).toContain(`Step "${STEP_ID}"`);
    expect(computed.error).toContain('input "scope"');
    expect(computed.error).toContain("steps.collect.output.scope");
    expect(computed.error).toContain("failed to resolve");
    expect(computed.error).toContain("is missing");
  });
});

describe("P2b pre-attempt — a literal binding passes through unchanged, with no re-validation (B-34)", () => {
  test("computeStepWorkList succeeds for a purely-literal binding set with NO stepOutputs at all", async () => {
    writeCentralTaskFixture();
    writeWorkflow("literal-only", [
      `      - id: ${STEP_ID}`,
      `        uses: ${TASK_REF}`,
      "        with:",
      "          ticket: T-1",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });
    const started = await startWorkflowRun("workflows/literal-only");
    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    const plan = decodeWorkflowPlanV4(JSON.parse(row?.plan_json ?? "null"));

    // No "collect" step exists in this plan at all — a literal binding needs
    // no stepOutputs to resolve, because there is nothing to resolve.
    const computed = computeStepWorkList(plan.steps[0]!, { runId: started.run.id, params: {}, stepOutputs: {} });
    expect(computed.ok).toBe(true);
  });
});
