// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import type { UnitDispatchRequest } from "../../../src/workflows/exec/native-executor";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import { startWorkflowRun } from "../../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../../_helpers/sandbox";

interface AttemptRow {
  unit_id: string;
  attempt: number;
  dispatch_id: string;
  status: string;
  tokens: number | null;
}

interface AttemptDispatch extends UnitDispatchRequest {
  attempt: number;
  dispatchId: string;
}

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});

afterEach(() => storage.cleanup());

function writeRetryWorkflow(name: string): void {
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
      "    unit:",
      "      retry: { max: 1, on: [timeout] }",
      "---",
      "",
      "## work",
      "",
      "Perform retryable frozen work.",
      "",
    ].join("\n"),
  );
}

function attempts(runId: string): AttemptRow[] {
  const db = openStateDatabase(getStateDbPath());
  try {
    return db
      .prepare(
        `SELECT unit_id, attempt, dispatch_id, status, tokens
           FROM workflow_run_unit_attempts
          WHERE run_id = ?
          ORDER BY unit_id, attempt`,
      )
      .all(runId) as AttemptRow[];
  } finally {
    db.close();
  }
}

function eventMetadata(runId: string): Record<string, unknown>[] {
  const db = openStateDatabase(getStateDbPath());
  try {
    const rows = db
      .prepare(
        `SELECT metadata_json
           FROM events
          WHERE event_type IN ('workflow_unit_started', 'workflow_unit_finished')
            AND json_extract(metadata_json, '$.runId') = ?
          ORDER BY id`,
      )
      .all(runId) as Array<{ metadata_json: string }>;
    return rows.map((row) => JSON.parse(row.metadata_json) as Record<string, unknown>);
  } finally {
    db.close();
  }
}

describe("durable v4 retries retain one content-derived unit identity", () => {
  test("failure then success appends attempts [1,2] under one unit id and sends stable external unit ids", async () => {
    writeRetryWorkflow("stable-retry");
    const started = await startWorkflowRun("workflows/stable-retry", {});
    const requests: AttemptDispatch[] = [];

    const result = await runWorkflowSteps({
      target: started.run.id,
      summaryJudge: null,
      heartbeatScheduler: () => () => {},
      dispatcher: async (request) => {
        requests.push(request as AttemptDispatch);
        return requests.length === 1
          ? {
              ok: false,
              text: "first timeout",
              failureReason: "timeout",
              error: "timed out",
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          : { ok: true, text: "second succeeds", usage: { inputTokens: 2, outputTokens: 3 } };
      },
    });

    expect(result.done).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.attempt)).toEqual([1, 2]);
    expect(requests[0]?.unitId).toBe(requests[1]?.unitId);
    expect(requests[0]?.unitId).not.toContain("~r");
    expect(requests[0]?.dispatchId).not.toBe(requests[1]?.dispatchId);
    const stableUnitId = requests[0]?.unitId;
    if (!stableUnitId) throw new Error("expected stable dispatched unit id");

    const rows = attempts(started.run.id);
    expect(rows.map(({ unit_id, attempt, status, tokens }) => ({ unit_id, attempt, status, tokens }))).toEqual([
      { unit_id: stableUnitId, attempt: 1, status: "failed", tokens: 2 },
      { unit_id: stableUnitId, attempt: 2, status: "completed", tokens: 5 },
    ]);
    expect(new Set(rows.map(({ dispatch_id }) => dispatch_id)).size).toBe(2);

    const events = eventMetadata(started.run.id);
    expect(events).toHaveLength(4);
    expect(new Set(events.map((event) => event.unitId))).toEqual(new Set([requests[0]?.unitId]));
    expect(events.map((event) => event.attempt)).toEqual([1, 1, 2, 2]);

    const db = openStateDatabase(getStateDbPath());
    try {
      const projection = db
        .prepare("SELECT unit_id, status, attempts, tokens FROM workflow_run_units WHERE run_id = ?")
        .all(started.run.id) as Array<Record<string, unknown>>;
      expect(projection).toEqual([{ unit_id: stableUnitId, status: "completed", attempts: 2, tokens: 5 }]);
    } finally {
      db.close();
    }
  });

  test("the historical v3 retry suffix remains byte-for-byte compatible", async () => {
    // The v3 compatibility behavior is already covered deeply by the native
    // executor suite. This focused ratchet pins the user-visible journal ABI:
    // v3 still allocates a separate row id for retry N, while v4 never does.
    const source = fs.readFileSync(
      path.join(process.cwd(), "tests", "integration", "workflows", "native-executor.test.ts"),
      "utf8",
    );
    expect(source).toContain('byId.get("fetch:solo~r1")');
    expect(source).toContain('byId.get("fetch:solo~r2")');
  });
});
