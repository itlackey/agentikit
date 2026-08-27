// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P3a Lane A TESTS — the v4 complete-or-abandon policy (spec
 * docs/plans/specs/p3a-plan-v5-child-freeze.md §3.2, behavior rows
 * A-03…A-10, A-16). Once plan `irVersion` 5 becomes the sole EXECUTABLE
 * version, a stored `plan_ir_version = 4` run must stay readable and
 * abandonable (`status` / `list` / `abandon`) while `resume` / `next` /
 * `complete` / `run` fail closed under `WORKFLOW_IR_VERSION_UNSUPPORTED`
 * (A-N2: this code already exists in `UsageErrorCode`, `src/core/errors.ts`,
 * with no producer anywhere — P3a is its first).
 *
 * Every fixture below asserts, immediately after `startWorkflowRun`, that
 * the fresh row's `plan_ir_version` is the CURRENT executable version (a
 * pin for row A-01 — post-Implement that is plan irVersion 5), and THEN
 * hand-tampers the row down to `plan_ir_version = 4` via the same raw-SQL
 * escape hatch `tests/integration/workflows/frozen-plan.test.ts:258` uses
 * for its `plan_ir_version = 2` fixture — exactly as that file's F-A2 flip
 * does. Without the tamper, a fresh run would simply freeze to whatever the
 * current version already is and never reach the retired case at all.
 *
 * RED today, for exactly one reason: `startWorkflowRun` still freezes to
 * `WORKFLOW_IR_V4_VERSION` (4) AND `plan-classifier.ts` still treats 4 as
 * the CURRENT/supported version, so the pre-tamper pin below — asserting
 * the fresh row already carries plan irVersion 5 — fails today (A-N1:
 * `WORKFLOW_IR_V4_VERSION` is deleted, not merely superseded, so 4 is never
 * current again once Implement lands). Once Implement moves the "current"
 * line to `WORKFLOW_IR_V5_VERSION` (5), that pin goes green and the
 * hand-tampered row becomes exactly the retired case this file exercises.
 *
 * No `@ts-expect-error` directives: `WORKFLOW_IR_VERSION_UNSUPPORTED` is
 * already a real `UsageErrorCode` member (A-N2), `WorkflowRunRow.plan_ir_version`
 * and `WorkflowRunSummary.planIrVersion`/`.executionSupport` are already
 * widely typed (`number | null` / `"supported" | "unsupported-version" |
 * "missing-plan" | "corrupt-plan"`, not narrow literals), so every assertion
 * below type-checks today and stays green after Implement with no directive
 * to add or remove.
 *
 * Sandbox/fixture pattern follows
 * `tests/integration/workflows/frozen-plan.test.ts`'s "non-current workflow
 * IR is unsupported on every live plan surface" /  "malformed and
 * unsupported plans can be abandoned" tests — this file is their v4-specific
 * successor, not an edit to that file (which F-A2 owns; see the spec's §6
 * flips table).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { UsageError } from "../../../src/core/errors";
import { openStateDatabase } from "../../../src/core/state-db";
import { resolveStorageLocations } from "../../../src/storage/locations";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import {
  abandonWorkflowRun,
  completeWorkflowStep,
  getNextWorkflowStep,
  getWorkflowStatus,
  listWorkflowRuns,
  resumeWorkflowRun,
  startWorkflowRun,
} from "../../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});

afterEach(() => storage.cleanup());

