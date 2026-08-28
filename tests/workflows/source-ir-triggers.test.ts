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
 *
 * Review finding (docs/plans/specs/p4-deletions-closeout.md review, on
 * src/workflows/source-ir/triggers.ts): the `{akm?, on?}` fragment above is
 * no longer accurate — the re-home's own `akm:` options-bag grammar was
 * unreachable from the classifier's one production caller
 * (`github-yaml.ts`'s `verifyOwnerTriggerPlan`, which only ever passes
 * `{on: ...}`) and has been deleted. The first case below drops the `akm:`
 * key it used to carry (it contributed nothing to the assertion — `enabled`
 * was never read by `compileTriggers`); the second case is new and pins that
 * `akm:` is now rejected as an unsupported field, same as any other stray
 * top-level key.
 */

import { describe, expect, test } from "bun:test";
import { classifyWorkflowYamlTriggers } from "../../src/workflows/source-ir/triggers";

describe("classifyWorkflowYamlTriggers", () => {
  test("exports the same pure trigger classifier used by complete workflow-YAML parsing", () => {
    expect(
      classifyWorkflowYamlTriggers(
        { on: { schedule: [{ cron: "0 1 * * *" }], workflow_dispatch: {} } },
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

  test("rejects the retired task-v3 akm: options bag as an unsupported field", () => {
    expect(() =>
      classifyWorkflowYamlTriggers(
        { akm: { enabled: false }, on: { workflow_dispatch: {} } },
        { filePath: "/stash/workflows/nightly.yml" },
      ),
    ).toThrow(/akm.*unsupported field/);
  });

  test("requires on: — there is no second scheduling source to fall back to", () => {
    expect(() => classifyWorkflowYamlTriggers({}, { filePath: "/stash/workflows/nightly.yml" })).toThrow(
      /on is required/,
    );
  });
});
