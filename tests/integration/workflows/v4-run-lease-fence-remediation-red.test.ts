// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import {
  type WorkflowRunsRepository,
  type WorkflowRunUnitAttemptRowV4,
  withWorkflowRunsRepo,
} from "../../../src/storage/repositories/workflow-runs-repository";
import { executeStepPlan } from "../../../src/workflows/exec/native-executor";
import { decodeWorkflowPlanV4 } from "../../../src/workflows/ir/schema-v4";
import { startWorkflowRun } from "../../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../../_helpers/sandbox";

type LeaseMode = "engine" | "direct";

interface FencedReserveInput {
  runId: string;
  unitId: string;
  stepId: string;
  nodeId: string;
  phase: "unit" | "gate";
  runner: string | null;
  engine: string | null;
  model: string | null;
  inputHash: string;
  claimHolder: string;
  claimExpiresAt: string;
  now: string;
  leaseMode: LeaseMode;
}

interface FencedAttemptsRepository {
  reserveUnitAttempt(input: FencedReserveInput): {
    kind: "reserved" | "existing" | "reclaimed" | "busy";
    attempt: WorkflowRunUnitAttemptRowV4;
  };
}

const START = "2026-08-22T12:00:00.000Z";
const LIVE = "2026-08-22T12:01:30.000Z";
const EXPIRED = "2026-08-22T11:59:59.000Z";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});

afterEach(() => storage.cleanup());

