// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStateDatabase } from "../../../../src/core/state-db";
import { withWorkflowRunsRepo } from "../../../../src/storage/repositories/workflow-runs-repository";
import { cpuDerivedUnitConcurrency } from "../../../../src/workflows/concurrency-policy";
import { runWorkflowSteps } from "../../../../src/workflows/exec/run-workflow";
import type { WorkflowPlanGraph } from "../../../../src/workflows/ir/schema";
import { frozenStepRows } from "../../../../src/workflows/runtime/plan-classifier";
import { getWorkflowStatus } from "../../../../src/workflows/runtime/runs";
import { freezeWorkflow, storeFrozenWorkflowPlan } from "../../../_helpers/workflow";

/**
 * Conformance suite (orchestration plan, §Anti-drift; conformance goldens
 * ported to the unified workflow markdown format per the workflow-format-
 * unification redesign): golden workflows run through every execution
 * backend with mocked runners; the suite asserts an identical compiled plan
 * and an identical per-unit graph. Today the native executor is the only
 * backend — when the R3 driver protocol lands, brief/report-driven runs plug
 * into `BACKENDS` below and every golden workflow must produce the same unit
 * graph on each.
 *
 * The golden plans are EXPLICIT expected structures, not snapshots: a change
 * that alters the compiled IR or the executed unit graph must edit this file
 * knowingly.
 *
 * ## One frontend now
 *
 * Pre-unification this suite compiled each golden through TWO frontends —
 * the YAML program (`freezeWorkflowProgram`, `templating: "expressions"`) and
 * the classic linear markdown (`freezeMarkdownWorkflow`, `templating:
 * "verbatim"`) — to prove they produced the same IR shape. Both helpers, and
 * the whole classic markdown grammar (`# Workflow:` / `## Step:` / `Step
 * ID:`), are deleted (spec §3): there is exactly one frontend
 * (`freezeWorkflow`) and exactly one `templating` value (`"verbatim"` — the
 * unified format never interpolates prose, spec §2.3). The former "Golden 1b:
 * classic linear markdown" duplicate golden is gone with it; Golden 1 below
 * is the sole linear golden.
 */

let tmpDir = "";
let prevDataDir: string | undefined;

const RUN_ID = "55555555-5555-4555-8555-555555555555";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-conformance-"));
  prevDataDir = process.env.AKM_DATA_DIR;
  process.env.AKM_DATA_DIR = tmpDir;
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.AKM_DATA_DIR;
  else process.env.AKM_DATA_DIR = prevDataDir;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** Compile a golden unified workflow markdown source. */
function compile(markdown: string): WorkflowPlanGraph {
  return freezeWorkflow(markdown, "workflows/golden.md");
}

function seedRun(plan: WorkflowPlanGraph, params: Record<string, unknown>): void {
  const steps = frozenStepRows(plan);
  const db = openStateDatabase(path.join(tmpDir, "state.db"));
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO workflow_runs
         (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
          params_json, current_step_id, created_at, updated_at)
       VALUES (?, 'workflows/golden', 'dir:v1:golden', NULL, 'Golden', 'active', ?, ?, ?, ?)`,
    ).run(RUN_ID, JSON.stringify(params), steps[0]!.stepId, now, now);
    steps.forEach((step) => {
      db.prepare(
        `INSERT INTO workflow_run_steps
           (run_id, step_id, step_title, instructions, completion_json, sequence_index, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      ).run(RUN_ID, step.stepId, step.stepTitle, step.instructions, step.completionJson, step.sequenceIndex);
    });
  } finally {
    db.close();
  }
}

/** Execution backends under conformance. R3 driver-protocol backends register here. */
const BACKENDS = [
  {
    name: "native",
    run: (plan: WorkflowPlanGraph) => {
      const db = openStateDatabase(path.join(tmpDir, "state.db"));
      try {
        storeFrozenWorkflowPlan(db, RUN_ID, plan);
      } finally {
        db.close();
      }
      return runWorkflowSteps({
        target: RUN_ID,
        summaryJudge: null,
        dispatcher: async (req) =>
          req.schema ? { ok: true, text: '{"verdict": "pass"}' } : { ok: true, text: `did ${req.unitId}` },
        loadPlan: async () => plan,
      });
    },
  },
] as const;

