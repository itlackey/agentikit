// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { UsageError } from "../../../src/core/errors";
import { openStateDatabase } from "../../../src/core/state-db";
import { resolveStorageLocations } from "../../../src/storage/locations";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import { computePlanHash } from "../../../src/workflows/ir/plan-hash";
import type { WorkflowPlanGraphV4 } from "../../../src/workflows/ir/schema-v4";
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

/**
 * Frozen-plan contract (redesign addendum R1, migration 006):
 *
 *   - `workflow start` compiles the plan ONCE and persists `plan_json` +
 *     `plan_hash` on the run row, in the same transaction as the insert.
 *   - `workflow run` executes the FROZEN plan — the asset file is never
 *     re-read for an in-flight run, so a mid-run edit cannot change behavior.
 *   - A plan_json / plan_hash mismatch (journal tampering) fails loudly.
 *   - Missing or non-current plans are invalid live state and never rebuilt
 *     from the mutable workflow asset.
 */

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
    "description: Frozen-plan test workflow",
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

/** Direct-SQL escape hatch for simulating legacy rows / journal tampering. */
function execOnWorkflowDb(sql: string, ...params: Array<string | number | null>): void {
  const db = openStateDatabase(resolveStorageLocations().stateDb);
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

describe("plan freezing at workflow start (migration 006)", () => {
  test("a fresh run persists plan_json + plan_hash, and the hash verifies the JSON", async () => {
    writeWorkflow("freeze-me", "Do the frozen thing.");
    const started = await startWorkflowRun("workflows/freeze-me", {});

    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    expect(row?.plan_json).toBeTruthy();
    expect(row?.plan_hash).toBeTruthy();

    const plan = JSON.parse(row?.plan_json ?? "") as WorkflowPlanGraphV4;
    expect(plan.steps.map((s) => s.stepId)).toEqual(["only-step"]);
    // @ts-expect-error P3a red-phase: WORKFLOW_IR_V5_VERSION lands in Implement (the implementation removes this directive)
    expect(plan.irVersion).toBe(5);
    // @ts-expect-error P3a red-phase: WORKFLOW_IR_V5_VERSION lands in Implement (the implementation removes this directive)
    if (plan.irVersion !== 5) throw new Error("fresh starts must persist plan irVersion 5");
    expect(plan.steps[0]!.root?.kind).toBe("unit");
    expect(Object.hasOwn(plan.execution, "engines")).toBe(false);
    const root = plan.steps[0]!.root;
    if (!root || root.kind !== "unit") throw new Error("expected one current runtime unit");
    expect(root.frozenTarget.kind).toBe("command");
    if (root.frozenTarget.kind === "command") {
      expect(root.frozenTarget.request.engine.name).toBe("test-agent");
      expect(root.frozenTarget.runner.kind).toBe("sdk");
    }
    expect(computePlanHash(plan)).toBe(row?.plan_hash ?? "");

    // Lease columns exist on the row but are unset — enforcement is R2.
    expect(row?.engine_lease_until).toBeNull();
    expect(row?.engine_lease_holder).toBeNull();
  });

  test("workflow run executes the FROZEN plan even after the asset file is edited mid-run", async () => {
    const file = writeWorkflow("frozen-semantics", "Do the ORIGINAL thing.");
    const started = await startWorkflowRun("workflows/frozen-semantics", {});

    // Mid-run edit: the live asset now says something else entirely.
    writeWorkflow("frozen-semantics", "Do the EDITED thing.");
    expect(fs.readFileSync(file, "utf8")).toContain("EDITED");

    const prompts: string[] = [];
    const result = await runWorkflowSteps({
      target: started.run.id,
      dispatcher: async (req) => {
        prompts.push(req.prompt);
        return { ok: true, text: "done" };
      },
    });

    expect(result.done).toBe(true);
    expect(prompts).toHaveLength(1);
    // Old semantics: the frozen instructions dispatched, never the edited ones.
    expect(prompts[0]).toContain("Do the ORIGINAL thing.");
    expect(prompts[0]).not.toContain("Do the EDITED thing.");
  });

  test(`body instructions containing literal \${{ … }} pass through verbatim (stable contract)`, async () => {
    // Peer-review regression, preserved under the unified format: body prose is
    // opaque data, never scanned for `${{ … }}` grammar — only frontmatter
    // whole-value positions (map.over/route.input/inputs) carry the reference
    // grammar (spec §2.3). A literal `${{ github.sha }}` (GitHub Actions
    // syntax) in a step's instructions must dispatch byte-exact, never parsed
    // or substituted.
    writeWorkflow(
      "gha-doc",
      `Deploy the build for commit \${{ github.sha }}. Do not resolve \${{ params.tag }} either.`,
    );
    const started = await startWorkflowRun("workflows/gha-doc", { tag: "v1" });

    const prompts: string[] = [];
    const result = await runWorkflowSteps({
      target: started.run.id,
      dispatcher: async (req) => {
        prompts.push(req.prompt);
        return { ok: true, text: "done" };
      },
    });

    expect(result.done).toBe(true);
    expect(prompts).toHaveLength(1);
    // Unknown roots are content, not a parse error …
    expect(prompts[0]).toContain(`\${{ github.sha }}`);
    // … and even a well-formed reference is NOT substituted on the markdown path.
    expect(prompts[0]).toContain(`\${{ params.tag }}`);
    expect(prompts[0]).not.toContain("v1.");
  });

  test("a plan_json / plan_hash mismatch is rejected with an error naming the run", async () => {
    writeWorkflow("tampered", "Do the honest thing.");
    const started = await startWorkflowRun("workflows/tampered", {});

    // Tamper with the journaled plan while leaving the hash in place.
    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    const tampered = (row?.plan_json ?? "").replace("Do the honest thing.", "Do something sneaky.");
    execOnWorkflowDb("UPDATE workflow_runs SET plan_json = ? WHERE id = ?", tampered, started.run.id);

    let dispatches = 0;
    await expect(
      runWorkflowSteps({
        target: started.run.id,
        dispatcher: async () => {
          dispatches++;
          return { ok: true, text: "must not run" };
        },
      }),
    ).rejects.toThrow(new RegExp(`${started.run.id}.*integrity check`));
    expect(dispatches).toBe(0);
  });

  test("corrupt plan_json (not valid JSON) is rejected with an error naming the run", async () => {
    writeWorkflow("corrupt", "Do the thing.");
    const started = await startWorkflowRun("workflows/corrupt", {});
    execOnWorkflowDb("UPDATE workflow_runs SET plan_json = ? WHERE id = ?", "{not json", started.run.id);

    await expect(
      runWorkflowSteps({
        target: started.run.id,
        dispatcher: async () => ({ ok: true, text: "must not run" }),
      }),
    ).rejects.toThrow(new RegExp(`${started.run.id}.*corrupt frozen plan`));
  });

  test("a run without a frozen plan is rejected for execution but can be abandoned", async () => {
    writeWorkflow("missing-plan", "Do the thing.");
    const started = await startWorkflowRun("workflows/missing-plan", {});

    execOnWorkflowDb(
      "UPDATE workflow_runs SET plan_json = NULL, plan_hash = NULL, plan_ir_version = NULL WHERE id = ?",
      started.run.id,
    );

    let dispatches = 0;
    await expect(
      runWorkflowSteps({
        target: started.run.id,
        dispatcher: async () => {
          dispatches++;
          return { ok: true, text: "must not run" };
        },
      }),
    ).rejects.toThrow(new RegExp(`${started.run.id}.*has no frozen workflow plan`, "s"));
    expect(dispatches).toBe(0);
    execOnWorkflowDb(
      "UPDATE workflow_runs SET engine_lease_holder = ?, engine_lease_until = ? WHERE id = ?",
      "holder",
      "2099-01-01T00:00:00.000Z",
      started.run.id,
    );
    execOnWorkflowDb(
      `INSERT INTO workflow_run_units
         (run_id, unit_id, step_id, node_id, status, started_at)
       VALUES (?, 'unit-1', 'only-step', 'only-step', 'running', '2026-01-01T00:00:00.000Z')`,
      started.run.id,
    );
    const stepsBefore = await withWorkflowRunsRepo((repo) => repo.getStepsForRun(started.run.id));
    const unitsBefore = await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(started.run.id));
    expect((await abandonWorkflowRun(started.run.id)).run.status).toBe("failed");
    await expect(abandonWorkflowRun(started.run.id)).rejects.toThrow(/already failed/);

    const db = openStateDatabase(resolveStorageLocations().stateDb);
    try {
      const row = db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(started.run.id) as {
        engine_lease_holder: string | null;
        engine_lease_until: string | null;
      };
      expect(row.engine_lease_holder).toBe("holder");
      expect(row.engine_lease_until).toBe("2099-01-01T00:00:00.000Z");
      expect(
        db
          .prepare("SELECT metadata_json FROM events WHERE event_type = 'workflow_abandoned'")
          .all()
          .map((event) => JSON.parse((event as { metadata_json: string }).metadata_json)),
      ).toEqual([{ runId: started.run.id }]);
    } finally {
      db.close();
    }
    expect(await withWorkflowRunsRepo((repo) => repo.getStepsForRun(started.run.id))).toEqual(stepsBefore);
    expect(await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(started.run.id))).toEqual(unitsBefore);
  });

  test("non-current workflow IR is unsupported on every live plan surface", async () => {
    writeWorkflow("noncurrent-plan", "Do work.");
    const started = await startWorkflowRun("workflows/noncurrent-plan", {});
    execOnWorkflowDb(
      "UPDATE workflow_runs SET plan_json = ?, plan_hash = NULL, plan_ir_version = 2 WHERE id = ?",
      '{"irVersion":2}',
      started.run.id,
    );

    const status = await getWorkflowStatus(started.run.id);
    expect(status.run.executionSupport).toBe("unsupported-version");
    expect((await getWorkflowStatus(started.run.id, { includeUnits: true })).units).toEqual([]);
    expect((await listWorkflowRuns()).runs.find((run) => run.id === started.run.id)?.executionSupport).toBe(
      "unsupported-version",
    );

    const expectCorrupt = async (operation: Promise<unknown>): Promise<void> => {
      try {
        await operation;
        throw new Error("expected current workflow IR rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(UsageError);
        expect((error as UsageError).code).toBe("WORKFLOW_IR_VERSION_UNSUPPORTED");
      }
    };
    await expectCorrupt(getNextWorkflowStep(started.run.id));
    await expectCorrupt(completeWorkflowStep({ runId: started.run.id, stepId: "only-step", status: "blocked" }));
    await expectCorrupt(resumeWorkflowRun(started.run.id));
    await expectCorrupt(runWorkflowSteps({ target: started.run.id, summaryJudge: null }));
    expect((await abandonWorkflowRun(started.run.id)).run.status).toBe("failed");
  });

  test("malformed and unsupported plans can be abandoned without touching their spine", async () => {
    const cases = [
      { name: "malformed-null", version: null, status: "blocked" },
      { name: "malformed-v2", version: 2, status: "active" },
      { name: "malformed-current", version: 5, status: "active" },
      { name: "malformed-v3", version: 3, status: "active" },
    ];
    for (const item of cases) {
      writeWorkflow(item.name, "Work.");
      const started = await startWorkflowRun(`workflows/${item.name}`, {});
      execOnWorkflowDb(
        "UPDATE workflow_runs SET plan_json = ?, plan_hash = NULL, plan_ir_version = ?, status = ? WHERE id = ?",
        "{malformed",
        item.version,
        item.status,
        started.run.id,
      );
      const beforeSteps = await withWorkflowRunsRepo((repo) => repo.getStepsForRun(started.run.id));
      expect((await abandonWorkflowRun(started.run.id)).run.status).toBe("failed");
      expect(await withWorkflowRunsRepo((repo) => repo.getStepsForRun(started.run.id))).toEqual(beforeSteps);
    }
  });

  test("bad hash and spine mismatch are rejected before any workflow mutation", async () => {
    writeWorkflow("preflight", "Do immutable work.");
    const started = await startWorkflowRun("workflows/preflight", {});
    const beforeRun = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    const beforeSteps = await withWorkflowRunsRepo((repo) => repo.getStepsForRun(started.run.id));

    execOnWorkflowDb("UPDATE workflow_runs SET plan_hash = ? WHERE id = ?", "0".repeat(64), started.run.id);
    await expect(
      completeWorkflowStep({ runId: started.run.id, stepId: "only-step", status: "blocked" }),
    ).rejects.toThrow(/integrity check failed/);
    expect((await abandonWorkflowRun(started.run.id)).run.status).toBe("failed");

    const afterBadHashRun = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    const afterBadHashSteps = await withWorkflowRunsRepo((repo) => repo.getStepsForRun(started.run.id));
    expect(afterBadHashRun?.status).toBe("failed");
    expect(afterBadHashSteps).toEqual(beforeSteps);

    const valid = beforeRun;
    if (!valid?.plan_hash) throw new Error("fixture requires a plan hash");
    execOnWorkflowDb(
      "UPDATE workflow_runs SET status = 'active', completed_at = NULL, plan_hash = ? WHERE id = ?",
      valid.plan_hash,
      started.run.id,
    );
    execOnWorkflowDb(
      "UPDATE workflow_run_steps SET instructions = ? WHERE run_id = ? AND step_id = ?",
      "tampered instructions",
      started.run.id,
      "only-step",
    );
    await expect(
      completeWorkflowStep({ runId: started.run.id, stepId: "only-step", status: "blocked" }),
    ).rejects.toThrow(/corrupt durable step spine/);
    expect((await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id)))?.status).toBe("active");
    expect((await withWorkflowRunsRepo((repo) => repo.getStep(started.run.id, "only-step")))?.status).toBe("pending");
  });
});
