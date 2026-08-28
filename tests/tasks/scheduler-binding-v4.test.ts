// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Test-review remediation (spec docs/plans/specs/p2a-task-source-v4.md §1.5
 * D2-N5, §5.2, F-4) for the finding recorded against
 * docs/plans/specs/p2a-task-source-v4.md:504: B-10's compile half and F-4's
 * authorized change to `src/tasks/scheduler-binding.ts` were untested —
 * nothing exercised `SchedulerSourceSchedule.enabled?` or
 * `compileTaskSchedulerBindings`'s `enabled: schedule.enabled ?? input.enabled`.
 * `tests/tasks/scheduler-binding.test.ts` must stay byte-unchanged (F-4), so
 * this v4-shaped coverage lands as a new, separate file.
 */

import { describe, expect, test } from "bun:test";
import {
  type CompileTaskSchedulerBindingsInput,
  compileTaskSchedulerBindings,
} from "../../src/tasks/scheduler-binding";

describe("compileTaskSchedulerBindings — per-entry enabled overrides the document-level default (D2-N5, B-10)", () => {
  test("a per-entry enabled: false disables ONLY that binding; siblings keep the document-level enabled: true", () => {
    const input: CompileTaskSchedulerBindingsInput = {
      id: "nightly",
      qualifiedRef: "team//tasks/nightly",
      bundleTarget: "team",
      enabled: true,
      schedules: [
        { cron: "0 6 * * *", source: "schedule[0].cron", ordinal: 0 },
        { cron: "30 18 * * 1-5", source: "schedule[1].cron", ordinal: 1, enabled: false },
      ],
    };

    const bindings = compileTaskSchedulerBindings(input);
    expect(bindings.map((binding) => binding.enabled)).toEqual([true, false]);
  });

  test("a per-entry enabled: true overrides a document-level enabled: false for ONLY that binding; the sibling stays disabled", () => {
    const input: CompileTaskSchedulerBindingsInput = {
      id: "nightly",
      qualifiedRef: "team//tasks/nightly",
      enabled: false,
      schedules: [
        { cron: "0 6 * * *", source: "schedule[0].cron", ordinal: 0 },
        { cron: "30 18 * * 1-5", source: "schedule[1].cron", ordinal: 1, enabled: true },
      ],
    };

    const bindings = compileTaskSchedulerBindings(input);
    expect(bindings.map((binding) => binding.enabled)).toEqual([false, true]);
  });

  test("an UNSET per-entry enabled falls back to the document-level input.enabled — true and false both", () => {
    const enabledDoc: CompileTaskSchedulerBindingsInput = {
      id: "nightly",
      qualifiedRef: "team//tasks/nightly",
      enabled: true,
      schedules: [{ cron: "0 6 * * *", source: "schedule", ordinal: 0 }],
    };
    expect(compileTaskSchedulerBindings(enabledDoc).map((binding) => binding.enabled)).toEqual([true]);

    const disabledDoc: CompileTaskSchedulerBindingsInput = {
      id: "nightly",
      qualifiedRef: "team//tasks/nightly",
      enabled: false,
      schedules: [{ cron: "0 6 * * *", source: "schedule", ordinal: 0 }],
    };
    expect(compileTaskSchedulerBindings(disabledDoc).map((binding) => binding.enabled)).toEqual([false]);
  });

  test("v3 documents never set the field: every compiled binding is byte-identical to today (byte-stable invocation tail and signature, D2-N5)", () => {
    // v3 never authors schedule[i].enabled — this reproduces
    // tests/tasks/scheduler-binding.test.ts's own first fixture verbatim to
    // prove the D2-N5 addition changes nothing for a v3-shaped caller.
    const [binding] = compileTaskSchedulerBindings({
      id: "nightly",
      qualifiedRef: "team//tasks/nightly",
      bundleTarget: "team",
      enabled: false,
      schedules: [{ cron: "0 2 * * *", source: "akm.schedule", ordinal: 0 }],
    });

    expect(binding).toEqual({
      id: "nightly",
      nativeId: "nightly",
      logicalSource: { kind: "task", ref: "team//tasks/nightly" },
      cron: "0 2 * * *",
      source: "akm.schedule",
      ordinal: 0,
      enabled: false,
      invocation: ["task", "run", "nightly", "--bundle", "team", "--scheduled"],
    });
  });
});