/** The observable per-unit graph: (unitId, nodeId, parent, status) tuples. */
async function unitGraph(): Promise<Array<[string, string, string | null, string]>> {
  return withWorkflowRunsRepo((repo) =>
    repo
      .getUnitsForRun(RUN_ID)
      .map((u): [string, string, string | null, string] => [u.unit_id, u.node_id, u.parent_unit_id, u.status])
      .sort((a, b) => a[0].localeCompare(b[0])),
  );
}

const FROZEN_EXECUTION: NonNullable<WorkflowPlanGraph["execution"]> = {
  maxConcurrency: cpuDerivedUnitConcurrency(),
  engines: {
    "test-agent": {
      name: "test-agent",
      kind: "agent",
      runnerKind: "sdk",
      platform: "opencode-sdk",
      bin: "opencode",
      args: [],
      workspace: null,
      envPassthrough: [],
      commandBuilder: "opencode-sdk",
      fallbackLlmEngine: "test-llm",
    },
    "test-llm": {
      name: "test-llm",
      kind: "llm",
      endpoint: "http://localhost:1/v1/chat/completions",
      model: "test-model",
      credential: { names: ["AKM_ENGINE_TEST_LLM_API_KEY", "AKM_LLM_API_KEY"], required: false },
      concurrency: 1,
    },
  },
};

/** Golden 1's expected plan (one frontend, one `templating: "verbatim"` value). */
function linearGolden(
  sources: [{ path: string; start: number; end: number }, { path: string; start: number; end: number }],
): WorkflowPlanGraph {
  const unit = (id: string, instructions: string, source: (typeof sources)[number]) => ({
    kind: "unit" as const,
    id,
    instructions,
    templating: "verbatim" as const,
    invocation: { engine: "test-agent", model: "test-model", timeoutMs: 600_000 },
    onError: "fail" as const,
    isolation: "none" as const,
    source,
  });
  return {
    irVersion: 3,
    title: "golden",
    execution: FROZEN_EXECUTION,
    steps: [
      {
        stepId: "build",
        title: "build",
        sequenceIndex: 0,
        root: unit("build", "Build it.", sources[0]),
        gate: {
          kind: "gate",
          id: "build.gate",
          stepId: "build",
          criteria: ["Artifact exists."],
          maxLoops: 1,
          judge: { engine: "test-llm", model: "test-model", timeoutMs: 600_000 },
        },
      },
      {
        stepId: "deploy",
        title: "deploy",
        sequenceIndex: 1,
        root: unit("deploy", "Deploy it.", sources[1]),
        gate: {
          kind: "gate",
          id: "deploy.gate",
          stepId: "deploy",
          criteria: [],
          maxLoops: 1,
          judge: null,
        },
      },
    ],
  };
}

// ── Golden 1: linear workflow (behavior identical to the classic step loop) ──

const LINEAR = `---
type: workflow
steps:
  - id: build
  - id: deploy
---

## build

Build it.

### gate

Artifact exists.

## deploy

Deploy it.
`;

describe("conformance — linear workflow", () => {
  test("compiles to the golden plan", () => {
    expect(compile(LINEAR)).toEqual(
      linearGolden([
        { path: "workflows/golden.md", start: 9, end: 11 },
        { path: "workflows/golden.md", start: 17, end: 19 },
      ]),
    );
  });

  for (const backend of BACKENDS) {
    test(`${backend.name}: executes the golden unit graph`, async () => {
      const plan = compile(LINEAR);
      seedRun(plan, {});
      const result = await backend.run(plan);
      expect(result.done).toBe(true);
      // Content-derived unit identity (R2): solo units are `<node_id>:solo`.
      expect(await unitGraph()).toEqual([
        ["build:solo", "build", null, "completed"],
        ["deploy:solo", "deploy", null, "completed"],
      ]);
    });
  }
});

// ── Golden 2: fan-out + schema + vote reducer ────────────────────────────────

const FAN_OUT_VOTE = `---
type: workflow
params:
  attempts: { type: array }
steps:
  - id: judge
    map:
      over: params.attempts
      concurrency: 2
      reducer: vote
      unit:
        output:
          type: object
          properties: { verdict: { type: string } }
          required: [verdict]
---

## judge

Judge the assigned attempt.
`;