function writeWorkflow(name: string, instructions: string): string {
  const file = path.join(storage.stashDir, "workflows", `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = [
    "---",
    "type: workflow",
    "steps:",
    "  - id: only-step",
    "---",
    "",
    "## only-step",
    "",
    instructions,
    "",
  ].join("\n");
  fs.writeFileSync(file, content, "utf8");
  return file;
}

/** Direct-SQL escape hatch, mirroring frozen-plan.test.ts. */
function execOnWorkflowDb(sql: string, ...params: Array<string | number | null>): void {
  const db = openStateDatabase(resolveStorageLocations().stateDb);
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

/** §3.2's exact unsupported-version message. */
function unsupportedVersionMessage(runId: string, version: number): string {
  return (
    `Workflow run ${runId} was frozen as workflow plan irVersion ${version}; pre-irVersion-5 ` +
    `plans cannot execute after the 0.9.2 upgrade. Complete them before upgrading, or run ` +
    `'akm workflow abandon ${runId}' and start a new run from the authored workflow. ` +
    `'akm workflow status' and 'akm workflow list' still work on this run.`
  );
}

describe("A-03…A-06, A-16 — a stored plan_ir_version 4 run", () => {
  test("status, list, and abandon keep working; resume/next/complete/run fail closed with WORKFLOW_IR_VERSION_UNSUPPORTED, and no unit row is ever created by the attempt", async () => {
    writeWorkflow("retiring", "Do the work.");
    const started = await startWorkflowRun("workflows/retiring", {});
    const runId = started.run.id;

    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(runId));
    // A-01: a fresh run persists the CURRENT plan irVersion — post-Implement, 5.
    expect(row?.plan_ir_version).toBe(5);

    // Hand-tamper to a genuinely non-current stored version (mirrors
    // frozen-plan.test.ts:258's plan_ir_version = 2 fixture). Every
    // assertion below must run against a row we've deliberately aged to a
    // version that is NOT the current one, or the complete-or-abandon
    // policy under test never actually engages.
    execOnWorkflowDb("UPDATE workflow_runs SET plan_ir_version = 4 WHERE id = ?", runId);

    // A-03/A-04 (NEW): status/list report the policy against the SAME row.
    const status = await getWorkflowStatus(runId);
    expect(status.run.executionSupport).toBe("unsupported-version");
    expect(status.run.planIrVersion).toBe(4);
    expect((await getWorkflowStatus(runId, { includeUnits: true })).units).toEqual([]);

    const listed = (await listWorkflowRuns()).runs.find((run) => run.id === runId);
    expect(listed?.executionSupport).toBe("unsupported-version");
    expect(listed?.planIrVersion).toBe(4);

    // A-16: nothing has re-hashed a unit yet — the journal is still empty.
    const unitsBeforeAttempts = await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(runId));
    expect(unitsBeforeAttempts).toEqual([]);

    // A-06 (NEW): resume / next / complete / run fail closed with the exact code + message.
    const expectRetired = async (operation: Promise<unknown>): Promise<void> => {
      try {
        await operation;
        throw new Error("expected WORKFLOW_IR_VERSION_UNSUPPORTED");
      } catch (error) {
        expect(error).toBeInstanceOf(UsageError);
        expect((error as UsageError).code).toBe("WORKFLOW_IR_VERSION_UNSUPPORTED");
        expect((error as UsageError).message).toBe(unsupportedVersionMessage(runId, 4));
      }
    };
    await expectRetired(getNextWorkflowStep(runId));
    await expectRetired(completeWorkflowStep({ runId, stepId: "only-step", status: "blocked" }));
    await expectRetired(resumeWorkflowRun(runId));
    await expectRetired(runWorkflowSteps({ target: runId, summaryJudge: null }));

    // A-16: still nothing durable happened — requireExecutableWorkflowPlan
    // fails BEFORE any unit is ever computed/journaled under the (mixed)
    // hashVersion vocabulary.
    expect(await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(runId))).toEqual([]);

    // A-05 (PRESERVE): abandon still works, and the spine is untouched.
    const stepsBefore = await withWorkflowRunsRepo((repo) => repo.getStepsForRun(runId));
    expect((await abandonWorkflowRun(runId)).run.status).toBe("failed");
    expect(await withWorkflowRunsRepo((repo) => repo.getStepsForRun(runId))).toEqual(stepsBefore);

    // status/list keep working post-abandon too.
    expect((await getWorkflowStatus(runId)).run.status).toBe("failed");
    expect((await listWorkflowRuns()).runs.find((run) => run.id === runId)?.status).toBe("failed");
  });
});

describe("A-07, A-08 — missing-plan and corrupt-plan retain INVALID_JSON_ARGUMENT (PRESERVE)", () => {
  test("a run with plan_json = NULL is missing-plan, not unsupported-version", async () => {
    writeWorkflow("missing-plan-v4r", "Do the work.");
    const started = await startWorkflowRun("workflows/missing-plan-v4r", {});
    execOnWorkflowDb(
      "UPDATE workflow_runs SET plan_json = NULL, plan_hash = NULL, plan_ir_version = NULL WHERE id = ?",
      started.run.id,
    );
    try {
      await getNextWorkflowStep(started.run.id);
      throw new Error("expected missing-plan rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).code).toBe("INVALID_JSON_ARGUMENT");
    }
  });

  test("a plan_ir_version 5 run with malformed plan_json is corrupt-plan, not unsupported-version", async () => {
    // A-08 is tagged PRESERVE: the corrupt-plan CODE (INVALID_JSON_ARGUMENT)
    // does not change. Today, plan_ir_version 5 is not yet current, so this
    // row is decided by the "unsupported-version" branch instead of
    // "corrupt-plan" — but A-N2 gives both branches the SAME code today
    // (the classifier does not yet split by branch at all; that split is
    // itself part of Implement), so this assertion already holds and stays
    // held once Implement moves "current" to 5 and the row is decided by
    // "corrupt-plan" instead. A genuine regression guard, not a RED probe.
    writeWorkflow("corrupt-v5", "Do the work.");
    const started = await startWorkflowRun("workflows/corrupt-v5", {});
    execOnWorkflowDb(
      "UPDATE workflow_runs SET plan_json = ?, plan_hash = NULL, plan_ir_version = 5 WHERE id = ?",
      "{malformed",
      started.run.id,
    );
    try {
      await getNextWorkflowStep(started.run.id);
      throw new Error("expected corrupt-plan rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).code).toBe("INVALID_JSON_ARGUMENT");
    }
    // PRESERVE (mirrors frozen-plan.test.ts): still abandonable, spine untouched.
    const stepsBefore = await withWorkflowRunsRepo((repo) => repo.getStepsForRun(started.run.id));
    expect((await abandonWorkflowRun(started.run.id)).run.status).toBe("failed");
    expect(await withWorkflowRunsRepo((repo) => repo.getStepsForRun(started.run.id))).toEqual(stepsBefore);
  });
});

describe("A-09 — the WORKFLOW_IR_VERSION_UNSUPPORTED hint", () => {
  test('UsageError(..., "WORKFLOW_IR_VERSION_UNSUPPORTED").hint() returns §3.2\'s exact hint string', () => {
    const error = new UsageError("irrelevant message", "WORKFLOW_IR_VERSION_UNSUPPORTED");
    expect(error.hint()).toBe(
      "Abandon the run with `akm workflow abandon <id>`, then start it again from the " +
        "workflow source — pre-0.9.2 frozen plans are not re-executable.",
    );
  });
});
