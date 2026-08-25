// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { shapeForCommand } from "../src/output/shapes";
import { formatWorkflowRunPlain } from "../src/output/text/workflow-format";

const NOTICE = {
  code: "conversation-prompt-composed",
  severity: "warning" as const,
  adapter: "codex",
  field: "conversation",
  message: "conversation was composed safely",
  details: { strategy: "system-prefix" },
};

const RUN_RESULT = {
  run: { id: "run-1", status: "completed" },
  executed: [
    {
      stepId: "review",
      ok: true,
      unitCount: 1,
      failedUnits: 0,
      summary: "reviewed",
      notices: [NOTICE],
    },
  ],
  stepsProcessed: 1,
  done: true as const,
  notices: [NOTICE],
};

describe("workflow lowering notices are live output only", () => {
  test("workflow-run JSON passthrough preserves the typed top-level and per-step notices", () => {
    const shaped = shapeForCommand("workflow-run", RUN_RESULT, "normal") as Record<string, unknown>;
    expect(shaped.notices).toEqual([NOTICE]);
    expect((shaped.executed as Array<Record<string, unknown>>)[0]?.notices).toEqual([NOTICE]);
    expect(shaped.shape).toBe("workflow-run");
    expect(shaped.schemaVersion).toBe(1);
  });

  test("workflow run text renders each deduped top-level notice once", () => {
    const text = formatWorkflowRunPlain(RUN_RESULT);
    expect(text).toContain(
      "! lowering[warning] conversation-prompt-composed (codex; conversation): conversation was composed safely",
    );
    expect(text?.match(/conversation-prompt-composed/g)).toHaveLength(1);
  });
});