describe("conformance — fan-out + schema + vote", () => {
  test("compiles to the golden plan", () => {
    const plan = compile(FAN_OUT_VOTE);
    expect(plan.params).toEqual(["attempts"]);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toEqual({
      stepId: "judge",
      title: "judge",
      sequenceIndex: 0,
      root: {
        kind: "map",
        id: "judge.map",
        over: "params.attempts",
        template: {
          kind: "unit",
          id: "judge.unit",
          instructions: "Judge the assigned attempt.",
          templating: "verbatim",
          invocation: { engine: "test-agent", model: "test-model", timeoutMs: 600_000 },
          onError: "fail",
          isolation: "none",
          schema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] },
          source: { path: "workflows/golden.md", start: 6, end: 15 },
        },
        concurrency: 2,
        reducer: "vote",
        source: { path: "workflows/golden.md", start: 6, end: 15 },
      },
      gate: {
        kind: "gate",
        id: "judge.gate",
        stepId: "judge",
        criteria: [],
        maxLoops: 1,
        judge: null,
      },
    });
  });

  for (const backend of BACKENDS) {
    test(`${backend.name}: executes the golden unit graph with vote evidence`, async () => {
      const plan = compile(FAN_OUT_VOTE);
      seedRun(plan, { attempts: [1, 2, 3] });
      const result = await backend.run(plan);
      expect(result.done).toBe(true);
      // Content-derived fan-out identity: `<node_id>:<sha256(canonicalJson(item))[:12]>`
      // for items 1, 2, 3 — position-independent, sorted by unit_id here.
      expect(await unitGraph()).toEqual([
        ["judge.unit:4e07408562be", "judge.unit", "judge.map", "completed"], // item 3
        ["judge.unit:6b86b273ff34", "judge.unit", "judge.map", "completed"], // item 1
        ["judge.unit:d4735e3a265e", "judge.unit", "judge.map", "completed"], // item 2
      ]);
      const status = await getWorkflowStatus(RUN_ID);
      expect(status.workflow.steps[0]!.evidence?.vote).toEqual({
        winner: { verdict: "pass" },
        votes: 3,
        total: 3,
      });
      // The promoted step artifact of a vote step IS the winner — what
      // `steps.judge.output` resolves to downstream.
      expect(status.workflow.steps[0]!.evidence?.output).toEqual({ verdict: "pass" });
    });
  }
});

// ── Golden 3: routed workflow (route-only step, explicit input) ─────────────

const ROUTED = `---
type: workflow
steps:
  - id: classify
    unit:
      output:
        type: object
        properties: { verdict: { type: string } }
        required: [verdict]
  - id: triage
    route:
      input: steps.classify.output.verdict
      when: [{ match: pass, step: ship }, { match: fail, step: rework }]
  - id: ship
  - id: rework
---

## classify

Classify.

## ship

Ship it.

## rework

Rework it.
`;

describe("conformance — routed workflow", () => {
  test("compiles the route into a route-only step plan", () => {
    const plan = compile(ROUTED);
    expect(plan.steps[1]).toEqual({
      stepId: "triage",
      title: "triage",
      sequenceIndex: 1,
      route: {
        input: "steps.classify.output.verdict",
        when: { pass: "ship", fail: "rework" },
      },
      gate: {
        kind: "gate",
        id: "triage.gate",
        stepId: "triage",
        criteria: [],
        maxLoops: 1,
        judge: null,
      },
    });
    expect(plan.steps[1]!.root).toBeUndefined();
  });

  for (const backend of BACKENDS) {
    test(`${backend.name}: selected branch dispatches, unselected is skipped with no units`, async () => {
      const plan = compile(ROUTED);
      seedRun(plan, {});
      const result = await backend.run(plan);
      expect(result.done).toBe(true);
      // Neither the route step nor rework may have unit rows — the route
      // dispatches nothing, and rework never ran.
      expect(await unitGraph()).toEqual([
        ["classify:solo", "classify", null, "completed"],
        ["ship:solo", "ship", null, "completed"],
      ]);
      const status = await getWorkflowStatus(RUN_ID);
      const byId = new Map(status.workflow.steps.map((s) => [s.id, s.status]));
      expect(byId.get("triage")).toBe("completed");
      expect(byId.get("rework")).toBe("skipped");
    });
  }
});
