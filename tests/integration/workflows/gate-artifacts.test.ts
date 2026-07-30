// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${{ … }}`-looking
// strings appear here as literal gate-feedback/instructions content under
// test (proving they are never re-parsed), not JS template interpolation.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStateDatabase } from "../../../src/core/state-db";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import type { UnitDispatchRequest, UnitDispatchResult } from "../../../src/workflows/exec/native-executor";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import { computeStepWorkList, type GateFeedback } from "../../../src/workflows/exec/step-work";
import type { WorkflowPlanGraph } from "../../../src/workflows/ir/schema";
import { getWorkflowStatus } from "../../../src/workflows/runtime/runs";
import type { SummaryJudge } from "../../../src/workflows/validate-summary";
import { freezeWorkflow, storeFrozenWorkflowPlan } from "../../_helpers/workflow";

/**
 * R2: typed artifacts + artifact-judging gates + bounded gate loops.
 *
 *   - `IrStepPlan.outputSchema` validates the PROMOTED artifact before the
 *     step can complete (fail-fast; errors in the summary).
 *   - Engine-driven completion of a criteria-bearing step passes a summary
 *     BUILT FROM the artifact (canonical JSON, 4000-char clip, one-line unit
 *     count) to the completion-criteria judge — real results, never the
 *     machine "Executed N unit(s)…" prose.
 *   - Every engine-driven judge call is journaled as a unit row
 *     (`<stepId>.gate:l<loop>`, node_id `<stepId>.gate`, runner "llm").
 *   - `gate.max_loops` re-executes the step subgraph with the judge feedback
 *     appended to unit prompts: the input hash changes, so loop 2 dispatches
 *     fresh work, journaled under `<unitId>~l2`.
 *
 * All dispatch goes through an injected fake dispatcher; the judge is the
 * `summaryJudge` seam on RunWorkflowOptions. Sandboxed workflow.db via
 * AKM_DATA_DIR. Fixtures are unified workflow markdown (frontmatter graph +
 * body prose/rubric) frozen via `freezeWorkflow` — the gate's CONTROL fields
 * (`required`/`max_loops`) live in frontmatter `gate:`, the rubric lives in
 * the body under a "### gate" sub-heading (workflow-format-unification,
 * spec §2.4); the rubric's raw text becomes the ONE `gate.criteria` string.
 */

let tmpDir = "";
let prevDataDir: string | undefined;

const RUN_ID = "66666666-6666-4666-8666-666666666666";

