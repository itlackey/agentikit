// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import type { UnitDispatcher } from "../../../src/workflows/exec/native-executor";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import { getWorkflowStatus, startWorkflowRun } from "../../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});

afterEach(() => storage.cleanup());

function writeWorkflow(name: string): void {
  fs.mkdirSync(path.join(storage.stashDir, "workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(storage.stashDir, "workflows", `${name}.md`),
    [
      "---",
      "type: workflow",
      "description: Run control test",
      "steps:",
      "  - id: work",
      "---",
      "",
      "## work",
      "",
      "Do the work.",
      "",
    ].join("\n"),
    "utf8",
  );
}

describe("workflow invocation controls", () => {
  test("maxRetries resumes the failed step and reuses the same run", async () => {
    writeWorkflow("retry");
    const started = await startWorkflowRun("workflows/retry");
    let calls = 0;
    const dispatcher: UnitDispatcher = async () => {
      calls += 1;
      return calls === 1
        ? { ok: false, text: "", failureReason: "spawn_failed", error: "temporary failure" }
        : { ok: true, text: "completed on retry" };
    };

    const result = await runWorkflowSteps({ target: started.run.id, maxRetries: 1, dispatcher });

    expect(result.run).toMatchObject({ id: started.run.id, status: "completed" });
    expect(result.done).toBe(true);
    expect(result.executed).toHaveLength(2);
    expect(calls).toBe(2);
    const units = await getWorkflowStatus(started.run.id, { includeUnits: true });
    expect(units.units?.[0]).toMatchObject({ status: "completed", attempts: 2 });
  });

  test("an aborted invocation leaves the step active and releases its lease", async () => {
    writeWorkflow("timeout");
    const started = await startWorkflowRun("workflows/timeout");
    const controller = new AbortController();
    const dispatcher: UnitDispatcher = async (request) =>
      new Promise((resolve) => {
        request.signal?.addEventListener(
          "abort",
          () => resolve({ ok: false, text: "", failureReason: "aborted", error: "interrupted" }),
          { once: true },
        );
      });
    const timer = setTimeout(() => controller.abort(new Error("test timeout")), 10);

    try {
      const result = await runWorkflowSteps({ target: started.run.id, signal: controller.signal, dispatcher });
      expect(result).toMatchObject({ aborted: true, run: { status: "active", currentStepId: "work" } });
      const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
      expect(row?.engine_lease_holder).toBeNull();
      expect(row?.engine_lease_until).toBeNull();
    } finally {
      clearTimeout(timer);
    }
  });
});
