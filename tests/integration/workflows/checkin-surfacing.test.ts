// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { openStateDatabase } from "../../../src/core/state-db";
import { formatWorkflowStatusPlain } from "../../../src/output/text/helpers";
import { CHECKIN_STALL_MS } from "../../../src/workflows/runtime/checkin";
import { getWorkflowStatus } from "../../../src/workflows/runtime/runs";
import { type Cleanup, sandboxEnvDir } from "../../_helpers/sandbox";

/**
 * Check-in surfacing gaps from the check-in v2 design review:
 * `workflow status` must both evaluate and render the check-in directive so
 * plain (non-JSON) consumers see the CONTINUE nudge.
 */

let tmpDir = "";
let cleanup: Cleanup;

const RUN_ID = "22222222-2222-4222-8222-222222222222";

function seedStalledRun(dbPath: string): void {
  const db = openStateDatabase(dbPath);
  try {
    const stale = new Date(Date.now() - CHECKIN_STALL_MS * 3).toISOString();
    db.prepare(
      `INSERT INTO workflow_runs
         (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
          params_json, current_step_id, created_at, updated_at, checkin_armed_at,
          agent_harness, agent_session_id)
       VALUES (?, 'workflows/demo', 'dir:v1:demo', NULL, 'Demo', 'active', '{}', 'step-1', ?, ?, ?, 'claude', 'sess-9')`,
    ).run(RUN_ID, stale, stale, stale);
    db.prepare(
      `INSERT INTO workflow_run_steps
         (run_id, step_id, step_title, instructions, completion_json, sequence_index, status)
       VALUES (?, 'step-1', 'Do the thing', 'instructions', NULL, 0, 'pending')`,
    ).run(RUN_ID);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  const sandboxed = sandboxEnvDir("akm-checkin-surfacing-", "AKM_DATA_DIR");
  tmpDir = sandboxed.dir;
  cleanup = sandboxed.cleanup;
  seedStalledRun(path.join(tmpDir, "state.db"));
});

afterEach(() => {
  cleanup();
});

describe("workflow status check-in evaluation (review M1)", () => {
  test("getWorkflowStatus surfaces a continue directive for a stalled active run", async () => {
    const detail = await getWorkflowStatus(RUN_ID);
    expect(detail.checkin).toBeDefined();
    expect(detail.checkin?.signal).toBe("continue");
    expect(detail.checkin?.directive).toContain("CONTINUE");
  });
});

describe("plain-text check-in surfacing (review C2)", () => {
  const checkin = {
    signal: "continue",
    directive: "CONTINUE: this workflow run has stalled with no progress. Resume immediately.",
    idleMs: 120_000,
  };
  const result = {
    run: { id: RUN_ID, status: "active", currentStepId: "step-1" },
    workflow: { ref: "workflows/demo", title: "Demo", steps: [] },
    step: { id: "step-1", title: "Do the thing", instructions: "instructions" },
    checkin,
  };

  test("formatWorkflowStatusPlain includes the directive", () => {
    const text = formatWorkflowStatusPlain(result as Record<string, unknown>);
    expect(text).toContain("CONTINUE:");
  });

  test("formatters stay unchanged when no checkin is present", () => {
    const { checkin: _omit, ...healthy } = result;
    const text = formatWorkflowStatusPlain(healthy as Record<string, unknown>);
    expect(text).not.toContain("CONTINUE:");
  });
});