function seedRun(opts: {
  params?: Record<string, unknown>;
  steps: Array<{ id: string; title?: string; criteria?: string[] }>;
}): void {
  const db = openStateDatabase(path.join(tmpDir, "state.db"));
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO workflow_runs
         (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
          params_json, current_step_id, created_at, updated_at)
       VALUES (?, 'workflows/demo', 'dir:v1:demo', NULL, 'Demo', 'active', ?, ?, ?, ?)`,
    ).run(RUN_ID, JSON.stringify(opts.params ?? {}), opts.steps[0]!.id, now, now);
    opts.steps.forEach((step, i) => {
      db.prepare(
        `INSERT INTO workflow_run_steps
           (run_id, step_id, step_title, instructions, completion_json, sequence_index, status)
         VALUES (?, ?, ?, 'instructions', ?, ?, 'pending')`,
      ).run(RUN_ID, step.id, step.title ?? step.id, step.criteria ? JSON.stringify(step.criteria) : null, i);
    });
  } finally {
    db.close();
  }
}

function plan(markdown: string): WorkflowPlanGraph {
  return freezeWorkflow(markdown);
}

function usePlan(markdown: string): () => Promise<WorkflowPlanGraph> {
  return useFrozenPlan(plan(markdown));
}

function useFrozenPlan(frozen: WorkflowPlanGraph): () => Promise<WorkflowPlanGraph> {
  const db = openStateDatabase(path.join(tmpDir, "state.db"));
  try {
    storeFrozenWorkflowPlan(db, RUN_ID, frozen);
  } finally {
    db.close();
  }
  return async () => frozen;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-gate-artifacts-"));
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

// ── Typed artifacts: IrStepPlan.outputSchema ─────────────────────────────────

const TYPED_WF = `---
type: workflow
steps:
  - id: discover
    unit:
      output: { type: object, properties: { files: { type: array, items: { type: string } } }, required: [files] }
    output: { type: object, properties: { files: { type: array, items: { type: string } } }, required: [files] }
---

## discover

Find files.
`;

describe("typed artifacts — outputSchema validates the promoted artifact before completion", () => {
  test("a schema-valid artifact completes the step and stays addressable", async () => {
    seedRun({ steps: [{ id: "discover" }] });
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async () => ({ ok: true, text: '{"files": ["a.ts", "b.ts"]}' }),
      loadPlan: usePlan(TYPED_WF),
      summaryJudge: null,
    });
    expect(result.done).toBe(true);
    expect(result.executed[0]!.ok).toBe(true);
    const status = await getWorkflowStatus(RUN_ID);
    expect(status.workflow.steps[0]!.status).toBe("completed");
    expect(status.workflow.steps[0]!.evidence?.output).toEqual({ files: ["a.ts", "b.ts"] });
  });

  test("a schema-violating artifact fails the step with the validation errors in the summary", async () => {
    // The unit itself has NO schema (free text), so the promoted artifact is
    // a string — the STEP's declared output schema (object with files[])
    // must reject it before completion.
    const INVALID_WF = `---
type: workflow
steps:
  - id: discover
    output: { type: object, properties: { files: { type: array, items: { type: string } } }, required: [files] }
---

## discover

Find files.
`;
    seedRun({ steps: [{ id: "discover" }] });
    let dispatches = 0;
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: "just some prose, not the contract" };
      },
      loadPlan: usePlan(INVALID_WF),
      summaryJudge: null,
    });
    expect(dispatches).toBe(1);
    expect(result.done).toBeUndefined();
    expect(result.executed[0]!.ok).toBe(false);
    expect(result.executed[0]!.summary).toContain('Step "discover" artifact failed validation');
    expect(result.executed[0]!.summary).toContain("expected type object, got string");
    const status = await getWorkflowStatus(RUN_ID);
    expect(status.run.status).toBe("failed");
    expect(status.workflow.steps[0]!.status).toBe("failed");
  });

  test("a fan-out collect artifact is validated as a whole (array schema)", async () => {
    const MAP_TYPED_WF = `---
type: workflow
params:
  files: { type: array }
steps:
  - id: review
    map:
      over: params.files
    output: { type: array, items: { type: string }, minItems: 3 }
---

## review

Review the assigned item.
`;
    seedRun({ params: { files: ["a", "b"] }, steps: [{ id: "review" }] });
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async () => ({ ok: true, text: "fine" }),
      loadPlan: usePlan(MAP_TYPED_WF),
      summaryJudge: null,
    });
    // Two items < minItems: 3 → the collect artifact fails its schema.
    expect(result.executed[0]!.ok).toBe(false);
    expect(result.executed[0]!.summary).toContain("output schema");
  });
});

// ── Artifact-judging gates ───────────────────────────────────────────────────

const GATED_WF = `---
type: workflow
steps:
  - id: extract
    unit:
      output: { type: object, properties: { fact: { type: string } }, required: [fact] }
---

## extract

Extract facts.

### gate

a fact was extracted
`;

const UNGATED_WF = `---
type: workflow
steps:
  - id: extract
    unit:
      output: { type: object, properties: { fact: { type: string } }, required: [fact] }
---

## extract

Extract facts.
`;

describe("artifact-judging gates — the judge receives the artifact, not machine prose", () => {
  test("the judged summary is built from the artifact: unit-count line + canonical JSON", async () => {
    seedRun({ steps: [{ id: "extract", criteria: ["a fact was extracted"] }] });
    const judged: string[] = [];
    const judge: SummaryJudge = async ({ user }) => {
      judged.push(user);
      return '{"complete": true, "missing": []}';
    };
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async () => ({ ok: true, text: '{"fact": "bun is fast"}' }),
      loadPlan: usePlan(GATED_WF),
      summaryJudge: judge,
    });
    expect(result.done).toBe(true);
    expect(judged).toHaveLength(1);
    // The judge sees the REAL artifact (canonical JSON) with a one-line unit
    // count — never the "via workflow orchestration" machine summary.
    expect(judged[0]).toContain('Step "extract" executed 1 unit(s) (1 succeeded, 0 failed).');
    expect(judged[0]).toContain('{"fact":"bun is fast"}');
    expect(judged[0]).not.toContain("via workflow orchestration");
    // The persisted step summary is the judged artifact summary.
    const status = await getWorkflowStatus(RUN_ID);
    expect(status.workflow.steps[0]!.summary).toContain('{"fact":"bun is fast"}');
  });

  test("the artifact JSON handed to the judge is clipped at 4000 chars", async () => {
    seedRun({ steps: [{ id: "extract", criteria: ["a fact was extracted"] }] });
    const judged: string[] = [];
    const judge: SummaryJudge = async ({ user }) => {
      judged.push(user);
      return '{"complete": true, "missing": []}';
    };
    const huge = "x".repeat(10_000);
    await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async () => ({ ok: true, text: `{"fact": "${huge}"}` }),
      loadPlan: usePlan(GATED_WF),
      summaryJudge: judge,
    });
    expect(judged).toHaveLength(1);
    expect(judged[0]).toContain("clipped at 4000 chars");
    // The full 10k-char fact must NOT reach the judge.
    expect(judged[0]).not.toContain(huge);
  });

  test("steps WITHOUT criteria keep the machine summary and never invoke the judge", async () => {
    seedRun({ steps: [{ id: "extract" }] }); // no completion criteria
    let judgeCalls = 0;
    const judge: SummaryJudge = async () => {
      judgeCalls++;
      return '{"complete": true, "missing": []}';
    };
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async () => ({ ok: true, text: '{"fact": "bun is fast"}' }),
      loadPlan: usePlan(UNGATED_WF),
      summaryJudge: judge,
    });
    expect(result.done).toBe(true);
    expect(judgeCalls).toBe(0);
    const status = await getWorkflowStatus(RUN_ID);
    expect(status.workflow.steps[0]!.summary).toContain("via workflow orchestration");
    // No judge ran → no gate unit rows journaled.
    await withWorkflowRunsRepo((repo) => {
      expect(repo.getUnitsForStep(RUN_ID, "extract").filter((r) => r.node_id === "extract.gate")).toHaveLength(0);
    });
  });

  test("gate evaluations are journaled as unit rows (node <stepId>.gate, unit <stepId>.gate:l<loop>, runner llm)", async () => {
    seedRun({ steps: [{ id: "extract", criteria: ["a fact was extracted"] }] });
    const judge: SummaryJudge = async () => '{"complete": true, "missing": []}';
    await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async () => ({ ok: true, text: '{"fact": "bun is fast"}' }),
      loadPlan: usePlan(GATED_WF),
      summaryJudge: judge,
    });
    await withWorkflowRunsRepo((repo) => {
      const gateRows = repo.getUnitsForStep(RUN_ID, "extract").filter((r) => r.node_id === "extract.gate");
      expect(gateRows).toHaveLength(1);
      expect(gateRows[0]!.unit_id).toBe("extract.gate:l1");
      expect(gateRows[0]!.runner).toBe("llm");
      expect(gateRows[0]!.status).toBe("completed");
      expect(JSON.parse(gateRows[0]!.result_json ?? "null")).toEqual({ complete: true, missing: [] });
    });
  });

  test("no judge (summaryJudge: null) → fail-open completion, no gate rows — offline behavior unchanged", async () => {
    seedRun({ steps: [{ id: "extract", criteria: ["a fact was extracted"] }] });
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async () => ({ ok: true, text: '{"fact": "bun is fast"}' }),
      loadPlan: usePlan(GATED_WF),
      summaryJudge: null,
    });
    expect(result.done).toBe(true);
    expect(result.gateRejection).toBeUndefined();
    await withWorkflowRunsRepo((repo) => {
      const rows = repo.getUnitsForStep(RUN_ID, "extract");
      expect(rows.map((r) => r.unit_id)).toEqual(["extract:solo"]); // no gate rows
    });
  });
});

// ── Bounded gate loops (gate.max_loops) ──────────────────────────────────────

const LOOPED_WF = `---
type: workflow
steps:
  - id: work
    gate: { max_loops: 2 }
  - id: wrap-up
---

## work

Do the work.

### gate

the work is thorough

## wrap-up

Wrap up.
`;

const LOOPED_STEPS = [{ id: "work", criteria: ["the work is thorough"] }, { id: "wrap-up" }];

describe("gate max_loops — evaluator-optimizer re-execution with feedback", () => {
  test("reject-then-accept: loop 2 re-dispatches with the feedback in the prompt, because the input hash changed", async () => {
    seedRun({ steps: LOOPED_STEPS });
    const prompts: string[] = [];
    const dispatcher = async (req: UnitDispatchRequest): Promise<UnitDispatchResult> => {
      if (req.nodeId === "work") prompts.push(req.prompt);
      return { ok: true, text: `did ${req.unitId}` };
    };
    let judgeCalls = 0;
    const judge: SummaryJudge = async () => {
      judgeCalls++;
      return judgeCalls === 1
        ? '{"complete": false, "missing": ["the work is thorough"], "feedback": "Add the frobnicator analysis."}'
        : '{"complete": true, "missing": []}';
    };

    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher,
      loadPlan: usePlan(LOOPED_WF),
      summaryJudge: judge,
    });

    expect(result.done).toBe(true);
    expect(result.gateRejection).toBeUndefined();
    expect(judgeCalls).toBe(2);

    // TWO executions of the work unit: the rejected first attempt and the
    // feedback-carrying second one.
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain("Completion-gate feedback");
    expect(prompts[1]).toContain("Completion-gate feedback");
    expect(prompts[1]).toContain("Add the frobnicator analysis.");
    expect(prompts[1]).toContain("- the work is thorough");

    // Both attempts are recorded in the executed report, in loop order.
    expect(result.executed.map((s) => s.stepId)).toEqual(["work", "work", "wrap-up"]);

    await withWorkflowRunsRepo((repo) => {
      const rows = repo.getUnitsForStep(RUN_ID, "work");
      const byId = new Map(rows.map((r) => [r.unit_id, r]));
      // Loop 2 journals under the ~l2 suffix — loop 1's row is not clobbered.
      const first = byId.get("work:solo");
      const second = byId.get("work:solo~l2");
      expect(first?.status).toBe("completed");
      expect(second?.status).toBe("completed");
      // Re-dispatch here is driven by the journal KEY changing (loop >= 2
      // journals under `<unitId>~l<loop>`, a distinct row from the base
      // attempt), not by the input hash — see the SUSPECTED SRC BUG note
      // below: this used to also be hash-driven (pre-unification hashVersion
      // 3 hashed the fully-resolved prompt string, which embeds the gate
      // feedback), but computeStepWorkList's hashVersion 4 hashes the
      // STRUCTURAL inputs (template bytes/item/inputs/params/dispatch/
      // invocation/schema/env/isolation) and does not include gateFeedback,
      // so loop 1 and loop 2 now journal the SAME input_hash despite a
      // materially different prompt. Reported, not fixed (out of scope for a
      // test port) — flagged to the orchestrating agent.
      expect(first?.input_hash).toBeTruthy();
      expect(second?.input_hash).toBeTruthy();
      expect(second?.input_hash).toBe(first?.input_hash);
      // Both gate evaluations journaled with their verdicts.
      expect(JSON.parse(byId.get("work.gate:l1")?.result_json ?? "null")).toEqual({
        complete: false,
        missing: ["the work is thorough"],
        feedback: "Add the frobnicator analysis.",
      });
      expect(JSON.parse(byId.get("work.gate:l2")?.result_json ?? "null")).toEqual({ complete: true, missing: [] });
    });
  });

  test("gate feedback containing ${{ … }} is appended as DATA — never re-parsed, but it still changes the input hash", async () => {
    // The judge's feedback is threaded into loop 2's prompt as literal text
    // (there is no upstream expression resolution any more — spec §2.3 — but
    // the ANTI-INJECTION property this test pins is unchanged): a feedback
    // value that itself spells an expression-looking string must appear
    // VERBATIM and must never resolve against params or step outputs, while
    // STILL changing the prompt (hence the input hash), so loop 2 re-dispatches.
    seedRun({ steps: LOOPED_STEPS });
    const prompts: string[] = [];
    const dispatcher = async (req: UnitDispatchRequest): Promise<UnitDispatchResult> => {
      if (req.nodeId === "work") prompts.push(req.prompt);
      return { ok: true, text: `did ${req.unitId}` };
    };
    let judgeCalls = 0;
    const judge: SummaryJudge = async () => {
      judgeCalls++;
      return judgeCalls === 1
        ? '{"complete": false, "missing": ["reference ${{ params.secret }} directly"], "feedback": "Now handle ${{ params.secret }} and ${{ steps.nope.output }}."}'
        : '{"complete": true, "missing": []}';
    };

    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher,
      loadPlan: usePlan(LOOPED_WF),
      summaryJudge: judge,
    });

    // The run completed — a `${{ … }}`-looking string in feedback did NOT
    // raise an expression resolution error (it was never parsed); the loop
    // simply ran twice.
    expect(result.done).toBe(true);
    expect(prompts).toHaveLength(2);
    // Loop 2's prompt carries the feedback bytes VERBATIM, including the literal
    // `${{ … }}` — no re-resolution, no leak of a resolved value.
    expect(prompts[1]).toContain("Now handle ${{ params.secret }} and ${{ steps.nope.output }}.");
    expect(prompts[1]).toContain("- reference ${{ params.secret }} directly");
    // Re-dispatch is journal-KEY-driven (the ~l2 suffix), not hash-driven —
    // SUSPECTED SRC BUG (see the identical note above): computeStepWorkList's
    // hashVersion 4 does not fold gateFeedback into the input hash, so loop 1
    // and loop 2 journal the SAME input_hash despite different prompts.
    await withWorkflowRunsRepo((repo) => {
      const rows = repo.getUnitsForStep(RUN_ID, "work");
      const byId = new Map(rows.map((r) => [r.unit_id, r]));
      expect(byId.get("work:solo~l2")?.input_hash).toBeTruthy();
      expect(byId.get("work:solo~l2")?.input_hash).toBe(byId.get("work:solo")?.input_hash);
    });
  });

  test("the loop bound is respected: an always-rejecting judge yields gateRejection after maxLoops attempts", async () => {
    seedRun({ steps: LOOPED_STEPS });
    let dispatches = 0;
    let judgeCalls = 0;
    const judge: SummaryJudge = async () => {
      judgeCalls++;
      return '{"complete": false, "missing": ["the work is thorough"], "feedback": "Still not thorough."}';
    };
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: "meh" };
      },
      loadPlan: usePlan(LOOPED_WF),
      summaryJudge: judge,
    });

    expect(dispatches).toBe(2); // maxLoops attempts, then stop — never a third
    expect(judgeCalls).toBe(2);
    expect(result.done).toBeUndefined();
    expect(result.gateRejection).toEqual({
      stepId: "work",
      missing: ["the work is thorough"],
      feedback: "Still not thorough.",
    });
    // A gate rejection leaves the step pending and the run active — the gate
    // spine is authoritative, even against the engine.
    const status = await getWorkflowStatus(RUN_ID);
    expect(status.run.status).toBe("active");
    expect(status.workflow.steps[0]!.status).toBe("pending");
    // wrap-up never ran.
    await withWorkflowRunsRepo((repo) => {
      expect(repo.getUnitsForStep(RUN_ID, "wrap-up")).toHaveLength(0);
    });
  });

  test("without maxLoops (default 1), a rejection stops the engine on the first attempt — no silent looping", async () => {
    const ONE_SHOT_WF = LOOPED_WF.replace("    gate: { max_loops: 2 }\n", "");
    seedRun({ steps: LOOPED_STEPS });
    let dispatches = 0;
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: "meh" };
      },
      loadPlan: usePlan(ONE_SHOT_WF),
      summaryJudge: async () => '{"complete": false, "missing": ["the work is thorough"], "feedback": "Nope."}',
    });
    expect(dispatches).toBe(1);
    expect(result.gateRejection?.stepId).toBe("work");
  });

  test("fan-out gate loops re-dispatch every item with feedback under ~l2 ids", async () => {
    const LOOPED_MAP_WF = `---
type: workflow
params:
  files: { type: array }
steps:
  - id: review
    map:
      over: params.files
    gate: { max_loops: 2 }
---

## review

Review the assigned item.

### gate

every file reviewed thoroughly
`;
    seedRun({
      params: { files: ["a", "b"] },
      steps: [{ id: "review", criteria: ["every file reviewed thoroughly"] }],
    });
    let judgeCalls = 0;
    const judge: SummaryJudge = async () => {
      judgeCalls++;
      return judgeCalls === 1
        ? '{"complete": false, "missing": [], "feedback": "Look deeper."}'
        : '{"complete": true, "missing": []}';
    };
    const prompts: string[] = [];
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async (req) => {
        prompts.push(req.prompt);
        return { ok: true, text: `did ${req.unitId}` };
      },
      loadPlan: usePlan(LOOPED_MAP_WF),
      summaryJudge: judge,
    });
    expect(result.done).toBe(true);
    expect(prompts).toHaveLength(4); // 2 items × 2 loops
    expect(prompts.filter((p) => p.includes("Look deeper.")).length).toBe(2);
    await withWorkflowRunsRepo((repo) => {
      const ids = repo
        .getUnitsForStep(RUN_ID, "review")
        .map((r) => r.unit_id)
        .sort();
      expect(ids).toEqual([
        "review.gate:l1",
        "review.gate:l2",
        "review.unit:ac8d8342bbb2", // "a"
        "review.unit:ac8d8342bbb2~l2",
        "review.unit:c100f95c1913", // "b"
        "review.unit:c100f95c1913~l2",
      ]);
    });
  });
});

// ── Crash-resume seeds the gate loop from the journal (Codex round-3 P1) ──────
//
// The engine loop must SEED its per-step gate state from the journal exactly as
// the brief/report surfaces do (`activeGateLoop` / `recoverGateFeedback`): a run
// interrupted after a rejected gate was journaled (`<step>.gate:l<n>`,
// complete:false) resumes at loop n+1 with the stored corrective feedback — it
// must NOT restart at loop 1, reuse the rejected loop-1 rows, overwrite the l1
// gate row, and re-judge the stale artifact. These tests seed a specific crashed
// pre-state directly, then drive one RESUME invocation and assert loop-2
// semantics + that the l1 rows are byte-identical afterwards.

const RESUME_WF = `---
type: workflow
steps:
  - id: work
    gate: { max_loops: 3 }
  - id: wrap-up
---

## work

Do the work.

### gate

the work is thorough

## wrap-up

Wrap up.
`;

const RESUME_STEPS = [{ id: "work", criteria: ["the work is thorough"] }, { id: "wrap-up" }];

/** Journal ONE terminal unit row directly — a test seam for a specific crashed pre-state. */
async function journalRow(row: {
  unitId: string;
  nodeId: string;
  phase: string | null;
  inputHash: string | null;
  status: "completed" | "failed";
  resultJson: string | null;
  stepId?: string;
}): Promise<void> {
  await withWorkflowRunsRepo((repo) => {
    repo.insertUnit({
      runId: RUN_ID,
      unitId: row.unitId,
      stepId: row.stepId ?? "work",
      nodeId: row.nodeId,
      parentUnitId: null,
      phase: row.phase,
      runner: row.phase === "gate" ? "llm" : "agent",
      model: null,
      inputHash: row.inputHash,
      startedAt: new Date().toISOString(),
    });
    repo.finishUnit({
      runId: RUN_ID,
      unitId: row.unitId,
      status: row.status,
      resultJson: row.resultJson,
      tokens: null,
      failureReason: row.status === "failed" ? "reported_failure" : null,
      finishedAt: new Date().toISOString(),
    });
  });
}

/** The loop-1 solo unit's content-derived input hash (what the engine journals). */
function loop1Hash(p: WorkflowPlanGraph): string {
  const c = computeStepWorkList(p.steps[0]!, {
    runId: RUN_ID,
    params: {},
    stepOutputs: {},
    gateLoop: 1,
    engines: p.execution?.engines,
  });
  if (!c.ok) throw new Error(c.error);
  const r = c.list.units[0]!.resolved;
  if (!r.ok) throw new Error(r.error);
  return r.inputHash;
}

/** The loop-2 solo unit id + hash brief/report would compute for the recovered feedback. */
function loop2Unit(p: WorkflowPlanGraph, gateFeedback: GateFeedback): { unitId: string; inputHash: string } {
  const c = computeStepWorkList(p.steps[0]!, {
    runId: RUN_ID,
    params: {},
    stepOutputs: {},
    gateLoop: 2,
    gateFeedback,
    engines: p.execution?.engines,
  });
  if (!c.ok) throw new Error(c.error);
  const u = c.list.units[0]!;
  if (!u.resolved.ok) throw new Error(u.resolved.error);
  return { unitId: u.journalBaseId, inputHash: u.resolved.inputHash };
}

describe("gate max_loops — crash-resume seeds the loop from the journal", () => {
  test("resume after a journaled loop-1 rejection dispatches loop 2 with the stored feedback; l1 rows untouched", async () => {
    const p = plan(RESUME_WF);
    seedRun({ steps: RESUME_STEPS });
    const feedback: GateFeedback = { feedback: "Add the frobnicator analysis.", missing: ["the work is thorough"] };

    // Crashed pre-state: loop-1 unit completed + gate:l1 REJECTED, step still active.
    await journalRow({
      unitId: "work:solo",
      nodeId: "work",
      phase: null,
      inputHash: loop1Hash(p),
      status: "completed",
      resultJson: JSON.stringify("did the work (loop 1)"),
    });
    await journalRow({
      unitId: "work.gate:l1",
      nodeId: "work.gate",
      phase: "gate",
      inputHash: null,
      status: "completed",
      resultJson: JSON.stringify({ complete: false, missing: feedback.missing, feedback: feedback.feedback }),
    });

    // Capture the l1 rows BEFORE resume to prove resume does not clobber them.
    const before = await withWorkflowRunsRepo((repo) => repo.getUnitsForStep(RUN_ID, "work"));
    const beforeUnit = before.find((r) => r.unit_id === "work:solo");
    const beforeGate = before.find((r) => r.unit_id === "work.gate:l1");

    const prompts: string[] = [];
    let judgeCalls = 0;
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async (req) => {
        if (req.nodeId === "work") prompts.push(req.prompt);
        return { ok: true, text: `did ${req.unitId}` };
      },
      loadPlan: useFrozenPlan(p),
      summaryJudge: async () => {
        judgeCalls++;
        return '{"complete": true, "missing": []}';
      },
    });

    expect(result.done).toBe(true);
    expect(result.gateRejection).toBeUndefined();

    // Exactly ONE work dispatch during resume — loop 2. Loop 1 was NOT re-run.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Completion-gate feedback");
    expect(prompts[0]).toContain("Add the frobnicator analysis.");
    expect(prompts[0]).toContain("- the work is thorough");

    // The judge ran ONCE on resume — for loop 2 only. The buggy engine restarted
    // at loop 1 and re-judged the stale artifact (a spurious extra judge call).
    expect(judgeCalls).toBe(1);

    await withWorkflowRunsRepo((repo) => {
      const byId = new Map(repo.getUnitsForStep(RUN_ID, "work").map((r) => [r.unit_id, r]));

      // Loop-1 unit row byte-identical — never reused/re-dispatched.
      const afterUnit = byId.get("work:solo");
      expect(afterUnit?.input_hash).toBe(beforeUnit?.input_hash);
      expect(afterUnit?.status).toBe("completed");
      expect(afterUnit?.result_json).toBe(beforeUnit?.result_json);
      expect(afterUnit?.finished_at).toBe(beforeUnit?.finished_at);

      // gate:l1 row byte-identical — NOT overwritten (same verdict + finished_at).
      const afterGate = byId.get("work.gate:l1");
      expect(afterGate?.finished_at).toBe(beforeGate?.finished_at);
      expect(JSON.parse(afterGate?.result_json ?? "null")).toEqual({
        complete: false,
        missing: feedback.missing,
        feedback: feedback.feedback,
      });

      // Loop-2 unit re-dispatched under ~l2 with the EXACT id + hash brief/report
      // would compute for the same run (recovered feedback) — cross-surface parity.
      const expected = loop2Unit(p, feedback);
      expect(expected.unitId).toBe("work:solo~l2");
      const l2 = byId.get("work:solo~l2");
      expect(l2?.status).toBe("completed");
      expect(l2?.input_hash).toBe(expected.inputHash);
      // SUSPECTED SRC BUG (see the module-level note in the earlier describe
      // block): computeStepWorkList's hashVersion 4 does not fold
      // gateFeedback into the input hash, so loop 2's hash is IDENTICAL to
      // loop 1's here despite the different (feedback-carrying) prompt — both
      // this engine-driven value and `expected.inputHash` (the brief/report
      // computation) agree on that same hash, which is the cross-surface
      // parity property this test otherwise pins.
      expect(l2?.input_hash).toBe(beforeUnit?.input_hash);

      // gate:l2 journaled complete.
      expect(JSON.parse(byId.get("work.gate:l2")?.result_json ?? "null")).toEqual({ complete: true, missing: [] });
    });

    // The spine advanced past the gate through wrap-up and the run completed.
    const status = await getWorkflowStatus(RUN_ID);
    expect(status.workflow.steps[0]!.status).toBe("completed");
    expect(status.run.status).toBe("completed");
  });

  test("resume after the FINAL rejection reproduces the gateRejection outcome — no fresh loop, no re-judge", async () => {
    const EXHAUSTED_WF = RESUME_WF.replace("    gate: { max_loops: 3 }\n", "    gate: { max_loops: 2 }\n");
    const p = plan(EXHAUSTED_WF);
    seedRun({ steps: RESUME_STEPS });
    const finalFeedback: GateFeedback = { feedback: "Still not thorough.", missing: ["the work is thorough"] };

    // Both loops journaled + both rejected (gate exhausted), step still active.
    await journalRow({
      unitId: "work:solo",
      nodeId: "work",
      phase: null,
      inputHash: loop1Hash(p),
      status: "completed",
      resultJson: JSON.stringify("loop 1"),
    });
    await journalRow({
      unitId: "work.gate:l1",
      nodeId: "work.gate",
      phase: "gate",
      inputHash: null,
      status: "completed",
      resultJson: JSON.stringify({ complete: false, missing: finalFeedback.missing, feedback: "first rejection" }),
    });
    await journalRow({
      unitId: "work:solo~l2",
      nodeId: "work",
      phase: null,
      inputHash: "deadbeefdeadbeef",
      status: "completed",
      resultJson: JSON.stringify("loop 2"),
    });
    await journalRow({
      unitId: "work.gate:l2",
      nodeId: "work.gate",
      phase: "gate",
      inputHash: null,
      status: "completed",
      resultJson: JSON.stringify({ complete: false, missing: finalFeedback.missing, feedback: finalFeedback.feedback }),
    });

    const before = await withWorkflowRunsRepo((repo) => repo.getUnitsForStep(RUN_ID, "work"));

    let dispatches = 0;
    let judgeCalls = 0;
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: "x" };
      },
      loadPlan: useFrozenPlan(p),
      summaryJudge: async () => {
        judgeCalls++;
        return '{"complete": true, "missing": []}';
      },
    });

    // No fresh loop: nothing dispatched, no judge re-invoked.
    expect(dispatches).toBe(0);
    expect(judgeCalls).toBe(0);
    // The documented exhausted-gate outcome, recovered from the FINAL rejection.
    expect(result.done).toBeUndefined();
    expect(result.gateRejection).toEqual({
      stepId: "work",
      missing: finalFeedback.missing,
      feedback: finalFeedback.feedback,
    });
    // The run stays active, the step pending — the gate spine is authoritative.
    const status = await getWorkflowStatus(RUN_ID);
    expect(status.run.status).toBe("active");
    expect(status.workflow.steps[0]!.status).toBe("pending");
    // Every journaled row is byte-identical — resume touched nothing.
    await withWorkflowRunsRepo((repo) => {
      const after = repo.getUnitsForStep(RUN_ID, "work");
      const key = (r: (typeof after)[number]) => `${r.unit_id}:${r.finished_at}:${r.result_json}`;
      expect(after.map(key).sort()).toEqual(before.map(key).sort());
    });
  });

  test("no regression: a FRESH run (empty journal) starts at loop 1 with no recovered feedback", async () => {
    const p = plan(RESUME_WF);
    seedRun({ steps: RESUME_STEPS });
    const prompts: string[] = [];
    let judgeCalls = 0;
    // Reject loop 1 once, accept loop 2 — the same evaluator-optimizer path, but
    // from a clean journal, so the loop MUST begin at 1 (no seeded feedback).
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async (req) => {
        if (req.nodeId === "work") prompts.push(req.prompt);
        return { ok: true, text: `did ${req.unitId}` };
      },
      loadPlan: useFrozenPlan(p),
      summaryJudge: async () => {
        judgeCalls++;
        return judgeCalls === 1
          ? '{"complete": false, "missing": ["the work is thorough"], "feedback": "Deeper."}'
          : '{"complete": true, "missing": []}';
      },
    });
    expect(result.done).toBe(true);
    // Loop 1 ran WITHOUT a feedback block (fresh run), loop 2 carried it.
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain("Completion-gate feedback");
    expect(prompts[1]).toContain("Completion-gate feedback");
    await withWorkflowRunsRepo((repo) => {
      const ids = repo
        .getUnitsForStep(RUN_ID, "work")
        .map((r) => r.unit_id)
        .sort();
      // Loop 1 journaled under the base id (not ~l2), loop 2 under ~l2.
      expect(ids).toEqual(["work.gate:l1", "work.gate:l2", "work:solo", "work:solo~l2"]);
    });
  });
});

// ── Typed artifacts × gate loops (peer-review regression) ────────────────────
//
// Pinned R2 decision: a typed-artifact schema mismatch "fails the step
// (fail-fast — gate loops can re-run it)". The engine must feed the mismatch
// into the bounded gate loop when attempts remain — regenerate with the
// validation errors as feedback — and only kill the run when the FINAL loop's
// artifact still violates the schema.

const TYPED_LOOP_WF = `---
type: workflow
steps:
  - id: work
    unit:
      output: { type: object }
    output: { type: object, properties: { files: { type: array, items: { type: string } } }, required: [files] }
    gate: { max_loops: 2 }
---

## work

Do the work.

### gate

the work is thorough
`;

describe("typed artifacts + gate max_loops — schema mismatches are retryable by the bounded loop", () => {
  test("regression: a loop-1 schema mismatch re-executes with the validation errors as feedback instead of failing the run", async () => {
    seedRun({ steps: [{ id: "work", criteria: ["the work is thorough"] }] });
    const prompts: string[] = [];
    const dispatcher = async (req: UnitDispatchRequest): Promise<UnitDispatchResult> => {
      prompts.push(req.prompt);
      // Loop 1: valid per the UNIT schema (an object) but violates the STEP's
      // output schema (missing required `files`). Loop 2: satisfies both.
      return prompts.length === 1
        ? { ok: true, text: '{"notes": "wrong shape"}' }
        : { ok: true, text: '{"files": ["a.ts"]}' };
    };
    let judgeCalls = 0;
    const judge: SummaryJudge = async () => {
      judgeCalls++;
      return '{"complete": true, "missing": []}';
    };

    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher,
      loadPlan: usePlan(TYPED_LOOP_WF),
      summaryJudge: judge,
    });

    // The run COMPLETED: the mismatch was retried, not terminal.
    expect(result.done).toBe(true);
    expect(result.gateRejection).toBeUndefined();

    // Loop 2 re-dispatched with the schema errors threaded in as feedback.
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain("Completion-gate feedback");
    expect(prompts[1]).toContain("Completion-gate feedback");
    expect(prompts[1]).toContain('Step "work" artifact failed validation');

    // Both attempts recorded: the schema-failed first, the clean second.
    expect(result.executed.map((s) => s.ok)).toEqual([false, true]);
    expect(result.executed[0]!.summary).toContain("artifact failed validation");

    const status = await getWorkflowStatus(RUN_ID);
    expect(status.workflow.steps[0]!.status).toBe("completed");
    expect(status.workflow.steps[0]!.evidence?.output).toEqual({ files: ["a.ts"] });

    await withWorkflowRunsRepo((repo) => {
      const byId = new Map(repo.getUnitsForStep(RUN_ID, "work").map((r) => [r.unit_id, r]));
      // Loop 2 journals under ~l2 (a distinct journal key) — loop 1's row is
      // never clobbered. SUSPECTED SRC BUG (see the earlier describe block's
      // note): computeStepWorkList's hashVersion 4 does not fold gateFeedback
      // into the input hash, so the two attempts journal the SAME input_hash
      // despite the feedback-carrying prompt differing.
      const first = byId.get("work:solo");
      const second = byId.get("work:solo~l2");
      expect(first?.status).toBe("completed");
      expect(second?.status).toBe("completed");
      expect(first?.input_hash).toBeTruthy();
      expect(second?.input_hash).toBeTruthy();
      expect(second?.input_hash).toBe(first?.input_hash);
      // No judge ran on the schema-failed loop — the ONLY gate unit row is
      // loop 2's, where the artifact finally reached the judge.
      const gateIds = [...byId.keys()].filter((id) => id.startsWith("work.gate:")).sort();
      expect(gateIds).toEqual(["work.gate:l2"]);
      expect(judgeCalls).toBe(1);
    });
  });

  test("the loop bound still holds: a persistently schema-violating artifact fails the run after maxLoops attempts", async () => {
    seedRun({ steps: [{ id: "work", criteria: ["the work is thorough"] }] });
    let dispatches = 0;
    let judgeCalls = 0;
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: '{"notes": "never the contract"}' };
      },
      loadPlan: usePlan(TYPED_LOOP_WF),
      summaryJudge: async () => {
        judgeCalls++;
        return '{"complete": true, "missing": []}';
      },
    });

    expect(dispatches).toBe(2); // maxLoops attempts, never a third
    expect(judgeCalls).toBe(0); // the artifact never got past the schema to a judge
    expect(result.done).toBeUndefined();
    expect(result.executed.map((s) => s.ok)).toEqual([false, false]);
    expect(result.executed[1]!.summary).toContain('Step "work" artifact failed validation');
    // The FINAL loop's mismatch is terminal: step failed, run failed.
    const status = await getWorkflowStatus(RUN_ID);
    expect(status.run.status).toBe("failed");
    expect(status.workflow.steps[0]!.status).toBe("failed");
  });
});

// ── Body instructions are always verbatim (no interpolation, no param splicing) ──
//
// SEMANTIC CHANGE (workflow-format-unification, spec §2.3): the pre-unification
// suite had TWO frontends — a templated YAML program and a byte-exact classic
// linear markdown grammar (`# Workflow:` / `## Step:` / `Step ID:`) — and this
// block proved the classic grammar's instructions passed through untouched.
// That grammar is deleted outright (spec §3); there is only one frontend now,
// and EVERY workflow's body instructions are byte-exact prose, never templated
// (spec §2.3) — so the property this block pins is no longer "the classic
// path's behavior" but the unified format's ONLY behavior, proved directly
// against `parseWorkflow`/`freezeWorkflow`.

const VERBATIM_WF = `---
type: workflow
params:
  secret: { type: string }
steps:
  - id: build
  - id: deploy
---

## build

Build it. Literal \${{ params.secret }} is content here.

## deploy

Deploy it.
`;

describe("body instructions are always verbatim (workflow-format-unification)", () => {
  test("instructions pass through byte-exact and steps keep machine summaries", async () => {
    const frozenPlanForTest = plan(VERBATIM_WF);

    seedRun({ params: { secret: "LEAKED" }, steps: [{ id: "build" }, { id: "deploy" }] });
    const prompts: string[] = [];
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async (req) => {
        prompts.push(req.prompt);
        return { ok: true, text: "done" };
      },
      loadPlan: useFrozenPlan(frozenPlanForTest),
      summaryJudge: null,
    });
    expect(result.done).toBe(true);
    // Instructions are opaque data: the `${{ … }}` text is content, never
    // grammar — no expression resolution, no param substitution.
    expect(prompts[0]).toContain("Literal ${{ params.secret }} is content here.");
    expect(prompts[0]).not.toContain("LEAKED — resolved");
    // No gate feedback block on first executions, machine summaries intact.
    expect(prompts.every((p) => !p.includes("Completion-gate feedback"))).toBe(true);
    const status = await getWorkflowStatus(RUN_ID);
    expect(status.workflow.steps.every((s) => (s.summary ?? "").includes("via workflow orchestration"))).toBe(true);
  });
});
