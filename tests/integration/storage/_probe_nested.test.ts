import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import { WorkflowRunsRepository } from "../../../src/storage/repositories/workflow-runs-repository";
import { canonicalPlanJson, computePlanHash } from "../../../src/workflows/ir/plan-hash";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";
import { seedWorkflowRun } from "../../_helpers/workflow";

let storage: IsolatedAkmStorage;
beforeEach(() => { storage = withIsolatedAkmStorage(); });
afterEach(() => storage.cleanup());

test("probe: BEGIN IMMEDIATE observed at outermost, absent when nested", () => {
  const db = openStateDatabase(getStateDbPath());
  try {
    seedWorkflowRun(db, { runId: "p1", workflowRef: "workflows/parent", scopeKey: "s", steps: ["spawn"] });
    const repo = new WorkflowRunsRepository(db);
    const fakePlan = { irVersion: 5, title: "child", steps: [] };
    const input = (runId: string, key: string) => ({
      parentRunId: "p1",
      spawnedByUnitId: "spawn.unit",
      invocationKey: key,
      run: {
        id: runId, workflowRef: "workflows/child", scopeKey: "s", workflowEntryId: null,
        workflowTitle: "child", paramsJson: "{}", currentStepId: "spawn",
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
        agentHarness: null, agentSessionId: null, checkinArmedAt: null,
      },
      steps: [{ runId, stepId: "spawn", stepTitle: "spawn", instructions: "x", completionJson: null, sequenceIndex: 0 }],
      planJson: canonicalPlanJson(fakePlan),
      planHash: computePlanHash(fakePlan),
    });

    const execCalls: string[] = [];
    const spy = spyOn(db, "exec").mockImplementation(((sql: string, ...args: unknown[]) => {
      execCalls.push(sql);
      return (spy.wrappedMethod as any).call(db, sql, ...args);
    }) as any);

    (repo as any).publishChildWorkflowRun(input("c1", "k1"));
    console.log("outermost execCalls:", JSON.stringify(execCalls));
    spy.mockRestore();

    // Now nested: open our own transaction first.
    db.exec("BEGIN");
    const execCalls2: string[] = [];
    const spy2 = spyOn(db, "exec").mockImplementation(((sql: string, ...args: unknown[]) => {
      execCalls2.push(sql);
      return (spy2.wrappedMethod as any).call(db, sql, ...args);
    }) as any);
    (repo as any).publishChildWorkflowRun(input("c2", "k2"));
    console.log("nested execCalls:", JSON.stringify(execCalls2));
    spy2.mockRestore();
    db.exec("COMMIT");
  } finally {
    db.close();
  }
});
