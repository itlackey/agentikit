// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #919 reproduction — "editing a workflow breaks its in-flight runs despite
 * the plan being frozen", reported as `plan_ir_version` jumping to 111 after
 * a mid-run source edit.
 *
 * Static analysis before writing this test (per the #919 triage and team
 * brief): `plan_ir_version` is written in exactly two places in the whole
 * repository (`storage/repositories/workflow-runs-repository.ts`, the fresh
 * `publishWorkflowRunV4` insert and the child-run publish path), both as the
 * literal SQL `= 5` — never a bound parameter, so the column can only ever
 * receive the integer 5 from these sites. The column itself
 * (`core/state/migrations.ts` migration 020) was declared
 * `plan_ir_version INTEGER` at table creation with no later ALTER/backfill
 * touching it. `grep -r plan_ir_version` across `scripts/akm-migrate/` finds
 * nothing. So there is no code path — including a stored TEXT value compared
 * with `!==`, or a migration carrying an old value forward — that could
 * produce anything other than 5 on a run this codebase created.
 *
 * This test exercises the reported scenario end to end anyway: start a run,
 * execute part of it, edit the source (as the report describes — extend a
 * step body), then resolve the SAME ref again exactly as
 * `akm workflow run <ref>` does (silently reusing the active run, #485).
 * `plan_ir_version` must read 5 before and after the edit, and the second
 * invocation must succeed (not raise `WORKFLOW_IR_VERSION_UNSUPPORTED`) —
 * confirming the report does not reproduce on this tree, and pinning the
 * frozen-plan contract the report expected in the first place.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import type { UnitDispatcher } from "../../src/workflows/exec/native-executor";
import { runWorkflowSteps } from "../../src/workflows/exec/run-workflow";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});

afterEach(() => storage.cleanup());

function writeWorkflow(name: string, secondStepBody: string): string {
  const file = path.join(storage.stashDir, "workflows", `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      "---",
      "type: workflow",
      "description: issue 919 repro workflow",
      "steps:",
      "  - id: first-step",
      "  - id: second-step",
      "---",
      "",
      "## first-step",
      "",
      "Do the first thing.",
      "",
      "## second-step",
      "",
      secondStepBody,
      "",
    ].join("\n"),
    "utf8",
  );
  return file;
}

const okDispatcher: UnitDispatcher = async () => ({ ok: true, text: "done" });

describe("#919 repro — mid-run source edit does not bump plan_ir_version or invalidate the run", () => {
  test("plan_ir_version stays 5 before and after an edit, and the resumed run keeps executing", async () => {
    const file = writeWorkflow("repro-919", "Do the ORIGINAL second thing.");

    // "akm workflow run workflows/repro-919 --max-steps=1"
    const started = await runWorkflowSteps({
      target: "workflows/repro-919",
      maxSteps: 1,
      dispatcher: okDispatcher,
    });
    expect(started.run.status).toBe("active");

    const before = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    expect(before?.plan_ir_version).toBe(5);
    expect(typeof before?.plan_ir_version).toBe("number");

    // "edit ~/akm/workflows/repro-919.md — extend a step body"
    writeWorkflow("repro-919", "Do the EDITED second thing, now with more detail.");
    expect(fs.readFileSync(file, "utf8")).toContain("EDITED");

    // "akm workflow run workflows/repro-919" (no --max-steps: run to completion)
    const prompts: string[] = [];
    const resumed = await runWorkflowSteps({
      target: "workflows/repro-919",
      dispatcher: async (req) => {
        prompts.push(req.prompt);
        return { ok: true, text: "done" };
      },
    });

    // Did not reproduce: the run resolves and finishes, not
    // WORKFLOW_IR_VERSION_UNSUPPORTED.
    expect(resumed.run.id).toBe(started.run.id);
    expect(resumed.resumed).toBe(true);
    expect(resumed.done).toBe(true);
    expect(resumed.run.status).toBe("completed");

    // The frozen plan dispatched — never the edited source.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Do the ORIGINAL second thing.");
    expect(prompts[0]).not.toContain("EDITED");

    const after = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    expect(after?.plan_ir_version).toBe(5);
    expect(after?.plan_ir_version).toBe(before?.plan_ir_version);
  });
});
