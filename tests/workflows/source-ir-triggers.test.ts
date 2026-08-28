// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The canonical workflow YAML trigger classifier
 * (`src/workflows/source-ir/triggers.ts`'s `classifyWorkflowYamlTriggers`).
 *
 * This case moved here, body-intact, from `tests/tasks/source-v3.test.ts`
 * (spec docs/plans/specs/p4-deletions-closeout.md §3.2.3, F-A2.1) when that
 * file was deleted along with the retired task-v3 parser — the classifier's
 * subject was always a WORKFLOW's `{akm?, on?}` trigger fragment, never a
 * task document, and it now lives independently of task source parsing
 * (P4-N3).
 */

import { describe, expect, test } from "bun:test";
import { classifyWorkflowYamlTriggers } from "../../src/workflows/source-ir/triggers";

describe("classifyWorkflowYamlTriggers", () => {
  test("exports the same pure trigger classifier used by complete workflow-YAML parsing", () => {
    expect(
      classifyWorkflowYamlTriggers(
        {
          akm: { enabled: false },
          on: { schedule: [{ cron: "0 1 * * *" }], workflow_dispatch: {} },
        },
        { filePath: "/stash/workflows/nightly.yml" },
      ),
    ).toEqual({
      manual: true,
      schedules: [{ cron: "0 1 * * *", source: "on.schedule[0].cron", ordinal: 0 }],
    });
    expect(() =>
      classifyWorkflowYamlTriggers({ on: { push: {} } }, { filePath: "/stash/workflows/nightly.yml" }),
    ).toThrow(/unsupported local service event/);
    expect(() =>
      classifyWorkflowYamlTriggers(
        { on: { workflow_dispatch: {} }, jobs: {} },
        { filePath: "/stash/workflows/nightly.yml" },
      ),
    ).toThrow(/jobs.*unsupported field/);
  });
});