function writeWorkflow(name: string): void {
  const file = path.join(storage.stashDir, "workflows", `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      "---",
      "type: workflow",
      `description: ${name}`,
      "steps:",
      "  - id: work",
      "---",
      "",
      "## work",
      "",
      "Perform fenced work.",
      "",
    ].join("\n"),
  );
}

async function startedRun(name: string): Promise<string> {
  writeWorkflow(name);
  return (await startWorkflowRun(`workflows/${name}`, {})).run.id;
}

function fenced(repo: WorkflowRunsRepository): FencedAttemptsRepository {
  return repo as unknown as FencedAttemptsRepository;
}

function reserveInput(
  runId: string,
  claimHolder: string,
  leaseMode: LeaseMode,
  overrides: Partial<FencedReserveInput> = {},
): FencedReserveInput {
  return {
    runId,
    unitId: "work:solo",
    stepId: "work",
    nodeId: "work.unit",
    phase: "unit",
    runner: "agent",
    engine: "test-agent",
    model: null,
    inputHash: "frozen-input-hash",
    claimHolder,
    claimExpiresAt: LIVE,
    now: START,
    leaseMode,
    ...overrides,
  };
}

function unitMutationCounts(runId: string): { attempts: number; units: number; events: number } {
  const db = openStateDatabase(getStateDbPath());
  try {
    const scalar = (sql: string) => Number((db.prepare(sql).get(runId) as { count: number } | undefined)?.count ?? 0);
    return {
      attempts: scalar("SELECT COUNT(*) AS count FROM workflow_run_unit_attempts WHERE run_id = ?"),
      units: scalar("SELECT COUNT(*) AS count FROM workflow_run_units WHERE run_id = ?"),
      events: scalar(
        "SELECT COUNT(*) AS count FROM events WHERE event_type LIKE 'workflow_unit_%' AND json_extract(metadata_json, '$.runId') = ?",
      ),
    };
  } finally {
    db.close();
  }
}

describe("v4 attempt reservation is fenced by the current run lease", () => {
  test("a stale engine holder is rejected in the reservation transaction with zero mutation", async () => {
    const runId = await startedRun("lease-stale-repo");
    await withWorkflowRunsRepo((repo) => {
      expect(repo.acquireEngineLease(runId, "engine-current", LIVE, START)).toBe(true);
      expect(() => fenced(repo).reserveUnitAttempt(reserveInput(runId, "engine-stale", "engine"))).toThrow(
        /lease|holder|fence|current/i,
      );
    });
    expect(unitMutationCounts(runId)).toEqual({ attempts: 0, units: 0, events: 0 });
  });

  test("engine mode requires a live matching lease; expiry is rejection, not reservation authority", async () => {
    const runId = await startedRun("lease-expired-repo");
    await withWorkflowRunsRepo((repo) => {
      expect(repo.acquireEngineLease(runId, "engine-a", EXPIRED, "2026-08-22T11:59:00.000Z")).toBe(true);
      expect(() => fenced(repo).reserveUnitAttempt(reserveInput(runId, "engine-a", "engine"))).toThrow(
        /expired|lease|fence/i,
      );
    });
    expect(unitMutationCounts(runId)).toEqual({ attempts: 0, units: 0, events: 0 });
  });

  test("direct mode is separate: it works only while the run has no lease holder", async () => {
    const unleasedRun = await startedRun("lease-direct-free");
    await withWorkflowRunsRepo((repo) => {
      expect(fenced(repo).reserveUnitAttempt(reserveInput(unleasedRun, "direct:test", "direct")).kind).toBe("reserved");
    });

    const leasedRun = await startedRun("lease-direct-blocked");
    await withWorkflowRunsRepo((repo) => {
      expect(repo.acquireEngineLease(leasedRun, "engine-current", LIVE, START)).toBe(true);
      expect(() => fenced(repo).reserveUnitAttempt(reserveInput(leasedRun, "direct:test", "direct"))).toThrow(
        /direct|lease|holder/i,
      );
    });
    expect(unitMutationCounts(leasedRun)).toEqual({ attempts: 0, units: 0, events: 0 });
  });

  test("lease theft reclaims the same attempt and dispatch id; the stale terminal CAS loses", async () => {
    const runId = await startedRun("lease-reclaim-repo");
    await withWorkflowRunsRepo((repo) => {
      expect(repo.acquireEngineLease(runId, "engine-a", LIVE, START)).toBe(true);
      const first = fenced(repo).reserveUnitAttempt(reserveInput(runId, "engine-a", "engine")).attempt;
      expect(repo.renewEngineLease(runId, "engine-a", EXPIRED)).toBe(true);
      expect(repo.acquireEngineLease(runId, "engine-b", LIVE, START)).toBe(true);

      const reclaimed = fenced(repo).reserveUnitAttempt(
        reserveInput(runId, "engine-b", "engine", { claimExpiresAt: LIVE }),
      );
      expect(reclaimed.kind).toBe("reclaimed");
      expect(reclaimed.attempt.attempt).toBe(first.attempt);
      expect(reclaimed.attempt.dispatch_id).toBe(first.dispatch_id);
      expect(
        repo.finishUnitAttempt({
          runId,
          unitId: first.unit_id,
          attempt: first.attempt,
          dispatchId: first.dispatch_id,
          claimHolder: "engine-a",
          status: "completed",
          resultJson: JSON.stringify("stale"),
          tokens: 99,
          failureReason: null,
          finishedAt: "2026-08-22T12:00:02.000Z",
        }),
      ).toBe(false);
    });
  });
});

describe("real v4 start/lease/reservation race", () => {
  test("a displaced driver reaches no dispatcher and writes no attempt/event", async () => {
    const runId = await startedRun("lease-stale-runtime");
    const row = await withWorkflowRunsRepo((repo) => {
      expect(repo.acquireEngineLease(runId, "engine-a", LIVE, START)).toBe(true);
      expect(repo.renewEngineLease(runId, "engine-a", EXPIRED)).toBe(true);
      expect(repo.acquireEngineLease(runId, "engine-b", LIVE, START)).toBe(true);
      return repo.getRunById(runId);
    });
    if (!row?.plan_json) throw new Error("expected persisted v4 plan");
    const plan = decodeWorkflowPlanV4(JSON.parse(row.plan_json));
    const step = plan.steps[0];
    if (!step) throw new Error("expected one frozen step");
    let dispatches = 0;

    const result = await executeStepPlan(step, {
      runId,
      workflowRef: row.workflow_ref,
      leaseHolder: "engine-a",
      params: {},
      evidence: {},
      dispatcher: async () => {
        dispatches += 1;
        return { ok: true, text: "must not run" };
      },
    });

    expect(result.ok).toBe(false);
    expect(dispatches).toBe(0);
    expect(unitMutationCounts(runId)).toEqual({ attempts: 0, units: 0, events: 0 });
  });
});
