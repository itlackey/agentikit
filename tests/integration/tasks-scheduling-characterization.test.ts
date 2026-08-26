// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P0 characterization (Lane B) — task v3's mandatory, exactly-one scheduling
 * source: declaring NEITHER `akm.schedule` nor `on:` is an error, and
 * declaring BOTH is the identical error, plus the `akm.schedule` arm's
 * success shape.
 *
 * See docs/plans/specs/p0-invariants.md row R-06. This is a REPLACE row —
 * P2a deliberately makes the schedule optional — and it is also the row that
 * justifies R-02's fake `@daily` schedule
 * (src/workflows/ir/source-freeze-v4.ts:274-298), which the fixture set
 * leans on in several places. Nothing here is fixed.
 */

import { describe, expect, test } from "bun:test";
import { UsageError } from "../../src/core/errors";
import { parseTaskV3Yaml } from "../../src/tasks/source-v3";

/** Capture a synchronous throw once, so a message/code pin never re-invokes the function under test. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected function to throw");
}

const SHARED_FILE_PATH = "tasks/r06-scheduling.yml";

// sourceError(ctx, [], "must declare exactly one scheduling source: akm.schedule
// or on.") renders the empty field path as the literal "$". Both the
// neither-case and the both-case call this SAME sourceError(ctx, [], …) with
// the same field path and detail text, so both are asserted independently
// against this single rendered constant rather than one re-deriving the other
// — that way P2a's flip of the neither-arm (making the schedule optional)
// fails exactly that pinned test, while the both-arm test keeps passing (or
// fails on its own terms) with a message that names R-06.
const EXACTLY_ONE_SCHEDULING_SOURCE = `Invalid task v3 source at ${SHARED_FILE_PATH}:1: $ must declare exactly one scheduling source: akm.schedule or on.`;

describe("R-06 — task v3 requires exactly one scheduling source (source-v3.ts:636-651)", () => {
  test("R-06 — declaring neither akm.schedule nor on: fails with the exact rendered source-error text at the empty field path", () => {
    // P1a FLIP (F-02, spec §7): the sourceError funnel (source-v3.ts:210-226)
    // re-codes INVALID_FLAG_VALUE -> TASK_SOURCE_INVALID (spec §2.2). Message
    // text, the empty-path "$" rendering, and the UsageError type are
    // byte-identical to the P0-pinned characterization — only the code
    // assertion below flips.
    const error = thrown(() => parseTaskV3Yaml({ yaml: "version: 3\nrun: echo hi\n", filePath: SHARED_FILE_PATH }));
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).code).toBe("TASK_SOURCE_INVALID");
    expect((error as Error).message).toBe(EXACTLY_ONE_SCHEDULING_SOURCE);
  });

  test("R-06 — declaring BOTH akm.schedule and on: fails with the byte-identical rendered text as the neither-case", () => {
    // P1a FLIP (F-02, spec §7): same sourceError re-code as the neither-case
    // above; message text is unchanged.
    const both = thrown(() =>
      parseTaskV3Yaml({
        yaml: ["version: 3", "run: echo hi", "akm:", '  schedule: "@daily"', "on:", "  workflow_dispatch:", ""].join(
          "\n",
        ),
        filePath: SHARED_FILE_PATH,
      }),
    );
    expect(both).toBeInstanceOf(UsageError);
    expect((both as UsageError).code).toBe("TASK_SOURCE_INVALID");
    expect((both as Error).message).toBe(EXACTLY_ONE_SCHEDULING_SOURCE);
  });

  test('R-06 — the akm.schedule arm\'s success shape is { manual: false, schedules: [{ cron, source: "akm.schedule", ordinal: 0 }] }, frozen', () => {
    // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later phase flips this deliberately.
    const document = parseTaskV3Yaml({
      yaml: 'version: 3\nrun: echo hi\nakm:\n  schedule: "@daily"\n',
      filePath: "tasks/r06-akm-schedule-only.yml",
    });
    expect(document.triggers).toEqual({
      manual: false,
      schedules: [{ cron: "@daily", source: "akm.schedule", ordinal: 0 }],
    });
    expect(Object.isFrozen(document.triggers)).toBe(true);
    expect(Object.isFrozen(document.triggers.schedules)).toBe(true);
    expect(Object.isFrozen(document.triggers.schedules[0])).toBe(true);
  });
});
